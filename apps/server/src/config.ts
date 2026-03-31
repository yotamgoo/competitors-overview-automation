import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function loadEnvFile(filePath: string): void {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) {
      continue;
    }

    const [keyPart, ...valueParts] = line.split("=");
    const key = keyPart.trim();
    const value = valueParts.join("=").trim().replace(/^['"]|['"]$/g, "");

    if (key && !(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function envText(name: string, defaultValue = ""): string {
  return String(process.env[name] ?? defaultValue).trim();
}

function envFirst(names: string[], defaultValue = ""): string {
  for (const name of names) {
    const value = envText(name);
    if (value) {
      return value;
    }
  }
  return defaultValue.trim();
}

function envInt(name: string, defaultValue: number): number {
  const value = Number.parseInt(envText(name), 10);
  return Number.isFinite(value) ? value : defaultValue;
}

function resolvePath(rootDir: string, rawPath: string): string {
  if (!rawPath) {
    return rootDir;
  }

  const candidate = rawPath.startsWith("~")
    ? path.join(process.env.HOME ?? process.env.USERPROFILE ?? "", rawPath.slice(1))
    : rawPath;

  return path.isAbsolute(candidate) ? path.normalize(candidate) : path.resolve(rootDir, candidate);
}

const currentFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(currentFile), "../../../");

loadEnvFile(path.join(repoRoot, ".env"));

const dbDir = path.join(repoRoot, "db");
const metaSourceDir = resolvePath(repoRoot, envText("META_SOURCE_DIR", "sources/meta"));
const legacyDbPath = resolvePath(repoRoot, envText("INTELLIGENCE_DB_PATH", "db/intelligence.db"));
const explicitDataPath = envText("INTELLIGENCE_DATA_PATH");
const dataPath = explicitDataPath
  ? resolvePath(repoRoot, explicitDataPath)
  : legacyDbPath.replace(/\.[^.]+$/, ".json");

export const config = {
  repoRoot,
  dbDir,
  dataPath,
  legacyDbPath,
  webDistDir: path.join(repoRoot, "apps", "web", "dist"),
  dashboardSettingsPath: resolvePath(
    repoRoot,
    envText("INTELLIGENCE_DASHBOARD_SETTINGS_PATH", "db/dashboard_settings.json")
  ),
  dashboardPort: envInt("INTELLIGENCE_DASHBOARD_PORT", envInt("PORT", 8080)),
  metaSourceDir,
  metaAdvertisersDb: resolvePath(
    repoRoot,
    envText("META_ADVERTISERS_DB", path.join(metaSourceDir, "ads.db"))
  ),
  credentials: {
    foreplayEmail: envText("FOREPLAY_EMAIL"),
    foreplayPassword: envText("FOREPLAY_PASSWORD"),
    adplexityEmail: envText("ADPLEXITY_EMAIL"),
    adplexityPassword: envText("ADPLEXITY_PASSWORD"),
    airtablePat: envFirst(["AIRTABLE_PAT", "AIRTABLE_TOKEN", "AIRTABLE_API_KEY"])
  }
};
