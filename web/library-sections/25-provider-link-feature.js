// ==============================================
// Provider Link Feature
// ==============================================

/**
 * Update the provider link indicator in the modal (generic — any provider)
 * @param {Object} char - Character object
 */
/** Whether char's data.extensions are trustworthy right now. */
function extensionsReady(char) {
    if (!char) return true;
    if (!char._slim) return true;
    if (!window.stShallowMode) return true;
    return _extensionsCache.has(char.avatar);
}

/** Provider-link indicator loading state while shallow extensions are fetched. */
function setProviderLinkIndicatorLoading() {
    const indicator = document.getElementById('providerLinkIndicator');
    if (!indicator) return;
    indicator.classList.remove('linked');
    indicator.style.pointerEvents = 'none';
    indicator.title = 'Loading link status...';
    delete indicator.dataset.providerId;
    const textSpan = indicator.querySelector('.provider-link-text');
    if (textSpan) textSpan.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    const toggle = document.getElementById('namePreferenceToggle');
    if (toggle) toggle.classList.add('hidden'); // listing name unknown until hydrate
}

function updateProviderLinkIndicator(char) {
    const indicator = document.getElementById('providerLinkIndicator');
    if (!indicator) return;
    indicator.style.pointerEvents = '';

    const result = window.ProviderRegistry?.getCharacterProvider(char) || null;
    const textSpan = indicator.querySelector('.provider-link-text');
    const locked = isUpdateLocked(char);
    
    if (result) {
        const { provider, linkInfo } = result;
        indicator.classList.add('linked');
        indicator.title = `Linked to ${provider.name}: ${linkInfo.fullPath}`;
        indicator.dataset.providerId = provider.id;
        const lockIcon = locked ? ' <i class="fa-solid fa-lock provider-link-lock-icon" title="Updates locked"></i>' : '';
        if (textSpan) {
            textSpan.innerHTML = `<i class="provider-link-icon ${escapeHtml(provider.icon)}"></i><span class="provider-link-name">${escapeHtml(provider.name)}</span> <i class="fa-solid fa-check"></i>${lockIcon}`;
        }
    } else {
        indicator.classList.remove('linked');
        indicator.title = 'Click to link to a provider';
        delete indicator.dataset.providerId;
        if (textSpan) {
            textSpan.innerHTML = '<span class="provider-link-name">Link</span>';
        }
    }
    
    updateNamePreferenceToggle(char);
}

function updateNamePreferenceToggle(char) {
    const toggle = document.getElementById('namePreferenceToggle');
    if (!toggle) return;
    
    const listingName = getListingNameFromExtensions(char);
    const label = toggle.querySelector('.name-pref-label');
    
    if (!listingName) {
        toggle.classList.add('hidden');
        return;
    }
    
    if (!getSetting('showNameToggle')) {
        toggle.classList.add('hidden');
        return;
    }
    
    const cardName = char.name || char.data?.name || '';
    if (listingName.toLowerCase() === cardName.toLowerCase()) {
        toggle.classList.add('hidden');
        return;
    }
    
    toggle.classList.remove('hidden');
    const prefs = getSetting('namePreferences') || {};
    const pref = prefs[char.avatar] || null;
    const isListing = pref === 'listing' || (!pref && getSetting('displayNamePreference') === 'listing');
    
    toggle.classList.toggle('active', isListing);
    const hasOverride = !!(prefs[char.avatar]) && prefs[char.avatar] !== (getSetting('displayNamePreference') || 'card');
    toggle.classList.toggle('override', hasOverride);
    if (label) label.textContent = isListing ? 'Listing' : 'Card';
    toggle.title = isListing
        ? `Showing listing name "${listingName}". Click to use card name "${cardName}".`
        : `Showing card name. Click to use listing name "${listingName}".`;
}

