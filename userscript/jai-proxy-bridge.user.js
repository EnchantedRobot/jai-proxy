// ==UserScript==
// @name         jai-proxy bridge
// @namespace    https://github.com/EnchantedRobot/jai-proxy
// @version      0.5.3
// @description  Thin bridge: relays JanitorAI chat completions through a local jai-proxy server (which forwards to local MLX), shows a connection pill, and exports the current profile as a V3 card PNG. Card assembly lives server-side.
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

(function () {
  "use strict";

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

    async captureGreetings(payload) {
      const { text } = await this._request({
        method: "POST",
        path: "/capture-greetings",
        body: payload,
        timeout: 15000,
      });
      return JSON.parse(text);
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
  // FetchHook — patch window.fetch and XMLHttpRequest at document-start so
  // JanitorAI's chat-completion request is intercepted before its app code
  // ever runs. Everything that doesn't look like a chat-completion request
  // passes through untouched.
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
  // Greeting carousel walker — ported from janitorai-export.user.js's
  // extractInitialMessages (~L470). Opens the "Initial Messages" (or, for a
  // single greeting, "First Message") accordion, reads the "N / M" counter,
  // and walks Next capturing each message body's RAW HTML. Unlike the
  // reference script (which converts to markdown in-page via
  // richToGreeting), this sends raw HTML and lets the server's
  // GreetingConverter.convert() do the HTML→markdown conversion — same
  // division of labor as everything else in this thin bridge.
  // ---------------------------------------------------------------------------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(predicate, timeoutMs = 4000, stepMs = 100) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const v = predicate();
      if (v) return v;
      if (Date.now() > deadline) return v;
      await sleep(stepMs);
    }
  }

  function initialMessagesBtn() {
    // Multiple greetings → "Initial Messages" (carousel + counter). Exactly
    // one greeting → "First Message" (singular, no carousel).
    return [
      ...document.querySelectorAll("button[aria-controls^='panel-info-']"),
    ].find((b) => {
      const t = b.textContent.trim().toLowerCase();
      return t.startsWith("initial messages") || t.startsWith("first message");
    });
  }

  function currentMessageBodyEl(panel) {
    return panel.querySelector(".characterInfoMarkdownContainer");
  }

  function parseCounter(panel) {
    const m = panel.textContent.match(/(\d+)\s*\/\s*(\d+)/);
    return m ? { cur: +m[1], total: +m[2] } : null;
  }

  function textLength(html) {
    const d = document.createElement("div");
    d.innerHTML = html;
    return (d.textContent || "").trim().length;
  }

  async function walkGreetings() {
    const btn = initialMessagesBtn();
    if (!btn) {
      warn('no "Initial Messages"/"First Message" accordion — greetings_html will be empty');
      return [];
    }
    if (btn.getAttribute("aria-expanded") === "false") btn.click();
    const panel = document.getElementById(btn.getAttribute("aria-controls"));
    if (!panel) {
      warn("Initial Messages panel not found");
      return [];
    }
    await waitFor(() => currentMessageBodyEl(panel));

    const counter = parseCounter(panel);
    const total = counter ? counter.total : 1;
    log(`initial messages: ${total} total`);

    const bodies = [];
    for (let i = 0; i < total && i < 40; i++) {
      await waitFor(() => currentMessageBodyEl(panel));
      const el = currentMessageBodyEl(panel);
      const html = el ? el.innerHTML : "";
      bodies.push(html);
      if (i >= total - 1) break;

      const next = [...panel.querySelectorAll("button")].find(
        (b) =>
          /next message/i.test(b.getAttribute("aria-label") || "") && !b.disabled
      );
      if (!next) {
        warn("no enabled Next-message button — stopping early");
        break;
      }
      next.click();
      await waitFor(() => {
        const cur = currentMessageBodyEl(panel);
        return cur ? cur.innerHTML !== html : false;
      });
    }

    // Drop blank / "create your own" stub greetings (JanitorAI's last slot
    // is often an empty "make your own scenario" card). Judge by rendered
    // TEXT length, not raw HTML length — mirrors the reference script's
    // MIN=10 threshold, applied post-conversion there but pre-conversion
    // here since the server does the HTML→markdown step.
    const MIN = 10;
    return bodies.filter((html) => textLength(html) >= MIN);
  }

  // ---------------------------------------------------------------------------
  // Lorebook mining — ported from janitorai-export.user.js's jaiPageScrape
  // (~L557) + fetchScriptsViaPage (~L615). JanitorAI calls attached
  // lorebooks "scripts"; a character page renders ScriptCards for each. Two
  // obstacles, both solved by running in PAGE context (see comments there):
  //   1. ScriptCards are React-routed <div>s with no <a href> carrying the
  //      id — it only lives in the card's React fiber props.
  //   2. Reading page-side fiber objects from the userscript sandbox trips
  //      Firefox Xray, so a <script> tag is injected to run in page
  //      context, and results cross back via a one-shot CustomEvent
  //      (primitives only — hence JSON-stringifying the result).
  // Confirmed live (console-export-2026-6-22_22-15-50.log): the real
  // endpoint is /hampter/script/<id> (singular) — /hampter/scripts/<id> and
  // /hampter/lorebooks/<id> both 404.
  // ---------------------------------------------------------------------------

  // This function's source is stringified and injected into the page — it
  // must be fully self-contained (no closure over userscript sandbox scope).
  function jaiLorebookPageScrape(eventName) {
    var UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    var ids = new Set();
    document.querySelectorAll('a[href*="/scripts/"]').forEach(function (a) {
      var m = (a.getAttribute("href") || "").match(UUID);
      if (m) ids.add(m[0]);
    });
    function fiberKey(el) {
      return Object.keys(el).find(function (k) {
        return k.indexOf("__reactFiber$") === 0 || k.indexOf("__reactInternalInstance$") === 0;
      });
    }
    var cards = document.querySelectorAll(
      '[class*="scriptsSection"] *, [class*="ScriptCard"], [class*="scriptCard"]'
    );
    cards.forEach(function (el) {
      var k = fiberKey(el);
      if (!k) return;
      var f = el[k];
      var depth = 0;
      while (f && depth < 40) {
        var p = f.memoizedProps || f.pendingProps;
        if (p) {
          for (var key in p) {
            var v = p[key];
            if (typeof v === "string") {
              var mm = v.match(UUID);
              if (mm) ids.add(mm[0]);
            } else if (v && typeof v === "object" && typeof v.id === "string" && UUID.test(v.id)) {
              ids.add(v.id);
            }
          }
        }
        f = f.return;
        depth++;
      }
    });
    var arr = Array.from(ids);
    Promise.all(
      arr.map(function (id) {
        return fetch("/hampter/script/" + id, { credentials: "include" })
          .then(function (r) {
            return r.ok ? r.json() : null;
          })
          .then(function (j) {
            return j ? { id: id, raw: j } : null;
          })
          .catch(function () {
            return null;
          });
      })
    ).then(function (list) {
      var ok = list.filter(Boolean);
      window.dispatchEvent(new CustomEvent(eventName, { detail: JSON.stringify(ok) }));
    });
  }

  // Inject jaiLorebookPageScrape into page context and await its
  // JSON-string result: [{id, raw}, ...] — matches ServerClient.build()'s
  // `lorebooks` contract directly, no reshaping needed.
  function fetchLorebooksViaPage(timeoutMs = 15000) {
    return new Promise((resolve) => {
      const evt = "jai-lb-" + Math.random().toString(36).slice(2);
      let done = false;
      const finish = (val) => {
        if (done) return;
        done = true;
        resolve(val);
      };
      window.addEventListener(
        evt,
        (e) => {
          try {
            finish(JSON.parse(e.detail));
          } catch (err) {
            warn("could not parse lorebook scrape result:", err);
            finish([]);
          }
        },
        { once: true }
      );
      const s = document.createElement("script");
      s.textContent = `(${jaiLorebookPageScrape.toString()})(${JSON.stringify(evt)});`;
      (document.head || document.documentElement).appendChild(s);
      s.remove();
      setTimeout(() => finish([]), timeoutMs);
    });
  }

  async function mineLorebooks() {
    try {
      const lorebooks = await fetchLorebooksViaPage();
      log("lorebooks found on page:", lorebooks.length);
      return lorebooks;
    } catch (err) {
      warn("lorebook scrape failed:", err);
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Chat-view detection + hidden-card name persistence — M7. A hidden
  // profile page carries no usable character name (no accordion, no title
  // name — just the tagline); the chat page's `_nameText_` is authoritative,
  // so it's remembered here (GM_setValue) and reused when building from the
  // profile page.
  // ---------------------------------------------------------------------------
  function isChatView() {
    return !!document.querySelector("[class*='_messageBody_']");
  }

  function chatCharacterName() {
    const el = document.querySelector("[class*='_nameText_']");
    return el ? el.textContent.trim() : "";
  }

  function rememberChatNameIfChatView() {
    if (!isChatView()) return;
    const name = chatCharacterName();
    if (name) GM_setValue("jai_last_char_name", name);
  }

  function isHiddenProfile() {
    return !!document.body && document.body.textContent.includes("Character Definition is hidden");
  }

  // Mirrors rememberChatNameIfChatView: the hidden/open distinction only
  // shows up in the DOM on the profile page, but the status pill also
  // needs it while on the chat page, so it's remembered here.
  function rememberProfileHiddenStateIfProfileView() {
    if (isChatView()) return;
    GM_setValue("jai_last_card_hidden", isHiddenProfile());
  }

  // Defaults to true (assume hidden) until a profile-page visit has told
  // us otherwise, so the status pill doesn't flash false checkmarks.
  function effectiveIsHidden() {
    return isChatView() ? GM_getValue("jai_last_card_hidden", true) : isHiddenProfile();
  }

  function effectiveCharacterName() {
    if (isHiddenProfile()) return GM_getValue("jai_last_char_name", "");
    return Collector.characterName();
  }

  function harvestChatGreetings() {
    const bodies = document.querySelectorAll("[class*='_messageBody_']");
    const out = [];
    bodies.forEach((body) => {
      const clone = body.cloneNode(true);
      clone
        .querySelectorAll(
          "[class*='_messageNameContainerCopying_'], [class*='_nameContainer_'], [class*='_messageFooter_']"
        )
        .forEach((el) => el.remove());
      const html = clone.innerHTML;
      // Floor at 100 chars of rendered text to skip blank / trivial stub
      // slots. Note this does NOT reliably exclude JanitorAI's "Custom
      // Scenario Creator" swipe — those blocks vary wildly per card (some
      // short, some hundreds of chars of instructions), so no length cutoff
      // catches them cleanly. Kept a known follow-up; the human reviews the
      // harvested greetings before/after export. Don't raise this much
      // higher — some cards have legitimately short opening scenarios.
      if (textLength(html) >= 100) out.push(html);
    });
    return out;
  }

  // ---------------------------------------------------------------------------
  // Collector — gathers the raw material for POST /build. Everything else
  // (HTML→md, macro repair, V3 JSON, PNG chunks) happens server-side; this
  // just hands over outerHTML, walked greeting HTML, mined lorebook JSON,
  // and the avatar URL.
  // ---------------------------------------------------------------------------
  const Collector = {
    characterName() {
      const parts = (document.title || "").split("|");
      const name = (parts[parts.length - 1] || "").trim();
      return name || "Unknown";
    },

    characterId() {
      const m = window.location.pathname.match(/characters?\/([\w-]+)/i);
      return m ? m[1] : null;
    },

    profileHtml() {
      const root = document.querySelector("main") || document.body;
      return root ? root.outerHTML : "";
    },

    avatarUrl() {
      const img = document.querySelector("img.avatar-image");
      if (img && img.src) return img.src;
      const og = document.querySelector('meta[property="og:image:secure_url"]');
      if (og && og.content) return og.content;
      const tw = document.querySelector('meta[name="twitter:image"]');
      if (tw && tw.content) return tw.content;
      return null;
    },

    async collect() {
      const [greetings_html, lorebooks] = await Promise.all([
        walkGreetings(),
        mineLorebooks(),
      ]);
      return {
        character: {
          name: this.characterName(),
          id: this.characterId(),
          url: window.location.href,
        },
        profile_html: this.profileHtml(),
        greetings_html,
        avatar_url: this.avatarUrl(),
        lorebooks,
      };
    },
  };

  // ---------------------------------------------------------------------------
  // ExportButton — context-aware. On a chat page it harvests + posts the
  // greeting capture; on a profile page it runs the existing Collector +
  // /build path (with the effective name override for hidden cards).
  // ---------------------------------------------------------------------------
  const ExportButton = {
    _el: null,
    _labelInterval: null,

    mount() {
      if (this._el) return;
      const el = document.createElement("button");
      el.id = "jai-proxy-export";
      Object.assign(el.style, {
        position: "fixed",
        bottom: "44px",
        right: "12px",
        zIndex: 999999,
        padding: "6px 12px",
        borderRadius: "6px",
        fontFamily: "monospace",
        fontSize: "12px",
        background: "#2d6cdf",
        color: "#fff",
        border: "1px solid #1d4ea0",
        cursor: "pointer",
      });
      el.addEventListener("click", () => this._export(el));
      document.documentElement.appendChild(el);
      this._el = el;
      this._updateLabel();
      if (!this._labelInterval) {
        this._labelInterval = setInterval(() => this._updateLabel(), 2000);
      }
    },

    _updateLabel() {
      if (!this._el || this._el.disabled) return;
      rememberChatNameIfChatView();
      this._el.textContent = isChatView() ? "⬇ Export greetings" : "⬇ Export card";
    },

    _export(el) {
      return isChatView() ? this._exportGreetings(el) : this._exportCard(el);
    },

    async _exportGreetings(el) {
      const original = el.textContent;
      el.textContent = "⏳ exporting…";
      el.disabled = true;
      let holdMs = 2500;
      try {
        const name = chatCharacterName();
        const greetings_html = harvestChatGreetings();
        if (!greetings_html.length) {
          el.textContent = "⚠️ no greetings found";
          holdMs = 4000;
        } else {
          const result = await ServerClient.captureGreetings({ name, greetings_html });
          log("captured greetings ->", result.count);
          el.textContent = `✅ captured ${result.count} greetings`;
        }
      } catch (err) {
        el.textContent = "⚠️ failed";
        el.title = String(err);
        holdMs = 8000;
        warn("greetings export failed", err);
      } finally {
        setTimeout(() => {
          el.textContent = original;
          el.title = "";
          el.disabled = false;
        }, holdMs);
      }
    },

    async _exportCard(el) {
      const original = el.textContent;
      el.textContent = "⏳ exporting…";
      el.disabled = true;
      let holdMs = 2500;
      try {
        const payload = await Collector.collect();
        payload.character.name = effectiveCharacterName() || payload.character.name;

        // Prefilled with the detected name so the box is never blank --
        // the server's own fallback (profile_html-parsed name) can differ
        // from this client-side default, so we always send back exactly
        // what's in the box rather than relying on a server-side default.
        const typed = window.prompt("Save card as:", payload.character.name);
        if (typed === null) {
          el.textContent = original;
          el.disabled = false;
          return;
        }
        payload.output_name = typed.trim() || payload.character.name;

        const result = await ServerClient.build(payload);
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
    },

    keepAlive() {
      new MutationObserver(() => {
        if (!document.getElementById("jai-proxy-export")) {
          this._el = null;
          this.mount();
        }
      }).observe(document.documentElement, { childList: true, subtree: true });
    },
  };

  // ---------------------------------------------------------------------------
  // ClearCacheButton — wipes server-side .captures state (raw system-prompt
  // .txt dumps + per-character .json CaptureRecords). Exists because hidden
  // cards are rectified by name, and name collisions get more likely the
  // longer captures accumulate. PNGs under output_dir are untouched.
  // ---------------------------------------------------------------------------
  const ClearCacheButton = {
    _el: null,

    mount() {
      if (this._el) return;
      const el = document.createElement("button");
      el.id = "jai-proxy-clear-cache";
      el.textContent = "🗑 Clear cache";
      Object.assign(el.style, {
        position: "fixed",
        bottom: "76px",
        right: "12px",
        zIndex: 999999,
        padding: "6px 12px",
        borderRadius: "6px",
        fontFamily: "monospace",
        fontSize: "12px",
        background: "#6b6b6b",
        color: "#fff",
        border: "1px solid #4a4a4a",
        cursor: "pointer",
      });
      el.addEventListener("click", () => this._clear(el));
      document.documentElement.appendChild(el);
      this._el = el;
    },

    async _clear(el) {
      if (!window.confirm("Clear jai-proxy capture cache (all captured system prompts + greetings)? PNGs are not affected.")) {
        return;
      }
      const original = el.textContent;
      el.textContent = "⏳ clearing…";
      el.disabled = true;
      let holdMs = 2000;
      try {
        const result = await ServerClient.clearCaptures();
        log("cleared captures ->", result.removed);
        el.textContent = `✅ cleared ${result.removed}`;
      } catch (err) {
        el.textContent = "⚠️ failed";
        el.title = String(err);
        holdMs = 6000;
        warn("clear cache failed", err);
      } finally {
        setTimeout(() => {
          el.textContent = original;
          el.title = "";
          el.disabled = false;
        }, holdMs);
      }
    },

    keepAlive() {
      new MutationObserver(() => {
        if (!document.getElementById("jai-proxy-clear-cache")) {
          this._el = null;
          this.mount();
        }
      }).observe(document.documentElement, { childList: true, subtree: true });
    },
  };

  // ---------------------------------------------------------------------------
  // StatusPill — small fixed-position indicator, polls /health.
  // ---------------------------------------------------------------------------
  const StatusPill = {
    _el: null,

    mount() {
      if (this._el) return;
      const el = document.createElement("div");
      el.id = "jai-proxy-pill";
      Object.assign(el.style, {
        position: "fixed",
        bottom: "12px",
        right: "12px",
        zIndex: 999999,
        padding: "4px 10px",
        borderRadius: "999px",
        fontFamily: "monospace",
        fontSize: "12px",
        background: "#222",
        color: "#fff",
        border: "1px solid #444",
        pointerEvents: "none",
        opacity: "0.85",
      });
      el.textContent = "⚪ jai-proxy";
      document.documentElement.appendChild(el);
      this._el = el;
      this._poll();
      setInterval(() => this._poll(), 5000);
    },

    async _poll() {
      if (!this._el) return;
      rememberChatNameIfChatView();
      rememberProfileHiddenStateIfProfileView();
      const name = isChatView()
        ? chatCharacterName()
        : GM_getValue("jai_last_char_name", "") || Collector.characterName();

      try {
        if (!name || name === "Unknown") {
          await ServerClient.health();
          this._el.textContent = "🟢 jai-proxy";
          return;
        }
        // Open cards carry everything the /build scrape needs directly in
        // the DOM (no hidden-flow captures required), so show both as
        // satisfied by default rather than checking capture state that
        // will never be populated for them.
        const open = !effectiveIsHidden();
        const status = open ? null : await ServerClient.captureStatus(name);
        const sys = open || status.system ? "✓" : "✗";
        const greet = open || status.greetings ? "✓" : "✗";
        this._el.textContent = `🟢 ${name} · Sys ${sys} · Greet ${greet}`;
      } catch {
        this._el.textContent = "🔴 jai-proxy (server down)";
      }
    },

    keepAlive() {
      new MutationObserver(() => {
        if (!document.getElementById("jai-proxy-pill")) {
          this._el = null;
          this.mount();
        }
      }).observe(document.documentElement, { childList: true, subtree: true });
    },
  };

  // ---------------------------------------------------------------------------
  // bootstrap
  // ---------------------------------------------------------------------------
  FetchHook.install();

  function boot() {
    StatusPill.mount();
    StatusPill.keepAlive();
    ExportButton.mount();
    ExportButton.keepAlive();
    ClearCacheButton.mount();
    ClearCacheButton.keepAlive();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
