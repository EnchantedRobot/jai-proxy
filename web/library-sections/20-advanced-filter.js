// ========================================
// ADVANCED FILTER
// ========================================

const ADV_FILTER_FIELDS = {
    name: { label: 'Name', type: 'text', operators: ['contains', 'not_contains', 'equals', 'starts_with', 'is_empty', 'is_not_empty'] },
    listingName: { label: 'Listing Name', type: 'text', operators: ['contains', 'not_contains', 'equals', 'starts_with', 'is_empty', 'is_not_empty'] },
    creator: { label: 'Creator', type: 'text', operators: ['contains', 'not_contains', 'equals', 'starts_with', 'is_empty', 'is_not_empty'] },
    tags: { label: 'Tags', type: 'tag', operators: ['includes', 'excludes'] },
    creatorNotes: { label: 'Creator Notes', type: 'text', operators: ['contains', 'not_contains', 'is_empty', 'is_not_empty'] },
    favorite: { label: 'Favorite', type: 'boolean', operators: ['is_true', 'is_false'] },
    providerLink: { label: 'Provider Link', type: 'provider', operators: ['is_linked', 'is_not_linked', 'linked_to', 'not_linked_to'] },
    dateAdded: { label: 'Date Added', type: 'date', operators: ['before', 'after', 'in_the_last'] },
    dateCreated: { label: 'Date Created', type: 'date', operators: ['before', 'after', 'in_the_last'] },
    version: { label: 'Version', type: 'text', operators: ['contains', 'is_empty', 'is_not_empty'] },
    tokens: { label: 'Token Count', type: 'number', operators: ['more_than', 'less_than', 'equals'] },
    nameOverride: { label: 'Name Override', type: 'nameOverride', operators: ['has_override', 'no_override', 'set_to_card', 'set_to_listing'] },
};

const ADV_FILTER_OP_LABELS = {
    contains: 'contains',
    not_contains: 'does not contain',
    equals: 'equals',
    starts_with: 'starts with',
    is_empty: 'is empty',
    is_not_empty: 'is not empty',
    includes: 'includes',
    excludes: 'excludes',
    is_true: 'yes',
    is_false: 'no',
    is_linked: 'is linked',
    is_not_linked: 'is not linked',
    linked_to: 'linked to',
    not_linked_to: 'not linked to',
    before: 'before',
    after: 'after',
    in_the_last: 'in the last',
    never: 'never',
    more_than: 'more than',
    less_than: 'less than',
    in: 'in',
    not_in: 'not in',
    in_any: 'in any',
    not_in_any: 'not in any',
    has_override: 'yes',
    no_override: 'no',
    set_to_card: 'to card name',
    set_to_listing: 'to listing name',
};

const ADV_FILTER_NO_VALUE_OPS = new Set([
    'is_empty', 'is_not_empty', 'is_true', 'is_false', 'is_linked', 'is_not_linked', 'never', 'in_any', 'not_in_any',
    'has_override', 'no_override', 'set_to_card', 'set_to_listing',
]);

const ADV_FILTER_PROVIDERS = [
    { value: 'chub', label: 'ChubAI' },
    { value: 'datacat', label: 'DataCat' },
];

// ========== FILTER PRESETS ==========

const FILTER_PRESETS_FILE = '_cl_filterpresets.json';
let _filterPresetsData = null;
let _filterPresetsSaving = false;
let _filterPresetsSaveQueued = false;

// UTF-8 string to base64 for Files-API JSON uploads. Plain fromCharCode loop, no chunking, so its safe at any size.
function utf8ToBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
}

async function loadFilterPresets() {
    if (_filterPresetsData) return _filterPresetsData;
    try {
        const resp = await fetch(`/user/files/${FILTER_PRESETS_FILE}`);
        if (resp.ok) {
            const text = await resp.text();
            const data = text && text.trim() ? JSON.parse(text) : null;
            if (data && data.version) {
                _filterPresetsData = data;
                if (!Array.isArray(_filterPresetsData.char)) _filterPresetsData.char = [];
                if (!Array.isArray(_filterPresetsData.chat)) _filterPresetsData.chat = [];
                return _filterPresetsData;
            }
        }
    } catch (e) {
        console.error('[FilterPresets] Load failed:', e.message);
    }
    _filterPresetsData = { version: 1, char: [], chat: [] };
    return _filterPresetsData;
}

