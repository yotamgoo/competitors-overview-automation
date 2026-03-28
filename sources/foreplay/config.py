"""Foreplay Spyder Winners Extractor — configuration."""

from datetime import datetime, timezone, timedelta

API_BASE = "https://api.foreplay.co"
PAGE_SIZE = 100
LOOKBACK_MONTHS = 3
MAX_RETRIES = 3
RATE_LIMIT_BUFFER = 5  # sleep when remaining requests drop to this

DEFAULT_HEADERS = {
    "accept": "application/json, text/plain, */*",
    "accept-language": "en-GB,en-US;q=0.9,en;q=0.8,he;q=0.7",
    "cache-control": "no-cache",
    "dnt": "1",
    "origin": "https://app.foreplay.co",
    "pragma": "no-cache",
    "referer": "https://app.foreplay.co/",
    "sec-ch-ua": '"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-site",
    "user-agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/146.0.0.0 Safari/537.36"
    ),
}


def get_lookback_start(months: int = LOOKBACK_MONTHS) -> int:
    """Return Unix timestamp in milliseconds for *months* ago."""
    now = datetime.now(timezone.utc)
    start = now - timedelta(days=months * 30)
    return int(start.timestamp() * 1000)
