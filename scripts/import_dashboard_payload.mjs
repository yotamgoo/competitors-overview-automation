import fs from "node:fs";
import path from "node:path";

const [, , inputPath, outputPath] = process.argv;

if (!inputPath || !outputPath) {
  console.error("Usage: node scripts/import_dashboard_payload.mjs <payload.json> <store.json>");
  process.exit(1);
}

const payloadText = fs.readFileSync(inputPath, "utf8").replace(/^\uFEFF/, "");
const payload = JSON.parse(payloadText);
const ads = Array.isArray(payload.ads) ? payload.ads : [];

const normalizedAds = ads.map((ad) => ({
  id: typeof ad.id === "number" ? ad.id : undefined,
  source: ad.source,
  sourceId: String(ad.sourceId ?? ""),
  brand: String(ad.brand ?? ""),
  title: String(ad.title ?? ""),
  adCopy: String(ad.adCopy ?? ""),
  firstSeen: ad.firstSeen ?? null,
  lastSeen: ad.lastSeen ?? null,
  daysRunning: typeof ad.daysRunning === "number" ? ad.daysRunning : null,
  status: ad.status === "inactive" ? "inactive" : "active",
  countries: Array.isArray(ad.countries) ? ad.countries : [],
  platforms: Array.isArray(ad.platforms) ? ad.platforms : [],
  cta: String(ad.cta ?? ""),
  videoUrl: ad.videoUrl ?? null,
  imageUrl: ad.imageUrl ?? null,
  landingPageUrl: ad.landingPageUrl ?? null,
  adLibraryUrl: ad.adLibraryUrl ?? null,
  vertical: ad.vertical ?? null,
  fetchedAt: ad.fetchedAt ?? payload.generatedAt ?? new Date().toISOString(),
  isWinner: Boolean(ad.isWinner),
  winnerLabel: ad.winnerLabel ?? null
}));

const nextId =
  normalizedAds.reduce((max, ad) => Math.max(max, typeof ad.id === "number" ? ad.id : 0), 0) + 1;

const store = {
  nextId,
  updatedAt: payload.generatedAt ?? new Date().toISOString(),
  ads: normalizedAds
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
console.log(`Wrote ${normalizedAds.length} ads to ${outputPath}`);
