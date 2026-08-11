/**
 * Media Dedup & Failure Ledger
 *
 * Fork-local module. Owns the two decisions the media download loops used to
 * make inline, so the loops themselves stay near-upstream and easy to rebase:
 *
 *   1. "Do we already have this file?" — answered BEFORE any bytes move, from
 *      an on-disk name index that is extension-agnostic. A remote .webp matches
 *      a local .png as long as the name matches; the stored extension only ever
 *      reflects what the source happened to serve that day.
 *
 *   2. "Is this URL worth retrying?" — answered from a persistent per-URL
 *      ledger. A 404 is permanent: recording it stops the character from being
 *      re-scanned forever. Transient failures (timeouts, 5xx, rate limits) keep
 *      retrying until they exhaust MAX_TRANSIENT_ATTEMPTS.
 *
 * The name check matters most for sources whose per-file fetch is expensive.
 * MEGA is the extreme case: reaching the content hash costs an extra API call,
 * a full ciphertext download and an AES-CTR decrypt per file, all discarded on
 * a dup. Extractors already resolve a real filename, so we key on that.
 *
 * Both loops (library.js downloadEmbeddedMediaForCharacter and
 * provider-interface.js downloadGallery) call in here.
 */

import CoreAPI from './core-api.js';

// ========================================
// CONSTANTS
// ========================================

const LEDGER_FILE = '_cl_media_dead_urls.json';
const LEDGER_VERSION = 1;

// Flip to true, reload once, then flip back to forget every recorded failure and
// retry the lot. A code switch rather than a settings toggle on purpose: this is
// a fork, and one less upstream file touched is one less rebase conflict.
const RESET_LEDGER_ON_LOAD = false;

// Ledger is global (the same dead catbox link shows up across many cards), so
// cap it and evict least-recently-touched entries.
const MAX_LEDGER_ENTRIES = 5000;

// Consecutive transient failures before a URL is given up on. Runs 1..N-1 still
// count as errors (character stays incomplete); the Nth retires it as dead.
const MAX_TRANSIENT_ATTEMPTS = 4;

// Below this a name is too generic to dedup on safely.
const MIN_KEY_LENGTH = 4;

// A match smaller than this is treated as a truncated/empty file.
const MIN_VALID_SIZE = 1024;

// Statuses that will never succeed on retry. 401/403 stay transient: hotlink
// protection and Cloudflare interstitials do clear up.
const PERMANENT_HTTP = new Set([400, 404, 410, 451]);

// Failure text from downloadMediaToMemory that can't be an HTTP status.
const PERMANENT_ERROR_TEXT = [
    /invalid url/i,
    /blocked scheme/i,
    /blocked hostname/i,
    /empty hostname/i,
    /blocked private/i,
    // ST core's /images/upload rejects any format outside its own MEDIA_EXTENSIONS
    // whitelist (svg and avif aren't in it as of this writing). No retry fixes that
    // — it's a save-step failure, not a network hiccup, so ledger it like a 404.
    /invalid image format/i,
];

// Extractor-level failures (whole gallery page, not one file) that won't heal.
const PERMANENT_EXTRACTION_TEXT = [
    /\berror -9\b/,                   // MEGA ENOENT — folder deleted
    /\berror -2\b/,                   // MEGA EARGS — malformed handle/key
    /no image files found/i,
    /empty folder or access denied/i,
    /invalid .*(?:url|key)/i,
    /no extractor matched/i,
    /url rejected/i,
];

// Filenames the pipeline writes: {prefix}_{index}_{name}.{ext}
const PREFIXED_NAME_RE = /^(?:localized_media|lorebook_media|[a-z]+gallery)_[A-Za-z0-9]+_(.+)$/;

const MEDIA_EXT_RE = /\.(png|jpg|jpeg|webp|gif|bmp|svg|avif|mp3|wav|ogg|m4a|flac|aac|mp4|webm|mov)$/i;

// Mirrors the priority ladder in library.js: a file already carrying a
// higher-priority prefix is never reclassified down to a lower one.
const PREFIX_PRIORITY = { localized_media: 4, lorebook_media: 3, extgallery: 2 };

// ========================================
// NAME KEYS
// ========================================

/**
 * Normalize a bare filename into a dedup key: extension dropped, sanitized the
 * same way library.js sanitizes URL-derived names, lowercased for lookup.
 * @param {string} name
 * @returns {string}
 */
export function mediaKey(name) {
    if (!name || typeof name !== 'string') return '';
    const base = name.includes('.') ? name.substring(0, name.lastIndexOf('.')) : name;
    return base.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 40).toLowerCase();
}