let _isTogglingNamePref = false;
async function toggleCharNamePreference(char) {
    if (!char?.avatar || _isTogglingNamePref) return;
    _isTogglingNamePref = true;
    
    try {
        const prefs = { ...(getSetting('namePreferences') || {}) };
        const current = prefs[char.avatar] || null;
        const globalPref = getSetting('displayNamePreference') || 'card';
        
        let newPref;
        if (current === 'listing') {
            newPref = 'card';
        } else if (current === 'card') {
            newPref = 'listing';
        } else {
            newPref = globalPref === 'listing' ? 'card' : 'listing';
        }
        
        if (newPref === globalPref) {
            delete prefs[char.avatar];
        } else {
            prefs[char.avatar] = newPref;
        }
        setSetting('namePreferences', prefs);
        
        updateNamePreferenceToggle(char);
        
        const headerName = document.querySelector('#charModal .modal-header h2');
        if (headerName) headerName.textContent = getCharacterName(char);
        
        performSearch();
    } finally {
        _isTogglingNamePref = false;
    }
}

// Tracks which provider the link modal is currently showing
let linkModalActiveProvider = null;

// Session-sticky source filter for the link-modal name search ('all' or a provider id)
let linkSearchSourceFilter = 'all';

/**
 * Open the provider link modal (works for any provider, not just ChubAI)
 * @param {Object} [char] - Character to link (sets activeChar if provided)
 */
function openProviderLinkModal(char) {
    if (char) activeChar = char;
    if (!activeChar) return;
    
    const modal = document.getElementById('providerLinkModal');
    const linkedState = document.getElementById('providerLinkLinkedState');
    const unlinkedState = document.getElementById('providerLinkUnlinkedState');
    const titleEl = document.getElementById('providerLinkModalTitle');
    const searchResults = document.getElementById('providerLinkSearchResults');
    
    // Populate sidebar with character info
    const avatarEl = document.getElementById('providerLinkCharAvatar');
    const charNameEl = document.getElementById('providerLinkCharName');
    const charName = getCharacterName(activeChar) || 'Character';
    
    if (avatarEl) {
        avatarEl.src = getCharacterAvatarUrl(activeChar.avatar);
        avatarEl.onerror = () => { avatarEl.src = '/img/ai4.png'; };
    }
    if (charNameEl) {
        charNameEl.textContent = charName;
        charNameEl.title = charName;
    }
    
    const statusIcon = document.getElementById('providerLinkStatusIcon');
    
    // Check ALL providers via the registry, not just Chub
    const providerMatch = window.ProviderRegistry?.getCharacterProvider(activeChar) || null;
    const provider = providerMatch?.provider;
    const linkInfo = providerMatch?.linkInfo;
    linkModalActiveProvider = providerMatch;
    
    if (linkInfo && linkInfo.fullPath) {
        // ── Linked state ──
        linkedState.classList.remove('hidden');
        unlinkedState.classList.add('hidden');
        titleEl.textContent = `${provider.name} Link`;
        
        if (statusIcon) {
            statusIcon.className = 'provider-link-status-icon linked';
            statusIcon.innerHTML = '<i class="fa-solid fa-link"></i>';
        }
        
        // Link URL — use provider method if available, else build manually
        const pathEl = document.getElementById('providerLinkCurrentPath');
        if (pathEl) {
            const charUrl = provider.getCharacterUrl?.(linkInfo) || '#';
            pathEl.href = charUrl;
            const pathSpan = pathEl.querySelector('span');
            if (pathSpan) pathSpan.textContent = linkInfo.fullPath;
        }
        
        // Provider-specific button visibility
        const viewBtn = document.getElementById('providerLinkViewInGalleryBtn');
        const galleryBtn = document.getElementById('providerLinkGalleryBtn');
        const versionsBtn = document.getElementById('providerLinkVersionsBtn');
        const statsEl = document.getElementById('providerLinkStats');
        
        if (viewBtn) {
            viewBtn.classList.remove('hidden');
            viewBtn.innerHTML = `<i class="fa-solid fa-eye"></i> View on ${escapeHtml(provider.name)}`;
        }
        if (galleryBtn) galleryBtn.classList.toggle('hidden', !provider.supportsGallery);
        if (versionsBtn) versionsBtn.classList.remove('hidden');
        
        // Fetch live stats from the provider (if supported)
        if (typeof provider.fetchLinkStats === 'function') {
            if (statsEl) {
                const fields = provider.linkStatFields || {};
                const slots = ['stat1', 'stat2', 'stat3'];
                statsEl.innerHTML = slots
                    .filter(k => fields[k])
                    .map(k => `<span><i class="${fields[k].icon}"></i> <span data-stat="${k}">-</span></span>`)
                    .join('');
                statsEl.classList.remove('hidden');
            }
            provider.fetchLinkStats(linkInfo).then(stats => {
                if (!stats || !statsEl) return;
                for (const key of ['stat1', 'stat2', 'stat3']) {
                    const el = statsEl.querySelector(`[data-stat="${key}"]`);
                    if (el) el.textContent = stats[key] != null ? formatNumber(stats[key]) : '-';
                }
            });
        } else {
            if (statsEl) statsEl.classList.add('hidden');
        }

        updateLockToggleUI(isUpdateLocked(activeChar));
        
    } else {
        // ── Unlinked state ──
        linkedState.classList.add('hidden');
        unlinkedState.classList.remove('hidden');
        titleEl.textContent = 'Link to Provider';
        linkModalActiveProvider = null;
        
        if (statusIcon) {
            statusIcon.className = 'provider-link-status-icon unlinked';
            statusIcon.innerHTML = '<i class="fa-solid fa-link-slash"></i>';
        }
        
        const nameInput = document.getElementById('providerLinkSearchName');
        const creatorInput = document.getElementById('providerLinkSearchCreator');
        const urlInput = document.getElementById('providerLinkUrlInput');

        const creator = activeChar.creator || activeChar.data?.creator || '';

        if (nameInput) nameInput.value = charName;
        if (creatorInput) creatorInput.value = creator;
        if (urlInput) urlInput.value = '';
        if (searchResults) searchResults.innerHTML = '';

        // Rebuild the source filter from currently-enabled searchable providers (enablement can change mid-session)
        const sourceSelect = document.getElementById('providerLinkSourceSelect');
        if (sourceSelect) {
            const disabledSet = new Set(getSetting('disabledProviders') || []);
            const searchable = (window.ProviderRegistry?.getAllProviders() || [])
                .filter(p => p.supportsBulkLink && !disabledSet.has(p.id));
            if (linkSearchSourceFilter !== 'all' && !searchable.some(p => p.id === linkSearchSourceFilter)) {
                linkSearchSourceFilter = 'all';
            }
            sourceSelect.innerHTML = '<option value="all">All providers</option>'
                + searchable.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('');
            sourceSelect.value = linkSearchSourceFilter;
            sourceSelect._customSelect?.refresh?.();
            sourceSelect._customSelect?.relockWidth?.();
        }
    }

    modal.classList.add('visible');
}

