"""Solar forecast API. Run: uvicorn main:app --reload"""
import json
import os
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
import requests
import xgboost as xgb
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
import time
import threading
from email.utils import parsedate_to_datetime
from datetime import datetime, timedelta, timezone

WEATHER_CACHE = {}
CACHE_TTL_SECONDS = 21600  # 6 hours: share one weather forecast across visitors
DEFAULT_RATE_LIMIT_COOLDOWN = 3600  # 1 hour when provider supplies no Retry-After
WEATHER_LOCK = threading.Lock()

BASE = Path(__file__).resolve().parent
MODEL_PATH = BASE / 'models' / 'solar_xgboost.json'
META_PATH = BASE / 'models' / 'model_metadata.json'
TZ = 'Asia/Karachi'
# Match the historical training dataset. Change these together if retraining for a different site.
LATITUDE = float(os.getenv('SOLAR_LATITUDE', '29.3956'))
LONGITUDE = float(os.getenv('SOLAR_LONGITUDE', '71.6836'))
TILT = float(os.getenv('SOLAR_TILT', '30'))
AZIMUTH = float(os.getenv('SOLAR_AZIMUTH', '0'))
REFERENCE_KWP = 5.0
REFERENCE_INVERTER_KW = 5.0
PR = 0.85
NOCT = 45.0
TEMP_COEFFICIENT = -0.0035

app = FastAPI(title='Solar Energy Forecast API', version='2.0')
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://khuzemaqayyum.me",
        "https://khuzema37.github.io"
    ],
    allow_credentials=False,
    allow_methods=["GET"],
    allow_headers=["*"],
)

@app.get('/health')
def health():
    return {'status': 'ok', 'model_available': MODEL_PATH.is_file() and META_PATH.is_file()}

@app.get('/api/system')
def system():
    return {'reference_capacity_kwp': REFERENCE_KWP, 'reference_inverter_kw': REFERENCE_INVERTER_KW,
            'performance_ratio': PR, 'tilt_degrees': TILT, 'azimuth_degrees': AZIMUTH,
            'latitude': LATITUDE, 'longitude': LONGITUDE, 'timezone': TZ}


def get_forecast():

    date = datetime.now(ZoneInfo(TZ)).date() + timedelta(days=1)

    variables = [
        'temperature_2m',
        'relative_humidity_2m',
        'cloud_cover',
        'shortwave_radiation',
        'direct_normal_irradiance',
        'diffuse_radiation',
        'global_tilted_irradiance',
        'wind_speed_10m',
        'precipitation'
    ]

    params = {
        'latitude': LATITUDE,
        'longitude': LONGITUDE,
        'hourly': ','.join(variables),
        'daily': 'temperature_2m_max,precipitation_sum,weather_code',
        'timezone': TZ,
        'tilt': TILT,
        'azimuth': AZIMUTH,
        'start_date': date.isoformat(),
        'end_date': date.isoformat()
    }

    cache_key = (
        date.isoformat(),
        LATITUDE,
        LONGITUDE,
        TZ,
        TILT,
        AZIMUTH,
        tuple(variables)
    )

    with WEATHER_LOCK:

        now = time.time()
        cached = WEATHER_CACHE.get(cache_key)

        # Return cached weather if still fresh.
        if cached and now < cached["expires_at"]:
            return (
                date,
                cached["df"].copy(),
                cached["outlook"].copy()
            )

        # Avoid repeatedly calling Open-Meteo while rate-limited.
        if cached and now < cached.get("retry_after", 0):
            return (
                date,
                cached["df"].copy(),
                cached["outlook"].copy()
            )

        if now < WEATHER_CACHE.get("global_retry_after", 0):
            if cached:
                return (
                    date,
                    cached["df"].copy(),
                    cached["outlook"].copy()
                )

            remaining = max(1, int(WEATHER_CACHE["global_retry_after"] - now))
            raise HTTPException(
                status_code=503,
                detail=f"Weather provider rate-limited. Retry in approximately {remaining} seconds.",
                headers={"Retry-After": str(remaining)}
            )

        try:

            response = requests.get(
                'https://api.open-meteo.com/v1/forecast',
                params=params,
                timeout=30
            )

            # Handle Open-Meteo rate limiting.
            if response.status_code == 429:

                retry_seconds = DEFAULT_RATE_LIMIT_COOLDOWN
                retry_header = response.headers.get("Retry-After")

                if retry_header:
                    try:
                        retry_seconds = max(
                            1,
                            int(retry_header)
                        )
                    except ValueError:
                        try:
                            retry_date = parsedate_to_datetime(retry_header)
                            if retry_date.tzinfo is None:
                                retry_date = retry_date.replace(tzinfo=timezone.utc)
                            retry_seconds = max(
                                1,
                                int(
                                    (retry_date - datetime.now(timezone.utc))
                                    .total_seconds()
                                )
                            )
                        except (TypeError, ValueError, OverflowError):
                            pass

                WEATHER_CACHE["global_retry_after"] = (
                    time.time() + retry_seconds
                )

                if cached:
                    return (
                        date,
                        cached["df"].copy(),
                        cached["outlook"].copy()
                    )

                raise HTTPException(
                    status_code=503,
                    detail=f"Open-Meteo returned HTTP 429. Retry in approximately {retry_seconds} seconds.",
                    headers={"Retry-After": str(retry_seconds)}
                )

            response.raise_for_status()

            payload = response.json()

            if payload.get('error'):
                raise ValueError(
                    payload.get('reason', 'Open-Meteo error')
                )

            df = pd.DataFrame(payload['hourly'])

            df['time'] = pd.to_datetime(
                df['time'],
                format='%Y-%m-%dT%H:%M'
            )

            if (
                len(df) != 24
                or df[variables].isna().any().any()
            ):
                raise ValueError(
                    'Forecast must contain 24 complete hourly records'
                )

            daily = payload['daily']

            outlook = {
                'max_temperature_c': float(
                    daily['temperature_2m_max'][0]
                ),
                'precipitation_mm': float(
                    daily['precipitation_sum'][0]
                ),
                'weather_code': int(
                    daily['weather_code'][0]
                )
            }

            # Save successful forecast in cache.
            WEATHER_CACHE[cache_key] = {
                "df": df.copy(),
                "outlook": outlook.copy(),
                "expires_at": time.time() + CACHE_TTL_SECONDS
            }

            return date, df, outlook

        except HTTPException:
            raise

        except (
            requests.RequestException,
            ValueError,
            KeyError,
            TypeError
        ) as exc:

            # Use an existing forecast for the same date
            # when the weather service is temporarily unavailable.
            if cached:
                return (
                    date,
                    cached["df"].copy(),
                    cached["outlook"].copy()
                )

            print(f"Forecast upstream failure: {type(exc).__name__}: {exc}", flush=True)
            raise HTTPException(
                status_code=503,
                detail='Weather forecast temporarily unavailable. Check Render logs for upstream details.'
            ) from exc

