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
    if (!data) return;
    const [description, icon] = weatherDescription(Number(data.weather_code));
    setText('weather_description', description);
    setText('weather_icon', icon);
    setText('temp_display', `${fmt(data.max_temperature_c, 1)} °C`);
    setText('precip_display', `${fmt(data.precipitation_mm, 1)} mm`);
}

const WEATHER_VARIABLES = [
    'temperature_2m', 'relative_humidity_2m', 'cloud_cover',
    'shortwave_radiation', 'direct_normal_irradiance', 'diffuse_radiation',
    'global_tilted_irradiance', 'wind_speed_10m', 'precipitation'
];

let forecastBundle = null; // Selected day's weather bundle.
let forecastBundles = {}; // Three daily bundles fetched together on page load.
let forecastLoadPromise = null;
let selectedForecastDate = null;
const resetAnimationTimers = new WeakMap();

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchWithRetry(url, options = {}, label = 'Weather request') {
    const maxAttempts = 3;
    let lastError;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);

        try {
            const response = await fetch(url, { ...options, signal: controller.signal });
            clearTimeout(timeoutId);

            if (response.ok) return response;

            const retryable = response.status === 429 ||
                [500, 502, 503, 504].includes(response.status);

            if (!retryable || attempt === maxAttempts) {
                let detail = '';
                try {
                    const body = await response.clone().json();
                    detail = body.detail || body.reason || body.message || '';
                } catch (_) {}
                throw new Error(detail || `${label} failed (HTTP ${response.status}).`);
            }

            // Respect Retry-After when supplied; otherwise use bounded backoff.
            const retryAfter = Number(response.headers.get('Retry-After'));
            const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
                ? Math.min(retryAfter * 1000, 20000)
                : (response.status === 429 ? 10000 : attempt * 2000);

            console.warn(`${label}: HTTP ${response.status}; retrying in ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}/${maxAttempts}).`);
            await sleep(waitMs);
        } catch (error) {
            clearTimeout(timeoutId);
            lastError = error.name === 'AbortError'
                ? new Error(`${label} timed out after 15 seconds.`)
                : error;

            const isHttpFinal = /HTTP \d+/.test(lastError.message);
            if (isHttpFinal || attempt === maxAttempts) throw lastError;

            const waitMs = attempt * 2000;
            console.warn(`${label}: ${lastError.message}; retrying in ${waitMs / 1000}s (attempt ${attempt + 1}/${maxAttempts}).`);
            await sleep(waitMs);
        }
    }

    throw lastError || new Error(`${label} failed after ${maxAttempts} attempts.`);
}

function dateInPakistan(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
}

function addDaysToDate(dateString, days) {
    const [year, month, day] = dateString.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day + days));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function tomorrowInPakistan() {
    return addDaysToDate(dateInPakistan(), 1);
}

function forecastDateForOffset(offset) {
    return addDaysToDate(dateInPakistan(), offset);
}

function splitThreeDayForecast(payload, startDate) {
    if (!payload.hourly || !Array.isArray(payload.hourly.time) || !payload.daily) {
        throw new Error('Open-Meteo returned an incomplete three-day forecast.');
    }
    const expectedHours = 72;
    if (payload.hourly.time.length !== expectedHours) {
        throw new Error(`Expected 72 hourly weather records for three days; received ${payload.hourly.time.length}.`);
    }
    for (const name of WEATHER_VARIABLES) {
        if (!Array.isArray(payload.hourly[name]) || payload.hourly[name].length !== expectedHours ||
            payload.hourly[name].some(value => value === null || !Number.isFinite(Number(value)))) {
            throw new Error(`Three-day forecast is incomplete. Missing or invalid hourly data: ${name}`);
        }
    }
    for (const field of ['temperature_2m_max', 'precipitation_sum', 'weather_code']) {
        if (!Array.isArray(payload.daily[field]) || payload.daily[field].length < 3 ||
            payload.daily[field].slice(0, 3).some(value => value === null || !Number.isFinite(Number(value)))) {
            throw new Error(`Forecast is missing valid three-day data: ${field}`);
        }
    }

    const bundles = {};
    for (let dayIndex = 0; dayIndex < 3; dayIndex++) {
        const date = addDaysToDate(startDate, dayIndex);
        const from = dayIndex * 24;
        const to = from + 24;
        const hourly = {};
        for (const [key, values] of Object.entries(payload.hourly)) {
            hourly[key] = values.slice(from, to);
        }
        if (hourly.time.length !== 24 || hourly.time.some(value => !String(value).startsWith(date))) {
            throw new Error(`Hourly timestamps do not match forecast date ${date}.`);
        }
        const daily = {};
        for (const [key, values] of Object.entries(payload.daily)) daily[key] = [values[dayIndex]];
        bundles[date] = { date, hourly, daily };
    }
    return bundles;
}

