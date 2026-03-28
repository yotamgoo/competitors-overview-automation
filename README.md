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
