import { startTransition, useDeferredValue, useEffect, useState } from "react";

import {
  createDefaultDashboardSettings,
  type AppStateSnapshot,
  type DashboardAction,
  type DashboardAdCard,
  type DashboardPayload,
  type DashboardSettings
} from "@competitors/shared";

const emptyPayload: DashboardPayload = {
  generatedAt: "",
  stats: {
    totalAds: 0,
    winnerAds: 0,
    bySource: {},
    byStatus: {},
    byVertical: {}
  },
  ads: []
};

const defaultSettings = createDefaultDashboardSettings();

function label(value: string): string {
  if (value === "all") {
    return "All";
  }
  if (value === "unclassified") {
    return "Unclassified";
  }
  return value.replaceAll("_", " ").replace(/\b\w/g, (match) => match.toUpperCase());
}

function uniqueOptions(values: string[], includeUnclassified = false): string[] {
  const unique = Array.from(new Set(values.filter(Boolean))).sort();
  if (includeUnclassified && !unique.includes("unclassified")) {
    return ["all", "unclassified", ...unique];
  }
  return ["all", ...unique];
}

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json"
    },
    ...options
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(String(payload.error ?? `Request failed: ${response.status}`));
  }
  return payload as T;
}

function describeAction(action: DashboardAction, settings: DashboardSettings): string {
  if (action === "stop-job") {
    return "Stop the running job now? The current step will be interrupted as soon as possible.";
  }
  if (action === "extract-foreplay") {
    return `Run Foreplay winner extraction for ${settings.foreplay.brandIds.length} brand IDs with a ${settings.foreplay.months}-month lookback?`;
  }
  if (action === "extract-adplexity") {
    return `Run AdPlexity extraction for ${settings.adplexity.reportIds.length} saved reports?`;
  }
  if (action === "extract-meta") {
    if (settings.meta.mode === "page") {
      return `Run Meta extraction directly from UI for page ${settings.meta.pageId} with max ${settings.meta.maxAds} ads and min ${settings.meta.minDays} running days?`;
    }
    return `Run Meta extraction from database ${settings.meta.advertisersDb} with min ${settings.meta.minDays} running days?`;
  }
  if (action === "sync-competitors") {
    return "Sync competitor inputs from Airtable into Foreplay IDs, Meta page IDs cache, and AdPlexity report IDs?";
  }
  if (action === "sync-airtable-ads") {
    return "Push all unified ads from this dashboard into Airtable now?";
  }
  if (action === "classify") {
    return "Run the keyword classifier on unclassified ads now?";
  }
  if (action === "full-refresh") {
    return "Run a full refresh? This will run every extractor that is already available in the native TypeScript runtime.";
  }
  return "Continue?";
}

function validateAction(action: DashboardAction, settings: DashboardSettings): string {
  if (action === "stop-job") {
    return "";
  }
  if (action === "extract-foreplay" && settings.foreplay.brandIds.length === 0) {
    return "Add at least one Foreplay brand ID before running extraction.";
  }
  if (action === "extract-adplexity" && settings.adplexity.reportIds.length === 0) {
    return "Add at least one AdPlexity report ID before running extraction.";
  }
  if (action === "extract-meta" && settings.meta.mode === "page" && !settings.meta.pageId) {
    return "Meta page mode needs a page ID before extraction can start.";
  }
  if (
    action === "extract-meta" &&
    settings.meta.mode === "batch" &&
    !settings.meta.advertisersDb &&
    !(settings.airtable.enabled && settings.airtable.useCompetitorsForMetaBatch)
  ) {
    return "Meta batch mode needs an advertisers DB path before extraction can start.";
  }
  if ((action === "sync-competitors" || action === "sync-airtable-ads") && !settings.airtable.enabled) {
    return "Enable Airtable first.";
  }
  if ((action === "sync-competitors" || action === "sync-airtable-ads") && !settings.airtable.baseId.trim()) {
    return "Airtable Base ID is required.";
  }
  if (action === "sync-competitors" && !settings.airtable.competitorsTable.trim()) {
    return "Airtable Competitors table is required.";
  }
  if (action === "sync-airtable-ads" && !settings.airtable.adsTable.trim()) {
    return "Airtable Ads table is required.";
  }
  return "";
}

