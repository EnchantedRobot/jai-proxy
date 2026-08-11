// ========================================
// Additional character lorebooks (charLore)
// ========================================

// ST stores these in client module state + settings.json (keyed by avatar filename minus
// extension), not on the card. Live reads/writes go through the __clCharLore accessor the
// ST-side index.js puts on ST's window; without that handle (opener closed, tab opened from
// a bookmark) reads fall back to the persisted settings copy and writes are refused.
function getCharLoreBridge() {
    try {
        const host = getHostWindow();
        return host?.__clCharLore || null;
    } catch { return null; }
}

window.canEditCharLore = function() {
    return !!getCharLoreBridge();
};

// Fallback-path cache only: the settings blob read can lag ST's debounced save anyway,
// so a short TTL costs nothing; bridge reads stay live so our own writes are never stale.
let _charLoreSettingsCache = { at: 0, data: null };

window.getAllCharLore = async function() {
    // ARCHIVE FORK: the archive has no charLore store, so the honest answer is
    // "unreadable", and it must be given before any of the reads below can
    // succeed at returning an empty list instead.
    //
    // null and [] are not interchangeable here. Batch-transfer omits auxWorlds
    // from a bundle manifest on null, and writes `auxWorlds: []` on []. An
    // explicit [] means "restore NO lorebooks" to an importing SillyTavern, so
    // it silently strips lorebook links from every card it overwrites.
    //
    // Standalone, the settings read below now *succeeds* (it returns the
    // archive's own settings from data/settings.json), and a successful read
    // with no world_info_settings yields [] -- the destructive value. This
    // exact bug shipped once already, via an adapter stub that returned
    // `{ settings: {} }`, and put `auxWorlds: []` on all 94 characters of a
    // test bundle. Restore this to upstream only alongside a real
    // additional-lorebook store.
    return null;

    // eslint-disable-next-line no-unreachable
    const bridge = getCharLoreBridge();
    if (bridge) {
        try {
            const list = await bridge.list();
            if (Array.isArray(list)) return list;
        } catch { /* fall through to settings read */ }
    }
    if (Date.now() - _charLoreSettingsCache.at < 15000 && _charLoreSettingsCache.data) {
        return _charLoreSettingsCache.data;
    }
    const st = await fetchStSettings();
    // null = NO source succeeded; distinct from [] = readable and genuinely empty.
    // Batch-transfer keys destructive-vs-omit manifest semantics on this difference,
    // so a response without a parseable settings blob is also "not readable".
    if (!st?.settings) return null;
    const charLore = st.settings.world_info_settings?.world_info?.charLore;
    const list = Array.isArray(charLore) ? charLore : [];
    _charLoreSettingsCache = { at: Date.now(), data: list };
    return list;
};

// The charLore key for an avatar: filename minus extension, ST's getCharaFilename shape.
// The index.js bridge keeps its own copy (ST realm, cant import from here).
window.charLoreKey = function(avatar) {
    return String(avatar || '').replace(/\.[^/.]+$/, '');
};

/**
 * The additional (aux) lorebook names for one character.
 * @param {string} avatar - avatar filename (extension ok, stripped internally)
 * @returns {Promise<string[]>}
 */
window.getCharAdditionalLorebooks = async function(avatar) {
    const key = window.charLoreKey(avatar);
    if (!key) return [];
    const bridge = getCharLoreBridge();
    if (bridge) {
        try {
            const books = await bridge.getFor(avatar);
            if (Array.isArray(books)) return books;
        } catch { /* fall through to the list read */ }
    }
    const all = await window.getAllCharLore();
    const entry = (all || []).find(e => e?.name === key);
    const books = Array.isArray(entry?.extraBooks) ? entry.extraBooks : [];
    return [...new Set(books.filter(b => typeof b === 'string' && b))];
};

/**
 * Replace a character's additional lorebook list. Requires the ST window (live write).
 * @param {string} avatar
 * @param {string[]} books
 * @returns {Promise<boolean>} Success
 */
window.setCharAdditionalLorebooks = async function(avatar, books) {
    const bridge = getCharLoreBridge();
    if (!bridge) return false;
    try {
        return (await bridge.set(avatar, books)) === true;
    } catch {
        return false;
    }
};

/**
 * Primitive card-write operation. Takes a char object directly (caller already has the ref).
 * Hydrates the char, preflight-cleans null pollution, builds the merge-attributes payload,
 * sends it, and syncs in-memory state on both the passed char and the matching allCharacters entry.
 *
 * Does NOT do convenience side effects (gallery folder rename, ST main-window notify). Callers
 * that want those should use applyCardFieldUpdates instead.
 *
 * @param {Object} char - the character object (live ref, mutated in place).
 * @param {Object<string, *>} fieldUpdates - dot-path keys to values. Pass ST_UNSET_SENTINEL as value to delete an extension key (e.g. {'extensions.chub': ST_UNSET_SENTINEL}).
 * @returns {Promise<{ok: boolean, response?: Response}>}
 */
