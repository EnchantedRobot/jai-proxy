// ==============================================
// On-the-fly Media Localization (URL Replacement)
// ==============================================

/**
 * Cache for URL→LocalPath mappings per character
 * Structure: { charAvatar: { remoteUrl: localPath, ... } }
 */
const mediaLocalizationCache = {};

/**
 * Sanitize a filename the same way saveMediaFromMemory does
 * This ensures we can match remote URLs to their saved local files
 */
function sanitizeMediaFilename(filename) {
    const nameWithoutExt = filename.includes('.') 
        ? filename.substring(0, filename.lastIndexOf('.'))
        : filename;
    return nameWithoutExt.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 40);
}

/**
 * Extract the filename from a remote URL
 */
function extractFilenameFromUrl(url) {
    try {
        const urlObj = new URL(url);
        const pathParts = urlObj.pathname.split('/');
        return pathParts[pathParts.length - 1] || '';
    } catch (e) {
        const parts = url.split('/');
        return parts[parts.length - 1]?.split('?')[0] || '';
    }
}

/**
 * Media localization is always on -- local media is authoritative whenever it exists,
 * remote is the fallback. The URL-substitution below already no-ops when the gallery
 * has no matching local file, which is what makes "always on" safe.
 * @param {string} avatar - Character avatar filename (e.g., "Rory.png"), unused
 * @returns {boolean} always true
 */
function isMediaLocalizationEnabled(avatar) {
    return true;
}

/**
 * Build URL→LocalPath mapping for a character by scanning their gallery folder
 * @param {string} characterName - Character name (folder name)
 * @param {string} avatar - Character avatar filename (for cache key)
 * @param {boolean} forceRefresh - Force rebuild cache even if exists
 * @returns {Promise<Object>} Map of { remoteUrl: localPath }
 */
async function buildMediaLocalizationMap(characterName, avatar, forceRefresh = false) {
    // Check cache first
    if (!forceRefresh && avatar && mediaLocalizationCache[avatar]) {
        return mediaLocalizationCache[avatar];
    }
    
    const urlMap = {};
    const safeFolderName = sanitizeFolderName(characterName);
    
    try {
        // Get list of files in character's gallery (all media types = 7)
        const response = await apiRequest(ENDPOINTS.IMAGES_LIST, 'POST', { folder: characterName, type: 7 });
        
        if (!response.ok) {
            debugLog('[MediaLocalize] Could not list gallery files');
            return urlMap;
        }
        
        const files = await response.json();
        if (!files || files.length === 0) {
            return urlMap;
        }
        
        // Parse localized/lorebook/provider-gallery media files to build reverse mapping
        // Format: {localized_media|lorebook_media}_{index}_{sanitizedName}.{ext}
        // Format: {provider}gallery_{hash8}_{sanitizedName}.{ext}
        const localizedPattern = /^(?:(?:localized_media|lorebook_media)_\d+|[a-z]+gallery_[a-f0-9]+)_(.+)\.[^.]+$/;
        
        for (const file of files) {
            const fileName = (typeof file === 'string') ? file : file.name;
            if (!fileName) continue;
            
            // Only process media files
            if (!fileName.match(/\.(png|jpg|jpeg|webp|gif|bmp|svg|mp3|wav|ogg|m4a|mp4|webm)$/i)) continue;
            
            const localPath = galleryFileUrl(safeFolderName, fileName);
            
            // Method 1: Check for localized_media_* pattern
            const match = fileName.match(localizedPattern);
            if (match) {
                const sanitizedName = match[1]; // The sanitized original filename
                urlMap[`__sanitized__${sanitizedName}`] = localPath;
            }
            
            // Method 2: Also map by the raw filename (without extension)
            // This catches files that were imported with their original names
            const nameWithoutExt = fileName.includes('.') 
                ? fileName.substring(0, fileName.lastIndexOf('.'))
                : fileName;
            // Store by original filename for direct matching
            urlMap[`__filename__${nameWithoutExt}`] = localPath;
        }
        
        // Cache the mapping
        if (avatar) {
            mediaLocalizationCache[avatar] = urlMap;
        }
        
        debugLog(`[MediaLocalize] Built map for ${characterName}: ${Object.keys(urlMap).length} entries`);
        return urlMap;
        
    } catch (error) {
        console.error('[MediaLocalize] Error building localization map:', error);
        return urlMap;
    }
}

/**
 * Look up a remote URL in the localization map and return local path if found
 * @param {Object} urlMap - The localization map from buildMediaLocalizationMap
 * @param {string} remoteUrl - The remote URL to look up
 * @returns {string|null} Local path if found, null otherwise
 */
