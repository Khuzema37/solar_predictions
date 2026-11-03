# Solar Energy Forecast — updated XGBoost website

This package updates the existing Bahawalpur solar forecast website to use the
trained XGBoost reference model and a parameterized physics estimate. It also
loads tomorrow's weather preview as soon as the page opens.

## Important: add your trained model files

The supplied source files did not include the trained model artifacts. Before
predictions can work, copy these files into `models/` from your training project:

- `models/solar_xgboost.json`
- `models/model_metadata.json`

Do not substitute the old `model.json`. See `models/README.md`.

## Project structure

```text
solar_predictions_updated/
├── index.html
├── style.css
├── app.js
├── main.py
├── requirements.txt
├── .env.example
└── models/
    └── README.md
```

## Run backend locally in VS Code (Windows PowerShell)

1. Open this folder in VS Code.
2. Open Terminal → New Terminal.
3. Create and activate a virtual environment:

   ```powershell
   py -3.13 -m venv .venv
   .\.venv\Scripts\Activate.ps1
   ```

   If PowerShell blocks activation, use `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass`
   in that terminal, then activate again.

4. Install dependencies:

   ```powershell
   python -m pip install --upgrade pip
   pip install -r requirements.txt
   ```

5. Add the two model files listed above to `models/`.
6. Start the API:

   ```powershell
   uvicorn main:app --reload
   ```

7. Check `http://127.0.0.1:8000/health` and API docs at
   `http://127.0.0.1:8000/docs`.

## Run the frontend locally

In a second VS Code terminal, from this project folder run:

```powershell
python -m http.server 5500
```

Open `http://127.0.0.1:5500`. In `index.html`, set
`window.SOLAR_API_BASE` to `http://127.0.0.1:8000` while testing locally.
For production, it is set to `https://solar-predictions.onrender.com`.

## Weather loading and API request behavior

- On page open, `app.js` requests `/api/forecast/tomorrow`.
- The backend calls the shared `get_forecast()` function.
- Clicking Calculate calls `/api/predict/tomorrow`, which uses that same
  server-side in-memory forecast cache.
- Cache TTL is six hours. A rate-limit cooldown and stale-cache fallback are
  also implemented in `main.py`.
- This cache is process-local; if you later run multiple Render instances,
  move the cache to Redis or another shared cache.

## Deploying

Backend: deploy `main.py` on Render with build command
`pip install -r requirements.txt` and start command
`uvicorn main:app --host 0.0.0.0 --port $PORT`. Ensure the model files are
included in the deployed repository or otherwise available at `models/`.

Frontend: publish `index.html`, `style.css`, and `app.js` using your existing
GitHub Pages / custom-domain setup. The backend CORS allowlist currently includes
`https://khuzemaqayyum.me` and `https://khuzema37.github.io`; add the exact
origin of any other frontend host in `main.py`.

## GitHub + VS Code workflow

If the repository is already cloned, open its folder in VS Code and copy these
updated files into the matching repository files. Then use Source Control to
review, commit, and push. If it is not cloned yet, clone your repository using
`https://github.com/Khuzema37/solar_predictions.git` (instructions are in the
chat response).

## Model assumptions and limitations

- Reference model: 5 kWp DC panels and 5 kW AC inverter.
- Proportional capacity scaling is used only when the user's inverter-to-panel
  ratio matches the reference ratio; other ratios use the physics estimator.
- Weather source: Open-Meteo forecast API.
- Site defaults: 29.3956, 71.6836; Asia/Karachi; 30° tilt; azimuth 0°.
- Forecast generation is a simulation and is not yet validated against measured
  inverter output.
