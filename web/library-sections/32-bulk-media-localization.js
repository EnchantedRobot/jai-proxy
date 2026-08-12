// ==============================================
// Bulk Media Localization
// ==============================================

// Bulk Localize Modal Elements
const bulkLocalizeModal = document.getElementById('bulkLocalizeModal');
const closeBulkLocalizeModal = document.getElementById('closeBulkLocalizeModal');
const cancelBulkLocalizeBtn = document.getElementById('cancelBulkLocalizeBtn');
const bulkLocalizeCharAvatar = document.getElementById('bulkLocalizeCharAvatar');
const bulkLocalizeCharName = document.getElementById('bulkLocalizeCharName');
const bulkLocalizeStatus = document.getElementById('bulkLocalizeStatus');
const bulkLocalizeProgressCount = document.getElementById('bulkLocalizeProgressCount');
const bulkLocalizeProgressFill = document.getElementById('bulkLocalizeProgressFill');
const bulkLocalizeFileCount = document.getElementById('bulkLocalizeFileCount');
const bulkLocalizeFileFill = document.getElementById('bulkLocalizeFileFill');
const bulkStatDownloaded = document.getElementById('bulkStatDownloaded');
const bulkStatSkipped = document.getElementById('bulkStatSkipped');
const bulkStatErrors = document.getElementById('bulkStatErrors');

// Bulk Summary Modal Elements
const bulkSummaryModal = document.getElementById('bulkLocalizeSummaryModal');
const closeBulkSummaryModal = document.getElementById('closeBulkSummaryModal');
const closeBulkSummaryBtn = document.getElementById('closeBulkSummaryBtn');
const bulkSummaryOverview = document.getElementById('bulkSummaryOverview');
const bulkSummaryFilterSelect = document.getElementById('bulkSummaryFilterSelect');
const bulkSummarySearch = document.getElementById('bulkSummarySearch');
const bulkSummaryList = document.getElementById('bulkSummaryList');
const bulkSummaryPrevBtn = document.getElementById('bulkSummaryPrevBtn');
const bulkSummaryNextBtn = document.getElementById('bulkSummaryNextBtn');
const bulkSummaryPageInfo = document.getElementById('bulkSummaryPageInfo');

// Bulk localization state
let bulkLocalizeAborted = false;
let bulkLocalizeAbortController = null;
let bulkLocalizeResults = [];
let bulkSummaryCurrentPage = 1;
let bulkSummaryShowRenamed = false;
const BULK_SUMMARY_PAGE_SIZE = 50;

// Close bulk localize modal
closeBulkLocalizeModal?.addEventListener('click', () => {
    bulkLocalizeAborted = true;
    bulkLocalizeAbortController?.abort();
    bulkLocalizeModal.classList.remove('visible');
});

cancelBulkLocalizeBtn?.addEventListener('click', () => {
    bulkLocalizeAborted = true;
    bulkLocalizeAbortController?.abort();
    cancelBulkLocalizeBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Stopping...';
    cancelBulkLocalizeBtn.disabled = true;
});

// Close summary modal
closeBulkSummaryModal?.addEventListener('click', () => {
    bulkSummaryModal.classList.remove('visible');
});

closeBulkSummaryBtn?.addEventListener('click', () => {
    bulkSummaryModal.classList.remove('visible');
});

// Summary filter and search handlers
bulkSummaryFilterSelect?.addEventListener('change', () => {
    bulkSummaryCurrentPage = 1;
    renderBulkSummaryList();
});

bulkSummarySearch?.addEventListener('input', () => {
    bulkSummaryCurrentPage = 1;
    renderBulkSummaryList();
});

bulkSummaryPrevBtn?.addEventListener('click', () => {
    if (bulkSummaryCurrentPage > 1) {
        bulkSummaryCurrentPage--;
        renderBulkSummaryList();
    }
});

bulkSummaryNextBtn?.addEventListener('click', () => {
    bulkSummaryCurrentPage++;
    renderBulkSummaryList();
});

document.getElementById('bulkSummaryList')?.addEventListener('click', (e) => {
    const link = e.target.closest('.char-name-link');
    if (link) {
        e.preventDefault();
        const avatar = link.dataset.avatar;
        if (avatar) openCharFromBulkSummary(avatar);
    }
});

