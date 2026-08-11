// =====================================================
// Card Image (avatar) replacement state — Edit tab
// =====================================================

function populateEditAvatarPreview() {
    const img = document.getElementById('modalImage');
    if (!img || !activeChar) return;
    const url = getCharacterAvatarUrl(activeChar.avatar);
    img.src = url;
    // Mobile mirrors the hero on the small header thumbnail (sidebar is hidden). 32x32 target, so ST's built-in /thumbnail is plenty and avoids re-fetching the full PNG just to shrink it.
    const headerAvatar = document.querySelector('#charModal .mobile-header-avatar');
    if (headerAvatar) headerAvatar.src = getCharacterAvatarStThumbUrl(activeChar.avatar);
}

function clearPendingAvatar() {
    if (pendingAvatarPreviewUrl) {
        try { URL.revokeObjectURL(pendingAvatarPreviewUrl); } catch (_) {}
    }
    pendingAvatarFile = null;
    pendingAvatarPreviewUrl = null;
    const badge = document.getElementById('portraitPendingBadge');
    if (badge) badge.classList.add('hidden');
    const fileInput = document.getElementById('editAvatarFileInput');
    if (fileInput) fileInput.value = '';
    populateEditAvatarPreview();
}

function refreshSaveButtonState() {
    const saveBtn = document.getElementById('saveEditBtn');
    if (!saveBtn || isEditLocked) return;
    saveBtn.disabled = false;
}

function handlePendingAvatarSelected(file) {
    if (!file || !activeChar) return;
    if (!/^image\/(png|jpe?g|webp)$/i.test(file.type)) {
        showToast('Unsupported image type. Use PNG, JPEG, or WebP.', 'error');
        return;
    }
    const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
    if (file.size > MAX_BYTES) {
        showToast('Image too large (max 10 MB).', 'error');
        return;
    }
    if (pendingAvatarPreviewUrl) {
        try { URL.revokeObjectURL(pendingAvatarPreviewUrl); } catch (_) {}
    }
    pendingAvatarFile = file;
    pendingAvatarPreviewUrl = URL.createObjectURL(file);
    const img = document.getElementById('modalImage');
    if (img) img.src = pendingAvatarPreviewUrl;
    // Mirror the preview onto the mobile header thumbnail.
    const headerAvatar = document.querySelector('#charModal .mobile-header-avatar');
    if (headerAvatar) headerAvatar.src = pendingAvatarPreviewUrl;
    const badge = document.getElementById('portraitPendingBadge');
    if (badge) badge.classList.remove('hidden');
    refreshSaveButtonState();
}

function closeModal() {
    modal.classList.add('hidden');
    _modalOpenGen++;
    activeChar = null;

    // Clear avatar so stale image doesn't flash on next open
    const modalImg = document.getElementById('modalImage');
    modalImg.removeAttribute('src');
    modalImg.classList.remove('loading');

    // Reset all edit-mode DOM state (tag input, lock header, buttons, etc.)
    setEditLock(true);
    originalValues = {};
    originalRawData = {};
    _editTagsArray = [];

    // Discard any pending avatar replacement
    clearPendingAvatar();
    
    // Release window globals holding rich text content (can be large)
    window.currentCreatorNotesContent = null;
    window.currentFirstMesContent = null;
    window.currentAltGreetingsContent = null;
    
    // Clear alt greetings HTML
    const altGreetingsEl = document.getElementById('modalAltGreetings');
    if (altGreetingsEl) altGreetingsEl.innerHTML = '';
    
    // Clear creator notes iframe - disconnect ResizeObserver and release its document
    const creatorNotesEl = document.getElementById('modalCreatorNotes');
    cleanupCreatorNotesContainer(creatorNotesEl);
    
    // Clear tagline content
    const taglineEl = document.getElementById('modalProviderTagline');
    if (taglineEl) taglineEl.textContent = '';

    if (duplicateModalState.wasOpen) {
        restoreDuplicateModalState();
        duplicateModalState.wasOpen = false; // Reset flag
    }
    else if (bulkSummaryModalState.wasOpen) {
        restoreBulkSummaryModalState();
        bulkSummaryModalState.wasOpen = false; // Reset flag
    }
}

// ==================== INFO TAB (Developer) ====================

/**
 * Populate the Info tab with character metadata and mappings
 * @param {Object} char - Character object
 */
function populateInfoTab(char) {
    const container = document.getElementById('infoTabContent');
    if (!container || !char) return;
    
    const charName = char.name || char.data?.name || 'Unknown';
    const listingName = getListingNameFromExtensions(char);
    const avatar = char.avatar || '';
    const galleryFolder = getGalleryFolderName(char);
    const chatsFolder = sanitizeFolderName(charName);
    const providerResult = window.ProviderRegistry?.getCharacterProvider(char) || null;
    const galleryId = getCharacterGalleryId(char);
    const uniqueFoldersEnabled = getSetting('uniqueGalleryFolders');
    const mediaLocStatus = char.avatar ? getMediaLocalizationStatus(char.avatar) : null;
    const isFavorite = isCharacterFavorite(char);
    
    // Get token estimate
    const tokenEstimate = estimateTokens(char);
    
    // Get embedded media URLs count
    const { embeddedUrls: sidebarEmbeddedUrls, lorebookUrls: sidebarLorebookUrls } = findCharacterMediaUrls(char, { split: true });
    
    // Get lorebook info
    const characterBook = char.character_book || char.data?.character_book;
    const lorebookEntries = characterBook?.entries?.length || 0;
    // Linked external world file (primary link) lives on the card at data.extensions.world.
    const linkedWorld = char.data?.extensions?.world || '';
    
    // Get alternate greetings count
    const altGreetings = char.alternate_greetings || char.data?.alternate_greetings || [];
    
    // Build HTML
    let html = '';
    
    // Section: Identity
    html += `<div class="info-section">
        <div class="info-section-title"><i class="fa-solid fa-user"></i> Identity</div>
        <div class="info-row">
            <span class="info-label">Card Name</span>
            <span class="info-value">${escapeHtml(charName)}</span>
        </div>
        <div class="info-row">
            <span class="info-label">Listing Name</span>
            <span class="info-value">${listingName ? escapeHtml(listingName) : '<span style="color: var(--text-faint);">(none)</span>'}</span>
        </div>
        <div class="info-row">
            <span class="info-label">Creator</span>
            <span class="info-value">${escapeHtml(String(char.creator || char.data?.creator || '(not set)'))}</span>
        </div>
        <div class="info-row">
            <span class="info-label">Version</span>
            <span class="info-value">${escapeHtml(String(char.character_version || char.data?.character_version || '(not set)'))}</span>
        </div>
        <div class="info-row">
            <span class="info-label">Favorite</span>
            <span class="info-value">${isFavorite ? '<i class="fa-solid fa-star" style="color: gold;"></i> Yes' : 'No'}</span>
        </div>
    </div>`;
    
    // Section: Files & Paths
    html += `<div class="info-section">
        <div class="info-section-title"><i class="fa-solid fa-folder-tree"></i> Files & Paths</div>
        <div class="info-row">
            <span class="info-label">Avatar Filename</span>
            <span class="info-value info-code">${escapeHtml(avatar) || '(none)'}</span>
        </div>
        <div class="info-row">
            <span class="info-label">Gallery Folder</span>
            <span class="info-value info-code">/characters/${escapeHtml(galleryFolder)}/</span>
        </div>
        <div class="info-row">
            <span class="info-label">Chats Folder</span>
            <span class="info-value info-code">/chats/${escapeHtml(chatsFolder)}/</span>
        </div>
    </div>`;
    
    // Section: Unique Gallery ID
    html += `<div class="info-section">
        <div class="info-section-title"><i class="fa-solid fa-fingerprint"></i> Unique Gallery</div>
        <div class="info-row">
            <span class="info-label">Feature Enabled</span>
            <span class="info-value">${uniqueFoldersEnabled ? '<i class="fa-solid fa-check" style="color: var(--cl-success-bright);"></i> Yes' : '<i class="fa-solid fa-times" style="color: var(--text-faint);"></i> No'}</span>
        </div>
        <div class="info-row">
            <span class="info-label">Gallery ID</span>
            <span class="info-value info-code">${galleryId ? escapeHtml(galleryId) : '<span style="color: var(--text-faint);">(not assigned)</span>'}</span>
        </div>
        <div class="info-row">
            <span class="info-label">Unique Folder Name</span>
            <span class="info-value info-code">${galleryId ? escapeHtml(buildUniqueGalleryFolderName(char)) : '<span style="color: var(--text-faint);">(using standard name)</span>'}</span>
        </div>
    </div>`;
    
    // Section: Provider Link (generic - shows whichever provider owns this card)
    html += `<div class="info-section">
        <div class="info-section-title"><i class="fa-solid fa-link"></i> Provider Link</div>
        <div class="info-row">
            <span class="info-label">Linked</span>
            <span class="info-value">${providerResult ? '<i class="fa-solid fa-check" style="color: var(--cl-success-bright);"></i> Yes' : '<i class="fa-solid fa-times" style="color: var(--text-faint);"></i> No'}</span>
        </div>`;
    if (providerResult) {
        const { provider: linkedProvider, linkInfo } = providerResult;
        html += `<div class="info-row">
            <span class="info-label">Provider</span>
            <span class="info-value"><i class="${escapeHtml(linkedProvider.icon)}"></i> ${escapeHtml(linkedProvider.name)}</span>
        </div>
        <div class="info-row">
            <span class="info-label">Full Path</span>
            <span class="info-value info-code">${escapeHtml(linkInfo.fullPath || '')}</span>
        </div>
        <div class="info-row">
            <span class="info-label">Provider ID</span>
            <span class="info-value info-code">${escapeHtml(String(linkInfo.id || ''))}</span>
        </div>`;
        if (linkInfo.linkedAt) {
            html += `<div class="info-row">
                <span class="info-label">Linked At</span>
                <span class="info-value">${escapeHtml(new Date(linkInfo.linkedAt).toLocaleString())}</span>
            </div>`;
        }
    }
    html += `</div>`;

    // Section: Lorebook (embedded book + linked external world file)
    html += `<div class="info-section">
        <div class="info-section-title"><i class="fa-solid fa-book-atlas"></i> Lorebook</div>
        <div class="info-row">
            <span class="info-label">Embedded Book</span>
            <span class="info-value">${characterBook ? `<i class="fa-solid fa-check" style="color: var(--cl-success-bright);"></i> Yes (${lorebookEntries} ${lorebookEntries === 1 ? 'entry' : 'entries'})` : '<i class="fa-solid fa-times" style="color: var(--text-faint);"></i> No'}</span>
        </div>
        <div class="info-row">
            <span class="info-label">Linked World</span>
            <span class="info-value">${linkedWorld ? `<i class="fa-solid fa-link" style="color: var(--cl-success-bright);"></i> ${escapeHtml(linkedWorld)}` : '<span style="color: var(--text-faint);">(none)</span>'}</span>
        </div>
    </div>`;

    // Section: Media Localization
    html += `<div class="info-section">
        <div class="info-section-title"><i class="fa-solid fa-images"></i> Media Localization</div>
        <div class="info-row">
            <span class="info-label">Global Setting</span>
            <span class="info-value">${mediaLocStatus?.globalEnabled ? '<i class="fa-solid fa-check" style="color: var(--cl-success-bright);"></i> Enabled' : '<i class="fa-solid fa-times" style="color: var(--text-faint);"></i> Disabled'}</span>
        </div>
        <div class="info-row">
            <span class="info-label">Per-Character Override</span>
            <span class="info-value">${mediaLocStatus?.hasOverride ? (mediaLocStatus.isEnabled ? 'Force ON' : 'Force OFF') : '(none)'}</span>
        </div>
        <div class="info-row">
            <span class="info-label">Effective State</span>
            <span class="info-value">${mediaLocStatus?.isEnabled ? '<i class="fa-solid fa-check" style="color: var(--cl-success-bright);"></i> Active' : '<i class="fa-solid fa-times" style="color: var(--text-faint);"></i> Inactive'}</span>
        </div>
        <div class="info-row">
            <span class="info-label">Embedded Media URLs</span>
            <span class="info-value">${sidebarEmbeddedUrls.length} URL(s) found</span>
        </div>
        <div class="info-row">
            <span class="info-label">Lorebook Media URLs</span>
            <span class="info-value">${sidebarLorebookUrls.length} URL(s) found</span>
        </div>
    </div>`;
    
    // Section: Content Stats
    html += `<div class="info-section">
        <div class="info-section-title"><i class="fa-solid fa-chart-bar"></i> Content Stats</div>
        <div class="info-row">
            <span class="info-label">Est. Token Count</span>
            <span class="info-value">~${tokenEstimate.toLocaleString()} tokens</span>
        </div>
        <div class="info-row">
            <span class="info-label">Alternate Greetings</span>
            <span class="info-value">${altGreetings.length}</span>
        </div>
        <div class="info-row">
            <span class="info-label">Lorebook Entries</span>
            <span class="info-value">${lorebookEntries}</span>
        </div>
        <div class="info-row">
            <span class="info-label">Tags</span>
            <span class="info-value">${(getTags(char) || []).length}</span>
        </div>
    </div>`;
    
    // Section: Spec Info
    const spec = char.spec || char.data?.spec || 'unknown';
    const specVersion = char.spec_version || char.data?.spec_version || '';
    html += `<div class="info-section">
        <div class="info-section-title"><i class="fa-solid fa-file-code"></i> Card Spec</div>
        <div class="info-row">
            <span class="info-label">Spec</span>
            <span class="info-value info-code">${escapeHtml(spec)}</span>
        </div>
        <div class="info-row">
            <span class="info-label">Spec Version</span>
            <span class="info-value info-code">${escapeHtml(specVersion) || '(not set)'}</span>
        </div>
    </div>`;
    
    // Section: Date Info
    const createDateRaw = getCharacterCreateDateValue(char);
    const dateCreated = createDateRaw ? new Date(createDateRaw) : null;
    const dateModified = char.date_added ? new Date(Number(char.date_added)) : null;
    
    html += `<div class="info-section">
        <div class="info-section-title"><i class="fa-solid fa-calendar"></i> Dates</div>
        <div class="info-row">
            <span class="info-label">Date Created</span>
            <span class="info-value">${formatDateTime(createDateRaw)}</span>
        </div>
        <div class="info-row">
            <span class="info-label">Last Modified</span>
            <span class="info-value">${dateModified && !isNaN(dateModified.getTime()) ? formatDateTime(dateModified.getTime()) : '(not available)'}</span>
        </div>
    </div>`;
    
    // Section: Raw Extensions (if any)
    const extensions = char.data?.extensions || char.extensions || {};
    // Exclude the linked provider's key since it's already shown in the Provider Link section
    const linkedProviderKey = providerResult?.provider?.id || null;
    const extensionKeys = Object.keys(extensions).filter(k => k !== linkedProviderKey);
    if (extensionKeys.length > 0) {
        html += `<div class="info-section">
            <div class="info-section-title"><i class="fa-solid fa-puzzle-piece"></i> Extensions</div>`;
        for (const key of extensionKeys) {
            const value = extensions[key];
            const displayValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
            html += `<div class="info-row">
                <span class="info-label info-code">${escapeHtml(key)}</span>
                <span class="info-value info-code" style="word-break: break-all;">${escapeHtml(displayValue.substring(0, 100))}${displayValue.length > 100 ? '...' : ''}</span>
            </div>`;
        }
        html += `</div>`;
    }
    
    // Section: Actions
    html += `<div class="info-section info-actions-section">
        <div class="info-section-title"><i class="fa-solid fa-wrench"></i> Actions</div>
        <div class="info-actions">
            <button type="button" class="action-btn secondary small" id="copyRawCardDataBtn">
                <i class="fa-solid fa-copy"></i> Copy Raw Card Data
            </button>
        </div>
    </div>`;
    
    container.innerHTML = html;
    
    // Attach event handler for copy button (use activeChar for most up-to-date reference)
    const copyBtn = document.getElementById('copyRawCardDataBtn');
    if (copyBtn) {
        copyBtn.onclick = () => copyRawCardData(activeChar);
    }
}

