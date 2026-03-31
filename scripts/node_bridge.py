"""Bridge script for the Node/React app to reuse the working Python extractors."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Iterable

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from classify import classify_ads
from dashboard import get_dashboard_payload
from intelligence_db import IntelligenceDatabase
from unified_extractors import extract_adplexity, extract_foreplay, extract_meta_batch, extract_meta_page


def to_ts_payload(payload: dict[str, Any]) -> dict[str, Any]:
    stats = payload.get("stats") or {}
    ads = []
    for row in payload.get("ads") or []:
        ads.append(
            {
                "id": row.get("id"),
                "source": row.get("source"),
                "sourceId": str(row.get("source_id") or ""),
                "brand": row.get("brand") or "",
                "title": row.get("title") or "",
                "adCopy": row.get("ad_copy") or "",
                "firstSeen": row.get("first_seen"),
                "lastSeen": row.get("last_seen"),
                "daysRunning": row.get("days_running"),
                "status": row.get("status") or "inactive",
                "countries": list(row.get("countries") or []),
                "platforms": list(row.get("platforms") or []),
                "cta": row.get("cta") or "",
                "videoUrl": row.get("video_url"),
                "imageUrl": row.get("image_url"),
                "landingPageUrl": row.get("landing_page_url"),
                "adLibraryUrl": row.get("ad_library_url"),
                "vertical": row.get("vertical"),
                "fetchedAt": row.get("fetched_at"),
                "isWinner": bool(row.get("is_winner")),
                "winnerLabel": row.get("winner_label"),
                "countriesText": row.get("countriesText") or "Global",
                "platformsText": row.get("platformsText") or "Unknown",
                "verticalText": row.get("verticalText") or "unclassified",
                "statusText": row.get("statusText") or "inactive",
                "brandText": row.get("brandText") or "Unknown brand",
                "sourceText": row.get("sourceText") or str(row.get("source") or "").title(),
                "titleText": row.get("titleText") or "",
                "copyText": row.get("copyText") or "",
                "videoHref": row.get("videoUrl"),
                "imageHref": row.get("imageUrl"),
                "firstSeenText": row.get("firstSeenText") or "Unknown",
                "lastSeenText": row.get("lastSeenText") or "Unknown",
                "daysRunningText": row.get("daysRunningText") if row.get("daysRunningText") is not None else "n/a",
                "winnerText": row.get("winnerText") or "",
            }
        )

    return {
        "generatedAt": payload.get("generatedAt"),
        "stats": {
            "totalAds": stats.get("total_ads", 0),
            "winnerAds": stats.get("winner_ads", 0),
            "bySource": stats.get("by_source", {}),
            "byStatus": stats.get("by_status", {}),
            "byVertical": stats.get("by_vertical", {}),
        },
        "ads": ads,
    }


def cmd_dashboard_data(args: argparse.Namespace) -> int:
    payload = get_dashboard_payload(db_path=args.db)
    print(json.dumps(to_ts_payload(payload), ensure_ascii=False))
    return 0


def cmd_extract_foreplay(args: argparse.Namespace) -> int:
    db = IntelligenceDatabase(args.db)
    db.initialize()
    try:
        results = extract_foreplay(
            db,
            brand_ids=args.brand_ids,
            months=args.months,
            email=args.email,
            password=args.password,
            log=print,
        )
    finally:
        db.close()

    total_winners = sum(item.winners_found for item in results)
    print(f"RESULT: Foreplay complete: {total_winners} winner ads stored.")
    return 0


def cmd_extract_adplexity(args: argparse.Namespace) -> int:
    db = IntelligenceDatabase(args.db)
    db.initialize()
    total_ads = 0
    total_details = 0
    total_failed = 0
    try:
        for report_id in args.report_ids:
            result = extract_adplexity(
                db,
                report_id=report_id,
                report_name=str(report_id),
                email=args.email,
                password=args.password,
                log=print,
            )
            total_ads += result.ads_fetched
            total_details += result.details_fetched
            total_failed += result.failed
    finally:
        db.close()

    print(
        "RESULT: AdPlexity complete: "
        f"{total_ads} ads fetched, {total_details} enriched, {total_failed} failed."
    )
    return 0


def cmd_extract_meta(args: argparse.Namespace) -> int:
    db = IntelligenceDatabase(args.db)
    db.initialize()
    try:
        if args.batch:
            summary = extract_meta_batch(
                db,
                advertisers_db=args.advertisers_db,
                vertical=args.vertical_filter or None,
                min_days=args.min_days,
                media_type=args.media,
                max_ads=args.max_ads,
                log=print,
            )
        else:
            summary = extract_meta_page(
                db,
                page_id=args.page_id,
                keywords=args.keywords,
                min_days=args.min_days,
                media_type=args.media,
                max_ads=args.max_ads,
                log=print,
            )
    finally:
        db.close()

    print(
        "RESULT: Meta complete: "
        f"mode={summary.mode}, processed={summary.processed}, stored={summary.stored}, failed={summary.failed}."
    )
    return 0


def cmd_classify(args: argparse.Namespace) -> int:
    summary = classify_ads(
        db_path=args.db,
        force=args.force,
        limit=args.limit,
        dry_run=False,
        log=print,
    )
    print(
        "RESULT: Classification complete: "
        f"scanned={summary.scanned}, classified={summary.classified}, still_unclassified={summary.still_unclassified}."
    )
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Bridge the Node app to the working Python extractors")
    sub = parser.add_subparsers(dest="command", required=True)

    dashboard_data = sub.add_parser("dashboard-data", help="Emit dashboard payload JSON for the Node app")
    dashboard_data.add_argument("--db", required=True, help="Unified intelligence DB path")
    dashboard_data.set_defaults(func=cmd_dashboard_data)

    extract = sub.add_parser("extract", help="Run a Python extractor job")
    extract_sub = extract.add_subparsers(dest="source_name", required=True)

    foreplay = extract_sub.add_parser("foreplay", help="Run Foreplay winner extraction")
    foreplay.add_argument("--db", required=True, help="Unified intelligence DB path")
    foreplay.add_argument("--brand-ids", nargs="+", required=True, help="Foreplay brand IDs")
    foreplay.add_argument("--months", type=int, default=3, help="Lookback months")
    foreplay.add_argument("--email", default=None, help="Optional Foreplay email override")
    foreplay.add_argument("--password", default=None, help="Optional Foreplay password override")
    foreplay.set_defaults(func=cmd_extract_foreplay)

    adplexity = extract_sub.add_parser("adplexity", help="Run AdPlexity extraction")
    adplexity.add_argument("--db", required=True, help="Unified intelligence DB path")
    adplexity.add_argument("--report-ids", nargs="+", type=int, required=True, help="AdPlexity report IDs")
    adplexity.add_argument("--email", default=None, help="Optional AdPlexity email override")
    adplexity.add_argument("--password", default=None, help="Optional AdPlexity password override")
    adplexity.set_defaults(func=cmd_extract_adplexity)

    meta = extract_sub.add_parser("meta", help="Run Meta extraction")
    meta.add_argument("--db", required=True, help="Unified intelligence DB path")
    mode_group = meta.add_mutually_exclusive_group(required=True)
    mode_group.add_argument("--page-id", help="Single Meta advertiser page ID")
    mode_group.add_argument("--batch", action="store_true", help="Run batch mode using the advertisers DB")
    meta.add_argument("--keywords", default="", help="Keyword filter for page mode")
    meta.add_argument("--vertical-filter", default="", help="Vertical filter for batch mode")
    meta.add_argument("--min-days", type=int, default=30, help="Minimum days running")
    meta.add_argument("--media", choices=["image", "video", "both"], default="both", help="Media type filter")
    meta.add_argument("--max-ads", type=int, default=50, help="Max ads to scrape")
    meta.add_argument("--advertisers-db", default="", help="Advertisers DB for batch mode")
    meta.set_defaults(func=cmd_extract_meta)

    classify = sub.add_parser("classify", help="Run the Python classifier")
    classify.add_argument("--db", required=True, help="Unified intelligence DB path")
    classify.add_argument("--force", action="store_true", help="Reclassify all ads")
    classify.add_argument("--limit", type=int, default=None, help="Optional row limit")
    classify.set_defaults(func=cmd_classify)

    return parser


def main(argv: Iterable[str] | None = None) -> int:
    args = build_parser().parse_args(list(argv) if argv is not None else None)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
