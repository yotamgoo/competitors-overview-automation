import { spawn } from "node:child_process";

import type { DashboardPayload, DashboardSettings } from "@competitors/shared";

type LogFn = (line: string) => void;

interface BridgeOptions {
  pythonExecutable: string;
  scriptPath: string;
  dbPath: string;
  advertisersDbPath: string;
}

function splitIntoLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split(/\r?\n/);
  const rest = parts.pop() ?? "";
  return {
    lines: parts.filter((line) => line.trim()),
    rest
  };
}

export class PythonBridge {
  constructor(private readonly options: BridgeOptions) {}

  async getDashboardPayload(): Promise<DashboardPayload> {
    const stdout = await this.runJsonCommand([
      this.options.scriptPath,
      "dashboard-data",
      "--db",
      this.options.dbPath
    ]);
    return JSON.parse(stdout) as DashboardPayload;
  }

  async runForeplay(settings: DashboardSettings["foreplay"], log: LogFn): Promise<string> {
    return this.runLoggedCommand(
      [
        this.options.scriptPath,
        "extract",
        "foreplay",
        "--db",
        this.options.dbPath,
        "--brand-ids",
        ...settings.brandIds,
        "--months",
        String(settings.months)
      ],
      log
    );
  }

  async runAdplexity(settings: DashboardSettings["adplexity"], log: LogFn): Promise<string> {
    return this.runLoggedCommand(
      [
        this.options.scriptPath,
        "extract",
        "adplexity",
        "--db",
        this.options.dbPath,
        "--report-ids",
        ...settings.reportIds.map(String)
      ],
      log
    );
  }

  async runMeta(settings: DashboardSettings["meta"], log: LogFn): Promise<string> {
    const args = [
      this.options.scriptPath,
      "extract",
      "meta",
      "--db",
      this.options.dbPath
    ];

    if (settings.mode === "page") {
      args.push("--page-id", settings.pageId);
      if (settings.keywords) {
        args.push("--keywords", settings.keywords);
      }
    } else {
      args.push("--batch", "--advertisers-db", settings.advertisersDb || this.options.advertisersDbPath);
      if (settings.verticalFilter) {
        args.push("--vertical-filter", settings.verticalFilter);
      }
    }

    args.push(
      "--min-days",
      String(settings.minDays),
      "--media",
      settings.media,
      "--max-ads",
      String(settings.maxAds)
    );

    if (settings.mode === "page" && settings.verticalFilter) {
      args.push("--vertical-filter", settings.verticalFilter);
    }

    if (settings.mode === "batch" && !args.includes("--advertisers-db")) {
      args.push("--advertisers-db", this.options.advertisersDbPath);
    }

    return this.runLoggedCommand(args, log);
  }

  async runClassify(log: LogFn): Promise<string> {
    return this.runLoggedCommand(
      [this.options.scriptPath, "classify", "--db", this.options.dbPath],
      log
    );
  }

  private runJsonCommand(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.options.pythonExecutable, args, {
        stdio: ["ignore", "pipe", "pipe"]
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      child.on("error", (error) => {
        reject(error);
      });

      child.on("close", (code) => {
        if (code === 0) {
          resolve(stdout.trim());
          return;
        }
        reject(new Error(stderr.trim() || stdout.trim() || `Python bridge failed with exit code ${code}`));
      });
    });
  }

  private runLoggedCommand(args: string[], log: LogFn): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.options.pythonExecutable, args, {
        stdio: ["ignore", "pipe", "pipe"]
      });

      let stdoutBuffer = "";
      let stderrBuffer = "";
      let lastResult = "";

      const emitStdout = (chunk: string) => {
        stdoutBuffer += chunk;
        const { lines, rest } = splitIntoLines(stdoutBuffer);
        stdoutBuffer = rest;
        for (const line of lines) {
          log(line);
          if (line.startsWith("RESULT:")) {
            lastResult = line.replace(/^RESULT:\s*/, "").trim();
          } else if (line.trim()) {
            lastResult = line.trim();
          }
        }
      };

      const emitStderr = (chunk: string) => {
        stderrBuffer += chunk;
        const { lines, rest } = splitIntoLines(stderrBuffer);
        stderrBuffer = rest;
        for (const line of lines) {
          log(line);
        }
      };

      child.stdout.on("data", (chunk) => emitStdout(chunk.toString()));
      child.stderr.on("data", (chunk) => emitStderr(chunk.toString()));

      child.on("error", (error) => {
        reject(error);
      });

      child.on("close", (code) => {
        if (stdoutBuffer.trim()) {
          emitStdout("\n");
        }
        if (stderrBuffer.trim()) {
          emitStderr("\n");
        }

        if (code === 0) {
          resolve(lastResult || "Python bridge action completed.");
          return;
        }

        reject(new Error(lastResult || `Python bridge failed with exit code ${code}`));
      });
    });
  }
}
