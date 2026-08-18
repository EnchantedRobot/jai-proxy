// ========================================
// SMART IMAGE RELOCATION SYSTEM
// Uses content hashes from provider gallery + embedded URLs as "fingerprints"
// to determine which images belong to which character when migrating
// from shared folders to unique folders
// ========================================

// A run of these statuses = blocked; 404/timeouts never count (stale links must not false-trip).
const RELOCATE_BLOCK_STATUSES = new Set([403, 429, 503]);
const RELOCATE_BLOCK_THRESHOLD = 5;
const RELOCATE_GALLERY_FETCH_DELAY_MS = 150; // light pacing between provider gallery downloads

/**
 * Build an ownership fingerprint for a character by downloading and hashing
 * their provider gallery images and embedded media URLs (without saving).
 * This fingerprint proves which images belong to this character.
 * @param {object} char - Character object
 * @param {object} options - Progress callbacks
 * @returns {Promise<{hashes: Set<string>, errors: number, providerGalleryCount: number, embeddedCount: number}>}
 */
async function buildOwnershipFingerprint(char, options = {}) {
    const { onLog, onLogUpdate, shouldAbort, rateLimit } = options;
    const hashes = new Set();
    let errors = 0;
    let providerGalleryCount = 0;
    let embeddedCount = 0;
    
    // 1. Get hashes from provider gallery images (if character is linked)
    const providerMatch = window.ProviderRegistry?.getCharacterProvider(char) || null;
    const fpProvider = providerMatch?.provider;
    const fpLinkInfo = providerMatch?.linkInfo;
    if (fpProvider?.supportsGallery && fpLinkInfo) {
        const logEntry = onLog ? onLog(`Fetching ${fpProvider.name} gallery fingerprint for ${char.name}...`, 'pending') : null;
        
        try {
            const galleryImages = await fpProvider.fetchGalleryImages(fpLinkInfo);
            
            for (const image of galleryImages) {
                if (shouldAbort && shouldAbort()) break;

                let downloadResult = await downloadMediaToMemory(image.url || image.imageUrl, 30000);
                if (downloadResult.success) {
                    const hash = await calculateHash(downloadResult.arrayBuffer);
                    hashes.add(hash);
                    providerGalleryCount++;
                    if (rateLimit) rateLimit.consecutiveBlocks = 0;
                } else {
                    errors++;
                    // Trip the shared breaker once a run of block statuses confirms a rate-limit.
                    if (rateLimit && RELOCATE_BLOCK_STATUSES.has(downloadResult.status)) {
                        rateLimit.consecutiveBlocks++;
                        rateLimit.providerName = fpProvider.name || rateLimit.providerName;
                        if (rateLimit.consecutiveBlocks >= RELOCATE_BLOCK_THRESHOLD) {
                            rateLimit.tripped = true;
                            downloadResult = null;
                            break;
                        }
                    }
                }
                downloadResult = null;
                if (RELOCATE_GALLERY_FETCH_DELAY_MS > 0) {
                    await new Promise(resolve => setTimeout(resolve, RELOCATE_GALLERY_FETCH_DELAY_MS));
                }
            }
            
            if (onLogUpdate && logEntry) {
                onLogUpdate(logEntry, `${fpProvider.name} gallery: ${providerGalleryCount} hashes collected`, 'success');
            }
        } catch (e) {
            console.error('[Fingerprint] Provider gallery error:', e);
            if (onLogUpdate && logEntry) {
                onLogUpdate(logEntry, `${fpProvider.name} gallery error: ${e.message}`, 'error');
            }
        }
    }
    
    // 2. Get hashes from embedded media URLs
    const mediaUrls = findCharacterMediaUrls(char);
    if (mediaUrls.length > 0) {
        const logEntry = onLog ? onLog(`Fetching embedded media fingerprint (${mediaUrls.length} URLs)...`, 'pending') : null;
        
        for (const url of mediaUrls) {
            if (shouldAbort && shouldAbort()) break;
            
            try {
                let downloadResult = await downloadMediaToMemory(url, 30000);
                if (downloadResult.success) {
                    const hash = await calculateHash(downloadResult.arrayBuffer);
                    hashes.add(hash);
                    embeddedCount++;
                } else {
                    errors++;
                }
                downloadResult = null; // Release immediately
            } catch (e) {
                errors++;
            }
        }
        
        if (onLogUpdate && logEntry) {
            onLogUpdate(logEntry, `Embedded media: ${embeddedCount} hashes collected`, 'success');
        }
    }
    
    debugLog(`[Fingerprint] ${char.name}: ${hashes.size} total hashes (${providerGalleryCount} provider, ${embeddedCount} embedded, ${errors} errors)`);

    return { hashes, errors, providerGalleryCount, embeddedCount };
}