async function saveFilterPresets() {
    if (!_filterPresetsData) return;
    if (_filterPresetsSaving) { _filterPresetsSaveQueued = true; return; }
    _filterPresetsSaving = true;
    try {
        const b64 = utf8ToBase64(JSON.stringify(_filterPresetsData));
        const resp = await apiRequest('/files/upload', 'POST', { name: FILTER_PRESETS_FILE, data: b64 });
        if (!resp.ok) throw new Error(resp.status);
    } catch (e) {
        console.error('[FilterPresets] Save failed:', e.message);
        showToast('Failed to save filter presets', 'error');
    } finally {
        _filterPresetsSaving = false;
        if (_filterPresetsSaveQueued) { _filterPresetsSaveQueued = false; saveFilterPresets(); }
    }
}

function getFilterPresets() {
    const key = currentView === 'chats' ? 'chat' : 'char';
    return (_filterPresetsData || { char: [], chat: [] })[key] || [];
}

function _generateFilterPresetUid() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const existing = getFilterPresets();
    let uid;
    do {
        uid = '';
        for (let i = 0; i < 10; i++) uid += chars[Math.floor(Math.random() * chars.length)];
    } while (existing.some(p => p.uid === uid));
    return uid;
}

async function saveCurrentAsFilterPreset(name) {
    name = (name || '').trim();
    if (!name) return;
    const rules = getAdvFilterRules();
    const activeRules = rules.filter(r => ADV_FILTER_NO_VALUE_OPS.has(r.operator) || !!r.value);
    if (activeRules.length === 0) { showToast('No active filters to save', 'warning'); return; }
    await loadFilterPresets();
    const key = currentView === 'chats' ? 'chat' : 'char';
    const nameLower = name.toLowerCase();
    if (_filterPresetsData[key].some(p => p.name.toLowerCase() === nameLower)) {
        showToast(`A preset named "${name}" already exists`, 'warning');
        return;
    }
    const serialized = activeRules.map(({ field, operator, value }) => ({ field, operator, value }));
    _filterPresetsData[key].push({ uid: _generateFilterPresetUid(), name, rules: serialized });
    rerenderAdvFilterPresets();
    const input = document.getElementById('advFilterPresetNameInput');
    if (input) input.value = '';
    saveFilterPresets();
    showToast(`Preset "${name}" saved`, 'success', 2000);
}

async function applyFilterPreset(uid, opts = {}) {
    await loadFilterPresets();
    const preset = getFilterPresets().find(p => p.uid === uid);
    if (!preset) return null;
    setAdvFilterRules(preset.rules.map(r => ({ ...r, id: advFilterNextId++ })));
    rerenderAdvFilterRows();
    updateAdvFilterIndicator();
    triggerAdvFilterSearch();
    if (!opts.silent) {
        closeAdvFilterPresetsPanel();
        showToast(`Loaded "${preset.name}"`, 'success', 2000);
    }
    return preset;
}

/**
 * Populate the Default Filter Preset <select> in Settings with current character-view presets.
 * Reuses the styled custom-select if one was already initialized for this element.
 */
function populateDefaultFilterPresetSelect(selectEl, currentValue) {
    if (!selectEl) return;
    loadFilterPresets().then(() => {
        const presets = (_filterPresetsData && _filterPresetsData.char) || [];
        const opts = ['<option value="" data-icon="fa-solid fa-ban">(None)</option>'];
        for (const p of presets) {
            const safeName = (p.name || '').replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
            opts.push(`<option value="${p.uid}" data-icon="fa-solid fa-filter">${safeName}</option>`);
        }
        selectEl.innerHTML = opts.join('');
        const validUids = new Set(presets.map(p => p.uid));
        selectEl.value = validUids.has(currentValue) ? currentValue : '';
        if (selectEl._customSelect) {
            selectEl._customSelect.refresh();
        } else {
            initCustomSelect(selectEl);
        }
    });
}

async function deleteFilterPreset(uid) {
    await loadFilterPresets();
    const key = currentView === 'chats' ? 'chat' : 'char';
    _filterPresetsData[key] = _filterPresetsData[key].filter(p => p.uid !== uid);
    rerenderAdvFilterPresets();
    saveFilterPresets();
}

