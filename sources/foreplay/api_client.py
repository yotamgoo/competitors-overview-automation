"""HTTP client for the Foreplay api.foreplay.co endpoints."""

from __future__ import annotations

import time
from typing import Any, Callable, Iterator

import httpx

try:  # pragma: no cover - supports both package and script execution
    from .config import API_BASE, DEFAULT_HEADERS, MAX_RETRIES, PAGE_SIZE, RATE_LIMIT_BUFFER
except ImportError:  # pragma: no cover
    from config import API_BASE, DEFAULT_HEADERS, MAX_RETRIES, PAGE_SIZE, RATE_LIMIT_BUFFER

FIREBASE_API_KEY = "AIzaSyCIn3hB6C5qsx5L_a_V17n08eJ24MeqYDg"
FIREBASE_VERIFY_URL = f"https://www.googleapis.com/identitytoolkit/v3/relyingparty/verifyPassword?key={FIREBASE_API_KEY}"
FIREBASE_REFRESH_URL = f"https://securetoken.googleapis.com/v1/token?key={FIREBASE_API_KEY}"


def firebase_login(email: str, password: str) -> dict:
    """Authenticate via Firebase and return token info.

    Returns dict with keys: idToken, refreshToken, expiresIn, localId, email.
    """
    resp = httpx.post(
        FIREBASE_VERIFY_URL,
        json={"email": email, "password": password, "returnSecureToken": True},
        headers={"origin": "https://app.foreplay.co", "referer": "https://app.foreplay.co/"},
        timeout=15.0,
    )
    resp.raise_for_status()
    return resp.json()


def firebase_refresh(refresh_token: str) -> dict:
    """Exchange a refresh token for a new id token.

    Returns dict with keys: access_token, id_token, refresh_token, expires_in.
    """
    resp = httpx.post(
        FIREBASE_REFRESH_URL,
        data={"grant_type": "refresh_token", "refresh_token": refresh_token},
        headers={
            "origin": "https://app.foreplay.co",
            "referer": "https://app.foreplay.co/",
            "x-client-version": "Chrome/JsCore/8.10.1/FirebaseCore-web",
        },
        timeout=15.0,
    )
    resp.raise_for_status()
    return resp.json()


