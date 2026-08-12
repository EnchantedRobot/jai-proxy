// ========================================
// SETTINGS PERSISTENCE SYSTEM
// Uses SillyTavern's extensionSettings via main window for server-side storage
// Falls back to localStorage if main window unavailable
// ========================================

const SETTINGS_KEY = 'SillyTavernCharacterGallery';
const DEFAULT_SETTINGS = {
    // ---- Credentials & Auth ----
    chubToken: null,
    chubRememberToken: true,
    pygmalionEmail: null,
    pygmalionPassword: null,
    pygmalionToken: null,
    pygmalionRememberCredentials: true,
    wyvernEmail: null,
    wyvernPassword: null,
    wyvernToken: null,
    wyvernRefreshToken: null,
    wyvernUid: null,
    wyvernRememberCredentials: true,
    datacatToken: null,
    datacatPublicFeed: false,
    datacatReextractOnUpdate: false,
    // Separate from the janitorai* pair below: the refresh token is single-use and rotates, so a
    // shared pair breaks whichever provider refreshes second.
    datacatJanitoraiToken: null,
    datacatJanitoraiRefreshToken: null,
    saucepanToken: null,
    janitoraiToken: null,
    janitoraiRefreshToken: null,
    // Kept so a lapsed session can be renewed without hunting for the password again.
    janitoraiEmail: null,
    janitoraiPassword: null,
    janitoraiBrowserEndpoint: null,
    // 'managed' spawns a headless browser lazily on first real use.
    janitoraiBrowserMode: 'managed',
    janitoraiNsfw: false,
    janitoraiExtractOnUpdate: false,
    ctCookie: null,

    // ---- NSFW Toggles ----
    chubNsfw: false,
    jannyNsfw: false,
    pygmalionNsfw: false,
    wyvernNsfw: false,
    ctNsfw: false,
    datacatNsfw: false,
    saucepanNsfw: false,
    saucepanHideExtreme: false,

    // ---- Search & Sort ----
    defaultSort: 'name_asc',
    defaultFilterPreset: '',
    groupFavoritesFirst: false,
    searchInName: true,
    searchInListingName: true,
    searchInTags: true,
    searchInAuthor: false,
    searchInNotes: false,
    searchInTagline: false,
    tagIncludeMode: 'any',
    tagExcludeMode: 'all',

    // ---- Duplicate Detection ----
    duplicateMinScore: 35,

    // ---- Online / Browse ----
    possibleMatchMinScore: 65,

    // ---- Gallery & Media ----
    includeProviderGallery: true,
    includeLorebook: false,
    richCreatorNotes: true,
    expandCreatorNotes: false,
    highlightColor: '#4a9eff',
    mediaLocalizationEnabled: true,
    mediaLocalizationPerChar: {},
    importMediaAction: 'ask',
    importDirectDownloads: false,
    includeExternalGalleries: true,

    // ---- UI & Display ----
    chatCardDensity: 'comfortable',
    buttonStyle: 'glass',
    uiScale: 3,
    modalSize: 2,
    replaceUserPlaceholder: true,
    animateTagPills: true,
    animateKeepName: false,
    debugMode: false,
    // ARCHIVE FORK (see web/VENDORED.md): upstream defaults this off because a
    // SillyTavern install may hold either folder layout. This archive holds
    // exactly one -- all 3,804 gallery folders are `<Name>_<gallery_id>` -- so
    // defaulting it off makes every gallery look empty until the user finds the
    // setting.
    uniqueGalleryFolders: true,
    showInfoTab: false,
    themeCustomizer: false,
    customCSS: '',
    customCSSMode: 'raw',
    exportAsLinks: false,
    showProviderTagline: true,
    showWyvernTagline: true,
    allowRichTagline: false,
    displayNamePreference: 'card',
    displayNameOverrideEnabled: true,
    showNameToggle: true,
    namePreferences: {},
    browseSnapSections: false,
    collapseAllBrowseSections: false,
    mobileProviderQuickSwitch: true,
    mobileHideBackArrows: false,
    mobileBrowseQuickImport: true,
    mobileSwipeGestures: true,
    mobileHaptics: true,
    useGridThumbnails: false,
    gridThumbnailsDesktop: false,
    gridThumbnailsHiRes: true,
    gridThumbnailSize: 512,
    enableCharDetailNav: true,

    // ---- Provider Config ----
    chubUseV4Api: false,
    providerOrder: null,
    providerDefaults: {},
    infiniteScroll: {},
    disabledProviders: ['datacat'],
    datacatFollowedCreators: [],
    providerExcludeTags: {},

    // ---- Versions ----
    autoSnapshotOnEdit: true,
    maxAutoBackups: 10,
};

// Debug logging helper - only logs when debug mode is enabled
function debugLog(...args) {
    if (getSetting('debugMode')) {
        console.log('[Debug]', ...args);
    }
}

function debugWarn(...args) {
    if (getSetting('debugMode')) {
        console.warn('[Debug]', ...args);
    }
}