/**
 * Scan a folder and get hash -> filename map for all images
 * @param {string} folderName - Folder to scan
 * @returns {Promise<Map<string, string>>} Map of hash -> filename
 */
async function scanFolderForImageHashes(folderName) {
    const hashToFile = new Map();
    
    try {
        const response = await apiRequest(ENDPOINTS.IMAGES_LIST, 'POST', { folder: folderName, type: 7 });
        
        if (!response.ok) {
            debugLog('[Migration] Could not list folder:', folderName);
            return hashToFile;
        }
        
        const files = await response.json();
        if (!files || files.length === 0) {
            return hashToFile;
        }

        let encodedFolder;
        try { encodedFolder = encodeURIComponent(folderName); } catch { return hashToFile; }
        
        for (const file of files) {
            const fileName = (typeof file === 'string') ? file : file.name;
            if (!fileName) continue;
            
            if (!fileName.match(/\.(png|jpg|jpeg|webp|gif|bmp|mp3|wav|ogg|m4a|mp4|webm)$/i)) continue;
            
            const localPath = galleryFileUrl(folderName, fileName);
            
            try {
                const fileResponse = await fetch(localPath);
                if (fileResponse.ok) {
                    const buffer = await fileResponse.arrayBuffer();
                    const hash = await calculateHash(buffer);
                    hashToFile.set(hash, fileName);
                }
            } catch (e) {
                console.warn(`[Migration] Could not hash file: ${fileName}`);
            }
        }
    } catch (error) {
        console.error('[Migration] Error scanning folder:', error);
    }
    
    return hashToFile;
}

/**
 * Move/copy an image file from one gallery folder to another
 * Since there's no move API, we download the file and re-upload to the new folder
 * @param {string} sourceFolder - Source folder name
 * @param {string} targetFolder - Target folder name  
 * @param {string} fileName - File name to move
 * @param {boolean} deleteSource - Whether to delete from source after copying
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function moveImageToFolder(sourceFolder, targetFolder, fileName, deleteSource = true) {
    try {
        let sourcePath;
        try {
            sourcePath = galleryFileUrl(sourceFolder, fileName);
        } catch {
            return { success: false, error: 'Cannot encode source path (mangled characters)' };
        }
        
        debugLog(`[MoveFile] Moving ${fileName} from ${sourceFolder} to ${targetFolder}`);
        
        // Download the file
        const response = await fetch(sourcePath);
        if (!response.ok) {
            return { success: false, error: `Could not read source file: ${response.status}` };
        }
        
        const arrayBuffer = await response.arrayBuffer();
        const contentType = response.headers.get('content-type') || 'application/octet-stream';
        
        debugLog(`[MoveFile] Downloaded ${fileName}, size: ${arrayBuffer.byteLength}, type: ${contentType}`);
        
        // Convert to base64 directly (avoid Blob+FileReader triple-buffering)
        const base64Data = arrayBufferToBase64(arrayBuffer);
        
        // Get extension from filename
        const ext = fileName.includes('.') ? fileName.substring(fileName.lastIndexOf('.') + 1).toLowerCase() : 'png';
        
        debugLog(`[MoveFile] Uploading ${fileName} with extension: ${ext}`);
        
        // Upload to target folder with same filename (server sanitizes ch_name)
        const uploadResponse = await apiRequest(ENDPOINTS.IMAGES_UPLOAD, 'POST', {
            image: base64Data,
            ch_name: targetFolder,
            filename: fileName.includes('.') ? fileName.substring(0, fileName.lastIndexOf('.')) : fileName,
            format: ext
        });
        
        if (!uploadResponse.ok) {
            const errorText = await uploadResponse.text().catch(() => 'Unknown error');
            debugLog(`[MoveFile] Upload FAILED for ${fileName}: ${errorText}`);
            return { success: false, error: `Upload failed: ${errorText}` };
        }
        
        await uploadResponse.text().catch(() => {});
        debugLog(`[MoveFile] Upload successful for ${fileName}`);
        
        // Delete from source folder if requested
        if (deleteSource) {
            const deletePath = `/user/images/${sourceFolder}/${fileName}`;
            const delResp = await apiRequest(ENDPOINTS.IMAGES_DELETE, 'POST', { path: deletePath });
            await delResp.text().catch(() => {});
            debugLog(`[MoveFile] Deleted source file ${fileName}`);
        }
        
        return { success: true };
    } catch (error) {
        debugLog(`[MoveFile] Exception moving ${fileName}: ${error.message}`);
        return { success: false, error: error.message };
    }
}

/**
 * Find characters that share the same name (and thus the same old folder)
 * @returns {Map<string, Array<object>>} Map of character name -> array of characters with that name
 */
