# Meta Ads Library Source

This source scraper powers the unified app's `meta` extraction mode.

## What It Needs

- Python 3.11+
- Google Chrome installed
- Selenium dependencies from the project root `requirements.txt`

The scraper will try to find ChromeDriver in this order:

1. `CHROMEDRIVER_PATH`
2. `chromedriver` already on `PATH`
3. automatic download via `webdriver-manager`

If Chrome is installed in a non-standard location, set:

- `CHROME_BINARY_PATH=/path/to/Google Chrome`

## Run From Project Root

### macOS / Linux

```bash
python cli.py extract meta --page-id 1234567890
python cli.py extract meta --batch --vertical-filter auto_insurance
```

### Windows PowerShell

```powershell
python cli.py extract meta --page-id 1234567890
python cli.py extract meta --batch --vertical-filter auto_insurance
```

## Notes

- Country is fixed to United States (`US`) by design.
- First run may need internet access so `webdriver-manager` can fetch ChromeDriver.
- Batch mode uses the advertiser database defined by `META_ADVERTISERS_DB`.