/**
 * Filter bulk summary results based on current filter and search
 */
function getFilteredBulkResults() {
    const filter = bulkSummaryFilterSelect?.value || 'all';
    const search = (bulkSummarySearch?.value || '').toLowerCase().trim();
    
    return bulkLocalizeResults.filter(r => {
        const totalDownloaded = (r.downloaded || 0) + (r.galleryDownloaded || 0) + (r.extGalleryDownloaded || 0);
        const totalSkipped = (r.skipped || 0) + (r.gallerySkipped || 0) + (r.extGallerySkipped || 0);
        const totalErrors = (r.errors || 0) + (r.galleryErrors || 0) + (r.extGalleryErrors || 0);
        const hasAnyMedia = r.totalUrls > 0;
        
        if (filter === 'localized' && (!hasAnyMedia || totalErrors > 0 || r.incomplete)) return false;
        if (filter === 'downloaded' && totalDownloaded === 0) return false;
        if (filter === 'skipped' && totalSkipped === 0) return false;
        if (filter === 'errors' && totalErrors === 0) return false;
        if (filter === 'incomplete' && !r.incomplete) return false;
        if (filter === 'none' && hasAnyMedia) return false;
        
        // Apply search
        if (search && !r.name.toLowerCase().includes(search)) return false;
        
        return true;
    });
}

/**
 * Save bulk summary modal state before opening character modal
 */
function saveBulkSummaryModalState() {
    const modal = bulkSummaryModal;
    bulkSummaryModalState.wasOpen = modal && modal.classList.contains('visible');
    bulkSummaryModalState.scrollPosition = bulkSummaryList ? bulkSummaryList.scrollTop : 0;
    bulkSummaryModalState.currentPage = bulkSummaryCurrentPage;
    bulkSummaryModalState.filterValue = bulkSummaryFilterSelect?.value || 'all';
    bulkSummaryModalState.searchValue = bulkSummarySearch?.value || '';
}

/**
 * Restore bulk summary modal state after closing character modal
 */
function restoreBulkSummaryModalState() {
    if (!bulkSummaryModalState.wasOpen) return;
    
    // Restore filter/search values
    if (bulkSummaryFilterSelect) bulkSummaryFilterSelect.value = bulkSummaryModalState.filterValue;
    if (bulkSummarySearch) bulkSummarySearch.value = bulkSummaryModalState.searchValue;
    bulkSummaryCurrentPage = bulkSummaryModalState.currentPage;
    
    bulkSummaryModal.classList.add('visible');
    
    // Re-render and restore scroll position
    renderBulkSummaryList();
    
    setTimeout(() => {
        if (bulkSummaryList) {
            bulkSummaryList.scrollTop = bulkSummaryModalState.scrollPosition;
        }
    }, 50);
}

/**
 * Open character modal from bulk summary list
 */
function openCharFromBulkSummary(avatar) {
    const char = allCharacters.find(c => c.avatar === avatar);
    if (!char) {
        showToast('Character not found', 'error');
        return;
    }
    
    saveBulkSummaryModalState();
    
    // Hide bulk summary modal
    bulkSummaryModal.classList.remove('visible');
    
    // Open character modal
    openModal(char);
}

/**
 * Render the bulk summary list with pagination
 */
