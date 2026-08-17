// ============================================================
// Settings migrations
// ============================================================

function migrateSettings() {
    if (gallerySettings.includeChubGallery !== undefined) {
        gallerySettings.includeProviderGallery = gallerySettings.includeChubGallery;
        delete gallerySettings.includeChubGallery;
        saveGallerySettings();
    }
    if ('showChubTagline' in gallerySettings) {
        gallerySettings.showProviderTagline = gallerySettings.showChubTagline;
        delete gallerySettings.showChubTagline;
        saveGallerySettings();
    }
    // not in DEFAULT_SETTINGS anymore, so presence here means a real saved value (existing install)
    if ('notifyAdditionalContent' in gallerySettings || 'backgroundMediaLocalization' in gallerySettings) {
        gallerySettings.importMediaAction = gallerySettings.notifyAdditionalContent === false ? 'none' : 'background';
        delete gallerySettings.notifyAdditionalContent;
        delete gallerySettings.backgroundMediaLocalization;
        saveGallerySettings();
    }
    // gridThumbnailsClHelper renamed to gridThumbnailsHiRes -- same toggle, cl-helper is gone
    if ('gridThumbnailsClHelper' in gallerySettings) {
        gallerySettings.gridThumbnailsHiRes = gallerySettings.gridThumbnailsClHelper;
        delete gallerySettings.gridThumbnailsClHelper;
        saveGallerySettings();
    }
}

/**
 * Save settings to SillyTavern's extension settings (server-side)
 * Also saves to localStorage as backup
 */
function saveGallerySettings(changedKeys = null) {
    // Try to save to SillyTavern extension settings first
    const context = getSTContext();
    if (context && context.extensionSettings) {
        const ns = context.extensionSettings[SETTINGS_KEY];
        if (changedKeys && ns) {
            // Surgical per-key write: a concurrent CL instance (embedded pane + tab)
            // may hold newer values for OTHER keys; a wholesale stamp would revert them.
            for (const key of changedKeys) ns[key] = gallerySettings[key];
        } else {
            // Wholesale, for boot migrations that delete keys (deletion must propagate).
            context.extensionSettings[SETTINGS_KEY] = { ...gallerySettings };
        }
        // Trigger ST's debounced save to persist to disk
        if (typeof context.saveSettingsDebounced === 'function') {
            context.saveSettingsDebounced();
            debugLog('[Settings] Saved to SillyTavern extensionSettings');
        }
    }
    
    // ARCHIVE FORK: persist to the archive server. Upstream has no HTTP save
    // path at all -- it writes SillyTavern's in-memory extensionSettings above
    // and lets ST flush that to disk -- so standalone there was nothing but the
    // localStorage backup below, which is keyed to the origin and evaporates
    // when the port or host changes. These are the only copy of the Chub and
    // DataCat tokens. Fire-and-forget: the adapter coalesces the writes and
    // logs its own failures, and no caller here inspects a result.
    fetch('/api/settings/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: gallerySettings }),
    }).catch(() => { /* adapter reports; a save must never throw into the UI */ });

    // Also save to localStorage as backup
    try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(gallerySettings));
    } catch (e) {
        console.warn('[Settings] Failed to save to localStorage:', e);
    }
}

function getSetting(key) {
    return gallerySettings[key];
}

function setSetting(key, value) {
    gallerySettings[key] = value;
    saveGallerySettings([key]);
}

function setSettings(settings) {
    Object.assign(gallerySettings, settings);
    saveGallerySettings(Object.keys(settings));
}

// Respects mobileHaptics setting and silently no-ops on unsupported devices.
function hapticFeedback(pattern) {
    if (getSetting('mobileHaptics') === false) return;
    if (typeof navigator.vibrate !== 'function') return;
    try { navigator.vibrate(pattern); } catch { /* unsupported */ }
}
window.hapticFeedback = hapticFeedback;

function getProviderExcludeTags(providerId) {
    const map = getSetting('providerExcludeTags') || {};
    const tags = map[providerId];
    return Array.isArray(tags) ? tags : [];
}

function setProviderExcludeTags(providerId, tags) {
    const map = { ...(getSetting('providerExcludeTags') || {}) };
    map[providerId] = Array.isArray(tags) ? tags : [];
    setSetting('providerExcludeTags', map);
}

// Runtime tokens live in <style id="cl-runtime-tokens"> not inline on the root,
// so user Custom CSS (later insource order) can override without !important.
const runtimeTokens = new Map();
function serializeRuntimeTokens() {
    const tag = document.getElementById('cl-runtime-tokens');
    if (!tag) return;
    if (runtimeTokens.size === 0) {
        tag.textContent = '';
        return;
    }
    const lines = [];
    for (const [k, v] of runtimeTokens) lines.push(`    ${k}: ${v};`);
    tag.textContent = `:root {\n${lines.join('\n')}\n}`;
}
function setRuntimeToken(name, value) {
    if (value == null || value === '') {
        runtimeTokens.delete(name);
    } else {
        runtimeTokens.set(name, String(value));
    }
    serializeRuntimeTokens();
}
function removeRuntimeToken(name) {
    runtimeTokens.delete(name);
    serializeRuntimeTokens();
}
function getRuntimeToken(name) {
    return runtimeTokens.get(name) || '';
}

function applyHighlightColor(color) {
    if (!color) color = DEFAULT_SETTINGS.highlightColor;

    setRuntimeToken('--accent', color);

    const hex = color.replace('#', '');
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);

    setRuntimeToken('--accent-rgb', `${r}, ${g}, ${b}`);
    setRuntimeToken('--accent-glow', `rgba(${r}, ${g}, ${b}, 0.3)`);

    const toHex = n => Math.min(255, n).toString(16).padStart(2, '0');
    const lighten = (v, f) => Math.round(v + (255 - v) * f);
    setRuntimeToken('--accent-hover', `#${toHex(lighten(r, 0.2))}${toHex(lighten(g, 0.2))}${toHex(lighten(b, 0.2))}`);

    // Secondary: hue-shift +30deg, desaturate slightly, darken slightly
    const rn = r / 255, gn = g / 255, bn = b / 255;
    const cMax = Math.max(rn, gn, bn), cMin = Math.min(rn, gn, bn);
    const delta = cMax - cMin;
    let h = 0, s = 0, l = (cMax + cMin) / 2;
    if (delta > 0) {
        s = l > 0.5 ? delta / (2 - cMax - cMin) : delta / (cMax + cMin);
        if (cMax === rn) h = ((gn - bn) / delta + (gn < bn ? 6 : 0)) / 6;
        else if (cMax === gn) h = ((bn - rn) / delta + 2) / 6;
        else h = ((rn - gn) / delta + 4) / 6;
    }
    const sh = (h + 1 / 12) % 1;
    const ss = Math.min(1, s * 0.9);
    const sl = Math.max(0, l * 0.95);
    let sr, sg, sb;
    if (ss === 0) {
        sr = sg = sb = Math.round(sl * 255);
    } else {
        const q = sl < 0.5 ? sl * (1 + ss) : sl + ss - sl * ss;
        const p = 2 * sl - q;
        const hue2rgb = (t) => {
            if (t < 0) t += 1; if (t > 1) t -= 1;
            if (t < 1 / 6) return p + (q - p) * 6 * t;
            if (t < 1 / 2) return q;
            if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
            return p;
        };
        sr = Math.round(hue2rgb(sh + 1 / 3) * 255);
        sg = Math.round(hue2rgb(sh) * 255);
        sb = Math.round(hue2rgb(sh - 1 / 3) * 255);
    }
    setRuntimeToken('--accent-secondary', `#${toHex(sr)}${toHex(sg)}${toHex(sb)}`);
    setRuntimeToken('--accent-secondary-rgb', `${sr}, ${sg}, ${sb}`);

    // WCAG relative luminance → pick white or dark text for readability on accent bg
    const srgb = c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    const lum = 0.2126 * srgb(rn) + 0.7152 * srgb(gn) + 0.0722 * srgb(bn);
    setRuntimeToken('--accent-text', lum > 0.36 ? '#121212' : '#ffffff');
}

const UI_SCALE_MAP = { 1: 0.8, 2: 0.9, 3: 1, 4: 1.1, 5: 1.2 };

function applyUiScale(level) {
    const zoom = UI_SCALE_MAP[level] || 1;
    document.body.style.zoom = zoom;
    document.body.style.height = zoom !== 1 ? `calc(100vh / ${zoom})` : '';
}

const MODAL_SIZE_MAP = { 1: 0.8, 2: 1, 3: 1.25, 4: 1.4 };

function applyModalSize(level) {
    const scale = MODAL_SIZE_MAP[level] || 1;
    document.body.style.setProperty('--modal-scale', scale);
    document.body.classList.remove('modal-size-small', 'modal-size-large', 'modal-size-xlarge');
    if (level === 1) document.body.classList.add('modal-size-small');
    else if (level === 3) document.body.classList.add('modal-size-large');
    else if (level === 4) document.body.classList.add('modal-size-xlarge');
}

// XL only fits at 80% ui scale, grey it out otherwise and downgrade to medium if it was active
function syncXlModalSizeAvailability() {
    const sel = document.getElementById('settingsModalSize');
    const xlOption = sel?.querySelector('option[value="4"]');
    if (!sel || !xlOption) return;
    const allow = (parseInt(getSetting('uiScale')) || 3) === 1;
    xlOption.disabled = !allow;
    xlOption.title = allow ? '' : 'Available only at the smallest UI Scale (80%)';
    if (!allow && sel.value === '4') {
        sel.value = '2';
        setSetting('modalSize', 2);
        applyModalSize(2);
    }
    sel._customSelect?.refresh();
}

function applyButtonStyle(style) {
    document.documentElement.dataset.btnStyle = style === 'solid' ? 'solid' : 'glass';
}

function applyCollapseAllBrowseSections(enabled) {
    document.body.classList.toggle('collapse-all-browse-sections', !!enabled);
}

function applyAnimateTagPills(enabled, keepName) {
    document.documentElement.classList.toggle('animate-tag-pills', !!enabled);
    document.documentElement.classList.toggle('animate-keep-name', !!enabled && !!keepName);
}

function applyMobileHideBackArrows(hidden) {
    document.documentElement.classList.toggle('cl-hide-back-arrows', !!hidden);
}

function applyMobileBrowseQuickImport(enabled) {
    document.documentElement.classList.toggle('cl-browse-quick-import', !!enabled);
}

function applyMobileProviderQuickSwitch(enabled) {
    document.documentElement.classList.toggle('cl-no-provider-quick-switch', !enabled);
}

function getActiveFilterState() {
    return {
        fav: !!document.getElementById('searchFavoritesOnly')?.checked,
        tag: !!(activeTagFilters && activeTagFilters.size > 0),
    };
}

function updateMobileFilterIndicator() {
    const s = getActiveFilterState();
    document.documentElement.classList.toggle('cl-filters-active', s.fav || s.tag);
}

function updateThemeCustomizerVisibility() {
    const row = document.getElementById('themeCustomizerBtnRow');
    if (!row) return;
    row.style.display = getSetting('themeCustomizer') ? '' : 'none';
}

/**
 * Setup the Gallery Settings Modal
 */
