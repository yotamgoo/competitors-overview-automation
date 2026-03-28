"""Unified source adapters that write all extractor output into intelligence.db."""

from __future__ import annotations

import html
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable
from urllib.parse import urlparse

from app_config import (
    ADPLEXITY_EMAIL,
    ADPLEXITY_PASSWORD,
    FOREPLAY_EMAIL,
    FOREPLAY_PASSWORD,
    META_ADVERTISERS_DB,
    META_SOURCE_DIR,
)
from intelligence_db import IntelligenceDatabase, NormalizedAd, display_brand_from_url, now_iso
from sources.adplexity.api_client import AdplexityClient
from sources.adplexity.extractor import AdplexityExtractor
from sources.foreplay.api_client import ForeplayClient
from sources.foreplay.extractor import WinnerExtractor
from sources.meta.database import get_all_advertisers, get_db as get_meta_db
from sources.meta.research_pipeline import AdRecord, scrape_ads


LogFn = Callable[..., Any]


@dataclass(slots=True)
class MetaExtractionSummary:
    mode: str
    processed: int
    stored: int
    failed: int = 0


class ForeplayUnifiedBridge:
    """Implements the DB interface WinnerExtractor expects, but writes only winners."""

    def __init__(self, db: IntelligenceDatabase):
        self.db = db
        self._brands: dict[str, str] = {}
        self._ads_by_id: dict[str, dict[str, Any]] = {}
        self._run_counter = 0

    def start_run(self, brand_id: str) -> int:
        self._run_counter += 1
        return self._run_counter

    def end_run(self, run_id: int, ads_fetched: int, winners_found: int, status: str = "completed") -> None:
        return None

    def upsert_brand(self, brand_id: str, name: str) -> None:
        self._brands[brand_id] = name

    def upsert_ad(self, ad: dict[str, Any]) -> None:
        self._ads_by_id[str(ad["id"])] = ad

    def bulk_upsert_ads(self, ads: list[dict[str, Any]]) -> None:
        for ad in ads:
            self.upsert_ad(ad)

    def update_ad_thumbnail(self, doc_id: str, thumbnail_url: str) -> None:
        ad = self._ads_by_id.get(str(doc_id))
        if ad is not None:
            ad["_unified_thumbnail_url"] = thumbnail_url

    def upsert_winner(self, collation_id: str, brand_id: str, winner_ad_id: str, total_ads: int) -> None:
        ad = self._ads_by_id.get(str(winner_ad_id))
        if ad is None:
            raise KeyError(f"Winner ad {winner_ad_id!r} not found in Foreplay bridge cache")
        normalized = normalize_foreplay_winner(ad, self._brands.get(brand_id, brand_id))
        self.db.upsert_ad(normalized)
        self.db.conn.commit()

    def close(self) -> None:
        self._ads_by_id.clear()


class AdplexityUnifiedBridge:
    """Implements the DB interface AdplexityExtractor expects."""

    def __init__(self, db: IntelligenceDatabase):
        self.db = db
        self._reports: dict[int, str] = {}
        self._listings: dict[int, dict[str, Any]] = {}
        self._pending_detail: dict[int, list[int]] = {}
        self._run_counter = 0

    def start_run(self, report_id: int) -> int:
        self._run_counter += 1
        return self._run_counter

    def end_run(self, run_id: int, ads_fetched: int, status: str = "completed") -> None:
        return None

    def upsert_report(self, report_id: int, name: str) -> None:
        self._reports[report_id] = name

    def upsert_ad_from_listing(self, ad: dict[str, Any], report_id: int) -> None:
        adplexity_id = int(ad["id"])
        self._listings[adplexity_id] = ad
        self.db.upsert_ad(normalize_adplexity_listing(ad, report_name=self._reports.get(report_id, "")))

    def bulk_upsert_ads(self, ads: list[dict[str, Any]], report_id: int) -> None:
        ids: list[int] = []
        for ad in ads:
            self.upsert_ad_from_listing(ad, report_id)
            ids.append(int(ad["id"]))
        self._pending_detail[report_id] = ids
        self.db.conn.commit()

    def get_ads_needing_detail(self, report_id: int | None = None) -> list[int]:
        if report_id is not None:
            return list(self._pending_detail.get(report_id, []))
        ids: list[int] = []
        for batch in self._pending_detail.values():
            ids.extend(batch)
        return ids

    def upsert_ad_detail(self, adplexity_id: int, detail: dict[str, Any]) -> None:
        listing = self._listings.get(adplexity_id, {})
        self.db.upsert_ad(normalize_adplexity_detail(adplexity_id, listing, detail))

    def commit_detail(self, adplexity_id: int, detail: dict[str, Any]) -> None:
        self.upsert_ad_detail(adplexity_id, detail)
        for report_id, ids in list(self._pending_detail.items()):
            self._pending_detail[report_id] = [item for item in ids if item != adplexity_id]
        self.db.conn.commit()

    def get_ads(self, report_id: int | None = None) -> list[dict[str, Any]]:
        return self.db.get_ads(source="adplexity")

    def close(self) -> None:
        self._listings.clear()
        self._pending_detail.clear()