function lookupLocalizedMedia(urlMap, remoteUrl) {
    if (!urlMap || !remoteUrl) return null;
    
    // Extract filename from URL
    const filename = extractFilenameFromUrl(remoteUrl);
    if (!filename) return null;
    
    // Get filename without extension for direct matching
    const nameWithoutExt = filename.includes('.') 
        ? filename.substring(0, filename.lastIndexOf('.'))
        : filename;
    
    // Method 1: Try direct filename match first (most reliable)
    let localPath = urlMap[`__filename__${nameWithoutExt}`];
    if (localPath) return localPath;
    
    // Method 2: Try sanitized name match (for localized_media_* files)
    const sanitizedName = sanitizeMediaFilename(filename);
    localPath = urlMap[`__sanitized__${sanitizedName}`];
    if (localPath) return localPath;

    // Method 3: CDN-aware match — files saved with parent+variant naming
    const cdnAwareName = extractSanitizedUrlName(remoteUrl);
    if (cdnAwareName && cdnAwareName !== sanitizedName) {
        localPath = urlMap[`__sanitized__${cdnAwareName}`];
        if (localPath) return localPath;
    }

    return null;
}

/**
 * Replace remote media URLs in text with local paths
 * @param {string} text - Text containing media URLs (markdown/HTML)
 * @param {Object} urlMap - The localization map
 * @returns {string} Text with URLs replaced
 */
