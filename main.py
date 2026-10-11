from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import joblib
import pandas as pd
import os

# Initialize the FastAPI application
app = FastAPI(title="Solar Yield Forecaster")

# Configure CORS (Cross-Origin Resource Sharing)
# This is mandatory. Without this, your GitHub Pages frontend will be blocked from accessing this Render backend.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Allows requests from any website (update to your GitHub Pages URL for strict security later)
    allow_credentials=True,
    allow_methods=["*"],  
    allow_headers=["*"],
)

# Load the trained Random Forest model safely
MODEL_PATH = "bahawalpur_solar_model.pkl"
try:
    model = joblib.load(MODEL_PATH)
except Exception as e:
    model = None
    print(f"Critical Error: Failed to load model. {e}")

# Define the expected input data structure and data types
class WeatherInput(BaseModel):
    T2M: float          # Temperature in Celsius
    RH2M: float         # Relative Humidity in %
    WS2M: float         # Wind Speed in m/s
    PRECTOTCORR: float  # Precipitation in mm
    system_kw: float = 5.0  # System size in kW (defaults to 5.0)

@app.get("/")
def health_check():
    """Endpoint to verify the API server is awake and the model is loaded."""
    status = "Active" if model else "Model Missing"
    return {"status": status, "message": "ZEMA Solar API for Bahawalpur is operational."}

@app.post("/predict")
def predict_solar(data: WeatherInput):
    """Endpoint to execute machine learning inference and physics calculations."""
    # Guard clause to prevent execution if the model failed to load
    if not model:
        raise HTTPException(status_code=500, detail="Machine learning model is offline.")

    try:
        # 1. Format the incoming JSON data into a Pandas DataFrame
        input_df = pd.DataFrame([{
            "T2M": data.T2M,
            "RH2M": data.RH2M,
            "WS2M": data.WS2M,
            "PRECTOTCORR": data.PRECTOTCORR
        }])
        
        # 2. Execute inference to get raw irradiance (outputs kWh/m2/day)
        raw_irradiance = model.predict(input_df)[0]
        
        # 3. Calculate final electrical output using modern standard parameters
        panel_wattage = 550      
        panel_area_m2 = 2.58     
        efficiency = 0.22        
        
        total_panels = (data.system_kw * 1000) / panel_wattage
        total_system_area = total_panels * panel_area_m2
        
        final_kwh = raw_irradiance * total_system_area * efficiency
        
        # 4. Return a structured JSON response
        return {
            "location": "Bahawalpur",
            "system_kw": data.system_kw,
            "raw_irradiance_kwh_m2": round(raw_irradiance, 2),
            "estimated_yield_kwh": round(final_kwh, 2)
        }
    
    except Exception as e:
        # Catch unexpected mathematical or formatting errors
        raise HTTPException(status_code=400, detail=str(e))