function findCharactersWithSharedNames() {
    const nameMap = new Map();
    
    for (const char of allCharacters) {
        if (!char.name) continue;
        
        const existing = nameMap.get(char.name) || [];
        existing.push(char);
        nameMap.set(char.name, existing);
    }
    
    // Filter to only names with multiple characters
    const sharedNames = new Map();
    for (const [name, chars] of nameMap) {
        if (chars.length > 1) {
            sharedNames.set(name, chars);
        }
    }
    
    return sharedNames;
}

/**
 * Perform smart image relocation for characters sharing the same name
 * Uses fingerprinting to determine which images belong to which character
 * @param {Array<object>} characters - Characters sharing the same name
 * @param {object} options - Progress callbacks
 * @returns {Promise<{moved: number, unmatched: number, errors: number, details: Array}>}
 */
async function relocateSharedFolderImages(characters, options = {}) {
    const { onLog, onLogUpdate, onProgress, shouldAbort, rateLimit } = options;
    const results = { moved: 0, unmatched: 0, errors: 0, details: [] };
    
    if (characters.length < 2) {
        return results;
    }
    
    const sharedFolderName = characters[0].name;
    const logEntry = onLog ? onLog(`Analyzing shared folder: ${sharedFolderName}`, 'pending') : null;
    
    // 1. Build fingerprints for all characters sharing this name
    const fingerprints = new Map(); // char.avatar -> Set of hashes
    let totalFingerprints = 0;
    
    for (let i = 0; i < characters.length; i++) {
        if (shouldAbort && shouldAbort()) return results;
        
        const char = characters[i];
        if (onLogUpdate && logEntry) {
            onLogUpdate(logEntry, `Building fingerprint for ${char.avatar}... (${i + 1}/${characters.length})`, 'pending');
        }
        
        // Hydrate so findCharacterMediaUrls can extract embedded URLs from heavy fields
        await hydrateCharacter(char);
        
        const fingerprint = await buildOwnershipFingerprint(char, { shouldAbort, rateLimit });
        fingerprints.set(char.avatar, fingerprint.hashes);
        totalFingerprints += fingerprint.hashes.size;
        
        results.details.push({
            character: char.name,
            avatar: char.avatar,
            fingerprintSize: fingerprint.hashes.size
        });
    }
    
    if (totalFingerprints === 0) {
        if (onLogUpdate && logEntry) {
            onLogUpdate(logEntry, `No fingerprints found - characters may not be linked to a provider with a gallery, or have embedded media`, 'success');
        }
        return results;
    }
    
    // 2. Scan the shared folder for existing images
    if (onLogUpdate && logEntry) {
        onLogUpdate(logEntry, `Scanning shared folder for images...`, 'pending');
    }
    
    const folderImages = await scanFolderForImageHashes(sharedFolderName);
    
    if (folderImages.size === 0) {
        if (onLogUpdate && logEntry) {
            onLogUpdate(logEntry, `No images in shared folder`, 'success');
        }
        return results;
    }
    
    // 3. Match images to characters based on hash fingerprints
    if (onLogUpdate && logEntry) {
        onLogUpdate(logEntry, `Matching ${folderImages.size} images to ${characters.length} characters...`, 'pending');
    }
    
    const imagesToMove = []; // Array of { fileName, targetChar }
    const unmatchedImages = [];
    
    for (const [hash, fileName] of folderImages) {
        let matchedChar = null;
        
        // Find which character's fingerprint contains this hash
        for (const [avatar, hashes] of fingerprints) {
            if (hashes.has(hash)) {
                matchedChar = characters.find(c => c.avatar === avatar);
                break;
            }
        }
        
        if (matchedChar) {
            imagesToMove.push({ fileName, targetChar: matchedChar, hash });
        } else {
            unmatchedImages.push(fileName);
            results.unmatched++;
        }
    }
    
    // 4. Move matched images to their unique folders
    // First, scan destination folders to avoid moving duplicates
    const destFolderHashes = new Map(); // uniqueFolder -> Set of hashes
    for (const { targetChar } of imagesToMove) {
        const uniqueFolder = buildUniqueGalleryFolderName(targetChar);
        if (uniqueFolder && !destFolderHashes.has(uniqueFolder)) {
            const existingHashes = await scanFolderForImageHashes(uniqueFolder);
            destFolderHashes.set(uniqueFolder, new Set(existingHashes.keys()));
        }
    }
    
    for (let i = 0; i < imagesToMove.length; i++) {
        if (shouldAbort && shouldAbort()) return results;
        
        const { fileName, targetChar, hash } = imagesToMove[i];
        const uniqueFolder = buildUniqueGalleryFolderName(targetChar);
        
        if (!uniqueFolder) {
            results.errors++;
            continue;
        }
        
        // Skip if already in the correct folder (shouldn't happen, but safety check)
        if (uniqueFolder === sharedFolderName) {
            continue;
        }

        const destHashes = destFolderHashes.get(uniqueFolder);
        if (destHashes && destHashes.has(hash)) {
            // File already exists in destination - just delete from source
            debugLog(`[Migration] File ${fileName} already exists in ${uniqueFolder}, deleting from source`);
            const deletePath = `/user/images/${sanitizeFolderName(sharedFolderName)}/${fileName}`;
            const delResp = await apiRequest(ENDPOINTS.IMAGES_DELETE, 'POST', { path: deletePath });
            await delResp.text().catch(() => {});
            results.moved++; // Count as successful (file is where it should be)
            continue;
        }
        
        if (onLogUpdate && logEntry) {
            onLogUpdate(logEntry, `Moving ${fileName} to ${uniqueFolder}... (${i + 1}/${imagesToMove.length})`, 'pending');
        }
        
        const moveResult = await moveImageToFolder(sharedFolderName, uniqueFolder, fileName, true);
        
        if (moveResult.success) {
            results.moved++;
        } else {
            results.errors++;
            console.error(`[Migration] Failed to move ${fileName}:`, moveResult.error);
        }
        
        if (onProgress) onProgress(i + 1, imagesToMove.length);
    }
    
    if (onLogUpdate && logEntry) {
        const status = results.errors === 0 ? 'success' : 'warning';
        onLogUpdate(logEntry, 
            `${sharedFolderName}: ${results.moved} moved, ${results.unmatched} unmatched, ${results.errors} errors`, 
            status
        );
    }
    
    if (unmatchedImages.length > 0) {
        debugLog(`[Migration] Unmatched images in ${sharedFolderName}:`, unmatchedImages);
    }
    
    return results;
}

