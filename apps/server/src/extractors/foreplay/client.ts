const API_BASE = "https://api.foreplay.co";
const PAGE_SIZE = 100;
const MAX_RETRIES = 3;
const RATE_LIMIT_BUFFER = 5;
const FIREBASE_API_KEY = "AIzaSyCIn3hB6C5qsx5L_a_V17n08eJ24MeqYDg";
const FIREBASE_VERIFY_URL = `https://www.googleapis.com/identitytoolkit/v3/relyingparty/verifyPassword?key=${FIREBASE_API_KEY}`;
const FIREBASE_REFRESH_URL = `https://securetoken.googleapis.com/v1/token?key=${FIREBASE_API_KEY}`;

const DEFAULT_HEADERS: Record<string, string> = {
  accept: "application/json, text/plain, */*",
  "accept-language": "en-GB,en-US;q=0.9,en;q=0.8,he;q=0.7",
  "cache-control": "no-cache",
  dnt: "1",
  origin: "https://app.foreplay.co",
  pragma: "no-cache",
  referer: "https://app.foreplay.co/",
  "sec-ch-ua": '"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"',
  "sec-ch-ua-mobile": "?0",
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-site",
  "user-agent": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36"
};

const DAY_MS = 24 * 60 * 60 * 1000;
const FIRESTORE_RUN_QUERY_URL =
  "https://firestore.googleapis.com/v1/projects/adison-foreplay/databases/(default)/documents:runQuery";
const FIRESTORE_BRAND_DOCS_BASE_URL =
  "https://firestore.googleapis.com/v1/projects/adison-foreplay/databases/(default)/documents/brands";

type LogFn = (...parts: unknown[]) => void;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ForeplayBrandRecord {
  id?: string;
  name?: string;
  adLibraryId?: string | number | null;
  spyder_socials_page_id?: string | number | null;
  url?: string | null;
}

export interface ForeplayAdCardRecord {
  thumbnail?: string | null;
  image?: string | null;
  video?: string | null;
  description?: string | null;
  cta_text?: string | null;
}

export interface ForeplayAdRecord {
  id?: string;
  ad_id?: number | null;
  brandId?: string | null;
  collationId?: string | null;
  collationCount?: number | null;
  live?: boolean;
  startedRunning?: number | null;
  end_date?: number | null;
  name?: string | null;
  headline?: string | null;
  description?: string | null;
  link_url?: string | null;
  display_format?: string | null;
  image?: string | null;
  avatar?: string | null;
  cta_title?: string | null;
  cta_type?: string | null;
  publisher_platform?: string[] | string | null;
  cards?: ForeplayAdCardRecord[] | null;
}

export interface CreativeTestAggregation {
  date: string;
  count?: number;
  liveCount?: number;
}

interface FirebaseLoginResponse {
  idToken: string;
  refreshToken?: string;
  expiresIn?: string;
}

interface FirebaseRefreshResponse {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
  expires_in?: string;
}

interface FirestoreStringField {
  stringValue?: string;
}

interface FirestoreRunQueryDocument {
  fields?: Record<string, FirestoreStringField>;
}

interface FirestoreRunQueryRow {
  document?: FirestoreRunQueryDocument;
}

interface FirestoreDocumentResponse {
  fields?: Record<string, FirestoreStringField>;
}

export class ForeplayClient {
  private readonly log: LogFn;
  private refreshToken: string | null = null;
  private tokenExpiresAt = 0;
  private authHeaders: Record<string, string>;

  constructor(
    private readonly email: string,
    private readonly password: string,
    log: LogFn = console.log
  ) {
    this.log = log;
    this.authHeaders = { ...DEFAULT_HEADERS };
  }

  async initialize(): Promise<void> {
    this.log("Authenticating with Firebase...");
    const auth = await this.firebaseLogin(this.email, this.password);
    this.authHeaders.authorization = `Bearer ${auth.idToken}`;
    this.refreshToken = auth.refreshToken ?? null;
    this.tokenExpiresAt = Date.now() + Number(auth.expiresIn ?? "3600") * 1000 - 60_000;
    this.log("Authenticated successfully");
  }

  async *iterAds(options: {
    brandId: string;
    startedAfter?: number;
    startedBefore?: number;
  }): AsyncGenerator<ForeplayAdRecord> {
    const params: Record<string, string> = {
      "orBrands[]": options.brandId,
      sort: "longest",
      spyder: "true",
      size: String(PAGE_SIZE)
    };

    if (typeof options.startedAfter === "number") {
      params.startedRunningStart = String(options.startedAfter);
    }
    if (typeof options.startedBefore === "number") {
      params.startedRunningEnd = String(options.startedBefore);
    }

    let cursor: string | null = null;
    let page = 0;

    while (true) {
      page += 1;
      const response: { results?: ForeplayAdRecord[]; nextPage?: unknown } = await this.request(
        "GET",
        "/ads/discovery",
        cursor ? { ...params, next: cursor } : params
      );
      const results = response.results ?? [];
      if (!results.length) {
        break;
      }

      this.log(`  page ${page}: ${results.length} ads`);
      for (const ad of results) {
        yield ad;
      }

      if (!response.nextPage) {
        break;
      }
      cursor = String(response.nextPage);
    }
  }

