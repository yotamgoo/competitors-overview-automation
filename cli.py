"""Unified CLI for the competitive intelligence platform."""

from __future__ import annotations

import argparse
import csv
import io
import json
import sys
from pathlib import Path
from typing import Iterable

from app_config import (
    ADPLEXITY_EMAIL,
    ADPLEXITY_PASSWORD,
    DEFAULT_DASHBOARD_PATH,
    DEFAULT_DASHBOARD_SETTINGS_PATH,
    DEFAULT_DB_PATH,
    FOREPLAY_EMAIL,
    FOREPLAY_PASSWORD,
    META_ADVERTISERS_DB,
)
from classify import classify_ads
from dashboard import build_dashboard, serve_dashboard
from intelligence_db import IntelligenceDatabase
from unified_extractors import extract_adplexity, extract_foreplay, extract_meta_batch, extract_meta_page

if hasattr(sys.stdout, "reconfigure"):  # pragma: no branch - runtime safeguard for Windows terminals
    sys.stdout.reconfigure(encoding="utf-8")


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
        )
    finally:
        db.close()

    total_winners = 0
    print("\nForeplay extraction summary")
    print("-" * 72)
    for result in results:
        total_winners += result.winners_found
        print(
            f"{result.brand_name:<24} "
            f"dates={result.dates_processed:<3} "
            f"ads={result.ads_fetched:<4} "
            f"winners={result.winners_found:<3} "
            f"in_progress={result.in_progress:<3} "
            f"failed={result.failed:<3}"
        )
    print("-" * 72)
    print(f"Stored {total_winners} Foreplay winner ads in {Path(args.db).resolve()}")
    return 0


def cmd_extract_adplexity(args: argparse.Namespace) -> int:
    db = IntelligenceDatabase(args.db)
    db.initialize()
    try:
        result = extract_adplexity(
            db,
            report_id=args.report_id,
            report_name=args.report_name,
            email=args.email,
            password=args.password,
        )
    finally:
        db.close()

    print("\nAdPlexity extraction summary")
    print("-" * 72)
    print(f"Report       : {result.report_name}")
    print(f"Ads fetched  : {result.ads_fetched}")
    print(f"Enriched     : {result.details_fetched}")
    print(f"Failed       : {result.failed}")
    print(f"Database     : {Path(args.db).resolve()}")
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
            )
        else:
            summary = extract_meta_page(
                db,
                page_id=args.page_id,
                keywords=args.keywords,
                min_days=args.min_days,
                media_type=args.media,
                max_ads=args.max_ads,
            )
    finally:
        db.close()

    print("\nMeta extraction summary")
    print("-" * 72)
    print(f"Mode         : {summary.mode}")
    print(f"Processed    : {summary.processed}")
    print(f"Stored       : {summary.stored}")
    print(f"Failed       : {summary.failed}")
    print(f"Database     : {Path(args.db).resolve()}")
    return 0


def cmd_ads(args: argparse.Namespace) -> int:
    db = IntelligenceDatabase(args.db)
    db.initialize()
    try:
        rows = db.get_ads(
            source=args.source,
            vertical=args.vertical,
            status=args.status,
            brand=args.brand,
            limit=args.limit,
        )
    finally:
        db.close()

    if not rows:
        print("No ads found.")
        return 0

    if args.format == "json":
        print(json.dumps(rows, indent=2, ensure_ascii=False))
        return 0

    if args.format == "csv":
        buffer = io.StringIO()
        writer = csv.DictWriter(
            buffer,
            fieldnames=[
                "id",
                "source",
                "source_id",
                "brand",
                "title",
                "ad_copy",
                "first_seen",
                "last_seen",
                "days_running",
                "status",
                "countries",
                "platforms",
                "cta",
                "video_url",
                "image_url",
                "landing_page_url",
                "ad_library_url",
                "vertical",
                "fetched_at",
            ],
            extrasaction="ignore",
        )
        writer.writeheader()
        for row in rows:
            item = dict(row)
            item["countries"] = ", ".join(row.get("countries") or [])
            item["platforms"] = ", ".join(row.get("platforms") or [])
            writer.writerow(item)
        print(buffer.getvalue())
        return 0

    print(
        f"{'Source':<11} {'Brand':<24} {'Vertical':<18} "
        f"{'Status':<9} {'Days':<6} {'Platforms':<24}"
    )
    print("-" * 98)
    for row in rows:
        print(
            f"{row['source']:<11} "
            f"{truncate(row['display_brand'], 24):<24} "
            f"{truncate(row['display_vertical'], 18):<18} "
            f"{row['status']:<9} "
            f"{str(row['days_running'] if row['days_running'] is not None else 'n/a'):<6} "
            f"{truncate(', '.join(row.get('platforms') or []) or 'unknown', 24):<24}"
        )
        print(f"  Title : {row['title'] or 'Untitled Creative'}")
        print(f"  Copy  : {truncate(row['ad_copy'] or 'No ad copy captured.', 140)}")
        if row.get("landing_page_url"):
            print(f"  Link  : {row['landing_page_url']}")
        if row.get("ad_library_url"):
            print(f"  Ads   : {row['ad_library_url']}")
        print()
    print(f"Total: {len(rows)}")
    return 0


