// ========================================
// NOTIFICATIONS CENTER
// Section-based topbar dropdown. Modules contribute sections (gallery sync,
// media downloads); the shell owns the button state, visibility, and open
// dispatch. Warning beats activity beats neutral for the button icon.
// ========================================

const _notifSections = new Map(); // id -> { id, getStatus, onOpen }

function registerNotificationSection(cfg) {
    if (!cfg?.id) return;
    _notifSections.set(cfg.id, cfg);
    refreshNotificationsUI();
}

function getNotificationSectionEl(id) {
    return document.querySelector(`#notificationsDropdown [data-notif-section="${id}"]`);
}

function refreshNotificationsUI() {
    const btn = document.getElementById('notificationsBtn');
    if (!btn) return;
    const container = btn.closest('.notifications-container');
    const statuses = [];
    for (const s of _notifSections.values()) {
        try { statuses.push(s.getStatus?.() || {}); } catch { statuses.push({}); }
    }
    const anyVisible = statuses.some(s => s.visible);
    container?.classList.toggle('hidden', !anyVisible);
    if (!anyVisible) {
        document.getElementById('notificationsDropdown')?.classList.add('hidden');
        return;
    }
    const warning = statuses.find(s => s.visible && s.level === 'warning');
    const activity = statuses.find(s => s.visible && s.level === 'activity');
    const icon = btn.querySelector('i');
    const badge = btn.querySelector('.warning-badge');
    btn.classList.toggle('has-issues', !!warning);
    btn.classList.toggle('notif-activity', !warning && !!activity);
    if (warning) {
        if (icon) icon.className = warning.icon || 'fa-solid fa-triangle-exclamation';
        if (badge) {
            const text = warning.badge != null ? String(warning.badge) : '';
            badge.classList.toggle('hidden', !text);
            badge.textContent = text;
        }
        btn.title = warning.title || 'Attention needed';
    } else if (activity) {
        if (icon) icon.className = activity.icon || 'fa-solid fa-download';
        if (badge) badge.classList.add('hidden');
        btn.title = activity.title || 'Working...';
    } else {
        if (icon) icon.className = 'fa-solid fa-bell';
        if (badge) badge.classList.add('hidden');
        btn.title = 'Notifications';
    }
}

// Renders every visible section; used by the button click and the mobile sheet
function openNotificationsDropdown() {
    const dropdown = document.getElementById('notificationsDropdown');
    if (!dropdown) return;
    dropdown.classList.remove('hidden');
    for (const s of _notifSections.values()) {
        const el = getNotificationSectionEl(s.id);
        if (!el) continue;
        const visible = (() => { try { return !!s.getStatus?.()?.visible; } catch { return false; } })();
        el.classList.toggle('hidden', !visible);
        if (!visible) continue;
        try { s.onOpen?.(el); } catch (e) { console.error('[Notifications] onOpen failed:', s.id, e); }
    }
}

function setupNotificationsCenter() {
    const btn = document.getElementById('notificationsBtn');
    const dropdown = document.getElementById('notificationsDropdown');
    if (!btn || !dropdown) return;
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = !dropdown.classList.contains('hidden');
        closeAllTopbarDropdowns('notificationsDropdown');
        if (isOpen) dropdown.classList.add('hidden');
        else openNotificationsDropdown();
    });
    document.addEventListener('click', (e) => {
        if (!btn.contains(e.target) && !dropdown.contains(e.target)) {
            dropdown.classList.add('hidden');
        }
    });
}

