import { nowIso, type MediaFilter } from "@competitors/shared";

type LogFn = (...parts: unknown[]) => void;

interface RawCardCandidate {
  libraryId: string;
  advertiser: string;
  startedRunningText: string;
  runningDaysHint: number | null;
  adCopy: string;
  headline: string;
  cta: string;
  mediaType: string;
  mediaUrl: string;
  landingUrl: string;
  platforms: string;
  categories: string;
}

export interface DirectMetaAdRecord {
  libraryId: string;
  advertiser: string;
  startedRunningDate: string;
  runningDays: number;
  adCopy: string;
  headline: string;
  cta: string;
  mediaType: "image" | "video";
  mediaUrl: string;
  adLink: string;
  landingUrl: string;
  platforms: string;
  categories: string;
  scrapedAt: string;
}

interface PlaywrightRuntime {
  chromium: {
    launch: (options?: Record<string, unknown>) => Promise<{
      newContext: (options?: Record<string, unknown>) => Promise<{
        newPage: () => Promise<{
          goto: (url: string, options?: Record<string, unknown>) => Promise<unknown>;
          waitForTimeout: (ms: number) => Promise<void>;
          evaluate: <T>(pageFunction: () => T | Promise<T>) => Promise<T>;
          on: (
            event: "response",
            listener: (response: {
              url: () => string;
              status: () => number;
              request: () => { postData: () => string | null };
              text: () => Promise<string>;
            }) => void | Promise<void>
          ) => void;
        }>;
        close: () => Promise<void>;
      }>;
      close: () => Promise<void>;
    }>;
  };
}

function normalizeMediaType(value: string): "image" | "video" | "unknown" {
  const text = String(value ?? "").trim().toLowerCase();
  if (text === "image" || text === "video") {
    return text;
  }
  return "unknown";
}

function buildSearchUrl(searchQuery: string, pageId: string): string {
  const q = searchQuery.trim() ? `&q=${encodeURIComponent(searchQuery.trim())}` : "";
  return (
    "https://www.facebook.com/ads/library/" +
    "?active_status=active" +
    "&ad_type=all" +
    "&country=US" +
    `&view_all_page_id=${encodeURIComponent(pageId)}` +
    q +
    "&search_type=page"
  );
}

function parseMetaDate(raw: string): Date | null {
  const clean = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!clean) {
    return null;
  }

  const direct = new Date(clean);
  if (!Number.isNaN(direct.valueOf())) {
    return direct;
  }

  const parts = clean
    .replace(",", " ")
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (parts.length < 3) {
    return null;
  }

  const monthLookup: Record<string, number> = {
    jan: 0,
    january: 0,
    feb: 1,
    february: 1,
    mar: 2,
    march: 2,
    apr: 3,
    april: 3,
    may: 4,
    jun: 5,
    june: 5,
    jul: 6,
    july: 6,
    aug: 7,
    august: 7,
    sep: 8,
    sept: 8,
    september: 8,
    oct: 9,
    october: 9,
    nov: 10,
    november: 10,
    dec: 11,
    december: 11
  };

  let day = Number.NaN;
  let month = Number.NaN;
  let year = Number.NaN;

  if (Number.isFinite(Number(parts[0])) && monthLookup[parts[1].toLowerCase()] !== undefined) {
    day = Number(parts[0]);
    month = monthLookup[parts[1].toLowerCase()];
    year = Number(parts[2]);
  } else if (monthLookup[parts[0].toLowerCase()] !== undefined && Number.isFinite(Number(parts[1]))) {
    month = monthLookup[parts[0].toLowerCase()];
    day = Number(parts[1]);
    year = Number(parts[2]);
  }

  if (!Number.isFinite(day) || !Number.isFinite(month) || !Number.isFinite(year)) {
    return null;
  }
  return new Date(Date.UTC(year, month, day, 0, 0, 0));
}

function daysBetween(today: Date, startedDate: Date): number {
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const startUtc = Date.UTC(startedDate.getUTCFullYear(), startedDate.getUTCMonth(), startedDate.getUTCDate());
  return Math.max(Math.floor((todayUtc - startUtc) / 86_400_000), 0);
}

function cleanPageId(value: string): string {
  return String(value ?? "").replace(/[^\d]/g, "").trim();
}

