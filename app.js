let hourlyWeatherPayload = [];
let yieldChartInstance = null;

document.addEventListener("DOMContentLoaded", async () => {
    const LAT = 29.39; // Bahawalpur Latitude
    const LON = 71.67; // Bahawalpur Longitude
    
    try {
        // Fetch daily weather code + 24 hourly weather arrays aligned with Asia/Karachi
        const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}&daily=weather_code&hourly=temperature_2m,relative_humidity_2m,wind_speed_10m,precipitation,cloud_cover,is_day&forecast_days=2&timezone=Asia%2FKarachi`;
        
        const weatherResponse = await fetch(weatherUrl);
        const weatherData = await weatherResponse.json();

        // Update Weather Banner using tomorrow's daily weather code (Index 1)
        const weatherCode = weatherData.daily.weather_code[1];
        
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
        document.getElementById('weather_description').innerText = ui.text;
        document.getElementById('weather_icon').innerText = ui.icon;

        // Build the 24-hour payload for tomorrow (Hours 24 through 47 in Open-Meteo's array)
        hourlyWeatherPayload = [];
        const hourly = weatherData.hourly;
        
        for (let i = 24; i < 48; i++) {
            const cloudCoverPct = hourly.cloud_cover[i] || 0;
            // Convert Cloud Cover percentage into Clearness Index (ALLSKY_KT)
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
    
    if (hourlyWeatherPayload.length === 0) {
        alert("Weather data is still loading or failed to load. Please refresh.");
        return;
    }

    // Toggle Loading State
    const btnLoader = document.getElementById('btnLoader');
    const btnIcon = document.getElementById('btnIcon');
    const submitBtn = this.querySelector('button[type="submit"]');
    const apiStatusText = document.getElementById('apiStatusText');
    
    btnLoader.style.display = 'block';
    btnIcon.style.display = 'none';
    apiStatusText.classList.remove('hidden');
    submitBtn.disabled = true;

    const panelArea = parseFloat(document.getElementById('panelArea').value);
    const panelEfficiency = parseFloat(document.getElementById('panelEfficiency').value);

    try {
        // Send request payload to XGBoost FastAPI Render endpoint
        const response = await fetch('https://solar-predictions.onrender.com/predict', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                hourly_data: hourlyWeatherPayload,
                panel_area: panelArea,
                panel_efficiency: panelEfficiency
            })
        });

        if (!response.ok) {
            throw new Error(`API Error: ${response.status}`);
        }

        const resultData = await response.json();

        // 1. Animate total yield display
        animateValue("finalKwh", 0, resultData.total_daily_kwh, 1000);

        // 2. Render 24-Hour Line Chart
        renderHourlyChart(resultData.hourly_kwh_yield);

        // 3. Populate Hour-by-Hour Table
        populateHourlyTable(resultData.hourly_irradiance_w_m2, resultData.hourly_kwh_yield);

        // 4. Populate Appliances Covered
        populateAppliances(resultData.total_daily_kwh);

        // Switch to Populated View
        document.getElementById('emptyState').classList.add('hidden');
        document.getElementById('populatedState').classList.remove('hidden');
        document.getElementById('populatedState').classList.add('flex');

    } catch (error) {
        console.error('Error fetching prediction:', error);
        alert("Connection Error: Failed to connect to the prediction backend.");
    } finally {
        btnLoader.style.display = 'none';
        btnIcon.style.display = 'block';
        apiStatusText.classList.add('hidden');
        submitBtn.disabled = false;
    }
});

// Populate the hour-by-hour forecast table
function populateHourlyTable(irradianceArray, kwhArray) {
    const tableBody = document.getElementById('hourlyTableBody');
    tableBody.innerHTML = ''; // Clear previous content

    for (let hour = 0; hour < 24; hour++) {
        const timeLabel = `${String(hour).padStart(2, '0')}:00`;
        const irradiance = irradianceArray[hour];
        const kwh = kwhArray[hour];

        const tr = document.createElement('tr');
        tr.className = hour % 2 === 0 ? 'bg-white' : 'bg-slate-50/50';

        let badgeHtml = '';
        if (irradiance === 0) {
            badgeHtml = `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-100 text-slate-500">Night</span>`;
        } else if (irradiance > 500) {
            badgeHtml = `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-800">Peak Yield</span>`;
        } else {
            badgeHtml = `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-teal-100 text-teal-800">Moderate</span>`;
        }

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

    if (yieldChartInstance) {
        yieldChartInstance.destroy();
    }

    yieldChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: hoursLabels,
            datasets: [{
                label: 'Hourly Output (kWh)',
                data: hourlyKwhData,
                borderColor: '#0d9488',
                backgroundColor: 'rgba(13, 148, 136, 0.15)',
                borderWidth: 3,
                fill: true,
                tension: 0.4,
                pointRadius: 3,
                pointHoverRadius: 6
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: { label: (context) => ` Yield: ${context.parsed.y} kWh` }
                }
            },
            scales: {
                x: { title: { display: true, text: 'Hour of Day (LST)' }, grid: { display: false } },
                y: { beginAtZero: true, title: { display: true, text: 'Energy (kWh)' } }
            }
        }
    });
}

