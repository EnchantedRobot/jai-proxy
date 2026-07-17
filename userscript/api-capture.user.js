// ==UserScript==
// @name         API Capture (fixtures collector)
// @namespace    https://github.com/mjnitz02/jai-proxy
// @version      0.2.0
// @description  DEV TOOL. Taps every fetch/XHR the page makes and records JSON responses keyed by "METHOD url". One click dumps the whole session as a single {..} fixture file. Works on saucepan.ai and janitorai.com. NOT part of the shipped bridge.
// @match        https://saucepan.ai/*
// @match        https://janitorai.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // Why this exists
  //
  // Building saucepan (and janitorai) mapper fixtures by hand means saving one
  // JSON per endpoint — and a single character page fans out to >150 API calls,
  // many of which fire during initial load before you could paste a console
  // snippet. So instead we install a passive tap at document-start: patch the
  // PAGE's fetch + XMLHttpRequest (so every request keeps the site's own
  // auth/Cloudflare headers), stash each JSON response under "METHOD url", and
  // hand it all back as one file on demand. Just browse the character normally
  // (open the profile, expand the definition, walk the scenarios modal, open the
  // lorebook) and everything the SPA fetches lands in the archive.
  //
  // CSP note: saucepan ships `script-src 'self'` (no 'unsafe-inline', no
  // 'blob:'), so we CANNOT inject a <script> element to reach page context —
  // the browser refuses to execute it. We don't need to: `@grant none` already
  // runs this userscript in the page's own context on every manager, so we just
  // reassign window.fetch / patch XMLHttpRequest.prototype directly. Assigning a
  // property is not "executing a script resource", so CSP's script-src never
  // applies.
  //
  // Firefox sandbox fallback: if a manager hands us a content-script sandbox
  // instead of page context (window !== unsafeWindow), we patch the real page
  // window via unsafeWindow and wrap our callbacks with exportFunction so the
  // page is allowed to call them across the Xray boundary. The capture store
  // stays sandbox-side (a plain JS object); only STRINGS ever cross back
  // (response text via .clone().text() / xhr.responseText, and the final dump).
  // ---------------------------------------------------------------------------

  const TAG = "[api-capture]";
  const MAX_BYTES = 4 * 1024 * 1024;
  const STATIC = /\.(js|css|png|jpe?g|webp|gif|svg|ico|woff2?|ttf|mp4|webm|map)(\?|$)/i;

  // The page's real window. With `@grant none` this is just `window`; in a
  // Firefox content-script sandbox it's `unsafeWindow`. When they differ we're
  // sandboxed and must hand the page exportFunction-wrapped callbacks.
  const pageWin =
    typeof unsafeWindow !== "undefined" && unsafeWindow ? unsafeWindow : window;
  const sandboxed = pageWin !== window && typeof exportFunction === "function";
  const expose = sandboxed ? (fn) => exportFunction(fn, pageWin) : (fn) => fn;

  // The archive. Lives here in our context; keyed by "METHOD absolute-url".
  const store = {};
  try {
    // Handy for poking at from the console when we're in page context.
    if (!sandboxed) pageWin.__API_CAPTURE__ = store;
  } catch (e) {}

  function abs(u) {
    try {
      return new URL(u, location.href).href;
    } catch (e) {
      return String(u);
    }
  }

  function parse(text) {
    try {
      return JSON.parse(text);
    } catch (e) {
      return undefined;
    }
  }

  function record(method, url, status, reqBody, text) {
    if (!url || STATIC.test(url)) return;
    if (text && text.length > MAX_BYTES) return; // skip oversized bodies
    const body = parse(text);
    if (body === undefined || typeof body !== "object") return; // JSON only
    let parsedReq;
    if (reqBody) {
      const p = parse(reqBody);
      parsedReq = p !== undefined ? p : reqBody;
    }
    store[method + " " + url] = {
      method,
      url,
      status,
      requestBody: parsedReq,
      response: body,
    };
    updateButton();
  }

  // --- fetch tap -------------------------------------------------------------
  const origFetch = pageWin.fetch;
  if (origFetch) {
    pageWin.fetch = expose(function (input, init) {
      const url = abs(typeof input === "string" ? input : (input && input.url) || input);
      const method = ((init && init.method) || (input && input.method) || "GET").toUpperCase();
      const reqBody = init && init.body != null ? String(init.body) : undefined;
      return origFetch.apply(this, arguments).then(function (res) {
        try {
          res
            .clone()
            .text()
            .then(function (text) {
              record(method, url, res.status, reqBody, text);
            })
            .catch(function () {});
        } catch (e) {}
        return res;
      });
    });
  }

  // --- XHR tap (prototype patch, so it survives across all XHR instances) -----
  const xhrProto = pageWin.XMLHttpRequest && pageWin.XMLHttpRequest.prototype;
  if (xhrProto) {
    const meta = new WeakMap();
    const origOpen = xhrProto.open;
    const origSend = xhrProto.send;
    xhrProto.open = expose(function (m, u) {
      try {
        meta.set(this, { method: (m || "GET").toUpperCase(), url: abs(u), reqBody: undefined });
      } catch (e) {}
      return origOpen.apply(this, arguments);
    });
    xhrProto.send = expose(function (body) {
      const info = meta.get(this) || { method: "GET", url: "" };
      if (body != null) {
        try {
          info.reqBody = String(body);
        } catch (e) {}
      }
      const xhr = this;
      xhr.addEventListener("load", function () {
        try {
          const rt = xhr.responseType;
          if (rt !== "" && rt !== "text") return; // only readable-as-text
          record(info.method, info.url, xhr.status, info.reqBody, xhr.responseText);
        } catch (e) {}
      });
      return origSend.apply(this, arguments);
    });
  }

  console.log(TAG, "tap installed" + (sandboxed ? " (sandbox/exportFunction)" : " (page context)") + " — browse the character, then click the button to dump");

  // --- dump UI ---------------------------------------------------------------

  // Download a (UTF-8) string as a file via a base64 data: URL. A download
  // triggered by <a download> is not governed by CSP script-src, so this is
  // safe even under the strict policy that blocks injected scripts.
  function download(text, filename) {
    const href = "data:application/json;base64," + btoa(unescape(encodeURIComponent(text)));
    const a = document.createElement("a");
    a.href = href;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  let btn = null;
  function updateButton() {
    if (btn) btn.textContent = `⬇ Dump API captures (${Object.keys(store).length})`;
  }

  function addButton() {
    if (document.getElementById("api-capture-btn")) return;
    if (!document.body) return;
    btn = document.createElement("button");
    btn.id = "api-capture-btn";
    Object.assign(btn.style, {
      position: "fixed", bottom: "16px", left: "16px", zIndex: 999999,
      padding: "10px 14px", borderRadius: "10px", border: "none",
      background: "#2f5db5", color: "#fff", fontWeight: "600", cursor: "pointer",
      boxShadow: "0 2px 8px rgba(0,0,0,.3)",
    });
    btn.addEventListener("click", () => {
      const text = JSON.stringify(store);
      const n = Object.keys(store).length;
      const host = location.hostname.replace(/[^\w.]+/g, "_");
      const slug = (location.pathname.split("/").filter(Boolean).pop() || "page").replace(/[^\w-]+/g, "_");
      download(text, `capture_${host}_${slug}_${n}.json`);
      console.log(TAG, `dumped ${n} captures`);
    });
    document.body.appendChild(btn);
    updateButton();
  }

  if (document.body) addButton();
  new MutationObserver(addButton).observe(document.documentElement, { childList: true, subtree: true });
})();
