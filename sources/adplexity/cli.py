"""CLI entry point for the AdPlexity Extractor."""

from __future__ import annotations

import argparse
import io
import json
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

try:  # pragma: no cover - supports both package and script execution
    from .api_client import AdplexityClient
    from .extractor import AdplexityExtractor
    from .models import Database
except ImportError:  # pragma: no cover
    from api_client import AdplexityClient
    from extractor import AdplexityExtractor
    from models import Database


def cmd_extract(args: argparse.Namespace) -> None:
    """Fetch ads from a saved AdPlexity report and enrich with detail."""
    client = _make_client(args)
    db = Database(args.db)
    db.initialize()
    extractor = AdplexityExtractor(client, db)

    report_id = args.report_id
    report_name = args.report_name or str(report_id)

    result = extractor.extract_report(report_id, report_name)
    print(f"\nDone: {result.ads_fetched} ads, {result.details_fetched} enriched, {result.failed} failed")

    client.close()
    db.close()


def cmd_reports(args: argparse.Namespace) -> None:
    """List all saved reports on the account."""
    client = _make_client(args)
    reports = client.list_reports()
    if not reports:
        print("No reports found.")
    for r in reports:
        print(f"  ID: {r.get('id'):<8}  {r.get('name')}")
    client.close()


def cmd_ads(args: argparse.Namespace) -> None:
    """Display extracted ads from the local DB."""
    db = Database(args.db)
    db.initialize()
    ads = db.get_ads(report_id=args.report_id)

    if not ads:
        print("No ads found.")
        db.close()
        return

    fmt = args.format
    if fmt == "json":
        print(json.dumps(ads, indent=2, default=str))
    elif fmt == "csv":
        import csv
        fields = [
            "id", "report_id", "title", "ad_copy", "first_seen", "last_seen",
            "days_running", "status", "countries", "platforms", "meta_ad_id",
            "cta_type", "keyword", "video_url", "thumb_url",
            "ad_url", "landing_page_url",
        ]
        buf = io.StringIO()
        writer = csv.DictWriter(buf, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(ads)
        print(buf.getvalue())
    else:
        sep = "-" * 80
        for a in ads:
            print(sep)
            print(f"  AdPlexity ID   : {a['id']}")
            print(f"  Meta Ad ID     : {a.get('meta_ad_id') or '—'}")
            print(f"  Title          : {a.get('title') or '—'}")
            print(f"  Ad Copy        : {(a.get('ad_copy') or '')[:120]}")
            print(f"  First Seen     : {a.get('first_seen') or '—'}")
            print(f"  Last Seen      : {a.get('last_seen') or '—'}")
            print(f"  Days Running   : {a.get('days_running') or '—'}")
            print(f"  Status         : {a.get('status') or '—'}")
            print(f"  Countries      : {a.get('countries') or '—'}")
            print(f"  Platforms      : {a.get('platforms') or '—'}")
            print(f"  CTA            : {a.get('cta_type') or '—'}")
            print(f"  Keyword        : {a.get('keyword') or '—'}")
            print(f"  Video URL      : {a.get('video_url') or '—'}")
            print(f"  Thumb URL      : {a.get('thumb_url') or '—'}")
            print(f"  Ad URL         : {a.get('ad_url') or '—'}")
            print(f"  Landing Page   : {a.get('landing_page_url') or '—'}")
        print(sep)
    print(f"\nTotal: {len(ads)} ads")
    db.close()


def _make_client(args: argparse.Namespace) -> AdplexityClient:
    email = args.email or input("AdPlexity email: ")
    password = args.password or input("AdPlexity password: ")
    return AdplexityClient(email=email, password=password)


def main() -> None:
    parser = argparse.ArgumentParser(description="AdPlexity Extractor")
    parser.add_argument("--db", default="adplexity.db", help="SQLite database path")
    parser.add_argument("--email", default=None, help="AdPlexity account email")
    parser.add_argument("--password", default=None, help="AdPlexity account password")
    sub = parser.add_subparsers(dest="command")

    # reports
    sub.add_parser("reports", help="List saved reports on the account")

    # extract
    p_extract = sub.add_parser("extract", help="Fetch and enrich ads from a report")
    p_extract.add_argument("--report-id", type=int, required=True, help="AdPlexity report ID")
    p_extract.add_argument("--report-name", default=None, help="Human-readable report name")

    # ads
    p_ads = sub.add_parser("ads", help="Display extracted ads from local DB")
    p_ads.add_argument("--report-id", type=int, default=None, help="Filter by report ID")
    p_ads.add_argument("--format", choices=["table", "csv", "json"], default="table")

    args = parser.parse_args()
    if args.command == "reports":
        cmd_reports(args)
    elif args.command == "extract":
        cmd_extract(args)
    elif args.command == "ads":
        cmd_ads(args)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