function visibleAds(
  cards: DashboardAdCard[],
  filters: {
    source: string;
    vertical: string;
    status: string;
    winner: string;
    search: string;
  }
): DashboardAdCard[] {
  const query = filters.search.trim().toLowerCase();

  return cards.filter((card) => {
    if (filters.source !== "all" && card.source !== filters.source) {
      return false;
    }
    if (filters.vertical !== "all" && card.verticalText !== filters.vertical) {
      return false;
    }
    if (filters.status !== "all" && card.statusText !== filters.status) {
      return false;
    }
    if (filters.winner === "winners" && !card.isWinner) {
      return false;
    }
    if (filters.winner === "non-winners" && card.isWinner) {
      return false;
    }
    if (!query) {
      return true;
    }

    const haystack = [
      card.brandText,
      card.titleText,
      card.copyText,
      card.platformsText,
      card.countriesText,
      card.verticalText,
      card.source
    ]
      .join(" ")
      .toLowerCase();

    return haystack.includes(query);
  });
}

function mediaPreview(card: DashboardAdCard) {
  if (card.videoHref) {
    return (
      <video controls muted playsInline preload="none" poster={card.imageHref ?? undefined}>
        <source src={card.videoHref} />
      </video>
    );
  }

  if (card.imageHref) {
    return <img src={card.imageHref} alt={card.brandText} loading="lazy" />;
  }

  return <div className="mediaEmpty">No image or video preview available for this ad.</div>;
}

