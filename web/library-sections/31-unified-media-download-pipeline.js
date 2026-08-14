// ========================================================================
// Unified Media Download Pipeline
// ========================================================================

/**
 * @param {Object} character
 * @param {string} folderName - Gallery folder name
 * @param {Object} [options]
 * @param {AbortSignal} [options.signal]
 * @param {function} [options.shouldAbort]
 * @param {function} [options.onPhaseStart] - (phaseName, context) => void
 * @param {function} [options.onProgress] - (phase, current, total) => void
 * @param {function} [options.onLog] - (message, status) => logEntry
 * @param {function} [options.onLogUpdate] - (entry, message, status) => void
 * @param {string[]} [options.embeddedUrls] - Pre-resolved embedded media URLs (skip scanning)
 * @param {string[]} [options.lorebookUrls] - Pre-resolved lorebook media URLs (skip scanning)
 * @param {string[]} [options.galleryPageUrls] - Pre-resolved gallery page URLs for extraction
 * @param {string[]} [options.phases] - Restrict to these phases. Default: all applicable
 * @returns {Promise<Object>} PipelineResult
 */
async function downloadCharacterMedia(character, folderName, options = {}) {
    const {
        signal, shouldAbort,
        onPhaseStart, onPhaseEnd, onProgress, onLog, onLogUpdate,
        embeddedUrls: overrideEmbedded,
        lorebookUrls: overrideLorebook,
        galleryPageUrls: overrideGalleryPages,
        providerOverride,
        phases: restrictPhases
    } = options;

    const emptyPhase = () => ({ success: 0, skipped: 0, errors: 0, renamed: 0, filenameSkipped: 0 });
    const result = {
        embedded: emptyPhase(),
        lorebook: emptyPhase(),
        providerGallery: { ...emptyPhase(), providerName: null },
        extGallery: emptyPhase(),
        totals: { success: 0, skipped: 0, errors: 0 },
        aborted: false,
        incomplete: false
    };

    const phaseAllowed = (name) => !restrictPhases || restrictPhases.includes(name);
    const isAborted = () => signal?.aborted || shouldAbort?.();

    // Hydrate if slim and we need to scan for URLs
    const needsScan = !overrideEmbedded || !overrideLorebook || !overrideGalleryPages;
    if (needsScan && character._slim) {
        await hydrateCharacter(character);
    }

    // Resolve URLs: use overrides if provided, otherwise scan
    let embeddedUrls, lorebookUrls;
    if (overrideEmbedded !== undefined && overrideLorebook !== undefined) {
        embeddedUrls = overrideEmbedded || [];
        lorebookUrls = overrideLorebook || [];
    } else if (overrideEmbedded !== undefined) {
        embeddedUrls = overrideEmbedded || [];
        const scanned = findCharacterMediaUrls(character, { split: true });
        lorebookUrls = overrideLorebook !== undefined ? (overrideLorebook || []) : scanned.lorebookUrls;
    } else {
        const scanned = findCharacterMediaUrls(character, { split: true });
        embeddedUrls = overrideEmbedded !== undefined ? (overrideEmbedded || []) : scanned.embeddedUrls;
        lorebookUrls = overrideLorebook !== undefined ? (overrideLorebook || []) : scanned.lorebookUrls;
    }

    // Provider discovery (or use override for import flows)
    let galleryProvider = null;
    let providerLinkInfo = null;
    if (providerOverride?.provider) {
        galleryProvider = providerOverride.provider;
        providerLinkInfo = providerOverride.linkInfo || null;
    } else {
        const allProviders = window.ProviderRegistry?.getAllProviders() || [];
        for (const provider of allProviders) {
            if (!provider.supportsGallery) continue;
            const linkInfo = provider.getLinkInfo(character);
            if (linkInfo?.id) {
                galleryProvider = provider;
                providerLinkInfo = linkInfo;
                break;
            }
        }
    }

    // External gallery page URLs (bypass settings gate when phases are explicitly specified)
    const bypassSettingsGates = !!restrictPhases;
    const includeExtGalleries = bypassSettingsGates || getSetting('includeExternalGalleries') !== false;
    if (includeExtGalleries) await window.ensureExtractorsLoaded?.();
    let galleryPageUrls;
    if (overrideGalleryPages !== undefined) {
        galleryPageUrls = overrideGalleryPages || [];
    } else if (includeExtGalleries && typeof window.findCharacterGalleryUrls === 'function') {
        galleryPageUrls = window.findCharacterGalleryUrls(character);
    } else {
        galleryPageUrls = [];
    }

    // Settings
    const includeProviderGallery = bypassSettingsGates || getSetting('includeProviderGallery') !== false;
    const includeLorebook = lorebookUrls.length > 0; // findCharacterMediaUrls already gates on setting

    // Early exit: nothing to do
    const hasEmbedded = phaseAllowed('embedded') && embeddedUrls.length > 0;
    const hasLorebook = phaseAllowed('lorebook') && includeLorebook;
    const hasProviderGallery = phaseAllowed('providerGallery') && includeProviderGallery && galleryProvider;
    const hasExtGallery = phaseAllowed('extGallery') && includeExtGalleries && galleryPageUrls.length > 0;

    if (!hasEmbedded && !hasLorebook && !hasProviderGallery && !hasExtGallery) {
        return result;
    }

    // The card's own archive id -- every phase below downloads through the
    // server route, which resolves the gallery folder from this itself
    // (docs/PHASE_3C_PLAN.md §3), so it's what the phases need, not folderName.
    const cardId = character.avatar;

    const sharedOpts = { shouldAbort, abortSignal: signal };

    // Phase 1: Embedded media
    if (hasEmbedded && !isAborted()) {
        onPhaseStart?.('embedded', { count: embeddedUrls.length });
        const r = await downloadEmbeddedMediaForCharacter(cardId, embeddedUrls, {
            ...sharedOpts,
            prefix: 'localized_media',
            phase: 'embedded',
            onProgress: onProgress ? (cur, tot) => onProgress('embedded', cur, tot) : undefined,
            onLog
        });
        result.embedded = { success: r.success, skipped: r.skipped, errors: r.errors, renamed: 0, filenameSkipped: 0 };
        onPhaseEnd?.('embedded', result.embedded);
        if (r.aborted) { result.aborted = true; return sumTotals(result); }
    }

    // Phase 2: Lorebook media
    if (hasLorebook && !isAborted()) {
        onPhaseStart?.('lorebook', { count: lorebookUrls.length });
        const r = await downloadEmbeddedMediaForCharacter(cardId, lorebookUrls, {
            ...sharedOpts,
            prefix: 'lorebook_media',
            phase: 'lorebook',
            onProgress: onProgress ? (cur, tot) => onProgress('lorebook', cur, tot) : undefined,
            onLog
        });
        result.lorebook = { success: r.success, skipped: r.skipped, errors: r.errors, renamed: 0, filenameSkipped: 0 };
        onPhaseEnd?.('lorebook', result.lorebook);
        if (r.aborted) { result.aborted = true; return sumTotals(result); }
    }

    // Phase 3: Provider gallery
    if (hasProviderGallery && !isAborted()) {
        const providerLabel = galleryProvider.name || 'Provider';
        result.providerGallery.providerName = providerLabel;
        onPhaseStart?.('providerGallery', { provider: providerLabel, linkInfo: providerLinkInfo });
        try {
            const r = await galleryProvider.downloadGallery(providerLinkInfo, cardId, {
                ...sharedOpts,
                onProgress: onProgress ? (cur, tot) => onProgress('providerGallery', cur, tot) : undefined,
                onLog
            });
            result.providerGallery.success = r.success || 0;
            result.providerGallery.skipped = r.skipped || 0;
            result.providerGallery.errors = r.errors || 0;
            result.providerGallery.filenameSkipped = r.filenameSkipped || 0;
            onPhaseEnd?.('providerGallery', result.providerGallery);
            if (r.aborted) { result.aborted = true; return sumTotals(result); }
        } catch (error) {
            console.error('[MediaPipeline] Provider gallery error:', error);
            result.providerGallery.errors++;
            onPhaseEnd?.('providerGallery', result.providerGallery);
        }
    } else if (phaseAllowed('providerGallery') && galleryProvider && !includeProviderGallery) {
        result.providerGallery.providerName = galleryProvider.name || 'Provider';
    }

    // Phase 4: External galleries
    if (hasExtGallery && !isAborted()) {
        onPhaseStart?.('extGallery', { count: galleryPageUrls.length });
        const r = await downloadExternalGalleryForCharacter(character, cardId, {
            ...sharedOpts,
            galleryPageUrls,
            onProgress: onProgress ? (cur, tot) => onProgress('extGallery', cur, tot) : undefined,
            onLog
        });
        result.extGallery = { success: r.success || 0, skipped: r.skipped || 0, errors: r.errors || 0, renamed: 0, filenameSkipped: 0 };
        onPhaseEnd?.('extGallery', result.extGallery);
        if (r.aborted) { result.aborted = true; return sumTotals(result); }
    }

    if (isAborted()) result.aborted = true;
    return sumTotals(result);
}

