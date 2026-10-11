from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import joblib
import pandas as pd

app = FastAPI()

# Enable CORS for your GitHub Pages frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], 
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Load the newly trained V2 model with the Clearness Index
model = joblib.load('bahawalpur_solar_model_v2.pkl')

# Updated input schema with ALLSKY_KT
class WeatherInput(BaseModel):
    T2M: float
    RH2M: float
    WS2M: float
    PRECTOTCORR: float
    ALLSKY_KT: float
    system_kw: float

@app.get("/")
def read_root():
    return {"status": "ZEMA Solar API is running with the upgraded V2 model"}

@app.post("/predict")
def predict_yield(data: WeatherInput):
    # Format the incoming 5 variables for the Random Forest
    input_df = pd.DataFrame([{
        'T2M': data.T2M,
        'RH2M': data.RH2M,
        'WS2M': data.WS2M,
        'PRECTOTCORR': data.PRECTOTCORR,
        'ALLSKY_KT': data.ALLSKY_KT
    }])
    
    # Predict the irradiance
    irradiance_pred = model.predict(input_df)[0]
    
    # Physical system calculations (Area based on 550W panels, 22% efficiency)
    area_m2 = (data.system_kw * 1000 / 550) * 2.58
    estimated_yield = irradiance_pred * area_m2 * 0.22
    
    return {
        "raw_irradiance_kwh_m2": round(irradiance_pred, 3),
        "estimated_yield_kwh": round(estimated_yield, 2)
    }
