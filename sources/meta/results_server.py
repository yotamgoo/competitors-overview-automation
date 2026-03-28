import json
import sqlite3
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path

DB_PATH = "ads.db"
PORT = 8050


def get_data():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    advertisers = [
        dict(r) for r in conn.execute("SELECT * FROM advertisers ORDER BY name").fetchall()
    ]
    ads = [
        dict(r)
        for r in conn.execute("SELECT * FROM ads ORDER BY running_days DESC").fetchall()
    ]
    stats = {
        "total_ads": len(ads),
        "total_advertisers": len(advertisers),
        "by_source": {},
        "by_media": {},
    }
    for a in ads:
        stats["by_source"][a["source"]] = stats["by_source"].get(a["source"], 0) + 1
        stats["by_media"][a["media_type"]] = stats["by_media"].get(a["media_type"], 0) + 1

    conn.close()
    return advertisers, ads, stats


HTML = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Ad Scraper Results</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f1117; color: #e1e4e8; padding: 24px; }
  h1 { font-size: 22px; margin-bottom: 20px; color: #fff; }
  .stats { display: flex; gap: 16px; margin-bottom: 24px; flex-wrap: wrap; }
  .stat-card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px 20px; min-width: 140px; }
  .stat-card .value { font-size: 28px; font-weight: 700; color: #58a6ff; }
  .stat-card .label { font-size: 12px; color: #8b949e; margin-top: 4px; text-transform: uppercase; letter-spacing: 0.5px; }
  .section { margin-bottom: 28px; }
  .section h2 { font-size: 16px; margin-bottom: 12px; color: #c9d1d9; border-bottom: 1px solid #30363d; padding-bottom: 8px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; padding: 8px 12px; background: #161b22; color: #8b949e; font-weight: 600; text-transform: uppercase; font-size: 11px; letter-spacing: 0.5px; border-bottom: 1px solid #30363d; }
  td { padding: 8px 12px; border-bottom: 1px solid #21262d; }
  tr:hover td { background: #161b22; }
  a { color: #58a6ff; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; }
  .badge-meta { background: #1f3a5f; color: #58a6ff; }
  .badge-foreplay { background: #3b2f1f; color: #f0a840; }
  .badge-adplexity { background: #1f3b2f; color: #56d364; }
  .badge-video { background: #2d1f3b; color: #bc8cff; }
  .badge-image { background: #1f3b35; color: #56d3b0; }
  .text-muted { color: #8b949e; }
  .empty { text-align: center; padding: 40px; color: #8b949e; }
</style>
</head>
<body>
<h1>Ad Scraper Results</h1>
<div class="stats" id="stats"></div>
<div class="section">
  <h2>Ads</h2>
  <table id="ads-table">
    <thead>
      <tr>
        <th>Source</th>
        <th>Library ID</th>
        <th>Advertiser</th>
        <th>Ad Copy</th>
        <th>Headline</th>
        <th>CTA</th>
        <th>Media</th>
        <th>Platforms</th>
        <th>Categories</th>
        <th>Days</th>
        <th>Started</th>
        <th>Landing</th>
        <th>Ad Library</th>
      </tr>
    </thead>
    <tbody id="ads-body"></tbody>
  </table>
</div>
<div class="section">
  <h2>Advertisers</h2>
  <table>
    <thead>
      <tr><th>Name</th><th>Page ID</th><th>Vertical</th><th>Category</th></tr>
    </thead>
    <tbody id="adv-body"></tbody>
  </table>
</div>
<script>
const DATA = __DATA__;

const statsEl = document.getElementById('stats');
const s = DATA.stats;
statsEl.innerHTML = `
  <div class="stat-card"><div class="value">${s.total_ads}</div><div class="label">Total Ads</div></div>
  <div class="stat-card"><div class="value">${s.total_advertisers}</div><div class="label">Advertisers</div></div>
  ${Object.entries(s.by_source).map(([k,v]) => `<div class="stat-card"><div class="value">${v}</div><div class="label">${k}</div></div>`).join('')}
  ${Object.entries(s.by_media).map(([k,v]) => `<div class="stat-card"><div class="value">${v}</div><div class="label">${k}</div></div>`).join('')}
`;

const adsBody = document.getElementById('ads-body');
if (!DATA.ads.length) {
  adsBody.innerHTML = '<tr><td colspan="13" class="empty">No ads yet.</td></tr>';
} else {
  function trunc(s, n) { s = s || ''; return s.length > n ? s.substring(0, n) + '…' : s; }
  adsBody.innerHTML = DATA.ads.map(a => `<tr>
    <td><span class="badge badge-${a.source}">${a.source}</span></td>
    <td class="text-muted">${a.source_id}</td>
    <td>${a.advertiser_name || '<span class="text-muted">—</span>'}</td>
    <td title="${(a.ad_copy||'').replace(/"/g,'&quot;')}">${trunc(a.ad_copy, 50)}</td>
    <td title="${(a.headline||'').replace(/"/g,'&quot;')}">${trunc(a.headline, 40)}</td>
    <td>${a.cta || '<span class="text-muted">—</span>'}</td>
    <td><span class="badge badge-${a.media_type}">${a.media_type}</span></td>
    <td class="text-muted">${a.platforms || '—'}</td>
    <td class="text-muted">${a.categories || '—'}</td>
    <td>${a.running_days}</td>
    <td class="text-muted">${a.started_running_date || '—'}</td>
    <td>${a.landing_url ? '<a href="'+a.landing_url+'" target="_blank">'+(a.landing_domain||'LP')+'</a>' : (a.landing_domain || '<span class="text-muted">—</span>')}</td>
    <td>${a.ad_link ? '<a href="'+a.ad_link+'" target="_blank">View</a>' : '—'}</td>
  </tr>`).join('');
}

const advBody = document.getElementById('adv-body');
if (!DATA.advertisers.length) {
  advBody.innerHTML = '<tr><td colspan="4" class="empty">No advertisers seeded yet.</td></tr>';
} else {
  advBody.innerHTML = DATA.advertisers.map(a => `<tr>
    <td>${a.name}</td>
    <td class="text-muted">${a.page_id}</td>
    <td>${a.vertical || '—'}</td>
    <td>${a.category || '—'}</td>
  </tr>`).join('');
}
</script>
</body>
</html>"""


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        advertisers, ads, stats = get_data()
        data_json = json.dumps({"advertisers": advertisers, "ads": ads, "stats": stats})
        html = HTML.replace("__DATA__", data_json)
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(html.encode())

    def log_message(self, format, *args):
        pass


class ReusableHTTPServer(HTTPServer):
    allow_reuse_address = True
    allow_reuse_port = True


def main():
    print(f"Results server running at http://localhost:{PORT}")
    ReusableHTTPServer(("", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