/**
 * Search all providers for characters matching name/creator.
 * Results are tagged with providerId so linkToSearchResult knows which provider to save with.
 */
async function searchProvidersForLink(name, creator) {
    const resultsContainer = document.getElementById('providerLinkSearchResults');
    if (!resultsContainer) return;
    
    if (!name.trim()) {
        resultsContainer.innerHTML = '<div class="provider-link-search-empty">Enter a character name to search</div>';
        return;
    }
    
    resultsContainer.innerHTML = '<div class="provider-link-search-loading"><i class="fa-solid fa-spinner fa-spin"></i> Searching...</div>';
    
    try {
        const registry = window.ProviderRegistry;
        const disabledSet = new Set(getSetting('disabledProviders') || []);
        const providers = registry ? registry.getAllProviders().filter(p =>
            p.supportsBulkLink && !disabledSet.has(p.id)
            && (linkSearchSourceFilter === 'all' || p.id === linkSearchSourceFilter)) : [];

        if (providers.length === 0) {
            resultsContainer.innerHTML = '<div class="provider-link-search-empty"><i class="fa-solid fa-exclamation-triangle"></i> No providers available</div>';
            return;
        }
        
        // Search all providers in parallel
        const searchPromises = providers.map(async (provider) => {
            try {
                const results = await provider.searchForBulkLink(name.trim(), creator?.trim() || '');
                return results.map(r => ({ ...r, providerId: provider.id, providerName: provider.name }));
            } catch (e) {
                debugLog(`[LinkSearch] ${provider.name} search failed:`, e.message);
                return [];
            }
        });
        
        const allProviderResults = await Promise.all(searchPromises);
        let allResults = allProviderResults.flat();
        
        if (allResults.length === 0) {
            resultsContainer.innerHTML = '<div class="provider-link-search-empty"><i class="fa-solid fa-search"></i> No characters found</div>';
            return;
        }
        
        // Sort by content similarity to the local character
        if (activeChar) {
            allResults = sortResultsByContentSimilarity(allResults, activeChar);
        }
        
        // Render results with provider badge
        resultsContainer.innerHTML = allResults.map(result => {
            const provider = registry.getProvider(result.providerId);
            const avatarUrl = provider?.getResultAvatarUrl?.(result) || result.avatarUrl || '';
            const rating = result.rating ? result.rating.toFixed(1) : '';
            const starCount = result.starCount || 0;
            // Providers whose fullPath is a bare id (janitorai, botbooru, wyvern, pygmalion) have
            // no author segment to split off, so the fallback would print the id as the creator.
            // Use the explicit field when the provider supplies one.
            const creator = result.creator || (result.fullPath || '').split('/')[0];
            
            const statsHtml = [
                rating ? `<span><i class="fa-solid fa-star"></i> ${rating}</span>` : '',
                starCount ? `<span><i class="fa-solid fa-heart"></i> ${formatNumber(starCount)}</span>` : '',
            ].filter(Boolean).join('');
            
            return `
                <div class="provider-link-search-result" data-fullpath="${escapeHtml(result.fullPath)}" data-id="${result.id || ''}" data-provider-id="${escapeHtml(result.providerId)}">
                    <img class="provider-link-search-result-avatar" src="${avatarUrl}" alt="" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><rect fill=%22%23333%22 width=%22100%22 height=%22100%22/><text x=%2250%22 y=%2255%22 text-anchor=%22middle%22 fill=%22%23666%22 font-size=%2240%22>?</text></svg>'">
                    <div class="provider-link-search-result-info">
                        <div class="provider-link-search-result-name">${escapeHtml(result.name || result.fullPath.split('/').pop())}</div>
                        <div class="provider-link-search-result-creator">by ${escapeHtml(creator)} · ${escapeHtml(result.providerName)}</div>
                        <div class="provider-link-search-result-stats">${statsHtml}</div>
                    </div>
                    <button class="action-btn primary small provider-link-search-result-btn">
                        <i class="fa-solid fa-link"></i> Link
                    </button>
                </div>
            `;
        }).join('');
        
    } catch (error) {
        console.error('[LinkSearch] Search error:', error);
        resultsContainer.innerHTML = `<div class="provider-link-search-empty"><i class="fa-solid fa-exclamation-triangle"></i> Search failed: ${error.message}</div>`;
    }
}

