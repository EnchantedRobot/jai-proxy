// ==============================================
// Media Localization Feature
// ==============================================

// Duplicated in index.js (extractSanitizedUrlNameForChat). keep in sync
const CDN_VARIANT_NAMES = new Set(['public', 'original', 'raw', 'full', 'thumbnail', 'thumb',
    'medium', 'small', 'large', 'xl', 'default', 'image', 'photo', 'download', 'view',
    'highres', 'hires', 'high', 'lowres', 'lores', 'low', 'preview', 'avatar']);

function extractSanitizedUrlName(url) {
    try {
        const urlObj = new URL(url);
        const pathParts = urlObj.pathname.split('/').filter(Boolean);
        if (pathParts.length === 0) return '';

        const lastPart = pathParts[pathParts.length - 1];
        const nameWithoutExt = lastPart.includes('.')
            ? lastPart.substring(0, lastPart.lastIndexOf('.'))
            : lastPart;
        const sanitized = nameWithoutExt.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 40);

        // CDN URLs often end with a generic variant name (/public, /original, /thumbnail).
        // Prepend the parent segment for uniqueness when this happens.
        if (pathParts.length >= 2 && CDN_VARIANT_NAMES.has(sanitized.toLowerCase())) {
            const parent = pathParts[pathParts.length - 2]
                .replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 30);
            if (parent.length >= 4) {
                return `${parent}_${sanitized}`.substring(0, 40);
            }
        }

        return sanitized;
    } catch {
        return '';
    }
}

const MEDIA_JOB_POLL_MS = 400;

// downloadFn-bearing images (MEGA) fetch the actual file body in the browser,
// which can stall indefinitely on a slow/stuck storage node (unlike the
// extraction step, which already bounds itself via EXTRACT_TIMEOUT_MS). Bound
// it too so one stuck file can't freeze the whole serial download loop.
const DOWNLOAD_FN_TIMEOUT_MS = 60000;

/**
 * Batch-download URLs through the server's media pipeline -- guard, fetch,
 * sniff, WebP-normalize, dedupe, write, thumbnail, manifest, all server side
 * (docs/PHASE_3C_PLAN.md §3, step 4). The run itself is a detached background
 * job (§7, "3C-2 -- the job runner"): this function only submits it and polls
 * for progress, so closing the tab mid-run no longer kills the download --
 * the server keeps going and the manifest ends up correct regardless of
 * whether anyone is still watching. Maps each finished item onto one `onLog`
 * line, same as the old NDJSON stream, so the calling UI doesn't change.
 * @param {string} cardId - the card's archive id (character.avatar)
 * @param {{url: string, filename?: string}[]} items
 * @param {string} prefix - 'localized_media' | 'lorebook_media' | 'extgallery' | '{provider}gallery'
 * @param {string} phase - label only, recorded in the manifest's run history
 * @param {Object} [options]
 * @param {function} [options.onLog] - (message, status) => void
 * @param {function} [options.onProgress] - (current, total) => void
 * @param {function} [options.shouldAbort] - () => boolean
 * @param {AbortSignal} [options.abortSignal]
 * @returns {Promise<{success: number, skipped: number, errors: number, aborted: boolean}>}
 */
