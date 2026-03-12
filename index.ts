import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createHttpHandler } from "./src/http-handler.js";

const plugin = {
  id: "openclaw-appstore",
  name: "App Market",
  description:
    "Browse and install OpenClaw plugins from GitHub with one click.",

  register(api: OpenClawPluginApi) {
    const pluginRoot = path.dirname(
      typeof __filename !== "undefined"
        ? __filename
        : new URL(import.meta.url).pathname,
    );
    const uiRoot = path.resolve(pluginRoot, "ui");

    // ── Plugin config ───────────────────────────────────────────
    const pluginCfg = (api.pluginConfig || {}) as Record<string, unknown>;
    const registryUrl = (pluginCfg.registryUrl as string) || undefined;
    const cacheTtl = (pluginCfg.cacheTtlMs as number) || undefined;

    // ── HTTP routes ────────────────────────────────────────────────
    // Gateway only supports exact-path matching, so we register:
    // 1. Base path → self-contained HTML bundle + API via ?_api= params
    // 2. Injector script → loaded by Control UI <script> tag
    api.registerHttpRoute({
      path: "/plugins/openclaw-appstore",
      auth: "plugin",
      handler: createHttpHandler({
        logger: api.logger,
        uiRoot,
        pluginRoot,
        registryUrl,
        cacheTtl,
        pluginApi: api,
      }),
    });

    const injectorPath = path.join(uiRoot, "injector.js");
    api.registerHttpRoute({
      path: "/plugins/openclaw-appstore/injector.js",
      auth: "plugin",
      handler: async (_req, res) => {
        try {
          const content = fs.readFileSync(injectorPath, "utf8");
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/javascript; charset=utf-8");
          res.end(content);
        } catch {
          res.statusCode = 404;
          res.end("Not found");
        }
        return true;
      },
    });

    // ── Inject App Market tab into Control UI ─────────────────────
    setupControlUiPatchAppstore({ api });

    api.logger.info("App Market plugin registered");
  },
};

export default plugin;

// ── On-disk Control UI patching ──────────────────────────────────────

const APPSTORE_TAG =
  '<script src="/plugins/openclaw-appstore/injector.js" defer></script>';

function setupControlUiPatchAppstore(params: { api: OpenClawPluginApi }): void {
  const { api } = params;
  const logger = api.logger;
  const config = api.config as Record<string, any>;

  try {
    const controlUiRoot = resolveControlUiRootAppstore(config);
    if (!controlUiRoot) {
      logger.warn(
        "[openclaw-appstore] Could not locate control-ui; tab injection skipped.",
      );
      return;
    }

    const indexPath = path.join(controlUiRoot, "index.html");
    logger.info(`[openclaw-appstore] Control-ui root: ${controlUiRoot}`);

    const html = fs.readFileSync(indexPath, "utf8");

    if (html.includes("openclaw-appstore/injector.js")) {
      logger.info("[openclaw-appstore] Injector tag already present.");
      return;
    }

    const patched = html.replace("</body>", `    ${APPSTORE_TAG}\n  </body>`);
    fs.writeFileSync(indexPath, patched, "utf8");
    logger.info(`[openclaw-appstore] Injected tab script into ${indexPath}`);
  } catch (err) {
    logger.warn(`[openclaw-appstore] Failed to patch control-ui: ${err}`);
  }
}

function resolveControlUiRootAppstore(
  config?: Record<string, any>,
): string | null {
  const configRoot = config?.gateway?.controlUi?.root;
  if (typeof configRoot === "string" && configRoot.trim()) {
    const resolved = path.resolve(configRoot.trim());
    const idx = path.join(resolved, "index.html");
    if (fs.existsSync(idx)) return resolved;
  }

  try {
    const require_ = createRequire(import.meta.url);
    const openclawMain = require_.resolve("openclaw");
    const openclawDir = path.dirname(openclawMain);
    for (const rel of [
      "control-ui",
      "../control-ui",
      "dist/control-ui",
      "../dist/control-ui",
    ]) {
      const dir = path.join(openclawDir, rel);
      if (fs.existsSync(path.join(dir, "index.html"))) return dir;
    }
  } catch { /* */ }

  const candidates: string[] = [];
  if (process.env.NVM_BIN) {
    candidates.push(
      path.resolve(process.env.NVM_BIN, "../lib/node_modules/openclaw/dist/control-ui"),
    );
  }
  const home = process.env.HOME || "/root";
  try {
    const nvmDir = path.join(home, ".nvm/versions/node");
    if (fs.existsSync(nvmDir)) {
      for (const v of fs.readdirSync(nvmDir)) {
        candidates.push(path.join(nvmDir, v, "lib/node_modules/openclaw/dist/control-ui"));
      }
    }
  } catch { /* */ }
  candidates.push("/usr/lib/node_modules/openclaw/dist/control-ui");
  candidates.push(path.resolve(process.cwd(), "node_modules/openclaw/dist/control-ui"));

  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, "index.html"))) return dir;
    } catch { /* */ }
  }
  return null;
}
