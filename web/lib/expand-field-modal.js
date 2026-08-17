// ==============================================
// Expand Field Modal for Larger Text Editing
// ==============================================

/**
 * Initialize click handlers for expand field buttons
 */
export function initExpandFieldButtons() {
    document.querySelectorAll('.expand-field-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const fieldId = btn.dataset.field;
            const fieldLabel = btn.dataset.label;
            openExpandedFieldEditor(fieldId, fieldLabel);
        });
    });
}

/**
 * Initialize section expand buttons for Greetings and Lorebook
 */
export function initSectionExpandButtons() {
    // Greetings expand button
    const expandGreetingsBtn = document.getElementById('expandGreetingsBtn');
    if (expandGreetingsBtn) {
        expandGreetingsBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            openGreetingsModal();
        });
    }

    // Lorebook expand button
    const expandLorebookBtn = document.getElementById('expandLorebookBtn');
    if (expandLorebookBtn) {
        expandLorebookBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            openLorebookModal();
        });
    }

}

/**
 * Open full-screen modal for editing all greetings (First Message + Alternate Greetings)
 */
function openGreetingsModal() {
    // Get current values from the edit form
    const firstMesField = document.getElementById('editFirstMes');
    const altGreetingsContainer = document.getElementById('altGreetingsEditContainer');

    if (!firstMesField) {
        showToast('Greetings fields not found', 'error');
        return;
    }

    // Collect current alternate greetings
    const altGreetings = [];
    if (altGreetingsContainer) {
        const altInputs = altGreetingsContainer.querySelectorAll('.alt-greeting-input');
        altInputs.forEach(input => {
            altGreetings.push(input.value);
        });
    }

    // Build modal HTML
    let altGreetingsHtml = '';
    altGreetings.forEach((greeting, idx) => {
        const previewText = greeting ? greeting.substring(0, 100).replace(/\n/g, ' ') + (greeting.length > 100 ? '...' : '') : 'Empty greeting';
        altGreetingsHtml += `
            <div class="expanded-greeting-item" data-index="${idx}">
                <div class="expanded-greeting-header">
                    <button type="button" class="expanded-greeting-collapse-btn" title="Expand/Collapse">
                        <i class="fa-solid fa-chevron-down"></i>
                    </button>
                    <span class="expanded-greeting-num">#${idx + 1}</span>
                    <span class="expanded-greeting-preview">${escapeHtml(previewText)}</span>
                    <button type="button" class="expanded-greeting-delete" title="Delete this greeting">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
                <textarea class="glass-input expanded-greeting-textarea" rows="6" placeholder="Alternate greeting message...">${escapeHtml(greeting)}</textarea>
            </div>
        `;
    });

    const modalHtml = `
        <div id="greetingsExpandModal" class="modal-overlay">
            <div class="modal-glass section-expand-modal" id="greetingsExpandModalInner">
                <div class="modal-header">
                    <h2><i class="fa-solid fa-comments"></i> Edit Greetings</h2>
                    <div class="modal-header-controls">
                        <div class="display-control-btns zoom-controls" id="greetingsZoomControls">
                            <button type="button" class="display-control-btn" data-zoom="out" title="Zoom Out">
                                <i class="fa-solid fa-minus"></i>
                            </button>
                            <span class="zoom-level" id="greetingsZoomDisplay">100%</span>
                            <button type="button" class="display-control-btn" data-zoom="in" title="Zoom In">
                                <i class="fa-solid fa-plus"></i>
                            </button>
                            <button type="button" class="display-control-btn" data-zoom="reset" title="Reset Zoom">
                                <i class="fa-solid fa-rotate-left"></i>
                            </button>
                        </div>
                    </div>
                    <div class="modal-controls">
                        <button id="greetingsModalSave" class="action-btn primary"><i class="fa-solid fa-check"></i> Apply All</button>
                        <button class="close-btn" id="greetingsModalClose">&times;</button>
                    </div>
                </div>
                <div class="section-expand-body" id="greetingsExpandBody">
                    <div class="expanded-greeting-section">
                        <h3 class="expanded-section-label"><i class="fa-solid fa-message"></i> First Message</h3>
                        <textarea id="expandedFirstMes" class="glass-input expanded-greeting-textarea first-message" rows="8" placeholder="Opening message from the character...">${escapeHtml(firstMesField.value)}</textarea>
                    </div>

                    <div class="expanded-greeting-section">
                        <h3 class="expanded-section-label">
                            <i class="fa-solid fa-layer-group"></i> Alternate Greetings
                            <div class="expanded-greetings-header-actions">
                                <button type="button" id="collapseAllGreetingsBtn" class="action-btn secondary small" title="Collapse All">
                                    <i class="fa-solid fa-compress-alt"></i>
                                </button>
                                <button type="button" id="expandAllGreetingsBtn" class="action-btn secondary small" title="Expand All">
                                    <i class="fa-solid fa-expand-alt"></i>
                                </button>
                                <button type="button" id="addExpandedGreetingBtn" class="action-btn secondary small">
                                    <i class="fa-solid fa-plus"></i> Add Greeting
                                </button>
                            </div>
                        </h3>
                        <div id="expandedAltGreetingsContainer" class="expanded-greetings-list">
                            ${altGreetingsHtml || '<div class="no-alt-greetings">No alternate greetings yet. Click "Add Greeting" to create one.</div>'}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;

    // Remove existing modal if any
    const existingModal = document.getElementById('greetingsExpandModal');
    if (existingModal) existingModal.remove();

    document.body.insertAdjacentHTML('beforeend', modalHtml);

    const modal = document.getElementById('greetingsExpandModal');
    const expandedFirstMes = document.getElementById('expandedFirstMes');
    const greetingsExpandBody = document.getElementById('greetingsExpandBody');

    // Focus first message textarea
    setTimeout(() => expandedFirstMes.focus(), 50);

    // Zoom controls
    let greetingsZoom = 100;
    const greetingsZoomDisplay = document.getElementById('greetingsZoomDisplay');

    const updateGreetingsZoom = (zoom) => {
        greetingsZoom = Math.max(50, Math.min(200, zoom));
        greetingsZoomDisplay.textContent = `${greetingsZoom}%`;
        greetingsExpandBody.style.zoom = `${greetingsZoom}%`;
    };

    document.getElementById('greetingsZoomControls').onclick = (e) => {
        const btn = e.target.closest('.display-control-btn[data-zoom]');
        if (!btn) return;
        const action = btn.dataset.zoom;
        if (action === 'in') updateGreetingsZoom(greetingsZoom + 10);
        else if (action === 'out') updateGreetingsZoom(greetingsZoom - 10);
        else if (action === 'reset') updateGreetingsZoom(100);
    };

    // Close handlers
    const closeModal = () => modal.remove();

    document.getElementById('greetingsModalClose').onclick = closeModal;
    modal.onclick = (e) => { if (e.target === modal) closeModal(); };

    // Add greeting handler
    document.getElementById('addExpandedGreetingBtn').onclick = () => {
        const container = document.getElementById('expandedAltGreetingsContainer');

        // Remove "no greetings" message if present
        const noGreetingsMsg = container.querySelector('.no-alt-greetings');
        if (noGreetingsMsg) noGreetingsMsg.remove();

        const idx = container.querySelectorAll('.expanded-greeting-item').length;
        const newGreetingHtml = `
            <div class="expanded-greeting-item" data-index="${idx}">
                <div class="expanded-greeting-header">
                    <button type="button" class="expanded-greeting-collapse-btn" title="Expand/Collapse">
                        <i class="fa-solid fa-chevron-down"></i>
                    </button>
                    <span class="expanded-greeting-num">#${idx + 1}</span>
                    <span class="expanded-greeting-preview">Empty greeting</span>
                    <button type="button" class="expanded-greeting-delete" title="Delete this greeting">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
                <textarea class="glass-input expanded-greeting-textarea" rows="6" placeholder="Alternate greeting message..."></textarea>
            </div>
        `;
        container.insertAdjacentHTML('beforeend', newGreetingHtml);

        // Add handlers to new item
        const newItem = container.lastElementChild;
        setupGreetingItemHandlers(newItem);

        // Focus the new textarea
        const newTextarea = newItem.querySelector('textarea');
        newTextarea.focus();
    };

    // Setup handlers for greeting items (delete + collapse)
    function setupGreetingItemHandlers(item) {
        const deleteBtn = item.querySelector('.expanded-greeting-delete');
        deleteBtn.onclick = () => {
            item.remove();
            renumberExpandedGreetings();
        };

        const collapseBtn = item.querySelector('.expanded-greeting-collapse-btn');
        if (collapseBtn) {
            collapseBtn.onclick = () => {
                const isCollapsed = item.classList.toggle('collapsed');
                collapseBtn.innerHTML = isCollapsed
                    ? '<i class="fa-solid fa-chevron-right"></i>'
                    : '<i class="fa-solid fa-chevron-down"></i>';
                // Update preview when collapsing
                if (isCollapsed) {
                    const preview = item.querySelector('.expanded-greeting-preview');
                    const textarea = item.querySelector('.expanded-greeting-textarea');
                    if (preview && textarea) {
                        const text = textarea.value;
                        const previewText = text ? text.substring(0, 100).replace(/\n/g, ' ') + (text.length > 100 ? '...' : '') : 'Empty greeting';
                        preview.textContent = previewText;
                    }
                }
            };
        }
    }

    function renumberExpandedGreetings() {
        const container = document.getElementById('expandedAltGreetingsContainer');
        const items = container.querySelectorAll('.expanded-greeting-item');
        items.forEach((item, idx) => {
            item.dataset.index = idx;
            const numSpan = item.querySelector('.expanded-greeting-num');
            if (numSpan) numSpan.textContent = `#${idx + 1}`;
        });

        // Show "no greetings" message if empty
        if (items.length === 0) {
            container.innerHTML = '<div class="no-alt-greetings">No alternate greetings yet. Click "Add Greeting" to create one.</div>';
        }
    }

    // Collapse/Expand All handlers
    document.getElementById('collapseAllGreetingsBtn').onclick = () => {
        const container = document.getElementById('expandedAltGreetingsContainer');
        container.querySelectorAll('.expanded-greeting-item').forEach(item => {
            item.classList.add('collapsed');
            const btn = item.querySelector('.expanded-greeting-collapse-btn');
            if (btn) btn.innerHTML = '<i class="fa-solid fa-chevron-right"></i>';
            // Update preview
            const preview = item.querySelector('.expanded-greeting-preview');
            const textarea = item.querySelector('.expanded-greeting-textarea');
            if (preview && textarea) {
                const text = textarea.value;
                const previewText = text ? text.substring(0, 100).replace(/\n/g, ' ') + (text.length > 100 ? '...' : '') : 'Empty greeting';
                preview.textContent = previewText;
            }
        });
    };

    document.getElementById('expandAllGreetingsBtn').onclick = () => {
        const container = document.getElementById('expandedAltGreetingsContainer');
        container.querySelectorAll('.expanded-greeting-item').forEach(item => {
            item.classList.remove('collapsed');
            const btn = item.querySelector('.expanded-greeting-collapse-btn');
            if (btn) btn.innerHTML = '<i class="fa-solid fa-chevron-down"></i>';
        });
    };

    // Setup handlers for initial items
    modal.querySelectorAll('.expanded-greeting-item').forEach(setupGreetingItemHandlers);

    // Save/Apply handler
    document.getElementById('greetingsModalSave').onclick = () => {
        // Update First Message
        const newFirstMes = document.getElementById('expandedFirstMes').value;
        const firstMesFieldCurrent = document.getElementById('editFirstMes');
        if (firstMesFieldCurrent) {
            firstMesFieldCurrent.value = newFirstMes;
            firstMesFieldCurrent.dispatchEvent(new Event('input', { bubbles: true }));
        }

        // Collect and update alternate greetings
        const expandedContainer = document.getElementById('expandedAltGreetingsContainer');
        const expandedGreetings = [];
        if (expandedContainer) {
            expandedContainer.querySelectorAll('.expanded-greeting-textarea').forEach(textarea => {
                expandedGreetings.push(textarea.value);
            });
        }

        // Clear and repopulate alt greetings container in main edit form
        const altGreetingsContainerCurrent = document.getElementById('altGreetingsEditContainer');
        if (altGreetingsContainerCurrent) {
            altGreetingsContainerCurrent.innerHTML = '';
            expandedGreetings.forEach((greeting, idx) => {
                addAltGreetingField(altGreetingsContainerCurrent, greeting, idx);
            });
        }

        closeModal();
        document.removeEventListener('keydown', handleKeydown);
        showToast('Greetings updated', 'success');
    };
}