function renderBulkSummaryList() {
    const filtered = getFilteredBulkResults();
    const totalPages = Math.max(1, Math.ceil(filtered.length / BULK_SUMMARY_PAGE_SIZE));
    
    // Clamp current page
    if (bulkSummaryCurrentPage > totalPages) bulkSummaryCurrentPage = totalPages;
    
    const startIdx = (bulkSummaryCurrentPage - 1) * BULK_SUMMARY_PAGE_SIZE;
    const pageResults = filtered.slice(startIdx, startIdx + BULK_SUMMARY_PAGE_SIZE);
    
    if (pageResults.length === 0) {
        bulkSummaryList.innerHTML = '<div class="bulk-summary-empty"><i class="fa-solid fa-filter-circle-xmark"></i><br>No characters match the current filter</div>';
    } else {
        bulkSummaryList.innerHTML = pageResults.map(r => {
            const hasGalleryStats = r.galleryDownloaded > 0 || r.gallerySkipped > 0 || r.galleryErrors > 0;
            const hasExtGalleryStats = (r.extGalleryDownloaded || 0) > 0 || (r.extGallerySkipped || 0) > 0 || (r.extGalleryErrors || 0) > 0;
            const totalEmbedded = (r.downloaded || 0) + (r.skipped || 0) + (r.errors || 0);
            const hasEmbeddedStats = totalEmbedded > 0;
            const hasAnyMedia = hasEmbeddedStats || hasGalleryStats || hasExtGalleryStats;
            
            // Build embedded stats section
            let embeddedHtml = '';
            if (hasEmbeddedStats) {
                const parts = [];
                if (r.downloaded > 0) parts.push(`<span class="downloaded" title="${r.downloaded} new file(s) downloaded"><i class="fa-solid fa-download"></i>${r.downloaded}</span>`);
                if (r.skipped > 0) parts.push(`<span class="skipped" title="${r.filenameSkipped > 0 ? `${r.skipped} already local (${r.filenameSkipped} by filename)` : `${r.skipped} file(s) already local`}"><i class="fa-solid fa-check"></i>${r.skipped}</span>`);
                if (r.errors > 0) parts.push(`<span class="errors" title="${r.errors} file(s) failed"><i class="fa-solid fa-xmark"></i>${r.errors}</span>`);
                if (bulkSummaryShowRenamed && r.renamed > 0) parts.push(`<span class="renamed" title="${r.renamed} file(s) renamed"><i class="fa-solid fa-file-pen"></i>${r.renamed}</span>`);
                embeddedHtml = `<div class="media-source-group embedded" title="Embedded media from character data"><i class="fa-solid fa-file-code source-icon"></i>${parts.join('')}</div>`;
            }
            
            // Build provider gallery stats section
            let galleryHtml = '';
            if (hasGalleryStats) {
                const parts = [];
                if (r.galleryDownloaded > 0) parts.push(`<span class="downloaded" title="${r.galleryDownloaded} gallery image(s) downloaded"><i class="fa-solid fa-download"></i>${r.galleryDownloaded}</span>`);
                if (r.gallerySkipped > 0) parts.push(`<span class="skipped" title="${r.galleryFilenameSkipped > 0 ? `${r.gallerySkipped} already local (${r.galleryFilenameSkipped} by filename)` : `${r.gallerySkipped} gallery image(s) already local`}"><i class="fa-solid fa-check"></i>${r.gallerySkipped}</span>`);
                if (r.galleryErrors > 0) parts.push(`<span class="errors" title="${r.galleryErrors} gallery image(s) failed"><i class="fa-solid fa-xmark"></i>${r.galleryErrors}</span>`);
                galleryHtml = `<div class="media-source-group gallery" title="Provider gallery images"><i class="fa-solid fa-images source-icon"></i>${parts.join('')}</div>`;
            }
            
            let extGalleryHtml = '';
            if (hasExtGalleryStats) {
                const parts = [];
                if (r.extGalleryDownloaded > 0) parts.push(`<span class="downloaded" title="${r.extGalleryDownloaded} image(s) downloaded from external galleries"><i class="fa-solid fa-download"></i>${r.extGalleryDownloaded}</span>`);
                if (r.extGallerySkipped > 0) parts.push(`<span class="skipped" title="${r.extGallerySkipped} external gallery image(s) already local"><i class="fa-solid fa-check"></i>${r.extGallerySkipped}</span>`);
                if (r.extGalleryErrors > 0) parts.push(`<span class="errors" title="${r.extGalleryErrors} external gallery image(s) failed"><i class="fa-solid fa-xmark"></i>${r.extGalleryErrors}</span>`);
                extGalleryHtml = `<div class="media-source-group ext-gallery" title="External gallery pages (Imgchest, ImgBB, etc.)"><i class="fa-solid fa-globe source-icon"></i>${parts.join('')}</div>`;
            }
            
            return `
            <div class="bulk-summary-item${r.incomplete ? ' incomplete' : ''}">
                <img src="${getCharacterAvatarStThumbUrl(r.avatar)}" alt="" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><rect fill=%22%23333%22 width=%22100%22 height=%22100%22/><text x=%2250%22 y=%2255%22 text-anchor=%22middle%22 fill=%22%23666%22 font-size=%2240%22>?</text></svg>'">
                <a class="char-name-link" href="#" data-avatar="${escapeHtml(r.avatar)}" title="Click to view ${escapeHtml(r.name)}">${escapeHtml(r.name)}</a>
                <div class="char-stats">
                    ${r.incomplete ? '<span class="incomplete-badge" title="Has errors or was interrupted"><i class="fa-solid fa-exclamation-triangle"></i></span>' : ''}
                    ${!hasAnyMedia 
                        ? '<span class="none" title="Character has no embedded remote media URLs and no linked provider gallery"><i class="fa-solid fa-minus"></i> No media</span>'
                        : `${embeddedHtml}${galleryHtml}${extGalleryHtml}`
                    }
                </div>
            </div>
        `}).join('');
    }
    
    // Update pagination
    bulkSummaryPageInfo.textContent = `Page ${bulkSummaryCurrentPage} of ${totalPages}`;
    bulkSummaryPrevBtn.disabled = bulkSummaryCurrentPage <= 1;
    bulkSummaryNextBtn.disabled = bulkSummaryCurrentPage >= totalPages;
}