/**
 * Candidate dedup keys for one download, most specific first.
 *
 * Both are checked because they can disagree: files saved before this module
 * existed were named from the URL, while new saves prefer the extractor's real
 * filename. Checking both means an upgrade doesn't re-download the library.
 *
 * @param {string} url
 * @param {string} [filename] - extractor-supplied real filename, if any
 * @returns {string[]}
 */
export function keysForItem(url, filename) {
    const keys = [];
    const fromName = mediaKey(filename);
    if (fromName.length >= MIN_KEY_LENGTH) keys.push(fromName);
    const fromUrl = mediaKey(CoreAPI.extractSanitizedUrlName(url) || '');
    if (fromUrl.length >= MIN_KEY_LENGTH && !keys.includes(fromUrl)) keys.push(fromUrl);
    return keys;
}

/**
 * The name a new file should be saved under. Prefers the extractor's filename
 * so synthetic URLs (mega://folder/handle) stop producing opaque names.
 * Returns '' when there is no usable hint — caller keeps its URL-derived name.
 * @param {string} url
 * @param {string} [filename]
 * @returns {string}
 */
export function saveNameFor(url, filename) {
    const fromName = mediaKey(filename);
    return fromName.length >= MIN_KEY_LENGTH ? fromName : '';
}

function prefixPriority(fileName) {
    for (const [p, v] of Object.entries(PREFIX_PRIORITY)) {
        if (fileName.startsWith(p + '_')) return v;
    }
    return /^[a-z]+gallery_/.test(fileName) ? 1 : 0;
}

// ========================================
// ON-DISK INDEX
// ========================================

/**
 * Index every media file in a gallery folder by dedup key.
 *
 * Unlike the prefix-only index this replaces, unprefixed files (manual uploads,
 * older naming schemes) are indexed under their own name, so they count as
 * "already have it" too.
 *
 * @param {string} folderName
 * @returns {Promise<Map<string, {fileName: string, localPath: string}>>}
 */
export async function buildFileIndex(folderName) {
    const index = new Map();
    // Canonical (prefix-stripped) keys win over raw-filename keys.
    const strongKeys = new Set();

    const add = (key, entry, strong) => {
        if (!key || key.length < MIN_KEY_LENGTH) return;
        if (!strong && strongKeys.has(key)) return;
        index.set(key, entry);
        if (strong) strongKeys.add(key);
    };

    try {
        const endpoints = CoreAPI.getEndpoints?.() || {};
        const response = await CoreAPI.apiRequest(endpoints.IMAGES_LIST || '/images/list', 'POST', {
            folder: folderName,
            type: 7,
        });
        if (!response.ok) return index;

        const files = await response.json();
        if (!files || files.length === 0) return index;

        const safeFolderName = CoreAPI.sanitizeFolderName(folderName);

        for (const file of files) {
            const fileName = (typeof file === 'string') ? file : file.name;
            if (!fileName || !MEDIA_EXT_RE.test(fileName)) continue;

            const localPath = `/user/images/${encodeURIComponent(safeFolderName)}/${encodeURIComponent(fileName)}`;
            const entry = { fileName, localPath };
            const nameNoExt = fileName.includes('.')
                ? fileName.substring(0, fileName.lastIndexOf('.'))
                : fileName;

            const stripped = nameNoExt.match(PREFIXED_NAME_RE);
            if (stripped) add(mediaKey(stripped[1]), entry, true);
            add(mediaKey(nameNoExt), entry, false);
        }
    } catch (error) {
        console.error('[MediaDedup] Error building file index:', error);
    }

    CoreAPI.debugLog(`[MediaDedup] Indexed ${index.size} key(s) for ${folderName}`);
    return index;
}

async function validateFileByHead(localPath) {
    try {
        const resp = await fetch(localPath, { method: 'HEAD' });
        if (!resp.ok) return false;
        return parseInt(resp.headers.get('Content-Length') || '0', 10) >= MIN_VALID_SIZE;
    } catch {
        return false;
    }
}

/**
 * Decide whether an already-present local file lets us skip this download.
 *
 * @param {{url: string, filename?: string}} item
 * @param {Object} ctx
 * @param {Map} ctx.index - from buildFileIndex
 * @param {string} [ctx.prefix] - prefix this phase writes ('localized_media', …)
 * @param {boolean} [ctx.validateHeaders] - HEAD-check the match's size
 * @param {boolean} [ctx.fixFilenames] - let mis-prefixed matches fall through
 *   to the hash path so they get reclassified
 * @returns {Promise<{fileName: string, localPath: string}|null>} match to skip on, or null to download
 */