def cmd_classify(args: argparse.Namespace) -> int:
    summary = classify_ads(
        db_path=args.db,
        force=args.force,
        limit=args.limit,
        dry_run=args.dry_run,
    )
    print(
        f"Scanned {summary.scanned} ads | "
        f"classified {summary.classified} | "
        f"still unclassified {summary.still_unclassified}"
    )
    return 0


def cmd_dashboard(args: argparse.Namespace) -> int:
    out = build_dashboard(db_path=args.db, out_path=args.out)
    print(f"Dashboard written to {out.resolve()}")
    if args.serve:
        serve_dashboard(
            out,
            db_path=args.db,
            settings_path=args.settings,
            port=args.port,
        )
    return 0


def truncate(value: str, limit: int) -> str:
    text = value or ""
    return text if len(text) <= limit else text[: limit - 1] + "…"


def truncate(value: str, limit: int) -> str:
    text = value or ""
    return text if len(text) <= limit else text[: max(limit - 3, 0)] + "..."


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Unified competitive intelligence platform")
    parser.add_argument("--db", default=str(DEFAULT_DB_PATH), help="Unified intelligence DB path")
    sub = parser.add_subparsers(dest="command", required=True)

    extract = sub.add_parser("extract", help="Run one of the source extractors")
    extract_sub = extract.add_subparsers(dest="source_name", required=True)

    foreplay = extract_sub.add_parser("foreplay", help="Extract winner ads from Foreplay Spyder")
    foreplay.add_argument("--brand-ids", nargs="+", required=True, help="Foreplay brand IDs")
    foreplay.add_argument("--months", type=int, default=3, help="Lookback window in months")
    foreplay.add_argument("--email", default=FOREPLAY_EMAIL, help="Foreplay account email")
    foreplay.add_argument("--password", default=FOREPLAY_PASSWORD, help="Foreplay account password")
    foreplay.set_defaults(func=cmd_extract_foreplay)

    adplexity = extract_sub.add_parser("adplexity", help="Extract ads from a saved AdPlexity report")
    adplexity.add_argument("--report-id", type=int, required=True, help="AdPlexity report ID")
    adplexity.add_argument("--report-name", default=None, help="Optional human-readable report name")
    adplexity.add_argument("--email", default=ADPLEXITY_EMAIL, help="AdPlexity account email")
    adplexity.add_argument("--password", default=ADPLEXITY_PASSWORD, help="AdPlexity account password")
    adplexity.set_defaults(func=cmd_extract_adplexity)

    meta = extract_sub.add_parser("meta", help="Extract ads from Meta Ads Library")
    mode_group = meta.add_mutually_exclusive_group(required=True)
    mode_group.add_argument("--page-id", help="Single Meta advertiser page ID")
    mode_group.add_argument("--batch", action="store_true", help="Scrape all advertisers from the Meta source DB")
    meta.add_argument("--keywords", default="", help="Optional keyword query for single page mode")
    meta.add_argument("--vertical-filter", default="", help="Vertical filter when using --batch")
    meta.add_argument("--min-days", type=int, default=30, help="Minimum running days")
    meta.add_argument("--media", choices=["image", "video", "both"], default="both", help="Media type filter")
    meta.add_argument("--max-ads", type=int, default=50, help="Maximum ads to collect per advertiser")
    meta.add_argument(
        "--advertisers-db",
        default=str(META_ADVERTISERS_DB),
        help="Path to the existing Meta advertisers database for --batch mode",
    )
    meta.set_defaults(func=cmd_extract_meta)

    ads = sub.add_parser("ads", help="Browse normalized ads in the unified DB")
    ads.add_argument("--source", default="all", choices=["all", "foreplay", "adplexity", "meta"])
    ads.add_argument("--vertical", default="all", help="Filter by vertical or use 'unclassified'")
    ads.add_argument("--status", default="all", choices=["all", "active", "inactive"])
    ads.add_argument("--brand", default=None, help="Case-insensitive brand filter")
    ads.add_argument("--limit", type=int, default=None, help="Optional row limit")
    ads.add_argument("--format", default="table", choices=["table", "json", "csv"])
    ads.set_defaults(func=cmd_ads)

    classify = sub.add_parser("classify", help="Run the keyword-based vertical classifier")
    classify.add_argument("--force", action="store_true", help="Reclassify all ads instead of only blank verticals")
    classify.add_argument("--limit", type=int, default=None, help="Optional row limit")
    classify.add_argument("--dry-run", action="store_true", help="Preview matches without saving")
    classify.set_defaults(func=cmd_classify)

    dashboard = sub.add_parser("dashboard", help="Generate the HTML dashboard")
    dashboard.add_argument("--out", default=str(DEFAULT_DASHBOARD_PATH), help="Output HTML path")
    dashboard.add_argument("--serve", action="store_true", help="Serve the generated dashboard locally")
    dashboard.add_argument("--port", type=int, default=8050, help="Port for --serve mode")
    dashboard.add_argument(
        "--settings",
        default=str(DEFAULT_DASHBOARD_SETTINGS_PATH),
        help="Dashboard settings JSON used in app mode",
    )
    dashboard.set_defaults(func=cmd_dashboard)

    return parser


def main(argv: Iterable[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(list(argv) if argv is not None else None)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
