
import os
import re
import sys
import time
from dataclasses import asdict, dataclass
from datetime import date, datetime
from pathlib import Path
from shutil import which
from typing import Callable, Dict, List, Optional
from urllib.parse import quote_plus

import requests
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.action_chains import ActionChains
from webdriver_manager.chrome import ChromeDriverManager

US_COUNTRY_CODE = "US"
MEDIA_DIR = Path("media")
IMAGES_DIR = MEDIA_DIR / "images"
VIDEOS_DIR = MEDIA_DIR / "videos"


@dataclass
class AdRecord:
    library_id: str
    advertiser: str
    started_running_date: str
    running_days: int
    ad_copy: str
    headline: str
    cta: str
    media_type: str
    media_file: str
    media_path: str
    ad_link: str
    landing_url: str
    landing_domain: str
    platforms: str
    categories: str
    search_term: str
    scraped_at: str


def build_search_url(search_query: str, page_id: str = "") -> str:
    if page_id:
        q = quote_plus(search_query.strip()) if search_query.strip() else ""
        return (
            "https://www.facebook.com/ads/library/"
            "?active_status=active"
            "&ad_type=all"
            f"&country={US_COUNTRY_CODE}"
            f"&view_all_page_id={page_id}"
            + (f"&q={q}" if q else "")
            + "&search_type=page"
        )
    return (
        "https://www.facebook.com/ads/library/"
        "?active_status=active"
        "&ad_type=all"
        f"&country={US_COUNTRY_CODE}"
        f"&q={quote_plus(search_query.strip())}"
        "&search_type=keyword_unordered"
    )


def resolve_chromedriver() -> str:
    explicit = os.getenv("CHROMEDRIVER_PATH", "").strip()
    if explicit:
        if os.path.exists(explicit):
            return explicit
        raise RuntimeError(f"CHROMEDRIVER_PATH does not exist: {explicit}")

    local = which("chromedriver")
    if local:
        return local

    try:
        return ChromeDriverManager().install()
    except Exception as exc:
        raise RuntimeError(
            "Could not locate/download ChromeDriver. Connect to the internet once, "
            "or set CHROMEDRIVER_PATH to a local chromedriver path."
        ) from exc


def resolve_chrome_binary() -> str | None:
    explicit = os.getenv("CHROME_BINARY_PATH", "").strip() or os.getenv("GOOGLE_CHROME_BIN", "").strip()
    if explicit:
        if os.path.exists(explicit):
            return explicit
        raise RuntimeError(f"CHROME_BINARY_PATH does not exist: {explicit}")

    command_names = (
        "google-chrome",
        "chrome",
        "chromium",
        "chromium-browser",
    )
    for name in command_names:
        resolved = which(name)
        if resolved:
            return resolved

    if sys.platform == "darwin":
        mac_candidates = (
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
        )
        for candidate in mac_candidates:
            if os.path.exists(candidate):
                return candidate

    return None


def build_driver() -> webdriver.Chrome:
    opts = Options()
    opts.add_argument("--start-maximized")
    opts.add_argument("--disable-blink-features=AutomationControlled")
    opts.add_experimental_option("excludeSwitches", ["enable-automation"])
    opts.add_experimental_option("useAutomationExtension", False)
    chrome_binary = resolve_chrome_binary()
    if chrome_binary:
        opts.binary_location = chrome_binary

    driver = webdriver.Chrome(service=Service(resolve_chromedriver()), options=opts)
    driver.execute_script(
        "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})"
    )
    return driver


def parse_meta_date(raw: str) -> Optional[date]:
    clean = re.sub(r"\s+", " ", (raw or "").strip())
    if not clean:
        return None

    patterns = [
        "%b %d, %Y",
        "%B %d, %Y",
        "%b %d %Y",
        "%B %d %Y",
        "%d %b %Y",
        "%d %B %Y",
    ]
    for fmt in patterns:
        try:
            return datetime.strptime(clean, fmt).date()
        except ValueError:
            continue
    return None


def normalize_media_type(value: str) -> str:
    v = (value or "").strip().lower()
    if v in {"image", "video"}:
        return v
    return "unknown"

