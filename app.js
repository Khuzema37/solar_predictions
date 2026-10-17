let hourlyWeatherPayload = [];
let yieldChartInstance = null;

document.addEventListener("DOMContentLoaded", async () => {
    const LAT = 29.39; // Bahawalpur
    const LON = 71.67; 
    
    try {
        // Added weather_code to the hourly request
        const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}&hourly=temperature_2m,relative_humidity_2m,wind_speed_10m,precipitation,cloud_cover,is_day,weather_code&forecast_days=2&timezone=Asia%2FKarachi`;
        
        const weatherResponse = await fetch(weatherUrl);
        const weatherData = await weatherResponse.json();

        // 1. Get current hour and find the matching index for TOMORROW
        const now = new Date();
        const currentHour = now.getHours();
        const targetHourIndex = 24 + currentHour; // Tomorrow starts at index 24 in the array

        // 2. Fetch specific weather for tomorrow at this exact time
        const weatherCode = weatherData.hourly.weather_code[targetHourIndex];
        const tempAtTime = weatherData.hourly.temperature_2m[targetHourIndex];
        
        function getWeatherUI(code) {
            if (code === 0) return { text: 'Clear Sky', icon: '☀️' };
            if (code === 1 || code === 2) return { text: 'Partly Cloudy', icon: '⛅' };
            if (code === 3) return { text: 'Overcast', icon: '☁️' };
            if (code >= 45 && code <= 48) return { text: 'Fog', icon: '🌫️' };
            if (code >= 51 && code <= 67) return { text: 'Rain', icon: '🌧️' };
            if (code >= 95) return { text: 'Thunderstorm', icon: '⛈️' };
            return { text: 'Clear', icon: '☀️' };
        }

        const ui = getWeatherUI(weatherCode);
        
        // Format time for the banner (e.g., 11:00 PM)
        const ampm = currentHour >= 12 ? 'PM' : 'AM';
        const displayHour = currentHour % 12 || 12;
        
        document.querySelector('#weather_description').previousElementSibling.innerText = `Tomorrow at ${displayHour}:00 ${ampm}`;
        document.getElementById('weather_description').innerText = `${ui.text} (${tempAtTime}°C)`;
        document.getElementById('weather_icon').innerText = ui.icon;

        // 3. Build the 24-hour payload for tomorrow (for the AI model)
        hourlyWeatherPayload = [];
        const hourly = weatherData.hourly;
        
        for (let i = 24; i < 48; i++) {
            const cloudCoverPct = hourly.cloud_cover[i] || 0;
            const estimatedKt = Math.max(0, Math.min(1.0, (100 - cloudCoverPct) / 100));

            hourlyWeatherPayload.push({
                t2m: hourly.temperature_2m[i],
                rh2m: hourly.relative_humidity_2m[i],
                ws10m: hourly.wind_speed_10m[i],
                prectotcorr: hourly.precipitation[i],
                allsky_kt: estimatedKt,
                is_day: hourly.is_day[i]
            });
        }
        
    } catch (error) {
        console.error('Error fetching weather:', error);
        document.getElementById('weather_description').innerText = "Data Unavailable";
        document.getElementById('weather_icon').innerText = "⚠️";
    }
});

document.getElementById('predictionForm').addEventListener('submit', async function(e) {
    e.preventDefault();
    
    if (hourlyWeatherPayload.length === 0) return alert("Weather data loading...");

    const btnLoader = document.getElementById('btnLoader');
    const btnIcon = document.getElementById('btnIcon');
    const submitBtn = this.querySelector('button[type="submit"]');
    
    btnLoader.style.display = 'block';
    btnIcon.style.display = 'none';
    submitBtn.disabled = true;

    // Fixed calculations
    const systemKw = parseFloat(document.getElementById('systemKw').value);
    const fixedEfficiency = 0.20; 
    // Area = kW / Efficiency
    const calculatedArea = systemKw / fixedEfficiency;

    try {
        const response = await fetch('https://solar-predictions.onrender.com/predict', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                hourly_data: hourlyWeatherPayload,
                panel_area: calculatedArea, 
                panel_efficiency: fixedEfficiency
            })
        });

        if (!response.ok) throw new Error(`API Error: ${response.status}`);

        const resultData = await response.json();

        animateValue("finalKwh", 0, resultData.total_daily_kwh, 1000);
        renderHourlyChart(resultData.hourly_kwh_yield);
        populateHourlyTable(resultData.hourly_irradiance_w_m2, resultData.hourly_kwh_yield);
        populateAppliances(resultData.total_daily_kwh);

        document.getElementById('emptyState').classList.add('hidden');
        document.getElementById('populatedState').classList.remove('hidden');
        document.getElementById('populatedState').classList.add('flex');

    } catch (error) {
        console.error('Error:', error);
        alert("Failed to connect to backend.");
    } finally {
        btnLoader.style.display = 'none';
        btnIcon.style.display = 'block';
        submitBtn.disabled = false;
    }
});

function populateHourlyTable(irradianceArray, kwhArray) {
    const tableBody = document.getElementById('hourlyTableBody');
    tableBody.innerHTML = ''; 
    let rowCount = 0;

    for (let hour = 0; hour < 24; hour++) {
        const irradiance = irradianceArray[hour];
        
        // Hide night hours completely
        if (irradiance === 0) continue;

        const kwh = kwhArray[hour];
        const timeLabel = `${String(hour).padStart(2, '0')}:00`;

        const tr = document.createElement('tr');
        tr.className = rowCount % 2 === 0 ? 'bg-white' : 'bg-slate-50/50';
        rowCount++;

        let badgeHtml = irradiance > 500 
            ? `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-800">Peak Yield</span>`
            : `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-teal-100 text-teal-800">Moderate</span>`;

        tr.innerHTML = `
            <td class="py-2 px-3 font-semibold text-slate-700">${timeLabel}</td>
            <td class="py-2 px-3 text-slate-600">${irradiance.toFixed(1)} W/m²</td>
            <td class="py-2 px-3 font-bold text-teal-700">${kwh.toFixed(3)} kWh</td>
            <td class="py-2 px-3 text-right">${badgeHtml}</td>
        `;
        tableBody.appendChild(tr);
    }
}