def extract_foreplay(
    db: IntelligenceDatabase,
    brand_ids: Iterable[str],
    *,
    months: int = 3,
    email: str | None = None,
    password: str | None = None,
    log: LogFn = print,
) -> list[Any]:
    client = ForeplayClient(
        email=email or FOREPLAY_EMAIL,
        password=password or FOREPLAY_PASSWORD,
        log=log,
    )
    bridge = ForeplayUnifiedBridge(db)
    extractor = WinnerExtractor(client, bridge, log=log)

    try:
        resolved = resolve_foreplay_brands(client, list(brand_ids), log=log)
        results = extractor.extract_brands(resolved, lookback_months=months)
        db.conn.commit()
        return results
    finally:
        bridge.close()
        client.close()


def extract_adplexity(
    db: IntelligenceDatabase,
    report_id: int,
    *,
    report_name: str | None = None,
    email: str | None = None,
    password: str | None = None,
    log: LogFn = print,
) -> Any:
    client = AdplexityClient(
        email=email or ADPLEXITY_EMAIL,
        password=password or ADPLEXITY_PASSWORD,
        log=log,
    )
    bridge = AdplexityUnifiedBridge(db)
    extractor = AdplexityExtractor(client, bridge, log=log)

    try:
        result = extractor.extract_report(report_id=report_id, report_name=report_name or str(report_id))
        db.conn.commit()
        return result
    finally:
        bridge.close()
        client.close()


def extract_meta_page(
    db: IntelligenceDatabase,
    page_id: str,
    *,
    keywords: str = "",
    min_days: int = 30,
    media_type: str = "both",
    max_ads: int = 50,
    base_dir: Path = META_SOURCE_DIR,
    log: LogFn = print,
) -> MetaExtractionSummary:
    records = scrape_ads(
        search_query=keywords,
        running_duration_days=min_days,
        media_type_filter=media_type,
        number_of_ads=max_ads,
        base_dir=base_dir,
        log=log,
        page_id=page_id,
    )
    stored = db.upsert_ads(normalize_meta_record(record, base_dir=base_dir) for record in records)
    return MetaExtractionSummary(mode="page", processed=len(records), stored=stored)


def extract_meta_batch(
    db: IntelligenceDatabase,
    *,
    advertisers_db: str | Path = META_ADVERTISERS_DB,
    vertical: str | None = None,
    min_days: int = 30,
    media_type: str = "both",
    max_ads: int = 50,
    base_dir: Path = META_SOURCE_DIR,
    log: LogFn = print,
) -> MetaExtractionSummary:
    conn = get_meta_db(str(advertisers_db))
    try:
        advertisers = get_all_advertisers(conn, vertical=vertical)
    finally:
        conn.close()

    processed = 0
    stored = 0
    failed = 0
    for index, advertiser in enumerate(advertisers, start=1):
        log(f"[{index}/{len(advertisers)}] Meta page {advertiser['name']} ({advertiser['page_id']})")
        try:
            result = extract_meta_page(
                db,
                advertiser["page_id"],
                keywords="",
                min_days=min_days,
                media_type=media_type,
                max_ads=max_ads,
                base_dir=base_dir,
                log=log,
            )
            processed += result.processed
            stored += result.stored
        except Exception as exc:
            failed += 1
            log(f"  Error: {exc}")
    return MetaExtractionSummary(mode="batch", processed=processed, stored=stored, failed=failed)


