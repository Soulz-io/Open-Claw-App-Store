/**
 * App Store — Tab Injector for OpenClaw Control UI
 *
 * Injects an "App Store" tab into the Control UI sidebar (Shadow DOM).
 * Uses MutationObserver on childList only (NO attributes) to avoid
 * infinite mutation loops that freeze the page.
 */
(function () {
  "use strict";

  const PLUGIN_URL = "/plugins/openclaw-appstore/";
  const TAB_HASH = "#/appstore";
  const INJECT_ATTR = "data-appstore-dash";

  const ICON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>`;

  let active = false;
  let iframeBox = null;
  let mutationPending = false;
  let _root = null;

  function getRoot(app) {
    return app.shadowRoot || app;
  }

  function waitForApp(cb) {
    let n = 0;
    const poll = () => {
      n++;
      const app = document.querySelector("openclaw-app");
      if (!app) { if (n < 200) setTimeout(poll, 50); return; }
      const root = getRoot(app);
      const nav = root.querySelector("aside.nav, aside, .nav");
      if (nav) cb(app, root, nav);
      else if (n < 200) setTimeout(poll, 50);
    };
    poll();
  }

  function injectTab(nav) {
    if (nav.querySelector(`[${INJECT_ATTR}]`)) return;

    // Check if there's already a plugin nav-group we can add to (e.g., from subagents)
    const existingPluginGroup = nav.querySelector("[data-subagents-dash]");
    if (existingPluginGroup) {
      // Add our tab to the existing group's items container
      const groupEl = existingPluginGroup.closest(".nav-group") || existingPluginGroup;
      const itemsContainer = groupEl.querySelector(".nav-group__items");
      if (itemsContainer) {
        const tab = createTabElement();
        itemsContainer.appendChild(tab);
        tab.addEventListener("click", onTabClick);
        return;
      }
    }

    // Otherwise, create our own nav-group
    const group = document.createElement("div");
    group.className = "nav-group";
    group.setAttribute(INJECT_ATTR, "");
    group.innerHTML = `
      <button class="nav-label" aria-expanded="true">
        <span class="nav-label__text">Apps</span>
        <span class="nav-label__chevron">\u2212</span>
      </button>
      <div class="nav-group__items">
        <a href="${TAB_HASH}" class="nav-item" title="App Store"
           data-appstore-tab ${INJECT_ATTR}>
          <span class="nav-item__icon" aria-hidden="true">${ICON_SVG}</span>
          <span class="nav-item__text">App Store</span>
        </a>
      </div>`;

    const links = nav.querySelector(".nav-group--links");
    if (links) nav.insertBefore(group, links);
    else nav.appendChild(group);

    // Collapse toggle
    const label = group.querySelector(".nav-label");
    const chevron = group.querySelector(".nav-label__chevron");
    const items = group.querySelector(".nav-group__items");
    label.addEventListener("click", (e) => {
      e.stopPropagation();
      const collapsed = items.style.display === "none";
      items.style.display = collapsed ? "" : "none";
      chevron.textContent = collapsed ? "\u2212" : "+";
    });

    // Tab click
    group.querySelector("[data-appstore-tab]").addEventListener("click", onTabClick);
  }

  function createTabElement() {
    const tab = document.createElement("a");
    tab.href = TAB_HASH;
    tab.className = "nav-item";
    tab.title = "App Store";
    tab.setAttribute("data-appstore-tab", "");
    tab.setAttribute(INJECT_ATTR, "");
    tab.innerHTML = `
      <span class="nav-item__icon" aria-hidden="true">${ICON_SVG}</span>
      <span class="nav-item__text">App Store</span>`;
    return tab;
  }

  function onTabClick(e) {
    e.preventDefault();
    e.stopPropagation();
    activate();
  }

  function ensureIframe() {
    if (iframeBox || !_root) return;
    const main = _root.querySelector("main.content, main, .content");
    if (!main) return;

    iframeBox = document.createElement("div");
    iframeBox.setAttribute(INJECT_ATTR, "iframe");
    iframeBox.style.cssText =
      "display:none;position:absolute;inset:0;z-index:50;background:var(--bg,#12141a);";

    const iframe = document.createElement("iframe");
    iframe.src = PLUGIN_URL;
    iframe.style.cssText = "width:100%;height:100%;border:none;background:var(--bg,#12141a);";
    iframe.setAttribute("allow", "clipboard-write");
    iframe.setAttribute("title", "App Store");
    iframeBox.appendChild(iframe);

    if (window.getComputedStyle(main).position === "static") {
      main.style.position = "relative";
    }
    main.appendChild(iframeBox);
  }

  function activate() {
    if (active || !_root) return;
    active = true;
    ensureIframe();

    const main = _root.querySelector("main.content, main, .content");
    if (main) {
      for (const ch of main.children) {
        if (ch.getAttribute(INJECT_ATTR) === "iframe") ch.style.display = "block";
        else { ch.dataset._appstorePrev = ch.style.display; ch.style.display = "none"; }
      }
    }

    const nav = _root.querySelector("aside.nav, aside, .nav");
    if (nav) {
      nav.querySelectorAll(".nav-item").forEach((el) => {
        if (el.hasAttribute(INJECT_ATTR)) el.classList.add("active");
        else el.classList.remove("active");
      });
    }
    if (location.hash !== TAB_HASH) {
      history.pushState(null, "", TAB_HASH);
    }
  }

  function deactivate() {
    if (!active || !_root) return;
    active = false;
    if (iframeBox) iframeBox.style.display = "none";

    const main = _root.querySelector("main.content, main, .content");
    if (main) {
      for (const ch of main.children) {
        if (ch.getAttribute(INJECT_ATTR) !== "iframe" && ch.dataset._appstorePrev !== undefined) {
          ch.style.display = ch.dataset._appstorePrev;
          delete ch.dataset._appstorePrev;
        }
      }
    }
    const tab = _root.querySelector("[data-appstore-tab]");
    if (tab) tab.classList.remove("active");
  }

  waitForApp(function (app, root, nav) {
    _root = root;
    injectTab(nav);

    // Observe nav only, childList only — no attributes to avoid infinite loops
    const observer = new MutationObserver(() => {
      if (mutationPending) return;
      mutationPending = true;
      requestAnimationFrame(() => {
        mutationPending = false;
        const cur = root.querySelector("aside.nav, aside, .nav");
        if (!cur) return;
        if (!cur.querySelector(`[${INJECT_ATTR}]`)) injectTab(cur);
        if (active) {
          const other = cur.querySelector(".nav-item.active:not([data-appstore-tab])");
          if (other) deactivate();
        }
      });
    });
    observer.observe(nav, { childList: true, subtree: true });

    // Watch for nav replacement by Lit (single observer, reused)
    const navParent = nav.parentElement;
    if (navParent) {
      const parentObserver = new MutationObserver(() => {
        const newNav = root.querySelector("aside.nav, aside, .nav");
        if (newNav && !newNav.querySelector(`[${INJECT_ATTR}]`)) {
          injectTab(newNav);
          observer.disconnect();
          observer.observe(newNav, { childList: true, subtree: true });
        }
      });
      parentObserver.observe(navParent, { childList: true });
    }

    if (typeof app.setTab === "function") {
      const orig = app.setTab.bind(app);
      app.setTab = function (t) { deactivate(); return orig(t); };
    }

    window.addEventListener("popstate", () => {
      if (location.hash === TAB_HASH) activate();
      else if (active) deactivate();
    });

    if (location.hash === TAB_HASH) setTimeout(activate, 150);
  });
})();
