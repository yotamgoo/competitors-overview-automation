"""SQLite database layer for the Foreplay Winners Extractor."""

from __future__ import annotations

import html
import json
import re
import sqlite3
import time
from pathlib import Path
from typing import Any


class Database:
    def __init__(self, path: str | Path = "winners.db"):
        self.path = Path(path)
        self.conn = sqlite3.connect(str(self.path))
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA foreign_keys=ON")

    def initialize(self) -> None:
        self.conn.executescript("""
            CREATE TABLE IF NOT EXISTS brands (
                id          TEXT PRIMARY KEY,
                name        TEXT NOT NULL,
                fetched_at  INTEGER
            );

            CREATE TABLE IF NOT EXISTS ads (
                id                  TEXT PRIMARY KEY,
                ad_id               INTEGER,
                brand_id            TEXT REFERENCES brands(id),
                collation_id        TEXT,
                collation_count     INTEGER,
                live                INTEGER,
                started_running     INTEGER,
                end_date            INTEGER,
                name                TEXT,
                headline            TEXT,
                description         TEXT,
                link_url            TEXT,
                display_format      TEXT,
                video_url           TEXT,
                thumbnail_url       TEXT,
                cta_text            TEXT,
                cta_type            TEXT,
                video_duration      REAL,
                same_creative_count INTEGER,
                product_category    TEXT,
                publisher_platform  TEXT,
                categories          TEXT,
                fetched_at          INTEGER
            );

            CREATE INDEX IF NOT EXISTS idx_ads_brand     ON ads(brand_id);
            CREATE INDEX IF NOT EXISTS idx_ads_collation ON ads(collation_id);

            CREATE TABLE IF NOT EXISTS winners (
                collation_id        TEXT PRIMARY KEY,
                brand_id            TEXT REFERENCES brands(id),
                winner_ad_id        TEXT REFERENCES ads(id),
                total_ads_in_test   INTEGER,
                analyzed_at         INTEGER
            );

            CREATE TABLE IF NOT EXISTS extraction_runs (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                brand_id        TEXT,
                started_at      INTEGER,
                completed_at    INTEGER,
                ads_fetched     INTEGER DEFAULT 0,
                winners_found   INTEGER DEFAULT 0,
                status          TEXT DEFAULT 'running'
            );
        """)
        self.conn.commit()

    # ── brands ──────────────────────────────────────────────────────

    def upsert_brand(self, brand_id: str, name: str) -> None:
        self.conn.execute(
            "INSERT INTO brands (id, name, fetched_at) VALUES (?, ?, ?)"
            " ON CONFLICT(id) DO UPDATE SET name=excluded.name, fetched_at=excluded.fetched_at",
            (brand_id, name, _now_ms()),
        )
        self.conn.commit()

    # ── ads ─────────────────────────────────────────────────────────

    def upsert_ad(self, ad: dict[str, Any]) -> None:
        cards = ad.get("cards") or []
        first_card = cards[0] if cards else {}

        # media: prefer cards video/thumbnail/image, fall back to top-level image, then avatar
        # DCO cards use "image" instead of "thumbnail"
        video_url = first_card.get("video") or None
        thumbnail_url = (
            first_card.get("thumbnail")
            or first_card.get("image")
            or ad.get("image")
            or ad.get("avatar")
            or None
        )

        # clean HTML entities from description
        raw_desc = ad.get("description") or first_card.get("description") or ""
        description = _clean_html(raw_desc)

        # cta: prefer card-level text, then top-level type/title
        cta_text = first_card.get("cta_text") or ad.get("cta_title") or None

        # publisher_platform can be list or string
        platform = ad.get("publisher_platform")
        publisher_platform = json.dumps(platform) if isinstance(platform, list) else platform

        self.conn.execute(
            """INSERT INTO ads
               (id, ad_id, brand_id, collation_id, collation_count, live,
                started_running, end_date, name, headline, description, link_url,
                display_format, video_url, thumbnail_url, cta_text, cta_type,
                video_duration, same_creative_count, product_category,
                publisher_platform, categories, fetched_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(id) DO UPDATE SET
                 live=excluded.live,
                 end_date=excluded.end_date,
                 collation_count=excluded.collation_count,
                 same_creative_count=excluded.same_creative_count,
                 fetched_at=excluded.fetched_at""",
            (
                ad["id"],
                ad.get("ad_id"),
                ad.get("brandId"),
                ad.get("collationId"),
                ad.get("collationCount"),
                1 if ad.get("live") else 0,
                ad.get("startedRunning"),
                ad.get("end_date"),
                ad.get("name"),
                ad.get("headline"),
                description,
                ad.get("link_url"),
                ad.get("display_format"),
                video_url,
                thumbnail_url,
                cta_text,
                ad.get("cta_type"),
                first_card.get("video_duration"),
                ad.get("sameCreativeCount"),
                ad.get("productCategory"),
                publisher_platform,
                json.dumps(ad.get("categories", [])),
                _now_ms(),
            ),
        )

    def bulk_upsert_ads(self, ads: list[dict[str, Any]]) -> None:
        for ad in ads:
            self.upsert_ad(ad)
        self.conn.commit()

    # ── winners ─────────────────────────────────────────────────────

    def upsert_winner(
        self,
        collation_id: str,
        brand_id: str,
        winner_ad_id: str,
        total_ads: int,
    ) -> None:
        self.conn.execute(
            """INSERT INTO winners (collation_id, brand_id, winner_ad_id, total_ads_in_test, analyzed_at)
               VALUES (?,?,?,?,?)
               ON CONFLICT(collation_id) DO UPDATE SET
                 winner_ad_id=excluded.winner_ad_id,
                 total_ads_in_test=excluded.total_ads_in_test,
                 analyzed_at=excluded.analyzed_at""",
            (collation_id, brand_id, winner_ad_id, total_ads, _now_ms()),
        )
        self.conn.commit()

    def get_winners(self, brand_id: str | None = None) -> list[dict]:
        sql = """
            SELECT
                b.name                  AS brand,
                a.ad_id,
                a.headline              AS title,
                a.description           AS ad_copy,
                a.started_running       AS first_seen,
                a.end_date              AS last_seen,
                a.live,
                a.display_format        AS format,
                a.video_url,
                a.thumbnail_url,
                a.cta_text,
                a.cta_type,
                a.link_url              AS landing_page_url,
                a.product_category,
                a.same_creative_count   AS duplicates,
                a.publisher_platform,
                w.total_ads_in_test
            FROM winners w
            JOIN ads a ON w.winner_ad_id = a.id
            JOIN brands b ON w.brand_id = b.id
        """
        params: list = []
        if brand_id:
            sql += " WHERE w.brand_id = ?"
            params.append(brand_id)
        sql += " ORDER BY a.started_running DESC"
        rows = self.conn.execute(sql, params).fetchall()

        results = []
        now_ms = _now_ms()
        for r in rows:
            d = dict(r)
            # computed fields
            first = d.get("first_seen") or 0
            last = d.get("last_seen") or (now_ms if d["live"] else 0)
            d["days_running"] = round((last - first) / 86_400_000) if first else None
            d["status"] = "Running" if d["live"] else "Ended"
            d["winner"] = "Yes"
            d["ad_library_url"] = f"https://www.facebook.com/ads/library/?id={d['ad_id']}" if d.get("ad_id") else None
            # media url: video takes priority
            d["media_url"] = d.get("video_url") or d.get("thumbnail_url")
            # format timestamps as readable dates
            d["first_seen_date"] = _ms_to_date(first)
            d["last_seen_date"] = _ms_to_date(last) if last else None
            results.append(d)
        return results

    # ── extraction runs ─────────────────────────────────────────────

    def start_run(self, brand_id: str) -> int:
        cur = self.conn.execute(
            "INSERT INTO extraction_runs (brand_id, started_at, status) VALUES (?,?,?)",
            (brand_id, _now_ms(), "running"),
        )
        self.conn.commit()
        return cur.lastrowid  # type: ignore[return-value]

    def end_run(self, run_id: int, ads_fetched: int, winners_found: int, status: str = "completed") -> None:
        self.conn.execute(
            "UPDATE extraction_runs SET completed_at=?, ads_fetched=?, winners_found=?, status=? WHERE id=?",
            (_now_ms(), ads_fetched, winners_found, status, run_id),
        )
        self.conn.commit()

    def update_ad_thumbnail(self, doc_id: str, thumbnail_url: str) -> None:
        """Overwrite the thumbnail_url for an ad (used for DCO enrichment)."""
        self.conn.execute(
            "UPDATE ads SET thumbnail_url=? WHERE id=?",
            (thumbnail_url, doc_id),
        )
        self.conn.commit()

    def close(self) -> None:
        self.conn.close()


# ── helpers ──────────────────────────────────────────────────────────

def _now_ms() -> int:
    return int(time.time() * 1000)


def _ms_to_date(ts_ms: int) -> str | None:
    if not ts_ms:
        return None
    from datetime import datetime, timezone
    return datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d")


def _clean_html(text: str) -> str:
    """Decode HTML entities and strip tags."""
    text = html.unescape(text)
    text = re.sub(r"<[^>]+>", " ", text)
    return " ".join(text.split())
