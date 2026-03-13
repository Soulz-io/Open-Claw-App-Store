import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { browsePlugins, getTrendingPlugins, getInstalledPluginIds, type BrowseOptions } from "./marketplace-store.js";
import {
  startInstall,
  startUninstall,
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
 *   - ?_api=uninstall → JSON uninstall response (POST)
 *   - ?_api=readme&github=owner/repo → README content
 *   - ?_api=trending  → JSON trending top 10
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
    if (apiAction === "uninstall" && req.method === "POST") {
      return handleUninstall(req, res, logger);
    }
    if (apiAction === "readme" && req.method === "GET") {
      const github = url.searchParams.get("github") || "";
      return handleReadme(res, github, logger);
    }
    if (apiAction === "trending" && req.method === "GET") {
      return handleTrending(res, logger, registryUrl, bundledRegistryPath);
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
      source: (url.searchParams.get("source") as "all" | "curated" | "community") || "all",
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

async function handleTrending(
  res: ServerResponse,
  logger?: PluginLogger,
  registryUrl?: string,
  bundledRegistryPath?: string,
): Promise<boolean> {
  try {
    const trending = await getTrendingPlugins(logger, registryUrl, bundledRegistryPath);
    sendJson(res, 200, { trending });
  } catch (err) {
    logger?.error?.(`[appstore] Trending error: ${err}`);
    sendJson(res, 500, { error: "Failed to fetch trending plugins" });
  }
  return true;
}

async function handleUninstall(
  req: IncomingMessage,
  res: ServerResponse,
  logger?: PluginLogger,
): Promise<boolean> {
  try {
    const body = await readBody(req);
    const { pluginId } = body as { pluginId?: string };

    if (!pluginId) {
      sendJson(res, 400, { error: "Missing required field: pluginId" });
      return true;
    }

    if (typeof pluginId !== "string" || pluginId.length > 100) {
      sendJson(res, 400, { error: "Invalid pluginId" });
      return true;
    }

    const jobId = startUninstall(pluginId, logger);
    sendJson(res, 202, { jobId, status: "uninstalling", pluginId });
  } catch (err) {
    logger?.error?.(`[appstore] Uninstall error: ${err}`);
    sendJson(res, 500, { error: "Failed to start uninstallation" });
  }
  return true;
}

// ── README cache ──────────────────────────────────────────────────
const readmeCache = new Map<string, { content: string; fetchedAt: number }>();
const README_CACHE_TTL = 10 * 60 * 1000; // 10 minutes
const README_MAX_SIZE = 64 * 1024; // 64KB max

async function handleReadme(
  res: ServerResponse,
  github: string,
  logger?: PluginLogger,
): Promise<boolean> {
  if (!github || !/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(github)) {
    sendJson(res, 400, { error: "Invalid github parameter" });
    return true;
  }

  // Check cache
  const cached = readmeCache.get(github);
  if (cached && Date.now() - cached.fetchedAt < README_CACHE_TTL) {
    sendJson(res, 200, { readme: cached.content });
    return true;
  }

  try {
    // Try main branch first, then master
    let content: string | null = null;
    for (const branch of ["main", "master"]) {
      const url = `https://raw.githubusercontent.com/${github}/${branch}/README.md`;
      const resp = await fetch(url);
      if (resp.ok) {
        const text = await resp.text();
        content = text.length > README_MAX_SIZE ? text.slice(0, README_MAX_SIZE) : text;
        break;
      }
    }

    if (!content) {
      sendJson(res, 404, { error: "README not found" });
      return true;
    }

    readmeCache.set(github, { content, fetchedAt: Date.now() });
    sendJson(res, 200, { readme: content });
  } catch (err) {
    logger?.error?.(`[appstore] README fetch error for ${github}: ${err}`);
    sendJson(res, 500, { error: "Failed to fetch README" });
  }
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