def resolve_foreplay_brands(
    client: ForeplayClient,
    brand_ids: list[str],
    *,
    log: LogFn = print,
) -> list[tuple[str, str]]:
    pending = {brand_id for brand_id in brand_ids}
    resolved = {brand_id: brand_id for brand_id in brand_ids}
    if not pending:
        return []

    log("Resolving Foreplay brand names...")
    for brand in client.iter_brands():
        current_id = str(brand.get("id", "")).strip()
        if current_id in pending:
            resolved[current_id] = (brand.get("name") or current_id).strip()
            pending.remove(current_id)
            if not pending:
                break

    if pending:
        log(f"Could not resolve names for {len(pending)} Foreplay brands; falling back to IDs.")
    return [(brand_id, resolved[brand_id]) for brand_id in brand_ids]


def normalize_foreplay_winner(ad: dict[str, Any], brand_name: str) -> NormalizedAd:
    first_card = (ad.get("cards") or [{}])[0]
    description = clean_html_text(ad.get("description") or first_card.get("description") or "")
    image_url = (
        ad.get("_unified_thumbnail_url")
        or first_card.get("thumbnail")
        or first_card.get("image")
        or ad.get("image")
        or ad.get("avatar")
    )
    video_url = first_card.get("video")
    title = (ad.get("headline") or ad.get("name") or "").strip()
    cta = (first_card.get("cta_text") or ad.get("cta_title") or ad.get("cta_type") or "").strip()
    ad_id = ad.get("ad_id")

    return NormalizedAd(
        source="foreplay",
        source_id=str(ad.get("id") or ad_id),
        brand=brand_name,
        title=title,
        ad_copy=description,
        first_seen=ad.get("startedRunning"),
        last_seen=ad.get("end_date"),
        days_running=None,
        status="active" if ad.get("live") else "inactive",
        countries=[],
        platforms=ad.get("publisher_platform"),
        cta=cta,
        video_url=video_url,
        image_url=image_url,
        landing_page_url=ad.get("link_url"),
        ad_library_url=f"https://www.facebook.com/ads/library/?id={ad_id}" if ad_id else None,
        vertical=None,
        fetched_at=now_iso(),
    )


def normalize_adplexity_listing(ad: dict[str, Any], *, report_name: str = "") -> NormalizedAd:
    adplexity_id = int(ad["id"])
    title = (ad.get("title") or ad.get("title_en") or "").strip()
    brand = pick_first_text(
        ad.get("advertiser"),
        ad.get("advertiser_name"),
        ad.get("brand"),
        infer_brand_from_title(title),
        infer_brand_from_url(ad.get("landing_page_url")),
    )
    return NormalizedAd(
        source="adplexity",
        source_id=str(adplexity_id),
        brand=brand,
        title=title,
        ad_copy="",
        first_seen=ad.get("first_seen"),
        last_seen=ad.get("last_seen"),
        days_running=ad.get("days_total") or ad.get("hits_total"),
        status="active" if ad.get("meta_status") == 1 else "inactive",
        countries=ad.get("countries"),
        platforms=[],
        cta="",
        video_url=None,
        image_url=ad.get("thumb_url"),
        landing_page_url=ad.get("landing_page_url"),
        ad_library_url=None,
        vertical=None,
        fetched_at=now_iso(),
    )


