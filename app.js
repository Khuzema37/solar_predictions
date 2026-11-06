// Set to your deployed FastAPI URL when the frontend is hosted separately.
// For local testing with FastAPI serving the frontend, leave this empty.
const API_BASE = window.SOLAR_API_BASE || '';
let yieldChartInstance = null;
const byId = id => document.getElementById(id);
const setText = (id, value) => {
    const element = byId(id);
    if (element) element.textContent = value;
};
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

const WEATHER_CACHE_KEY = 'solar_open_meteo_forecast_v1';
const WEATHER_CACHE_TTL_MS = 1 * 60 * 60 * 1000;
const WEATHER_VARIABLES = [
    'temperature_2m', 'relative_humidity_2m', 'cloud_cover',
    'shortwave_radiation', 'direct_normal_irradiance', 'diffuse_radiation',
    'global_tilted_irradiance', 'wind_speed_10m', 'precipitation'
];
let forecastBundle = null;
let forecastLoadPromise = null;

function dateInPakistan(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
}

function tomorrowInPakistan() {
    const [year, month, day] = dateInPakistan().split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day + 1));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function readCachedForecast(targetDate) {
    try {
        const raw = localStorage.getItem(WEATHER_CACHE_KEY);
        if (!raw) return null;
        const cached = JSON.parse(raw);
        const age = Date.now() - Number(cached.savedAt);
        if (cached.date !== targetDate || !Number.isFinite(age) || age < 0 || age >= WEATHER_CACHE_TTL_MS) {
            return null;
        }
        if (!cached.hourly || !cached.daily || cached.hourly.time?.length !== 24) return null;
        return cached;
    } catch (error) {
        console.warn('Could not read browser weather cache:', error);
        return null;
    }
}

async function fetchWeatherBundle() {
    const targetDate = tomorrowInPakistan();
    const cached = readCachedForecast(targetDate);
    if (cached) {
        console.info('Using browser-cached Open-Meteo forecast.');
        return cached;
    }

    // Read installation coordinates and array orientation from the backend so
    // the browser requests exactly the same site/tilt/azimuth as the model.
    const systemResponse = await fetch(`${API_BASE}/api/system`);
    const system = await systemResponse.json().catch(() => ({}));
    if (!systemResponse.ok) throw new Error(system.detail || `Backend configuration error ${systemResponse.status}`);

    const params = new URLSearchParams({
        latitude: system.latitude,
        longitude: system.longitude,
        hourly: WEATHER_VARIABLES.join(','),
        daily: 'temperature_2m_max,precipitation_sum,weather_code',
        timezone: system.timezone || 'Asia/Karachi',
        tilt: system.tilt_degrees,
        azimuth: system.azimuth_degrees,
        start_date: targetDate,
        end_date: targetDate
    });
    const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.error) {
        throw new Error(payload.reason || `Open-Meteo error ${response.status}`);
    }
    if (!payload.hourly || payload.hourly.time?.length !== 24 || !payload.daily) {
        throw new Error('Open-Meteo did not return a complete 24-hour forecast.');
    }

    const bundle = { date: targetDate, hourly: payload.hourly, daily: payload.daily, savedAt: Date.now() };
    try { localStorage.setItem(WEATHER_CACHE_KEY, JSON.stringify(bundle)); }
    catch (error) { console.warn('Browser cache could not be saved:', error); }
    console.info('Fetched and cached a new Open-Meteo forecast for six hours.');
    return bundle;
}

function outlookFromBundle(bundle) {
    return {
        max_temperature_c: Number(bundle.daily.temperature_2m_max[0]),
        precipitation_mm: Number(bundle.daily.precipitation_sum[0]),
        weather_code: Number(bundle.daily.weather_code[0])
    };
}

async function ensureForecastBundle() {
    const targetDate = tomorrowInPakistan();
    if (forecastBundle && forecastBundle.date === targetDate && Date.now() - forecastBundle.savedAt < WEATHER_CACHE_TTL_MS) {
        return forecastBundle;
    }
    if (!forecastLoadPromise) {
        forecastLoadPromise = fetchWeatherBundle()
            .then(bundle => { forecastBundle = bundle; return bundle; })
            .finally(() => { forecastLoadPromise = null; });
    }
    return forecastLoadPromise;
}