def build_icon_map(
    driver: webdriver.Chrome,
    log: Callable[[str], None] = print,
) -> Dict[str, str]:
    """Hover each unique sprite icon in Platform/Category rows to read tooltip text.

    Returns a dict mapping mask-position string -> tooltip name, e.g.
    {"-387px -792px": "Facebook", "-387px -922px": "Financial products and services"}
    """
    unique_icons = driver.execute_script(r"""
    const seen = new Map();
    const allMask = Array.from(
      document.querySelectorAll('div[style*="mask-image"][style*="mask-position"]')
    );
    for (let i = 0; i < allMask.length; i++) {
      const d = allMask[i];
      const style = d.getAttribute('style') || '';
      const posMatch = style.match(/mask-position:\s*([^;]+)/);
      if (!posMatch) continue;
      const pos = posMatch[1].trim();
      if (seen.has(pos)) continue;
      // Only keep icons inside Platforms or Categories rows
      let section = '';
      let parent = d;
      for (let j = 0; j < 10; j++) {
        parent = parent.parentElement;
        if (!parent) break;
        const spans = parent.querySelectorAll(':scope > span');
        for (const s of spans) {
          const t = s.textContent.trim();
          if (t === 'Platforms' || t === 'Categories') { section = t; break; }
        }
        if (section) break;
      }
      if (section) seen.set(pos, i);
    }
    return Array.from(seen.entries()).map(([pos, idx]) => ({pos, idx}));
    """)

    if not unique_icons:
        return {}

    icon_map = {}
    for item in unique_icons:
        pos = item["pos"]
        idx = item["idx"]

        elem = driver.execute_script(
            "return document.querySelectorAll("
            "'div[style*=\"mask-image\"][style*=\"mask-position\"]'"
            f")[{idx}];"
        )
        if not elem:
            continue

        driver.execute_script(
            "arguments[0].scrollIntoView({block: 'center'});", elem
        )
        time.sleep(0.3)

        ActionChains(driver).move_to_element(elem).perform()
        time.sleep(0.8)

        tooltip = driver.execute_script(
            "const t = document.querySelector('[role=\"tooltip\"]');"
            "return t ? t.textContent.trim() : '';"
        )
        if tooltip:
            icon_map[pos] = tooltip

        # Dismiss tooltip by moving away
        try:
            body = driver.find_element("tag name", "body")
            ActionChains(driver).move_to_element_with_offset(body, 10, 10).perform()
        except Exception:
            pass
        time.sleep(0.2)

    if icon_map:
        log(f"Icon map: {icon_map}")
    return icon_map