async function clickConsentIfPresent(page: {
  evaluate: <T>(pageFunction: () => T | Promise<T>) => Promise<T>;
  waitForTimeout: (ms: number) => Promise<void>;
}, log: LogFn): Promise<void> {
  const clicked = await page.evaluate(() => {
    const labels = [
      "Allow all cookies",
      "Allow essential and optional cookies",
      "Accept all",
      "Accept",
      "Allow all",
      "I agree"
    ].map((item) => item.toLowerCase());

    const buttons = Array.from(document.querySelectorAll("button, [role='button']"));
    for (const button of buttons) {
      const text = (button.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      if (!text) continue;
      if (!labels.some((label) => text.includes(label))) {
        continue;
      }
      (button as HTMLElement).click();
      return true;
    }
    return false;
  });
  if (clicked) {
    log("Accepted cookie/consent prompt.");
    await page.waitForTimeout(1_500);
  }
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) {
      return text;
    }
  }
  return "";
}

function humanizeCta(value: string): string {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return "";
  }
  if (raw.includes("_")) {
    return raw
      .toLowerCase()
      .split("_")
      .filter(Boolean)
      .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
      .join(" ");
  }
  return raw;
}

function unixToIsoDate(value: unknown): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return "";
  }
  return new Date(Math.trunc(numeric) * 1000).toISOString().slice(0, 10);
}

function pickGraphMedia(snapshot: Record<string, unknown>): { mediaType: string; mediaUrl: string } {
  const cards = Array.isArray(snapshot.cards) ? snapshot.cards : [];
  for (const card of cards) {
    if (!card || typeof card !== "object") continue;
    const record = card as Record<string, unknown>;
    const video = firstText(
      record.video_hd_url,
      record.video_sd_url,
      record.watermarked_video_hd_url,
      record.watermarked_video_sd_url,
      record.video_url
    );
    if (video) {
      return { mediaType: "video", mediaUrl: video };
    }
  }

  const videos = Array.isArray(snapshot.videos) ? snapshot.videos : [];
  for (const videoItem of videos) {
    if (!videoItem || typeof videoItem !== "object") continue;
    const record = videoItem as Record<string, unknown>;
    const video = firstText(
      record.video_hd_url,
      record.video_sd_url,
      record.watermarked_video_hd_url,
      record.watermarked_video_sd_url,
      record.url,
      record.video_url
    );
    if (video) {
      return { mediaType: "video", mediaUrl: video };
    }
  }

  const directVideo = firstText(
    snapshot.video_hd_url,
    snapshot.video_sd_url,
    snapshot.watermarked_video_hd_url,
    snapshot.watermarked_video_sd_url
  );
  if (directVideo) {
    return { mediaType: "video", mediaUrl: directVideo };
  }

  for (const card of cards) {
    if (!card || typeof card !== "object") continue;
    const record = card as Record<string, unknown>;
    const image = firstText(
      record.original_image_url,
      record.resized_image_url,
      record.watermarked_resized_image_url,
      record.image_url
    );
    if (image) {
      return { mediaType: "image", mediaUrl: image };
    }
  }

  const images = Array.isArray(snapshot.images) ? snapshot.images : [];
  for (const imageItem of images) {
    if (!imageItem || typeof imageItem !== "object") continue;
    const record = imageItem as Record<string, unknown>;
    const image = firstText(
      record.original_image_url,
      record.resized_image_url,
      record.watermarked_resized_image_url,
      record.image_url,
      record.url
    );
    if (image) {
      return { mediaType: "image", mediaUrl: image };
    }
  }

  const fallbackImage = firstText(snapshot.video_preview_image_url, snapshot.original_image_url, snapshot.resized_image_url);
  if (fallbackImage) {
    return { mediaType: "image", mediaUrl: fallbackImage };
  }

  return { mediaType: "unknown", mediaUrl: "" };
}

function inferMediaTypeFromUrl(mediaUrl: string): "image" | "video" | "unknown" {
  const value = String(mediaUrl ?? "").trim().toLowerCase();
  if (!value) {
    return "unknown";
  }
  if (
    value.includes(".mp4") ||
    value.includes(".webm") ||
    value.includes(".m3u8") ||
    value.includes("video")
  ) {
    return "video";
  }
  if (
    value.includes(".jpg") ||
    value.includes(".jpeg") ||
    value.includes(".png") ||
    value.includes(".webp") ||
    value.includes(".gif") ||
    value.includes("image")
  ) {
    return "image";
  }
  return "unknown";
}

