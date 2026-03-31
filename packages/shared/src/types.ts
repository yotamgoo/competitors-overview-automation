export type AdSource = "foreplay" | "adplexity" | "meta";
export type AdStatus = "active" | "inactive";
export type MediaFilter = "image" | "video" | "both";
export type MetaMode = "batch" | "page";

export type DashboardAction =
  | "save-settings"
  | "stop-job"
  | "refresh"
  | "classify"
  | "extract-foreplay"
  | "extract-adplexity"
  | "extract-meta"
  | "sync-competitors"
  | "sync-airtable-ads"
  | "full-refresh";

export interface NormalizedAd {
  id?: number;
  source: AdSource;
  sourceId: string;
  brand: string;
  title: string;
  adCopy: string;
  firstSeen: string | null;
  lastSeen: string | null;
  daysRunning: number | null;
  status: AdStatus;
  countries: string[];
  platforms: string[];
  cta: string;
  videoUrl: string | null;
  imageUrl: string | null;
  landingPageUrl: string | null;
  adLibraryUrl: string | null;
  vertical: string | null;
  fetchedAt: string;
  isWinner?: boolean;
  winnerLabel?: string | null;
}

export interface DashboardAdCard extends NormalizedAd {
  countriesText: string;
  platformsText: string;
  verticalText: string;
  statusText: string;
  brandText: string;
  sourceText: string;
  titleText: string;
  copyText: string;
  videoHref: string | null;
  imageHref: string | null;
  firstSeenText: string;
  lastSeenText: string;
  daysRunningText: number | "n/a";
  winnerText: string;
}

export interface DashboardStats {
  totalAds: number;
  winnerAds: number;
  bySource: Record<string, number>;
  byStatus: Record<string, number>;
  byVertical: Record<string, number>;
}

export interface DashboardPayload {
  generatedAt: string;
  stats: DashboardStats;
  ads: DashboardAdCard[];
}

export interface ForeplaySettings {
  brandIds: string[];
  months: number;
}

export interface AdplexitySettings {
  reportIds: number[];
}

export interface MetaSettings {
  mode: MetaMode;
  pageId: string;
  keywords: string;
  verticalFilter: string;
  minDays: number;
  media: MediaFilter;
  maxAds: number;
  advertisersDb: string;
}

export interface AirtableSettings {
  enabled: boolean;
  baseId: string;
  competitorsTable: string;
  adsTable: string;
  competitorsActiveField: string;
  competitorsVerticalField: string;
  competitorsForeplayField: string;
  competitorsMetaPageField: string;
  competitorsAdplexityField: string;
  adsExternalIdField: string;
  autoSyncAdsAfterExtract: boolean;
  useCompetitorsForForeplay: boolean;
  useCompetitorsForAdplexity: boolean;
  useCompetitorsForMetaBatch: boolean;
}

export interface DashboardSettings {
  foreplay: ForeplaySettings;
  adplexity: AdplexitySettings;
  meta: MetaSettings;
  airtable: AirtableSettings;
  autoClassifyAfterExtract: boolean;
}

export interface JobSnapshot {
  running: boolean;
  name: DashboardAction | "";
  startedAt: string | null;
  finishedAt: string | null;
  lastResult: string;
  lastError: string;
  logs: string[];
}

export interface AppStateSnapshot {
  settings: DashboardSettings;
  job: JobSnapshot;
  dataVersion: string;
}

export interface ClassificationSummary {
  scanned: number;
  classified: number;
  unmatched: number;
}