async function writeCardFields(char, fieldUpdates, opts = {}) {
    if (!char) {
        console.error('[writeCardFields] No char provided');
        return { ok: false };
    }

    try {
        // Must hydrate before building the merge payload - slim chars lack heavy fields
        // and sending undefined would erase existing content on the server.
        await hydrateCharacter(char);

        // PRE-FLIGHT: sentinel-delete null-valued extension keys before the main write; ST otherwise drops object writes aimed at a null namespace. No-op on older ST.
        const existingExtRaw = char.data?.extensions || char.extensions || {};
        const polluted = Object.keys(existingExtRaw).filter(k => existingExtRaw[k] === null);
        if (polluted.length > 0) {
            const deleteValue = await getExtensionDeleteValue();
            if (deleteValue !== null) {
                try {
                    const cleanupExt = {};
                    for (const k of polluted) cleanupExt[k] = deleteValue;
                    await apiRequest('/characters/merge-attributes', 'POST', {
                        avatar: char.avatar,
                        create_date: char.create_date,
                        data: { extensions: cleanupExt, create_date: char.create_date },
                    });
                    // Mirror server-side cleanup in memory so the main payload spread doesnt carry the null forward.
                    for (const k of polluted) delete char.data.extensions[k];
                } catch (cleanupErr) {
                    console.warn('[writeCardFields] Null-pollution cleanup failed; main payload may still trip ST deepMerge:', cleanupErr);
                }
            }
        }

        // Build update payload preserving all existing data
        const existingExtensions = char.data?.extensions || char.extensions || {};
        const existingCreateDate = char.create_date;
        const existingSpec = char.spec || char.data?.spec;
        const existingSpecVersion = char.spec_version || char.data?.spec_version;
        const existingData = char.data || {};

        // Treat null/undefined alike when descending so legacy null-polluted namespaces dont throw on the leaf write.
        const setNestedValue = (obj, path, value) => {
            const keys = path.split('.');
            const lastKey = keys.pop();
            const target = keys.reduce((o, k) => {
                if (o[k] == null) o[k] = {};
                return o[k];
            }, obj);
            target[lastKey] = value;
        };

        // Resolve SENTINEL values centrally so callers can pass ST_UNSET_SENTINEL freely; degrades to null on old ST.
        const deleteValue = await getExtensionDeleteValue();
        const resolvedUpdates = {};
        for (const [field, value] of Object.entries(fieldUpdates)) {
            resolvedUpdates[field] = value === ST_UNSET_SENTINEL ? deleteValue : value;
        }

        // Start with existing data
        const updatedData = { ...existingData };
        // Deep-clone the extensions subtree so a nested write (eg. extensions.chub.tagline) mutates this
        // copy, not the live char.data.extensions, until the round trip succeeds.
        updatedData.extensions = (existingExtensions && typeof existingExtensions === 'object')
            ? JSON.parse(JSON.stringify(existingExtensions))
            : {};

        for (const [field, value] of Object.entries(resolvedUpdates)) {
            const mapped = field.startsWith('depth_prompt.') ? 'extensions.' + field : field;
            setNestedValue(updatedData, mapped, value);
        }

        const payload = {
            avatar: char.avatar,
            ...(existingSpec && { spec: existingSpec }),
            ...(existingSpecVersion && { spec_version: existingSpecVersion }),
            name: updatedData.name,
            description: updatedData.description,
            first_mes: updatedData.first_mes,
            personality: updatedData.personality,
            scenario: updatedData.scenario,
            mes_example: updatedData.mes_example,
            system_prompt: updatedData.system_prompt,
            post_history_instructions: updatedData.post_history_instructions,
            creator_notes: updatedData.creator_notes,
            creator: updatedData.creator,
            character_version: updatedData.character_version,
            tags: updatedData.tags,
            alternate_greetings: updatedData.alternate_greetings,
            character_book: updatedData.character_book,
            create_date: existingCreateDate,
            data: updatedData,
            // Root-only fields (chat, fav, create_date) live outside data; ST's
            // import strips them and dot-path updates cant reach them.
            ...(opts.rootFields || {}),
        };

        const response = await apiRequest('/characters/merge-attributes', 'POST', payload);
        if (!response.ok) {
            console.error('[writeCardFields] API error:', response.status);
            return { ok: false, response };
        }

        // Strip resolved sentinels from the in-memory copy so readers never see the literal wire value.
        const cleanSentinels = (obj) => {
            if (!obj || typeof obj !== 'object') return;
            for (const k of Object.keys(obj)) {
                if (obj[k] === ST_UNSET_SENTINEL) delete obj[k];
                else if (obj[k] && typeof obj[k] === 'object') cleanSentinels(obj[k]);
            }
        };
        cleanSentinels(updatedData);

        // In-memory sync. Mutate the passed char and the matching allCharacters entry (which may be the same reference or different).
        char.data = updatedData;
        for (const [field, value] of Object.entries(fieldUpdates)) {
            if (!field.includes('.') && value !== ST_UNSET_SENTINEL) char[field] = value;
        }
        for (const [field, value] of Object.entries(opts.rootFields || {})) char[field] = value;
        const charIndex = allCharacters.findIndex(c => c.avatar === char.avatar);
        if (charIndex !== -1 && allCharacters[charIndex] !== char) {
            allCharacters[charIndex].data = updatedData;
            for (const [field, value] of Object.entries(fieldUpdates)) {
                if (!field.includes('.') && value !== ST_UNSET_SENTINEL) allCharacters[charIndex][field] = value;
            }
            for (const [field, value] of Object.entries(opts.rootFields || {})) allCharacters[charIndex][field] = value;
        }
        if (updatedData.extensions) _extensionsCache.set(char.avatar, updatedData.extensions);
        // Under ST lazy loading the post-save refetch restores the cached estimate, so refresh it at the write.
        if (TOKEN_ESTIMATE_FIELDS.some(f => f in fieldUpdates)) {
            const tok = computeTokenEstimate(char);
            char._tokenEstimate = tok;
            if (charIndex !== -1) allCharacters[charIndex]._tokenEstimate = tok;
            _tokenEstimateCache.set(char.avatar, tok);
        }

        // The Online In-Library lookup base is keyed on name+creator; a surgical write that
        // changes either must invalidate it (other edit paths refresh via fetchCharacters).
        const touchedNameOrCreator = Object.keys(fieldUpdates).some(
            f => f === 'name' || f === 'creator' || f.endsWith('.name') || f.endsWith('.creator')
        );
        if (touchedNameOrCreator) window.ProviderRegistry?.invalidateBrowseLookupBase?.();

        return { ok: true, response };
    } catch (error) {
        console.error('[writeCardFields] Error:', error);
        return { ok: false };
    }
}

