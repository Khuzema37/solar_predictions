// Global variables
let hourlyWeatherPayload = [];
let yieldChartInstance = null;

document.addEventListener("DOMContentLoaded", async () => {
    // 1. Live Clock Function
    function updateCurrentTime() {
        const timeElement = document.getElementById('current_time_display');
        if (timeElement) {
            const now = new Date();
            timeElement.innerText = now.toLocaleTimeString('en-US', {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: true
            });
        }
    }
    
    // Start time and update every second
    updateCurrentTime();
    setInterval(updateCurrentTime, 1000);

    // 2. Fetch Tomorrow's Weather Details
    const LAT = 29.39; // Bahawalpur Latitude
    const LON = 71.67; // Bahawalpur Longitude
    
    try {
        // Fetch daily forecasts (max temp, total precip, weather code) + hourly data for the model
        const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}&daily=temperature_2m_max,precipitation_sum,weather_code&hourly=temperature_2m,relative_humidity_2m,wind_speed_10m,precipitation,cloud_cover,is_day&forecast_days=2&timezone=Asia%2FKarachi`;
        
        const weatherResponse = await fetch(weatherUrl);
        const weatherData = await weatherResponse.json();

        // Tomorrow is index 1 in Open-Meteo daily arrays
        const weatherCode = weatherData.daily.weather_code[1];
        const maxTemp = weatherData.daily.temperature_2m_max[1];
        const totalPrecip = weatherData.daily.precipitation_sum[1];
        
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

        // Update UI Banner elements
        const descEl = document.getElementById('weather_description');
        const iconEl = document.getElementById('weather_icon');
        const tempEl = document.getElementById('temp_display');
        const precipEl = document.getElementById('precip_display');

        if(descEl) descEl.innerText = ui.text;
        if(iconEl) iconEl.innerText = ui.icon;
        if(tempEl) tempEl.innerText = `${maxTemp.toFixed(1)} °C`;
        if(precipEl) precipEl.innerText = `${totalPrecip.toFixed(1)} mm`;

        // Build the 24-hour payload for tomorrow (Index 24 to 47 for XGBoost model)
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
        console.error('Error fetching weather details:', error);
        const descEl = document.getElementById('weather_description');
        const iconEl = document.getElementById('weather_icon');
        if(descEl) descEl.innerText = "Data Unavailable";
        if(iconEl) iconEl.innerText = "⚠️";
    }
});

// Handle Form Submission
document.getElementById('predictionForm').addEventListener('submit', async function(e) {
    e.preventDefault();
    
    if (hourlyWeatherPayload.length === 0) {
        return alert("Weather data is still loading or failed to load. Please refresh the page.");
    }

    const btnLoader = document.getElementById('btnLoader');
    const btnIcon = document.getElementById('btnIcon');
    const submitBtn = this.querySelector('button[type="submit"]');
    const apiStatusText = document.getElementById('apiStatusText');
    
    btnLoader.style.display = 'block';
    btnIcon.style.display = 'none';
    if(apiStatusText) apiStatusText.classList.remove('hidden');
    submitBtn.disabled = true;

    // Fixed calculations using System Size (kW)
    const systemKw = parseFloat(document.getElementById('systemKw').value);
    const fixedEfficiency = 0.20; 
    // Calculate physical Area: Area = kW / Efficiency
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

        // Update UI Dashboards
        animateValue("finalKwh", 0, resultData.total_daily_kwh, 1000);
        renderHourlyChart(resultData.hourly_kwh_yield);
        populateHourlyTable(resultData.hourly_irradiance_w_m2, resultData.hourly_kwh_yield);
        populateAppliances(resultData.total_daily_kwh);

        document.getElementById('emptyState').classList.add('hidden');
        document.getElementById('populatedState').classList.remove('hidden');
        document.getElementById('populatedState').classList.add('flex');

    } catch (error) {
        console.error('Error:', error);
        alert("Connection Error: Failed to connect to the prediction backend.");
    } finally {
        btnLoader.style.display = 'none';
        btnIcon.style.display = 'block';
        if(apiStatusText) apiStatusText.classList.add('hidden');
        submitBtn.disabled = false;
    }
});

// Populate the hour-by-hour forecast table
function populateHourlyTable(irradianceArray, kwhArray) {
    const tableBody = document.getElementById('hourlyTableBody');
    tableBody.innerHTML = ''; 
    let rowCount = 0;

    for (let hour = 0; hour < 24; hour++) {
        const irradiance = irradianceArray[hour];
        
        // Hide night hours completely from the table
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
                borderWidth: 3, 
                fill: true, 
                tension: 0.4, 
                pointRadius: 3
            }]
        },
        options: {
            responsive: true, 
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                x: { grid: { display: false } },
                y: { beginAtZero: true }
            }
        }
    });
}

// Dynamically populate appliances based strictly on peak daylight/sun hours
function populateAppliances(totalKwh) {
    const list = document.getElementById('applianceList');
    list.innerHTML = ''; 

    // All appliances are strictly bounded to peak solar generation hours (max 5 hours)
    const appliances = [
        { name: '1.5 Ton DC Inverter AC', consume: 1.2, maxRun: 5, icon: 'fa-snowflake', color: 'text-blue-500', bg: 'bg-blue-50' },
        { name: 'Water Pump (1 HP)', consume: 0.75, maxRun: 2, icon: 'fa-faucet-drip', color: 'text-indigo-500', bg: 'bg-indigo-50' },
        { name: 'Washing Machine', consume: 0.5, maxRun: 2, icon: 'fa-shirt', color: 'text-purple-500', bg: 'bg-purple-50' },
        { name: 'Refrigerator (Daytime)', consume: 0.2, maxRun: 5, icon: 'fa-icicles', color: 'text-cyan-500', bg: 'bg-cyan-50' },
        { name: '4 Ceiling Fans', consume: 0.3, maxRun: 5, icon: 'fa-fan', color: 'text-slate-500', bg: 'bg-slate-100' }
    ];

    let remainingKwh = totalKwh;
    let addedCount = 0;

    appliances.forEach(app => {
        if (remainingKwh < app.consume || addedCount >= 4) return;
        
        let possibleHours = Math.floor(remainingKwh / app.consume);
        let actualHours = Math.min(possibleHours, app.maxRun);
        
        if (actualHours >= 1) {
            let runText = `~${actualHours} hours during peak sun`;
            
            remainingKwh -= (actualHours * app.consume);
            createApplianceCard(app, runText, list);
            addedCount++;
        }
    });

    if (addedCount === 0) {
        list.innerHTML = `<li class="p-3 border border-amber-100 rounded-lg bg-amber-50 col-span-full">
            <p class="text-sm font-semibold text-amber-800">Low Generation Expected</p>
            <p class="text-xs text-amber-600">Not enough energy to power appliances during peak sun hours.</p>
        </li>`;
    }
}

// Helper to create appliance DOM element
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

// Smooth counting animation for numerical displays
function animateValue(id, start, end, duration) {
    if (start === end) return;
    let obj = document.getElementById(id);
    if (!obj) return;
    let startTimestamp = null;
    const step = (timestamp) => {
        if (!startTimestamp) startTimestamp = timestamp;
        const progress = Math.min((timestamp - startTimestamp) / duration, 1);
        obj.innerHTML = (progress * (end - start) + start).toFixed(1);
        if (progress < 1) window.requestAnimationFrame(step);
    };
    window.requestAnimationFrame(step);
}
