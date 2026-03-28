"""HTTP client for app.adplexity.io — auth, reports, ad detail."""

from __future__ import annotations

import time
from typing import Any, Iterator

import httpx

try:  # pragma: no cover - supports both package and script execution
    from .config import API_BASE, DEFAULT_HEADERS, MAX_RETRIES, PAGE_SIZE, RATE_LIMIT_SLEEP
except ImportError:  # pragma: no cover
    from config import API_BASE, DEFAULT_HEADERS, MAX_RETRIES, PAGE_SIZE, RATE_LIMIT_SLEEP


class AdplexityClient:
    """Thin wrapper around the AdPlexity internal API."""

    def __init__(
        self,
        email: str,
        password: str,
        log=print,
    ):
        self._log = log
        self._http = httpx.Client(
            base_url=API_BASE,
            headers=DEFAULT_HEADERS,
            timeout=30.0,
            follow_redirects=True,
        )
        self._login(email, password)

    # ── auth ────────────────────────────────────────────────────────

    def _login(self, email: str, password: str) -> None:
        """Full auth flow mirroring the browser:
        1. GET / to seed XSRF-TOKEN cookie
        2. POST /members/login with credentials
        3. POST /api/user/session to initialise SPA session
        Each step re-reads the rotated XSRF-TOKEN cookie.
        """
        import urllib.parse

        self._log("Logging in to AdPlexity...")

        # Step 1: seed XSRF-TOKEN cookie
        self._http.get("/")
        self._sync_xsrf()

        # Step 2: login
        resp = self._http.post(
            "/members/login",
            data={"amember_login": email, "amember_pass": password},
            headers={"content-type": "application/x-www-form-urlencoded"},
        )
        resp.raise_for_status()
        data = resp.json()
        if not data.get("ok"):
            raise RuntimeError(f"AdPlexity login failed: {data.get('error')}")

        self._sync_xsrf()

        # Step 3: initialise SPA session
        self._http.post("/api/user/session", json={})
        self._sync_xsrf()

        self._log("Authenticated successfully")

    def _sync_xsrf(self) -> None:
        """Read the current XSRF-TOKEN cookie and set it as the request header."""
        import urllib.parse
        raw = self._http.cookies.get("XSRF-TOKEN", "")
        if raw:
            self._http.headers["x-xsrf-token"] = urllib.parse.unquote(raw)

    # ── low-level request ───────────────────────────────────────────

    def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict | None = None,
        json: Any = None,
        referer: str | None = None,
    ) -> httpx.Response:
        # Refresh XSRF token from cookie before every request (it rotates)
        self._sync_xsrf()
        headers = {"referer": referer} if referer else {}
        last_exc: Exception | None = None
        for attempt in range(1, MAX_RETRIES + 1):
            try:
                resp = self._http.request(method, path, params=params, json=json, headers=headers)
            except (httpx.ConnectError, httpx.ReadTimeout) as exc:
                last_exc = exc
                self._log(f"  [retry {attempt}/{MAX_RETRIES}] network error: {exc}")
                time.sleep(2 ** attempt)
                continue

            if resp.status_code == 429:
                self._log(f"  [retry {attempt}/{MAX_RETRIES}] 429 rate-limited, sleeping 60s")
                time.sleep(60)
                last_exc = httpx.HTTPStatusError("429", request=resp.request, response=resp)
                continue

            if resp.status_code >= 500:
                self._log(f"  [retry {attempt}/{MAX_RETRIES}] server error {resp.status_code}")
                time.sleep(2 ** attempt)
                last_exc = httpx.HTTPStatusError(
                    str(resp.status_code), request=resp.request, response=resp
                )
                continue

            resp.raise_for_status()
            return resp

        raise RuntimeError(f"Request failed after {MAX_RETRIES} attempts: {last_exc}")

    # ── reports ─────────────────────────────────────────────────────

    def list_reports(self) -> list[dict]:
        """Return all saved reports for this account."""
        resp = self._request("GET", "/api/reports")
        return resp.json() or []

    def iter_report_ads(self, report_id: int) -> Iterator[dict]:
        """Yield all ads from a saved report, paginating automatically."""
        offset = 0
        while True:
            resp = self._request("POST", "/api/report/show", json={
                "id": report_id,
                "count": PAGE_SIZE,
                "offset": offset,
            })
            data = resp.json()
            ads = data.get("ads") or []
            if not ads:
                break
            self._log(f"  report page offset={offset}: {len(ads)} ads")
            yield from ads
            if len(ads) < PAGE_SIZE:
                break
            offset += PAGE_SIZE

    # ── ad detail ───────────────────────────────────────────────────

    def get_ad_detail(self, adplexity_id: int) -> dict | None:
        """GET /api/adx/{id} — returns full ad detail including video, copy, platforms."""
        time.sleep(RATE_LIMIT_SLEEP)
        try:
            resp = self._request(
                "GET",
                f"/api/adx/{adplexity_id}",
                referer=f"{API_BASE}/ad/{adplexity_id}",
            )
            if resp.status_code == 204 or not resp.content:
                return None
            return resp.json()
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code in (404, 204):
                return None
            raise

    # ── search ──────────────────────────────────────────────────────

    def search_ads(
        self,
        keyword: str = "",
        country: str | None = None,
        days_running_min: int = 1,
        date_from: str | None = None,
        date_to: str | None = None,
        offset: int = 0,
    ) -> dict:
        """POST /api/search — returns {total, ads[]}."""
        body: dict[str, Any] = {
            "mode": "keyword",
            "subMode": "ad",
            "query": keyword,
            "querySubject": "keyword.ad_or_lp",
            "order": "first_seen",
            "count": PAGE_SIZE,
            "offset": offset,
            "daysRunningFrom": days_running_min,
            "daysRunningTo": None,
            "bidPriceFrom": 0,
            "bidPriceTo": None,
            "videoLengthFrom": 0,
            "videoLikesFrom": 0,
            "videoViewsFrom": 0,
            "countriesCountFrom": 1,
            "adsCountFrom": 1,
            "advancedFilter": {},
            "deviceType": {"values": [], "exclusiveSearch": False},
            "adType": {"values": [], "exclusiveSearch": False},
            "adCategory": {"values": [], "exclusiveSearch": False},
            "country": {"values": [country] if country else [], "exclusiveSearch": False},
            "language": {"values": [], "exclusiveSearch": False},
            "connection": {"values": [], "exclusiveSearch": False},
        }
        if date_from:
            body["from"] = date_from
        if date_to:
            body["to"] = date_to
        resp = self._request("POST", "/api/search", json=body)
        return resp.json()

    def close(self) -> None:
        self._http.close()
