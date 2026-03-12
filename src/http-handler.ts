import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { browsePlugins, getInstalledPluginIds, type BrowseOptions } from "./marketplace-store.js";
import {
  startInstall,
  getJobStatus,
  type InstallJob,
} from "./marketplace-installer.js";

// ── Types ─────────────────────────────────────────────────────────

interface PluginLogger {
  info?: (...args: any[]) => void;
  warn?: (...args: any[]) => void;
  error?: (...args: any[]) => void;
}

export interface HttpHandlerParams {
  logger?: PluginLogger;
  uiRoot: string;
  pluginRoot: string;
  registryUrl?: string;
  cacheTtl?: number;
  pluginApi?: any;
}

// ── Constants ─────────────────────────────────────────────────────

const PREFIX = "/plugins/openclaw-appstore";

// ── Handler factory ───────────────────────────────────────────────

/**
 * Gateway only supports exact-path matching for plugin routes.
 * This handler serves on the EXACT path `/plugins/openclaw-appstore`:
 *   - No query params → self-contained HTML bundle (inline JS+CSS)
 *   - ?_api=browse    → JSON browse response
 *   - ?_api=install   → JSON install response (POST)
 *   - ?_api=status&jobId=xxx → JSON status response
 *   - ?_api=installed → JSON installed list
 */
export function createHttpHandler(params: HttpHandlerParams) {
  const { logger, uiRoot, pluginRoot, registryUrl, cacheTtl, pluginApi } = params;
  const bundledRegistryPath = path.join(pluginRoot, "registry.json");

  let bundledHtml: string | null = null;
  let lastBundleTime = 0;

  function buildBundle(): string {
    const cssPath = path.join(uiRoot, "app.css");
    const jsPath = path.join(uiRoot, "app.js");

    const css = fs.existsSync(cssPath) ? fs.readFileSync(cssPath, "utf8") : "";
    let js = fs.existsSync(jsPath) ? fs.readFileSync(jsPath, "utf8") : "";

    // Rewrite API_BASE to use query-parameter dispatch on the same URL
    js = js.replace(
      /const API_BASE\s*=\s*["'][^"']*["']/,
      `const API_BASE = "${PREFIX}"`,
    );

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>App Market — OpenClaw</title>
  <style>${css}</style>
</head>
<body>
  <div id="app"></div>
  <script type="module">${js}</script>
</body>
</html>`;
  }

  return async function handler(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;

    if (pathname !== PREFIX) return false;

    // ── API dispatch via _api query param ────────────────────
    const apiAction = url.searchParams.get("_api");

    if (apiAction === "browse" && req.method === "GET") {
      return handleBrowse(req, res, url, logger, registryUrl, cacheTtl, bundledRegistryPath);
    }
    if (apiAction === "install" && req.method === "POST") {
      return handleInstall(req, res, logger);
    }
    if (apiAction === "status" && req.method === "GET") {
      const jobId = url.searchParams.get("jobId") || "";
      return handleStatus(res, jobId);
    }
    if (apiAction === "installed" && req.method === "GET") {
      return handleInstalled(res);
    }

    // ── HTML bundle ──────────────────────────────────────────
    const now = Date.now();
    if (!bundledHtml || now - lastBundleTime > 5000) {
      try {
        bundledHtml = buildBundle();
        lastBundleTime = now;
      } catch (err) {
        logger?.warn?.(`[openclaw-appstore] Bundle error: ${err}`);
        res.statusCode = 500;
        res.end("Failed to build UI bundle");
        return true;
      }
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(bundledHtml);
    return true;
  };
}

// ── API Handlers ──────────────────────────────────────────────────

async function handleBrowse(
  _req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  logger?: PluginLogger,
  registryUrl?: string,
  cacheTtl?: number,
  bundledRegistryPath?: string,
): Promise<boolean> {
  try {
    const opts: BrowseOptions = {
      logger,
      search: url.searchParams.get("search") || undefined,
      category: url.searchParams.get("category") || undefined,
      sort: (url.searchParams.get("sort") as "stars" | "updated") || "stars",
      registryUrl,
      cacheTtl,
      bundledRegistryPath,
    };

    const plugins = await browsePlugins(opts);
    sendJson(res, 200, { plugins });
  } catch (err) {
    logger?.error?.(`[appstore] Browse error: ${err}`);
    sendJson(res, 500, { error: "Failed to fetch plugins" });
  }
  return true;
}

async function handleInstall(
  req: IncomingMessage,
  res: ServerResponse,
  logger?: PluginLogger,
): Promise<boolean> {
  try {
    const body = await readBody(req);
    const { npmSpec, pluginId } = body as { npmSpec?: string; pluginId?: string };

    if (!npmSpec || !pluginId) {
      sendJson(res, 400, { error: "Missing required fields: npmSpec, pluginId" });
      return true;
    }

    if (typeof npmSpec !== "string" || npmSpec.length > 500) {
      sendJson(res, 400, { error: "Invalid npmSpec" });
      return true;
    }

    if (typeof pluginId !== "string" || pluginId.length > 100) {
      sendJson(res, 400, { error: "Invalid pluginId" });
      return true;
    }

    if (npmSpec.includes("..") || npmSpec.includes("~")) {
      sendJson(res, 400, { error: "Invalid npm spec: suspicious characters" });
      return true;
    }

    const jobId = startInstall(npmSpec, pluginId, logger);
    sendJson(res, 202, { jobId, status: "installing", pluginId });
  } catch (err) {
    logger?.error?.(`[appstore] Install error: ${err}`);
    sendJson(res, 500, { error: "Failed to start installation" });
  }
  return true;
}

function handleStatus(res: ServerResponse, jobId: string): boolean {
  const job = getJobStatus(jobId);
  if (!job) {
    sendJson(res, 404, { error: "Job not found" });
    return true;
  }
  sendJson(res, 200, {
    jobId: job.jobId,
    pluginId: job.pluginId,
    status: job.status,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    error: job.error,
    message: job.message,
  });
  return true;
}

function handleInstalled(res: ServerResponse): boolean {
  try {
    const ids = getInstalledPluginIds();
    sendJson(res, 200, { installed: ids });
  } catch (err) {
    sendJson(res, 500, { error: "Failed to get installed plugins" });
  }
  return true;
}

// ── Utilities ─────────────────────────────────────────────────────

function sendJson(res: ServerResponse, status: number, data: any): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = "";
    let rejected = false;
    req.on("data", (chunk) => {
      if (rejected) return;
      body += chunk.toString();
      if (body.length > 1024 * 64) {
        rejected = true;
        req.destroy();
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
      if (rejected) return;
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", (err) => {
      if (!rejected) reject(err);
    });
  });
}
