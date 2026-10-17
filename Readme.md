# ☀️ ZEMA Solar Yield Prediction System

An end-to-end Machine Learning web application designed to predict the daily energy output of solar panel installations in the **Bahawalpur region**. 

This project was developed as a final-year defense project for the **Bachelor of Artificial Intelligence** degree. It combines an optimized Random Forest machine learning model with real-time meteorological APIs to provide accurate, actionable energy forecasts.

---

## 🎯 The Problem We Are Solving

As the adoption of solar energy grows in Pakistan, especially in high-sunlight regions like Bahawalpur, a major challenge remains: **unpredictability**. Traditional solar calculators estimate energy output using static, historical averages. However, day-to-day weather variables—like sudden cloud cover, humidity spikes, or wind speed—drastically affect how much energy a solar panel actually generates. 

Without accurate, dynamic forecasting, plant managers and homeowners cannot reliably predict their daily energy generation, making it difficult to optimize power usage or plan for grid dependence.

## 💡 What This Project Does

The ZEMA Solar Yield Prediction System eliminates this guesswork by providing a **dynamic, weather-aware energy forecast**. 
Instead of giving a generic yearly average, this application looks at tomorrow's specific weather forecast for Bahawalpur and predicts exactly how much energy (in kWh) a specific solar setup will generate that day.

**How it works:**
1. **Live Data Ingestion:** The frontend fetches tomorrow's weather data (Temperature, Humidity, Wind, Precipitation, and Cloud Cover) via the Open-Meteo API.
2. **AI Translation:** The system algorithmically converts raw cloud cover into NASA's scientific "Clearness Index" (KT).
3. **Machine Learning Prediction:** This data is sent to a FastApi backend where a Random Forest AI—trained on 11 years of NASA POWER satellite data—evaluates the weather conditions to predict the day's solar irradiance.
4. **Physics Engine:** The system calculates the physical footprint of the user's solar setup (based on 550W panels) and applies a 22% system efficiency rating to output the final usable energy.

## 📊 What the User Sees (Output)

The user is presented with a clean, intuitive dashboard. After entering their Total System Size (kW), the application provides:

* **Tomorrow's Weather UI:** A visual banner showing the forecasted weather (e.g., "Clear Sky ☀️") based on live API data.
* **Estimated Daily Output:** The main result, showing the exact expected usable energy in **kWh (Units)**.
* **Model Irradiance:** The AI's predicted solar radiation hitting the panels ($kWh/m^2$).
* **Physical Setup Stats:** The calculated physical surface area ($m^2$) required for their specific system.
* **Practical Applications:** A real-world context metric (e.g., estimating how long the generated power could run a 1.5 Ton DC Inverter AC).

---

## 🚀 Technical Features

* **Live API Integration:** Automatically fetches tomorrow's forecast for Bahawalpur.
* **Dynamic Clearness Index (KT):** Converts standard cloud cover percentages into atmospheric Clearness Index on the fly.
* **High-Accuracy ML Backend:** R² Score of 0.914, proving the model explains over 91% of the variance in solar irradiance.
* **Responsive UI:** Modern, Tailwind CSS-powered dashboard.

## 🧠 Machine Learning Architecture

The core prediction engine is built using `scikit-learn` and hosted via a FastAPI backend. 

* **Algorithm:** Random Forest Regressor (Optimized with `max_depth=25`, `n_estimators=80`)
* **Dataset:** 11 years (2016–2026) of NASA POWER satellite weather data specific to Bahawalpur, Pakistan.
* **Features Used:**
  * `T2M`: Temperature at 2 Meters (°C)
  * `RH2M`: Relative Humidity at 2 Meters (%)
  * `WS2M`: Wind Speed at 2 Meters (m/s)
  * `PRECTOTCORR`: Precipitation (mm)
  * `ALLSKY_KT`: Clearness Index (0.0 to 1.0)
* **Performance Metrics:**
  * **R² Score:** 0.914 
  * **MAE:** 0.326 kWh/m²

*Note: The deployed model is compressed via `joblib` (`compress=3`) to ensure high-speed loading and compliance with GitHub's 25MB repository size limits.*

## 💻 Tech Stack

* **Frontend:** HTML5, Vanilla JavaScript, Tailwind CSS
* **Backend:** Python, FastAPI, Uvicorn, Pydantic
* **Machine Learning:** Scikit-Learn, Pandas, NumPy, Joblib
* **External APIs:** Open-Meteo (Weather Forecast)
* **Deployment:** Render (Web Services)

## ⚙️ Local Setup & Installation

If you wish to run this project locally for testing or further development:

1. **Clone the repository:**
   ```bash
   git clone https://github.com/yourusername/zema-solar-prediction.git
   cd zema-solar-prediction
   ```

2. **Install backend dependencies:**
   ```bash
   pip install fastapi uvicorn scikit-learn pandas numpy joblib
   ```

3. **Run the FastAPI server:**
   ```bash
   uvicorn main:app --reload
   ```
   *The API will start running at `http://127.0.0.1:8000`*

4. **Launch the Frontend:**
   * Open the `index.html` file in any modern web browser.
   * *Note: If testing locally, ensure your `fetch()` URL in the JavaScript is temporarily pointed to your localhost instead of the production Render URL.*

## 🌍 Production Deployment

The backend API is currently live-hosted on **Render**. 
Due to Render's free-tier architecture, the server may spin down after 15 minutes of inactivity. If the frontend displays a "Connection Error", simply wait 60 seconds for the backend to perform a "cold start" and click calculate again.