def extract_card_candidates(
    driver: webdriver.Chrome,
    icon_map: Dict[str, str] = None,
) -> List[Dict[str, str]]:
    if icon_map is None:
        icon_map = {}

    script = r"""
const CTA_WORDS = new Set([
  "learn more", "apply now", "get quote", "sign up", "shop now", "book now",
  "contact us", "get offer", "download", "watch more", "send message",
  "get started", "subscribe", "see menu", "call now", "request time", "order now"
]);

const DURATION_RE = /^\d+:\d+\s*[\/|]\s*\d+:\d+$/;
const ZWS = /^\u200b+$/;
const SKIP_LINES = new Set([
  "See ad details", "See summary details", "This ad has multiple versions",
  "Open Dropdown", "Platforms", "Categories", "Sponsored", "Active",
  "Ad Details", "Close", "About the advertiser", "About ads and data use"
]);

function isJunk(line) {
  if (!line || ZWS.test(line)) return true;
  if (SKIP_LINES.has(line)) return true;
  if (DURATION_RE.test(line)) return true;
  if (/^\d+ ads use this creative/i.test(line)) return true;
  if (/^Library ID:/i.test(line)) return true;
  if (/^Started running on/i.test(line)) return true;
  if (/^\d+ of \d+$/.test(line)) return true;
  return false;
}

function parseCard(card) {
  const text = card.innerText || '';
  const lines = text.split('\n').map(s => s.trim()).filter(Boolean);

  const idMatch = text.match(/Library ID:\s*(\d+)/i);
  const startMatch = text.match(/Started running on\s+([^\n]+)/i);

  // --- Advertiser ---
  // Primary: img[alt] near the advertiser profile pic (small 30x30 image)
  let advertiser = "";
  const profileImgs = Array.from(card.querySelectorAll('img[alt]'));
  for (const img of profileImgs) {
    const alt = (img.alt || '').trim();
    if (!alt) continue;
    // Profile pic is small (< 60px) and near "Sponsored" text
    if (img.width <= 60 && img.height <= 60 && alt.length > 1) {
      advertiser = alt;
      break;
    }
  }
  // Fallback: page link text (link to facebook.com/<page>)
  if (!advertiser) {
    const pageLinks = Array.from(card.querySelectorAll('a[href*="facebook.com/"]'));
    for (const a of pageLinks) {
      const href = a.href || '';
      const linkText = (a.textContent || '').trim();
      if (linkText && !href.includes('/ads/library') && !href.includes('l.facebook.com')
          && linkText.length > 1 && linkText.length < 80) {
        advertiser = linkText;
        break;
      }
    }
  }
  // Final fallback: line after "See ad details"
  if (!advertiser) {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] === "See ad details" || lines[i] === "See summary details") {
        if (i + 1 < lines.length && !isJunk(lines[i + 1])) {
          advertiser = lines[i + 1];
          break;
        }
      }
    }
  }

  // --- CTA ---
  let cta = "";
  for (const line of lines) {
    if (CTA_WORDS.has(line.toLowerCase())) { cta = line; }
  }

  // --- Platforms & Categories: extract mask-positions for resolution in Python ---
  let platformPositions = [];
  let categoryPositions = [];
  const allDivs = Array.from(card.querySelectorAll('div'));

  for (const row of allDivs) {
    const spans = row.querySelectorAll(':scope > span');
    let label = '';
    for (const s of spans) {
      const t = s.textContent.trim();
      if (t === 'Platforms' || t === 'Categories') { label = t; break; }
    }
    if (!label) continue;

    const maskDivs = Array.from(row.querySelectorAll('div[style*="mask-image"]'));
    const positions = [];
    for (const d of maskDivs) {
      const style = d.getAttribute('style') || '';
      const posMatch = style.match(/mask-position:\s*([^;]+)/);
      if (posMatch) positions.push(posMatch[1].trim());
    }
    if (label === 'Platforms' && !platformPositions.length) platformPositions = positions;
    else if (label === 'Categories' && !categoryPositions.length) categoryPositions = positions;
    if (platformPositions.length && categoryPositions.length) break;
  }

  // --- Ad copy + headline + landing domain ---
  let adCopy = "";
  let headline = "";
  let landingDomain = "";
  const sponsoredIdx = lines.indexOf("Sponsored");
  if (sponsoredIdx >= 0) {
    const contentLines = [];
    for (const ln of lines.slice(sponsoredIdx + 1)) {
      if (isJunk(ln)) continue;
      if (ln === cta) continue;
      if (ln === advertiser) continue;
      contentLines.push(ln);
    }
    // Layout: adCopy, [DOMAIN.COM], headline, [description]
    for (let i = 0; i < contentLines.length; i++) {
      const ln = contentLines[i];
      // Domain: all-uppercase with a dot (e.g. ALLSTATE.COM)
      if (/^[A-Z0-9][A-Z0-9\-]*\.[A-Z0-9\.\-]+$/.test(ln)) {
        landingDomain = ln;
        continue;
      }
      if (!adCopy) {
        adCopy = ln;
      } else if (!headline) {
        headline = ln;
      }
    }
  }

  // --- Landing URL ---
  let landing_url = "";
  const anchors = Array.from(card.querySelectorAll('a[href]'));
  for (const a of anchors) {
    const href = a.href || '';
    const uMatch = href.match(/[?&]u=(https?[^&]+)/);
    if (uMatch) {
      landing_url = decodeURIComponent(uMatch[1]);
      break;
    }
    if (href.startsWith('http') && !href.includes('facebook.com') && !href.includes('fb.com')) {
      landing_url = href;
      break;
    }
  }

  // --- Media ---
  const video = card.querySelector('video');
  const sourceEl = video ? video.querySelector('source[src]') : null;
  const imgs = Array.from(card.querySelectorAll('img[src]'));

  let media_type = 'unknown';
  let media_url = '';

  if (video && (video.currentSrc || video.src || (sourceEl && sourceEl.src))) {
    media_type = 'video';
    media_url = video.currentSrc || video.src || (sourceEl ? sourceEl.src : '') || '';
  } else {
    const candidate = imgs.reverse().find((img) => {
      const src = img.src || '';
      return src.startsWith('http') && !src.includes('emoji') && !src.includes('profile');
    });
    if (candidate && candidate.src) {
      media_type = 'image';
      media_url = candidate.src;
    } else {
      const bgEl = Array.from(card.querySelectorAll('[style*="background-image"]'))
        .find((el) => (el.getAttribute('style') || '').includes('url('));
      if (bgEl) {
        const style = bgEl.getAttribute('style') || '';
        const m = style.match(/url\(["']?([^"')]+)["']?\)/i);
        if (m && m[1]) {
          media_type = 'image';
          media_url = m[1];
        }
      }
    }
  }

  return {
    library_id: idMatch ? idMatch[1] : "",
    started_running_text: startMatch ? startMatch[1].trim() : "",
    advertiser,
    ad_copy: adCopy,
    headline,
    cta,
    platform_positions: platformPositions,
    category_positions: categoryPositions,
    landing_domain: landingDomain,
    landing_url,
    media_type,
    media_url,
  };
}

let cards = Array.from(document.querySelectorAll('div[role="article"]'))
  .filter((el) => (el.innerText || '').includes('Library ID:'));

if (!cards.length) {
  const byId = {};
  for (const el of document.querySelectorAll('div')) {
    const t = el.innerText || '';
    if (!t.includes('Library ID:')) continue;
    if (!el.querySelector('video, img, [style*="background-image"]')) continue;
    const idMatches = t.match(/Library ID:/g);
    if (!idMatches || idMatches.length !== 1) continue;
    const m = t.match(/Library ID:\s*(\d+)/);
    if (!m) continue;
    const id = m[1];
    if (!byId[id] || t.length < byId[id].innerText.length) {
      byId[id] = el;
    }
  }
  cards = Object.values(byId);
}

return cards.map(parseCard);
"""
    raw = driver.execute_script(script)
    if not isinstance(raw, list):
        return []

    results = []
    for card in raw:
        if not isinstance(card, dict):
            continue
        # Resolve platform/category icon positions to names
        plat_names = []
        for pos in card.pop("platform_positions", []):
            name = icon_map.get(pos, "")
            if name:
                plat_names.append(name)
        card["platforms"] = ", ".join(plat_names)

        cat_names = []
        for pos in card.pop("category_positions", []):
            name = icon_map.get(pos, "")
            if name:
                cat_names.append(name)
        card["categories"] = ", ".join(cat_names)

        results.append(card)

    return results