/**
 * Show the bulk summary modal with results
 */
function showBulkSummary(wasAborted = false, skippedCompleted = 0) {
    // Calculate totals
    const totals = bulkLocalizeResults.reduce((acc, r) => {
        acc.characters++;
        acc.downloaded += r.downloaded || 0;
        acc.skipped += r.skipped || 0;
        acc.errors += r.errors || 0;
        acc.renamed += r.renamed || 0;
        acc.filenameSkipped += r.filenameSkipped || 0;
        acc.galleryDownloaded += r.galleryDownloaded || 0;
        acc.gallerySkipped += r.gallerySkipped || 0;
        acc.galleryErrors += r.galleryErrors || 0;
        acc.galleryFilenameSkipped += r.galleryFilenameSkipped || 0;
        acc.extGalleryDownloaded += r.extGalleryDownloaded || 0;
        acc.extGallerySkipped += r.extGallerySkipped || 0;
        acc.extGalleryErrors += r.extGalleryErrors || 0;
        if (r.totalUrls > 0) acc.withMedia++;
        if (r.galleryDownloaded > 0 || r.gallerySkipped > 0 || r.galleryErrors > 0) acc.withGallery++;
        if (r.extGalleryDownloaded > 0 || r.extGallerySkipped > 0 || r.extGalleryErrors > 0) acc.withExtGallery++;
        if (r.incomplete) acc.incomplete++;
        return acc;
    }, { characters: 0, downloaded: 0, skipped: 0, errors: 0, renamed: 0, filenameSkipped: 0, withMedia: 0, incomplete: 0, galleryDownloaded: 0, gallerySkipped: 0, galleryErrors: 0, galleryFilenameSkipped: 0, withGallery: 0, extGalleryDownloaded: 0, extGallerySkipped: 0, extGalleryErrors: 0, withExtGallery: 0 });
    
    const hasEmbedded = totals.downloaded > 0 || totals.skipped > 0 || totals.errors > 0;
    const hasGallery = totals.galleryDownloaded > 0 || totals.gallerySkipped > 0 || totals.galleryErrors > 0;
    const hasExtGallery = totals.extGalleryDownloaded > 0 || totals.extGallerySkipped > 0 || totals.extGalleryErrors > 0;
    const totalDownloaded = totals.downloaded + totals.galleryDownloaded + totals.extGalleryDownloaded;
    const totalSkipped = totals.skipped + totals.gallerySkipped + totals.extGallerySkipped;
    const totalErrors = totals.errors + totals.galleryErrors + totals.extGalleryErrors;
    
    // Build the overview with two media source sections
    bulkSummaryOverview.innerHTML = `
        <!-- Summary header row -->
        <div class="bulk-summary-header-row">
            <div class="bulk-summary-stat main" title="Characters processed in this scan">
                <span class="stat-value">${totals.characters}</span>
                <span class="stat-label"><i class="fa-solid fa-user"></i> ${wasAborted ? 'Processed' : 'Scanned'}</span>
            </div>
            ${skippedCompleted > 0 ? `
            <div class="bulk-summary-stat previously-done" title="Characters skipped because media was already localized in a previous run">
                <span class="stat-value">${skippedCompleted}</span>
                <span class="stat-label"><i class="fa-solid fa-check-double"></i> Previously Done</span>
            </div>
            ` : ''}
            ${totals.incomplete > 0 ? `
            <div class="bulk-summary-stat incomplete" title="Characters that had download errors or were interrupted mid-process">
                <span class="stat-value">${totals.incomplete}</span>
                <span class="stat-label"><i class="fa-solid fa-exclamation-triangle"></i> Incomplete</span>
            </div>
            ` : ''}
        </div>
        
        <!-- Two-column media sources -->
        <div class="bulk-summary-media-sources">
            <!-- Embedded Media Column -->
            <div class="bulk-summary-source embedded ${!hasEmbedded ? 'empty' : ''}">
                <div class="source-header">
                    <i class="fa-solid fa-file-code"></i>
                    <span>Embedded Media</span>
                    <span class="source-hint" title="Images and media URLs found within character description, personality, first message, and other text fields">?</span>
                </div>
                <div class="source-stats">
                    <div class="source-stat downloaded" title="New files downloaded from remote URLs embedded in character data and saved to gallery">
                        <i class="fa-solid fa-download"></i>
                        <span class="value">${totals.downloaded}</span>
                        <span class="label">Downloaded</span>
                    </div>
                    <div class="source-stat skipped" title="${totals.filenameSkipped > 0 ? `${totals.skipped} files already local — ${totals.filenameSkipped} matched by filename, ${totals.skipped - totals.filenameSkipped} by content hash` : 'Files that were already present in the local gallery (matched by content hash)'}">
                        <i class="fa-solid fa-check"></i>
                        <span class="value">${totals.skipped}</span>
                        <span class="label">Already Local</span>
                    </div>
                    <div class="source-stat errors" title="Files that failed to download due to network errors, missing files, or access restrictions">
                        <i class="fa-solid fa-xmark"></i>
                        <span class="value">${totals.errors}</span>
                        <span class="label">Failed</span>
                    </div>
                    ${totals.renamed > 0 ? `
                    <div class="source-stat renamed" title="Existing gallery files that were renamed to their correct prefix format for proper hash-based lookup">
                        <i class="fa-solid fa-file-pen"></i>
                        <span class="value">${totals.renamed}</span>
                        <span class="label">Renamed</span>
                    </div>
                    ` : ''}
                </div>
                ${!hasEmbedded ? '<div class="source-empty">No embedded media found</div>' : ''}
            </div>
            
            <!-- Provider Gallery Column -->
            <div class="bulk-summary-source gallery ${!hasGallery ? 'empty' : ''}">
                <div class="source-header">
                    <i class="fa-solid fa-images"></i>
                    <span>Provider Gallery</span>
                    <span class="source-hint" title="Gallery images from linked providers. Downloaded from the character's public gallery page.">?</span>
                </div>
                <div class="source-stats">
                    <div class="source-stat downloaded" title="New gallery images downloaded and saved to the character's local gallery">
                        <i class="fa-solid fa-download"></i>
                        <span class="value">${totals.galleryDownloaded}</span>
                        <span class="label">Downloaded</span>
                    </div>
                    <div class="source-stat skipped" title="${totals.galleryFilenameSkipped > 0 ? `${totals.gallerySkipped} gallery images already local — ${totals.galleryFilenameSkipped} matched by filename, ${totals.gallerySkipped - totals.galleryFilenameSkipped} by content hash` : 'Gallery images that were already present locally (matched by content hash)'}">
                        <i class="fa-solid fa-check"></i>
                        <span class="value">${totals.gallerySkipped}</span>
                        <span class="label">Already Local</span>
                    </div>
                    <div class="source-stat errors" title="Gallery images that failed to download">
                        <i class="fa-solid fa-xmark"></i>
                        <span class="value">${totals.galleryErrors}</span>
                        <span class="label">Failed</span>
                    </div>
                </div>
                ${!hasGallery ? '<div class="source-empty">No provider galleries processed</div>' : ''}
                ${hasGallery ? `<div class="source-footer">${totals.withGallery} character${totals.withGallery !== 1 ? 's' : ''} with gallery</div>` : ''}
            </div>
            
            <!-- External Gallery Column -->
            ${hasExtGallery ? `
            <div class="bulk-summary-source ext-gallery">
                <div class="source-header">
                    <i class="fa-solid fa-globe"></i>
                    <span>External Galleries</span>
                    <span class="source-hint" title="Images from external gallery pages (Imgchest, ImgBB) found in character card text fields.">?</span>
                </div>
                <div class="source-stats">
                    <div class="source-stat downloaded" title="New images downloaded from external gallery pages">
                        <i class="fa-solid fa-download"></i>
                        <span class="value">${totals.extGalleryDownloaded}</span>
                        <span class="label">Downloaded</span>
                    </div>
                    <div class="source-stat skipped" title="External gallery images already present locally">
                        <i class="fa-solid fa-check"></i>
                        <span class="value">${totals.extGallerySkipped}</span>
                        <span class="label">Already Local</span>
                    </div>
                    <div class="source-stat errors" title="External gallery images that failed to download">
                        <i class="fa-solid fa-xmark"></i>
                        <span class="value">${totals.extGalleryErrors}</span>
                        <span class="label">Failed</span>
                    </div>
                </div>
                <div class="source-footer">${totals.withExtGallery} character${totals.withExtGallery !== 1 ? 's' : ''} with ext galleries</div>
            </div>
            ` : ''}
        </div>
        
        <!-- Grand totals row -->
        <div class="bulk-summary-totals">
            <div class="total-item downloaded" title="Total new files downloaded from all sources">
                <i class="fa-solid fa-download"></i>
                <span class="total-value">${totalDownloaded}</span>
                <span class="total-label">Total Downloaded</span>
            </div>
            <div class="total-item skipped" title="${(totals.filenameSkipped + totals.galleryFilenameSkipped) > 0 ? `${totalSkipped} total already local, ${totals.filenameSkipped + totals.galleryFilenameSkipped} matched by filename` : 'Total files already present locally'}">
                <i class="fa-solid fa-check"></i>
                <span class="total-value">${totalSkipped}</span>
                <span class="total-label">Already Local</span>
            </div>
            <div class="total-item errors" title="Total files that failed to download">
                <i class="fa-solid fa-xmark"></i>
                <span class="total-value">${totalErrors}</span>
                <span class="total-label">Failed</span>
            </div>
        </div>
    `;
    
    // Reset filters
    bulkSummaryFilterSelect.value = 'all';
    bulkSummarySearch.value = '';
    bulkSummaryCurrentPage = 1;
    
    // Always show renamed column since we always rename non-localized duplicates
    bulkSummaryShowRenamed = true;
    
    // Refresh the custom select menu to pick up any option changes
    bulkSummaryFilterSelect._customSelect?.refresh();
    
    // Render list
    renderBulkSummaryList();
    
    // Show modal
    bulkSummaryModal.classList.add('visible');
}

