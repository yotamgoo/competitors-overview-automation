import { displayBrandFromUrl, normalizeCountryList, normalizePlatformList, nowIso, type NormalizedAd } from "@competitors/shared";

import type { FileBackedIntelligenceStore } from "../../data-store.js";
import { AdplexityClient, type AdplexityAdDetailRecord, type AdplexityListingRecord } from "./client.js";

type LogFn = (...parts: unknown[]) => void;

export interface AdplexityExtractionResult {
  reportId: number;
  reportName: string;
  adsFetched: number;
  detailsFetched: number;
  failed: number;
}

function pickFirstText(...values: unknown[]): string {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text && text.toLowerCase() !== "null" && text.toLowerCase() !== "none") {
      return text;
    }
  }
  return "";
}

function inferBrandFromTitle(title: string): string {
  const text = String(title ?? "").trim();
  if (!text) {
    return "";
  }

  if (text.includes(":")) {
    const candidate = text.split(":").at(-1)?.trim() ?? "";
    if (candidate && candidate.split(/\s+/).length <= 5) {
      return candidate;
    }
  }

  if (text.includes("|")) {
    const candidate = text.split("|")[0]?.trim() ?? "";
    if (candidate && candidate.split(/\s+/).length <= 5) {
      return candidate;
    }
  }
  return "";
}

function inferBrandFromUrl(url: string | null): string {
  if (!url) {
    return "";
  }

  try {
    const parsed = new URL(url);
    let host = parsed.hostname.toLowerCase();
    if (host.startsWith("www.")) {
      host = host.slice(4);
    }
    if (!host) {
      return "";
    }

    const rawParts = host.split(".").filter(Boolean);
    if (!rawParts.length) {
      return "";
    }

    let core = rawParts.length >= 2 ? rawParts[rawParts.length - 2] : rawParts[0];
    if (["l", "m", "app", "go", "click"].includes(core) && rawParts.length >= 3) {
      core = rawParts[rawParts.length - 3];
    }
    return core
      .replaceAll("-", " ")
      .replaceAll("_", " ")
      .replace(/\b\w/g, (match) => match.toUpperCase());
  } catch {
    return "";
  }
}

function toAdplexityId(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : null;
}

function normalizeListingAd(listing: AdplexityListingRecord): Partial<NormalizedAd> & Pick<NormalizedAd, "source" | "sourceId"> {
  const adplexityId = toAdplexityId(listing.id);
  if (adplexityId === null) {
    throw new Error("AdPlexity listing is missing a numeric id.");
  }

  const title = String(listing.title ?? listing.title_en ?? "").trim();
  const landingPage = String(listing.landing_page_url ?? "").trim() || null;
  const brand = pickFirstText(
    listing.advertiser,
    listing.advertiser_name,
    listing.brand,
    inferBrandFromTitle(title),
    inferBrandFromUrl(landingPage)
  );

  return {
    source: "adplexity",
    sourceId: String(adplexityId),
    brand,
    title,
    adCopy: "",
    firstSeen: String(listing.first_seen ?? "").trim() || null,
    lastSeen: String(listing.last_seen ?? "").trim() || null,
    daysRunning: toAdplexityId(listing.days_total) ?? toAdplexityId(listing.hits_total),
    status: Number(listing.meta_status ?? 0) === 1 ? "active" : "inactive",
    countries: normalizeCountryList(listing.countries),
    platforms: [],
    cta: "",
    videoUrl: null,
    imageUrl: String(listing.thumb_url ?? "").trim() || null,
    landingPageUrl: landingPage,
    adLibraryUrl: null,
    vertical: null,
    fetchedAt: nowIso()
  };
}

