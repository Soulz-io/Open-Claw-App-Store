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
}

// ── Constants ─────────────────────────────────────────────────────

const PREFIX = "/plugins/openclaw-appstore";
const API_PREFIX = `${PREFIX}/api/`;

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

// ── Handler factory ───────────────────────────────────────────────

export function createHttpHandler(params: HttpHandlerParams) {
  const { logger, uiRoot, pluginRoot, registryUrl, cacheTtl, pluginApi } = params;
  const bundledRegistryPath = path.join(pluginRoot, "registry.json");

  const handler = async function handler(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;

    // Only handle our prefix
    if (!pathname.startsWith(PREFIX)) return false;

    // ── API routes ────────────────────────────────────────────
    if (pathname.startsWith(API_PREFIX)) {
      const apiPath = pathname.slice(API_PREFIX.length);

      if (apiPath === "browse" && req.method === "GET") {
        return handleBrowse(req, res, url, logger, registryUrl, cacheTtl, bundledRegistryPath);
      }

      if (apiPath === "install" && req.method === "POST") {
        return handleInstall(req, res, logger);
      }

      if (apiPath.startsWith("status/") && req.method === "GET") {
        const jobId = apiPath.slice("status/".length);
        return handleStatus(res, jobId);
      }

      if (apiPath === "installed" && req.method === "GET") {
        return handleInstalled(res);
      }

      sendJson(res, 404, { error: "Not found" });
      return true;
    }

    // ── Injector script (served at PREFIX root for tab injection) ──
    const subPath = pathname.slice(PREFIX.length) || "/";

    if (subPath === "/injector.js") {
      const filePath = path.join(uiRoot, "injector.js");
      return serveFile(res, filePath);
    }

    // ── Static UI files ───────────────────────────────────────
    return serveStaticOrIndex(res, uiRoot, subPath);
  };

  // Register as HTTP handler for sub-path matching.
  // registerHttpRoute only supports exact path matching, so without this,
  // sub-paths like /api/browse, /injector.js, etc. would never be reached.
  if (pluginApi) {
    pluginApi.registerHttpHandler(handler);
  }

  return handler;
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

    // Basic validation
    if (typeof npmSpec !== "string" || npmSpec.length > 500) {
      sendJson(res, 400, { error: "Invalid npmSpec" });
      return true;
    }

    if (typeof pluginId !== "string" || pluginId.length > 100) {
      sendJson(res, 400, { error: "Invalid pluginId" });
      return true;
    }

    // Disallow suspicious specs (path traversal, etc.)
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

// ── Static file serving ───────────────────────────────────────────

function serveStaticOrIndex(
  res: ServerResponse,
  uiRoot: string,
  subPath: string,
): boolean {
  // Normalize
  let filePath: string;
  if (subPath === "/" || subPath === "") {
    filePath = path.join(uiRoot, "index.html");
  } else {
    filePath = path.join(uiRoot, subPath);
  }

  // Security: ensure path is within uiRoot
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(uiRoot))) {
    sendJson(res, 403, { error: "Forbidden" });
    return true;
  }

  // If file exists, serve it
  if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
    return serveFile(res, resolved);
  }

  // SPA fallback: if no extension, serve index.html
  const ext = path.extname(subPath);
  if (!ext) {
    const indexPath = path.join(uiRoot, "index.html");
    if (fs.existsSync(indexPath)) {
      return serveFile(res, indexPath);
    }
  }

  sendJson(res, 404, { error: "Not found" });
  return true;
}

function serveFile(res: ServerResponse, filePath: string): boolean {
  try {
    const ext = path.extname(filePath);
    const mime = MIME_TYPES[ext] || "application/octet-stream";
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { "Content-Type": mime });
    res.end(content);
    return true;
  } catch {
    sendJson(res, 404, { error: "File not found" });
    return true;
  }
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
