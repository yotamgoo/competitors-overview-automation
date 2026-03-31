import "dotenv/config";

import fs from "node:fs";
import path from "node:path";

import cors from "cors";
import express from "express";

import type { DashboardAction } from "@competitors/shared";

import { AirtableService } from "./airtable/service.js";
import { config } from "./config.js";
import { DashboardAppController } from "./controller.js";
import { FileBackedIntelligenceStore } from "./data-store.js";
import { AdplexityExtractorService } from "./extractors/adplexity/service.js";
import { ForeplayExtractorService } from "./extractors/foreplay/service.js";
import { MetaExtractorService } from "./extractors/meta/service.js";
import { DashboardSettingsStore } from "./settings-store.js";

const app = express();
const dataStore = new FileBackedIntelligenceStore(config.dataPath);
const controller = new DashboardAppController(
  new DashboardSettingsStore(config.dashboardSettingsPath, config.metaAdvertisersDb),
  dataStore,
  new ForeplayExtractorService(dataStore, {
    email: config.credentials.foreplayEmail,
    password: config.credentials.foreplayPassword
  }),
  new AdplexityExtractorService(dataStore, {
    email: config.credentials.adplexityEmail,
    password: config.credentials.adplexityPassword
  }),
  new MetaExtractorService(dataStore, config.repoRoot, config.metaSourceDir),
  new AirtableService(config.credentials.airtablePat)
);

app.use(cors());
app.use(express.json());

app.get("/api/health", async (_req, res) => {
  res.json({
    ok: true,
    service: "competitors-server",
    storage: "native-typescript-json-store",
    dataPath: config.dataPath,
    dbPath: config.legacyDbPath,
    settingsPath: config.dashboardSettingsPath,
    migrationPhase: "native-foreplay-adplexity-meta-airtable"
  });
});

app.get("/api/state", async (_req, res) => {
  res.json(await controller.snapshot());
});

app.get("/api/data", async (_req, res) => {
  res.json(await controller.getData());
});

app.get("/api/media", async (req, res) => {
  const rawPath = String(req.query.path ?? "").trim();
  if (!rawPath) {
    res.status(400).json({ error: "Missing media path." });
    return;
  }

  const resolved = path.resolve(config.repoRoot, rawPath);
  const relative = path.relative(config.repoRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    res.status(403).json({ error: "Media path is outside the workspace." });
    return;
  }

  res.sendFile(resolved, (error) => {
    if (error && !res.headersSent) {
      const typedError = error as NodeJS.ErrnoException & { statusCode?: number };
      const statusCode: number = typeof typedError.statusCode === "number" ? typedError.statusCode : 404;
      res.status(statusCode).json({ error: "Media file not found." });
    }
  });
});

app.post("/api/settings", async (req, res) => {
  res.json(await controller.saveSettings(req.body));
});

app.post("/api/actions/:action", async (req, res) => {
  const action = req.params.action as DashboardAction;
  try {
    const snapshot = await controller.startAction(action, req.body);
    res.status(202).json(snapshot);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const statusCode = message.includes("already running") ? 409 : 400;
    res.status(statusCode).json({
      error: message,
      state: await controller.snapshot()
    });
  }
});

if (fs.existsSync(config.webDistDir)) {
  app.use(express.static(config.webDistDir));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(config.webDistDir, "index.html"));
  });
}

await controller.initialize();

app.listen(config.dashboardPort, () => {
  console.log(`TypeScript server listening on http://127.0.0.1:${config.dashboardPort}`);
});