async function downloadViaServerRoute(cardId, items, prefix, phase, options = {}) {
    const { onLog, onProgress, shouldAbort, abortSignal, force } = options;

    if ((!items || items.length === 0) && !force) {
        return { success: 0, skipped: 0, errors: 0, aborted: false };
    }

    let success = 0, skipped = 0, errors = 0, done = 0;
    const total = items.length;

    let submitResp;
    try {
        submitResp = await fetch('/api/v1/media/jobs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                card_id: cardId,
                items: items.map(i => ({ url: i.url, filename: i.filename || null })),
                prefix,
                phase
            }),
            signal: abortSignal
        });
    } catch (err) {
        if (err.name === 'AbortError') return { success: 0, skipped: 0, errors: 0, aborted: true };
        if (onLog) onLog(`Download request failed: ${err.message}`, 'error');
        return { success: 0, skipped: 0, errors: items.length, aborted: false };
    }

    if (!submitResp.ok) {
        const text = await submitResp.text().catch(() => '');
        if (onLog) onLog(`Download request failed: HTTP ${submitResp.status} ${text}`, 'error');
        return { success: 0, skipped: 0, errors: items.length, aborted: false };
    }

    const { job_id: jobId } = await submitResp.json();

    const handleEvent = (evt) => {
        done++;
        const displayUrl = evt.url.length > 60 ? evt.url.substring(0, 60) + '...' : evt.url;
        if (evt.status === 'saved') {
            success++;
            if (onLog) onLog(`Saved: ${evt.file}`, 'success');
        } else if (evt.status === 'skipped') {
            skipped++;
            if (evt.file) {
                if (onLog) onLog(`Skipped (${evt.reason || 'already have it'}): ${evt.file}`, 'success');
            } else {
                if (onLog) onLog(`Unreachable, skipping: ${displayUrl}${evt.reason ? ` (${evt.reason})` : ''}`, 'info');
            }
        } else {
            errors++;
            if (onLog) onLog(`Failed: ${displayUrl} - ${evt.reason || 'unknown error'}`, 'error');
        }
        if (onProgress) onProgress(done, total);
    };

    let cursor = 0;
    let aborted = false;
    let state = 'queued';
    while (state === 'queued' || state === 'running') {
        if ((shouldAbort && shouldAbort()) || abortSignal?.aborted) {
            aborted = true;
            fetch(`/api/v1/media/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' }).catch(() => {});
            break;
        }
        await new Promise(resolve => setTimeout(resolve, MEDIA_JOB_POLL_MS));
        let statusResp;
        try {
            statusResp = await fetch(`/api/v1/media/jobs/${encodeURIComponent(jobId)}?after=${cursor}`);
        } catch {
            continue; // transient network hiccup -- the job keeps running server-side, just keep polling
        }
        if (!statusResp.ok) continue;
        const body = await statusResp.json();
        for (const evt of body.events) handleEvent(evt);
        cursor = body.next_cursor;
        state = body.state;
        if (state === 'error' && onLog) onLog(`Download job failed: ${body.error || 'unknown error'}`, 'error');
    }
    if (state === 'cancelled') aborted = true;

    return { success, skipped, errors, aborted };
}

/**
 * Save one already-fetched media item through the server's second entry door
 * (docs/PHASE_3C_PLAN.md §6, "one writer, two entry doors") -- for MEGA's
 * AES-CTR decrypt, which has to happen in the browser, but still needs
 * sniff/normalize/dedupe/write/thumbnail/manifest applied exactly the way a
 * server-fetched item does.
 * @param {string} cardId
 * @param {{url: string, filename?: string, arrayBuffer: ArrayBuffer, contentType?: string}} item
 * @param {string} prefix
 * @returns {Promise<{status: 'saved'|'skipped'|'error', file?: string, reason?: string, bytes?: number}>}
 */
async function downloadBytesViaServerRoute(cardId, item, prefix) {
    try {
        const form = new FormData();
        const blob = new Blob([item.arrayBuffer], { type: item.contentType || 'application/octet-stream' });
        form.append('file', blob, item.filename || 'media');
        form.append('url', item.url);
        if (item.filename) form.append('filename', item.filename);
        form.append('prefix', prefix);

        const resp = await fetch(`/api/v1/characters/${encodeURIComponent(cardId)}/media/bytes`, {
            method: 'POST',
            body: form
        });
        if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            return { status: 'error', reason: `HTTP ${resp.status} ${text}` };
        }
        return await resp.json();
    } catch (err) {
        return { status: 'error', reason: err.message || String(err) };
    }
}

/**
 * Ask the server which of these items its gallery already satisfies, so a
 * caller that fetches bytes itself doesn't fetch what it already has.
 *
 * The batch route gets this check for free (`download_item` consults the name
 * index before opening a connection). The browser-fetch door can't: MEGA's
 * per-file AES-CTR decrypt means the bytes are already downloaded by the time
 * the server sees them, so an already-complete folder re-downloaded and
 * re-decrypted every file just to be told "already have this content". One
 * request replaces all of that.
 *
 * Fails open -- a network error or an older server without the route returns
 * an empty map, and every item goes down the download path as before.
 *
 * @param {string} cardId
 * @param {{url: string, filename?: string}[]} items
 * @param {string} prefix
 * @param {AbortSignal} [abortSignal]
 * @returns {Promise<Map<string, string>>} url -> existing local filename
 */
async function checkServerHasMedia(cardId, items, prefix, abortSignal) {
    if (!items.length) return new Map();
    try {
        const resp = await fetch(`/api/v1/characters/${encodeURIComponent(cardId)}/media/have`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                items: items.map(i => ({ url: i.url, filename: i.filename || null })),
                prefix
            }),
            signal: abortSignal
        });
        if (!resp.ok) return new Map();
        const body = await resp.json();
        return new Map(Object.entries(body.have || {}));
    } catch {
        return new Map();
    }
}

/**
 * Download embedded media for a character (core function used by both localize button and import summary)
 * @param {string} cardId - The card's archive id (character.avatar)
 * @param {string[]} mediaUrls - Array of URLs to download
 * @param {Object} options - Optional callbacks for progress/logging
 * @returns {Promise<{success: number, skipped: number, errors: number}>}
 */
async function downloadEmbeddedMediaForCharacter(cardId, mediaUrls, options = {}) {
    const { onProgress, onLog, shouldAbort, abortSignal, prefix = 'localized_media', phase = 'embedded', nameHints } = options;

    if (!mediaUrls || mediaUrls.length === 0) {
        return { success: 0, skipped: 0, errors: 0, aborted: false };
    }

    const items = mediaUrls.map(url => ({ url, filename: nameHints?.get(url) || undefined }));
    return downloadViaServerRoute(cardId, items, prefix, phase, { onLog, onProgress, shouldAbort, abortSignal });
}

/**
 * Extract image/media URLs from text content
 */
function extractMediaUrls(text) {
    if (!text) return [];
    
    const urls = [];
    
    // Match ![](url) markdown - allow one level of balanced parens in the path so
    // postimg "(1)" filenames dont truncate at the first ), still stop at whitespace
    // (sizing params/titles). Single-char first branch keeps the alternation disjoint, so linear time.
    const markdownPattern = /!\[.*?\]\((https?:\/\/(?:[^\s()]|\([^\s()]*\))+)/g;
    let match;
    while ((match = markdownPattern.exec(text)) !== null) {
        let url = match[1];
        // An unbalanced-paren URL makes the balanced branch swallow the markdown closer; give it back.
        if (url.endsWith(')') && text[markdownPattern.lastIndex] !== ')') url = url.slice(0, -1);
        urls.push(url);
    }
    
    // Match <img src="url"> HTML format
    const htmlPattern = /<img[^>]+src=["']([^"']+)["'][^>]*>/g;
    while ((match = htmlPattern.exec(text)) !== null) {
        if (match[1].startsWith('http')) {
            urls.push(match[1]);
        }
    }
    
    // Match <audio src="url"> and <source src="url"> HTML format
    const audioPattern = /<(?:audio|source)[^>]+src=["']([^"']+)["'][^>]*>/g;
    while ((match = audioPattern.exec(text)) !== null) {
        if (match[1].startsWith('http')) {
            urls.push(match[1]);
        }
    }
    
    // Match CSS url() patterns: background-image: url('...'), content: url("..."), etc.
    const cssUrlPattern = /url\(["']?(https?:\/\/[^"')\s]+\.(?:png|jpg|jpeg|gif|webp|svg|mp4|webm|mov|mp3|wav|ogg|m4a))["']?\)/gi;
    while ((match = cssUrlPattern.exec(text)) !== null) {
        urls.push(match[1]);
    }
    
    // Match raw URLs for media files. Parens terminate the match: bare URLs
    // almost never contain them, but the text around them constantly does --
    // a markdown closer `![](url.jpg)` left a trailing `)` on 1,323 URLs in the
    // corpus, and `![]{{random:(a.jpg),(b.jpg),(c.jpg)}}` (a JanitorAI macro)
    // ran the whole list together into one unfetchable string, so those cards'
    // media never downloaded and the fake URLs landed in the dead ledger.
    // The paren-bearing URLs that are real (postimg's "(1).png") arrive through
    // the markdown branch above, which balances them deliberately.
    const urlPattern = /(https?:\/\/[^\s<>"{}|\\^`\[\]()]+\.(?:png|jpg|jpeg|gif|webp|svg|mp4|webm|mov|mp3|wav|ogg|m4a)(?:\/[^\s<>"'{}|\\^`\[\]()]+)?)/gi;
    while ((match = urlPattern.exec(text)) !== null) {
        urls.push(match[1]);
    }

    const unique = [...new Set(urls)];
    // a proper prefix of a longer capture continuing with / is a truncated twin the raw pattern makes of ext-mid-path urls
    return unique.filter(u => !unique.some(o => o !== u && o.startsWith(u) && o[u.length] === '/'));
}

// Single source of truth for which card surfaces carry scannable text; media
// localization and gallery-URL discovery both walk this. Lorebook chunks come
// back separate so each consumer applies its own gating. Character must be
// hydrated (slim cards have the heavy fields stripped).
function collectCardTextChunks(character) {
    const chunks = { main: [], lorebook: [] };
    if (!character) return chunks;

    const data = character.data || character;

    const fieldsToCheck = [
        'description',
        'personality',
        'scenario',
        'first_mes',
        'mes_example',
        'creator_notes',
        'system_prompt',
        'post_history_instructions'
    ];
    for (const field of fieldsToCheck) {
        const value = data[field];
        if (value && typeof value === 'string') chunks.main.push(value);
    }

    const extensions = data.extensions;
    if (extensions && typeof extensions === 'object') {
        for (const providerData of Object.values(extensions)) {
            const tagline = providerData?.tagline;
            if (tagline && typeof tagline === 'string') chunks.main.push(tagline);
        }
    }

    const altGreetings = data.alternate_greetings;
    if (Array.isArray(altGreetings)) {
        for (const greeting of altGreetings) {
            if (greeting && typeof greeting === 'string') chunks.main.push(greeting);
        }
    }

    const entries = data.character_book?.entries;
    if (entries) {
        const entryList = Array.isArray(entries) ? entries : Object.values(entries);
        for (const entry of entryList) {
            if (entry?.content && typeof entry.content === 'string') chunks.lorebook.push(entry.content);
        }
    }

    return chunks;
}

/**
 * Find all remote media URLs in a character card
 */
function findCharacterMediaUrls(character, { split = false } = {}) {
    if (!character) return split ? { embeddedUrls: [], lorebookUrls: [] } : [];

    const { main, lorebook } = collectCardTextChunks(character);

    const mediaUrls = new Set();
    for (const chunk of main) {
        for (const url of extractMediaUrls(chunk)) {
            if (url.startsWith('http://') || url.startsWith('https://')) {
                mediaUrls.add(url);
            }
        }
    }

    const lorebookUrls = new Set();
    if (getSetting('includeLorebook')) {
        for (const chunk of lorebook) {
            for (const url of extractMediaUrls(chunk)) {
                if ((url.startsWith('http://') || url.startsWith('https://')) && !mediaUrls.has(url)) {
                    lorebookUrls.add(url);
                }
            }
        }
    }

    if (split) {
        debugLog(`[Localize] Found ${mediaUrls.size} embedded + ${lorebookUrls.size} lorebook media URLs`);
        return { embeddedUrls: Array.from(mediaUrls), lorebookUrls: Array.from(lorebookUrls) };
    }
    
    // Combined mode (backwards compat)
    lorebookUrls.forEach(url => mediaUrls.add(url));
    debugLog(`[Localize] Found ${mediaUrls.size} remote media URLs in character`);
    return Array.from(mediaUrls);
}

/**
 * Parse MP4/M4A container to check if it contains video tracks
 * MP4 files are structured as nested "atoms" (boxes) with 4-byte size + 4-byte type
 * We scan for 'hdlr' (handler) atoms and check if any have 'vide' (video) handler type
 * @param {Uint8Array} bytes - The file bytes
 * @returns {boolean} True if video track found, false if audio-only
 */
function mp4HasVideoTrack(bytes) {
    const len = bytes.length;
    let pos = 0;
    
    // Scan through atoms looking for 'hdlr' handler atoms
    // hdlr atom structure: [4-byte size][hdlr][4-byte version/flags][4-byte predefined][4-byte handler_type]
    // handler_type at offset 16 from atom start: 'vide' for video, 'soun' for sound
    while (pos < len - 24) {
        // Read atom size (big-endian 32-bit)
        const atomSize = (bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3];
        
        // Read atom type
        const atomType = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
        
        // Check for 'hdlr' atom
        if (atomType === 'hdlr' && atomSize >= 24) {
            // Handler type is at offset 16 from atom start (after size[4] + type[4] + version[4] + predefined[4])
            const handlerType = String.fromCharCode(
                bytes[pos + 16], bytes[pos + 17], bytes[pos + 18], bytes[pos + 19]
            );
            
            if (handlerType === 'vide') {
                return true; // Found video track
            }
        }
        
        // Move to next atom
        // Atom size of 0 means "extends to end of file" - stop scanning
        // Atom size of 1 means 64-bit extended size (rare, skip for simplicity)
        if (atomSize === 0 || atomSize === 1) {
            break;
        }
        
        // For container atoms (moov, trak, mdia, minf, stbl), descend into them
        // by moving just past the header (8 bytes) instead of skipping the whole atom
        const containerAtoms = ['moov', 'trak', 'mdia', 'minf', 'stbl', 'udta', 'edts'];
        if (containerAtoms.includes(atomType)) {
            pos += 8; // Just skip the header, scan contents
        } else {
            pos += atomSize; // Skip entire atom
        }
        
        // Safety: prevent infinite loop on malformed files
        if (atomSize < 8 && !containerAtoms.includes(atomType)) {
            break;
        }
    }
    
    return false; // No video track found = audio only
}

/**
 * Download a media file to memory (ArrayBuffer) without saving
 */
/**
 * Validate that downloaded content is actually valid media by checking magic bytes
 * Returns the detected media type or null if invalid
 * @param {ArrayBuffer} arrayBuffer - The downloaded content
 * @param {string} contentType - Content-Type header from response
 * @returns {{ valid: boolean, detectedType: string|null, reason: string }}
 */
function validateMediaContent(arrayBuffer, contentType) {
    // Check minimum size
    if (!arrayBuffer || arrayBuffer.byteLength < 8) {
        return { valid: false, detectedType: null, reason: 'Content too small to be valid media' };
    }
    
    const bytes = new Uint8Array(arrayBuffer);
    
    // Check for common magic bytes
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
        return { valid: true, detectedType: 'image/png', reason: 'Valid PNG' };
    }
    
    // JPEG: FF D8 FF
    if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
        return { valid: true, detectedType: 'image/jpeg', reason: 'Valid JPEG' };
    }
    
    // GIF: 47 49 46 38 (GIF8)
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
        return { valid: true, detectedType: 'image/gif', reason: 'Valid GIF' };
    }
    
    // WebP: 52 49 46 46 ... 57 45 42 50 (RIFF....WEBP)
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
        return { valid: true, detectedType: 'image/webp', reason: 'Valid WebP' };
    }
    
    // BMP: 42 4D (BM)
    if (bytes[0] === 0x42 && bytes[1] === 0x4D) {
        return { valid: true, detectedType: 'image/bmp', reason: 'Valid BMP' };
    }
    
    // MP4/M4A/M4V: ... 66 74 79 70 (....ftyp) at offset 4
    // MP4 and M4A share the same container format - we need to check for video tracks
    if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
        // Check the major brand at bytes 8-11 first (quick check)
        const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
        
        // Definitive audio brands - no need to scan
        if (brand === 'M4A ' || brand === 'M4B ' || brand === 'M4P ') {
            return { valid: true, detectedType: 'audio/mp4', reason: 'Valid M4A audio (brand)' };
        }
        
        // For generic brands (isom, mp41, mp42, etc.), scan the file for video tracks
        // Look for 'moov' -> 'trak' -> 'mdia' -> 'hdlr' with 'vide' handler type
        const hasVideoTrack = mp4HasVideoTrack(bytes);
        
        if (hasVideoTrack) {
            return { valid: true, detectedType: 'video/mp4', reason: 'Valid MP4 video (has video track)' };
        } else {
            return { valid: true, detectedType: 'audio/mp4', reason: 'Valid M4A audio (no video track)' };
        }
    }
    
    // WebM: 1A 45 DF A3
    if (bytes[0] === 0x1A && bytes[1] === 0x45 && bytes[2] === 0xDF && bytes[3] === 0xA3) {
        return { valid: true, detectedType: 'video/webm', reason: 'Valid WebM' };
    }
    
    // MP3: ID3 tag (49 44 33) or MPEG sync word (FF FB, FF FA, FF F3, FF F2)
    if ((bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) ||
        (bytes[0] === 0xFF && (bytes[1] === 0xFB || bytes[1] === 0xFA || bytes[1] === 0xF3 || bytes[1] === 0xF2))) {
        return { valid: true, detectedType: 'audio/mpeg', reason: 'Valid MP3' };
    }
    
    // OGG: 4F 67 67 53 (OggS)
    if (bytes[0] === 0x4F && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) {
        return { valid: true, detectedType: 'audio/ogg', reason: 'Valid OGG' };
    }
    
    // WAV: 52 49 46 46 ... 57 41 56 45 (RIFF....WAVE)
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45) {
        return { valid: true, detectedType: 'audio/wav', reason: 'Valid WAV' };
    }
    
    // FLAC: 66 4C 61 43 (fLaC)
    if (bytes[0] === 0x66 && bytes[1] === 0x4C && bytes[2] === 0x61 && bytes[3] === 0x43) {
        return { valid: true, detectedType: 'audio/flac', reason: 'Valid FLAC' };
    }
    
    // SVG: Check for <?xml or <svg
    const textStart = new TextDecoder().decode(bytes.slice(0, Math.min(100, bytes.length)));
    if (textStart.includes('<?xml') || textStart.includes('<svg')) {
        return { valid: true, detectedType: 'image/svg+xml', reason: 'Valid SVG' };
    }
    
    // Check if it looks like HTML (common error page response)
    if (textStart.includes('<!DOCTYPE') || textStart.includes('<html') || textStart.includes('<HTML')) {
        return { valid: false, detectedType: 'text/html', reason: 'Content is HTML (likely error page)' };
    }
    
    // If content-type suggests media but we couldn't validate, allow it with warning
    if (contentType && (contentType.startsWith('image/') || contentType.startsWith('audio/') || contentType.startsWith('video/'))) {
        debugLog(`[EmbeddedMedia] Unknown format but content-type suggests media: ${contentType}`);
        return { valid: true, detectedType: contentType, reason: 'Unknown format, trusting content-type' };
    }
    
    // Unknown format
    return { valid: false, detectedType: null, reason: 'Unknown or invalid media format' };
}