/**
 * Count how many characters share names and could benefit from image relocation
 * @returns {{sharedNameGroups: number, charactersAffected: number}}
 */
function countCharactersNeedingImageRelocation() {
    const sharedNames = findCharactersWithSharedNames();
    let charactersAffected = 0;
    
    for (const [_, chars] of sharedNames) {
        charactersAffected += chars.length;
    }
    
    return {
        sharedNameGroups: sharedNames.size,
        charactersAffected
    };
}

/**
 * Migrate all images from a character's old name-based folder to their unique folder
 * This is a simple migration for characters with unique names (no fingerprinting needed)
 * @param {object} char - Character object with gallery_id
 * @returns {Promise<{moved: number, errors: number, skipped: boolean}>}
 */
async function migrateCharacterImagesToUniqueFolder(char) {
    const result = { moved: 0, errors: 0, skipped: false };
    
    // Must have gallery_id
    const galleryId = getCharacterGalleryId(char);
    if (!galleryId) {
        result.skipped = true;
        return result;
    }
    
    const oldFolderName = char.name;
    const uniqueFolderName = buildUniqueGalleryFolderName(char);
    
    if (!uniqueFolderName) {
        result.skipped = true;
        return result;
    }
    
    // If old and new are the same, nothing to do
    if (oldFolderName === uniqueFolderName) {
        result.skipped = true;
        return result;
    }
    
    try {
        // List files in the old folder
        const response = await apiRequest(ENDPOINTS.IMAGES_LIST, 'POST', { folder: oldFolderName, type: 7 });
        
        if (!response.ok) {
            // Folder might not exist, that's fine
            return result;
        }
        
        const files = await response.json();
        
        if (!files || files.length === 0) {
            return result;
        }
        
        // Filter to media files (images, audio, video)
        const mediaExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac', '.mp4', '.webm', '.mov', '.avi', '.mkv', '.m4v'];
        const mediaFiles = files.filter(f => {
            const fileName = typeof f === 'string' ? f : f.name;
            if (!fileName) return false;
            const ext = fileName.toLowerCase().substring(fileName.lastIndexOf('.'));
            return mediaExtensions.includes(ext);
        });
        
        if (mediaFiles.length === 0) {
            return result;
        }
        
        debugLog(`[MigrateAll] ${char.name}: Moving ${mediaFiles.length} files from "${oldFolderName}" to "${uniqueFolderName}"`);
        
        // Move each file
        for (const file of mediaFiles) {
            const fileName = typeof file === 'string' ? file : file.name;
            const moveResult = await moveImageToFolder(oldFolderName, uniqueFolderName, fileName, true);
            
            if (moveResult.success) {
                result.moved++;
            } else {
                result.errors++;
                console.warn(`[MigrateAll] Failed to move "${fileName}" from "${oldFolderName}" to "${uniqueFolderName}":`, moveResult.error);
            }
        }
        
        debugLog(`[MigrateAll] ${char.name}: Moved ${result.moved} files, ${result.errors} errors`);
        
    } catch (error) {
        debugError(`[MigrateAll] Error migrating ${char.name}:`, error);
        result.errors++;
    }
    
    return result;
}

