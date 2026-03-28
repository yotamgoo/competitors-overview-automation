"""Selenium-based fallback: log in to Foreplay and capture network responses."""

from __future__ import annotations

import json
import os
import time
import uuid
from pathlib import Path
from shutil import which
from typing import Any, Callable, Iterator

from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait
from webdriver_manager.chrome import ChromeDriverManager

try:  # pragma: no cover - supports both package and script execution
    from .config import PAGE_SIZE, get_lookback_start
except ImportError:  # pragma: no cover
    from config import PAGE_SIZE, get_lookback_start


# ── driver setup (mirrors meta-ads-scraper patterns) ────────────────


def _resolve_chromedriver() -> str:
    explicit = os.getenv("CHROMEDRIVER_PATH", "").strip()
    if explicit:
        if os.path.exists(explicit):
            return explicit
        raise RuntimeError(f"CHROMEDRIVER_PATH does not exist: {explicit}")
    local = which("chromedriver")
    if local:
        return local
    return ChromeDriverManager().install()


def _build_driver() -> webdriver.Chrome:
    opts = Options()
    opts.add_argument("--start-maximized")
    opts.add_argument("--disable-blink-features=AutomationControlled")
    opts.add_argument("--no-first-run")
    opts.add_argument("--no-default-browser-check")
    opts.add_argument("--disable-gpu")
    opts.add_argument("--disable-dev-shm-usage")
    opts.add_argument("--remote-debugging-port=0")
    opts.add_argument("--disable-features=RendererCodeIntegrity")
    opts.add_argument("--window-size=1920,1080")
    opts.add_experimental_option("excludeSwitches", ["enable-automation"])
    opts.add_experimental_option("useAutomationExtension", False)

    # Persistent profile so login cookies survive across runs
    profile_dir = Path.cwd() / ".chrome-profiles" / "foreplay"
    profile_dir.mkdir(parents=True, exist_ok=True)
    opts.add_argument(f"--user-data-dir={profile_dir}")

    # Enable network interception via CDP
    opts.set_capability("goog:loggingPrefs", {"performance": "ALL"})

    driver = webdriver.Chrome(service=Service(_resolve_chromedriver()), options=opts)
    driver.execute_script(
        "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})"
    )
    return driver


# ── browser extractor ───────────────────────────────────────────────


class BrowserExtractor:
    """Fallback extractor that captures XHR responses through Chrome DevTools."""

    def __init__(self, email: str, password: str, log: Callable[..., Any] = print):
        self.email = email
        self.password = password
        self._log = log
        self.driver: webdriver.Chrome | None = None

    def start(self) -> None:
        self._log("Starting Chrome...")
        self.driver = _build_driver()
        # Enable CDP Network domain for response body capture
        self.driver.execute_cdp_cmd("Network.enable", {})

    def login(self) -> None:
        assert self.driver
        self._log("Navigating to Foreplay login...")
        self.driver.get("https://app.foreplay.co/login")

        wait = WebDriverWait(self.driver, 20)

        # Check if already logged in (redirected away from login)
        time.sleep(3)
        if "/login" not in self.driver.current_url:
            self._log("Already logged in (cookie session)")
            return

        # Fill login form
        email_input = wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, "input[type='email']")))
        email_input.clear()
        email_input.send_keys(self.email)

        pw_input = self.driver.find_element(By.CSS_SELECTOR, "input[type='password']")
        pw_input.clear()
        pw_input.send_keys(self.password)

        submit = self.driver.find_element(By.CSS_SELECTOR, "button[type='submit']")
        submit.click()

        # Wait for redirect after login
        wait.until(lambda d: "/login" not in d.current_url)
        self._log("Logged in successfully")
        time.sleep(2)

    def iter_ads_for_brand(
        self,
        brand_id: str,
        lookback_months: int = 3,
    ) -> Iterator[dict]:
        """Navigate to the brand's Spyder page and capture ad data from network."""
        assert self.driver
        started_after = get_lookback_start(lookback_months)

        # Build the discovery URL the browser would call
        base_url = (
            f"https://app.foreplay.co/spyder?brands={brand_id}"
            f"&sort=longest&spyder=true"
        )
        self._log(f"Navigating to Spyder view: {base_url}")
        self.driver.get(base_url)
        time.sleep(5)

        # Collect ads from network responses by polling performance logs
        all_ads: dict[str, dict] = {}
        scroll_attempts = 0
        max_scrolls = 50

        while scroll_attempts < max_scrolls:
            new_ads = self._capture_ads_from_logs()
            for ad in new_ads:
                aid = ad.get("id")
                if aid:
                    all_ads[aid] = ad

            # Scroll to trigger next page load
            self.driver.execute_script("window.scrollTo(0, document.body.scrollHeight)")
            time.sleep(2)
            scroll_attempts += 1

            # Check if we got new ads this scroll
            new_batch = self._capture_ads_from_logs()
            if not new_batch:
                # No new network requests — we've reached the end
                break
            for ad in new_batch:
                aid = ad.get("id")
                if aid:
                    all_ads[aid] = ad

        self._log(f"Captured {len(all_ads)} ads via browser network")
        yield from all_ads.values()

    def _capture_ads_from_logs(self) -> list[dict]:
        """Extract ad objects from Chrome performance logs (XHR responses)."""
        assert self.driver
        ads = []
        try:
            logs = self.driver.get_log("performance")
        except Exception:
            return ads

        for entry in logs:
            try:
                msg = json.loads(entry["message"])["message"]
                if msg["method"] != "Network.responseReceived":
                    continue
                url = msg["params"]["response"]["url"]
                if "api.foreplay.co/ads/discovery" not in url:
                    continue

                request_id = msg["params"]["requestId"]
                body = self.driver.execute_cdp_cmd(
                    "Network.getResponseBody", {"requestId": request_id}
                )
                data = json.loads(body.get("body", "{}"))
                results = data.get("results", [])
                ads.extend(results)
            except Exception:
                continue

        return ads

    def close(self) -> None:
        if self.driver:
            self.driver.quit()
            self.driver = None