/**
 * Convert ArrayBuffer to base64 string directly without intermediate Blob/FileReader.
 * Uses chunked btoa: processes 3072-byte groups (multiple of 3 for valid base64),
 * collects chunk strings, then joins once at the end.
 *
 * Memory profile for 5MB input:
 *   - bytes view: 0 (shares buffer)
 *   - per-chunk overhead: ~7KB (3KB binary + 4KB base64), immediately GC-eligible
 *   - parts array: ~1700 string references (~14KB)
 *   - final join: ~6.67MB result string
 *   - Peak: ~18MB (buffer + parts + join result)
 *
 * Previous Array approach was ~53MB peak for the same input.
 */
function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const len = bytes.length;
    // 3072 bytes = 1024 triplets → 4096 base64 chars per chunk.
    // Small enough for String.fromCharCode.apply (well under stack limits).
    const GROUP = 3072;
    const parts = [];
    for (let i = 0; i < len; i += GROUP) {
        const chunk = bytes.subarray(i, Math.min(i + GROUP, len));
        parts.push(btoa(String.fromCharCode.apply(null, chunk)));
    }
    return parts.join('');
}

// ============ Media Download Safety (SSRF + DoS defense) ============

const MAX_MEDIA_BYTES = 50 * 1024 * 1024; // 50 MB hard cap per file