  async getCreativeTestDates(brandId: string): Promise<CreativeTestAggregation[]> {
    const aggregations: CreativeTestAggregation[] = [];
    let cursor: string | null = null;

    while (true) {
      const response: {
        aggregations?: CreativeTestAggregation[];
        nextId?: string | null;
      } = await this.request("GET", `/brands/creative-tests/${brandId}`, cursor ? { next: cursor } : undefined);

      const batch = response.aggregations ?? [];
      aggregations.push(...batch);

      if (!response.nextId || !batch.length) {
        break;
      }
      cursor = response.nextId;
    }

    return aggregations;
  }

  async *iterBrands(): AsyncGenerator<ForeplayBrandRecord> {
    let cursor: string | null = null;

    while (true) {
      const response: { results?: ForeplayBrandRecord[]; nextPage?: unknown } = await this.request(
        "GET",
        "/brands/discovery",
        cursor ? { sort: "subscriberCount", next: cursor } : { sort: "subscriberCount" }
      );
      const results = response.results ?? [];
      if (!results.length) {
        break;
      }

      for (const brand of results) {
        yield brand;
      }

      if (!response.nextPage) {
        break;
      }
      cursor = typeof response.nextPage === "string" ? response.nextPage : JSON.stringify(response.nextPage);
    }
  }

  async getDcoThumbnail(options: {
    brandId: string;
    collationId?: string | null;
    fbAdId?: number | null;
    startedRunning?: number | null;
  }): Promise<string | null> {
    const extractImage = (results: ForeplayAdRecord[], targetFbAdId?: number | null): string | null => {
      for (const ad of results) {
        if (targetFbAdId && ad.ad_id !== targetFbAdId) {
          continue;
        }
        const firstCard = ad.cards?.[0];
        const url = firstCard?.thumbnail || firstCard?.image || ad.image;
        if (url) {
          return url;
        }
      }
      return null;
    };

    try {
      if (options.collationId) {
        const response: { results?: ForeplayAdRecord[] } = await this.request("GET", "/ads/discovery", {
          "orBrands[]": options.brandId,
          collationId: options.collationId
        });
        const match = extractImage(response.results ?? []);
        if (match) {
          return match;
        }
      }

      if (options.fbAdId && options.startedRunning) {
        const response: { results?: ForeplayAdRecord[] } = await this.request("GET", "/ads/discovery", {
          "orBrands[]": options.brandId,
          startedRunningStart: String(options.startedRunning),
          startedRunningEnd: String(options.startedRunning + DAY_MS - 1),
          spyder: "true",
          size: "100"
        });
        const match = extractImage(response.results ?? [], options.fbAdId);
        if (match) {
          return match;
        }
      }
    } catch {
      return null;
    }

    return null;
  }

  async resolveBrandIdFromPageId(pageId: string): Promise<string | null> {
    const normalizedPageId = String(pageId ?? "").trim();
    if (!normalizedPageId || !/^\d+$/.test(normalizedPageId)) {
      return null;
    }

    await this.ensureToken();
    const payload = {
      structuredQuery: {
        from: [{ collectionId: "fb_ads_page_track" }],
        where: {
          fieldFilter: {
            field: { fieldPath: "pageId" },
            op: "EQUAL",
            value: { stringValue: normalizedPageId }
          }
        },
        limit: 1
      }
    };

    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        const response = await fetch(FIRESTORE_RUN_QUERY_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "https://app.foreplay.co",
            referer: "https://app.foreplay.co/",
            authorization: this.authHeaders.authorization
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(20_000)
        });

        if (response.status >= 500) {
          this.log(`  [retry ${attempt}/${MAX_RETRIES}] firestore error ${response.status}`);
          await sleep(2 ** attempt * 1000);
          lastError = new Error(`Firestore server error ${response.status}`);
          continue;
        }

        if (!response.ok) {
          throw new Error(`Firestore runQuery failed: ${response.status}`);
        }

        const rows = (await response.json()) as FirestoreRunQueryRow[];
        for (const row of rows) {
          const brandId = row.document?.fields?.brandId?.stringValue?.trim();
          if (brandId) {
            return brandId;
          }
        }