async function loadWeatherOnPageOpen() {
    const description = byId('weather_description');
    const icon = byId('weather_icon');
    description.textContent = 'Loading tomorrow\'s forecast...';
    icon.textContent = '⏳';
    try {
        forecastBundle = await ensureForecastBundle();
        updateOutlook(outlookFromBundle(forecastBundle));
        const dateEl = byId('weather_forecast_date');
        if (dateEl) dateEl.textContent = forecastBundle.date;
    } catch (error) {
        description.textContent = 'Forecast temporarily unavailable';
        icon.textContent = '⚠️';
        console.error('Unable to load weather preview:', error);
    }
}

function renderHourlyChart(hourly) {
    const ctx = byId('hourlyYieldChart').getContext('2d');
    if (yieldChartInstance) yieldChartInstance.destroy();
    yieldChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: hourly.map(row => row.time.slice(11, 16)),
            datasets: [{
                label: 'Estimated energy in each hour (kWh)',
                data: hourly.map(row => row.predicted_energy_kwh),
                borderColor: '#0d9488',
                backgroundColor: 'rgba(13,148,136,.14)',
                borderWidth: 3,
                fill: true,
                tension: .3,
                pointRadius: 2
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                x: { grid: { display: false }, title: { display: true, text: 'Local time (Pakistan)' } },
                y: { beginAtZero: true, title: { display: true, text: 'Estimated energy (kWh per hour)' } }
            }
        }
    });
}

function populateHourlyTable(hourly) {
    const body = byId('hourlyTableBody');
    body.replaceChildren();
    hourly.forEach((item, index) => {
        const tr = document.createElement('tr');
        tr.className = index % 2 ? 'bg-slate-50/50' : 'bg-white';
        const cells = [
            item.time.slice(11, 16),
            `${fmt(item.irradiance_w_m2, 1)} W/m²`,
            `${fmt(item.predicted_energy_kwh, 3)} kWh`,
            item.irradiance_w_m2 <= 0 ? 'No sunlight' : item.predicted_energy_kwh > 0 ? 'Generating' : 'Low output'
        ];
        cells.forEach(value => {
            const td = document.createElement('td');
            td.className = 'py-2 px-3 text-slate-700';
            td.textContent = value;
            tr.appendChild(td);
        });
        body.appendChild(tr);
    });
}

