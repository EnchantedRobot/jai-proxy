// ==========================================
// Lorebook Editor Functions
// ==========================================

/**
 * Populate the lorebook editor with existing entries
 * @param {Object} characterBook - The character_book object from the character
 */
function populateLorebookEditor(characterBook) {
    const container = document.getElementById('lorebookEntriesEdit');
    const countEl = document.getElementById('lorebookEditCount');

    if (!container) return;

    container.innerHTML = '';

    const entries = characterBook?.entries || [];

    if (countEl) {
        countEl.textContent = `(${entries.length} ${entries.length === 1 ? 'entry' : 'entries'})`;
    }
    
    entries.forEach((entry, index) => {
        addLorebookEntryField(container, entry, index);
    });
}

/**
 * Add a lorebook entry field to the editor
 * @param {HTMLElement} container - The container element
 * @param {Object} entry - The lorebook entry object (or null for new entry)
 * @param {number} index - The index of the entry
 */
function addLorebookEntryField(container, entry = null, index = null) {
    if (!container) {
        container = document.getElementById('lorebookEntriesEdit');
    }
    if (!container) return;
    
    const idx = index !== null ? index : container.children.length;
    
    // Default values for new entry
    const name = entry?.comment || entry?.name || '';
    const keys = entry?.keys || entry?.key || [];
    const keyStr = Array.isArray(keys) ? keys.join(', ') : keys;
    const secondaryKeys = entry?.secondary_keys || [];
    const secondaryKeyStr = Array.isArray(secondaryKeys) ? secondaryKeys.join(', ') : secondaryKeys;
    const content = entry?.content || '';
    const enabled = entry?.enabled !== false;
    const selective = entry?.selective || false;
    const constant = entry?.constant || false;
    const order = entry?.order ?? entry?.insertion_order ?? idx;
    const priority = entry?.priority ?? 10;
    
    const wrapper = document.createElement('div');
    wrapper.className = `lorebook-entry-edit${enabled ? '' : ' disabled'}`;
    wrapper.dataset.index = idx;
    
    wrapper.innerHTML = `
        <div class="lorebook-entry-header">
            <input type="text" class="glass-input lorebook-entry-name-input" placeholder="Entry name/comment" style="flex: 1; font-weight: 600;">
            <div class="lorebook-entry-controls">
                <label class="lorebook-entry-toggle ${enabled ? 'enabled' : 'disabled'}" title="Toggle enabled">
                    <input type="checkbox" class="lorebook-enabled-checkbox" ${enabled ? 'checked' : ''} style="display: none;">
                    ${enabled ? '<i class="fa-solid fa-toggle-on"></i> On' : '<i class="fa-solid fa-toggle-off"></i> Off'}
                </label>
                <span class="lorebook-entry-delete" title="Delete entry">
                    <i class="fa-solid fa-trash"></i>
                </span>
            </div>
        </div>
        <div class="lorebook-entry-fields">
            <div class="lorebook-entry-row">
                <div class="form-group flex-1">
                    <label>Keys <span class="label-hint">(comma-separated)</span></label>
                    <input type="text" class="glass-input lorebook-keys-input" placeholder="keyword1, keyword2">
                </div>
            </div>
            <div class="lorebook-entry-row">
                <div class="form-group flex-1">
                    <label>Secondary Keys <span class="label-hint">(optional, for selective)</span></label>
                    <input type="text" class="glass-input lorebook-secondary-keys-input" placeholder="secondary1, secondary2">
                </div>
            </div>
            <div class="lorebook-entry-row">
                <div class="form-group flex-1">
                    <label>Content</label>
                    <textarea class="glass-input lorebook-content-input" rows="3" placeholder="Lore content..."></textarea>
                </div>
            </div>
            <div class="lorebook-entry-row" style="gap: 15px;">
                <label style="display: flex; align-items: center; gap: 6px; cursor: pointer;">
                    <input type="checkbox" class="lorebook-selective-checkbox" ${selective ? 'checked' : ''}>
                    <span style="font-size: 0.85em;">Selective</span>
                </label>
                <label style="display: flex; align-items: center; gap: 6px; cursor: pointer;">
                    <input type="checkbox" class="lorebook-constant-checkbox" ${constant ? 'checked' : ''}>
                    <span style="font-size: 0.85em;">Constant</span>
                </label>
                <div style="display: flex; align-items: center; gap: 6px;">
                    <label style="font-size: 0.85em;">Order:</label>
                    <input type="number" class="glass-input lorebook-order-input" style="width: 60px; padding: 4px 8px;">
                </div>
                <div style="display: flex; align-items: center; gap: 6px;">
                    <label style="font-size: 0.85em;">Priority:</label>
                    <input type="number" class="glass-input lorebook-priority-input" style="width: 60px; padding: 4px 8px;">
                </div>
            </div>
        </div>
    `;
    
    wrapper._originalEntry = entry || null;
    container.appendChild(wrapper);
    
    // Set input values directly (not via innerHTML) to ensure .value properties are set correctly
    wrapper.querySelector('.lorebook-entry-name-input').value = name;
    wrapper.querySelector('.lorebook-keys-input').value = keyStr;
    wrapper.querySelector('.lorebook-secondary-keys-input').value = secondaryKeyStr;
    wrapper.querySelector('.lorebook-content-input').value = content;
    wrapper.querySelector('.lorebook-order-input').value = order;
    wrapper.querySelector('.lorebook-priority-input').value = priority;

    // Snapshot what we populated so read-back preserves untouched fields verbatim instead of re-materialising them.
    wrapper._populated = {
        name: wrapper.querySelector('.lorebook-entry-name-input').value,
        keys: wrapper.querySelector('.lorebook-keys-input').value,
        secondaryKeys: wrapper.querySelector('.lorebook-secondary-keys-input').value,
        content: wrapper.querySelector('.lorebook-content-input').value,
        order: wrapper.querySelector('.lorebook-order-input').value,
        priority: wrapper.querySelector('.lorebook-priority-input').value,
        enabled: wrapper.querySelector('.lorebook-enabled-checkbox').checked,
        selective: wrapper.querySelector('.lorebook-selective-checkbox').checked,
        constant: wrapper.querySelector('.lorebook-constant-checkbox').checked,
    };

    // Toggle enabled handler
    const toggleLabel = wrapper.querySelector('.lorebook-entry-toggle');
    toggleLabel.addEventListener('click', (e) => {
        e.preventDefault();
        const checkbox = wrapper.querySelector('.lorebook-enabled-checkbox');
        const isEnabled = checkbox.checked;
        const newEnabled = !isEnabled;
        checkbox.checked = newEnabled;
        toggleLabel.className = `lorebook-entry-toggle ${newEnabled ? 'enabled' : 'disabled'}`;
        toggleLabel.innerHTML = `<input type="checkbox" class="lorebook-enabled-checkbox" ${newEnabled ? 'checked' : ''} style="display: none;">${newEnabled ? '<i class="fa-solid fa-toggle-on"></i> On' : '<i class="fa-solid fa-toggle-off"></i> Off'}`;
        wrapper.classList.toggle('disabled', !newEnabled);
    });
    
    // Delete handler
    const deleteBtn = wrapper.querySelector('.lorebook-entry-delete');
    deleteBtn.addEventListener('click', () => {
        wrapper.remove();
        updateLorebookCount();
    });
}