/**
 * Copy the raw character card data to clipboard as JSON
 * @param {Object} char - Character object (optional, falls back to activeChar)
 */
function copyRawCardData(char) {
    // Use activeChar as fallback
    const character = char || activeChar;
    
    if (!character) {
        showToast('No character data available', 'error');
        return;
    }
    
    try {
        const cardData = {
            // Include spec info
            spec: character.spec || character.data?.spec || 'chara_card_v2',
            spec_version: character.spec_version || character.data?.spec_version || '2.0',
            // Include the data object (main character definition)
            data: character.data || {
                name: character.name,
                description: character.description,
                personality: character.personality,
                scenario: character.scenario,
                first_mes: character.first_mes,
                mes_example: character.mes_example,
                creator_notes: character.creator_notes,
                system_prompt: character.system_prompt,
                post_history_instructions: character.post_history_instructions,
                alternate_greetings: character.alternate_greetings || [],
                tags: character.tags || [],
                creator: character.creator,
                character_version: character.character_version,
                extensions: character.extensions || {},
                character_book: character.character_book || null,
            },
            // Include ST-specific metadata
            _meta: {
                avatar: character.avatar,
                date_added: character.date_added,
                create_date: character.create_date,
            }
        };
        
        const jsonString = JSON.stringify(cardData, null, 2);
        
        copyTextToClipboard(jsonString).then((success) => {
            showToast(success ? 'Card data copied to clipboard' : 'Failed to copy to clipboard', success ? 'success' : 'error');
        });
    } catch (error) {
        console.error('Error preparing card data:', error);
        showToast('Error preparing card data', 'error');
    }
}

/**
 * Copy text to the clipboard: modern API first, textarea fallback for
 * non-secure contexts. No toasts; callers own the feedback.
 * @param {string} text
 * @returns {Promise<boolean>}
 */
async function copyTextToClipboard(text) {
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch { /* fall through to the textarea path */ }
    try {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        textarea.style.top = '-9999px';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        const success = document.execCommand('copy');
        document.body.removeChild(textarea);
        return success;
    } catch (err) {
        console.error('Fallback copy failed:', err);
        return false;
    }
}

// ==================== RELATED CHARACTERS ====================

