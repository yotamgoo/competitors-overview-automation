from dataclasses import asdict
from pathlib import Path
from typing import Callable, Dict, List, Optional

try:  # pragma: no cover - supports both package and script execution
    from .database import (
        get_db,
        get_advertiser_by_page_id,
        get_all_advertisers,
        init_db,
        upsert_ads_batch,
    )
    from .research_pipeline import AdRecord, scrape_ads
except ImportError:  # pragma: no cover
    from database import get_db, init_db, get_advertiser_by_page_id, get_all_advertisers, upsert_ads_batch
    from research_pipeline import scrape_ads, AdRecord


def _record_to_db_dict(record: AdRecord, advertiser: Optional[dict]) -> dict:
    return {
        "source": "meta",
        "source_id": record.library_id,
        "advertiser_id": advertiser["id"] if advertiser else None,
        "advertiser_name": record.advertiser,
        "headline": record.headline,
        "ad_copy": record.ad_copy,
        "cta": record.cta,
        "media_type": record.media_type,
        "media_path": record.media_path,
        "ad_link": record.ad_link,
        "landing_url": record.landing_url,
        "landing_domain": record.landing_domain,
        "platforms": record.platforms,
        "categories": record.categories,
        "started_running_date": record.started_running_date,
        "running_days": record.running_days,
        "search_term": record.search_term,
        "scraped_at": record.scraped_at,
    }


def scrape_and_store(
    page_id: str,
    keywords: str = "",
    min_days: int = 30,
    media_type: str = "both",
    max_ads: int = 50,
    download_media_files: bool = False,
    db_path: str = "ads.db",
    base_dir: Path = None,
    log: Callable[[str], None] = print,
) -> Dict[str, int]:
    if base_dir is None:
        base_dir = Path.cwd()

    conn = get_db(db_path)
    init_db(conn)

    advertiser = get_advertiser_by_page_id(conn, page_id)
    search_query = keywords

    log(f"Scraping page_id={page_id} keywords={keywords!r} min_days={min_days}")
    records = scrape_ads(
        search_query=search_query,
        running_duration_days=min_days,
        media_type_filter=media_type,
        number_of_ads=max_ads,
        base_dir=base_dir,
        log=log,
        page_id=page_id,
        download_media_files=download_media_files,
    )

    ads = [_record_to_db_dict(r, advertiser) for r in records]
    stored = upsert_ads_batch(conn, ads)
    conn.close()

    log(f"Done: scraped={len(records)} stored={stored}")
    return {"scraped": len(records), "stored": stored}


def batch_scrape(
    db_path: str = "ads.db",
    vertical: Optional[str] = None,
    min_days: int = 30,
    media_type: str = "both",
    max_ads: int = 50,
    download_media_files: bool = False,
    base_dir: Path = None,
    log: Callable[[str], None] = print,
) -> Dict[str, int]:
    if base_dir is None:
        base_dir = Path.cwd()

    conn = get_db(db_path)
    init_db(conn)

    advertisers = get_all_advertisers(conn, vertical=vertical)
    conn.close()

    if not advertisers:
        log("No advertisers found in database.")
        return {"total_scraped": 0, "total_stored": 0, "advertisers": 0}

    log(f"Batch scraping {len(advertisers)} advertisers...")
    total_scraped = 0
    total_stored = 0

    for i, adv in enumerate(advertisers, 1):
        log(f"\n[{i}/{len(advertisers)}] {adv['name']} (page_id={adv['page_id']})")
        try:
            result = scrape_and_store(
                page_id=adv["page_id"],
                min_days=min_days,
                media_type=media_type,
                max_ads=max_ads,
                download_media_files=download_media_files,
                db_path=db_path,
                base_dir=base_dir,
                log=log,
            )
            total_scraped += result["scraped"]
            total_stored += result["stored"]
        except Exception as exc:
            log(f"  Error: {exc}")

    log(f"\nBatch complete: {total_scraped} scraped, {total_stored} stored from {len(advertisers)} advertisers")
    return {
        "total_scraped": total_scraped,
        "total_stored": total_stored,
        "advertisers": len(advertisers),
    }
