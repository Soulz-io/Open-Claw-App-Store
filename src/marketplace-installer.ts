import { spawn } from "node:child_process";
import crypto from "node:crypto";

// ── Interfaces ────────────────────────────────────────────────────

export interface InstallJob {
  jobId: string;
  pluginId: string;
  npmSpec: string;
  status: "installing" | "done" | "error";
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
  // Try to find the most relevant error line
  const combined = `${stderr}\n${stdout}`;
  const lines = combined.split("\n").map((l) => l.trim()).filter(Boolean);

  // Look for common error patterns
  for (const line of lines) {
    if (
      line.includes("Error:") ||
      line.includes("error:") ||
      line.includes("failed") ||
      line.includes("not found") ||
      line.includes("ENOENT") ||
      line.includes("EACCES") ||
      line.includes("already exists")
    ) {
      // Clean up ANSI codes
      return line.replace(/\x1b\[[0-9;]*m/g, "").trim();
    }
  }

  // Fallback: last non-empty line
  return lines[lines.length - 1]?.replace(/\x1b\[[0-9;]*m/g, "").trim() ?? "Unknown error";
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