/**
 * Update the lorebook entry count display
 */
function updateLorebookCount() {
    const container = document.getElementById('lorebookEntriesEdit');
    const countEl = document.getElementById('lorebookEditCount');
    
    if (container && countEl) {
        const count = container.children.length;
        countEl.textContent = `(${count} ${count === 1 ? 'entry' : 'entries'})`;
    }
}

/**
 * Lossless merge of one lorebook entry's editor state. Starts from the original entry (`orig`)
 * and overrides only the fields whose input actually changed from what was populated (`pop`).
 * Shared by the inline editor (getLorebookFromEditor) and the expanded modal so both round-trip
 * untouched entries byte-for-byte: no trimmed comment, no injected `order`, no materialised
 * defaults, no dropped position/insertion_order/case_sensitive/id/extensions. `cur`/`pop` use the
 * editor-neutral keys: name, keys, secondaryKeys, content, enabled, selective, constant, order,
 * priority. New entries (no `orig`) materialise the full shape; the caller assigns the id.
 */
function buildLorebookEntryFromInputs(orig, pop, cur, idx) {
    const entry = orig ? { ...orig } : {
        position: 'before_char',
        case_sensitive: false,
        use_regex: false,
        extensions: {}
    };
    const dirty = (c, w) => !orig || c !== w;
    const parseList = (s) => String(s).split(',').map(k => k.trim()).filter(Boolean);

    if (dirty(cur.keys, pop.keys)) entry.keys = parseList(cur.keys);
    if (dirty(cur.secondaryKeys, pop.secondaryKeys)) entry.secondary_keys = parseList(cur.secondaryKeys);
    if (dirty(cur.content, pop.content)) entry.content = cur.content;
    if (dirty(cur.name, pop.name)) entry.comment = String(cur.name).trim() || `Entry ${idx + 1}`;
    if (dirty(cur.enabled, pop.enabled)) entry.enabled = cur.enabled;
    if (dirty(cur.selective, pop.selective)) entry.selective = cur.selective;
    if (dirty(cur.constant, pop.constant)) entry.constant = cur.constant;
    if (dirty(cur.order, pop.order)) {
        const o = parseInt(cur.order);
        const v = Number.isNaN(o) ? idx : o;
        entry.insertion_order = v;
        // Carry order only when the original had it; dont inject it onto entries that only stored insertion_order.
        if (!orig || 'order' in entry) entry.order = v;
    }
    if (dirty(cur.priority, pop.priority)) {
        const p = parseInt(cur.priority);
        entry.priority = Number.isNaN(p) ? 10 : p;
    }
    return entry;
}

