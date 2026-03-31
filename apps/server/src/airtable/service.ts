import type { AirtableSettings, NormalizedAd } from "@competitors/shared";

type LogFn = (...parts: unknown[]) => void;

interface AirtableRecord {
  id: string;
  fields?: Record<string, unknown>;
}

interface AirtableListResponse {
  records?: AirtableRecord[];
  offset?: string;
}

interface AirtableMetadataResponse {
  tables?: Array<{
    id?: string;
    name?: string;
    fields?: Array<{ name?: string }>;
  }>;
}

interface AirtableWriteSummary {
  total: number;
  created: number;
  updated: number;
  skipped: number;
}

export interface AirtableCompetitorSnapshot {
  totalRows: number;
  activeRows: number;
  foreplayBrandIds: string[];
  metaPageIds: string[];
  adplexityReportIds: number[];
}

const BASE_URL = "https://api.airtable.com/v0/";
const META_BASE_URL = "https://api.airtable.com/v0/meta/";
const MAX_RETRIES = 4;
const MAX_BATCH = 10;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toStringList(value: unknown): string[] {
  if (value === null || value === undefined) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => toStringList(item));
  }

  if (typeof value === "number") {
    return [String(value)];
  }

  const text = String(value).trim();
  if (!text) {
    return [];
  }

  return text
    .replaceAll(";", ",")
    .split(/[\n,]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function toIntList(value: unknown): number[] {
  return toStringList(value)
    .map((token) => Number.parseInt(token, 10))
    .filter((token) => Number.isFinite(token) && token > 0);
}

function fieldValue(fields: Record<string, unknown>, fieldName: string): unknown {
  const wanted = fieldName.trim();
  if (!wanted) {
    return undefined;
  }
  if (wanted in fields) {
    return fields[wanted];
  }

  const lowerWanted = wanted.toLowerCase();
  for (const [key, value] of Object.entries(fields)) {
    if (key.trim().toLowerCase() === lowerWanted) {
      return value;
    }
  }
  return undefined;
}

function collectStringValues(fields: Record<string, unknown>, fieldNames: string[]): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const fieldName of fieldNames) {
    const raw = fieldValue(fields, fieldName);
    if (raw === undefined) {
      continue;
    }
    for (const value of toStringList(raw)) {
      if (!seen.has(value)) {
        seen.add(value);
        output.push(value);
      }
    }
  }
  return output;
}

function collectIntValues(fields: Record<string, unknown>, fieldNames: string[]): number[] {
  const output: number[] = [];
  const seen = new Set<number>();
  for (const fieldName of fieldNames) {
    const raw = fieldValue(fields, fieldName);
    if (raw === undefined) {
      continue;
    }
    for (const value of toIntList(raw)) {
      if (!seen.has(value)) {
        seen.add(value);
        output.push(value);
      }
    }
  }
  return output;
}

function isActiveValue(value: unknown): boolean {
  if (value === undefined || value === null || value === "") {
    return true;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }

  const text = String(value).trim().toLowerCase();
  if (!text) {
    return true;
  }
  if (["false", "0", "no", "off", "inactive", "disabled"].includes(text)) {
    return false;
  }
  return true;
}

function chunk<T>(items: T[], size: number): T[][] {
  const slices: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    slices.push(items.slice(index, index + size));
  }
  return slices;
}

function adExternalId(ad: NormalizedAd): string {
  return `${ad.source}:${ad.sourceId}`;
}

function firstNonEmptyText(values: unknown[]): string {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) {
      return text;
    }
  }
  return "";
}

function resolveExternalIdField(settings: AirtableSettings, allowedFields: Set<string> | null): string {
  const configured = settings.adsExternalIdField.trim();
  if (!allowedFields) {
    if (configured.toLowerCase() === "ad id") {
      return configured;
    }
    return "Ad Id";
  }

  if (configured && allowedFields.has(configured)) {
    return configured;
  }
  if (allowedFields.has("Ad Id")) {
    return "Ad Id";
  }
  if (allowedFields.has("External ID")) {
    return "External ID";
  }
  if (configured) {
    return configured;
  }

  return "Ad Id";
}

