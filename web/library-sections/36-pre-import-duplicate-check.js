// ========================================
// PRE-IMPORT DUPLICATE CHECK
// ========================================

let preImportPendingChar = null; // Character data waiting to be imported
let preImportMatches = []; // Matching existing characters
let preImportResolveCallback = null; // Promise resolver

/**
 * Show the pre-import duplicate warning modal
 * Returns a promise that resolves with the user's choice
 */
async function showPreImportDuplicateWarning(newCharInfo, matches) {
    // Hydrate slim characters so estimateTokens can read heavy fields
    await Promise.all(matches.map(m => hydrateCharacter(m.char)));

    return new Promise((resolve) => {
        preImportPendingChar = newCharInfo;
        preImportMatches = matches;
        preImportResolveCallback = resolve;
        
        const modal = document.getElementById('preImportDuplicateModal');
        const infoEl = document.getElementById('preImportDuplicateInfo');
        const matchesEl = document.getElementById('preImportDuplicateMatches');
        
        // Render importing character info
        const name = newCharInfo.name || newCharInfo.definition?.name || 'Unknown';
        const creator = newCharInfo.creator || newCharInfo.definition?.creator || 'Unknown';
        const avatarUrl = newCharInfo.avatarUrl || `https://avatars.charhub.io/avatars/${newCharInfo.fullPath}/avatar.webp`;
        const bestScore = matches.length > 0 ? matches[0].score : 0;
        const headerSubtext = bestScore >= 60
            ? 'This character likely already exists in your library'
            : 'This character may already exist in your library';
        
        infoEl.innerHTML = `
            <img class="pre-import-info-avatar" src="${avatarUrl}" alt="${escapeHtml(name)}" onerror="this.style.display='none'">
            <div class="pre-import-info-text">
                <h4><i class="fa-solid fa-download"></i> Importing: ${escapeHtml(name)}</h4>
                <p>by ${escapeHtml(creator)} &bull; ${headerSubtext}</p>
            </div>
        `;
        
        // Render existing matches
        let matchesHtml = `<div class="pre-import-matches-header">Found ${matches.length} potential match${matches.length === 1 ? '' : 'es'}:</div>`;
        
        matches.forEach((match, idx) => {
            const existingChar = match.char;
            const existingName = getCharField(existingChar, 'name');
            const existingCreator = getCharField(existingChar, 'creator');
            const existingAvatar = getCharacterAvatarStThumbUrl(existingChar.avatar);
            const tokens = estimateTokens(existingChar);
            const provInfo = window.ProviderRegistry?.getCharacterProvider(existingChar);
            const sourceName = provInfo?.provider?.name || 'Local';
            
            matchesHtml += `
                <div class="char-dup-card pre-import-match-card" data-avatar="${escapeHtml(existingChar.avatar)}" style="margin-bottom: 10px; border-color: var(--glass-border);">
                    <div class="char-dup-card-header">
                        <img class="char-dup-card-avatar" src="${existingAvatar}" alt="${escapeHtml(existingName)}" loading="lazy">
                        <div class="char-dup-card-title">
                            <div class="char-dup-card-name">${escapeHtml(existingName)}</div>
                            <div class="char-dup-card-creator">by ${escapeHtml(existingCreator)} &bull; ${escapeHtml(sourceName)}</div>
                        </div>
                    </div>
                    <div class="char-dup-card-meta">
                        <div class="char-dup-group-confidence ${match.confidence}">${match.matchReason}</div>
                        <div class="char-dup-card-meta-item" style="margin-left: auto;"><i class="fa-solid fa-code"></i> ~${tokens} tokens</div>
                        <div class="char-dup-card-meta-item" style="opacity: 0.5;"><i class="fa-solid fa-eye"></i> View</div>
                    </div>
                </div>
            `;
        });
        
        matchesEl.innerHTML = matchesHtml;

        // Show modal
        modal.classList.add('visible');
    });
}

/**
 * Hide the pre-import modal and resolve with user choice
 */
function resolvePreImportChoice(choice) {
    document.getElementById('preImportDuplicateModal').classList.remove('visible');
    
    if (preImportResolveCallback) {
        preImportResolveCallback({
            choice,
            pendingChar: preImportPendingChar,
            matches: preImportMatches
        });
        preImportResolveCallback = null;
    }
    
    preImportPendingChar = null;
    preImportMatches = [];
}

// Pre-Import Modal Event Listeners
on('closePreImportDuplicateModal', 'click', () => resolvePreImportChoice('skip'));

on('preImportSkipBtn', 'click', () => resolvePreImportChoice('skip'));

on('preImportAnyway', 'click', () => resolvePreImportChoice('import'));

on('preImportReplaceBtn', 'click', () => resolvePreImportChoice('replace'));

document.getElementById('preImportDuplicateMatches')?.addEventListener('click', (e) => {
    const card = e.target.closest('.pre-import-match-card[data-avatar]');
    if (!card) return;
    const avatar = card.dataset.avatar;
    const match = preImportMatches.find(m => m.char.avatar === avatar);
    if (!match) return;
    document.querySelectorAll('.modal-overlay:not(.hidden)').forEach(m => {
        if (m.querySelector('.browse-char-modal')) m.classList.add('hidden');
    });
    openCharModalElevated(match.char);
});


/**
 * Render creator notes with simple sanitized HTML (no iframe, no custom CSS)
 * This is the fallback when rich rendering is disabled
 * @param {string} content - The creator notes content
 * @param {string} charName - Character name for placeholder replacement
 * @param {HTMLElement} container - Container element to render into
 */
function renderCreatorNotesSimple(content, charName, container) {
    if (!content || !container) return;
    
    // Use formatRichText without preserveHtml to get basic markdown formatting
    const formattedNotes = formatRichText(content, charName, false);
    
    // Strict sanitization - no style tags, minimal allowed elements
    const sanitizedNotes = safePurify(formattedNotes, {
        ALLOWED_TAGS: [
            'p', 'br', 'hr', 'div', 'span',
            'strong', 'b', 'em', 'i', 'u', 's', 'del',
            'a', 'img', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
            'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
            'table', 'tr', 'td', 'th', 'thead', 'tbody'
        ],
        ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'target', 'class'],
        ADD_ATTR: ['target'],
        FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'select', 'textarea', 'style', 'link'],
        FORBID_ATTR: ['onerror', 'onclick', 'onload', 'onmouseover', 'style'],
        ALLOW_UNKNOWN_PROTOCOLS: false,
        KEEP_CONTENT: true
    });
    
    container.innerHTML = sanitizedNotes;
}

