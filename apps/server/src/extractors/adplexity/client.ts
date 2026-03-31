const API_BASE = "https://app.adplexity.io";
const LOGIN_REFERER = `${API_BASE}/auth/login?to=search`;
const SEARCH_REFERER = `${API_BASE}/search/keyword`;
const PAGE_SIZE = 50;
const MAX_RETRIES = 3;
const RATE_LIMIT_SLEEP_MS = 1000;

const DEFAULT_HEADERS: Record<string, string> = {
  accept: "application/json",
  "accept-language": "en-GB,en-US;q=0.9,en;q=0.8,he;q=0.7",
  "cache-control": "no-cache",
  dnt: "1",
  origin: "https://app.adplexity.io",
  pragma: "no-cache",
  "x-requested-with": "XMLHttpRequest",
  "user-agent": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36"
};

type LogFn = (...parts: unknown[]) => void;

type JsonRecord = Record<string, unknown>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function splitSetCookieHeader(value: string): string[] {
  const items: string[] = [];
  let start = 0;
  let inExpires = false;

  for (let index = 0; index < value.length; index += 1) {
    const remaining = value.slice(index).toLowerCase();
    if (remaining.startsWith("expires=")) {
      inExpires = true;
      continue;
    }

    const current = value[index];
    if (current === ";") {
      inExpires = false;
      continue;
    }

    if (current === "," && !inExpires) {
      const token = value.slice(start, index).trim();
      if (token) {
        items.push(token);
      }
      start = index + 1;
    }
  }

  const tail = value.slice(start).trim();
  if (tail) {
    items.push(tail);
  }
  return items;
}

interface AdplexityRequestOptions {
  params?: Record<string, string | number | boolean | null | undefined>;
  json?: unknown;
  form?: Record<string, string>;
  headers?: Record<string, string>;
  referer?: string;
  dropAjaxHeaders?: boolean;
  allowStatuses?: number[];
}

export interface AdplexityReportRecord {
  id: number;
  name: string;
}

export interface AdplexityListingRecord {
  id: number;
  title?: string;
  title_en?: string;
  advertiser?: string;
  advertiser_name?: string;
  brand?: string;
  thumb_url?: string;
  first_seen?: string;
  last_seen?: string;
  days_total?: number;
  hits_total?: number;
  countries?: unknown;
  meta_status?: number;
  landing_page_url?: string;
  meta_ad_id?: string;
}

export interface AdplexityAdDetailRecord {
  ad?: JsonRecord;
  videos?: Array<{ url?: string }>;
}

export class AdplexityClient {
  private readonly cookies = new Map<string, string>();
  private readonly headers: Record<string, string> = { ...DEFAULT_HEADERS };
  private initialized = false;

  constructor(
    private readonly email: string,
    private readonly password: string,
    private readonly log: LogFn = console.log
  ) {}

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    this.log("Logging in to AdPlexity...");