function debugError(...args) {
    if (getSetting('debugMode')) {
        console.error('[Debug]', ...args);
    } else {
        console.error(...args);
    }
}

// In-memory settings cache
let gallerySettings = { ...DEFAULT_SETTINGS };

function getHostWindow() {
    try {
        if (window.opener && !window.opener.closed) return window.opener;
    } catch { /* cross-origin */ }
    try {
        if (window.parent !== window) return window.parent;
    } catch { /* cross-origin */ }
    return null;
}

function getSTContext() {
    try {
        const host = getHostWindow();
        if (host?.SillyTavern?.getContext) {
            return host.SillyTavern.getContext();
        }
    } catch (e) {
        console.warn('[Settings] Cannot access main window context:', e);
    }
    return null;
}

// Sentinel deletes keys on current ST only; older builds would store it as a literal, so probe once and fall back to null.
const ST_UNSET_SENTINEL = '__@@UNSET@@__';
const ST_MIN_VERSION_FOR_SENTINEL = '1.13.5';
let _stSentinelProbePromise = null;

function compareSemverParts(a, b) {
    const pa = String(a || '').split('.').map(n => parseInt(n, 10) || 0);
    const pb = String(b || '').split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const x = pa[i] || 0, y = pb[i] || 0;
        if (x !== y) return x - y;
    }
    return 0;
}

async function probeSTSentinelSupport() {
    // Function-presence check beats version sniffing: doesnt depend on getContext exposing a version field.
    try {
        const ctx = getSTContext();
        if (ctx) {
            if (typeof ctx.writeExtensionField === 'function') { debugLog('[ST sentinel] detected via getContext().writeExtensionField'); return true; }
            if (ctx.UNSET_VALUE === ST_UNSET_SENTINEL) { debugLog('[ST sentinel] detected via getContext().UNSET_VALUE'); return true; }
            const ctxVersion = ctx.applicationVersion || ctx.appVersion || ctx.version;
            if (ctxVersion && compareSemverParts(String(ctxVersion), ST_MIN_VERSION_FOR_SENTINEL) >= 0) { debugLog('[ST sentinel] detected via getContext() version:', ctxVersion); return true; }
        }
    } catch { /* host window may be cross-origin or opener-detached in re-opened tabs */ }
    try {
        // /api/extensions/version exists on current ST and returns plain text version.
        const resp = await fetch('/api/extensions/version', { headers: getRequestHeaders() });
        if (resp.ok) {
            const v = (await resp.text()).trim();
            if (v && compareSemverParts(v, ST_MIN_VERSION_FOR_SENTINEL) >= 0) { debugLog('[ST sentinel] detected via /api/extensions/version:', v); return true; }
        }
    } catch { /* endpoint may not exist on older ST */ }
    try {
        // /settings/get response wraps a stringified settings JSON; the app_version field hides inside that.
        const st = await fetchStSettings();
        if (st) {
            const v = st.data?.appVersion || st.data?.applicationVersion || st.data?.version || st.settings?.app_version || st.settings?.applicationVersion;
            if (v && compareSemverParts(String(v), ST_MIN_VERSION_FOR_SENTINEL) >= 0) { debugLog('[ST sentinel] detected via /settings/get:', v); return true; }
        }
    } catch { /* network or 404 */ }
    debugLog('[ST sentinel] NOT detected; falling back to null-as-delete (broken on ST < 1.13.5)');
    return false;
}

// Sentinel when ST supports it, else null (older ST cant delete keys, so they accumulate).
async function getExtensionDeleteValue() {
    if (!_stSentinelProbePromise) _stSentinelProbePromise = probeSTSentinelSupport();
    return (await _stSentinelProbePromise) ? ST_UNSET_SENTINEL : null;
}


// One POST /settings/get with the stringified-settings unwrap; callers read their own
// fields off the result. Returns { data, settings } or null on any failure.
async function fetchStSettings() {
    try {
        const response = await apiRequest('/settings/get', 'POST', {});
        if (!response.ok) return null;
        const data = await response.json();
        const settings = typeof data.settings === 'string' ? JSON.parse(data.settings) : data.settings;
        return { data, settings: settings || null };
    } catch (e) {
        // Callers pick their own fallback; the diagnostic lives here so they dont each re-log.
        console.warn('[Settings] /settings/get fetch failed:', e?.message || e);
        return null;
    }
}