function toggleAdvFilterPresetsPanel() {
    const panel = document.getElementById('advFilterPresetsPanel');
    if (!panel) return;
    if (panel.classList.contains('hidden')) openAdvFilterPresetsPanel();
    else closeAdvFilterPresetsPanel();
}

function openAdvFilterPresetsPanel() {
    loadFilterPresets().then(() => {
        rerenderAdvFilterPresets();
        document.getElementById('advFilterPresetsPanel')?.classList.remove('hidden');
        document.getElementById('advFilterPresetsBtn')?.classList.add('active');
        if (!isMobileMode()) {
            setTimeout(() => document.getElementById('advFilterPresetNameInput')?.focus(), 50);
        }
    });
}

function closeAdvFilterPresetsPanel() {
    document.getElementById('advFilterPresetsPanel')?.classList.add('hidden');
    document.getElementById('advFilterPresetsBtn')?.classList.remove('active');
}

function rerenderAdvFilterPresets() {
    const list = document.getElementById('advFilterPresetsList');
    if (!list) return;
    const query = (document.getElementById('advFilterPresetNameInput')?.value || '').trim().toLowerCase();
    const presets = getFilterPresets();
    const filtered = query ? presets.filter(p => p.name.toLowerCase().includes(query)) : presets;
    if (filtered.length === 0) {
        list.innerHTML = presets.length === 0
            ? `<div class="adv-filter-presets-empty">No saved presets</div>`
            : `<div class="adv-filter-presets-empty">No match</div>`;
        return;
    }
    list.innerHTML = filtered.map(p => `<div class="adv-filter-preset-item">
        <button class="adv-filter-preset-load" data-uid="${escapeHtml(p.uid)}">
            <i class="fa-regular fa-bookmark"></i>
            <span>${escapeHtml(p.name)}</span>
        </button>
        <button class="adv-filter-preset-delete" data-uid="${escapeHtml(p.uid)}" title="Delete">
            <i class="fa-solid fa-xmark"></i>
        </button>
    </div>`).join('');
}

let charAdvFilterRules = [];
let advFilterNextId = 1;

function getAdvFilterRules() {
    return charAdvFilterRules;
}

function setAdvFilterRules(rules) {
    charAdvFilterRules = rules;
}

function getActiveAdvFilterFields() {
    return ADV_FILTER_FIELDS;
}

function triggerAdvFilterSearch() {
    performSearch();
}

const debouncedAdvFilterSearch = debounce(triggerAdvFilterSearch, 150);

function toggleAdvFilterPanel() {
    const panel = document.getElementById('advFilterPanel');
    if (!panel) return;
    const isHidden = panel.classList.contains('hidden');
    closeAllTopbarDropdowns('advFilterPanel');
    if (isHidden) {
        panel.classList.remove('hidden');
        if (getAdvFilterRules().length === 0) addAdvFilterRule();
    } else {
        panel.classList.add('hidden');
    }
}

function closeAdvFilterPanel() {
    document.getElementById('advFilterPanel')?.classList.add('hidden');
    closeAdvFilterPresetsPanel();
}

function addAdvFilterRule() {
    const fields = getActiveAdvFilterFields();
    const firstField = Object.keys(fields)[0];
    const rule = {
        id: advFilterNextId++,
        field: firstField,
        operator: fields[firstField].operators[0],
        value: '',
    };
    rule.value = getAdvFilterDefaultValue(rule);
    getAdvFilterRules().push(rule);
    rerenderAdvFilterRows();
    updateAdvFilterIndicator();
}

// Operators with a UI-displayed default (date "7", first provider) need
// the rule's stored value seeded to match, or evaluateAdvancedFilters skips the rule
// for being empty while the user sees a configured filter that silently does nothing.
function getAdvFilterDefaultValue(rule) {
    if (rule.operator === 'in_the_last') return '7';
    const fieldDef = getActiveAdvFilterFields()[rule.field];
    if (!fieldDef) return '';
    if (fieldDef.type === 'provider' && (rule.operator === 'linked_to' || rule.operator === 'not_linked_to')) {
        return ADV_FILTER_PROVIDERS[0]?.value || '';
    }
    return '';
}

