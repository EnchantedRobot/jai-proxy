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

// Index build lives in modules/media-dedup.js (fork-local). Without it we return
// an empty index, which just means every file falls through to the hash path.
async function getExistingFileIndex(folderName) {
    if (!window.MediaDedup) {
        console.warn('[Localize] MediaDedup module unavailable; name-based skip disabled');
        return new Map();
    }
    return window.MediaDedup.buildFileIndex(folderName);
}

/**
 * Build shared dedup state for a gallery folder. Call once per character, pass to all download phases.
 * @param {string} folderName
 * @returns {Promise<{fileNameIndex: Map|null, hashMap: Map|null, ensureHashMap: function, useFastSkip: boolean, validateHeaders: boolean}>}
 */
async function buildDedupState(folderName) {
    const useFastSkip = getSetting('fastFilenameSkip') || false;
    const validateHeaders = useFastSkip && (getSetting('fastSkipValidateHeaders') || false);

    // Needed by every phase's pre-download dead-URL check.
    await window.MediaDedup?.loadLedger();

    let fileNameIndex = null;
    let hashMap = null;

    if (useFastSkip) {
        fileNameIndex = await getExistingFileIndex(folderName);
        debugLog(`[DedupState] Fast skip: ${fileNameIndex.size} indexed files for ${folderName}`);
    } else {
        hashMap = await getExistingFileHashes(folderName);
        debugLog(`[DedupState] Hash map: ${hashMap.size} entries for ${folderName}`);
    }

    async function ensureHashMap() {
        if (!hashMap) {
            hashMap = await getExistingFileHashes(folderName);
            debugLog(`[DedupState] Lazy hash map built: ${hashMap.size} entries for ${folderName}`);
        }
        return hashMap;
    }

    return { fileNameIndex, hashMap, ensureHashMap, useFastSkip, validateHeaders };
}

/**
 * Download embedded media for a character (core function used by both localize button and import summary)
 * @param {string} folderName - The gallery folder name (use getGalleryFolderName() for unique folders)
 * @param {string[]} mediaUrls - Array of URLs to download
 * @param {Object} options - Optional callbacks for progress/logging
 * @returns {Promise<{success: number, skipped: number, errors: number, renamed: number}>}
 */
