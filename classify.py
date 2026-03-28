"""Batch vertical classifier for the unified competitive intelligence database."""

from __future__ import annotations

import argparse
import re
from dataclasses import dataclass
from typing import Callable

from app_config import DEFAULT_DB_PATH
from intelligence_db import IntelligenceDatabase


VERTICAL_RULES: dict[str, tuple[str, ...]] = {
    "pet_insurance": (
        "pet insurance",
        "dog insurance",
        "cat insurance",
        "vet bills",
        "vet bill",
        "veterinary care",
        "pet wellness",
        "accident and illness coverage",
        "accident & illness coverage",
    ),
    "auto_insurance": (
        "auto insurance",
        "car insurance",
        "vehicle insurance",
        "sr-22",
        "safe driver",
        "good driver",
        "drivewise",
        "accident forgiveness",
        "liability coverage",
        "collision coverage",
        "comprehensive coverage",
        "/auto",
        "/car-insurance",
        "/vehicle-insurance",
    ),
    "home_insurance": (
        "home insurance",
        "homeowners insurance",
        "house insurance",
        "dwelling coverage",
        "property insurance",
        "home policy",
        "/home-insurance",
        "/homeowners",
    ),
    "renters_insurance": (
        "renters insurance",
        "renter's insurance",
        "tenant insurance",
        "apartment insurance",
        "/renters-insurance",
    ),
    "life_insurance": (
        "life insurance",
        "term life",
        "whole life",
        "final expense",
        "burial insurance",
        "beneficiary",
        "death benefit",
        "/life-insurance",
    ),
    "health_insurance": (
        "health insurance",
        "health plan",
        "medical insurance",
        "medical coverage",
        "marketplace plan",
        "aca plan",
        "obamacare",
        "medicare",
        "medicaid",
        "/health-insurance",
    ),
    "dental_insurance": (
        "dental insurance",
        "dental plan",
        "orthodontic coverage",
        "/dental-insurance",
    ),
    "travel_insurance": (
        "travel insurance",
        "trip protection",
        "trip cancellation",
        "travel medical",
        "/travel-insurance",
    ),
    "disability_insurance": (
        "disability insurance",
        "income protection",
        "short term disability",
        "long term disability",
        "/disability-insurance",
    ),
}


@dataclass(slots=True)
class ClassificationSummary:
    scanned: int = 0
    classified: int = 0
    still_unclassified: int = 0


def classify_ads(
    db_path: str = str(DEFAULT_DB_PATH),
    *,
    force: bool = False,
    limit: int | None = None,
    dry_run: bool = False,
    log: Callable[[str], None] = print,
) -> ClassificationSummary:
    db = IntelligenceDatabase(db_path)
    db.initialize()
    try:
        rows = db.get_ads(limit=limit) if force else db.get_unclassified_ads(limit=limit)
        summary = ClassificationSummary(scanned=len(rows))
        updates: list[tuple[int, str | None]] = []

        for row in rows:
            vertical = classify_row(row)
            if vertical:
                summary.classified += 1
                updates.append((row["id"], vertical))
                log(f"[{row['source']}] {row['display_brand']} -> {vertical}")
            else:
                summary.still_unclassified += 1

        if not dry_run and updates:
            db.bulk_update_vertical(updates)
        elif not dry_run:
            db.conn.commit()

        return summary
    finally:
        db.close()


def classify_row(row: dict[str, object]) -> str | None:
    haystack = normalize_text(
        " ".join(
            [
                str(row.get("brand") or ""),
                str(row.get("title") or ""),
                str(row.get("ad_copy") or ""),
                str(row.get("landing_page_url") or ""),
                str(row.get("cta") or ""),
            ]
        )
    )
    if not haystack:
        return None

    best_vertical: str | None = None
    best_score = 0
    for vertical, keywords in VERTICAL_RULES.items():
        score = 0
        for keyword in keywords:
            if keyword in haystack:
                score += max(len(keyword.split()), 1)
        if score > best_score:
            best_vertical = vertical
            best_score = score
    return best_vertical


def normalize_text(value: str) -> str:
    lowered = value.lower()
    lowered = lowered.replace("&", " and ")
    lowered = re.sub(r"[^a-z0-9/]+", " ", lowered)
    return " ".join(lowered.split())


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Classify ads into insurance verticals")
    parser.add_argument("--db", default=str(DEFAULT_DB_PATH), help="Unified intelligence DB path")
    parser.add_argument("--force", action="store_true", help="Reclassify all ads, not just blank verticals")
    parser.add_argument("--limit", type=int, default=None, help="Limit number of rows to classify")
    parser.add_argument("--dry-run", action="store_true", help="Show proposed classifications without saving")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
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


if __name__ == "__main__":
    raise SystemExit(main())