/**
 * Kept as a no-op so a name change has an obvious place to hook if a gallery
 * ever does need moving. It does not need moving here -- see the body.
 * @returns {Promise<{success: boolean, moved: number, errors: number}>}
 */
async function handleGalleryFolderRename(char, oldName, newName, galleryId) {
    // ARCHIVE FORK: nothing to do, and the whole body went with it.
    //
    // The archive resolves a gallery folder by its `_<gallery_id>` tail rather
    // than by the character's current name, so a renamed card keeps finding its
    // images exactly where they already are. Upstream had to physically move
    // them because SillyTavern rebuilds the folder name from the character name
    // every time it looks -- which is what orphaned 262 folders here before the
    // archive stopped doing that.
    //
    // What was deleted: list the old folder, then download and re-upload every
    // file into a new one, one request pair at a time, deleting each source
    // after. On a 400-image gallery that was 800 requests to achieve nothing.
    // Callers still await this and read `.success`, so the shape stays.
    return { success: true, moved: 0, errors: 0 };
}

// Init
document.addEventListener('DOMContentLoaded', async () => {
    // Lock view-toggle / bottom-nav until fetchCharacters finishes (eg. user cant tap into Chats mid-load)
    document.documentElement.classList.add('cl-initial-loading');

    // Load settings first to ensure defaults are available
    await loadGallerySettings();

    // Run once at boot on any settings-load path; idempotent (renamed keys are gone, so re-runs no-op).
    migrateSettings();

    // Apply saved highlight color
    applyHighlightColor(getSetting('highlightColor'));

    // Apply UI scale (desktop only)
    if (!isMobileMode()) {
        applyUiScale(getSetting('uiScale'));
        applyModalSize(getSetting('modalSize'));
        // Self-correct XL if saved alongside a non-80% ui scale.
        syncXlModalSizeAvailability();
    }
    // Re-apply on a live mode flip: UI scale + modal size are desktop-only chrome (mobile runs
    // unzoomed). The writer fires this after run/teardown and before its synthetic resize, so the
    // zoom change lands before the grid re-measures.
    function applyViewportChrome() {
        if (isMobileMode()) {
            document.body.style.zoom = '';
            document.body.style.height = '';
        } else {
            applyUiScale(getSetting('uiScale'));
            applyModalSize(getSetting('modalSize'));
            syncXlModalSizeAvailability();
        }
        // Width-locked custom-select triggers were measured under the old
        // mode; re-measure them all for the new one
        document.querySelectorAll('.glass-select, .glass-select-small').forEach(s => {
            s._customSelect?.relockWidth?.();
        });
    }
    document.addEventListener('cl-mobile-mode-change', applyViewportChrome);


    // Apply button style
    applyButtonStyle(getSetting('buttonStyle'));

    applyMobileHideBackArrows(getSetting('mobileHideBackArrows'));
    applyMobileBrowseQuickImport(getSetting('mobileBrowseQuickImport') !== false);
    applyMobileProviderQuickSwitch(getSetting('mobileProviderQuickSwitch') !== false);

    // Apply collapse-all browse sections preference
    applyCollapseAllBrowseSections(getSetting('collapseAllBrowseSections'));

    // Apply animated tag pills setting
    applyAnimateTagPills(getSetting('animateTagPills'), getSetting('animateKeepName'));
    

    // Apply any saved token overrides before first render
    loadCustomTokens();
    applyCustomCSS();
    updateThemeCustomizerVisibility();
    
    initAllCustomSelects();
    
    // Reset filters and search on page load
    resetFiltersAndSearch();
    
    // Always use API for initial load to get authoritative data from disk.
    // The opener's in-memory character list may be stale if another client
    // (e.g. mobile) imported characters since the opener last refreshed.
    try {
        await fetchCharacters(true);
    } finally {
        // Unlock even on fetch failure so the user isnt stranded
        document.documentElement.classList.remove('cl-initial-loading');
    }
    setupEventListeners();

    // Apply default filter preset (if any) after the initial render is done.
    const defaultPresetUid = getSetting('defaultFilterPreset');
    if (defaultPresetUid && currentView !== 'chats') {
        try { await applyFilterPreset(defaultPresetUid, { silent: true }); }
        catch (e) { console.warn('[DefaultFilterPreset] Failed to apply:', e); }
    }
});

