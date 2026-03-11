import fs from "node:fs";
import path from "node:path";

// ── Interfaces ────────────────────────────────────────────────────

export interface RegistryPlugin {
  id: string;
  name: string;
  description: string;
  author: string;
  github: string;        // "owner/repo"
  npmSpec: string;        // "github:owner/repo"
  category: string;
  tags: string[];
  icon: string;
  featured?: boolean;
}

export interface EnrichedPlugin extends RegistryPlugin {
  stars: number;
  lastUpdated: string;
  license?: string;
  installed: boolean;
}

interface CacheData {
  fetchedAt: number;
  registry: RegistryPlugin[];
  github: Record<string, GitHubCacheEntry>;
}

interface GitHubCacheEntry {
  stars: number;
  lastUpdated: string;
  license?: string;
  etag?: string;
  fetchedAt: number;
}

interface PluginLogger {
  info?: (...args: any[]) => void;
  warn?: (...args: any[]) => void;
  error?: (...args: any[]) => void;
}

// ── Constants ─────────────────────────────────────────────────────

const REGISTRY_URLS = [
  "https://cdn.jsdelivr.net/gh/Soulz-io/Open-Claw-App-Store@main/registry.json",
  "https://raw.githubusercontent.com/Soulz-io/Open-Claw-App-Store/main/registry.json",
];

const GITHUB_API = "https://api.github.com";
const DEFAULT_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

// ── Cache file path ───────────────────────────────────────────────

function getCachePath(): string {
  const home = process.env.HOME || "/root";
  const candidates = [
    path.join(home, ".openclaw"),
    "/home/.openclaw",
  ];
  for (const dir of candidates) {
    try {
      if (fs.existsSync(dir)) {
        return path.join(dir, "appstore-cache.json");
      }
    } catch { /* skip */ }
  }
  const fallback = path.join(home, ".openclaw");
  try { fs.mkdirSync(fallback, { recursive: true }); } catch { /* */ }
  return path.join(fallback, "appstore-cache.json");
}

// ── Disk cache ────────────────────────────────────────────────────

function readCache(): CacheData | null {
  try {
    const raw = fs.readFileSync(getCachePath(), "utf8");
    return JSON.parse(raw) as CacheData;
  } catch {
    return null;
  }
}

function writeCache(data: CacheData): void {
  try {
    fs.writeFileSync(getCachePath(), JSON.stringify(data, null, 2), "utf8");
  } catch { /* non-critical */ }
}

// ── Registry fetch ────────────────────────────────────────────────

export async function fetchRegistry(
  logger?: PluginLogger,
  customUrl?: string,
  bundledRegistryPath?: string,
): Promise<RegistryPlugin[]> {
  // 1. Try fresh disk cache (fast)
  const cached = readCache();
  if (cached?.registry?.length) {
    const age = Date.now() - cached.fetchedAt;
    if (age < DEFAULT_CACHE_TTL) {
      logger?.info?.("[appstore] Using cached registry");
      return cached.registry;
    }
  }

  // 2. Try remote URLs (gets latest plugins)
  const urls = customUrl ? [customUrl, ...REGISTRY_URLS] : REGISTRY_URLS;
  for (const url of urls) {
    try {
      logger?.info?.(`[appstore] Fetching registry from ${url}`);
      const resp = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) {
        logger?.warn?.(`[appstore] Registry ${url} returned ${resp.status}`);
        continue;
      }
      const data = await resp.json() as { version?: number; plugins?: RegistryPlugin[] };
      if (!Array.isArray(data.plugins)) {
        logger?.warn?.(`[appstore] Registry ${url} has no plugins array`);
        continue;
      }
      logger?.info?.(`[appstore] Loaded ${data.plugins.length} plugins from remote registry`);
      return data.plugins;
    } catch (err) {
      logger?.warn?.(`[appstore] Failed to fetch ${url}: ${err}`);
    }
  }

  // 3. Stale cache as fallback
  if (cached?.registry?.length) {
    logger?.warn?.("[appstore] Using stale cached registry");
    return cached.registry;
  }

  // 4. Bundled registry as last resort (offline/first-boot)
  if (bundledRegistryPath) {
    try {
      if (fs.existsSync(bundledRegistryPath)) {
        const raw = fs.readFileSync(bundledRegistryPath, "utf8");
        const data = JSON.parse(raw) as { plugins?: RegistryPlugin[] };
        if (Array.isArray(data.plugins) && data.plugins.length > 0) {
          logger?.info?.(`[appstore] Loaded ${data.plugins.length} plugins from bundled registry`);
          return data.plugins;
        }
      }
    } catch (err) {
      logger?.warn?.(`[appstore] Failed to read bundled registry: ${err}`);
    }
  }

  return [];
}

