import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { DashboardSettings, NormalizedAd } from "@competitors/shared";

import type { FileBackedIntelligenceStore } from "../../data-store.js";
import { scrapeMetaAdsDirect, type DirectMetaAdRecord } from "./direct-scraper.js";

type LogFn = (...parts: unknown[]) => void;

interface MetaExtractionResult {
  scanned: number;
  stored: number;
  advertisers: number;
}

interface MetaAdRow {
  source_id: string;
  advertiser_id: number | null;
  advertiser_name: string;
  headline: string;
  ad_copy: string;
  cta: string;
  media_type: string;
  media_path: string;
  ad_link: string;
  landing_url: string;
  platforms: string;
  started_running_date: string;
  running_days: number;
  scraped_at: string;
  vertical: string | null;
}

interface AdvertiserRow {
  id: number;
  name: string;
  page_id: string;
  vertical: string;
}

function normalizePageId(value: string): string {
  return value.replace(/[^\d]/g, "").trim();
}

function parseKeywords(value: string): string[] {
  return value
    .replaceAll(",", "\n")
    .split(/\r?\n/)
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
}

function parsePlatforms(value: string): string[] {
  return value
    .replace(/[;|]/g, ",")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeMediaPath(repoRoot: string, metaSourceDir: string, mediaPath: string): string | null {
  const raw = String(mediaPath ?? "").trim();
  if (!raw) {
    return null;
  }

  if (/^https?:\/\//i.test(raw) || raw.startsWith("data:")) {
    return raw;
  }

  const absolute = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(metaSourceDir, raw);
  const relative = path.relative(repoRoot, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }

  return relative.replace(/\\/g, "/");
}

function toNormalizedAdFromSqlite(
  row: MetaAdRow,
  repoRoot: string,
  metaSourceDir: string
): Partial<NormalizedAd> & Pick<NormalizedAd, "source" | "sourceId"> {
  const mediaPath = normalizeMediaPath(repoRoot, metaSourceDir, row.media_path);
  const mediaType = String(row.media_type ?? "").trim().toLowerCase();
  const sourceId = String(row.source_id ?? "").trim();
  const adLibraryUrl =
    String(row.ad_link ?? "").trim() || (sourceId ? `https://www.facebook.com/ads/library/?id=${sourceId}` : "");

  const isVideo = mediaType.includes("video");
  const isImage = mediaType.includes("image");

  return {
    source: "meta",
    sourceId,
    brand: String(row.advertiser_name ?? "").trim(),
    title: String(row.headline ?? "").trim(),
    adCopy: String(row.ad_copy ?? "").trim(),
    firstSeen: String(row.started_running_date ?? "").trim() || null,
    lastSeen: String(row.scraped_at ?? "").trim() || null,
    daysRunning: Number.isFinite(Number(row.running_days)) ? Number(row.running_days) : null,
    status: Number(row.running_days) > 0 ? "active" : "inactive",
    countries: ["US"],
    platforms: parsePlatforms(String(row.platforms ?? "")),
    cta: String(row.cta ?? "").trim(),
    videoUrl: isVideo ? mediaPath : null,
    imageUrl: isImage ? mediaPath : isVideo ? null : mediaPath,
    landingPageUrl: String(row.landing_url ?? "").trim() || null,
    adLibraryUrl: adLibraryUrl || null,
    vertical: String(row.vertical ?? "").trim() || null,
    fetchedAt: String(row.scraped_at ?? "").trim() || undefined
  };
}

function toNormalizedAdFromDirect(row: DirectMetaAdRecord): Partial<NormalizedAd> & Pick<NormalizedAd, "source" | "sourceId"> {
  return {
    source: "meta",
    sourceId: row.libraryId,
    brand: row.advertiser,
    title: row.headline,
    adCopy: row.adCopy,
    firstSeen: row.startedRunningDate || null,
    lastSeen: row.scrapedAt || null,
    daysRunning: row.runningDays,
    status: row.runningDays > 0 ? "active" : "inactive",
    countries: ["US"],
    platforms: parsePlatforms(row.platforms),
    cta: row.cta,
    videoUrl: row.mediaType === "video" ? row.mediaUrl : null,
    imageUrl: row.mediaType === "image" ? row.mediaUrl : null,
    landingPageUrl: row.landingUrl || null,
    adLibraryUrl: row.adLink || `https://www.facebook.com/ads/library/?id=${row.libraryId}`,
    vertical: null,
    fetchedAt: row.scrapedAt
  };
}

export class MetaExtractorService {
  constructor(
    private readonly store: FileBackedIntelligenceStore,
    private readonly repoRoot: string,
    private readonly defaultMetaSourceDir: string
  ) {}

  async extract(options: {
    settings: DashboardSettings["meta"];
    log?: LogFn;
    shouldStop?: () => boolean;
  }): Promise<MetaExtractionResult> {
    const log = options.log ?? console.log;
    const shouldStop = options.shouldStop ?? (() => false);

    if (options.settings.mode === "page") {
      const rawPageId = options.settings.pageId.trim();
      const pageId = normalizePageId(rawPageId);
      if (!pageId) {
        throw new Error("Meta direct mode requires a page ID.");
      }
      if (pageId !== rawPageId) {
        log(`Normalized Meta page ID from '${rawPageId}' to '${pageId}'.`);
      }

      log(`Starting Meta direct scrape for page_id=${pageId}...`);
      const directAds = await scrapeMetaAdsDirect({
        pageId,
        keywords: options.settings.keywords,
        minDays: options.settings.minDays,
        media: options.settings.media,
        maxAds: options.settings.maxAds,
        log,
        shouldStop
      });
      if (shouldStop()) {
        throw new Error("Job stopped by user.");
      }

      const normalized = directAds.map(toNormalizedAdFromDirect);
      const stored = await this.store.upsertAds(normalized);
      log("Meta direct scrape finished.");

      return {
        scanned: directAds.length,
        stored,
        advertisers: 1
      };
    }

    const dbPath = path.isAbsolute(options.settings.advertisersDb)
      ? options.settings.advertisersDb
      : path.resolve(this.repoRoot, options.settings.advertisersDb);

    if (!fs.existsSync(dbPath)) {
      throw new Error(`Meta database not found: ${dbPath}`);
    }

    const metaSourceDir = path.dirname(dbPath) || this.defaultMetaSourceDir;
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const advertisers = this.selectAdvertisers(db, options.settings, log);
      const ads = this.selectAds(db, options.settings, advertisers, log);
      if (shouldStop()) {
        throw new Error("Job stopped by user.");
      }

      const normalized = ads.map((row) => toNormalizedAdFromSqlite(row, this.repoRoot, metaSourceDir));
      const stored = await this.store.upsertAds(normalized);

      return {
        scanned: ads.length,
        stored,
        advertisers: advertisers.length
      };
    } finally {
      db.close();
    }
  }

  private selectAdvertisers(
    db: DatabaseSync,
    settings: DashboardSettings["meta"],
    log: LogFn
  ): AdvertiserRow[] {
    if (settings.verticalFilter.trim()) {
      const rows = db
        .prepare("SELECT id, name, page_id, vertical FROM advertisers WHERE vertical = ? ORDER BY name")
        .all(settings.verticalFilter.trim()) as unknown as AdvertiserRow[];
      if (!rows.length) {
        log(`No advertisers found for vertical '${settings.verticalFilter}'. Using all stored ads.`);
      }
      return rows;
    }

    return db.prepare("SELECT id, name, page_id, vertical FROM advertisers ORDER BY name").all() as unknown as AdvertiserRow[];
  }

  private selectAds(
    db: DatabaseSync,
    settings: DashboardSettings["meta"],
    advertisers: AdvertiserRow[],
    log: LogFn
  ): MetaAdRow[] {
    const clauses: string[] = ["a.source = 'meta'"];
    const params: Array<string | number> = [];

    if (settings.minDays > 0) {
      clauses.push("COALESCE(a.running_days, 0) >= ?");
      params.push(settings.minDays);
    }

    if (settings.media !== "both") {
      clauses.push("LOWER(COALESCE(a.media_type, '')) = ?");
      params.push(settings.media.toLowerCase());
    }

    const keywords = parseKeywords(settings.keywords);
    for (const keyword of keywords) {
      clauses.push(
        "(LOWER(COALESCE(a.headline, '')) LIKE ? OR LOWER(COALESCE(a.ad_copy, '')) LIKE ? OR LOWER(COALESCE(a.search_term, '')) LIKE ?)"
      );
      const token = `%${keyword}%`;
      params.push(token, token, token);
    }

    if (settings.verticalFilter.trim() && advertisers.length) {
      const advertiserIds = advertisers.map((item) => item.id);
      const names = advertisers.map((item) => item.name.toLowerCase());
      const idPlaceholders = advertiserIds.map(() => "?").join(", ");
      const namePlaceholders = names.map(() => "?").join(", ");
      clauses.push(
        `((a.advertiser_id IN (${idPlaceholders})) OR (LOWER(COALESCE(a.advertiser_name, '')) IN (${namePlaceholders})))`
      );
      params.push(...advertiserIds, ...names);
    }

    if (settings.maxAds > 0) {
      log("Batch mode ignores maxAds per advertiser and returns all matching stored ads.");
    }

    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    const sql = `
      SELECT
        a.source_id,
        a.advertiser_id,
        a.advertiser_name,
        a.headline,
        a.ad_copy,
        a.cta,
        a.media_type,
        a.media_path,
        a.ad_link,
        a.landing_url,
        a.platforms,
        a.started_running_date,
        a.running_days,
        a.scraped_at,
        adv.vertical AS vertical
      FROM ads a
      LEFT JOIN advertisers adv ON adv.id = a.advertiser_id
      ${where}
      ORDER BY COALESCE(a.running_days, 0) DESC, COALESCE(a.scraped_at, '') DESC
    `;

    return db.prepare(sql).all(...params) as unknown as MetaAdRow[];
  }
}
