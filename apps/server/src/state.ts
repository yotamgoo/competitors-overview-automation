import type { DashboardPayload, DashboardStats, JobSnapshot } from "@competitors/shared";

export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function createEmptyJob(): JobSnapshot {
  return {
    running: false,
    name: "",
    startedAt: null,
    finishedAt: null,
    lastResult: "",
    lastError: "",
    logs: []
  };
}

export function createEmptyStats(): DashboardStats {
  return {
    totalAds: 0,
    winnerAds: 0,
    bySource: {},
    byStatus: {},
    byVertical: {}
  };
}

export function createEmptyDashboardPayload(): DashboardPayload {
  return {
    generatedAt: nowIso(),
    stats: createEmptyStats(),
    ads: []
  };
}