function sumTotals(result) {
    result.totals = {
        success: result.embedded.success + result.lorebook.success + result.providerGallery.success + result.extGallery.success,
        skipped: result.embedded.skipped + result.lorebook.skipped + result.providerGallery.skipped + result.extGallery.skipped,
        errors: result.embedded.errors + result.lorebook.errors + result.providerGallery.errors + result.extGallery.errors
    };
    result.incomplete = result.totals.errors > 0;
    return result;
}


// Convenience wrappers for localize log
function addLocalizeLogEntry(message, status = 'pending') {
    return addLogEntry(localizeLog, message, status);
}

function updateLocalizeLogEntry(entry, message, status) {
    updateLogEntryStatus(entry, message, status);
}

// Localize Media Modal Elements
const localizeModal = document.getElementById('localizeModal');
const closeLocalizeModal = document.getElementById('closeLocalizeModal');
const closeLocalizeBtn = document.getElementById('closeLocalizeBtn');
const localizeStatus = document.getElementById('localizeStatus');
const localizeProgress = document.getElementById('localizeProgress');
const localizeProgressCount = document.getElementById('localizeProgressCount');
const localizeProgressFill = document.getElementById('localizeProgressFill');
const localizeLog = document.getElementById('localizeLog');
const localizeMediaBtn = document.getElementById('localizeMediaBtn');
let localizeAbortController = null;

