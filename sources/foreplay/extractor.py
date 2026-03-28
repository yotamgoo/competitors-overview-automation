"""Core winner-detection logic for Foreplay Spyder ads.

Winner logic (mirrors the Foreplay UI exactly):
  The UI shows creative tests grouped by START DATE. For each date:
    - "X/Y Ads Running" = X ads still live, Y total ads started that day
    - "Winner Identified" = exactly 1 ad from that day is still live

  So: for each date bucket, fetch all ads. If exactly 1 is live → winner day.
  The winner = that single live ad.

  No collationId grouping needed — the date IS the test boundary.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

try:  # pragma: no cover - supports both package and script execution
    from .api_client import ForeplayClient
    from .config import LOOKBACK_MONTHS
    from .models import Database
except ImportError:  # pragma: no cover
    from api_client import ForeplayClient
    from config import LOOKBACK_MONTHS
    from models import Database


_DAY_MS = 24 * 60 * 60 * 1000


@dataclass
class ExtractionResult:
    brand_id: str
    brand_name: str
    dates_processed: int = 0
    ads_fetched: int = 0
    winners_found: int = 0
    in_progress: int = 0   # multiple ads still live on that date
    failed: int = 0         # all ads stopped, no winner


def _parse_date_ts(date_str: str) -> int | None:
    match = re.search(r"\d{10,}", date_str)
    return int(match.group()) if match else None


class WinnerExtractor:
    def __init__(
        self,
        client: ForeplayClient,
        db: Database,
        log: Callable[..., Any] = print,
    ):
        self.client = client
        self.db = db
        self._log = log

    def extract_brand(
        self,
        brand_id: str,
        brand_name: str,
        lookback_months: int = LOOKBACK_MONTHS,
    ) -> ExtractionResult:
        result = ExtractionResult(brand_id=brand_id, brand_name=brand_name)
        run_id = self.db.start_run(brand_id)

        try:
            self.db.upsert_brand(brand_id, brand_name)

            # 1. Get date buckets from the creative-tests aggregation endpoint
            cutoff_ms = _lookback_start_ms(lookback_months)
            self._log(f"[{brand_name}] Fetching creative-test dates...")
            all_dates = self.client.get_creative_test_dates(brand_id)
            dates_in_window = [
                d for d in all_dates
                if (ts := _parse_date_ts(d["date"])) and ts >= cutoff_ms
            ]
            self._log(f"[{brand_name}] {len(dates_in_window)} date buckets in last {lookback_months} months")

            # 2. Process each date: fetch its ads, then check live count
            for i, day_entry in enumerate(dates_in_window, 1):
                day_ts = _parse_date_ts(day_entry["date"])
                if day_ts is None:
                    continue

                day_str = datetime.fromtimestamp(day_ts / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
                expected = day_entry.get("count", "?")
                live_expected = day_entry.get("liveCount", "?")
                self._log(
                    f"  [{i}/{len(dates_in_window)}] {day_str} "
                    f"({expected} tests, {live_expected} live)"
                )

                day_ads: list[dict[str, Any]] = list(
                    self.client.iter_ads(
                        brand_id,
                        started_after=day_ts,
                        started_before=day_ts + _DAY_MS - 1,
                    )
                )
                result.ads_fetched += len(day_ads)
                self.db.bulk_upsert_ads(day_ads)

                # 3. Count live ads for this day
                live_ads = [a for a in day_ads if a.get("live")]

                if len(live_ads) == 1:
                    # Winner: single ad from this day is still running
                    winner = live_ads[0]
                    # Enrich DCO ads that have no thumbnail/video
                    self._enrich_dco(winner, brand_id)
                    # Use day timestamp as the collation key for this date's winner
                    self.db.upsert_winner(
                        collation_id=str(day_ts),
                        brand_id=brand_id,
                        winner_ad_id=winner["id"],
                        total_ads=len(day_ads),
                    )
                    result.winners_found += 1
                    self._log(f"    *** WINNER: ad_id={winner.get('ad_id')} ({winner.get('display_format')})")
                elif len(live_ads) == 0:
                    result.failed += 1
                else:
                    result.in_progress += 1

            result.dates_processed = len(dates_in_window)
            self._log(
                f"[{brand_name}] Done — "
                f"{result.winners_found} winners, "
                f"{result.in_progress} dates in-progress, "
                f"{result.failed} dates failed"
            )
            self.db.end_run(run_id, result.ads_fetched, result.winners_found)

        except Exception:
            self.db.end_run(run_id, result.ads_fetched, result.winners_found, status="failed")
            raise

        return result

    def _enrich_dco(self, ad: dict, brand_id: str) -> None:
        """If a winner ad has no real thumbnail/video, fetch DCO card image via collationId."""
        cards = ad.get("cards") or []
        first_card = cards[0] if cards else {}
        has_media = (
            first_card.get("video")
            or first_card.get("thumbnail")
            or first_card.get("image")
            or ad.get("image")
        )
        if has_media:
            return  # already has real media, skip

        doc_id = ad.get("id")
        if not doc_id:
            return
        collation_id = ad.get("collationId")

        self._log(f"    [DCO] Fetching card image (collationId={collation_id})...")
        url = self.client.get_dco_thumbnail(
            brand_id,
            collation_id=collation_id,
            fb_ad_id=ad.get("ad_id"),
            started_running=ad.get("startedRunning"),
        )
        if url:
            self._log(f"    [DCO] Found: {url[:70]}...")
            self.db.update_ad_thumbnail(doc_id, url)
        else:
            self._log(f"    [DCO] No card image found")

    def extract_brands(
        self,
        brands: list[tuple[str, str]],
        lookback_months: int = LOOKBACK_MONTHS,
    ) -> list[ExtractionResult]:
        results = []
        for i, (bid, bname) in enumerate(brands, 1):
            self._log(f"\n=== Brand {i}/{len(brands)}: {bname} ===")
            try:
                r = self.extract_brand(bid, bname, lookback_months)
                results.append(r)
            except Exception as exc:
                self._log(f"[{bname}] ERROR: {exc}")
                results.append(ExtractionResult(brand_id=bid, brand_name=bname))
        return results


def _lookback_start_ms(months: int) -> int:
    now = datetime.now(timezone.utc)
    start = now - timedelta(days=months * 30)
    return int(start.timestamp() * 1000)
