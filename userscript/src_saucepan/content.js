  // ---------------------------------------------------------------------------
  // This used to be a 1200-line DOM scraper that also deobfuscated saucepan's
  // fragment format and hand-rolled PNG tEXt-chunk embedding in JS. All of that
  // now lives server-side (proxy/saucepan_fragments.py + saucepan_mapper.py +
  // cardbuilder.py), reached via POST /build-saucepan. The userscript's whole
  // job is to fetch the raw API JSON the way the page's own client does and
  // hand it to the server -- the saucepan twin of the JanitorAI bridge.
  //
  // What we fetch, per companion (mirrors what a fully-loaded profile requests):
  //   GET /api/v1/companion/definition?companion_id=<id>   -> {sections, card}
  //   GET /api/v2/companions/<id>                          -> {companion, ...}
  //   GET /api/v2/lorebooks/<lid>/chapters                 -> {chapters:[{index,title}]}
  //   GET /api/v2/lorebooks/<lid>/chapters/<index>         -> {title, text_fragments}
  // Lorebook ids aren't in the companion payload, so they're read from the
  // profile's own /lorebook/<id> links (same source the page uses).
  //
  // Macros ({{user}}/{{char}}) come back intact from these endpoints -- the
  // account-handle substitution only happens in the chat stream, which we never
  // touch -- so there is no {{user}} restoration step here anymore.
  // ---------------------------------------------------------------------------

  const TAG = "[saucepan-export]";
  const log = (...a) => console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);

  const SAUCEPAN_ORIGIN = "https://saucepan.ai";
  const SERVER = "http://127.0.0.1:8000";

  // ---------------------------------------------------------------------------
  // saucepan API auth. Every /api call needs a bearer JWT plus a constant
  // Cloudflare edge-gate header; without both the API returns 404 (not 401).
  // The JWT lives in localStorage under "hallucination/auth_token" (the sandbox
  // shares the page's localStorage). If a future build rotates the edge header,
  // requests 404 again and both name/value can be re-read from any authed /api
  // call in DevTools → Network.
  // ---------------------------------------------------------------------------
  const SAUCEPAN_EDGE_HEADER = "cf-edge-token-8af3";
  const SAUCEPAN_EDGE_TOKEN = "e3b0c44298fc1c14";

  function authHeaders() {
    let token = localStorage.getItem("hallucination/auth_token");
    if (token && token[0] === '"') {
      try {
        token = JSON.parse(token);
      } catch (e) {
        /* leave as-is */
      }
    }
    const headers = { Accept: "application/json" };
    headers[SAUCEPAN_EDGE_HEADER] = SAUCEPAN_EDGE_TOKEN;
    if (token) headers.Authorization = "Bearer " + token;
    return headers;
  }

  // GET a saucepan API path (absolute URL required by GM_xmlhttpRequest).
  function apiGet(path) {
    const url = SAUCEPAN_ORIGIN + path;
    const headers = authHeaders();
    log("GET", path, "(auth:", headers.Authorization ? "bearer" : "NONE", ")");
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url,
        headers,
        onload: (r) => {
          if (r.status >= 200 && r.status < 300) {
            try {
              resolve(JSON.parse(r.responseText));
            } catch (e) {
              reject(new Error("bad JSON from " + path));
            }
          } else {
            // 404 here usually means the auth/edge-token headers were rejected.
            warn("HTTP", r.status, "for", path, "— check bearer token + cf-edge-token");
            reject(new Error("HTTP " + r.status + " for " + path));
          }
        },
        onerror: () => reject(new Error("network error for " + path)),
      });
    });
  }

  // POST the raw export to the local jai-proxy server.
  function buildOnServer(payload) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "POST",
        url: SERVER + "/build-saucepan",
        headers: { "Content-Type": "application/json" },
        data: JSON.stringify(payload),
        timeout: 60000,
        onload: (r) => {
          if (r.status >= 200 && r.status < 300) {
            try {
              resolve(JSON.parse(r.responseText));
            } catch (e) {
              reject(new Error("bad JSON from server"));
            }
          } else {
            reject(new Error(`server HTTP ${r.status}: ${r.responseText}`));
          }
        },
        onerror: () => reject(new Error("cannot reach jai-proxy server at " + SERVER)),
        ontimeout: () => reject(new Error("server timeout")),
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Fetch the full raw export for a companion id: {id, definition, companion,
  // lorebooks}. This is exactly the shape POST /build-saucepan expects.
  // ---------------------------------------------------------------------------
  function companionIdFromUrl() {
    const m = location.pathname.match(/\/companion\/([0-9a-f-]{8,})/i);
    return m ? m[1] : null;
  }

  // Lorebook ids from the profile's own /lorebook/<id> links (the companion
  // payload doesn't carry them).
  function lorebookIds() {
    const ids = new Set();
    for (const a of document.querySelectorAll('a[href*="/lorebook/"]')) {
      const m = (a.href || "").match(/\/lorebook\/([0-9a-f-]{8,})/i);
      if (m) ids.add(m[1]);
    }
    return [...ids];
  }

  async function fetchExport(id) {
    const out = { id };
    out.definition = await apiGet(`/api/v1/companion/definition?companion_id=${id}`);
    out.companion = await apiGet(`/api/v2/companions/${id}`);

    out.lorebooks = [];
    for (const lid of lorebookIds()) {
      const list = await apiGet(`/api/v2/lorebooks/${lid}/chapters`);
      const chapters = [];
      for (const c of (list && list.chapters) || []) {
        chapters.push(await apiGet(`/api/v2/lorebooks/${lid}/chapters/${c.index}`));
      }
      out.lorebooks.push({ id: lid, list, chapters });
    }
    log(`fetched export for ${id} — lorebooks: ${out.lorebooks.length}`);
    return out;
  }

  // ---------------------------------------------------------------------------
  // UI: one floating button. Fetch → build → report. The server derives the
  // real character name from the companion JSON (companion.name), so there's no
  // name prompt.
  // ---------------------------------------------------------------------------
  async function run(setStatus) {
    const id = companionIdFromUrl();
    if (!id) {
      setStatus("Open a /companion/<id> page first", true);
      return;
    }
    setStatus("Fetching…");
    const export_ = await fetchExport(id);

    setStatus("Building on server…");
    const res = await buildOnServer({ character: export_ });
    if (res.ok) {
      const warnCount = (res.warnings || []).length;
      log("built:", res.path, "warnings:", res.warnings || []);
      setStatus(`✓ Saved${warnCount ? ` (${warnCount} warning${warnCount > 1 ? "s" : ""})` : ""}`);
    } else {
      warn("build failed:", res.warnings);
      setStatus("✗ " + ((res.warnings && res.warnings[0]) || "build failed"), true);
    }
  }

  function addButton() {
    if (document.getElementById("saucepan-export-btn")) return;
    if (!document.body) return;

    const wrap = document.createElement("div");
    Object.assign(wrap.style, {
      position: "fixed", bottom: "16px", right: "16px", zIndex: 999999,
      display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "6px",
    });

    const status = document.createElement("div");
    Object.assign(status.style, {
      font: "12px system-ui, sans-serif", color: "#fff", background: "rgba(0,0,0,.6)",
      padding: "3px 8px", borderRadius: "8px", maxWidth: "260px", display: "none",
    });
    const setStatus = (text, isError) => {
      status.textContent = text;
      status.style.display = "block";
      status.style.background = isError ? "rgba(150,30,30,.85)" : "rgba(0,0,0,.6)";
    };

    const btn = document.createElement("button");
    btn.id = "saucepan-export-btn";
    btn.textContent = "⬇ Export to card";
    Object.assign(btn.style, {
      padding: "10px 14px", borderRadius: "10px", border: "none",
      background: "#7a3db5", color: "#fff", fontWeight: "600", cursor: "pointer",
      boxShadow: "0 2px 8px rgba(0,0,0,.3)",
    });
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await run(setStatus);
      } catch (e) {
        warn(e);
        setStatus("✗ " + e.message, true);
      } finally {
        btn.disabled = false;
      }
    });

    wrap.appendChild(status);
    wrap.appendChild(btn);
    document.body.appendChild(wrap);
  }

  if (document.body) addButton();
  new MutationObserver(addButton).observe(document.documentElement, { childList: true, subtree: true });