# Updated Solar Forecast Website

Preserves the original HTML/CSS dashboard, but replaces the old irradiance model with the newly trained hourly energy XGBoost model.

## Required model files (not included in this package)
Copy your own trained files to:
- `models/solar_xgboost.json`
- `models/model_metadata.json`

The metadata must contain `features` (in training order) and `best_iteration`. Do **not** use the old `model.json`.

## Install and run

```bash
python -m pip install -r requirements.txt
uvicorn main:app --reload
```

API docs: http://127.0.0.1:8000/docs

For local frontend testing, serve the frontend separately, e.g. `python -m http.server 5500` from this directory, then open http://127.0.0.1:5500/. Default CORS permits that origin. For a deployed static website, set `window.SOLAR_API_BASE = 'https://YOUR-API-HOST'` in a script tag before `app.js` in `index.html`, and set `CORS_ORIGINS` on the backend to your exact frontend origin (comma-separated if necessary).

Example API: `GET /api/predict/tomorrow?capacity_kwp=5&inverter_kw=5`

## Model assumptions

- Reference XGBoost model was trained on simulated output of a 5 kWp DC / 5 kW AC system.
- When both DC and AC capacities scale proportionally, reference model output is scaled by `capacity_kwp / 5`.
- If the inverter-to-panel ratio differs, the API uses a parameterized physics estimator instead, avoiding inaccurate scaling of already-clipped AC output.
- The configured location is Bahawalpur example coordinates, and the weather features use Open-Meteo `global_tilted_irradiance`, tilt 30 degrees and azimuth 0 (south). Change only if consistent with the training setup, or retrain accordingly.
- Forecast output is simulated, not validated against measured inverter output.
- API fetches the forecast server-side. It does not estimate clearness index from cloud cover or multiply rated kWp by panel efficiency again.
