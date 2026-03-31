import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { startTransition, useDeferredValue, useEffect, useState } from "react";
import { createDefaultDashboardSettings } from "@competitors/shared";
const emptyPayload = {
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
function label(value) {
    if (value === "all") {
        return "All";
    }
    if (value === "unclassified") {
        return "Unclassified";
    }
    return value.replaceAll("_", " ").replace(/\b\w/g, (match) => match.toUpperCase());
}
function uniqueOptions(values, includeUnclassified = false) {
    const unique = Array.from(new Set(values.filter(Boolean))).sort();
    if (includeUnclassified && !unique.includes("unclassified")) {
        return ["all", "unclassified", ...unique];
    }
    return ["all", ...unique];
}
async function fetchJson(url, options) {
    const response = await fetch(url, {
        headers: {
            "Content-Type": "application/json"
        },
        ...options
    });
    const payload = (await response.json().catch(() => ({})));
    if (!response.ok) {
        throw new Error(String(payload.error ?? `Request failed: ${response.status}`));
    }
    return payload;
}
function describeAction(action, settings) {
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
function validateAction(action, settings) {
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
    if (action === "extract-meta" &&
        settings.meta.mode === "batch" &&
        !settings.meta.advertisersDb &&
        !(settings.airtable.enabled && settings.airtable.useCompetitorsForMetaBatch)) {
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
function visibleAds(cards, filters) {
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
function mediaPreview(card) {
    if (card.videoHref) {
        return (_jsx("video", { controls: true, muted: true, playsInline: true, preload: "none", poster: card.imageHref ?? undefined, children: _jsx("source", { src: card.videoHref }) }));
    }
    if (card.imageHref) {
        return _jsx("img", { src: card.imageHref, alt: card.brandText, loading: "lazy" });
    }
    return _jsx("div", { className: "mediaEmpty", children: "No image or video preview available for this ad." });
}
export function App() {
    const [payload, setPayload] = useState(emptyPayload);
    const [appState, setAppState] = useState(null);
    const [settings, setSettings] = useState(defaultSettings);
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
    async function refreshEverything() {
        try {
            const [nextPayload, nextState] = await Promise.all([
                fetchJson("/api/data"),
                fetchJson("/api/state")
            ]);
            setError("");
            startTransition(() => {
                setPayload(nextPayload);
                setAppState(nextState);
                setSettings(nextState.settings);
            });
        }
        catch (nextError) {
            setError(nextError instanceof Error ? nextError.message : String(nextError));
        }
    }
    useEffect(() => {
        void refreshEverything();
    }, []);
    useEffect(() => {
        const handle = window.setInterval(() => {
            void fetchJson("/api/state")
                .then((nextState) => {
                const shouldSyncSettings = Boolean(nextState.job.finishedAt) && nextState.job.finishedAt !== lastFinishedAt;
                startTransition(() => {
                    setAppState(nextState);
                    if (shouldSyncSettings) {
                        setSettings(nextState.settings);
                    }
                });
                if (nextState.dataVersion !== payload.generatedAt) {
                    void fetchJson("/api/data").then((nextPayload) => {
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
    async function saveSettings() {
        try {
            const nextState = await fetchJson("/api/settings", {
                method: "POST",
                body: JSON.stringify(settings)
            });
            setError("");
            startTransition(() => {
                setAppState(nextState);
                setSettings(nextState.settings);
            });
        }
        catch (nextError) {
            setError(nextError instanceof Error ? nextError.message : String(nextError));
        }
    }
    async function runAction(action) {
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
            const nextState = await fetchJson("/api/actions/" + action, {
                method: "POST",
                body: JSON.stringify({ settings })
            });
            setError("");
            startTransition(() => {
                setAppState(nextState);
                setSettings(nextState.settings);
            });
        }
        catch (nextError) {
            setError(nextError instanceof Error ? nextError.message : String(nextError));
        }
    }
    const stats = [
        ["Total Ads", payload.stats.totalAds],
        ["Winner Ads", payload.stats.winnerAds],
        ...Object.entries(payload.stats.bySource).map(([key, value]) => [label(key), value]),
        ...Object.entries(payload.stats.byStatus).map(([key, value]) => [label(key), value])
    ];
    return (_jsxs("main", { className: "shell", children: [_jsxs("section", { className: "hero", children: [_jsx("div", { className: "eyebrow", children: "Google AI Studio Migration" }), _jsx("h1", { children: "Competitive Intelligence Studio" }), _jsx("p", { className: "subhead", children: "Unified competitive intelligence in a Google AI Studio-friendly stack: Node, React, and a portable JSON-backed runtime. Foreplay, AdPlexity, and Meta extraction run directly from this dashboard, with keyword classification handled in the same native TypeScript pipeline." }), _jsxs("div", { className: "heroMeta", children: [_jsxs("div", { className: "chip", children: ["Generated at: ", payload.generatedAt || "Pending"] }), _jsx("div", { className: "chip", children: "Storage: native TypeScript JSON store" }), _jsx("div", { className: "chip", children: "Sources: Foreplay, AdPlexity, Meta" })] })] }), _jsx("section", { className: "statsGrid", children: stats.map(([title, value]) => (_jsxs("article", { className: "panel statCard", children: [_jsx("div", { className: "statLabel", children: title }), _jsx("div", { className: "statValue", children: value })] }, String(title)))) }), _jsxs("div", { className: "layout", children: [_jsxs("aside", { className: "panel controlPanel", children: [_jsx("div", { className: "panelTitle", children: "Control Center" }), _jsx("p", { className: "panelCopy", children: "Settings persist in the Node backend. Every extractor button now runs in the same native app flow with one job at a time and full activity logs." }), _jsx("label", { className: "fieldLabel", htmlFor: "foreplay-brand-ids", children: "Foreplay Brand IDs" }), _jsx("textarea", { id: "foreplay-brand-ids", value: settings.foreplay.brandIds.join("\n"), onChange: (event) => setSettings({
                                    ...settings,
                                    foreplay: {
                                        ...settings.foreplay,
                                        brandIds: event.target.value
                                            .split(/\n|,/)
                                            .map((value) => value.trim())
                                            .filter(Boolean)
                                    }
                                }) }), _jsx("label", { className: "fieldLabel", htmlFor: "foreplay-months", children: "Foreplay Months" }), _jsx("input", { id: "foreplay-months", type: "number", min: 1, max: 24, value: settings.foreplay.months, onChange: (event) => setSettings({
                                    ...settings,
                                    foreplay: {
                                        ...settings.foreplay,
                                        months: Number(event.target.value || 3)
                                    }
                                }) }), _jsx("label", { className: "fieldLabel", htmlFor: "adplexity-report-ids", children: "AdPlexity Report IDs" }), _jsx("textarea", { id: "adplexity-report-ids", value: settings.adplexity.reportIds.join("\n"), onChange: (event) => setSettings({
                                    ...settings,
                                    adplexity: {
                                        ...settings.adplexity,
                                        reportIds: event.target.value
                                            .split(/\n|,/)
                                            .map((value) => Number.parseInt(value.trim(), 10))
                                            .filter((value) => Number.isFinite(value) && value > 0)
                                    }
                                }) }), _jsx("label", { className: "fieldLabel", htmlFor: "meta-mode", children: "Meta Source" }), _jsxs("select", { id: "meta-mode", value: settings.meta.mode, onChange: (event) => setSettings({
                                    ...settings,
                                    meta: {
                                        ...settings.meta,
                                        mode: event.target.value === "page" ? "page" : "batch"
                                    }
                                }), children: [_jsx("option", { value: "batch", children: "From Database" }), _jsx("option", { value: "page", children: "Direct from UI (Page ID)" })] }), settings.meta.mode === "page" ? (_jsxs(_Fragment, { children: [_jsx("label", { className: "fieldLabel", htmlFor: "meta-page-id", children: "Meta Page ID" }), _jsx("input", { id: "meta-page-id", type: "text", value: settings.meta.pageId, onChange: (event) => setSettings({
                                            ...settings,
                                            meta: {
                                                ...settings.meta,
                                                pageId: event.target.value
                                            }
                                        }) })] })) : null, _jsx("label", { className: "fieldLabel", htmlFor: "meta-keywords", children: "Meta Keywords" }), _jsx("input", { id: "meta-keywords", type: "text", value: settings.meta.keywords, onChange: (event) => setSettings({
                                    ...settings,
                                    meta: {
                                        ...settings.meta,
                                        keywords: event.target.value
                                    }
                                }) }), settings.meta.mode === "batch" ? (_jsxs(_Fragment, { children: [_jsx("label", { className: "fieldLabel", htmlFor: "meta-vertical-filter", children: "Meta Vertical Filter" }), _jsx("input", { id: "meta-vertical-filter", type: "text", value: settings.meta.verticalFilter, onChange: (event) => setSettings({
                                            ...settings,
                                            meta: {
                                                ...settings.meta,
                                                verticalFilter: event.target.value
                                            }
                                        }) })] })) : null, _jsxs("div", { className: "fieldGrid", children: [_jsxs("div", { children: [_jsx("label", { className: "fieldLabel", htmlFor: "meta-media", children: "Meta Media" }), _jsxs("select", { id: "meta-media", value: settings.meta.media, onChange: (event) => setSettings({
                                                    ...settings,
                                                    meta: {
                                                        ...settings.meta,
                                                        media: event.target.value === "image" || event.target.value === "video"
                                                            ? event.target.value
                                                            : "both"
                                                    }
                                                }), children: [_jsx("option", { value: "both", children: "Both" }), _jsx("option", { value: "image", children: "Image" }), _jsx("option", { value: "video", children: "Video" })] })] }), _jsxs("div", { children: [_jsx("label", { className: "fieldLabel", htmlFor: "meta-min-days", children: "Min Days" }), _jsx("input", { id: "meta-min-days", type: "number", min: 0, max: 365, value: settings.meta.minDays, onChange: (event) => setSettings({
                                                    ...settings,
                                                    meta: {
                                                        ...settings.meta,
                                                        minDays: Number(event.target.value || 30)
                                                    }
                                                }) })] }), _jsxs("div", { children: [_jsx("label", { className: "fieldLabel", htmlFor: "meta-max-ads", children: "Max Ads" }), _jsx("input", { id: "meta-max-ads", type: "number", min: 1, max: 250, value: settings.meta.maxAds, onChange: (event) => setSettings({
                                                    ...settings,
                                                    meta: {
                                                        ...settings.meta,
                                                        maxAds: Number(event.target.value || 50)
                                                    }
                                                }) })] })] }), settings.meta.mode === "batch" ? (_jsxs(_Fragment, { children: [_jsx("label", { className: "fieldLabel", htmlFor: "meta-advertisers-db", children: "Advertisers DB" }), _jsx("input", { id: "meta-advertisers-db", type: "text", value: settings.meta.advertisersDb, onChange: (event) => setSettings({
                                            ...settings,
                                            meta: {
                                                ...settings.meta,
                                                advertisersDb: event.target.value
                                            }
                                        }) })] })) : null, _jsx("label", { className: "fieldLabel", htmlFor: "airtable-enabled", children: "Airtable Integration" }), _jsxs("label", { className: "checkboxRow", htmlFor: "airtable-enabled", children: [_jsx("input", { id: "airtable-enabled", type: "checkbox", checked: settings.airtable.enabled, onChange: (event) => setSettings({
                                            ...settings,
                                            airtable: {
                                                ...settings.airtable,
                                                enabled: event.target.checked
                                            }
                                        }) }), "Enable Airtable (uses AIRTABLE_PAT from .env)"] }), _jsx("label", { className: "fieldLabel", htmlFor: "airtable-base-id", children: "Airtable Base ID" }), _jsx("input", { id: "airtable-base-id", type: "text", value: settings.airtable.baseId, onChange: (event) => setSettings({
                                    ...settings,
                                    airtable: {
                                        ...settings.airtable,
                                        baseId: event.target.value
                                    }
                                }) }), _jsxs("div", { className: "fieldGrid", children: [_jsxs("div", { children: [_jsx("label", { className: "fieldLabel", htmlFor: "airtable-competitors-table", children: "Competitors Table" }), _jsx("input", { id: "airtable-competitors-table", type: "text", value: settings.airtable.competitorsTable, onChange: (event) => setSettings({
                                                    ...settings,
                                                    airtable: {
                                                        ...settings.airtable,
                                                        competitorsTable: event.target.value
                                                    }
                                                }) })] }), _jsxs("div", { children: [_jsx("label", { className: "fieldLabel", htmlFor: "airtable-ads-table", children: "Ads Table" }), _jsx("input", { id: "airtable-ads-table", type: "text", value: settings.airtable.adsTable, onChange: (event) => setSettings({
                                                    ...settings,
                                                    airtable: {
                                                        ...settings.airtable,
                                                        adsTable: event.target.value
                                                    }
                                                }) })] })] }), _jsxs("div", { className: "fieldGrid", children: [_jsxs("div", { children: [_jsx("label", { className: "fieldLabel", htmlFor: "airtable-foreplay-field", children: "Foreplay ID Field" }), _jsx("input", { id: "airtable-foreplay-field", type: "text", value: settings.airtable.competitorsForeplayField, onChange: (event) => setSettings({
                                                    ...settings,
                                                    airtable: {
                                                        ...settings.airtable,
                                                        competitorsForeplayField: event.target.value
                                                    }
                                                }) })] }), _jsxs("div", { children: [_jsx("label", { className: "fieldLabel", htmlFor: "airtable-meta-field", children: "Meta Page Field" }), _jsx("input", { id: "airtable-meta-field", type: "text", value: settings.airtable.competitorsMetaPageField, onChange: (event) => setSettings({
                                                    ...settings,
                                                    airtable: {
                                                        ...settings.airtable,
                                                        competitorsMetaPageField: event.target.value
                                                    }
                                                }) })] }), _jsxs("div", { children: [_jsx("label", { className: "fieldLabel", htmlFor: "airtable-adplexity-field", children: "AdPlexity Report Field" }), _jsx("input", { id: "airtable-adplexity-field", type: "text", value: settings.airtable.competitorsAdplexityField, onChange: (event) => setSettings({
                                                    ...settings,
                                                    airtable: {
                                                        ...settings.airtable,
                                                        competitorsAdplexityField: event.target.value
                                                    }
                                                }) })] })] }), _jsxs("div", { className: "fieldGrid", children: [_jsxs("div", { children: [_jsx("label", { className: "fieldLabel", htmlFor: "airtable-active-field", children: "Active Field" }), _jsx("input", { id: "airtable-active-field", type: "text", value: settings.airtable.competitorsActiveField, onChange: (event) => setSettings({
                                                    ...settings,
                                                    airtable: {
                                                        ...settings.airtable,
                                                        competitorsActiveField: event.target.value
                                                    }
                                                }) })] }), _jsxs("div", { children: [_jsx("label", { className: "fieldLabel", htmlFor: "airtable-vertical-field", children: "Vertical Field" }), _jsx("input", { id: "airtable-vertical-field", type: "text", value: settings.airtable.competitorsVerticalField, onChange: (event) => setSettings({
                                                    ...settings,
                                                    airtable: {
                                                        ...settings.airtable,
                                                        competitorsVerticalField: event.target.value
                                                    }
                                                }) })] }), _jsxs("div", { children: [_jsx("label", { className: "fieldLabel", htmlFor: "airtable-external-id-field", children: "Ads External ID Field" }), _jsx("input", { id: "airtable-external-id-field", type: "text", value: settings.airtable.adsExternalIdField, onChange: (event) => setSettings({
                                                    ...settings,
                                                    airtable: {
                                                        ...settings.airtable,
                                                        adsExternalIdField: event.target.value
                                                    }
                                                }) })] })] }), _jsxs("label", { className: "checkboxRow", htmlFor: "airtable-use-foreplay", children: [_jsx("input", { id: "airtable-use-foreplay", type: "checkbox", checked: settings.airtable.useCompetitorsForForeplay, onChange: (event) => setSettings({
                                            ...settings,
                                            airtable: {
                                                ...settings.airtable,
                                                useCompetitorsForForeplay: event.target.checked
                                            }
                                        }) }), "Use Airtable competitors for Foreplay when IDs are empty"] }), _jsxs("label", { className: "checkboxRow", htmlFor: "airtable-use-adplexity", children: [_jsx("input", { id: "airtable-use-adplexity", type: "checkbox", checked: settings.airtable.useCompetitorsForAdplexity, onChange: (event) => setSettings({
                                            ...settings,
                                            airtable: {
                                                ...settings.airtable,
                                                useCompetitorsForAdplexity: event.target.checked
                                            }
                                        }) }), "Use Airtable competitors for AdPlexity when report IDs are empty"] }), _jsxs("label", { className: "checkboxRow", htmlFor: "airtable-use-meta", children: [_jsx("input", { id: "airtable-use-meta", type: "checkbox", checked: settings.airtable.useCompetitorsForMetaBatch, onChange: (event) => setSettings({
                                            ...settings,
                                            airtable: {
                                                ...settings.airtable,
                                                useCompetitorsForMetaBatch: event.target.checked
                                            }
                                        }) }), "Use Airtable competitor page IDs for Meta batch extraction"] }), _jsxs("label", { className: "checkboxRow", htmlFor: "airtable-auto-sync", children: [_jsx("input", { id: "airtable-auto-sync", type: "checkbox", checked: settings.airtable.autoSyncAdsAfterExtract, onChange: (event) => setSettings({
                                            ...settings,
                                            airtable: {
                                                ...settings.airtable,
                                                autoSyncAdsAfterExtract: event.target.checked
                                            }
                                        }) }), "Auto-sync Airtable ads after each extraction"] }), _jsxs("label", { className: "checkboxRow", htmlFor: "auto-classify", children: [_jsx("input", { id: "auto-classify", type: "checkbox", checked: settings.autoClassifyAfterExtract, onChange: (event) => setSettings({
                                            ...settings,
                                            autoClassifyAfterExtract: event.target.checked
                                        }) }), "Auto-classify after extraction"] }), _jsxs("div", { className: "buttonGrid", children: [_jsx("button", { className: "primary", disabled: busy, onClick: () => void saveSettings(), children: "Save Settings" }), _jsx("button", { disabled: busy, onClick: () => void runAction("refresh"), children: "Refresh Data" }), _jsx("button", { className: "danger", disabled: !busy, onClick: () => void runAction("stop-job"), children: "Stop Job" }), _jsx("button", { disabled: busy, onClick: () => void runAction("sync-competitors"), children: "Sync Competitors" }), _jsx("button", { disabled: busy, onClick: () => void runAction("sync-airtable-ads"), children: "Sync Airtable Ads" }), _jsx("button", { disabled: busy, onClick: () => void runAction("extract-foreplay"), children: "Extract Foreplay" }), _jsx("button", { disabled: busy, onClick: () => void runAction("extract-adplexity"), children: "Extract AdPlexity" }), _jsx("button", { disabled: busy, onClick: () => void runAction("extract-meta"), children: "Extract Meta" }), _jsx("button", { disabled: busy, onClick: () => void runAction("classify"), children: "Classify" }), _jsx("button", { className: "primary fullWidth", disabled: busy, onClick: () => void runAction("full-refresh"), children: "Run Full Refresh" })] }), error ? _jsx("div", { className: "errorBanner", children: error }) : null, _jsx("div", { className: "noteBox", children: "Responsible mode stays in place: one job at a time, persisted settings, live status, and explicit confirmations before actions." })] }), _jsxs("section", { className: "workspace", children: [_jsxs("section", { className: "panel statusCard", children: [_jsxs("div", { className: "statusHeader", children: [_jsx("h2", { children: "Job Status" }), _jsx("div", { className: `statusPill ${busy ? "running" : appState?.job.lastError ? "error" : "idle"}`, children: busy ? "Running" : appState?.job.lastError ? "Error" : "Idle" })] }), _jsxs("div", { className: "statusDetail", children: [appState?.job.name ? `Action: ${label(appState.job.name)}` : "No job has run yet in this session.", appState?.job.startedAt ? ` | Started: ${appState.job.startedAt}` : "", appState?.job.finishedAt ? ` | Finished: ${appState.job.finishedAt}` : "", appState?.job.lastResult ? ` | ${appState.job.lastResult}` : "", appState?.job.lastError ? ` | ${appState.job.lastError}` : ""] }), _jsx("pre", { className: "logBox", children: appState?.job.logs.length ? appState.job.logs.join("\n") : "Waiting for activity..." })] }), _jsxs("section", { className: "panel board", children: [_jsxs("div", { className: "filters", children: [_jsxs("div", { children: [_jsx("label", { className: "fieldLabel", htmlFor: "source-filter", children: "Source" }), _jsx("select", { id: "source-filter", value: filters.source, onChange: (event) => setFilters({ ...filters, source: event.target.value }), children: sourceOptions.map((option) => (_jsx("option", { value: option, children: label(option) }, option))) })] }), _jsxs("div", { children: [_jsx("label", { className: "fieldLabel", htmlFor: "vertical-filter", children: "Vertical" }), _jsx("select", { id: "vertical-filter", value: filters.vertical, onChange: (event) => setFilters({ ...filters, vertical: event.target.value }), children: verticalOptions.map((option) => (_jsx("option", { value: option, children: label(option) }, option))) })] }), _jsxs("div", { children: [_jsx("label", { className: "fieldLabel", htmlFor: "status-filter", children: "Status" }), _jsx("select", { id: "status-filter", value: filters.status, onChange: (event) => setFilters({ ...filters, status: event.target.value }), children: statusOptions.map((option) => (_jsx("option", { value: option, children: label(option) }, option))) })] }), _jsxs("div", { children: [_jsx("label", { className: "fieldLabel", htmlFor: "winner-filter", children: "Winner View" }), _jsxs("select", { id: "winner-filter", value: filters.winner, onChange: (event) => setFilters({ ...filters, winner: event.target.value }), children: [_jsx("option", { value: "all", children: "All Ads" }), _jsx("option", { value: "winners", children: "Winners Only" }), _jsx("option", { value: "non-winners", children: "Non-Winners Only" })] })] }), _jsxs("div", { children: [_jsx("label", { className: "fieldLabel", htmlFor: "search-filter", children: "Search" }), _jsx("input", { id: "search-filter", type: "search", placeholder: "Brand, copy, platform...", value: filters.search, onChange: (event) => setFilters({ ...filters, search: event.target.value }) })] })] }), _jsxs("div", { className: "boardToolbar", children: [_jsxs("p", { children: [filteredAds.length, " of ", payload.ads.length, " ads visible | ", visibleWinners, " winner ads in view"] }), error ? _jsx("div", { className: "errorBanner", children: error }) : null] }), _jsx("div", { className: "cardGrid", children: filteredAds.length === 0 ? (_jsx("div", { className: "emptyState", children: "No ads match the current filters." })) : (filteredAds.map((card) => (_jsxs("article", { className: `adCard ${card.isWinner ? "winnerCard" : ""}`, children: [_jsxs("div", { className: "mediaFrame", children: [mediaPreview(card), _jsxs("div", { className: "badgeRows", children: [_jsxs("div", { className: "badgeStack", children: [_jsx("span", { className: `badge source-${card.source}`, children: card.sourceText }), card.isWinner ? _jsx("span", { className: "badge winnerBadge", children: "Foreplay Winner" }) : null] }), _jsxs("div", { className: "badgeStack", children: [_jsx("span", { className: "badge neutralBadge", children: label(card.verticalText) }), _jsx("span", { className: `badge status-${card.statusText}`, children: label(card.statusText) })] })] })] }), _jsxs("div", { className: "cardBody", children: [_jsxs("div", { className: "brandRow", children: [_jsx("div", { className: "brandName", children: card.brandText }), card.isWinner ? _jsx("div", { className: "winnerInline", children: card.winnerText }) : null] }), _jsx("div", { className: "cardTitle", children: card.titleText || "Untitled Creative" }), _jsx("p", { className: "cardCopy", children: card.copyText || "No ad copy captured for this creative." }), _jsxs("div", { className: "metaGrid", children: [_jsxs("div", { className: "metaItem", children: [_jsx("div", { className: "metaKey", children: "Days Running" }), _jsx("div", { className: "metaValue", children: card.daysRunningText })] }), _jsxs("div", { className: "metaItem", children: [_jsx("div", { className: "metaKey", children: "Platforms" }), _jsx("div", { className: "metaValue", children: card.platformsText })] }), _jsxs("div", { className: "metaItem", children: [_jsx("div", { className: "metaKey", children: "Countries" }), _jsx("div", { className: "metaValue", children: card.countriesText })] }), _jsxs("div", { className: "metaItem", children: [_jsx("div", { className: "metaKey", children: "CTA" }), _jsx("div", { className: "metaValue", children: card.cta || "Unknown" })] }), _jsxs("div", { className: "metaItem", children: [_jsx("div", { className: "metaKey", children: "First Seen" }), _jsx("div", { className: "metaValue", children: card.firstSeenText })] }), _jsxs("div", { className: "metaItem", children: [_jsx("div", { className: "metaKey", children: "Last Seen" }), _jsx("div", { className: "metaValue", children: card.lastSeenText })] })] }), _jsxs("div", { className: "linkRow", children: [card.landingPageUrl ? (_jsx("a", { href: card.landingPageUrl, rel: "noreferrer", target: "_blank", children: "Landing Page" })) : null, card.adLibraryUrl ? (_jsx("a", { href: card.adLibraryUrl, rel: "noreferrer", target: "_blank", children: "Ad Library" })) : null] })] })] }, `${card.source}-${card.sourceId}`)))) })] })] })] })] }));
}
