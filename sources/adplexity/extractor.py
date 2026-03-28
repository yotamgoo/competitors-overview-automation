"""Core extraction logic for AdPlexity reports."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable

try:  # pragma: no cover - supports both package and script execution
    from .api_client import AdplexityClient
    from .models import Database
except ImportError:  # pragma: no cover
    from api_client import AdplexityClient
    from models import Database


@dataclass
class ExtractionResult:
    report_id: int
    report_name: str
    ads_fetched: int = 0
    details_fetched: int = 0
    failed: int = 0


class AdplexityExtractor:
    def __init__(
        self,
        client: AdplexityClient,
        db: Database,
        log: Callable[..., Any] = print,
    ):
        self.client = client
        self.db = db
        self._log = log

    def extract_report(self, report_id: int, report_name: str = "") -> ExtractionResult:
        result = ExtractionResult(report_id=report_id, report_name=report_name)
        run_id = self.db.start_run(report_id)

        try:
            self.db.upsert_report(report_id, report_name or str(report_id))

            # 1. Fetch all ads from report listing
            self._log(f"[{report_name}] Fetching ads from report {report_id}...")
            ads: list[dict] = list(self.client.iter_report_ads(report_id))
            self._log(f"[{report_name}] {len(ads)} ads found")

            self.db.bulk_upsert_ads(ads, report_id)
            result.ads_fetched = len(ads)

            # 2. Enrich each ad with detail (video, copy, platforms)
            self._log(f"[{report_name}] Fetching ad details...")
            ids_needing_detail = self.db.get_ads_needing_detail(report_id)
            total = len(ids_needing_detail)

            for i, adplexity_id in enumerate(ids_needing_detail, 1):
                self._log(f"  [{i}/{total}] ad {adplexity_id}")
                try:
                    detail = self.client.get_ad_detail(adplexity_id)
                    if detail:
                        self.db.commit_detail(adplexity_id, detail)
                        result.details_fetched += 1
                    else:
                        self._log(f"    -> not found")
                        result.failed += 1
                except Exception as exc:
                    self._log(f"    -> error: {exc}")
                    result.failed += 1

            self._log(
                f"[{report_name}] Done — "
                f"{result.ads_fetched} ads, "
                f"{result.details_fetched} enriched, "
                f"{result.failed} failed"
            )
            self.db.end_run(run_id, result.ads_fetched)

        except Exception:
            self.db.end_run(run_id, result.ads_fetched, status="failed")
            raise

        return result
