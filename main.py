from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List
import xgboost as xgb
import numpy as np

# 1. Initialize the FastAPI app
app = FastAPI(title="Solar Yield Prediction API")

# Allow frontend requests (Update origins in production)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 2. Load the trained XGBoost model
print("Loading XGBoost model...")
xgb_model = xgb.XGBRegressor()
xgb_model.load_model("model.json")

# 3. Define the expected data structures using Pydantic
class HourlyWeather(BaseModel):
    t2m: float
    rh2m: float
    ws10m: float
    prectotcorr: float
    allsky_kt: float
    is_day: int  # 1 for daytime, 0 for nighttime

class DailyForecastRequest(BaseModel):
    hourly_data: List[HourlyWeather]
    panel_area: float      # in square meters (m²)
    panel_efficiency: float # e.g., 0.20 for 20%

# 4. Create the prediction endpoint
@app.post("/predict")
async def predict_hourly_yield(request: DailyForecastRequest):
    hourly_irradiance = []
    hourly_kwh_yield = []
    
    # Process each of the 24 hours
    for hour_data in request.hourly_data:
        # Dynamic Gatekeeper: Check if the sun is up
        if hour_data.is_day == 0:
            irradiance_w_m2 = 0.0
        else:
            # Format features for the model exactly as trained: ['T2M', 'RH2M', 'WS10M', 'PRECTOTCORR', 'ALLSKY_KT']
            features = np.array([[
                hour_data.t2m,
                hour_data.rh2m,
                hour_data.ws10m,
                hour_data.prectotcorr,
                hour_data.allsky_kt
            ]])
            
            # Predict irradiance (W/m²) and ensure it doesn't dip below 0
            prediction = xgb_model.predict(features)[0]
            irradiance_w_m2 = max(0.0, float(prediction))
            
        hourly_irradiance.append(irradiance_w_m2)
        
        performance_ratio = 0.7
        kwh = ((irradiance_w_m2 / 1000.0) * request.panel_area * request.panel_efficiency) * performance_ratio
        hourly_kwh_yield.append(kwh)

    # Sum the 24 hours to get the total daily yield
    total_daily_kwh = sum(hourly_kwh_yield)

    return {
        "status": "success",
        "total_daily_kwh": round(total_daily_kwh, 2),
        "hourly_irradiance_w_m2": [round(val, 2) for val in hourly_irradiance],
        "hourly_kwh_yield": [round(val, 3) for val in hourly_kwh_yield]
    }