// The API returns one predicted value for each one-hour interval.
// Therefore, the numeric value is kWh for that interval and numerically
// equals the average kW during that hour (interval duration = 1 hour).
function populateSolarInsights(hourly, outlook) {
    const valid = hourly
        .filter(row => Number.isFinite(Number(row.predicted_energy_kwh)))
        .map(row => ({
            ...row,
            energy: Math.max(0, Number(row.predicted_energy_kwh)),
            irradiance: Number(row.irradiance_w_m2) || 0,
            cloud: Number(row.cloud_cover_pct)
        }));

    if (!valid.length) {
        throw new Error('The API returned no usable hourly prediction values.');
    }

    // Peak one-hour interval.
    const peak = valid.reduce((best, row) => row.energy > best.energy ? row : best, valid[0]);
    const peakHour = peak.energy > 0 ? peak.time.slice(11, 16) : 'No solar output';
    setText('peakHourValue', peakHour);
    setText('peakHourNote', peak.energy > 0
        ? `${fmt(peak.energy, 2)} kWh during this hour (about ${fmt(peak.energy, 2)} kW average)`
        : 'No meaningful generation is predicted.');

    // Find the strongest rolling three-hour window by total energy.
    let bestStart = 0;
    let bestTotal = -1;
    const windowSize = Math.min(3, valid.length);
    for (let i = 0; i <= valid.length - windowSize; i++) {
        const total = valid.slice(i, i + windowSize).reduce((sum, row) => sum + row.energy, 0);
        if (total > bestTotal) {
            bestTotal = total;
            bestStart = i;
        }
    }
    const windowRows = valid.slice(bestStart, bestStart + windowSize);
    const windowStart = windowRows[0].time.slice(11, 16);
    const lastTime = windowRows[windowRows.length - 1].time;
    const lastHour = Number(lastTime.slice(11, 13));
    const windowEnd = `${String((lastHour + 1) % 24).padStart(2, '0')}:00`;
    setText('peakWindowValue', `${windowStart}–${windowEnd}`);
    setText('peakWindowNote',
        `${fmt(bestTotal, 2)} kWh across ${windowSize} hours (${fmt(bestTotal / windowSize, 2)} kW average)`);

    // Weather impact is a transparent rule-of-thumb based on forecast daylight
    // cloud cover and daily precipitation. It is not a physical PV simulation.
    const daylight = valid.filter(row => row.irradiance >= 50 && Number.isFinite(row.cloud));
    const averageCloud = daylight.length
        ? daylight.reduce((sum, row) => sum + row.cloud, 0) / daylight.length
        : null;
    const rain = Number(outlook?.precipitation_mm);
    const weatherCode = Number(outlook?.weather_code);
    let impactTitle = 'Weather impact unavailable';
    let impactNote = 'The forecast did not provide enough daylight cloud-cover data to estimate weather impact.';

    if (averageCloud !== null) {
        if (averageCloud < 25) {
            impactTitle = 'Favourable solar conditions';
            impactNote = 'Forecast daylight cloud cover is low, so clouds are less likely to reduce solar production substantially.';
        } else if (averageCloud < 50) {
            impactTitle = 'Some cloud impact possible';
            impactNote = 'Partly cloudy conditions may cause some variation in solar production.';
        } else if (averageCloud < 75) {
            impactTitle = 'Clouds may reduce output';
            impactNote = 'Higher forecast daylight cloud cover may reduce or fluctuate solar generation.';
        } else {
            impactTitle = 'Significant cloud impact possible';
            impactNote = 'Very high forecast daylight cloud cover may substantially reduce solar generation.';
        }
    }

    if (Number.isFinite(rain) && rain >= 1) {
        impactNote += ` Rain is also forecast (${fmt(rain, 1)} mm).`;
    } else if (Number.isFinite(rain) && rain > 0) {
        impactNote += ` A small amount of rain is forecast (${fmt(rain, 1)} mm).`;
    }
    if (weatherCode >= 95) {
        impactNote += ' Thunderstorms are indicated in the daily weather forecast.';
    }

    setText('weatherImpactValue', impactTitle);
    setText('weatherImpactNote', impactNote);
    setText('daylightCloudValue', averageCloud === null ? 'Unavailable' : `${fmt(averageCloud, 0)}%`);
    setText('rainImpactValue', Number.isFinite(rain) ? `${fmt(rain, 1)} mm` : 'Unavailable');
}


// Stage 2.1: hourly, inverter-aware appliance planning.
// The API's predicted_energy_kwh is energy over one hour; numerically it is
// also the average AC kW for that one-hour interval.
const APPLIANCE_PRESETS = {
    fan: { name: 'Ceiling fan', watts: 75, quantity: 1, hours: 8, category: 'essential' },
    led: { name: 'LED bulb', watts: 12, quantity: 1, hours: 5, category: 'essential' },
    tv: { name: 'LED television', watts: 100, quantity: 1, hours: 4, category: 'schedulable' },
    refrigerator: { name: 'Refrigerator', watts: 150, quantity: 1, hours: 8, category: 'automatic' },
    ac: { name: 'Inverter AC', watts: 1200, quantity: 1, hours: 6, category: 'automatic' },
    washing: { name: 'Washing machine', watts: 500, quantity: 1, hours: 1, category: 'schedulable' },
    pump: { name: 'Water pump', watts: 750, quantity: 1, hours: 1, category: 'schedulable' },
    custom: { name: 'Custom appliance', watts: 100, quantity: 1, hours: 1, category: 'schedulable' }
};
let latestPrediction = null;
let applianceRowCounter = 0;
let plannerChartInstance = null;

function applianceRowValues(row) {
    const watts = Number(row.querySelector('[data-field="watts"]').value);
    const quantity = Number(row.querySelector('[data-field="quantity"]').value);
    const hours = Number(row.querySelector('[data-field="hours"]').value);
    if (![watts, quantity, hours].every(Number.isFinite) || watts <= 0 || quantity <= 0 ||
        watts > 100000 || quantity > 100 || hours < 0 || hours > 24 || !Number.isInteger(hours)) return null;
    return {
        name: row.querySelector('[data-field="name"]').value.trim() || 'Unnamed appliance',
        watts, quantity, hours,
        category: row.querySelector('[data-field="category"]').value,
        energy: watts * quantity * hours / 1000,
        demandKw: watts * quantity / 1000
    };
}

