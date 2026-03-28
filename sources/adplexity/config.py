"""AdPlexity Extractor configuration."""

API_BASE = "https://app.adplexity.io"

PAGE_SIZE = 50
MAX_RETRIES = 3
RATE_LIMIT_SLEEP = 1.0  # Seconds between ad-detail requests.

DEFAULT_USER_AGENT = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36"

DEFAULT_HEADERS = {
    "accept": "application/json",
    "accept-language": "en-GB,en-US;q=0.9,en;q=0.8,he;q=0.7",
    "cache-control": "no-cache",
    "dnt": "1",
    "origin": "https://app.adplexity.io",
    "pragma": "no-cache",
    "x-requested-with": "XMLHttpRequest",
    "user-agent": DEFAULT_USER_AGENT,
}
