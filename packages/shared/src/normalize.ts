import type { AdSource, AdStatus } from "./types";

const VALID_SOURCES = new Set<AdSource>(["foreplay", "adplexity", "meta"]);

function isoWithoutMilliseconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function nowIso(): string {
  return isoWithoutMilliseconds(new Date());
}

export function normalizeSource(value: unknown): AdSource {
  const source = String(value ?? "").trim().toLowerCase() as AdSource;
  if (!VALID_SOURCES.has(source)) {
    throw new Error(`Unsupported source: ${String(value)}`);
  }
  return source;
}

export function normalizeStatus(value: unknown): AdStatus {
  if (typeof value === "boolean") {
    return value ? "active" : "inactive";
  }

  if (typeof value === "number") {
    return value ? "active" : "inactive";
  }

  const text = String(value ?? "").trim().toLowerCase();
  if (["active", "running", "live", "1", "true"].includes(text)) {
    return "active";
  }
  if (["inactive", "ended", "stopped", "0", "false"].includes(text)) {
    return "inactive";
  }
  return "active";
}

export function normalizeOptionalText(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const text = String(value).trim();
  return text || null;
}

export function normalizeDateTime(value: unknown): string | null {
  if (value === null || value === undefined || value === "" || value === 0) {
    return null;
  }

  if (value instanceof Date) {
    return isoWithoutMilliseconds(value);
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    const timestamp =
      value > 1_000_000_000_000 ? value : value > 1_000_000_000 ? value * 1000 : Number.NaN;
    if (Number.isNaN(timestamp)) {
      return null;
    }
    return isoWithoutMilliseconds(new Date(timestamp));
  }

  const text = String(value).trim();
  if (!text) {
    return null;
  }

  if (/^\d+$/.test(text)) {
    return normalizeDateTime(Number(text));
  }

  const parsed = new Date(text);
  if (Number.isNaN(parsed.valueOf())) {
    return text;
  }

  return isoWithoutMilliseconds(parsed);
}

export function normalizeDaysRunning(
  days: unknown,
  options: {
    firstSeen?: unknown;
    lastSeen?: unknown;
  } = {}
): number | null {
  if (days !== null && days !== undefined && String(days).trim() !== "") {
    const numeric = Number(days);
    if (Number.isFinite(numeric)) {
      return Math.trunc(numeric);
    }
  }

  const firstIso = normalizeDateTime(options.firstSeen);
  const lastIso = normalizeDateTime(options.lastSeen) ?? nowIso();
  if (!firstIso) {
    return null;
  }

  const first = new Date(firstIso);
  const last = new Date(lastIso);
  if (Number.isNaN(first.valueOf()) || Number.isNaN(last.valueOf())) {
    return null;
  }

  const deltaMs = last.valueOf() - first.valueOf();
  return Math.max(Math.floor(deltaMs / 86_400_000), 0);
}

export function coerceList(value: unknown): unknown[] {
  if (value === null || value === undefined || value === "") {
    return [];
  }

  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value === "string") {
    const text = value.trim();
    if (!text) {
      return [];
    }

    if (text.startsWith("[")) {
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) {
          return parsed;
        }
      } catch {
        return text.split(",").map((part) => part.trim()).filter(Boolean);
      }
    }

    return text.split(",").map((part) => part.trim()).filter(Boolean);
  }

  return [value];
}

export function normalizeCountryList(value: unknown): string[] {
  const seen = new Set<string>();
  const countries: string[] = [];

  for (const item of coerceList(value)) {
    const token = String(item ?? "").trim().toUpperCase();
    if (token && !seen.has(token)) {
      seen.add(token);
      countries.push(token);
    }
  }

  return countries;
}

export function normalizePlatformList(value: unknown): string[] {
  const seen = new Set<string>();
  const platforms: string[] = [];

  for (const item of coerceList(value)) {
    const token = String(item ?? "")
      .trim()
      .toLowerCase()
      .replaceAll("-", " ")
      .replaceAll("/", " ");
    const normalized = token.split(/\s+/).filter(Boolean).join("_");
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      platforms.push(normalized);
    }
  }

  return platforms;
}

export function parseJsonList(value: unknown): string[] {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.map((item) => String(item)).filter(Boolean);
  }

  const text = String(value);
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parsed.map((item) => String(item)).filter(Boolean);
    }
    return [String(parsed)];
  } catch {
    return text.split(",").map((part) => part.trim()).filter(Boolean);
  }
}

export function displayBrandFromUrl(url: string | null): string {
  if (!url) {
    return "";
  }

  try {
    const parsed = new URL(url);
    let host = parsed.hostname.toLowerCase();
    if (host.startsWith("www.")) {
      host = host.slice(4);
    }

    if (!host) {
      return "";
    }

    const parts = host.split(".");
    const core = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
    return core
      .replaceAll("-", " ")
      .replaceAll("_", " ")
      .replace(/\b\w/g, (match) => match.toUpperCase());
  } catch {
    return "";
  }
}

export function formatPlatform(platform: string): string {
  return platform
    .replaceAll("_", " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

export function formatSource(source: string): string {
  if (source === "foreplay") {
    return "Foreplay";
  }
  if (source === "adplexity") {
    return "AdPlexity";
  }
  if (source === "meta") {
    return "Meta";
  }
  return source.replace(/\b\w/g, (match) => match.toUpperCase());
}
