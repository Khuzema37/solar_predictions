import json
import os
from pathlib import Path
from zoneinfo import ZoneInfo
from pydantic import BaseModel, Field

import numpy as np
import pandas as pd
import xgboost as xgb
from fastapi import FastAPI, HTTPException, Query, Body
from fastapi.middleware.cors import CORSMiddleware
from datetime import datetime, timedelta

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
        "https://khuzema37.github.io",
        "http://localhost:5500",
        "http://127.0.0.1:5500"
    ],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
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


class ForecastRequest(BaseModel):
    capacity_kwp: float = Field(gt=0, le=1000)
    inverter_kw: float = Field(gt=0, le=1000)
    date: str
    hourly: dict
    daily: dict


def forecast_from_client(request: ForecastRequest):
    """Validate and normalize the exact Open-Meteo forecast sent by app.js."""
    today = datetime.now(ZoneInfo(TZ)).date()
    try:
        requested_date = datetime.strptime(request.date, '%Y-%m-%d').date()
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail='Forecast date must use YYYY-MM-DD format.') from exc
    first_allowed = today + timedelta(days=1)
    last_allowed = today + timedelta(days=3)
    if not first_allowed <= requested_date <= last_allowed:
        raise HTTPException(
            status_code=400,
            detail=f'Forecast date must be between {first_allowed.isoformat()} and {last_allowed.isoformat()}. Reload the page and try again.'
        )

    required = [
        'time', 'temperature_2m', 'relative_humidity_2m', 'cloud_cover',
        'shortwave_radiation', 'direct_normal_irradiance', 'diffuse_radiation',
        'global_tilted_irradiance', 'wind_speed_10m', 'precipitation'
    ]
    missing = [name for name in required if name not in request.hourly]
    if missing:
        raise HTTPException(status_code=422, detail=f'Missing hourly weather fields: {missing}')

    try:
        df = pd.DataFrame(request.hourly)
        if len(df) != 24 or df['time'].nunique() != 24:
            raise ValueError('Expected 24 unique hourly records.')
        df['time'] = pd.to_datetime(df['time'], format='%Y-%m-%dT%H:%M')
        if df['time'].dt.strftime('%Y-%m-%d').nunique() != 1 or df['time'].dt.strftime('%Y-%m-%d').iloc[0] != request.date:
            raise ValueError('Hourly timestamps do not match the requested forecast date.')
        numeric_fields = [name for name in df.columns if name != 'time']
        df[numeric_fields] = df[numeric_fields].apply(pd.to_numeric, errors='coerce')
        if df[numeric_fields].isna().any().any() or not np.isfinite(df[numeric_fields].to_numpy(dtype=float)).all():
            raise ValueError('Hourly weather data contains missing or non-numeric values.')

        daily = request.daily
        for field in ['temperature_2m_max', 'precipitation_sum', 'weather_code']:
            if field not in daily or not isinstance(daily[field], list) or not daily[field]:
                raise ValueError(f'Missing daily weather field: {field}')
        outlook = {
            'max_temperature_c': float(daily['temperature_2m_max'][0]),
            'precipitation_mm': float(daily['precipitation_sum'][0]),
            'weather_code': int(daily['weather_code'][0])
        }
        if not all(np.isfinite(v) for v in outlook.values()):
            raise ValueError('Daily weather data contains invalid values.')
        return df, outlook
    except (ValueError, TypeError, KeyError) as exc:
        raise HTTPException(status_code=422, detail=f'Invalid weather forecast payload: {exc}') from exc

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

@app.post('/api/predict')
@app.post('/api/predict/tomorrow')  # Backwards-compatible alias for older frontends.
def predict_tomorrow(request: ForecastRequest = Body(...)):
    capacity_kwp = request.capacity_kwp
    inverter_kw = request.inverter_kw
    df, outlook = forecast_from_client(request)
    date = datetime.strptime(request.date, '%Y-%m-%d').date()
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