def build_requests_session(driver: webdriver.Chrome) -> requests.Session:
    session = requests.Session()
    user_agent = driver.execute_script("return navigator.userAgent")
    session.headers.update({"User-Agent": user_agent})

    for cookie in driver.get_cookies():
        session.cookies.set(
            cookie.get("name", ""),
            cookie.get("value", ""),
            domain=cookie.get("domain"),
            path=cookie.get("path", "/"),
        )

    return session


def extension_for_media(media_type: str) -> str:
    media_type = normalize_media_type(media_type)
    return ".mp4" if media_type == "video" else ".jpg"


def download_media(
    session: requests.Session,
    media_url: str,
    media_type: str,
    library_id: str,
    base_dir: Path,
    log: Callable[[str], None],
) -> str:
    media_type = normalize_media_type(media_type)
    if media_type not in {"image", "video"}:
        raise RuntimeError(f"Unsupported media type for download: {media_type}")

    target_dir = base_dir / (VIDEOS_DIR if media_type == "video" else IMAGES_DIR)
    target_dir.mkdir(parents=True, exist_ok=True)

    resp = session.get(media_url, timeout=30, stream=True)
    resp.raise_for_status()

    ext = extension_for_media(media_type)
    filename = f"{library_id}{ext}"
    target_path = target_dir / filename

    with open(target_path, "wb") as f:
        for chunk in resp.iter_content(chunk_size=1024 * 256):
            if chunk:
                f.write(chunk)

    rel = target_path.relative_to(base_dir).as_posix()
    log(f"Downloaded {media_type}: {rel}")
    return rel

