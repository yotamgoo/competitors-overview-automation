import { classifyAd, type AppStateSnapshot, type DashboardAction, type DashboardPayload, type DashboardSettings } from "@competitors/shared";

import { AirtableService, type AirtableCompetitorSnapshot } from "./airtable/service.js";
import type { FileBackedIntelligenceStore } from "./data-store.js";
import { AdplexityExtractorService } from "./extractors/adplexity/service.js";
import { ForeplayExtractorService } from "./extractors/foreplay/service.js";
import { MetaExtractorService } from "./extractors/meta/service.js";
import type { DashboardSettingsStore } from "./settings-store.js";
import { createEmptyDashboardPayload, createEmptyJob, nowIso } from "./state.js";

class JobStoppedError extends Error {
  constructor(message = "Job stopped by user.") {
    super(message);
    this.name = "JobStoppedError";
  }
}

function publicMediaHref(value: string | null): string | null {
  if (!value) {
    return null;
  }

  if (
    value.startsWith("http://") ||
    value.startsWith("https://") ||
    value.startsWith("data:") ||
    value.startsWith("/api/media?")
  ) {
    return value;
  }

  return `/api/media?path=${encodeURIComponent(value)}`;
}

function hasSettingsPayload(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return ["foreplay", "adplexity", "meta", "airtable", "autoClassifyAfterExtract"].some((key) => key in value);
}

export class DashboardAppController {
  private job = createEmptyJob();
  private dataVersion = nowIso();
  private cachedSettings: DashboardSettings | null = null;
  private airtableCompetitorsCache: AirtableCompetitorSnapshot | null = null;
  private stopRequested = false;

  constructor(
    private readonly settingsStore: DashboardSettingsStore,
    private readonly dataStore: FileBackedIntelligenceStore,
    private readonly foreplayService: ForeplayExtractorService,
    private readonly adplexityService: AdplexityExtractorService,
    private readonly metaService: MetaExtractorService,
    private readonly airtableService: AirtableService
  ) {}

  async initialize(): Promise<void> {
    await this.dataStore.initialize();
    this.cachedSettings = await this.settingsStore.load();
    this.dataVersion = await this.dataStore.getDataVersion();
  }

  async snapshot(): Promise<AppStateSnapshot> {
    const settings = await this.getSettings();
    return {
      settings,
      job: { ...this.job, logs: [...this.job.logs] },
      dataVersion: this.dataVersion
    };
  }

  async getData(): Promise<DashboardPayload> {
    try {
      const payload = await this.dataStore.getDashboardPayload();
      return {
        ...payload,
        generatedAt: this.dataVersion,
        ads: payload.ads.map((ad) => ({
          ...ad,
          imageHref: publicMediaHref(ad.imageHref),
          videoHref: publicMediaHref(ad.videoHref)
        }))
      };
    } catch {
      return {
        ...createEmptyDashboardPayload(),
        generatedAt: this.dataVersion
      };
    }
  }

  async saveSettings(raw: unknown): Promise<AppStateSnapshot> {
    this.cachedSettings = await this.settingsStore.save(raw);
    this.appendLog("Settings saved.");
    return this.snapshot();
  }

  async startAction(action: DashboardAction, payload?: { settings?: unknown }): Promise<AppStateSnapshot> {
    const submittedSettings = payload?.settings;
    if (hasSettingsPayload(submittedSettings)) {
      this.cachedSettings = await this.settingsStore.save(submittedSettings);
    }

    if (action === "save-settings") {
      return this.snapshot();
    }
    if (action === "stop-job") {
      if (!this.job.running) {
        this.appendLog("No running job to stop.");
        return this.snapshot();
      }
      if (!this.stopRequested) {
        this.stopRequested = true;
        this.appendLog("Stop requested. Finishing current step before canceling...");
      }
      return this.snapshot();
    }

    if (this.job.running) {
      throw new Error("Another dashboard job is already running.");
    }

    this.stopRequested = false;
    this.job = {
      running: true,
      name: action,
      startedAt: nowIso(),
      finishedAt: null,
      lastResult: "",
      lastError: "",
      logs: []
    };

    void this.runJob(action);
    return this.snapshot();
  }