async function fetchWeatherBundles() {
    const startDate = tomorrowInPakistan();
    const endDate = forecastDateForOffset(3);
    const systemResponse = await fetchWithRetry(`${API_BASE}/api/system`, {}, 'Solar system configuration request');
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
        start_date: startDate,
        end_date: endDate
    });
    const response = await fetchWithRetry(`https://api.open-meteo.com/v1/forecast?${params}`, {}, 'Open-Meteo three-day forecast request');
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.error) throw new Error(payload.reason || `Open-Meteo error ${response.status}`);
    return splitThreeDayForecast(payload, startDate);
}

function outlookFromBundle(bundle) {
    return {
        max_temperature_c: Number(bundle.daily.temperature_2m_max[0]),
        precipitation_mm: Number(bundle.daily.precipitation_sum[0]),
        weather_code: Number(bundle.daily.weather_code[0])
    };
}

function ensureForecastBundles() {
    const tomorrow = tomorrowInPakistan();
    if (forecastBundles[tomorrow] && forecastBundles[forecastDateForOffset(3)]) return Promise.resolve(forecastBundles);
    if (!forecastLoadPromise) {
        forecastLoadPromise = fetchWeatherBundles()
            .then(bundles => {
                forecastBundles = bundles;
                return bundles;
            })
            .finally(() => { forecastLoadPromise = null; });
    }
    return forecastLoadPromise;
}

function updateForecastDayLabels() {
    const select = byId('forecastDaySelect');
    if (!select) return;
    const today = dateInPakistan();
    const labels = ['Tomorrow', 'Day after tomorrow', 'In two days'];
    Array.from(select.options).forEach((option, index) => {
        const date = forecastDateForOffset(index + 1);
        option.value = date;
        option.textContent = `${labels[index]} (${date})`;
    });
    if (!select.value || !forecastBundles[select.value]) select.value = forecastDateForOffset(1);
}

function selectForecastDay(date) {
    const bundle = forecastBundles[date];
    if (!bundle) {
        setText('weather_description', 'Selected day forecast unavailable');
        setText('weather_icon', '⚠️');
        return;
    }
    selectedForecastDate = date;
    forecastBundle = bundle;
    updateOutlook(outlookFromBundle(bundle));
    setText('weather_forecast_date', date);
    const outlookHeading = byId('weatherOutlookHeading');
    if (outlookHeading) outlookHeading.textContent = date === forecastDateForOffset(1) ? 'Tomorrow’s Outlook' : `Forecast for ${date}`;
    const buttonLabel = byId('predictButton')?.querySelector('span');
    if (buttonLabel) buttonLabel.textContent = `Predict ${date === forecastDateForOffset(1) ? "Tomorrow's" : date === forecastDateForOffset(2) ? "Day 2's" : "Day 3's"} Generation`;
}

