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
