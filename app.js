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
    const tableBody = document