function updateApplianceTotal() {
    let total = 0, valid = true;
    document.querySelectorAll('.appliance-row').forEach(row => {
        const item = applianceRowValues(row);
        const output = row.querySelector('[data-field="energy"]');
        if (!item) { valid = false; output.textContent = 'Check inputs'; }
        else { total += item.energy; output.textContent = `${item.energy.toFixed(2)} kWh`; }
    });
    setText('applianceTotal', valid ? `${total.toFixed(2)} kWh/day` : 'Check appliance inputs');
    return valid ? total : null;
}

function addApplianceRow(presetKey) {
    const preset = APPLIANCE_PRESETS[presetKey] || APPLIANCE_PRESETS.custom;
    const body = byId('applianceRows');
    byId('applianceEmptyRow')?.remove();
    const row = document.createElement('tr');
    row.className = 'appliance-row';
    row.dataset.rowId = String(++applianceRowCounter);

    const nameCell = document.createElement('td');
    nameCell.className = 'px-2 py-2';
    const name = document.createElement('input');
    name.className = 'appliance-name-input text-xs';
    name.value = preset.name; name.maxLength = 50; name.dataset.field = 'name';
    name.setAttribute('aria-label', 'Appliance name');
    nameCell.appendChild(name); row.appendChild(nameCell);

    const addNumberCell = (field, value, min, max, step) => {
        const td = document.createElement('td'); td.className = 'px-2 py-2';
        const input = document.createElement('input');
        input.type = 'number'; input.className = 'appliance-input text-xs';
        input.dataset.field = field; input.value = value;
        input.min = min; input.max = max; input.step = step;
        input.setAttribute('aria-label', field); td.appendChild(input); return td;
    };
    row.appendChild(addNumberCell('watts', preset.watts, '1', '100000', '1'));
    row.appendChild(addNumberCell('quantity', preset.quantity, '1', '100', '1'));
    row.appendChild(addNumberCell('hours', preset.hours, '0', '24', '1'));

    const categoryCell = document.createElement('td'); categoryCell.className = 'px-2 py-2';
    const category = document.createElement('select');
    category.className = 'appliance-category-input text-xs'; category.dataset.field = 'category';
    category.setAttribute('aria-label', 'Appliance category');
    [['schedulable','Schedulable'],['essential','Essential'],['automatic','Automatic']].forEach(([value,label]) => {
        const option = document.createElement('option'); option.value = value; option.textContent = label;
        category.appendChild(option);
    });
    category.value = preset.category; categoryCell.appendChild(category); row.appendChild(categoryCell);

    const energyCell = document.createElement('td');
    energyCell.className = 'px-2 py-2 text-right whitespace-nowrap font-semibold text-slate-700';
    energyCell.dataset.field = 'energy'; energyCell.textContent = '0.00 kWh'; row.appendChild(energyCell);

    const removeCell = document.createElement('td'); removeCell.className = 'px-2 py-2 text-right';
    const remove = document.createElement('button'); remove.type = 'button';
    remove.className = 'text-red-600 hover:text-red-800 px-2 py-1';
    remove.innerHTML = '<i class="fa-solid fa-trash" aria-hidden="true"></i>';
    remove.setAttribute('aria-label', 'Remove appliance');
    remove.addEventListener('click', () => {
        row.remove();
        if (!document.querySelector('.appliance-row')) {
            const empty = document.createElement('tr'); empty.id = 'applianceEmptyRow';
            empty.innerHTML = '<td colspan="7" class="px-2 py-5 text-center text-slate-500">Add appliances to estimate your daily consumption.</td>';
            body.appendChild(empty);
        }
        updateApplianceTotal(); byId('applianceResults').classList.add('hidden');
    });
    removeCell.appendChild(remove); row.appendChild(removeCell);
    row.addEventListener('input', () => { updateApplianceTotal(); byId('applianceResults').classList.add('hidden'); });
    row.addEventListener('change', () => { updateApplianceTotal(); byId('applianceResults').classList.add('hidden'); });
    body.appendChild(row); updateApplianceTotal();
}