// Close localize modal handlers
function closeLocalizeModalHandler() {
    localizeAbortController?.abort();
    localizeAbortController = null;
    localizeModal.classList.remove('visible');
}
closeLocalizeModal?.addEventListener('click', closeLocalizeModalHandler);
closeLocalizeBtn?.addEventListener('click', closeLocalizeModalHandler);

// Localize Media button click handler (embedded media + linked provider gallery)
localizeMediaBtn?.addEventListener('click', async () => {
    if (!activeChar) {
        showToast('No character selected', 'error');
        return;
    }
    
    // Show modal
    localizeModal.classList.add('visible');
    localizeStatus.textContent = 'Scanning character...';
    localizeLog.innerHTML = '';
    localizeProgressFill.style.width = '0%';
    localizeProgressCount.textContent = '0/0';
    
    const folderName = getGalleryFolderName(activeChar);
    const phasesStarted = new Set();
    let isFirstPhase = true;
    let totalUrlCount = 0;
    const phaseDone = { embedded: 0, lorebook: 0, providerGallery: 0, extGallery: 0 };
    const phaseTotal = { embedded: 0, lorebook: 0, providerGallery: 0, extGallery: 0 };

    const updateProgressBar = () => {
        const allDone = phaseDone.embedded + phaseDone.lorebook + phaseDone.providerGallery + phaseDone.extGallery;
        localizeProgressFill.style.width = `${totalUrlCount > 0 ? (allDone / totalUrlCount) * 100 : 0}%`;
        localizeProgressCount.textContent = `${allDone}/${totalUrlCount}`;
    };
    
    localizeAbortController = new AbortController();

    const result = await downloadCharacterMedia(activeChar, folderName, {
        signal: localizeAbortController.signal,
        onPhaseStart: (phase, ctx) => {
            if (!isFirstPhase) addLocalizeLogEntry('', 'divider');
            isFirstPhase = false;
            phasesStarted.add(phase);
            
            if (phase === 'embedded') {
                phaseTotal.embedded = ctx.count;
                totalUrlCount += ctx.count;
                addLocalizeLogEntry(`Embedded Media (${ctx.count} URL(s) found)`, 'info');
                localizeStatus.textContent = `Downloading ${ctx.count} embedded media file(s)...`;
                updateProgressBar();
            } else if (phase === 'lorebook') {
                phaseTotal.lorebook = ctx.count;
                totalUrlCount += ctx.count;
                addLocalizeLogEntry(`Lorebook Media (${ctx.count} URL(s) found)`, 'info');
                localizeStatus.textContent = `Downloading ${ctx.count} lorebook media file(s)...`;
                updateProgressBar();
            } else if (phase === 'providerGallery') {
                addLocalizeLogEntry(`${ctx.provider} Gallery (${ctx.linkInfo?.fullPath || ctx.linkInfo?.id || ''})`, 'info');
                localizeStatus.textContent = `Downloading ${ctx.provider} gallery...`;
            } else if (phase === 'extGallery') {
                addLocalizeLogEntry(`External Galleries (${ctx.count} URL(s) found)`, 'info');
                localizeStatus.textContent = 'Extracting external gallery images...';
            }
        },
        onPhaseEnd: (phase, phaseResult) => {
            const { success, skipped, errors } = phaseResult;
            if (phase === 'providerGallery') {
                if (success > 0) {
                    addLocalizeLogEntry(`  ✓ ${success} downloaded, ${skipped} skipped, ${errors} failed`, 'success');
                } else if (skipped > 0) {
                    addLocalizeLogEntry(`  ✓ ${skipped} already exist`, 'info');
                } else if (errors > 0) {
                    addLocalizeLogEntry(`  ✗ Download failed`, 'error');
                } else {
                    addLocalizeLogEntry('  No gallery images found', 'info');
                }
            } else if (phase === 'extGallery') {
                if (success > 0) {
                    addLocalizeLogEntry(`  ✓ ${success} downloaded, ${skipped} skipped, ${errors} failed`, 'success');
                } else if (skipped > 0) {
                    addLocalizeLogEntry(`  ✓ ${skipped} already exist`, 'info');
                } else if (errors > 0) {
                    addLocalizeLogEntry(`  ✗ ${errors} failed`, 'error');
                } else {
                    addLocalizeLogEntry('  No images resolved from external galleries', 'info');
                }
            } else {
                if (success > 0) {
                    addLocalizeLogEntry(`  ✓ ${success} downloaded, ${skipped} skipped, ${errors} failed`, 'success');
                } else if (skipped > 0) {
                    addLocalizeLogEntry(`  ✓ ${skipped} already exist`, 'info');
                } else if (errors > 0) {
                    addLocalizeLogEntry(`  ✗ ${errors} failed to download`, 'error');
                }
            }
        },
        onProgress: (phase, current, total) => {
            phaseDone[phase] = current;
            if ((phase === 'providerGallery' || phase === 'extGallery') && phaseTotal[phase] === 0 && total > 0) {
                phaseTotal[phase] = total;
                totalUrlCount += total;
            }
            updateProgressBar();
        },
        onLog: (message, status) => addLocalizeLogEntry(message, status),
        onLogUpdate: (entry, message, status) => updateLocalizeLogEntry(entry, message, status)
    });
    
    // Show "not found" messages for phases that didn't start
    if (!phasesStarted.has('embedded')) {
        addLocalizeLogEntry('Embedded Media: none found in character card', 'info');
        isFirstPhase = false;
    }
    if (!phasesStarted.has('providerGallery')) {
        if (!isFirstPhase) addLocalizeLogEntry('', 'divider');
        isFirstPhase = false;
        if (result.providerGallery.providerName) {
            addLocalizeLogEntry(`${result.providerGallery.providerName} Gallery`, 'info');
            addLocalizeLogEntry('  ⚠ Skipped: disabled in settings (Include Gallery)', 'warning');
        } else {
            addLocalizeLogEntry('Provider Gallery: not available for this character', 'info');
        }
    }
    
    // Final status
    localizeAbortController = null;

    if (result.aborted) {
        localizeStatus.textContent = 'Stopped.';
        if (result.totals.success > 0) {
            showToast(`Stopped. Downloaded ${result.totals.success} file(s) before stopping.`, 'warning');
            if (activeChar?.avatar) clearMediaLocalizationCache(activeChar.avatar);
            if (activeChar) fetchCharacterImages(activeChar);
        }
        return;
    }

    const { totals } = result;
    const totalRenamed = (result.embedded.renamed || 0) + (result.lorebook.renamed || 0);
    let statusMsg = '';
    if (totals.success > 0) statusMsg = `Downloaded ${totals.success} file(s)`;
    if (totalRenamed > 0) statusMsg += (statusMsg ? ', ' : '') + `renamed ${totalRenamed} file(s)`;
    if (totals.skipped > 0) statusMsg += (statusMsg ? ', ' : '') + `${totals.skipped} existed`;
    if (totals.errors > 0) statusMsg += (statusMsg ? ', ' : '') + `${totals.errors} failed`;
    localizeStatus.textContent = statusMsg || 'No new files to download.';
    
    if (totals.success > 0 || totalRenamed > 0) {
        const msg = totalRenamed > 0
            ? `Downloaded ${totals.success}, renamed ${totalRenamed} file(s)`
            : `Downloaded ${totals.success} new media file(s)`;
        showToast(msg, 'success');
        if (activeChar?.avatar) clearMediaLocalizationCache(activeChar.avatar);
        if (activeChar) fetchCharacterImages(activeChar);
    } else if (totals.skipped > 0 && totals.errors === 0) {
        showToast('All files already exist', 'info');
    } else if (totals.errors > 0) {
        showToast('Some downloads failed', 'error');
    }
});