// Which characters Bulk Localize can skip -- read straight from the archive's
// own per-gallery manifests (docs/PHASE_3C_PLAN.md §3, §9 step 6) rather than
// a client-side completed-list. There is nothing to migrate: the old
// `_cl_media_loc_completed.json` (and the dead-URL ledger before it) tracked
// completion independently of whether anything was actually ever downloaded,
// which is exactly the state that went stale. "Complete" is now just "the
// gallery's last download run had zero errors," a fact the server already
// has to know to answer `GET /media/status`.
let _forceRescanNextBulkRun = false;

async function fetchMediaStatus() {
    try {
        const resp = await fetch('/api/v1/media/status');
        if (!resp.ok) return {};
        const body = await resp.json();
        return body?.cards || {};
    } catch (e) {
        console.warn('[MediaLoc] /media/status fetch failed:', e?.message || e);
        return {};
    }
}

/**
 * Run bulk media localization across all characters
 */
async function runBulkLocalization() {
    bulkLocalizeAborted = false;
    bulkLocalizeAbortController = new AbortController();
    bulkLocalizeResults = [];

    const mediaStatus = _forceRescanNextBulkRun ? {} : await fetchMediaStatus();
    _forceRescanNextBulkRun = false;

    // Reset UI
    bulkLocalizeModal.classList.add('visible');
    bulkLocalizeCharAvatar.src = '';
    bulkLocalizeCharName.textContent = 'Preparing...';
    bulkLocalizeStatus.textContent = 'Scanning library...';
    bulkLocalizeProgressFill.style.width = '0%';
    bulkLocalizeFileFill.style.width = '0%';
    bulkLocalizeProgressCount.textContent = '0/0 characters';
    bulkLocalizeFileCount.textContent = '0/0 files';
    bulkStatDownloaded.textContent = '0';
    bulkStatSkipped.textContent = '0';
    bulkStatErrors.textContent = '0';
    cancelBulkLocalizeBtn.innerHTML = '<i class="fa-solid fa-stop"></i> Stop';
    cancelBulkLocalizeBtn.disabled = false;
    
    let totalDownloaded = 0;
    let totalSkipped = 0;
    let totalErrors = 0;
    let totalRenamed = 0;
    
    const characters = [...allCharacters];
    const totalChars = characters.length;
    
    bulkLocalizeStatus.textContent = `Processing ${totalChars} characters...`;
    
    let skippedCompleted = 0;
    
    for (let i = 0; i < characters.length; i++) {
        if (bulkLocalizeAborted) {
            bulkLocalizeStatus.textContent = 'Stopping...';
            break;
        }
        
        const char = characters[i];
        const charName = getCharacterName(char, 'Unknown');
        // Get unique folder name if enabled
        const folderName = getGalleryFolderName(char);
        
        // Skip characters whose last download run already finished clean
        if (char.avatar && mediaStatus[char.avatar]?.complete) {
            skippedCompleted++;
            bulkLocalizeProgressCount.textContent = `${i + 1}/${totalChars} characters (${skippedCompleted} previously done)`;
            bulkLocalizeProgressFill.style.width = `${((i + 1) / totalChars) * 100}%`;
            continue;
        }
        
        bulkLocalizeCharAvatar.src = getCharacterAvatarStThumbUrl(char.avatar);
        bulkLocalizeCharName.textContent = charName;
        bulkLocalizeProgressCount.textContent = `${i + 1}/${totalChars} characters`;
        bulkLocalizeProgressFill.style.width = `${((i + 1) / totalChars) * 100}%`;
        
        // Hydrate slim character — findCharacterMediaUrls reads description/first_mes/etc.
        await hydrateCharacter(char);
        
        const result = {
            name: charName,
            avatar: char.avatar,
            totalUrls: 0,
            downloaded: 0,
            skipped: 0,
            errors: 0,
            renamed: 0,
            filenameSkipped: 0,
            incomplete: false
        };
        
        let currentPhaseLabel = '';
        let fileTotalCount = 0;
        const filePhaseDone = { embedded: 0, lorebook: 0, providerGallery: 0, extGallery: 0 };
        const filePhaseTotal = { embedded: 0, lorebook: 0, providerGallery: 0, extGallery: 0 };

        const updateFileProgress = () => {
            const allDone = filePhaseDone.embedded + filePhaseDone.lorebook + filePhaseDone.providerGallery + filePhaseDone.extGallery;
            bulkLocalizeFileFill.style.width = `${fileTotalCount > 0 ? (allDone / fileTotalCount) * 100 : 0}%`;
            bulkLocalizeFileCount.textContent = `${allDone}/${fileTotalCount} files`;
        };
        
        const pipelineResult = await downloadCharacterMedia(char, folderName, {
            shouldAbort: () => bulkLocalizeAborted,
            signal: bulkLocalizeAbortController.signal,
            onPhaseStart: (phase, ctx) => {
                if (phase === 'embedded' || phase === 'lorebook') {
                    filePhaseTotal[phase] = ctx.count;
                    fileTotalCount += ctx.count;
                    updateFileProgress();
                } else if (phase === 'providerGallery') {
                    currentPhaseLabel = ctx.provider || 'Provider';
                    bulkLocalizeFileCount.textContent = `Fetching ${currentPhaseLabel} gallery...`;
                } else if (phase === 'extGallery') {
                    bulkLocalizeFileCount.textContent = 'Extracting external galleries...';
                }
            },
            onProgress: (phase, current, total) => {
                if (bulkLocalizeAborted) return;
                filePhaseDone[phase] = current;
                if ((phase === 'providerGallery' || phase === 'extGallery') && filePhaseTotal[phase] === 0 && total > 0) {
                    filePhaseTotal[phase] = total;
                    fileTotalCount += total;
                }
                updateFileProgress();
            }
        });
        
        // Map pipeline result to bulk result shape
        result.totalUrls = fileTotalCount;
        result.downloaded = pipelineResult.embedded.success + pipelineResult.lorebook.success;
        result.skipped = pipelineResult.embedded.skipped + pipelineResult.lorebook.skipped;
        result.errors = pipelineResult.embedded.errors + pipelineResult.lorebook.errors;
        result.renamed = (pipelineResult.embedded.renamed || 0) + (pipelineResult.lorebook.renamed || 0);
        result.filenameSkipped = (pipelineResult.embedded.filenameSkipped || 0) + (pipelineResult.lorebook.filenameSkipped || 0);
        result.galleryDownloaded = pipelineResult.providerGallery.success;
        result.gallerySkipped = pipelineResult.providerGallery.skipped;
        result.galleryErrors = pipelineResult.providerGallery.errors;
        result.galleryFilenameSkipped = pipelineResult.providerGallery.filenameSkipped || 0;
        result.extGalleryDownloaded = pipelineResult.extGallery.success;
        result.extGallerySkipped = pipelineResult.extGallery.skipped;
        result.extGalleryErrors = pipelineResult.extGallery.errors;
        result.incomplete = pipelineResult.incomplete || pipelineResult.aborted;
        
        // Update totals
        totalDownloaded += pipelineResult.totals.success;
        totalSkipped += pipelineResult.totals.skipped;
        totalErrors += pipelineResult.totals.errors;
        totalRenamed += result.renamed;
        
        bulkStatDownloaded.textContent = totalDownloaded;
        bulkStatSkipped.textContent = totalSkipped;
        bulkStatErrors.textContent = totalErrors;
        
        if (pipelineResult.totals.success > 0 && char.avatar) {
            clearMediaLocalizationCache(char.avatar);
        }
        
        if (pipelineResult.aborted) {
            bulkLocalizeResults.push(result);
            break;
        }
        
        if (fileTotalCount === 0 && !pipelineResult.providerGallery.providerName) {
            bulkLocalizeFileCount.textContent = 'No remote media';
            bulkLocalizeFileFill.style.width = '100%';
        }
        
        bulkLocalizeResults.push(result);
        
        // Small delay to prevent UI lockup and allow abort to be processed
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    
    // Hide progress modal and show summary
    bulkLocalizeModal.classList.remove('visible');
    showBulkSummary(bulkLocalizeAborted, skippedCompleted);
    
    // Show toast
    const renamedMsg = totalRenamed > 0 ? `, renamed ${totalRenamed}` : '';
    if (bulkLocalizeAborted) {
        showToast(`Bulk localization stopped. Downloaded ${totalDownloaded} files${renamedMsg}.`, 'info');
    } else {
        showToast(`Bulk localization complete. Downloaded ${totalDownloaded} files${renamedMsg}.`, 'success');
    }
}

// Bulk Localize button in settings
document.getElementById('bulkLocalizeBtn')?.addEventListener('click', async () => {
    document.getElementById('gallerySettingsModal')?.classList.remove('visible');

    if (allCharacters.length === 0) {
        showToast('No characters loaded', 'error');
        return;
    }

    const mediaStatus = _forceRescanNextBulkRun ? {} : await fetchMediaStatus();
    const alreadyDone = allCharacters.filter(c => c.avatar && mediaStatus[c.avatar]?.complete).length;
    const remaining = allCharacters.length - alreadyDone;

    let confirmMsg;
    if (alreadyDone > 0) {
        confirmMsg = `${alreadyDone} of ${allCharacters.length} characters were previously processed and will be skipped.\n\n${remaining} characters will be scanned for remote media.\n\nContinue?`;
    } else {
        confirmMsg = `This will scan ${allCharacters.length} characters for remote media and download any new files.\n\nThis may take a while for large libraries. Continue?`;
    }

    if (confirm(confirmMsg)) {
        runBulkLocalization();
    }
});

// "Clear history" now just forces the next run to ignore each gallery's
// recorded completion and rescan everyone -- there is no separate history to
// clear any more; completeness is read live from each gallery's manifest.
document.getElementById('clearBulkLocalizeHistoryBtn')?.addEventListener('click', () => {
    _forceRescanNextBulkRun = true;
    showToast('Next bulk localize will scan every character again', 'success');
});