/**
 * Open full-screen modal for editing all lorebook entries
 */
function openLorebookModal() {
    const lorebookContainer = document.getElementById('lorebookEntriesEdit');

    if (!lorebookContainer) {
        showToast('Lorebook container not found', 'error');
        return;
    }

    // Collect current lorebook entries from the edit form. Carry each entry's full current data
    // (original fields + any inline edits) on `_full` so the expanded editor round-trips it losslessly
    // instead of reducing it to the 9 editable fields.
    const entries = [];
    lorebookContainer.querySelectorAll('.lorebook-entry-edit').forEach((entryEl, idx) => {
        const cur = readInlineLorebookInputs(entryEl);
        const full = buildLorebookEntryFromInputs(entryEl._originalEntry, entryEl._populated || {}, cur, idx);
        entries.push({
            name: cur.name, keys: cur.keys, secondaryKeys: cur.secondaryKeys, content: cur.content,
            enabled: cur.enabled, selective: cur.selective, constant: cur.constant, order: cur.order, priority: cur.priority,
            _full: full,
        });
    });

    // Build entries HTML
    let entriesHtml = '';
    entries.forEach((entry, idx) => {
        entriesHtml += buildExpandedLorebookEntryHtml(entry, idx);
    });

    const modalHtml = `
        <div id="lorebookExpandModal" class="modal-overlay">
            <div class="modal-glass section-expand-modal lorebook-expand-modal" id="lorebookExpandModalInner">
                <div class="modal-header">
                    <h2><i class="fa-solid fa-book"></i> Edit Lorebook</h2>
                    <div class="modal-header-controls">
                        <div class="display-control-btns zoom-controls" id="lorebookZoomControls">
                            <button type="button" class="display-control-btn" data-zoom="out" title="Zoom Out">
                                <i class="fa-solid fa-minus"></i>
                            </button>
                            <span class="zoom-level" id="lorebookZoomDisplay">100%</span>
                            <button type="button" class="display-control-btn" data-zoom="in" title="Zoom In">
                                <i class="fa-solid fa-plus"></i>
                            </button>
                            <button type="button" class="display-control-btn" data-zoom="reset" title="Reset Zoom">
                                <i class="fa-solid fa-rotate-left"></i>
                            </button>
                        </div>
                    </div>
                    <div class="modal-controls">
                        <button id="lorebookModalSave" class="action-btn primary"><i class="fa-solid fa-check"></i> Apply All</button>
                        <button class="close-btn" id="lorebookModalClose">&times;</button>
                    </div>
                </div>
                <div class="section-expand-body" id="lorebookExpandBody">
                    <div class="expanded-lorebook-header">
                        <span id="expandedLorebookCount">${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}</span>
                        <div class="expanded-lorebook-header-actions">
                            <button type="button" id="collapseAllLorebookBtn" class="action-btn secondary small" title="Collapse All">
                                <i class="fa-solid fa-compress-alt"></i>
                            </button>
                            <button type="button" id="expandAllLorebookBtn" class="action-btn secondary small" title="Expand All">
                                <i class="fa-solid fa-expand-alt"></i>
                            </button>
                            <button type="button" id="addExpandedLorebookEntryBtn" class="action-btn secondary small">
                                <i class="fa-solid fa-plus"></i> Add Entry
                            </button>
                        </div>
                    </div>
                    <div id="expandedLorebookContainer" class="expanded-lorebook-list">
                        ${entriesHtml || '<div class="no-lorebook-entries">No lorebook entries yet. Click "Add Entry" to create one.</div>'}
                    </div>
                </div>
            </div>
        </div>
    `;

    // Remove existing modal if any
    const existingModal = document.getElementById('lorebookExpandModal');
    if (existingModal) existingModal.remove();

    document.body.insertAdjacentHTML('beforeend', modalHtml);

    const modal = document.getElementById('lorebookExpandModal');
    const lorebookExpandBody = document.getElementById('lorebookExpandBody');

    // Zoom controls
    let lorebookZoom = 100;
    const lorebookZoomDisplay = document.getElementById('lorebookZoomDisplay');

    const updateLorebookZoom = (zoom) => {
        lorebookZoom = Math.max(50, Math.min(200, zoom));
        lorebookZoomDisplay.textContent = `${lorebookZoom}%`;
        lorebookExpandBody.style.zoom = `${lorebookZoom}%`;
    };

    document.getElementById('lorebookZoomControls').onclick = (e) => {
        const btn = e.target.closest('.display-control-btn[data-zoom]');
        if (!btn) return;
        const action = btn.dataset.zoom;
        if (action === 'in') updateLorebookZoom(lorebookZoom + 10);
        else if (action === 'out') updateLorebookZoom(lorebookZoom - 10);
        else if (action === 'reset') updateLorebookZoom(100);
    };

    // Close handlers
    const closeModal = () => modal.remove();

    document.getElementById('lorebookModalClose').onclick = closeModal;
    modal.onclick = (e) => { if (e.target === modal) closeModal(); };

    // Collapse/Expand All handlers
    document.getElementById('collapseAllLorebookBtn').onclick = () => {
        const container = document.getElementById('expandedLorebookContainer');
        container.querySelectorAll('.expanded-lorebook-entry').forEach(entry => {
            entry.classList.add('collapsed');
            const btn = entry.querySelector('.expanded-lorebook-collapse-btn');
            if (btn) btn.innerHTML = '<i class="fa-solid fa-chevron-right"></i>';
            // Update preview with keys
            const preview = entry.querySelector('.expanded-lorebook-preview');
            const keys = entry.querySelector('.expanded-lorebook-keys')?.value || '';
            if (preview) {
                const keysPreview = keys ? keys.substring(0, 100) + (keys.length > 100 ? '...' : '') : 'No keys';
                preview.innerHTML = `<i class="fa-solid fa-key"></i> ${keysPreview}`;
            }
        });
    };

    document.getElementById('expandAllLorebookBtn').onclick = () => {
        const container = document.getElementById('expandedLorebookContainer');
        container.querySelectorAll('.expanded-lorebook-entry').forEach(entry => {
            entry.classList.remove('collapsed');
            const btn = entry.querySelector('.expanded-lorebook-collapse-btn');
            if (btn) btn.innerHTML = '<i class="fa-solid fa-chevron-down"></i>';
        });
    };

    // Add entry handler
    document.getElementById('addExpandedLorebookEntryBtn').onclick = () => {
        const container = document.getElementById('expandedLorebookContainer');

        // Remove "no entries" message if present
        const noEntriesMsg = container.querySelector('.no-lorebook-entries');
        if (noEntriesMsg) noEntriesMsg.remove();

        const idx = container.querySelectorAll('.expanded-lorebook-entry').length;
        const newEntry = { name: '', keys: '', secondaryKeys: '', content: '', enabled: true, selective: false, constant: false, order: idx, priority: 10 };
        const newEntryHtml = buildExpandedLorebookEntryHtml(newEntry, idx);
        container.insertAdjacentHTML('beforeend', newEntryHtml);

        // Setup handlers for new entry
        const newEntryEl = container.lastElementChild;
        setupExpandedLorebookEntryHandlers(newEntryEl);
        // No original to preserve; the populated baseline matches the freshly-rendered empty inputs.
        newEntryEl._fullEntry = null;
        newEntryEl._populated = {
            name: '', keys: '', secondaryKeys: '', content: '',
            order: String(idx), priority: '10', enabled: true, selective: false, constant: false,
        };
        updateExpandedLorebookCount();

        // Focus the name input
        const nameInput = newEntryEl.querySelector('.expanded-lorebook-name');
        nameInput.focus();
    };

    // Setup handlers for existing entries
    modal.querySelectorAll('.expanded-lorebook-entry').forEach(setupExpandedLorebookEntryHandlers);

    // Stash the full original entry + the populated display values on each expanded row so Save can merge
    // the user's edits back losslessly. The 9 visible fields are all that can change; everything else
    // (position, insertion_order, case_sensitive, id, extensions, ...) rides along on _fullEntry.
    document.getElementById('expandedLorebookContainer')?.querySelectorAll('.expanded-lorebook-entry').forEach((el, idx) => {
        const e = entries[idx];
        if (!e) return;
        el._fullEntry = e._full ?? null;
        el._populated = {
            name: e.name, keys: e.keys, secondaryKeys: e.secondaryKeys, content: e.content,
            order: String(e.order), priority: String(e.priority),
            enabled: e.enabled, selective: e.selective, constant: e.constant,
        };
    });

    // Save/Apply handler
    document.getElementById('lorebookModalSave').onclick = () => {
        const expandedContainer = document.getElementById('expandedLorebookContainer');
        const mergedEntries = [];

        if (expandedContainer) {
            expandedContainer.querySelectorAll('.expanded-lorebook-entry').forEach((entryEl, idx) => {
                const cur = {
                    name: entryEl.querySelector('.expanded-lorebook-name')?.value || '',
                    keys: entryEl.querySelector('.expanded-lorebook-keys')?.value || '',
                    secondaryKeys: entryEl.querySelector('.expanded-lorebook-secondary-keys')?.value || '',
                    content: entryEl.querySelector('.expanded-lorebook-content')?.value || '',
                    enabled: entryEl.querySelector('.expanded-lorebook-enabled')?.checked ?? true,
                    selective: entryEl.querySelector('.expanded-lorebook-selective')?.checked ?? false,
                    constant: entryEl.querySelector('.expanded-lorebook-constant')?.checked ?? false,
                    order: entryEl.querySelector('.expanded-lorebook-order')?.value ?? idx,
                    priority: entryEl.querySelector('.expanded-lorebook-priority')?.value ?? 10,
                };
                // Merge edits onto _fullEntry so position/insertion_order/id/extensions survive; only changed fields override.
                mergedEntries.push(buildLorebookEntryFromInputs(entryEl._fullEntry, entryEl._populated || {}, cur, idx));
            });
        }

        // Feed the full merged entries back into the inline editor. addLorebookEntryField re-stashes each as
        // _originalEntry + _populated, so the subsequent performSave read-back stays lossless.
        const lorebookContainerCurrent = document.getElementById('lorebookEntriesEdit');
        if (lorebookContainerCurrent) {
            lorebookContainerCurrent.innerHTML = '';
            mergedEntries.forEach((entry, idx) => {
                addLorebookEntryField(lorebookContainerCurrent, entry, idx);
            });
        }

        updateLorebookCount();
        closeModal();
        document.removeEventListener('keydown', handleKeydown);
        showToast('Lorebook updated', 'success');
    };
}