async function loadWeatherOnPageOpen() {
    const description = byId('weather_description');
    const icon = byId('weather_icon');
    const retryButton = byId('retryWeatherButton');
    setText('weather_description', 'Loading three-day forecast...');
    setText('weather_icon', '⏳');
    if (retryButton) retryButton.classList.add('hidden');
    try {
        await ensureForecastBundles();
        updateForecastDayLabels();
        const select = byId('forecastDaySelect');
        const initialDate = select?.value || forecastDateForOffset(1);
        selectForecastDay(initialDate);
        if (retryButton) retryButton.classList.add('hidden');
    } catch (error) {
        forecastBundles = {};
        forecastBundle = null;
        if (description) description.textContent = 'Forecast temporarily unavailable';
        if (icon) icon.textContent = '⚠️';
        if (retryButton) retryButton.classList.remove('hidden');
        console.error('Unable to load three-day weather forecast:', error);
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


// Daily consumption planner: compares the user's stated daily kWh with
// the selected day's forecast and identifies the strongest consecutive solar window.
// It intentionally does not infer exact grid import/export without an hourly load profile.
let latestPrediction = null;
let predictionRequestVersion = 0;

function animateAndHide(element, onHidden) {
    if (!element || element.classList.contains('hidden')) {
        if (onHidden) onHidden();
        return;
    }
    const oldTimer = resetAnimationTimers.get(element);
    if (oldTimer) clearTimeout(oldTimer);
    element.classList.remove('results-fade-out');
    // Force a style flush so repeated edits restart the short exit animation.
    void element.offsetWidth;
    element.classList.add('results-fade-out');
    const timer = setTimeout(() => {
        element.classList.add('hidden');
        element.classList.remove('results-fade-out');
        resetAnimationTimers.delete(element);
        if (onHidden) onHidden();
    }, 230);
    resetAnimationTimers.set(element, timer);
}

function cancelPendingHide(element, keepHidden = false) {
    if (!element) return;
    const timer = resetAnimationTimers.get(element);
    if (timer) clearTimeout(timer);
    resetAnimationTimers.delete(element);
    element.classList.remove('results-fade-out');
    if (keepHidden) element.classList.add('hidden');
}

function hideDailyPlanResults(animate = true) {
    const results = byId('dailyPlanResults');
    if (animate) animateAndHide(results);
    else if (results) results.classList.add('hidden');
    setText('dailyPlanError', '');
}

function resetPredictionResults() {
    // Invalidate any in-flight prediction so it cannot repopulate stale results.
    predictionRequestVersion += 1;
    latestPrediction = null;
    const predictButton = byId('predictButton');
    if (predictButton) predictButton.disabled = false;
    const loader = byId('btnLoader');
    if (loader) loader.style.display = 'none';
    byId('btnIcon')?.classList.remove('hidden');
    byId('apiStatusText')?.classList.add('hidden');

    const populated = byId('populatedState');
    const empty = byId('emptyState');
    const thisResetVersion = predictionRequestVersion;
    animateAndHide(populated, () => {
        if (thisResetVersion !== predictionRequestVersion || latestPrediction) return;
        if (populated) populated.classList.remove('flex');
        if (empty) {
            empty.classList.remove('hidden');
            empty.classList.add('flex');
        }
    });
    hideDailyPlanResults(true);
    setText('errorMessage', '');
}

function createDailyConsumptionPlan() {
    cancelPendingHide(byId('dailyPlanResults'));
    const error = byId('dailyPlanError');
    error.textContent = '';
    const consumption = Number(byId('dailyConsumptionKwh').value);

    if (!Number.isFinite(consumption) || consumption <= 0 || consumption > 10000) {
        error.textContent = 'Enter a daily consumption value greater than 0 and no more than 10,000 kWh.';
        return;
    }
    if (!latestPrediction || !Array.isArray(latestPrediction.hourly) || latestPrediction.hourly.length !== 24) {
        error.textContent = 'First calculate solar generation for the selected day using the Predict button.';
        return;
    }

    const generation = Number(latestPrediction.total_daily_kwh);
    if (!Number.isFinite(generation) || generation < 0) {
        error.textContent = 'The solar forecast did not contain a valid daily generation total.';
        return;
    }

    const difference = generation - consumption;
    setText('dailyPlanGeneration', `${generation.toFixed(2)} kWh`);
    setText('dailyPlanConsumption', `${consumption.toFixed(2)} kWh`);
    setText('dailyPlanDifference', `${difference >= 0 ? '+' : ''}${difference.toFixed(2)} kWh`);
    byId('dailyPlanDifference').style.color = difference >= 0 ? '#0f766e' : '#b91c1c';

    const hourly = latestPrediction.hourly.map(item => ({
        time: item.time,
        energy: Math.max(0, Number(item.predicted_energy_kwh) || 0)
    }));
    let bestStart = 0;
    let bestEnergy = -1;
    const windowHours = 3;
    for (let start = 0; start <= hourly.length - windowHours; start++) {
        const energy = hourly.slice(start, start + windowHours).reduce((sum, item) => sum + item.energy, 0);
        if (energy > bestEnergy) {
            bestEnergy = energy;
            bestStart = start;
        }
    }
    const startLabel = hourly[bestStart].time.slice(11, 16);
    const endIndex = bestStart + windowHours;
    const endLabel = endIndex < hourly.length ? hourly[endIndex].time.slice(11, 16) : '24:00';
    const peak = hourly.reduce((best, item) => item.energy > best.energy ? item : best, hourly[0]);
    const peakTime = peak.time.slice(11, 16);
    const generationShare = consumption > 0 ? generation / consumption * 100 : 0;

    const advice = [];
    advice.push(`<article class="planner-recommendation"><strong>Prioritize daytime usage</strong><p>Try to run flexible, high-energy appliances during the strongest forecast solar window: <strong>${startLabel}–${endLabel}</strong>. This is the best consecutive three-hour period by forecast energy, not a guarantee that all loads will be solar-powered.</p></article>`);
    advice.push(`<article class="planner-recommendation planner-neutral"><strong>Best individual production hour</strong><p>The highest forecast production hour is around <strong>${peakTime}</strong>. Where practical, use this period for tasks such as pumping water, washing clothes, or other flexible activities.</p></article>`);


    byId('dailyPlanAdvice').innerHTML = advice.join('');
    byId('dailyPlanResults').classList.remove('hidden');
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
    const requestVersion = ++predictionRequestVersion;
    cancelPendingHide(byId('populatedState'), true);
    const emptyState = byId('emptyState');
    if (emptyState) { emptyState.classList.remove('hidden'); emptyState.classList.add('flex'); }
    byId('errorMessage').textContent = '';
    byId('btnLoader').style.display = 'block';
    byId('btnIcon').classList.add('hidden');
    byId('apiStatusText').classList.remove('hidden');
    submit.disabled = true;

    try {
        const requestedDate = byId('forecastDaySelect')?.value || selectedForecastDate || tomorrowInPakistan();
        const requestedBundle = forecastBundles[requestedDate];
        if (!requestedBundle || requestedBundle.date !== requestedDate) {
            throw new Error('The selected day\'s weather forecast is not ready. Please wait for it to load or use Retry forecast.');
        }
        forecastBundle = requestedBundle;
        selectedForecastDate = requestedDate;
        const response = await fetch(`${API_BASE}/api/predict`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                capacity_kwp: capacity,
                inverter_kw: inverter,
                date: requestedBundle.date,
                hourly: requestedBundle.hourly,
                daily: requestedBundle.daily
            })
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.detail || `API error ${response.status}`);

        if (!Array.isArray(payload.hourly) || payload.hourly.length === 0) {
            throw new Error('The prediction API returned no hourly forecast data.');
        }

        // Ignore a response if the user changed system settings while it was running.
        if (requestVersion !== predictionRequestVersion ||
            Number(byId('systemKw').value) !== capacity ||
            Number(byId('inverterKw').value) !== inverter) {
            return;
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
        if (requestVersion === predictionRequestVersion) {
            byId('btnLoader').style.display = 'none';
            byId('btnIcon').classList.remove('hidden');
            byId('apiStatusText').classList.add('hidden');
            submit.disabled = false;
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    // Fetch a fresh forecast once for this page session. Predict reuses forecastBundle.
    loadWeatherOnPageOpen();

    const retryWeatherButton = byId('retryWeatherButton');
    if (retryWeatherButton) {
        retryWeatherButton.addEventListener('click', async () => {
            if (forecastLoadPromise) return;
            retryWeatherButton.disabled = true;
            retryWeatherButton.textContent = 'Retrying...';
            forecastBundle = null;
            forecastBundles = {};
            try {
                await loadWeatherOnPageOpen();
            } finally {
                retryWeatherButton.disabled = false;
                retryWeatherButton.textContent = 'Retry forecast';
            }
        });
    }

    // Bind only elements present in this version of the page. This prevents
    // a stale/partial HTML deployment from crashing all remaining initialization.
    const predictionForm = byId('predictionForm');
    if (predictionForm) predictionForm.addEventListener('submit', runPrediction);
    else console.error('Missing required HTML element: #predictionForm');

    const forecastDaySelect = byId('forecastDaySelect');
    if (forecastDaySelect) {
        forecastDaySelect.addEventListener('change', () => {
            predictionRequestVersion += 1;
            latestPrediction = null;
            const predictButton = byId('predictButton');
            if (predictButton) predictButton.disabled = false;
            const loader = byId('btnLoader');
            if (loader) loader.style.display = 'none';
            byId('btnIcon')?.classList.remove('hidden');
            byId('apiStatusText')?.classList.add('hidden');
            const populated = byId('populatedState');
            const empty = byId('emptyState');
            const dayChangeVersion = predictionRequestVersion;
            animateAndHide(populated, () => {
                if (dayChangeVersion !== predictionRequestVersion || latestPrediction) return;
                if (populated) populated.classList.remove('flex');
                if (empty) { empty.classList.remove('hidden'); empty.classList.add('flex'); }
            });
            hideDailyPlanResults(true);
            setText('errorMessage', '');
            selectForecastDay(forecastDaySelect.value);
        });
    }

    // Any change to the solar system configuration invalidates the displayed
    // prediction and its dependent daily-use plan. Weather remains untouched.
    ['systemKw', 'inverterKw'].forEach(id => {
        const input = byId(id);
        if (input) {
            input.addEventListener('input', resetPredictionResults);
            input.addEventListener('change', resetPredictionResults);
        }
    });

    const calculateButton = byId('calculateDailyPlanButton');
    if (calculateButton) calculateButton.addEventListener('click', createDailyConsumptionPlan);

    const consumptionInput = byId('dailyConsumptionKwh');
    if (consumptionInput) {
        consumptionInput.addEventListener('input', hideDailyPlanResults);
        consumptionInput.addEventListener('change', hideDailyPlanResults);
    }

    const updateClock = () => {
        const clock = byId('current_time_display');
        if (clock) {
            clock.textContent = new Intl.DateTimeFormat('en-US', {
                timeZone: 'Asia/Karachi',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
            }).format(new Date());
        }
    };
    updateClock();
    setInterval(updateClock, 1000);
});