// Populate appliance list based on total daily yield
function populateAppliances(kwh) {
    const list = document.getElementById('applianceList');
    list.innerHTML = ''; 

    const appliances = [
        { name: '1.5 Ton DC Inverter AC', threshold: 18, desc: '~12 hours runtime', icon: 'fa-snowflake', color: 'text-blue-500', bg: 'bg-blue-50' },
        { name: 'Refrigerator', threshold: 3, desc: 'Full 24 hours runtime', icon: 'fa-icicles', color: 'text-cyan-500', bg: 'bg-cyan-50' },
        { name: 'Water Pump (1 HP)', threshold: 1.5, desc: '~1.5 hours runtime', icon: 'fa-faucet-drip', color: 'text-indigo-500', bg: 'bg-indigo-50' },
        { name: '4 Ceiling Fans', threshold: 2, desc: '12 hours runtime', icon: 'fa-fan', color: 'text-slate-500', bg: 'bg-slate-100' },
        { name: 'Basic Lighting & TV', threshold: 1, desc: '6 hours evening usage', icon: 'fa-lightbulb', color: 'text-amber-500', bg: 'bg-amber-50' }
    ];

    let addedCount = 0;
    let remainingKwh = kwh;

    appliances.forEach(app => {
        if (remainingKwh >= app.threshold && addedCount < 4) {
            const li = document.createElement('li');
            li.className = 'flex items-center p-3 border border-slate-100 rounded-lg bg-slate-50/50';
            li.innerHTML = `
                <div class="flex-shrink-0 h-10 w-10 rounded-full ${app.bg} flex items-center justify-center mr-4 shadow-sm border border-white">
                    <i class="fa-solid ${app.icon} ${app.color}"></i>
                </div>
                <div class="flex-1 min-w-0">
                    <p class="text-sm font-semibold text-slate-800 truncate">${app.name}</p>
                    <p class="text-xs text-slate-500 truncate">${app.desc}</p>
                </div>
                <div class="flex-shrink-0">
                    <span class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-teal-100 text-teal-800">
                        Covered
                    </span>
                </div>
            `;
            list.appendChild(li);
            remainingKwh -= app.threshold;
            addedCount++;
        }
    });

    if (addedCount === 0) {
        const li = document.createElement('li');
        li.className = 'flex items-center p-3 border border-amber-100 rounded-lg bg-amber-50 col-span-full';
        li.innerHTML = `
            <div class="flex-shrink-0 h-10 w-10 rounded-full bg-amber-100 flex items-center justify-center mr-4 text-amber-600">
                <i class="fa-solid fa-battery-quarter"></i>
            </div>
            <div class="flex-1 min-w-0">
                <p class="text-sm font-semibold text-amber-800">Low Generation Expected</p>
                <p class="text-xs text-amber-600">Consider reducing appliance usage or switching to grid backup.</p>
            </div>
        `;
        list.appendChild(li);
    }
}

// Smooth counting animation for numerical displays
function animateValue(id, start, end, duration) {
    if (start === end) return;
    let obj = document.getElementById(id);
    let startTimestamp = null;
    const step = (timestamp) => {
        if (!startTimestamp) startTimestamp = timestamp;
        const progress = Math.min((timestamp - startTimestamp) / duration, 1);
        const current = progress * (end - start) + start;
        obj.innerHTML = current.toFixed(1);
        if (progress < 1) {
            window.requestAnimationFrame(step);
        } else {
            obj.innerHTML = end.toFixed(1);
        }
    };
    window.requestAnimationFrame(step);
}