function buildExpandedLorebookEntryHtml(entry, idx) {
    const keysPreview = entry.keys ? entry.keys.substring(0, 100) + (entry.keys.length > 100 ? '...' : '') : 'No keys';
    return `
        <div class="expanded-lorebook-entry${entry.enabled ? '' : ' disabled'}" data-index="${idx}">
            <div class="expanded-lorebook-entry-header">
                <button type="button" class="expanded-lorebook-collapse-btn" title="Expand/Collapse">
                    <i class="fa-solid fa-chevron-down"></i>
                </button>
                <input type="text" class="glass-input expanded-lorebook-name" placeholder="Entry name/comment" value="${escapeHtml(entry.name)}">
                <span class="expanded-lorebook-preview"><i class="fa-solid fa-key"></i> ${escapeHtml(keysPreview)}</span>
                <div class="expanded-lorebook-entry-controls">
                    <label class="expanded-lorebook-toggle ${entry.enabled ? 'enabled' : 'disabled'}" title="Toggle enabled">
                        <input type="checkbox" class="expanded-lorebook-enabled" ${entry.enabled ? 'checked' : ''} style="display: none;">
                        ${entry.enabled ? '<i class="fa-solid fa-toggle-on"></i> On' : '<i class="fa-solid fa-toggle-off"></i> Off'}
                    </label>
                    <button type="button" class="expanded-lorebook-delete" title="Delete entry">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            </div>
            <div class="expanded-lorebook-entry-body">
                <div class="expanded-lorebook-row">
                    <div class="form-group flex-1">
                        <label>Keys <span class="label-hint">(comma-separated)</span></label>
                        <input type="text" class="glass-input expanded-lorebook-keys" placeholder="keyword1, keyword2" value="${escapeHtml(entry.keys)}">
                    </div>
                </div>
                <div class="expanded-lorebook-row">
                    <div class="form-group flex-1">
                        <label>Secondary Keys <span class="label-hint">(optional, for selective)</span></label>
                        <input type="text" class="glass-input expanded-lorebook-secondary-keys" placeholder="secondary1, secondary2" value="${escapeHtml(entry.secondaryKeys)}">
                    </div>
                </div>
                <div class="expanded-lorebook-row">
                    <div class="form-group flex-1">
                        <label>Content</label>
                        <textarea class="glass-input expanded-lorebook-content" rows="5" placeholder="Lore content...">${escapeHtml(entry.content)}</textarea>
                    </div>
                </div>
                <div class="expanded-lorebook-options">
                    <label>
                        <input type="checkbox" class="expanded-lorebook-selective" ${entry.selective ? 'checked' : ''}>
                        <span>Selective</span>
                    </label>
                    <label>
                        <input type="checkbox" class="expanded-lorebook-constant" ${entry.constant ? 'checked' : ''}>
                        <span>Constant</span>
                    </label>
                    <div class="expanded-lorebook-number">
                        <label>Order:</label>
                        <input type="number" class="glass-input expanded-lorebook-order" value="${entry.order}">
                    </div>
                    <div class="expanded-lorebook-number">
                        <label>Priority:</label>
                        <input type="number" class="glass-input expanded-lorebook-priority" value="${entry.priority}">
                    </div>
                </div>
            </div>
        </div>
    `;
}