function resetFiltersAndSearch() {
    const searchInput = document.getElementById('searchInput');
    const sortSelect = document.getElementById('sortSelect');
    const clearSearchBtn = document.getElementById('clearSearchBtn');
    
    if (searchInput) searchInput.value = '';
    if (clearSearchBtn) clearSearchBtn.classList.add('hidden');
    if (sortSelect) sortSelect.value = getSetting('defaultSort') || 'name_asc';
    
    activeTagFilters.clear();
    
    // Reset tag filter UI
    document.querySelectorAll('.tag-filter-item .tag-state-btn').forEach(btn => {
        btn.dataset.state = 'neutral';
        updateTagStateButton(btn, undefined);
    });
    updateTagFilterButtonIndicator();
    
    // Reset search settings checkboxes
    const searchName = document.getElementById('searchName');
    const searchListingName = document.getElementById('searchListingName');
    const searchDesc = document.getElementById('searchDesc');
    const searchTags = document.getElementById('searchTags');
    
    if (searchName) searchName.checked = true;
    if (searchListingName) searchListingName.checked = true;
    if (searchDesc) searchDesc.checked = false;
    if (searchTags) searchTags.checked = true;
}

// Toast Icons
const TOAST_ICONS = {
    success: '<svg viewBox="0 0 24 24" fill="none" class="w-6 h-6"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M22 4L12 14.01l-3-3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    error: '<svg viewBox="0 0 24 24" fill="none" class="w-6 h-6"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/><path d="M15 9l-6 6M9 9l6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    warning: '<svg viewBox="0 0 24 24" fill="none" class="w-6 h-6"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 9v4M12 17h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" class="w-6 h-6"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/><path d="M12 16v-4M12 8h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
};

// Toast Notification System
function showToast(message, type = 'info', duration = 3000) {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    
    // Icon
    const icon = document.createElement('div');
    icon.className = 'toast-icon';
    icon.innerHTML = TOAST_ICONS[type] || TOAST_ICONS.info;
    
    // Message
    const msg = document.createElement('div');
    msg.className = 'toast-message';
    msg.textContent = message;
    
    toast.appendChild(icon);
    toast.appendChild(msg);
    container.appendChild(toast);

    // Remove after duration
    setTimeout(() => {
        toast.classList.add('hiding');
        toast.addEventListener('animationend', () => {
            toast.remove();
        });
    }, duration);
}

