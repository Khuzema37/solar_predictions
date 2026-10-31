// Set to your deployed FastAPI URL when the frontend is hosted separately.
// For local testing with FastAPI serving the frontend, leave this empty.
const API_BASE = 'https://solar-predictions.onrender.com';
let yieldChartInstance = null;
const byId = id => document.getElementById(id);
const fmt = (n, digits = 2) => Number(n).toFixed(digits);

function weatherDescription(code) {
    if (code === 0) return ['Clear sky', '☀️'];
    if ([1, 2].includes(code)) return ['Partly cloudy', '⛅'];
    if (code === 3) return ['Overcast', '☁️'];
    if (code >= 45 && code <= 48) return ['Fog', '🌫️'];
    if (code >= 51 && code <= 67) return ['Rain', '🌧️'];
    if (code >= 95) return ['Thunderstorm', '⛈️'];
    return ['Forecast available', '🌤️'];
}

function updateOutlook(data) {
    const [description, icon] = weatherDescription(data.weather_code);
    byId('weather_description').textContent = description;
    byId('weather_icon').textContent = icon;
    byId('temp_display').textContent = `${fmt(data.max_temperature_c, 1)} °C`;
    byId('precip_display').textContent = `${fmt(data.precipitation_mm, 1)} mm`;
}

function renderHourlyChart(hourly) {
    const ctx = byId('hourlyYieldChart').getContext('2d');
    if (yieldChartInstance) yieldChartInstance.destroy();
    yieldChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: hourly.map(row => row.time.slice(11, 16)),
            datasets: [{
                label: 'Estimated hourly energy (kWh)',
                data: hourly.map(row => row.predicted_energy_kwh),
                borderColor: '#0d9488', backgroundColor: 'rgba(13,148,136,.14)',
                borderWidth: 3, fill: true, tension: .3, pointRadius: 2
            }]
        },
        options: {responsive: true, maintainAspectRatio: false,
            plugins: {legend: {display: false}},
            scales: {x: {grid: {display: false}}, y: {beginAtZero: true}}}
    });
}

function populateHourlyTable(hourly) {
    const body = byId('hourlyTableBody');
    body.replaceChildren();
    hourly.forEach((item, index) => {
        const tr = document.createElement('tr');
        tr.className = index % 2 ? 'bg-slate-50/50' : 'bg-white';
        const cells = [item.time.slice(11, 16), `${fmt(item.irradiance_w_m2, 1)} W/m²`,
            `${fmt(item.predicted_energy_kwh, 3)} kWh`,
            item.irradiance_w_m2 <= 0 ? 'No sunlight' : item.predicted_energy_kwh > 0 ? 'Generating' : 'Low output'];
        cells.forEach(value => { const td = document.createElement('td'); td.className = 'py-2 px-3 text-slate-700'; td.textContent = value; tr.appendChild(td); });
        body.appendChild(tr);
    });
}

function populateAppliances(hourly) {
    const list = byId('applianceList');
    list.replaceChildren();
    const peak = Math.max(...hourly.map(h => h.predicted_energy_kwh));
    const p = document.createElement('li');
    p.className = 'p-4 rounded-xl bg-slate-50 border border-slate-200 text-sm text-slate-700';
    p.textContent = `Estimated peak one-hour average output: ${fmt(peak, 2)} kW. Appliance operation depends on instantaneous generation, startup surges, inverter limits, batteries, and grid supply. This forecast cannot certify a load bundle as safe to run.`;
    list.appendChild(p);
}

async function runPrediction(event) {
    event.preventDefault();
    const capacity = Number(byId('systemKw').value);
    const inverter = Number(byId('inverterKw').value);
    if (!Number.isFinite(capacity) || !Number.isFinite(inverter) || capacity <= 0 || inverter <= 0 || capacity > 1000 || inverter > 1000) {
        byId('errorMessage').textContent = 'Enter valid panel and inverter capacities between 0 and 1000.';
        return;
    }
    const submit = byId('predictButton');
    byId('errorMessage').textContent = '';
    byId('btnLoader').style.display = 'block';
    byId('btnIcon').classList.add('hidden');
    byId('apiStatusText').classList.remove('hidden');
    submit.disabled = true;
    try {
        const params = new URLSearchParams({capacity_kwp: capacity, inverter_kw: inverter});
        const response = await fetch(`${API_BASE}/api/predict/tomorrow?${params}`);
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.detail || `API error ${response.status}`);
        byId('finalKwh').textContent = fmt(payload.total_daily_kwh, 2);
        byId('forecastDate').textContent = payload.date;
        byId('methodLabel').textContent = payload.method === 'xgboost_scaled_reference' ? 'XGBoost reference (scaled)' : 'Parameterized physics estimate';
        byId('methodNote').textContent = payload.method_note;
        byId('physicsTotal').textContent = `${fmt(payload.physics_total_kwh, 2)} kWh`;
        byId('systemSummary').textContent = `${fmt(payload.system.capacity_kwp, 1)} kWp panels · ${fmt(payload.system.inverter_kw, 1)} kW inverter`;
        updateOutlook(payload.outlook);
        renderHourlyChart(payload.hourly);
        populateHourlyTable(payload.hourly);
        populateAppliances(payload.hourly);
        byId('emptyState').classList.add('hidden');
        byId('populatedState').classList.remove('hidden');
        byId('populatedState').classList.add('flex');
    } catch (error) {
        byId('errorMessage').textContent = error.message || 'Could not fetch the forecast.';
        console.error(error);
    } finally {
        byId('btnLoader').style.display = 'none';
        byId('btnIcon').classList.remove('hidden');
        byId('apiStatusText').classList.add('hidden');
        submit.disabled = false;
    }
}

document.addEventListener('DOMContentLoaded', () => {
    byId('predictionForm').addEventListener('submit', runPrediction);
    const updateClock = () => { byId('current_time_display').textContent = new Intl.DateTimeFormat('en-US', {timeZone: 'Asia/Karachi', hour: '2-digit', minute: '2-digit', second: '2-digit'}).format(new Date()); };
    updateClock(); setInterval(updateClock, 1000);
});