/**
 * Link to a character from search results (multi-provider aware)
 */
async function linkToSearchResult(btn) {
    const resultEl = btn.closest('.provider-link-search-result');
    if (!resultEl || !activeChar) return;
    
    const fullPath = resultEl.dataset.fullpath;
    let resultId = resultEl.dataset.id;
    const providerId = resultEl.dataset.providerId;
    
    if (!providerId) {
        showToast('No provider specified for this result', 'error');
        return;
    }
    
    const registry = window.ProviderRegistry;
    const provider = registry?.getProvider(providerId);
    
    if (!provider) {
        showToast('Provider not found', 'error');
        return;
    }
    
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    
    try {
        // Fetch metadata to get numeric ID (needed for gallery, versioning)
        let pageName = null;
        if (!resultId && provider.fetchMetadata) {
            const metadata = await provider.fetchMetadata(fullPath);
            if (metadata) {
                if (metadata.id) resultId = metadata.id;
                pageName = provider.getListingName(metadata);
            }
        }
        
        await saveProviderLink(activeChar, provider, { id: resultId, fullPath, pageName });
        
        showToast(`Linked to ${fullPath} (${provider.name})`, 'success');
        
        updateProviderLinkIndicator(activeChar);
        hideModal('providerLinkModal');
        
    } catch (error) {
        console.error('[LinkSearch] Link error:', error);
        showToast('Failed to save link', 'error');
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-link"></i> Link';
    }
}