// Event Listeners
function setupEventListeners() {
    setupNotificationsCenter();

    // View Toggle Buttons (Characters / Chats / Online)
    document.querySelectorAll('.view-toggle-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            switchView(btn.dataset.view);
        });
    });

    on('searchInput', 'input', debouncedSearch);

    // Filter Checkboxes
    ['searchName', 'searchListingName', 'searchTags', 'searchAuthor', 'searchNotes', 'searchTagline'].forEach(id => {
        on(id, 'change', performSearch);
    });

    // Tag Filter Toggle
    const tagBtn = document.getElementById('tagFilterBtn');
    const tagPopup = document.getElementById('tagFilterPopup');
    const clearAllTagsBtn = document.getElementById('clearAllTagsBtn');

    if (tagBtn && tagPopup) {
        tagBtn.onclick = (e) => {
            e.stopPropagation();
            closeAllTopbarDropdowns('tagFilterPopup');
            tagPopup.classList.toggle('hidden');
        };
        
        if (clearAllTagsBtn) {
            clearAllTagsBtn.onclick = (e) => {
                e.stopPropagation();
                clearAllTagFilters();
            };
        }
        
        // Close rules
        window.addEventListener('click', (e) => {
            if (!tagPopup.classList.contains('hidden') && 
                !tagPopup.contains(e.target) && 
                e.target !== tagBtn && 
                !tagBtn.contains(e.target)) {
                tagPopup.classList.add('hidden');
            }
        });
    }

    // Settings Toggle
    const settingsBtn = document.getElementById('searchSettingsBtn');
    const settingsMenu = document.getElementById('searchSettingsMenu');
    
    if(settingsBtn && settingsMenu) {
        settingsBtn.onclick = (e) => {
            e.stopPropagation();
            closeAllTopbarDropdowns('searchSettingsMenu');
            settingsMenu.classList.toggle('hidden');
        };

        // Close when clicking outside
        window.addEventListener('click', (e) => {
            if (!settingsMenu.classList.contains('hidden') && 
                !settingsMenu.contains(e.target) && 
                e.target !== settingsBtn && 
                !settingsBtn.contains(e.target)) {
                settingsMenu.classList.add('hidden');
            }
        });
    }
    
    // Advanced Filter Panel
    const advFilterBtn = document.getElementById('advFilterBtn');
    const advFilterPanel = document.getElementById('advFilterPanel');
    const advFilterRows = document.getElementById('advFilterRows');

    if (advFilterBtn && advFilterPanel) {
        advFilterBtn.onclick = (e) => {
            e.stopPropagation();
            toggleAdvFilterPanel();
        };

        on('advFilterAddBtn', 'click', (e) => {
            e.stopPropagation();
            addAdvFilterRule();
        });

        on('advFilterClearAll', 'click', (e) => {
            e.stopPropagation();
            clearAllAdvFilters();
        });

        advFilterPanel.addEventListener('click', (e) => e.stopPropagation());

        on('advFilterPresetsBtn', 'click', (e) => {
            e.stopPropagation();
            toggleAdvFilterPresetsPanel();
        });

        on('advFilterPresetSaveBtn', 'click', (e) => {
            e.stopPropagation();
            saveCurrentAsFilterPreset(document.getElementById('advFilterPresetNameInput')?.value || '');
        });

        document.getElementById('advFilterPresetNameInput')?.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return;
            e.stopPropagation();
            saveCurrentAsFilterPreset(e.target.value);
        });

        document.getElementById('advFilterPresetNameInput')?.addEventListener('input', (e) => {
            e.stopPropagation();
            rerenderAdvFilterPresets();
        });

        document.getElementById('advFilterPresetsList')?.addEventListener('click', (e) => {
            const load = e.target.closest('.adv-filter-preset-load');
            if (load) { applyFilterPreset(load.dataset.uid); return; }
            const del = e.target.closest('.adv-filter-preset-delete');
            if (del) deleteFilterPreset(del.dataset.uid);
        });

        if (advFilterRows) {
            advFilterRows.addEventListener('change', (e) => {
                const ruleId = parseInt(e.target.dataset.ruleId);
                const rule = getAdvFilterRules().find(r => r.id === ruleId);
                if (!rule) return;

                if (e.target.classList.contains('adv-filter-field')) {
                    rule.field = e.target.value;
                    const newField = getActiveAdvFilterFields()[rule.field];
                    rule.operator = newField.operators[0];
                    rule.value = getAdvFilterDefaultValue(rule);
                    rerenderAdvFilterRows();
                    updateAdvFilterIndicator();
                    triggerAdvFilterSearch();
                } else if (e.target.classList.contains('adv-filter-operator')) {
                    rule.operator = e.target.value;
                    rule.value = getAdvFilterDefaultValue(rule);
                    rerenderAdvFilterRows();
                    updateAdvFilterIndicator();
                    triggerAdvFilterSearch();
                } else if (e.target.classList.contains('adv-filter-input')) {
                    rule.value = e.target.value;
                    updateAdvFilterIndicator();
                    triggerAdvFilterSearch();
                }
            });

            advFilterRows.addEventListener('input', (e) => {
                if (!e.target.classList.contains('adv-filter-input')) return;
                const ruleId = parseInt(e.target.dataset.ruleId);
                const rule = getAdvFilterRules().find(r => r.id === ruleId);
                if (!rule) return;
                rule.value = e.target.value;
                updateAdvFilterIndicator();
                debouncedAdvFilterSearch();
            });

            advFilterRows.addEventListener('click', (e) => {
                const removeBtn = e.target.closest('.adv-filter-remove');
                if (!removeBtn) return;
                const ruleId = parseInt(removeBtn.dataset.ruleId);
                removeAdvFilterRule(ruleId);
            });
        }

        window.addEventListener('click', (e) => {
            if (!advFilterPanel.classList.contains('hidden') &&
                !advFilterPanel.contains(e.target) &&
                e.target !== advFilterBtn &&
                !advFilterBtn.contains(e.target)) {
                closeAdvFilterPanel();
            }
        });

        window.registerOverlay?.({
            id: 'advFilterPanel',
            tier: 10,
            close: () => closeAdvFilterPanel(),
        });
    }

    // More Options Dropdown Toggle
    const moreOptionsBtn = document.getElementById('moreOptionsBtn');
    const moreOptionsMenu = document.getElementById('moreOptionsMenu');
    
    if(moreOptionsBtn && moreOptionsMenu) {
        moreOptionsBtn.onclick = (e) => {
            e.stopPropagation();
            closeAllTopbarDropdowns('moreOptionsMenu');
            moreOptionsMenu.classList.toggle('hidden');
        };

        // Close when clicking outside
        window.addEventListener('click', (e) => {
            if (!moreOptionsMenu.classList.contains('hidden') && 
                !moreOptionsMenu.contains(e.target) && 
                e.target !== moreOptionsBtn && 
                !moreOptionsBtn.contains(e.target)) {
                moreOptionsMenu.classList.add('hidden');
            }
        });
        
        // Close menu when clicking any item inside
        moreOptionsMenu.querySelectorAll('.dropdown-item').forEach(item => {
            item.addEventListener('click', () => {
                moreOptionsMenu.classList.add('hidden');
            });
        });

    }

    // Favorites Filter Toggle (row-2 topbar button)
    on('favoritesFilterBtn', 'click', () => {
        toggleFavoritesFilter(!showFavoritesOnly);
    });
    
    // Clear Search Button
    const clearSearchBtn = document.getElementById('clearSearchBtn');
    const searchInputEl = document.getElementById('searchInput');
    
    if (clearSearchBtn && searchInputEl) {
        // Show/hide clear button based on input
        searchInputEl.addEventListener('input', () => {
            clearSearchBtn.classList.toggle('hidden', searchInputEl.value.length === 0);
        });
        
        // Clear search when clicked
        clearSearchBtn.addEventListener('click', () => {
            searchInputEl.value = '';
            clearSearchBtn.classList.add('hidden');
            performSearch();
        });
    }

    // Sort - delegate to performSearch so there is ONE sort+render codepath.
    // This eliminates the dual-sort bug where the sort handler and performSearch
    // could produce different results from stale/divergent data.
    on('sortSelect', 'change', (e) => {
        if (e?.target?.value === 'random') reshuffleRandomSort();
        performSearch();
    });
    
    // Favorites Filter Toggle (inside search settings dropdown)
    const favCheckbox = document.getElementById('searchFavoritesOnly');
    if (favCheckbox) {
        favCheckbox.addEventListener('change', () => toggleFavoritesFilter());
    }
    
    // Favorite Character Button in Modal
    const favoriteCharBtn = document.getElementById('favoriteCharBtn');
    if (favoriteCharBtn) {
        favoriteCharBtn.addEventListener('click', () => {
            if (activeChar) {
                toggleCharacterFavorite(activeChar);
            }
        });
    }

    // Download Character Button in Modal
    on('downloadCharBtn', 'click', async () => {
        if (!activeChar) return;
        try {
            await window.ModuleLoader?.get('context-menu')?.downloadCharacterPng(activeChar);
        } catch (err) {
            showToast('Download failed: ' + err.message, 'error');
        }
    });

    // Refresh - forces a rescan so disk changes made outside the app are picked
    // up, then preserves current filters and search.
    on('refreshLibraryBtn', 'click', async () => {
        const btn = document.getElementById('refreshLibraryBtn');
        const icon = btn?.querySelector('i');
        icon?.classList.add('fa-spin');

        try {
            await fetch('/api/v1/refresh', { method: 'POST' }).catch(e => console.warn('[Refresh] Rescan failed:', e));

            document.getElementById('characterGrid').innerHTML = '';
            document.getElementById('loading').style.display = '';

            try {
                const ctx = getSTContext();
                if (typeof ctx?.getCharacters === 'function') {
                    ctx.getCharacters().catch(e => console.warn('[Refresh] Host refresh failed:', e));
                }
            } catch (e) { /* host unavailable */ }

            await fetchCharacters(true);
            performSearch();
        } finally {
            icon?.classList.remove('fa-spin');
        }
    });
    
    // Delete Character Button
    const deleteCharBtn = document.getElementById('deleteCharBtn');
    if (deleteCharBtn) {
        deleteCharBtn.addEventListener('click', () => {
            if (activeChar) {
                showDeleteConfirmation(activeChar);
            }
        });
    }

    // Close Modal
    on('modalClose', 'click', maybeCloseModal);
    modal.addEventListener('click', (e) => {
        if (e.target === modal) maybeCloseModal();
    });

    // Char detail prev/next nav (desktop chevrons + keyboard; mobile swipe wired in library-mobile.js).
    on('charModalNavPrev', 'click', () => navigateModal(-1));
    on('charModalNavNext', 'click', () => navigateModal(1));
    // View-mode hero avatar overlay (desktop only; sidebar is hidden on mobile): click opens it in the gallery viewer, gallery images follow as prev/next.
    on('portraitViewOverlay', 'click', () => {
        if (activeChar) openAvatarInGalleryViewer(activeChar);
    });
    // Hover preload: warm the sibling's hero (only useful when the grid shows thumbs, else already cached).
    const navPrevBtn = document.getElementById('charModalNavPrev');
    const navNextBtn = document.getElementById('charModalNavNext');
    const previewSiblingAt = (offset) => {
        if (!activeChar) return null;
        const navList = getModalNavList();
        const idx = navList.findIndex(c => c.avatar === activeChar.avatar);
        if (idx === -1) return null;
        return navList[idx + offset] || null;
    };
    navPrevBtn?.addEventListener('mouseenter', () => {
        if (!gridUsesThumbnails()) return;
        const s = previewSiblingAt(-1);
        if (s) new Image().src = getCharacterAvatarUrl(s.avatar);
    });
    navNextBtn?.addEventListener('mouseenter', () => {
        if (!gridUsesThumbnails()) return;
        const s = previewSiblingAt(1);
        if (s) new Image().src = getCharacterAvatarUrl(s.avatar);
    });
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        if (modal.classList.contains('hidden')) return;
        // dont drive char nav while a gallery viewer / sub-modal sits on top of the detail modal
        if (getTopmostOverlay()?.reg?.id !== 'charModal') return;
        if (getSetting('enableCharDetailNav') === false) return;
        const t = e.target;
        const tag = t?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable) return;
        e.preventDefault();
        navigateModal(e.key === 'ArrowLeft' ? -1 : 1);
    });

    // Tabs
    getTabButtons().forEach(btn => {
        btn.addEventListener('click', () => {
            deactivateAllTabs();
            
            btn.classList.add('active');
            const tabId = btn.dataset.tab;
            const pane = document.getElementById(`pane-${tabId}`);
            pane.classList.add('active');
            
            // Reset scroll position when switching tabs
            pane.scrollTop = 0;
        });
    });
    
    setupCharacterGridDelegates();

    // Apply / Revert (Card tab is always editable; no lock). The header buttons are
    // shared across tabs: Apply acts on whichever of Card/Raw is currently active.
    on('applyCardBtn', 'click', () => {
        const rawActive = document.getElementById('pane-raw')?.classList.contains('active');
        if (rawActive) {
            if (document.getElementById('applyCardBtn')?.dataset.rawInvalid) {
                showToast('Fix the JSON error before applying', 'error');
                return;
            }
            applyRawTab();
        } else {
            applyCardTab();
        }
    });
    on('revertCardBtn', 'click', revertCardTab);

    // Dirty tracking: any field edit or add/remove-row click inside the Card
    // pane recomputes isCardDirty and shows/hides Apply/Revert.
    const cardPane = document.getElementById('pane-card');
    if (cardPane) {
        cardPane.addEventListener('input', () => refreshApplyState());
        cardPane.addEventListener('change', () => refreshApplyState());
        cardPane.addEventListener('click', (e) => {
            if (e.target.closest('button')) refreshApplyState();
        });
    }

    // Card Image change controls (in-place hero overlay)
    const portraitEditOverlay = document.getElementById('portraitEditOverlay');
    const portraitPendingRevertBtn = document.getElementById('portraitPendingRevertBtn');
    const editAvatarFileInput = document.getElementById('editAvatarFileInput');
    if (portraitEditOverlay && editAvatarFileInput) {
        portraitEditOverlay.onclick = () => {
            editAvatarFileInput.click();
        };
        editAvatarFileInput.addEventListener('change', (e) => {
            const file = e.target.files?.[0];
            if (file) handlePendingAvatarSelected(file);
        });
    }
    if (portraitPendingRevertBtn) {
        portraitPendingRevertBtn.onclick = (e) => {
            e.stopPropagation();
            clearPendingAvatar();
            refreshApplyState();
        };
    }

    // Edit Fields Expand/Collapse Toggle
    const editFieldsToggleBtn = document.getElementById('editFieldsToggleBtn');
    if (editFieldsToggleBtn) {
        editFieldsToggleBtn.onclick = toggleEditFieldsExpand;
    }

    // Creator's Notes: toggle between the rendered (sandboxed) view and the raw textarea.
    const creatorNotesEditToggleBtn = document.getElementById('creatorNotesEditToggleBtn');
    if (creatorNotesEditToggleBtn) {
        creatorNotesEditToggleBtn.onclick = () => toggleCreatorNotesEditMode();
    }

    // Raw tab
    on('copyRawJsonBtn', 'click', async () => {
        const ta = document.getElementById('rawCardJson');
        if (!ta) return;
        const success = await copyTextToClipboard(ta.value);
        showToast(success ? 'Copied to clipboard' : 'Failed to copy to clipboard', success ? 'success' : 'error');
    });
    const rawJsonTextarea = document.getElementById('rawCardJson');
    if (rawJsonTextarea) {
        let rawValidateTimer = null;
        rawJsonTextarea.addEventListener('input', () => {
            isRawDirty = true;
            clearTimeout(rawValidateTimer);
            rawValidateTimer = setTimeout(validateRawJsonTab, 250);
        });
    }

    // Gallery Settings Modal
    setupSettingsModal();
    
    // Add Alternate Greeting Button
    const addAltGreetingBtn = document.getElementById('addAltGreetingBtn');
    if (addAltGreetingBtn) {
        addAltGreetingBtn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            addAltGreetingField();
        };
    }
    
    // Add Lorebook Entry Button
    const addLorebookEntryBtn = document.getElementById('addLorebookEntryBtn');
    if (addLorebookEntryBtn) {
        addLorebookEntryBtn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            addLorebookEntryField();
            updateLorebookCount();
        };
    }

    // Upload Zone
    const uploadZone = document.getElementById('uploadZone');
    const fileInput = document.getElementById('imageUploadInput');
    
    if (uploadZone && fileInput) {
        uploadZone.onclick = (e) => {
            if (e.target !== fileInput) fileInput.click();
        };

        fileInput.onchange = (e) => {
            if (e.target.files.length) uploadImages(e.target.files);
            fileInput.value = ''; 
        };
        
        // Drag and drop
        uploadZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            uploadZone.style.borderColor = 'var(--accent)';
            uploadZone.style.backgroundColor = 'rgba(var(--accent-rgb), 0.1)';
        });
        
        uploadZone.addEventListener('dragleave', (e) => {
            e.preventDefault();
            uploadZone.style.borderColor = '';
            uploadZone.style.backgroundColor = '';
        });
        
        uploadZone.addEventListener('drop', (e) => {
            e.preventDefault();
            uploadZone.style.borderColor = '';
            uploadZone.style.backgroundColor = '';
            if (e.dataTransfer.files.length) uploadImages(e.dataTransfer.files);
        });
    }
}