function removeAdvFilterRule(id) {
    setAdvFilterRules(getAdvFilterRules().filter(r => r.id !== id));
    updateAdvFilterIndicator();
    rerenderAdvFilterRows();
    triggerAdvFilterSearch();
}

function clearAllAdvFilters() {
    setAdvFilterRules([]);
    updateAdvFilterIndicator();
    rerenderAdvFilterRows();
    triggerAdvFilterSearch();
}

function updateAdvFilterIndicator() {
    const btn = document.getElementById('advFilterBtn');
    if (!btn) return;
    const hasActive = getAdvFilterRules().some(r =>
        ADV_FILTER_NO_VALUE_OPS.has(r.operator) ? true : !!r.value
    );
    btn.classList.toggle('has-filters', hasActive);
}

function rerenderAdvFilterRows() {
    const container = document.getElementById('advFilterRows');
    if (!container) return;
    const rules = getAdvFilterRules();
    if (rules.length === 0) {
        container.innerHTML = '';
        return;
    }
    container.innerHTML = rules.map((rule, idx) => buildAdvFilterRowHtml(rule, idx)).join('');
}

function buildAdvFilterRowHtml(rule, idx) {
    const fields = getActiveAdvFilterFields();
    const fieldDef = fields[rule.field];
    const connector = idx === 0 ? 'Where' : 'and';

    const fieldOptions = Object.entries(fields)
        .map(([k, f]) => `<option value="${k}"${k === rule.field ? ' selected' : ''}>${escapeHtml(f.label)}</option>`)
        .join('');

    const opOptions = fieldDef.operators
        .map(op => `<option value="${op}"${op === rule.operator ? ' selected' : ''}>${escapeHtml(ADV_FILTER_OP_LABELS[op] || op)}</option>`)
        .join('');

    const valueHtml = buildAdvFilterValueHtml(rule, fieldDef);

    return `<div class="adv-filter-row" data-rule-id="${rule.id}">
        <span class="adv-filter-connector">${connector}</span>
        <select class="adv-filter-field" data-rule-id="${rule.id}">${fieldOptions}</select>
        <select class="adv-filter-operator" data-rule-id="${rule.id}">${opOptions}</select>
        ${valueHtml}
        <button class="adv-filter-remove" data-rule-id="${rule.id}" title="Remove"><i class="fa-solid fa-xmark"></i></button>
    </div>`;
}

function buildAdvFilterValueHtml(rule, fieldDef) {
    if (ADV_FILTER_NO_VALUE_OPS.has(rule.operator)) return '';

    if (rule.operator === 'in_the_last') {
        return `<div class="adv-filter-value">
            <input type="number" class="adv-filter-input" data-rule-id="${rule.id}" min="1" value="${escapeHtml(rule.value || '7')}">
            <span class="adv-filter-unit">days</span>
        </div>`;
    }

    if (rule.operator === 'before' || rule.operator === 'after') {
        return `<div class="adv-filter-value">
            <input type="date" class="adv-filter-input" data-rule-id="${rule.id}" value="${escapeHtml(rule.value || '')}">
        </div>`;
    }

    if (fieldDef.type === 'number') {
        return `<div class="adv-filter-value">
            <input type="number" class="adv-filter-input" data-rule-id="${rule.id}" min="0" value="${escapeHtml(rule.value || '')}" placeholder="0">
        </div>`;
    }

    if (fieldDef.type === 'provider') {
        const opts = ADV_FILTER_PROVIDERS
            .map(p => `<option value="${p.value}"${p.value === (rule.value || ADV_FILTER_PROVIDERS[0]?.value) ? ' selected' : ''}>${escapeHtml(p.label)}</option>`)
            .join('');
        return `<div class="adv-filter-value"><select class="adv-filter-input" data-rule-id="${rule.id}">${opts}</select></div>`;
    }

    return `<div class="adv-filter-value">
        <input type="search" class="adv-filter-input" data-rule-id="${rule.id}" value="${escapeHtml(rule.value || '')}" placeholder="Value..." autocomplete="off">
    </div>`;
}

