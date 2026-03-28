"""Generate an HTML preview of winner ads."""

from __future__ import annotations

import json
from pathlib import Path

try:  # pragma: no cover - supports both package and script execution
    from .models import Database
except ImportError:  # pragma: no cover
    from models import Database


def generate(db_path: str = "winners.db", out_path: str = "winners_preview.html", brand_id: str | None = None) -> Path:
    db = Database(db_path)
    db.initialize()
    winners = db.get_winners(brand_id=brand_id)
    db.close()

    cards_html = ""
    for w in winners:
        media_html = _media_block(w)
        platform = _fmt_platform(w.get("publisher_platform"))
        cards_html += f"""
        <div class="card">
            <div class="media-wrap">
                {media_html}
                <span class="badge">WINNER</span>
                <span class="status-badge {'live' if w['status'] == 'Running' else 'ended'}">{w['status'].upper()}</span>
            </div>
            <div class="info">
                <div class="brand">{w['brand']}</div>
                <div class="copy">{w['ad_copy'] or ''}</div>
                <div class="meta-grid">
                    <div class="meta-item"><span class="label">First Seen</span>{w['first_seen_date'] or '—'}</div>
                    <div class="meta-item"><span class="label">Last Seen</span>{w['last_seen_date'] or '—'}</div>
                    <div class="meta-item"><span class="label">Days Running</span>{w['days_running'] or '—'}</div>
                    <div class="meta-item"><span class="label">Duplicates</span>{w['duplicates'] or '—'}</div>
                    <div class="meta-item"><span class="label">Format</span>{w['format'] or '—'}</div>
                    <div class="meta-item"><span class="label">Platform</span>{platform}</div>
                    <div class="meta-item"><span class="label">CTA</span>{w['cta_text'] or w['cta_type'] or '—'}</div>
                    <div class="meta-item"><span class="label">Product</span>{w['product_category'] or '—'}</div>
                </div>
                <div class="links">
                    {f'<a href="{w["ad_library_url"]}" target="_blank">FB Ad Library</a>' if w.get('ad_library_url') else ''}
                    {f'<a href="{w["landing_page_url"]}" target="_blank">Landing Page</a>' if w.get('landing_page_url') else ''}
                </div>
                <div class="ad-id">Ad ID: {w['ad_id']}</div>
            </div>
        </div>"""

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Winner Ads Preview</title>
<style>
  * {{ box-sizing: border-box; margin: 0; padding: 0; }}
  body {{ background: #0f0f0f; color: #e0e0e0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 32px; }}
  h1 {{ font-size: 22px; font-weight: 600; margin-bottom: 8px; color: #fff; }}
  .subtitle {{ color: #666; font-size: 13px; margin-bottom: 32px; }}
  .grid {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 24px; }}
  .card {{ background: #1a1a1a; border-radius: 12px; overflow: hidden; border: 1px solid #2a2a2a; }}
  .media-wrap {{ position: relative; background: #111; aspect-ratio: 1/1; overflow: hidden; }}
  .media-wrap img {{ width: 100%; height: 100%; object-fit: cover; display: block; }}
  .media-wrap video {{ width: 100%; height: 100%; object-fit: cover; display: block; }}
  .no-media {{ width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; color: #444; font-size: 13px; }}
  .badge {{ position: absolute; top: 10px; left: 10px; background: #f59e0b; color: #000; font-size: 10px; font-weight: 700; padding: 3px 8px; border-radius: 4px; letter-spacing: 0.5px; }}
  .status-badge {{ position: absolute; top: 10px; right: 10px; font-size: 10px; font-weight: 700; padding: 3px 8px; border-radius: 4px; letter-spacing: 0.5px; }}
  .status-badge.live {{ background: #22c55e; color: #000; }}
  .status-badge.ended {{ background: #555; color: #ccc; }}
  .info {{ padding: 16px; }}
  .brand {{ font-size: 12px; font-weight: 600; color: #888; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; }}
  .copy {{ font-size: 14px; color: #ccc; line-height: 1.5; margin-bottom: 14px; min-height: 40px; }}
  .meta-grid {{ display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 14px; }}
  .meta-item {{ font-size: 12px; color: #999; }}
  .meta-item .label {{ display: block; font-size: 10px; color: #555; text-transform: uppercase; letter-spacing: 0.4px; margin-bottom: 2px; }}
  .links {{ display: flex; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; }}
  .links a {{ font-size: 12px; color: #60a5fa; text-decoration: none; padding: 4px 10px; border: 1px solid #2563eb44; border-radius: 4px; }}
  .links a:hover {{ background: #2563eb22; }}
  .ad-id {{ font-size: 10px; color: #444; font-family: monospace; }}
</style>
</head>
<body>
<h1>Winner Ads</h1>
<p class="subtitle">{len(winners)} winner{"s" if len(winners) != 1 else ""} found &nbsp;·&nbsp; Foreplay Spyder</p>
<div class="grid">
{cards_html}
</div>
</body>
</html>"""

    out = Path(out_path)
    out.write_text(html, encoding="utf-8")
    return out


def _media_block(w: dict) -> str:
    video = w.get("video_url")
    thumb = w.get("thumbnail_url")
    if video:
        poster = f'poster="{thumb}"' if thumb else ""
        return f'<video src="{video}" {poster} controls muted playsinline loop></video>'
    if thumb:
        return f'<img src="{thumb}" alt="Ad creative" loading="lazy">'
    return '<div class="no-media">No preview available</div>'


def _fmt_platform(raw: str | None) -> str:
    if not raw:
        return "—"
    try:
        platforms = json.loads(raw) if raw.startswith("[") else [raw]
        return ", ".join(p.capitalize() for p in platforms)
    except Exception:
        return raw


if __name__ == "__main__":
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument("--db", default="winners.db")
    p.add_argument("--out", default="winners_preview.html")
    p.add_argument("--brand-id")
    args = p.parse_args()
    out = generate(args.db, args.out, args.brand_id)
    print(f"Preview saved: {out.resolve()}")
