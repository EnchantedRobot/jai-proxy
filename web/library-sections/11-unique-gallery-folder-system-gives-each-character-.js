// ========================================
// UNIQUE GALLERY FOLDER SYSTEM
// Gives each character a unique gallery folder, even when multiple characters share the same name
// by using a unique gallery_id stored in character data.extensions
// ========================================

/**
 * Generate a unique gallery ID (12-character alphanumeric)
 * @returns {string} A 12-character unique ID like 'aB3xY9kLmN2p'
 */
function generateGalleryId() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 12; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

/**
 * Get a character's gallery_id from their data.extensions
 * @param {object} char - Character object
 * @returns {string|null} The gallery_id or null if not set
 */
function getCharacterGalleryId(char) {
    return char?.data?.extensions?.gallery_id || null;
}

/**
 * Build the unique gallery folder name for a character
 * Format: "{CharacterName}_{gallery_id}"
 * @param {object} char - Character object (must have name and data.extensions.gallery_id)
 * @returns {string|null} The unique folder name or null if gallery_id not set
 */
function buildUniqueGalleryFolderName(char) {
    const galleryId = getCharacterGalleryId(char);
    if (!galleryId || !char?.name) return null;
    
    // Sanitize character name for folder use (remove/replace problematic characters)
    const safeName = char.name.replace(/[<>:"/\\|?*]/g, '_').trim();
    return `${safeName}_${galleryId}`;
}

/**
 * Show or hide the per-character gallery ID warning on the Gallery tab.
 * Displays when uniqueGalleryFolders is enabled and the character has no gallery_id.
 * Wires up the 1-click "Assign ID" button to generate + save an ID immediately.
 * @param {object} char - Character object
 */
function updateGalleryIdWarning(char) {
    const warningEl = document.getElementById('galleryIdWarning');
    const assignBtn = document.getElementById('assignGalleryIdBtn');
    if (!warningEl || !assignBtn) return;

    // extensionsReady gate: unreadable extensions mean the id is unknown, not absent; a mint here would clobber the real one.
    const needsWarning = getSetting('uniqueGalleryFolders') && extensionsReady(char) && !getCharacterGalleryId(char);

    if (!needsWarning) {
        warningEl.classList.add('hidden');
        return;
    }

    warningEl.classList.remove('hidden');

    // Wire up the assign button (replace handler each time to capture current char)
    assignBtn.onclick = async () => {
        assignBtn.disabled = true;
        assignBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Assigning...';

        try {
            // Route through the guarded primitive so every existing-card mint shares one gate.
            const result = await assignGalleryIdToCharacter(char);

            if (result.success) {
                // writeCardFields syncs the allCharacters entry; the modal char may be a detached copy
                if (!char.data) char.data = {};
                if (!char.data.extensions) char.data.extensions = {};
                char.data.extensions.gallery_id = result.galleryId;

                warningEl.classList.add('hidden');
                fetchCharacterImages(char);
                showToast(`Gallery ID assigned: ${result.galleryId}`, 'success');
            } else {
                showToast('Failed to assign gallery ID. Check console for details.', 'error');
            }
        } catch (err) {
            console.error('[GalleryIdWarning] Error assigning gallery_id:', err);
            showToast('Error assigning gallery ID.', 'error');
        } finally {
            assignBtn.disabled = false;
            assignBtn.innerHTML = '<i class="fa-solid fa-fingerprint"></i> Assign ID';
        }
    };
}


/**
 * Move all images from unique folders back to default (character name) folders.
 * Iterates characters with a gallery_id (those are the ones whose images live in `Name_id` folders).
 */
async function moveImagesToDefaultFolders(progressCallback) {
    const chars = allCharacters.filter(c => getCharacterGalleryId(c));
    const results = { moved: 0, errors: 0, chars: 0 };

    for (let i = 0; i < chars.length; i++) {
        const char = chars[i];
        const uniqueFolder = buildUniqueGalleryFolderName(char);
        const defaultFolder = sanitizeFolderName(char?.name || '');
        if (!uniqueFolder || !defaultFolder || uniqueFolder === defaultFolder) continue;

        if (progressCallback) progressCallback(i + 1, chars.length, char.name || char.avatar);

        try {
            const response = await apiRequest(ENDPOINTS.IMAGES_LIST, 'POST', { folder: uniqueFolder, type: 7 });
            if (!response.ok) continue;

            const files = await response.json();
            if (!files || files.length === 0) continue;

            results.chars++;

            for (const fileName of files) {
                const moveResult = await moveImageToFolder(uniqueFolder, defaultFolder, fileName, true);
                if (moveResult.success) {
                    results.moved++;
                } else {
                    results.errors++;
                    debugWarn(`[GalleryFolder] Failed to move ${fileName}: ${moveResult.error}`);
                }
            }
        } catch (e) {
            debugError(`[GalleryFolder] Error processing ${uniqueFolder}:`, e);
        }
    }
    
    return results;
}

/**
 * Show confirmation modal when disabling unique gallery folders
 * @param {function} onConfirm - Callback when user confirms (receives moveImages boolean)
 * @param {function} onCancel - Callback when user cancels
 */
function showDisableGalleryFoldersModal(onConfirm, onCancel) {
    const charsWithId = allCharacters.filter(c => getCharacterGalleryId(c));

    if (charsWithId.length === 0) {
        onConfirm(false);
        return;
    }

    const modal = document.createElement('div');
    modal.className = 'cl-modal cl-modal-drawer';
    modal.id = 'disableGalleryFoldersModal';
    modal.innerHTML = `
        <div class="cl-modal-content">
            <div class="cl-modal-header">
                <h3><i class="fa-solid fa-folder-tree"></i> Disable Unique Gallery Folders</h3>
                <button class="cl-modal-close" id="closeDisableGalleryModal"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="cl-modal-body">
                    <p>
                        Found <strong>${charsWithId.length}</strong> character(s) with images in unique folders.
                    </p>

                    <p style="color: var(--text-secondary);">
                        Disabling will revert ST's gallery to default behavior (folders by character name). Gallery IDs stay on the cards, so re-enabling reuses them.
                    </p>
                    
                    <div style="background: rgba(var(--cl-error-bright-rgb), 0.1); border: 1px solid rgba(var(--cl-error-bright-rgb), 0.3); border-radius: var(--radius-lg); padding: 12px; margin-bottom: 20px;">
                        <p style="margin: 0; font-size: 0.9em;">
                            <i class="fa-solid fa-info-circle"></i> Characters sharing the same name will share gallery folders again. Images in unique folders won't be accessible until moved.
                        </p>
                    </div>
                    
                    <div style="display: flex; flex-direction: column; gap: 10px; margin-bottom: 10px;">
                        <label class="disable-gallery-option">
                            <input type="radio" name="disableOption" value="move" checked>
                            <div>
                                <strong>Move images to default folders first</strong>
                                <div style="font-size: 0.85em; color: var(--text-muted);">Recommended - keeps images accessible</div>
                            </div>
                        </label>
                        <label class="disable-gallery-option">
                            <input type="radio" name="disableOption" value="skip">
                            <div>
                                <strong>Disable without moving</strong>
                                <div style="font-size: 0.85em; color: var(--text-muted);">Recover later via "Browse Orphaned Folders"</div>
                            </div>
                        </label>
                    </div>
                    
                    <div id="disableGalleryProgress" style="display: none; margin-top: 15px;">
                        <div style="display: flex; align-items: center; gap: 10px; color: var(--accent);">
                            <i class="fa-solid fa-spinner fa-spin"></i>
                            <span id="disableGalleryProgressText">Moving images...</span>
                        </div>
                    </div>
                </div>
                <div class="cl-modal-footer">
                    <button id="cancelDisableGallery" class="action-btn secondary">Cancel</button>
                    <button id="confirmDisableGallery" class="action-btn danger">Disable</button>
                </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    requestAnimationFrame(() => modal.classList.add('visible'));
    const cancelBtn = document.getElementById('cancelDisableGallery');
    const confirmBtn = document.getElementById('confirmDisableGallery');
    const progressDiv = document.getElementById('disableGalleryProgress');
    const progressText = document.getElementById('disableGalleryProgressText');
    
    const closeModal = () => {
        modal.classList.remove('visible');
        setTimeout(() => modal.remove(), 200);
    };
    // Closing via X / Cancel / backdrop / Escape reverts the still-unsaved checkbox.
    const cancel = () => { closeModal(); onCancel(); };
    modal._closeFn = cancel;

    document.getElementById('closeDisableGalleryModal').onclick = cancel;
    cancelBtn.onclick = cancel;
    modal.onclick = (e) => { if (e.target === modal) cancel(); };
    
    confirmBtn.onclick = async () => {
        const moveImages = document.querySelector('input[name="disableOption"]:checked')?.value === 'move';
        
        confirmBtn.disabled = true;
        cancelBtn.disabled = true;
        
        if (moveImages) {
            progressDiv.style.display = 'block';

            const results = await moveImagesToDefaultFolders((current, total, charName) => {
                progressText.textContent = `Moving images... ${current}/${total} (${charName})`;
            });

            debugLog(`[GalleryFolder] Move results:`, results);
        }

        closeModal();
        onConfirm(moveImages);
    };
}

/**
 * Show a modal with folder mappings for characters sharing the same name
 * Helps users manually move unmatched images to the correct unique folder
 */
function showFolderMappingModal() {
    const sharedNames = findCharactersWithSharedNames();
    const charsWithGalleryIds = allCharacters.filter(c => getCharacterGalleryId(c));

    let contentHtml = '';

    if (sharedNames.size === 0 && charsWithGalleryIds.length === 0) {
        contentHtml = `
            <div class="empty-state" style="padding: 30px; text-align: center;">
                <i class="fa-solid fa-folder-open" style="font-size: 48px; color: var(--text-secondary); margin-bottom: 15px;"></i>
                <p style="color: var(--text-secondary);">No characters have unique gallery IDs assigned yet.</p>
                <p style="color: var(--text-muted); font-size: 0.9em;">Run "Assign Gallery IDs to All Characters" first.</p>
            </div>
        `;
    } else {
        // Show shared name groups first (most relevant for manual moves)
        if (sharedNames.size > 0) {
            contentHtml += `
                <div style="margin-bottom: 20px;">
                    <h4 style="margin: 0 0 10px 0; color: var(--text-primary); display: flex; align-items: center; gap: 8px;">
                        <i class="fa-solid fa-users" style="color: var(--cl-error-bright);"></i>
                        Characters Sharing Names (${sharedNames.size} groups)
                    </h4>
                    <p style="color: var(--text-muted); font-size: 0.85em; margin-bottom: 15px;">
                        These characters share the same name. Use this reference to move unmatched images from the old shared folder to the correct unique folder.
                    </p>
            `;
            
            for (const [name, chars] of sharedNames) {
                contentHtml += `
                    <div style="background: rgba(var(--cl-error-bright-rgb), 0.1); border: 1px solid rgba(var(--cl-error-bright-rgb), 0.3); border-radius: var(--radius-lg); padding: 12px; margin-bottom: 12px;">
                        <div style="font-weight: bold; color: var(--text-primary); margin-bottom: 8px;">
                            <i class="fa-solid fa-folder" style="color: var(--cl-warning-bright);"></i>
                            Old shared folder: <code style="background: rgba(0,0,0,0.3); padding: 2px 6px; border-radius: var(--radius-xs);">${escapeHtml(name)}</code>
                        </div>
                        <div style="margin-left: 20px;">
                            ${chars.map(char => {
                                const galleryId = getCharacterGalleryId(char);
                                const uniqueFolder = buildUniqueGalleryFolderName(char);
                                const provInfo = window.ProviderRegistry?.getCharacterProvider(char);
                                const provLabel = provInfo ? ` <span style="color: var(--cl-info-bright); font-size: 0.8em;">(${provInfo.provider.name}: ${provInfo.linkInfo.id || provInfo.linkInfo.fullPath || ''})</span>` : '';
                                return `
                                    <div style="margin: 6px 0; padding: 6px 8px; background: rgba(255,255,255,0.05); border-radius: var(--radius-sm);">
                                        <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                                            <img src="${getCharacterAvatarStThumbUrl(char.avatar)}"
                                                 style="width: 32px; height: 32px; border-radius: var(--radius-sm); object-fit: cover;"
                                                 onerror="this.src='/img/ai4.png'">
                                            <span class="folder-map-char-link" data-avatar="${escapeHtml(char.avatar)}" style="color: var(--accent); cursor: pointer;">${escapeHtml(char.name)}</span>${provLabel}
                                            <i class="fa-solid fa-arrow-right" style="color: var(--text-muted);"></i>
                                            <code style="background: rgba(var(--cl-success-bright-rgb), 0.2); color: var(--cl-success-bright); padding: 2px 6px; border-radius: var(--radius-xs); font-size: 0.85em;">${uniqueFolder || '(no ID)'}</code>
                                            <button class="copy-folder-btn" data-folder="${escapeHtml(uniqueFolder || '')}" title="Copy folder name">
                                                <i class="fa-solid fa-copy"></i>
                                            </button>
                                        </div>
                                    </div>
                                `;
                            }).join('')}
                        </div>
                    </div>
                `;
            }
            contentHtml += `</div>`;
        }
        
        // Show all other characters with unique folders (collapsed by default)
        const otherChars = charsWithGalleryIds.filter(c => {
            // Exclude chars that are in sharedNames groups
            for (const [_, chars] of sharedNames) {
                if (chars.some(sc => sc.avatar === c.avatar)) return false;
            }
            return true;
        });
        
        if (otherChars.length > 0) {
            contentHtml += `
                <details style="margin-top: 15px;">
                    <summary style="cursor: pointer; color: var(--text-primary); padding: 8px; background: rgba(255,255,255,0.03); border-radius: var(--radius-md);">
                        <i class="fa-solid fa-folder-tree"></i> 
                        All Other Characters with Unique Folders (${otherChars.length})
                    </summary>
                    <div style="max-height: 300px; overflow-y: auto; margin-top: 10px; padding: 10px; background: rgba(0,0,0,0.1); border-radius: var(--radius-md);">
                        <table style="width: 100%; border-collapse: collapse; font-size: 0.85em;">
                            <thead>
                                <tr style="color: var(--text-muted); border-bottom: 1px solid rgba(255,255,255,0.1);">
                                    <th style="text-align: left; padding: 6px;">Character</th>
                                    <th style="text-align: left; padding: 6px;">Unique Folder</th>
                                    <th style="width: 40px;"></th>
                                </tr>
                            </thead>
                            <tbody>
                                ${otherChars.map(char => {
                                    const uniqueFolder = buildUniqueGalleryFolderName(char);
                                    return `
                                        <tr style="border-bottom: 1px solid rgba(255,255,255,0.05);">
                                            <td style="padding: 6px;"><span class="folder-map-char-link" data-avatar="${escapeHtml(char.avatar)}" style="color: var(--accent); cursor: pointer;">${escapeHtml(char.name)}</span></td>
                                            <td style="padding: 6px;"><code style="background: rgba(255,255,255,0.1); padding: 2px 4px; border-radius: var(--radius-xs); font-size: 0.9em;">${uniqueFolder}</code></td>
                                            <td style="padding: 6px;">
                                                <button class="copy-folder-btn" data-folder="${escapeHtml(uniqueFolder || '')}" title="Copy">
                                                    <i class="fa-solid fa-copy"></i>
                                                </button>
                                            </td>
                                        </tr>
                                    `;
                                }).join('')}
                            </tbody>
                        </table>
                    </div>
                </details>
            `;
        }
    }
    
    const modal = document.createElement('div');
    modal.className = 'cl-modal cl-modal-drawer';
    modal.id = 'folderMappingModal';
    modal.innerHTML = `
        <div class="cl-modal-content folder-mapping-modal-content">
            <div class="cl-modal-header">
                <h3><i class="fa-solid fa-map"></i> Gallery Folder Names</h3>
                <button class="cl-modal-close" id="closeFolderMappingModal"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="cl-modal-body">
                <div class="folder-mapping-tip">
                    <i class="fa-solid fa-lightbulb"></i>
                    <p><strong>Tip:</strong> Gallery images are stored in <code>data/default-user/images/</code>. Move files from the old <code>CharName</code> folder to the new <code>CharName_abc123xyz</code> folder.</p>
                </div>
                ${contentHtml}
            </div>
            <div class="cl-modal-footer">
                <button class="action-btn primary" id="closeFolderMappingBtn">
                    <i class="fa-solid fa-check"></i> Done
                </button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);
    requestAnimationFrame(() => modal.classList.add('visible'));

    const closeModal = () => {
        modal.classList.remove('visible');
        setTimeout(() => modal.remove(), 200);
    };
    modal._closeFn = closeModal;
    document.getElementById('closeFolderMappingModal').onclick = closeModal;
    document.getElementById('closeFolderMappingBtn').onclick = closeModal;
    modal.onclick = (e) => { if (e.target === modal) closeModal(); };
    
    // Character name links — open details modal above this one
    modal.addEventListener('click', (e) => {
        const link = e.target.closest('.folder-map-char-link');
        if (!link) return;
        const avatar = link.dataset.avatar;
        if (!avatar) return;
        const char = allCharacters.find(c => c.avatar === avatar);
        if (!char) return;
        openCharModalElevated(char);
    });

    // Setup copy buttons with fallback for non-secure contexts
    modal.querySelectorAll('.copy-folder-btn').forEach(btn => {
        btn.onclick = async (e) => {
            e.stopPropagation();
            const folder = btn.dataset.folder;
            if (folder) {
                let success = false;
                try {
                    // Try modern Clipboard API first
                    if (navigator.clipboard && navigator.clipboard.writeText) {
                        await navigator.clipboard.writeText(folder);
                        success = true;
                    }
                } catch (err) {
                    // Clipboard API failed, try fallback
                }
                
                // Fallback: use execCommand (works in more contexts)
                if (!success) {
                    try {
                        const textarea = document.createElement('textarea');
                        textarea.value = folder;
                        textarea.style.position = 'fixed';
                        textarea.style.opacity = '0';
                        document.body.appendChild(textarea);
                        textarea.select();
                        success = document.execCommand('copy');
                        document.body.removeChild(textarea);
                    } catch (err2) {
                        // Both methods failed
                    }
                }
                
                if (success) {
                    btn.innerHTML = '<i class="fa-solid fa-check" style="color: var(--cl-success-bright);"></i>';
                    setTimeout(() => { btn.innerHTML = '<i class="fa-solid fa-copy"></i>'; }, 1500);
                } else {
                    showToast('Failed to copy to clipboard', 'error');
                }
            }
        };
    });
}

/**
 * Fetch all existing image subdirectory names from the server.
 * Unlike IMAGES_LIST, this does NOT create directories as a side effect.
 * @returns {Promise<Set<string>>} Set of folder names on disk
 */
async function getExistingImageFolders() {
    try {
        const resp = await apiRequest(ENDPOINTS.IMAGES_FOLDERS, 'POST');
        if (!resp.ok) return new Set();
        return new Set(await resp.json());
    } catch {
        return new Set();
    }
}

const DISMISSED_FOLDERS_KEY = 'cl_dismissed_orphaned_folders';

function getDismissedFolders() {
    try {
        return new Set(JSON.parse(localStorage.getItem(DISMISSED_FOLDERS_KEY) || '[]'));
    } catch { return new Set(); }
}

function addDismissedFolder(name) {
    const set = getDismissedFolders();
    set.add(name);
    localStorage.setItem(DISMISSED_FOLDERS_KEY, JSON.stringify([...set]));
}

/**
 * Scan for orphaned gallery folders (folders that exist but don't match any character's unique folder)
 * These are typically old-style folders or leftover folders from deleted characters
 * @returns {Promise<Array<{name: string, files: string[], isLegacy: boolean, matchingChars: Array}>>}
 */
async function scanOrphanedGalleryFolders() {
    const existingFolders = await getExistingImageFolders();
    const dismissed = getDismissedFolders();

    // Build a set of all "valid" folder names:
    // 1. Unique folder names (CharName_uuid) for characters with gallery_id
    // 2. Character names for characters without gallery_id (if unique folders disabled)
    const validFolders = new Set();
    const uniqueFolderToChar = new Map();
    
    for (const char of allCharacters) {
        if (!char.name) continue;
        
        const uniqueFolder = buildUniqueGalleryFolderName(char);
        if (uniqueFolder) {
            validFolders.add(uniqueFolder);
            uniqueFolderToChar.set(uniqueFolder, char);
        }
        validFolders.add(char.name);
    }
    
    // Only probe character-name folders that actually exist on disk
    const potentialFolders = new Set();
    for (const char of allCharacters) {
        if (char.name && existingFolders.has(char.name) && !dismissed.has(char.name)) {
            potentialFolders.add(char.name);
        }
    }
    
    const orphanedFolders = [];
    
    for (const folderName of potentialFolders) {
        try {
            const response = await apiRequest(ENDPOINTS.IMAGES_LIST, 'POST', { 
                folder: folderName, 
                type: 7 
            });
            
            if (!response.ok) continue;
            
            const files = await response.json();
            if (!files || files.length === 0) continue;
            
            const fileNames = files.map(f => typeof f === 'string' ? f : f.name).filter(Boolean);
            if (fileNames.length === 0) continue;
            
            const isUniqueFolder = folderName.match(/_[a-zA-Z0-9]{12}$/);
            const matchingChars = allCharacters.filter(c => c.name === folderName);
            
            const isOrphaned = !isUniqueFolder && matchingChars.some(c => {
                const uniqueFolder = buildUniqueGalleryFolderName(c);
                return uniqueFolder && uniqueFolder !== folderName;
            });
            
            if (isOrphaned || !matchingChars.length) {
                orphanedFolders.push({
                    name: folderName,
                    files: fileNames,
                    isLegacy: !isUniqueFolder,
                    matchingChars: matchingChars
                });
            }
        } catch (e) {
            debugLog(`[OrphanedFolders] Error checking folder ${folderName}:`, e);
        }
    }
    
    return orphanedFolders;
}

/**
 * Scan for truncated/duplicate gallery ID folders created by the old .slice(0, 50) bug
 * in getImportSummaryFolderName. Uses IMAGES_FOLDERS to check existence without
 * creating phantom directories (IMAGES_LIST creates folders as a side effect).
 * @returns {Promise<Array<{name: string, files: string[], correctFolder: string, matchingChars: Array}>>}
 */
async function scanDuplicateGalleryIdFolders() {
    const existingFolders = await getExistingImageFolders();
    const dismissed = getDismissedFolders();
    const results = [];
    const probed = new Set();

    for (const char of allCharacters) {
        const galleryId = getCharacterGalleryId(char);
        if (!galleryId || !char.name) continue;

        const correctFolder = buildUniqueGalleryFolderName(char);
        if (!correctFolder) continue;

        // Reproduce the old bug: different regex + .slice(0, 50)
        const truncatedName = char.name.replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 50);
        const buggyFolder = `${truncatedName}_${galleryId}`;

        if (buggyFolder === correctFolder) continue;
        if (probed.has(buggyFolder)) continue;
        probed.add(buggyFolder);

        if (!existingFolders.has(buggyFolder)) continue;
        if (dismissed.has(buggyFolder)) continue;

        try {
            const response = await apiRequest(ENDPOINTS.IMAGES_LIST, 'POST', {
                folder: buggyFolder,
                type: 7
            });
            if (!response.ok) continue;

            const files = await response.json();
            const fileNames = (files || []).map(f => typeof f === 'string' ? f : f.name).filter(Boolean);

            results.push({
                name: buggyFolder,
                files: fileNames,
                correctFolder,
                matchingChars: [char]
            });
        } catch (e) {
            debugLog(`[DuplicateGalleryIdFolders] Error probing ${buggyFolder}:`, e);
        }
    }

    return results;
}