class ForeplayClient:
    """Thin wrapper around api.foreplay.co with auth, rate-limit handling and pagination."""

    def __init__(
        self,
        email: str | None = None,
        password: str | None = None,
        token: str | None = None,
        log: Callable[..., Any] = print,
    ):
        self._log = log
        self._refresh_token: str | None = None
        self._token_expires_at: float = 0

        headers = dict(DEFAULT_HEADERS)

        if token:
            headers["authorization"] = f"Bearer {token}"
        elif email and password:
            self._log("Authenticating with Firebase...")
            auth = firebase_login(email, password)
            headers["authorization"] = f"Bearer {auth['idToken']}"
            self._refresh_token = auth.get("refreshToken")
            self._token_expires_at = time.time() + int(auth.get("expiresIn", 3600)) - 60
            self._log("Authenticated successfully")

        self._http = httpx.Client(
            base_url=API_BASE,
            headers=headers,
            timeout=30.0,
            follow_redirects=True,
        )

    # ── token refresh ───────────────────────────────────────────────

    def _ensure_token(self) -> None:
        """Refresh the Firebase token if it's about to expire."""
        if not self._refresh_token:
            return
        if time.time() < self._token_expires_at:
            return
        self._log("Refreshing auth token...")
        data = firebase_refresh(self._refresh_token)
        new_token = data.get("id_token") or data.get("access_token", "")
        self._http.headers["authorization"] = f"Bearer {new_token}"
        self._refresh_token = data.get("refresh_token", self._refresh_token)
        self._token_expires_at = time.time() + int(data.get("expires_in", 3600)) - 60

    # ── low-level request ───────────────────────────────────────────

    def _request(self, method: str, path: str, params: dict | None = None) -> httpx.Response:
        self._ensure_token()
        last_exc: Exception | None = None
        for attempt in range(1, MAX_RETRIES + 1):
            try:
                resp = self._http.request(method, path, params=params)
            except (httpx.ConnectError, httpx.ReadTimeout) as exc:
                last_exc = exc
                self._log(f"  [retry {attempt}/{MAX_RETRIES}] network error: {exc}")
                time.sleep(2 ** attempt)
                continue

            # Rate-limit handling
            remaining = resp.headers.get("x-ratelimit-remaining")
            reset_at = resp.headers.get("x-ratelimit-reset")
            if remaining is not None and int(remaining) <= RATE_LIMIT_BUFFER:
                wait = max(0, float(reset_at or 0) - time.time()) + 2
                self._log(f"  rate-limit low ({remaining} left), sleeping {wait:.0f}s")
                time.sleep(wait)

            if resp.status_code == 429:
                wait = max(0, float(reset_at or 0) - time.time()) + 2
                self._log(f"  [retry {attempt}/{MAX_RETRIES}] 429 rate-limited, sleeping {wait:.0f}s")
                time.sleep(wait)
                last_exc = httpx.HTTPStatusError(
                    "429", request=resp.request, response=resp
                )
                continue

            if resp.status_code >= 500:
                last_exc = httpx.HTTPStatusError(
                    f"{resp.status_code}", request=resp.request, response=resp
                )
                self._log(f"  [retry {attempt}/{MAX_RETRIES}] server error {resp.status_code}")
                time.sleep(2 ** attempt)
                continue

            resp.raise_for_status()
            return resp

        raise RuntimeError(f"Request failed after {MAX_RETRIES} attempts: {last_exc}")

    # ── ads ─────────────────────────────────────────────────────────

    def iter_ads(
        self,
        brand_id: str,
        started_after: int | None = None,
        started_before: int | None = None,
    ) -> Iterator[dict]:
        """Yield every ad for *brand_id*, paginating automatically.

        When started_after AND started_before are both set, the request
        targets a specific day range (exactly how the Foreplay UI works).
        """
        params: dict[str, Any] = {
            "orBrands[]": brand_id,
            "sort": "longest",
            "spyder": "true",
            "size": str(PAGE_SIZE),
        }
        if started_after is not None:
            params["startedRunningStart"] = str(started_after)
        if started_before is not None:
            params["startedRunningEnd"] = str(started_before)

        cursor: str | None = None
        page = 0
        while True:
            page += 1
            p = dict(params)
            if cursor:
                p["next"] = cursor

            resp = self._request("GET", "/ads/discovery", params=p)
            data = resp.json()

            results = data.get("results", [])
            if not results:
                break

            self._log(f"  page {page}: {len(results)} ads")
            yield from results

            next_page = data.get("nextPage")
            if not next_page:
                break
            cursor = next_page

    def get_creative_test_dates(self, brand_id: str) -> list[dict]:
        """Return date aggregations for a brand's creative tests.

        Each entry: { "date": "yyyy-MM-dd{timestamp}", "count": N, "liveCount": N }
        Paginates automatically and returns all entries.
        """
        aggregations: list[dict] = []
        cursor: str | None = None
        while True:
            path = f"/brands/creative-tests/{brand_id}"
            params: dict[str, Any] = {}
            if cursor:
                params["next"] = cursor

            resp = self._request("GET", path, params=params)
            data = resp.json()
            batch = data.get("aggregations", [])
            aggregations.extend(batch)

            next_id = data.get("nextId")
            if not next_id or not batch:
                break
            cursor = next_id

        return aggregations

    # ── brands ──────────────────────────────────────────────────────

    def iter_brands(self) -> Iterator[dict]:
        """Yield brands from the discovery endpoint, paginating automatically."""
        params: dict[str, Any] = {"sort": "subscriberCount"}
        cursor: str | None = None
        while True:
            p = dict(params)
            if cursor:
                p["next"] = cursor

            resp = self._request("GET", "/brands/discovery", params=p)
            data = resp.json()

            results = data.get("results", [])
            if not results:
                break
            yield from results

            next_page = data.get("nextPage")
            if not next_page:
                break
            # nextPage can be a JSON array like [184.18, "id"] — pass as string
            cursor = str(next_page) if not isinstance(next_page, str) else next_page

    def find_brand(self, name: str) -> dict | None:
        """Search brands by name (case-insensitive substring match)."""
        name_lower = name.lower()
        for brand in self.iter_brands():
            brand_name = (brand.get("name") or "").lower()
            if name_lower in brand_name or brand_name in name_lower:
                return brand
        return None

    def get_dco_thumbnail(
        self,
        brand_id: str,
        collation_id: str | None = None,
        fb_ad_id: int | None = None,
        started_running: int | None = None,
    ) -> str | None:
        """Fetch the first card image for a DCO ad.

        DCO ads use cards[0].image (not .thumbnail).
        Strategy 1: collation_id — fetches all ads in that creative test.
        Strategy 2: fb_ad_id + started_running — date-range fetch, match by Facebook ad ID.
        Returns the image URL, or None if unavailable.
        """
        _DAY_MS = 86_400_000

        def _extract_image(results: list, target_fb_ad_id: int | None) -> str | None:
            for ad in results:
                if target_fb_ad_id and ad.get("ad_id") != target_fb_ad_id:
                    continue
                cards = ad.get("cards") or []
                first_card = cards[0] if cards else {}
                url = (
                    first_card.get("thumbnail")
                    or first_card.get("image")
                    or ad.get("image")
                )
                if url:
                    return url
            return None

        try:
            # Strategy 1: collation endpoint
            if collation_id:
                resp = self._request("GET", "/ads/discovery", params={
                    "orBrands[]": brand_id,
                    "collationId": collation_id,
                })
                result = _extract_image(resp.json().get("results") or [], None)
                if result:
                    return result

            # Strategy 2: date-range + match by fb_ad_id
            if fb_ad_id and started_running:
                resp = self._request("GET", "/ads/discovery", params={
                    "orBrands[]": brand_id,
                    "startedRunningStart": started_running,
                    "startedRunningEnd": started_running + _DAY_MS - 1,
                    "spyder": "true",
                    "size": "100",
                })
                result = _extract_image(resp.json().get("results") or [], fb_ad_id)
                if result:
                    return result

        except Exception:
            pass

        return None

    def close(self) -> None:
        self._http.close()