export async function findExistingFile(item, ctx = {}) {
    const { index, prefix = '', validateHeaders = false, fixFilenames = false } = ctx;
    if (!index || index.size === 0) return null;

    let match = null;
    for (const key of keysForItem(item?.url, item?.filename)) {
        match = index.get(key);
        if (match) break;
    }
    if (!match) return null;

    // Wrong prefix and we're allowed to upgrade it: take the slow path so the
    // rename/reclassify logic runs. Never downgrade a higher-priority prefix.
    if (fixFilenames && prefix && !match.fileName.startsWith(prefix + '_')) {
        if (prefixPriority(match.fileName) < (PREFIX_PRIORITY[prefix] || 0)) {
            CoreAPI.debugLog(`[MediaDedup] Name match bypassed (wrong prefix): ${match.fileName} needs ${prefix}_*`);
            return null;
        }
    }

    if (validateHeaders && !(await validateFileByHead(match.localPath))) {
        CoreAPI.debugLog(`[MediaDedup] Name match rejected (HEAD validation): ${match.fileName}`);
        return null;
    }

    return match;
}

/**
 * Register a freshly saved file so later phases in the same run skip it.
 * @param {Map} index
 * @param {{url: string, filename?: string}} item
 * @param {{fileName: string, localPath?: string}} saved
 */
export function noteSavedFile(index, item, saved) {
    if (!index || !saved?.fileName) return;
    const entry = { fileName: saved.fileName, localPath: saved.localPath || '' };
    for (const key of keysForItem(item?.url, item?.filename)) index.set(key, entry);
}

// ========================================
// FAILURE CLASSIFICATION
// ========================================

/**
 * @param {Object} result - downloadMediaToMemory failure result
 * @returns {{permanent: boolean, status: number|null, message: string}}
 */
export function classifyFailure(result) {
    const message = result?.error || 'Download failed';
    if (result?.blocked) return { permanent: true, status: null, message };

    const status = typeof result?.status === 'number' ? result.status : null;
    if (status !== null) return { permanent: PERMANENT_HTTP.has(status), status, message };

    if (PERMANENT_ERROR_TEXT.some(re => re.test(message))) {
        return { permanent: true, status: null, message };
    }
    // Includes content-validation failures (server served HTML/junk). Left
    // transient on purpose: the bytes are already paid for, and a CDN error
    // page is not proof the file is gone.
    return { permanent: false, status: null, message };
}

/**
 * Same, for a whole gallery page that failed to extract.
 * @param {string} message
 * @returns {{permanent: boolean, status: null, message: string}}
 */
export function classifyExtractionFailure(message) {
    const msg = message || 'Extraction failed';
    return {
        permanent: PERMANENT_EXTRACTION_TEXT.some(re => re.test(msg)),
        status: null,
        message: msg,
    };
}

/** Aborts and timeouts are user/runtime events, never URL health signals. */
export function isAbortLike(err) {
    return err?.name === 'AbortError' || err?.name === 'TimeoutError';
}

// ========================================
// DEAD URL LEDGER
// ========================================

let _ledger = null;
let _loadPromise = null;
let _saving = false;
let _saveQueued = false;
let _dirty = false;
let _saveTimer = 0;

// Callers flush explicitly at the end of a pipeline run, but aborted runs and
// reloads shouldn't lose what we learned, so writes also self-schedule.
function scheduleSave() {
    if (_saveTimer) return;
    _saveTimer = setTimeout(() => { _saveTimer = 0; flushLedger(); }, 2000);
}

/**
 * Entry shape (short keys — this file can hold thousands):
 *   n: attempt count, f: first seen, l: last attempt,
 *   p: 1 when known-permanent, s: last HTTP status, e: last error text
 */

async function readLedgerFile() {
    try {
        const resp = await fetch(`/user/files/${LEDGER_FILE}`, { cache: 'no-store' });
        if (!resp.ok) return null;
        const text = await resp.text();
        if (!text || !text.trim()) return null;
        return JSON.parse(text);
    } catch {
        return null;
    }
}