// Words to skip when extracting proper-noun keywords from character text.
// Covers determiners, pronouns, prepositions, conjunctions, auxiliaries/modals,
// common verbs/adjectives/adverbs, and roleplay/character-card boilerplate that
// appear at sentence starts and get captured by the capitalized-word regex but
// carry no universe-identifying signal.
const COMMON_SKIP_WORDS = new Set([
    // Determiners & articles
    'the', 'this', 'that', 'these', 'those', 'each', 'every', 'both',
    'either', 'neither', 'such', 'another', 'other',
    // Pronouns
    'you', 'your', 'yours', 'yourself', 'they', 'them', 'their', 'theirs',
    'themselves', 'she', 'her', 'hers', 'herself', 'him', 'his', 'himself',
    'its', 'itself', 'one', 'ones', 'someone', 'anyone', 'everyone',
    'something', 'anything', 'everything', 'nothing', 'nobody', 'everybody',
    'whoever', 'whatever', 'whichever',
    // Prepositions & postpositions
    'about', 'above', 'across', 'after', 'against', 'along', 'among',
    'around', 'before', 'behind', 'below', 'beneath', 'beside', 'besides',
    'between', 'beyond', 'concerning', 'despite', 'down', 'during', 'except',
    'following', 'from', 'inside', 'into', 'like', 'near', 'onto', 'outside',
    'over', 'past', 'regarding', 'since', 'through', 'throughout', 'towards',
    'under', 'underneath', 'unlike', 'until', 'upon', 'with', 'within',
    'without',
    // Conjunctions
    'and', 'but', 'for', 'nor', 'yet', 'also', 'although', 'because',
    'however', 'moreover', 'nevertheless', 'otherwise', 'therefore',
    'furthermore', 'meanwhile', 'nonetheless', 'though', 'unless', 'whereas',
    'wherever', 'whenever', 'while',
    // Auxiliaries & modals
    'been', 'being', 'can', 'could', 'did', 'does', 'had', 'has', 'have',
    'may', 'might', 'must', 'shall', 'should', 'was', 'were', 'will',
    'would',
    // Question / relative words
    'how', 'what', 'when', 'where', 'which', 'who', 'whom', 'whose', 'why',
    // Common adverbs
    'already', 'always', 'almost', 'away', 'back', 'completely', 'deeply',
    'easily', 'else', 'especially', 'even', 'eventually', 'ever', 'extremely',
    'fairly', 'finally', 'fully', 'generally', 'greatly', 'hardly',
    'here', 'highly', 'immediately', 'indeed', 'instead', 'just', 'later',
    'likely', 'merely', 'more', 'most', 'much', 'naturally', 'nearly',
    'never', 'not', 'now', 'occasionally', 'often', 'once', 'only',
    'originally', 'particularly', 'perhaps', 'possibly', 'primarily',
    'probably', 'quickly', 'quite', 'rarely', 'rather', 'really',
    'recently', 'simply', 'slowly', 'sometimes', 'soon', 'still',
    'suddenly', 'then', 'there', 'thus', 'together', 'too', 'truly',
    'typically', 'usually', 'very', 'well',
    // Common verbs (high-frequency, low-signal)
    'ask', 'asked', 'become', 'becomes', 'began', 'begin', 'believe',
    'bring', 'brought', 'call', 'called', 'came', 'change', 'come',
    'comes', 'consider', 'continue', 'create', 'created', 'dare', 'deal',
    'enjoy', 'ensure', 'expect', 'face', 'feel', 'feels', 'felt', 'find',
    'found', 'gave', 'get', 'gets', 'give', 'given', 'gives', 'goes',
    'going', 'gone', 'got', 'grew', 'grow', 'grown', 'happen', 'help',
    'hold', 'include', 'including', 'keep', 'keeps', 'kept', 'knew',
    'know', 'known', 'knows', 'lead', 'leads', 'learn', 'leave', 'left',
    'let', 'live', 'lives', 'look', 'looks', 'lose', 'lost', 'made',
    'make', 'makes', 'making', 'mean', 'means', 'meet', 'move', 'moved',
    'need', 'needs', 'offer', 'open', 'part', 'play', 'provide', 'pull',
    'push', 'put', 'raise', 'ran', 'reach', 'read', 'remain', 'require',
    'return', 'run', 'running', 'said', 'saw', 'say', 'says', 'see',
    'seem', 'seems', 'seen', 'serve', 'set', 'show', 'shown', 'shows',
    'sit', 'speak', 'spend', 'stand', 'start', 'started', 'stay', 'step',
    'stop', 'take', 'takes', 'talk', 'tell', 'think', 'thinks', 'thought',
    'told', 'took', 'try', 'turn', 'turned', 'understand', 'use', 'used',
    'uses', 'walk', 'want', 'wants', 'watch', 'wish', 'work', 'works',
    'write', 'written',
    // Common adjectives (generic descriptors, not universe-identifying)
    'able', 'alone', 'available', 'beautiful', 'best', 'better', 'big',
    'black', 'blue', 'brown', 'certain', 'clear', 'close', 'cold',
    'common', 'complete', 'current', 'dark', 'dead', 'deep', 'different',
    'difficult', 'early', 'easy', 'entire', 'evident', 'evil', 'familiar',
    'far', 'few', 'final', 'fine', 'first', 'former', 'free', 'full',
    'general', 'gentle', 'good', 'great', 'green', 'grey', 'half', 'hard',
    'heavy', 'high', 'hot', 'huge', 'human', 'important', 'impossible',
    'known', 'large', 'last', 'late', 'least', 'less', 'little', 'long',
    'lost', 'low', 'main', 'major', 'many', 'mere', 'mind', 'minor',
    'modern', 'natural', 'necessary', 'new', 'next', 'normal', 'obvious',
    'old', 'only', 'original', 'own', 'particular', 'past', 'perfect',
    'personal', 'physical', 'plain', 'poor', 'possible', 'present',
    'pretty', 'private', 'proper', 'public', 'pure', 'quick', 'real',
    'red', 'rich', 'right', 'same', 'serious', 'several', 'sharp',
    'short', 'significant', 'similar', 'simple', 'single', 'small',
    'soft', 'some', 'special', 'strong', 'sure', 'sweet', 'tall', 'than',
    'thin', 'top', 'total', 'true', 'usual', 'vast', 'warm', 'weak',
    'well', 'white', 'whole', 'wide', 'wild', 'worth', 'wrong', 'young',
    // Common nouns (generic concepts that appear in any character card)
    'age', 'area', 'arms', 'attention', 'battle', 'bear', 'beauty',
    'body', 'bone', 'boy', 'case', 'cause', 'century', 'chance', 'child',
    'children', 'choice', 'city', 'class', 'control', 'country', 'course',
    'culture', 'danger', 'daughter', 'day', 'days', 'death', 'desire',
    'door', 'dream', 'edge', 'effect', 'end', 'energy', 'era', 'event',
    'example', 'experience', 'eye', 'eyes', 'face', 'fact', 'family',
    'father', 'fear', 'feeling', 'figure', 'fire', 'foot', 'force',
    'form', 'friend', 'friends', 'game', 'girl', 'god', 'ground', 'group',
    'hair', 'hand', 'hands', 'head', 'heart', 'history', 'home', 'hope',
    'hour', 'house', 'idea', 'interest', 'issue', 'kind', 'land', 'level',
    'life', 'light', 'line', 'love', 'man', 'mark', 'matter', 'men',
    'moment', 'money', 'month', 'morning', 'mother', 'mouth', 'name',
    'nature', 'night', 'note', 'number', 'order', 'pain', 'people',
    'person', 'place', 'point', 'position', 'power', 'problem', 'question',
    'reason', 'rest', 'result', 'road', 'role', 'room', 'rule', 'sense',
    'side', 'sign', 'sister', 'situation', 'skin', 'society', 'son',
    'sort', 'soul', 'sound', 'space', 'spirit', 'state', 'story',
    'strength', 'student', 'system', 'teacher', 'thing', 'things', 'time',
    'town', 'trouble', 'truth', 'type', 'voice', 'war', 'water', 'way',
    'week', 'woman', 'women', 'word', 'words', 'world', 'year', 'years',
    // Roleplay / character-card boilerplate
    'user', 'char', 'character', 'player', 'narrator', 'assistant',
    'roleplay', 'scenario', 'response', 'responses', 'greeting', 'message',
    'personality', 'backstory', 'background', 'description', 'appearance',
    'behavior', 'behaviour', 'dialogue', 'interaction', 'setting',
    'example', 'context', 'instruction', 'instructions', 'note', 'notes',
    'action', 'actions', 'reply', 'conversation', 'prompt', 'always',
    'never', 'must', 'shall', 'please', 'remember', 'include', 'avoid',
    'maintain', 'provide', 'express', 'portray', 'depict', 'speak',
    'speaking', 'refer', 'referred', 'describe', 'described', 'engage',
    'interact', 'based', 'capable', 'willing', 'tends', 'often',
    'sometimes', 'usually', 'rarely', 'despite', 'however', 'although',
    'overall', 'within', 'around', 'between', 'through',
    // Extra generic descriptor terms (low signal for shared-universe matching)
    'gender', 'style', 'clothing', 'clothing style', 'speaking style',
    'appearance', 'appearence', 'face', 'personality details', 'details',
    'hobby', 'hobbies', 'like', 'likes', 'dislike', 'dislikes',
    'love', 'loves', 'relationship', 'relationships', 'constantly',
    'somehow',
    // Sentence-start fillers (capitalized in prose but carry no signal)
    'there', 'here', 'once', 'thus', 'hence', 'moreover', 'furthermore',
    'additionally', 'consequently', 'regardless', 'apparently', 'basically',
    'certainly', 'clearly', 'essentially', 'fortunately', 'honestly',
    'ideally', 'importantly', 'inevitably', 'interestingly', 'naturally',
    'normally', 'notably', 'obviously', 'presumably', 'supposedly',
    'surprisingly', 'ultimately', 'unfortunately'
]);

/**
 * Extract keywords from text for content-based matching
 * Extracts significant proper nouns (capitalized words) that might indicate
 * shared universe, characters, or locations
 */
function extractContentKeywords(text) {
    if (!text) return new Set();
    
    const keywords = new Set();
    
    // Extract capitalized proper nouns (likely character/place names)
    // Match sequences of capitalized words (e.g., "Genshin Impact", "Harry Potter")
    const properNouns = text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g);
    if (properNouns) {
        properNouns.forEach(noun => {
            const lower = noun.toLowerCase();
            // Skip common words and very short names
            if (noun.length > 3 && !COMMON_SKIP_WORDS.has(lower)) {
                keywords.add(lower);
            }
        });
    }
    
    return keywords;
}

// Cache for tag frequency (how many characters have each tag)
let tagFrequencyCache = null;
let tagFrequencyCacheTime = 0;
const TAG_FREQUENCY_CACHE_TTL = 60000; // 1 minute

/**
 * Build/get cached tag frequency map
 * Returns Map of tag -> count of characters with that tag
 */
function getTagFrequencies() {
    const now = Date.now();
    if (tagFrequencyCache && (now - tagFrequencyCacheTime) < TAG_FREQUENCY_CACHE_TTL) {
        return tagFrequencyCache;
    }
    
    const frequencies = new Map();
    for (const char of allCharacters) {
        const tags = getTags(char);
        for (const tag of tags) {
            const normalizedTag = tag.toLowerCase().trim();
            if (normalizedTag) {
                frequencies.set(normalizedTag, (frequencies.get(normalizedTag) || 0) + 1);
            }
        }
    }
    
    tagFrequencyCache = frequencies;
    tagFrequencyCacheTime = now;
    return frequencies;
}

/**
 * Calculate the weight of a tag based on its rarity (inverse frequency)
 * Rare tags are worth more than common tags
 * @param {string} tag - The tag to calculate weight for
 * @param {Map} frequencies - Tag frequency map
 * @param {number} totalChars - Total number of characters
 * @returns {number} Weight value (higher = rarer/more valuable)
 */
function calculateTagWeight(tag, frequencies, totalChars) {
    const count = frequencies.get(tag) || 1;
    const frequency = count / totalChars;
    
    // Inverse frequency scoring with log scaling
    // Very rare (1-2 chars): ~20-25 points
    // Rare (3-10 chars): ~12-18 points  
    // Uncommon (11-50 chars): ~6-12 points
    // Common (51-200 chars): ~3-6 points
    // Very common (200+ chars): ~1-3 points
    
    // Using inverse log: -log(frequency) gives higher scores for lower frequencies
    // Base weight + inverse frequency bonus
    const baseWeight = 2;
    const rarityBonus = Math.max(0, -Math.log10(frequency) * 6);
    
    return Math.round(baseWeight + rarityBonus);
}

/**
 * Calculate relatedness score between two characters
 * Returns object with total score and breakdown by category
 *
 * @param {Object} sourceChar
 * @param {Object} targetChar
 * @param {Object} options  - useTags / useCreator / useContent booleans
 * @param {Object} [sourceCache] - Pre-computed source-side data to avoid
 *   recomputing per comparison (tags Set, creator string, keywords Set)
 */
function calculateRelatednessScore(sourceChar, targetChar, options = {}, sourceCache = null) {
    const { useTags = true, useCreator = true, useContent = true } = options;
    
    let score = 0;
    const breakdown = { tags: 0, creator: 0, content: 0, sharedTagCount: 0, topTags: [] };
    const matchReasons = [];
    
    // 1. Tag overlap (highest weight - tags are explicit categorization)
    if (useTags) {
        const sourceTags = sourceCache?.tags ?? new Set(getTags(sourceChar).map(t => t.toLowerCase().trim()));
        const targetTags = new Set(getTags(targetChar).map(t => t.toLowerCase().trim()));
        
        const sharedTags = [...sourceTags].filter(t => t && targetTags.has(t));
        
        if (sharedTags.length > 0) {
            // Get tag frequencies for rarity-based weighting
            const frequencies = getTagFrequencies();
            const totalChars = allCharacters.length;
            
            // Calculate weighted score based on tag rarity
            let tagScore = 0;
            const tagWeights = [];
            
            for (const tag of sharedTags) {
                const weight = calculateTagWeight(tag, frequencies, totalChars);
                tagScore += weight;
                tagWeights.push({ tag, weight, count: frequencies.get(tag) || 1 });
            }
            
            // Sort by weight descending to show most significant tags first
            tagWeights.sort((a, b) => b.weight - a.weight);
            
            breakdown.tags = tagScore;
            breakdown.sharedTagCount = sharedTags.length;
            breakdown.topTags = tagWeights.slice(0, 3); // Keep top 3 for display
            score += tagScore;
            
            // Build match reason showing most significant shared tags
            if (tagWeights.length === 1) {
                const t = tagWeights[0];
                matchReasons.push(`Shared tag: ${t.tag}${t.count <= 5 ? ' (rare!)' : ''}`);
            } else {
                // Show the most specific/rare tags
                const topTagNames = tagWeights.slice(0, 2).map(t => t.tag);
                const rareCount = tagWeights.filter(t => t.count <= 5).length;
                let reason = `${sharedTags.length} shared tags`;
                if (rareCount > 0) {
                    reason += ` (${rareCount} rare)`;
                }
                reason += `: ${topTagNames.join(', ')}`;
                if (tagWeights.length > 2) reason += '...';
                matchReasons.push(reason);
            }
        }
    }
    
    // 2. Same creator (moderate weight)
    if (useCreator) {
        const sourceCreator = sourceCache?.creator ?? (getCharField(sourceChar, 'creator') || '').toLowerCase().trim();
        const targetCreator = (getCharField(targetChar, 'creator') || '').toLowerCase().trim();
        
        if (sourceCreator && targetCreator && sourceCreator === targetCreator) {
            breakdown.creator = 25;
            score += 25;
            matchReasons.push(`Same creator: ${getCharField(targetChar, 'creator')}`);
        }
    }
    
    // 3. Content/keyword similarity (looks for universe indicators)
    if (useContent) {
        const sourceKeywords = sourceCache?.keywords ?? extractContentKeywords([
            getCharField(sourceChar, 'name'),
            getCharField(sourceChar, 'description'),
            getCharField(sourceChar, 'personality'),
            getCharField(sourceChar, 'scenario'),
            getCharField(sourceChar, 'first_mes')
        ].filter(Boolean).join(' '));
        
        const targetText = [
            getCharField(targetChar, 'name'),
            getCharField(targetChar, 'description'),
            getCharField(targetChar, 'personality'),
            getCharField(targetChar, 'scenario'),
            getCharField(targetChar, 'first_mes')
        ].filter(Boolean).join(' ');
        
        const targetKeywords = extractContentKeywords(targetText);
        
        // Find shared keywords
        const sharedKeywords = [...sourceKeywords].filter(k => targetKeywords.has(k));
        
        if (sharedKeywords.length > 0) {
            // Weight based on keyword rarity/specificity
            const contentScore = Math.min(sharedKeywords.length * 10, 35);
            breakdown.content = contentScore;
            score += contentScore;
            
            // Pick the most interesting keywords to show
            const displayKeywords = sharedKeywords.slice(0, 3).join(', ');
            matchReasons.push(`Shared context: ${displayKeywords}`);
        }
    }
    
    return {
        score,
        breakdown,
        matchReasons
    };
}

