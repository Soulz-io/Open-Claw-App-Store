(function () {
  "use strict";

  const API_BASE = "/plugins/openclaw-appstore";
  const POLL_INTERVAL = 2000;

  // ── Categories ────────────────────────────────────────────────
  const CATEGORIES = [
    { id: "all", label: "All" },
    { id: "channels", label: "Channels" },
    { id: "monitoring", label: "Monitoring" },
    { id: "ai", label: "AI" },
    { id: "tools", label: "Tools" },
    { id: "auth", label: "Auth" },
    { id: "memory", label: "Memory" },
    { id: "workflow", label: "Workflow" },
    { id: "integrations", label: "Integrations" },
  ];

  // ── State ─────────────────────────────────────────────────────
  let state = {
    view: "grid",           // "grid" | "detail"
    plugins: [],
    search: "",
    category: "all",
    sort: "stars",
    selectedPlugin: null,
    installJob: null,       // { jobId, pluginId, status, error?, message? }
    loading: true,
    error: null,
  };

  let pollTimer = null;
  let fetchController = null;  // AbortController for in-flight fetch
  let installing = false;      // double-click guard

  // ── Init ──────────────────────────────────────────────────────
  document.addEventListener("DOMContentLoaded", () => {
    fetchPlugins();
    syncTheme();
  });

  // ── Theme sync from parent ────────────────────────────────────
  function syncTheme() {
    try {
      const parent = window.parent;
      if (parent === window) return;
      const app = parent.document.querySelector("openclaw-app");
      if (!app) return;
      const root = app.shadowRoot || app;
      const style = parent.getComputedStyle(root);
      const vars = ["--bg", "--bg-card", "--text", "--accent", "--border", "--bg-hover"];
      vars.forEach((v) => {
        const val = style.getPropertyValue(v).trim();
        if (val) document.documentElement.style.setProperty(v, val);
      });
    } catch { /* cross-origin */ }
  }

  // ── Data fetching ─────────────────────────────────────────────
  async function fetchPlugins() {
    // Abort any in-flight fetch to prevent stale data race
    if (fetchController) {
      fetchController.abort();
    }
    fetchController = new AbortController();
    const signal = fetchController.signal;

    state.loading = true;
    state.error = null;
    render();

    try {
      const params = new URLSearchParams({ sort: state.sort });
      if (state.search) params.set("search", state.search);
      if (state.category !== "all") params.set("category", state.category);

      params.set("_api", "browse");
      const res = await fetch(`${API_BASE}?${params}`, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      state.plugins = data.plugins || [];
    } catch (err) {
      if (err.name === "AbortError") return; // superseded by newer fetch
      state.error = `Failed to load plugins: ${err.message}`;
      state.plugins = [];
    }

    state.loading = false;
    render();
  }

  async function requestInstall(plugin) {
    state.installJob = {
      jobId: null,
      pluginId: plugin.id,
      status: "confirming",
    };
    installing = false; // reset guard on new request
    render();
  }

  async function confirmInstall(plugin) {
    // Double-click guard
    if (installing) return;
    installing = true;

    state.installJob = {
      ...state.installJob,
      status: "installing",
    };
    render();

    try {
      const res = await fetch(`${API_BASE}?_api=install`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          npmSpec: plugin.npmSpec,
          pluginId: plugin.id,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      state.installJob = {
        ...state.installJob,
        jobId: data.jobId,
        status: "installing",
      };
      render();
      startInstallPoll(data.jobId);
    } catch (err) {
      installing = false;
      state.installJob = {
        ...state.installJob,
        status: "error",
        error: err.message,
      };
      render();
    }
  }

  function startInstallPoll(jobId) {
    stopInstallPoll();
    pollTimer = setInterval(async () => {
      try {
        const res = await fetch(`${API_BASE}?_api=status&jobId=${encodeURIComponent(jobId)}`);
        if (!res.ok) return;
        const data = await res.json();
        if (data.status === "done" || data.status === "error") {
          stopInstallPoll();
          installing = false;
          state.installJob = {
            ...state.installJob,
            status: data.status,
            error: data.error,
            message: data.message,
          };
          // Update plugin installed status
          if (data.status === "done") {
            const p = state.plugins.find((x) => x.id === state.installJob.pluginId);
            if (p) p.installed = true;
          }
          render();
        }
      } catch { /* retry */ }
    }, POLL_INTERVAL);
  }

  function stopInstallPoll() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function closeInstallJob() {
    stopInstallPoll();
    installing = false;
    state.installJob = null;
    render();
  }

  function selectPlugin(plugin) {
    state.view = "detail";
    state.selectedPlugin = plugin;
    state.installJob = null;
    installing = false;
    render();
  }

  function backToGrid() {
    state.view = "grid";
    state.selectedPlugin = null;
    state.installJob = null;
    installing = false;
    stopInstallPoll();
    render();
  }

  // ── Search / filter handlers ──────────────────────────────────
  let searchDebounce = null;
  function onSearch(e) {
    const val = e.target.value;
    state.search = val;
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(fetchPlugins, 350);
  }

  function setCategory(cat) {
    state.category = cat;
    fetchPlugins();
  }

  function setSort(sort) {
    state.sort = sort;
    fetchPlugins();
  }

  // ── HTML helpers ──────────────────────────────────────────────
  function esc(str) {
    const d = document.createElement("div");
    d.textContent = str || "";
    return d.innerHTML;
  }

  function timeAgo(dateStr) {
    if (!dateStr) return "";
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 30) return `${days}d ago`;
    const months = Math.floor(days / 30);
    return `${months}mo ago`;
  }

  function formatStars(n) {
    if (!n) return "0";
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
  }

  // ── Render ────────────────────────────────────────────────────
  function render() {
    const app = document.getElementById("app");
    if (!app) return;

    // Save focus state for search input
    const activeEl = document.activeElement;
    const searchHadFocus = activeEl && activeEl.id === "search-input";
    const selStart = searchHadFocus ? activeEl.selectionStart : null;
    const selEnd = searchHadFocus ? activeEl.selectionEnd : null;

    if (state.view === "detail" && state.selectedPlugin) {
      app.innerHTML = renderDetail(state.selectedPlugin);
      bindDetailEvents();
    } else {
      app.innerHTML = renderGrid();
      bindGridEvents();

      // Restore search input focus
      if (searchHadFocus) {
        const input = document.getElementById("search-input");
        if (input) {
          input.focus();
          if (selStart !== null) {
            input.setSelectionRange(selStart, selEnd);
          }
        }
      }
    }
  }

  // ── Grid view ─────────────────────────────────────────────────
  function renderGrid() {
    const filtersHtml = CATEGORIES.map(
      (c) =>
        `<button class="filter-pill ${state.category === c.id ? "filter-pill--active" : ""}" data-cat="${esc(c.id)}">${esc(c.label)}</button>`,
    ).join("");

    let contentHtml;
    if (state.loading) {
      contentHtml = `<div class="skeleton-grid">
        ${Array(6).fill('<div class="skeleton-card"></div>').join("")}
      </div>`;
    } else if (state.error) {
      contentHtml = `<div class="empty">
        <div class="empty__icon">!</div>
        <div class="empty__text">${esc(state.error)}</div>
        <div class="empty__hint"><button class="btn btn--ghost" id="retry-btn">Retry</button></div>
      </div>`;
    } else if (state.plugins.length === 0) {
      contentHtml = `<div class="empty">
        <div class="empty__icon">&#128270;</div>
        <div class="empty__text">No plugins found</div>
        <div class="empty__hint">${state.search ? "Try a different search term" : "Check back later for new plugins"}</div>
      </div>`;
    } else {
      const total = state.plugins.length;
      const installed = state.plugins.filter((p) => p.installed).length;

      contentHtml = `
        <div class="stats-row">
          <div class="stats-row__item"><span class="stats-row__value">${total}</span> plugins</div>
          <div class="stats-row__item"><span class="stats-row__value">${installed}</span> installed</div>
        </div>
        <div class="plugin-grid">
          ${state.plugins.map(renderPluginCard).join("")}
        </div>`;
    }

    return `
      <div class="header">
        <h1 class="header__title">App Market</h1>
        <div class="header__search">
          <input type="text" class="search-input" placeholder="Search plugins..." value="${esc(state.search)}" id="search-input" />
        </div>
      </div>
      <div class="filters">
        ${filtersHtml}
        <div class="filter-sep"></div>
        <select class="sort-select" id="sort-select">
          <option value="stars" ${state.sort === "stars" ? "selected" : ""}>Most Stars</option>
          <option value="updated" ${state.sort === "updated" ? "selected" : ""}>Recently Updated</option>
        </select>
      </div>
      ${contentHtml}`;
  }

  function renderPluginCard(plugin) {
    const statusBadge = plugin.installed
      ? `<span class="install-badge install-badge--installed">Installed</span>`
      : `<span class="install-badge install-badge--available">Available</span>`;

    return `
      <div class="plugin-card ${plugin.featured ? "plugin-card--featured" : ""}" data-plugin-id="${esc(plugin.id)}">
        <div class="plugin-card__header">
          <div class="plugin-card__icon">${esc(plugin.icon || "\ud83d\udce6")}</div>
          <div class="plugin-card__info">
            <div class="plugin-card__name">${esc(plugin.name)}</div>
            <div class="plugin-card__author">by ${esc(plugin.author)}</div>
          </div>
        </div>
        <div class="plugin-card__desc">${esc(plugin.description)}</div>
        <div class="plugin-card__footer">
          <span class="plugin-card__stars">${plugin.stars ? "&#9733; " + formatStars(plugin.stars) : ""}</span>
          ${plugin.featured ? '<span class="featured-badge">Featured</span>' : ""}
          ${statusBadge}
        </div>
      </div>`;
  }

  // ── Detail view ───────────────────────────────────────────────
  function renderDetail(plugin) {
    const metaParts = [];
    if (plugin.author) metaParts.push(`by ${esc(plugin.author)}`);
    if (plugin.license) metaParts.push(esc(plugin.license));
    if (plugin.lastUpdated) metaParts.push(`Updated ${timeAgo(plugin.lastUpdated)}`);

    const tagsHtml = (plugin.tags || []).map(
      (t) => `<span class="detail-tag">${esc(t)}</span>`,
    ).join("");

    let actionHtml;
    if (state.installJob) {
      actionHtml = renderInstallState(plugin);
    } else if (plugin.installed) {
      actionHtml = `<div class="confirm-box">
        <div class="confirm-box__title">&#9989; Already Installed</div>
        <p style="font-size:0.85rem;color:var(--text-dim);">This plugin is already installed and active on your OpenClaw instance.</p>
      </div>`;
    } else {
      actionHtml = `
        <div class="confirm-box">
          <div class="confirm-box__title">&#128230; Install this plugin</div>
          <ul class="confirm-box__list">
            <li>Download from GitHub (${esc(plugin.github)})</li>
            <li>Install to ~/.openclaw/extensions/</li>
            <li>Add plugin entry to openclaw config</li>
            <li>Gateway restart required to activate</li>
          </ul>
          <div class="confirm-box__actions">
            <button class="btn btn--success" id="install-btn">Install Plugin</button>
          </div>
        </div>`;
    }

    return `
      <button class="detail-panel__back" id="back-btn">&#8592; Back to App Market</button>
      <div class="detail-header">
        <div class="detail-header__icon">${esc(plugin.icon || "\ud83d\udce6")}</div>
        <div class="detail-header__info">
          <div class="detail-header__name">${esc(plugin.name)}</div>
          <div class="detail-header__meta">${metaParts.join(" &middot; ")}</div>
        </div>
        <div class="detail-header__stars">${plugin.stars ? "&#9733; " + formatStars(plugin.stars) : ""}</div>
      </div>
      <div class="detail-desc">${esc(plugin.description)}</div>
      ${tagsHtml ? `<div class="detail-tags">${tagsHtml}</div>` : ""}
      <div class="detail-links">
        <a href="https://github.com/${esc(plugin.github)}" target="_blank" rel="noopener">&#128279; View on GitHub</a>
      </div>
      ${actionHtml}`;
  }

  function renderInstallState(plugin) {
    const job = state.installJob;

    if (job.status === "confirming") {
      return `
        <div class="confirm-box">
          <div class="confirm-box__title">&#128230; Confirm Installation</div>
          <ul class="confirm-box__list">
            <li>Download from GitHub (${esc(plugin.github)})</li>
            <li>Install to ~/.openclaw/extensions/${esc(plugin.id)}/</li>
            <li>Add plugin configuration to your openclaw.json</li>
            <li>You will need to restart the gateway to activate</li>
          </ul>
          <div class="confirm-box__actions">
            <button class="btn btn--ghost" id="cancel-install-btn">Cancel</button>
            <button class="btn btn--success" id="confirm-install-btn">Confirm &amp; Install</button>
          </div>
        </div>`;
    }

    if (job.status === "installing") {
      return `
        <div class="confirm-box">
          <div class="install-progress">
            <div class="install-progress__spinner"></div>
            <div class="install-progress__text">Installing ${esc(plugin.name)}...</div>
            <div style="font-size:0.78rem;color:var(--text-dim);">Downloading and setting up the plugin. This may take a moment.</div>
          </div>
        </div>`;
    }

    if (job.status === "done") {
      return `
        <div class="confirm-box">
          <div class="result-box">
            <div class="result-box__icon">&#9989;</div>
            <div class="result-box__title">Installed Successfully!</div>
            <div class="result-box__msg">${esc(plugin.name)} has been installed.</div>
            <div class="result-box__msg">Restart the gateway to activate:</div>
            <div class="result-box__cmd">openclaw gateway restart</div>
            <div class="result-box__actions">
              <button class="btn btn--primary" id="close-result-btn">Done</button>
            </div>
          </div>
        </div>`;
    }

    if (job.status === "error") {
      return `
        <div class="confirm-box">
          <div class="result-box">
            <div class="result-box__icon">&#10060;</div>
            <div class="result-box__title">Installation Failed</div>
            <div class="result-box__error">${esc(job.error || "Unknown error")}</div>
            <div class="result-box__msg">No changes were made to your system.</div>
            <div class="result-box__actions">
              <button class="btn btn--ghost" id="close-result-btn">Close</button>
              <button class="btn btn--primary" id="retry-install-btn">Try Again</button>
            </div>
          </div>
        </div>`;
    }

    return "";
  }

  // ── Event binding ─────────────────────────────────────────────
  function bindGridEvents() {
    // Search
    const searchInput = document.getElementById("search-input");
    if (searchInput) searchInput.addEventListener("input", onSearch);

    // Sort
    const sortSelect = document.getElementById("sort-select");
    if (sortSelect) sortSelect.addEventListener("change", (e) => setSort(e.target.value));

    // Category filters
    document.querySelectorAll("[data-cat]").forEach((el) => {
      el.addEventListener("click", () => setCategory(el.dataset.cat));
    });

    // Plugin cards
    document.querySelectorAll("[data-plugin-id]").forEach((el) => {
      el.addEventListener("click", () => {
        const plugin = state.plugins.find((p) => p.id === el.dataset.pluginId);
        if (plugin) selectPlugin(plugin);
      });
    });

    // Retry
    const retryBtn = document.getElementById("retry-btn");
    if (retryBtn) retryBtn.addEventListener("click", fetchPlugins);
  }

  function bindDetailEvents() {
    const backBtn = document.getElementById("back-btn");
    if (backBtn) backBtn.addEventListener("click", backToGrid);

    const installBtn = document.getElementById("install-btn");
    if (installBtn) {
      installBtn.addEventListener("click", () => requestInstall(state.selectedPlugin));
    }

    const cancelBtn = document.getElementById("cancel-install-btn");
    if (cancelBtn) cancelBtn.addEventListener("click", closeInstallJob);

    const confirmBtn = document.getElementById("confirm-install-btn");
    if (confirmBtn) {
      confirmBtn.addEventListener("click", () => confirmInstall(state.selectedPlugin));
    }

    const closeBtn = document.getElementById("close-result-btn");
    if (closeBtn) closeBtn.addEventListener("click", closeInstallJob);

    const retryBtn = document.getElementById("retry-install-btn");
    if (retryBtn) {
      retryBtn.addEventListener("click", () => {
        closeInstallJob();
        requestInstall(state.selectedPlugin);
      });
    }
  }

  // Visibility-based cleanup + resume
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopInstallPoll();
    } else {
      // Resume polling if an install is in progress
      if (state.installJob && state.installJob.jobId && state.installJob.status === "installing") {
        startInstallPoll(state.installJob.jobId);
      }
    }
  });
})();
