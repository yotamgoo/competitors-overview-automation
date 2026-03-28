"""CLI entry point for the Foreplay Spyder Winners Extractor."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

try:  # pragma: no cover - supports both package and script execution
    from .api_client import ForeplayClient
    from .extractor import WinnerExtractor
    from .models import Database
except ImportError:  # pragma: no cover
    from api_client import ForeplayClient
    from extractor import WinnerExtractor
    from models import Database


def cmd_extract(args: argparse.Namespace) -> None:
    """Fetch ads and identify winners for the given brand IDs."""
    brand_ids = _collect_brand_ids(args)
    if not brand_ids:
        print("No brand IDs provided. Use --brand-ids or --brand-ids-file.")
        sys.exit(1)

    db = Database(args.db)
    db.initialize()
    client = _make_client(args)

    # Resolve names — for now, brand_ids are passed as (id, id) pairs
    # If user wants name resolution, use the 'brands' sub-command first
    brands = [(bid, bid) for bid in brand_ids]

    extractor = WinnerExtractor(client, db)

    if args.browser:
        _extract_browser(brands, db, args)
    else:
        results = extractor.extract_brands(brands, lookback_months=args.months)
        print("\n=== Summary ===")
        total_winners = 0
        for r in results:
            print(
                f"  {r.brand_name}: {r.ads_fetched} ads, "
                f"{r.winners_found} winners, "
                f"{r.in_progress} in-progress, "
                f"{r.failed} failed"
            )
            total_winners += r.winners_found
        print(f"\nTotal winners found: {total_winners}")

    client.close()
    db.close()


def _extract_browser(
    brands: list[tuple[str, str]],
    db: Database,
    args: argparse.Namespace,
) -> None:
    """Fallback extraction via Selenium browser network capture."""
    from browser_fallback import BrowserExtractor
    from config import get_lookback_start
    from collections import defaultdict

    email = args.email or input("Foreplay email: ")
    password = args.password or input("Foreplay password: ")

    browser = BrowserExtractor(email, password)
    browser.start()
    browser.login()

    for brand_id, brand_name in brands:
        print(f"\n=== {brand_name} (browser mode) ===")
        db.upsert_brand(brand_id, brand_name)

        ads = list(browser.iter_ads_for_brand(brand_id, args.months))
        print(f"  {len(ads)} ads captured")
        db.bulk_upsert_ads(ads)

        # Same winner logic as direct extractor
        groups: dict[str, list[dict]] = defaultdict(list)
        for ad in ads:
            cid = ad.get("collationId")
            count = ad.get("collationCount", 1)
            if cid and count and count >= 2:
                groups[cid].append(ad)

        winners = 0
        for collation_id, test_ads in groups.items():
            live_ads = [a for a in test_ads if a.get("live")]
            total = max((a.get("collationCount", 0) for a in test_ads), default=len(test_ads))
            if len(live_ads) == 1:
                db.upsert_winner(collation_id, brand_id, live_ads[0]["id"], total)
                winners += 1

        print(f"  {winners} winners found")

    browser.close()


def cmd_winners(args: argparse.Namespace) -> None:
    """Display extracted winners."""
    db = Database(args.db)
    db.initialize()
    winners = db.get_winners(brand_id=args.brand_id)

    if not winners:
        print("No winners found.")
        db.close()
        return

    fmt = args.format
    if fmt == "json":
        print(json.dumps(winners, indent=2, default=str))
    elif fmt == "csv":
        import csv, io

        # Define column order matching the requested fields
        fields = [
            "brand", "ad_id", "title", "ad_copy", "first_seen_date", "last_seen_date",
            "days_running", "duplicates", "winner", "status", "publisher_platform",
            "cta_text", "cta_type", "ad_library_url", "landing_page_url",
            "product_category", "format", "media_url", "video_url", "thumbnail_url",
        ]
        buf = io.StringIO()
        writer = csv.DictWriter(buf, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(winners)
        print(buf.getvalue())
    else:
        # table format — one winner per block
        sep = "-" * 80
        for w in winners:
            print(sep)
            print(f"  Brand          : {w['brand']}")
            print(f"  Ad ID          : {w['ad_id']}")
            print(f"  Title          : {w['title'] or ''}")
            print(f"  Ad Copy        : {(w['ad_copy'] or '')[:120]}")
            print(f"  First Seen     : {w['first_seen_date']}")
            print(f"  Last Seen      : {w['last_seen_date']}")
            print(f"  Days Running   : {w['days_running']}")
            print(f"  Duplicates     : {w['duplicates']}")
            print(f"  Winner         : Yes")
            print(f"  Status         : {w['status']}")
            print(f"  Platform       : {w['publisher_platform']}")
            print(f"  CTA            : {w['cta_text'] or w['cta_type'] or ''}")
            print(f"  Ad Library URL : {w['ad_library_url']}")
            print(f"  Landing Page   : {w['landing_page_url']}")
            print(f"  Product Cat.   : {w['product_category']}")
            print(f"  Format         : {w['format']}")
            print(f"  Media URL      : {w['media_url']}")
        print(sep)

    print(f"\nTotal: {len(winners)} winners")
    db.close()


def cmd_enrich(args: argparse.Namespace) -> None:
    """Re-fetch card images for DCO winner ads via their collation endpoint."""
    db = Database(args.db)
    db.initialize()
    client = _make_client(args)

    sql = """
        SELECT a.id, a.ad_id, a.collation_id, a.display_format,
               a.started_running, w.brand_id, b.name
        FROM winners w
        JOIN ads a ON w.winner_ad_id = a.id
        JOIN brands b ON w.brand_id = b.id
        WHERE a.video_url IS NULL AND a.display_format = 'DCO'
    """
    params: list = []
    if args.brand_id:
        sql += " AND w.brand_id=?"
        params.append(args.brand_id)

    rows = db.conn.execute(sql, params).fetchall()
    if not rows:
        print("No DCO winners without video found.")
        client.close()
        db.close()
        return

    enriched = 0
    for doc_id, ad_id, collation_id, fmt, started_running, brand_id, brand_name in rows:
        print(f"  [enrich] {brand_name} ad_id={ad_id}")
        url = client.get_dco_thumbnail(
            brand_id,
            collation_id=collation_id,
            fb_ad_id=ad_id,
            started_running=started_running,
        )
        if url:
            db.update_ad_thumbnail(doc_id, url)
            print(f"    -> {url[:80]}")
            enriched += 1
        else:
            print(f"    -> no card image found")

    print(f"\nEnriched {enriched}/{len(rows)} DCO ads.")
    client.close()
    db.close()


def cmd_brands(args: argparse.Namespace) -> None:
    """Search for brand IDs on Foreplay."""
    client = _make_client(args)
    search = (args.search or "").lower()

    print(f"Searching brands for '{search}'...")
    found = 0
    for brand in client.iter_brands():
        name = brand.get("name", "")
        if search and search not in name.lower():
            continue
        bid = brand.get("id", "")
        print(f"  {name:<40} ID: {bid}")
        found += 1
        if found >= 20:
            print("  ... (showing first 20 matches)")
            break

    if found == 0:
        print("  No brands found.")
    client.close()


def _make_client(args: argparse.Namespace) -> ForeplayClient:
    email = args.email
    password = args.password
    if not args.token and not email:
        email = input("Foreplay email: ")
    if not args.token and not password:
        password = input("Foreplay password: ")
    return ForeplayClient(email=email, password=password, token=args.token)


def _collect_brand_ids(args: argparse.Namespace) -> list[str]:
    ids = list(args.brand_ids or [])
    if args.brand_ids_file:
        p = Path(args.brand_ids_file)
        if p.exists():
            ids.extend(line.strip() for line in p.read_text().splitlines() if line.strip())
        else:
            print(f"Warning: file not found: {p}")
    return ids


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Foreplay Spyder Winners Extractor"
    )
    parser.add_argument("--db", default="winners.db", help="SQLite database path")
    parser.add_argument("--token", default=None, help="Bearer token (direct)")
    parser.add_argument("--email", default=None, help="Foreplay account email")
    parser.add_argument("--password", default=None, help="Foreplay account password")
    sub = parser.add_subparsers(dest="command")

    # extract
    p_extract = sub.add_parser("extract", help="Fetch ads and identify winners")
    p_extract.add_argument("--brand-ids", nargs="+", default=[], help="Foreplay brand IDs")
    p_extract.add_argument("--brand-ids-file", help="File with one brand ID per line")
    p_extract.add_argument("--months", type=int, default=3, help="Lookback months (default: 3)")
    p_extract.add_argument("--browser", action="store_true", help="Use Selenium browser fallback")

    # winners
    p_winners = sub.add_parser("winners", help="Display extracted winners")
    p_winners.add_argument("--brand-id", help="Filter by brand ID")
    p_winners.add_argument("--format", choices=["table", "csv", "json"], default="table")

    # brands
    p_brands = sub.add_parser("brands", help="Search for brand IDs")
    p_brands.add_argument("--search", help="Brand name to search")

    # enrich
    p_enrich = sub.add_parser("enrich", help="Fetch DCO images for winners with no thumbnail")
    p_enrich.add_argument("--brand-id", help="Limit to one brand")

    args = parser.parse_args()

    if args.command == "extract":
        cmd_extract(args)
    elif args.command == "winners":
        cmd_winners(args)
    elif args.command == "brands":
        cmd_brands(args)
    elif args.command == "enrich":
        cmd_enrich(args)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
