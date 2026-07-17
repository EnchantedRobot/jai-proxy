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