// Render Chart.js line graph
function renderHourlyChart(hourlyKwhData) {
    const ctx = document.getElementById('hourlyYieldChart').getContext('2d');
    const hoursLabels = Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, '0')}:00`);
    if (yieldChartInstance) yieldChartInstance.destroy();

    yieldChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: hoursLabels,
            datasets: [{
                label: 'Hourly Output (kWh)',
                data: hourlyKwhData,
                borderColor: '#0d9488',
                backgroundColor: 'rgba(13, 148, 136, 0.15)',
                borderWidth: 3, fill: true, tension: 0.4, pointRadius: 3
            }]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                x: { grid: { display: false } },
                y: { beginAtZero: true }
            }
        }
    });
}

function populateAppliances(totalKwh) {
    const list = document.getElementById('applianceList');
    list.innerHTML = ''; 

    // Realistic energy allocation (kWh per hour or per day)
    const appliances = [
        { name: 'Refrigerator', consume: 2.0, type: 'daily', maxRun: 24, icon: 'fa-icicles', color: 'text-cyan-500', bg: 'bg-cyan-50' },
        { name: 'Water Pump (1 HP)', consume: 0.75, type: 'hourly', maxRun: 2, icon: 'fa-faucet-drip', color: 'text-indigo-500', bg: 'bg-indigo-50' },
        { name: 'Basic Lighting & TV', consume: 0.5, type: 'hourly', maxRun: 6, icon: 'fa-lightbulb', color: 'text-amber-500', bg: 'bg-amber-50' },
        { name: '4 Ceiling Fans', consume: 0.3, type: 'hourly', maxRun: 12, icon: 'fa-fan', color: 'text-slate-500', bg: 'bg-slate-100' },
        { name: '1.5 Ton DC Inverter AC', consume: 1.2, type: 'hourly', maxRun: 12, icon: 'fa-snowflake', color: 'text-blue-500', bg: 'bg-blue-50' }
    ];

    let remainingKwh = totalKwh;
    let addedCount = 0;

    appliances.forEach(app => {
        if (remainingKwh <= 0.5 || addedCount >= 4) return;
        
        let runText = "";
        
        if (app.type === 'daily' && remainingKwh >= app.consume) {
            runText = "Full 24 hours runtime";
            remainingKwh -= app.consume;
            createApplianceCard(app, runText, list);
            addedCount++;
        } else if (app.type === 'hourly') {
            // Calculate how many hours we can afford
            let possibleHours = Math.floor(remainingKwh / app.consume);
            let actualHours = Math.min(possibleHours, app.maxRun);
            
            if (actualHours >= 1) {
                runText = `~${actualHours} hours runtime`;
                remainingKwh -= (actualHours * app.consume);
                createApplianceCard(app, runText, list);
                addedCount++;
            }
        }
    });

    if (addedCount === 0) {
        list.innerHTML = `<li class="p-3 border border-amber-100 rounded-lg bg-amber-50 col-span-full">
            <p class="text-sm font-semibold text-amber-800">Low Generation Expected</p>
            <p class="text-xs text-amber-600">Not enough energy to fully power primary appliances.</p>
        </li>`;
    }
}

function createApplianceCard(app, runText, list) {
    const li = document.createElement('li');
    li.className = 'flex items-center p-3 border border-slate-100 rounded-lg bg-slate-50/50';
    li.innerHTML = `
        <div class="flex-shrink-0 h-10 w-10 rounded-full ${app.bg} flex items-center justify-center mr-4 shadow-sm border border-white">
            <i class="fa-solid ${app.icon} ${app.color}"></i>
        </div>
        <div class="flex-1 min-w-0">
            <p class="text-sm font-semibold text-slate-800 truncate">${app.name}</p>
            <p class="text-xs text-slate-500 truncate">${runText}</p>
        </div>
        <div class="flex-shrink-0">
            <span class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-teal-100 text-teal-800">
                Covered
            </span>
        </div>
    `;
    list.appendChild(li);
}

function animateValue(id, start, end, duration) {
    if (start === end) return;
    let obj = document.getElementById(id);
    let startTimestamp = null;
    const step = (timestamp) => {
        if (!startTimestamp) startTimestamp = timestamp;
        const progress = Math.min((timestamp - startTimestamp) / duration, 1);
        obj.innerHTML = (progress * (end - start) + start).toFixed(1);
        if (progress < 1) window.requestAnimationFrame(step);
    };
    window.requestAnimationFrame(step);
}
