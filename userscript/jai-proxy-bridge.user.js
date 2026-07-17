// ==UserScript==
// @name         jai-proxy bridge
// @namespace    https://github.com/EnchantedRobot/jai-proxy
// @version      0.7.0
// @description  Thin bridge: relays JanitorAI chat completions through a local jai-proxy server (which forwards to local MLX), shows a connection pill, and exports a character as a V3 card PNG via JanitorAI's clean JSON API (no DOM scraping). Card assembly lives server-side.
// @match        https://janitorai.com/*
// @match        https://www.janitorai.com/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      127.0.0.1
// @connect      localhost
// @connect      janitorai.com
// @connect      ella.janitorai.com
// ==/UserScript==
//
// SOURCE LAYOUT — this file is COMPILED. Do not edit jai-proxy-bridge.user.js by
// hand; edit userscript/src/*.js and run `make compile` (see
// scripts/compile_userscript.py). The modules are concatenated, in order, inside
// a single IIFE beneath this banner.

(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // User config — hand-edited, not persisted. Controls which cards the BULK
  // "download all open cards" run (creator /profiles/ page) exports. The single
  // ⬇ Export button is NEVER filtered; this only narrows a bulk sweep.
  //
  // Matching is case-insensitive and ignores a tag's leading emoji / "#" prefix,
  // so "female" matches JanitorAI's "👩‍🦰 Female". Both a card's official tags
  // and its free-form custom_tags are checked. Tag names are matched WHOLE (after
  // the emoji prefix): "futa" does NOT match "futanari" — list every variant you
  // want to catch.
  //
  // A card is exported when it has at least one `include` tag (or `include` is
  // empty = no include filter) AND none of the `exclude` tags. The filter runs on
  // the cheap list rows, so excluded cards are skipped before any per-card fetch.
  //
  //   include: []                      → download every open card
  //   include: ["female"]              → only cards tagged Female
  //   exclude: ["futa", "futanari"]    → drop either tag
  // ---------------------------------------------------------------------------
  const BULK_TAG_FILTER = {
    include: [],
    exclude: ["futa", "futanari"],
  };

  // The one config knob. Change if the server runs elsewhere.
  const SERVER = "http://127.0.0.1:8000";

  const TAG = "[jai-proxy]";
  const log = (...a) => console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);

  // ---------------------------------------------------------------------------
  // ServerClient — all traffic to the local jai-proxy server goes via
  // GM_xmlhttpRequest so it's exempt from the page's CSP / mixed-content rules.
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
          onerror: () => reject(new Error("network error")),
          ontimeout: () => reject(new Error("timeout")),
        });
      });
    },

    async health() {
      const { text } = await this._request({ path: "/health" });
      return JSON.parse(text);
    },

    async relay(body) {
      const { text } = await this._request({
        method: "POST",
        path: "/v1/chat/completions",
        body,
        timeout: 120000,
      });
      return text;
    },

    async models() {
      const { text } = await this._request({ path: "/v1/models" });
      return text;
    },

    async build(payload) {
      const { text } = await this._request({
        method: "POST",
        path: "/build",
        body: payload,
        timeout: 60000,
      });
      return JSON.parse(text);
    },

    // Which of these card ids are already saved on disk. Lets a bulk run skip
    // cards we already have before the slow per-card fetch loop.
    async existing(ids) {
      const { text } = await this._request({
        method: "POST",
        path: "/existing",
        body: { ids },
        timeout: 30000,
      });
      return JSON.parse(text).existing || [];
    },

    async captureStatus(name) {
      const { text } = await this._request({
        path: "/capture-status?name=" + encodeURIComponent(name),
      });
      return JSON.parse(text);
    },

    async clearCaptures() {
      const { text } = await this._request({
        method: "POST",
        path: "/clear-captures",
        timeout: 15000,
      });
      return JSON.parse(text);
    },
  };

  // ---------------------------------------------------------------------------
  // JanitorClient — reads a character (and its lorebooks) straight from
  // JanitorAI's own JSON API, replacing all DOM scraping.
  //
  //   GET /hampter/characters/<id>  → full card JSON (open cards carry the
  //                                   definition; hidden cards omit it)
  //   GET /hampter/script/<id>      → a public lorebook's entries
  //
  // Both need `Authorization: Bearer <supabase-JWT>` (cookies alone 401) and
  // must run IN THE PAGE: Cloudflare gates on the browser's TLS fingerprint +
  // cf_clearance cookie, and the token lives in the page's cookies/localStorage.
  // So a self-contained fetch is injected as a <script> (page context) and its
  // result crosses back via a one-shot CustomEvent (a JSON string — primitives
  // only, to sidestep Firefox Xray). Same mechanism the old lorebook scrape
  // used. findToken() is ported from ~/workspaces/JAR/src/autotrigger.js.
  // ---------------------------------------------------------------------------

  // Stringified + injected into the page — must be fully self-contained (no
  // closure over the userscript sandbox scope).
  function jaiAuthedFetchPage(eventName, url) {
    function findToken() {
      var b64 = function (s) {
        try { return atob(s); } catch (e) { /* */ }
        try { return atob(s.replace(/-/g, "+").replace(/_/g, "/")); } catch (e) { /* */ }
        return null;
      };
      var extract = function (rawIn) {
        var raw = rawIn;
        if (!raw) return null;
        try { raw = decodeURIComponent(raw); } catch (e) { /* */ }
        if (raw.indexOf("base64-") === 0) raw = raw.slice(7);
        if (raw.indexOf("eyJ") === 0 && raw.split(".").length === 3) return raw;
        var candidates = [b64(raw), raw];
        for (var ci = 0; ci < candidates.length; ci += 1) {
          var s = candidates[ci];
          if (!s) continue;
          var mm = s.match(/"access_token":"(eyJ[^"]+)"/);
          if (mm) return mm[1];
          try {
            var o = JSON.parse(s);
            var c = o && (o.access_token || o.accessToken || o.token
              || (o.currentSession && o.currentSession.access_token));
            if (typeof c === "string" && c.indexOf("eyJ") === 0) return c;
          } catch (e) { /* */ }
        }
        return null;
      };
      // Supabase chunks the auth cookie across sb-<ref>-auth-token(.0/.1/…);
      // reassemble each base's chunks in index order before extracting.
      try {
        var parts = {};
        var cookies = (document.cookie || "").split("; ");
        for (var i = 0; i < cookies.length; i += 1) {
          var c = cookies[i];
          var eq = c.indexOf("=");
          if (eq < 0) continue;
          var mm = c.slice(0, eq).match(/^(sb-.*-auth-token)(?:\.(\d+))?$/);
          if (!mm) continue;
          var base = mm[1];
          var idx = mm[2] ? parseInt(mm[2], 10) : 0;
          (parts[base] = parts[base] || {})[idx] = c.slice(eq + 1);
        }
        for (var b in parts) {
          var idxs = Object.keys(parts[b]).map(Number).sort(function (x, y) { return x - y; });
          var joined = "";
          for (var j = 0; j < idxs.length; j += 1) joined += parts[b][idxs[j]];
          var t = extract(joined);
          if (t) return t;
        }
      } catch (e) { /* */ }
      try {
        for (var k = 0; k < localStorage.length; k += 1) {
          var lt = extract(localStorage.getItem(localStorage.key(k)));
          if (lt) return lt;
        }
      } catch (e) { /* */ }
      return null;
    }

    var token = findToken();
    var headers = { accept: "application/json, text/plain, */*" };
    if (token) headers.authorization = "Bearer " + token;
    fetch(url, { credentials: "include", headers: headers })
      .then(function (r) {
        return r.text().then(function (body) {
          window.dispatchEvent(new CustomEvent(eventName, {
            detail: JSON.stringify({ status: r.status, body: body }),
          }));
        });
      })
      .catch(function (err) {
        window.dispatchEvent(new CustomEvent(eventName, {
          detail: JSON.stringify({ status: 0, body: String(err) }),
        }));
      });
  }

  // Inject jaiAuthedFetchPage for one URL, resolve with the response body text
  // (rejects on non-2xx or timeout).
  function pageAuthedFetch(url, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const evt = "jai-af-" + Math.random().toString(36).slice(2);
      let done = false;
      let timer = null;
      const finish = (fn) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        fn();
      };
      timer = setTimeout(() => finish(() => reject(new Error("timeout"))), timeoutMs);
      window.addEventListener(
        evt,
        (e) => {
          let res;
          try {
            res = JSON.parse(e.detail);
          } catch (err) {
            finish(() => reject(err));
            return;
          }
          if (res.status >= 200 && res.status < 300) {
            finish(() => resolve(res.body));
          } else {
            finish(() => reject(new Error(`HTTP ${res.status}: ${(res.body || "").slice(0, 200)}`)));
          }
        },
        { once: true }
      );
      const s = document.createElement("script");
      s.textContent = `(${jaiAuthedFetchPage.toString()})(${JSON.stringify(evt)}, ${JSON.stringify(url)});`;
      (document.head || document.documentElement).appendChild(s);
      s.remove();
    });
  }

  const JanitorClient = {
    async fetchCharacter(id) {
      const body = await pageAuthedFetch(`https://janitorai.com/hampter/characters/${id}`);
      return JSON.parse(body);
    },

    async fetchScript(id) {
      const body = await pageAuthedFetch(`https://janitorai.com/hampter/script/${id}`);
      return JSON.parse(body);
    },

    // One page of a creator's catalogue, keyed on the creator UUID. Rows carry
    // `showdefinition` (open/hidden) + `name` (the title blurb — `chat_name` is
    // null here, it only appears on the per-card fetch) and the envelope carries
    // `page` / `size` / `total` for pagination. Bracketed `user_id[]` is sent
    // literally, exactly as the site does.
    async listCharacters(creatorId, page = 1) {
      const url =
        `https://janitorai.com/hampter/characters?page=${page}` +
        `&language=en&sort=latest&user_id[]=${encodeURIComponent(creatorId)}`;
      const body = await pageAuthedFetch(url);
      return JSON.parse(body);
    },
  };

  // ---------------------------------------------------------------------------
  // Overlay widgets — a single fixed-position container (#jai-proxy-root) holds
  // the export button and the status pill. All styling lives in one injected
  // <style> instead of per-element inline styles.
  // ---------------------------------------------------------------------------
  const OVERLAY_STYLE = `
    #jai-proxy-root {
      position: fixed; bottom: 12px; right: 12px; z-index: 999999;
      display: flex; flex-direction: column; align-items: flex-end; gap: 8px;
      font-family: monospace; font-size: 12px; pointer-events: none;
    }
    #jai-proxy-export {
      pointer-events: auto; padding: 6px 12px; border-radius: 6px; color: #fff;
      background: #2d6cdf; border: 1px solid #1d4ea0; cursor: pointer;
    }
    #jai-proxy-pill {
      display: flex; align-items: center; gap: 8px; padding: 4px 10px;
      border-radius: 999px; background: #222; color: #fff; border: 1px solid #444;
      opacity: 0.9;
    }
    #jai-proxy-pill .jai-clear {
      pointer-events: auto; cursor: pointer; color: #ff9d9d; font-weight: bold;
      letter-spacing: 0.5px; border-left: 1px solid #555; padding-left: 8px;
    }
    #jai-proxy-pill .jai-clear:hover { color: #ff6b6b; }
    #jai-proxy-bulk {
      pointer-events: auto; display: none; flex-direction: column; gap: 6px;
      background: #222; color: #fff; border: 1px solid #444; border-radius: 8px;
      padding: 8px 10px; width: 300px; opacity: 0.96;
    }
    #jai-proxy-bulk .jai-bulk-head {
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
    }
    #jai-proxy-bulk .jai-bulk-title { font-weight: bold; }
    #jai-proxy-bulk-btn {
      pointer-events: auto; padding: 5px 10px; border-radius: 6px; color: #fff;
      background: #2d6cdf; border: 1px solid #1d4ea0; cursor: pointer; font: inherit;
    }
    #jai-proxy-bulk-btn:disabled { opacity: 0.6; cursor: default; }
    #jai-proxy-bulk .jai-bulk-status { opacity: 0.85; word-break: break-word; }
    #jai-proxy-bulk .jai-bulk-list {
      display: flex; flex-direction: column; gap: 2px;
      max-height: 260px; overflow-y: auto; margin-top: 2px;
    }
    #jai-proxy-bulk .jai-bulk-row { display: flex; align-items: baseline; gap: 6px; }
    #jai-proxy-bulk .jai-bulk-icon { flex: 0 0 1.2em; text-align: center; }
    #jai-proxy-bulk .jai-bulk-name {
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
  `;

  // ---------------------------------------------------------------------------
  // ExportButton — one action now (the greeting-capture button is gone; hidden
  // greetings ride in on the chat relay). The scheduler drives its ready
  // colour via setReady(); green = the card in view can be exported right now
  // (open card, or hidden card whose captures are present).
  // ---------------------------------------------------------------------------
  const ExportButton = {
    _el: null,

    setReady(green) {
      if (!this._el || this._el.disabled) return;
      this._el.style.background = green ? "#2e9e4f" : "#2d6cdf";
      this._el.style.borderColor = green ? "#22803c" : "#1d4ea0";
    },

    onClick() {
      return exportCard(this._el);
    },
  };

  // ---------------------------------------------------------------------------
  // Pill — status indicator + inline CLEAR affordance. CLEAR wipes the
  // server-side capture cache AND resets the plugin's remembered state (last
  // card name / id / hidden flag). Exported PNGs are untouched. flash() shows
  // transient feedback the scheduler's setStatus() won't overwrite until the
  // hold expires.
  // ---------------------------------------------------------------------------
  const Pill = {
    _el: null,
    _statusEl: null,
    _holdUntil: 0,

    setStatus(text) {
      if (!this._statusEl || Date.now() < this._holdUntil) return;
      this._statusEl.textContent = text;
    },

    flash(text, ms) {
      if (!this._statusEl) return;
      this._statusEl.textContent = text;
      this._holdUntil = Date.now() + ms;
    },

    async clear() {
      if (
        !window.confirm(
          "Clear jai-proxy capture cache (captured hidden definitions + greetings) " +
            "and reset the plugin's remembered card state? Exported PNGs are not affected."
        )
      ) {
        return;
      }
      resetPluginState();
      this.flash("⏳ clearing…", 4000);
      try {
        const result = await ServerClient.clearCaptures();
        log("cleared captures ->", result.removed, "+ plugin state");
        this.flash(`✅ cleared ${result.removed}`, 3000);
      } catch (err) {
        warn("clear failed", err);
        this.flash("⚠️ clear failed", 6000);
      }
    },
  };

  // ---------------------------------------------------------------------------
  // Overlay — builds and keeps alive the single container. The watchdog
  // observes only <html>'s direct children (childList, NO subtree), so it does
  // not fire on every streamed chat token; it wakes only if our root detaches.
  // ---------------------------------------------------------------------------
  const Overlay = {
    _root: null,

    mount() {
      if (this._root && this._root.isConnected) return;

      if (!document.getElementById("jai-proxy-style")) {
        const style = document.createElement("style");
        style.id = "jai-proxy-style";
        style.textContent = OVERLAY_STYLE;
        (document.head || document.documentElement).appendChild(style);
      }

      const root = document.createElement("div");
      root.id = "jai-proxy-root";

      const btn = document.createElement("button");
      btn.id = "jai-proxy-export";
      btn.textContent = "⬇ Export card";
      btn.addEventListener("click", () => ExportButton.onClick());

      const pill = document.createElement("div");
      pill.id = "jai-proxy-pill";
      const status = document.createElement("span");
      status.textContent = "⚪ jai-proxy";
      const clear = document.createElement("span");
      clear.className = "jai-clear";
      clear.textContent = "CLEAR";
      clear.title = "Clear server capture cache + reset remembered card state";
      clear.addEventListener("click", () => Pill.clear());
      pill.append(status, clear);

      root.append(BulkPanel.build(), btn, pill);
      document.documentElement.appendChild(root);

      ExportButton._el = btn;
      Pill._el = pill;
      Pill._statusEl = status;
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
      }).observe(document.documentElement, { childList: true });
    },
  };

  // ---------------------------------------------------------------------------
  // Character state — resolved from JanitorAI's JSON, not the DOM.
  //
  // A character page's URL carries the character UUID; the chat page's does
  // not. So on a character page we fetch the JSON once (cached per id) and
  // persist name / id / hidden (GM_setValue); the chat page — where the hidden
  // capture actually happens — reads those back. `showdefinition:false` is the
  // open/hidden flag. Reset by the pill's CLEAR affordance.
  // ---------------------------------------------------------------------------
  const KEY_NAME = "jai_last_char_name";
  const KEY_ID = "jai_last_char_id";
  const KEY_HIDDEN = "jai_last_card_hidden";

  const AVATAR_BASE = "https://ella.janitorai.com/bot-avatars/";
  const CHAR_BASE = "https://janitorai.com/characters/";

  function resetPluginState() {
    GM_setValue(KEY_NAME, "");
    GM_setValue(KEY_ID, "");
    GM_setValue(KEY_HIDDEN, false);
  }

  // The character UUID from a /characters/<uuid>_<slug> path. Scoped to
  // /characters/ so a chat page's own id (a different UUID) can't be mistaken
  // for a character id.
  function currentCharacterId() {
    const m = location.pathname.match(/\/characters?\/([0-9a-f-]{36})/i);
    return m ? m[1].toLowerCase() : null;
  }

  function isChatView() {
    return !!document.querySelector("[class*='_messageBody_']");
  }

  function chatCharacterName() {
    const el = document.querySelector("[class*='_nameText_']");
    return el ? el.textContent.trim() : "";
  }

  const CharacterState = {
    _id: null,
    _json: null,
    _fetching: false,

    // On a character page, fetch + cache the JSON once and persist the derived
    // name / id / hidden flag. No-op on chat / browse pages (no id in URL).
    async refresh() {
      const id = currentCharacterId();
      if (!id || id === this._id || this._fetching) return;
      this._fetching = true;
      try {
        const json = await JanitorClient.fetchCharacter(id);
        this._id = id;
        this._json = json;
        GM_setValue(KEY_NAME, (json.chat_name || json.name || "").trim());
        GM_setValue(KEY_ID, id);
        GM_setValue(KEY_HIDDEN, json.showdefinition === false);
      } catch (err) {
        warn("character fetch failed", err);
      } finally {
        this._fetching = false;
      }
    },

    cachedJson(id) {
      return this._id === id ? this._json : null;
    },
  };

  // ---------------------------------------------------------------------------
  // Scheduler — one poll drives the pill + button. Paused while the tab is
  // hidden; backs off to 15s while the server is unreachable. A single
  // self-scheduling timer runs at a time; returning to the tab wakes it.
  // ---------------------------------------------------------------------------
  let serverDown = false;
  let pollTimer = null;

  async function tick() {
    await CharacterState.refresh();

    // The bulk "download all open cards" panel lives on creator profile pages
    // only; show/hide it as the SPA navigates.
    BulkPanel.toggle(!!currentCreatorId());

    const onChar = !!currentCharacterId();
    const onChat = isChatView();
    const id = currentCharacterId() || GM_getValue(KEY_ID, "");
    const name = GM_getValue(KEY_NAME, "") || (onChat ? chatCharacterName() : "");
    const hidden = GM_getValue(KEY_HIDDEN, false);

    try {
      let ready = false;
      let statusText;
      if ((!onChar && !onChat) || !name) {
        await ServerClient.health();
        statusText = "🟢 jai-proxy";
      } else if (!hidden) {
        // Open card: the JSON carries everything; nothing to capture.
        await ServerClient.health();
        statusText = `🟢 ${name} · open ✓`;
        ready = !!id;
      } else {
        // Hidden card: the definition + primary greeting come from the chat
        // relay capture, so surface whether the server has them yet.
        const status = await ServerClient.captureStatus(name);
        statusText = `🟢 ${name} · Sys ${status.system ? "✓" : "✗"} · Greet ${status.greetings ? "✓" : "✗"}`;
        ready = !!id && status.system && status.greetings;
      }
      serverDown = false;
      Pill.setStatus(statusText);
      ExportButton.setReady(ready);
    } catch {
      serverDown = true;
      Pill.setStatus("🔴 jai-proxy (server down)");
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
  // Export — the whole card export is now: fetch the character JSON, fetch its
  // public lorebooks, POST /build. No DOM scraping, no greeting carousel walk.
  // Hidden cards work the same way: their definition + primary greeting are
  // already captured server-side from the chat relay, and the server merges
  // them with the JSON's alternate greetings / metadata.
  // ---------------------------------------------------------------------------
  async function fetchPublicLorebooks(character) {
    const scripts = Array.isArray(character.scripts) ? character.scripts : [];
    const ids = scripts
      .filter((s) => s && s.type === "lorebook" && s.is_public && s.id)
      .map((s) => s.id);
    if (!ids.length) return [];
    const results = await Promise.all(
      ids.map(async (id) => {
        try {
          return { id, raw: await JanitorClient.fetchScript(id) };
        } catch (err) {
          warn("lorebook fetch failed", id, err);
          return null;
        }
      })
    );
    const ok = results.filter(Boolean);
    log(`lorebooks: ${ok.length}/${ids.length} public fetched`);
    return ok;
  }

  // Resolve a character JSON, preferring the scheduler's per-page cache so a
  // freshly-viewed character page isn't refetched.
  async function resolveCharacter(id) {
    return CharacterState.cachedJson(id) || (await JanitorClient.fetchCharacter(id));
  }

  // The reusable core of a card export: resolve the character JSON (unless one
  // is supplied), fetch its public lorebooks, POST /build. Shared by the single
  // Export-card button and the bulk "download all open cards" panel. Returns
  // the server result plus the resolved character + its default (chat_)name.
  //   opts.character  — a pre-fetched JSON, to avoid a second round-trip
  //   opts.outputName — overrides the saved card name (defaults to chat_name)
  //   opts.url        — source URL recorded on the card (defaults to the id URL)
  async function buildCardById(id, opts = {}) {
    const character = opts.character || (await resolveCharacter(id));
    const defaultName =
      (character.chat_name || character.name || "").trim() || "Unknown";
    const lorebooks = await fetchPublicLorebooks(character);
    const payload = {
      character: { name: defaultName, id, url: opts.url || CHAR_BASE + id },
      character_json: character,
      avatar_url: character.avatar ? AVATAR_BASE + character.avatar : null,
      lorebooks,
      output_name: (opts.outputName || "").trim() || defaultName,
    };
    const result = await ServerClient.build(payload);
    return { result, character, defaultName };
  }

  async function exportCard(el) {
    const original = el.textContent;
    el.textContent = "⏳ exporting…";
    el.disabled = true;
    let holdMs = 2500;
    try {
      const id = currentCharacterId() || GM_getValue(KEY_ID, "");
      if (!id) {
        el.textContent = "⚠️ open a character page first";
        holdMs = 5000;
        return;
      }

      const character = await resolveCharacter(id);
      const defaultName =
        (character.chat_name || character.name || "").trim() || "Unknown";

      // Prefilled with the real character name (chat_name) so the box is never
      // blank; whatever the user leaves becomes data.name server-side.
      const typed = window.prompt("Save card as:", defaultName);
      if (typed === null) {
        el.textContent = original;
        el.disabled = false;
        return;
      }

      const { result } = await buildCardById(id, {
        character,
        outputName: typed,
        url: location.href,
      });
      const warnings = result.warnings || [];
      if (result.ok) {
        log("exported card ->", result.path, warnings);
        if (warnings.length) {
          const n = warnings.length;
          const first =
            warnings[0].length > 60 ? warnings[0].slice(0, 57) + "…" : warnings[0];
          el.textContent = `⚠️ saved — ${n} warning${n === 1 ? "" : "s"}: ${first}`;
          el.title = warnings.join("\n");
          holdMs = 8000;
          warn("export warnings:", warnings);
        } else {
          el.textContent = "✅ saved";
          el.title = result.path || "";
        }
      } else {
        el.textContent = `⚠️ ${warnings[0] || "failed"}`;
        el.title = JSON.stringify(result);
        holdMs = 8000;
        warn("export failed", result);
      }
    } catch (err) {
      el.textContent = "⚠️ failed";
      el.title = String(err);
      holdMs = 8000;
      warn("export failed", err);
    } finally {
      setTimeout(() => {
        el.textContent = original;
        el.title = "";
        el.disabled = false;
      }, holdMs);
    }
  }

  // ---------------------------------------------------------------------------
  // Bulk export — on a creator's /profiles/<uuid>_… page, enumerate the whole
  // catalogue and export every OPEN card, reusing the per-card buildCardById
  // path. Hidden cards are listed but skipped; auto-capturing hidden
  // definitions in bulk (create a chat + send a message per card) is deferred.
  //
  // IMPORTANT: the creator/list endpoint reports every row as is_public:true /
  // showdefinition:false as CONSTANT PLACEHOLDERS (verified across ~6 creators)
  // — it cannot tell open from hidden. Only the per-card /hampter/characters/<id>
  // response carries the real `showdefinition`. So we enumerate ids from the
  // list, then fetch each card to classify + export. Userscript-only; every
  // open card still goes through the same server /build as the single button.
  // ---------------------------------------------------------------------------
  const LIST_PAGE_DELAY_MS = 600;    // between list-endpoint pages
  const CARD_BUILD_DELAY_MS = 1500;  // after exporting an open card (writes a PNG)
  const CARD_SKIP_DELAY_MS = 400;    // after skipping a hidden card (just a GET)
  const MAX_LIST_PAGES = 100;        // safety valve

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // ---------------------------------------------------------------------------
  // Tag filter (BULK_TAG_FILTER, from config.js) — applied to the cheap list
  // rows so filtered-out cards never trigger a per-card fetch.
  // ---------------------------------------------------------------------------

  // Normalize a tag for comparison: drop a leading emoji / "#" / punctuation run
  // (JanitorAI prefixes official tags with an emoji) then lower-case. Mirrors the
  // server's clean_tag so "👩‍🦰 Female" and "female" compare equal.
  function normTag(t) {
    return String(t == null ? "" : t)
      .replace(/^[^\p{L}\p{N}]+/u, "")
      .trim()
      .toLowerCase();
  }

  const _INCLUDE = (BULK_TAG_FILTER.include || []).map(normTag).filter(Boolean);
  const _EXCLUDE = (BULK_TAG_FILTER.exclude || []).map(normTag).filter(Boolean);

  // Every tag on a list row, normalized: official `tags[].name` + `custom_tags`.
  function rowTagSet(row) {
    const out = new Set();
    for (const t of row.tags || []) {
      if (t && t.name) out.add(normTag(t.name));
    }
    for (const c of row.custom_tags || []) out.add(normTag(c));
    out.delete("");
    return out;
  }

  // A card passes when it carries at least one include tag (or include is empty)
  // AND none of the exclude tags.
  function passesTagFilter(row) {
    const tset = rowTagSet(row);
    if (_INCLUDE.length && !_INCLUDE.some((t) => tset.has(t))) return false;
    if (_EXCLUDE.some((t) => tset.has(t))) return false;
    return true;
  }

  // Human-readable one-liner for the active filter, or "" when none is set.
  function filterSummary() {
    const parts = [];
    if (_INCLUDE.length) parts.push(`only ${_INCLUDE.join(", ")}`);
    if (_EXCLUDE.length) parts.push(`no ${_EXCLUDE.join(", ")}`);
    return parts.join(" · ");
  }

  // Creator UUID from a /profiles/<uuid>_<slug> path — the leading 36-char UUID
  // the list endpoint keys on via user_id[]=. Mirrors currentCharacterId().
  function currentCreatorId() {
    const m = location.pathname.match(/\/profiles\/([0-9a-f-]{36})/i);
    return m ? m[1].toLowerCase() : null;
  }

  // Every card id + display name in a creator's catalogue that passes the tag
  // filter. `chat_name` is null in list rows, so the label is the `name` blurb;
  // the real name is resolved per-card at build time. Pagination keys on the
  // full scanned count vs the envelope's `total` (not the kept count, which the
  // filter shrinks). Returns { rows, scanned, skipped }.
  async function enumerateCards(creatorId, onProgress) {
    const rows = [];
    let scanned = 0;
    let skipped = 0;
    for (let page = 1; page <= MAX_LIST_PAGES; page += 1) {
      const res = await JanitorClient.listCharacters(creatorId, page);
      const data = Array.isArray(res.data) ? res.data : [];
      for (const c of data) {
        if (!c || !c.id) continue;
        scanned += 1;
        if (!passesTagFilter(c)) {
          skipped += 1;
          continue;
        }
        rows.push({ id: c.id, name: (c.name || "").trim() || c.id });
      }
      const total = Number(res.total) || scanned;
      if (onProgress) onProgress(scanned, total, rows.length);
      if (!data.length || scanned >= total) break;
      await sleep(LIST_PAGE_DELAY_MS);
    }
    return { rows, scanned, skipped };
  }

  // ---------------------------------------------------------------------------
  // BulkPanel — the profile-page widget: a Download button, a status line, and
  // a scrollable list of rows whose leading icon tracks each card's fate
  // (⏳ pending/working · ✓ saved · ✗ hidden-skipped · ⚠ failed).
  // ---------------------------------------------------------------------------
  const BulkPanel = {
    _el: null,
    _btn: null,
    _status: null,
    _list: null,
    _rows: new Map(),
    _running: false,

    build() {
      const el = document.createElement("div");
      el.id = "jai-proxy-bulk";

      const head = document.createElement("div");
      head.className = "jai-bulk-head";
      const title = document.createElement("span");
      title.className = "jai-bulk-title";
      title.textContent = "⬇ All open cards";
      const btn = document.createElement("button");
      btn.id = "jai-proxy-bulk-btn";
      btn.textContent = "Download";
      btn.addEventListener("click", () => this.run());
      head.append(title, btn);

      const status = document.createElement("div");
      status.className = "jai-bulk-status";
      const fs = filterSummary();
      status.textContent = fs ? `filter: ${fs} — click Download` : "creator profile — click Download";

      const list = document.createElement("div");
      list.className = "jai-bulk-list";

      el.append(head, status, list);
      this._el = el;
      this._btn = btn;
      this._status = status;
      this._list = list;
      return el;
    },

    toggle(show) {
      if (this._el) this._el.style.display = show ? "flex" : "none";
    },

    _setStatus(text) {
      if (this._status) this._status.textContent = text;
    },

    _renderRows(rows) {
      this._list.innerHTML = "";
      this._rows.clear();
      for (const r of rows) {
        const row = document.createElement("div");
        row.className = "jai-bulk-row";
        const icon = document.createElement("span");
        icon.className = "jai-bulk-icon";
        icon.textContent = "⏳";
        const name = document.createElement("span");
        name.className = "jai-bulk-name";
        name.textContent = r.name;
        row.title = "pending";
        row.append(icon, name);
        this._list.append(row);
        this._rows.set(r.id, { icon, row });
      }
    },

    _setRow(id, iconText, title) {
      const entry = this._rows.get(id);
      if (!entry) return;
      entry.icon.textContent = iconText;
      if (title) entry.row.title = title;
    },

    async run() {
      if (this._running) return;
      const creatorId = currentCreatorId();
      if (!creatorId) {
        this._setStatus("⚠️ open a creator's profile page first");
        return;
      }
      this._running = true;
      this._btn.disabled = true;
      try {
        this._setStatus("⏳ listing cards…");
        const { rows, scanned, skipped } = await enumerateCards(creatorId, (n, total) =>
          this._setStatus(`⏳ listing cards… ${n}/${total}`)
        );
        if (!scanned) {
          this._setStatus("no cards found for this creator");
          return;
        }
        if (!rows.length) {
          this._setStatus(`no cards matched the tag filter (scanned ${scanned})`);
          return;
        }
        this._renderRows(rows);

        // Skip cards already on disk. The `_<id8>` fragment in each saved
        // filename is knowable from a list row (unlike the real name), so the
        // server can tell us which ids exist in one cheap call — those drop out
        // before the slow one-at-a-time classify/build loop. Fails soft: if the
        // check errors, we just export everything.
        this._setStatus("⏳ checking which cards are already saved…");
        let onDisk = new Set();
        try {
          onDisk = new Set(await ServerClient.existing(rows.map((r) => r.id)));
        } catch (err) {
          warn("existing-check failed; exporting all", err);
        }
        const pending = [];
        for (const r of rows) {
          if (onDisk.has(r.id)) {
            this._setRow(r.id, "•", "already saved — skipped");
          } else {
            pending.push(r);
          }
        }
        const already = rows.length - pending.length;
        if (!pending.length) {
          this._setStatus(`all ${rows.length} card(s) already saved — nothing to do`);
          return;
        }

        // The listing can't tell open from hidden, so every kept card is fetched
        // individually — warn before a long one-at-a-time run.
        const filterNote = skipped ? `\n\n${skipped} card(s) excluded by the tag filter.` : "";
        const onDiskNote = already ? `\n\n${already} card(s) already saved — skipped.` : "";
        if (
          !window.confirm(
            `Check ${pending.length} card(s) for open definitions and download each ` +
              "open one?\n\nThe listing can't tell open from hidden, so each card " +
              "is fetched one at a time. Hidden cards are skipped." +
              onDiskNote +
              filterNote
          )
        ) {
          this._setStatus(`${pending.length} cards — cancelled`);
          return;
        }

        let done = 0;
        let failed = 0;
        let hidden = 0;
        for (let i = 0; i < pending.length; i += 1) {
          const r = pending[i];
          this._setStatus(`(${i + 1}/${pending.length}) ✓${done} ✗${hidden} ⚠${failed} — ${r.name}`);
          let built = false;
          try {
            this._setRow(r.id, "⏳", "checking…");
            const character = await resolveCharacter(r.id);
            if (character.showdefinition === false) {
              hidden += 1;
              this._setRow(r.id, "✗", "hidden — skipped (needs a chat capture)");
            } else {
              this._setRow(r.id, "⏳", "exporting…");
              const { result } = await buildCardById(r.id, { character });
              const warnings = (result && result.warnings) || [];
              if (result && result.ok) {
                done += 1;
                built = true;
                this._setRow(
                  r.id,
                  "✓",
                  warnings.length ? `saved — ${warnings.length} warning(s)` : (result.path || "saved")
                );
              } else {
                failed += 1;
                this._setRow(r.id, "⚠", warnings[0] || "build failed");
                warn("bulk build failed", r.id, result);
              }
            }
          } catch (err) {
            failed += 1;
            this._setRow(r.id, "⚠", String(err));
            warn("bulk card error", r.id, err);
          }
          if (i < pending.length - 1) {
            await sleep(built ? CARD_BUILD_DELAY_MS : CARD_SKIP_DELAY_MS);
          }
        }
        const filtered = skipped ? ` · ⊘ ${skipped} filtered` : "";
        const existingNote = already ? ` · • ${already} already saved` : "";
        this._setStatus(
          `done · ✓ ${done} saved · ✗ ${hidden} hidden · ⚠ ${failed} failed${existingNote}${filtered}`
        );
      } catch (err) {
        warn("bulk run failed", err);
        this._setStatus("⚠️ " + String(err));
      } finally {
        this._running = false;
        this._btn.disabled = false;
      }
    },
  };

  // ---------------------------------------------------------------------------
  // FetchHook — patch window.fetch and XMLHttpRequest at document-start so
  // JanitorAI's chat-completion request is intercepted before its app code ever
  // runs, relayed through the local server (which forwards to MLX AND captures
  // the hidden definition + primary greeting). Everything that doesn't look
  // like a chat-completion / models probe passes through untouched.
  // ---------------------------------------------------------------------------
  function looksLikeChatCompletion(url, bodyText) {
    if (url && url.includes("chat/completions")) return true;
    if (!bodyText) return false;
    try {
      const parsed = JSON.parse(bodyText);
      return Array.isArray(parsed.messages) && "model" in parsed;
    } catch {
      return false;
    }
  }

  // Scoped to our own configured endpoint host so we never shadow JanitorAI's
  // own unrelated "/models" calls elsewhere on the site.
  function looksLikeModelsProbe(method, url) {
    if ((method || "GET").toUpperCase() !== "GET" || !url) return false;
    return url.startsWith(SERVER) && url.includes("/models");
  }

  const FetchHook = {
    install() {
      this._installFetch();
      this._installXHR();
      log("fetch hook installed");
    },

    _installFetch() {
      const originalFetch = window.fetch;
      window.fetch = async function (input, init) {
        const url = typeof input === "string" ? input : input?.url;
        const method = init?.method || "GET";
        const bodyText = init?.body;

        if (looksLikeModelsProbe(method, url)) {
          try {
            const replyText = await ServerClient.models();
            return new Response(replyText, {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          } catch (err) {
            warn("models probe relay failed, falling through", err);
          }
        }

        if (looksLikeChatCompletion(url, typeof bodyText === "string" ? bodyText : null)) {
          try {
            const parsedBody = typeof bodyText === "string" ? JSON.parse(bodyText) : bodyText;
            log("relaying chat/completions via fetch", url);
            const replyText = await ServerClient.relay(parsedBody);
            return new Response(replyText, {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          } catch (err) {
            warn("relay failed, falling through to original fetch", err);
          }
        }

        return originalFetch.apply(this, arguments);
      };
    },

    _installXHR() {
      const OriginalXHR = window.XMLHttpRequest;
      const originalOpen = OriginalXHR.prototype.open;
      const originalSend = OriginalXHR.prototype.send;

      OriginalXHR.prototype.open = function (method, url, ...rest) {
        this.__jaiProxyUrl = url;
        this.__jaiProxyMethod = method;
        return originalOpen.call(this, method, url, ...rest);
      };

      function resolveWith(xhr, replyText) {
        Object.defineProperty(xhr, "readyState", { value: 4, configurable: true });
        Object.defineProperty(xhr, "status", { value: 200, configurable: true });
        Object.defineProperty(xhr, "responseText", { value: replyText, configurable: true });
        Object.defineProperty(xhr, "response", { value: replyText, configurable: true });
        xhr.dispatchEvent(new Event("readystatechange"));
        xhr.dispatchEvent(new Event("load"));
        xhr.dispatchEvent(new Event("loadend"));
      }

      OriginalXHR.prototype.send = function (body) {
        const url = this.__jaiProxyUrl || "";
        const method = this.__jaiProxyMethod || "GET";
        const bodyText = typeof body === "string" ? body : null;
        const xhr = this;

        if (looksLikeModelsProbe(method, url)) {
          ServerClient.models()
            .then((replyText) => resolveWith(xhr, replyText))
            .catch((err) => {
              warn("XHR models probe relay failed, falling through", err);
              originalSend.call(xhr, body);
            });
          return;
        }

        if (looksLikeChatCompletion(url, bodyText)) {
          const parsedBody = bodyText ? JSON.parse(bodyText) : {};
          log("relaying chat/completions via XHR", url);
          ServerClient.relay(parsedBody)
            .then((replyText) => resolveWith(xhr, replyText))
            .catch((err) => {
              warn("XHR relay failed, falling through to original send", err);
              originalSend.call(xhr, body);
            });
          return;
        }

        return originalSend.call(this, body);
      };
    },
  };

  // ---------------------------------------------------------------------------
  // bootstrap
  // ---------------------------------------------------------------------------
  FetchHook.install();

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