function replaceMediaUrlsInText(text, urlMap) {
    if (!text || !urlMap || Object.keys(urlMap).length === 0) return text;
    
    let result = text;
    
    // Replace markdown images: ![alt](url)
    result = result.replace(/!\[([^\]]*)\]\(((?:[^\s()]|\([^\s()]*\))+|[^)\s]+)(?:\s*=[^)]*)?(?:\s+"[^"]*")?\)/g, (match, alt, url) => {
        const localPath = lookupLocalizedMedia(urlMap, url);
        if (localPath) {
            return `![${alt}](${localPath})`;
        }
        return match;
    });
    
    // Replace markdown links to media: [text](url.ext)
    result = result.replace(/\[([^\]]*)\]\((https?:\/\/[^)\s]+\.(?:png|jpg|jpeg|gif|webp|svg|mp4|webm|mov|mp3|wav|ogg|m4a))(?:\s+"[^"]*)?\)/gi, (match, text, url) => {
        const localPath = lookupLocalizedMedia(urlMap, url);
        if (localPath) {
            return `[${text}](${localPath})`;
        }
        return match;
    });
    
    // Replace HTML img src: <img src="url">
    result = result.replace(/<img([^>]+)src=["']([^"']+)["']([^>]*)>/gi, (match, before, url, after) => {
        const localPath = lookupLocalizedMedia(urlMap, url);
        if (localPath) {
            return `<img${before}src="${localPath}"${after}>`;
        }
        return match;
    });
    
    // Replace video sources: <video src="url"> or <source src="url">
    result = result.replace(/<(video|source)([^>]+)src=["']([^"']+)["']([^>]*)>/gi, (match, tag, before, url, after) => {
        const localPath = lookupLocalizedMedia(urlMap, url);
        if (localPath) {
            return `<${tag}${before}src="${localPath}"${after}>`;
        }
        return match;
    });
    
    // Replace audio sources: <audio src="url">
    result = result.replace(/<audio([^>]+)src=["']([^"']+)["']([^>]*)>/gi, (match, before, url, after) => {
        const localPath = lookupLocalizedMedia(urlMap, url);
        if (localPath) {
            return `<audio${before}src="${localPath}"${after}>`;
        }
        return match;
    });
    
    // Replace CSS url() patterns: background-image: url('...'), content: url("..."), etc.
    result = result.replace(/url\((["']?)(https?:\/\/[^"')\s]+\.(?:png|jpg|jpeg|gif|webp|svg|mp4|webm|mov|mp3|wav|ogg|m4a))\1\)/gi, (match, quote, url) => {
        const localPath = lookupLocalizedMedia(urlMap, url);
        if (localPath) {
            return `url(${quote}${localPath}${quote})`;
        }
        return match;
    });
    
    // Replace raw media URLs (not already in markdown or HTML tags)
    result = result.replace(/(^|[^"'(])((https?:\/\/[^\s<>"{}|\\^`\[\]]+\.(?:png|jpg|jpeg|gif|webp|svg|mp4|webm|mov|mp3|wav|ogg|m4a)))(?=[)\s<"']|$)/gi, (match, prefix, url) => {
        const localPath = lookupLocalizedMedia(urlMap, url);
        if (localPath) {
            return prefix + localPath;
        }
        return match;
    });
    
    // Final fallback: Direct string replacement for any remaining URLs
    // This catches URLs in any format the regex patterns might have missed
    // Build list of all remote URLs we have local versions for
    for (const [key, localPath] of Object.entries(urlMap)) {
        if (!key.startsWith('__sanitized__')) continue;
        const sanitizedName = key.replace('__sanitized__', '');
        
        // Find any remaining remote URLs with this filename and replace them
        // Match the filename in any imageshack/catbox/etc URL pattern
        const filenamePattern = new RegExp(
            `(https?://[^\\s"'<>]+[/=])${sanitizedName}(\\.[a-z0-9]+)`,
            'gi'
        );
        result = result.replace(filenamePattern, () => localPath);
    }
    
    return result;
}

/**
 * Apply media localization to already-rendered modal content
 * Called asynchronously after modal opens to update URLs without blocking
 * @param {Object} char - Character object
 * @param {string} desc - Original description
 * @param {string} firstMes - Original first message
 * @param {Array} altGreetings - Original alternate greetings
 * @param {string} creatorNotes - Original creator notes
 * @param {number} [gen] - Modal generation to write under; defaults to the current one. Callers
 *   that awaited before calling should pass the generation they captured before those awaits.
 */
async function applyMediaLocalizationToModal(char, desc, firstMes, altGreetings, creatorNotes, gen = _modalOpenGen) {
    const avatar = char?.avatar;
    const charName = char?.name || char?.data?.name || '';
    // Use proper gallery folder name (may include _uuid suffix)
    const folderName = getGalleryFolderName(char);
    
    if (!avatar || !isMediaLocalizationEnabled(avatar)) {
        return;
    }
    
    const urlMap = await buildMediaLocalizationMap(folderName, avatar);
    // Unconditional: a swap during the fetch means these writes belong to the previous card.
    if (gen !== _modalOpenGen) return;
    
    if (Object.keys(urlMap).length === 0) {
        return;
    }
    
    debugLog(`[MediaLocalize] Applying localization to modal for ${charName} (${Object.keys(urlMap).length} map entries)`);
    
    // Update Description
    if (desc) {
        const localizedDesc = replaceMediaUrlsInText(desc, urlMap);
        if (localizedDesc !== desc) {
            document.getElementById('modalDescription').innerHTML = formatRichText(localizedDesc, charName);
        }
    }
    
    // Update First Message
    if (firstMes) {
        const localizedFirstMes = replaceMediaUrlsInText(firstMes, urlMap);
        if (localizedFirstMes !== firstMes) {
            document.getElementById('modalFirstMes').innerHTML = formatRichText(localizedFirstMes, charName);
        }
    }
    
    // Update Alternate Greetings
    if (altGreetings && altGreetings.length > 0) {
        let anyChanged = false;
        const listHTML = altGreetings.map((g, i) => {
            const original = (g || '').trim();
            const localized = replaceMediaUrlsInText(original, urlMap);
            if (localized !== original) anyChanged = true;
            return `<div style="margin-bottom: 15px; padding-bottom: 10px; border-bottom: 1px dashed rgba(255,255,255,0.1);"><strong style="color:var(--accent);">#${i+1}:</strong> <span>${formatRichText(localized, charName)}</span></div>`;
        }).join('');
        
        if (anyChanged) {
            document.getElementById('modalAltGreetings').innerHTML = listHTML;
        }
    }
    
    // Update Creator Notes (re-render if content changed)
    if (creatorNotes) {
        const localizedNotes = replaceMediaUrlsInText(creatorNotes, urlMap);
        if (localizedNotes !== creatorNotes) {
            const notesContainer = document.getElementById('modalCreatorNotes');
            if (notesContainer) {
                renderCreatorNotesSecure(localizedNotes, charName, notesContainer);
            }
        }
    }
}

/**
 * Clear the media localization cache for a character (call after downloading new media)
 */
function clearMediaLocalizationCache(avatar) {
    if (avatar && mediaLocalizationCache[avatar]) {
        delete mediaLocalizationCache[avatar];
        debugLog(`[MediaLocalize] Cleared cache for ${avatar}`);
    }
}

/**
 * Clear entire media localization cache
 */
function clearAllMediaLocalizationCache() {
    Object.keys(mediaLocalizationCache).forEach(key => delete mediaLocalizationCache[key]);
    debugLog('[MediaLocalize] Cleared all cache');
}

