import fs from "node:fs/promises";
import path from "node:path";

import {
  buildDashboardPayload,
  normalizeAd,
  normalizeSource,
  normalizeStatus,
  nowIso,
  type DashboardPayload,
  type NormalizedAd
} from "@competitors/shared";

interface IntelligenceStoreFile {
  nextId: number;
  updatedAt: string;
  ads: NormalizedAd[];
}

interface GetAdsOptions {
  source?: string | null;
  vertical?: string | null;
  status?: string | null;
  brand?: string | null;
  limit?: number | null;
}

function emptyStore(): IntelligenceStoreFile {
  return {
    nextId: 1,
    updatedAt: nowIso(),
    ads: []
  };
}

function compareAds(left: NormalizedAd, right: NormalizedAd): number {
  const dayDelta = (right.daysRunning ?? -1) - (left.daysRunning ?? -1);
  if (dayDelta !== 0) {
    return dayDelta;
  }

  const firstSeenDelta = (right.firstSeen ?? "").localeCompare(left.firstSeen ?? "");
  if (firstSeenDelta !== 0) {
    return firstSeenDelta;
  }

  const sourceDelta = left.source.localeCompare(right.source);
  if (sourceDelta !== 0) {
    return sourceDelta;
  }

  return left.brand.localeCompare(right.brand);
}

function looksLikeOpaqueIdentifier(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed)) {
    return false;
  }

  return /^[A-Za-z0-9]{10,}$/.test(trimmed);
}

export class FileBackedIntelligenceStore {
  constructor(private readonly storePath: string) {}

  async initialize(): Promise<void> {
    const existing = await this.readStore();
    await this.writeStore(existing);
  }

  async getAds(options: GetAdsOptions = {}): Promise<NormalizedAd[]> {
    const store = await this.readStore();
    let ads = [...store.ads];

    if (options.source && options.source !== "all") {
      const source = normalizeSource(options.source);
      ads = ads.filter((ad) => ad.source === source);
    }

    if (options.vertical && options.vertical !== "all") {
      if (options.vertical === "unclassified") {
        ads = ads.filter((ad) => !ad.vertical);
      } else {
        ads = ads.filter((ad) => ad.vertical === options.vertical);
      }
    }

    if (options.status && options.status !== "all") {
      const status = normalizeStatus(options.status);
      ads = ads.filter((ad) => ad.status === status);
    }

    if (options.brand) {
      const query = options.brand.trim().toLowerCase();
      ads = ads.filter((ad) => ad.brand.toLowerCase().includes(query));
    }

    ads.sort(compareAds);

    if (options.limit && options.limit > 0) {
      ads = ads.slice(0, options.limit);
    }

    return ads;
  }

  async getUnclassifiedAds(limit?: number | null): Promise<NormalizedAd[]> {
    const ads = (await this.readStore()).ads
      .filter((ad) => !ad.vertical)
      .sort(compareAds);
    return limit && limit > 0 ? ads.slice(0, limit) : ads;
  }

  async getDashboardPayload(): Promise<DashboardPayload> {
    const store = await this.readStore();
    return buildDashboardPayload([...store.ads].sort(compareAds), {
      generatedAt: store.updatedAt
    });
  }

  async getDataVersion(): Promise<string> {
    return (await this.readStore()).updatedAt;
  }

  async upsertAd(ad: Partial<NormalizedAd> & Pick<NormalizedAd, "source" | "sourceId">): Promise<NormalizedAd> {
    const store = await this.readStore();
    const normalized = normalizeAd(ad);
    const index = store.ads.findIndex(
      (item) => item.source === normalized.source && item.sourceId === normalized.sourceId
    );

    if (index >= 0) {
      const existing = store.ads[index];
      const brand =
        existing.brand && looksLikeOpaqueIdentifier(normalized.brand) ? existing.brand : normalized.brand;
      const merged: NormalizedAd = {
        ...existing,
        ...normalized,
        id: existing.id,
        brand,
        vertical: existing.vertical ?? normalized.vertical
      };
      store.ads[index] = merged;
      store.updatedAt = nowIso();
      await this.writeStore(store);
      return merged;
    }

    const created: NormalizedAd = {
      ...normalized,
      id: store.nextId
    };
    store.nextId += 1;
    store.ads.push(created);
    store.updatedAt = nowIso();
    await this.writeStore(store);
    return created;
  }

  async upsertAds(ads: Array<Partial<NormalizedAd> & Pick<NormalizedAd, "source" | "sourceId">>): Promise<number> {
    for (const ad of ads) {
      await this.upsertAd(ad);
    }
    return ads.length;
  }

  async bulkUpdateVertical(updates: Array<[number, string | null]>): Promise<number> {
    if (!updates.length) {
      return 0;
    }

    const store = await this.readStore();
    const map = new Map<number, string | null>(updates);

    store.ads = store.ads.map((ad) =>
      ad.id && map.has(ad.id)
        ? {
            ...ad,
            vertical: map.get(ad.id) ?? null
          }
        : ad
    );
    store.updatedAt = nowIso();
    await this.writeStore(store);
    return updates.length;
  }

  private async readStore(): Promise<IntelligenceStoreFile> {
    try {
      const raw = await fs.readFile(this.storePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<IntelligenceStoreFile>;
      const ads = Array.isArray(parsed.ads) ? parsed.ads.map((ad) => normalizeAd(ad)) : [];
      const nextId =
        typeof parsed.nextId === "number"
          ? parsed.nextId
          : ads.reduce((max, ad) => Math.max(max, ad.id ?? 0), 0) + 1;

      return {
        nextId,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : nowIso(),
        ads
      };
    } catch {
      return emptyStore();
    }
  }

  private async writeStore(store: IntelligenceStoreFile): Promise<void> {
    await fs.mkdir(path.dirname(this.storePath), { recursive: true });
    await fs.writeFile(this.storePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  }
}
