// ========================================
// UPDATE LOCK
// ========================================

function isUpdateLocked(char) {
    return !!char?.data?.extensions?.update_locked;
}

async function setUpdateLocked(avatar, locked) {
    const success = await window.applyCardFieldUpdates(avatar, {
        'extensions.update_locked': !!locked,
    });
    if (!success) throw new Error('Failed to save update lock');
}

/**
 * Apply the selected links via the active provider
 */
async function applyBulkAutoLinks() {
    const applyBtn = document.getElementById('bulkAutoLinkApplyBtn');
    applyBtn.disabled = true;
    applyBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Linking...';
    
    const registry = window.ProviderRegistry;
    let successCount = 0;
    let errorCount = 0;
    
    try {
        // Process confident matches
        for (const item of bulkAutoLinkResults.confident) {
            if (!item.selected) continue;
            
            const selectedResult = item.options[item.selectedOption] || item.bestMatch;
            const provider = registry?.getProvider(selectedResult.providerId);
            if (!provider) { errorCount++; continue; }
            
            try {
                let resultId = selectedResult.id;
                if (!resultId && provider.fetchMetadata) {
                    const metadata = await provider.fetchMetadata(selectedResult.fullPath);
                    resultId = metadata?.id;
                }
                
                debugLog('[bulkAutoLink] Linking', item.char.name, 'to', selectedResult.fullPath, `(${provider.name})`);
                await saveProviderLink(item.char, provider, {
                    id: resultId,
                    fullPath: selectedResult.fullPath,
                    pageName: selectedResult.name || null,
                });
                successCount++;
                debugLog('[bulkAutoLink] Successfully linked', item.char.name);
            } catch (err) {
                console.error('[bulkAutoLink] Link error for', item.char.name, ':', err);
                errorCount++;
            }
            
            // Small delay to avoid hammering the API
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        // Process uncertain matches with selections
        for (const item of bulkAutoLinkResults.uncertain) {
            if (item.selectedOption === null) continue;
            
            const selectedResult = item.options[item.selectedOption];
            const provider = registry?.getProvider(selectedResult.providerId);
            if (!provider) { errorCount++; continue; }
            
            try {
                let resultId = selectedResult.id;
                if (!resultId && provider.fetchMetadata) {
                    const metadata = await provider.fetchMetadata(selectedResult.fullPath);
                    resultId = metadata?.id;
                }
                
                debugLog('[bulkAutoLink] Linking', item.char.name, 'to', selectedResult.fullPath, `(${provider.name})`);
                await saveProviderLink(item.char, provider, {
                    id: resultId,
                    fullPath: selectedResult.fullPath,
                    pageName: selectedResult.name || null,
                });
                successCount++;
                debugLog('[bulkAutoLink] Successfully linked', item.char.name);
            } catch (err) {
                console.error('[bulkAutoLink] Link error for', item.char.name, ':', err);
                errorCount++;
            }
            
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    } catch (outerErr) {
        console.error('[bulkAutoLink] Outer error:', outerErr);
    }
    
    // Show result
    if (errorCount > 0) {
        showToast(`Linked ${successCount} characters (${errorCount} errors)`, 'info');
    } else if (successCount > 0) {
        showToast(`Successfully linked ${successCount} characters!`, 'success');
    } else {
        showToast('No characters were linked', 'info');
    }
    
    // Close modal
    document.getElementById('bulkAutoLinkModal').classList.remove('visible');
    
    // Reset state since we linked characters - they're no longer in the unlinked pool
    bulkAutoLinkResults = { confident: [], uncertain: [], nomatch: [] };
    bulkAutoLinkScanState = { scannedAvatars: new Set(), scanComplete: false, lastUnlinkedCount: 0 };
    
    // Rebuild lookup
    window.ProviderRegistry?.rebuildAllBrowseLookups?.();
    
    // Reset button state in case modal is reopened
    applyBtn.disabled = false;
    applyBtn.innerHTML = '<i class="fa-solid fa-link"></i> Link Selected (<span id="bulkAutoLinkSelectedCount">0</span>)';
}

// Event handlers for Bulk Auto-Link
window.openBulkAutoLinkModal = openBulkAutoLinkModal;
document.getElementById('bulkAutoLinkBtn')?.addEventListener('click', openBulkAutoLinkModal);
document.getElementById('closeBulkAutoLinkModal')?.addEventListener('click', () => {
    // Just set abort flag and close - state is preserved for resuming
    bulkAutoLinkAborted = true;
    document.getElementById('bulkAutoLinkModal').classList.remove('visible');
});
document.getElementById('bulkAutoLinkCancelBtn')?.addEventListener('click', () => {
    // If we're in scanning phase, just stop (let the scan loop show results)
    // If we're in results phase, close the modal
    const resultsPhase = document.getElementById('bulkAutoLinkResults');
    if (resultsPhase && !resultsPhase.classList.contains('hidden')) {
        // Results phase - close modal
        document.getElementById('bulkAutoLinkModal').classList.remove('visible');
    } else {
        // Scanning phase - just set abort flag, scan loop will handle showing results
        bulkAutoLinkAborted = true;
        document.getElementById('bulkAutoLinkScanStatus').textContent = 'Stopping...';
    }
});
document.getElementById('bulkAutoLinkApplyBtn')?.addEventListener('click', applyBulkAutoLinks);

// Delegated handlers for bulk auto-link results
document.getElementById('bulkAutoLinkResults')?.addEventListener('click', (e) => {
    const tab = e.target.closest('.bulk-auto-link-tab');
    if (tab) { switchBulkAutoLinkTab(tab.dataset.tab); return; }

    if (e.target.closest('.bulk-auto-link-select-all')) { bulkAutoLinkSelectAll(); return; }
    if (e.target.closest('.bulk-auto-link-deselect-all')) { bulkAutoLinkDeselectAll(); return; }

    if (e.target.classList.contains('bulk-auto-link-item-checkbox')) return;

    const option = e.target.closest('.bulk-auto-link-option');
    if (option) {
        const itemIdx = parseInt(option.dataset.itemIdx);
        const optIdx = parseInt(option.dataset.optIdx);
        const item = option.closest('.bulk-auto-link-item');
        if (item?.classList.contains('bulk-auto-link-item-confident')) {
            selectBulkAutoLinkConfidentOption(itemIdx, optIdx);
        } else if (item?.classList.contains('bulk-auto-link-item-uncertain')) {
            selectBulkAutoLinkOption(itemIdx, optIdx);
        }
        return;
    }

    if (e.target.closest('.bulk-auto-link-item-confident-header')) {
        const idx = parseInt(e.target.closest('.bulk-auto-link-item')?.dataset.idx);
        if (!isNaN(idx)) toggleBulkAutoLinkConfidentExpand(idx);
        return;
    }

    if (e.target.closest('.bulk-auto-link-item-uncertain-header')) {
        const idx = parseInt(e.target.closest('.bulk-auto-link-item')?.dataset.idx);
        if (!isNaN(idx)) toggleBulkAutoLinkExpand(idx);
        return;
    }
});

document.getElementById('bulkAutoLinkResults')?.addEventListener('change', (e) => {
    if (!e.target.classList.contains('bulk-auto-link-item-checkbox')) return;
    const item = e.target.closest('.bulk-auto-link-item');
    const idx = parseInt(item?.dataset.idx);
    if (isNaN(idx)) return;

    if (item.classList.contains('bulk-auto-link-item-confident')) {
        toggleBulkAutoLinkItem('confident', idx);
    } else if (item.classList.contains('bulk-auto-link-item-uncertain')) {
        clearBulkAutoLinkSelection(idx, e.target);
    }
});