function decodeEscapedText(value: string): string {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return "";
  }
  return raw
    .replace(/\\u003D/gi, "=")
    .replace(/\\u0026/gi, "&")
    .replace(/\\u0025/gi, "%")
    .replace(/\\u002F/gi, "/")
    .replace(/\\\//g, "/")
    .replace(/\\n/g, " ")
    .replace(/\\r/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toTitleCaseTokens(values: string[]): string {
  return values
    .map((item) => item.trim().toLowerCase().replaceAll("_", " "))
    .filter(Boolean)
    .map((item) => item.replace(/\b\w/g, (match) => match.toUpperCase()))
    .join(", ");
}

function extractTextField(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (!value || typeof value !== "object") {
    return "";
  }
  const record = value as Record<string, unknown>;
  return firstText(record.text, record.body_text, record.message, record.content);
}

function toRawCandidate(row: Record<string, unknown>): RawCardCandidate | null {
  const snapshot = (row.snapshot ?? row.ad_snapshot ?? row.rendering_snapshot ?? {}) as Record<string, unknown>;
  const cards = Array.isArray(snapshot.cards) ? snapshot.cards : [];
  const firstCard = (cards[0] as Record<string, unknown> | undefined) ?? {};
  const branded = (snapshot.branded_content as Record<string, unknown> | undefined) ?? {};
  const media = pickGraphMedia(snapshot);
  const fallbackMediaUrl = firstText(
    row.media_url,
    row.video_url,
    row.image_url,
    row.video_hd_url,
    row.video_sd_url,
    row.original_image_url,
    row.resized_image_url
  );
  const mediaUrl = firstText(media.mediaUrl, fallbackMediaUrl);
  const mediaType = media.mediaType === "unknown" ? inferMediaTypeFromUrl(mediaUrl) : media.mediaType;

  const platformListRaw = firstText(
    Array.isArray(row.publisher_platform) ? (row.publisher_platform as unknown[]).join(",") : "",
    Array.isArray(row.publisher_platforms) ? (row.publisher_platforms as unknown[]).join(",") : "",
    Array.isArray(row.platforms) ? (row.platforms as unknown[]).join(",") : "",
    String(row.platforms ?? "")
  );
  const platformList = platformListRaw
    .split(/[,\|;]/)
    .map((item) => item.trim())
    .filter(Boolean);

  const categories = Array.isArray(snapshot.page_categories)
    ? snapshot.page_categories.map((item) => String(item ?? "").trim()).filter(Boolean).join(", ")
    : firstText(
        Array.isArray(row.categories) ? (row.categories as unknown[]).join(", ") : "",
        String(row.category ?? "")
      );

  const libraryId = firstText(row.ad_archive_id, row.ad_id, row.id).replace(/[^\d]/g, "");
  if (!libraryId) {
    return null;
  }

  const startedRunningText = firstText(
    unixToIsoDate(row.start_date),
    unixToIsoDate(row.start_date_utc),
    unixToIsoDate(row.startDate),
    String(row.started_running_date ?? ""),
    String(row.started_running_text ?? "")
  );

  const runningDaysHint = Number(row.running_days);

  return {
    libraryId,
    advertiser: firstText(
      branded.page_name,
      snapshot.page_name,
      row.page_name,
      row.pageName,
      row.advertiser_name,
      row.advertiser
    ),
    startedRunningText,
    runningDaysHint: Number.isFinite(runningDaysHint) ? runningDaysHint : null,
    adCopy: firstText(
      extractTextField(snapshot.body),
      extractTextField(firstCard.body),
      String(row.ad_copy ?? ""),
      String(row.body ?? ""),
      String(row.description ?? "")
    ),
    headline: firstText(snapshot.title, firstCard.title, row.title, row.headline),
    cta: firstText(
      snapshot.cta_text,
      firstCard.cta_text,
      row.cta_text,
      row.cta,
      humanizeCta(firstText(snapshot.cta_type, firstCard.cta_type, row.cta_type))
    ),
    mediaType,
    mediaUrl,
    landingUrl: firstText(
      snapshot.link_url,
      firstCard.link_url,
      row.link_url,
      row.landing_url,
      row.destination_url,
      row.url
    ),
    platforms: toTitleCaseTokens(platformList),
    categories
  };
}

function collectRows(value: unknown, sink: Record<string, unknown>[], seen: Set<unknown>, depth = 0): void {
  if (!value || typeof value !== "object" || seen.has(value) || depth > 12) {
    return;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      collectRows(item, sink, seen, depth + 1);
    }
    return;
  }

  const record = value as Record<string, unknown>;
  if (
    record.ad_archive_id ||
    record.ad_id ||
    record.start_date ||
    record.snapshot ||
    record.ad_snapshot ||
    record.rendering_snapshot
  ) {
    sink.push(record);
  }

  for (const nested of Object.values(record)) {
    collectRows(nested, sink, seen, depth + 1);
  }
}

function extractGraphCandidates(payload: unknown): RawCardCandidate[] {
  const rows: Record<string, unknown>[] = [];
  collectRows(payload, rows, new Set<unknown>());
  const byId = new Map<string, RawCardCandidate>();
  for (const row of rows) {
    const candidate = toRawCandidate(row);
    if (!candidate) {
      continue;
    }
    if (!byId.has(candidate.libraryId)) {
      byId.set(candidate.libraryId, candidate);
    }
  }
  return [...byId.values()];
}

function extractGraphCandidatesFromText(rawPayloadText: string): RawCardCandidate[] {
  const text = decodeEscapedText(rawPayloadText.replace(/\\"/g, "\""));
  const idRegex = /"ad_archive_id"\s*:\s*"?(?<id>\d{6,})"?/g;
  const byId = new Map<string, RawCardCandidate>();
  const matchField = (chunk: string, patterns: RegExp[]): string => {
    for (const pattern of patterns) {
      const match = chunk.match(pattern);
      if (match?.[1]) {
        return decodeEscapedText(match[1]);
      }
    }
    return "";
  };

  for (const match of text.matchAll(idRegex)) {
    const libraryId = (match.groups?.id ?? "").trim();
    if (!libraryId || byId.has(libraryId)) {
      continue;
    }

    const index = match.index ?? 0;
    const chunk = text.slice(Math.max(0, index - 1_600), Math.min(text.length, index + 3_200));
    const resolvedMediaUrl = matchField(chunk, [
      /"(?:video_hd_url|video_sd_url|video_url|watermarked_video_hd_url|watermarked_video_sd_url)"\s*:\s*"([^"]+)"/i,
      /"(?:original_image_url|resized_image_url|watermarked_resized_image_url|image_url|video_preview_image_url)"\s*:\s*"([^"]+)"/i
    ]);

    const platformsBlock = matchField(chunk, [/"publisher_platforms?"\s*:\s*\[([^\]]+)\]/i]);
    const platformItems = [...platformsBlock.matchAll(/"([^"]+)"/g)].map((item) => item[1]);
    const categoriesBlock = matchField(chunk, [/"page_categories"\s*:\s*\[([^\]]+)\]/i]);
    const categoryItems = [...categoriesBlock.matchAll(/"([^"]+)"/g)].map((item) => item[1]);

    const candidate: RawCardCandidate = {
      libraryId,
      advertiser: matchField(chunk, [
        /"(?:page_name|advertiser_name|advertiser)"\s*:\s*"([^"]{2,120})"/i
      ]),
      startedRunningText: firstText(
        unixToIsoDate(matchField(chunk, [/"start_date(?:_utc)?"\s*:\s*(\d{9,12})/i])),
        matchField(chunk, [/"started_running_(?:date|text)"\s*:\s*"([^"]+)"/i])
      ),
      runningDaysHint: null,
      adCopy: matchField(chunk, [
        /"body"\s*:\s*\{"text":"([^"]{2,500})"/i,
        /"(?:ad_copy|description|message)"\s*:\s*"([^"]{2,500})"/i
      ]),
      headline: matchField(chunk, [/"(?:title|headline)"\s*:\s*"([^"]{2,500})"/i]),
      cta: humanizeCta(
        matchField(chunk, [/"(?:cta_text|cta_type|cta)"\s*:\s*"([^"]{2,120})"/i])
      ),
      mediaType: inferMediaTypeFromUrl(resolvedMediaUrl),
      mediaUrl: resolvedMediaUrl,
      landingUrl: matchField(chunk, [/"(?:link_url|landing_url|destination_url|url)"\s*:\s*"([^"]+)"/i]),
      platforms: toTitleCaseTokens(platformItems),
      categories: categoryItems.join(", ")
    };
    byId.set(libraryId, candidate);
  }

  return [...byId.values()];
}