function evaluateAdvancedFilters(c) {
    for (const rule of charAdvFilterRules) {
        const needsValue = !ADV_FILTER_NO_VALUE_OPS.has(rule.operator);
        if (needsValue && !rule.value) continue;
        if (!evaluateAdvFilterRule(c, rule)) return false;
    }
    return true;
}

function evaluateAdvFilterRule(c, rule) {
    const op = rule.operator;
    const val = (rule.value || '').toLowerCase();

    switch (rule.field) {
        case 'name': return evalTextOp(c._lowerName, op, val);
        case 'listingName': return evalTextOp(c._lowerListingName || '', op, val);
        case 'creator': return evalTextOp(c._lowerCreator, op, val);
        case 'tags': return evalTagOp(c, op, val);
        case 'creatorNotes': {
            const notes = String(c.creator_notes || c.data?.creator_notes || '').toLowerCase();
            return evalTextOp(notes, op, val);
        }
        case 'favorite':
            return op === 'is_true' ? isCharacterFavorite(c) : !isCharacterFavorite(c);
        case 'providerLink': return evalProviderOp(c, op, rule.value);
        case 'dateAdded': return evalDateOp(c._dateAdded, op, rule.value);
        case 'dateCreated': return evalDateOp(c._createDate, op, rule.value);
        case 'version': {
            const ver = (c.character_version || c.data?.character_version || '').toLowerCase();
            return evalTextOp(ver, op, val);
        }
        case 'tokens': return c._tokenEstimate == null ? false : evalNumberOp(c._tokenEstimate, op, rule.value);
        case 'nameOverride': return evalNameOverrideOp(c, op);
    }
    return true;
}

function evalTextOp(text, op, val) {
    switch (op) {
        case 'contains': return text.includes(val);
        case 'not_contains': return !text.includes(val);
        case 'equals': return text === val;
        case 'starts_with': return text.startsWith(val);
        case 'is_empty': return !text;
        case 'is_not_empty': return !!text;
    }
    return true;
}

function evalTagOp(c, op, val) {
    const tags = getTags(c);
    const hasTag = tags.some(t => t.toLowerCase() === val);
    return op === 'includes' ? hasTag : !hasTag;
}

function evalProviderOp(c, op, val) {
    if (op === 'is_linked') return !!window.ProviderRegistry?.getLinkInfo(c);
    if (op === 'is_not_linked') return !window.ProviderRegistry?.getLinkInfo(c);
    const prov = val ? window.ProviderRegistry?.getProvider(val) : null;
    const isLinked = prov ? !!prov.getLinkInfo(c) : false;
    return op === 'linked_to' ? isLinked : !isLinked;
}

function evalDateOp(timestamp, op, rawVal) {
    if (!timestamp) return false;
    if (op === 'in_the_last') {
        const days = parseInt(rawVal, 10);
        if (isNaN(days) || days <= 0) return true;
        return timestamp >= Date.now() - days * 86400000;
    }
    const target = new Date(rawVal).getTime();
    if (isNaN(target)) return true;
    if (op === 'before') return timestamp < target;
    if (op === 'after') return timestamp > target;
    return true;
}

function evalNameOverrideOp(c, op) {
    const prefs = getSetting('namePreferences') || {};
    const pref = prefs[c.avatar] || null;
    switch (op) {
        case 'has_override': return !!pref;
        case 'no_override': return !pref;
        case 'set_to_card': return pref === 'card';
        case 'set_to_listing': return pref === 'listing';
    }
    return true;
}

