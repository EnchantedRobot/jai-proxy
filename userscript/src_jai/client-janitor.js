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
