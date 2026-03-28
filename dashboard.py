"""HTML dashboard generator and local app server for competitive intelligence."""

from __future__ import annotations

import argparse
import json
import os
import threading
import traceback
from dataclasses import dataclass, field
from datetime import datetime
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlparse

from app_config import (
    DEFAULT_DASHBOARD_PATH,
    DEFAULT_DASHBOARD_PORT,
    DEFAULT_DASHBOARD_SETTINGS_PATH,
    DEFAULT_DB_PATH,
    META_ADVERTISERS_DB,
    ROOT_DIR,
)
from classify import classify_ads
from intelligence_db import IntelligenceDatabase, now_iso
from unified_extractors import extract_adplexity, extract_foreplay, extract_meta_batch, extract_meta_page


def get_dashboard_payload(db_path: str | Path = DEFAULT_DB_PATH, out_dir: str | Path | None = None) -> dict[str, Any]:
    out_base = Path(out_dir) if out_dir is not None else Path(db_path).resolve().parent
    db = IntelligenceDatabase(db_path)
    db.initialize()
    try:
        rows = db.get_ads()
        stats = db.get_stats()
    finally:
        db.close()
    ads = [prepare_row(row, out_base) for row in rows]
    stats["winner_ads"] = sum(1 for row in ads if row["is_winner"])
    return {"generatedAt": now_iso(), "stats": stats, "ads": ads}


def build_dashboard(db_path: str | Path = DEFAULT_DB_PATH, out_path: str | Path = DEFAULT_DASHBOARD_PATH) -> Path:
    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(render_html(get_dashboard_payload(db_path, out.parent)), encoding="utf-8")
    return out


def serve_dashboard(
    out_path: str | Path = DEFAULT_DASHBOARD_PATH,
    *,
    db_path: str | Path = DEFAULT_DB_PATH,
    settings_path: str | Path = DEFAULT_DASHBOARD_SETTINGS_PATH,
    port: int = DEFAULT_DASHBOARD_PORT,
) -> None:
    out = build_dashboard(db_path=db_path, out_path=out_path).resolve()
    app = DashboardAppController(Path(db_path).resolve(), out, Path(settings_path).resolve())
    server = DashboardHTTPServer(("127.0.0.1", port), partial(AppRequestHandler, directory=str(ROOT_DIR)), app)
    page = out.relative_to(ROOT_DIR.resolve()).as_posix()
    print(f"Dashboard app available at http://127.0.0.1:{port}/{page}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nDashboard server stopped.")
    finally:
        server.server_close()


@dataclass(slots=True)
class JobState:
    running: bool = False
    name: str = ""
    started_at: str | None = None
    finished_at: str | None = None
    last_result: str = ""
    last_error: str = ""
    logs: list[str] = field(default_factory=list)


