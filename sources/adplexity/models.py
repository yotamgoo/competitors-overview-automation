"""SQLite database layer for the AdPlexity Extractor."""

from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path
from typing import Any


class Database:
    def __init__(self, path: str | Path = "adplexity.db"):
        self.path = Path(path)
        self.conn = sqlite3.connect(str(self.path))
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA foreign_keys=ON")

    def initialize(self) -> None:
        self.conn.executescript("""
            CREATE TABLE IF NOT EXISTS reports (
                id          INTEGER PRIMARY KEY,
                name        TEXT NOT NULL,
                fetched_at  INTEGER
            );

            CREATE TABLE IF NOT EXISTS ads (
                id                  INTEGER PRIMARY KEY,   -- AdPlexity internal ID
                report_id           INTEGER REFERENCES reports(id),
                -- from report listing
                title               TEXT,
                thumb_url           TEXT,
                first_seen          TEXT,
                last_seen           TEXT,
                days_running        INTEGER,
                countries           TEXT,                  -- JSON array
                status              TEXT,
                landing_page_url    TEXT,
                ad_url              TEXT,                  -- https://app.adplexity.io/ad/{id}
                -- from /api/adx/{id} detail
                meta_ad_id          TEXT,                  -- Facebook/platform ad ID
                ad_copy             TEXT,
                video_url           TEXT,
                platforms           TEXT,                  -- JSON array e.g. ["FACEBOOK","INSTAGRAM"]
                cta_type            TEXT,
                keyword             TEXT,
                -- meta
                fetched_at          INTEGER,
                detail_fetched_at   INTEGER
            );

            CREATE INDEX IF NOT EXISTS idx_ads_report ON ads(report_id);

            CREATE TABLE IF NOT EXISTS extraction_runs (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                report_id       INTEGER,
                started_at      INTEGER,
                completed_at    INTEGER,
                ads_fetched     INTEGER DEFAULT 0,
                status          TEXT DEFAULT 'running'
            );
        """)
        self.conn.commit()

    # ── reports ─────────────────────────────────────────────────────

    def upsert_report(self, report_id: int, name: str) -> None:
        self.conn.execute(
            "INSERT INTO reports (id, name, fetched_at) VALUES (?,?,?)"
            " ON CONFLICT(id) DO UPDATE SET name=excluded.name, fetched_at=excluded.fetched_at",
            (report_id, name, _now_ms()),
        )
        self.conn.commit()

    # ── ads ─────────────────────────────────────────────────────────

    def upsert_ad_from_listing(self, ad: dict, report_id: int) -> None:
        """Store basic ad info from the report listing (no detail yet)."""
        countries = ad.get("countries") or []
        adplexity_id = ad.get("id")
        self.conn.execute(
            """INSERT INTO ads
               (id, report_id, title, thumb_url, first_seen, last_seen, days_running,
                countries, status, ad_url, fetched_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(id) DO UPDATE SET
                 title=excluded.title,
                 thumb_url=excluded.thumb_url,
                 first_seen=excluded.first_seen,
                 last_seen=excluded.last_seen,
                 days_running=excluded.days_running,
                 countries=excluded.countries,
                 status=excluded.status,
                 fetched_at=excluded.fetched_at""",
            (
                adplexity_id,
                report_id,
                ad.get("title") or ad.get("title_en"),
                ad.get("thumb_url"),
                ad.get("first_seen"),
                ad.get("last_seen"),
                ad.get("days_total") or ad.get("hits_total"),
                json.dumps(countries),
                "active" if ad.get("meta_status") == 1 else "inactive",
                f"https://app.adplexity.io/ad/{adplexity_id}",
                _now_ms(),
            ),
        )

    def upsert_ad_detail(self, adplexity_id: int, detail: dict) -> None:
        """Store enriched fields from /api/adx/{id}."""
        ad = detail.get("ad") or {}
        meta = ad.get("meta") or {}
        videos = detail.get("videos") or meta.get("videos") or []
        video_url = videos[0].get("url") if videos else None
        platforms = meta.get("platforms") or []

        # Landing page URL from detail response
        lp = None
        # detail may include landing page info if we fetched it separately
        # for now use the link_url or host from meta
        lp = meta.get("url") or None

        self.conn.execute(
            """UPDATE ads SET
                 meta_ad_id=?,
                 ad_copy=?,
                 video_url=?,
                 platforms=?,
                 cta_type=?,
                 keyword=?,
                 landing_page_url=COALESCE(?, landing_page_url),
                 detail_fetched_at=?
               WHERE id=?""",
            (
                str(meta.get("ad_id") or ""),
                ad.get("description") or ad.get("description_en") or "",
                video_url,
                json.dumps(platforms),
                meta.get("cta_type_name") or meta.get("cta_type") or "",
                meta.get("keyword") or "",
                lp,
                _now_ms(),
                adplexity_id,
            ),
        )

    def bulk_upsert_ads(self, ads: list[dict], report_id: int) -> None:
        for ad in ads:
            self.upsert_ad_from_listing(ad, report_id)
        self.conn.commit()

    def commit_detail(self, adplexity_id: int, detail: dict) -> None:
        self.upsert_ad_detail(adplexity_id, detail)
        self.conn.commit()

    def get_ads(self, report_id: int | None = None) -> list[dict]:
        sql = "SELECT * FROM ads"
        params: list = []
        if report_id is not None:
            sql += " WHERE report_id=?"
            params.append(report_id)
        sql += " ORDER BY first_seen DESC"
        rows = self.conn.execute(sql, params).fetchall()
        return [dict(r) for r in rows]

    def get_ads_needing_detail(self, report_id: int | None = None) -> list[int]:
        """Return IDs of ads that haven't been enriched yet."""
        sql = "SELECT id FROM ads WHERE detail_fetched_at IS NULL"
        params: list = []
        if report_id is not None:
            sql += " AND report_id=?"
            params.append(report_id)
        rows = self.conn.execute(sql, params).fetchall()
        return [r[0] for r in rows]

    # ── runs ────────────────────────────────────────────────────────

    def start_run(self, report_id: int) -> int:
        cur = self.conn.execute(
            "INSERT INTO extraction_runs (report_id, started_at, status) VALUES (?,?,?)",
            (report_id, _now_ms(), "running"),
        )
        self.conn.commit()
        return cur.lastrowid  # type: ignore[return-value]

    def end_run(self, run_id: int, ads_fetched: int, status: str = "completed") -> None:
        self.conn.execute(
            "UPDATE extraction_runs SET completed_at=?, ads_fetched=?, status=? WHERE id=?",
            (_now_ms(), ads_fetched, status, run_id),
        )
        self.conn.commit()

    def close(self) -> None:
        self.conn.close()


# ── helpers ──────────────────────────────────────────────────────────

def _now_ms() -> int:
    return int(time.time() * 1000)
