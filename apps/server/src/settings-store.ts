import fs from "node:fs/promises";
import path from "node:path";

import { normalizeSettings, type DashboardSettings } from "@competitors/shared";

export class DashboardSettingsStore {
  constructor(
    private readonly settingsPath: string,
    private readonly advertisersDbPath: string
  ) {}

  async load(): Promise<DashboardSettings> {
    try {
      const raw = await fs.readFile(this.settingsPath, "utf8");
      return normalizeSettings(JSON.parse(raw), {
        advertisersDbPath: this.advertisersDbPath
      });
    } catch {
      return normalizeSettings({}, { advertisersDbPath: this.advertisersDbPath });
    }
  }

  async save(raw: unknown): Promise<DashboardSettings> {
    const settings = normalizeSettings(raw, {
      advertisersDbPath: this.advertisersDbPath
    });

    await fs.mkdir(path.dirname(this.settingsPath), { recursive: true });
    await fs.writeFile(this.settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    return settings;
  }
}