// Search and Filter Functionality (Global so it can be called from view switching)
function performSearch() {
    updateMobileFilterIndicator();
    const rawQuery = document.getElementById('searchInput').value;
    
    const useName = document.getElementById('searchName').checked;
    const useListingName = document.getElementById('searchListingName').checked;
    const useTags = document.getElementById('searchTags').checked;
    const useAuthor = document.getElementById('searchAuthor').checked;
    const useNotes = document.getElementById('searchNotes').checked;
    const useTagline = document.getElementById('searchTagline')?.checked;
    
    // ========================================================================
    // Parse prefix tokens from query, leaving remaining text as free-text search.
    // Supports multiple prefixes combined with free text, e.g.:
    //   "creator:john linked:yes dark elf"
    // ========================================================================
    
    // favorite before fav: alternation is first-match, so a token that prefixes another must come second.
    const prefixPattern = /(?:^|\s)((?:creator|version|gallery|uid|favorite|fav|linked|chub|datacat|dc):(?:[^\s]+))/gi;
    
    let creatorFilter = null;
    let versionFilter = null;
    let galleryFilter = null;
    let uidFilter = null;
    let favoriteFilter = null;
    let filterFavoriteYes = false;
    let filterFavoriteNo = false;
    let linkFilterPrefix = null;
    let linkFilterWantLinked = false;
    
    let query = rawQuery;
    let match;
    
    while ((match = prefixPattern.exec(rawQuery)) !== null) {
        const token = match[1];
        const colonIdx = token.indexOf(':');
        const prefix = token.substring(0, colonIdx).toLowerCase();
        const value = token.substring(colonIdx + 1).trim().toLowerCase();
        if (!value) continue;
        
        query = query.replace(token, '');
        
        if (prefix === 'creator') {
            creatorFilter = value;
        } else if (prefix === 'version') {
            versionFilter = value;
        } else if (prefix === 'gallery') {
            galleryFilter = value;
        } else if (prefix === 'uid') {
            uidFilter = value;
        } else if (prefix === 'favorite' || prefix === 'fav') {
            favoriteFilter = value;
            filterFavoriteYes = value === 'yes' || value === 'true';
            filterFavoriteNo = value === 'no' || value === 'false';
        } else if (['linked', 'chub', 'datacat', 'dc'].includes(prefix)) {
            linkFilterPrefix = prefix;
            linkFilterWantLinked = value === 'yes' || value === 'true' || value === 'linked';
        }
    }
    
    query = query.trim().toLowerCase();

    // Tag filter selections are per-pass constants too; split them once here
    const includedTags = [];
    const excludedTags = [];
    activeTagFilters.forEach((state, tag) => {
        if (state === 'include') includedTags.push(tag);
        else if (state === 'exclude') excludedTags.push(tag);
    });
    const includedTagSet = new Set(includedTags);
    const excludedTagSet = new Set(excludedTags);

    const filtered = allCharacters.filter(c => {
        
        // Prefix filters: each is an AND constraint
        
        if (creatorFilter) {
            if (!(c._lowerCreator === creatorFilter || c._lowerCreator.includes(creatorFilter))) return false;
        }
        
        if (versionFilter) {
            const version = (c.character_version || (c.data ? c.data.character_version : "") || "").toLowerCase();
            if (versionFilter === 'none' || versionFilter === 'empty') {
                if (version) return false;
            } else {
                if (!(version === versionFilter || version.includes(versionFilter))) return false;
            }
        }
        
        if (galleryFilter) {
            const gid = (c.data?.extensions?.gallery_id || '').toLowerCase();
            if (galleryFilter === 'none' || galleryFilter === 'empty') {
                if (gid) return false;
            } else {
                if (!(gid === galleryFilter || gid.includes(galleryFilter))) return false;
            }
        }
        
        if (uidFilter) {
            const uid = (c.data?.extensions?.version_uid || '').toLowerCase();
            if (uidFilter === 'none' || uidFilter === 'empty') {
                if (uid) return false;
            } else {
                if (!(uid === uidFilter || uid.includes(uidFilter))) return false;
            }
        }
        
        if (favoriteFilter !== null) {
            const isFav = isCharacterFavorite(c);
            if (filterFavoriteYes && !isFav) return false;
            if (filterFavoriteNo && isFav) return false;
        }
        
        if (linkFilterPrefix !== null) {
            let isLinked = false;
            if (linkFilterPrefix === 'linked') {
                isLinked = !!window.ProviderRegistry?.getLinkInfo(c);
            } else {
                const provId = linkFilterPrefix === 'chub' ? 'chub'
                    : (linkFilterPrefix === 'janitorai' || linkFilterPrefix === 'jai') ? 'janitorai'
                    : linkFilterPrefix === 'janny' ? 'jannyai'
                    : (linkFilterPrefix === 'datacat' || linkFilterPrefix === 'dc') ? 'datacat'
                    : null;
                const prov = provId ? window.ProviderRegistry?.getProvider(provId) : null;
                isLinked = prov ? !!prov.getLinkInfo(c) : false;
            }
            if (linkFilterWantLinked && !isLinked) return false;
            if (!linkFilterWantLinked && isLinked) return false;
        }
        
        // Favorites-only filter (from toolbar button)
        if (showFavoritesOnly) {
            if (!isCharacterFavorite(c)) return false;
        }

        // Advanced filter rules (AND with all other constraints)
        if (charAdvFilterRules.length > 0) {
            if (!evaluateAdvancedFilters(c)) return false;
        }

        // 1. Text Search Logic
        let matchesSearch = false;
        if (!query) {
            matchesSearch = true;
        } else {
            if (useName && c._lowerName.includes(query)) matchesSearch = true;
            if (!matchesSearch && useListingName && c._lowerListingName && c._lowerListingName.includes(query)) matchesSearch = true;
            if (!matchesSearch && useTags && c._tagsLower.includes(query)) matchesSearch = true;
            if (!matchesSearch && useAuthor && c._lowerCreator.includes(query)) matchesSearch = true;
            if (!matchesSearch && useNotes && (c._lowerNotes || '').includes(query)) matchesSearch = true;
            if (!matchesSearch && useTagline && (c._lowerTagline || '').includes(query)) matchesSearch = true;
        }

        // 2. Tag Filter Logic - Tri-state: include, exclude, neutral
        //    Include mode: 'any' = OR (has at least one), 'all' = AND (has every one)
        //    Exclude mode: 'any' = reject if has any, 'all' = reject only if has all
        if (activeTagFilters.size > 0) {
             const charTags = getTags(c);

             if (excludedTags.length > 0) {
                 const hasExcluded = tagExcludeMode === 'all'
                     ? excludedTags.every(t => charTags.includes(t))
                     : charTags.some(t => excludedTagSet.has(t));
                 if (hasExcluded) return false;
             }

             if (includedTags.length > 0) {
                 const hasIncluded = tagIncludeMode === 'all'
                     ? includedTags.every(t => charTags.includes(t))
                     : charTags.some(t => includedTagSet.has(t));
                 if (!hasIncluded) return false;
             }
        }

        return matchesSearch;
    });
    
    const sorted = [...filtered].sort(makeCharSortComparator());
    
    // Keep currentCharacters in sync with sorted/filtered result
    // This ensures the sort change handler (and any other consumer) works with 
    // the same data that was just rendered, preventing stale-order bugs.
    currentCharacters = sorted;
    
    renderGrid(sorted);
}

