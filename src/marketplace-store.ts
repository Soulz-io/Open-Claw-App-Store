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
  source: "curated" | "community";
  verified: boolean;
  htmlUrl?: string;
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

interface DiscoveredRepo {
  fullName: string;
  name: string;
  description: string;
  owner: string;
  stars: number;
  lastUpdated: string;
  license?: string;
  topics: string[];
  htmlUrl: string;
}

interface DiscoveryCacheData {
  fetchedAt: number;
  allResults: DiscoveredRepo[];
  trendingResults: DiscoveredRepo[];
  trendingFetchedAt: number;
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
const GITHUB_SEARCH_API = "https://api.github.com/search/repositories";
const DEFAULT_CACHE_TTL = 30 * 60 * 1000;      // 30 minutes
const DISCOVERY_CACHE_TTL = 15 * 60 * 1000;     // 15 minutes
const TRENDING_CACHE_TTL = 10 * 60 * 1000;      // 10 minutes
const DISCOVERY_TOPIC = "openclaw-plugin";

// ── Cache file paths ─────────────────────────────────────────────

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

function getDiscoveryCachePath(): string {
  const home = process.env.HOME || "/root";
  const dir = path.join(home, ".openclaw");
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* */ }
  return path.join(dir, "appstore-discovery-cache.json");
}

// ── Disk cache (registry) ────────────────────────────────────────

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

// ── Disk cache (discovery) ───────────────────────────────────────

function readDiscoveryCache(): DiscoveryCacheData | null {
  try {
    const raw = fs.readFileSync(getDiscoveryCachePath(), "utf8");
    return JSON.parse(raw) as DiscoveryCacheData;
  } catch {
    return null;
  }
}