// ── GitHub enrichment ─────────────────────────────────────────────

async function fetchGitHubRepo(
  owner: string,
  repo: string,
  etag?: string,
  logger?: PluginLogger,
): Promise<GitHubCacheEntry | null> {
  try {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "openclaw-appstore/1.0",
    };
    if (etag) headers["If-None-Match"] = etag;

    const resp = await fetch(`${GITHUB_API}/repos/${owner}/${repo}`, {
      headers,
      signal: AbortSignal.timeout(8000),
    });

    if (resp.status === 304) return null; // Not modified
    if (resp.status === 403 || resp.status === 429) {
      logger?.warn?.(`[appstore] GitHub API rate limited (${resp.status})`);
      return { stars: -1, lastUpdated: "", fetchedAt: 0 }; // sentinel: rate limited
    }
    if (!resp.ok) {
      logger?.warn?.(`[appstore] GitHub API ${resp.status} for ${owner}/${repo}`);
      return null;
    }

    const data = await resp.json() as any;
    return {
      stars: data.stargazers_count ?? 0,
      lastUpdated: data.pushed_at ?? data.updated_at ?? "",
      license: data.license?.spdx_id ?? undefined,
      etag: resp.headers.get("etag") ?? undefined,
      fetchedAt: Date.now(),
    };
  } catch (err) {
    logger?.warn?.(`[appstore] GitHub fetch failed for ${owner}/${repo}: ${err}`);
    return null;
  }
}

export async function enrichWithGitHub(
  plugins: RegistryPlugin[],
  logger?: PluginLogger,
  cacheTtl: number = DEFAULT_CACHE_TTL,
): Promise<Record<string, GitHubCacheEntry>> {
  const cache = readCache();
  const githubCache = cache?.github ?? {};
  const results: Record<string, GitHubCacheEntry> = { ...githubCache };
  const now = Date.now();

  const toFetch = plugins.filter((p) => {
    if (!p.github) return false;
    const cached = githubCache[p.github];
    if (!cached) return true;
    return now - cached.fetchedAt > cacheTtl;
  });

  if (toFetch.length === 0) {
    logger?.info?.("[appstore] All GitHub data cached, skipping enrichment");
    return results;
  }

  logger?.info?.(`[appstore] Enriching ${toFetch.length} plugins from GitHub API`);

  let rateLimited = false;
  const BATCH_SIZE = 5;
  for (let i = 0; i < toFetch.length && !rateLimited; i += BATCH_SIZE) {
    const batch = toFetch.slice(i, i + BATCH_SIZE);
    const promises = batch.map(async (plugin) => {
      if (rateLimited) return;
      const parts = plugin.github.split("/");
      if (parts.length !== 2 || !parts[0] || !parts[1]) return;
      try {
        const entry = await fetchGitHubRepo(parts[0], parts[1], githubCache[plugin.github]?.etag, logger);
        if (entry) {
          if (entry.stars === -1 && entry.fetchedAt === 0) {
            // Rate limit sentinel — stop fetching
            rateLimited = true;
            return;
          }
          results[plugin.github] = entry;
        }
      } catch { /* skip individual failures */ }
    });
    await Promise.all(promises);
  }

  if (rateLimited) {
    logger?.warn?.("[appstore] GitHub API rate limited — using cached data for remaining plugins");
  }

  return results;
}

// ── Installed plugins detection ───────────────────────────────────