export function App() {
  const [payload, setPayload] = useState<DashboardPayload>(emptyPayload);
  const [appState, setAppState] = useState<AppStateSnapshot | null>(null);
  const [settings, setSettings] = useState<DashboardSettings>(defaultSettings);
  const [error, setError] = useState("");
  const [filters, setFilters] = useState({
    source: "all",
    vertical: "all",
    status: "all",
    winner: "all",
    search: ""
  });

  const deferredSearch = useDeferredValue(filters.search);
  const filteredAds = visibleAds(payload.ads, { ...filters, search: deferredSearch });
  const visibleWinners = filteredAds.filter((card) => card.isWinner).length;
  const busy = Boolean(appState?.job.running);
  const lastFinishedAt = appState?.job.finishedAt ?? "";

  const sourceOptions = uniqueOptions(payload.ads.map((card) => card.source));
  const verticalOptions = uniqueOptions(payload.ads.map((card) => card.verticalText), true);
  const statusOptions = uniqueOptions(payload.ads.map((card) => card.statusText));

  async function refreshEverything(): Promise<void> {
    try {
      const [nextPayload, nextState] = await Promise.all([
        fetchJson<DashboardPayload>("/api/data"),
        fetchJson<AppStateSnapshot>("/api/state")
      ]);
      setError("");
      startTransition(() => {
        setPayload(nextPayload);
        setAppState(nextState);
        setSettings(nextState.settings);
      });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  }

  useEffect(() => {
    void refreshEverything();
  }, []);

  useEffect(() => {
    const handle = window.setInterval(() => {
      void fetchJson<AppStateSnapshot>("/api/state")
        .then((nextState) => {
          const shouldSyncSettings =
            Boolean(nextState.job.finishedAt) && nextState.job.finishedAt !== lastFinishedAt;

          startTransition(() => {
            setAppState(nextState);
            if (shouldSyncSettings) {
              setSettings(nextState.settings);
            }
          });
          if (nextState.dataVersion !== payload.generatedAt) {
            void fetchJson<DashboardPayload>("/api/data").then((nextPayload) => {
              startTransition(() => {
                setPayload(nextPayload);
              });
            });
          }
        })
        .catch(() => undefined);
    }, 2500);

    return () => window.clearInterval(handle);
  }, [payload.generatedAt, lastFinishedAt]);

  async function saveSettings(): Promise<void> {
    try {
      const nextState = await fetchJson<AppStateSnapshot>("/api/settings", {
        method: "POST",
        body: JSON.stringify(settings)
      });
      setError("");
      startTransition(() => {
        setAppState(nextState);
        setSettings(nextState.settings);
      });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  }

  async function runAction(action: DashboardAction): Promise<void> {
    const validation = validateAction(action, settings);
    if (validation) {
      setError(validation);
      return;
    }

    const needsConfirmation = action !== "refresh" && action !== "stop-job";
    const isEmbeddedPreview = window.self !== window.top;
    if (needsConfirmation && !isEmbeddedPreview) {
      if (!window.confirm(describeAction(action, settings))) {
        return;
      }
    }

    try {
      setError("");
      const nextState = await fetchJson<AppStateSnapshot>("/api/actions/" + action, {
        method: "POST",
        body: JSON.stringify({ settings })
      });
      setError("");
      startTransition(() => {
        setAppState(nextState);
        setSettings(nextState.settings);
      });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  }

  const stats = [
    ["Total Ads", payload.stats.totalAds],
    ["Winner Ads", payload.stats.winnerAds],
    ...Object.entries(payload.stats.bySource).map(([key, value]) => [label(key), value]),
    ...Object.entries(payload.stats.byStatus).map(([key, value]) => [label(key), value])
  ];

  return (
    <main className="shell">
      <section className="hero">
        <div className="eyebrow">Google AI Studio Migration</div>
        <h1>Competitive Intelligence Studio</h1>
        <p className="subhead">
          Unified competitive intelligence in a Google AI Studio-friendly stack: Node, React, and
          a portable JSON-backed runtime. Foreplay, AdPlexity, and Meta extraction run directly
          from this dashboard, with keyword classification handled in the same native TypeScript
          pipeline.
        </p>
        <div className="heroMeta">
          <div className="chip">Generated at: {payload.generatedAt || "Pending"}</div>
          <div className="chip">Storage: native TypeScript JSON store</div>
          <div className="chip">Sources: Foreplay, AdPlexity, Meta</div>
        </div>
      </section>

      <section className="statsGrid">
        {stats.map(([title, value]) => (
          <article className="panel statCard" key={String(title)}>
            <div className="statLabel">{title}</div>
            <div className="statValue">{value}</div>
          </article>
        ))}
      </section>

      <div className="layout">
        <aside className="panel controlPanel">
          <div className="panelTitle">Control Center</div>
          <p className="panelCopy">
            Settings persist in the Node backend. Every extractor button now runs in the same
            native app flow with one job at a time and full activity logs.
          </p>

          <label className="fieldLabel" htmlFor="foreplay-brand-ids">
            Foreplay Brand IDs
          </label>
          <textarea
            id="foreplay-brand-ids"
            value={settings.foreplay.brandIds.join("\n")}
            onChange={(event) =>
              setSettings({
                ...settings,
                foreplay: {
                  ...settings.foreplay,
                  brandIds: event.target.value
                    .split(/\n|,/)
                    .map((value) => value.trim())
                    .filter(Boolean)
                }
              })
            }
          />

          <label className="fieldLabel" htmlFor="foreplay-months">
            Foreplay Months
          </label>
          <input
            id="foreplay-months"
            type="number"
            min={1}
            max={24}
            value={settings.foreplay.months}
            onChange={(event) =>
              setSettings({
                ...settings,
                foreplay: {
                  ...settings.foreplay,
                  months: Number(event.target.value || 3)
                }
              })
            }
          />

          <label className="fieldLabel" htmlFor="adplexity-report-ids">
            AdPlexity Report IDs
          </label>
          <textarea
            id="adplexity-report-ids"
            value={settings.adplexity.reportIds.join("\n")}
            onChange={(event) =>
              setSettings({
                ...settings,
                adplexity: {
                  ...settings.adplexity,
                  reportIds: event.target.value
                    .split(/\n|,/)
                    .map((value) => Number.parseInt(value.trim(), 10))
                    .filter((value) => Number.isFinite(value) && value > 0)
                }
              })
            }
          />

          <label className="fieldLabel" htmlFor="meta-mode">
            Meta Source
          </label>
          <select
            id="meta-mode"
            value={settings.meta.mode}
            onChange={(event) =>
              setSettings({
                ...settings,
                meta: {
                  ...settings.meta,
                  mode: event.target.value === "page" ? "page" : "batch"
                }
              })
            }
          >
            <option value="batch">From Database</option>
            <option value="page">Direct from UI (Page ID)</option>
          </select>

          {settings.meta.mode === "page" ? (
            <>
              <label className="fieldLabel" htmlFor="meta-page-id">
                Meta Page ID
              </label>
              <input
                id="meta-page-id"
                type="text"
                value={settings.meta.pageId}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    meta: {
                      ...settings.meta,
                      pageId: event.target.value
                    }
                  })
                }
              />
            </>
          ) : null}

          <label className="fieldLabel" htmlFor="meta-keywords">
            Meta Keywords
          </label>
          <input
            id="meta-keywords"
            type="text"
            value={settings.meta.keywords}
            onChange={(event) =>
              setSettings({
                ...settings,
                meta: {
                  ...settings.meta,
                  keywords: event.target.value
                }
              })
            }
          />

          {settings.meta.mode === "batch" ? (
            <>
              <label className="fieldLabel" htmlFor="meta-vertical-filter">
                Meta Vertical Filter
              </label>
              <input
                id="meta-vertical-filter"
                type="text"
                value={settings.meta.verticalFilter}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    meta: {
                      ...settings.meta,
                      verticalFilter: event.target.value
                    }
                  })
                }
              />
            </>
          ) : null}

          <div className="fieldGrid">
            <div>
              <label className="fieldLabel" htmlFor="meta-media">
                Meta Media
              </label>
              <select
                id="meta-media"
                value={settings.meta.media}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    meta: {
                      ...settings.meta,
                      media:
                        event.target.value === "image" || event.target.value === "video"
                          ? event.target.value
                          : "both"
                    }
                  })
                }
              >
                <option value="both">Both</option>
                <option value="image">Image</option>
                <option value="video">Video</option>
              </select>
            </div>
            <div>
              <label className="fieldLabel" htmlFor="meta-min-days">
                Min Days
              </label>
              <input
                id="meta-min-days"
                type="number"
                min={0}
                max={365}
                value={settings.meta.minDays}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    meta: {
                      ...settings.meta,
                      minDays: Number(event.target.value || 30)
                    }
                  })
                }
              />
            </div>
            <div>
              <label className="fieldLabel" htmlFor="meta-max-ads">
                Max Ads
              </label>
              <input
                id="meta-max-ads"
                type="number"
                min={1}
                max={250}
                value={settings.meta.maxAds}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    meta: {
                      ...settings.meta,
                      maxAds: Number(event.target.value || 50)
                    }
                  })
                }
              />
            </div>
          </div>

          {settings.meta.mode === "batch" ? (
            <>
              <label className="fieldLabel" htmlFor="meta-advertisers-db">
                Advertisers DB
              </label>
              <input
                id="meta-advertisers-db"
                type="text"
                value={settings.meta.advertisersDb}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    meta: {
                      ...settings.meta,
                      advertisersDb: event.target.value
                    }
                  })
                }
              />
            </>
          ) : null}

          <label className="fieldLabel" htmlFor="airtable-enabled">
            Airtable Integration
          </label>
          <label className="checkboxRow" htmlFor="airtable-enabled">
            <input
              id="airtable-enabled"
              type="checkbox"
              checked={settings.airtable.enabled}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  airtable: {
                    ...settings.airtable,
                    enabled: event.target.checked
                  }
                })
              }
            />
            Enable Airtable (uses AIRTABLE_PAT from .env)
          </label>

          <label className="fieldLabel" htmlFor="airtable-base-id">
            Airtable Base ID
          </label>
          <input
            id="airtable-base-id"
            type="text"
            value={settings.airtable.baseId}
            onChange={(event) =>
              setSettings({
                ...settings,
                airtable: {
                  ...settings.airtable,
                  baseId: event.target.value
                }
              })
            }
          />

          <div className="fieldGrid">
            <div>
              <label className="fieldLabel" htmlFor="airtable-competitors-table">
                Competitors Table
              </label>
              <input
                id="airtable-competitors-table"
                type="text"
                value={settings.airtable.competitorsTable}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    airtable: {
                      ...settings.airtable,
                      competitorsTable: event.target.value
                    }
                  })
                }
              />
            </div>
            <div>
              <label className="fieldLabel" htmlFor="airtable-ads-table">
                Ads Table
              </label>
              <input
                id="airtable-ads-table"
                type="text"
                value={settings.airtable.adsTable}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    airtable: {
                      ...settings.airtable,
                      adsTable: event.target.value
                    }
                  })
                }
              />
            </div>
          </div>

          <div className="fieldGrid">
            <div>
              <label className="fieldLabel" htmlFor="airtable-foreplay-field">
                Foreplay ID Field
              </label>
              <input
                id="airtable-foreplay-field"
                type="text"
                value={settings.airtable.competitorsForeplayField}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    airtable: {
                      ...settings.airtable,
                      competitorsForeplayField: event.target.value
                    }
                  })
                }
              />
            </div>
            <div>
              <label className="fieldLabel" htmlFor="airtable-meta-field">
                Meta Page Field
              </label>
              <input
                id="airtable-meta-field"
                type="text"
                value={settings.airtable.competitorsMetaPageField}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    airtable: {
                      ...settings.airtable,
                      competitorsMetaPageField: event.target.value
                    }
                  })
                }
              />
            </div>
            <div>
              <label className="fieldLabel" htmlFor="airtable-adplexity-field">
                AdPlexity Report Field
              </label>
              <input
                id="airtable-adplexity-field"
                type="text"
                value={settings.airtable.competitorsAdplexityField}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    airtable: {
                      ...settings.airtable,
                      competitorsAdplexityField: event.target.value
                    }
                  })
                }
              />
            </div>
          </div>

          <div className="fieldGrid">
            <div>
              <label className="fieldLabel" htmlFor="airtable-active-field">
                Active Field
              </label>
              <input
                id="airtable-active-field"
                type="text"
                value={settings.airtable.competitorsActiveField}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    airtable: {
                      ...settings.airtable,
                      competitorsActiveField: event.target.value
                    }
                  })
                }
              />
            </div>
            <div>
              <label className="fieldLabel" htmlFor="airtable-vertical-field">
                Vertical Field
              </label>
              <input
                id="airtable-vertical-field"
                type="text"
                value={settings.airtable.competitorsVerticalField}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    airtable: {
                      ...settings.airtable,
                      competitorsVerticalField: event.target.value
                    }
                  })
                }
              />
            </div>
            <div>
              <label className="fieldLabel" htmlFor="airtable-external-id-field">
                Ads External ID Field
              </label>
              <input
                id="airtable-external-id-field"
                type="text"
                value={settings.airtable.adsExternalIdField}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    airtable: {
                      ...settings.airtable,
                      adsExternalIdField: event.target.value
                    }
                  })
                }
              />
            </div>
          </div>

          <label className="checkboxRow" htmlFor="airtable-use-foreplay">
            <input
              id="airtable-use-foreplay"
              type="checkbox"
              checked={settings.airtable.useCompetitorsForForeplay}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  airtable: {
                    ...settings.airtable,
                    useCompetitorsForForeplay: event.target.checked
                  }
                })
              }
            />
            Use Airtable competitors for Foreplay when IDs are empty
          </label>

          <label className="checkboxRow" htmlFor="airtable-use-adplexity">
            <input
              id="airtable-use-adplexity"
              type="checkbox"
              checked={settings.airtable.useCompetitorsForAdplexity}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  airtable: {
                    ...settings.airtable,
                    useCompetitorsForAdplexity: event.target.checked
                  }
                })
              }
            />
            Use Airtable competitors for AdPlexity when report IDs are empty
          </label>

          <label className="checkboxRow" htmlFor="airtable-use-meta">
            <input
              id="airtable-use-meta"
              type="checkbox"
              checked={settings.airtable.useCompetitorsForMetaBatch}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  airtable: {
                    ...settings.airtable,
                    useCompetitorsForMetaBatch: event.target.checked
                  }
                })
              }
            />
            Use Airtable competitor page IDs for Meta batch extraction
          </label>

          <label className="checkboxRow" htmlFor="airtable-auto-sync">
            <input
              id="airtable-auto-sync"
              type="checkbox"
              checked={settings.airtable.autoSyncAdsAfterExtract}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  airtable: {
                    ...settings.airtable,
                    autoSyncAdsAfterExtract: event.target.checked
                  }
                })
              }
            />
            Auto-sync Airtable ads after each extraction
          </label>

          <label className="checkboxRow" htmlFor="auto-classify">
            <input
              id="auto-classify"
              type="checkbox"
              checked={settings.autoClassifyAfterExtract}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  autoClassifyAfterExtract: event.target.checked
                })
              }
            />
            Auto-classify after extraction
          </label>

          <div className="buttonGrid">
            <button className="primary" disabled={busy} onClick={() => void saveSettings()}>
              Save Settings
            </button>
            <button disabled={busy} onClick={() => void runAction("refresh")}>
              Refresh Data
            </button>
            <button className="danger" disabled={!busy} onClick={() => void runAction("stop-job")}>
              Stop Job
            </button>
            <button disabled={busy} onClick={() => void runAction("sync-competitors")}>
              Sync Competitors
            </button>
            <button disabled={busy} onClick={() => void runAction("sync-airtable-ads")}>
              Sync Airtable Ads
            </button>
            <button disabled={busy} onClick={() => void runAction("extract-foreplay")}>
              Extract Foreplay
            </button>
            <button disabled={busy} onClick={() => void runAction("extract-adplexity")}>
              Extract AdPlexity
            </button>
            <button disabled={busy} onClick={() => void runAction("extract-meta")}>
              Extract Meta
            </button>
            <button disabled={busy} onClick={() => void runAction("classify")}>
              Classify
            </button>
            <button className="primary fullWidth" disabled={busy} onClick={() => void runAction("full-refresh")}>
              Run Full Refresh
            </button>
          </div>

          {error ? <div className="errorBanner">{error}</div> : null}

          <div className="noteBox">
            Responsible mode stays in place: one job at a time, persisted settings, live status,
            and explicit confirmations before actions.
          </div>
        </aside>

        <section className="workspace">
          <section className="panel statusCard">
            <div className="statusHeader">
              <h2>Job Status</h2>
              <div className={`statusPill ${busy ? "running" : appState?.job.lastError ? "error" : "idle"}`}>
                {busy ? "Running" : appState?.job.lastError ? "Error" : "Idle"}
              </div>
            </div>
            <div className="statusDetail">
              {appState?.job.name ? `Action: ${label(appState.job.name)}` : "No job has run yet in this session."}
              {appState?.job.startedAt ? ` | Started: ${appState.job.startedAt}` : ""}
              {appState?.job.finishedAt ? ` | Finished: ${appState.job.finishedAt}` : ""}
              {appState?.job.lastResult ? ` | ${appState.job.lastResult}` : ""}
              {appState?.job.lastError ? ` | ${appState.job.lastError}` : ""}
            </div>
            <pre className="logBox">
              {appState?.job.logs.length ? appState.job.logs.join("\n") : "Waiting for activity..."}
            </pre>
          </section>

          <section className="panel board">
            <div className="filters">
              <div>
                <label className="fieldLabel" htmlFor="source-filter">
                  Source
                </label>
                <select
                  id="source-filter"
                  value={filters.source}
                  onChange={(event) => setFilters({ ...filters, source: event.target.value })}
                >
                  {sourceOptions.map((option) => (
                    <option key={option} value={option}>
                      {label(option)}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="fieldLabel" htmlFor="vertical-filter">
                  Vertical
                </label>
                <select
                  id="vertical-filter"
                  value={filters.vertical}
                  onChange={(event) => setFilters({ ...filters, vertical: event.target.value })}
                >
                  {verticalOptions.map((option) => (
                    <option key={option} value={option}>
                      {label(option)}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="fieldLabel" htmlFor="status-filter">
                  Status
                </label>
                <select
                  id="status-filter"
                  value={filters.status}
                  onChange={(event) => setFilters({ ...filters, status: event.target.value })}
                >
                  {statusOptions.map((option) => (
                    <option key={option} value={option}>
                      {label(option)}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="fieldLabel" htmlFor="winner-filter">
                  Winner View
                </label>
                <select
                  id="winner-filter"
                  value={filters.winner}
                  onChange={(event) => setFilters({ ...filters, winner: event.target.value })}
                >
                  <option value="all">All Ads</option>
                  <option value="winners">Winners Only</option>
                  <option value="non-winners">Non-Winners Only</option>
                </select>
              </div>
              <div>
                <label className="fieldLabel" htmlFor="search-filter">
                  Search
                </label>
                <input
                  id="search-filter"
                  type="search"
                  placeholder="Brand, copy, platform..."
                  value={filters.search}
                  onChange={(event) => setFilters({ ...filters, search: event.target.value })}
                />
              </div>
            </div>

            <div className="boardToolbar">
              <p>
                {filteredAds.length} of {payload.ads.length} ads visible | {visibleWinners} winner ads in
                view
              </p>
              {error ? <div className="errorBanner">{error}</div> : null}
            </div>

            <div className="cardGrid">
              {filteredAds.length === 0 ? (
                <div className="emptyState">No ads match the current filters.</div>
              ) : (
                filteredAds.map((card) => (
                  <article className={`adCard ${card.isWinner ? "winnerCard" : ""}`} key={`${card.source}-${card.sourceId}`}>
                    <div className="mediaFrame">
                      {mediaPreview(card)}
                      <div className="badgeRows">
                        <div className="badgeStack">
                          <span className={`badge source-${card.source}`}>{card.sourceText}</span>
                          {card.isWinner ? <span className="badge winnerBadge">Foreplay Winner</span> : null}
                        </div>
                        <div className="badgeStack">
                          <span className="badge neutralBadge">{label(card.verticalText)}</span>
                          <span className={`badge status-${card.statusText}`}>{label(card.statusText)}</span>
                        </div>
                      </div>
                    </div>

                    <div className="cardBody">
                      <div className="brandRow">
                        <div className="brandName">{card.brandText}</div>
                        {card.isWinner ? <div className="winnerInline">{card.winnerText}</div> : null}
                      </div>
                      <div className="cardTitle">{card.titleText || "Untitled Creative"}</div>
                      <p className="cardCopy">
                        {card.copyText || "No ad copy captured for this creative."}
                      </p>

                      <div className="metaGrid">
                        <div className="metaItem">
                          <div className="metaKey">Days Running</div>
                          <div className="metaValue">{card.daysRunningText}</div>
                        </div>
                        <div className="metaItem">
                          <div className="metaKey">Platforms</div>
                          <div className="metaValue">{card.platformsText}</div>
                        </div>
                        <div className="metaItem">
                          <div className="metaKey">Countries</div>
                          <div className="metaValue">{card.countriesText}</div>
                        </div>
                        <div className="metaItem">
                          <div className="metaKey">CTA</div>
                          <div className="metaValue">{card.cta || "Unknown"}</div>
                        </div>
                        <div className="metaItem">
                          <div className="metaKey">First Seen</div>
                          <div className="metaValue">{card.firstSeenText}</div>
                        </div>
                        <div className="metaItem">
                          <div className="metaKey">Last Seen</div>
                          <div className="metaValue">{card.lastSeenText}</div>
                        </div>
                      </div>

                      <div className="linkRow">
                        {card.landingPageUrl ? (
                          <a href={card.landingPageUrl} rel="noreferrer" target="_blank">
                            Landing Page
                          </a>
                        ) : null}
                        {card.adLibraryUrl ? (
                          <a href={card.adLibraryUrl} rel="noreferrer" target="_blank">
                            Ad Library
                          </a>
                        ) : null}
                      </div>
                    </div>
                  </article>
                ))
              )}
            </div>
          </section>
        </section>
      </div>
    </main>
  );
}