/**
 * Convenience wrapper for callers that have an avatar but not a char ref.
 * Looks up the char, calls writeCardFields, then runs convenience side effects:
 *   - Gallery folder rename if data.name changed.
 *   - notifySTCharacterEdited to refresh ST main window.
 *
 * Orchestrators with their own gallery-rename or ST-notify logic should call writeCardFields
 * directly to avoid duplicate side effects.
 *
 * @param {string} avatar - Character avatar filename
 * @param {Object} fieldUpdates - Object with field paths as keys (supports dot notation)
 * @param {Object} [opts] - awaitNotify: await the ST resync before returning, so a follow-on implicit card save cannot clobber this write. rootFields: payload-root key/values for fields ST keeps outside data (chat, fav, create_date).
 * @returns {Promise<boolean>} Success status
 */
window.applyCardFieldUpdates = async function(avatar, fieldUpdates, opts = {}) {
    const char = allCharacters.find(c => c.avatar === avatar);
    if (!char) {
        console.error('[applyCardFieldUpdates] Character not found:', avatar);
        return false;
    }

    // Capture name BEFORE write for gallery-rename comparison. writeCardFields will mutate char.data in place.
    const oldName = char.data?.name || char.name || '';

    const result = await writeCardFields(char, fieldUpdates, { rootFields: opts.rootFields });
    if (!result.ok) return false;

    // Convenience side effects. Failure here doesn't roll back the write.
    try {
        const newName = char.data?.name || char.name || '';
        if (oldName && newName && oldName !== newName) {
            const galleryId = getCharacterGalleryId(char);
            if (galleryId && getSetting('uniqueGalleryFolders')) {
                await handleGalleryFolderRename(char, oldName, newName, galleryId);
            }
        }
        // awaitNotify resyncs ST in-memory before ST's openCharacterChat implicit-save can clobber this out-of-band write
        if (opts.awaitNotify) {
            await notifySTCharacterEdited(avatar);
        } else {
            notifySTCharacterEdited(avatar);
        }
    } catch (sideErr) {
        console.warn('[applyCardFieldUpdates] Side effect failed (write succeeded):', sideErr);
    }

    debugLog('[applyCardFieldUpdates] Updated', Object.keys(fieldUpdates).length, 'fields for:', avatar);
    return true;
};
window.writeCardFields = writeCardFields;

// Expose allCharacters as a getter so CoreAPI always gets current value
Object.defineProperty(window, 'allCharacters', {
    get: () => allCharacters,
    configurable: true
});

// Expose currentCharacters as a getter for filtered/displayed characters
Object.defineProperty(window, 'currentCharacters', {
    get: () => currentCharacters,
    configurable: true
});

// Expose activeChar with getter/setter for CoreAPI (used by openProviderLinkModal)
Object.defineProperty(window, 'activeChar', {
    get: () => activeChar,
    set: (char) => { activeChar = char; },
    configurable: true
});
