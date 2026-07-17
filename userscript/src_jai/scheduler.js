  // ---------------------------------------------------------------------------
  // Character state — resolved from JanitorAI's JSON, not the DOM.
  //
  // A character page's URL carries the character UUID; the chat page's does
  // not. So on a character page we fetch the JSON once (cached per id) and
  // persist name / id / hidden (GM_setValue); the chat page — where the hidden
  // capture actually happens — reads those back. `showdefinition:false` is the
  // open/hidden flag. Reset by the pill's CLEAR affordance.
  // ---------------------------------------------------------------------------
  const KEY_NAME = "jai_last_char_name";
  const KEY_ID = "jai_last_char_id";
  const KEY_HIDDEN = "jai_last_card_hidden";

  const AVATAR_BASE = "https://ella.janitorai.com/bot-avatars/";
  const CHAR_BASE = "https://janitorai.com/characters/";

  function resetPluginState() {
    GM_setValue(KEY_NAME, "");
    GM_setValue(KEY_ID, "");
    GM_setValue(KEY_HIDDEN, false);
  }

  // The character UUID from a /characters/<uuid>_<slug> path. Scoped to
  // /characters/ so a chat page's own id (a different UUID) can't be mistaken
  // for a character id.
  function currentCharacterId() {
    const m = location.pathname.match(/\/characters?\/([0-9a-f-]{36})/i);
    return m ? m[1].toLowerCase() : null;
  }

  function isChatView() {
    return !!document.querySelector("[class*='_messageBody_']");
  }

  function chatCharacterName() {
    const el = document.querySelector("[class*='_nameText_']");
    return el ? el.textContent.trim() : "";
  }

  const CharacterState = {
    _id: null,
    _json: null,
    _fetching: false,

    // On a character page, fetch + cache the JSON once and persist the derived
    // name / id / hidden flag. No-op on chat / browse pages (no id in URL).
    async refresh() {
      const id = currentCharacterId();
      if (!id || id === this._id || this._fetching) return;
      this._fetching = true;
      try {
        const json = await JanitorClient.fetchCharacter(id);
        this._id = id;
        this._json = json;
        GM_setValue(KEY_NAME, (json.chat_name || json.name || "").trim());
        GM_setValue(KEY_ID, id);
        GM_setValue(KEY_HIDDEN, json.showdefinition === false);
      } catch (err) {
        warn("character fetch failed", err);
      } finally {
        this._fetching = false;
      }
    },

    cachedJson(id) {
      return this._id === id ? this._json : null;
    },
  };

  // ---------------------------------------------------------------------------
  // Scheduler — one poll drives the pill + button. Paused while the tab is
  // hidden; backs off to 15s while the server is unreachable. A single
  // self-scheduling timer runs at a time; returning to the tab wakes it.
  // ---------------------------------------------------------------------------
  let serverDown = false;
  let pollTimer = null;

  async function tick() {
    await CharacterState.refresh();

    // The bulk "download all open cards" panel lives on creator profile pages
    // only; show/hide it as the SPA navigates.
    BulkPanel.toggle(!!currentCreatorId());

    const onChar = !!currentCharacterId();
    const onChat = isChatView();
    const id = currentCharacterId() || GM_getValue(KEY_ID, "");
    const name = GM_getValue(KEY_NAME, "") || (onChat ? chatCharacterName() : "");
    const hidden = GM_getValue(KEY_HIDDEN, false);

    try {
      let ready = false;
      let statusText;
      if ((!onChar && !onChat) || !name) {
        await ServerClient.health();
        statusText = "🟢 jai-proxy";
      } else if (!hidden) {
        // Open card: the JSON carries everything; nothing to capture.
        await ServerClient.health();
        statusText = `🟢 ${name} · open ✓`;
        ready = !!id;
      } else {
        // Hidden card: the definition + primary greeting come from the chat
        // relay capture, so surface whether the server has them yet.
        const status = await ServerClient.captureStatus(name);
        statusText = `🟢 ${name} · Sys ${status.system ? "✓" : "✗"} · Greet ${status.greetings ? "✓" : "✗"}`;
        ready = !!id && status.system && status.greetings;
      }
      serverDown = false;
      Pill.setStatus(statusText);
      ExportButton.setReady(ready);
    } catch {
      serverDown = true;
      Pill.setStatus("🔴 jai-proxy (server down)");
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