// Find a contiguous block where each hour's remaining solar headroom can
// support this appliance's rated running demand. Rank feasible blocks by
// solar headroom (not merely by total solar energy).
function findOperatingWindow(solarKw, alreadyScheduledKw, demandKw, durationHours) {
    const slots = Math.max(1, Math.ceil(durationHours));
    let best = null;
    for (let start = 0; start <= solarKw.length - slots; start++) {
        let feasibleHours = 0, minimumHeadroom = Infinity, totalHeadroom = 0;
        for (let offset = 0; offset < slots; offset++) {
            const idx = start + offset;
            const headroom = Math.max(0, solarKw[idx] - alreadyScheduledKw[idx]);
            if (headroom + 1e-9 >= demandKw) feasibleHours++;
            minimumHeadroom = Math.min(minimumHeadroom, headroom);
            totalHeadroom += Math.min(headroom, demandKw);
        }
        const candidate = { start, end: start + slots, feasibleHours, minimumHeadroom, totalHeadroom };
        if (!best || candidate.feasibleHours > best.feasibleHours ||
            (candidate.feasibleHours === best.feasibleHours && candidate.totalHeadroom > best.totalHeadroom)) best = candidate;
    }
    return best;
}

function drawPlannerChart(solarKw, totalLoadKw) {
    const canvas = byId('plannerHourlyChart');
    if (!canvas || typeof Chart === 'undefined') return;
    if (plannerChartInstance) plannerChartInstance.destroy();
    const labels = latestPrediction.hourly.map(item => item.time.slice(11, 16));
    plannerChartInstance = new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: { labels, datasets: [
            { label: 'Forecast solar AC output (kW)', data: solarKw, borderColor: '#0d9488', backgroundColor: 'rgba(13,148,136,.12)', fill: true, tension: .25, pointRadius: 1.5 },
            { label: 'Total estimated appliance load (kW)', data: totalLoadKw, borderColor: '#d97706', backgroundColor: 'rgba(217,119,6,.08)', fill: false, tension: 0, pointRadius: 1.5 }
        ]},
        options: { responsive: true, maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: { legend: { position: 'bottom' } },
            scales: { x: { title: { display: true, text: 'Pakistan local time' }, grid: { display: false } },
                y: { beginAtZero: true, title: { display: true, text: 'Average power (kW)' } } }
        }
    });
}