/**
 * Filter local cards view by creator name
 * Sets the search to "creator:Name" and ensures Author filter is checked
 */
function filterLocalByCreator(creatorName) {
    debugLog('[Gallery] Filtering local by creator:', creatorName);
    
    // Switch to characters view if not already there
    if ((getCurrentView() || 'characters') !== 'characters') {
        switchView('characters');
    }
    
    // Set search input to creator filter syntax
    const searchInput = document.getElementById('searchInput');
    const clearSearchBtn = document.getElementById('clearSearchBtn');
    if (searchInput) {
        searchInput.value = `creator:${creatorName}`;
        // Show clear button since we're populating programmatically
        if (clearSearchBtn) clearSearchBtn.classList.remove('hidden');
    }
    
    const authorCheckbox = document.getElementById('searchAuthor');
    if (authorCheckbox) {
        authorCheckbox.checked = true;
    }
    
    // Trigger search
    performSearch();
    
    showToast(`Filtering by creator: ${creatorName}`, 'info');
}

// Debounced search for better performance (150ms delay)
const debouncedSearch = debounce(performSearch, 150);

const TOPBAR_DROPDOWN_IDS = ['tagFilterPopup', 'searchSettingsMenu', 'moreOptionsMenu', 'notificationsDropdown', 'advFilterPanel'];

function closeAllTopbarDropdowns(exceptId) {
    for (const id of TOPBAR_DROPDOWN_IDS) {
        if (id === exceptId) continue;
        document.getElementById(id)?.classList.add('hidden');
    }
    document.querySelectorAll('.custom-select-menu:not(.hidden)').forEach(m => m.classList.add('hidden'));
    window.closeActiveBrowseDropdowns?.();
}