/**
 * Show a modal for browsing and redistributing orphaned folder contents
 */
async function showOrphanedFoldersModal(initialMode = 'legacy') {
    let currentMode = initialMode;

    const modal = document.createElement('div');
    // Full-viewport on mobile, not a drawer: the two-pane file manager needs the whole screen.
    modal.className = 'cl-modal';
    modal.id = 'orphanedFoldersModal';
    modal.innerHTML = `
        <div class="cl-modal-content orphaned-folders-modal">
            <div class="cl-modal-header">
                <h3><i class="fa-solid fa-folder-open"></i> Browse Orphaned Folders</h3>
                <select id="orphanedFoldersModeSelect" class="glass-select orphaned-folders-mode-select">
                    <option value="legacy"${currentMode === 'legacy' ? ' selected' : ''} data-icon="fa-solid fa-folder-open">Legacy Folders (no gallery ID)</option>
                    <option value="duplicate"${currentMode === 'duplicate' ? ' selected' : ''} data-icon="fa-solid fa-clone">Duplicate Gallery ID</option>
                </select>
                <button class="cl-modal-close" id="closeOrphanedFoldersModal"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="cl-modal-body" id="orphanedFoldersBody">
                <div class="loading-spinner">
                    <i class="fa-solid fa-spinner fa-spin"></i>
                    <p>Scanning for orphaned folders...</p>
                </div>
            </div>
            <div class="cl-modal-footer">
                <button class="action-btn secondary" id="closeOrphanedFoldersBtn">
                    <i class="fa-solid fa-xmark"></i> Close
                </button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);
    requestAnimationFrame(() => modal.classList.add('visible'));

    const modeSelect = document.getElementById('orphanedFoldersModeSelect');
    initCustomSelect(modeSelect);

    const closeModal = () => {
        if (modeSelect._customSelect?.menu) modeSelect._customSelect.menu.remove();
        modal.classList.remove('visible');
        setTimeout(() => modal.remove(), 200);
    };
    modal._closeFn = closeModal;
    document.getElementById('closeOrphanedFoldersModal').onclick = closeModal;
    document.getElementById('closeOrphanedFoldersBtn').onclick = closeModal;
    modal.onclick = (e) => { if (e.target === modal) closeModal(); };
    
    // ── Reusable scan + render for the current mode ──
    async function loadMode(mode) {
        currentMode = mode;
        const body = document.getElementById('orphanedFoldersBody');
        body.innerHTML = `
            <div class="loading-spinner">
                <i class="fa-solid fa-spinner fa-spin"></i>
                <p>Scanning for ${mode === 'duplicate' ? 'duplicate gallery ID' : 'orphaned'} folders...</p>
            </div>
        `;

        const scannedFolders = mode === 'duplicate'
            ? await scanDuplicateGalleryIdFolders()
            : await scanOrphanedGalleryFolders();

        if (scannedFolders.length === 0) {
            body.innerHTML = `
                <div style="display: flex; flex-direction: column; align-items: center; padding: 40px; text-align: center;">
                    <i class="fa-solid fa-check-circle" style="font-size: 48px; color: var(--cl-success-bright); margin-bottom: 15px;"></i>
                    <h4 style="color: var(--text-primary); margin: 0 0 10px 0;">No ${mode === 'duplicate' ? 'Duplicate Gallery ID' : 'Orphaned'} Folders Found</h4>
                    <p style="color: var(--text-secondary); margin: 0;">
                        ${mode === 'duplicate'
                            ? 'No truncated/duplicate gallery folders detected.'
                            : 'All gallery folders are properly associated with characters.'}
                    </p>
                </div>
            `;
            return;
        }

        renderOrphanedBody(body, scannedFolders, mode);
    }

    function renderOrphanedBody(body, orphanedFolders, mode) {
        const isDuplicateMode = mode === 'duplicate';

        const infoText = isDuplicateMode
            ? `Found <strong>${orphanedFolders.length}</strong> truncated folder(s) with duplicate gallery IDs. These were created by a bug that truncated long character names. Files can be moved to the correct folder or cleared.`
            : `Found <strong>${orphanedFolders.length}</strong> legacy folder(s) with images. Select a folder to view its contents, then choose images to move to a character's unique folder.`;

        const listHeader = isDuplicateMode ? 'Truncated Folders' : 'Legacy Folders';
        const folderIcon = isDuplicateMode ? 'fa-clone' : 'fa-folder';

    // Build list of available destination characters (those with unique folders)
    const destinationChars = allCharacters
        .filter(c => getCharacterGalleryId(c))
        .sort((a, b) => a.name.localeCompare(b.name));
    
    // Render folder selector and content area
    body.innerHTML = `
        <div class="orphaned-folders-info">
            <i class="fa-solid fa-info-circle"></i>
            <span>${infoText}</span>
        </div>
        
        <div class="orphaned-folders-layout">
            <div class="orphaned-folders-list">
                <div class="orphaned-folders-list-header">
                    <i class="fa-solid ${folderIcon}"></i> ${listHeader}
                </div>
                <div class="orphaned-folders-list-items">
                    ${orphanedFolders.map((folder, idx) => {
                        const matchChar = isDuplicateMode && folder.matchingChars?.[0];
                        return `
                        <div class="orphaned-folder-item ${idx === 0 ? 'active' : ''}" data-folder="${escapeHtml(folder.name)}">
                            <div class="orphaned-folder-name">
                                <i class="fa-solid fa-folder" style="color: ${isDuplicateMode ? 'var(--cl-error-bright)' : 'var(--cl-warning-bright)'};"></i>
                                ${escapeHtml(folder.name)}
                            </div>
                            <div class="orphaned-folder-count">${folder.files.length} file${folder.files.length !== 1 ? 's' : ''}</div>
                            ${matchChar ? `<div class="orphaned-folder-char"><img src="${getCharacterAvatarStThumbUrl(matchChar.avatar)}" class="orphaned-char-avatar" onerror="this.style.display='none'"><span class="orphaned-char-link" data-avatar="${escapeHtml(matchChar.avatar)}" title="View character details">${escapeHtml(matchChar.name)}</span></div>` : ''}
                            ${isDuplicateMode && folder.correctFolder ? `<div class="orphaned-folder-correct" title="Correct folder: ${escapeHtml(folder.correctFolder)}"><i class="fa-solid fa-arrow-right"></i> ${escapeHtml(folder.correctFolder.length > 40 ? folder.correctFolder.slice(0, 37) + '...' : folder.correctFolder)}</div>` : ''}
                        </div>`;
                    }).join('')}
                </div>
                ${isDuplicateMode ? `
                <div style="padding: 8px;">
                    <button class="action-btn primary small" id="orphanedMoveAllCorrectBtn" style="width: 100%;">
                        <i class="fa-solid fa-truck-moving"></i> Move All to Correct Folders
                    </button>
                </div>` : ''}
            </div>
            
            <div class="orphaned-folders-content">
                <div class="orphaned-content-header">
                    <div class="orphaned-content-title">
                        <span id="orphanedCurrentFolder">${escapeHtml(orphanedFolders[0].name)}</span>
                        <span class="orphaned-file-count" id="orphanedFileCount">${orphanedFolders[0].files.length} files</span>
                        <span id="orphanedCurrentChar" class="orphaned-content-char"></span>
                    </div>
                    <div class="orphaned-content-actions">
                        <button class="action-btn danger small" id="orphanedDeleteFolderBtn" title="Delete all files in this folder">
                            <i class="fa-solid fa-folder-minus"></i> Delete Folder
                        </button>
                        <button class="action-btn danger small" id="orphanedDeleteSelectedBtn" style="display: none;" title="Delete selected files permanently">
                            <i class="fa-solid fa-trash"></i> Delete Selected
                        </button>
                        <button class="action-btn secondary small" id="orphanedClearDuplicatesBtn" title="Remove files that already exist in a unique folder">
                            <i class="fa-solid fa-broom"></i> Clear Duplicates
                        </button>
                        <label class="orphaned-select-all">
                            <input type="checkbox" id="orphanedSelectAll">
                            <span>Select All</span>
                        </label>
                    </div>
                </div>
                
                <div class="orphaned-images-grid" id="orphanedImagesGrid">
                    <!-- Images will be rendered here -->
                </div>
                
                <div class="orphaned-move-section" id="orphanedMoveSection" style="display: none;">
                    <div class="orphaned-move-header">
                        <i class="fa-solid fa-truck-moving"></i>
                        Move <span id="orphanedSelectedCount">0</span> selected image(s) to:
                    </div>
                    <div class="orphaned-destination-picker">
                        <div class="orphaned-search-wrapper">
                            <i class="fa-solid fa-search"></i>
                            <input type="search" id="orphanedDestSearch" placeholder="Search characters..." autocomplete="one-time-code">
                        </div>
                        <div class="orphaned-destination-list" id="orphanedDestList">
                            ${destinationChars.map(char => {
                                const uniqueFolder = buildUniqueGalleryFolderName(char);
                                const provInfo = window.ProviderRegistry?.getCharacterProvider(char);
                                const provLabel = provInfo ? `<span class="dest-chub-id">${provInfo.provider.name}: ${provInfo.linkInfo.id || ''}</span>` : '';
                                return `
                                    <div class="orphaned-dest-item" data-avatar="${escapeHtml(char.avatar)}" data-folder="${escapeHtml(uniqueFolder)}" data-name="${escapeHtml(char.name.toLowerCase())}">
                                        <img src="${getCharacterAvatarStThumbUrl(char.avatar)}" class="dest-avatar" onerror="this.src='${FALLBACK_AVATAR_SVG}'">
                                        <div class="dest-info">
                                            <div class="dest-name"><span class="dest-name-link" data-avatar="${escapeHtml(char.avatar)}" title="View character details">${escapeHtml(char.name)}</span> ${provLabel}</div>
                                            <div class="dest-folder">${escapeHtml(uniqueFolder)}</div>
                                        </div>
                                    </div>
                                `;
                            }).join('')}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;
    
    let currentFolder = orphanedFolders[0];
    let selectedFiles = new Set();
    
    // Render images for current folder
    function renderFolderImages(folder) {
        currentFolder = folder;
        selectedFiles.clear();
        
        const grid = document.getElementById('orphanedImagesGrid');

        // Use raw folder name from scanner - it came from disk via IMAGES_FOLDERS.
        // encodeURIComponent throws on lone surrogates from mangled emoji.
        let encodedFolderName;
        try { encodedFolderName = encodeURIComponent(folder.name); } catch { encodedFolderName = null; }
        
        document.getElementById('orphanedCurrentFolder').textContent = folder.name;
        document.getElementById('orphanedFileCount').textContent = `${folder.files.length} files`;
        document.getElementById('orphanedSelectAll').checked = false;

        // Show matched character in content header (duplicate mode)
        const charSpan = document.getElementById('orphanedCurrentChar');
        if (charSpan) {
            const matchChar = isDuplicateMode && folder.matchingChars?.[0];
            if (matchChar) {
                charSpan.innerHTML = `<img src="${getCharacterAvatarStThumbUrl(matchChar.avatar)}" class="orphaned-char-avatar" onerror="this.style.display='none'"><span class="orphaned-char-link" data-avatar="${escapeHtml(matchChar.avatar)}" title="View character details">${escapeHtml(matchChar.name)}</span>`;
            } else {
                charSpan.innerHTML = '';
            }
        }
        
        // Pre-fill destination search with folder name to show relevant characters first
        const destSearch = document.getElementById('orphanedDestSearch');
        if (destSearch) {
            // In duplicate mode, search for the correct folder; otherwise use the folder name
            const searchHint = (isDuplicateMode && folder.correctFolder) ? folder.correctFolder : folder.name;
            destSearch.value = searchHint;
            const query = searchHint.toLowerCase().trim();
            document.querySelectorAll('.orphaned-dest-item').forEach(item => {
                const name = item.dataset.name || '';
                const itemFolder = item.dataset.folder?.toLowerCase() || '';
                const matches = !query || name.includes(query) || itemFolder.includes(query);
                item.style.display = matches ? '' : 'none';
            });
        }

        if (folder.files.length === 0) {
            grid.innerHTML = `
                <div class="empty-state" style="padding: 30px; text-align: center; grid-column: 1 / -1;">
                    <i class="fa-solid fa-folder-open" style="font-size: 36px; color: var(--text-muted); margin-bottom: 10px;"></i>
                    <p style="color: var(--text-secondary); margin: 0;">Empty folder — use <strong>Delete Folder</strong> to remove it.</p>
                </div>
            `;
            updateMoveSection();
            return;
        }
        
        grid.innerHTML = folder.files.map(fileName => {
            const ext = fileName.split('.').pop()?.toLowerCase() || '';
            const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'].includes(ext);
            const isAudio = ['mp3', 'wav', 'ogg', 'm4a', 'flac'].includes(ext);
            const isVideo = ['mp4', 'webm', 'mov', 'avi'].includes(ext);
            
            let previewHtml;
            if (isImage && encodedFolderName) {
                previewHtml = `<img src="${galleryFileUrl(folder.name, fileName)}" 
                     loading="lazy"
                     onerror="this.onerror=null; this.parentElement.innerHTML='<div class=\\'orphaned-file-icon\\'><i class=\\'fa-solid fa-image\\'></i></div>';">`;
            } else if (isImage) {
                previewHtml = `<div class="orphaned-file-icon"><i class="fa-solid fa-image"></i></div>`;
            } else if (isAudio) {
                previewHtml = `<div class="orphaned-file-icon audio"><i class="fa-solid fa-music"></i></div>`;
            } else if (isVideo) {
                previewHtml = `<div class="orphaned-file-icon video"><i class="fa-solid fa-video"></i></div>`;
            } else {
                previewHtml = `<div class="orphaned-file-icon"><i class="fa-solid fa-file"></i></div>`;
            }
            
            return `
            <div class="orphaned-image-item" data-filename="${escapeHtml(fileName)}">
                ${previewHtml}
                <div class="orphaned-image-checkbox">
                    <input type="checkbox" class="orphaned-file-checkbox" data-filename="${escapeHtml(fileName)}">
                </div>
                <div class="orphaned-image-name" title="${escapeHtml(fileName)}">${escapeHtml(fileName)}</div>
            </div>`;
        }).join('');
        
        // Bind checkbox events
        grid.querySelectorAll('.orphaned-image-item').forEach(item => {
            item.addEventListener('click', (e) => {
                if (e.target.type === 'checkbox') return;
                const checkbox = item.querySelector('.orphaned-file-checkbox');
                checkbox.checked = !checkbox.checked;
                checkbox.dispatchEvent(new Event('change'));
            });
        });
        
        grid.querySelectorAll('.orphaned-file-checkbox').forEach(checkbox => {
            checkbox.addEventListener('change', () => {
                const filename = checkbox.dataset.filename;
                if (checkbox.checked) {
                    selectedFiles.add(filename);
                    checkbox.closest('.orphaned-image-item').classList.add('selected');
                } else {
                    selectedFiles.delete(filename);
                    checkbox.closest('.orphaned-image-item').classList.remove('selected');
                }
                updateMoveSection();
            });
        });
        
        updateMoveSection();
    }
    
    // Update move section visibility and count
    function updateMoveSection() {
        const moveSection = document.getElementById('orphanedMoveSection');
        const countSpan = document.getElementById('orphanedSelectedCount');
        const deleteBtn = document.getElementById('orphanedDeleteSelectedBtn');
        
        if (selectedFiles.size > 0) {
            moveSection.style.display = 'block';
            countSpan.textContent = selectedFiles.size;
            if (deleteBtn) deleteBtn.style.display = '';
        } else {
            moveSection.style.display = 'none';
            if (deleteBtn) deleteBtn.style.display = 'none';
        }
        
        // Update select all checkbox state
        const selectAllCheckbox = document.getElementById('orphanedSelectAll');
        selectAllCheckbox.checked = selectedFiles.size === currentFolder.files.length && currentFolder.files.length > 0;
        selectAllCheckbox.indeterminate = selectedFiles.size > 0 && selectedFiles.size < currentFolder.files.length;
    }
    
    // Initial render
    renderFolderImages(orphanedFolders[0]);
    
    // Folder list click handler
    function bindFolderListClicks() {
        body.querySelectorAll('.orphaned-folder-item').forEach(item => {
            item.addEventListener('click', (e) => {
                if (e.target.closest('.orphaned-char-link')) return;
                body.querySelectorAll('.orphaned-folder-item').forEach(i => i.classList.remove('active'));
                item.classList.add('active');
            
                const folderName = item.dataset.folder;
                const folder = orphanedFolders.find(f => f.name === folderName);
                if (folder) {
                    renderFolderImages(folder);
                }
            });
        });
    }
    bindFolderListClicks();
    
    // Select all handler
    document.getElementById('orphanedSelectAll').addEventListener('change', (e) => {
        const checkAll = e.target.checked;
        document.querySelectorAll('.orphaned-file-checkbox').forEach(checkbox => {
            checkbox.checked = checkAll;
            const filename = checkbox.dataset.filename;
            if (checkAll) {
                selectedFiles.add(filename);
                checkbox.closest('.orphaned-image-item').classList.add('selected');
            } else {
                selectedFiles.delete(filename);
                checkbox.closest('.orphaned-image-item').classList.remove('selected');
            }
        });
        updateMoveSection();
    });

    // Delete Selected handler
    document.getElementById('orphanedDeleteSelectedBtn').addEventListener('click', async () => {
        if (selectedFiles.size === 0) return;

        if (!confirm(`Delete ${selectedFiles.size} file(s) permanently?\n\nThis cannot be undone.`)) return;

        const btn = document.getElementById('orphanedDeleteSelectedBtn');
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Deleting...';

        let deleted = 0;
        let errors = 0;

        for (const fileName of selectedFiles) {
            try {
                const deletePath = `/user/images/${currentFolder.name}/${fileName}`;
                const resp = await apiRequest(ENDPOINTS.IMAGES_DELETE, 'POST', { path: deletePath });
                await resp.text().catch(() => {});
                deleted++;
            } catch {
                errors++;
            }
        }

        currentFolder.files = currentFolder.files.filter(f => !selectedFiles.has(f));
        selectedFiles.clear();

        const folderItem = body.querySelector(`.orphaned-folder-item[data-folder="${CSS.escape(currentFolder.name)}"]`);
        if (folderItem) {
            const countEl = folderItem.querySelector('.orphaned-folder-count');
            if (countEl) countEl.textContent = `${currentFolder.files.length} file${currentFolder.files.length !== 1 ? 's' : ''}`;

            if (currentFolder.files.length === 0) {
                addDismissedFolder(currentFolder.name);
                folderItem.remove();
                const idx = orphanedFolders.indexOf(currentFolder);
                if (idx !== -1) orphanedFolders.splice(idx, 1);

                const remainingFolders = body.querySelectorAll('.orphaned-folder-item');
                if (remainingFolders.length > 0) {
                    remainingFolders[0].click();
                } else {
                    body.innerHTML = `
                        <div class="empty-state" style="padding: 40px; text-align: center;">
                            <i class="fa-solid fa-check-circle" style="font-size: 48px; color: var(--cl-success-bright); margin-bottom: 15px;"></i>
                            <h4 style="color: var(--text-primary); margin: 0 0 10px 0;">All Done!</h4>
                            <p style="color: var(--text-secondary); margin: 0;">All folder contents have been cleared.</p>
                        </div>
                    `;
                    btn.disabled = false;
                    btn.innerHTML = '<i class="fa-solid fa-trash"></i> Delete Selected';
                    showToast(`Deleted ${deleted} file(s)${errors > 0 ? `, ${errors} error(s)` : ''}`, errors > 0 ? 'warning' : 'success');
                    return;
                }
            }
        }

        renderFolderImages(currentFolder);
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-trash"></i> Delete Selected';
        showToast(`Deleted ${deleted} file(s)${errors > 0 ? `, ${errors} error(s)` : ''}`, errors > 0 ? 'warning' : 'success');
    });

    // Delete Folder handler - deletes ALL files then attempts to remove the empty folder
    document.getElementById('orphanedDeleteFolderBtn').addEventListener('click', async () => {
        if (!currentFolder) return;

        const fileCount = currentFolder.files.length;
        const confirmMsg = fileCount === 0
            ? `Delete empty folder "${currentFolder.name}"?`
            : `Delete folder "${currentFolder.name}" and ALL ${fileCount} file(s) inside?\n\nThis cannot be undone.`;
        if (!confirm(confirmMsg)) return;

        const btn = document.getElementById('orphanedDeleteFolderBtn');
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Deleting...';

        let deleted = 0;
        let errors = 0;

        for (const fileName of [...currentFolder.files]) {
            try {
                const deletePath = `/user/images/${currentFolder.name}/${fileName}`;
                const resp = await apiRequest(ENDPOINTS.IMAGES_DELETE, 'POST', { path: deletePath });
                await resp.text().catch(() => {});
                deleted++;
            } catch {
                errors++;
            }
        }

        currentFolder.files = [];
        selectedFiles.clear();

        // Track as dismissed so it won't reappear on next scan
        // (ST has no directory deletion API - fs.unlinkSync can't remove dirs)
        addDismissedFolder(currentFolder.name);
        cleanupThumbCache(currentFolder.name);

        const folderItem = body.querySelector(`.orphaned-folder-item[data-folder="${CSS.escape(currentFolder.name)}"]`);
        if (folderItem) {
            folderItem.remove();
            const idx = orphanedFolders.indexOf(currentFolder);
            if (idx !== -1) orphanedFolders.splice(idx, 1);

            const remainingFolders = body.querySelectorAll('.orphaned-folder-item');
            if (remainingFolders.length > 0) {
                remainingFolders[0].click();
            } else {
                body.innerHTML = `
                    <div class="empty-state" style="padding: 40px; text-align: center;">
                        <i class="fa-solid fa-check-circle" style="font-size: 48px; color: var(--cl-success-bright); margin-bottom: 15px;"></i>
                        <h4 style="color: var(--text-primary); margin: 0 0 10px 0;">All Done!</h4>
                        <p style="color: var(--text-secondary); margin: 0;">All folders have been cleaned up.</p>
                    </div>
                `;
            }
        }

        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-folder-minus"></i> Delete Folder';

        if (deleted > 0) {
            showToast(`Deleted ${deleted} file(s)${errors > 0 ? `, ${errors} error(s)` : ''}. Empty folder will be hidden from future scans.`, errors > 0 ? 'warning' : 'success');
        } else {
            showToast('Folder dismissed — will be hidden from future scans.', 'success');
        }
    });
    
    // Clear Duplicates handler - processes ALL orphaned folders
    document.getElementById('orphanedClearDuplicatesBtn').addEventListener('click', async () => {
        const btn = document.getElementById('orphanedClearDuplicatesBtn');
        const originalHtml = btn.innerHTML;

        if (isDuplicateMode) {
            // In duplicate mode, clear duplicates compares against the known correct folder
            if (!confirm(`Clear Duplicates\n\nThis will scan ALL ${orphanedFolders.length} truncated folder(s) and remove files that already exist in the correct folder.\n\nContinue?`)) return;

            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Processing...';
            btn.disabled = true;

            let totalDeleted = 0;
            let totalKept = 0;
            let foldersProcessed = 0;
            let foldersCleared = 0;

            try {
                for (const folder of [...orphanedFolders]) {
                    foldersProcessed++;
                    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Folder ${foldersProcessed}/${orphanedFolders.length}...`;

                    if (!folder.correctFolder) { totalKept += folder.files.length; continue; }

                    const correctHashes = await scanFolderForImageHashes(folder.correctFolder);
                    const correctFilenames = new Set();
                    for (const [, fn] of correctHashes) correctFilenames.add(fn);

                    if (correctHashes.size === 0 && correctFilenames.size === 0) { totalKept += folder.files.length; continue; }

                    let folderDeleted = 0;

                    for (const fileName of folder.files) {
                        if (correctFilenames.has(fileName)) {
                            const deletePath = `/user/images/${folder.name}/${fileName}`;
                            const delResp = await apiRequest(ENDPOINTS.IMAGES_DELETE, 'POST', { path: deletePath });
                            await delResp.text().catch(() => {});
                            folderDeleted++; totalDeleted++;
                            continue;
                        }
                        let localPath;
                        try { localPath = galleryFileUrl(folder.name, fileName); } catch { totalKept++; continue; }
                        try {
                            const fileResponse = await fetch(localPath);
                            if (fileResponse.ok) {
                                const buffer = await fileResponse.arrayBuffer();
                                const hash = await calculateHash(buffer);
                                if (correctHashes.has(hash)) {
                                    const deletePath = `/user/images/${folder.name}/${fileName}`;
                                    const delResp = await apiRequest(ENDPOINTS.IMAGES_DELETE, 'POST', { path: deletePath });
                                    await delResp.text().catch(() => {});
                                    folderDeleted++; totalDeleted++;
                                } else { totalKept++; }
                            } else { totalKept++; }
                        } catch { totalKept++; }
                    }

                    if (folderDeleted > 0) {
                        const response = await apiRequest(ENDPOINTS.IMAGES_LIST, 'POST', { folder: folder.name, type: 7 });
                        if (response.ok) {
                            const files = await response.json();
                            folder.files = files.map(f => typeof f === 'string' ? f : f.name).filter(Boolean);
                        }
                        if (folder.files.length === 0) foldersCleared++;
                    }
                }

                refreshFolderListAfterChange(body, orphanedFolders, renderFolderImages, bindFolderListClicks, isDuplicateMode, totalDeleted, foldersCleared);
                showToast(`Cleared ${totalDeleted} duplicate(s) from ${foldersProcessed} folder(s), ${totalKept} unique file(s) remain`, totalDeleted > 0 ? 'success' : 'info');
            } catch (error) {
                console.error('[ClearDuplicates] Error:', error);
                showToast('Error clearing duplicates: ' + error.message, 'error');
            }
            btn.innerHTML = originalHtml;
            btn.disabled = false;
            return;
        }

        // Legacy mode - original clear duplicates logic
        if (!confirm(`Clear Duplicates\n\nThis will scan ALL ${orphanedFolders.length} orphaned folder(s) and remove any files that already exist in their matching unique folders.\n\nContinue?`)) {
            return;
        }
        
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Processing...';
        btn.disabled = true;
        
        let totalDeleted = 0;
        let totalKept = 0;
        let foldersProcessed = 0;
        let foldersCleared = 0;
        
        try {
            for (const folder of [...orphanedFolders]) {
                foldersProcessed++;
                btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Folder ${foldersProcessed}/${orphanedFolders.length}...`;
                
                const baseName = folder.name;
                const matchingChars = allCharacters.filter(c => c.name === baseName && getCharacterGalleryId(c));
                const matchingUniqueFolders = matchingChars
                    .map(c => buildUniqueGalleryFolderName(c))
                    .filter(f => f);
                
                if (matchingUniqueFolders.length === 0) {
                    totalKept += folder.files.length;
                    continue;
                }
                
                const uniqueFolderHashes = new Set();
                const uniqueFolderFilenames = new Set();
                for (const uniqueFolder of matchingUniqueFolders) {
                    const folderHashes = await scanFolderForImageHashes(uniqueFolder);
                    for (const [hash, fileName] of folderHashes) {
                        uniqueFolderHashes.add(hash);
                        uniqueFolderFilenames.add(fileName);
                    }
                }
                
                if (uniqueFolderHashes.size === 0 && uniqueFolderFilenames.size === 0) {
                    totalKept += folder.files.length;
                    continue;
                }
                
                let folderDeleted = 0;
                
                for (const fileName of folder.files) {
                    if (uniqueFolderFilenames.has(fileName)) {
                        const deletePath = `/user/images/${folder.name}/${fileName}`;
                        const delResp = await apiRequest(ENDPOINTS.IMAGES_DELETE, 'POST', { path: deletePath });
                        await delResp.text().catch(() => {});
                        folderDeleted++;
                        totalDeleted++;
                        continue;
                    }
                    
                    let localPath;
                    try { localPath = galleryFileUrl(folder.name, fileName); } catch { totalKept++; continue; }
                    
                    try {
                        const fileResponse = await fetch(localPath);
                        if (fileResponse.ok) {
                            const buffer = await fileResponse.arrayBuffer();
                            const hash = await calculateHash(buffer);
                            
                            if (uniqueFolderHashes.has(hash)) {
                                const deletePath = `/user/images/${folder.name}/${fileName}`;
                                const delResp = await apiRequest(ENDPOINTS.IMAGES_DELETE, 'POST', { path: deletePath });
                                await delResp.text().catch(() => {});
                                folderDeleted++;
                                totalDeleted++;
                            } else {
                                totalKept++;
                            }
                        } else {
                            totalKept++;
                        }
                    } catch (e) {
                        totalKept++;
                    }
                }
                
                if (folderDeleted > 0) {
                    const response = await apiRequest(ENDPOINTS.IMAGES_LIST, 'POST', { folder: folder.name, type: 7 });
                    if (response.ok) {
                        const files = await response.json();
                        folder.files = files.map(f => typeof f === 'string' ? f : f.name).filter(Boolean);
                    }
                    
                    if (folder.files.length === 0) {
                        foldersCleared++;
                    }
                }
            }
            
            refreshFolderListAfterChange(body, orphanedFolders, renderFolderImages, bindFolderListClicks, isDuplicateMode, totalDeleted, foldersCleared);
            showToast(`Cleared ${totalDeleted} duplicate(s) from ${foldersProcessed} folder(s), ${totalKept} unique file(s) remain`, totalDeleted > 0 ? 'success' : 'info');
            
        } catch (error) {
            console.error('[ClearDuplicates] Error:', error);
            showToast('Error clearing duplicates: ' + error.message, 'error');
        }
        btn.innerHTML = originalHtml;
        btn.disabled = false;
    });

    // "Move All to Correct Folders" button (duplicate mode only)
    const moveAllCorrectBtn = document.getElementById('orphanedMoveAllCorrectBtn');
    if (moveAllCorrectBtn) {
        moveAllCorrectBtn.addEventListener('click', async () => {
            const foldersWithCorrect = orphanedFolders.filter(f => f.correctFolder);
            const totalFiles = foldersWithCorrect.reduce((sum, f) => sum + f.files.length, 0);

            if (foldersWithCorrect.length === 0) {
                showToast('No folders with known correct destinations', 'info');
                return;
            }

            if (!confirm(`Move All to Correct Folders\n\nThis will move ${totalFiles} file(s) from ${foldersWithCorrect.length} truncated folder(s) to their correct unique folders.\n\nContinue?`)) return;

            moveAllCorrectBtn.disabled = true;
            moveAllCorrectBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Moving...';

            let totalMoved = 0;
            let totalErrors = 0;

            for (let i = 0; i < foldersWithCorrect.length; i++) {
                const folder = foldersWithCorrect[i];
                moveAllCorrectBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Folder ${i + 1}/${foldersWithCorrect.length}...`;

                for (const fileName of [...folder.files]) {
                    const result = await moveImageToFolder(folder.name, folder.correctFolder, fileName, true);
                    if (result.success) {
                        totalMoved++;
                    } else {
                        totalErrors++;
                    }
                }

                // Refresh file list
                const response = await apiRequest(ENDPOINTS.IMAGES_LIST, 'POST', { folder: folder.name, type: 7 });
                if (response.ok) {
                    const files = await response.json();
                    folder.files = files.map(f => typeof f === 'string' ? f : f.name).filter(Boolean);
                } else {
                    folder.files = [];
                }
            }

            refreshFolderListAfterChange(body, orphanedFolders, renderFolderImages, bindFolderListClicks, isDuplicateMode, totalMoved, 0);
            showToast(`Moved ${totalMoved} file(s)${totalErrors > 0 ? `, ${totalErrors} error(s)` : ''}`, totalErrors > 0 ? 'warning' : 'success');

            if (orphanedFolders.length > 0) {
                moveAllCorrectBtn.disabled = false;
                moveAllCorrectBtn.innerHTML = '<i class="fa-solid fa-truck-moving"></i> Move All to Correct Folders';
            }
        });
    }
    
    // Destination search handler
    document.getElementById('orphanedDestSearch').addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase().trim();
        document.querySelectorAll('.orphaned-dest-item').forEach(item => {
            const name = item.dataset.name || '';
            const folder = item.dataset.folder?.toLowerCase() || '';
            const matches = !query || name.includes(query) || folder.includes(query);
            item.style.display = matches ? '' : 'none';
        });
    });
    
    // Character name click handler - open details modal above orphaned modal
    function openCharAboveOrphaned(avatar) {
        const char = allCharacters.find(c => c.avatar === avatar);
        if (!char) return;
        openCharModalElevated(char);
    }

    body.addEventListener('click', (e) => {
        const nameLink = e.target.closest('.dest-name-link, .orphaned-char-link');
        if (!nameLink) return;
        e.stopPropagation();
        const avatar = nameLink.dataset.avatar;
        if (avatar) openCharAboveOrphaned(avatar);
    });

    // Destination click handler - move files
    body.querySelectorAll('.orphaned-dest-item').forEach(destItem => {
        destItem.addEventListener('click', async (e) => {
            if (e.target.closest('.dest-name-link')) return;
            if (selectedFiles.size === 0) {
                showToast('No files selected', 'error');
                return;
            }
            
            const destFolder = destItem.dataset.folder;
            const destName = destItem.querySelector('.dest-name').textContent.trim();
            
            if (!confirm(`Move ${selectedFiles.size} file(s) to "${destName}"?\n\nDestination folder: ${destFolder}`)) {
                return;
            }
            
            const moveBtn = destItem;
            const originalHtml = moveBtn.innerHTML;
            moveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Moving...';
            moveBtn.style.pointerEvents = 'none';
            
            let moved = 0;
            let errors = 0;
            
            for (const fileName of selectedFiles) {
                const result = await moveImageToFolder(currentFolder.name, destFolder, fileName, true);
                if (result.success) {
                    moved++;
                } else {
                    errors++;
                }
            }
            
            moveBtn.innerHTML = originalHtml;
            moveBtn.style.pointerEvents = '';
            
            if (errors === 0) {
                showToast(`Moved ${moved} file(s) successfully`, 'success');
            } else {
                showToast(`Moved ${moved} file(s), ${errors} error(s)`, 'error');
            }
            
            // Refresh folder contents
            const updatedFiles = currentFolder.files.filter(f => !selectedFiles.has(f));
            currentFolder.files = updatedFiles;
            
            const folderItem = body.querySelector(`.orphaned-folder-item[data-folder="${CSS.escape(currentFolder.name)}"]`);
            if (folderItem) {
                const countEl = folderItem.querySelector('.orphaned-folder-count');
                if (countEl) {
                    countEl.textContent = `${updatedFiles.length} file${updatedFiles.length !== 1 ? 's' : ''}`;
                }
                
                if (updatedFiles.length === 0) {
                    folderItem.remove();
                    const idx = orphanedFolders.indexOf(currentFolder);
                    if (idx !== -1) orphanedFolders.splice(idx, 1);
                    
                    const remainingFolders = body.querySelectorAll('.orphaned-folder-item');
                    if (remainingFolders.length > 0) {
                        remainingFolders[0].click();
                    } else {
                        body.innerHTML = `
                            <div class="empty-state" style="padding: 40px; text-align: center;">
                                <i class="fa-solid fa-check-circle" style="font-size: 48px; color: var(--cl-success-bright); margin-bottom: 15px;"></i>
                                <h4 style="color: var(--text-primary); margin: 0 0 10px 0;">All Done!</h4>
                                <p style="color: var(--text-secondary); margin: 0;">
                                    All orphaned folder contents have been redistributed.
                                </p>
                            </div>
                        `;
                    }
                    return;
                }
            }
            
            renderFolderImages(currentFolder);
        });
    });

    } // end renderOrphanedBody

    // ── Shared helper to refresh the folder sidebar after bulk operations ──
    function refreshFolderListAfterChange(body, orphanedFolders, renderFolderImages, bindFolderListClicks, isDuplicateMode, totalProcessed, foldersCleared) {
        // Dismiss emptied folders so they don't reappear
        for (const f of orphanedFolders) {
            if (f.files.length === 0) addDismissedFolder(f.name);
        }
        const remainingFolders = orphanedFolders.filter(f => f.files.length > 0);
        orphanedFolders.length = 0;
        orphanedFolders.push(...remainingFolders);

        if (orphanedFolders.length === 0) {
            body.innerHTML = `
                <div class="empty-state" style="padding: 40px; text-align: center;">
                    <i class="fa-solid fa-check-circle" style="font-size: 48px; color: var(--cl-success-bright); margin-bottom: 15px;"></i>
                    <h4 style="color: var(--text-primary); margin: 0 0 10px 0;">All Done!</h4>
                    <p style="color: var(--text-secondary); margin: 0;">
                        Processed ${totalProcessed} file(s)${foldersCleared > 0 ? ` from ${foldersCleared} folder(s)` : ''}.
                    </p>
                </div>
            `;
        } else {
            const folderListItems = body.querySelector('.orphaned-folders-list-items');
            if (folderListItems) {
                folderListItems.innerHTML = orphanedFolders.map((folder, idx) => {
                    const matchChar = isDuplicateMode && folder.matchingChars?.[0];
                    return `
                    <div class="orphaned-folder-item ${idx === 0 ? 'active' : ''}" data-folder="${escapeHtml(folder.name)}">
                        <div class="orphaned-folder-name">
                            <i class="fa-solid fa-folder" style="color: ${isDuplicateMode ? 'var(--cl-error-bright)' : 'var(--cl-warning-bright)'};"></i>
                            ${escapeHtml(folder.name)}
                        </div>
                        <div class="orphaned-folder-count">${folder.files.length} file${folder.files.length !== 1 ? 's' : ''}</div>
                        ${matchChar ? `<div class="orphaned-folder-char"><img src="${getCharacterAvatarStThumbUrl(matchChar.avatar)}" class="orphaned-char-avatar" onerror="this.style.display='none'"><span class="orphaned-char-link" data-avatar="${escapeHtml(matchChar.avatar)}" title="View character details">${escapeHtml(matchChar.name)}</span></div>` : ''}
                        ${isDuplicateMode && folder.correctFolder ? `<div class="orphaned-folder-correct" title="Correct folder: ${escapeHtml(folder.correctFolder)}"><i class="fa-solid fa-arrow-right"></i> ${escapeHtml(folder.correctFolder.length > 40 ? folder.correctFolder.slice(0, 37) + '...' : folder.correctFolder)}</div>` : ''}
                    </div>`;
                }).join('');
                bindFolderListClicks();
            }
            renderFolderImages(orphanedFolders[0]);
        }
    }

    // ── Mode switch handler ──
    document.getElementById('orphanedFoldersModeSelect').addEventListener('change', (e) => {
        loadMode(e.target.value);
    });

    // Kick off initial scan
    loadMode(currentMode);
}