let _relatedSearchId = 0;
const RELATED_CHUNK_SIZE = 200;

/**
 * Find characters related to the given character.
 * Processes in async chunks so the UI stays responsive for large libraries.
 */
async function findRelatedCharacters(sourceChar) {
    const resultsEl = document.getElementById('relatedResults');
    if (!resultsEl) return;
    
    // Cancel any in-flight search
    const searchId = ++_relatedSearchId;
    
    resultsEl.innerHTML = '<div class="related-loading"><i class="fa-solid fa-spinner fa-spin"></i> Finding related characters...</div>';
    
    // Get filter options
    const useTags = document.getElementById('relatedFilterTags')?.checked ?? true;
    const useCreator = document.getElementById('relatedFilterCreator')?.checked ?? true;
    const useContent = document.getElementById('relatedFilterContent')?.checked ?? true;
    const options = { useTags, useCreator, useContent };
    
    // Fetch full data for content matching (allCharacters stores slim objects)
    let fullDataMap = null;
    if (useContent && allCharacters.length > 0) {
        try {
            const response = await apiRequest(ENDPOINTS.CHARACTERS_ALL, 'POST', {});
            if (!response.ok) {
                console.warn('[Related] /characters/all returned', response.status);
            } else {
                const data = await response.json();
                const arr = Array.isArray(data) ? data : (data.data || []);
                if (arr.length > 0 && arr[0].shallow) {
                    console.warn('[Related] Server returned shallow data — content matching via hydration');
                } else if (arr.length > 0) {
                    fullDataMap = new Map();
                    for (const c of arr) {
                        if (c?.avatar) fullDataMap.set(c.avatar, c);
                    }
                }
            }
        } catch (e) {
            console.warn('[Related] Failed to fetch full data:', e.message);
        }
    }
    if (searchId !== _relatedSearchId) return;
    
    // Pre-compute source-side data once (avoids recomputing per comparison)
    const sourceCache = {};
    const sourceSrc = fullDataMap?.get(sourceChar.avatar) || sourceChar;
    if (useTags) {
        sourceCache.tags = new Set(getTags(sourceChar).map(t => t.toLowerCase().trim()));
    }
    if (useCreator) {
        sourceCache.creator = (getCharField(sourceChar, 'creator') || '').toLowerCase().trim();
    }
    if (useContent) {
        sourceCache.keywords = extractContentKeywords([
            getCharField(sourceSrc, 'name'),
            getCharField(sourceSrc, 'description'),
            getCharField(sourceSrc, 'personality'),
            getCharField(sourceSrc, 'scenario'),
            getCharField(sourceSrc, 'first_mes')
        ].filter(Boolean).join(' '));
    }
    
    const sourceAvatar = sourceChar.avatar;
    const related = [];
    let idx = 0;
    const hasFullData = fullDataMap !== null;
    
    function processChunk() {
        if (searchId !== _relatedSearchId) return; // cancelled
        
        const end = Math.min(idx + RELATED_CHUNK_SIZE, allCharacters.length);
        for (; idx < end; idx++) {
            const targetChar = allCharacters[idx];
            if (targetChar.avatar === sourceAvatar) continue;
            
            // Use full data for heavy field reads when available
            const targetSrc = fullDataMap?.get(targetChar.avatar) || targetChar;
            const result = calculateRelatednessScore(sourceChar, targetSrc, options, sourceCache);
            if (result.score > 0) {
                related.push({
                    char: targetChar,
                    score: result.score,
                    breakdown: result.breakdown,
                    matchReasons: result.matchReasons
                });
            }
        }
        
        if (idx < allCharacters.length) {
            setTimeout(processChunk, 0);
        } else {
            fullDataMap = null;
            related.sort((a, b) => b.score - a.score);
            
            // When full data was unavailable, hydrate top candidates and
            // re-score with content for more accurate results.
            if (!hasFullData && useContent && related.length > 0) {
                const top = related.slice(0, 30);
                Promise.all(top.map(r => hydrateCharacter(r.char))).then(() => {
                    if (searchId !== _relatedSearchId) return;
                    for (const r of top) {
                        const rescore = calculateRelatednessScore(sourceChar, r.char, options, sourceCache);
                        r.score = rescore.score;
                        r.breakdown = rescore.breakdown;
                        r.matchReasons = rescore.matchReasons;
                    }
                    related.sort((a, b) => b.score - a.score);
                    renderRelatedResults(related.slice(0, 20), sourceChar);
                });
            } else {
                renderRelatedResults(related.slice(0, 20), sourceChar);
            }
        }
    }
    
    // Yield one frame so the loading spinner paints first
    setTimeout(processChunk, 0);
}

/**
 * Render the related characters results
 */
function renderRelatedResults(related, sourceChar) {
    const resultsEl = document.getElementById('relatedResults');
    if (!resultsEl) return;
    
    if (related.length === 0) {
        resultsEl.innerHTML = `
            <div class="related-empty">
                <i class="fa-solid fa-users-slash"></i>
                <p>No related characters found</p>
                <span>Try adjusting the filters above or add more tags to this character</span>
            </div>
        `;
        return;
    }
    
    let html = '';
    
    // Group by relationship strength
    // With new scoring: 8 pts/tag, 25 pts/creator, up to 35 pts content
    // Strong: 5+ shared tags (40+), or 3+ tags + creator (49+)
    // Moderate: 2-4 shared tags (16-32), or 1 tag + creator (33)
    // Weak: 1 tag (8), or just content matches
    const strong = related.filter(r => r.score >= 32);  // 4+ shared tags
    const moderate = related.filter(r => r.score >= 16 && r.score < 32);  // 2-3 shared tags
    const weak = related.filter(r => r.score < 16);  // 1 tag or content only
    
    if (strong.length > 0) {
        html += `<div class="related-section"><div class="related-section-header"><i class="fa-solid fa-link"></i> Strongly Related (${strong.length})</div>`;
        html += renderRelatedCards(strong);
        html += '</div>';
    }
    
    if (moderate.length > 0) {
        html += `<div class="related-section"><div class="related-section-header"><i class="fa-solid fa-link-slash" style="opacity: 0.7;"></i> Moderately Related (${moderate.length})</div>`;
        html += renderRelatedCards(moderate);
        html += '</div>';
    }
    
    if (weak.length > 0) {
        html += `<div class="related-section"><div class="related-section-header"><i class="fa-regular fa-circle-dot"></i> Possibly Related (${weak.length})</div>`;
        html += renderRelatedCards(weak);
        html += '</div>';
    }
    
    resultsEl.innerHTML = html;

    // Event delegation for related card clicks
    resultsEl.addEventListener('click', (e) => {
        const card = e.target.closest('.related-card[data-avatar]');
        if (!card) return;
        openRelatedCharacter(card.dataset.avatar);
    });

    // Setup filter change handlers
    setupRelatedFilters(sourceChar);
}

/**
 * Render related character cards
 */
function renderRelatedCards(related) {
    return `<div class="related-cards">${related.map(r => {
        const char = r.char;
        const name = getCharField(char, 'name') || 'Unknown';
        const creator = getCharField(char, 'creator') || '';
        const avatarPath = getCharacterAvatarStThumbUrl(char.avatar);
        
        // Build score breakdown pills - show tag count and rarity info
        const pills = [];
        if (r.breakdown.tags > 0) {
            const tagCount = r.breakdown.sharedTagCount || 0;
            // Check if any rare tags (used by <=5 characters)
            const hasRareTags = r.breakdown.topTags?.some(t => t.count <= 5);
            const tagClass = hasRareTags ? 'tags rare' : 'tags';
            const topTagNames = r.breakdown.topTags?.slice(0, 2).map(t => t.tag).join(', ') || '';
            pills.push(`<span class="related-pill ${tagClass}" title="${tagCount} shared tags: ${topTagNames}"><i class="fa-solid fa-tags"></i> ${tagCount}${hasRareTags ? '★' : ''}</span>`);
        }
        if (r.breakdown.creator > 0) pills.push(`<span class="related-pill creator" title="Same creator"><i class="fa-solid fa-user-pen"></i></span>`);
        if (r.breakdown.content > 0) pills.push(`<span class="related-pill content" title="Similar content"><i class="fa-solid fa-file-lines"></i></span>`);
        
        return `
            <div class="related-card" data-avatar="${escapeHtml(char.avatar)}" title="${escapeHtml(r.matchReasons.join('\n'))}">
                <img class="related-card-avatar" src="${avatarPath}" alt="${escapeHtml(name)}" loading="lazy" 
                     onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><rect fill=%22%23333%22 width=%22100%22 height=%22100%22/><text x=%2250%22 y=%2255%22 text-anchor=%22middle%22 fill=%22%23666%22 font-size=%2240%22>?</text></svg>'">
                <div class="related-card-info">
                    <div class="related-card-name">${escapeHtml(name)}</div>
                    ${creator ? `<div class="related-card-creator">by ${escapeHtml(creator)}</div>` : ''}
                    <div class="related-card-reasons">${r.matchReasons.slice(0, 2).join(' \u2022 ')}</div>
                </div>
                <div class="related-card-score">
                    <div class="related-score-value">${r.score}</div>
                    <div class="related-score-pills">${pills.join('')}</div>
                </div>
            </div>
        `;
    }).join('')}</div>`;
}

/**
 * Setup filter change handlers for related tab
 */
function setupRelatedFilters(sourceChar) {
    const filterIds = ['relatedFilterTags', 'relatedFilterCreator', 'relatedFilterContent'];
    filterIds.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.onchange = () => findRelatedCharacters(sourceChar);
        }
    });
}

/**
 * Open a related character (close current modal, open new one)
 */
function openRelatedCharacter(avatar) {
    const char = allCharacters.find(c => c.avatar === avatar);
    if (char) {
        openModal(char);
    }
}

// ==================== DELETE CHARACTER ====================