function calculateAppliancePlan() {
    const total = updateApplianceTotal();
    const error = byId('applianceError'); error.textContent = '';
    const rows = [...document.querySelectorAll('.appliance-row')];
    if (total === null) { error.textContent = 'Correct all appliance values. Wattage and quantity must be positive; hours must be whole numbers between 0 and 24.'; return; }
    if (!rows.length) { error.textContent = 'Add at least one appliance before calculating.'; return; }
    if (!latestPrediction || !Array.isArray(latestPrediction.hourly) || latestPrediction.hourly.length !== 24) {
        error.textContent = 'First calculate tomorrow’s solar generation using the Predict button.'; return;
    }

    const inverterKw = Number(byId('inverterKw').value);
    if (!Number.isFinite(inverterKw) || inverterKw <= 0) { error.textContent = 'Enter a valid inverter capacity first.'; return; }
    const items = rows.map(applianceRowValues);
    if (items.some(item => !item)) { error.textContent = 'One or more appliance inputs are invalid.'; return; }

    const solarKw = latestPrediction.hourly.map(item =>
        Math.min(inverterKw, Math.max(0, Number(item.predicted_energy_kwh) || 0)));
    const scheduledKw = Array(24).fill(0);
    const recommendations = [];
    const schedulable = items.filter(item => item.category === 'schedulable' && item.hours > 0);
    const nonSchedulable = items.filter(item => item.category !== 'schedulable');

    // Schedule largest loads first so small loads do not occupy the best slots.
    schedulable.sort((a, b) => b.demandKw - a.demandKw);
    let scheduledEnergy = 0, coveredEnergy = 0;
    schedulable.forEach(item => {
        const window = findOperatingWindow(solarKw, scheduledKw, item.demandKw, item.hours);
        const end = Math.min(24, window.end);
        const startTime = latestPrediction.hourly[window.start].time.slice(11, 16);
        const endTime = end >= 24 ? '24:00' : latestPrediction.hourly[end].time.slice(11, 16);
        const feasible = window.feasibleHours === (window.end - window.start);
        const hoursPlaced = Math.min(item.hours, window.end - window.start);
        for (let h = window.start; h < window.end; h++) scheduledKw[h] += item.demandKw;
        scheduledEnergy += item.energy;
        if (feasible) {
            coveredEnergy += item.energy;
            recommendations.push(`<article class="planner-recommendation"><strong>${escapeHtml(item.name)}</strong><p>Suggested window: <strong>${startTime}–${endTime}</strong> (${item.hours.toFixed(1)} planned operating hours).</p><p class="planner-good">Estimated solar headroom supports the rated load in every selected hour, before unlisted household loads.</p><p class="planner-reason">Reason: minimum available solar headroom in this window is ${window.minimumHeadroom.toFixed(2)} kW; appliance demand is ${item.demandKw.toFixed(2)} kW.</p></article>`);
        } else {
            const percent = Math.round(window.feasibleHours / Math.max(1, window.end - window.start) * 100);
            recommendations.push(`<article class="planner-recommendation planner-warning"><strong>${escapeHtml(item.name)}</strong><p>Best available window: <strong>${startTime}–${endTime}</strong>, but the forecast does not support the full rated load in every hour.</p><p>Only ${window.feasibleHours} of ${window.end - window.start} hours meet the ${item.demandKw.toFixed(2)} kW demand (${percent}%). Consider a shorter run, a lower-power appliance, or grid support.</p><p class="planner-reason">Reason: the selected window has the best combined solar headroom, but full solar coverage cannot be confirmed.</p></article>`);
        }
    });

    nonSchedulable.forEach(item => {
        const categoryText = item.category === 'automatic' ? 'Automatic / cycling load' : 'Essential load';
        recommendations.push(`<article class="planner-recommendation planner-neutral"><strong>${escapeHtml(item.name)}</strong> <span class="planner-category">${categoryText}</span><p>Do not automatically shift this appliance. Its entered energy estimate is ${item.energy.toFixed(2)} kWh/day (${item.demandKw.toFixed(2)} kW while running).</p><p class="planner-reason">${item.category === 'automatic' ? 'Actual demand varies with thermostat and duty cycle; entered hours should represent estimated compressor or operating hours.' : 'Keep essential usage based on household needs. This planner does not advise delaying essential loads.'}</p></article>`);
    });

    // Essential and automatic loads have no entered clock-time profile.
    // Approximate them as a constant average load across all 24 hours.
    const fixedDailyEnergy = nonSchedulable.reduce((sum, item) => sum + item.energy, 0);
    const fixedAverageKw = fixedDailyEnergy / 24;
    const totalLoadKw = scheduledKw.map(value => value + fixedAverageKw);

    // Hourly energy accounting (each forecast point represents one hour).
    let directSolarKwh = 0;
    let potentialSurplusKwh = 0;
    let gridOrBackupKwh = 0;
    for (let h = 0; h < 24; h++) {
        directSolarKwh += Math.min(solarKw[h], totalLoadKw[h]);
        potentialSurplusKwh += Math.max(0, solarKw[h] - totalLoadKw[h]);
        gridOrBackupKwh += Math.max(0, totalLoadKw[h] - solarKw[h]);
    }

    const generation = Number(latestPrediction.total_daily_kwh);
    const balance = generation - total;
    const accountedGeneration = directSolarKwh + potentialSurplusKwh;
    const accountedConsumption = directSolarKwh + gridOrBackupKwh;

    setText('plannerGeneration', `${generation.toFixed(2)} kWh`);
    setText('plannerConsumption', `${total.toFixed(2)} kWh`);
    setText('plannerBalance', `${balance >= 0 ? '+' : ''}${balance.toFixed(2)} kWh`);
    setText('plannerDirectUse', `${directSolarKwh.toFixed(2)} kWh`);
    setText('plannerSurplus', `${potentialSurplusKwh.toFixed(2)} kWh`);
    const systemType = byId('plannerSystemType').value;
    setText('plannerGridUse',
        `${gridOrBackupKwh.toFixed(2)} kWh`);
    const gridLabel = byId('plannerGridUseLabel');
    if (gridLabel) gridLabel.textContent = systemType === 'on_grid'
        ? 'Estimated grid energy required'
        : 'Estimated battery / backup energy required';

    byId('plannerBalance').style.color = balance >= 0 ? '#0f766e' : '#b91c1c';

    const coverage = total > 0 ? Math.min(100, directSolarKwh / total * 100) : 0;
    setText('plannerCoverage', total > 0
        ? `${coverage.toFixed(0)}% of total appliance consumption supplied directly by forecast solar`
        : 'No appliance consumption entered');
    setText('plannerPeakLoad', `${Math.max(...totalLoadKw).toFixed(2)} kW`);
    drawPlannerChart(solarKw, totalLoadKw);

    const systemNote = systemType === 'on_grid'
        ? 'On-grid estimate: the grid may supply the hourly shortfall. Actual grid import and export are not measured.'
        : 'Hybrid/off-grid estimate: hourly shortfall is shown as battery/backup energy required. Battery charging, storage losses, and discharge limits are not modelled.';
    const balanceNote = `Daily net difference: ${balance >= 0 ? '+' : ''}${balance.toFixed(2)} kWh. This daily difference is not the same as direct solar use.`;
    const accountingNote = `Hourly accounting: generation = direct solar use (${directSolarKwh.toFixed(2)} kWh) + potential surplus (${potentialSurplusKwh.toFixed(2)} kWh); consumption = direct solar use (${directSolarKwh.toFixed(2)} kWh) + grid/backup requirement (${gridOrBackupKwh.toFixed(2)} kWh).`;
    const assumptionNote = `Essential and automatic loads are spread evenly across 24 hours because no clock-time profile is entered. Flexible appliances are placed in their suggested operating windows. The hourly totals reconcile to ${accountedGeneration.toFixed(2)} kWh generation and ${accountedConsumption.toFixed(2)} kWh consumption (small rounding differences may occur).`;
    byId('applianceRecommendations').innerHTML =
        `<p class="text-sm font-semibold text-slate-800 mb-2">${escapeHtml(balanceNote)}</p>` +
        `<p class="text-xs text-slate-600 mb-2">${escapeHtml(accountingNote)}</p>` +
        `<p class="text-xs text-slate-500 mb-3">${escapeHtml(systemNote)} ${escapeHtml(assumptionNote)} Solar output is capped at the inverter AC capacity.</p>` +
        (recommendations.length ? recommendations.join('') : '<p>No appliance recommendations are needed for the current inputs.</p>');
    byId('applianceResults').classList.remove('hidden');
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char]);
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
        forecastBundle = await ensureForecastBundle();
        const response = await fetch(`${API_BASE}/api/predict/tomorrow`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                capacity_kwp: capacity,
                inverter_kw: inverter,
                date: forecastBundle.date,
                hourly: forecastBundle.hourly,
                daily: forecastBundle.daily
            })
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.detail || `API error ${response.status}`);

        if (!Array.isArray(payload.hourly) || payload.hourly.length === 0) {
            throw new Error('The prediction API returned no hourly forecast data.');
        }

        latestPrediction = payload;
        byId('finalKwh').textContent = fmt(payload.total_daily_kwh, 2);
        byId('forecastDate').textContent = payload.date;
        updateOutlook(payload.outlook);
        renderHourlyChart(payload.hourly);
        populateHourlyTable(payload.hourly);
        populateSolarInsights(payload.hourly, payload.outlook || {});

        byId('emptyState').classList.add('hidden');
        byId('populatedState').classList.remove('hidden');
        byId('populatedState').classList.add('flex');
    } catch (error) {
        setText('errorMessage', error.message || 'Could not fetch the forecast.');
        console.error(error);
    } finally {
        byId('btnLoader').style.display = 'none';
        byId('btnIcon').classList.remove('hidden');
        byId('apiStatusText').classList.add('hidden');
        submit.disabled = false;
    }
}

document.addEventListener('DOMContentLoaded', () => {
    loadWeatherOnPageOpen();
    byId('predictionForm').addEventListener('submit', runPrediction);
    byId('addApplianceButton').addEventListener('click', () => {
        const select = byId('appliancePreset');
        if (!select.value) {
            setText('applianceError', 'Choose an appliance first.');
            return;
        }
        addApplianceRow(select.value);
        select.value = '';
        setText('applianceError', '');
    });
    byId('calculateAppliancesButton').addEventListener('click', calculateAppliancePlan);
    const updateClock = () => {
        byId('current_time_display').textContent = new Intl.DateTimeFormat('en-US', {
            timeZone: 'Asia/Karachi',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        }).format(new Date());
    };
    updateClock();
    setInterval(updateClock, 1000);
});