const BLOCKED_HOSTNAME_SUFFIXES = [
    '.local', '.localhost', '.internal'
];
const BLOCKED_HOSTNAMES = new Set([
    'localhost',
    'localhost.localdomain',
    'metadata.google.internal',
    'metadata.goog',
    'kubernetes.default',
    'kubernetes.default.svc'
]);

function isPrivateIPv4(host) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (!m) return false;
    const o = m.slice(1).map(n => parseInt(n, 10));
    if (o.some(n => n > 255)) return true; // malformed → treat as unsafe
    const [a, b] = o;
    if (a === 0) return true;                      // 0.0.0.0/8 - "this network"
    if (a === 10) return true;                     // 10.0.0.0/8 - private
    if (a === 127) return true;                    // 127.0.0.0/8 - loopback
    if (a === 169 && b === 254) return true;       // 169.254.0.0/16 - link-local + AWS metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 - private
    if (a === 192 && b === 168) return true;       // 192.168.0.0/16 - private
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 - CGNAT
    if (a >= 224) return true;                     // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
    return false;
}

function isPrivateIPv6(host) {
    // Strip brackets if URL parser left them in (it shouldn't for .hostname, but be safe)
    let h = host.toLowerCase().replace(/^\[|\]$/g, '');
    if (!h.includes(':')) return false;
    if (h === '::' || h === '::1') return true;       // unspecified + loopback
    // IPv4-mapped: ::ffff:a.b.c.d → recurse
    const v4Mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h);
    if (v4Mapped) return isPrivateIPv4(v4Mapped[1]);
    // Expand leading shorthand to inspect first hextet
    const firstHextet = h.startsWith('::') ? '0' : h.split(':')[0];
    const head = parseInt(firstHextet || '0', 16);
    if ((head & 0xfe00) === 0xfc00) return true;      // fc00::/7 unique-local
    if ((head & 0xffc0) === 0xfe80) return true;      // fe80::/10 link-local
    return false;
}