async function downloadEmbeddedMediaForCharacter(folderName, mediaUrls, options = {}) {
    const { onProgress, onLog, onLogUpdate, shouldAbort, abortSignal, prefix = 'localized_media', dedupState: externalDedup, downloadFnMap, nameHints } = options;
    
    let successCount = 0;
    let errorCount = 0;
    let skippedCount = 0;
    let renamedCount = 0;
    
    if (!mediaUrls || mediaUrls.length === 0) {
        return { success: 0, skipped: 0, errors: 0, renamed: 0, aborted: false };
    }
    
    // Use shared dedup state if provided, otherwise build our own
    const dedup = externalDedup || await buildDedupState(folderName);
    const { useFastSkip, validateHeaders, ensureHashMap } = dedup;
    let { fileNameIndex } = dedup;
    const MD = window.MediaDedup;
    
    let startIndex = Date.now(); // Use timestamp as start index for unique filenames
    let filenameSkippedCount = 0;
    
    for (let i = 0; i < mediaUrls.length; i++) {
        // Check for abort signal
        if ((shouldAbort && shouldAbort()) || abortSignal?.aborted) {
            return { success: successCount, skipped: skippedCount, errors: errorCount, renamed: renamedCount, filenameSkipped: filenameSkippedCount, aborted: true };
        }
        
        const url = mediaUrls[i];
        const fileIndex = startIndex + i;
        
        // Extractors resolve a real filename; it beats guessing from the URL,
        // which is worthless for synthetic ones like mega://folder/handle.
        const nameHint = nameHints?.get(url) || '';
        // '' means "no usable hint" — saveMediaFromMemory keeps its URL-derived name
        const saveName = MD?.saveNameFor(url, nameHint) || '';

        // Truncate URL for display
        const displayUrl = url.length > 60 ? url.substring(0, 60) + '...' : url;
        const logEntry = onLog ? onLog(`Checking ${displayUrl}`, 'pending') : null;
        
        // Name match against what's already on disk — before any bytes move.
        // Runs ahead of the dead check so a file we already hold logs as a
        // filename match even if its source has since gone away.
        if (useFastSkip && fileNameIndex && MD) {
            const match = await MD.findExistingFile({ url, filename: nameHint }, {
                index: fileNameIndex,
                prefix,
                validateHeaders,
                fixFilenames: getSetting('fixFilenames') !== false,
            });
            if (match) {
                skippedCount++;
                filenameSkippedCount++;
                if (onLogUpdate && logEntry) onLogUpdate(logEntry, `Skipped (filename match): ${match.fileName}`, 'success');
                if (onProgress) onProgress(i + 1, mediaUrls.length);
                continue;
            }
        }

        // Known-dead URL — never spend a request on it again. Counted as skipped,
        // not failed: there is nothing to retry and nothing the user can fix.
        if (MD?.isDead(url)) {
            skippedCount++;
            if (onLogUpdate && logEntry) onLogUpdate(logEntry, `Unreachable, skipping: ${displayUrl} (${MD.deadReason(url)})`, 'info');
            if (onProgress) onProgress(i + 1, mediaUrls.length);
            continue;
        }
        
        // Download to memory first to check hash (with 30s timeout)
        const customDownloadFn = downloadFnMap?.get(url);
        let downloadResult;
        if (customDownloadFn) {
            try {
                downloadResult = await customDownloadFn(abortSignal);
            } catch (err) {
                if (err.name === 'AbortError' || err.name === 'TimeoutError') {
                    return { success: successCount, skipped: skippedCount, errors: errorCount, renamed: renamedCount, filenameSkipped: filenameSkippedCount, aborted: true };
                }
                downloadResult = { success: false, error: err.message };
            }
        } else {
            downloadResult = await downloadMediaToMemory(url, 30000, abortSignal);
        }
        
        if (!downloadResult.success) {
            // A 404 is not a retryable error: bank it so this character can
            // still reach "complete" instead of failing forever.
            const failure = MD?.recordFailure(url, MD.classifyFailure(downloadResult));
            if (failure?.dead) {
                skippedCount++;
                if (onLogUpdate && logEntry) onLogUpdate(logEntry, `Unreachable, giving up: ${displayUrl} - ${downloadResult.error}`, 'info');
            } else {
                errorCount++;
                if (onLogUpdate && logEntry) onLogUpdate(logEntry, `Failed: ${displayUrl} - ${downloadResult.error}`, 'error');
            }
            downloadResult = null;
            if (onProgress) onProgress(i + 1, mediaUrls.length);
            continue;
        }
        MD?.recordSuccess(url);
        
        // Calculate hash of downloaded content
        const hashMap = await ensureHashMap();
        const contentHash = await calculateHash(downloadResult.arrayBuffer);
        
        const existingFile = hashMap.get(contentHash);
        if (existingFile) {
            // File exists - check if we should rename it
            // Always rename provider gallery files (e.g. {provider}gallery_*) to localized_media_* (embedded takes precedence)
            // Also rename files that don't follow localized_media_* naming convention
            // Also rename if extension doesn't match actual content type (fixes corrupted files)
            const isProviderGalleryFile = (window.ProviderRegistry?.getAllProviders() || [])
                .some(p => existingFile.fileName.startsWith(p.galleryFilePrefix + '_'));
            const isAlreadyLocalized = existingFile.fileName.startsWith('localized_media_') || existingFile.fileName.startsWith('lorebook_media_') || existingFile.fileName.startsWith('extgallery_');
            const hasCorrectPrefix = existingFile.fileName.startsWith(prefix + '_');
            
            // Check if extension matches detected content type
            let hasWrongExtension = false;
            if (downloadResult.contentType && isAlreadyLocalized) {
                const currentExt = existingFile.fileName.includes('.') 
                    ? existingFile.fileName.substring(existingFile.fileName.lastIndexOf('.') + 1).toLowerCase()
                    : '';
                const expectedExtMap = {
                    'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
                    'image/bmp': 'bmp', 'image/svg+xml': 'svg',
                    'video/mp4': 'mp4', 'video/webm': 'webm',
                    'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg',
                    'audio/flac': 'flac', 'audio/aac': 'aac', 'audio/mp4': 'm4a'
                };
                const expectedExt = expectedExtMap[downloadResult.contentType];
                // Check if current extension mismatches expected (e.g., audio saved as .png)
                if (expectedExt && currentExt !== expectedExt) {
                    // Special case: jpg vs jpeg are equivalent
                    if (!(currentExt === 'jpeg' && expectedExt === 'jpg') && !(currentExt === 'jpg' && expectedExt === 'jpeg')) {
                        hasWrongExtension = true;
                        debugLog(`[EmbeddedMedia] Extension mismatch: ${existingFile.fileName} has .${currentExt} but content is ${downloadResult.contentType} (should be .${expectedExt})`);
                    }
                }
            }
            
            const fixFilenames = getSetting('fixFilenames') !== false;
            // Prefix priority: localized_media > lorebook_media > extgallery > provider gallery > unknown
            // Never reclassify a higher-priority prefix to a lower one
            const PREFIX_PRIORITY = { 'localized_media': 4, 'lorebook_media': 3, 'extgallery': 2 };
            const existingPriority = Object.entries(PREFIX_PRIORITY).find(([p]) => existingFile.fileName.startsWith(p + '_'))?.[1] || (isProviderGalleryFile ? 1 : 0);
            const currentPriority = PREFIX_PRIORITY[prefix] || (isProviderGalleryFile ? 1 : 0);
            const wouldDowngrade = hasCorrectPrefix ? false : existingPriority >= currentPriority;
            const needsRename = hasWrongExtension || (isProviderGalleryFile && currentPriority > 1) || (!isAlreadyLocalized && !isProviderGalleryFile) || (fixFilenames && !hasCorrectPrefix && !wouldDowngrade);
            
            if (needsRename) {
                const renameResult = await renameToLocalizedFormat(existingFile, url, folderName, fileIndex, downloadResult, prefix, saveName);
                downloadResult = null;
                if (renameResult.success) {
                    renamedCount++;
                    const action = isProviderGalleryFile ? 'Converted' : (!hasCorrectPrefix && isAlreadyLocalized) ? 'Reclassified' : (hasWrongExtension ? 'Fixed extension' : 'Renamed');
                    if (onLogUpdate && logEntry) onLogUpdate(logEntry, `${action}: ${existingFile.fileName} → ${renameResult.newName}`, 'success');
                } else {
                    skippedCount++;
                    if (onLogUpdate && logEntry) onLogUpdate(logEntry, `Skipped (rename failed): ${displayUrl}`, 'success');
                }
            } else {
                // Check if existing file was saved under a different URL's name.
                // If so, save an additional copy so both URLs resolve during localization lookup.
                // Only for localized/lorebook files — provider gallery files aren't part of text localization.
                const existingSanitized = isAlreadyLocalized
                    ? existingFile.fileName.match(/^(?:localized_media|lorebook_media)_\d+_(.+)\.[^.]+$/)
                    : null;
                const currentSanitized = existingSanitized ? (saveName || extractSanitizedUrlName(url)) : null;
                if (existingSanitized && currentSanitized && existingSanitized[1] !== currentSanitized) {
                    const aliasResult = await saveMediaFromMemory({ arrayBuffer: downloadResult.arrayBuffer, contentType: downloadResult.contentType }, url, folderName, fileIndex, prefix, saveName);
                    downloadResult = null;
                    if (aliasResult.success) {
                        successCount++;
                        hashMap.set(contentHash + '_alias_' + currentSanitized, { fileName: aliasResult.filename, localPath: aliasResult.localPath });
                        if (onLogUpdate && logEntry) onLogUpdate(logEntry, `Saved alias: ${aliasResult.filename} (same content as ${existingFile.fileName})`, 'success');
                    } else {
                        skippedCount++;
                        if (onLogUpdate && logEntry) onLogUpdate(logEntry, `Skipped (already localized): ${displayUrl}`, 'success');
                    }
                } else {
                    skippedCount++;
                    downloadResult = null;
                    if (onLogUpdate && logEntry) onLogUpdate(logEntry, `Skipped (already localized): ${displayUrl}`, 'success');
                }
            }
            debugLog(`[EmbeddedMedia] Duplicate found: ${url} -> ${existingFile.fileName}`);
            if (onProgress) onProgress(i + 1, mediaUrls.length);
            continue;
        }
        
        // Not a duplicate, save the file
        if (onLogUpdate && logEntry) onLogUpdate(logEntry, `Saving ${displayUrl}...`, 'pending');
        const result = await saveMediaFromMemory(downloadResult, url, folderName, fileIndex, prefix, saveName);
        downloadResult = null; // Release after save
        
        if (result.success) {
            successCount++;
            // Add to hash map to avoid downloading same file twice in this session
            hashMap.set(contentHash, { fileName: result.filename, localPath: result.localPath });
            // Update filename index for cross-phase fast-skip
            if (fileNameIndex) MD?.noteSavedFile(fileNameIndex, { url, filename: nameHint }, result);
            if (onLogUpdate && logEntry) onLogUpdate(logEntry, `Saved: ${result.filename}`, 'success');
        } else {
            // A save can fail for reasons a retry will never fix (e.g. ST core
            // rejecting a format outside its own upload whitelist, like svg/avif)
            // just as surely as a download 404 — ledger it the same way.
            const failure = MD?.recordFailure(url, MD.classifyFailure(result));
            if (failure?.dead) {
                skippedCount++;
                if (onLogUpdate && logEntry) onLogUpdate(logEntry, `Unreachable, giving up: ${displayUrl} - ${result.error}`, 'info');
            } else {
                errorCount++;
                if (onLogUpdate && logEntry) onLogUpdate(logEntry, `Failed: ${displayUrl} - ${result.error}`, 'error');
            }
        }
        
        if (onProgress) onProgress(i + 1, mediaUrls.length);
        
        // Yield to browser for GC between media uploads (critical for mobile)
        await new Promise(r => setTimeout(r, 50));
    }
    
    return { success: successCount, skipped: skippedCount, errors: errorCount, renamed: renamedCount, filenameSkipped: filenameSkippedCount, aborted: false };
}

