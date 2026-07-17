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