// @canonical cl-confirm-overlay
// Singleton confirmation dialog. Resolves true (confirm), false (cancel button,
// backdrop, Escape, or Android back via the overlay registry), or the string
// 'extra' when the optional third button (extraLabel) is shown and chosen.
function showConfirm({
    title = 'Confirm',
    message = '',
    messageHtml = null,
    icon = '',
    iconColor = '',
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    extraLabel = '',
    danger = false,
} = {}) {
    let overlay = document.getElementById('clConfirmOverlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'clConfirmOverlay';
        overlay.className = 'cl-confirm-overlay hidden';
        overlay.innerHTML = `
            <div class="confirm-modal-content">
                <div class="cl-confirm-main">
                    <div class="cl-confirm-badge"><i id="clConfirmIcon" class="fa-solid fa-circle-question"></i></div>
                    <div class="cl-confirm-text">
                        <h3 id="clConfirmTitle"></h3>
                        <div id="clConfirmMessage"></div>
                    </div>
                </div>
                <div class="confirm-modal-footer">
                    <button type="button" class="action-btn secondary" id="clConfirmCancelBtn"></button>
                    <button type="button" class="action-btn secondary hidden" id="clConfirmExtraBtn"></button>
                    <button type="button" class="action-btn" id="clConfirmConfirmBtn"></button>
                </div>
            </div>`;
        document.body.appendChild(overlay);

        const cancelFn = () => { overlay.classList.add('hidden'); overlay._resolve?.(false); };
        const confirmFn = () => { overlay.classList.add('hidden'); overlay._resolve?.(true); };
        const extraFn = () => { overlay.classList.add('hidden'); overlay._resolve?.('extra'); };

        document.getElementById('clConfirmCancelBtn').addEventListener('click', cancelFn);
        document.getElementById('clConfirmConfirmBtn').addEventListener('click', confirmFn);
        document.getElementById('clConfirmExtraBtn').addEventListener('click', extraFn);
        overlay.addEventListener('click', e => { if (e.target === overlay) cancelFn(); });

        // Register with overlay registry so Escape and Android back resolve as cancel.
        // tier -1 keeps the confirm below the tier-0 band (pickers, fullscreen viewers) so it,
        // the topmost interrupt, always closes before whatever overlay it is layered over.
        window.registerOverlay?.({
            id: 'clConfirmOverlay',
            tier: -1,
            close: cancelFn,
        });
    }

    const titleEl = document.getElementById('clConfirmTitle');
    const msgEl = document.getElementById('clConfirmMessage');
    const iconEl = document.getElementById('clConfirmIcon');
    const cancelBtn = document.getElementById('clConfirmCancelBtn');
    const confirmBtn = document.getElementById('clConfirmConfirmBtn');
    // Intent badge: red for destructive, accent otherwise. Caller icon overrides the glyph.
    overlay.classList.toggle('cl-confirm-danger', !!danger);
    if (iconEl) {
        iconEl.className = icon || (danger ? 'fa-solid fa-triangle-exclamation' : 'fa-solid fa-circle-question');
        iconEl.style.color = iconColor || '';
    }
    if (titleEl) titleEl.textContent = title;
    if (msgEl) {
        if (messageHtml != null) msgEl.innerHTML = messageHtml;
        else msgEl.textContent = message;
        msgEl.style.display = (messageHtml != null || message) ? '' : 'none';
    }
    if (cancelBtn) cancelBtn.textContent = cancelLabel;
    if (confirmBtn) {
        confirmBtn.textContent = confirmLabel;
        confirmBtn.classList.toggle('danger', !!danger);
        confirmBtn.classList.toggle('primary', !danger);
    }
    const extraBtn = document.getElementById('clConfirmExtraBtn');
    if (extraBtn) {
        extraBtn.textContent = extraLabel;
        extraBtn.classList.toggle('hidden', !extraLabel);
    }
    overlay.classList.toggle('cl-confirm-three', !!extraLabel);

    return new Promise(resolve => {
        // a re-entrant open must cancel the pending question, not orphan its awaiter
        overlay._resolve?.(false);
        overlay._resolve = resolve;
        overlay.classList.remove('hidden');
        cancelBtn?.focus();
    });
}