async function showDeleteConfirmation(char) {
    const charName = getCharacterName(char);
    const avatar = char.avatar || '';
    const creatorName = char.data?.creator || char.creator || '';
    const uniqueFoldersEnabled = getSetting('uniqueGalleryFolders') || false;
    
    // Show modal immediately with a loading placeholder for gallery info
    const deleteModal = document.createElement('div');
    deleteModal.className = 'confirm-modal cl-modal-drawer';
    deleteModal.id = 'deleteConfirmModal';
    deleteModal.innerHTML = `
        <div class="confirm-modal-content" style="max-width: calc(450px * var(--modal-scale, 1));">
            <div class="confirm-modal-header" style="background: linear-gradient(135deg, rgba(var(--cl-error-bright-rgb), 0.2) 0%, rgba(var(--cl-error-bright-rgb), 0.3) 100%);">
                <h3>
                    <i class="fa-solid fa-triangle-exclamation" style="color: var(--cl-error-bright);"></i>
                    Delete Character
                </h3>
                <button class="close-confirm-btn" id="closeDeleteModal">&times;</button>
            </div>
            <div class="confirm-modal-body" style="text-align: center;">
                <div class="del-confirm-hero">
                    <img class="del-confirm-avatar" src="${getSetting('useGridThumbnails') ? getCharacterAvatarThumbUrl(avatar) : getCharacterAvatarUrl(avatar)}"
                         alt="${escapeHtml(charName)}"
                         onerror="if(!this.dataset.f){this.dataset.f=1;this.src='${getCharacterAvatarUrl(avatar)}';}else{this.src='/img/ai4.png';}">
                    <h4 class="del-confirm-name">${escapeHtml(charName)}</h4>
                    ${creatorName ? `<div class="del-confirm-meta">by ${escapeHtml(creatorName)}</div>` : ''}
                </div>
                <div id="deleteGallerySection">
                    <div style="color: var(--text-secondary); font-size: 0.85rem; padding: 8px 0;">
                        <i class="fa-solid fa-spinner fa-spin"></i> Checking gallery...
                    </div>
                </div>
                <div class="del-confirm-warning">
                    <i class="fa-solid fa-triangle-exclamation"></i>
                    <div>
                        <strong>This cannot be undone</strong>
                        <span>The character card will be permanently removed from your library.</span>
                    </div>
                </div>
                <div id="deleteChatsSection" style="display: none; background: rgba(var(--cl-error-bright-rgb), 0.1); border: 1px solid rgba(var(--cl-error-bright-rgb), 0.3); border-radius: var(--radius-lg); padding: 12px; margin-bottom: 15px;">
                    <label style="display: flex; align-items: center; gap: 10px; cursor: pointer; color: var(--text-primary);">
                        <input type="checkbox" id="deleteChatsCheckbox" style="accent-color: var(--cl-error-bright);">
                        <span id="deleteChatsLabel">Also delete all chat history with this character</span>
                    </label>
                </div>
            </div>
            <div class="confirm-modal-footer">
                <button class="action-btn secondary" id="cancelDeleteBtn">
                    <i class="fa-solid fa-xmark"></i> Cancel
                </button>
                <button class="action-btn danger" id="confirmDeleteBtn">
                    <i class="fa-solid fa-trash"></i> Delete
                </button>
            </div>
        </div>
    `;
    
    document.body.appendChild(deleteModal);
    
    // Event handlers
    const closeBtn = deleteModal.querySelector('#closeDeleteModal');
    const cancelBtn = deleteModal.querySelector('#cancelDeleteBtn');
    const confirmBtn = deleteModal.querySelector('#confirmDeleteBtn');
    
    const closeDeleteModal = () => {
        deleteModal.remove();
    };
    
    closeBtn.addEventListener('click', closeDeleteModal);
    cancelBtn.addEventListener('click', closeDeleteModal);
    deleteModal.addEventListener('click', (e) => {
        if (e.target === deleteModal) closeDeleteModal();
    });
    
    // Chats checkbox only shows for characters that actually have chats
    apiRequest(ENDPOINTS.CHARACTERS_CHATS, 'POST', { avatar_url: avatar, simple: true }).then(async resp => {
        if (!resp.ok) return;
        const chats = await resp.json().catch(() => null);
        if (Array.isArray(chats) && chats.length > 0) {
            const label = deleteModal.querySelector('#deleteChatsLabel');
            if (label) label.textContent = `Also delete all chat history (${chats.length} chat${chats.length === 1 ? '' : 's'})`;
            const section = deleteModal.querySelector('#deleteChatsSection');
            if (section) section.style.display = '';
        }
    }).catch(() => {});

    // gallery_id sits in extensions; hydrate first under lazy loading or the option never shows
    let galleryInfo = { folder: '', files: [], count: 0 };
    let canDeleteGallery = false;

    (async () => {
        if (window.extensionsRecoveryInProgress) {
            try { await hydrateCharacter(char); } catch (_) {}
        }
        const hasUniqueGallery = !!getCharacterGalleryId(char);
        const info = await getCharacterGalleryInfo(char);
        galleryInfo = info;
        const hasImages = info.count > 0;
        canDeleteGallery = uniqueFoldersEnabled && hasImages && hasUniqueGallery;
        
        const section = deleteModal.querySelector('#deleteGallerySection');
        if (!section) return; // Modal was closed before fetch finished
        
        if (canDeleteGallery) {
            section.innerHTML = `
                <div style="background: rgba(var(--cl-warning-bright-rgb), 0.15); border: 1px solid rgba(var(--cl-warning-bright-rgb), 0.4); border-radius: var(--radius-lg); padding: 12px; margin-bottom: 15px;">
                    <div style="display: flex; align-items: center; justify-content: center; gap: 8px; color: var(--cl-warning-bright); margin-bottom: 10px;">
                        <i class="fa-solid fa-images"></i>
                        <strong>Gallery Contains ${info.count} File${info.count !== 1 ? 's' : ''}</strong>
                    </div>
                    <div style="display: flex; flex-direction: column; gap: 8px; text-align: left;">
                        <label style="display: flex; align-items: center; gap: 10px; cursor: pointer; color: var(--text-primary); padding: 8px; border-radius: var(--radius-md); background: rgba(0,0,0,0.2);">
                            <input type="radio" name="galleryAction" value="keep" checked style="accent-color: var(--cl-warning-bright);">
                            <span><strong>Keep gallery files</strong> - Leave in folder</span>
                        </label>
                        <label style="display: flex; align-items: center; gap: 10px; cursor: pointer; color: var(--text-primary); padding: 8px; border-radius: var(--radius-md); background: rgba(0,0,0,0.2);">
                            <input type="radio" name="galleryAction" value="delete" style="accent-color: var(--cl-error-bright);">
                            <span><strong>Delete gallery files</strong> - Remove all images</span>
                        </label>
                    </div>
                </div>
            `;
        } else if (hasImages) {
            section.innerHTML = `
                <div style="background: rgba(var(--cl-warning-bright-rgb), 0.15); border: 1px solid rgba(var(--cl-warning-bright-rgb), 0.4); border-radius: var(--radius-lg); padding: 12px; margin-bottom: 15px;">
                    <div style="display: flex; align-items: center; justify-content: center; gap: 8px; color: var(--cl-warning-bright);">
                        <i class="fa-solid fa-images"></i>
                        <strong>Gallery Contains ${info.count} File${info.count !== 1 ? 's' : ''}</strong>
                    </div>
                    <p style="margin: 8px 0 0 0; color: var(--text-secondary); font-size: 13px;">
                        ${!uniqueFoldersEnabled 
                            ? 'Unique gallery folders feature is disabled. Gallery files will not be deleted.'
                            : 'Gallery folder will remain after deletion.'}
                    </p>
                </div>
            `;
        } else {
            section.innerHTML = '';
        }
    })();

    confirmBtn.addEventListener('click', async () => {
        const deleteChats = deleteModal.querySelector('#deleteChatsCheckbox').checked;
        const galleryAction = deleteModal.querySelector('input[name="galleryAction"]:checked')?.value || 'keep';
        
        confirmBtn.disabled = true;
        confirmBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Deleting...';
        
        // Delete gallery files if requested (only possible for unique galleries)
        if (canDeleteGallery && galleryAction === 'delete') {
            confirmBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Deleting gallery...';
            let deleted = 0;
            let errors = 0;
            
            const safeFolderName = sanitizeFolderName(galleryInfo.folder);
            for (const fileName of galleryInfo.files) {
                try {
                    const deletePath = `/user/images/${safeFolderName}/${fileName}`;
                    const response = await apiRequest(ENDPOINTS.IMAGES_DELETE, 'POST', {
                        path: deletePath
                    });
                    await response.text().catch(() => {});
                    if (response.ok) {
                        deleted++;
                    } else {
                        errors++;
                    }
                } catch (e) {
                    errors++;
                }
            }
            
            if (deleted > 0) {
                debugLog(`[Delete] Deleted ${deleted} gallery image${deleted !== 1 ? 's' : ''}`);
                cleanupThumbCache(safeFolderName);
            }
        }
        
        confirmBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Deleting character...';
        const success = await deleteCharacter(char, deleteChats);
        
        if (success) {
            closeDeleteModal();
            closeModal();
            // Remove from in-memory lists and flag for full refresh on next view entry
            removeCharacterFromList(char.avatar);
            window.ProviderRegistry?.rebuildAllBrowseLookups?.();
            performSearch();
            showToast(`Character "${charName}" deleted`, 'success');
        } else {
            confirmBtn.disabled = false;
            confirmBtn.innerHTML = '<i class="fa-solid fa-trash"></i> Delete';
        }
    });
}

async function deleteCharacter(char, deleteChats = false) {
    try {
        const avatar = char.avatar || '';
        const charName = getCharField(char, 'name') || avatar;

        debugLog('[Delete] Starting deletion for:', charName, 'avatar:', avatar);

        hapticFeedback([20, 30, 20]);
        
        // Delete character via SillyTavern API
        const response = await apiRequest(ENDPOINTS.CHARACTERS_DELETE, 'POST', {
            avatar_url: avatar,
            delete_chats: deleteChats
        }, { cache: 'no-cache' });
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error('[Delete] API Error:', response.status, errorText);
            showToast('Failed to delete character', 'error');
            return false;
        }
        
        debugLog('[Delete] API call successful, cleaning up...');


        // Evict any queued/active background media download
        if (avatar) window.mediaDownloadQueueOnCharDeleted?.(avatar);

        // Clean up per-character name preference
        if (avatar) {
            const prefs = gallerySettings.namePreferences;
            if (prefs && prefs[avatar]) {
                delete prefs[avatar];
                setSetting('namePreferences', prefs);
            }
        }

        // Evict from the per-avatar caches (ST lazy loading restore path)
        if (avatar) _extensionsCache.delete(avatar);
        if (avatar) _tokenEstimateCache.delete(avatar);
        
        // Trigger character refresh in the ST window. Best-effort with a timeout:
        // on mobile the opener tab may be suspended and cross-window awaits hang.
        const refreshOpener = async () => {
            try {
                const host = getHostWindow();
                if (host) {
                    // Method 1: Use SillyTavern context API if available
                    if (host.SillyTavern && host.SillyTavern.getContext) {
                        const context = host.SillyTavern.getContext();
                        if (context && typeof context.getCharacters === 'function') {
                            debugLog('[Delete] Triggering getCharacters() in main window...');
                            await context.getCharacters();
                        }
                    }
                    
                    // Method 2: Try to emit the CHARACTER_DELETED event directly
                    if (host.eventSource && host.event_types) {
                        debugLog('[Delete] Emitting CHARACTER_DELETED event...');
                        const charIndex = host.characters?.findIndex(c => c.avatar === avatar);
                        if (charIndex !== undefined && charIndex >= 0) {
                            await host.eventSource.emit(
                                host.event_types.CHARACTER_DELETED, 
                                { id: charIndex, character: char }
                            );
                        }
                    }
                }
            } catch (e) {
                console.warn('[Delete] Could not refresh main window (non-fatal):', e);
            }
        };
        const openerTimeout = new Promise(resolve => setTimeout(resolve, 3000));
        await Promise.race([refreshOpener(), openerTimeout]);
        
        debugLog('[Delete] Character deleted successfully');
        return true;
        
    } catch (error) {
        console.error('[Delete] Error:', error);
        showToast('Error deleting character', 'error');
        return false;
    }
}