    await this.seedXsrfToken();
    await this.request("POST", "/members/login", {
      form: {
        amember_login: this.email,
        amember_pass: this.password
      },
      referer: LOGIN_REFERER
    }).then(async (response) => {
      const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!payload.ok) {
        throw new Error(`AdPlexity login failed: ${payload.error ?? "unknown error"}`);
      }
    });

    const sessionResponse = await this.request("POST", "/api/user/session", {
      json: {},
      referer: LOGIN_REFERER,
      allowStatuses: [401, 500]
    });
    if (sessionResponse.status === 401) {
      this.log("AdPlexity session sync returned 401; continuing with authenticated cookies.");
    } else if (sessionResponse.status === 500) {
      this.log("AdPlexity session sync returned 500; continuing with authenticated cookies.");
    }
    this.syncXsrfHeader();
    this.initialized = true;
    this.log("Authenticated successfully");
  }

  async listReports(): Promise<AdplexityReportRecord[]> {
    const response = await this.request("GET", "/api/reports", {
      referer: SEARCH_REFERER
    });
    const payload = (await response.json().catch(() => [])) as unknown;
    if (!Array.isArray(payload)) {
      return [];
    }

    const reports: AdplexityReportRecord[] = [];
    for (const item of payload) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const row = item as JsonRecord;
      const id = Number(row.id);
      if (!Number.isFinite(id)) {
        continue;
      }
      reports.push({
        id,
        name: String(row.name ?? id).trim() || String(id)
      });
    }
    return reports;
  }

  async *iterReportAds(reportId: number): AsyncGenerator<AdplexityListingRecord> {
    let offset = 0;
    while (true) {
      const response = await this.request("POST", "/api/report/show", {
        referer: `${API_BASE}/reports/${reportId}`,
        json: {
          id: reportId,
          count: PAGE_SIZE,
          offset
        }
      });
      const payload = (await response.json().catch(() => ({}))) as { ads?: unknown[] };
      const rows = Array.isArray(payload.ads) ? payload.ads : [];
      if (!rows.length) {
        break;
      }

      this.log(`  report page offset=${offset}: ${rows.length} ads`);

      for (const item of rows) {
        if (!item || typeof item !== "object") {
          continue;
        }
        const row = item as JsonRecord;
        const id = Number(row.id);
        if (!Number.isFinite(id)) {
          continue;
        }
        yield {
          ...(row as unknown as AdplexityListingRecord),
          id
        };
      }

      if (rows.length < PAGE_SIZE) {
        break;
      }
      offset += PAGE_SIZE;
    }
  }

  async getAdDetail(adplexityId: number): Promise<AdplexityAdDetailRecord | null> {
    await sleep(RATE_LIMIT_SLEEP_MS);
    const response = await this.request("GET", `/api/adx/${adplexityId}`, {
      referer: `${API_BASE}/ad/${adplexityId}`,
      allowStatuses: [204, 404]
    });

    if (response.status === 204 || response.status === 404) {
      return null;
    }

    if (response.headers.get("content-length") === "0") {
      return null;
    }

    const payload = (await response.json().catch(() => null)) as AdplexityAdDetailRecord | null;
    if (!payload || typeof payload !== "object") {
      return null;
    }
    return payload;
  }

  private async seedXsrfToken(): Promise<void> {
    const seedHeaders = {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": "same-origin",
      "upgrade-insecure-requests": "1"
    };

    const seedPaths = ["/auth/login?to=search", "/members/login", "/"];
    for (const path of seedPaths) {
      try {
        await this.request("GET", path, {
          headers: seedHeaders,
          referer: LOGIN_REFERER,
          dropAjaxHeaders: true,
          allowStatuses: [401]
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log(`Seed request ${path} failed: ${message}`);
      }

      if (this.cookies.has("XSRF-TOKEN")) {
        break;
      }
    }

    const sessionResponse = await this.request("POST", "/api/user/session", {
      json: {},
      referer: LOGIN_REFERER,
      allowStatuses: [401, 500]
    });
    if (sessionResponse.status === 401) {
      this.log("AdPlexity pre-login session returned 401; continuing.");
    } else if (sessionResponse.status === 500) {
      this.log("AdPlexity pre-login session returned 500; continuing.");
    }
  }

  private syncXsrfHeader(): void {
    const raw = this.cookies.get("XSRF-TOKEN") ?? "";
    if (raw) {
      try {
        this.headers["x-xsrf-token"] = decodeURIComponent(raw);
      } catch {
        this.headers["x-xsrf-token"] = raw;
      }
      return;
    }
    delete this.headers["x-xsrf-token"];
  }

  private getCookieHeader(): string {
    return [...this.cookies.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
  }

  private updateCookies(response: Response): void {
    const headers = response.headers as Headers & {
      getSetCookie?: () => string[];
    };
    const rawValues =
      typeof headers.getSetCookie === "function"
        ? headers.getSetCookie()
        : (() => {
            const raw = response.headers.get("set-cookie");
            return raw ? splitSetCookieHeader(raw) : [];
          })();

    for (const cookie of rawValues) {
      const token = cookie.split(";")[0]?.trim();
      if (!token || !token.includes("=")) {
        continue;
      }
      const index = token.indexOf("=");
      const name = token.slice(0, index).trim();
      const value = token.slice(index + 1).trim();
      if (!name) {
        continue;
      }
      this.cookies.set(name, value);
    }
  }

  private buildUrl(path: string, params?: AdplexityRequestOptions["params"]): string {
    const url = new URL(path, API_BASE);
    if (!params) {
      return url.toString();
    }
    for (const [key, value] of Object.entries(params)) {
      if (value === null || value === undefined) {
        continue;
      }
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private async request(
    method: string,
    path: string,
    options: AdplexityRequestOptions = {}
  ): Promise<Response> {
    let lastError: Error | null = null;
    const allowed = new Set(options.allowStatuses ?? []);
    const url = this.buildUrl(path, options.params);

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        this.syncXsrfHeader();
        const headers: Record<string, string> = {
          ...this.headers,
          ...(options.headers ?? {})
        };
        if (options.dropAjaxHeaders) {
          delete headers.origin;
          delete headers["x-requested-with"];
          delete headers["x-xsrf-token"];
        }
        headers.referer = options.referer || headers.referer || SEARCH_REFERER;

        let body: string | undefined;
        if (options.form) {
          body = new URLSearchParams(options.form).toString();
          headers["content-type"] = "application/x-www-form-urlencoded";
        } else if (options.json !== undefined) {
          body = JSON.stringify(options.json);
          headers["content-type"] = "application/json";
        }

        let response = await this.fetchWithRedirects(url, method, headers, body);

        if (allowed.has(response.status)) {
          return response;
        }

        if (response.status === 429) {
          this.log(`  [retry ${attempt}/${MAX_RETRIES}] 429 rate-limited, sleeping 60s`);
          lastError = new Error("AdPlexity rate limited");
          await sleep(60_000);
          continue;
        }

        if (response.status >= 500) {
          this.log(`  [retry ${attempt}/${MAX_RETRIES}] server error ${response.status}`);
          lastError = new Error(`AdPlexity server error ${response.status}`);
          await sleep(2 ** attempt * 1000);
          continue;
        }

        if (!response.ok) {
          const snippet = (await response.text().catch(() => "")).slice(0, 200);
          throw new Error(`AdPlexity request ${method} ${path} failed: ${response.status} ${snippet}`.trim());
        }

        return response;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.log(`  [retry ${attempt}/${MAX_RETRIES}] network error: ${lastError.message}`);
        await sleep(2 ** attempt * 1000);
      }
    }

    throw new Error(
      `AdPlexity request ${method} ${path} failed after ${MAX_RETRIES} attempts: ${lastError?.message ?? "unknown error"}`
    );
  }

  private async fetchWithRedirects(
    initialUrl: string,
    method: string,
    headers: Record<string, string>,
    body?: string
  ): Promise<Response> {
    let currentUrl = initialUrl;
    let currentMethod = method.toUpperCase();
    let currentBody = body;

    for (let redirectCount = 0; redirectCount <= 10; redirectCount += 1) {
      if (this.headers["x-xsrf-token"]) {
        headers["x-xsrf-token"] = this.headers["x-xsrf-token"];
      } else {
        delete headers["x-xsrf-token"];
      }

      const cookieHeader = this.getCookieHeader();
      if (cookieHeader) {
        headers.cookie = cookieHeader;
      } else {
        delete headers.cookie;
      }

      const response = await fetch(currentUrl, {
        method: currentMethod,
        headers,
        body: currentMethod === "GET" || currentMethod === "HEAD" ? undefined : currentBody,
        signal: AbortSignal.timeout(30_000),
        redirect: "manual"
      });

      this.updateCookies(response);
      this.syncXsrfHeader();

      if (![301, 302, 303, 307, 308].includes(response.status)) {
        return response;
      }

      const location = response.headers.get("location");
      if (!location) {
        return response;
      }
      if (redirectCount >= 10) {
        throw new Error(`Too many redirects while requesting ${initialUrl}`);
      }

      const previousUrl = currentUrl;
      currentUrl = new URL(location, currentUrl).toString();

      if (
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) &&
          currentMethod !== "GET" &&
          currentMethod !== "HEAD")
      ) {
        currentMethod = "GET";
        currentBody = undefined;
        delete headers["content-type"];
      }

      headers.referer = previousUrl;
    }

    throw new Error(`Too many redirects while requesting ${initialUrl}`);
  }
}
