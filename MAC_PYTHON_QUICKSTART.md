# macOS Python Quickstart

This repository keeps two app tracks side by side:

- The current `Node/React` app under `apps/` and `packages/`
- The original `Python` dashboard and CLI at the repo root

Nothing in the current `Node/React` app needs to be removed or renamed to use the Python path on a Mac.

## Recommended macOS path

For a first run on macOS, the lower-risk path is the Python app.

1. Run:

```bash
./scripts/mac_python_setup.sh
```

2. Edit `.env` and fill in any credentials you need:

- `FOREPLAY_EMAIL`
- `FOREPLAY_PASSWORD`
- `ADPLEXITY_EMAIL`
- `ADPLEXITY_PASSWORD`
- `AIRTABLE_PAT`

3. Start the Python dashboard:

```bash
./scripts/mac_python_dashboard.sh
```

4. Open:

- `http://127.0.0.1:8050/db/intelligence_dashboard.html`

## Keep the current version available

The current `Node/React` version stays available exactly as before:

```bash
npm install
npm run dev
```

Or for the packaged flow:

```bash
npm run app
```

## Important macOS notes

- The Python Meta flow on macOS uses Chrome and ChromeDriver.
- The `Node/React` Meta direct flow uses Playwright, so it may also need:

```bash
npx playwright install chromium
```

- The saved dashboard settings in `db/dashboard_settings.json` currently include a Windows absolute path for `meta.advertisersDb`. On macOS, change that value to `sources/meta/ads.db` or to a valid macOS absolute path before running Meta batch mode.

## Useful Python commands

```bash
source .venv/bin/activate
python cli.py extract foreplay --brand-ids ID1 ID2
python cli.py extract adplexity --report-id 455
python cli.py extract meta --batch --vertical-filter auto_insurance
python cli.py classify
```