// Alternate Greetings Editor Functions
function populateAltGreetingsEditor(greetings) {
    const container = document.getElementById('altGreetingsEditContainer');
    if (!container) return;

    container.innerHTML = '';

    if (greetings && greetings.length > 0) {
        greetings.forEach((greeting, index) => {
            addAltGreetingField(container, (greeting || '').trim(), index);
        });
    }
    updateAltGreetingsCount();
}

function updateAltGreetingsCount() {
    const countEl = document.getElementById('altGreetingsCount');
    const container = document.getElementById('altGreetingsEditContainer');
    if (!countEl || !container) return;
    const count = container.querySelectorAll('.alt-greeting-item').length;
    countEl.textContent = count > 0 ? `(${count})` : '';
}

function addAltGreetingField(container, value = '', index = null) {
    if (!container) {
        container = document.getElementById('altGreetingsEditContainer');
    }
    if (!container) return;
    
    const idx = index !== null ? index : container.children.length;
    
    const wrapper = document.createElement('div');
    wrapper.className = 'alt-greeting-item';
    wrapper.style.cssText = 'position: relative; margin-bottom: 10px;';
    
    wrapper.innerHTML = `
        <div style="display: flex; align-items: flex-start; gap: 8px;">
            <span style="color: var(--accent); font-weight: bold; padding-top: 8px;">#${idx + 1}</span>
            <textarea class="glass-input alt-greeting-input" rows="3" placeholder="Alternate greeting message..." style="flex: 1;"></textarea>
            <button type="button" class="remove-alt-greeting-btn" title="Remove this greeting">
                <i class="fa-solid fa-trash"></i>
            </button>
        </div>
    `;
    
    container.appendChild(wrapper);
    
    // Set the textarea value directly (not via innerHTML) to ensure .value property is set
    const textarea = wrapper.querySelector('.alt-greeting-input');
    if (textarea && value) {
        textarea.value = value;
    }
    
    // Add remove button handler
    const removeBtn = wrapper.querySelector('.remove-alt-greeting-btn');
    removeBtn.addEventListener('click', () => {
        wrapper.remove();
        renumberAltGreetings();
        updateAltGreetingsCount();
    });
    updateAltGreetingsCount();
}

function renumberAltGreetings() {
    const container = document.getElementById('altGreetingsEditContainer');
    if (!container) return;
    
    const items = container.querySelectorAll('.alt-greeting-item');
    items.forEach((item, idx) => {
        const numSpan = item.querySelector('span');
        if (numSpan) {
            numSpan.textContent = `#${idx + 1}`;
        }
    });
}

function getAltGreetingsFromEditor() {
    const container = document.getElementById('altGreetingsEditContainer');
    if (!container) return [];
    
    const inputs = container.querySelectorAll('.alt-greeting-input');
    const greetings = [];
    
    inputs.forEach(input => {
        const value = input.value;
        if (value.trim()) {  // Skip truly empty entries, but preserve original content
            greetings.push(value);
        }
    });
    
    return greetings;
}