/**
 * Link using a pasted URL — tries all providers' canHandleUrl/parseUrl
 */
async function linkToProviderUrl(url) {
    if (!activeChar) return;
    
    const btn = document.getElementById('providerLinkUrlBtn');
    
    const registry = window.ProviderRegistry;

    // Enabled-first tie-break + parse requirement both live in getProviderForUrl now.
    const matchedProvider = registry?.getProviderForUrl(url, { accept: (p) => !!p.parseUrl?.(url) }) || null;
    const parsedPath = matchedProvider?.parseUrl?.(url) || null;

    if (!matchedProvider || !parsedPath) {
        showToast('URL not recognized by any provider', 'error');
        return;
    }
    
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    }
    
    try {
        let resultId = null;
        let pageName = null;
        
        // Fetch metadata to get the project/numeric ID
        if (matchedProvider.fetchMetadata) {
            const metadata = await matchedProvider.fetchMetadata(parsedPath);
            if (metadata) {
                resultId = metadata.id;
                pageName = matchedProvider.getListingName(metadata);
            }
        }
        
        await saveProviderLink(activeChar, matchedProvider, { id: resultId, fullPath: parsedPath, pageName });
        
        showToast(`Linked to ${parsedPath} (${matchedProvider.name})`, 'success');
        
        updateProviderLinkIndicator(activeChar);
        hideModal('providerLinkModal');
        
    } catch (error) {
        console.error('[LinkSearch] URL link error:', error);
        showToast(`Failed to link: ${error.message}`, 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-link"></i> Link';
        }
    }
}

/**
 * Unlink character from the active provider
 */
async function unlinkFromProvider() {
    if (!activeChar) return;
    
    const btn = document.getElementById('providerLinkUnlinkBtn');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    }
    
    try {
        const match = linkModalActiveProvider || window.ProviderRegistry?.getCharacterProvider(activeChar);
        const provider = match?.provider;
        if (!provider) throw new Error('No provider found for this character');

        // Non-blocking auto-snapshot before unlink (destructive, restore is the only undo).

        // Capture provider display metadata before setLinkInfo wipes it, so it survives as CL-owned fallback.
        const provTagline = activeChar.data?.extensions?.[provider.id]?.tagline;
        const provPageName = activeChar.data?.extensions?.[provider.id]?.pageName;

        // Drop the provider namespace in-memory so reads see unlinked state before the round-trip completes.
        provider.setLinkInfo(activeChar, null);
        const charInArray = allCharacters.find(c => c.avatar === activeChar.avatar);
        if (charInArray && charInArray !== activeChar) {
            provider.setLinkInfo(charInArray, null);
        }

        // Sentinel-delete the provider namespace; migrate display metadata into cl only where cl is empty (dont clobber user values).
        const existingCl = activeChar.data?.extensions?.cl;
        const updates = { [`extensions.${provider.id}`]: ST_UNSET_SENTINEL };
        if (provTagline && !(existingCl && 'tagline' in existingCl)) {
            updates['extensions.cl.tagline'] = provTagline;
        }
        if (provPageName && !(existingCl && 'pageName' in existingCl)) {
            updates['extensions.cl.pageName'] = provPageName;
        }

        const success = await window.applyCardFieldUpdates(activeChar.avatar, updates);
        if (!success) throw new Error('Failed to save unlink');

        // Recompute the listing-name + tagline search keys on both refs: CL-side state outside char.data, so the helper's write doesnt touch it.
        for (const c of [activeChar, charInArray].filter(Boolean)) {
            const ln = getListingNameFromExtensions(c);
            c._lowerListingName = ln ? ln.toLowerCase() : '';
            c._lowerTagline = getDisplayTagline(c).toLowerCase();
        }

        showToast(`Unlinked from ${provider.name}`, 'info');

        updateProviderLinkIndicator(activeChar);
        openProviderLinkModal();
        
    } catch (error) {
        console.error('[Link] Unlink error:', error);
        showToast('Failed to unlink', 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-unlink"></i> Unlink';
        }
    }
}

