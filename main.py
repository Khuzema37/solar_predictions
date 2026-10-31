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
