  // ---------------------------------------------------------------------------
  // Overlay widgets — a single fixed-position container (#jai-proxy-root) holds,
  // top to bottom: the bulk panel (profile pages only), a transient status line,
  // the purple Export button, and the connection pill. All styling lives in one
  // injected <style> instead of per-element inline styles.
  // ---------------------------------------------------------------------------
  const OVERLAY_STYLE = `
    #jai-proxy-root {
      position: fixed; bottom: 12px; right: 12px; z-index: 999999;
      display: flex; flex-direction: column; align-items: flex-end; gap: 8px;
      font-family: system-ui, sans-serif; font-size: 12px; pointer-events: none;
    }
    #jai-proxy-status {
      pointer-events: auto; display: none; max-width: 260px;
      padding: 3px 8px; border-radius: 8px; color: #fff;
      background: rgba(0,0,0,.6); word-break: break-word;
    }
    #jai-proxy-export {
      pointer-events: auto; padding: 10px 14px; border-radius: 10px; border: none;
      background: #7a3db5; color: #fff; font-family: inherit; font-size: 13px;
      font-weight: 600; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.3);
    }
    #jai-proxy-export:disabled { cursor: default; }
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
      pointer-events: auto; padding: 6px 12px; border-radius: 8px; color: #fff;
      background: #7a3db5; border: none; cursor: pointer; font: inherit;
      font-weight: 600;
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
  // ExportButton — one always-purple action button (mirrors the saucepan
  // bridge). Readiness is no longer color-coded on the button itself — the pill
  // already spells it out (ready ✓ / hidden ✓ / hidden ✗) — so the scheduler
  // only dims the button slightly when the card in view can't be exported yet.
  // ---------------------------------------------------------------------------
  const ExportButton = {
    _el: null,

    setReady(ready) {
      if (!this._el || this._el.disabled) return;
      this._el.style.opacity = ready ? "1" : "0.6";
    },

    onClick() {
      return exportCard();
    },
  };

  // ---------------------------------------------------------------------------
  // ExportStatus — the transient line that sits just above the button (like the
  // saucepan bridge's "Fetching…" / "✓ Saved" toast). Export progress lands
  // here now instead of hijacking the button's own label.
  // ---------------------------------------------------------------------------
  const ExportStatus = {
    _el: null,

    show(text, isError) {
      if (!this._el) return;
      this._el.textContent = text;
      this._el.style.display = "block";
      this._el.style.background = isError ? "rgba(150,30,30,.85)" : "rgba(0,0,0,.6)";
    },

    hide() {
      if (this._el) this._el.style.display = "none";
    },
  };

  // ---------------------------------------------------------------------------
  // Pill — connection indicator + inline CLEAR affordance. CLEAR wipes the
  // server-side capture cache AND resets the plugin's remembered card state
  // (last id / hidden flag). Exported PNGs are untouched. flash() shows
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

      const status = document.createElement("div");
      status.id = "jai-proxy-status";

      const btn = document.createElement("button");
      btn.id = "jai-proxy-export";
      btn.textContent = "⬇ Export to card";
      btn.addEventListener("click", () => ExportButton.onClick());

      const pill = document.createElement("div");
      pill.id = "jai-proxy-pill";
      const pillStatus = document.createElement("span");
      pillStatus.textContent = "⚪ jai-proxy";
      const clear = document.createElement("span");
      clear.className = "jai-clear";
      clear.textContent = "CLEAR";
      clear.title = "Clear server capture cache + reset remembered card state";
      clear.addEventListener("click", () => Pill.clear());
      pill.append(pillStatus, clear);

      root.append(BulkPanel.build(), status, btn, pill);
      document.documentElement.appendChild(root);

      ExportButton._el = btn;
      ExportStatus._el = status;
      Pill._el = pill;
      Pill._statusEl = pillStatus;
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