// Collect current edit values
function collectEditValues() {
    return {
        name: document.getElementById('editName').value,
        description: document.getElementById('editDescription').value,
        first_mes: document.getElementById('editFirstMes').value,
        creator: document.getElementById('editCreator').value,
        character_version: document.getElementById('editVersion').value,
        tagline: document.getElementById('editTagline').value,
        listingName: document.getElementById('editListingName').value,
        tagsArray: [..._editTagsArray],
        personality: document.getElementById('editPersonality').value,
        scenario: document.getElementById('editScenario').value,
        mes_example: document.getElementById('editMesExample').value,
        system_prompt: document.getElementById('editSystemPrompt').value,
        post_history_instructions: document.getElementById('editPostHistoryInstructions').value,
        creator_notes: document.getElementById('editCreatorNotes').value,
        alternate_greetings: getAltGreetingsFromEditor(),
        character_book: getCharacterBookFromEditor()
    };
}

// Generate diff between original and new values
function generateChangesDiff(original, current) {
    const changes = [];
    const fieldLabels = {
        name: 'Character Name',
        description: 'Description',
        first_mes: 'First Message',
        creator: 'Creator',
        character_version: 'Version',
        tagline: 'Tagline',
        listingName: 'Listing Name',
        tagsArray: 'Tags',
        personality: 'Personality',
        scenario: 'Scenario',
        mes_example: 'Example Dialogue',
        system_prompt: 'System Prompt',
        post_history_instructions: 'Post-History Instructions',
        creator_notes: "Creator's Notes",
        alternate_greetings: 'Alternate Greetings',
        character_book: 'Embedded Lorebook'
    };
    
    // Helper to normalize string values for comparison
    // Handles line ending differences (\r\n vs \n) and trims whitespace
    const normalizeString = (val) => String(val || '').replace(/\r\n/g, '\n').trim();
    
    // Helper to normalize arrays of strings for comparison
    const normalizeStringArray = (arr) => {
        if (!Array.isArray(arr)) return [];
        return arr.map(s => String(s || '').replace(/\r\n/g, '\n').trim()).filter(s => s.length > 0);
    };
    
    for (const key of Object.keys(fieldLabels)) {
        let oldVal = original[key];
        let newVal = current[key];
        
        // Handle tags array comparison
        if (key === 'tagsArray') {
            const oldNorm = normalizeStringArray(oldVal || []);
            const newNorm = normalizeStringArray(newVal || []);
            // Sort for order-insensitive comparison
            const oldSorted = [...oldNorm].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
            const newSorted = [...newNorm].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
            if (JSON.stringify(oldSorted) !== JSON.stringify(newSorted)) {
                const added = newNorm.filter(t => !oldNorm.some(o => o.localeCompare(t, undefined, { sensitivity: 'base' }) === 0));
                const removed = oldNorm.filter(t => !newNorm.some(n => n.localeCompare(t, undefined, { sensitivity: 'base' }) === 0));
                const parts = [];
                if (added.length) parts.push(`Added: ${added.join(', ')}`);
                if (removed.length) parts.push(`Removed: ${removed.join(', ')}`);
                changes.push({
                    field: fieldLabels[key],
                    old: oldNorm.join(', ') || '(none)',
                    new: newNorm.join(', ') || '(none)',
                    detail: parts.join(' | ')
                });
            }
            continue;
        }
        
        // Handle alternate greetings array comparison
        if (key === 'alternate_greetings') {
            const oldNorm = normalizeStringArray(oldVal);
            const newNorm = normalizeStringArray(newVal);
            const oldStr = JSON.stringify(oldNorm);
            const newStr = JSON.stringify(newNorm);
            if (oldStr !== newStr) {
                changes.push({
                    field: fieldLabels[key],
                    old: oldNorm.map((g, i) => `#${i+1}: ${g}`).join('\n') || '(none)',
                    new: newNorm.map((g, i) => `#${i+1}: ${g}`).join('\n') || '(none)'
                });
            }
            continue;
        }
        
        // Handle character_book comparison - compare only the meaningful fields
        if (key === 'character_book') {
            const normalizeBook = (book) => {
                if (!book || !book.entries || book.entries.length === 0) return null;
                // Only compare the fields that matter for equality
                return book.entries.map(e => ({
                    keys: (e.keys || []).map(k => String(k).replace(/\r\n/g, '\n').trim()).filter(k => k),
                    secondary_keys: (e.secondary_keys || []).map(k => String(k).replace(/\r\n/g, '\n').trim()).filter(k => k),
                    content: String(e.content || '').replace(/\r\n/g, '\n').trim(),
                    comment: String(e.comment || e.name || '').replace(/\r\n/g, '\n').trim(),
                    enabled: e.enabled !== false,
                    selective: e.selective || false,
                    constant: e.constant || false,
                    order: e.order ?? e.insertion_order ?? 0,
                    priority: e.priority ?? 10
                }));
            };
            
            const oldNorm = normalizeBook(oldVal);
            const newNorm = normalizeBook(newVal);
            const oldStr = JSON.stringify(oldNorm);
            const newStr = JSON.stringify(newNorm);
            
            if (oldStr !== newStr) {
                const oldCount = oldNorm?.length || 0;
                const newCount = newNorm?.length || 0;
                const oldSummary = oldCount > 0 
                    ? `${oldCount} entries: ${oldNorm.slice(0, 3).map(e => e.comment || e.keys?.[0] || 'unnamed').join(', ')}${oldCount > 3 ? '...' : ''}`
                    : '(none)';
                const newSummary = newCount > 0 
                    ? `${newCount} entries: ${newNorm.slice(0, 3).map(e => e.comment || e.keys?.[0] || 'unnamed').join(', ')}${newCount > 3 ? '...' : ''}`
                    : '(none)';
                changes.push({
                    field: fieldLabels[key],
                    old: oldSummary,
                    new: newSummary
                });
            }
            continue;
        }
        
        // String field comparison - normalize both values
        const oldNorm = normalizeString(oldVal);
        const newNorm = normalizeString(newVal);
        
        if (oldNorm !== newNorm) {
            // Get smart excerpts showing context around the changes with highlighting
            const excerpts = getChangeExcerpts(oldNorm, newNorm, 150);
            changes.push({
                field: fieldLabels[key],
                old: excerpts.old || '(empty)',
                new: excerpts.new || '(empty)',
                oldHtml: excerpts.oldHtml,
                newHtml: excerpts.newHtml
            });
        }
    }
    
    return changes;
}

function findFirstDifference(str1, str2) {
    const minLen = Math.min(str1.length, str2.length);
    for (let i = 0; i < minLen; i++) {
        if (str1[i] !== str2[i]) return i;
    }
    // If one is longer, the difference starts at the end of the shorter one
    if (str1.length !== str2.length) return minLen;
    return -1; // Identical
}

function findLastDifference(str1, str2) {
    let i = str1.length - 1;
    let j = str2.length - 1;
    
    while (i >= 0 && j >= 0) {
        if (str1[i] !== str2[j]) {
            return { pos1: i, pos2: j };
        }
        i--;
        j--;
    }
    
    // One string is a prefix of the other
    if (i >= 0) return { pos1: i, pos2: -1 };
    if (j >= 0) return { pos1: -1, pos2: j };
    return { pos1: -1, pos2: -1 }; // Identical
}

/**
 * Get excerpts from old and new strings with highlighted changes
 * @param {string} oldStr - Original string
 * @param {string} newStr - New string  
 * @param {number} contextLength - How many characters to show around changes
 * @returns {{old: string, new: string, oldHtml: string, newHtml: string}} Excerpts with highlighting
 */
function getChangeExcerpts(oldStr, newStr, contextLength = 150) {
    if (!oldStr && !newStr) return { old: '(empty)', new: '(empty)', oldHtml: '(empty)', newHtml: '(empty)' };
    if (!oldStr) {
        const truncated = truncateText(newStr, contextLength);
        return { 
            old: '(empty)', 
            new: truncated,
            oldHtml: '<span class="diff-empty">(empty)</span>',
            newHtml: `<span class="diff-added">${escapeHtml(truncated)}</span>`
        };
    }
    if (!newStr) {
        const truncated = truncateText(oldStr, contextLength);
        return { 
            old: truncated, 
            new: '(empty)',
            oldHtml: `<span class="diff-removed">${escapeHtml(truncated)}</span>`,
            newHtml: '<span class="diff-empty">(empty)</span>'
        };
    }
    
    // Find where differences start and end
    const diffStart = findFirstDifference(oldStr, newStr);
    if (diffStart === -1) {
        // Identical - shouldn't happen but handle gracefully
        return { old: oldStr, new: newStr, oldHtml: escapeHtml(oldStr), newHtml: escapeHtml(newStr) };
    }
    
    const diffEnd = findLastDifference(oldStr, newStr);
    
    // Calculate the changed regions
    const oldChangeEnd = diffEnd.pos1 + 1;
    const newChangeEnd = diffEnd.pos2 + 1;
    
    // For short strings, show them entirely with highlighting
    if (oldStr.length <= contextLength && newStr.length <= contextLength) {
        const oldHtml = buildHighlightedString(oldStr, diffStart, oldChangeEnd, 'diff-removed');
        const newHtml = buildHighlightedString(newStr, diffStart, newChangeEnd, 'diff-added');
        return { old: oldStr, new: newStr, oldHtml, newHtml };
    }
    
    // For longer strings, extract context around the change
    const contextBefore = 30;
    const contextAfter = contextLength - contextBefore;
    
    const startPos = Math.max(0, diffStart - contextBefore);
    
    const oldEndPos = Math.min(oldStr.length, Math.max(oldChangeEnd, diffStart) + contextAfter);
    const newEndPos = Math.min(newStr.length, Math.max(newChangeEnd, diffStart) + contextAfter);
    
    // Extract and highlight
    const oldExcerpt = oldStr.substring(startPos, oldEndPos);
    const newExcerpt = newStr.substring(startPos, newEndPos);
    
    // Adjust highlight positions for the excerpt
    const highlightStart = diffStart - startPos;
    const oldHighlightEnd = oldChangeEnd - startPos;
    const newHighlightEnd = newChangeEnd - startPos;
    
    let oldHtml = buildHighlightedString(oldExcerpt, highlightStart, oldHighlightEnd, 'diff-removed');
    let newHtml = buildHighlightedString(newExcerpt, highlightStart, newHighlightEnd, 'diff-added');
    
    // Add ellipsis markers
    const oldPrefix = startPos > 0 ? '<span class="diff-ellipsis">...</span>' : '';
    const oldSuffix = oldEndPos < oldStr.length ? '<span class="diff-ellipsis">...</span>' : '';
    const newPrefix = startPos > 0 ? '<span class="diff-ellipsis">...</span>' : '';
    const newSuffix = newEndPos < newStr.length ? '<span class="diff-ellipsis">...</span>' : '';
    
    return {
        old: (startPos > 0 ? '...' : '') + oldExcerpt + (oldEndPos < oldStr.length ? '...' : ''),
        new: (startPos > 0 ? '...' : '') + newExcerpt + (newEndPos < newStr.length ? '...' : ''),
        oldHtml: oldPrefix + oldHtml + oldSuffix,
        newHtml: newPrefix + newHtml + newSuffix
    };
}

/**
 * Build a string with a highlighted section
 */
function buildHighlightedString(str, highlightStart, highlightEnd, className) {
    if (highlightStart < 0) highlightStart = 0;
    if (highlightEnd > str.length) highlightEnd = str.length;
    if (highlightStart >= highlightEnd) return escapeHtml(str);
    
    const before = str.substring(0, highlightStart);
    const highlighted = str.substring(highlightStart, highlightEnd);
    const after = str.substring(highlightEnd);
    
    return escapeHtml(before) + 
           `<span class="${className}">${escapeHtml(highlighted)}</span>` + 
           escapeHtml(after);
}

function truncateText(text, maxLength) {
    if (!text) return '(empty)';
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength) + '...';
}