function setupExpandedLorebookEntryHandlers(entryEl) {
    // Collapse/expand handler
    const collapseBtn = entryEl.querySelector('.expanded-lorebook-collapse-btn');
    const entryBody = entryEl.querySelector('.expanded-lorebook-entry-body');
    const preview = entryEl.querySelector('.expanded-lorebook-preview');
    const nameInput = entryEl.querySelector('.expanded-lorebook-name');

    collapseBtn.onclick = () => {
        const isCollapsed = entryEl.classList.toggle('collapsed');
        collapseBtn.innerHTML = isCollapsed
            ? '<i class="fa-solid fa-chevron-right"></i>'
            : '<i class="fa-solid fa-chevron-down"></i>';
        // Update preview with keys when collapsing
        if (isCollapsed && preview) {
            const keys = entryEl.querySelector('.expanded-lorebook-keys')?.value || '';
            const keysPreview = keys ? keys.substring(0, 100) + (keys.length > 100 ? '...' : '') : 'No keys';
            preview.innerHTML = `<i class="fa-solid fa-key"></i> ${keysPreview}`;
        }
    };

    // Toggle enabled handler
    const toggleLabel = entryEl.querySelector('.expanded-lorebook-toggle');

    toggleLabel.onclick = (e) => {
        e.preventDefault();
        const checkbox = entryEl.querySelector('.expanded-lorebook-enabled');
        const isEnabled = checkbox.checked;
        const newEnabled = !isEnabled;
        checkbox.checked = newEnabled;
        toggleLabel.className = `expanded-lorebook-toggle ${newEnabled ? 'enabled' : 'disabled'}`;
        toggleLabel.innerHTML = `<input type="checkbox" class="expanded-lorebook-enabled" ${newEnabled ? 'checked' : ''} style="display: none;">${newEnabled ? '<i class="fa-solid fa-toggle-on"></i> On' : '<i class="fa-solid fa-toggle-off"></i> Off'}`;
        entryEl.classList.toggle('disabled', !newEnabled);
    };

    // Delete handler
    const deleteBtn = entryEl.querySelector('.expanded-lorebook-delete');
    deleteBtn.onclick = () => {
        entryEl.remove();
        renumberExpandedLorebookEntries();
        updateExpandedLorebookCount();
    };
}