/**
 * Get the gallery folder name to use for API calls
 * Returns unique folder if enabled and available, otherwise falls back to character name
 * @param {object} char - Character object
 * @returns {string} The folder name to use for ch_name parameter
 */
function getGalleryFolderName(char) {
    if (!char?.name) return '';
    
    // If unique folders disabled, use standard name
    if (!getSetting('uniqueGalleryFolders')) {
        return char.name;
    }
    
    // Try to use unique folder name
    const uniqueFolder = buildUniqueGalleryFolderName(char);
    if (uniqueFolder) {
        return uniqueFolder;
    }
    
    // Fallback to standard name if no gallery_id
    return char.name;
}

/**
 * Resolve the gallery folder name from various inputs
 * Use this when you might have a character object, avatar filename, or just a name
 * @param {object|string} charOrNameOrAvatar - Character object, avatar filename, or character name
 * @returns {string} The folder name to use for ch_name parameter
 */
function resolveGalleryFolderName(charOrNameOrAvatar) {
    // If it's a character object, use getGalleryFolderName directly
    if (charOrNameOrAvatar && typeof charOrNameOrAvatar === 'object' && charOrNameOrAvatar.name) {
        return getGalleryFolderName(charOrNameOrAvatar);
    }
    
    // It's a string - could be avatar or name
    const str = String(charOrNameOrAvatar);
    
    // Try to find character by avatar (also accepts the extensionless import-response stem)
    const strPng = `${str}.png`;
    const charByAvatar = allCharacters.find(c => c.avatar === str || c.avatar === strPng);
    if (charByAvatar) {
        return getGalleryFolderName(charByAvatar);
    }
    
    // Try to find character by name (only if exactly one match)
    const charsByName = allCharacters.filter(c => c.name === str);
    if (charsByName.length === 1) {
        return getGalleryFolderName(charsByName[0]);
    }
    
    // Multiple matches or no matches - return the string as-is
    // For multiple matches with same name, they need to use unique folders
    // to avoid mixing. Since we can't determine which one, use the shared name.
    return str;
}