class DashboardAppController:
    def __init__(self, db_path: Path, out_path: Path, settings_path: Path):
        self.db_path = db_path
        self.out_path = out_path
        self.settings_path = settings_path
        self._lock = threading.Lock()
        self._job = JobState()
        self._data_version = now_iso()
        self.settings = self._load_settings()

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "settings": self.settings,
                "job": {
                    "running": self._job.running,
                    "name": self._job.name,
                    "startedAt": self._job.started_at,
                    "finishedAt": self._job.finished_at,
                    "lastResult": self._job.last_result,
                    "lastError": self._job.last_error,
                    "logs": list(self._job.logs[-120:]),
                },
                "dataVersion": self._data_version,
            }

    def get_data(self) -> dict[str, Any]:
        return get_dashboard_payload(self.db_path, self.out_path.parent)

    def save_settings(self, raw: dict[str, Any]) -> dict[str, Any]:
        self.settings = normalize_settings(raw)
        self.settings_path.parent.mkdir(parents=True, exist_ok=True)
        self.settings_path.write_text(json.dumps(self.settings, indent=2), encoding="utf-8")
        self.append_log("Settings saved.")
        return self.snapshot()

    def start_action(self, action: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        payload = payload or {}
        if "settings" in payload:
            self.save_settings(payload["settings"])
        if action == "save-settings":
            return self.snapshot()
        with self._lock:
            if self._job.running:
                raise RuntimeError("Another dashboard job is already running.")
            self._job = JobState(running=True, name=action, started_at=now_iso(), logs=[])
        threading.Thread(target=self._run_job, args=(action, self._runner(action)), daemon=True).start()
        return self.snapshot()

    def append_log(self, *parts: Any) -> None:
        message = " ".join(str(part) for part in parts).strip()
        if not message:
            return
        line = f"[{datetime.now().strftime('%H:%M:%S')}] {message}"
        with self._lock:
            self._job.logs.append(line)
            self._job.logs = self._job.logs[-200:]

    def _run_job(self, action: str, runner: Callable[[], str]) -> None:
        try:
            result = runner()
            build_dashboard(self.db_path, self.out_path)
            self._data_version = self.get_data()["generatedAt"]
            with self._lock:
                self._job.running = False
                self._job.finished_at = now_iso()
                self._job.last_result = result
                self._job.last_error = ""
            self.append_log("Dashboard refreshed.")
        except Exception as exc:  # pragma: no cover
            with self._lock:
                self._job.running = False
                self._job.finished_at = now_iso()
                self._job.last_error = f"{exc}\n{traceback.format_exc(limit=4)}"
            self.append_log(f"Job failed: {exc}")

    def _runner(self, action: str) -> Callable[[], str]:
        mapping = {
            "extract-foreplay": self._run_foreplay,
            "extract-adplexity": self._run_adplexity,
            "extract-meta": self._run_meta,
            "classify": self._run_classify,
            "full-refresh": self._run_full_refresh,
            "refresh": self._run_refresh,
        }
        if action not in mapping:
            raise ValueError(f"Unknown action: {action}")
        return mapping[action]

    def _run_foreplay(self) -> str:
        brand_ids = self.settings["foreplay"]["brand_ids"]
        if not brand_ids:
            raise ValueError("Add at least one Foreplay brand ID.")
        db = IntelligenceDatabase(self.db_path)
        db.initialize()
        try:
            results = extract_foreplay(db, brand_ids, months=self.settings["foreplay"]["months"], log=self.append_log)
        finally:
            db.close()
        total = sum(item.winners_found for item in results)
        if self.settings["auto_classify_after_extract"]:
            self._classify_internal()
        return f"Foreplay complete: {total} winner ads stored."

    def _run_adplexity(self) -> str:
        report_ids = self.settings["adplexity"]["report_ids"]
        if not report_ids:
            raise ValueError("Add at least one AdPlexity report ID.")
        db = IntelligenceDatabase(self.db_path)
        db.initialize()
        try:
            totals = [extract_adplexity(db, report_id=rid, log=self.append_log) for rid in report_ids]
        finally:
            db.close()
        if self.settings["auto_classify_after_extract"]:
            self._classify_internal()
        return f"AdPlexity complete: {sum(x.ads_fetched for x in totals)} ads fetched."

    def _run_meta(self) -> str:
        meta = self.settings["meta"]
        db = IntelligenceDatabase(self.db_path)
        db.initialize()
        try:
            if meta["mode"] == "page":
                if not meta["page_id"]:
                    raise ValueError("Meta page mode requires a page ID.")
                summary = extract_meta_page(
                    db,
                    page_id=meta["page_id"],
                    keywords=meta["keywords"],
                    min_days=meta["min_days"],
                    media_type=meta["media"],
                    max_ads=meta["max_ads"],
                    log=self.append_log,
                )
            else:
                summary = extract_meta_batch(
                    db,
                    advertisers_db=meta["advertisers_db"],
                    vertical=meta["vertical_filter"] or None,
                    min_days=meta["min_days"],
                    media_type=meta["media"],
                    max_ads=meta["max_ads"],
                    log=self.append_log,
                )
        finally:
            db.close()
        if self.settings["auto_classify_after_extract"]:
            self._classify_internal()
        return f"Meta complete: {summary.stored} ads stored."

    def _run_classify(self) -> str:
        summary = self._classify_internal()
        return f"Classification complete: scanned {summary.scanned}, classified {summary.classified}."

    def _run_full_refresh(self) -> str:
        results: list[str] = []
        auto_classify = self.settings["auto_classify_after_extract"]
        self.settings["auto_classify_after_extract"] = False
        try:
            if self.settings["foreplay"]["brand_ids"]:
                results.append(self._run_foreplay())
            else:
                self.append_log("Skipping Foreplay: no brand IDs configured.")
            if self.settings["adplexity"]["report_ids"]:
                results.append(self._run_adplexity())
            else:
                self.append_log("Skipping AdPlexity: no report IDs configured.")
            meta = self.settings["meta"]
            if meta["mode"] == "batch" or meta["page_id"]:
                results.append(self._run_meta())
            else:
                self.append_log("Skipping Meta: configure batch mode or a page ID.")
        finally:
            self.settings["auto_classify_after_extract"] = auto_classify
        if auto_classify and results:
            results.append(self._run_classify())
        if not results:
            raise ValueError("No extractors are configured yet.")
        return " | ".join(results)

    def _run_refresh(self) -> str:
        self.append_log("Refreshing dashboard output only.")
        return "Dashboard output refreshed."

    def _classify_internal(self):
        self.append_log("Running keyword classifier...")
        return classify_ads(db_path=str(self.db_path), log=self.append_log)

    def _load_settings(self) -> dict[str, Any]:
        if not self.settings_path.exists():
            return normalize_settings({})
        try:
            return normalize_settings(json.loads(self.settings_path.read_text(encoding="utf-8")))
        except json.JSONDecodeError:
            return normalize_settings({})


def normalize_settings(raw: dict[str, Any]) -> dict[str, Any]:
    foreplay = raw.get("foreplay") or {}
    adplexity = raw.get("adplexity") or {}
    meta = raw.get("meta") or {}
    return {
        "foreplay": {
            "brand_ids": parse_string_list(foreplay.get("brand_ids")),
            "months": clamp_int(foreplay.get("months"), default=3, minimum=1, maximum=24),
        },
        "adplexity": {"report_ids": parse_int_list(adplexity.get("report_ids"))},
        "meta": {
            "mode": "page" if meta.get("mode") == "page" else "batch",
            "page_id": str(meta.get("page_id") or "").strip(),
            "keywords": str(meta.get("keywords") or "").strip(),
            "vertical_filter": str(meta.get("vertical_filter") or "").strip(),
            "min_days": clamp_int(meta.get("min_days"), default=30, minimum=0, maximum=365),
            "media": normalize_media(meta.get("media")),
            "max_ads": clamp_int(meta.get("max_ads"), default=50, minimum=1, maximum=250),
            "advertisers_db": str(meta.get("advertisers_db") or META_ADVERTISERS_DB),
        },
        "auto_classify_after_extract": bool(raw.get("auto_classify_after_extract", True)),
    }


def parse_string_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    text = str(value).replace(",", "\n").replace("\r", "\n")
    return [line.strip() for line in text.splitlines() if line.strip()]


def parse_int_list(value: Any) -> list[int]:
    return [int(token) for token in parse_string_list(value) if token.isdigit()]


def clamp_int(value: Any, *, default: int, minimum: int, maximum: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return default
    return max(minimum, min(maximum, number))


def normalize_media(value: Any) -> str:
    text = str(value or "both").strip().lower()
    return text if text in {"image", "video", "both"} else "both"


class DashboardHTTPServer(ThreadingHTTPServer):
    def __init__(self, server_address, handler_cls, app: DashboardAppController):
        super().__init__(server_address, handler_cls)
        self.app = app


class AppRequestHandler(SimpleHTTPRequestHandler):
    server: DashboardHTTPServer

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path in {"/", "/index.html"}:
            self._serve_dashboard()
            return
        if path == "/api/data":
            self._send_json(200, self.server.app.get_data())
            return
        if path == "/api/state":
            self._send_json(200, self.server.app.snapshot())
            return
        super().do_GET()

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        payload = self._read_json()
        if path == "/api/settings":
            self._send_json(200, self.server.app.save_settings(payload))
            return
        if path.startswith("/api/actions/"):
            action = path.removeprefix("/api/actions/")
            try:
                snapshot = self.server.app.start_action(action, payload)
            except RuntimeError as exc:
                self._send_json(409, {"error": str(exc), "state": self.server.app.snapshot()})
                return
            except ValueError as exc:
                self._send_json(400, {"error": str(exc)})
                return
            self._send_json(202, snapshot)
            return
        self._send_json(404, {"error": "Not found"})

    def log_message(self, format: str, *args: Any) -> None:  # pragma: no cover
        return

    def _serve_dashboard(self) -> None:
        if not self.server.app.out_path.exists():
            build_dashboard(self.server.app.db_path, self.server.app.out_path)
        content = self.server.app.out_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if not length:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except json.JSONDecodeError:
            return {}

    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def prepare_row(row: dict[str, Any], out_dir: Path) -> dict[str, Any]:
    item = dict(row)
    item["countriesText"] = ", ".join(item.get("countries") or []) or "Global"
    item["platformsText"] = ", ".join(format_platform(p) for p in item.get("platforms") or []) or "Unknown"
    item["verticalText"] = item.get("display_vertical") or "unclassified"
    item["statusText"] = item.get("status") or "inactive"
    item["brandText"] = item.get("display_brand") or "Unknown brand"
    item["sourceText"] = format_source(item.get("source") or "")
    item["titleText"] = item.get("title") or ""
    item["copyText"] = item.get("ad_copy") or ""
    item["videoUrl"] = media_href(item.get("video_url"), out_dir)
    item["imageUrl"] = media_href(item.get("image_url"), out_dir)
    item["firstSeenText"] = item.get("first_seen") or "Unknown"
    item["lastSeenText"] = item.get("last_seen") or "Unknown"
    item["daysRunningText"] = item.get("days_running") if item.get("days_running") is not None else "n/a"
    item["winnerText"] = "Foreplay Winner" if item.get("is_winner") else ""
    return item


def media_href(value: str | None, out_dir: Path) -> str | None:
    if not value:
        return None
    text = str(value).strip()
    if not text:
        return None
    if text.startswith(("http://", "https://", "data:")):
        return text
    path = Path(text)
    if not path.is_absolute():
        path = (ROOT_DIR / path).resolve()
    return Path(os.path.relpath(path, start=out_dir)).as_posix()


def format_platform(platform: str) -> str:
    return platform.replace("_", " ").title()


def format_source(source: str) -> str:
    mapping = {
        "foreplay": "Foreplay",
        "adplexity": "AdPlexity",
        "meta": "Meta",
    }
    return mapping.get(source, source.title())


HTML_HEAD = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Competitive Intelligence App</title>
<style>
:root {
  --bg:#08111a; --panel:rgba(10,20,31,.84); --strong:rgba(13,24,36,.97); --line:rgba(124,162,193,.18);
  --text:#edf6ff; --muted:#91a8bc; --cyan:#7ce0ff; --teal:#49d5b6; --amber:#f5b544; --rose:#ff8a70;
  --shadow:0 24px 80px rgba(0,0,0,.35);
}
*{box-sizing:border-box} body{
  margin:0;color:var(--text);font-family:"Segoe UI Variable Display","Aptos Display","Trebuchet MS",sans-serif;
  background:radial-gradient(circle at top left,rgba(73,213,182,.18),transparent 30%),radial-gradient(circle at top right,rgba(124,224,255,.2),transparent 28%),linear-gradient(180deg,#071018 0%,#08111a 48%,#091621 100%);min-height:100vh;
}
.shell{max-width:1500px;margin:0 auto;padding:40px 24px 72px}
.hero,.panel{border:1px solid var(--line);background:var(--panel);box-shadow:var(--shadow);backdrop-filter:blur(12px)}
.hero{position:relative;overflow:hidden;padding:28px 30px 30px;border-radius:28px;background:linear-gradient(135deg,rgba(124,224,255,.08),rgba(245,181,68,.06)),rgba(6,14,22,.82)}
.eyebrow,.badge,.status-pill{display:inline-flex;align-items:center}
.eyebrow{gap:10px;padding:8px 12px;border:1px solid rgba(124,224,255,.18);border-radius:999px;color:var(--cyan);font-size:12px;letter-spacing:.12em;text-transform:uppercase;background:rgba(124,224,255,.08)}
h1{margin:16px 0 10px;font-size:clamp(32px,5vw,56px);line-height:1;letter-spacing:-.04em}
.subhead{max-width:860px;margin:0;color:var(--muted);font-size:16px;line-height:1.7}
.hero-meta{display:flex;flex-wrap:wrap;gap:12px;margin-top:22px}
.chip{padding:10px 14px;border-radius:14px;border:1px solid rgba(145,168,188,.14);background:rgba(8,18,29,.76);color:var(--muted);font-size:13px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:16px;margin:26px 0 24px}
.stat{padding:18px;border-radius:22px}.stat-label{color:var(--muted);font-size:12px;letter-spacing:.12em;text-transform:uppercase}.stat-value{margin-top:12px;font-size:34px;font-weight:700;letter-spacing:-.04em}
.layout{display:grid;grid-template-columns:minmax(280px,360px) 1fr;gap:18px;align-items:start}
.controls{position:sticky;top:16px;padding:18px;border-radius:24px}.workspace{display:flex;flex-direction:column;gap:18px}
.filters,.grid,.status-card{padding:18px}.status-card,.board{border-radius:24px}
.section-label,label{color:var(--muted);font-size:12px;text-transform:uppercase}
.section-label{margin-top:18px;color:var(--cyan);letter-spacing:.12em}
label{display:block;letter-spacing:.1em;margin:12px 0 8px}
select,input,textarea,button{width:100%;padding:12px 14px;border:1px solid rgba(145,168,188,.16);border-radius:14px;background:rgba(3,9,15,.86);color:var(--text);font:inherit;outline:none}
textarea{min-height:92px;resize:vertical} .inline{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.check{display:flex;align-items:center;gap:10px;margin-top:14px;color:var(--muted);font-size:13px}.check input{width:auto;margin:0}
.buttons{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:18px}
button{cursor:pointer;font-weight:600;background:rgba(124,224,255,.08)} button.primary{background:linear-gradient(135deg,rgba(124,224,255,.18),rgba(73,213,182,.18))}
button:disabled{opacity:.55;cursor:not-allowed}
.note{margin-top:14px;padding:12px 14px;border-radius:14px;border:1px dashed rgba(145,168,188,.18);color:var(--muted);font-size:13px;line-height:1.6}
.status-line,.toolbar{display:flex;align-items:center;justify-content:space-between;gap:16px}
.status-pill{gap:10px;padding:8px 12px;border-radius:999px;font-size:12px;letter-spacing:.1em;text-transform:uppercase}
.status-pill.idle{background:rgba(145,168,188,.12);color:var(--muted)} .status-pill.running{background:rgba(245,181,68,.16);color:var(--amber)} .status-pill.error{background:rgba(255,138,112,.16);color:var(--rose)}
.status-detail,.toolbar p{color:var(--muted);font-size:14px;line-height:1.7;margin:0}
.log{margin-top:14px;padding:14px;min-height:150px;max-height:280px;overflow:auto;border-radius:16px;background:rgba(3,9,15,.92);border:1px solid rgba(145,168,188,.12);color:#d6e5f1;font-family:Consolas,"SFMono-Regular",monospace;font-size:12px;line-height:1.65;white-space:pre-wrap}
.filters{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:18px}
.card{display:flex;flex-direction:column;min-height:100%;border-radius:24px;overflow:hidden;border:1px solid var(--line);background:var(--strong);box-shadow:var(--shadow)}
.card.is-winner{border-color:rgba(245,181,68,.3);box-shadow:var(--shadow),0 0 0 1px rgba(245,181,68,.12) inset}
.media{position:relative;aspect-ratio:4/3;background:linear-gradient(180deg,rgba(124,224,255,.08),transparent),linear-gradient(180deg,#0c1823,#09111a)}
.media img,.media video{width:100%;height:100%;object-fit:cover;display:block}
.media-empty{display:grid;place-items:center;width:100%;height:100%;color:var(--muted);font-size:14px;padding:20px;text-align:center}
.badges{position:absolute;inset:14px 14px auto 14px;display:flex;justify-content:space-between;gap:12px;pointer-events:none}
.stack{display:flex;gap:8px;flex-wrap:wrap}
.badge{padding:7px 10px;border-radius:999px;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;backdrop-filter:blur(10px)}
.src-foreplay{background:rgba(245,181,68,.18);color:var(--amber);border:1px solid rgba(245,181,68,.2)} .src-adplexity{background:rgba(73,213,182,.16);color:var(--teal);border:1px solid rgba(73,213,182,.18)} .src-meta{background:rgba(124,224,255,.16);color:var(--cyan);border:1px solid rgba(124,224,255,.2)}
.badge-vertical{background:rgba(237,246,255,.08);color:var(--text);border:1px solid rgba(237,246,255,.12)} .st-active{background:rgba(73,213,182,.16);color:var(--teal);border:1px solid rgba(73,213,182,.18)} .st-inactive{background:rgba(255,138,112,.16);color:var(--rose);border:1px solid rgba(255,138,112,.18)} .badge-winner{background:rgba(245,181,68,.22);color:#fff0cd;border:1px solid rgba(245,181,68,.26)}
.content{display:flex;flex:1;flex-direction:column;padding:18px 18px 20px}
.brand-line{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.brand{color:var(--cyan);font-size:12px;letter-spacing:.14em;text-transform:uppercase}
.winner-inline{padding:6px 10px;border-radius:999px;background:rgba(245,181,68,.14);border:1px solid rgba(245,181,68,.24);color:#ffe0a0;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
.title{margin:12px 0 8px;font-size:22px;line-height:1.15;letter-spacing:-.03em}.copy{margin:0 0 16px;color:#cfe0ee;font-size:14px;line-height:1.65}
.meta{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:auto}.meta-item{padding:12px;border-radius:16px;background:rgba(255,255,255,.035);border:1px solid rgba(145,168,188,.08)}
.meta-k{color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.12em}.meta-v{margin-top:6px;font-size:13px;line-height:1.45}
.links{display:flex;flex-wrap:wrap;gap:10px;margin-top:16px}.links a{display:inline-flex;align-items:center;justify-content:center;min-width:110px;padding:11px 14px;border-radius:14px;border:1px solid rgba(124,224,255,.18);background:rgba(124,224,255,.08);color:var(--text);font-size:13px;text-decoration:none}
.empty{padding:42px 28px;border:1px dashed rgba(145,168,188,.18);border-radius:24px;color:var(--muted);text-align:center;background:rgba(8,18,29,.5);margin:18px}
.hidden{display:none!important}
@media (max-width:1120px){.layout{grid-template-columns:1fr}.controls{position:static}}
@media (max-width:720px){.shell{padding:28px 16px 48px}.hero{padding:22px;border-radius:24px}.stats{grid-template-columns:repeat(2,minmax(0,1fr))}.inline,.buttons,.meta{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="shell">
  <section class="hero">
    <div class="eyebrow">Unified Competitive Intelligence</div>
    <h1>One view across Foreplay, AdPlexity, and Meta</h1>
    <p class="subhead">A single command-center for live competitor creative, normalized into one SQLite dataset and ready to filter by source, vertical, and status. When served locally, this page becomes the control app for extraction, classification, refresh, and monitoring.</p>
    <div class="hero-meta">
      <div class="chip">Foreplay winners clearly labeled</div>
      <div class="chip">Last refreshed <span id="generated-at"></span></div>
      <div class="chip">Single-job guardrails for safe extraction</div>
    </div>
  </section>
  <section class="stats" id="stats"></section>
  <div class="layout">
    <aside class="panel controls">
      <h2>Control App</h2>
      <div id="app-note" class="note">Open this dashboard with <code>python cli.py dashboard --serve</code> to enable extraction controls, saved settings, and live job logs.</div>
      <div id="app-controls" class="hidden">
        <div class="section-label">Foreplay</div>
        <label for="foreplay-brand-ids">Brand IDs</label><textarea id="foreplay-brand-ids" placeholder="One brand ID per line"></textarea>
        <label for="foreplay-months">Lookback Months</label><input id="foreplay-months" type="number" min="1" max="24">
        <div class="section-label">AdPlexity</div>
        <label for="adplexity-report-ids">Report IDs</label><textarea id="adplexity-report-ids" placeholder="One report ID per line"></textarea>
        <div class="section-label">Meta</div>
        <label for="meta-mode">Mode</label><select id="meta-mode"><option value="batch">Batch from Meta advertiser DB</option><option value="page">Single page ID</option></select>
        <label for="meta-page-id">Page ID</label><input id="meta-page-id" type="text" placeholder="Only used for single-page mode">
        <label for="meta-keywords">Keywords</label><input id="meta-keywords" type="text" placeholder="Optional keyword filter for single-page mode">
        <div class="inline">
          <div><label for="meta-vertical-filter">Batch Vertical Filter</label><input id="meta-vertical-filter" type="text" placeholder="Optional, batch mode only"></div>
          <div><label for="meta-media">Media</label><select id="meta-media"><option value="both">Both</option><option value="image">Images</option><option value="video">Videos</option></select></div>
        </div>
        <div class="inline">
          <div><label for="meta-min-days">Min Days Running</label><input id="meta-min-days" type="number" min="0" max="365"></div>
          <div><label for="meta-max-ads">Max Ads</label><input id="meta-max-ads" type="number" min="1" max="250"></div>
        </div>
        <label for="meta-advertisers-db">Advertisers DB</label><input id="meta-advertisers-db" type="text">
        <label class="check"><input id="auto-classify" type="checkbox"> Auto-classify after each extraction</label>
        <div class="buttons">
          <button id="save-settings" class="primary">Save Settings</button>
          <button id="refresh-data">Refresh Data</button>
          <button id="extract-foreplay">Extract Foreplay</button>
          <button id="extract-adplexity">Extract AdPlexity</button>
          <button id="extract-meta">Extract Meta</button>
          <button id="classify-ads">Classify</button>
          <button id="full-refresh" class="primary" style="grid-column:1/-1">Run Full Refresh</button>
        </div>
        <div class="note">Responsible mode: the app runs one job at a time, saves settings before actions, and keeps a live activity log so you can see exactly what it is doing.</div>
      </div>
    </aside>
    <section class="workspace">
      <section class="panel status-card">
        <div class="status-line"><h2>Job Status</h2><div id="status-pill" class="status-pill idle">Idle</div></div>
        <div id="status-detail" class="status-detail">No job has run yet in this session.</div>
        <div id="log-box" class="log">Waiting for activity…</div>
      </section>
      <section class="panel board">
        <div class="filters">
          <div><label for="source-filter">Source</label><select id="source-filter"></select></div>
          <div><label for="vertical-filter">Vertical</label><select id="vertical-filter"></select></div>
          <div><label for="status-filter">Status</label><select id="status-filter"></select></div>
          <div><label for="winner-filter">Winner View</label><select id="winner-filter"><option value="all">All Ads</option><option value="winners">Winners Only</option><option value="non-winners">Non-Winners Only</option></select></div>
          <div><label for="search-filter">Search</label><input id="search-filter" type="search" placeholder="Brand, title, copy, platform..."></div>
        </div>
        <div class="toolbar"><p id="summary"></p></div>
        <div class="grid" id="card-grid"></div>
      </section>
    </section>
  </div>
</div>
<script>
const INITIAL_DATA = __DATA__;
"""

HTML_BODY = """
let dashboardData = INITIAL_DATA;
let appState = null;
let lastSeenDataVersion = INITIAL_DATA.generatedAt;
const appMode = window.location.protocol === 'http:' || window.location.protocol === 'https:';

const ids = (id) => document.getElementById(id);
const sourceFilter = ids('source-filter');
const verticalFilter = ids('vertical-filter');
const statusFilter = ids('status-filter');
const winnerFilter = ids('winner-filter');
const searchFilter = ids('search-filter');
const grid = ids('card-grid');
const summary = ids('summary');
const stats = ids('stats');
const generatedAt = ids('generated-at');
const appNote = ids('app-note');
const appControls = ids('app-controls');
const statusPill = ids('status-pill');
const statusDetail = ids('status-detail');
const logBox = ids('log-box');

const controls = {
  foreplayBrandIds: ids('foreplay-brand-ids'),
  foreplayMonths: ids('foreplay-months'),
  adplexityReportIds: ids('adplexity-report-ids'),
  metaMode: ids('meta-mode'),
  metaPageId: ids('meta-page-id'),
  metaKeywords: ids('meta-keywords'),
  metaVerticalFilter: ids('meta-vertical-filter'),
  metaMedia: ids('meta-media'),
  metaMinDays: ids('meta-min-days'),
  metaMaxAds: ids('meta-max-ads'),
  metaAdvertisersDb: ids('meta-advertisers-db'),
  autoClassify: ids('auto-classify'),
  saveSettings: ids('save-settings'),
  refreshData: ids('refresh-data'),
  extractForeplay: ids('extract-foreplay'),
  extractAdplexity: ids('extract-adplexity'),
  extractMeta: ids('extract-meta'),
  classifyAds: ids('classify-ads'),
  fullRefresh: ids('full-refresh'),
};

generatedAt.textContent = dashboardData.generatedAt;

function uniqueValues(items, key) { return Array.from(new Set(items.map(x => x[key]).filter(Boolean))).sort(); }
function optionList(values, includeUnclassified = false) {
  const extra = includeUnclassified ? ['unclassified', ...values.filter(v => v !== 'unclassified')] : values;
  return [...new Set(['all', ...extra])];
}
function label(value) {
  if (value === 'all') return 'All';
  if (value === 'unclassified') return 'Unclassified';
  return String(value).replaceAll('_', ' ').replace(/\\b\\w/g, (c) => c.toUpperCase());
}
function escapeHtml(value) {
  return String(value || '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
function populateFilters() {
  const cards = dashboardData.ads || [];
  sourceFilter.innerHTML = optionList(uniqueValues(cards, 'source')).map(v => `<option value="${v}">${label(v)}</option>`).join('');
  verticalFilter.innerHTML = optionList(uniqueValues(cards, 'verticalText'), true).map(v => `<option value="${v}">${label(v)}</option>`).join('');
  statusFilter.innerHTML = optionList(uniqueValues(cards, 'statusText')).map(v => `<option value="${v}">${label(v)}</option>`).join('');
}
function renderStats() {
  const entries = [
    ['Total Ads', dashboardData.stats.total_ads || 0],
    ['Winner Ads', dashboardData.stats.winner_ads || 0],
    ...Object.entries(dashboardData.stats.by_source || {}).map(([k, v]) => [label(k), v]),
    ...Object.entries(dashboardData.stats.by_status || {}).map(([k, v]) => [label(k), v]),
  ];
  stats.innerHTML = entries.map(([title, value]) => `<article class="panel stat"><div class="stat-label">${title}</div><div class="stat-value">${value}</div></article>`).join('');
}
function renderMedia(card) {
  if (card.videoUrl) {
    const poster = card.imageUrl ? `poster="${card.imageUrl}"` : '';
    return `<video src="${card.videoUrl}" ${poster} controls muted playsinline preload="none"></video>`;
  }
  if (card.imageUrl) return `<img src="${card.imageUrl}" alt="${escapeHtml(card.brandText)}" loading="lazy">`;
  return '<div class="media-empty">No image or video preview available for this ad.</div>';
}
function visibleCards() {
  const source = sourceFilter.value, vertical = verticalFilter.value, status = statusFilter.value, winner = winnerFilter.value, search = searchFilter.value.trim().toLowerCase();
  return (dashboardData.ads || []).filter(card => {
    if (source !== 'all' && card.source !== source) return false;
    if (vertical !== 'all' && card.verticalText !== vertical) return false;
    if (status !== 'all' && card.statusText !== status) return false;
    if (winner === 'winners' && !card.is_winner) return false;
    if (winner === 'non-winners' && card.is_winner) return false;
    if (!search) return true;
    const haystack = [card.brandText, card.titleText, card.copyText, card.platformsText, card.countriesText, card.verticalText, card.source].join(' ').toLowerCase();
    return haystack.includes(search);
  });
}
function renderCards() {
  const cards = visibleCards();
  const visibleWinners = cards.filter((card) => card.is_winner).length;
  summary.textContent = `${cards.length} of ${(dashboardData.ads || []).length} ads visible | ${visibleWinners} winner ads in view`;
  if (!cards.length) { grid.innerHTML = '<div class="empty">No ads match the current filters.</div>'; return; }
  grid.innerHTML = cards.map(card => `
    <article class="card${card.is_winner ? ' is-winner' : ''}">
      <div class="media">
        ${renderMedia(card)}
        <div class="badges">
          <div class="stack">
            <span class="badge src-${card.source}">${escapeHtml(card.sourceText)}</span>
            ${card.is_winner ? '<span class="badge badge-winner">Foreplay Winner</span>' : ''}
          </div>
          <div class="stack">
            <span class="badge badge-vertical">${label(card.verticalText)}</span>
            <span class="badge st-${card.statusText}">${label(card.statusText)}</span>
          </div>
        </div>
      </div>
      <div class="content">
        <div class="brand-line">
          <div class="brand">${escapeHtml(card.brandText)}</div>
          ${card.is_winner ? `<div class="winner-inline">${escapeHtml(card.winnerText)}</div>` : ''}
        </div>
        <div class="title">${escapeHtml(card.titleText || 'Untitled Creative')}</div>
        <p class="copy">${escapeHtml(card.copyText || 'No ad copy captured for this creative.')}</p>
        <div class="meta">
          <div class="meta-item"><div class="meta-k">Days Running</div><div class="meta-v">${card.daysRunningText}</div></div>
          <div class="meta-item"><div class="meta-k">Platforms</div><div class="meta-v">${escapeHtml(card.platformsText)}</div></div>
          <div class="meta-item"><div class="meta-k">Countries</div><div class="meta-v">${escapeHtml(card.countriesText)}</div></div>
          <div class="meta-item"><div class="meta-k">CTA</div><div class="meta-v">${escapeHtml(card.cta || 'Unknown')}</div></div>
          <div class="meta-item"><div class="meta-k">First Seen</div><div class="meta-v">${escapeHtml(card.firstSeenText)}</div></div>
          <div class="meta-item"><div class="meta-k">Last Seen</div><div class="meta-v">${escapeHtml(card.lastSeenText)}</div></div>
        </div>
        <div class="links">
          ${card.landing_page_url ? `<a href="${card.landing_page_url}" target="_blank" rel="noreferrer">Landing Page</a>` : ''}
          ${card.ad_library_url ? `<a href="${card.ad_library_url}" target="_blank" rel="noreferrer">Ad Library</a>` : ''}
        </div>
      </div>
    </article>
  `).join('');
}
function collectSettings() {
  const split = (value) => value.split(/\\n|,/).map(v => v.trim()).filter(Boolean);
  return {
    foreplay: { brand_ids: split(controls.foreplayBrandIds.value), months: Number(controls.foreplayMonths.value || 3) },
    adplexity: { report_ids: split(controls.adplexityReportIds.value).map(Number).filter((v) => Number.isFinite(v) && v > 0) },
    meta: {
      mode: controls.metaMode.value, page_id: controls.metaPageId.value.trim(), keywords: controls.metaKeywords.value.trim(),
      vertical_filter: controls.metaVerticalFilter.value.trim(), media: controls.metaMedia.value,
      min_days: Number(controls.metaMinDays.value || 30), max_ads: Number(controls.metaMaxAds.value || 50),
      advertisers_db: controls.metaAdvertisersDb.value.trim(),
    },
    auto_classify_after_extract: controls.autoClassify.checked,
  };
}
function hydrateSettings(settings) {
  if (!settings) return;
  controls.foreplayBrandIds.value = (settings.foreplay.brand_ids || []).join('\\n');
  controls.foreplayMonths.value = settings.foreplay.months;
  controls.adplexityReportIds.value = (settings.adplexity.report_ids || []).join('\\n');
  controls.metaMode.value = settings.meta.mode;
  controls.metaPageId.value = settings.meta.page_id || '';
  controls.metaKeywords.value = settings.meta.keywords || '';
  controls.metaVerticalFilter.value = settings.meta.vertical_filter || '';
  controls.metaMedia.value = settings.meta.media || 'both';
  controls.metaMinDays.value = settings.meta.min_days;
  controls.metaMaxAds.value = settings.meta.max_ads;
  controls.metaAdvertisersDb.value = settings.meta.advertisers_db || '';
  controls.autoClassify.checked = Boolean(settings.auto_classify_after_extract);
}
function setDisabled(flag) { Object.values(controls).forEach((el) => { if ('disabled' in el) el.disabled = flag; }); }
function validateAction(action, settings) {
  if (action === 'extract-foreplay' && !(settings.foreplay.brand_ids || []).length) return 'Add at least one Foreplay brand ID before running extraction.';
  if (action === 'extract-adplexity' && !(settings.adplexity.report_ids || []).length) return 'Add at least one AdPlexity report ID before running extraction.';
  if (action === 'extract-meta') {
    if (settings.meta.mode === 'page' && !settings.meta.page_id) return 'Meta page mode needs a page ID before extraction can start.';
    if (settings.meta.mode === 'batch' && !settings.meta.advertisers_db) return 'Meta batch mode needs an advertisers DB path before extraction can start.';
  }
  if (action === 'full-refresh') {
    const hasForeplay = (settings.foreplay.brand_ids || []).length > 0;
    const hasAdplexity = (settings.adplexity.report_ids || []).length > 0;
    const hasMeta = settings.meta.mode === 'batch' || Boolean(settings.meta.page_id);
    if (!hasForeplay && !hasAdplexity && !hasMeta) return 'Configure at least one extractor before running a full refresh.';
  }
  return '';
}
function describeAction(action, settings) {
  if (action === 'extract-foreplay') return `Run Foreplay winner extraction for ${(settings.foreplay.brand_ids || []).length} brand IDs with a ${settings.foreplay.months}-month lookback?`;
  if (action === 'extract-adplexity') return `Run AdPlexity extraction for ${(settings.adplexity.report_ids || []).length} saved reports?`;
  if (action === 'extract-meta') {
    if (settings.meta.mode === 'page') return `Run Meta extraction for page ${settings.meta.page_id} with max ${settings.meta.max_ads} ads and min ${settings.meta.min_days} running days?`;
    return `Run Meta batch extraction from ${settings.meta.advertisers_db} with max ${settings.meta.max_ads} ads per advertiser?`;
  }
  if (action === 'classify') return 'Run the keyword classifier on unclassified ads now?';
  if (action === 'full-refresh') return 'Run a responsible full refresh? The app will save settings, run one extractor at a time, skip any unconfigured source, and refresh the dashboard when each job finishes.';
  return 'Continue?';
}
function renderJob(job) {
  if (!job) { statusPill.className = 'status-pill idle'; statusPill.textContent = 'Idle'; statusDetail.textContent = 'No job has run yet in this session.'; logBox.textContent = 'Waiting for activity…'; return; }
  statusPill.className = 'status-pill ' + (job.running ? 'running' : job.lastError ? 'error' : 'idle');
  statusPill.textContent = job.running ? 'Running' : job.lastError ? 'Error' : 'Idle';
  statusDetail.textContent = [job.name ? `Action: ${label(job.name)}` : '', job.startedAt ? `Started: ${job.startedAt}` : '', job.finishedAt ? `Finished: ${job.finishedAt}` : '', job.lastResult || '', job.lastError || ''].filter(Boolean).join(' | ') || 'No job has run yet in this session.';
  logBox.textContent = (job.logs && job.logs.length) ? job.logs.join('\\n') : 'Waiting for activity…';
  setDisabled(Boolean(job.running));
}
async function fetchJson(url, options = {}) {
  const response = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed: ${response.status}`);
  return body;
}
async function refreshData() {
  dashboardData = await fetchJson('/api/data');
  lastSeenDataVersion = dashboardData.generatedAt;
  generatedAt.textContent = dashboardData.generatedAt;
  populateFilters(); renderStats(); renderCards();
}
async function refreshState() {
  appState = await fetchJson('/api/state');
  hydrateSettings(appState.settings);
  renderJob(appState.job);
  if (appState.dataVersion && appState.dataVersion !== lastSeenDataVersion) await refreshData();
}
async function postSettings() { await fetchJson('/api/settings', { method: 'POST', body: JSON.stringify(collectSettings()) }); await refreshState(); }
async function runAction(action) {
  try { await fetchJson(`/api/actions/${action}`, { method: 'POST', body: JSON.stringify({ settings: collectSettings() }) }); await refreshState(); }
  catch (error) { alert(error.message); }
}
function renderJob(job) {
  if (!job) {
    statusPill.className = 'status-pill idle';
    statusPill.textContent = 'Idle';
    statusDetail.textContent = 'No job has run yet in this session.';
    logBox.textContent = 'Waiting for activity...';
    return;
  }
  statusPill.className = 'status-pill ' + (job.running ? 'running' : job.lastError ? 'error' : 'idle');
  statusPill.textContent = job.running ? 'Running' : job.lastError ? 'Error' : 'Idle';
  statusDetail.textContent = [job.name ? `Action: ${label(job.name)}` : '', job.startedAt ? `Started: ${job.startedAt}` : '', job.finishedAt ? `Finished: ${job.finishedAt}` : '', job.lastResult || '', job.lastError || ''].filter(Boolean).join(' | ') || 'No job has run yet in this session.';
  logBox.textContent = (job.logs && job.logs.length) ? job.logs.join('\\n') : 'Waiting for activity...';
  setDisabled(Boolean(job.running));
}
async function runAction(action) {
  const settings = collectSettings();
  const validation = validateAction(action, settings);
  if (validation) { alert(validation); return; }
  if (action !== 'refresh' && !window.confirm(describeAction(action, settings))) return;
  try { await fetchJson(`/api/actions/${action}`, { method: 'POST', body: JSON.stringify({ settings }) }); await refreshState(); }
  catch (error) { alert(error.message); }
}
populateFilters(); renderStats(); renderCards();
[sourceFilter, verticalFilter, statusFilter].forEach((el) => el.addEventListener('change', renderCards));
winnerFilter.addEventListener('change', renderCards);
searchFilter.addEventListener('input', renderCards);
if (appMode) {
  appNote.classList.add('hidden'); appControls.classList.remove('hidden');
  controls.saveSettings.addEventListener('click', postSettings);
  controls.refreshData.addEventListener('click', () => runAction('refresh'));
  controls.extractForeplay.addEventListener('click', () => runAction('extract-foreplay'));
  controls.extractAdplexity.addEventListener('click', () => runAction('extract-adplexity'));
  controls.extractMeta.addEventListener('click', () => runAction('extract-meta'));
  controls.classifyAds.addEventListener('click', () => runAction('classify'));
  controls.fullRefresh.addEventListener('click', () => runAction('full-refresh'));
  refreshState().catch((error) => { statusPill.className = 'status-pill error'; statusPill.textContent = 'Error'; statusDetail.textContent = error.message; });
  setInterval(() => { refreshState().catch(() => {}); }, 2500);
} else {
  renderJob(null);
}
</script>
</body>
</html>
"""


def render_html(payload: dict[str, Any]) -> str:
    return HTML_HEAD.replace("__DATA__", json.dumps(payload, ensure_ascii=False)) + HTML_BODY


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Generate or serve the competitive intelligence dashboard app")
    parser.add_argument("--db", default=str(DEFAULT_DB_PATH), help="Unified intelligence DB path")
    parser.add_argument("--out", default=str(DEFAULT_DASHBOARD_PATH), help="Output HTML path")
    parser.add_argument("--serve", action="store_true", help="Serve the generated dashboard locally as an app")
    parser.add_argument("--port", type=int, default=DEFAULT_DASHBOARD_PORT, help="Port for --serve mode")
    parser.add_argument("--settings", default=str(DEFAULT_DASHBOARD_SETTINGS_PATH), help="Settings JSON used in app mode")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    out = build_dashboard(db_path=args.db, out_path=args.out)
    print(f"Dashboard written to {out.resolve()}")
    if args.serve:
        serve_dashboard(out, db_path=args.db, settings_path=args.settings, port=args.port)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