function renumberExpandedLorebookEntries() {
    const container = document.getElementById('expandedLorebookContainer');
    if (!container) return;

    const entries = container.querySelectorAll('.expanded-lorebook-entry');
    entries.forEach((entry, idx) => {
        entry.dataset.index = idx;
    });

    // Show "no entries" message if empty
    if (entries.length === 0) {
        container.innerHTML = '<div class="no-lorebook-entries">No lorebook entries yet. Click "Add Entry" to create one.</div>';
    }
}

function updateExpandedLorebookCount() {
    const container = document.getElementById('expandedLorebookContainer');
    const countEl = document.getElementById('expandedLorebookCount');
    if (!container || !countEl) return;

    const count = container.querySelectorAll('.expanded-lorebook-entry').length;
    countEl.textContent = `${count} ${count === 1 ? 'entry' : 'entries'}`;
}

/**
 * Open expanded editor modal for a text field
 */
function openExpandedFieldEditor(fieldId, fieldLabel) {
    const originalField = document.getElementById(fieldId);
    if (!originalField) {
        showToast('Field not found', 'error');
        return;
    }

    const currentValue = originalField.value;
    const isCreatorNotes = fieldId === 'editCreatorNotes';

    // Get field-specific icon
    const fieldIcons = {
        'editDescription': 'fa-solid fa-user',
        'editPersonality': 'fa-solid fa-brain',
        'editScenario': 'fa-solid fa-map',
        'editSystemPrompt': 'fa-solid fa-terminal',
        'editPostHistoryInstructions': 'fa-solid fa-clock-rotate-left',
        'editCreatorNotes': 'fa-solid fa-feather-pointed',
        'editMesExample': 'fa-solid fa-quote-left'
    };
    const fieldIcon = fieldIcons[fieldId] || 'fa-solid fa-expand';

    // Preview toggle button only for Creator's Notes
    const previewToggleHtml = isCreatorNotes ? `
        <button id="expandFieldPreviewToggle" class="action-btn secondary" title="Toggle Preview">
            <i class="fa-solid fa-eye"></i> Preview
        </button>
    ` : '';

    // Create expand modal
    const expandModalHtml = `
        <div id="expandFieldModal" class="modal-overlay">
            <div class="modal-glass expand-field-modal">
                <div class="modal-header">
                    <h2><i class="${fieldIcon}"></i> ${escapeHtml(fieldLabel)}</h2>
                    <div class="modal-controls">
                        ${previewToggleHtml}
                        <button id="expandFieldSave" class="action-btn primary"><i class="fa-solid fa-check"></i> Apply</button>
                        <button class="close-btn" id="expandFieldClose">&times;</button>
                    </div>
                </div>
                <div class="expand-field-body" id="expandFieldBody">
                    <textarea id="expandFieldTextarea" class="glass-input expand-field-textarea" placeholder="Enter ${escapeHtml(fieldLabel.toLowerCase())}...">${escapeHtml(currentValue)}</textarea>
                    ${isCreatorNotes ? '<div id="expandFieldPreview" class="expand-field-preview scrolling-text" style="display: none;"></div>' : ''}
                </div>
            </div>
        </div>
    `;

    // Remove existing modal if any
    const existingModal = document.getElementById('expandFieldModal');
    if (existingModal) existingModal.remove();

    document.body.insertAdjacentHTML('beforeend', expandModalHtml);

    const expandModal = document.getElementById('expandFieldModal');
    const expandTextarea = document.getElementById('expandFieldTextarea');

    // Focus textarea and move cursor to end
    setTimeout(() => {
        expandTextarea.focus();
        expandTextarea.setSelectionRange(expandTextarea.value.length, expandTextarea.value.length);
    }, 50);

    // Preview toggle for Creator's Notes
    if (isCreatorNotes) {
        const previewToggle = document.getElementById('expandFieldPreviewToggle');
        const previewDiv = document.getElementById('expandFieldPreview');
        let isPreviewMode = false;

        previewToggle.onclick = () => {
            isPreviewMode = !isPreviewMode;

            if (isPreviewMode) {
                // Switch to preview mode
                expandTextarea.style.display = 'none';
                previewDiv.style.display = 'block';
                previewDiv.innerHTML = formatRichText(expandTextarea.value, 'Character', true);
                previewToggle.innerHTML = '<i class="fa-solid fa-code"></i> Edit';
                previewToggle.title = 'Switch to Edit Mode';
            } else {
                // Switch to edit mode
                expandTextarea.style.display = 'block';
                previewDiv.style.display = 'none';
                previewToggle.innerHTML = '<i class="fa-solid fa-eye"></i> Preview';
                previewToggle.title = 'Toggle Preview';
                expandTextarea.focus();
            }
        };
    }

    // Close handlers
    const closeExpandModal = () => {
        expandModal.remove();
    };

    document.getElementById('expandFieldClose').onclick = closeExpandModal;
    expandModal.onclick = (e) => { if (e.target === expandModal) closeExpandModal(); };

    // Save/Apply handler
    document.getElementById('expandFieldSave').onclick = () => {
        const newValue = expandTextarea.value;
        // Re-query the original field to ensure we have a fresh reference
        const targetField = document.getElementById(fieldId);
        if (targetField) {
            targetField.value = newValue;
            // Trigger input event so any listeners know the value changed
            targetField.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
            console.error('[ExpandField] Could not find target field:', fieldId);
        }

        closeExpandModal();
        document.removeEventListener('keydown', handleKeydown);
        showToast('Changes applied to field', 'success');
    };
}