def physics_estimate(df, capacity, inverter):
    gti = df['global_tilted_irradiance'].clip(lower=0).to_numpy(dtype=float)
    ambient = df['temperature_2m'].to_numpy(dtype=float)
    cell_temp = ambient + (NOCT - 20) / 800 * gti
    factor = np.maximum(0, 1 + TEMP_COEFFICIENT * (cell_temp - 25))
    dc = capacity * gti / 1000 * PR * factor
    return np.clip(dc, 0, inverter)

def reference_model(df):
    if not MODEL_PATH.is_file() or not META_PATH.is_file():
        raise HTTPException(status_code=503, detail='Trained model or metadata missing from models/ directory')
    try:
        metadata = json.loads(META_PATH.read_text(encoding='utf-8'))
        df = df.copy()
        df['hour'] = df['time'].dt.hour
        df['day_of_year'] = df['time'].dt.dayofyear
        df['month'] = df['time'].dt.month
        df['hour_sin'] = np.sin(2 * np.pi * df['hour'] / 24)
        df['hour_cos'] = np.cos(2 * np.pi * df['hour'] / 24)
        df['day_sin'] = np.sin(2 * np.pi * df['day_of_year'] / 365)
        df['day_cos'] = np.cos(2 * np.pi * df['day_of_year'] / 365)
        features = metadata['features']
        missing = [name for name in features if name not in df.columns]
        if missing:
            raise ValueError(f'Missing model features: {missing}')
        booster = xgb.Booster()
        booster.load_model(str(MODEL_PATH))
        matrix = xgb.DMatrix(df[features], feature_names=features)
        best = metadata.get('best_iteration')
        options = {'iteration_range': (0, int(best) + 1)} if best is not None else {}
        values = booster.predict(matrix, **options)
        values = np.clip(values, 0, REFERENCE_INVERTER_KW)
        return np.where(df['global_tilted_irradiance'].to_numpy() <= 0, 0, values)
    except (OSError, ValueError, KeyError, TypeError, xgb.core.XGBoostError) as exc:
        raise HTTPException(status_code=500, detail=f'Unable to run trained model: {exc}') from exc

@app.get('/api/predict/tomorrow')
def predict_tomorrow(capacity_kwp: float = Query(5, gt=0, le=1000),
                     inverter_kw: float = Query(5, gt=0, le=1000)):
    date, df, outlook = get_forecast()
    reference = reference_model(df)
    physics = physics_estimate(df, capacity_kwp, inverter_kw)
    scale = capacity_kwp / REFERENCE_KWP
    # The trained model represents a 5 kWp array and 5 kW inverter. Scaling its
    # AC output is justified only if inverter and panel capacity scale together.
    proportional = np.isclose(inverter_kw, REFERENCE_INVERTER_KW * scale, rtol=1e-6, atol=1e-6)
    if proportional:
        predicted = np.clip(reference * scale, 0, inverter_kw)
        method = 'xgboost_scaled_reference'
        note = 'XGBoost 5 kWp reference scaled under the same inverter-to-array ratio and loss assumptions.'
    else:
        predicted = physics
        method = 'parameterized_physics'
        note = 'Custom inverter ratio: physics estimate used because scaled clipped AC model output is not reliable.'
    hourly = []
    for i, row in df.iterrows():
        hourly.append({'time': row['time'].strftime('%Y-%m-%dT%H:%M:%S'),
                       'irradiance_w_m2': round(float(row['global_tilted_irradiance']), 3),
                       'temperature_c': round(float(row['temperature_2m']), 2),
                       'cloud_cover_pct': round(float(row['cloud_cover']), 1),
                       'predicted_energy_kwh': round(float(predicted[i]), 6),
                       'physics_energy_kwh': round(float(physics[i]), 6)})
    return {'date': date.isoformat(), 'timezone': TZ, 'method': method, 'method_note': note,
            'system': {'capacity_kwp': capacity_kwp, 'inverter_kw': inverter_kw},
            'total_daily_kwh': round(float(predicted.sum()), 4),
            'physics_total_kwh': round(float(physics.sum()), 4),
            'hourly': hourly, 'outlook': outlook,
            'disclaimer': 'Simulation based on forecast weather and assumed system losses; not validated against measured inverter output.'}
