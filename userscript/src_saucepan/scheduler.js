  // ---------------------------------------------------------------------------
  // Companion state — the companion's open/hidden status, read from saucepan's
  // JSON (`open_definition`), cached per id. Mirrors the JanitorAI bridge's
  // CharacterState: one fetch per companion page, reused every tick.
  // ---------------------------------------------------------------------------
  const CompanionState = {
    _id: null,
    _payload: null,
    _fetching: false,

    // Ensure the `/api/v2/companions/<id>` payload for `id` is cached, fetching
    // it once if needed. Returns the payload, or null while a fetch is in flight
    // / on error.
    async ensure(id) {
      if (!id) return null;
      if (this._id === id && this._payload) return this._payload;
      if (this._fetching) return null;
      this._fetching = true;
      try {
        const payload = await SaucepanClient.fetchCompanion(id);
        this._id = id;
        this._payload = payload;
        return payload;
      } catch (err) {
        warn("companion fetch failed", err);
        return null;
      } finally {
        this._fetching = false;
      }
    },
  };

  // ---------------------------------------------------------------------------
  // Scheduler — one poll drives the connection pill + button dim. Paused while
  // the tab is hidden; backs off to 15s while the server is unreachable. A
  // single self-scheduling timer runs at a time; returning to the tab wakes it.
  //
  // Pill vocabulary (shared with the JanitorAI bridge):
  //   🟢 saucepan               — connected, no companion in view
  //   🟢 saucepan · ready ✓     — open companion, exportable right now
  //   🟢 saucepan · hidden ✗    — hidden companion; only the public blurb can
  //                               export (the definition API returns a decoy
  //                               error and there's no capture path — unlike a
  //                               JanitorAI hidden card, this never becomes ✓)
  //   🔴 saucepan (server down) — server unreachable
  // ---------------------------------------------------------------------------
  let serverDown = false;
  let pollTimer = null;

  async function tick() {
    const id = SaucepanClient.companionIdFromUrl();
    try {
      await ServerClient.health();
      serverDown = false;
      if (!id) {
        Pill.setStatus("🟢 saucepan");
        ExportButton.setReady(false);
      } else {
        // Classify open vs hidden from the companion JSON (cached per id). A
        // null payload (fetch failed / in flight) stays unclassified rather
        // than falsely claiming the card is exportable.
        const payload = await CompanionState.ensure(id);
        if (!payload) {
          Pill.setStatus("🟢 saucepan");
          ExportButton.setReady(false);
        } else if (SaucepanClient.isHidden(payload)) {
          Pill.setStatus("🟢 saucepan · hidden ✗");
          ExportButton.setReady(false);
        } else {
          Pill.setStatus("🟢 saucepan · ready ✓");
          ExportButton.setReady(true);
        }
      }
    } catch {
      serverDown = true;
      Pill.setStatus("🔴 saucepan (server down)");
      ExportButton.setReady(false);
    }
  }

  function scheduleTick(delay) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(runLoop, delay);
  }

  async function runLoop() {
    if (!document.hidden) {
      try {
        await tick();
      } catch (err) {
        warn("tick failed", err);
      }
    }
    scheduleTick(serverDown ? 15000 : 5000);
  }