        return null;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.log(`  [retry ${attempt}/${MAX_RETRIES}] firestore network error: ${lastError.message}`);
        await sleep(2 ** attempt * 1000);
      }
    }

    this.log(`  firestore page-id lookup failed: ${lastError?.message ?? "unknown error"}`);
    return null;
  }

  async resolveBrandNameFromBrandId(brandId: string): Promise<string | null> {
    const normalizedBrandId = String(brandId ?? "").trim();
    if (!normalizedBrandId) {
      return null;
    }

    await this.ensureToken();
    const endpoint = `${FIRESTORE_BRAND_DOCS_BASE_URL}/${encodeURIComponent(normalizedBrandId)}`;

    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        const response = await fetch(endpoint, {
          method: "GET",
          headers: {
            origin: "https://app.foreplay.co",
            referer: "https://app.foreplay.co/",
            authorization: this.authHeaders.authorization
          },
          signal: AbortSignal.timeout(20_000)
        });

        if (response.status === 404) {
          return null;
        }

        if (response.status >= 500) {
          this.log(`  [retry ${attempt}/${MAX_RETRIES}] firestore brand lookup error ${response.status}`);
          await sleep(2 ** attempt * 1000);
          lastError = new Error(`Firestore brand lookup server error ${response.status}`);
          continue;
        }

        if (!response.ok) {
          throw new Error(`Firestore brand lookup failed: ${response.status}`);
        }

        const doc = (await response.json()) as FirestoreDocumentResponse;
        const name = doc.fields?.name?.stringValue?.trim();
        if (name) {
          return name;
        }
        const sortName = doc.fields?.sortName?.stringValue?.trim();
        if (sortName) {
          return sortName;
        }
        return null;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.log(`  [retry ${attempt}/${MAX_RETRIES}] firestore brand lookup network error: ${lastError.message}`);
        await sleep(2 ** attempt * 1000);
      }
    }

    this.log(`  firestore brand-name lookup failed: ${lastError?.message ?? "unknown error"}`);
    return null;
  }

  private async ensureToken(): Promise<void> {
    if (!this.refreshToken || Date.now() < this.tokenExpiresAt) {
      return;
    }

    this.log("Refreshing auth token...");
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.refreshToken
    });
    const response = await fetch(FIREBASE_REFRESH_URL, {
      method: "POST",
      body,
      headers: {
        origin: "https://app.foreplay.co",
        referer: "https://app.foreplay.co/",
        "x-client-version": "Chrome/JsCore/8.10.1/FirebaseCore-web"
      }
    });

    if (!response.ok) {
      throw new Error(`Foreplay token refresh failed: ${response.status}`);
    }

    const data = (await response.json()) as FirebaseRefreshResponse;
    const nextToken = data.id_token || data.access_token;
    if (!nextToken) {
      throw new Error("Foreplay token refresh did not return a token");
    }

    this.authHeaders.authorization = `Bearer ${nextToken}`;
    this.refreshToken = data.refresh_token ?? this.refreshToken;
    this.tokenExpiresAt = Date.now() + Number(data.expires_in ?? "3600") * 1000 - 60_000;
  }

  private async request<T>(method: string, path: string, params?: Record<string, string>): Promise<T> {
    await this.ensureToken();

    const url = new URL(`${API_BASE}${path}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.append(key, value);
      }
    }

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        const response = await fetch(url, {
          method,
          headers: this.authHeaders,
          signal: AbortSignal.timeout(30_000)
        });

        const remaining = response.headers.get("x-ratelimit-remaining");
        const resetAt = response.headers.get("x-ratelimit-reset");
        if (remaining !== null && Number(remaining) <= RATE_LIMIT_BUFFER) {
          const waitMs = Math.max(0, Number(resetAt ?? "0") * 1000 - Date.now()) + 2_000;
          this.log(`  rate-limit low (${remaining} left), sleeping ${Math.round(waitMs / 1000)}s`);
          await sleep(waitMs);
        }

        if (response.status === 429) {
          const waitMs = Math.max(0, Number(resetAt ?? "0") * 1000 - Date.now()) + 2_000;
          this.log(`  [retry ${attempt}/${MAX_RETRIES}] 429 rate-limited, sleeping ${Math.round(waitMs / 1000)}s`);
          await sleep(waitMs);
          lastError = new Error("Foreplay rate limited");
          continue;
        }

        if (response.status >= 500) {
          this.log(`  [retry ${attempt}/${MAX_RETRIES}] server error ${response.status}`);
          await sleep(2 ** attempt * 1000);
          lastError = new Error(`Foreplay server error ${response.status}`);
          continue;
        }

        if (!response.ok) {
          throw new Error(`Foreplay request failed: ${response.status}`);
        }

        return (await response.json()) as T;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.log(`  [retry ${attempt}/${MAX_RETRIES}] network error: ${lastError.message}`);
        await sleep(2 ** attempt * 1000);
      }
    }

    throw new Error(`Foreplay request failed after ${MAX_RETRIES} attempts: ${lastError?.message ?? "unknown error"}`);
  }

  private async firebaseLogin(email: string, password: string): Promise<FirebaseLoginResponse> {
    const response = await fetch(FIREBASE_VERIFY_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://app.foreplay.co",
        referer: "https://app.foreplay.co/"
      },
      body: JSON.stringify({
        email,
        password,
        returnSecureToken: true
      }),
      signal: AbortSignal.timeout(15_000)
    });

    if (!response.ok) {
      throw new Error(`Foreplay Firebase login failed: ${response.status}`);
    }

    return (await response.json()) as FirebaseLoginResponse;
  }
}
