  // ---------------------------------------------------------------------------
  // Config + logging. The saucepan bridge is the twin of the JanitorAI bridge:
  // it fetches a companion straight from saucepan's own JSON API and hands the
  // raw export to the local jai-proxy server (POST /build-saucepan), which does
  // all the deobfuscation / mapping / PNG assembly. (That whole pipeline used to
  // be a 1200-line in-page DOM scraper; it now lives server-side in
  // proxy/saucepan_fragments.py + saucepan_mapper.py + cardbuilder.py.)
  // ---------------------------------------------------------------------------
  // Where the jai-proxy server is. Persisted in Tampermonkey storage rather
  // than compiled in, because it may now be a container on another machine
  // (docs/DEPLOY.md). To repoint the bridge, run this once in the console on
  // saucepan.ai — no recompile, no reinstall:
  //
  //   GM_setValue("serverUrl", "http://192.168.1.50:8000")
  //
  // and reload. Clearing it falls back to the local default below. Plain http
  // to a LAN address works from HTTPS saucepan: every call goes out through
  // GM_xmlhttpRequest (see client-server.js), which is exempt from the page's
  // mixed-content and CSP rules.
  const DEFAULT_SERVER = "http://127.0.0.1:8000";
  // Trailing slashes stripped: every call is SERVER + "/some/path".
  const SERVER = String(GM_getValue("serverUrl", "") || DEFAULT_SERVER).replace(/\/+$/, "");
  const SAUCEPAN_ORIGIN = "https://saucepan.ai";

  const TAG = "[saucepan-export]";
  const log = (...a) => console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);