// Show confirmation modal with diff
function showSaveConfirmation() {
    if (!activeChar) return;
    
    const currentValues = collectEditValues();
    const changes = generateChangesDiff(originalValues, currentValues);
    const hasAvatarChange = !!pendingAvatarFile;
    
    if (changes.length === 0 && !hasAvatarChange) {
        showToast("No changes detected", "info");
        return;
    }

    // Tagline and listing name as leaf writes so the namespace's sibling fields (id, full_path, linkedAt) survive the spread.
    const activeNs = window.ProviderRegistry?.getActiveTaglineNamespace?.(activeChar) ?? 'cl';
    pendingUpdates = {
        name: currentValues.name,
        description: currentValues.description,
        first_mes: currentValues.first_mes,
        personality: currentValues.personality,
        scenario: currentValues.scenario,
        mes_example: currentValues.mes_example,
        system_prompt: currentValues.system_prompt,
        post_history_instructions: currentValues.post_history_instructions,
        creator_notes: currentValues.creator_notes,
        creator: currentValues.creator,
        character_version: currentValues.character_version,
        tags: currentValues.tagsArray,
        alternate_greetings: currentValues.alternate_greetings,
        character_book: currentValues.character_book,
        [`extensions.${activeNs}.tagline`]: currentValues.tagline ?? '',
        [`extensions.${activeNs}.pageName`]: currentValues.listingName ?? '',
    };
    
    // Build diff HTML
    const diffContainer = document.getElementById('changesDiff');
    const diffEntries = [...changes];
    if (hasAvatarChange) {
        diffEntries.unshift({
            field: 'Card Image',
            oldHtml: `<img src="${escapeHtml(getCharacterAvatarUrl(activeChar.avatar))}" alt="Current image" style="max-width: 100px; max-height: 150px; border-radius: var(--radius-md);">`,
            newHtml: `<img src="${escapeHtml(pendingAvatarPreviewUrl || '')}" alt="New image" style="max-width: 100px; max-height: 150px; border-radius: var(--radius-md);">`,
        });
    }
    diffContainer.innerHTML = diffEntries.map(change => `
        <div class="diff-item">
            <div class="diff-item-label">${escapeHtml(change.field)}</div>
            <div class="diff-old">${change.oldHtml || escapeHtml(change.old)}</div>
            <div class="diff-arrow">↓</div>
            <div class="diff-new">${change.newHtml || escapeHtml(change.new)}</div>
        </div>
    `).join('');
    
    // Show modal
    document.getElementById('confirmSaveModal').classList.remove('hidden');
}

// Actually perform the save
async function performSave() {
    if (!activeChar || !pendingUpdates) return;

    if (activeChar._slim) {
        await hydrateCharacter(activeChar);
        if (activeChar._slim) { showToast('Card data still loading, please try again', 'warning'); return; }
    }

    // Re-entrancy guard: a double-tap Confirm Save must not run two concurrent snapshot+write+upload passes.
    if (_saveInProgress) return;
    _saveInProgress = true;

    const hasAvatarChange = !!pendingAvatarFile;

    // Auto-snapshot before edit (non-blocking - don't let snapshot failure block the save).
    // When the avatar is also being replaced, embed the OLD image bytes in the snapshot
    // so the version history can show/restore the original card image even after overwrite.

    // Capture old name before the write so the gallery folder rename has the pre-write value.
    const oldName = originalValues.name;
    const newName = pendingUpdates.name;
    const nameChanged = oldName && newName && oldName !== newName;
    const galleryId = getCharacterGalleryId(activeChar);

    try {
        // writeCardFields does the card write; performSave keeps the non-generic orchestration (avatar upload, gallery rename, date bump, refresh, notify).
        const writeResult = await writeCardFields(activeChar, pendingUpdates);

        if (writeResult.ok) {
            // Upload replacement avatar (after fields succeeded). edit-avatar reads existing
            // card JSON from the PNG and re-embeds it into the new image, so all fields,
            // extensions, gallery_id, version_uid, chats, and the filename are preserved.
            if (hasAvatarChange) {
                try {
                    const formData = new FormData();
                    // ST's edit-avatar re-encodes as PNG and re-embeds existing card JSON,
                    // so we always send with .png filename regardless of source format.
                    formData.append('avatar', new File([pendingAvatarFile], 'avatar.png', { type: pendingAvatarFile.type || 'image/png' }));
                    formData.append('avatar_url', activeChar.avatar);
                    const csrfToken = getCSRFToken();
                    const avatarResp = await fetch('/api/characters/edit-avatar', {
                        method: 'POST',
                        headers: { 'X-CSRF-Token': csrfToken },
                        body: formData,
                    });
                    if (!avatarResp.ok) {
                        const err = await avatarResp.text().catch(() => '');
                        throw new Error(`Avatar upload failed (${avatarResp.status}): ${err}`);
                    }
                } catch (avatarErr) {
                    console.error('[Edit] Avatar upload failed:', avatarErr);
                    showToast(`Card saved, but image update failed: ${avatarErr.message}`, 'warning');
                    // Don't bail; the field-level save already succeeded.
                }
            }

            showToast("Character saved successfully!", "success");

            // Close confirmation immediately so it doesn't wait on folder rename / grid refresh
            document.getElementById('confirmSaveModal').classList.add('hidden');

            // Handle gallery folder rename if name changed and character has unique gallery folder
            if (nameChanged && galleryId && getSetting('uniqueGalleryFolders')) {
                await handleGalleryFolderRename(activeChar, oldName, newName, galleryId);
            }

            // Re-point activeChar to the canonical array entry in case writeCardFields received a different ref.
            const charIndex = allCharacters.findIndex(c => c.avatar === activeChar.avatar);
            if (charIndex !== -1 && allCharacters[charIndex] !== activeChar) {
                activeChar = allCharacters[charIndex];
            }

            // Update last modified timestamp locally so sort by "Last Modified" reflects the change immediately.
            const nowMs = Date.now();
            activeChar.date_added = nowMs;
            if (activeChar._meta) activeChar._meta.date_added = nowMs;
            if (charIndex !== -1) {
                allCharacters[charIndex].date_added = nowMs;
                if (allCharacters[charIndex]._meta) allCharacters[charIndex]._meta.date_added = nowMs;
            }

            // Update original values to reflect saved state
            originalValues = collectEditValues();

            // Refresh the modal display to show saved changes
            refreshModalDisplay();

            // Cache-bust avatar URLs after image swap so the modal hero and grid cards
            // all fetch the new PNG without needing F5.
            if (hasAvatarChange) {
                bumpAvatarCacheBust(activeChar.avatar);
                const newUrl = getCharacterAvatarUrl(activeChar.avatar);
                const heroImg = document.getElementById('modalImage');
                if (heroImg) heroImg.src = newUrl;
                const headerAvatar = document.querySelector('#charModal .mobile-header-avatar');
                if (headerAvatar) headerAvatar.src = getCharacterAvatarStThumbUrl(activeChar.avatar);
                // Repaint the edited card's grid image now, in case the re-render below reuses the node.
                const gridUrl = gridUsesThumbnails() ? getCharacterAvatarThumbUrl(activeChar.avatar) : getCharacterAvatarUrl(activeChar.avatar);
                const cardImg = findCardElement(activeChar.avatar)?.querySelector('.card-image');
                if (cardImg) cardImg.src = gridUrl;
                clearPendingAvatar();
            }
            
            // Listing name + tagline feed the search keys (CL-side state the card write doesnt touch), so recompute them before the grid re-renders below.
            for (const c of [activeChar, charIndex !== -1 ? allCharacters[charIndex] : null].filter(Boolean)) {
                const ln = getListingNameFromExtensions(c);
                c._lowerListingName = ln ? ln.toLowerCase() : '';
                c._lowerTagline = getDisplayTagline(c).toLowerCase();
            }

            // Force re-render the grid to show updated data immediately
            performSearch();
            
            // Lock editing and clean up
            setEditLock(true);
            pendingUpdates = null;

            // Tell ST to re-read the character so open chats pick up the edits
            // without requiring a tab refresh. Best-effort, non-blocking.
            notifySTCharacterEdited(activeChar.avatar);

            // Fetch from server for full sync (in background)
            // forceRefresh avoids stale opener data overwriting recent changes
            fetchCharacters(true);
        } else {
            const err = writeResult.response ? await writeResult.response.text().catch(() => '') : '';
            showToast("Error saving: " + (err || 'unknown'), "error");
        }
    } catch (e) {
        showToast("Network error saving character: " + e.message, "error");
    } finally {
        _saveInProgress = false;
    }
}

// Heavy Details-tab fields: description, first message, alt greetings, embedded lorebook,
// plus the async media-localization repaint (gen-guarded so a stale pass from a previous
// open never lands). Shared by openModal's post-hydrate paint and the post-save refresh.
function paintModalHeavyContent(char, creatorNotes, gen) {
    // Description/First Message
    const desc = char.description || (char.data ? char.data.description : "") || "";
    const firstMes = char.first_mes || (char.data ? char.data.first_mes : "") || "";

    // Store raw content for fullscreen expand feature
    window.currentFirstMesContent = firstMes || null;

    // Details tab uses rich HTML rendering (initially without localization for instant display)
    document.getElementById('modalDescription').innerHTML = formatRichText(desc, char.name);
    document.getElementById('modalFirstMes').innerHTML = formatRichText(firstMes, char.name);

    // Alternate Greetings
    const altGreetings = char.alternate_greetings || (char.data ? char.data.alternate_greetings : []) || [];
    const altBox = document.getElementById('modalAltGreetingsBox');

    // Store raw content for fullscreen expand feature
    window.currentAltGreetingsContent = (altGreetings && altGreetings.length > 0) ? altGreetings : null;

    if (altBox) {
        if (altGreetings && altGreetings.length > 0) {
            document.getElementById('altGreetingsCount').innerText = altGreetings.length;
            const listHTML = altGreetings.map((g, i) =>
                `<div style="margin-bottom: 15px; padding-bottom: 10px; border-bottom: 1px dashed rgba(255,255,255,0.1);"><strong style="color:var(--accent);">#${i+1}:</strong> <span>${formatRichText((g || '').trim(), char.name)}</span></div>`
            ).join('');
            document.getElementById('modalAltGreetings').innerHTML = listHTML;
            altBox.style.display = 'block';
        } else {
            altBox.style.display = 'none';
        }
    }

    initContentExpandHandlers();

    // Apply media localization asynchronously (if enabled)
    // This updates the already-rendered content with localized URLs
    applyMediaLocalizationToModal(char, desc, firstMes, altGreetings, creatorNotes, gen);

    // Embedded Lorebook
    const characterBook = char.character_book || (char.data ? char.data.character_book : null);
    const lorebookBox = document.getElementById('modalLorebookBox');

    if (lorebookBox) {
        if (characterBook && characterBook.entries && characterBook.entries.length > 0) {
            document.getElementById('lorebookEntryCount').innerText = characterBook.entries.length;
            const lorebookHTML = renderLorebookEntriesHtml(characterBook.entries)
            document.getElementById('modalLorebookContent').innerHTML = lorebookHTML;
            lorebookBox.style.display = 'block';
        } else {
            lorebookBox.style.display = 'none';
        }
    }
}

/**
 * Refresh the modal display with current activeChar data
 * Called after save to update the Details tab without re-opening the modal
 */