/**
 * Rename an existing file to {prefix}_* format
 * Since there's no rename API, we delete old + save new (data already in memory)
 * @param {Object} existingFile - Existing file info
 * @param {string} originalUrl - Original URL of the media
 * @param {string} folderName - Gallery folder name (use getGalleryFolderName() for unique folders)
 * @param {number} index - File index for naming
 * @param {Object} downloadResult - Result from downloadMediaToMemory
 * @param {string} [prefix='localized_media'] - Filename prefix
 * @param {string} [nameHint] - Preferred base name (extractor-supplied filename)
 */
async function renameToLocalizedFormat(existingFile, originalUrl, folderName, index, downloadResult, prefix = 'localized_media', nameHint = '') {
    try {
        // Save with new name using saveMediaFromMemory which determines correct extension
        // from the detected content type (via magic bytes), not the old filename
        const saveResult = await saveMediaFromMemory(downloadResult, originalUrl, folderName, index, prefix, nameHint);
        
        if (!saveResult.success) {
            return { success: false, error: saveResult.error };
        }
        
        // Delete the old file - API expects full relative path like "/user/images/CharName/file.png"
        const safeFolderName = sanitizeFolderName(folderName);
        const deletePath = `/user/images/${safeFolderName}/${existingFile.fileName}`;
        const deleteResponse = await apiRequest(ENDPOINTS.IMAGES_DELETE, 'POST', {
            path: deletePath
        });
        await deleteResponse.text().catch(() => {});
        
        if (!deleteResponse.ok) {
            console.warn(`[EmbeddedMedia] Could not delete old file ${existingFile.fileName} (path: ${deletePath}), but new file was saved`);
        } else {
            debugLog(`[EmbeddedMedia] Deleted old file: ${deletePath}`);
        }
        
        return { success: true, newName: saveResult.filename };
    } catch (error) {
        console.error('[EmbeddedMedia] Rename error:', error);
        return { success: false, error: error.message };
    }
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
    
    // Match raw URLs for media files
    const urlPattern = /(https?:\/\/[^\s<>"{}|\\^`\[\]]+\.(?:png|jpg|jpeg|gif|webp|svg|mp4|webm|mov|mp3|wav|ogg|m4a)(?:\/[^\s<>"'{}|\\^`\[\]]+)?)/gi;
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
 * Get hashes of all existing files in a character's gallery
 * @returns {Promise<Map<string, {fileName: string, localPath: string}>>} Map of hash -> file info
 */
async function getExistingFileHashes(characterName) {
    const hashMap = new Map();
    
    try {
        // Request all media types: IMAGE=1, VIDEO=2, AUDIO=4, so 7 = all
        const response = await apiRequest(ENDPOINTS.IMAGES_LIST, 'POST', { folder: characterName, type: 7 });
        
        if (!response.ok) {
            debugLog('[Localize] Could not list existing files');
            return hashMap;
        }
        
        const files = await response.json();
        if (!files || files.length === 0) {
            return hashMap;
        }
        
        // Sanitize folder name to match SillyTavern's folder naming convention
        const safeFolderName = sanitizeFolderName(characterName);
        
        // Calculate hash for each existing file
        // Process one at a time and null the buffer immediately to keep peak memory low
        for (const file of files) {
            const fileName = (typeof file === 'string') ? file : file.name;
            if (!fileName) continue;
            
            // Only check media files
            if (!fileName.match(/\.(png|jpg|jpeg|webp|gif|bmp|mp3|wav|ogg|m4a|mp4|webm)$/i)) continue;
            
            const localPath = galleryFileUrl(safeFolderName, fileName);
            
            try {
                const fileResponse = await fetch(localPath);
                if (fileResponse.ok) {
                    let buffer = await fileResponse.arrayBuffer();
                    const hash = await calculateHash(buffer);
                    buffer = null; // Release immediately — critical for mobile memory
                    hashMap.set(hash, { fileName, localPath });
                }
            } catch (e) {
                console.warn(`[Localize] Could not hash existing file: ${fileName}`);
            }
        }
        
        return hashMap;
    } catch (error) {
        console.error('[Localize] Error getting existing file hashes:', error);
        return hashMap;
    }
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
 * Save a media file from memory (already downloaded ArrayBuffer) to character's gallery
 * @param {Object} downloadResult - Result from downloadMediaToMemory
 * @param {string} url - Original URL of the media
 * @param {string} folderName - Gallery folder name (use getGalleryFolderName() for unique folders)
 * @param {number} index - File index for naming
 * @param {string} [prefix='localized_media'] - Filename prefix
 * @param {string} [nameHint] - Preferred base name (extractor-supplied filename)
 */
async function saveMediaFromMemory(downloadResult, url, folderName, index, prefix = 'localized_media', nameHint = '') {
    try {
        const { arrayBuffer, contentType } = downloadResult;
        
        // Determine file extension from content type (detected via magic bytes)
        let extension = 'png'; // Default for images
        if (contentType) {
            const mimeToExt = {
                // Images
                'image/png': 'png',
                'image/jpeg': 'jpg',
                'image/webp': 'webp',
                'image/gif': 'gif',
                'image/bmp': 'bmp',
                'image/svg+xml': 'svg',
                // Video
                'video/mp4': 'mp4',
                'video/webm': 'webm',
                'video/quicktime': 'mov',
                // Audio
                'audio/mpeg': 'mp3',
                'audio/mp3': 'mp3',
                'audio/wav': 'wav',
                'audio/wave': 'wav',
                'audio/x-wav': 'wav',
                'audio/ogg': 'ogg',
                'audio/flac': 'flac',
                'audio/x-flac': 'flac',
                'audio/aac': 'aac',
                'audio/mp4': 'm4a',
                'audio/x-m4a': 'm4a'
            };
            
            // Try exact match first
            if (mimeToExt[contentType]) {
                extension = mimeToExt[contentType];
            } else if (contentType.startsWith('audio/')) {
                // Unknown audio type - extract subtype as extension, don't default to png!
                const subtype = contentType.split('/')[1].split(';')[0];
                extension = subtype.replace('x-', '') || 'audio';
                debugLog(`[EmbeddedMedia] Unknown audio type '${contentType}', using extension: ${extension}`);
            } else if (contentType.startsWith('video/')) {
                // Unknown video type - extract subtype as extension
                const subtype = contentType.split('/')[1].split(';')[0];
                extension = subtype.replace('x-', '') || 'video';
                debugLog(`[EmbeddedMedia] Unknown video type '${contentType}', using extension: ${extension}`);
            }
            // For unknown image types, 'png' default is acceptable
        } else {
            const urlMatch = url.match(/\.([a-zA-Z0-9]+)(?:\?|$)/);
            if (urlMatch) {
                extension = urlMatch[1].toLowerCase();
            }
        }
        
        // Prefer an extractor-supplied name; otherwise derive from the URL
        // (which handles CDN variant segments).
        const sanitizedName = nameHint || extractSanitizedUrlName(url) || 'media';
        
        // Generate local filename
        const filenameBase = `${prefix}_${index}_${sanitizedName}`;
        
        // Convert arrayBuffer to base64 then release the buffer immediately.
        // This prevents holding both the raw buffer (5MB) and the base64 string (6.7MB)
        // simultaneously during the upload await — critical for mobile memory.
        let base64Data = arrayBufferToBase64(arrayBuffer);
        // Break the reference so the ArrayBuffer can be GC'd during upload
        downloadResult.arrayBuffer = null;
        
        // Build JSON body, then release the base64 string — the JSON body contains it.
        const bodyStr = JSON.stringify({
            image: base64Data,
            filename: filenameBase,
            format: extension,
            ch_name: folderName
        });
        base64Data = null; // Release — serialized into bodyStr
        
        // Use fetch directly (instead of apiRequest) so we control the body lifecycle
        const csrfToken = getCSRFToken();
        const saveResponse = await fetch(`${API_BASE}${ENDPOINTS.IMAGES_UPLOAD}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrfToken
            },
            body: bodyStr
        });
        
        if (!saveResponse.ok) {
            const errorText = await saveResponse.text();
            throw new Error(`Upload failed: ${errorText}`);
        }
        
        const saveResult = await saveResponse.json();
        
        if (!saveResult || !saveResult.path) {
            throw new Error('No path returned from upload');
        }
        
        return {
            success: true,
            localPath: saveResult.path,
            filename: `${filenameBase}.${extension}`
        };
        
    } catch (error) {
        return {
            success: false,
            error: error.message || String(error)
        };
    }
}

/**
 * Download images from external gallery pages found in a character's text fields.
 * Phase 3 of the localization pipeline (after embedded + provider gallery).
 * @param {Object} character - Character object (must be hydrated)
 * @param {string} folderName - Gallery folder name
 * @param {Object} [options]
 * @param {function} [options.onLog] - Log entry callback
 * @param {function} [options.onLogUpdate] - Log update callback
 * @param {function} [options.onProgress] - Progress callback (current, total)
 * @param {function} [options.shouldAbort] - Abort check callback
 * @param {AbortSignal} [options.abortSignal] - Abort signal
 * @returns {Promise<{success: number, skipped: number, errors: number, aborted: boolean}>}
 */
async function downloadExternalGalleryForCharacter(character, folderName, options = {}) {
    const { onLog, onLogUpdate, onProgress, shouldAbort, abortSignal, dedupState, galleryPageUrls: overrideUrls } = options;

    const result = { success: 0, skipped: 0, errors: 0, aborted: false };
    const MD = window.MediaDedup;

    const galleryUrls = overrideUrls || (typeof window.findCharacterGalleryUrls === 'function'
        ? window.findCharacterGalleryUrls(character)
        : []);
    if (galleryUrls.length === 0) return result;

    await MD?.loadLedger();
    let allImages = [];

    for (let i = 0; i < galleryUrls.length; i++) {
        if ((shouldAbort && shouldAbort()) || abortSignal?.aborted) {
            result.aborted = true;
            return result;
        }

        const gUrl = galleryUrls[i];
        const displayUrl = gUrl.length > 60 ? gUrl.substring(0, 60) + '...' : gUrl;

        // A deleted MEGA folder is the usual way a character gets pinned in a
        // permanent retry loop — the page itself is ledgered, not just its files.
        if (MD?.isDead(gUrl)) {
            result.skipped++;
            if (onLog) onLog(`Unreachable gallery, skipping: ${displayUrl} (${MD.deadReason(gUrl)})`, 'info');
            continue;
        }

        const logEntry = onLog ? onLog(`Extracting: ${displayUrl}`, 'pending') : null;

        try {
            const extracted = await window.extractGalleryImages(gUrl, { signal: abortSignal, character });
            if (extracted.aborted) {
                if (onLogUpdate && logEntry) onLogUpdate(logEntry, `Aborted: ${displayUrl}`, 'error');
                result.aborted = true;
                return result;
            }
            if (extracted.error) {
                const failure = MD?.recordFailure(gUrl, MD.classifyExtractionFailure(extracted.error));
                if (failure?.dead) {
                    result.skipped++;
                    if (onLogUpdate && logEntry) onLogUpdate(logEntry, `Unreachable gallery, giving up: ${displayUrl} (${extracted.error})`, 'info');
                } else {
                    result.errors++;
                    if (onLogUpdate && logEntry) onLogUpdate(logEntry, `Failed to extract: ${displayUrl} (${extracted.error})`, 'error');
                }
                continue;
            }
            MD?.recordSuccess(gUrl);
            if (extracted.images.length > 0) {
                if (onLogUpdate && logEntry) onLogUpdate(logEntry, `Found ${extracted.images.length} image(s) from ${displayUrl}`, 'success');
                allImages.push(...extracted.images);
            } else {
                if (onLogUpdate && logEntry) onLogUpdate(logEntry, `No images found at ${displayUrl}`, 'info');
            }
        } catch (err) {
            if (err.name === 'AbortError') { result.aborted = true; return result; }
            if (onLogUpdate && logEntry) onLogUpdate(logEntry, `Error extracting ${displayUrl}: ${err.message}`, 'error');
            result.errors++;
        }
    }

    if (allImages.length === 0) return result;

    const imageUrls = allImages.map(img => img.url);
    const downloadFnMap = new Map();
    const nameHints = new Map();
    for (const img of allImages) {
        if (typeof img.downloadFn === 'function') downloadFnMap.set(img.url, img.downloadFn);
        // The real filename is the only usable dedup key for extractors whose
        // URLs are synthetic (MEGA) or all-identical (Drive's /uc?id=...).
        if (img.filename) nameHints.set(img.url, img.filename);
    }

    const downloadResult = await downloadEmbeddedMediaForCharacter(folderName, imageUrls, {
        prefix: 'extgallery',
        onProgress,
        onLog,
        onLogUpdate,
        shouldAbort,
        abortSignal,
        dedupState,
        downloadFnMap,
        nameHints
    });

    result.success += downloadResult.success;
    result.skipped += downloadResult.skipped;
    result.errors += downloadResult.errors;
    result.aborted = !!downloadResult.aborted;

    return result;
}