/**
 * Open a read-only expanded view for ChubAI character preview sections
 */
function openBrowseExpandedView(sectionId, label, iconClass) {
    const sectionEl = document.getElementById(sectionId);
    if (!sectionEl) {
        showToast('Section not found', 'error');
        return;
    }

    // Truncated sections (First Message, etc.) stash full content on the element.
    let content;
    if (sectionEl.dataset.fullContent) {
        // Shared across all provider preview modals; resolve the name from THIS modal, not chub's.
        const charName = sectionEl.closest('.browse-char-modal')?.querySelector('.modal-header h2')?.textContent || 'Character';
        content = formatRichText(sectionEl.dataset.fullContent, charName, true);
    } else {
        // Creator's Notes renders through a secure iframe; pull content out if present.
        const existingIframe = sectionEl.querySelector('iframe');
        if (existingIframe && existingIframe.contentDocument?.body) {
            // Extract content from existing iframe
            content = existingIframe.contentDocument.body.innerHTML;
        } else {
            // Use innerHTML directly
            content = sectionEl.innerHTML;
        }
    }

    // Build iframe document like Creator's Notes does
    const iframeStyles = `<style>
        html { background: transparent; color-scheme: dark; }
        * { scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.15) transparent; }
        ::-webkit-scrollbar { width: 8px; height: 8px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: var(--radius-sm); }
        ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.25); }
        ::-webkit-scrollbar-corner { background: transparent; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            color: #e0e0e0;
            background: transparent;
            line-height: 1.7;
            font-size: 1rem;
            margin: 0;
            padding: 20px;
        }
        a { color: #4a9eff; }
        img, video { max-width: 100%; height: auto; border-radius: var(--radius-lg); }
        pre, code { background: rgba(0,0,0,0.3); padding: 2px 6px; border-radius: var(--radius-sm); }
        blockquote { border-left: 3px solid #4a9eff; margin-left: 0; padding-left: 15px; opacity: 0.9; }
        .char-placeholder { color: #4a9eff; font-weight: 500; }
        .user-placeholder { color: #9b59b6; font-weight: 500; }
        iframe { max-width: 100%; border-radius: var(--radius-lg); }
        @media (max-width: 768px) {
            body { font-size: 0.88rem; padding: 12px; }
        }
    </style>`;
    const iframeDoc = `<!DOCTYPE html><html><head><meta charset="UTF-8">${iframeStyles}</head><body>${content}</body></html>`;

    // Create expanded view modal with size and zoom controls (same pattern as Creator's Notes)
    const expandModalHtml = `
        <div id="chubExpandModal" class="modal-overlay">
            <div class="modal-glass browse-expand-modal" id="chubExpandModalInner" data-size="normal">
                <div class="modal-header">
                    <h2><i class="${iconClass}"></i> ${escapeHtml(label)}</h2>
                    <div class="browse-expand-display-controls">
                        <div class="display-control-btns zoom-controls" id="chubExpandZoomControls">
                            <button type="button" class="display-control-btn" data-zoom="out" title="Zoom Out">
                                <i class="fa-solid fa-minus"></i>
                            </button>
                            <span class="zoom-level" id="chubExpandZoomDisplay">100%</span>
                            <button type="button" class="display-control-btn" data-zoom="in" title="Zoom In">
                                <i class="fa-solid fa-plus"></i>
                            </button>
                            <button type="button" class="display-control-btn" data-zoom="reset" title="Reset Zoom">
                                <i class="fa-solid fa-rotate-left"></i>
                            </button>
                        </div>
                        <div class="display-control-btns" id="chubExpandSizeControls">
                            <button type="button" class="display-control-btn" data-size="compact" title="Compact">
                                <i class="fa-solid fa-compress"></i>
                            </button>
                            <button type="button" class="display-control-btn active" data-size="normal" title="Normal">
                                <i class="fa-regular fa-window-maximize"></i>
                            </button>
                            <button type="button" class="display-control-btn" data-size="wide" title="Wide">
                                <i class="fa-solid fa-expand"></i>
                            </button>
                        </div>
                    </div>
                    <div class="modal-controls">
                        <button class="close-btn" id="chubExpandClose">&times;</button>
                    </div>
                </div>
                <div class="browse-expand-body">
                    <iframe id="chubExpandIframe" sandbox="allow-same-origin"></iframe>
                </div>
            </div>
        </div>
    `;

    // Remove existing modal if any
    const existingModal = document.getElementById('chubExpandModal');
    if (existingModal) existingModal.remove();

    document.body.insertAdjacentHTML('beforeend', expandModalHtml);

    const expandModal = document.getElementById('chubExpandModal');
    const modalInner = document.getElementById('chubExpandModalInner');
    const iframe = document.getElementById('chubExpandIframe');

    // Set iframe content
    iframe.srcdoc = iframeDoc;

    // Size control handlers
    document.getElementById('chubExpandSizeControls').onclick = (e) => {
        const btn = e.target.closest('.display-control-btn[data-size]');
        if (!btn) return;

        const size = btn.dataset.size;
        document.querySelectorAll('#chubExpandSizeControls .display-control-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        modalInner.dataset.size = size;
    };

    // Zoom controls - apply to iframe body (same as Creator's Notes)
    let chubExpandZoom = 100;
    const zoomDisplay = document.getElementById('chubExpandZoomDisplay');

    const updateZoom = (zoom) => {
        chubExpandZoom = Math.max(50, Math.min(200, zoom));
        zoomDisplay.textContent = `${chubExpandZoom}%`;
        iframe.contentDocument?.body?.style.setProperty('zoom', `${chubExpandZoom}%`);
    };

    document.getElementById('chubExpandZoomControls').onclick = (e) => {
        const btn = e.target.closest('.display-control-btn[data-zoom]');
        if (!btn) return;
        const action = btn.dataset.zoom;
        if (action === 'in') updateZoom(chubExpandZoom + 10);
        else if (action === 'out') updateZoom(chubExpandZoom - 10);
        else if (action === 'reset') updateZoom(100);
    };

    // Close handlers
    const closeExpandModal = () => expandModal.remove();

    document.getElementById('chubExpandClose').onclick = closeExpandModal;
    expandModal.onclick = (e) => { if (e.target === expandModal) closeExpandModal(); };
}

/**
 * Reset per-section uncollapsed state on a browse char modal so each new
 * character preview starts fresh in collapse-all mode.
 */
export function resetBrowseSectionCollapseState(modal) {
    if (!modal) return;
    modal.querySelectorAll('.browse-char-section.browse-section-uncollapsed')
        .forEach(section => section.classList.remove('browse-section-uncollapsed'));
}
window.resetBrowseSectionCollapseState = resetBrowseSectionCollapseState;

// Alt greetings of the currently-open browse preview; browse views publish via CoreAPI.
let _browseAltGreetings = null;
export function setBrowseAltGreetings(greetings) {
    _browseAltGreetings = greetings;
}
window.setBrowseAltGreetings = setBrowseAltGreetings;

/**
 * Delegated click handler for browse section titles (expand modal).
 * Uses event delegation since sections are injected dynamically by provider browse views.
 */
export function initBrowseExpandButtons() {
    document.addEventListener('click', (e) => {
        // Inline toggle chevron - expand/collapse section content in place
        const toggle = e.target.closest('.browse-section-inline-toggle');
        if (toggle) {
            e.preventDefault();
            e.stopPropagation();
            const section = toggle.closest('.browse-char-section');
            if (section) {
                if (document.body.classList.contains('collapse-all-browse-sections')) {
                    section.classList.remove('browse-section-collapsed');
                    section.classList.toggle('browse-section-uncollapsed');
                } else {
                    section.classList.toggle('browse-section-collapsed');
                }
            }
            return;
        }

        const title = e.target.closest('.browse-section-title');
        if (!title) return;
        const sectionId = title.dataset.section;
        const label = title.dataset.label;
        const iconClass = title.dataset.icon;

        // Collapse-all mode: optional sections (everything except creator's notes
        // and alt greetings) become inline toggles instead of opening the expand modal.
        const isCollapseAll = document.body.classList.contains('collapse-all-browse-sections');
        const isOptionalSection = sectionId
            && !sectionId.endsWith('CreatorNotes')
            && sectionId !== 'browseAltGreetings';
        if (isCollapseAll && isOptionalSection) {
            e.preventDefault();
            e.stopPropagation();
            const section = title.closest('.browse-char-section');
            if (section) {
                section.classList.remove('browse-section-collapsed');
                section.classList.toggle('browse-section-uncollapsed');
            }
            return;
        }

        e.preventDefault();
        e.stopPropagation();
        if (sectionId === 'browseAltGreetings') {
            const greetings = _browseAltGreetings || [];
            const modal = title.closest('.browse-char-modal');
            const charName = modal?.querySelector('.modal-header h2')?.textContent || 'Character';
            openAltGreetingsFullscreen(greetings, charName);
            return;
        }
        openBrowseExpandedView(sectionId, label, iconClass);
    });
}
