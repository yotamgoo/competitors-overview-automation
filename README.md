# Competitive Intelligence App

Unified competitive intelligence platform for competitor ads across:

- Foreplay winner extraction
- AdPlexity saved-report extraction
- Meta Ads Library scraping

The project writes everything into one normalized SQLite database and gives you:

- a single CLI
- a keyword-based vertical classifier
- a dark-theme HTML dashboard
- a local dashboard app mode that can trigger extraction jobs
- an in-progress TypeScript/Node/React migration for Google AI Studio constraints

## Quick Start

1. Create a virtual environment.
2. Install dependencies.
3. Copy `.env.example` to `.env`.
4. Fill in your local credentials.
5. Run the dashboard app.

### macOS / Linux

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
python cli.py dashboard --serve
```

### Windows PowerShell

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
python cli.py dashboard --serve
```

The dashboard will usually be available at:

- `http://127.0.0.1:8050/db/intelligence_dashboard.html`

## TypeScript Migration Scaffold

The repo now also includes a parallel TypeScript stack under:

- `apps/server`
- `apps/web`
- `packages/shared`

This migration path is aimed at Google AI Studio and other environments where a Node/React app is easier to host than the current Python app.

Current TypeScript status:

- shared contracts, settings normalization, and classifier rules are ported
- the Node server persists settings and serves a real dashboard payload from `db/intelligence.json`
- the React app mirrors the control-panel/dashboard structure
- extractor routes are still being ported, starting with Foreplay

Typical TypeScript env additions:

- `INTELLIGENCE_DATA_PATH=db/intelligence.json`
- `INTELLIGENCE_DASHBOARD_SETTINGS_PATH=db/dashboard_settings.json`
- `PYTHON_EXECUTABLE=python3` on macOS/Linux, or `python` on Windows if needed

Planned commands once Node dependencies are installed:

```bash
npm install
npm run dev
```

For the single-app packaged flow, build the React app and let the Node server serve it:

```bash
npm run app
```

## Core Commands

```bash
python cli.py extract foreplay --brand-ids ID1 ID2
python cli.py extract adplexity --report-id 455
python cli.py extract meta --page-id 1234567890
python cli.py extract meta --batch --vertical-filter auto_insurance
python cli.py classify
python cli.py dashboard --serve
```

## Configuration

Runtime settings come from environment variables or a local `.env` file loaded by `app_config.py`.

Important keys:

- `FOREPLAY_EMAIL`
- `FOREPLAY_PASSWORD`
- `ADPLEXITY_EMAIL`
- `ADPLEXITY_PASSWORD`
- `META_ADVERTISERS_DB`

## macOS Notes

- The unified CLI, DB, classifier, and dashboard are cross-platform Python code.
- Foreplay and AdPlexity are HTTP-only flows and should work the same on macOS.
- Meta needs Google Chrome and ChromeDriver. You can set:
  - `CHROMEDRIVER_PATH`
  - `CHROME_BINARY_PATH`

More detail is in [MAC_SETUP.md](MAC_SETUP.md).

## Dashboard App Behavior

When you run `python cli.py dashboard --serve`, the HTML becomes a local control app that:

- saves settings before actions
- validates inputs before extraction
- asks for confirmation before long-running jobs
- runs one job at a time
- shows a live log while work is running

## Data + Secrets

This repo is configured so generated databases, dashboards, media, and local secrets stay out of git by default.