// Data Fetching
// forceRefresh: if true, fetch directly from API (authoritative) and refresh main window in background
async function fetchCharacters(forceRefresh = false) {
    // Clear computation cache on refresh to prevent stale token estimates, etc.
    if (forceRefresh) {
        clearCache();
    }
    
    try {
        // Method 1: Try to get data directly from the opener (Main Window)
        // Only used for non-forced fetches — the opener's in-memory data may be stale
        // after imports. forceRefresh always goes to the API for authoritative disk data.
        const hostWindow = getHostWindow();
        if (!forceRefresh && hostWindow) {
            try {
                debugLog("Attempting to read characters from host window...");
                let openerChars = null;
                
                if (hostWindow.SillyTavern && hostWindow.SillyTavern.getContext) {
                    const context = hostWindow.SillyTavern.getContext();
                    if (context && context.characters) openerChars = context.characters;
                }
                if (!openerChars && hostWindow.characters) openerChars = hostWindow.characters;

                if (openerChars && Array.isArray(openerChars)) {
                    debugLog(`Loaded ${openerChars.length} characters from host window.`);
                    processAndRender(openerChars);
                    return allCharacters;
                }
            } catch (err) {
                console.warn("Host window access failed:", err);
            }
        }

        if (forceRefresh) {
            debugLog('Force refresh: fetching directly from API (bypassing opener)...');
        }

        // Method 2: API Fetch - use the known correct endpoint first
        let url = ENDPOINTS.CHARACTERS_ALL;
        debugLog(`Fetching characters from: ${API_BASE}${url}`);

        let response = await apiRequest(url, 'POST', {});
        
        // Fallback: try GET if POST not supported
        if (response.status === 404 || response.status === 405) {
            debugLog("POST failed, trying GET...");
            response = await apiRequest(url, 'GET');
        }
        
        if (!response.ok) {
            const text = await response.text();
            console.error('API Error:', text);
            throw new Error(`Server returned ${response.status}: ${text}`);
        }

        let data = await response.json();
        debugLog('Gallery Data: loaded', Array.isArray(data) ? data.length : 'object');
        processAndRender(data);
        data = null; // Release reference - processAndRender has consumed it into allCharacters
        // Callers (eg. the tag manager's re-survey) use the return value as the
        // authoritative post-refresh list -- an implicit undefined here reads as
        // "no cards", which silently empties any plan built from it.
        return allCharacters;

    } catch (error) {
        console.error("Failed to fetch characters:", error);
        document.getElementById('loading').textContent = 'Error: ' + error.message;
        return allCharacters;
    }
}

// Deferred refresh flag - set when a lightweight incremental add was used instead of
// a full fetchCharacters(true).  Cleared after next full refresh.
let _needsCharacterRefresh = false;

/**
 * Lightweight alternative to fetchCharacters(true) for single-character imports.
 * Fetches only the newly imported character and appends it to allCharacters,
 * avoiding the massive full-list JSON parse that can OOM mobile browsers.
 * Non-essential processing (tag filter rebuild, gallery audit) is deferred
 * to the next full refresh (triggered on characters view entry).
 * @param {string} avatarFileName - The avatar filename returned by the import API
 * @returns {Promise<Object|null>} the added slim character object, or null on failure
 */
async function fetchAndAddCharacter(avatarFileName, options = {}) {
    // ST refresh runs in parallel to CL's slim add and doesn't depend on it succeeding.
    // Batch importers pass skipNotify and fire one trailing ctx.getCharacters() themselves.
    if (!options.skipNotify) {
        notifySTCharacterAdded(avatarFileName);
    }
    try {
        const response = await apiRequest(ENDPOINTS.CHARACTERS_GET, 'POST', { avatar_url: avatarFileName });
        if (!response.ok) {
            debugLog('[fetchAndAddCharacter] Single-character fetch failed:', response.status);
            return null;
        }

        const char = await response.json();
        if (!char || !char.avatar) return null;

        if (char.data) {
            char.data.extensions = char.data.extensions || {};
            _extensionsCache.set(char.avatar, char.data.extensions);
        }

        prepareCharacterKeys([char]);
        const slim = slimCharacter(char);
        allCharacters.push(slim);
        currentCharacters.push(slim);

        _needsCharacterRefresh = true;
        return slim;
    } catch (e) {
        console.warn('[fetchAndAddCharacter] Failed:', e);
        return null;
    }
}

/**
 * Lightweight removal of a deleted character from allCharacters/currentCharacters
 * without a full reload. Mirrors fetchAndAddCharacter for the delete path.
 * @param {string} avatar - The avatar filename of the deleted character
 */
function removeCharacterFromList(avatar) {
    allCharacters = allCharacters.filter(c => c.avatar !== avatar);
    currentCharacters = currentCharacters.filter(c => c.avatar !== avatar);
    _needsCharacterRefresh = true;
}

