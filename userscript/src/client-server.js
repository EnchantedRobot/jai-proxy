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