/**
 * View character on linked provider — uses the provider's capability flags
 * to open an in-app preview or fall back to an external URL
 */
async function viewOnLinkedProvider() {
    if (!activeChar) {
        debugLog('[Link] viewOnLinkedProvider: no activeChar');
        return;
    }
    
    const match = linkModalActiveProvider || window.ProviderRegistry?.getCharacterProvider(activeChar);
    const provider = match?.provider;
    const linkInfo = match?.linkInfo;
    
    if (!provider || !linkInfo?.fullPath) {
        showToast('Not linked to any provider', 'error');
        return;
    }
    
    if (!provider.supportsInAppPreview) {
        const url = provider.getCharacterUrl?.(linkInfo);
        if (url) window.open(url, '_blank');
        else showToast(`No URL available for ${provider.name}`, 'error');
        return;
    }
    
    hideModal('providerLinkModal');
    hideModal('charModal');
    showToast(`Loading character from ${provider.name}...`, 'info');
    
    try {
        const previewObj = await provider.buildPreviewObject(activeChar, linkInfo);
        if (!previewObj) {
            showToast(`Character not found on ${provider.name}`, 'error');
            return;
        }

        // Ensure the provider's modals exist in the DOM before switching views
        provider.browseView?.injectModals();

        // Set this provider as the target so switchView activates it
        lastOnlineProviderId = provider.id;
        switchView('online');

        // Allow DOM to settle after view switch, then open the preview
        requestAnimationFrame(() => {
            provider.openPreview(previewObj);
        });
    } catch (error) {
        console.error(`[${provider.id}] Failed to open preview:`, error);
        showToast(`Failed to load ${provider.name} character preview`, 'error');
    }
}

/**
 * Download gallery for linked character (uses provider abstraction)
 */
async function downloadLinkedGallery() {
    if (!activeChar) return;
    
    // Find a provider with gallery support linked to this character
    let galleryProvider = null;
    let linkInfo = null;
    const providers = window.ProviderRegistry?.getAllProviders() || [];
    for (const provider of providers) {
        if (!provider.supportsGallery) continue;
        const li = provider.getLinkInfo(activeChar);
        if (li?.id) {
            galleryProvider = provider;
            linkInfo = li;
            break;
        }
    }
    
    if (!galleryProvider || !linkInfo) {
        showToast('Not linked to any provider with gallery support', 'error');
        return;
    }
    
    const btn = document.getElementById('providerLinkGalleryBtn');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Downloading...';
    }
    
    try {
        const characterName = getCharacterName(activeChar, 'unknown');
        // Use character object to get unique folder name if available
        const folderName = getGalleryFolderName(activeChar);
        const result = await galleryProvider.downloadGallery(linkInfo, folderName, {});
        
        if (result.success > 0) {
            showToast(`Downloaded ${result.success} gallery image${result.success > 1 ? 's' : ''}`, 'success');
            // Refresh gallery - pass character object for unique folder support
            fetchCharacterImages(activeChar);
        } else if (result.skipped > 0) {
            showToast('All gallery images already exist', 'info');
        } else {
            showToast('No gallery images found', 'info');
        }
        
    } catch (error) {
        console.error('[ChubLink] Gallery download error:', error);
        showToast('Failed to download gallery', 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-images"></i> Download Gallery';
        }
    }
}

// Provider Link Indicator — opens the appropriate provider's link UI
on('providerLinkIndicator', 'click', () => {
    if (!activeChar) return;
    const indicator = document.getElementById('providerLinkIndicator');
    const linkedProviderId = indicator?.dataset?.providerId;
    const registry = window.ProviderRegistry;

    if (linkedProviderId && registry) {
        // Already linked — open that provider's link UI
        const provider = registry.getProvider(linkedProviderId);
        if (provider?.openLinkUI) {
            provider.openLinkUI(activeChar);
            return;
        }
    }

    // Not linked — default to Chub link modal (primary provider)
    openProviderLinkModal();
});