// Fire-and-forget; 3s timeout. Active chat panel refreshes only when chid matches.
async function notifySTCharacterEdited(avatar) {
    if (!avatar) return;
    const run = async () => {
        try {
            const host = getHostWindow();
            const ctx = host?.SillyTavern?.getContext?.();
            if (!ctx) return;

            if (typeof ctx.getOneCharacter === 'function') {
                await ctx.getOneCharacter(avatar);
            }

            const charIndex = ctx.characters?.findIndex(c => c.avatar === avatar);
            if (charIndex === undefined || charIndex < 0) return;

            // characterId is a snapshot, not a live ref - re-read after the await.
            const currentChid = host?.SillyTavern?.getContext?.()?.characterId;
            const isActive = currentChid !== undefined && currentChid !== null
                && String(currentChid) === String(charIndex);

            // selectCharacterById on the active chid keeps chat + scroll intact.
            if (isActive && typeof ctx.selectCharacterById === 'function') {
                await ctx.selectCharacterById(charIndex, { switchMenu: false });
            }

            if (ctx.eventSource && ctx.event_types?.CHARACTER_EDITED) {
                await ctx.eventSource.emit(
                    ctx.event_types.CHARACTER_EDITED,
                    { id: charIndex, character: ctx.characters[charIndex] }
                );
            }
        } catch (e) {
            console.warn('[CL] Could not notify main window of edit (non-fatal):', e);
        }
    };
    await Promise.race([run(), new Promise(r => setTimeout(r, 3000))]);
}

async function notifySTCharacterAdded(avatar) {
    if (!avatar) return;
    const run = async () => {
        try {
            const host = getHostWindow();
            const ctx = host?.SillyTavern?.getContext?.();
            if (typeof ctx?.getCharacters !== 'function') return;
            await new Promise(r => setTimeout(r, 200));
            await ctx.getCharacters();
        } catch (e) {
            console.warn('[CL] Could not notify main window of add (non-fatal):', e);
        }
    };
    await Promise.race([run(), new Promise(r => setTimeout(r, 3000))]);
}

/**
 * Get the active persona name from SillyTavern
 * @returns {string} The persona name or '{{user}}' if unavailable or disabled
 */
function getPersonaName() {
    if (getSetting('replaceUserPlaceholder') === false) {
        return '{{user}}';
    }
    try {
        const context = getSTContext();
        if (context) {
            // ST stores the user's name in name1 or user_name
            return context.name1 || context.user_name || '{{user}}';
        }
    } catch (e) {
        console.warn('[Persona] Cannot get persona name:', e);
    }
    return '{{user}}';
}

/**
 * Load settings from SillyTavern's settings.json on disk via API
 * Falls back to opener's in-memory extensionSettings, then localStorage
 */
async function loadGallerySettings() {
    // Try to load fresh from disk via ST's settings API (authoritative source)
    try {
        const st = await fetchStSettings();
        if (st) {
            const parsedSettings = st.settings;
            // Key in settings.json on disk is snake_case "extension_settings"
            // (ST's context API uses camelCase "extensionSettings", but the raw file doesn't)
            if (parsedSettings?.extension_settings?.[SETTINGS_KEY]) {
                gallerySettings = { ...DEFAULT_SETTINGS, ...parsedSettings.extension_settings[SETTINGS_KEY] };
                // localStorage is written synchronously by saveGallerySettings() and may
                // contain changes that haven't flushed to disk yet (debounced save window)
                try {
                    const stored = localStorage.getItem(SETTINGS_KEY);
                    if (stored) {
                        const localData = JSON.parse(stored);
                        if (localData.namePreferences && Object.keys(localData.namePreferences).length) {
                            gallerySettings.namePreferences = localData.namePreferences;
                        }
                    }
                } catch (_) { /* ignore */ }
                debugLog('[Settings] Loaded fresh from disk via /api/settings/get', gallerySettings);
                // Live namespace keys win over the disk read (they may carry another CL
                // instance's not-yet-flushed changes); defaults+disk fill the gaps so
                // ST-side readers keep seeing the full key set.
                const context = getSTContext();
                if (context && context.extensionSettings) {
                    const merged = { ...gallerySettings, ...(context.extensionSettings[SETTINGS_KEY] || {}) };
                    context.extensionSettings[SETTINGS_KEY] = merged;
                    gallerySettings = { ...merged };
                }
                return;
            }
            debugLog('[Settings] No extension settings found on disk for key:', SETTINGS_KEY, 'keys found:', Object.keys(parsedSettings?.extension_settings || {}));
        }
    } catch (e) {
        console.warn('[Settings] Failed to load from API, trying fallbacks:', e);
    }

    // Fallback: opener's in-memory extensionSettings
    const context = getSTContext();
    if (context && context.extensionSettings) {
        if (!context.extensionSettings[SETTINGS_KEY]) {
            context.extensionSettings[SETTINGS_KEY] = { ...DEFAULT_SETTINGS };
        }
        gallerySettings = { ...DEFAULT_SETTINGS, ...context.extensionSettings[SETTINGS_KEY] };
        debugLog('[Settings] Loaded from SillyTavern extensionSettings (in-memory fallback)');
        return;
    }
    
    // Final fallback: localStorage
    try {
        const stored = localStorage.getItem(SETTINGS_KEY);
        if (stored) {
            gallerySettings = { ...DEFAULT_SETTINGS, ...JSON.parse(stored) };
            debugLog('[Settings] Loaded from localStorage (fallback)');
        }
    } catch (e) {
        console.warn('[Settings] Failed to load from localStorage:', e);
    }
}

