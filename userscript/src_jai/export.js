  // ---------------------------------------------------------------------------
  // Export — the whole card export is now: fetch the character JSON, fetch its
  // public lorebooks, POST /build. No DOM scraping, no greeting carousel walk.
  // Hidden cards work the same way: their definition + primary greeting are
  // already captured server-side from the chat relay, and the server merges
  // them with the JSON's alternate greetings / metadata.
  // ---------------------------------------------------------------------------
  async function fetchPublicLorebooks(character) {
    const scripts = Array.isArray(character.scripts) ? character.scripts : [];
    const ids = scripts
      .filter((s) => s && s.type === "lorebook" && s.is_public && s.id)
      .map((s) => s.id);
    if (!ids.length) return [];
    const results = await Promise.all(
      ids.map(async (id) => {
        try {
          return { id, raw: await JanitorClient.fetchScript(id) };
        } catch (err) {
          warn("lorebook fetch failed", id, err);
          return null;
        }
      })
    );
    const ok = results.filter(Boolean);
    log(`lorebooks: ${ok.length}/${ids.length} public fetched`);
    return ok;
  }

  // Resolve a character JSON, preferring the scheduler's per-page cache so a
  // freshly-viewed character page isn't refetched.
  async function resolveCharacter(id) {
    return CharacterState.cachedJson(id) || (await JanitorClient.fetchCharacter(id));
  }

  // The reusable core of a card export: resolve the character JSON (unless one
  // is supplied), fetch its public lorebooks, POST /build. Shared by the single
  // Export-card button and the bulk "download all open cards" panel. The card
  // name is no longer sent from here — the server derives the real character
  // name from the API JSON (chat_name), so there's nothing to guess or prompt
  // for. Returns the server result plus the resolved character.
  //   opts.character — a pre-fetched JSON, to avoid a second round-trip
  //   opts.url       — source URL recorded on the card (defaults to the id URL)
  async function buildCardById(id, opts = {}) {
    const character = opts.character || (await resolveCharacter(id));
    const lorebooks = await fetchPublicLorebooks(character);
    const payload = {
      character: { id, url: opts.url || CHAR_BASE + id },
      character_json: character,
      avatar_url: character.avatar ? AVATAR_BASE + character.avatar : null,
      lorebooks,
    };
    const result = await ServerClient.build(payload);
    return { result, character };
  }

  async function exportCard(el) {
    const original = el.textContent;
    el.textContent = "⏳ exporting…";
    el.disabled = true;
    let holdMs = 2500;
    try {
      const id = currentCharacterId() || GM_getValue(KEY_ID, "");
      if (!id) {
        el.textContent = "⚠️ open a character page first";
        holdMs = 5000;
        return;
      }

      // No name prompt: the server derives the real character name from the
      // API JSON (chat_name) and saves the card under it.
      const { result } = await buildCardById(id, { url: location.href });
      const warnings = result.warnings || [];
      if (result.ok) {
        log("exported card ->", result.path, warnings);
        if (warnings.length) {
          const n = warnings.length;
          const first =
            warnings[0].length > 60 ? warnings[0].slice(0, 57) + "…" : warnings[0];
          el.textContent = `⚠️ saved — ${n} warning${n === 1 ? "" : "s"}: ${first}`;
          el.title = warnings.join("\n");
          holdMs = 8000;
          warn("export warnings:", warnings);
        } else {
          el.textContent = "✅ saved";
          el.title = result.path || "";
        }
      } else {
        el.textContent = `⚠️ ${warnings[0] || "failed"}`;
        el.title = JSON.stringify(result);
        holdMs = 8000;
        warn("export failed", result);
      }
    } catch (err) {
      el.textContent = "⚠️ failed";
      el.title = String(err);
      holdMs = 8000;
      warn("export failed", err);
    } finally {
      setTimeout(() => {
        el.textContent = original;
        el.title = "";
        el.disabled = false;
      }, holdMs);
    }
  }