  private async getSettings(): Promise<DashboardSettings> {
    if (!this.cachedSettings) {
      this.cachedSettings = await this.settingsStore.load();
    }
    return this.cachedSettings;
  }

  private appendLog(...parts: unknown[]): void {
    const text = parts.map((part) => String(part)).join(" ").trim();
    if (!text) {
      return;
    }

    const line = `[${new Date().toTimeString().slice(0, 8)}] ${text}`;
    this.job.logs = [...this.job.logs.slice(-199), line];
  }

  private async runJob(action: DashboardAction): Promise<void> {
    try {
      const result = await this.runAction(action);
      this.dataVersion = await this.dataStore.getDataVersion();
      this.job = {
        ...this.job,
        running: false,
        finishedAt: nowIso(),
        lastResult: result,
        lastError: ""
      };
      this.appendLog("Dashboard data refreshed.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.dataVersion = await this.dataStore.getDataVersion();
      if (error instanceof JobStoppedError || message === "Job stopped by user.") {
        this.job = {
          ...this.job,
          running: false,
          finishedAt: nowIso(),
          lastResult: "Stopped by user.",
          lastError: ""
        };
        this.appendLog("Job stopped by user.");
        return;
      }
      this.job = {
        ...this.job,
        running: false,
        finishedAt: nowIso(),
        lastError: message
      };
      this.appendLog(`Job failed: ${message}`);
    } finally {
      this.stopRequested = false;
    }
  }

  private throwIfStopRequested(): void {
    if (this.stopRequested) {
      throw new JobStoppedError();
    }
  }

  private async runAction(action: DashboardAction): Promise<string> {
    this.throwIfStopRequested();
    const settings = await this.getSettings();

    if (action === "refresh") {
      this.appendLog("Refreshing dashboard payload only.");
      this.dataVersion = await this.dataStore.getDataVersion();
      return "Dashboard payload refreshed.";
    }

    if (action === "classify") {
      return this.runClassification();
    }

    if (action === "sync-competitors") {
      this.appendLog("Syncing competitor inputs from Airtable...");
      const snapshot = await this.getCompetitorsFromAirtable(settings, true);
      const nextSettings: DashboardSettings = {
        ...settings,
        foreplay: {
          ...settings.foreplay,
          brandIds: snapshot.foreplayBrandIds
        },
        adplexity: {
          ...settings.adplexity,
          reportIds: snapshot.adplexityReportIds
        },
        meta: {
          ...settings.meta,
          pageId: snapshot.metaPageIds[0] || settings.meta.pageId || ""
        }
      };
      this.cachedSettings = await this.settingsStore.save(nextSettings);
      return (
        `Competitors synced from Airtable: ${snapshot.activeRows}/${snapshot.totalRows} active rows, ` +
        `${snapshot.foreplayBrandIds.length} Foreplay IDs, ${snapshot.metaPageIds.length} Meta pages, ` +
        `${snapshot.adplexityReportIds.length} AdPlexity report IDs.`
      );
    }

    if (action === "sync-airtable-ads") {
      this.ensureAirtableReady(settings, { requireAdsTable: true });
      this.appendLog("Syncing unified ads to Airtable...");
      const ads = await this.dataStore.getAds();
      const summary = await this.airtableService.syncAds(settings.airtable, ads, (...parts) => this.appendLog(...parts));
      return `Airtable sync complete: ${summary.created} created, ${summary.updated} updated, ${summary.skipped} skipped.`;
    }

    if (action === "extract-foreplay") {
      let brandIds = settings.foreplay.brandIds;
      if (!brandIds.length && settings.airtable.enabled && settings.airtable.useCompetitorsForForeplay) {
        const competitors = await this.getCompetitorsFromAirtable(settings);
        brandIds = competitors.foreplayBrandIds;
        if (brandIds.length) {
          this.appendLog(`Using ${brandIds.length} Foreplay brand IDs from Airtable competitors.`);
        }
      }

      if (!brandIds.length) {
        throw new Error("Add at least one Foreplay brand ID.");
      }

      this.appendLog("Starting native Foreplay winner extraction...");
      const results = await this.foreplayService.extract({
        brandIds,
        months: settings.foreplay.months,
        log: (...parts) => this.appendLog(...parts),
        shouldStop: () => this.stopRequested
      });
      this.throwIfStopRequested();

      const totalWinners = results.reduce((sum, item) => sum + item.winnersFound, 0);
      if (settings.autoClassifyAfterExtract) {
        await this.runClassification(true);
      }
      const syncSummary = await this.syncAdsIfEnabled(settings);
      return `Foreplay complete: ${totalWinners} winner ads stored.${syncSummary ? ` ${syncSummary}` : ""}`;
    }

    if (action === "extract-adplexity") {
      let reportIds = settings.adplexity.reportIds;
      if (!reportIds.length && settings.airtable.enabled && settings.airtable.useCompetitorsForAdplexity) {
        const competitors = await this.getCompetitorsFromAirtable(settings);
        reportIds = competitors.adplexityReportIds;
        if (reportIds.length) {
          this.appendLog(`Using ${reportIds.length} AdPlexity report IDs from Airtable competitors.`);
        }
      }

      if (!reportIds.length) {
        throw new Error("Add at least one AdPlexity report ID.");
      }

      this.appendLog("Starting native AdPlexity report extraction...");
      const results = await this.adplexityService.extract({
        reportIds,
        log: (...parts) => this.appendLog(...parts),
        shouldStop: () => this.stopRequested
      });
      this.throwIfStopRequested();
      const totalAds = results.reduce((sum, item) => sum + item.adsFetched, 0);
      const totalEnriched = results.reduce((sum, item) => sum + item.detailsFetched, 0);
      const totalFailed = results.reduce((sum, item) => sum + item.failed, 0);
      if (settings.autoClassifyAfterExtract) {
        await this.runClassification(true);
      }
      const syncSummary = await this.syncAdsIfEnabled(settings);
      return (
        `AdPlexity complete: ${totalAds} ads, ${totalEnriched} enriched, ${totalFailed} failed.` +
        `${syncSummary ? ` ${syncSummary}` : ""}`
      );
    }

    if (action === "extract-meta") {
      let scanned = 0;
      let stored = 0;
      let advertisers = 0;
      let failed = 0;

      if (settings.meta.mode === "batch" && settings.airtable.enabled && settings.airtable.useCompetitorsForMetaBatch) {
        const competitors = await this.getCompetitorsFromAirtable(settings);
        const pageIds = competitors.metaPageIds;

        if (pageIds.length) {
          this.appendLog(`Starting native Meta batch from Airtable competitors (${pageIds.length} page IDs)...`);
          advertisers = pageIds.length;
          for (const [index, pageId] of pageIds.entries()) {
            this.throwIfStopRequested();
            this.appendLog(`[${index + 1}/${pageIds.length}] Meta page_id=${pageId}`);
            try {
              const result = await this.metaService.extract({
                settings: {
                  ...settings.meta,
                  mode: "page",
                  pageId
                },
                log: (...parts) => this.appendLog(...parts),
                shouldStop: () => this.stopRequested
              });
              this.throwIfStopRequested();
              scanned += result.scanned;
              stored += result.stored;
            } catch (error) {
              if (this.stopRequested) {
                throw new JobStoppedError();
              }
              failed += 1;
              this.appendLog(`Meta page ${pageId} failed: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        } else {
          this.appendLog("No Meta page IDs found in Airtable competitors; falling back to SQLite batch source.");
        }
      }

      if (advertisers === 0) {
        this.throwIfStopRequested();
        this.appendLog("Starting native Meta import from SQLite...");
        const result = await this.metaService.extract({
          settings: settings.meta,
          log: (...parts) => this.appendLog(...parts),
          shouldStop: () => this.stopRequested
        });
        scanned = result.scanned;
        stored = result.stored;
        advertisers = result.advertisers;
      }

      if (settings.autoClassifyAfterExtract) {
        await this.runClassification(true);
      }
      this.throwIfStopRequested();
      const syncSummary = await this.syncAdsIfEnabled(settings);
      return (
        `Meta complete: scanned ${scanned}, stored ${stored}` +
        `${advertisers ? `, advertisers ${advertisers}` : ""}` +
        `${failed ? `, failed ${failed}` : ""}.` +
        `${syncSummary ? ` ${syncSummary}` : ""}`
      );
    }

    if (action === "full-refresh") {
      const results: string[] = [];
      const hadAutoSync = settings.airtable.autoSyncAdsAfterExtract;
      if (hadAutoSync) {
        this.cachedSettings = {
          ...settings,
          airtable: {
            ...settings.airtable,
            autoSyncAdsAfterExtract: false
          }
        };
      }

      try {
        if (settings.foreplay.brandIds.length || (settings.airtable.enabled && settings.airtable.useCompetitorsForForeplay)) {
          this.throwIfStopRequested();
          results.push(await this.runAction("extract-foreplay"));
        }
        if (settings.adplexity.reportIds.length || (settings.airtable.enabled && settings.airtable.useCompetitorsForAdplexity)) {
          this.throwIfStopRequested();
          results.push(await this.runAction("extract-adplexity"));
        }
        if (settings.meta.mode === "batch" || settings.meta.pageId) {
          this.throwIfStopRequested();
          results.push(await this.runAction("extract-meta"));
        }
      } finally {
        if (hadAutoSync) {
          this.cachedSettings = settings;
        }
      }

      if (!results.length) {
        throw new Error("No extractors are configured yet.");
      }
      if (hadAutoSync) {
        const syncSummary = await this.syncAdsIfEnabled(settings);
        if (syncSummary) {
          results.push(syncSummary);
        }
      }
      return results.join(" | ");
    }

    throw new Error(`Unknown action: ${action}`);
  }

  private ensureAirtableReady(
    settings: DashboardSettings,
    options: {
      requireAdsTable?: boolean;
    } = {}
  ): void {
    if (!settings.airtable.enabled) {
      throw new Error("Enable Airtable in dashboard settings first.");
    }
    if (!this.airtableService.hasToken()) {
      throw new Error("Airtable token is missing in environment/secrets (AIRTABLE_PAT).");
    }
    if (!settings.airtable.baseId.trim()) {
      throw new Error("Airtable Base ID is required.");
    }
    if (!settings.airtable.competitorsTable.trim()) {
      throw new Error("Airtable Competitors table is required.");
    }
    if (options.requireAdsTable && !settings.airtable.adsTable.trim()) {
      throw new Error("Airtable Ads table is required.");
    }
  }

  private async getCompetitorsFromAirtable(
    settings: DashboardSettings,
    refresh = false
  ): Promise<AirtableCompetitorSnapshot> {
    this.ensureAirtableReady(settings);
    if (!refresh && this.airtableCompetitorsCache) {
      return this.airtableCompetitorsCache;
    }

    const snapshot = await this.airtableService.fetchCompetitors(settings.airtable, (...parts) => this.appendLog(...parts));
    this.airtableCompetitorsCache = snapshot;
    return snapshot;
  }

  private async syncAdsIfEnabled(settings: DashboardSettings): Promise<string> {
    if (!settings.airtable.enabled || !settings.airtable.autoSyncAdsAfterExtract) {
      return "";
    }

    try {
      this.ensureAirtableReady(settings, { requireAdsTable: true });
      const ads = await this.dataStore.getAds();
      const summary = await this.airtableService.syncAds(settings.airtable, ads, (...parts) => this.appendLog(...parts));
      return `Airtable sync: ${summary.created} created, ${summary.updated} updated.`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.appendLog(`Airtable auto-sync skipped: ${message}`);
      return "";
    }
  }

  private async runClassification(silent = false): Promise<string> {
    if (!silent) {
      this.appendLog("Running native keyword classifier...");
    }

    const ads = await this.dataStore.getUnclassifiedAds();
    const updates: Array<[number, string | null]> = [];
    let classified = 0;

    for (const ad of ads) {
      this.throwIfStopRequested();
      const vertical = classifyAd(ad);
      if (vertical && ad.id) {
        updates.push([ad.id, vertical]);
        classified += 1;
        if (!silent) {
          this.appendLog(`[${ad.source}] ${ad.brand || "Unknown brand"} -> ${vertical}`);
        }
      }
    }

    await this.dataStore.bulkUpdateVertical(updates);
    const result = `Classification complete: scanned ${ads.length}, classified ${classified}.`;
    if (!silent) {
      this.appendLog(`${result} Unmatched ${ads.length - classified}.`);
    }
    return result;
  }
}