/**
 * Assign a gallery_id to a character and save it
 * Only works when uniqueGalleryFolders setting is enabled
 * @param {object} char - Character object to update
 * @returns {Promise<{success: boolean, galleryId: string|null, error?: string}>}
 */
async function assignGalleryIdToCharacter(char) {
    // Feature must be enabled
    if (!getSetting('uniqueGalleryFolders')) {
        return { success: false, galleryId: null, error: 'Feature disabled' };
    }
    
    if (!char || !char.avatar) {
        return { success: false, galleryId: null, error: 'Invalid character' };
    }
    
    if (getCharacterGalleryId(char)) {
        debugLog(`[GalleryFolder] Character already has gallery_id: ${char.name}`);
        return { success: true, galleryId: getCharacterGalleryId(char) };
    }

    // Extensions unreadable = the id is UNKNOWN; minting one here would clobber the cards real id on disk.
    if (!extensionsReady(char)) {
        return { success: false, galleryId: null, error: 'Character data not loaded (cannot verify existing ID)' };
    }

    const galleryId = generateGalleryId();

    try {
        // Route through applyCardFieldUpdates (handles preflight, in-memory sync, ST notify).
        const success = await window.applyCardFieldUpdates(char.avatar, {
            'extensions.gallery_id': galleryId,
        });
        if (!success) throw new Error('API error');

        debugLog(`[GalleryFolder] Assigned gallery_id to ${char.name}: ${galleryId}`);
        return { success: true, galleryId };
    } catch (error) {
        debugError(`[GalleryFolder] Failed to assign gallery_id to ${char.name}:`, error);
        return { success: false, galleryId: null, error: error.message };
    }
}