function setupSettingsModal() {
    const settingsBtn = document.getElementById('gallerySettingsBtn');
    const settingsModal = document.getElementById('gallerySettingsModal');
    const closeSettingsModal = document.getElementById('closeSettingsModal');
    const saveSettingsBtn = document.getElementById('saveSettingsBtn');
    const resetSettingsBtn = document.getElementById('resetSettingsBtn');
    
    // Input elements
    const chubTokenInput = document.getElementById('settingsChubToken');
    const rememberTokenCheckbox = document.getElementById('settingsRememberToken');
    const toggleTokenVisibility = document.getElementById('toggleChubTokenVisibility');
    const datacatTokenInput = document.getElementById('settingsDatacatToken');
    const toggleDatacatTokenVisibility = document.getElementById('toggleDatacatTokenVisibility');
    const datacatSessionStatus = document.getElementById('datacatSessionStatus');
    const minScoreSlider = document.getElementById('settingsMinScore');
    const minScoreValue = document.getElementById('minScoreValue');
    const possibleMatchScoreSlider = document.getElementById('settingsPossibleMatchScore');
    const possibleMatchScoreValue = document.getElementById('possibleMatchScoreValue');
    const importDirectDownloadsCheckbox = document.getElementById('settingsImportDirectDownloads');
    
    // Search defaults
    const searchNameCheckbox = document.getElementById('settingsSearchName');
    const searchListingNameCheckbox = document.getElementById('settingsSearchListingName');
    const searchTagsCheckbox = document.getElementById('settingsSearchTags');
    const searchAuthorCheckbox = document.getElementById('settingsSearchAuthor');
    const searchNotesCheckbox = document.getElementById('settingsSearchNotes');
    const searchTaglineCheckbox = document.getElementById('settingsSearchTagline');
    const defaultSortSelect = document.getElementById('settingsDefaultSort');
    const defaultFilterPresetSelect = document.getElementById('settingsDefaultFilterPreset');
    const groupFavoritesFirstCheckbox = document.getElementById('settingsGroupFavoritesFirst');

    // Outbound proxy (General panel). The value is the server's, not this page's:
    // nothing the browser fetches goes through it -- see updateProxyStatus below.
    const httpProxyUrlInput = document.getElementById('settingsHttpProxyUrl');
    const proxyStatusBadge = document.getElementById('proxyStatusBadge');
    const proxyStatusDetail = document.getElementById('proxyStatusDetail');
    const testProxyBtn = document.getElementById('testProxyBtn');
    
    // Experimental features
    const richCreatorNotesCheckbox = document.getElementById('settingsRichCreatorNotes');
    const expandCreatorNotesCheckbox = document.getElementById('settingsExpandCreatorNotes');
    const displayNamePreferenceSelect = document.getElementById('settingsDisplayNamePreference');
    const displayNameOverrideCheckbox = document.getElementById('settingsDisplayNameOverride');
    const showNameToggleCheckbox = document.getElementById('settingsShowNameToggle');
    
    // Media Localization
    const includeProviderGalleryCheckbox = document.getElementById('settingsIncludeProviderGallery');
    const includeLorebookCheckbox = document.getElementById('settingsIncludeLorebook');
    const importMediaActionSelect = document.getElementById('settingsImportMediaAction');
    const includeExternalGalleriesCheckbox = document.getElementById('settingsIncludeExternalGalleries');

    // Display
    const replaceUserPlaceholderCheckbox = document.getElementById('settingsReplaceUserPlaceholder');
    
    // Developer
    const debugModeCheckbox = document.getElementById('settingsDebugMode');
    const exportAsLinksCheckbox = document.getElementById('settingsExportAsLinks');
    const showProviderTaglineCheckbox = document.getElementById('settingsShowProviderTagline');
    const allowRichTaglineCheckbox = document.getElementById('settingsAllowRichTagline');
    const browseSnapSectionsCheckbox = document.getElementById('settingsBrowseSnapSections');
    const collapseAllBrowseSectionsCheckbox = document.getElementById('settingsCollapseAllBrowseSections');
    const mobileProviderQuickSwitchCheckbox = document.getElementById('settingsMobileProviderQuickSwitch');
    const mobileHideBackArrowsCheckbox = document.getElementById('settingsMobileHideBackArrows');
    const mobileBrowseQuickImportCheckbox = document.getElementById('settingsMobileBrowseQuickImport');
    const mobileSwipeGesturesCheckbox = document.getElementById('settingsMobileSwipeGestures');
    const mobileHapticsCheckbox = document.getElementById('settingsMobileHaptics');
    const useGridThumbnailsCheckbox = document.getElementById('settingsUseGridThumbnails');
    const gridThumbDesktopCheckbox = document.getElementById('settingsGridThumbDesktop');
    const gridThumbHiResCheckbox = document.getElementById('settingsGridThumbHiRes');
    const gridThumbSizeSelect = document.getElementById('settingsGridThumbSize');
    const gridThumbDesktopRow = document.getElementById('settingsGridThumbDesktopRow');
    const gridThumbHiResRow = document.getElementById('settingsGridThumbHiResRow');
    const gridThumbSizeRow = document.getElementById('settingsGridThumbSizeRow');
    
    // Appearance
    const mobileModeSelect = document.getElementById('settingsMobileMode');
    const uiScaleSelect = document.getElementById('settingsUiScale');
    const modalSizeSelect = document.getElementById('settingsModalSize');
    const buttonStyleSelect = document.getElementById('settingsButtonStyle');
    const animateTagPillsCheckbox = document.getElementById('settingsAnimateTagPills');
    const animateKeepNameCheckbox = document.getElementById('settingsAnimateKeepName');
    const animateKeepNameRow = document.getElementById('animateKeepNameRow');
    const enableCharDetailNavCheckbox = document.getElementById('settingsEnableCharDetailNav');
    const highlightColorInput = document.getElementById('settingsHighlightColor');
    const themeCustomizerCheckbox = document.getElementById('settingsThemeCustomizer');
    
    // Card Updates
    const chubUseV4ApiCheckbox = document.getElementById('settingsChubUseV4Api');

    // Version History
    const autoSnapshotOnEditCheckbox = document.getElementById('settingsAutoSnapshotOnEdit');
    const maxAutoBackupsInput = document.getElementById('settingsMaxAutoBackups');

    // Unique Gallery Folders
    const uniqueGalleryFoldersCheckbox = document.getElementById('settingsUniqueGalleryFolders');
    const migrateGalleryFoldersBtn = document.getElementById('migrateGalleryFoldersBtn');
    const galleryMigrationStatus = document.getElementById('galleryMigrationStatus');
    const galleryMigrationStatusText = document.getElementById('galleryMigrationStatusText');
    const relocateSharedImagesBtn = document.getElementById('relocateSharedImagesBtn');
    const imageRelocationStatus = document.getElementById('imageRelocationStatus');
    const imageRelocationStatusText = document.getElementById('imageRelocationStatusText');
    
    if (!settingsBtn || !settingsModal) return;

    // ── Provider Order & Defaults UI ────────────────────────

    function applyProviderToggle(btn, isNowDisabled) {
        btn.classList.toggle('disabled', isNowDisabled);
        const icon = btn.querySelector('i');
        if (icon) icon.className = isNowDisabled ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye';
        btn.title = `${isNowDisabled ? 'Enable' : 'Disable'} in Online tab`;
        const orderItem = btn.closest('.provider-order-item');
        if (orderItem) orderItem.classList.toggle('provider-disabled', isNowDisabled);
    }

    function wireProviderToggleListeners(container, viewProviders) {
        container.querySelectorAll('.provider-toggle-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const isCurrentlyDisabled = btn.classList.contains('disabled');
                const pid = btn.dataset.provider;
                const prov = viewProviders.find(p => p.id === pid);

                if (isCurrentlyDisabled && prov?.enableWarning) {
                    // Canonical confirm: stacks above the settings cl-modal (a raw .confirm-modal sits
                    // below it) and gets Escape / Android back handling from the overlay registry.
                    showConfirm({
                        title: `Enable ${prov.name}?`,
                        message: prov.enableWarning,
                        icon: 'fa-solid fa-triangle-exclamation',
                        confirmLabel: 'Enable',
                    }).then(ok => { if (ok) applyProviderToggle(btn, false); });
                    return;
                }

                applyProviderToggle(btn, !isCurrentlyDisabled);
            });
        });
    }

    function buildProviderOrderUI() {
        const container = document.getElementById('providerOrderList');
        if (!container) return;

        const registry = window.ProviderRegistry;
        if (!registry) return;

        const viewProviders = registry.getAllProviders().filter(p => p.hasView);
        if (viewProviders.length === 0) {
            container.innerHTML = '<p class="settings-hint" style="text-align:center; padding:8px;">No providers available</p>';
            return;
        }

        const savedOrder = getSetting('providerOrder');
        const savedDefaults = getSetting('providerDefaults') || {};
        const disabledProviders = new Set(getSetting('disabledProviders') || []);

        // Sort providers: if saved order exists, use it; otherwise registration order
        let ordered;
        if (Array.isArray(savedOrder) && savedOrder.length > 0) {
            const idSet = new Set(viewProviders.map(p => p.id));
            const sorted = savedOrder.filter(id => idSet.has(id));
            const rest = viewProviders.filter(p => !sorted.includes(p.id));
            ordered = [...sorted.map(id => viewProviders.find(p => p.id === id)), ...rest];
        } else {
            ordered = viewProviders;
        }

        container.innerHTML = '';
        for (const provider of ordered) {
            const config = provider.browseView?.getSettingsConfig?.() || { browseSortOptions: [], followingSortOptions: [], viewModes: [] };
            const defaults = savedDefaults[provider.id] || {};
            const item = document.createElement('div');
            item.className = 'provider-order-item';
            item.dataset.providerId = provider.id;
            item.draggable = true;

            // Build default view dropdown (only for providers with mode toggle)
            let viewSelect = '';
            if (config.viewModes.length > 0) {
                const viewOpts = config.viewModes.map(m =>
                    `<option value="${m.value}"${defaults.view === m.value ? ' selected' : ''}>${m.label}</option>`
                ).join('');
                viewSelect = `<select class="provider-default-view" data-provider="${provider.id}" title="Default view mode">
                    <option value="">View: Auto</option>${viewOpts}
                </select>`;
            }

            // Build default sort dropdown - shows browse sorts initially, adapts to selected view
            const browseSorts = config.browseSortOptions || [];
            const followSorts = config.followingSortOptions || [];
            let sortOpts = '';
            if (browseSorts.length > 0 || followSorts.length > 0) {
                const currentView = defaults.view || '';
                const isFollowView = currentView === 'following' || currentView === 'timeline';
                const activeList = (isFollowView && followSorts.length > 0) ? followSorts : browseSorts;
                sortOpts = activeList.map(s =>
                    `<option value="${s.value}"${defaults.sort === s.value ? ' selected' : ''}>${s.label}</option>`
                ).join('');
            }
            let sortSelect = '';
            if (sortOpts) {
                sortSelect = `<select class="provider-default-sort" data-provider="${provider.id}" title="Default sort order">
                    <option value="">Sort: Auto</option>${sortOpts}
                </select>`;
            }

            const isDisabled = disabledProviders.has(provider.id);
            if (isDisabled) item.classList.add('provider-disabled');

            const hideToggles = `
                <label class="provider-default-hide" title="Hide cards already in your library by default"><input type="checkbox" class="provider-default-hide-owned"${defaults.hideOwned ? ' checked' : ''}>Hide Owned</label>
                <label class="provider-default-hide" title="Hide possible-match cards by default"><input type="checkbox" class="provider-default-hide-possible"${defaults.hidePossible ? ' checked' : ''}>Hide Possible</label>`;

            item.innerHTML = `
                <i class="fa-solid fa-grip-vertical drag-handle"></i>
                <button type="button" class="provider-toggle-btn${isDisabled ? ' disabled' : ''}" data-provider="${provider.id}" title="${isDisabled ? 'Enable' : 'Disable'} in Online tab">
                    <i class="fa-solid ${isDisabled ? 'fa-eye-slash' : 'fa-eye'}"></i>
                </button>
                <i class="fa-solid ${provider.icon || 'fa-globe'} provider-order-icon"></i>
                <span class="provider-order-name">${provider.name}</span>
                ${provider.beta ? '<span class="provider-beta-badge">Beta</span>' : ''}
                <span class="provider-order-badge">Default</span>
                <div class="provider-order-defaults">
                    ${viewSelect}${sortSelect}${hideToggles}
                </div>
            `;

            container.appendChild(item);
        }

        // Toggle enable/disable
        wireProviderToggleListeners(container, viewProviders);
        container.querySelectorAll('.provider-default-view').forEach(viewSel => {
            viewSel.addEventListener('change', () => {
                const pid = viewSel.dataset.provider;
                const prov = viewProviders.find(p => p.id === pid);
                if (!prov) return;
                const cfg = prov.browseView?.getSettingsConfig?.() || {};
                const sortSel = container.querySelector(`.provider-default-sort[data-provider="${pid}"]`);
                if (!sortSel) return;
                const isFollow = viewSel.value === 'following' || viewSel.value === 'timeline';
                const list = (isFollow && cfg.followingSortOptions?.length > 0) ? cfg.followingSortOptions : (cfg.browseSortOptions || []);
                const prevVal = sortSel.value;
                sortSel.innerHTML = '<option value="">Sort: Auto</option>' + list.map(s =>
                    `<option value="${s.value}">${s.label}</option>`
                ).join('');
                // Restore previous value if still valid
                if ([...sortSel.options].some(o => o.value === prevVal)) sortSel.value = prevVal;
                else sortSel.value = '';
            });
        });

        // Drag-and-drop reordering
        let dragItem = null;
        container.addEventListener('dragstart', (e) => {
            const item = e.target.closest('.provider-order-item');
            if (!item) return;
            dragItem = item;
            item.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', item.dataset.providerId);
        });
        container.addEventListener('dragend', () => {
            if (dragItem) dragItem.classList.remove('dragging');
            dragItem = null;
            container.querySelectorAll('.provider-order-item').forEach(el => el.classList.remove('drag-over'));
        });
        container.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            const target = e.target.closest('.provider-order-item');
            if (!target || target === dragItem) return;
            container.querySelectorAll('.provider-order-item').forEach(el => el.classList.remove('drag-over'));
            target.classList.add('drag-over');
        });
        container.addEventListener('dragleave', (e) => {
            const target = e.target.closest('.provider-order-item');
            if (target) target.classList.remove('drag-over');
        });
        container.addEventListener('drop', (e) => {
            e.preventDefault();
            const target = e.target.closest('.provider-order-item');
            if (!target || !dragItem || target === dragItem) return;
            target.classList.remove('drag-over');
            // Insert dragged item before the drop target
            container.insertBefore(dragItem, target);
        });

        // Touch drag support (mobile)
        let touchItem = null;
        let touchClone = null;
        let touchStartY = 0;
        container.addEventListener('touchstart', (e) => {
            const handle = e.target.closest('.drag-handle');
            if (!handle) return;
            const item = handle.closest('.provider-order-item');
            if (!item) return;
            touchItem = item;
            touchStartY = e.touches[0].clientY;
            item.classList.add('dragging');
        }, { passive: true });
        container.addEventListener('touchmove', (e) => {
            if (!touchItem) return;
            e.preventDefault();
            const y = e.touches[0].clientY;
            const items = [...container.querySelectorAll('.provider-order-item')];
            items.forEach(el => el.classList.remove('drag-over'));
            for (const item of items) {
                if (item === touchItem) continue;
                const rect = item.getBoundingClientRect();
                if (y >= rect.top && y <= rect.bottom) {
                    item.classList.add('drag-over');
                    break;
                }
            }
        }, { passive: false });
        container.addEventListener('touchend', () => {
            if (!touchItem) return;
            const overItem = container.querySelector('.provider-order-item.drag-over');
            if (overItem && overItem !== touchItem) {
                container.insertBefore(touchItem, overItem);
            }
            touchItem.classList.remove('dragging');
            container.querySelectorAll('.provider-order-item').forEach(el => el.classList.remove('drag-over'));
            touchItem = null;
        });
    }

    function readProviderOrderFromUI() {
        const container = document.getElementById('providerOrderList');
        if (!container) return { providerOrder: null, providerDefaults: {}, disabledProviders: [] };

        const items = container.querySelectorAll('.provider-order-item');
        const order = [];
        const defaults = {};
        const disabled = [];

        items.forEach(item => {
            const pid = item.dataset.providerId;
            if (!pid) return;
            order.push(pid);

            const toggleBtn = item.querySelector('.provider-toggle-btn');
            if (toggleBtn?.classList.contains('disabled')) {
                disabled.push(pid);
            }

            const viewSel = item.querySelector('.provider-default-view');
            const sortSel = item.querySelector('.provider-default-sort');
            const viewVal = viewSel?.value || '';
            const sortVal = sortSel?.value || '';
            const hideOwned = !!item.querySelector('.provider-default-hide-owned')?.checked;
            const hidePossible = !!item.querySelector('.provider-default-hide-possible')?.checked;

            if (viewVal || sortVal || hideOwned || hidePossible) {
                defaults[pid] = {};
                if (viewVal) defaults[pid].view = viewVal;
                if (sortVal) defaults[pid].sort = sortVal;
                if (hideOwned) defaults[pid].hideOwned = true;
                if (hidePossible) defaults[pid].hidePossible = true;
            }
        });

        return { providerOrder: order.length > 0 ? order : null, providerDefaults: defaults, disabledProviders: disabled };
    }

    function resetProviderOrderUI() {
        const container = document.getElementById('providerOrderList');
        if (!container) return;
        container.innerHTML = '';

        const registry = window.ProviderRegistry;
        if (!registry) return;
        const viewProviders = registry.getAllProviders().filter(p => p.hasView);
        for (const provider of viewProviders) {
            const config = provider.browseView?.getSettingsConfig?.() || { browseSortOptions: [], followingSortOptions: [], viewModes: [] };
            const item = document.createElement('div');
            item.className = 'provider-order-item';
            item.dataset.providerId = provider.id;
            item.draggable = true;

            let viewSelect = '';
            if (config.viewModes.length > 0) {
                const viewOpts = config.viewModes.map(m =>
                    `<option value="${m.value}">${m.label}</option>`
                ).join('');
                viewSelect = `<select class="provider-default-view" data-provider="${provider.id}" title="Default view mode">
                    <option value="" selected>View: Auto</option>${viewOpts}
                </select>`;
            }

            const browseSorts = config.browseSortOptions || [];
            let sortSelect = '';
            if (browseSorts.length > 0) {
                const sortOpts = browseSorts.map(s =>
                    `<option value="${s.value}">${s.label}</option>`
                ).join('');
                sortSelect = `<select class="provider-default-sort" data-provider="${provider.id}" title="Default sort order">
                    <option value="" selected>Sort: Auto</option>${sortOpts}
                </select>`;
            }

            const isDisabled = provider.disabledByDefault;
            if (isDisabled) item.classList.add('provider-disabled');

            item.innerHTML = `
                <i class="fa-solid fa-grip-vertical drag-handle"></i>
                <button type="button" class="provider-toggle-btn${isDisabled ? ' disabled' : ''}" data-provider="${provider.id}" title="${isDisabled ? 'Enable' : 'Disable'} in Online tab">
                    <i class="fa-solid ${isDisabled ? 'fa-eye-slash' : 'fa-eye'}"></i>
                </button>
                <i class="fa-solid ${provider.icon || 'fa-globe'} provider-order-icon"></i>
                <span class="provider-order-name">${provider.name}</span>
                ${provider.beta ? '<span class="provider-beta-badge">Beta</span>' : ''}
                <span class="provider-order-badge">Default</span>
                <div class="provider-order-defaults">
                    ${viewSelect}${sortSelect}
                    <label class="provider-default-hide" title="Hide cards already in your library by default"><input type="checkbox" class="provider-default-hide-owned">Hide Owned</label>
                    <label class="provider-default-hide" title="Hide possible-match cards by default"><input type="checkbox" class="provider-default-hide-possible">Hide Possible</label>
                </div>
            `;
            container.appendChild(item);
        }

        // Toggle enable/disable
        wireProviderToggleListeners(container, viewProviders);

        // Re-wire view→sort dependency for providers with mode toggle
        container.querySelectorAll('.provider-default-view').forEach(viewSel => {
            viewSel.addEventListener('change', () => {
                const pid = viewSel.dataset.provider;
                const prov = viewProviders.find(p => p.id === pid);
                if (!prov) return;
                const cfg = prov.browseView?.getSettingsConfig?.() || {};
                const sortSel = container.querySelector(`.provider-default-sort[data-provider="${pid}"]`);
                if (!sortSel) return;
                const isFollow = viewSel.value === 'following' || viewSel.value === 'timeline';
                const list = (isFollow && cfg.followingSortOptions?.length > 0) ? cfg.followingSortOptions : (cfg.browseSortOptions || []);
                sortSel.innerHTML = '<option value="">Sort: Auto</option>' + list.map(s =>
                    `<option value="${s.value}">${s.label}</option>`
                ).join('');
                sortSel.value = '';
            });
        });
    }

    // ── Infinite Scroll Toggles UI ─────────────────────────

    function buildInfiniteScrollUI() {
        const container = document.getElementById('infiniteScrollToggles');
        if (!container) return;

        const registry = window.ProviderRegistry;
        if (!registry) return;

        const viewProviders = registry.getViewProviders();
        if (viewProviders.length === 0) {
            container.innerHTML = '<p class="settings-hint" style="text-align:center; padding:8px;">No providers available</p>';
            return;
        }

        const saved = getSetting('infiniteScroll') || {};

        container.innerHTML = viewProviders.map(p => {
            const checked = (p.id in saved) ? saved[p.id] : true;
            return `<div class="settings-row">
                <label>
                    <input type="checkbox" class="infinite-scroll-toggle" data-provider="${escapeHtml(p.id)}" ${checked ? 'checked' : ''}>
                    ${escapeHtml(p.name)}
                </label>
            </div>`;
        }).join('');
    }

    function readInfiniteScrollFromUI() {
        const container = document.getElementById('infiniteScrollToggles');
        if (!container) return {};
        const result = {};
        container.querySelectorAll('.infinite-scroll-toggle').forEach(cb => {
            const pid = cb.dataset.provider;
            if (pid) result[pid] = cb.checked;
        });
        return result;
    }

    // ── Provider Exclude Tags ───────────────────────────────

    const EXCLUDE_TAG_PROVIDERS = [
        { id: 'chub', inputId: 'chubExcludeTagsInput', pillsId: 'chubExcludeTagsPills' },
        { id: 'datacat', inputId: 'datacatExcludeTagsInput', pillsId: 'datacatExcludeTagsPills' },
    ];

    function renderExcludeTagPills(providerId, pillsId) {
        const container = document.getElementById(pillsId);
        if (!container) return;
        const tags = getProviderExcludeTags(providerId);
        container.innerHTML = tags.map(tag =>
            `<span class="provider-exclude-tag-pill" data-tag="${tag.replace(/"/g, '&quot;')}">${escapeHtml(tag)}<button class="provider-exclude-tag-remove" title="Remove">&times;</button></span>`
        ).join('');
    }

    function populateAllExcludeTagPills() {
        for (const { id, pillsId } of EXCLUDE_TAG_PROVIDERS) {
            renderExcludeTagPills(id, pillsId);
        }
    }

    function addExcludeTag(providerId, pillsId, tag) {
        const trimmed = tag.trim().toLowerCase();
        if (!trimmed) return;
        const existing = getProviderExcludeTags(providerId);
        if (existing.includes(trimmed)) return;
        setProviderExcludeTags(providerId, [...existing, trimmed]);
        renderExcludeTagPills(providerId, pillsId);
    }

    function removeExcludeTag(providerId, pillsId, tag) {
        const existing = getProviderExcludeTags(providerId);
        setProviderExcludeTags(providerId, existing.filter(t => t !== tag));
        renderExcludeTagPills(providerId, pillsId);
    }

    for (const { id, inputId, pillsId } of EXCLUDE_TAG_PROVIDERS) {
        const input = document.getElementById(inputId);
        const pills = document.getElementById(pillsId);
        if (!input || !pills) continue;

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                addExcludeTag(id, pillsId, input.value);
                input.value = '';
            }
        });

        pills.addEventListener('click', (e) => {
            const removeBtn = e.target.closest('.provider-exclude-tag-remove');
            if (!removeBtn) return;
            const pill = removeBtn.closest('.provider-exclude-tag-pill');
            if (pill) removeExcludeTag(id, pillsId, pill.dataset.tag);
        });
    }

    // Open modal
    settingsBtn.onclick = () => {
        chubTokenInput.value = getSetting('chubToken') || '';
        rememberTokenCheckbox.checked = getSetting('chubRememberToken') || false;
        if (datacatTokenInput) datacatTokenInput.value = getSetting('datacatToken') || '';
        // onchange, not addEventListener: this runs on every settings open, so a listener would
        // stack and one click would fire N writes.
        const datacatPublicFeedCheckbox = document.getElementById('datacatPublicFeedCheckbox');
        if (datacatPublicFeedCheckbox) {
            datacatPublicFeedCheckbox.checked = getSetting('datacatPublicFeed') === true;
            datacatPublicFeedCheckbox.onchange = () => {
                setSetting('datacatPublicFeed', datacatPublicFeedCheckbox.checked);
            };
        }
        const datacatReextractCheckbox = document.getElementById('datacatReextractOnUpdateCheckbox');
        if (datacatReextractCheckbox) {
            datacatReextractCheckbox.checked = getSetting('datacatReextractOnUpdate') === true;
            datacatReextractCheckbox.onchange = () => {
                setSetting('datacatReextractOnUpdate', datacatReextractCheckbox.checked);
            };
        }
        // DataCat's own session transport lives in the archive server now, not
        // behind a plugin (see docs/PHASE_3B_PLAN.md S2).
        if (datacatSessionStatus) {
            datacatSessionStatus.className = 'settings-status-badge inactive';
            datacatSessionStatus.innerHTML = '<i class="fa-solid fa-circle"></i> Checking...';
            updateDatacatSessionStatus();
        }
        
        if (httpProxyUrlInput) {
            httpProxyUrlInput.value = getSetting('httpProxyUrl') || '';
            // Checked against what is *stored*, not what is typed: on open those
            // are the same thing, and the stored value is what the server is
            // actually using right now.
            updateProxyStatus(null);
        }

        const minScore = getSetting('duplicateMinScore') || 35;
        minScoreSlider.value = minScore;
        minScoreValue.textContent = parseInt(minScore) >= 120 ? 'Exact' : minScore;

        if (possibleMatchScoreSlider) {
            const pmScore = Number(getSetting('possibleMatchMinScore'));
            const pmVal = Number.isFinite(pmScore) ? pmScore : 65;
            possibleMatchScoreSlider.value = pmVal;
            if (possibleMatchScoreValue) possibleMatchScoreValue.textContent = String(pmVal);
        }
        if (importDirectDownloadsCheckbox) {
            importDirectDownloadsCheckbox.checked = getSetting('importDirectDownloads') === true;
        }
        
        // Search defaults
        searchNameCheckbox.checked = getSetting('searchInName') !== false;
        if (searchListingNameCheckbox) searchListingNameCheckbox.checked = getSetting('searchInListingName') !== false;
        searchTagsCheckbox.checked = getSetting('searchInTags') !== false;
        searchAuthorCheckbox.checked = getSetting('searchInAuthor') || false;
        searchNotesCheckbox.checked = getSetting('searchInNotes') || false;
        if (searchTaglineCheckbox) searchTaglineCheckbox.checked = getSetting('searchInTagline') || false;
        defaultSortSelect.value = getSetting('defaultSort') || 'name_asc';
        if (defaultFilterPresetSelect) {
            populateDefaultFilterPresetSelect(defaultFilterPresetSelect, getSetting('defaultFilterPreset') || '');
        }
        if (groupFavoritesFirstCheckbox) {
            groupFavoritesFirstCheckbox.checked = getSetting('groupFavoritesFirst') || false;
        }
        
        // Experimental features
        richCreatorNotesCheckbox.checked = getSetting('richCreatorNotes') || false;
        if (expandCreatorNotesCheckbox) expandCreatorNotesCheckbox.checked = getSetting('expandCreatorNotes') || false;
        if (displayNamePreferenceSelect) displayNamePreferenceSelect.value = getSetting('displayNamePreference') || 'card';
        if (displayNameOverrideCheckbox) displayNameOverrideCheckbox.checked = getSetting('displayNameOverrideEnabled') !== false;
        if (showNameToggleCheckbox) showNameToggleCheckbox.checked = getSetting('showNameToggle') !== false;
        
        // Media Localization
        if (includeProviderGalleryCheckbox) {
            includeProviderGalleryCheckbox.checked = getSetting('includeProviderGallery') !== false;
        }
        if (includeLorebookCheckbox) {
            includeLorebookCheckbox.checked = getSetting('includeLorebook') || false;
        }
        if (importMediaActionSelect) {
            importMediaActionSelect.value = getSetting('importMediaAction') || 'ask';
        }
        if (includeExternalGalleriesCheckbox) {
            includeExternalGalleriesCheckbox.checked = getSetting('includeExternalGalleries') !== false;
        }

        // Display
        if (replaceUserPlaceholderCheckbox) {
            replaceUserPlaceholderCheckbox.checked = getSetting('replaceUserPlaceholder') !== false; // Default true
        }
        
        // Developer
        if (debugModeCheckbox) {
            debugModeCheckbox.checked = getSetting('debugMode') || false;
        }
        if (exportAsLinksCheckbox) {
            exportAsLinksCheckbox.checked = getSetting('exportAsLinks') || false;
        }
        if (showProviderTaglineCheckbox) {
            showProviderTaglineCheckbox.checked = getSetting('showProviderTagline') !== false;
        }
        if (allowRichTaglineCheckbox) {
            allowRichTaglineCheckbox.checked = getSetting('allowRichTagline') === true;
        }
        if (browseSnapSectionsCheckbox) {
            browseSnapSectionsCheckbox.checked = getSetting('browseSnapSections') === true;
        }
        if (collapseAllBrowseSectionsCheckbox) {
            collapseAllBrowseSectionsCheckbox.checked = getSetting('collapseAllBrowseSections') === true;
        }
        if (mobileProviderQuickSwitchCheckbox) {
            mobileProviderQuickSwitchCheckbox.checked = getSetting('mobileProviderQuickSwitch') !== false;
        }
        if (mobileHideBackArrowsCheckbox) {
            mobileHideBackArrowsCheckbox.checked = getSetting('mobileHideBackArrows') === true;
        }
        if (mobileBrowseQuickImportCheckbox) {
            mobileBrowseQuickImportCheckbox.checked = getSetting('mobileBrowseQuickImport') !== false;
        }
        if (mobileSwipeGesturesCheckbox) {
            mobileSwipeGesturesCheckbox.checked = getSetting('mobileSwipeGestures') !== false;
        }
        if (mobileHapticsCheckbox) {
            mobileHapticsCheckbox.checked = getSetting('mobileHaptics') !== false;
        }
        if (useGridThumbnailsCheckbox) {
            useGridThumbnailsCheckbox.checked = getSetting('useGridThumbnails') === true;
        }
        if (gridThumbDesktopCheckbox) {
            gridThumbDesktopCheckbox.checked = getSetting('gridThumbnailsDesktop') === true;
        }
        if (gridThumbHiResCheckbox) {
            gridThumbHiResCheckbox.checked = getSetting('gridThumbnailsHiRes') !== false;
        }
        if (gridThumbSizeSelect) {
            gridThumbSizeSelect.value = String(getSetting('gridThumbnailSize') || 512);
        }
        applyGridThumbsDisabledStates();
        if (themeCustomizerCheckbox) {
            themeCustomizerCheckbox.checked = getSetting('themeCustomizer') || false;
        }
        
        // Appearance
        if (mobileModeSelect) {
            mobileModeSelect.value = window.getMobileModeOverride?.() || 'auto';
            if (mobileModeSelect._customSelect) mobileModeSelect._customSelect.refresh();
        }
        if (uiScaleSelect) {
            uiScaleSelect.value = String(getSetting('uiScale') ?? 3);
            if (uiScaleSelect._customSelect) uiScaleSelect._customSelect.refresh();
        }
        if (modalSizeSelect) {
            modalSizeSelect.value = String(getSetting('modalSize') ?? 2);
            if (modalSizeSelect._customSelect) modalSizeSelect._customSelect.refresh();
        }
        syncXlModalSizeAvailability();
        if (buttonStyleSelect) {
            buttonStyleSelect.value = getSetting('buttonStyle') || 'glass';
            if (buttonStyleSelect._customSelect) buttonStyleSelect._customSelect.refresh();
        }
        if (animateTagPillsCheckbox) {
            animateTagPillsCheckbox.checked = getSetting('animateTagPills') || false;
            if (animateKeepNameRow) animateKeepNameRow.style.display = animateTagPillsCheckbox.checked ? '' : 'none';
        }
        if (animateKeepNameCheckbox) {
            animateKeepNameCheckbox.checked = getSetting('animateKeepName') || false;
        }
        if (enableCharDetailNavCheckbox) {
            enableCharDetailNavCheckbox.checked = getSetting('enableCharDetailNav') !== false;
        }
        if (highlightColorInput) {
            highlightColorInput.value = getSetting('highlightColor') || DEFAULT_SETTINGS.highlightColor;
        }
        
        // Card Updates
        if (chubUseV4ApiCheckbox) {
            chubUseV4ApiCheckbox.checked = getSetting('chubUseV4Api') || false;
        }

        // Version History
        if (autoSnapshotOnEditCheckbox) {
            autoSnapshotOnEditCheckbox.checked = getSetting('autoSnapshotOnEdit') || false;
        }
        if (maxAutoBackupsInput) {
            maxAutoBackupsInput.value = getSetting('maxAutoBackups') ?? 10;
        }

        // Unique Gallery Folders
        if (uniqueGalleryFoldersCheckbox) {
            uniqueGalleryFoldersCheckbox.checked = getSetting('uniqueGalleryFolders') || false;
        }
        // Update migration status
        updateGalleryMigrationStatus();
        updateImageRelocationStatus();

        // Provider Order & Defaults
        buildProviderOrderUI();
        buildInfiniteScrollUI();
        populateAllExcludeTagPills();

        // Reset to first section
        switchSettingsSection('general');
        if (settingsSearchInput) {
            settingsSearchInput.value = '';
            settingsSearchInput.dispatchEvent(new Event('input'));
        }

        settingsModal.classList.add('visible');
    };
    
    // Settings sidebar navigation
    function switchSettingsSection(sectionName) {
        // Update nav items
        settingsModal.querySelectorAll('.settings-nav-item').forEach(item => {
            item.classList.toggle('active', item.dataset.section === sectionName);
        });
        // Update panels
        settingsModal.querySelectorAll('.settings-panel').forEach(panel => {
            panel.classList.toggle('active', panel.dataset.section === sectionName);
        });
    }
    
    settingsModal.querySelectorAll('.settings-nav-item').forEach(item => {
        item.addEventListener('click', () => {
            switchSettingsSection(item.dataset.section);
        });
    });

    // Settings search/filter
    const settingsSearchInput = document.getElementById('settingsSearchInput');
    if (settingsSearchInput) {
        const layout = settingsModal.querySelector('.settings-layout');
        settingsSearchInput.addEventListener('input', () => {
            const q = settingsSearchInput.value.trim().toLowerCase();
            if (!q) {
                layout.classList.remove('settings-search-active');
                clearHighlights(settingsModal);
                // Restore whichever section was active
                const activeNav = settingsModal.querySelector('.settings-nav-item.active');
                if (activeNav) switchSettingsSection(activeNav.dataset.section);
                settingsModal.querySelectorAll('.settings-search-hidden').forEach(el => el.classList.remove('settings-search-hidden'));
                // Restore inline display on sub-option rows
                settingsModal.querySelectorAll('.settings-search-force-show').forEach(el => {
                    el.classList.remove('settings-search-force-show');
                    el.style.display = 'none';
                });
                return;
            }
            layout.classList.add('settings-search-active');

            // Filter settings-rows and settings-groups
            settingsModal.querySelectorAll('.settings-group, details.settings-provider-section').forEach(group => {
                const titleEl = group.querySelector('.settings-group-title, summary');
                const titleText = titleEl ? titleEl.textContent.toLowerCase() : '';
                const titleMatch = titleText.includes(q);

                const rows = group.querySelectorAll('.settings-row');
                let anyRowVisible = false;
                rows.forEach(row => {
                    const text = row.textContent.toLowerCase();
                    const match = text.includes(q) || titleMatch;
                    row.classList.toggle('settings-search-hidden', !match);
                    // Force-show sub-option rows that have inline display:none
                    if (match && row.style.display === 'none') {
                        row.style.display = '';
                        row.classList.add('settings-search-force-show');
                    } else if (!match && row.classList.contains('settings-search-force-show')) {
                        row.classList.remove('settings-search-force-show');
                        row.style.display = 'none';
                    }
                    if (match) anyRowVisible = true;
                });

                // Hide entire group if no rows match and title doesn't match
                group.classList.toggle('settings-search-hidden', !anyRowVisible && !titleMatch);
            });

            highlightText(settingsModal.querySelector('.settings-content'), q);
        });
    }
    
    // Close modal
    const closeModal = () => settingsModal.classList.remove('visible');
    closeSettingsModal.onclick = closeModal;
    settingsModal.onclick = (e) => {
        if (e.target === settingsModal) closeModal();
    };
    
    // Toggle token visibility
    toggleTokenVisibility.onclick = () => {
        const isPassword = chubTokenInput.type === 'password';
        chubTokenInput.type = isPassword ? 'text' : 'password';
        toggleTokenVisibility.innerHTML = `<i class="fa-solid fa-eye${isPassword ? '-slash' : ''}"></i>`;
    };
    


    if (toggleDatacatTokenVisibility && datacatTokenInput) {
        toggleDatacatTokenVisibility.onclick = () => {
            const isPassword = datacatTokenInput.type === 'password';
            datacatTokenInput.type = isPassword ? 'text' : 'password';
            toggleDatacatTokenVisibility.innerHTML = `<i class="fa-solid fa-eye${isPassword ? '-slash' : ''}"></i>`;
        };
    }
    
    // Slider value display
    const formatMinScore = (val) => parseInt(val) >= 120 ? 'Exact' : val;
    minScoreSlider.oninput = () => {
        minScoreValue.textContent = formatMinScore(minScoreSlider.value);
    };
    if (possibleMatchScoreSlider) {
        possibleMatchScoreSlider.oninput = () => {
            if (possibleMatchScoreValue) possibleMatchScoreValue.textContent = possibleMatchScoreSlider.value;
        };
    }
    
    // Live preview highlight color
    if (highlightColorInput) {
        highlightColorInput.oninput = () => {
            applyHighlightColor(highlightColorInput.value);
        };
    }

    const resetAccentBtn = document.getElementById('resetAccentColor');
    if (resetAccentBtn) {
        resetAccentBtn.addEventListener('click', () => {
            const def = DEFAULT_SETTINGS.highlightColor;
            if (highlightColorInput) highlightColorInput.value = def;
            applyHighlightColor(def);
        });
    }
    
    // Mobile layout override: per-device (localStorage, not ST settings, so a desktop and an
    // iPad on the same account can diverge), applied live via the mode writer.
    if (mobileModeSelect) {
        mobileModeSelect.addEventListener('change', () => {
            const v = mobileModeSelect.value;
            // Session copy applies even when persistence fails (private mode), so the select never lies.
            window.clMobileModeOverrideMem = (v === 'mobile' || v === 'desktop') ? v : null;
            try {
                if (v === 'mobile' || v === 'desktop') localStorage.setItem('clMobileModeOverride', v);
                else localStorage.removeItem('clMobileModeOverride');
            } catch { /* storage blocked: the session copy above still applies */ }
            document.dispatchEvent(new CustomEvent('cl-mobile-override-changed'));
        });
    }

    // UI Scale: apply immediately on change
    if (uiScaleSelect) {
        uiScaleSelect.addEventListener('change', () => {
            const level = parseInt(uiScaleSelect.value) || 3;
            setSetting('uiScale', level);
            applyUiScale(level);
            syncXlModalSizeAvailability();
        });
    }

    // Modal Size: apply immediately on change
    if (modalSizeSelect) {
        modalSizeSelect.addEventListener('change', () => {
            const level = parseInt(modalSizeSelect.value) || 2;
            setSetting('modalSize', level);
            applyModalSize(level);
        });
    }

    // Button style: apply immediately on change
    if (buttonStyleSelect) {
        buttonStyleSelect.addEventListener('change', () => {
            const style = buttonStyleSelect.value || 'glass';
            setSetting('buttonStyle', style);
            applyButtonStyle(style);
        });
    }

    // Collapse all browse sections: apply immediately on change
    if (collapseAllBrowseSectionsCheckbox) {
        collapseAllBrowseSectionsCheckbox.addEventListener('change', () => {
            applyCollapseAllBrowseSections(collapseAllBrowseSectionsCheckbox.checked);
        });
    }

    // Animate card info sub-option visibility
    if (animateTagPillsCheckbox && animateKeepNameRow) {
        animateTagPillsCheckbox.addEventListener('change', () => {
            animateKeepNameRow.style.display = animateTagPillsCheckbox.checked ? '' : 'none';
        });
    }

    function applyGridThumbsDisabledStates() {
        const masterOn = !!(useGridThumbnailsCheckbox && useGridThumbnailsCheckbox.checked);
        const hiResOn = !!(gridThumbHiResCheckbox && gridThumbHiResCheckbox.checked);
        const sizeOn = masterOn && hiResOn;
        if (gridThumbDesktopCheckbox) gridThumbDesktopCheckbox.disabled = !masterOn;
        if (gridThumbDesktopRow) gridThumbDesktopRow.classList.toggle('disabled', !masterOn);
        if (gridThumbHiResCheckbox) gridThumbHiResCheckbox.disabled = !masterOn;
        if (gridThumbHiResRow) gridThumbHiResRow.classList.toggle('disabled', !masterOn);
        // Size only meaningful when master AND high-res thumbs are on.
        if (gridThumbSizeSelect) gridThumbSizeSelect.disabled = !sizeOn;
        if (gridThumbSizeRow) gridThumbSizeRow.classList.toggle('disabled', !sizeOn);
    }
    if (useGridThumbnailsCheckbox) {
        useGridThumbnailsCheckbox.addEventListener('change', applyGridThumbsDisabledStates);
    }
    if (gridThumbHiResCheckbox) {
        gridThumbHiResCheckbox.addEventListener('change', applyGridThumbsDisabledStates);
    }

    if (themeCustomizerCheckbox) {
        themeCustomizerCheckbox.addEventListener('change', () => updateThemeCustomizerVisibility());
    }

    const openThemeCustomizerBtnEl = document.getElementById('openThemeCustomizerBtn');
    if (openThemeCustomizerBtnEl) {
        openThemeCustomizerBtnEl.addEventListener('click', () => openThemeCustomizer());
    }


    const doSaveSettings = () => {
        const newHighlightColor = highlightColorInput ? highlightColorInput.value : DEFAULT_SETTINGS.highlightColor;
        // Read before setSettings overwrites it, so a changed proxy can be
        // verified below without re-testing one that did not change.
        const previousProxyUrl = getSetting('httpProxyUrl') || '';
        
        setSettings({
            chubToken: chubTokenInput.value || null,
            chubRememberToken: rememberTokenCheckbox.checked,
            // The Pygmalion, Wyvern and CharacterTavern credential fields were
            // removed with their providers (web/ trim, providers 9 -> 2), but
            // these lines survived and referenced identifiers that no longer
            // exist anywhere. `x ? x.value : null` is only null-safe for a
            // *declared* variable -- an undeclared one is a ReferenceError, so
            // every Save Settings threw here and silently saved nothing at all.
            // setSettings does an Object.assign, so dropping these keys leaves
            // whatever DEFAULT_SETTINGS holds for them untouched.
            duplicateMinScore: parseInt(minScoreSlider.value),
            possibleMatchMinScore: possibleMatchScoreSlider ? parseInt(possibleMatchScoreSlider.value) : 65,
            importDirectDownloads: importDirectDownloadsCheckbox ? importDirectDownloadsCheckbox.checked : false,
            searchInName: searchNameCheckbox.checked,
            searchInListingName: searchListingNameCheckbox ? searchListingNameCheckbox.checked : true,
            searchInTags: searchTagsCheckbox.checked,
            searchInAuthor: searchAuthorCheckbox.checked,
            searchInNotes: searchNotesCheckbox.checked,
            searchInTagline: searchTaglineCheckbox ? searchTaglineCheckbox.checked : false,
            defaultSort: defaultSortSelect.value,
            defaultFilterPreset: defaultFilterPresetSelect ? defaultFilterPresetSelect.value : '',
            groupFavoritesFirst: groupFavoritesFirstCheckbox ? groupFavoritesFirstCheckbox.checked : false,
            // Empty string -> null so "cleared" and "never set" are the same
            // thing on disk; the server treats both as "connect directly".
            httpProxyUrl: httpProxyUrlInput ? (httpProxyUrlInput.value.trim() || null) : null,
            richCreatorNotes: richCreatorNotesCheckbox.checked,
            expandCreatorNotes: expandCreatorNotesCheckbox ? expandCreatorNotesCheckbox.checked : false,
            displayNamePreference: displayNamePreferenceSelect ? displayNamePreferenceSelect.value : 'card',
            displayNameOverrideEnabled: displayNameOverrideCheckbox ? displayNameOverrideCheckbox.checked : true,
            showNameToggle: showNameToggleCheckbox ? showNameToggleCheckbox.checked : true,
            highlightColor: newHighlightColor,
            includeProviderGallery: includeProviderGalleryCheckbox ? includeProviderGalleryCheckbox.checked : false,
            includeLorebook: includeLorebookCheckbox ? includeLorebookCheckbox.checked : false,
            importMediaAction: importMediaActionSelect ? (importMediaActionSelect.value || 'ask') : 'ask',
            includeExternalGalleries: includeExternalGalleriesCheckbox ? includeExternalGalleriesCheckbox.checked : true,
            replaceUserPlaceholder: replaceUserPlaceholderCheckbox ? replaceUserPlaceholderCheckbox.checked : true,
            debugMode: debugModeCheckbox ? debugModeCheckbox.checked : false,
            themeCustomizer: themeCustomizerCheckbox ? themeCustomizerCheckbox.checked : false,
            exportAsLinks: exportAsLinksCheckbox ? exportAsLinksCheckbox.checked : false,
            showProviderTagline: showProviderTaglineCheckbox ? showProviderTaglineCheckbox.checked : true,
            allowRichTagline: allowRichTaglineCheckbox ? allowRichTaglineCheckbox.checked : false,
            browseSnapSections: browseSnapSectionsCheckbox ? browseSnapSectionsCheckbox.checked : false,
            collapseAllBrowseSections: collapseAllBrowseSectionsCheckbox ? collapseAllBrowseSectionsCheckbox.checked : false,
            mobileProviderQuickSwitch: mobileProviderQuickSwitchCheckbox ? mobileProviderQuickSwitchCheckbox.checked : true,
            mobileHideBackArrows: mobileHideBackArrowsCheckbox ? mobileHideBackArrowsCheckbox.checked : false,
            mobileBrowseQuickImport: mobileBrowseQuickImportCheckbox ? mobileBrowseQuickImportCheckbox.checked : true,
            mobileSwipeGestures: mobileSwipeGesturesCheckbox ? mobileSwipeGesturesCheckbox.checked : true,
            mobileHaptics: mobileHapticsCheckbox ? mobileHapticsCheckbox.checked : true,
            useGridThumbnails: useGridThumbnailsCheckbox ? useGridThumbnailsCheckbox.checked : false,
            gridThumbnailsDesktop: gridThumbDesktopCheckbox ? gridThumbDesktopCheckbox.checked : false,
            gridThumbnailsHiRes: gridThumbHiResCheckbox ? gridThumbHiResCheckbox.checked : true,
            gridThumbnailSize: gridThumbSizeSelect ? parseInt(gridThumbSizeSelect.value) || 512 : 512,
            buttonStyle: buttonStyleSelect ? buttonStyleSelect.value || 'glass' : 'glass',
            uiScale: uiScaleSelect ? parseInt(uiScaleSelect.value) || 3 : 3,
            modalSize: modalSizeSelect ? parseInt(modalSizeSelect.value) || 2 : 2,
            animateTagPills: animateTagPillsCheckbox ? animateTagPillsCheckbox.checked : false,
            animateKeepName: animateKeepNameCheckbox ? animateKeepNameCheckbox.checked : false,
            enableCharDetailNav: enableCharDetailNavCheckbox ? enableCharDetailNavCheckbox.checked : true,
            uniqueGalleryFolders: uniqueGalleryFoldersCheckbox ? uniqueGalleryFoldersCheckbox.checked : false,
            chubUseV4Api: chubUseV4ApiCheckbox ? chubUseV4ApiCheckbox.checked : false,
            autoSnapshotOnEdit: autoSnapshotOnEditCheckbox ? autoSnapshotOnEditCheckbox.checked : false,
            maxAutoBackups: maxAutoBackupsInput ? parseInt(maxAutoBackupsInput.value) || 10 : 10,
            ...readProviderOrderFromUI(),
            infiniteScroll: readInfiniteScrollFromUI(),
        });
        
        // Clear media localization cache when setting changes
        clearAllMediaLocalizationCache();
        
        // Apply highlight color
        applyHighlightColor(newHighlightColor);

        // Apply animated tag pills
        applyAnimateTagPills(
            animateTagPillsCheckbox ? animateTagPillsCheckbox.checked : false,
            animateKeepNameCheckbox ? animateKeepNameCheckbox.checked : false
        );


        updateCharModalNavState();

        // Mobile back-arrow visibility toggle
        applyMobileHideBackArrows(mobileHideBackArrowsCheckbox ? mobileHideBackArrowsCheckbox.checked : false);

        // Mobile compact-import on browse preview modals
        applyMobileBrowseQuickImport(mobileBrowseQuickImportCheckbox ? mobileBrowseQuickImportCheckbox.checked : true);

        // Mobile provider quick-switch (topbar icon + Online dropdown)
        applyMobileProviderQuickSwitch(mobileProviderQuickSwitchCheckbox ? mobileProviderQuickSwitchCheckbox.checked : true);

        // Keep import modal defaults in sync with settings
        syncImportAutoDownloadGallery();
        syncImportAutoDownloadMedia();
        
        // Also update the current session search checkboxes
        const searchName = document.getElementById('searchName');
        const searchListingName = document.getElementById('searchListingName');
        const searchTags = document.getElementById('searchTags');
        const searchAuthor = document.getElementById('searchAuthor');
        const searchNotes = document.getElementById('searchNotes');
        const sortSelect = document.getElementById('sortSelect');
        if (searchName) searchName.checked = searchNameCheckbox.checked;
        if (searchListingName && searchListingNameCheckbox) searchListingName.checked = searchListingNameCheckbox.checked;
        if (searchTags) searchTags.checked = searchTagsCheckbox.checked;
        if (searchAuthor) searchAuthor.checked = searchAuthorCheckbox.checked;
        if (searchNotes) searchNotes.checked = searchNotesCheckbox.checked;
        const searchTagline = document.getElementById('searchTagline');
        if (searchTagline && searchTaglineCheckbox) searchTagline.checked = searchTaglineCheckbox.checked;
        if (sortSelect) sortSelect.value = defaultSortSelect.value;
        
        showToast('Settings saved', 'success');

        // A proxy that does not work is worth hearing about immediately rather
        // than discovering when a media run silently fetches nothing. Tested by
        // value, not by reading it back: the settings write is debounced.
        const currentProxyUrl = httpProxyUrlInput ? httpProxyUrlInput.value.trim() : '';
        if (currentProxyUrl !== previousProxyUrl) {
            verifyProxyAfterSave(currentProxyUrl);
        }

        closeModal();
        
        performSearch();

        // Rebuild provider selector to reflect new order
        providerSelectorInitialized = false;
        const selectorArea = document.getElementById('providerSelectorArea');
        if (selectorArea) {
            const cs = selectorArea.querySelector('select')?._customSelect;
            if (cs?.menu) cs.menu.remove();
            selectorArea.innerHTML = '';
        }
        if (currentView === 'online') {
            activateOnlineProvider(lastOnlineProviderId);
        }
        // Re-grade possible-match badges so a changed sensitivity threshold shows immediately.
        window.ProviderRegistry?.refreshActiveBrowseBadges?.();
    };
    
    // Save settings
    saveSettingsBtn.onclick = () => {
        const wasEnabled = getSetting('uniqueGalleryFolders');
        const willBeEnabled = uniqueGalleryFoldersCheckbox ? uniqueGalleryFoldersCheckbox.checked : false;
        
        if (wasEnabled && !willBeEnabled) {
            // Feature is being disabled - show confirmation modal
            showDisableGalleryFoldersModal(
                (movedImages) => {
                    // User confirmed - save settings
                    if (movedImages) {
                        showToast('Images moved to default folders', 'success');
                    }
                    doSaveSettings();
                },
                () => {
                    // User cancelled - revert checkbox
                    if (uniqueGalleryFoldersCheckbox) {
                        uniqueGalleryFoldersCheckbox.checked = true;
                    }
                }
            );
        } else {
            // Normal save
            doSaveSettings();
        }
    };
    
    // Restore defaults - resets to default values AND saves them
    resetSettingsBtn.onclick = () => {
        // Reset form UI to defaults
        chubTokenInput.value = '';
        rememberTokenCheckbox.checked = false;
        // Same removed-provider fields as in doSaveSettings above; `if (x)` does
        // not guard an undeclared identifier either, so Restore Defaults threw
        // here for the same reason.
        minScoreSlider.value = DEFAULT_SETTINGS.duplicateMinScore;
        minScoreValue.textContent = String(DEFAULT_SETTINGS.duplicateMinScore);
        if (possibleMatchScoreSlider) {
            possibleMatchScoreSlider.value = DEFAULT_SETTINGS.possibleMatchMinScore;
            if (possibleMatchScoreValue) possibleMatchScoreValue.textContent = String(DEFAULT_SETTINGS.possibleMatchMinScore);
        }
        if (importDirectDownloadsCheckbox) {
            importDirectDownloadsCheckbox.checked = DEFAULT_SETTINGS.importDirectDownloads;
        }
        searchNameCheckbox.checked = DEFAULT_SETTINGS.searchInName;
        if (searchListingNameCheckbox) searchListingNameCheckbox.checked = DEFAULT_SETTINGS.searchInListingName;
        searchTagsCheckbox.checked = DEFAULT_SETTINGS.searchInTags;
        searchAuthorCheckbox.checked = DEFAULT_SETTINGS.searchInAuthor;
        searchNotesCheckbox.checked = DEFAULT_SETTINGS.searchInNotes;
        if (searchTaglineCheckbox) searchTaglineCheckbox.checked = DEFAULT_SETTINGS.searchInTagline;
        defaultSortSelect.value = DEFAULT_SETTINGS.defaultSort;
        if (defaultFilterPresetSelect) {
            populateDefaultFilterPresetSelect(defaultFilterPresetSelect, DEFAULT_SETTINGS.defaultFilterPreset);
        }
        if (groupFavoritesFirstCheckbox) {
            groupFavoritesFirstCheckbox.checked = DEFAULT_SETTINGS.groupFavoritesFirst;
        }
        if (httpProxyUrlInput) httpProxyUrlInput.value = DEFAULT_SETTINGS.httpProxyUrl || '';
        richCreatorNotesCheckbox.checked = DEFAULT_SETTINGS.richCreatorNotes;
        if (expandCreatorNotesCheckbox) expandCreatorNotesCheckbox.checked = DEFAULT_SETTINGS.expandCreatorNotes;
        if (displayNamePreferenceSelect) displayNamePreferenceSelect.value = DEFAULT_SETTINGS.displayNamePreference;
        if (displayNameOverrideCheckbox) displayNameOverrideCheckbox.checked = DEFAULT_SETTINGS.displayNameOverrideEnabled;
        if (showNameToggleCheckbox) showNameToggleCheckbox.checked = DEFAULT_SETTINGS.showNameToggle;
        if (highlightColorInput) {
            highlightColorInput.value = DEFAULT_SETTINGS.highlightColor;
        }
        if (includeLorebookCheckbox) {
            includeLorebookCheckbox.checked = DEFAULT_SETTINGS.includeLorebook;
        }
        if (replaceUserPlaceholderCheckbox) {
            replaceUserPlaceholderCheckbox.checked = DEFAULT_SETTINGS.replaceUserPlaceholder;
        }
        if (importMediaActionSelect) {
            importMediaActionSelect.value = DEFAULT_SETTINGS.importMediaAction;
        }
        if (uniqueGalleryFoldersCheckbox) {
            uniqueGalleryFoldersCheckbox.checked = DEFAULT_SETTINGS.uniqueGalleryFolders;
        }
        if (showProviderTaglineCheckbox) {
            showProviderTaglineCheckbox.checked = DEFAULT_SETTINGS.showProviderTagline;
        }
        if (browseSnapSectionsCheckbox) {
            browseSnapSectionsCheckbox.checked = DEFAULT_SETTINGS.browseSnapSections;
        }
        if (collapseAllBrowseSectionsCheckbox) {
            collapseAllBrowseSectionsCheckbox.checked = DEFAULT_SETTINGS.collapseAllBrowseSections;
        }
        if (mobileProviderQuickSwitchCheckbox) {
            mobileProviderQuickSwitchCheckbox.checked = DEFAULT_SETTINGS.mobileProviderQuickSwitch;
        }
        if (mobileHideBackArrowsCheckbox) {
            mobileHideBackArrowsCheckbox.checked = DEFAULT_SETTINGS.mobileHideBackArrows;
        }
        if (mobileBrowseQuickImportCheckbox) {
            mobileBrowseQuickImportCheckbox.checked = DEFAULT_SETTINGS.mobileBrowseQuickImport;
        }
        if (mobileSwipeGesturesCheckbox) {
            mobileSwipeGesturesCheckbox.checked = DEFAULT_SETTINGS.mobileSwipeGestures;
        }
        if (mobileHapticsCheckbox) {
            mobileHapticsCheckbox.checked = DEFAULT_SETTINGS.mobileHaptics;
        }
        if (useGridThumbnailsCheckbox) {
            useGridThumbnailsCheckbox.checked = DEFAULT_SETTINGS.useGridThumbnails;
        }
        if (gridThumbDesktopCheckbox) {
            gridThumbDesktopCheckbox.checked = DEFAULT_SETTINGS.gridThumbnailsDesktop;
        }
        if (gridThumbHiResCheckbox) {
            gridThumbHiResCheckbox.checked = DEFAULT_SETTINGS.gridThumbnailsHiRes;
        }
        if (gridThumbSizeSelect) {
            gridThumbSizeSelect.value = String(DEFAULT_SETTINGS.gridThumbnailSize);
        }
        applyGridThumbsDisabledStates();

        // Provider Order & Defaults - reset to registration order
        resetProviderOrderUI();

        // Infinite Scroll - reset all to enabled
        const isContainer = document.getElementById('infiniteScrollToggles');
        if (isContainer) {
            isContainer.querySelectorAll('.infinite-scroll-toggle').forEach(cb => { cb.checked = true; });
        }

        // Exclude Tags - clear pills
        populateAllExcludeTagPills();
        
        // Apply default highlight color immediately
        applyHighlightColor(DEFAULT_SETTINGS.highlightColor);
        
        // Clear caches
        clearAllMediaLocalizationCache();
        
        // Save defaults to storage (preserving tokens/credentials)
        const preserveChub = getSetting('chubRememberToken') ? getSetting('chubToken') : null;
        setSettings({
            ...DEFAULT_SETTINGS,
            chubToken: preserveChub,
            datacatToken: getSetting('datacatToken') || null,
            datacatJanitoraiToken: getSetting('datacatJanitoraiToken') || null,
            datacatJanitoraiRefreshToken: getSetting('datacatJanitoraiRefreshToken') || null,
            janitoraiToken: getSetting('janitoraiToken') || null,
            janitoraiRefreshToken: getSetting('janitoraiRefreshToken') || null,
            janitoraiEmail: getSetting('janitoraiEmail') || null,
            janitoraiPassword: getSetting('janitoraiPassword') || null,
        });
        
        const searchName = document.getElementById('searchName');
        const searchListingName = document.getElementById('searchListingName');
        const searchTags = document.getElementById('searchTags');
        const searchAuthor = document.getElementById('searchAuthor');
        const searchNotes = document.getElementById('searchNotes');
        const sortSelect = document.getElementById('sortSelect');
        if (searchName) searchName.checked = DEFAULT_SETTINGS.searchInName;
        if (searchListingName) searchListingName.checked = DEFAULT_SETTINGS.searchInListingName;
        if (searchTags) searchTags.checked = DEFAULT_SETTINGS.searchInTags;
        if (searchAuthor) searchAuthor.checked = DEFAULT_SETTINGS.searchInAuthor;
        if (searchNotes) searchNotes.checked = DEFAULT_SETTINGS.searchInNotes;
        const searchTagline = document.getElementById('searchTagline');
        if (searchTagline) searchTagline.checked = DEFAULT_SETTINGS.searchInTagline;
        if (sortSelect) sortSelect.value = DEFAULT_SETTINGS.defaultSort;
        
        showToast('Settings restored to defaults', 'success');
    };

    /**
     * Ask the server whether its outbound proxy is working, and paint the badge.
     *
     * @param {string|null} overrideUrl Test this URL instead of the stored one.
     *   Passed after a save because the settings write is debounced 400ms and
     *   fire-and-forget (see archive-api.js flushSettings) -- reading the stored
     *   value straight after a save would race that timer and sometimes report
     *   on the *previous* proxy. Null reads whatever is stored.
     */
    async function updateProxyStatus(overrideUrl) {
        if (!proxyStatusBadge) return;
        const paint = (cls, text, detail) => {
            proxyStatusBadge.className = `settings-status-badge ${cls}`;
            proxyStatusBadge.innerHTML = `<i class="fa-solid fa-circle"></i> ${text}`;
            if (proxyStatusDetail && detail) proxyStatusDetail.textContent = detail;
        };
        paint('inactive', 'Checking...');
        let data;
        try {
            const qs = overrideUrl === null ? '' : `?url=${encodeURIComponent(overrideUrl)}`;
            const resp = await fetch(`/api/v1/proxy/status${qs}`);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            data = await resp.json();
        } catch (e) {
            paint('error', 'Check failed', `Could not reach the archive server: ${e.message}`);
            return;
        }
        const seenAs = data.direct_ip ? ` Direct connection looks like ${data.direct_ip}.` : '';
        if (data.state === 'unset') {
            paint('inactive', 'Direct (no proxy)', `Fetching without a proxy.${seenAs}`);
        } else if (data.state === 'ok') {
            paint('active', `Connected · ${data.proxy_ip}`,
                `The proxy is carrying traffic: it reports ${data.proxy_ip}.${seenAs} ${data.latency_ms}ms.`);
        } else if (data.state === 'bypassed') {
            // Not an error and not a success: reachable, but the outside world
            // sees the same address either way, so nothing is being hidden.
            paint('warn', `Same IP · ${data.proxy_ip}`,
                `The proxy answered but reports the same address as a direct connection (${data.proxy_ip}), so traffic may not be routing through it.`);
        } else {
            paint('error', 'Unreachable', `${data.url || 'The proxy'} could not be used: ${data.error || 'unknown error'}`);
        }
    }

    /**
     * The post-save check. Reports through a toast rather than the badge,
     * because the settings modal has closed by the time this resolves.
     */
    async function verifyProxyAfterSave(url) {
        try {
            const qs = `?url=${encodeURIComponent(url)}`;
            const data = await (await fetch(`/api/v1/proxy/status${qs}`)).json();
            if (data.state === 'ok') {
                showToast(`Proxy connected - external IP ${data.proxy_ip}`, 'success');
            } else if (data.state === 'bypassed') {
                showToast(`Proxy reachable but not changing your IP (${data.proxy_ip})`, 'warning');
            } else if (data.state === 'unset') {
                showToast('Proxy cleared - fetching directly', 'success');
            } else {
                showToast(`Proxy unreachable: ${data.error || 'unknown error'}`, 'error');
            }
        } catch (e) {
            showToast(`Could not verify the proxy: ${e.message}`, 'error');
        }
    }

    if (testProxyBtn) {
        // Tests what is typed, not what is stored, so a URL can be checked
        // before committing it.
        testProxyBtn.addEventListener('click', () => {
            updateProxyStatus(httpProxyUrlInput ? httpProxyUrlInput.value.trim() : '');
        });
    }

    // DataCat session management
    function updateDatacatSessionStatus() {
        if (!datacatSessionStatus) return;
        if (!window.datacatValidateSession) {
            datacatSessionStatus.className = 'settings-status-badge inactive';
            datacatSessionStatus.innerHTML = '<i class="fa-solid fa-circle"></i> Module not loaded';
            return;
        }
        window.datacatValidateSession().then(result => {
            if (result.valid) {
                datacatSessionStatus.className = 'settings-status-badge active';
                datacatSessionStatus.innerHTML = '<i class="fa-solid fa-circle"></i> Active';
            } else {
                datacatSessionStatus.className = 'settings-status-badge inactive';
                datacatSessionStatus.innerHTML = `<i class="fa-solid fa-circle"></i> Inactive`;
            }
        });
    }

    // Version display reads the manifest (the single version source) so it cant drift;
    // no-cache forces revalidation so an update isnt masked by heuristic HTTP caching
    fetch('../manifest.json', { cache: 'no-cache' })
        .then(r => r.json())
        .then(manifest => {
            const el = document.getElementById('clAppVersion');
            if (el && manifest?.version) el.textContent = `v${manifest.version}`;
        })
        .catch(() => { /* html fallback text stays */ });

    document.getElementById('datacatRestoreAvatarsBtn')?.addEventListener('click', () => {
        // Closes settings first: the restore modal opens its own review surface on top.
        if (!window.datacatRestoreAvatars) {
            showToast('DataCat module not ready', 'error');
            return;
        }
        document.getElementById('gallerySettingsModal')?.classList.remove('visible');
        window.datacatRestoreAvatars();
    });

    const validateDatacatBtn = document.getElementById('validateDatacatBtn');
    if (validateDatacatBtn) {
        validateDatacatBtn.onclick = async (e) => {
            e.preventDefault();
            validateDatacatBtn.classList.remove('success', 'error');
            const originalHtml = '<i class="fa-solid fa-check"></i>';
            validateDatacatBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
            validateDatacatBtn.disabled = true;

            try {
                if (!window.datacatValidateSession) {
                    showToast('DataCat module not ready', 'error');
                    throw new Error('Module not ready');
                }
                const result = await window.datacatValidateSession();
                if (result.valid) {
                    showToast('DataCat session is valid!', 'success');
                    validateDatacatBtn.classList.add('success');
                    updateDatacatSessionStatus();
                } else {
                    showToast(`Session invalid: ${result.reason || 'Unknown'}`, 'error');
                    validateDatacatBtn.classList.add('error');
                    validateDatacatBtn.innerHTML = '<i class="fa-solid fa-times"></i>';
                    updateDatacatSessionStatus();
                }
            } catch (err) {
                if (!validateDatacatBtn.classList.contains('error')) {
                    showToast(`Validation error: ${err.message}`, 'error');
                    validateDatacatBtn.classList.add('error');
                    validateDatacatBtn.innerHTML = '<i class="fa-solid fa-exclamation"></i>';
                }
            } finally {
                validateDatacatBtn.disabled = false;
                if (validateDatacatBtn.classList.contains('success')) {
                    validateDatacatBtn.innerHTML = '<i class="fa-solid fa-check"></i>';
                }
                setTimeout(() => {
                    validateDatacatBtn.classList.remove('success', 'error');
                    validateDatacatBtn.innerHTML = originalHtml;
                }, 3000);
            }
        };
    }

    const datacatRefreshTokenBtn = document.getElementById('datacatRefreshTokenBtn');
    if (datacatRefreshTokenBtn) {
        datacatRefreshTokenBtn.onclick = async () => {
            datacatRefreshTokenBtn.disabled = true;
            datacatRefreshTokenBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Requesting...';
            try {
                if (!window.datacatRefreshToken) {
                    showToast('DataCat module not ready', 'error');
                    return;
                }
                const newToken = await window.datacatRefreshToken();
                if (newToken) {
                    setSetting('datacatToken', newToken);
                    if (datacatTokenInput) datacatTokenInput.value = newToken;
                    showToast('New DataCat token obtained!', 'success');
                    updateDatacatSessionStatus();
                } else {
                    showToast('Failed to obtain new token', 'error');
                }
            } catch (err) {
                showToast(`Refresh error: ${err.message}`, 'error');
            } finally {
                datacatRefreshTokenBtn.disabled = false;
                datacatRefreshTokenBtn.innerHTML = '<i class="fa-solid fa-rotate"></i> New Token';
            }
        };
    }

    const datacatClearTokenBtn = document.getElementById('datacatClearTokenBtn');
    if (datacatClearTokenBtn) {
        datacatClearTokenBtn.onclick = async () => {
            try {
                if (window.datacatClearSession) await window.datacatClearSession();
                setSetting('datacatToken', null);
                if (datacatTokenInput) datacatTokenInput.value = '';
                showToast('DataCat session cleared', 'info');
                updateDatacatSessionStatus();
            } catch (err) {
                showToast(`Clear error: ${err.message}`, 'error');
            }
        };
    }

    // ---- DataCat's JanitorAI Login (session cookie; unlocks Hampter pagination) ----
    // Its own session, not the provider's; refresh lives in datacat-provider (window.datacatJanitorai*).
    const datacatJanitoraiTokenInputEl = document.getElementById('settingsDatacatJanitoraiToken');
    const toggleDatacatJanitoraiTokenBtn = document.getElementById('toggleDatacatJanitoraiTokenVisibility');
    const saveDatacatJanitoraiTokenBtn = document.getElementById('saveDatacatJanitoraiTokenBtn');
    const clearDatacatJanitoraiTokenBtn = document.getElementById('clearDatacatJanitoraiTokenBtn');
    const datacatJanitoraiTokenStatusEl = document.getElementById('datacatJanitoraiTokenStatus');

    function updateDatacatJanitoraiStatus() {
        if (!datacatJanitoraiTokenStatusEl) return;
        const set = (cls, icon, text) => { datacatJanitoraiTokenStatusEl.className = `settings-status-badge ${cls}`; datacatJanitoraiTokenStatusEl.innerHTML = `<i class="fa-solid ${icon}"></i> ${text}`; };
        const status = window.datacatJanitoraiSessionStatus?.() || { loggedIn: !!getSetting('datacatJanitoraiToken') };
        if (!status.loggedIn) return set('inactive', 'fa-circle', 'Not logged in');
        // A refresh token keeps the session alive; without one it lapses in ~3h (bare-JWT paste).
        if (status.hasRefresh === false) return set('active', 'fa-triangle-exclamation', `Logged in${status.email ? ' as ' + status.email : ''} (expires in ~3h; paste the full cookie for a lasting session)`);
        set('active', 'fa-circle-check', `Logged in${status.email ? ' as ' + status.email : ''}`);
    }
    updateDatacatJanitoraiStatus();

    if (toggleDatacatJanitoraiTokenBtn && datacatJanitoraiTokenInputEl) {
        toggleDatacatJanitoraiTokenBtn.onclick = () => {
            const isPassword = datacatJanitoraiTokenInputEl.type === 'password';
            datacatJanitoraiTokenInputEl.type = isPassword ? 'text' : 'password';
            toggleDatacatJanitoraiTokenBtn.innerHTML = `<i class="fa-solid fa-eye${isPassword ? '-slash' : ''}"></i>`;
        };
    }
    if (saveDatacatJanitoraiTokenBtn && datacatJanitoraiTokenInputEl) {
        saveDatacatJanitoraiTokenBtn.onclick = async () => {
            const raw = (datacatJanitoraiTokenInputEl.value || '').trim();
            if (!raw) { showToast('Paste your sb-auth-auth-token cookie value first', 'warning'); return; }
            const original = saveDatacatJanitoraiTokenBtn.innerHTML;
            saveDatacatJanitoraiTokenBtn.disabled = true;
            saveDatacatJanitoraiTokenBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';
            try {
                const res = await window.datacatJanitoraiSetSession?.(raw);
                if (res?.ok) {
                    datacatJanitoraiTokenInputEl.value = '';
                    updateDatacatJanitoraiStatus();
                    if (res.hasRefresh) showToast(`DataCat is now signed in to JanitorAI${res.email ? ' as ' + res.email : ''}`, 'success');
                    else showToast('Logged in, but no refresh token was in that value; this session expires in ~3h. Copy the whole sb-auth-auth-token cookie for a lasting login.', 'warning', 9000);
                } else {
                    showToast(res?.error || 'Could not save the session', 'error');
                }
            } catch (err) {
                showToast(`Login error: ${err.message}`, 'error');
            } finally {
                saveDatacatJanitoraiTokenBtn.disabled = false;
                saveDatacatJanitoraiTokenBtn.innerHTML = original;
            }
        };
    }
    if (clearDatacatJanitoraiTokenBtn) {
        clearDatacatJanitoraiTokenBtn.onclick = () => {
            window.datacatJanitoraiLogout?.();
            if (datacatJanitoraiTokenInputEl) datacatJanitoraiTokenInputEl.value = '';
            updateDatacatJanitoraiStatus();
            showToast('DataCat signed out of JanitorAI', 'info');
        };
    }

    function updateGalleryMigrationStatus() {
        if (!galleryMigrationStatus || !galleryMigrationStatusText) return;

        if (window.extensionsRecoveryInProgress) {
            galleryMigrationStatus.style.display = 'block';
            galleryMigrationStatusText.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Recovering character data — gallery status will update when done.`;
            return;
        }

        const needsId = countCharactersNeedingGalleryId();
        const unknown = allCharacters.filter(c => !extensionsReady(c)).length;
        const total = allCharacters.length;
        const hasId = total - needsId - unknown;

        if (total === 0) {
            galleryMigrationStatus.style.display = 'none';
            return;
        }

        galleryMigrationStatus.style.display = 'block';

        if (needsId === 0 && unknown === 0) {
            galleryMigrationStatusText.innerHTML = `<i class="fa-solid fa-check-circle" style="color: var(--cl-success);"></i> All ${total} characters have gallery IDs.`;
        } else if (needsId === 0) {
            galleryMigrationStatusText.innerHTML = `<i class="fa-solid fa-info-circle"></i> ${hasId}/${total} characters have gallery IDs. ${unknown} could not be checked (character data unavailable).`;
        } else {
            galleryMigrationStatusText.innerHTML = `<i class="fa-solid fa-info-circle"></i> ${hasId}/${total} characters have gallery IDs. ${needsId} need assignment.${unknown > 0 ? ` ${unknown} could not be checked.` : ''}`;
        }
    }
    
    if (migrateGalleryFoldersBtn) {
        migrateGalleryFoldersBtn.onclick = async () => {
            if (!getSetting('uniqueGalleryFolders')) {
                showToast('Enable "Use unique gallery folder names" first!', 'error');
                return;
            }
            if (window.extensionsRecoveryInProgress) {
                showToast('Character data is still loading — please wait', 'warning');
                return;
            }

            const needsId = countCharactersNeedingGalleryId();
            if (needsId === 0) {
                showToast('All characters already have gallery IDs.', 'info');
                updateGalleryMigrationStatus();
                return;
            }

            const confirmMsg = `Assign unique gallery IDs to ${needsId} character(s)?\n\n` +
                `Gallery IDs are stored in character data (data.extensions.gallery_id) and travel with the card. Folder names are computed live from name + ID (no settings mapping needed).\n\n` +
                `Existing images are NOT moved.`;
            if (!confirm(confirmMsg)) return;

            const originalText = migrateGalleryFoldersBtn.innerHTML;
            migrateGalleryFoldersBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Processing...';
            migrateGalleryFoldersBtn.disabled = true;

            let assigned = 0, errors = 0, processed = 0;
            for (const char of allCharacters) {
                if (!extensionsReady(char) || getCharacterGalleryId(char)) continue;
                const result = await assignGalleryIdToCharacter(char);
                if (result.success) assigned++;
                else { errors++; console.error(`Failed to assign gallery_id to ${char.name}:`, result.error); }
                processed++;
                if (galleryMigrationStatusText) {
                    galleryMigrationStatusText.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Assigning IDs... ${processed}/${needsId}`;
                }
            }

            migrateGalleryFoldersBtn.innerHTML = originalText;
            migrateGalleryFoldersBtn.disabled = false;
            updateGalleryMigrationStatus();

            if (errors === 0) {
                showToast(`${assigned} gallery IDs assigned.`, 'success');
            } else {
                showToast(`${assigned} assigned, ${errors} failed. Check console.`, 'error');
            }
        };
    }
    
    // Update image relocation status display
    function updateImageRelocationStatus() {
        if (!imageRelocationStatus || !imageRelocationStatusText) return;
        
        const { sharedNameGroups, charactersAffected } = countCharactersNeedingImageRelocation();
        
        if (sharedNameGroups === 0) {
            imageRelocationStatus.style.display = 'none';
            return;
        }
        
        imageRelocationStatus.style.display = 'block';
        imageRelocationStatusText.innerHTML = `<i class="fa-solid fa-info-circle"></i> Found ${sharedNameGroups} shared name group(s) with ${charactersAffected} characters that may have mixed gallery images.`;
    }
    
    // Image relocation button handler
    if (relocateSharedImagesBtn) {
        relocateSharedImagesBtn.onclick = async () => {
            if (window.extensionsRecoveryInProgress) {
                showToast('Character data is still loading — please wait', 'warning');
                return;
            }
            const sharedNames = findCharactersWithSharedNames();
            
            if (sharedNames.size === 0) {
                showToast('No characters share the same name - no relocation needed!', 'info');
                return;
            }
            
            if (!getSetting('uniqueGalleryFolders')) {
                showToast('Enable "Unique Gallery Folders" first before relocating images.', 'error');
                return;
            }
            
            // Check that all characters have gallery IDs
            const needsId = countCharactersNeedingGalleryId();
            if (needsId > 0) {
                showToast(`Please assign gallery IDs first (${needsId} characters need IDs).`, 'error');
                return;
            }
            const unknownIds = allCharacters.filter(c => !extensionsReady(c)).length;
            if (unknownIds > 0) {
                showToast(`Character data could not be loaded for ${unknownIds} character(s) - reload and try again before relocating.`, 'error');
                return;
            }
            
            // Build description of what will happen
            let groupDescriptions = [];
            for (const [name, chars] of sharedNames) {
                const linkedCount = chars.filter(c => window.ProviderRegistry?.getLinkInfo(c)).length;
                groupDescriptions.push(`• "${name}": ${chars.length} characters (${linkedCount} linked)`);
            }
            
            const confirmed = confirm(
                `Smart Image Relocation\n\n` +
                `This will analyze and move gallery images for characters sharing the same name:\n\n` +
                `${groupDescriptions.slice(0, 5).join('\n')}` +
                `${groupDescriptions.length > 5 ? `\n...and ${groupDescriptions.length - 5} more groups` : ''}\n\n` +
                `Process:\n` +
                `1. Download provider gallery + embedded media to build ownership "fingerprints"\n` +
                `2. Scan shared folders and match images by content hash\n` +
                `3. Move matched images to unique folders\n\n` +
                `⚠ Images that can't be matched will remain in the shared folder.\n` +
                `⚠ This may take several minutes for many characters.\n\n` +
                `Continue?`
            );
            
            if (!confirmed) return;
            
            const originalText = relocateSharedImagesBtn.innerHTML;
            relocateSharedImagesBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Processing...';
            relocateSharedImagesBtn.disabled = true;
            
            let totalMoved = 0;
            let totalUnmatched = 0;
            let totalErrors = 0;
            let groupsProcessed = 0;
            // Shared breaker: a run of provider block statuses trips shouldAbort, stopping every loop layer.
            const rateLimit = { tripped: false, consecutiveBlocks: 0, providerName: '' };
            const shouldAbort = () => rateLimit.tripped;

            for (const [name, chars] of sharedNames) {
                // Update status
                if (imageRelocationStatusText) {
                    imageRelocationStatusText.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Processing "${name}"... (${groupsProcessed + 1}/${sharedNames.size} groups)`;
                }
                
                const result = await relocateSharedFolderImages(chars, {
                    onLog: (msg, status) => {
                        debugLog(`[Relocate] ${msg}`);
                        return msg;
                    },
                    onLogUpdate: (entry, msg, status) => {
                        debugLog(`[Relocate] ${msg}`);
                    },
                    shouldAbort,
                    rateLimit
                });

                totalMoved += result.moved;
                totalUnmatched += result.unmatched;
                totalErrors += result.errors;

                // Break before the increment: a blocked (zero-move) group must not count as completed.
                if (rateLimit.tripped) break;
                groupsProcessed++;
            }
            
            relocateSharedImagesBtn.innerHTML = originalText;
            relocateSharedImagesBtn.disabled = false;
            
            updateImageRelocationStatus();
            
            // Show summary
            if (rateLimit.tripped) {
                const who = rateLimit.providerName || 'The provider';
                showToast(`${who} rate-limited your connection, so relocation stopped after ${groupsProcessed}/${sharedNames.size} group(s). Wait a few minutes, then run it again (images already moved are skipped).`, 'warning', 10000);
            } else {
                const message = `Relocation complete: ${totalMoved} images moved, ${totalUnmatched} unmatched, ${totalErrors} errors`;
                showToast(message, totalErrors === 0 ? 'success' : 'error');
            }
            
            debugLog('[ImageRelocation] Summary:', { totalMoved, totalUnmatched, totalErrors, groupsProcessed });
        };
    }
    
    // Migrate All Images button handler (for characters with unique names)
    const migrateAllImagesBtn = document.getElementById('migrateAllImagesBtn');
    const migrateAllStatus = document.getElementById('migrateAllStatus');
    const migrateAllStatusText = document.getElementById('migrateAllStatusText');
    
    if (migrateAllImagesBtn) {
        migrateAllImagesBtn.onclick = async () => {
            if (!getSetting('uniqueGalleryFolders')) {
                showToast('Enable "Unique Gallery Folders" first before migrating images.', 'error');
                return;
            }
            
            // Get characters with gallery IDs (excluding those with shared names - they need fingerprinting)
            const sharedNames = findCharactersWithSharedNames();
            const sharedAvatars = new Set();
            for (const [_, chars] of sharedNames) {
                chars.forEach(c => sharedAvatars.add(c.avatar));
            }
            
            const uniqueNameChars = allCharacters.filter(c => 
                getCharacterGalleryId(c) && !sharedAvatars.has(c.avatar)
            );
            
            if (uniqueNameChars.length === 0) {
                showToast('No characters with unique names need migration.', 'info');
                return;
            }
            
            const confirmed = confirm(
                `Migrate All Images\n\n` +
                `This will move ALL existing gallery images for ${uniqueNameChars.length} characters with unique names ` +
                `from their old folder to their new unique folder.\n\n` +
                `Example:\n` +
                `• "Alice" folder → "Alice_abc123xyz" folder\n\n` +
                `Note: Characters sharing the same name (${sharedNames.size} groups) are excluded - ` +
                `use "Smart Relocate" for those.\n\n` +
                `Continue?`
            );
            
            if (!confirmed) return;
            
            const originalText = migrateAllImagesBtn.innerHTML;
            migrateAllImagesBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Migrating...';
            migrateAllImagesBtn.disabled = true;
            
            if (migrateAllStatus) migrateAllStatus.style.display = 'block';
            
            let totalMoved = 0;
            let totalErrors = 0;
            let charsProcessed = 0;
            let charsWithImages = 0;
            
            for (const char of uniqueNameChars) {
                charsProcessed++;
                
                if (migrateAllStatusText) {
                    migrateAllStatusText.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Processing ${escapeHtml(char.name)}... (${charsProcessed}/${uniqueNameChars.length})`;
                }
                
                const result = await migrateCharacterImagesToUniqueFolder(char);
                
                if (result.moved > 0) {
                    charsWithImages++;
                    totalMoved += result.moved;
                }
                totalErrors += result.errors;
            }
            
            migrateAllImagesBtn.innerHTML = originalText;
            migrateAllImagesBtn.disabled = false;
            
            if (migrateAllStatusText) {
                migrateAllStatusText.innerHTML = `<i class="fa-solid fa-check"></i> Migration complete: ${totalMoved} images moved for ${charsWithImages} characters`;
            }
            
            // Show summary
            const message = `Migration complete: ${totalMoved} images moved for ${charsWithImages} characters` + 
                (totalErrors > 0 ? ` (${totalErrors} errors)` : '');
            showToast(message, totalErrors === 0 ? 'success' : 'error');
            
            debugLog('[MigrateAll] Summary:', { totalMoved, totalErrors, charsProcessed, charsWithImages });
        };
    }
    
    // View Folder Mapping button handler
    const viewFolderMappingBtn = document.getElementById('viewFolderMappingBtn');
    if (viewFolderMappingBtn) {
        viewFolderMappingBtn.onclick = () => {
            showFolderMappingModal();
        };
    }
    
    // Browse Orphaned Folders button handler
    const browseOrphanedFoldersBtn = document.getElementById('browseOrphanedFoldersBtn');
    if (browseOrphanedFoldersBtn) {
        browseOrphanedFoldersBtn.onclick = () => {
            showOrphanedFoldersModal();
        };
    }
    
    // When extensions recovery finishes, refresh gallery migration status so the
    // settings panel shows real counts instead of the "recovering" placeholder.
    document.addEventListener('cl-extensions-recovered', () => {
        updateGalleryMigrationStatus();
    });
}

// Helper to get cookie value
function getCookie(name) {
    const value = `; ${document.cookie}`;
    const parts = value.split(`; ${name}=`);
    if (parts.length === 2) return parts.pop().split(';').shift();
    return '';
}

function getQueryParam(name) {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get(name);
}

/**
 * Get CSRF token from URL param or cookie
 * @returns {string} The CSRF token
 */
function getCSRFToken() {
    return getQueryParam('csrf') || getCookie('X-CSRF-Token');
}

