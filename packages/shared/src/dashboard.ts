import {
  displayBrandFromUrl,
  formatPlatform,
  formatSource,
  normalizeCountryList,
  normalizeDateTime,
  normalizeDaysRunning,
  normalizeOptionalText,
  normalizePlatformList,
  normalizeSource,
  normalizeStatus,
  nowIso
} from "./normalize.js";
import type { DashboardAdCard, DashboardPayload, DashboardStats, NormalizedAd } from "./types.js";

export function normalizeAd(
  input: Partial<NormalizedAd> & Pick<NormalizedAd, "source" | "sourceId">
): NormalizedAd {
  const normalized: NormalizedAd = {
    id: typeof input.id === "number" ? input.id : undefined,
    source: normalizeSource(input.source),
    sourceId: String(input.sourceId ?? "").trim(),
    brand: String(input.brand ?? "").trim(),
    title: String(input.title ?? "").trim(),
    adCopy: String(input.adCopy ?? "").trim(),
    firstSeen: normalizeDateTime(input.firstSeen),
    lastSeen: normalizeDateTime(input.lastSeen),
    daysRunning: normalizeDaysRunning(input.daysRunning, {
      firstSeen: input.firstSeen,
      lastSeen: input.lastSeen
    }),
    status: normalizeStatus(input.status),
    countries: normalizeCountryList(input.countries),
    platforms: normalizePlatformList(input.platforms),
    cta: String(input.cta ?? "").trim(),
    videoUrl: normalizeOptionalText(input.videoUrl),
    imageUrl: normalizeOptionalText(input.imageUrl),
    landingPageUrl: normalizeOptionalText(input.landingPageUrl),
    adLibraryUrl: normalizeOptionalText(input.adLibraryUrl),
    vertical: normalizeOptionalText(input.vertical),
    fetchedAt: normalizeDateTime(input.fetchedAt) ?? nowIso()
  };

  if (!normalized.sourceId) {
    throw new Error("sourceId is required");
  }

  normalized.isWinner = normalized.source === "foreplay";
  normalized.winnerLabel = normalized.isWinner ? "Winner" : null;
  return normalized;
}

export function prepareDashboardAd(ad: NormalizedAd): DashboardAdCard {
  const verticalText = ad.vertical ?? "unclassified";
  const brandText = ad.brand || displayBrandFromUrl(ad.landingPageUrl);
  const isWinner = ad.source === "foreplay" || Boolean(ad.isWinner);

  return {
    ...ad,
    isWinner,
    winnerLabel: isWinner ? "Winner" : null,
    countriesText: ad.countries.length ? ad.countries.join(", ") : "Global",
    platformsText: ad.platforms.length ? ad.platforms.map(formatPlatform).join(", ") : "Unknown",
    verticalText,
    statusText: ad.status,
    brandText: brandText || "Unknown brand",
    sourceText: formatSource(ad.source),
    titleText: ad.title,
    copyText: ad.adCopy,
    videoHref: ad.videoUrl,
    imageHref: ad.imageUrl,
    firstSeenText: ad.firstSeen ?? "Unknown",
    lastSeenText: ad.lastSeen ?? "Unknown",
    daysRunningText: ad.daysRunning ?? "n/a",
    winnerText: isWinner ? "Foreplay Winner" : ""
  };
}

export function buildDashboardStats(ads: DashboardAdCard[]): DashboardStats {
  const bySource: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  const byVertical: Record<string, number> = {};

  for (const ad of ads) {
    bySource[ad.source] = (bySource[ad.source] ?? 0) + 1;
    byStatus[ad.status] = (byStatus[ad.status] ?? 0) + 1;
    const vertical = ad.vertical ?? "unclassified";
    byVertical[vertical] = (byVertical[vertical] ?? 0) + 1;
  }

  return {
    totalAds: ads.length,
    winnerAds: ads.filter((ad) => ad.isWinner).length,
    bySource,
    byStatus,
    byVertical
  };
}

export function buildDashboardPayload(
  ads: NormalizedAd[],
  options: {
    generatedAt?: string;
  } = {}
): DashboardPayload {
  const cards = ads.map(prepareDashboardAd);
  return {
    generatedAt: options.generatedAt ?? nowIso(),
    stats: buildDashboardStats(cards),
    ads: cards
  };
}