// Reads the 9 editable fields off one inline `.lorebook-entry-edit` element into the editor-neutral shape.
function readInlineLorebookInputs(el) {
    return {
        name: el.querySelector('.lorebook-entry-name-input')?.value ?? '',
        keys: el.querySelector('.lorebook-keys-input')?.value ?? '',
        secondaryKeys: el.querySelector('.lorebook-secondary-keys-input')?.value ?? '',
        content: el.querySelector('.lorebook-content-input')?.value ?? '',
        order: el.querySelector('.lorebook-order-input')?.value ?? '',
        priority: el.querySelector('.lorebook-priority-input')?.value ?? '',
        enabled: el.querySelector('.lorebook-enabled-checkbox')?.checked ?? true,
        selective: el.querySelector('.lorebook-selective-checkbox')?.checked || false,
        constant: el.querySelector('.lorebook-constant-checkbox')?.checked || false,
    };
}

/**
 * Get lorebook entries from the editor
 * @returns {Array} Array of lorebook entry objects
 */
function getLorebookFromEditor() {
    const container = document.getElementById('lorebookEntriesEdit');
    if (!container) return [];

    const entries = [];
    const entryEls = container.querySelectorAll('.lorebook-entry-edit');

    // Preserve each entry's imported id; only mint ids for entries added in the editor.
    let maxExistingId = -1;
    entryEls.forEach((el) => {
        const origId = el._originalEntry?.id;
        if (typeof origId === 'number' && origId > maxExistingId) maxExistingId = origId;
    });
    let nextNewId = maxExistingId + 1;

    entryEls.forEach((el, idx) => {
        const entry = buildLorebookEntryFromInputs(el._originalEntry, el._populated || {}, readInlineLorebookInputs(el), idx);
        if (typeof entry.id !== 'number') entry.id = nextNewId++;
        entries.push(entry);
    });

    return entries;
}

/**
 * Build a character_book object from editor state.
 * Preserves existing book metadata (name, description, settings) from the
 * active character so we don't nuke them when the user only edits entries.
 * @returns {Object|null} The character_book object or null if no entries
 */
function getCharacterBookFromEditor() {
    const entries = getLorebookFromEditor();
    
    if (entries.length === 0) {
        return null;
    }
    
    const existing = activeChar?.data?.character_book;
    return {
        name: existing?.name ?? '',
        description: existing?.description ?? '',
        scan_depth: existing?.scan_depth ?? 2,
        token_budget: existing?.token_budget ?? 512,
        recursive_scanning: existing?.recursive_scanning ?? false,
        entries: entries
    };
}