function normalizeDetailedAd(
  adplexityId: number,
  listing: AdplexityListingRecord | null,
  detail: AdplexityAdDetailRecord
): Partial<NormalizedAd> & Pick<NormalizedAd, "source" | "sourceId"> {
  const adData = detail.ad ?? {};
  const meta = typeof adData.meta === "object" && adData.meta ? (adData.meta as Record<string, unknown>) : {};
  const listingData = listing ?? ({ id: adplexityId } as AdplexityListingRecord);
  const videoList =
    (Array.isArray(detail.videos) ? detail.videos : null) ??
    (Array.isArray(meta.videos) ? (meta.videos as Array<{ url?: string }>) : []);
  const videoUrl = String(videoList?.[0]?.url ?? "").trim() || null;
  const metaAdId = String(meta.ad_id ?? listingData.meta_ad_id ?? "").trim();
  const title = pickFirstText(listingData.title, listingData.title_en, adData.title);
  const landingPageUrl = pickFirstText(meta.url, listingData.landing_page_url) || null;
  const brand = pickFirstText(
    adData.advertiser,
    adData.advertiser_name,
    meta.advertiser,
    meta.advertiser_name,
    meta.brand,
    listingData.advertiser,
    listingData.advertiser_name,
    listingData.brand,
    inferBrandFromTitle(title),
    inferBrandFromUrl(landingPageUrl),
    displayBrandFromUrl(landingPageUrl)
  );

  return {
    source: "adplexity",
    sourceId: String(adplexityId),
    brand,
    title,
    adCopy: String(adData.description ?? adData.description_en ?? "").trim(),
    firstSeen: String(listingData.first_seen ?? "").trim() || null,
    lastSeen: String(listingData.last_seen ?? "").trim() || null,
    daysRunning: toAdplexityId(listingData.days_total) ?? toAdplexityId(listingData.hits_total),
    status: Number(listingData.meta_status ?? 0) === 1 ? "active" : "inactive",
    countries: normalizeCountryList(listingData.countries),
    platforms: normalizePlatformList(meta.platforms),
    cta: String(meta.cta_type_name ?? meta.cta_type ?? "").trim(),
    videoUrl,
    imageUrl: String(listingData.thumb_url ?? "").trim() || null,
    landingPageUrl,
    adLibraryUrl: metaAdId ? `https://www.facebook.com/ads/library/?id=${metaAdId}` : null,
    vertical: null,
    fetchedAt: nowIso()
  };
}

export class AdplexityExtractorService {
  constructor(
    private readonly store: FileBackedIntelligenceStore,
    private readonly credentials: {
      email: string;
      password: string;
    }
  ) {}

  async extract(options: {
    reportIds: number[];
    log?: LogFn;
    shouldStop?: () => boolean;
  }): Promise<AdplexityExtractionResult[]> {
    if (!this.credentials.email || !this.credentials.password) {
      throw new Error("AdPlexity credentials are missing.");
    }

    const log = options.log ?? console.log;
    const shouldStop = options.shouldStop ?? (() => false);
    const ensureNotStopped = () => {
      if (shouldStop()) {
        throw new Error("Job stopped by user.");
      }
    };

    ensureNotStopped();
    const reportIds = [...new Set(options.reportIds.filter((value) => Number.isFinite(value) && value > 0))];
    if (!reportIds.length) {
      return [];
    }

    const client = new AdplexityClient(this.credentials.email, this.credentials.password, log);
    await client.initialize();
    ensureNotStopped();

    const reportNameLookup = new Map<number, string>();
    try {
      const reports = await client.listReports();
      ensureNotStopped();
      for (const report of reports) {
        reportNameLookup.set(report.id, report.name);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Could not fetch report names: ${message}`);
    }

    const results: AdplexityExtractionResult[] = [];
    for (const reportId of reportIds) {
      ensureNotStopped();
      const reportName = reportNameLookup.get(reportId) ?? String(reportId);
      const result: AdplexityExtractionResult = {
        reportId,
        reportName,
        adsFetched: 0,
        detailsFetched: 0,
        failed: 0
      };
      results.push(result);

      log(`[${reportName}] Fetching ads from report ${reportId}...`);
      const listingById = new Map<number, AdplexityListingRecord>();

      for await (const listing of client.iterReportAds(reportId)) {
        ensureNotStopped();
        const adplexityId = toAdplexityId(listing.id);
        if (adplexityId === null) {
          continue;
        }
        listingById.set(adplexityId, listing);
        await this.store.upsertAd(normalizeListingAd(listing));
      }

      result.adsFetched = listingById.size;
      log(`[${reportName}] ${result.adsFetched} ads found`);
      log(`[${reportName}] Fetching ad details...`);

      const ids = [...listingById.keys()];
      for (const [index, adplexityId] of ids.entries()) {
        ensureNotStopped();
        log(`  [${index + 1}/${ids.length}] ad ${adplexityId}`);
        try {
          const detail = await client.getAdDetail(adplexityId);
          if (!detail) {
            log("    -> not found");
            result.failed += 1;
            continue;
          }

          await this.store.upsertAd(normalizeDetailedAd(adplexityId, listingById.get(adplexityId) ?? null, detail));
          result.detailsFetched += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log(`    -> error: ${message}`);
          result.failed += 1;
        }
      }

      log(
        `[${reportName}] Done - ${result.adsFetched} ads, ${result.detailsFetched} enriched, ${result.failed} failed`
      );
    }

    return results;
  }
}