/**
 * Get gallery image/file information for a character
 * @param {object} char - Character object
 * @returns {Promise<{folder: string, files: string[], count: number}>}
 */
async function getCharacterGalleryInfo(char) {
    const folderName = getGalleryFolderName(char);
    if (!folderName) {
        return { folder: '', files: [], count: 0 };
    }
    
    try {
        const response = await apiRequest(ENDPOINTS.IMAGES_LIST, 'POST', { folder: folderName, type: 7 });
        if (!response.ok) {
            return { folder: folderName, files: [], count: 0 };
        }
        const files = await response.json();
        return { folder: folderName, files: files || [], count: (files || []).length };
    } catch (e) {
        debugLog('[Gallery] Error getting gallery info:', e);
        return { folder: folderName, files: [], count: 0 };
    }
}

// Extensions the gallery viewer can display. Audio + everything else is excluded; the gallery tab lists audio in its own section.
const GALLERY_IMAGE_RE = /\.(png|jpg|jpeg|webp|gif|bmp)$/i;
const GALLERY_VIDEO_RE = /\.(mp4|webm|mov|avi|mkv|m4v)$/i;

// Shape a raw gallery file listing into the {name, url, type} list openGalleryViewerWithImages wants, matching what the gallery tab feeds it. Drops audio/non-media; type drives img-vs-video render.
function buildGalleryViewerMedia(files, folderName) {
    const media = [];
    for (const f of (files || [])) {
        const name = (typeof f === 'string') ? f : f?.name;
        if (!name) continue;
        const type = GALLERY_IMAGE_RE.test(name) ? 'image' : GALLERY_VIDEO_RE.test(name) ? 'video' : null;
        if (!type) continue;
        media.push({ name, url: galleryFileUrl(folderName, name), type });
    }
    return media;
}

/**
 * Count characters that need gallery_id assignment
 * @returns {number}
 */
function countCharactersNeedingGalleryId() {
    // Unreadable extensions (interrupted shallow recovery) are unknown, not missing.
    return allCharacters.filter(c => extensionsReady(c) && !getCharacterGalleryId(c)).length;
}

