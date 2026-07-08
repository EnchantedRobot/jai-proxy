// ==UserScript==
// @name         jai-proxy bridge
// @namespace    https://github.com/EnchantedRobot/jai-proxy
// @version      0.3.0
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
  // ExportButton — collects + POSTs /build, toasts the result path/warnings.
  // ---------------------------------------------------------------------------
  const ExportButton = {
    _el: null,

    mount() {
      if (this._el) return;
      const el = document.createElement("button");
      el.id = "jai-proxy-export";
      el.textContent = "⬇ Export card";
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
    },

    async _export(el) {
      const original = el.textContent;
      el.textContent = "⏳ exporting…";
      el.disabled = true;
      try {
        const payload = await Collector.collect();
        const result = await ServerClient.build(payload);
        if (result.ok) {
          el.textContent = "✅ saved";
          log("exported card ->", result.path, result.warnings);
          if (result.warnings && result.warnings.length) {
            warn("export warnings:", result.warnings);
          }
        } else {
          el.textContent = "⚠️ failed";
          warn("export failed", result);
        }
      } catch (err) {
        el.textContent = "⚠️ failed";
        warn("export failed", err);
      } finally {
        setTimeout(() => {
          el.textContent = original;
          el.disabled = false;
        }, 2500);
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
      try {
        const status = await ServerClient.health();
        this._el.textContent = `🟢 jai-proxy (${status.model}, ${status.captures} captured)`;
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
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