function refreshModalDisplay() {
    if (!activeChar) return;
    
    const char = activeChar;
    
    // Update modal title
    document.getElementById('modalTitle').innerText = getCharacterName(char);
    
    // Update author
    const author = char.creator || (char.data ? char.data.creator : "") || "";
    const authContainer = document.getElementById('modalAuthorContainer');
    const authorEl = document.getElementById('modalAuthor');
    if (author && authContainer) {
        authorEl.innerText = author;
        authContainer.style.display = 'inline';
    } else if (authContainer) {
        authContainer.style.display = 'none';
    }
    
    // Update Creator Notes
    const creatorNotes = char.creator_notes || (char.data ? char.data.creator_notes : "") || "";
    const notesBox = document.getElementById('modalCreatorNotesBox');
    const notesContainer = document.getElementById('modalCreatorNotes');
    if (creatorNotes && notesBox && notesContainer) {
        notesBox.style.display = 'block';
        const detailsEl = document.getElementById('creatorNotesDetails');
        if (detailsEl) detailsEl.open = !!getSetting('expandCreatorNotes');
        // Store raw content for fullscreen expand feature
        window.currentCreatorNotesContent = creatorNotes;
        renderCreatorNotesSecure(creatorNotes, char.name, notesContainer);
        initCreatorNotesHandlers();
        // Show/hide expand button based on content length
        const expandBtn = document.getElementById('creatorNotesExpandBtn');
        if (expandBtn) {
            const lineCount = (creatorNotes.match(/\n/g) || []).length + 1;
            const charCount = creatorNotes.length;
            const showExpand = lineCount >= CreatorNotesConfig.MIN_LINES_FOR_EXPAND || 
                               charCount >= CreatorNotesConfig.MIN_CHARS_FOR_EXPAND;
            expandBtn.style.display = showExpand ? 'flex' : 'none';
        }
    } else if (notesBox) {
        notesBox.style.display = 'none';
        window.currentCreatorNotesContent = null;
    }

    // Tagline (from active namespace: provider id when linked, 'cl' when unlinked).
    wireProviderTaglineExpand();
    renderProviderTaglineRow(char);
    
    paintModalHeavyContent(char, creatorNotes, _modalOpenGen);

    // Update tags in sidebar
    renderSidebarTags(getTags(char), !isEditLocked);
}

// Legacy saveCharacter now shows confirmation
async function saveCharacter() {
    showSaveConfirmation();
}

// Edit Lock Functions

// Reset to 'auto' first so scrollHeight reflects current content; without it the field grows but never shrinks.
function autoGrowEditField(ta) {
    ta.style.height = 'auto';
    ta.style.height = (ta.scrollHeight + 4) + 'px';
}

function detachEditFieldsAutoGrow() {
    if (!editFieldsAutoGrowHandler) return;
    document.getElementById('pane-edit')?.removeEventListener('input', editFieldsAutoGrowHandler);
    editFieldsAutoGrowHandler = null;
}

function toggleEditFieldsExpand() {
    const btn = document.getElementById('editFieldsToggleBtn');
    const icon = btn?.querySelector('i');
    if (!btn || !icon) return;
    const container = document.getElementById('pane-edit');
    const textareas = document.querySelectorAll('#pane-edit textarea.glass-input');
    if (btn.classList.contains('active')) {
        textareas.forEach(ta => { ta.style.height = ''; });
        detachEditFieldsAutoGrow();
        btn.classList.remove('active');
        icon.className = 'fa-solid fa-up-right-and-down-left-from-center';
        btn.title = 'Expand all fields to fit content';
    } else {
        // Initial pass only expands fields that already overflow, so empty textareas keep their min-height.
        textareas.forEach(ta => {
            if (ta.scrollHeight > ta.clientHeight) autoGrowEditField(ta);
        });
        // Delegated listener on #pane-edit catches input from any descendant textarea, so dynamically-added alt-greetings auto-grow too.
        if (container && !editFieldsAutoGrowHandler) {
            editFieldsAutoGrowHandler = (e) => {
                const ta = e.target;
                if (ta?.matches?.('#pane-edit textarea.glass-input')) {
                    autoGrowEditField(ta);
                }
            };
            container.addEventListener('input', editFieldsAutoGrowHandler);
        }
        btn.classList.add('active');
        icon.className = 'fa-solid fa-down-left-and-up-right-to-center';
        btn.title = 'Contract fields to default size';
    }
}

function setEditLock(locked) {
    isEditLocked = locked;
    
    const lockHeader = document.querySelector('.edit-lock-header');
    const lockStatus = document.getElementById('editLockStatus');
    const toggleBtn = document.getElementById('toggleEditLockBtn');
    const saveBtn = document.getElementById('saveEditBtn');
    const cancelBtn = document.getElementById('cancelEditBtn');
    const addAltGreetingBtn = document.getElementById('addAltGreetingBtn');
    const tagInputWrapper = document.getElementById('tagInputWrapper');
    const tagsContainer = document.getElementById('modalTags');
    const portraitContainer = document.querySelector('.char-portrait-container');
    const portraitOverlay = document.getElementById('portraitEditOverlay');
    
    // All editable inputs in the edit pane
    const editInputs = document.querySelectorAll('#pane-edit .glass-input');
    const removeGreetingBtns = document.querySelectorAll('.remove-alt-greeting-btn');
    const expandFieldBtns = document.querySelectorAll('.expand-field-btn');
    const sectionExpandBtns = document.querySelectorAll('.section-expand-btn');
    
    if (locked) {
        lockHeader?.classList.remove('unlocked');
        if (lockStatus) {
            lockStatus.innerHTML = '<i class="fa-solid fa-lock"></i><span>Fields are locked. Click unlock to edit.</span>';
        }
        if (toggleBtn) {
            toggleBtn.innerHTML = '<i class="fa-solid fa-lock-open"></i> <span class="btn-label">Unlock Editing</span>';
        }
        
        editInputs.forEach(input => {
            input.classList.add('locked');
            input.readOnly = true;
            if (input.tagName === 'SELECT') input.disabled = true;
        });
        
        if (saveBtn) saveBtn.disabled = true;
        if (cancelBtn) cancelBtn.style.display = 'none';
        if (addAltGreetingBtn) addAltGreetingBtn.classList.add('hidden');
        removeGreetingBtns.forEach(btn => btn.classList.add('hidden'));
        
        // Hide expand buttons when locked
        expandFieldBtns.forEach(btn => btn.classList.add('hidden'));
        sectionExpandBtns.forEach(btn => btn.classList.add('hidden'));

        // Hide portrait click-to-change overlay
        if (portraitContainer) portraitContainer.classList.remove('editing-unlocked');
        if (portraitOverlay) portraitOverlay.classList.add('hidden');
        modal?.classList.remove('editing-unlocked');
        
        // Reset field expand toggle
        const fieldsToggle = document.getElementById('editFieldsToggleBtn');
        if (fieldsToggle?.classList.contains('active')) {
            document.querySelectorAll('#pane-edit textarea.glass-input').forEach(ta => { ta.style.height = ''; });
            detachEditFieldsAutoGrow();
            fieldsToggle.classList.remove('active');
            const icon = fieldsToggle.querySelector('i');
            if (icon) icon.className = 'fa-solid fa-up-right-and-down-left-from-center';
            fieldsToggle.title = 'Expand all fields to fit content';
        }
        
        // Lorebook editor
        const addLorebookEntryBtn = document.getElementById('addLorebookEntryBtn');
        if (addLorebookEntryBtn) addLorebookEntryBtn.disabled = true;
        document.querySelectorAll('.lorebook-entry-edit input, .lorebook-entry-edit textarea').forEach(input => {
            input.classList.add('locked');
            input.readOnly = true;
            if (input.type === 'checkbox') input.disabled = true;
        });
        document.querySelectorAll('.lorebook-entry-delete, .lorebook-entry-toggle').forEach(btn => {
            btn.style.pointerEvents = 'none';
            btn.style.opacity = '0.5';
        });

        // Hide tag input and show non-editable tags
        if (tagInputWrapper) tagInputWrapper.classList.add('hidden');
        if (tagsContainer) tagsContainer.classList.remove('editable');
        if (activeChar) renderSidebarTags(getCurrentTagsArray(), false);
    } else {
        lockHeader?.classList.add('unlocked');
        if (lockStatus) {
            lockStatus.innerHTML = '<i class="fa-solid fa-unlock"></i><span>Editing enabled. Remember to save your changes!</span>';
        }
        if (toggleBtn) {
            toggleBtn.innerHTML = '<i class="fa-solid fa-lock"></i> <span class="btn-label">Lock Editing</span>';
        }
        
        editInputs.forEach(input => {
            input.classList.remove('locked');
            input.readOnly = false;
            if (input.tagName === 'SELECT') input.disabled = false;
        });
        
        if (saveBtn) saveBtn.disabled = false;
        if (cancelBtn) cancelBtn.style.display = '';
        if (addAltGreetingBtn) addAltGreetingBtn.classList.remove('hidden');
        removeGreetingBtns.forEach(btn => btn.classList.remove('hidden'));
        
        // Show expand buttons when unlocked
        expandFieldBtns.forEach(btn => btn.classList.remove('hidden'));
        sectionExpandBtns.forEach(btn => btn.classList.remove('hidden'));

        // Show portrait click-to-change overlay
        if (portraitContainer) portraitContainer.classList.add('editing-unlocked');
        if (portraitOverlay) portraitOverlay.classList.remove('hidden');
        modal?.classList.add('editing-unlocked');
        
        // Lorebook editor
        const addLorebookEntryBtn = document.getElementById('addLorebookEntryBtn');
        if (addLorebookEntryBtn) addLorebookEntryBtn.disabled = false;
        document.querySelectorAll('.lorebook-entry-edit input, .lorebook-entry-edit textarea').forEach(input => {
            input.classList.remove('locked');
            input.readOnly = false;
            if (input.type === 'checkbox') input.disabled = false;
        });
        document.querySelectorAll('.lorebook-entry-delete, .lorebook-entry-toggle').forEach(btn => {
            btn.style.pointerEvents = '';
            btn.style.opacity = '';
        });

        // Show tag input and make tags editable
        if (tagInputWrapper) tagInputWrapper.classList.remove('hidden');
        if (tagsContainer) tagsContainer.classList.add('editable');
        renderSidebarTags(getCurrentTagsArray(), true);
    }
}

function cancelEditing() {
    if (!activeChar) return;
    
    // Restore original values (text fields use originalValues which are already normalized)
    document.getElementById('editName').value = originalValues.name || '';
    document.getElementById('editDescription').value = originalValues.description || '';
    document.getElementById('editFirstMes').value = originalValues.first_mes || '';
    document.getElementById('editCreator').value = originalValues.creator || '';
    document.getElementById('editVersion').value = originalValues.character_version || '';
    document.getElementById('editTagline').value = originalValues.tagline || '';
    document.getElementById('editListingName').value = originalValues.listingName || '';
    document.getElementById('editPersonality').value = originalValues.personality || '';
    document.getElementById('editScenario').value = originalValues.scenario || '';
    document.getElementById('editMesExample').value = originalValues.mes_example || '';
    document.getElementById('editSystemPrompt').value = originalValues.system_prompt || '';
    document.getElementById('editPostHistoryInstructions').value = originalValues.post_history_instructions || '';
    document.getElementById('editCreatorNotes').value = originalValues.creator_notes || '';
    
    // Restore tag array from original values
    _editTagsArray = [...(originalValues.tagsArray || [])];
    
    // Restore alternate greetings from raw data
    populateAltGreetingsEditor(originalRawData.altGreetings || []);
    
    // Restore lorebook from raw data
    populateLorebookEditor(originalRawData.characterBook);

    // Discard any pending avatar replacement
    clearPendingAvatar();
    
    // Re-lock (this also re-renders sidebar tags via setEditLock)
    setEditLock(true);
    showToast("Changes discarded", "info");
}