async function loadPlaywright(): Promise<PlaywrightRuntime> {
  try {
    const moduleName = "playwright";
    return (await import(moduleName)) as unknown as PlaywrightRuntime;
  } catch {
    throw new Error(
      "Meta direct extraction requires the 'playwright' package in the Node runtime."
    );
  }
}

export async function scrapeMetaAdsDirect(options: {
  pageId: string;
  keywords: string;
  minDays: number;
  media: MediaFilter;
  maxAds: number;
  log?: LogFn;
  shouldStop?: () => boolean;
}): Promise<DirectMetaAdRecord[]> {
  const log = options.log ?? console.log;
  const shouldStop = options.shouldStop ?? (() => false);
  const pageId = cleanPageId(options.pageId);
  if (!pageId) {
    throw new Error("Meta direct mode requires a numeric page ID.");
  }

  const selectedMedia = options.media;
  const maxAds = Math.max(1, options.maxAds);
  const minDays = Math.max(0, options.minDays);
  const url = buildSearchUrl(options.keywords, pageId);
  const scrapedAt = nowIso();
  const today = new Date();

  const playwright = await loadPlaywright();
  let browser: Awaited<ReturnType<PlaywrightRuntime["chromium"]["launch"]>>;
  try {
    browser = await playwright.chromium.launch({
      headless: true,
      args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"]
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Meta browser launch failed. Install browser binaries with 'npx playwright install chromium'. ${message}`
    );
  }

  const records: DirectMetaAdRecord[] = [];
  const seenIds = new Set<string>();
  let cardsSeen = 0;
  let stagnantLoops = 0;
  let diagnostics = "";
  let pageAdvertiser = "";
  const graphCandidates = new Map<string, RawCardCandidate>();
  const graphDocIds = new Set<string>();

  const addCandidate = (card: RawCardCandidate): void => {
    const libraryId = String(card.libraryId ?? "").trim();
    if (!libraryId || seenIds.has(libraryId)) {
      return;
    }

    const startedDate = parseMetaDate(card.startedRunningText);
    const runningDays =
      startedDate ??
      (typeof card.runningDaysHint === "number" && Number.isFinite(card.runningDaysHint)
        ? card.runningDaysHint
        : null);
    const resolvedRunningDaysValue = runningDays instanceof Date ? daysBetween(today, runningDays) : runningDays ?? null;
    if (!Number.isFinite(resolvedRunningDaysValue)) {
      return;
    }
    const resolvedRunningDays = Number(resolvedRunningDaysValue);
    if (resolvedRunningDays < minDays) {
      return;
    }

    const mediaUrl = String(card.mediaUrl ?? "").trim();
    if (!mediaUrl) {
      return;
    }

    const mediaType = normalizeMediaType(card.mediaType);
    const inferredMediaType = mediaType === "unknown" ? inferMediaTypeFromUrl(mediaUrl) : mediaType;
    if (inferredMediaType === "unknown") {
      return;
    }
    const resolvedMediaType: "image" | "video" = inferredMediaType;
    if (selectedMedia !== "both" && resolvedMediaType !== selectedMedia) {
      return;
    }

    const startedRunningDate = startedDate
      ? startedDate.toISOString().slice(0, 10)
      : new Date(Date.now() - resolvedRunningDays * 86_400_000).toISOString().slice(0, 10);

    const advertiser = String(card.advertiser ?? "").trim() || pageAdvertiser;
    const headline = String(card.headline ?? "").trim();
    const adCopy = String(card.adCopy ?? "").trim();
    const landingUrl = String(card.landingUrl ?? "").trim();
    if (!advertiser && !headline && !adCopy && !landingUrl) {
      return;
    }

    const record: DirectMetaAdRecord = {
      libraryId,
      advertiser,
      startedRunningDate,
      runningDays: resolvedRunningDays,
      adCopy,
      headline,
      cta: String(card.cta ?? "").trim(),
      mediaType: resolvedMediaType,
      mediaUrl,
      adLink: `https://www.facebook.com/ads/library/?id=${libraryId}`,
      landingUrl,
      platforms: String(card.platforms ?? "").trim(),
      categories: String(card.categories ?? "").trim(),
      scrapedAt
    };

    seenIds.add(libraryId);
    records.push(record);
    log(
      `Collected [${records.length}/${maxAds}] ${record.advertiser || "Unknown"} | ${record.libraryId} | ${record.mediaType} | ${record.runningDays} days`
    );
  };

  try {
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      locale: "en-US"
    });
    const page = await context.newPage();

    page.on("response", async (response: {
      url: () => string;
      status: () => number;
      request: () => { postData: () => string | null };
      text: () => Promise<string>;
    }) => {
      try {
        const responseUrl = response.url();
        if (!responseUrl.includes("/api/graphql/")) {
          return;
        }
        if (response.status() >= 400) {
          return;
        }

        const postData = response.request().postData() || "";
        const docMatch = postData.match(/doc_id=(\d+)/);
        if (docMatch?.[1]) {
          graphDocIds.add(docMatch[1]);
        }

        const text = await response.text();
        if (!text || text.length < 60) {
          return;
        }

        const normalized = text.startsWith("for (;;);") ? text.slice(9) : text;
        let candidates: RawCardCandidate[] = [];
        try {
          const payload = JSON.parse(normalized) as unknown;
          candidates = extractGraphCandidates(payload);
        } catch {
          // Some responses are not strict JSON; we still try text-based extraction.
        }
        if (!candidates.length && normalized.includes("ad_archive_id")) {
          candidates = extractGraphCandidatesFromText(normalized);
        }
        for (const candidate of candidates) {
          const id = String(candidate.libraryId ?? "").trim();
          if (!id || seenIds.has(id)) {
            continue;
          }
          if (!graphCandidates.has(id)) {
            graphCandidates.set(id, candidate);
          }
        }
      } catch {
        // Ignore noisy non-ad GraphQL responses.
      }
    });

    log(`Opening Meta Ads Library for US: ${pageId}`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await page.waitForTimeout(4_000);
    await clickConsentIfPresent(page, log);
    pageAdvertiser = await page.evaluate(() => {
      const heading = Array.from(document.querySelectorAll("h1, h2"))
        .map((node) => (node.textContent || "").replace(/\s+/g, " ").trim())
        .find((text) => /\bAds$/i.test(text));
      if (heading) {
        return heading.replace(/\bAds$/i, "").trim();
      }
      const body = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
      const bodyMatch = body.match(/([A-Za-z0-9&.'\- ]{2,120})\s+Ads\b/);
      if (bodyMatch?.[1]) {
        const candidate = bodyMatch[1].trim();
        if (!/^(meta|ad library)$/i.test(candidate)) {
          return candidate;
        }
      }
      return "";
    });

    for (let loop = 0; loop < 45; loop += 1) {
      if (shouldStop()) {
        throw new Error("Job stopped by user.");
      }

      const before = records.length;
      if (graphCandidates.size) {
        const queued = [...graphCandidates.values()];
        graphCandidates.clear();
        cardsSeen += queued.length;
        for (const card of queued) {
          addCandidate(card);
          if (records.length >= maxAds) {
            break;
          }
        }
      }
      if (records.length >= maxAds) {
        break;
      }

      const candidates = (await page.evaluate(() => {
        const CTA_WORDS = new Set([
          "learn more",
          "apply now",
          "get quote",
          "sign up",
          "shop now",
          "book now",
          "contact us",
          "get offer",
          "download",
          "watch more",
          "send message",
          "get started",
          "subscribe",
          "see menu",
          "call now",
          "request time",
          "order now"
        ]);

        const DURATION_RE = /^\d+:\d+\s*[\/|]\s*\d+:\d+$/;
        const SKIP_LINES = new Set([
          "See ad details",
          "See summary details",
          "This ad has multiple versions",
          "Open Dropdown",
          "Platforms",
          "Categories",
          "Sponsored",
          "Active",
          "Ad Details",
          "Close",
          "About the advertiser",
          "About ads and data use"
        ]);

        function isJunk(line: string): boolean {
          if (!line) return true;
          if (SKIP_LINES.has(line)) return true;
          if (DURATION_RE.test(line)) return true;
          if (/^Library ID:/i.test(line)) return true;
          if (/^Started running on/i.test(line)) return true;
          if (/^\d+ of \d+$/.test(line)) return true;
          return false;
        }

        function parseCard(card: Element) {
          const text = (card as HTMLElement).innerText || "";
          const lines = text
            .split("\n")
            .map((item) => item.trim())
            .filter(Boolean);

          const idMatch = text.match(/Library ID:\s*(\d+)/i);
          let libraryId = idMatch ? idMatch[1] : "";
          if (!libraryId) {
            const idAnchor = card.querySelector("a[href*='/ads/library/?id=']") as HTMLAnchorElement | null;
            const href = idAnchor?.href || "";
            const hrefMatch = href.match(/[?&]id=(\d{6,})/);
            if (hrefMatch) {
              libraryId = hrefMatch[1];
            }
          }
          const startMatch = text.match(/Started running on\s+([^\n]+)/i);
          const runningDaysMatch = text.match(/\b(\d{1,4})\s+days?\b/i);

          let advertiser = "";
          const profileImgs = Array.from(card.querySelectorAll("img[alt]"));
          for (const image of profileImgs) {
            const img = image as HTMLImageElement;
            const alt = (img.alt || "").trim();
            if (!alt) continue;
            if (img.width <= 60 && img.height <= 60 && alt.length > 1) {
              advertiser = alt;
              break;
            }
          }

          if (!advertiser) {
            const links = Array.from(card.querySelectorAll("a[href*='facebook.com/']"));
            for (const link of links) {
              const href = (link as HTMLAnchorElement).href || "";
              const textValue = (link.textContent || "").trim();
              if (
                textValue &&
                !href.includes("/ads/library") &&
                !href.includes("l.facebook.com") &&
                textValue.length > 1 &&
                textValue.length < 80
              ) {
                advertiser = textValue;
                break;
              }
            }
          }
          if (!advertiser) {
            for (let index = 0; index < lines.length; index += 1) {
              const marker = lines[index];
              if (marker !== "See ad details" && marker !== "See summary details") {
                continue;
              }
              const fallback = lines[index + 1] || "";
              if (fallback && !isJunk(fallback)) {
                advertiser = fallback;
                break;
              }
            }
          }

          let cta = "";
          for (const line of lines) {
            if (CTA_WORDS.has(line.toLowerCase())) {
              cta = line;
            }
          }

          let adCopy = "";
          let headline = "";
          const sponsoredIdx = lines.indexOf("Sponsored");
          if (sponsoredIdx >= 0) {
            const contentLines: string[] = [];
            for (const line of lines.slice(sponsoredIdx + 1)) {
              if (isJunk(line)) continue;
              if (line === cta) continue;
              if (line === advertiser) continue;
              contentLines.push(line);
            }
            for (const line of contentLines) {
              if (!adCopy) {
                adCopy = line;
              } else if (!headline) {
                headline = line;
                break;
              }
            }
          }

          let landingUrl = "";
          const anchors = Array.from(card.querySelectorAll("a[href]"));
          for (const anchor of anchors) {
            const href = (anchor as HTMLAnchorElement).href || "";
            const encoded = href.match(/[?&]u=(https?[^&]+)/);
            if (encoded) {
              try {
                landingUrl = decodeURIComponent(encoded[1]);
              } catch {
                landingUrl = encoded[1];
              }
              break;
            }
            if (href.startsWith("http") && !href.includes("facebook.com") && !href.includes("fb.com")) {
              landingUrl = href;
              break;
            }
          }

          let mediaType = "unknown";
          let mediaUrl = "";
          const video = card.querySelector("video");
          const source = video ? video.querySelector("source[src]") : null;
          if (video && ((video as HTMLVideoElement).currentSrc || (video as HTMLVideoElement).src || source)) {
            mediaType = "video";
            mediaUrl =
              (video as HTMLVideoElement).currentSrc ||
              (video as HTMLVideoElement).src ||
              ((source as HTMLSourceElement | null)?.src ?? "");
          } else {
            const images = Array.from(card.querySelectorAll("img[src]")).reverse();
            const image = images.find((img) => {
              const src = (img as HTMLImageElement).src || "";
              return src.startsWith("http") && !src.includes("emoji") && !src.includes("profile");
            }) as HTMLImageElement | undefined;
            if (image?.src) {
              mediaType = "image";
              mediaUrl = image.src;
            } else {
              const richerImage = Array.from(card.querySelectorAll("img")).reverse().find((img) => {
                const element = img as HTMLImageElement;
                const src = (element.src || element.getAttribute("data-src") || "").trim();
                const srcset = (element.srcset || element.getAttribute("srcset") || "").trim();
                if (src.startsWith("http") && !src.includes("emoji") && !src.includes("profile")) {
                  return true;
                }
                if (srcset.includes("http")) {
                  return true;
                }
                return false;
              }) as HTMLImageElement | undefined;
              if (richerImage) {
                const src = (richerImage.src || richerImage.getAttribute("data-src") || "").trim();
                if (src.startsWith("http")) {
                  mediaType = "image";
                  mediaUrl = src;
                } else {
                  const srcset = (richerImage.srcset || richerImage.getAttribute("srcset") || "").trim();
                  const firstSrcset = srcset
                    .split(",")
                    .map((part) => part.trim().split(/\s+/)[0])
                    .find((part) => part.startsWith("http"));
                  if (firstSrcset) {
                    mediaType = "image";
                    mediaUrl = firstSrcset;
                  }
                }
              }
            }
            if (!mediaUrl) {
              const backgroundElement = Array.from(card.querySelectorAll("[style*='background-image']")).find(
                (element) => ((element as HTMLElement).getAttribute("style") || "").includes("url(")
              ) as HTMLElement | undefined;
              const backgroundStyle = backgroundElement?.getAttribute("style") || "";
              const match = backgroundStyle.match(/url\(["']?([^"')]+)["']?\)/i);
              if (match?.[1]) {
                mediaType = "image";
                mediaUrl = match[1];
              }
            }
          }

          return {
            libraryId,
            startedRunningText: startMatch ? startMatch[1].trim() : "",
            runningDaysHint: runningDaysMatch ? Number.parseInt(runningDaysMatch[1], 10) : null,
            advertiser,
            adCopy,
            headline,
            cta,
            mediaType,
            mediaUrl,
            landingUrl,
            platforms: "",
            categories: ""
          };
        }

        let cards = Array.from(document.querySelectorAll("div[role='article']"));
        cards = cards.filter((element) => {
          const text = ((element as HTMLElement).innerText || "").trim();
          if (!text) return false;
          if ((element as HTMLElement).querySelector("a[href*='/ads/library/?id=']")) return true;
          return text.includes("Library ID:");
        });

        if (!cards.length) {
          const fromAnchors = new Set<Element>();
          const idLinks = Array.from(document.querySelectorAll("a[href*='/ads/library/?id=']"));
          for (const link of idLinks) {
            const nearArticle = (link as HTMLElement).closest("div[role='article']");
            if (nearArticle) {
              fromAnchors.add(nearArticle);
              continue;
            }
            const nearBlock = (link as HTMLElement).closest("div");
            if (nearBlock) {
              fromAnchors.add(nearBlock);
            }
          }
          if (fromAnchors.size) {
            cards = Array.from(fromAnchors);
          }
        }

        if (!cards.length) {
          const dedupById: Record<string, Element> = {};
          const blocks = Array.from(document.querySelectorAll("div"));
          for (const block of blocks) {
            const text = (block as HTMLElement).innerText || "";
            if (!text.includes("Library ID:")) continue;
            const idMatch = text.match(/Library ID:\s*(\d+)/);
            if (!idMatch) continue;
            const id = idMatch[1];
            if (!dedupById[id] || text.length < ((dedupById[id] as HTMLElement).innerText || "").length) {
              dedupById[id] = block;
            }
          }
          cards = Object.values(dedupById);
        }

        return cards.map(parseCard);
      })) as RawCardCandidate[];

      cardsSeen += candidates.length;
      for (const card of candidates) {
        addCandidate(card);
        if (records.length >= maxAds) {
          break;
        }
      }

      if (records.length >= maxAds) {
        break;
      }

      if (records.length === before) {
        stagnantLoops += 1;
      } else {
        stagnantLoops = 0;
      }
      if (stagnantLoops >= 6) {
        break;
      }

      await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
      });
      await page.waitForTimeout(2_000);
    }

    if (!records.length) {
      diagnostics = await page.evaluate(() => {
        const body = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
        const title = document.title || "";
        const url = window.location.href || "";
        const articleCount = document.querySelectorAll("div[role='article']").length;
        const idLinkCount = document.querySelectorAll("a[href*='/ads/library/?id=']").length;
        return `title='${title}' url='${url}' articles=${articleCount} ad_id_links=${idLinkCount} body='${body.slice(0, 280)}'`;
      });
      const docs = [...graphDocIds].join(",");
      diagnostics = `${diagnostics} gql_docs='${docs}' queued_graph_candidates=${graphCandidates.size}`;
      log(`Meta direct diagnostics: ${diagnostics}`);
    }
  } finally {
    await browser.close().catch(() => undefined);
  }

  if (!records.length) {
    const suffix = diagnostics ? ` ${diagnostics}` : "";
    throw new Error(
      `No ads matched filters. cards_seen=${cardsSeen} min_days=${minDays} media=${selectedMedia}.${suffix}`
    );
  }

  return records;
}
