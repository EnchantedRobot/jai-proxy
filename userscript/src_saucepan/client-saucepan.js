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
    async fetchExport(id) {
      const out = { id };
      out.definition = await apiGet(`/api/v1/companion/definition?companion_id=${id}`);
      out.companion = await this.fetchCompanion(id);

      out.lorebooks = [];
      for (const lid of this.lorebookIds()) {
        const list = await apiGet(`/api/v2/lorebooks/${lid}/chapters`);
        const chapters = [];
        for (const c of (list && list.chapters) || []) {
          chapters.push(await apiGet(`/api/v2/lorebooks/${lid}/chapters/${c.index}`));
        }
        out.lorebooks.push({ id: lid, list, chapters });
      }
      log(`fetched export for ${id} — lorebooks: ${out.lorebooks.length}`);
      return out;
    },
  };
