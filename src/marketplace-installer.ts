import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// ── Interfaces ────────────────────────────────────────────────────

export interface InstallJob {
  jobId: string;
  pluginId: string;
  npmSpec: string;
  status: "installing" | "uninstalling" | "done" | "error";
  startedAt: number;
  endedAt?: number;
  error?: string;
  message?: string;
  stdout?: string;
  stderr?: string;
}

interface PluginLogger {
  info?: (...args: any[]) => void;
  warn?: (...args: any[]) => void;
  error?: (...args: any[]) => void;
}

// ── State ─────────────────────────────────────────────────────────

const installJobs = new Map<string, InstallJob>();
let activeInstall: string | null = null;
const pendingQueue: Array<{
  jobId: string;
  npmSpec: string;
  pluginId: string;
  logger?: PluginLogger;
}> = [];

// ── Constants ─────────────────────────────────────────────────────

const INSTALL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const MAX_JOBS_HISTORY = 50;
const MAX_OUTPUT_SIZE = 256 * 1024; // 256KB max stdout/stderr per job

// ── Public API ────────────────────────────────────────────────────

/**
 * Start a plugin installation. Returns a jobId for status polling.
 * Only one install runs at a time; additional requests are queued.
 */
export function startInstall(
  npmSpec: string,
  pluginId: string,
  logger?: PluginLogger,
): string {
  const jobId = crypto.randomUUID();

  const job: InstallJob = {
    jobId,
    pluginId,
    npmSpec,
    status: "installing",
    startedAt: Date.now(),
  };

  installJobs.set(jobId, job);
  cleanOldJobs();

  if (activeInstall) {
    logger?.info?.(`[appstore] Install queued: ${pluginId} (${npmSpec})`);
    pendingQueue.push({ jobId, npmSpec, pluginId, logger });
  } else {
    activeInstall = jobId;
    runInstall(jobId, npmSpec, pluginId, logger);
  }

  return jobId;
}

/**
 * Get the status of an install job.
 */
export function getJobStatus(jobId: string): InstallJob | null {
  return installJobs.get(jobId) ?? null;
}

/**
 * Start a plugin uninstallation. Returns a jobId for status polling.
 * Removes plugin files from extensions dir and config entries from openclaw.json.
 */
export function startUninstall(
  pluginId: string,
  logger?: PluginLogger,
): string {
  const jobId = crypto.randomUUID();

  const job: InstallJob = {
    jobId,
    pluginId,
    npmSpec: "",
    status: "uninstalling",
    startedAt: Date.now(),
  };

  installJobs.set(jobId, job);
  cleanOldJobs();

  // Run async but don't block the response
  runUninstall(jobId, pluginId, logger);

  return jobId;
}

/**
 * Get all jobs (for debugging/admin).
 */
export function getAllJobs(): InstallJob[] {
  return Array.from(installJobs.values()).sort(
    (a, b) => b.startedAt - a.startedAt,
  );
}

// ── Internal ──────────────────────────────────────────────────────

function runInstall(
  jobId: string,
  npmSpec: string,
  pluginId: string,
  logger?: PluginLogger,
): void {
  logger?.info?.(`[appstore] Starting install: ${pluginId} via ${npmSpec}`);

  const job = installJobs.get(jobId);
  if (!job) return;

  let stdout = "";
  let stderr = "";
  let killed = false;

  const child = spawn("openclaw", ["plugins", "install", npmSpec], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
    timeout: INSTALL_TIMEOUT_MS,
  });

  // Timeout fallback (spawn timeout doesn't always work)
  const timer = setTimeout(() => {
    if (child.exitCode === null) {
      killed = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 5000);
    }
  }, INSTALL_TIMEOUT_MS);

  child.stdout?.on("data", (chunk: Buffer) => {
    if (stdout.length < MAX_OUTPUT_SIZE) stdout += chunk.toString();
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderr.length < MAX_OUTPUT_SIZE) stderr += chunk.toString();
  });

  child.on("error", (err) => {
    clearTimeout(timer);
    const job = installJobs.get(jobId);
    if (job) {
      job.status = "error";
      job.error = `Failed to start install process: ${err.message}`;
      job.endedAt = Date.now();
      job.stdout = stdout;
      job.stderr = stderr;
    }
    logger?.error?.(`[appstore] Install process error: ${err.message}`);
    finishAndProcessQueue(logger);
  });

  child.on("close", (code) => {
    clearTimeout(timer);
    const job = installJobs.get(jobId);
    if (!job) {
      finishAndProcessQueue(logger);
      return;
    }

    job.stdout = stdout;
    job.stderr = stderr;
    job.endedAt = Date.now();

    if (killed) {
      job.status = "error";
      job.error = "Installation timed out after 5 minutes. No changes were made.";
      logger?.warn?.(`[appstore] Install timed out: ${pluginId}`);
    } else if (code !== 0) {
      job.status = "error";
      // Extract meaningful error from stderr
      const errMsg = extractErrorMessage(stderr, stdout);
      job.error = errMsg || `Installation failed (exit code ${code})`;
      logger?.warn?.(`[appstore] Install failed: ${pluginId} — ${job.error}`);
    } else {
      job.status = "done";
      job.message = `Plugin "${pluginId}" installed successfully. Restart the gateway to activate.`;
      logger?.info?.(`[appstore] Install complete: ${pluginId}`);
    }

    finishAndProcessQueue(logger);
  });
}

