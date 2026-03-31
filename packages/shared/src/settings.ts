import type { DashboardSettings, MediaFilter } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function createDefaultDashboardSettings(advertisersDbPath = "sources/meta/ads.db"): DashboardSettings {
  return {
    foreplay: {
      brandIds: [],
      months: 3
    },
    adplexity: {
      reportIds: []
    },
    meta: {
      mode: "batch",
      pageId: "",
      keywords: "",
      verticalFilter: "",
      minDays: 30,
      media: "both",
      maxAds: 50,
      advertisersDb: advertisersDbPath
    },
    airtable: {
      enabled: false,
      baseId: "",
      competitorsTable: "Competitors",
      adsTable: "Ads",
      competitorsActiveField: "Active",
      competitorsVerticalField: "Vertical",
      competitorsForeplayField: "Foreplay Brand ID",
      competitorsMetaPageField: "Meta Page ID",
      competitorsAdplexityField: "AdPlexity Report ID",
      adsExternalIdField: "Ad Id",
      autoSyncAdsAfterExtract: false,
      useCompetitorsForForeplay: true,
      useCompetitorsForAdplexity: true,
      useCompetitorsForMetaBatch: true
    },
    autoClassifyAfterExtract: true
  };
}

export function parseStringList(value: unknown): string[] {
  if (value === null || value === undefined) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }

  return String(value)
    .replaceAll(",", "\n")
    .replaceAll("\r", "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function parseIntList(value: unknown): number[] {
  return parseStringList(value)
    .map((token) => Number.parseInt(token, 10))
    .filter((token) => Number.isFinite(token) && token > 0);
}

export function clampInt(
  value: unknown,
  options: {
    defaultValue: number;
    minimum: number;
    maximum: number;
  }
): number {
  const numeric = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(numeric)) {
    return options.defaultValue;
  }
  return Math.max(options.minimum, Math.min(options.maximum, numeric));
}

export function normalizeMedia(value: unknown): MediaFilter {
  const text = String(value ?? "both").trim().toLowerCase();
  if (text === "image" || text === "video" || text === "both") {
    return text;
  }
  return "both";
}

export function normalizeSettings(
  raw: unknown,
  options: {
    advertisersDbPath?: string;
  } = {}
): DashboardSettings {
  const defaults = createDefaultDashboardSettings(options.advertisersDbPath);
  const root = isRecord(raw) ? raw : {};
  const foreplay = isRecord(root.foreplay) ? root.foreplay : {};
  const adplexity = isRecord(root.adplexity) ? root.adplexity : {};
  const meta = isRecord(root.meta) ? root.meta : {};
  const airtable = isRecord(root.airtable) ? root.airtable : {};

  return {
    foreplay: {
      brandIds: parseStringList(foreplay.brandIds ?? foreplay.brand_ids),
      months: clampInt(foreplay.months, {
        defaultValue: defaults.foreplay.months,
        minimum: 1,
        maximum: 24
      })
    },
    adplexity: {
      reportIds: parseIntList(adplexity.reportIds ?? adplexity.report_ids)
    },
    meta: {
      mode: meta.mode === "page" ? "page" : "batch",
      pageId: String(meta.pageId ?? meta.page_id ?? "").trim(),
      keywords: String(meta.keywords ?? "").trim(),
      verticalFilter: String(meta.verticalFilter ?? meta.vertical_filter ?? "").trim(),
      minDays: clampInt(meta.minDays ?? meta.min_days, {
        defaultValue: defaults.meta.minDays,
        minimum: 0,
        maximum: 365
      }),
      media: normalizeMedia(meta.media),
      maxAds: clampInt(meta.maxAds ?? meta.max_ads, {
        defaultValue: defaults.meta.maxAds,
        minimum: 1,
        maximum: 250
      }),
      advertisersDb: String(meta.advertisersDb ?? meta.advertisers_db ?? defaults.meta.advertisersDb).trim()
    },
    airtable: {
      enabled: Boolean(airtable.enabled ?? defaults.airtable.enabled),
      baseId: String(airtable.baseId ?? airtable.base_id ?? defaults.airtable.baseId).trim(),
      competitorsTable: String(
        airtable.competitorsTable ?? airtable.competitors_table ?? defaults.airtable.competitorsTable
      ).trim(),
      adsTable: String(airtable.adsTable ?? airtable.ads_table ?? defaults.airtable.adsTable).trim(),
      competitorsActiveField: String(
        airtable.competitorsActiveField ??
          airtable.competitors_active_field ??
          defaults.airtable.competitorsActiveField
      ).trim(),
      competitorsVerticalField: String(
        airtable.competitorsVerticalField ??
          airtable.competitors_vertical_field ??
          defaults.airtable.competitorsVerticalField
      ).trim(),
      competitorsForeplayField: String(
        airtable.competitorsForeplayField ??
          airtable.competitors_foreplay_field ??
          defaults.airtable.competitorsForeplayField
      ).trim(),
      competitorsMetaPageField: String(
        airtable.competitorsMetaPageField ??
          airtable.competitors_meta_page_field ??
          defaults.airtable.competitorsMetaPageField
      ).trim(),
      competitorsAdplexityField: String(
        airtable.competitorsAdplexityField ??
          airtable.competitors_adplexity_field ??
          defaults.airtable.competitorsAdplexityField
      ).trim(),
      adsExternalIdField: String(
        airtable.adsExternalIdField ?? airtable.ads_external_id_field ?? defaults.airtable.adsExternalIdField
      ).trim(),
      autoSyncAdsAfterExtract: Boolean(
        airtable.autoSyncAdsAfterExtract ??
          airtable.auto_sync_ads_after_extract ??
          defaults.airtable.autoSyncAdsAfterExtract
      ),
      useCompetitorsForForeplay: Boolean(
        airtable.useCompetitorsForForeplay ??
          airtable.use_competitors_for_foreplay ??
          defaults.airtable.useCompetitorsForForeplay
      ),
      useCompetitorsForAdplexity: Boolean(
        airtable.useCompetitorsForAdplexity ??
          airtable.use_competitors_for_adplexity ??
          defaults.airtable.useCompetitorsForAdplexity
      ),
      useCompetitorsForMetaBatch: Boolean(
        airtable.useCompetitorsForMetaBatch ??
          airtable.use_competitors_for_meta_batch ??
          defaults.airtable.useCompetitorsForMetaBatch
      )
    },
    autoClassifyAfterExtract: Boolean(
      root.autoClassifyAfterExtract ?? root.auto_classify_after_extract ?? defaults.autoClassifyAfterExtract
    )
  };
}
