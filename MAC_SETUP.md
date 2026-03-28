# macOS Setup

## 1. Create a Virtual Environment

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## 2. Configure Local Secrets

```bash
cp .env.example .env
```

Fill in:

- `FOREPLAY_EMAIL`
- `FOREPLAY_PASSWORD`
- `ADPLEXITY_EMAIL`
- `ADPLEXITY_PASSWORD`

## 3. Chrome + ChromeDriver

Install Google Chrome normally.

The Meta scraper will try:

1. `CHROMEDRIVER_PATH`
2. `chromedriver` on `PATH`
3. automatic download through `webdriver-manager`

If Chrome is in a custom location, set:

```bash
export CHROME_BINARY_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
```

If ChromeDriver is already installed:

```bash
export CHROMEDRIVER_PATH="/opt/homebrew/bin/chromedriver"
```

## 4. Run the App

```bash
python cli.py dashboard --serve
```

Open:

- `http://127.0.0.1:8050/db/intelligence_dashboard.html`

## 5. Extract Data

```bash
python cli.py extract foreplay --brand-ids ID1 ID2
python cli.py extract adplexity --report-id 455
python cli.py extract meta --batch --vertical-filter auto_insurance
python cli.py classify
```