/** Load the ledger. Safe to call repeatedly; the read happens once. */
export async function loadLedger() {
    if (_ledger) return _ledger;
    if (_loadPromise) return _loadPromise;
    _loadPromise = (async () => {
        if (RESET_LEDGER_ON_LOAD) {
            _ledger = new Map();
            _dirty = true;
            _loadPromise = null;
            console.log('[MediaDedup] RESET_LEDGER_ON_LOAD is set — every recorded failure will be retried');
            await flushLedger();
            return _ledger;
        }
        const data = await readLedgerFile();
        const urls = (data && data.version === LEDGER_VERSION && data.urls && typeof data.urls === 'object')
            ? data.urls
            : {};
        _ledger = new Map(Object.entries(urls));
        _loadPromise = null;
        CoreAPI.debugLog(`[MediaDedup] Ledger loaded (${_ledger.size} URL(s))`);
        return _ledger;
    })();
    return _loadPromise;
}

function evictIfNeeded() {
    if (_ledger.size <= MAX_LEDGER_ENTRIES) return;
    const sorted = [..._ledger.entries()].sort((a, b) => (a[1].l || 0) - (b[1].l || 0));
    const drop = _ledger.size - MAX_LEDGER_ENTRIES;
    for (let i = 0; i < drop; i++) _ledger.delete(sorted[i][0]);
}

/** Persist the ledger. Coalesces concurrent writers like the queue file does. */
export async function flushLedger() {
    if (!_ledger || !_dirty) return false;
    if (_saving) { _saveQueued = true; return false; }
    _saving = true;
    _dirty = false;
    let ok = false;
    try {
        evictIfNeeded();
        const payload = { version: LEDGER_VERSION, urls: Object.fromEntries(_ledger) };
        const base64 = CoreAPI.utf8ToBase64(JSON.stringify(payload));
        const resp = await CoreAPI.apiRequest('/files/upload', 'POST', { name: LEDGER_FILE, data: base64 });
        ok = resp.ok;
        if (!ok) {
            _dirty = true;
            console.warn('[MediaDedup] Ledger save failed:', resp.status);
        }
    } catch (e) {
        _dirty = true;
        console.warn('[MediaDedup] Ledger save failed:', e?.message || e);
    } finally {
        _saving = false;
        if (_saveQueued) { _saveQueued = false; flushLedger(); }
    }
    return ok;
}

/**
 * Should this URL be skipped without contacting the network?
 * @param {string} url
 * @returns {boolean}
 */
export function isDead(url) {
    const entry = _ledger?.get(url);
    if (!entry) return false;
    return entry.p === 1 || (entry.n || 0) >= MAX_TRANSIENT_ATTEMPTS;
}

/** Human-readable reason for a dead URL, for logs and the summary UI. */
export function deadReason(url) {
    const entry = _ledger?.get(url);
    if (!entry) return '';
    if (entry.p === 1) return entry.s ? `HTTP ${entry.s}` : (entry.e || 'permanently unavailable');
    return `failed ${entry.n} times (${entry.e || 'unknown'})`;
}

/**
 * Record a failed attempt.
 * @param {string} url
 * @param {{permanent: boolean, status: number|null, message: string}} classification
 * @returns {{dead: boolean, permanent: boolean, attempts: number}}
 */
export function recordFailure(url, classification) {
    if (!url || !_ledger) return { dead: false, permanent: false, attempts: 0 };
    const now = Date.now();
    const entry = _ledger.get(url) || { n: 0, f: now };
    entry.n = (entry.n || 0) + 1;
    entry.l = now;
    entry.s = classification?.status ?? null;
    entry.e = String(classification?.message || '').substring(0, 200);
    if (classification?.permanent) entry.p = 1;
    _ledger.set(url, entry);
    _dirty = true;
    scheduleSave();

    const permanent = entry.p === 1;
    return { dead: permanent || entry.n >= MAX_TRANSIENT_ATTEMPTS, permanent, attempts: entry.n };
}

/** A URL that works again drops out of the ledger. */
export function recordSuccess(url) {
    if (!url || !_ledger) return;
    if (_ledger.delete(url)) { _dirty = true; scheduleSave(); }
}

// ========================================
// EXPORT
// ========================================

const MediaDedup = {
    mediaKey,
    keysForItem,
    saveNameFor,
    buildFileIndex,
    findExistingFile,
    noteSavedFile,
    classifyFailure,
    classifyExtractionFailure,
    isAbortLike,
    loadLedger,
    flushLedger,
    isDead,
    deadReason,
    recordFailure,
    recordSuccess,
    MAX_TRANSIENT_ATTEMPTS,
};

// library.js is a classic script and cannot import; it reaches us through here.
window.MediaDedup = MediaDedup;

export default MediaDedup;