function finishAndProcessQueue(logger?: PluginLogger): void {
  activeInstall = null;
  if (pendingQueue.length > 0) {
    const next = pendingQueue.shift()!;
    activeInstall = next.jobId;
    runInstall(next.jobId, next.npmSpec, next.pluginId, next.logger ?? logger);
  }
}

function extractErrorMessage(stderr: string, stdout: string): string {
  const combined = `${stderr}\n${stdout}`;
  const lines = combined
    .split("\n")
    .map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trim())
    .filter(Boolean);

  // Filter out gateway plugin system noise (e.g. "[plugins] [engine-manager] Virtualenv already exists.")
  const relevantLines = lines.filter(
    (l) => !l.startsWith("[plugins]") && !l.startsWith("[gateway]"),
  );

  // Look for common error patterns in relevant lines first
  const errorPatterns = ["Error:", "error:", "ERR!", "failed", "not found", "ENOENT", "EACCES"];
  for (const line of relevantLines) {
    if (errorPatterns.some((p) => line.includes(p))) {
      return line;
    }
  }

  // Fallback: last relevant non-empty line
  if (relevantLines.length > 0) {
    return relevantLines[relevantLines.length - 1] ?? "Unknown error";
  }

  // Last resort: last line from all output
  return lines[lines.length - 1] ?? "Unknown error";
}

// ── Uninstall logic ──────────────────────────────────────────────

const PROTECTED_PLUGINS = new Set(["openclaw-appstore"]);

function getConfigPath(): string {
  const home = process.env.HOME || "/root";
  return path.join(home, ".openclaw/openclaw.json");
}

function getExtensionsDir(): string {
  const home = process.env.HOME || "/root";
  return path.join(home, ".openclaw/extensions");
}

async function runUninstall(
  jobId: string,
  pluginId: string,
  logger?: PluginLogger,
): Promise<void> {
  const job = installJobs.get(jobId);
  if (!job) return;

  try {
    logger?.info?.(`[appstore] Starting uninstall: ${pluginId}`);

    // Safety: block self-uninstall
    if (PROTECTED_PLUGINS.has(pluginId)) {
      job.status = "error";
      job.error = "Cannot uninstall the App Market plugin itself.";
      job.endedAt = Date.now();
      return;
    }

    // 1. Read config to find install metadata
    const configPath = getConfigPath();
    let config: any = {};
    try {
      config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch {
      job.status = "error";
      job.error = "Could not read openclaw.json config.";
      job.endedAt = Date.now();
      return;
    }

    const installInfo = config?.plugins?.installs?.[pluginId];

    // Block path-based (dev) installs
    if (installInfo?.source === "path") {
      job.status = "error";
      job.error = "Cannot uninstall path-based (development) plugins. Remove them manually.";
      job.endedAt = Date.now();
      return;
    }

    // 2. Remove extension directory (only if under ~/.openclaw/extensions/)
    const extDir = getExtensionsDir();
    const installPath = installInfo?.installPath;
    if (installPath && typeof installPath === "string") {
      const resolved = path.resolve(installPath);
      if (resolved.startsWith(extDir + "/") && fs.existsSync(resolved)) {
        logger?.info?.(`[appstore] Removing directory: ${resolved}`);
        fs.rmSync(resolved, { recursive: true, force: true });
      }
    }

    // Also check default extension path even without install metadata
    const defaultExtPath = path.join(extDir, pluginId);
    if (fs.existsSync(defaultExtPath)) {
      logger?.info?.(`[appstore] Removing directory: ${defaultExtPath}`);
      fs.rmSync(defaultExtPath, { recursive: true, force: true });
    }

    // 3. Remove config entries
    let configChanged = false;
    if (config?.plugins?.entries?.[pluginId]) {
      delete config.plugins.entries[pluginId];
      configChanged = true;
    }
    if (config?.plugins?.installs?.[pluginId]) {
      delete config.plugins.installs[pluginId];
      configChanged = true;
    }

    if (configChanged) {
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
      logger?.info?.(`[appstore] Removed config entries for: ${pluginId}`);
    }

    // 4. Done
    job.status = "done";
    job.message = `Plugin "${pluginId}" has been removed. Restart the gateway to apply changes.`;
    job.endedAt = Date.now();
    logger?.info?.(`[appstore] Uninstall complete: ${pluginId}`);
  } catch (err) {
    job.status = "error";
    job.error = `Uninstall failed: ${err instanceof Error ? err.message : String(err)}`;
    job.endedAt = Date.now();
    logger?.error?.(`[appstore] Uninstall error for ${pluginId}: ${err}`);
  }
}

function cleanOldJobs(): void {
  if (installJobs.size <= MAX_JOBS_HISTORY) return;
  const sorted = Array.from(installJobs.entries()).sort(
    ([, a], [, b]) => a.startedAt - b.startedAt,
  );
  const toRemove = sorted.slice(0, sorted.length - MAX_JOBS_HISTORY);
  for (const [id] of toRemove) {
    const job = installJobs.get(id);
    if (job && job.status !== "installing") {
      installJobs.delete(id);
    }
  }
}
