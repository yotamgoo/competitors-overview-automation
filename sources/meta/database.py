import csv
import sqlite3
from pathlib import Path
from typing import List, Optional


DEFAULT_DB = "ads.db"


def get_db(db_path: str = DEFAULT_DB) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db(conn: sqlite3.Connection) -> None:
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS advertisers (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            name       TEXT NOT NULL,
            page_id    TEXT UNIQUE NOT NULL,
            vertical   TEXT DEFAULT '',
            category   TEXT DEFAULT '',
            notes      TEXT DEFAULT '',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_advertisers_page_id
            ON advertisers(page_id);
        CREATE INDEX IF NOT EXISTS idx_advertisers_vertical
            ON advertisers(vertical);

        CREATE TABLE IF NOT EXISTS ads (
            id                   INTEGER PRIMARY KEY AUTOINCREMENT,
            source               TEXT NOT NULL DEFAULT 'meta',
            source_id            TEXT NOT NULL,
            advertiser_id        INTEGER REFERENCES advertisers(id),
            advertiser_name      TEXT NOT NULL DEFAULT '',
            headline             TEXT DEFAULT '',
            ad_copy              TEXT DEFAULT '',
            cta                  TEXT DEFAULT '',
            media_type           TEXT DEFAULT '',
            media_path           TEXT DEFAULT '',
            ad_link              TEXT DEFAULT '',
            landing_url          TEXT DEFAULT '',
            landing_domain       TEXT DEFAULT '',
            platforms            TEXT DEFAULT '',
            categories           TEXT DEFAULT '',
            started_running_date TEXT DEFAULT '',
            running_days         INTEGER DEFAULT 0,
            search_term          TEXT DEFAULT '',
            scraped_at           TEXT NOT NULL DEFAULT (datetime('now')),
            created_at           TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(source, source_id)
        );

        CREATE INDEX IF NOT EXISTS idx_ads_source
            ON ads(source);
        CREATE INDEX IF NOT EXISTS idx_ads_advertiser_id
            ON ads(advertiser_id);
        CREATE INDEX IF NOT EXISTS idx_ads_source_id
            ON ads(source, source_id);
        CREATE INDEX IF NOT EXISTS idx_ads_scraped_at
            ON ads(scraped_at);
    """)


def upsert_advertiser(
    conn: sqlite3.Connection,
    name: str,
    page_id: str,
    vertical: str = "",
    category: str = "",
) -> int:
    cur = conn.execute(
        """
        INSERT INTO advertisers (name, page_id, vertical, category)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(page_id) DO UPDATE SET
            name     = excluded.name,
            vertical = excluded.vertical,
            category = excluded.category,
            updated_at = datetime('now')
        """,
        (name, page_id, vertical, category),
    )
    conn.commit()
    return cur.lastrowid


def get_advertiser_by_page_id(
    conn: sqlite3.Connection, page_id: str
) -> Optional[dict]:
    row = conn.execute(
        "SELECT * FROM advertisers WHERE page_id = ?", (page_id,)
    ).fetchone()
    return dict(row) if row else None


def get_all_advertisers(
    conn: sqlite3.Connection, vertical: Optional[str] = None
) -> List[dict]:
    if vertical:
        rows = conn.execute(
            "SELECT * FROM advertisers WHERE vertical = ? ORDER BY name",
            (vertical,),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM advertisers ORDER BY name"
        ).fetchall()
    return [dict(r) for r in rows]


def upsert_ad(conn: sqlite3.Connection, ad: dict) -> int:
    cur = conn.execute(
        """
        INSERT INTO ads (
            source, source_id, advertiser_id, advertiser_name,
            headline, ad_copy, cta, media_type, media_path,
            ad_link, landing_url, landing_domain, platforms, categories,
            started_running_date, running_days,
            search_term, scraped_at
        ) VALUES (
            :source, :source_id, :advertiser_id, :advertiser_name,
            :headline, :ad_copy, :cta, :media_type, :media_path,
            :ad_link, :landing_url, :landing_domain, :platforms, :categories,
            :started_running_date, :running_days,
            :search_term, :scraped_at
        )
        ON CONFLICT(source, source_id) DO UPDATE SET
            advertiser_id        = excluded.advertiser_id,
            advertiser_name      = excluded.advertiser_name,
            headline             = excluded.headline,
            ad_copy              = excluded.ad_copy,
            cta                  = excluded.cta,
            media_type           = excluded.media_type,
            media_path           = excluded.media_path,
            ad_link              = excluded.ad_link,
            landing_url          = excluded.landing_url,
            landing_domain       = excluded.landing_domain,
            platforms            = excluded.platforms,
            categories           = excluded.categories,
            started_running_date = excluded.started_running_date,
            running_days         = excluded.running_days,
            search_term          = excluded.search_term,
            scraped_at           = excluded.scraped_at
        """,
        ad,
    )
    return cur.lastrowid


def upsert_ads_batch(conn: sqlite3.Connection, ads: List[dict]) -> int:
    count = 0
    for ad in ads:
        upsert_ad(conn, ad)
        count += 1
    conn.commit()
    return count


def get_ads(
    conn: sqlite3.Connection,
    source: Optional[str] = None,
    advertiser_id: Optional[int] = None,
    min_running_days: int = 0,
) -> List[dict]:
    clauses = []
    params = []

    if source:
        clauses.append("source = ?")
        params.append(source)
    if advertiser_id is not None:
        clauses.append("advertiser_id = ?")
        params.append(advertiser_id)
    if min_running_days > 0:
        clauses.append("running_days >= ?")
        params.append(min_running_days)

    where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
    rows = conn.execute(
        f"SELECT * FROM ads{where} ORDER BY running_days DESC", params
    ).fetchall()
    return [dict(r) for r in rows]


def seed_advertisers_from_csv(conn: sqlite3.Connection, csv_path: str) -> int:
    count = 0
    with open(csv_path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            name = (row.get("name") or "").strip()
            page_id = (row.get("page_id") or "").strip()
            if not name or not page_id:
                continue
            vertical = (row.get("vertical") or "").strip()
            category = (row.get("category") or "").strip()
            upsert_advertiser(conn, name, page_id, vertical, category)
            count += 1
    return count