function adToFields(ad: NormalizedAd, externalIdField: string): Record<string, unknown> {
  const externalId = adExternalId(ad);
  const vertical = ad.vertical ?? "unclassified";
  const mediaUrl = firstNonEmptyText([ad.videoUrl, ad.imageUrl]);

  const fields: Record<string, unknown> = {
    "Ad Id": externalId,
    Brand: ad.brand,
    Title: ad.title,
    "Ad Copy": ad.adCopy,
    "First Seen": ad.firstSeen,
    "Last Seen": ad.lastSeen,
    "Days Running": ad.daysRunning,
    Duplicates: "",
    Winner: ad.source === "foreplay",
    Status: ad.status,
    Country: ad.countries.join(", "),
    Categories: vertical,
    Platforms: ad.platforms.join(", "),
    CTA: ad.cta,
    "Ad URL": ad.adLibraryUrl,
    "Landing Page URL": ad.landingPageUrl,
    "Product Category": vertical,
    "Media URL": mediaUrl
  };

  if (externalIdField !== "Ad Id") {
    fields[externalIdField] = externalId;
  }

  return fields;
}

function encodeTablePath(tableName: string): string {
  return tableName
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

export class AirtableService {
  private schemaLookupDisabled = false;

  constructor(private readonly personalAccessToken: string) {}

  hasToken(): boolean {
    return Boolean(this.personalAccessToken.trim());
  }

  async fetchCompetitors(settings: AirtableSettings, log: LogFn = console.log): Promise<AirtableCompetitorSnapshot> {
    this.ensureConfigured(settings);

    const records = await this.listRecords(settings.baseId, settings.competitorsTable);
    const sharedPageIdFields = [
      "Page ID",
      "Page Id",
      "page id",
      "page_id",
      "PageID",
      "Facebook Page ID",
      "FB Page ID"
    ];
    const reportIdFields = [
      settings.competitorsAdplexityField,
      "Report IDs",
      "Report IDs ",
      "Report ID",
      "report ids",
      "report_id",
      "report_ids",
      "AdPlexity Report ID",
      "AdPlexity Report IDs",
      "Adplexity Report ID",
      "Adplexity Report IDs"
    ];
    const foreplayBrandIds: string[] = [];
    const metaPageIds: string[] = [];
    const adplexityReportIds: number[] = [];
    const seenForeplay = new Set<string>();
    const seenMeta = new Set<string>();
    const seenAdplexity = new Set<number>();
    let activeRows = 0;

    for (const row of records) {
      const fields = row.fields ?? {};
      if (!isActiveValue(fields[settings.competitorsActiveField])) {
        continue;
      }
      activeRows += 1;

      const foreplayCandidates = collectStringValues(fields, [
        settings.competitorsForeplayField,
        settings.competitorsMetaPageField,
        ...sharedPageIdFields
      ]);
      for (const brandId of foreplayCandidates) {
        if (!seenForeplay.has(brandId)) {
          seenForeplay.add(brandId);
          foreplayBrandIds.push(brandId);
        }
      }

      const metaCandidates = collectStringValues(fields, [
        settings.competitorsMetaPageField,
        settings.competitorsForeplayField,
        ...sharedPageIdFields
      ]);
      for (const pageId of metaCandidates) {
        if (!seenMeta.has(pageId)) {
          seenMeta.add(pageId);
          metaPageIds.push(pageId);
        }
      }

      for (const reportId of collectIntValues(fields, reportIdFields)) {
        if (!seenAdplexity.has(reportId)) {
          seenAdplexity.add(reportId);
          adplexityReportIds.push(reportId);
        }
      }
    }

    if (activeRows > 0 && foreplayBrandIds.length === 0 && metaPageIds.length === 0) {
      const sampleFields = Array.from(
        new Set(records.flatMap((record) => Object.keys(record.fields ?? {})))
      ).sort();
      if (sampleFields.length) {
        log(`No competitor IDs found. Available Airtable columns: ${sampleFields.join(", ")}`);
      }
    }

    log(
      `Airtable competitors synced: ${activeRows}/${records.length} active rows, ` +
        `${foreplayBrandIds.length} Foreplay IDs, ${metaPageIds.length} Meta pages, ${adplexityReportIds.length} report IDs`
    );

    return {
      totalRows: records.length,
      activeRows,
      foreplayBrandIds,
      metaPageIds,
      adplexityReportIds
    };
  }

  async syncAds(settings: AirtableSettings, ads: NormalizedAd[], log: LogFn = console.log): Promise<AirtableWriteSummary> {
    this.ensureConfigured(settings);
    if (!settings.adsTable.trim()) {
      throw new Error("Airtable ads table is not configured.");
    }

    const allowedFields = this.schemaLookupDisabled
      ? null
      : await this.tryGetTableFields(settings.baseId, settings.adsTable, log);
    const externalIdField = resolveExternalIdField(settings, allowedFields);
    const knownRecords = await this.listRecords(settings.baseId, settings.adsTable);
    const existingByExternalId = new Map<string, string>();

    for (const row of knownRecords) {
      const externalId = firstNonEmptyText([
        row.fields?.[externalIdField],
        row.fields?.[settings.adsExternalIdField],
        row.fields?.["Ad Id"],
        row.fields?.["External ID"]
      ]);
      if (externalId) {
        existingByExternalId.set(externalId, row.id);
      }
    }

    const creates: Array<{ fields: Record<string, unknown> }> = [];
    const updates: Array<{ id: string; fields: Record<string, unknown> }> = [];
    let skipped = 0;

    for (const ad of ads) {
      const externalId = adExternalId(ad);
      let fields = adToFields(ad, externalIdField);
      if (allowedFields) {
        fields = Object.fromEntries(Object.entries(fields).filter(([name]) => allowedFields.has(name)));
      }

      if (!fields[externalIdField]) {
        skipped += 1;
        continue;
      }

      const existingRecordId = existingByExternalId.get(externalId);
      if (existingRecordId) {
        updates.push({ id: existingRecordId, fields });
      } else {
        creates.push({ fields });
      }
    }

    let created = 0;
    for (const batch of chunk(creates, MAX_BATCH)) {
      const payload = await this.requestJson<{ records?: AirtableRecord[] }>("POST", settings.baseId, settings.adsTable, {
        body: {
          records: batch,
          typecast: true
        }
      });
      created += Array.isArray(payload.records) ? payload.records.length : batch.length;
    }

    let updated = 0;
    for (const batch of chunk(updates, MAX_BATCH)) {
      const payload = await this.requestJson<{ records?: AirtableRecord[] }>(
        "PATCH",
        settings.baseId,
        settings.adsTable,
        {
          body: {
            records: batch,
            typecast: true
          }
        }
      );
      updated += Array.isArray(payload.records) ? payload.records.length : batch.length;
    }

    const summary: AirtableWriteSummary = {
      total: ads.length,
      created,
      updated,
      skipped
    };
    log(`Airtable ads sync complete: created ${created}, updated ${updated}, skipped ${skipped}.`);
    return summary;
  }

  private ensureConfigured(settings: AirtableSettings): void {
    if (!this.personalAccessToken.trim()) {
      throw new Error("AIRTABLE_PAT is missing in environment.");
    }
    if (!settings.enabled) {
      throw new Error("Airtable integration is disabled in dashboard settings.");
    }
    if (!settings.baseId.trim()) {
      throw new Error("Airtable base ID is required.");
    }
  }

  private async tryGetTableFields(baseId: string, tableName: string, log: LogFn): Promise<Set<string> | null> {
    try {
      const payload = await this.requestMetaJson<AirtableMetadataResponse>(
        "GET",
        `bases/${encodeURIComponent(baseId)}/tables`
      );
      const table = payload.tables?.find((item) => String(item.name ?? "").trim() === tableName.trim());
      if (!table || !Array.isArray(table.fields)) {
        return null;
      }

      const fields = new Set<string>();
      for (const field of table.fields) {
        const name = String(field.name ?? "").trim();
        if (name) {
          fields.add(name);
        }
      }
      return fields;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        message.includes("INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND") ||
        message.includes("Airtable request failed (403)")
      ) {
        this.schemaLookupDisabled = true;
        log("Airtable schema lookup disabled (PAT has no schema scope). Continuing with direct record sync.");
        return null;
      }
      log(`Airtable schema lookup skipped: ${message}`);
      return null;
    }
  }

  private async listRecords(
    baseId: string,
    tableName: string,
    options: {
      fields?: string[];
    } = {}
  ): Promise<AirtableRecord[]> {
    const records: AirtableRecord[] = [];
    let offset = "";

    while (true) {
      const query: Record<string, string | number | string[] | undefined> = {
        pageSize: 100
      };
      if (offset) {
        query.offset = offset;
      }
      if (options.fields?.length) {
        query["fields[]"] = options.fields;
      }

      const payload = await this.requestJson<AirtableListResponse>("GET", baseId, tableName, {
        query
      });
      if (Array.isArray(payload.records)) {
        records.push(...payload.records);
      }
      if (!payload.offset) {
        break;
      }
      offset = payload.offset;
    }

    return records;
  }

  private async requestJson<T>(
    method: "GET" | "POST" | "PATCH",
    baseId: string,
    tableName: string,
    options: {
      query?: Record<string, string | number | string[] | undefined>;
      body?: unknown;
    } = {}
  ): Promise<T> {
    const path = `${encodeURIComponent(baseId)}/${encodeTablePath(tableName)}`;
    return this.performJsonRequest<T>(BASE_URL, method, path, options);
  }

  private async requestMetaJson<T>(
    method: "GET",
    path: string,
    options: {
      query?: Record<string, string | number | string[] | undefined>;
      body?: unknown;
    } = {}
  ): Promise<T> {
    return this.performJsonRequest<T>(META_BASE_URL, method, path, options);
  }

  private async performJsonRequest<T>(
    baseUrl: string,
    method: "GET" | "POST" | "PATCH",
    path: string,
    options: {
      query?: Record<string, string | number | string[] | undefined>;
      body?: unknown;
    } = {}
  ): Promise<T> {
    const url = new URL(path, baseUrl);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value === undefined) {
        continue;
      }
      if (Array.isArray(value)) {
        for (const item of value) {
          url.searchParams.append(key, String(item));
        }
        continue;
      }
      url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = {
      authorization: `Bearer ${this.personalAccessToken}`,
      "content-type": "application/json"
    };

    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        const response = await fetch(url, {
          method,
          headers,
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: AbortSignal.timeout(30_000)
        });

        if (response.status === 429 || response.status >= 500) {
          const retryAfter = Number.parseInt(response.headers.get("retry-after") ?? "0", 10);
          const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 1000;
          lastError = new Error(`Airtable temporary error ${response.status}`);
          await sleep(waitMs);
          continue;
        }

        if (!response.ok) {
          const message = (await response.text().catch(() => "")).slice(0, 500);
          throw new Error(`Airtable request failed (${response.status}): ${message}`);
        }

        const payload = (await response.json().catch(() => ({}))) as T;
        return payload;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt >= MAX_RETRIES) {
          break;
        }
        await sleep(2 ** attempt * 1000);
      }
    }

    throw lastError ?? new Error("Airtable request failed.");
  }
}