export function getInstalledPluginIds(): string[] {
  const idSet = new Set<string>();
  const home = process.env.HOME || "/root";
  const configPaths = [
    path.join(home, ".openclaw/openclaw.json"),
    "/home/.openclaw/openclaw.json",
  ];

  for (const cfgPath of configPaths) {
    try {
      if (!fs.existsSync(cfgPath)) continue;
      const raw = fs.readFileSync(cfgPath, "utf8");
      const cfg = JSON.parse(raw);
      const entries = cfg?.plugins?.entries ?? {};
      for (const [key, val] of Object.entries(entries)) {
        if ((val as any)?.enabled !== false) {
          idSet.add(key);
        }
      }
      const installs = cfg?.plugins?.installs ?? {};
      for (const key of Object.keys(installs)) {
        idSet.add(key);
      }
    } catch { /* skip */ }
  }

  try {
    const extDir = path.join(home, ".openclaw/extensions");
    if (fs.existsSync(extDir)) {
      for (const entry of fs.readdirSync(extDir)) {
        const entryPath = path.join(extDir, entry);
        try {
          if (fs.statSync(entryPath).isDirectory()) {
            const pkgPath = path.join(entryPath, "package.json");
            if (fs.existsSync(pkgPath)) {
              const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
              const id = pkg.name ? pkg.name.replace(/^@[^/]+\//, "") : entry;
              idSet.add(id);
            }
          }
        } catch { /* skip */ }
      }
    }
  } catch { /* skip */ }

  return Array.from(idSet);
}

// ── Browse (main public function) ─────────────────────────────────

export interface BrowseOptions {
  logger?: PluginLogger;
  search?: string;
  category?: string;
  sort?: "stars" | "updated";
  registryUrl?: string;
  cacheTtl?: number;
  bundledRegistryPath?: string;
}

export async function browsePlugins(opts: BrowseOptions = {}): Promise<EnrichedPlugin[]> {
  const { logger, search, category, sort = "stars", registryUrl, cacheTtl, bundledRegistryPath } = opts;

  try {
    // 1. Fetch registry
    const registry = await fetchRegistry(logger, registryUrl, bundledRegistryPath);
    if (registry.length === 0) return [];

    // 2. Enrich with GitHub data (non-blocking, best-effort)
    let githubData: Record<string, GitHubCacheEntry> = {};
    try {
      githubData = await enrichWithGitHub(registry, logger, cacheTtl);
    } catch (err) {
      logger?.warn?.(`[appstore] GitHub enrichment failed: ${err}`);
    }

    // 3. Get installed plugins
    const installedIds = getInstalledPluginIds();

    // 4. Merge into enriched plugins
    let plugins: EnrichedPlugin[] = registry.map((p) => {
      const gh = githubData[p.github];
      return {
        ...p,
        stars: gh?.stars ?? 0,
        lastUpdated: gh?.lastUpdated ?? "",
        license: gh?.license,
        installed: installedIds.includes(p.id),
      };
    });

    // 5. Filter by search
    if (search) {
      const q = search.toLowerCase();
      plugins = plugins.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.description.toLowerCase().includes(q) ||
          p.tags.some((t) => t.toLowerCase().includes(q)) ||
          p.author.toLowerCase().includes(q),
      );
    }

    // 6. Filter by category
    if (category && category !== "all") {
      plugins = plugins.filter((p) => p.category === category);
    }

    // 7. Sort
    if (sort === "stars") {
      plugins.sort((a, b) => b.stars - a.stars);
    } else if (sort === "updated") {
      plugins.sort((a, b) => {
        const ta = a.lastUpdated ? new Date(a.lastUpdated).getTime() : 0;
        const tb = b.lastUpdated ? new Date(b.lastUpdated).getTime() : 0;
        return tb - ta;
      });
    }

    // 8. Cap at 250
    plugins = plugins.slice(0, 250);

    // 9. Update cache
    writeCache({
      fetchedAt: Date.now(),
      registry,
      github: githubData,
    });

    return plugins;
  } catch (err) {
    logger?.error?.(`[appstore] browsePlugins error: ${err}`);
    return [];
  }
}