on('namePreferenceToggle', 'click', () => {
    if (activeChar) toggleCharNamePreference(activeChar);
});

on('closeProviderLinkModal', 'click', () => {
    linkModalActiveProvider?.provider?.clearCachedLinkNode?.();
    hideModal('providerLinkModal');
});

on('providerLinkSearchBtn', 'click', () => {
    const name = document.getElementById('providerLinkSearchName')?.value || '';
    const creator = document.getElementById('providerLinkSearchCreator')?.value || '';
    searchProvidersForLink(name, creator);
});

document.getElementById('providerLinkSearchResults')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.provider-link-search-result-btn');
    if (btn) linkToSearchResult(btn);
});

// Allow Enter key to search
document.getElementById('providerLinkSearchName')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        document.getElementById('providerLinkSearchBtn')?.click();
    }
});

document.getElementById('providerLinkSearchCreator')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        document.getElementById('providerLinkSearchBtn')?.click();
    }
});

on('providerLinkUrlBtn', 'click', () => {
    const url = document.getElementById('providerLinkUrlInput')?.value || '';
    if (url.trim()) {
        linkToProviderUrl(url.trim());
    } else {
        showToast('Please enter a character URL', 'info');
    }
});

document.getElementById('providerLinkUrlInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        document.getElementById('providerLinkUrlBtn')?.click();
    }
});

document.getElementById('providerLinkSourceSelect')?.addEventListener('change', (e) => {
    linkSearchSourceFilter = e.target.value || 'all';
    // Live-refilter only when results are already showing; a pre-search change just applies later.
    const name = document.getElementById('providerLinkSearchName')?.value || '';
    if (name.trim() && document.getElementById('providerLinkSearchResults')?.childElementCount) {
        searchProvidersForLink(name, document.getElementById('providerLinkSearchCreator')?.value || '');
    }
});

on('providerLinkViewInGalleryBtn', 'click', viewOnLinkedProvider);
on('providerLinkGalleryBtn', 'click', downloadLinkedGallery);
on('providerLinkUnlinkBtn', 'click', unlinkFromProvider);

// Update Lock toggle in provider link modal
function updateLockToggleUI(locked) {
    const btn = document.getElementById('providerLinkUpdateLockBtn');
    if (!btn) return;
    const statusSpan = btn.querySelector('.update-lock-status');
    const toggleIcon = btn.querySelector('.update-lock-toggle-icon');
    if (statusSpan) statusSpan.textContent = locked ? 'Locked' : 'Unlocked';
    if (toggleIcon) {
        toggleIcon.className = locked
            ? 'fa-solid fa-toggle-on update-lock-toggle-icon'
            : 'fa-solid fa-toggle-off update-lock-toggle-icon';
    }
    btn.classList.toggle('active', locked);
}

on('providerLinkUpdateLockBtn', 'click', async () => {
    if (!activeChar) return;
    const newState = !isUpdateLocked(activeChar);
    try {
        await setUpdateLocked(activeChar.avatar, newState);
        updateLockToggleUI(newState);
        updateProviderLinkIndicator(activeChar);
        showToast(newState ? 'Updates locked for this character' : 'Updates unlocked', newState ? 'info' : 'success');
    } catch (err) {
        console.error('[UpdateLock] Failed to toggle:', err);
        showToast('Failed to save update lock', 'error');
    }
});

// Version History button in provider link modal
on('providerLinkVersionsBtn', 'click', () => {
    if (activeChar) {
        // Close the link modal, then switch to the Versions tab
        const linkModal = document.getElementById('providerLinkModal');
        if (linkModal) linkModal.classList.remove('visible');
        const editVBtn = document.getElementById('editPaneVersionsBtn');
        if (editVBtn) editVBtn.click();
    }
});