/**
 * Decide if a URL is safe to download from.
 * Blocks non-http(s) schemes, private/loopback/link-local/CGNAT/metadata IPs (v4+v6),
 * and well-known internal hostnames. Returns { ok, reason }.
 */
function isUrlSafeForDownload(url) {
    let parsed;
    try { parsed = new URL(url); }
    catch { return { ok: false, reason: 'invalid URL' }; }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { ok: false, reason: `blocked scheme: ${parsed.protocol}` };
    }

    const host = parsed.hostname.toLowerCase();
    if (!host) return { ok: false, reason: 'empty hostname' };

    if (BLOCKED_HOSTNAMES.has(host)) return { ok: false, reason: `blocked hostname: ${host}` };
    for (const suffix of BLOCKED_HOSTNAME_SUFFIXES) {
        if (host === suffix.slice(1) || host.endsWith(suffix)) {
            return { ok: false, reason: `blocked hostname suffix: ${host}` };
        }
    }
    if (isPrivateIPv4(host)) return { ok: false, reason: `blocked private IPv4: ${host}` };
    if (isPrivateIPv6(host)) return { ok: false, reason: `blocked private IPv6: ${host}` };

    return { ok: true };
}

/**
 * Read a fetch Response body into an ArrayBuffer with a hard size cap.
 * Pre-checks Content-Length when present, then streams the body via the reader,
 * aborting + throwing if accumulated bytes exceed maxBytes.
 * Falls back to response.arrayBuffer() if streaming isn't available.
 */
