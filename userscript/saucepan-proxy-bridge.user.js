// ==UserScript==
// @name         saucepan-proxy bridge
// @namespace    https://github.com/EnchantedRobot/jai-proxy
// @version      0.8.0
// @description  Thin bridge: exports a Saucepan companion as a V3 card PNG via Saucepan's clean JSON API (no DOM scraping) and shows a local jai-proxy connection pill. Card assembly lives server-side.
// @match        https://saucepan.ai/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      saucepan.ai
// @connect      127.0.0.1
// @connect      localhost
// ==/UserScript==
//
// SOURCE LAYOUT — this file is COMPILED. Do not edit saucepan-proxy-bridge.user.js
// by hand; edit userscript/src_saucepan/*.js and run `make compile` (see
// scripts/compile_userscript_saucepan.py). The modules are concatenated, in
// order, inside a single IIFE beneath this banner.

(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // Config + logging. The saucepan bridge is the twin of the JanitorAI bridge:
  // it fetches a companion straight from saucepan's own JSON API and hands the
  // raw export to the local jai-proxy server (POST /build-saucepan), which does
  // all the deobfuscation / mapping / PNG assembly. (That whole pipeline used to
  // be a 1200-line in-page DOM scraper; it now lives server-side in
  // proxy/saucepan_fragments.py + saucepan_mapper.py + cardbuilder.py.)
  // ---------------------------------------------------------------------------
  const SERVER = "http://127.0.0.1:8000";
  const SAUCEPAN_ORIGIN = "https://saucepan.ai";

  const TAG = "[saucepan-export]";
  const log = (...a) => console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);

  // ---------------------------------------------------------------------------
  // ServerClient — all traffic to the local jai-proxy server goes via
  // GM_xmlhttpRequest so it's exempt from the page's CSP / mixed-content rules.
  // `/health` drives the connection pill; `/build-saucepan` turns a raw export
  // into a saved PNG card server-side.
  // ---------------------------------------------------------------------------
  const ServerClient = {
    _request(opts) {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: opts.method || "GET",
          url: SERVER + opts.path,
          headers: { "Content-Type": "application/json" },
          data: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
          timeout: opts.timeout || 15000,
          onload: (r) => {
            if (r.status >= 200 && r.status < 300) {
              resolve({ status: r.status, text: r.responseText });
            } else {
              reject(new Error(`HTTP ${r.status}: ${r.responseText}`));
            }
          },
          onerror: () => reject(new Error("cannot reach jai-proxy server at " + SERVER)),
          ontimeout: () => reject(new Error("server timeout")),
        });
      });
    },

    async health() {
      const { text } = await this._request({ path: "/health" });
      return JSON.parse(text);
    },

    async build(payload) {
      const { text } = await this._request({
        method: "POST",
        path: "/build-saucepan",
        body: payload,
        timeout: 60000,
      });
      return JSON.parse(text);
    },
  };

  // ---------------------------------------------------------------------------
  // SaucepanClient — reads a companion (and its lorebooks) straight from
  // saucepan's own JSON API, the way the page's own client does.
  //
  //   GET /api/v1/companion/definition?companion_id=<id>  -> {sections, card}
  //   GET /api/v2/companions/<id>                          -> {companion, ...}
  //   GET /api/v2/lorebooks/<lid>/chapters                 -> {chapters:[{index,title}]}
  //   GET /api/v2/lorebooks/<lid>/chapters/<index>         -> {title, text_fragments}
  // Lorebook ids aren't in the companion payload, so they're read from the
  // profile's own /lorebook/<id> links (same source the page uses).
  //
  // Macros ({{user}}/{{char}}) come back intact from these endpoints -- the
  // account-handle substitution only happens in the chat stream, which we never
  // touch -- so there is no {{user}} restoration step here.
  // ---------------------------------------------------------------------------

  // saucepan API auth. Every /api call needs a bearer JWT plus a constant
  // Cloudflare edge-gate header; without both the API returns 404 (not 401).
  // The JWT lives in localStorage under "hallucination/auth_token" (the sandbox
  // shares the page's localStorage). If a future build rotates the edge header,
  // requests 404 again and both name/value can be re-read from any authed /api
  // call in DevTools → Network.
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

  const SaucepanClient = {
    // The companion id from a /companion/<id> path.
    companionIdFromUrl() {
      const m = location.pathname.match(/\/companion\/([0-9a-f-]{8,})/i);
      return m ? m[1] : null;
    },

    // Lorebook ids from the profile's own /lorebook/<id> links (the companion
    // payload doesn't carry them).
    lorebookIds() {
      const ids = new Set();
      for (const a of document.querySelectorAll('a[href*="/lorebook/"]')) {
        const m = (a.href || "").match(/\/lorebook\/([0-9a-f-]{8,})/i);
        if (m) ids.add(m[1]);
      }
      return [...ids];
    },

    // The `/api/v2/companions/<id>` response: {companion:{...}, is_favorited, …}.
    async fetchCompanion(id) {
      return apiGet(`/api/v2/companions/${id}`);
    },

    // Whether a companion's definition is HIDDEN. `open_definition` (on the
    // inner companion object) is saucepan's own flag — the same one the "Definition:
    // Hidden" badge renders from, and the one the server's is_open() reads. A
    // hidden card's /api/v1/companion/definition returns a decoy error instead
    // of real sections, and this bridge has no chat-capture path, so a hidden
    // companion can only export its public blurb (server warns "not open").
    isHidden(v2) {
      const inner = v2 && v2.companion;
      return !!inner && inner.open_definition === false;
    },

    // The full raw export for a companion id: {id, definition, companion,
    // lorebooks}. Exactly the shape POST /build-saucepan expects.
    //
    // onProgress(p) is called as fetching advances, so the overlay can show a
    // live count instead of a static "Fetching…". It fires with one of:
    //   {phase:"definition"} | {phase:"companion"} | {phase:"lore", done, total}
    // Chapters are still fetched one at a time (a steady serial trickle, the
    // same request pattern the page itself makes) rather than in a burst, to
    // stay well under any saucepan rate limit — the count just makes the wait
    // legible, it isn't a speed-up.
    async fetchExport(id, onProgress) {
      const report = typeof onProgress === "function" ? onProgress : () => {};
      const out = { id };

      report({ phase: "definition" });
      out.definition = await apiGet(`/api/v1/companion/definition?companion_id=${id}`);

      report({ phase: "companion" });
      out.companion = await this.fetchCompanion(id);

      // Read every lorebook's chapter LIST first (one cheap call each). These
      // carry the chapter counts, so summing them gives a real denominator for
      // the progress count before any chapter body is fetched.
      const books = [];
      let total = 0;
      for (const lid of this.lorebookIds()) {
        const list = await apiGet(`/api/v2/lorebooks/${lid}/chapters`);
        const chapters = (list && list.chapters) || [];
        books.push({ id: lid, list, chapters });
        total += chapters.length;
      }

      // Now fetch the chapter bodies, reporting "done / total" as each lands.
      out.lorebooks = [];
      let done = 0;
      for (const book of books) {
        const chapters = [];
        for (const c of book.chapters) {
          chapters.push(await apiGet(`/api/v2/lorebooks/${book.id}/chapters/${c.index}`));
          done += 1;
          report({ phase: "lore", done, total });
        }
        out.lorebooks.push({ id: book.id, list: book.list, chapters });
      }
      log(`fetched export for ${id} — lorebooks: ${out.lorebooks.length}`);
      return out;
    },
  };

  // ---------------------------------------------------------------------------
  // Export — fetch the companion's raw JSON export and hand it to the server
  // (POST /build-saucepan), which does the deobfuscation / mapping / PNG build.
  // The server derives the real character name from the companion JSON
  // (companion.name), so there's no name prompt. Progress lands in the status
  // line above the button (ExportStatus), mirroring the JanitorAI bridge.
  // ---------------------------------------------------------------------------
  async function exportCompanion() {
    const btn = ExportButton._el;
    btn.disabled = true;
    ExportStatus.show("Fetching…");
    let holdMs = 2500;
    try {
      const id = SaucepanClient.companionIdFromUrl();
      if (!id) {
        ExportStatus.show("⚠️ Open a /companion/<id> page first", true);
        holdMs = 5000;
        return;
      }

      const export_ = await SaucepanClient.fetchExport(id, (p) => {
        if (p.phase === "lore") {
          ExportStatus.show(`Fetching lore ${p.done} / ${p.total}…`);
        } else if (p.phase === "companion") {
          ExportStatus.show("Fetching companion…");
        } else {
          ExportStatus.show("Fetching…");
        }
      });

      ExportStatus.show("Building on server…");
      const res = await ServerClient.build({ character: export_ });
      const warnings = res.warnings || [];
      if (res.ok) {
        log("built:", res.path, "warnings:", warnings);
        if (warnings.length) {
          const n = warnings.length;
          ExportStatus.show(`⚠️ Saved — ${n} warning${n === 1 ? "" : "s"}`, false);
          holdMs = 8000;
        } else {
          ExportStatus.show("✓ Saved");
        }
      } else {
        ExportStatus.show(`⚠️ ${warnings[0] || "build failed"}`, true);
        holdMs = 8000;
        warn("build failed:", warnings);
      }
    } catch (err) {
      ExportStatus.show("⚠️ " + (err && err.message ? err.message : String(err)), true);
      holdMs = 8000;
      warn(err);
    } finally {
      setTimeout(() => {
        ExportStatus.hide();
        btn.disabled = false;
      }, holdMs);
    }
  }

  // ---------------------------------------------------------------------------
  // Overlay widgets — a single fixed-position container (#saucepan-export-root)
  // holds, top to bottom: a transient status line, the purple Export button,
  // and the connection pill. Mirrors the JanitorAI bridge. Hidden companions ARE
  // detected (pill shows `hidden ✗`), but there's no CLEAR affordance: a hidden
  // saucepan definition can't be captured (the definition API returns a decoy
  // error and this bridge doesn't relay chat), so there's no cache to clear.
  // ---------------------------------------------------------------------------
  const OVERLAY_STYLE = `
    #saucepan-export-root {
      position: fixed; bottom: 16px; right: 16px; z-index: 999999;
      display: flex; flex-direction: column; align-items: flex-end; gap: 8px;
      font-family: system-ui, sans-serif; font-size: 12px; pointer-events: none;
    }
    #saucepan-export-status {
      pointer-events: auto; display: none; max-width: 260px;
      padding: 3px 8px; border-radius: 8px; color: #fff;
      background: rgba(0,0,0,.6); word-break: break-word;
    }
    #saucepan-export-btn {
      pointer-events: auto; padding: 10px 14px; border-radius: 10px; border: none;
      background: #7a3db5; color: #fff; font-family: inherit; font-size: 13px;
      font-weight: 600; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.3);
    }
    #saucepan-export-btn:disabled { cursor: default; }
    #saucepan-export-pill {
      display: flex; align-items: center; gap: 8px; padding: 4px 10px;
      border-radius: 999px; background: #222; color: #fff; border: 1px solid #444;
      opacity: 0.9;
    }
  `;

  // ---------------------------------------------------------------------------
  // ExportButton — one always-purple action button. Readiness (on a companion
  // page vs not) is shown by the pill; the scheduler only dims the button
  // slightly when there's no companion in view to export.
  // ---------------------------------------------------------------------------
  const ExportButton = {
    _el: null,

    setReady(ready) {
      if (!this._el || this._el.disabled) return;
      this._el.style.opacity = ready ? "1" : "0.6";
    },

    onClick() {
      return exportCompanion();
    },
  };

  // ---------------------------------------------------------------------------
  // ExportStatus — the transient line just above the button ("Fetching…",
  // "Building on server…", "✓ Saved", "⚠️ …").
  // ---------------------------------------------------------------------------
  const ExportStatus = {
    _el: null,

    show(text, isError) {
      if (!this._el) return;
      this._el.textContent = text;
      this._el.style.display = "block";
      this._el.style.background = isError ? "rgba(150,30,30,.85)" : "rgba(0,0,0,.6)";
    },

    hide() {
      if (this._el) this._el.style.display = "none";
    },
  };

  // ---------------------------------------------------------------------------
  // Pill — connection indicator. No CLEAR affordance: nothing is captured
  // server-side for saucepan, so there's no cache to clear.
  // ---------------------------------------------------------------------------
  const Pill = {
    _statusEl: null,

    setStatus(text) {
      if (this._statusEl) this._statusEl.textContent = text;
    },
  };

  // ---------------------------------------------------------------------------
  // Overlay — builds and keeps alive the single container. The watchdog re-adds
  // the overlay if the SPA detaches it.
  // ---------------------------------------------------------------------------
  const Overlay = {
    _root: null,

    mount() {
      if (this._root && this._root.isConnected) return;
      if (!document.body) return;

      if (!document.getElementById("saucepan-export-style")) {
        const style = document.createElement("style");
        style.id = "saucepan-export-style";
        style.textContent = OVERLAY_STYLE;
        (document.head || document.documentElement).appendChild(style);
      }

      const root = document.createElement("div");
      root.id = "saucepan-export-root";

      const status = document.createElement("div");
      status.id = "saucepan-export-status";

      const btn = document.createElement("button");
      btn.id = "saucepan-export-btn";
      btn.textContent = "⬇ Export to card";
      btn.addEventListener("click", () => ExportButton.onClick());

      const pill = document.createElement("div");
      pill.id = "saucepan-export-pill";
      const pillStatus = document.createElement("span");
      pillStatus.textContent = "⚪ saucepan";
      pill.append(pillStatus);

      root.append(status, btn, pill);
      document.body.appendChild(root);

      ExportButton._el = btn;
      ExportStatus._el = status;
      Pill._statusEl = pillStatus;
      this._root = root;
    },

    keepAlive() {
      let scheduled = false;
      new MutationObserver(() => {
        if (scheduled || (this._root && this._root.isConnected)) return;
        scheduled = true;
        requestAnimationFrame(() => {
          scheduled = false;
          this.mount();
        });
      }).observe(document.documentElement, { childList: true, subtree: true });
    },
  };

  // ---------------------------------------------------------------------------
  // Companion state — the companion's open/hidden status, read from saucepan's
  // JSON (`open_definition`), cached per id. Mirrors the JanitorAI bridge's
  // CharacterState: one fetch per companion page, reused every tick.
  // ---------------------------------------------------------------------------
  const CompanionState = {
    _id: null,
    _payload: null,
    _fetching: false,

    // Ensure the `/api/v2/companions/<id>` payload for `id` is cached, fetching
    // it once if needed. Returns the payload, or null while a fetch is in flight
    // / on error.
    async ensure(id) {
      if (!id) return null;
      if (this._id === id && this._payload) return this._payload;
      if (this._fetching) return null;
      this._fetching = true;
      try {
        const payload = await SaucepanClient.fetchCompanion(id);
        this._id = id;
        this._payload = payload;
        return payload;
      } catch (err) {
        warn("companion fetch failed", err);
        return null;
      } finally {
        this._fetching = false;
      }
    },
  };

  // ---------------------------------------------------------------------------
  // Scheduler — one poll drives the connection pill + button dim. Paused while
  // the tab is hidden; backs off to 15s while the server is unreachable. A
  // single self-scheduling timer runs at a time; returning to the tab wakes it.
  //
  // Pill vocabulary (shared with the JanitorAI bridge):
  //   🟢 saucepan               — connected, no companion in view
  //   🟢 saucepan · ready ✓     — open companion, exportable right now
  //   🟢 saucepan · hidden ✗    — hidden companion; only the public blurb can
  //                               export (the definition API returns a decoy
  //                               error and there's no capture path — unlike a
  //                               JanitorAI hidden card, this never becomes ✓)
  //   🔴 saucepan (server down) — server unreachable
  // ---------------------------------------------------------------------------
  let serverDown = false;
  let pollTimer = null;

  async function tick() {
    const id = SaucepanClient.companionIdFromUrl();
    try {
      await ServerClient.health();
      serverDown = false;
      if (!id) {
        Pill.setStatus("🟢 saucepan");
        ExportButton.setReady(false);
      } else {
        // Classify open vs hidden from the companion JSON (cached per id). A
        // null payload (fetch failed / in flight) stays unclassified rather
        // than falsely claiming the card is exportable.
        const payload = await CompanionState.ensure(id);
        if (!payload) {
          Pill.setStatus("🟢 saucepan");
          ExportButton.setReady(false);
        } else if (SaucepanClient.isHidden(payload)) {
          Pill.setStatus("🟢 saucepan · hidden ✗");
          ExportButton.setReady(false);
        } else {
          Pill.setStatus("🟢 saucepan · ready ✓");
          ExportButton.setReady(true);
        }
      }
    } catch {
      serverDown = true;
      Pill.setStatus("🔴 saucepan (server down)");
      ExportButton.setReady(false);
    }
  }

  function scheduleTick(delay) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(runLoop, delay);
  }

  async function runLoop() {
    if (!document.hidden) {
      try {
        await tick();
      } catch (err) {
        warn("tick failed", err);
      }
    }
    scheduleTick(serverDown ? 15000 : 5000);
  }

  // ---------------------------------------------------------------------------
  // bootstrap
  // ---------------------------------------------------------------------------
  function boot() {
    Overlay.mount();
    Overlay.keepAlive();
    scheduleTick(0);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) scheduleTick(0);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