function writeDiscoveryCache(data: DiscoveryCacheData): void {
  try {
    fs.writeFileSync(getDiscoveryCachePath(), JSON.stringify(data, null, 2), "utf8");
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
      return { stars: -1, lastUpdated: "", fetchedAt: 0 }; // sentinel
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

// ── GitHub Discovery ──────────────────────────────────────────────

export async function discoverPlugins(
  logger?: PluginLogger,
  cacheTtl: number = DISCOVERY_CACHE_TTL,
): Promise<DiscoveredRepo[]> {
  // 1. Check cache
  const cached = readDiscoveryCache();
  if (cached?.allResults?.length) {
    const age = Date.now() - cached.fetchedAt;
    if (age < cacheTtl) {
      logger?.info?.("[appstore] Using cached discovery results");
      return cached.allResults;
    }
  }

  // 2. Fetch from GitHub Search API (paginated, up to 3 pages = 300 repos)
  const allRepos: DiscoveredRepo[] = [];
  let rateLimited = false;

  for (let page = 1; page <= 3 && !rateLimited; page++) {
    try {
      const url = `${GITHUB_SEARCH_API}?q=topic:${DISCOVERY_TOPIC}&sort=stars&order=desc&per_page=100&page=${page}`;
      logger?.info?.(`[appstore] Discovery search page ${page}`);

      const resp = await fetch(url, {
        headers: {
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "openclaw-appstore/1.0",
        },
        signal: AbortSignal.timeout(10000),
      });

      if (resp.status === 403 || resp.status === 429) {
        logger?.warn?.(`[appstore] GitHub Search API rate limited (${resp.status})`);
        rateLimited = true;
        break;
      }
      if (!resp.ok) {
        logger?.warn?.(`[appstore] GitHub Search API ${resp.status}`);
        break;
      }

      const data = await resp.json() as {
        total_count: number;
        items: Array<{
          full_name: string;
          name: string;
          description: string | null;
          owner: { login: string };
          stargazers_count: number;
          pushed_at: string;
          license: { spdx_id: string } | null;
          topics: string[];
          html_url: string;
        }>;
      };

      for (const item of data.items) {
        allRepos.push({
          fullName: item.full_name,
          name: item.name,
          description: item.description || "",
          owner: item.owner.login,
          stars: item.stargazers_count,
          lastUpdated: item.pushed_at,
          license: item.license?.spdx_id ?? undefined,
          topics: item.topics || [],
          htmlUrl: item.html_url,
        });
      }

      // Stop paginating if we got all results
      if (data.items.length < 100 || allRepos.length >= data.total_count) break;
    } catch (err) {
      logger?.warn?.(`[appstore] Discovery search page ${page} failed: ${err}`);
      break;
    }
  }

  // 3. Rate limited with no new results → stale cache
  if (rateLimited && allRepos.length === 0 && cached?.allResults?.length) {
    logger?.warn?.("[appstore] Using stale discovery cache");
    return cached.allResults;
  }

  // 4. Update cache
  if (allRepos.length > 0) {
    const existing = readDiscoveryCache();
    writeDiscoveryCache({
      fetchedAt: Date.now(),
      allResults: allRepos,
      trendingResults: existing?.trendingResults ?? [],
      trendingFetchedAt: existing?.trendingFetchedAt ?? 0,
    });
  }

  return allRepos;
}

export async function fetchTrendingPlugins(
  logger?: PluginLogger,
  cacheTtl: number = TRENDING_CACHE_TTL,
): Promise<DiscoveredRepo[]> {
  // 1. Check cache
  const cached = readDiscoveryCache();
  if (cached?.trendingResults?.length) {
    const age = Date.now() - cached.trendingFetchedAt;
    if (age < cacheTtl) {
      logger?.info?.("[appstore] Using cached trending results");
      return cached.trendingResults;
    }
  }

  // 2. Fetch: plugins pushed in last 24h, sorted by stars
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split("T")[0];
  try {
    const url = `${GITHUB_SEARCH_API}?q=topic:${DISCOVERY_TOPIC}+pushed:>=${since}&sort=stars&order=desc&per_page=10`;
    logger?.info?.(`[appstore] Fetching trending plugins (pushed >= ${since})`);

    const resp = await fetch(url, {
      headers: {
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "openclaw-appstore/1.0",
      },
      signal: AbortSignal.timeout(10000),
    });

    if (resp.status === 403 || resp.status === 429) {
      logger?.warn?.("[appstore] GitHub Search rate limited for trending");
      return cached?.trendingResults ?? [];
    }
    if (!resp.ok) {
      logger?.warn?.(`[appstore] Trending search returned ${resp.status}`);
      return cached?.trendingResults ?? [];
    }

    const data = await resp.json() as { items: Array<any> };
    const trending: DiscoveredRepo[] = data.items.slice(0, 10).map((item: any) => ({
      fullName: item.full_name,
      name: item.name,
      description: item.description || "",
      owner: item.owner.login,
      stars: item.stargazers_count,
      lastUpdated: item.pushed_at,
      license: item.license?.spdx_id ?? undefined,
      topics: item.topics || [],
      htmlUrl: item.html_url,
    }));

    // 3. Update cache
    const existing = readDiscoveryCache();
    writeDiscoveryCache({
      fetchedAt: existing?.fetchedAt ?? 0,
      allResults: existing?.allResults ?? [],
      trendingResults: trending,
      trendingFetchedAt: Date.now(),
    });

    return trending;
  } catch (err) {
    logger?.warn?.(`[appstore] Trending fetch failed: ${err}`);
    return cached?.trendingResults ?? [];
  }
}

// ── Discovery → Plugin conversion ─────────────────────────────────

const TOPIC_TO_CATEGORY: Record<string, string> = {
  channel: "channels", channels: "channels", messaging: "channels",
  monitoring: "monitoring", observability: "monitoring",
  memory: "memory", ai: "ai", llm: "ai",
  workflow: "workflow", automation: "workflow",
  auth: "auth", tools: "tools",
  integration: "integrations", integrations: "integrations",
};

function discoveredToPlugin(repo: DiscoveredRepo, installedIds: string[]): EnrichedPlugin {
  const id = repo.name.toLowerCase().replace(/[^a-z0-9-]/g, "-");

  let category = "tools";
  for (const topic of repo.topics) {
    const mapped = TOPIC_TO_CATEGORY[topic.toLowerCase()];
    if (mapped) { category = mapped; break; }
  }

  return {
    id,
    name: formatRepoName(repo.name),
    description: repo.description,
    author: repo.owner,
    github: repo.fullName,
    npmSpec: `github:${repo.fullName}`,
    category,
    tags: repo.topics.filter(t => t !== DISCOVERY_TOPIC),
    icon: "\uD83D\uDCE6", // 📦
    featured: false,
    stars: repo.stars,
    lastUpdated: repo.lastUpdated,
    license: repo.license,
    installed: installedIds.includes(id),
    source: "community",
    verified: false,
    htmlUrl: repo.htmlUrl,
  };
}

function formatRepoName(name: string): string {
  return name
    .replace(/^openclaw[-_]?/i, "")
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim() || name;
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
  source?: "all" | "curated" | "community";
  registryUrl?: string;
  cacheTtl?: number;
  bundledRegistryPath?: string;
}

export async function browsePlugins(opts: BrowseOptions = {}): Promise<EnrichedPlugin[]> {
  const {
    logger, search, category, sort = "stars",
    source = "all",
    registryUrl, cacheTtl, bundledRegistryPath,
  } = opts;

  try {
    // 1. Fetch curated registry
    const registry = await fetchRegistry(logger, registryUrl, bundledRegistryPath);

    // 2. Enrich curated with GitHub data
    let githubData: Record<string, GitHubCacheEntry> = {};
    try {
      githubData = await enrichWithGitHub(registry, logger, cacheTtl);
    } catch (err) {
      logger?.warn?.(`[appstore] GitHub enrichment failed: ${err}`);
    }

    // 3. Get installed plugins
    const installedIds = getInstalledPluginIds();

    // 4. Build curated plugins keyed by id; track github repos for dedup
    const pluginMap = new Map<string, EnrichedPlugin>();
    const curatedGithubRepos = new Set<string>();
    for (const p of registry) {
      const gh = githubData[p.github];
      pluginMap.set(p.id, {
        ...p,
        stars: gh?.stars ?? 0,
        lastUpdated: gh?.lastUpdated ?? "",
        license: gh?.license,
        installed: installedIds.includes(p.id),
        source: "curated",
        verified: true,
      });
      curatedGithubRepos.add(p.github);
    }

    // 5. Merge discovered community plugins (skip if repo already in curated)
    if (source !== "curated") {
      try {
        const discovered = await discoverPlugins(logger, cacheTtl);
        for (const repo of discovered) {
          const communityPlugin = discoveredToPlugin(repo, installedIds);
          if (!curatedGithubRepos.has(repo.fullName) && !pluginMap.has(communityPlugin.id)) {
            pluginMap.set(communityPlugin.id, communityPlugin);
          }
        }
      } catch (err) {
        logger?.warn?.(`[appstore] Discovery failed, showing curated only: ${err}`);
      }
    }

    // 6. Convert map to array
    let plugins = Array.from(pluginMap.values());

    // 7. Filter by source
    if (source === "curated") {
      plugins = plugins.filter(p => p.source === "curated");
    } else if (source === "community") {
      plugins = plugins.filter(p => p.source === "community");
    }

    // 8. Filter by search
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

    // 9. Filter by category
    if (category && category !== "all") {
      plugins = plugins.filter((p) => p.category === category);
    }

    // 10. Sort
    if (sort === "stars") {
      plugins.sort((a, b) => b.stars - a.stars);
    } else if (sort === "updated") {
      plugins.sort((a, b) => {
        const ta = a.lastUpdated ? new Date(a.lastUpdated).getTime() : 0;
        const tb = b.lastUpdated ? new Date(b.lastUpdated).getTime() : 0;
        return tb - ta;
      });
    }

    // 11. Cap at 250
    plugins = plugins.slice(0, 250);

    // 12. Update registry cache
    writeCache({ fetchedAt: Date.now(), registry, github: githubData });

    return plugins;
  } catch (err) {
    logger?.error?.(`[appstore] browsePlugins error: ${err}`);
    return [];
  }
}

// ── Trending (public function) ────────────────────────────────────

export async function getTrendingPlugins(
  logger?: PluginLogger,
  registryUrl?: string,
  bundledRegistryPath?: string,
): Promise<EnrichedPlugin[]> {
  // 1. Get registry to know which are curated
  const registry = await fetchRegistry(logger, registryUrl, bundledRegistryPath);
  const curatedMap = new Map<string, RegistryPlugin>();
  for (const p of registry) curatedMap.set(p.github, p);

  // 2. Fetch trending from GitHub
  const trending = await fetchTrendingPlugins(logger);

  // 3. Get installed IDs
  const installedIds = getInstalledPluginIds();

  // 4. Convert to EnrichedPlugin[]
  return trending.map(repo => {
    const curated = curatedMap.get(repo.fullName);
    if (curated) {
      return {
        ...curated,
        stars: repo.stars,
        lastUpdated: repo.lastUpdated,
        license: repo.license,
        installed: installedIds.includes(curated.id),
        source: "curated" as const,
        verified: true,
        htmlUrl: repo.htmlUrl,
      };
    }
    return discoveredToPlugin(repo, installedIds);
  });
}