async function readBodyWithCap(response, maxBytes) {
    const declared = parseInt(response.headers.get('content-length') || '0', 10);
    if (declared > maxBytes) {
        throw new Error(`response too large: ${declared} > ${maxBytes} bytes`);
    }

    if (!response.body || typeof response.body.getReader !== 'function') {
        const buf = await response.arrayBuffer();
        if (buf.byteLength > maxBytes) {
            throw new Error(`response too large: ${buf.byteLength} > ${maxBytes} bytes`);
        }
        return buf;
    }

    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
            try { await reader.cancel(); } catch {}
            throw new Error(`response exceeded size cap: > ${maxBytes} bytes`);
        }
        chunks.push(value);
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return merged.buffer;
}

// encodeURIComponent leaves !'()* literal; strict reverse proxies/WAFs 403 literal
// parens (postimg "(1)" filenames are the common trigger), so escape them for /proxy/
function proxyEncode(url) {
    return encodeURIComponent(url).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

async function downloadMediaToMemory(url, timeoutMs = 30000, abortSignal = null) {
    try {
        const safety = isUrlSafeForDownload(url);
        if (!safety.ok) {
            debugLog(`[EmbeddedMedia] URL rejected: ${safety.reason} (${url})`);
            return { success: false, error: safety.reason, blocked: true };
        }

        let response;
        let usedProxy = false;

        // Slow CDNs get a longer timeout window (extend to at least 60s)
        const SLOW_HOSTS = /(?:^|\.)image\.civitai\.com$/i;
        try {
            if (SLOW_HOSTS.test(new URL(url).hostname)) timeoutMs = Math.max(timeoutMs, 60000);
        } catch {}

        // Create abort controller for timeout and external abort
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        let abortListener = null;

        if (abortSignal) {
            if (abortSignal.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }
            abortListener = () => controller.abort();
            abortSignal.addEventListener('abort', abortListener, { once: true });
        }

        try {
            // Try direct fetch first
            try {
                response = await fetch(url, { signal: controller.signal });
            } catch (directError) {
                if (directError.name === 'AbortError') throw directError;
                // fetch() rejected (CORS/network) — try proxy
                usedProxy = true;
                const proxyUrl = `/proxy/${proxyEncode(url)}`;
                response = await fetch(proxyUrl, { signal: controller.signal });
            }

            if (!response.ok) {
                if (response.status === 404) {
                    const text = await response.text();
                    if (text.includes('CORS proxy is disabled')) {
                        throw new Error('CORS blocked and proxy is disabled');
                    }
                }
                const httpErr = new Error(`${usedProxy ? 'Proxy ' : ''}HTTP ${response.status}`);
                httpErr.httpStatus = response.status;
                throw httpErr;
            }
        } finally {
            clearTimeout(timeoutId);
            if (abortSignal && abortListener) {
                abortSignal.removeEventListener('abort', abortListener);
            }
        }
        
        const arrayBuffer = await readBodyWithCap(response, MAX_MEDIA_BYTES);
        const contentType = response.headers.get('content-type') || '';
        
        // Validate that the downloaded content is actually valid media
        // This is critical because some CDNs/servers return incorrect Content-Type headers
        // (e.g., returning "image/jpeg" for an MP3 file), which would cause files to be
        // saved with wrong extensions. Magic byte detection ensures we identify the true
        // file type regardless of what the server claims.
        const validation = validateMediaContent(arrayBuffer, contentType);
        if (!validation.valid) {
            debugLog(`[EmbeddedMedia] Invalid media from ${url}: ${validation.reason}`);
            return {
                success: false,
                error: validation.reason
            };
        }
        
        // Use detected content type if header was missing/wrong
        const finalContentType = validation.detectedType || contentType;
        
        return {
            success: true,
            arrayBuffer: arrayBuffer,
            contentType: finalContentType,
            usedProxy: usedProxy,
            detectedType: validation.detectedType
        };
    } catch (error) {
        return {
            success: false,
            error: error.message || String(error),
            status: typeof error?.httpStatus === 'number' ? error.httpStatus : null
        };
    }
}

/**
 * Download images from external gallery pages found in a character's text fields.
 * Phase 3 of the localization pipeline (after embedded + provider gallery).
 *
 * Extraction stays entirely in the browser (session cookies, page scraping --
 * docs/PHASE_3C_PLAN.md §6, "extgallery still needs the browser's
 * extractors"). Once a page yields images, plain-URL ones go through the
 * batch JSON route same as embedded media; `downloadFn`-bearing ones (MEGA's
 * AES-CTR decrypt) still run in the browser, then their bytes go through the
 * second entry door.
 *
 * @param {Object} character - Character object (must be hydrated)
 * @param {string} cardId - The card's archive id (character.avatar)
 * @param {Object} [options]
 * @param {function} [options.onLog] - Log entry callback
 * @param {function} [options.onProgress] - Progress callback (current, total)
 * @param {function} [options.shouldAbort] - Abort check callback
 * @param {AbortSignal} [options.abortSignal] - Abort signal
 * @returns {Promise<{success: number, skipped: number, errors: number, aborted: boolean}>}
 */
async function downloadExternalGalleryForCharacter(character, cardId, options = {}) {
    const { onLog, onProgress, shouldAbort, abortSignal, galleryPageUrls: overrideUrls } = options;

    const result = { success: 0, skipped: 0, errors: 0, aborted: false };

    const galleryUrls = overrideUrls || (typeof window.findCharacterGalleryUrls === 'function'
        ? window.findCharacterGalleryUrls(character)
        : []);
    if (galleryUrls.length === 0) return result;

    let allImages = [];

    for (let i = 0; i < galleryUrls.length; i++) {
        if ((shouldAbort && shouldAbort()) || abortSignal?.aborted) {
            result.aborted = true;
            return result;
        }

        const gUrl = galleryUrls[i];
        const displayUrl = gUrl.length > 60 ? gUrl.substring(0, 60) + '...' : gUrl;

        if (onLog) onLog(`Extracting: ${displayUrl}`, 'pending');

        try {
            const extracted = await window.extractGalleryImages(gUrl, { signal: abortSignal, character });
            if (extracted.aborted) {
                result.aborted = true;
                return result;
            }
            if (extracted.error) {
                result.errors++;
                if (onLog) onLog(`Failed to extract: ${displayUrl} (${extracted.error})`, 'error');
                continue;
            }
            if (extracted.images.length > 0) {
                if (onLog) onLog(`Found ${extracted.images.length} image(s) from ${displayUrl}`, 'success');
                allImages.push(...extracted.images);
            } else {
                if (onLog) onLog(`No images found at ${displayUrl}`, 'info');
            }
        } catch (err) {
            if (err.name === 'AbortError') { result.aborted = true; return result; }
            if (onLog) onLog(`Error extracting ${displayUrl}: ${err.message}`, 'error');
            result.errors++;
        }
    }

    if (allImages.length === 0) return result;

    const plainItems = [];
    const downloadFnItems = [];
    for (const img of allImages) {
        if (typeof img.downloadFn === 'function') downloadFnItems.push(img);
        else plainItems.push({ url: img.url, filename: img.filename });
    }

    if (plainItems.length > 0) {
        const r = await downloadViaServerRoute(cardId, plainItems, 'extgallery', 'extGallery', {
            onLog, onProgress, shouldAbort, abortSignal
        });
        result.success += r.success;
        result.skipped += r.skipped;
        result.errors += r.errors;
        if (r.aborted) { result.aborted = true; return result; }
    }

    // One round trip retires every downloadFn item we already have on disk --
    // without it each one costs a full fetch + decrypt before the server can
    // say "already have this content".
    const alreadyHave = downloadFnItems.length
        ? await checkServerHasMedia(cardId, downloadFnItems, 'extgallery', abortSignal)
        : new Map();

    for (const img of downloadFnItems) {
        if ((shouldAbort && shouldAbort()) || abortSignal?.aborted) {
            result.aborted = true;
            return result;
        }
        const displayUrl = img.url.length > 60 ? img.url.substring(0, 60) + '...' : img.url;
        const existing = alreadyHave.get(img.url);
        if (existing) {
            result.skipped++;
            if (onLog) onLog(`Skipped (already have it): ${existing}`, 'success');
            continue;
        }
        let dl;
        try {
            const timeoutSignal = AbortSignal.timeout(DOWNLOAD_FN_TIMEOUT_MS);
            const combined = abortSignal ? AbortSignal.any([abortSignal, timeoutSignal]) : timeoutSignal;
            dl = await img.downloadFn(combined);
        } catch (err) {
            // Only a real user cancel aborts the whole batch. A TimeoutError
            // here means our own per-file timeout fired (stuck download) --
            // that's a per-item failure, not a reason to give up on the rest.
            if (err.name === 'AbortError' && (abortSignal?.aborted || (shouldAbort && shouldAbort()))) {
                result.aborted = true;
                return result;
            }
            dl = { success: false, error: err.name === 'TimeoutError' ? 'Download timed out' : err.message };
        }
        if (!dl?.success) {
            result.errors++;
            if (onLog) onLog(`Failed: ${displayUrl} - ${dl?.error || 'unknown error'}`, 'error');
            continue;
        }
        const saved = await downloadBytesViaServerRoute(cardId, {
            url: img.url,
            filename: img.filename,
            arrayBuffer: dl.arrayBuffer,
            contentType: dl.contentType
        }, 'extgallery');
        if (saved.status === 'saved') {
            result.success++;
            if (onLog) onLog(`Saved: ${saved.file}`, 'success');
        } else if (saved.status === 'skipped') {
            result.skipped++;
            if (onLog) onLog(`Skipped (${saved.reason || 'already have it'}): ${saved.file || displayUrl}`, 'success');
        } else {
            result.errors++;
            if (onLog) onLog(`Failed: ${displayUrl} - ${saved.reason || 'unknown error'}`, 'error');
        }
    }

    return result;
}


