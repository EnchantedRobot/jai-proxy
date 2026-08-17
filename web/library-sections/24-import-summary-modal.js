// ==============================================
// Import Summary Modal
// ==============================================

// Store pending media characters for download
let pendingMediaCharacters = [];
// Store pending gallery characters for download
let pendingGalleryCharacters = [];
// Track active import-summary downloads for cancel/cleanup
let importSummaryDownloadState = {
    active: false,
    abort: false,
    controller: null
};

function getImportSummaryFolderName(charInfo) {
    // resolveGalleryFolderName is unsafe here — allCharacters may not be refreshed yet
    // with this import's gallery_id, so build the name directly matching buildUniqueGalleryFolderName.
    if (charInfo?.galleryId && getSetting('uniqueGalleryFolders')) {
        const safeName = (charInfo.name || 'Unknown').replace(/[<>:"/\\|?*]/g, '_').trim();
        return `${safeName}_${charInfo.galleryId}`;
    }
    // Name-first for the same reason as the import loop: the summary can be acted on
    // before the imported char lands in allCharacters, and the name is the off-mode
    // folder in every window.
    return resolveGalleryFolderName(charInfo?.name || charInfo?.avatar);
}

function resetImportSummaryDownloads() {
    importSummaryDownloadState.active = false;
    importSummaryDownloadState.abort = false;
    importSummaryDownloadState.controller = null;
    pendingMediaCharacters = [];
    pendingGalleryCharacters = [];
}

async function handleImportSummaryCloseRequest() {
    if (importSummaryDownloadState.active) {
        const confirmClose = await showConfirm({
            title: 'Stop downloads?',
            message: 'Downloads are still running. Stop and close?',
            icon: 'fa-solid fa-triangle-exclamation',
            iconColor: 'var(--cl-warning-bright)',
            confirmLabel: 'Stop Downloads',
            cancelLabel: 'Keep Downloading',
            danger: true,
        });
        if (!confirmClose) return;
        importSummaryDownloadState.abort = true;
        importSummaryDownloadState.controller?.abort();
        importSummaryDownloadState.active = false;
        pendingMediaCharacters = [];
        pendingGalleryCharacters = [];
    } else {
        resetImportSummaryDownloads();
    }
    hideModal('importSummaryModal');
}

/**
 * Show import summary modal with 2 rows: gallery and/or embedded media
 * @param {Object} options
 * @param {Array<{name: string, fullPath: string, url: string, chubId: number}>} options.galleryCharacters - Characters with ChubAI galleries
 * @param {Array<{name: string, avatar: string, mediaUrls: string[]}>} options.mediaCharacters - Characters with embedded media
 */
// Merge the two pending lists into per-character download jobs. Shared by the
// summary's Download All button and the background-queue gate so the phase
// rules cant drift between the two paths.
function buildImportSummaryJobs(mediaCharacters, galleryCharacters) {
    const includeGallery = getSetting('includeProviderGallery') !== false;
    const includeExt = getSetting('includeExternalGalleries') !== false;
    const charMap = new Map();
    for (const c of mediaCharacters) {
        charMap.set(c.avatar || c.name, { ...c });
    }
    for (const c of galleryCharacters) {
        const key = c.avatar || c.name;
        if (charMap.has(key)) {
            const existing = charMap.get(key);
            existing.provider = c.provider;
            existing.linkInfo = c.linkInfo;
        } else {
            charMap.set(key, { ...c });
        }
    }
    const jobs = [];
    for (const charInfo of charMap.values()) {
        const phases = [];
        if (charInfo.mediaUrls?.length > 0) phases.push('embedded');
        if (includeGallery && charInfo.provider?.supportsGallery && charInfo.linkInfo) phases.push('providerGallery');
        if (includeExt && charInfo.galleryPageUrls?.length > 0) phases.push('extGallery');
        if (phases.length === 0) continue;
        jobs.push({
            charInfo,
            folderName: getImportSummaryFolderName(charInfo),
            pseudoChar: { avatar: charInfo.avatar, name: charInfo.name, data: charInfo.cardData || { extensions: {} }, _slim: false },
            phases,
        });
    }
    return jobs;
}

function queueImportMediaJobs({ galleryCharacters = [], mediaCharacters = [] }) {
    const jobs = buildImportSummaryJobs(mediaCharacters, galleryCharacters);
    let queued = 0;
    for (const job of jobs) {
        const ok = window.enqueueMediaDownloadJob?.({
            avatar: job.charInfo.avatar,
            name: job.charInfo.name,
            folderName: job.folderName,
            phases: job.phases,
            embeddedUrls: job.charInfo.mediaUrls || [],
            lorebookUrls: [],
            galleryPageUrls: job.charInfo.galleryPageUrls || [],
            providerOverride: job.charInfo.provider ? { provider: job.charInfo.provider, linkInfo: job.charInfo.linkInfo } : undefined,
            pseudoChar: job.pseudoChar,
        });
        if (ok) queued++;
    }
    return queued;
}

function showImportSummaryModal({ galleryCharacters = [], mediaCharacters = [] }) {
    // Background mode: queue everything silently instead of offering the
    // blocking download step; the modal never opens.
    if (getSetting('importMediaAction') === 'background') {
        const queued = queueImportMediaJobs({ galleryCharacters, mediaCharacters });
        if (queued > 0) {
            showToast(`Media downloads queued in background (${queued} character${queued === 1 ? '' : 's'})`, 'info');
        }
        return;
    }
    const modal = document.getElementById('importSummaryModal');
    const galleryRow = document.getElementById('importSummaryGalleryRow');
    const galleryDesc = document.getElementById('importSummaryGalleryDesc');
    const mediaRow = document.getElementById('importSummaryMediaRow');
    const mediaDesc = document.getElementById('importSummaryMediaDesc');
    const mediaBadge = document.getElementById('importSummaryMediaBadge');
    const extGalleryRow = document.getElementById('importSummaryExtGalleryRow');
    const extGalleryDesc = document.getElementById('importSummaryExtGalleryDesc');
    const extGalleryBadge = document.getElementById('importSummaryExtGalleryBadge');
    const downloadAllBtn = document.getElementById('importSummaryDownloadAllBtn');
    const progressWrap = document.getElementById('importSummaryProgress');
    const progressFill = document.getElementById('importSummaryProgressFill');
    const progressLabel = document.getElementById('importSummaryProgressLabel');
    const progressCount = document.getElementById('importSummaryProgressCount');
    
    if (!modal) return;
    
    // Store media characters for download
    pendingMediaCharacters = mediaCharacters;
    // Store gallery characters for download
    pendingGalleryCharacters = galleryCharacters;
    
    // Reset rows
    galleryRow?.classList.add('hidden');
    mediaRow?.classList.add('hidden');
    extGalleryRow?.classList.add('hidden');
    
    const includeProviderGallery = getSetting('includeProviderGallery') !== false;

    // Show gallery row if there are gallery characters (disabled when setting off)
    if (galleryCharacters.length > 0 && galleryRow) {
        const galleryTitle = document.getElementById('importSummaryGalleryTitle');
        const providerName = galleryCharacters[0]?.provider?.name || 'Provider';
        if (galleryTitle) galleryTitle.textContent = `${providerName} Gallery`;

        if (galleryCharacters.length === 1) {
            if (galleryDesc) {
                galleryDesc.textContent = includeProviderGallery
                    ? `Additional artwork available from ${providerName}`
                    : `Additional artwork available from ${providerName} (disabled in settings)`;
            }
        } else {
            if (galleryDesc) {
                galleryDesc.textContent = includeProviderGallery
                    ? `${galleryCharacters.length} characters have gallery images`
                    : `${galleryCharacters.length} characters have gallery images (disabled in settings)`;
            }
        }
        galleryRow.classList.toggle('disabled', !includeProviderGallery);
        galleryRow.classList.remove('hidden');
    }
    
    if (mediaCharacters.length > 0) {
        const totalFiles = mediaCharacters.reduce((sum, c) => sum + (c.mediaUrls?.length || 0), 0);
        const allGalleryUrls = mediaCharacters.flatMap(c => c.galleryPageUrls || []);
        const totalExtGalleries = allGalleryUrls.length;

        // Embedded media row
        if (totalFiles > 0 && mediaRow) {
            if (mediaBadge) mediaBadge.textContent = totalFiles;
            if (mediaDesc) {
                mediaDesc.textContent = totalFiles === 1
                    ? 'Image referenced in the card text'
                    : `${totalFiles} images and files referenced in the card`;
            }
            mediaRow.classList.remove('hidden');
        }

        // External galleries row
        if (totalExtGalleries > 0 && extGalleryRow) {
            if (extGalleryBadge) extGalleryBadge.textContent = totalExtGalleries;
            if (extGalleryDesc) {
                const sources = typeof window.identifyGallerySources === 'function'
                    ? window.identifyGallerySources(allGalleryUrls) : [];
                if (sources.length > 0) {
                    extGalleryDesc.textContent = sources.join(', ');
                } else {
                    extGalleryDesc.textContent = totalExtGalleries === 1
                        ? 'Gallery page linked in the card'
                        : `${totalExtGalleries} gallery pages linked in the card`;
                }
            }
            extGalleryRow.classList.remove('hidden');
        }
    }
    
    // Reset Download All button
    if (downloadAllBtn) {
        downloadAllBtn.disabled = false;
        downloadAllBtn.innerHTML = '<i class="fa-solid fa-download"></i> Download All';
        downloadAllBtn.classList.remove('success');
    }

    if (progressWrap && progressFill && progressLabel && progressCount) {
        progressWrap.classList.add('hidden');
        progressFill.style.width = '0%';
        progressLabel.textContent = 'Preparing downloads...';
        progressCount.textContent = '0/0';
    }

    modal.classList.add('visible');
}

// Import Summary Modal Event Listeners
on('closeImportSummaryModal', 'click', handleImportSummaryCloseRequest);

// Download All button - downloads both gallery and embedded media
on('importSummaryDownloadAllBtn', 'click', async () => {
    const btn = document.getElementById('importSummaryDownloadAllBtn');
    const progressWrap = document.getElementById('importSummaryProgress');
    const progressFill = document.getElementById('importSummaryProgressFill');
    const progressLabel = document.getElementById('importSummaryProgressLabel');
    const progressCount = document.getElementById('importSummaryProgressCount');
    
    // If already done, close the modal
    if (btn.classList.contains('success')) {
        hideModal('importSummaryModal');
        pendingMediaCharacters = [];
        pendingGalleryCharacters = [];
        return;
    }
    
    const hasGallery = pendingGalleryCharacters.length > 0 && getSetting('includeProviderGallery') !== false;
    const hasMedia = pendingMediaCharacters.length > 0;
    
    if (!hasGallery && !hasMedia) {
        showToast('Nothing to download', 'info');
        return;
    }
    
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Downloading...';

    importSummaryDownloadState.active = true;
    importSummaryDownloadState.abort = false;
    importSummaryDownloadState.controller?.abort();
    importSummaryDownloadState.controller = new AbortController();
    
    let totalGallerySuccess = 0;
    let totalMediaSuccess = 0;
    let totalExtGallerySuccess = 0;
    let wasAborted = false;

    const setProgress = (label, current, total) => {
        if (!progressWrap || !progressFill || !progressLabel || !progressCount) return;
        progressWrap.classList.remove('hidden');
        progressLabel.textContent = label;
        if (typeof total === 'number' && total > 0) {
            const pct = Math.min(100, Math.round((current / total) * 100));
            progressFill.style.width = `${pct}%`;
            progressCount.textContent = `${current}/${total}`;
        } else {
            progressFill.style.width = '20%';
            progressCount.textContent = current ? String(current) : '0';
        }
    };

    // Unified per-character job list (shared with the background-queue gate)
    for (const job of buildImportSummaryJobs(pendingMediaCharacters, pendingGalleryCharacters)) {
        if (importSummaryDownloadState.abort) { wasAborted = true; break; }
        const { charInfo, folderName, pseudoChar, phases } = job;

        const pResult = await downloadCharacterMedia(pseudoChar, folderName, {
            embeddedUrls: charInfo.mediaUrls || [],
            lorebookUrls: [],
            galleryPageUrls: charInfo.galleryPageUrls || [],
            providerOverride: charInfo.provider ? { provider: charInfo.provider, linkInfo: charInfo.linkInfo } : undefined,
            phases,
            signal: importSummaryDownloadState.controller.signal,
            shouldAbort: () => importSummaryDownloadState.abort,
            onProgress: (phase, current, total) => {
                const phaseLabel = { embedded: 'Embedded media', providerGallery: `${charInfo.provider?.name || 'Provider'} gallery`, extGallery: 'External galleries' }[phase] || phase;
                setProgress(`${phaseLabel}: ${charInfo.name || 'files'}`, current, total);
            }
        });

        totalMediaSuccess += (pResult.embedded?.success || 0);
        totalGallerySuccess += (pResult.providerGallery?.success || 0);
        totalExtGallerySuccess += (pResult.extGallery?.success || 0);
        if (pResult.aborted) { wasAborted = true; break; }
    }
    
    importSummaryDownloadState.active = false;
    importSummaryDownloadState.controller = null;
    if (wasAborted) {
        showToast('Downloads cancelled', 'info');
        if (progressWrap && progressFill && progressLabel && progressCount) {
            progressWrap.classList.add('hidden');
            progressFill.style.width = '0%';
            progressLabel.textContent = 'Preparing downloads...';
            progressCount.textContent = '0/0';
        }
        resetImportSummaryDownloads();
        return;
    }
    
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-check"></i> Done';
    btn.classList.add('success');
    
    const totalDownloaded = totalGallerySuccess + totalMediaSuccess + totalExtGallerySuccess;
    if (totalDownloaded > 0) {
        showToast(`Downloaded ${totalDownloaded} file${totalDownloaded > 1 ? 's' : ''}`, 'success');
        fetchCharacters(true);
    } else {
        showToast('All files already exist', 'info');
    }

    if (progressWrap && progressFill && progressLabel && progressCount) {
        progressWrap.classList.add('hidden');
        progressFill.style.width = '0%';
        progressLabel.textContent = 'Preparing downloads...';
        progressCount.textContent = '0/0';
    }

    resetImportSummaryDownloads();
});