def scrape_ads(
    search_query: str,
    running_duration_days: int,
    media_type_filter: str,
    number_of_ads: int,
    base_dir: Path,
    log: Callable[[str], None],
    page_id: str = "",
) -> List[AdRecord]:
    if not search_query.strip() and not page_id.strip():
        raise ValueError("Either search query or page_id is required.")
    if running_duration_days < 0:
        raise ValueError("Running duration must be 0 or greater.")
    if number_of_ads <= 0:
        raise ValueError("Number of ads must be greater than 0.")

    selected_media = media_type_filter.strip().lower()
    if selected_media not in {"image", "video", "both"}:
        raise ValueError("Media type must be Image, Video, or Both.")

    url = build_search_url(search_query, page_id=page_id)
    today = date.today()
    scraped_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    records: List[AdRecord] = []
    seen_ids = set()
    stats = {
        "cards_seen": 0,
        "missing_id": 0,
        "duplicate_id": 0,
        "unparsed_date": 0,
        "duration_filtered": 0,
        "unknown_media": 0,
        "media_mismatch": 0,
        "missing_media_url": 0,
        "download_failed": 0,
    }

    driver = build_driver()
    try:
        log(f"Opening Meta Ads Library for US: {page_id or search_query}")

        # Load page with retry on transient errors (529 overloaded, timeouts)
        for attempt in range(3):
            try:
                driver.get(url)
                time.sleep(5)
                break
            except Exception as exc:
                if attempt < 2:
                    wait = 10 * (attempt + 1)
                    log(f"Page load failed ({exc}), retrying in {wait}s...")
                    time.sleep(wait)
                else:
                    raise

        for _ in range(10):
            body_text = driver.execute_script("return document.body ? document.body.innerText : ''") or ""
            if "Library ID:" in body_text:
                break
            driver.execute_script("window.scrollTo(0, document.body.scrollHeight * 0.35);")
            time.sleep(1.5)

        # Build sprite icon map (platforms/categories) via hover tooltips
        icon_map = build_icon_map(driver, log=log)

        session = build_requests_session(driver)
        stagnation = 0

        for _ in range(40):
            card_candidates = extract_card_candidates(driver, icon_map=icon_map)
            stats["cards_seen"] += len(card_candidates)
            before = len(records)

            for card in card_candidates:
                library_id = (card.get("library_id") or "").strip()
                if not library_id:
                    stats["missing_id"] += 1
                    continue
                if library_id in seen_ids:
                    stats["duplicate_id"] += 1
                    continue
                seen_ids.add(library_id)

                start_text = (card.get("started_running_text") or "").strip()
                started_date = parse_meta_date(start_text)
                if not started_date:
                    stats["unparsed_date"] += 1
                    continue

                running_days = (today - started_date).days
                if running_days < running_duration_days:
                    stats["duration_filtered"] += 1
                    continue

                media_type = normalize_media_type(card.get("media_type", ""))
                if media_type not in {"image", "video"}:
                    stats["unknown_media"] += 1
                    continue

                if selected_media != "both" and media_type != selected_media:
                    stats["media_mismatch"] += 1
                    continue

                media_url = (card.get("media_url") or "").strip()
                if not media_url:
                    stats["missing_media_url"] += 1
                    continue

                try:
                    media_path = download_media(
                        session=session,
                        media_url=media_url,
                        media_type=media_type,
                        library_id=library_id,
                        base_dir=base_dir,
                        log=log,
                    )
                except Exception as exc:
                    stats["download_failed"] += 1
                    log(f"Skip {library_id}: failed to download media ({exc})")
                    continue

                ad_link = f"https://www.facebook.com/ads/library/?id={library_id}"
                record = AdRecord(
                    library_id=library_id,
                    advertiser=(card.get("advertiser") or "").strip(),
                    started_running_date=started_date.isoformat(),
                    running_days=running_days,
                    ad_copy=(card.get("ad_copy") or "").strip(),
                    headline=(card.get("headline") or "").strip(),
                    cta=(card.get("cta") or "").strip(),
                    media_type=media_type,
                    media_file=media_path,
                    media_path=media_path,
                    ad_link=ad_link,
                    landing_url=(card.get("landing_url") or "").strip(),
                    landing_domain=(card.get("landing_domain") or "").strip(),
                    platforms=(card.get("platforms") or "").strip(),
                    categories=(card.get("categories") or "").strip(),
                    search_term=search_query.strip(),
                    scraped_at=scraped_at,
                )
                records.append(record)
                log(
                    f"Collected [{len(records)}/{number_of_ads}] {record.advertiser} | "
                    f"{record.library_id} | {record.media_type} | {record.running_days} days"
                )

                if len(records) >= number_of_ads:
                    break

            if len(records) >= number_of_ads:
                break

            if len(records) == before:
                stagnation += 1
            else:
                stagnation = 0

            if stagnation >= 6:
                break

            driver.execute_script("window.scrollTo(0, document.body.scrollHeight);")
            time.sleep(2)

    finally:
        driver.quit()

    if not records:
        summary = (
            f"No ads matched your filters. cards_seen={stats['cards_seen']}, "
            f"missing_id={stats['missing_id']}, unparsed_date={stats['unparsed_date']}, "
            f"duration_filtered={stats['duration_filtered']}, unknown_media={stats['unknown_media']}, "
            f"media_mismatch={stats['media_mismatch']}, missing_media_url={stats['missing_media_url']}, "
            f"download_failed={stats['download_failed']}"
        )
        raise RuntimeError(summary)

    return records
