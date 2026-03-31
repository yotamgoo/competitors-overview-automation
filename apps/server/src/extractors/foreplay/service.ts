import { normalizeDateTime, normalizePlatformList, nowIso, type NormalizedAd } from "@competitors/shared";

import type { FileBackedIntelligenceStore } from "../../data-store.js";
import { ForeplayClient, type ForeplayAdRecord, type ForeplayBrandRecord } from "./client.js";

const DAY_MS = 24 * 60 * 60 * 1000;

type LogFn = (...parts: unknown[]) => void;

export interface ForeplayExtractionResult {
  brandId: string;
  brandName: string;
  datesProcessed: number;
  adsFetched: number;
  winnersFound: number;
  inProgress: number;
  failed: number;
}

function brandLookupKeys(brand: ForeplayBrandRecord): string[] {
  const keys = new Set<string>();

  for (const value of [brand.id, brand.adLibraryId, brand.spyder_socials_page_id]) {
    const text = String(value ?? "").trim();
    if (text) {
      keys.add(text);
    }
  }

  const url = String(brand.url ?? "").trim();
  if (url) {
    try {
      const parsed = new URL(url);
      const slug = parsed.pathname.split("/").filter(Boolean).at(-1);
      if (slug) {
        keys.add(slug);
      }
    } catch {
      keys.add(url);
    }
  }

  return [...keys];
}

function looksLikePageId(reference: string): boolean {
  return /^\d+$/.test(reference.trim());
}

function parseDateTimestamp(dateText: string): number | null {
  const match = /\d{10,}/.exec(dateText);
  return match ? Number.parseInt(match[0], 10) : null;
}

function lookbackStartMs(months: number): number {
  return Date.now() - months * 30 * DAY_MS;
}

function startOfUtcDay(timestampMs: number): number {
  const date = new Date(timestampMs);
  date.setUTCHours(0, 0, 0, 0);
  return date.getTime();
}

