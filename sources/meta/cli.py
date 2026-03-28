import argparse
import sys

try:  # pragma: no cover - supports both package and script execution
    from .database import (
        get_ads,
        get_all_advertisers,
        get_db,
        init_db,
        seed_advertisers_from_csv,
        upsert_advertiser,
    )
    from .workflow import batch_scrape, scrape_and_store
except ImportError:  # pragma: no cover
    from database import (
        get_db,
        init_db,
        get_ads,
        get_all_advertisers,
        seed_advertisers_from_csv,
        upsert_advertiser,
    )
    from workflow import batch_scrape, scrape_and_store


def cmd_scrape(args):
    scrape_and_store(
        page_id=args.page_id,
        keywords=args.keywords or "",
        min_days=args.min_days,
        media_type=args.media,
        max_ads=args.max_ads,
        db_path=args.db,
    )


def cmd_batch(args):
    batch_scrape(
        db_path=args.db,
        vertical=args.vertical or None,
        min_days=args.min_days,
        media_type=args.media,
        max_ads=args.max_ads,
    )


def cmd_seed(args):
    conn = get_db(args.db)
    init_db(conn)
    count = seed_advertisers_from_csv(conn, args.file)
    conn.close()
    print(f"Seeded {count} advertisers.")


def cmd_add_advertiser(args):
    conn = get_db(args.db)
    init_db(conn)
    upsert_advertiser(conn, args.name, args.page_id, args.vertical)
    conn.close()
    print(f"Added advertiser: {args.name} (page_id={args.page_id})")


def cmd_list(args):
    conn = get_db(args.db)
    init_db(conn)

    if args.what == "advertisers":
        rows = get_all_advertisers(conn, vertical=args.vertical or None)
        if not rows:
            print("No advertisers found.")
            return
        print(f"{'Name':<40} {'Page ID':<20} {'Vertical':<15}")
        print("-" * 75)
        for r in rows:
            print(f"{r['name']:<40} {r['page_id']:<20} {r['vertical']:<15}")
        print(f"\nTotal: {len(rows)}")

    else:
        ads = get_ads(
            conn,
            source=args.source or None,
            min_running_days=args.min_days,
        )
        if not ads:
            print("No ads found.")
            return
        print(f"{'Source':<10} {'Advertiser':<30} {'Days':<6} {'Type':<7} {'Source ID':<20}")
        print("-" * 73)
        for a in ads:
            print(
                f"{a['source']:<10} {a['advertiser_name'][:29]:<30} "
                f"{a['running_days']:<6} {a['media_type']:<7} {a['source_id']:<20}"
            )
        print(f"\nTotal: {len(ads)}")

    conn.close()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Meta Ads Library Scraper")
    sub = parser.add_subparsers(dest="command", required=True)

    # scrape
    p = sub.add_parser("scrape", help="Scrape ads for one advertiser by page_id")
    p.add_argument("--page-id", required=True, help="Meta page ID")
    p.add_argument("--keywords", default="", help="Optional search keywords")
    p.add_argument("--min-days", type=int, default=30, help="Min running days (default: 30)")
    p.add_argument("--media", choices=["image", "video", "both"], default="both")
    p.add_argument("--max-ads", type=int, default=50, help="Max ads to collect (default: 50)")
    p.add_argument("--db", default="ads.db", help="Database path (default: ads.db)")

    # batch
    p = sub.add_parser("batch", help="Scrape all advertisers in the database")
    p.add_argument("--vertical", default="", help="Filter by vertical")
    p.add_argument("--min-days", type=int, default=30)
    p.add_argument("--media", choices=["image", "video", "both"], default="both")
    p.add_argument("--max-ads", type=int, default=50)
    p.add_argument("--db", default="ads.db")

    # seed
    p = sub.add_parser("seed", help="Bulk load advertisers from CSV")
    p.add_argument("--file", required=True, help="CSV file (columns: name, page_id, vertical)")
    p.add_argument("--db", default="ads.db")

    # add-advertiser
    p = sub.add_parser("add-advertiser", help="Add a single advertiser")
    p.add_argument("--name", required=True)
    p.add_argument("--page-id", required=True)
    p.add_argument("--vertical", default="")
    p.add_argument("--db", default="ads.db")

    # list
    p = sub.add_parser("list", help="List ads or advertisers from the database")
    p.add_argument("what", choices=["ads", "advertisers"], help="What to list")
    p.add_argument("--source", default="", help="Filter by source (ads only)")
    p.add_argument("--vertical", default="", help="Filter by vertical (advertisers only)")
    p.add_argument("--min-days", type=int, default=0, help="Min running days (ads only)")
    p.add_argument("--db", default="ads.db")

    return parser


COMMANDS = {
    "scrape": cmd_scrape,
    "batch": cmd_batch,
    "seed": cmd_seed,
    "add-advertiser": cmd_add_advertiser,
    "list": cmd_list,
}


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    try:
        COMMANDS[args.command](args)
        return 0
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