def normalize_adplexity_detail(adplexity_id: int, listing: dict[str, Any], detail: dict[str, Any]) -> NormalizedAd:
    ad_data = detail.get("ad") or {}
    meta = ad_data.get("meta") or {}
    videos = detail.get("videos") or meta.get("videos") or []
    video_url = videos[0].get("url") if videos else None
    meta_ad_id = meta.get("ad_id") or listing.get("meta_ad_id")
    landing_page_url = meta.get("url") or listing.get("landing_page_url")
    title = (listing.get("title") or listing.get("title_en") or ad_data.get("title") or "").strip()
    brand = pick_first_text(
        ad_data.get("advertiser"),
        ad_data.get("advertiser_name"),
        meta.get("advertiser"),
        meta.get("advertiser_name"),
        meta.get("brand"),
        listing.get("advertiser"),
        listing.get("advertiser_name"),
        listing.get("brand"),
        infer_brand_from_title(title),
        infer_brand_from_url(landing_page_url),
        display_brand_from_url(landing_page_url),
    )

    return NormalizedAd(
        source="adplexity",
        source_id=str(adplexity_id),
        brand=brand,
        title=title,
        ad_copy=(ad_data.get("description") or ad_data.get("description_en") or "").strip(),
        first_seen=listing.get("first_seen"),
        last_seen=listing.get("last_seen"),
        days_running=listing.get("days_total") or listing.get("hits_total"),
        status="active" if listing.get("meta_status") == 1 else "inactive",
        countries=listing.get("countries"),
        platforms=meta.get("platforms") or [],
        cta=(meta.get("cta_type_name") or meta.get("cta_type") or "").strip(),
        video_url=video_url,
        image_url=listing.get("thumb_url"),
        landing_page_url=landing_page_url,
        ad_library_url=f"https://www.facebook.com/ads/library/?id={meta_ad_id}" if meta_ad_id else None,
        vertical=None,
        fetched_at=now_iso(),
    )


def normalize_meta_record(record: AdRecord, *, base_dir: Path) -> NormalizedAd:
    video_url: str | None = None
    image_url: str | None = None
    media_path = normalize_meta_media_path(record.media_path, base_dir=base_dir)
    if record.media_type == "video":
        video_url = media_path
    elif record.media_type == "image":
        image_url = media_path

    return NormalizedAd(
        source="meta",
        source_id=record.library_id,
        brand=record.advertiser,
        title=record.headline,
        ad_copy=record.ad_copy,
        first_seen=record.started_running_date,
        last_seen=record.scraped_at,
        days_running=record.running_days,
        status="active",
        countries=["US"],
        platforms=record.platforms,
        cta=record.cta,
        video_url=video_url,
        image_url=image_url,
        landing_page_url=record.landing_url,
        ad_library_url=record.ad_link,
        vertical=None,
        fetched_at=now_iso(),
    )


def normalize_meta_media_path(media_path: str, *, base_dir: Path) -> str | None:
    clean = (media_path or "").strip()
    if not clean:
        return None
    path = (base_dir / clean).resolve()
    workspace_root = base_dir.parent.parent.resolve()
    try:
        relative = path.relative_to(workspace_root)
    except ValueError:
        return clean.replace("\\", "/")
    return relative.as_posix()


def clean_html_text(value: str) -> str:
    text = html.unescape(value or "")
    text = re.sub(r"<[^>]+>", " ", text)
    return " ".join(text.split())


def pick_first_text(*values: Any) -> str:
    for value in values:
        text = str(value or "").strip()
        if text and text.lower() not in {"none", "null"}:
            return text
    return ""


def infer_brand_from_title(title: str) -> str:
    text = (title or "").strip()
    if ":" in text:
        candidate = text.split(":")[-1].strip()
        if 1 <= len(candidate.split()) <= 5:
            return candidate
    if "|" in text:
        candidate = text.split("|")[0].strip()
        if 1 <= len(candidate.split()) <= 5:
            return candidate
    return ""


def infer_brand_from_url(url: str | None) -> str:
    if not url:
        return ""
    parsed = urlparse(url)
    host = parsed.netloc.lower()
    if host.startswith("www."):
        host = host[4:]
    if not host:
        return ""
    raw_parts = [part for part in host.split(".") if part]
    if len(raw_parts) >= 2:
        core = raw_parts[-2]
    elif raw_parts:
        core = raw_parts[0]
    else:
        return ""
    if core in {"l", "m", "app", "go", "click"} and len(raw_parts) >= 3:
        core = raw_parts[-3]
    return core.replace("-", " ").replace("_", " ").title()