function cleanHtmlText(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function hasInlineMedia(ad: ForeplayAdRecord): boolean {
  const firstCard = ad.cards?.[0];
  return Boolean(firstCard?.video || firstCard?.thumbnail || firstCard?.image || ad.image);
}

function normalizeForeplayWinner(ad: ForeplayAdRecord, brandName: string): Partial<NormalizedAd> & Pick<NormalizedAd, "source" | "sourceId"> {
  const firstCard = ad.cards?.[0];
  const description = cleanHtmlText(ad.description || firstCard?.description || "");
  const imageUrl = firstCard?.thumbnail || firstCard?.image || ad.image || ad.avatar || null;
  const videoUrl = firstCard?.video || null;
  const title = String(ad.headline || ad.name || "").trim();
  const cta = String(firstCard?.cta_text || ad.cta_title || ad.cta_type || "").trim();

  return {
    source: "foreplay",
    sourceId: String(ad.id || ad.ad_id || ""),
    brand: brandName,
    title,
    adCopy: description,
    firstSeen: normalizeDateTime(ad.startedRunning),
    lastSeen: normalizeDateTime(ad.end_date),
    daysRunning: null,
    status: ad.live ? "active" : "inactive",
    countries: [],
    platforms: normalizePlatformList(ad.publisher_platform ?? []),
    cta,
    videoUrl,
    imageUrl,
    landingPageUrl: ad.link_url ?? null,
    adLibraryUrl: ad.ad_id ? `https://www.facebook.com/ads/library/?id=${ad.ad_id}` : null,
    vertical: null,
    fetchedAt: nowIso()
  };
}

export class ForeplayExtractorService {
  constructor(
    private readonly store: FileBackedIntelligenceStore,
    private readonly credentials: {
      email: string;
      password: string;
    }
  ) {}

  async extract(options: {
    brandIds: string[];
    months: number;
    log?: LogFn;
    shouldStop?: () => boolean;
  }): Promise<ForeplayExtractionResult[]> {
    if (!this.credentials.email || !this.credentials.password) {
      throw new Error("Foreplay credentials are missing.");
    }

    const log = options.log ?? console.log;
    const shouldStop = options.shouldStop ?? (() => false);
    const ensureNotStopped = () => {
      if (shouldStop()) {
        throw new Error("Job stopped by user.");
      }
    };

    ensureNotStopped();
    const client = new ForeplayClient(this.credentials.email, this.credentials.password, log);
    await client.initialize();
    ensureNotStopped();

    const resolvedBrands = await this.resolveBrands(client, options.brandIds, log, ensureNotStopped);
    const results: ForeplayExtractionResult[] = [];

    for (const [index, [brandId, brandName]] of resolvedBrands.entries()) {
      ensureNotStopped();
      log("");
      log(`=== Brand ${index + 1}/${resolvedBrands.length}: ${brandName} ===`);
      results.push(await this.extractBrand(client, brandId, brandName, options.months, log, ensureNotStopped));
    }

    return results;
  }

  private async resolveBrands(
    client: ForeplayClient,
    brandIds: string[],
    log: LogFn,
    ensureNotStopped: () => void
  ): Promise<Array<[string, string]>> {
    if (!brandIds.length) {
      return [];
    }

    const deadline = Date.now() + 30_000;
    const pending = new Set(brandIds);
    const resolved = new Map<string, [string, string]>();

    log("Resolving Foreplay brand references...");

    // Fast-path for Facebook page IDs (all digits) using Foreplay's Firestore mapping.
    for (const reference of [...pending]) {
      ensureNotStopped();
      if (!looksLikePageId(reference)) {
        continue;
      }

      const mappedBrandId = await client.resolveBrandIdFromPageId(reference);
      if (!mappedBrandId) {
        continue;
      }

      resolved.set(reference, [mappedBrandId, reference]);
      pending.delete(reference);
      log(`Resolved Foreplay page ID ${reference} -> brandId ${mappedBrandId}`);
    }

    if (!pending.size) {
      return brandIds.map((reference) => resolved.get(reference) ?? [reference, reference]);
    }

    for await (const brand of client.iterBrands()) {
      ensureNotStopped();
      const brandSlug = String(brand.id ?? "").trim();
      if (!brandSlug) {
        continue;
      }

      const brandName = String(brand.name ?? brandSlug).trim() || brandSlug;
      const keys = brandLookupKeys(brand);
      let matched = false;

      for (const reference of pending) {
        if (!keys.includes(reference)) {
          continue;
        }

        resolved.set(reference, [brandSlug, brandName]);
        pending.delete(reference);
        matched = true;
        log(`Resolved Foreplay brand ${reference} -> ${brandName} (${brandSlug})`);
        break;
      }

      if (!pending.size) {
        break;
      }

      if (!matched && Date.now() >= deadline) {
        log("Foreplay brand lookup timed out; using unresolved values directly.");
        break;
      }
    }

    if (pending.size) {
      log(`Could not resolve ${pending.size} Foreplay brand reference(s); using input values directly.`);
    }

    return brandIds.map((reference) => resolved.get(reference) ?? [reference, reference]);
  }

  private async extractBrand(
    client: ForeplayClient,
    brandId: string,
    brandName: string,
    months: number,
    log: LogFn,
    ensureNotStopped: () => void
  ): Promise<ForeplayExtractionResult> {
    const result: ForeplayExtractionResult = {
      brandId,
      brandName,
      datesProcessed: 0,
      adsFetched: 0,
      winnersFound: 0,
      inProgress: 0,
      failed: 0
    };

    const cutoffMs = lookbackStartMs(months);
    ensureNotStopped();
    log(`[${brandName}] Fetching creative-test dates...`);
    const allDates = await client.getCreativeTestDates(brandId);
    let datesInWindow = allDates.filter((entry) => {
      const timestamp = parseDateTimestamp(entry.date);
      return typeof timestamp === "number" && timestamp >= cutoffMs;
    });
    let fallbackGroups: Map<number, ForeplayAdRecord[]> | null = null;

    if (!datesInWindow.length) {
      log(`[${brandName}] No creative-test buckets found; falling back to direct ad scan...`);
      fallbackGroups = new Map<number, ForeplayAdRecord[]>();

      for await (const ad of client.iterAds({ brandId, startedAfter: cutoffMs })) {
        ensureNotStopped();
        const startedRunning = ad.startedRunning;
        if (typeof startedRunning !== "number" || startedRunning < cutoffMs) {
          continue;
        }

        const dayTimestamp = startOfUtcDay(startedRunning);
        const dayAds = fallbackGroups.get(dayTimestamp) ?? [];
        dayAds.push(ad);
        fallbackGroups.set(dayTimestamp, dayAds);
      }

      datesInWindow = [...fallbackGroups.entries()]
        .sort((left, right) => right[0] - left[0])
        .map(([dayTimestamp, dayAds]) => ({
          date: `yyyy-MM-dd${dayTimestamp}`,
          count: dayAds.length,
          liveCount: dayAds.filter((ad) => Boolean(ad.live)).length
        }));
    }

    log(`[${brandName}] ${datesInWindow.length} date buckets in last ${months} months`);

    for (const [index, dayEntry] of datesInWindow.entries()) {
      ensureNotStopped();
      const dayTimestamp = parseDateTimestamp(dayEntry.date);
      if (!dayTimestamp) {
        continue;
      }

      const dayLabel = new Date(dayTimestamp).toISOString().slice(0, 10);
      log(
        `  [${index + 1}/${datesInWindow.length}] ${dayLabel} (${dayEntry.count ?? "?"} tests, ${dayEntry.liveCount ?? "?"} live)`
      );

      const knownLiveCount = typeof dayEntry.liveCount === "number" ? dayEntry.liveCount : null;
      if (knownLiveCount !== null && knownLiveCount !== 1) {
        if (knownLiveCount === 0) {
          result.failed += 1;
        } else {
          result.inProgress += 1;
        }
        continue;
      }

      const dayAds: ForeplayAdRecord[] =
        fallbackGroups?.get(dayTimestamp) ??
        (await (async () => {
          const items: ForeplayAdRecord[] = [];
          for await (const ad of client.iterAds({
            // Cooperative cancellation while paginating this day bucket.
            brandId,
            startedAfter: dayTimestamp,
            startedBefore: dayTimestamp + DAY_MS - 1
          })) {
            ensureNotStopped();
            items.push(ad);
          }
          return items;
        })());

      result.adsFetched += dayAds.length;
      const liveAds = dayAds.filter((ad) => Boolean(ad.live));

      if (liveAds.length === 1) {
        const winner = { ...liveAds[0] };
        if (!hasInlineMedia(winner)) {
          log(`    [DCO] Fetching card image (collationId=${winner.collationId ?? "none"})...`);
          const imageUrl = await client.getDcoThumbnail({
            brandId,
            collationId: winner.collationId ?? null,
            fbAdId: winner.ad_id ?? null,
            startedRunning: winner.startedRunning ?? null
          });
          if (imageUrl) {
            if (!winner.cards?.length) {
              winner.cards = [{}];
            }
            winner.cards[0] = {
              ...(winner.cards?.[0] ?? {}),
              image: imageUrl
            };
            log(`    [DCO] Found: ${imageUrl.slice(0, 70)}...`);
          } else {
            log("    [DCO] No card image found");
          }
        }

        await this.store.upsertAd(normalizeForeplayWinner(winner, brandName));
        result.winnersFound += 1;
        log(`    *** WINNER: ad_id=${winner.ad_id ?? "unknown"} (${winner.display_format ?? "unknown"})`);
      } else if (liveAds.length === 0) {
        result.failed += 1;
      } else {
        result.inProgress += 1;
      }
    }

    result.datesProcessed = datesInWindow.length;
    log(
      `[${brandName}] Done - ${result.winnersFound} winners, ${result.inProgress} dates in-progress, ${result.failed} dates failed`
    );
    return result;
  }
}
