/**
 * tag-manager.js -- Phase 5B tag editor.
 *
 * A curation surface for the persistent tag dictionary. It shows three lists:
 *   • Canonical tags + the variants that merge into each (the full dictionary,
 *     grouped into collapsible categories).
 *   • Unassigned -- every tag seen on a card that no canonical claims.
 *   • Removed -- junk tags that get deleted from every card when applied.
 * Moving a tag between buckets edits the dictionary and saves immediately
 * (as a delta against the shipped base -- see tag-dictionary.js). It does NOT
 * rewrite any cards itself: the footer's "Apply Tags" button resolves the
 * dictionary against a fresh survey of the archive into a literal
 * { rename, remove } plan and posts that to the server (POST
 * /api/v1/tags/apply), which applies it by string equality and makes no
 * matching decisions of its own -- see docs/PHASE_5B_TAG_EDITOR_PLAN.md.
 *
 * Ported from SillyTavern-Character-Tools/ui-editor.js. The model (state
 * shape, rebuildMapping, moveVariant, buildBuckets/buildApplyPayload as the
 * sole decision point) is kept verbatim; only the SillyTavern chrome
 * (menu_button, toastr, text_pole, the SillyTavern modal shell) is replaced
 * with this app's CoreAPI / cl-modal equivalents.
 */
import * as CoreAPI from './core-api.js';
import { getCardTags, buildBuckets, buildApplyPayload, pickCanonical } from '../vendor/tag-tools/tag-analysis.js';
import { ensureDictionary, saveDictionary, loadBaseDictionary, rebuildMapping, dictSnapshot } from './tag-dictionary.js';

const debugLog = (...args) => {
    if (CoreAPI.getSetting?.('debugMode')) {
        console.log(...args);
    }
};

let isInitialized = false;

// Live state for the open modal. { groups: [{id, canonical, variants[], patterns[], category}], unassigned[], removed[], removedPatterns[] }
let state = null;
let characterList = [];
let groupSeq = 0;
let canonicalCategories = {};   // canonical -> category name
let categoryOrder = [];         // category names in dictionary order
let baseSnapshot = null;        // dictSnapshot of the base, for the Reset dirty-check

// Per-bucket filter text and a single shared selection (one bucket at a time).
let bucketFilter = { unassigned: '', removed: '' };
let selectionBucket = null;     // 'unassigned' | 'removed' | null
let selected = new Set();       // Set of variant objects

function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
}

export function init() {
    if (isInitialized) {
        console.warn('[TagManager] Already initialized');
        return;
    }

    injectModal();
    setupEventListeners();

    window.registerOverlay?.({ id: 'tagManagerModal', tier: 7, close: () => closeModal(), visible: (m) => m.classList.contains('visible') });
    // Registered once; getTopmostOverlay() skips it whenever no chip menu is
    // open (getElementById returns null). While open it sits above the modal
    // by z-index, so the global Escape handler closes it first.
    window.registerOverlay?.({ id: 'tagManagerChipMenu', tier: 8, static: false, close: () => closeChipMenu() });

    isInitialized = true;
    debugLog('[TagManager] Module initialized');
}

export async function openModal() {
    if (!isInitialized) {
        console.error('[TagManager] Module not initialized');
        return;
    }

    document.getElementById('tagManagerModal')?.classList.add('visible');
    closeChipMenu();
    setStatus('Loading the tag dictionary and scanning the archive…');
    const applyBtn = document.getElementById('tagManagerApplyBtn');
    if (applyBtn) applyBtn.disabled = true;

    try {
        const [dict, characters] = await Promise.all([
            ensureDictionary(),
            Promise.resolve(CoreAPI.getAllCharacters()),
        ]);
        characterList = characters;
        canonicalCategories = dict.canonicalCategories;
        categoryOrder = dict.categoryOrder;
        groupSeq = 0;
        bucketFilter = { unassigned: '', removed: '' };
        selectionBucket = null;
        selected = new Set();

        // Load the base first to snapshot it (for the Reset dirty-check),
        // then load the real working dictionary. Don't collapse these.
        loadState(dict.baseMapping, dict.baseRemovedTags);
        baseSnapshot = currentSnapshot();
        loadState(dict.mapping, dict.removedTags);

        renderBody();
    } catch (err) {
        console.error('[TagManager] Failed to build tag buckets:', err);
        setStatus('Could not load the tag dictionary or scan the archive. See the console for details.');
        state = null;
    }
}

/** (Re)build the modal's three buckets from a dictionary into `state`. */
function loadState(mapping, removedTags) {
    const { groups, unassigned, removed, removedPatterns } = buildBuckets(characterList, mapping, removedTags);
    state = {
        groups: groups.map(g => ({
            id: `g${groupSeq++}`,
            canonical: g.canonical,
            variants: g.variants,
            // Glob rules for this canonical. Held apart from `variants`
            // because they are rules, not tags: no chip, no count, can't be
            // moved. Must be written back on save (see rebuildMapping) or the
            // next persist would diff them away as user deletions.
            patterns: g.patterns,
            category: canonicalCategories[g.canonical] ?? '',
        })),
        unassigned,
        removed,
        removedPatterns,
    };
}

function currentSnapshot() {
    const { mapping, removed } = rebuildMapping(state);
    return dictSnapshot(mapping, removed);
}

/** Persist the dictionary rebuilt from live state (see rebuildMapping) to settings. */
function persist() {
    const { mapping, removed } = rebuildMapping(state);
    saveDictionary(mapping, removed);
    updateResetBtn();
}

function updateResetBtn() {
    const btn = document.getElementById('tagManagerResetBtn');
    if (!btn || !baseSnapshot) return;
    btn.disabled = currentSnapshot() === baseSnapshot;
}

/** Read DOM-only edits (canonical text) back into the model. */
function syncFromDom() {
    if (!state) return;
    for (const group of state.groups) {
        const tr = document.querySelector(`.ctm-row[data-id="${group.id}"]`);
        const input = tr?.querySelector('.ctm-canonical');
        if (input) group.canonical = input.value.trim() || group.canonical;
    }
}

// ── Apply ────────────────────────────────────────────────────────────────

async function applyPlan() {
    syncFromDom();
    const { mapping, removed } = rebuildMapping(state);
    const characters = await CoreAPI.refreshCharacters(true);   // re-survey, don't reuse the open-time list
    const plan = buildApplyPayload(characters, mapping, removed);
    if (Object.keys(plan.rename).length === 0 && plan.remove.length === 0) {
        CoreAPI.showToast('The dictionary changes nothing on these cards — nothing to apply.', 'info');
        return;
    }
    const stats = computeStats(characters, plan);

    const confirmed = await CoreAPI.showConfirm({
        title: 'Apply tag consolidation?',
        message: `This renames ${stats.renames} tag spelling(s) and removes ${stats.removals}, ` +
            `touching ${stats.affectedCards} card(s) on disk. This cannot be undone from here.`,
        icon: 'fa-solid fa-triangle-exclamation',
        iconColor: 'var(--cl-warning-bright)',
        confirmLabel: 'Apply',
        cancelLabel: 'Cancel',
        danger: true,
    });
    if (!confirmed) return;

    const applyBtn = document.getElementById('tagManagerApplyBtn');
    const originalHtml = applyBtn?.innerHTML;
    if (applyBtn) { applyBtn.disabled = true; applyBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Applying…'; }

    try {
        const resp = await fetch('/api/v1/tags/apply', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(plan),
        });
        if (!resp.ok) {
            const detail = await resp.text().catch(() => '');
            throw new Error(detail || `HTTP ${resp.status}`);
        }
        const result = await resp.json();
        const failedCount = Object.keys(result.failed || {}).length;
        for (const [id, reason] of Object.entries(result.failed || {})) {
            console.error('[TagManager] Failed to update', id, reason);
        }
        if (failedCount === 0) {
            CoreAPI.showToast(`Tag consolidation applied: ${result.changed} card(s) changed`, 'success');
        } else {
            CoreAPI.showToast(`Applied with errors: ${result.changed} changed, ${failedCount} failed`, 'warning');
        }

        // Rebuild buckets from the SAME working dictionary against the
        // refreshed characters, rather than reopening -- that would also
        // re-read the dictionary and reset scroll / open-section state.
        characterList = await CoreAPI.refreshCharacters(true);
        loadState(mapping, removed);
        renderBody();
    } catch (err) {
        console.error('[TagManager] Apply failed:', err);
        CoreAPI.showToast('Failed to apply the tag plan. See the console for details.', 'error');
        if (applyBtn) { applyBtn.disabled = false; applyBtn.innerHTML = originalHtml; }
    }
}

// Cards-affected and before/after vocabulary size, derived from the same
// literal plan the server would apply -- not a second interpretation of it.
function computeStats(characters, plan) {
    const removeSet = new Set(plan.remove);
    const before = new Set();
    const after = new Set();
    let affectedCards = 0;

    for (const char of characters) {
        const tags = getCardTags(char);
        let changed = false;
        for (const tag of tags) {
            before.add(tag);
            if (removeSet.has(tag)) {
                changed = true;
                continue;
            }
            const mapped = plan.rename[tag] ?? tag;
            if (mapped !== tag) changed = true;
            after.add(mapped);
        }
        if (changed) affectedCards++;
    }

    return {
        renames: Object.keys(plan.rename).length,
        removals: plan.remove.length,
        affectedCards,
        vocabBefore: before.size,
        vocabAfter: after.size,
    };
}

// ── rendering ────────────────────────────────────────────────────────────

function setStatus(message) {
    const body = document.getElementById('tagManagerBody');
    if (!body) return;
    body.innerHTML = `<div class="tm-status">${CoreAPI.escapeHtml(message)}</div>`;
}

function renderBody() {
    const body = document.getElementById('tagManagerBody');
    if (!body || !state) return;

    // Recomputed on every render -- these numbers are the point of the
    // screen and change with every move.
    const { mapping, removed } = rebuildMapping(state);
    const plan = buildApplyPayload(characterList, mapping, removed);
    const stats = computeStats(characterList, plan);
    const planEmpty = Object.keys(plan.rename).length === 0 && plan.remove.length === 0;

    body.innerHTML = '';
    body.appendChild(buildSummary(stats));
    body.appendChild(buildTable());
    body.appendChild(buildBucket('unassigned'));
    body.appendChild(buildBucket('removed'));

    const applyBtn = document.getElementById('tagManagerApplyBtn');
    if (applyBtn) applyBtn.disabled = planEmpty;
    updateResetBtn();
}

function buildSummary(stats) {
    return el(`
        <div class="ctm-summary">
            <div class="tm-summary">
                <div class="tm-stat"><span class="tm-stat-num">${stats.renames}</span><span class="tm-stat-label">renames</span></div>
                <div class="tm-stat"><span class="tm-stat-num">${stats.removals}</span><span class="tm-stat-label">removals</span></div>
                <div class="tm-stat"><span class="tm-stat-num">${stats.affectedCards}</span><span class="tm-stat-label">cards affected</span></div>
                <div class="tm-stat"><span class="tm-stat-num">${stats.vocabBefore} → ${stats.vocabAfter}</span><span class="tm-stat-label">vocabulary</span></div>
            </div>
            <div class="ctm-counts"><b>${state.groups.length}</b> canonical tag${state.groups.length === 1 ? '' : 's'}, <b>${state.unassigned.length}</b> unassigned, <b>${state.removed.length}</b> removed.</div>
            <div class="ctm-hint">Click a tag to move it between canonicals, Unassigned, or Removed. ✕ on a variant sends it back to Unassigned. Edits save automatically.</div>
        </div>
    `);
}

/** True if this group will actually rename at least one tag on a real card. */
function groupHasRename(group) {
    return group.variants.some(v => v.count > 0 && v.tag !== group.canonical);
}

/** Union of card avatars across a group's variants. */
function cardCount(group) {
    const set = new Set();
    for (const v of group.variants) for (const a of v.avatars) set.add(a);
    return set.size;
}

function buildRow(group) {
    const tr = el(`
        <tr class="ctm-row" data-id="${group.id}">
            <td><input type="text" class="ctm-canonical cl-input" value="${CoreAPI.escapeHtml(group.canonical)}"></td>
            <td class="ctm-variants"></td>
            <td class="ctm-col-count">${cardCount(group)}</td>
            <td class="ctm-col-dismiss"><span class="ctm-row-dismiss" title="Delete canonical — send all variants to Unassigned">✕</span></td>
        </tr>
    `);
    const visibleVariants = group.variants.filter(v => v.count > 0);
    if (!groupHasRename(group)) tr.classList.add('ctm-row--muted');
    const cell = tr.querySelector('.ctm-variants');
    // Rules first, then the tags they and the literal aliases pulled in.
    for (const p of group.patterns ?? []) cell.appendChild(buildRuleChip(p));
    for (const v of visibleVariants) cell.appendChild(buildChip(v, group));
    tr.querySelector('.ctm-canonical').addEventListener('change', (e) => {
        group.canonical = e.target.value.trim() || group.canonical;
        e.target.value = group.canonical;
        persist();
    });
    tr.querySelector('.ctm-row-dismiss').addEventListener('click', () => {
        // Glob rules are core-dictionary-only: the editor round-trips them
        // but never lets a user author or destroy one. Deleting the
        // canonical that owns a rule would do exactly that, silently, so
        // refuse instead.
        if ((group.patterns ?? []).length > 0) {
            CoreAPI.showToast(`"${group.canonical}" holds a core match rule (${group.patterns.join(', ')}) and can't be deleted. Move its tags individually instead.`, 'info');
            return;
        }
        syncFromDom();
        state.groups = state.groups.filter(g => g !== group);
        for (const v of group.variants) { v.declared = false; state.unassigned.push(v); }
        persist();
        renderBody();
    });
    return tr;
}

function buildTable() {
    const wrap = el(`<div class="ctm-categories"></div>`);

    // Group by category, preserving dictionary order; uncategorised at end.
    const byCat = new Map();
    for (const group of state.groups) {
        const cat = group.category || 'Custom';
        if (!byCat.has(cat)) byCat.set(cat, []);
        byCat.get(cat).push(group);
    }
    const orderedCats = [
        ...categoryOrder.filter(c => byCat.has(c)),
        ...[...byCat.keys()].filter(c => !categoryOrder.includes(c)),
    ];

    for (const cat of orderedCats) {
        const groups = byCat.get(cat);
        const hasChanges = groups.some(groupHasRename);
        const section = el(`
            <details class="ctm-category${hasChanges ? '' : ' ctm-category--clean'}"${hasChanges ? ' open' : ''}>
                <summary class="ctm-category-header">
                    <span class="ctm-category-name">${CoreAPI.escapeHtml(cat)}</span>
                    <span class="ctm-category-count">${groups.length}</span>
                </summary>
                <div class="ctm-table-wrap">
                    <table class="ctm-table">
                        <thead><tr>
                            <th>Canonical tag</th><th>Merged variants</th>
                            <th class="ctm-col-count">Cards</th><th class="ctm-col-dismiss"></th>
                        </tr></thead>
                        <tbody></tbody>
                    </table>
                </div>
            </details>
        `);
        const tbody = section.querySelector('tbody');
        for (const group of groups) tbody.appendChild(buildRow(group));
        wrap.appendChild(section);
    }
    return wrap;
}

/**
 * A glob rule chip. Deliberately inert -- no click handler, no count, no ✕.
 * Rules come from the shipped dictionary only; a user redirects a tag a rule
 * caught by moving that tag's own chip, which writes a literal override that
 * outranks every rule.
 */
function buildRuleChip(source) {
    const kind = source.startsWith('*') && source.endsWith('*') ? 'containing'
        : source.endsWith('*') ? 'starting with'
            : 'ending with';
    const needle = source.replace(/^\*|\*$/g, '');
    return el(`
        <span class="ctm-chip ctm-chip-rule" title="Core match rule — claims any unmapped tag ${kind} &quot;${CoreAPI.escapeHtml(needle)}&quot;. Move a tag's own chip to override it.">
            <span class="ctm-chip-rule-icon">⌇</span>
            <span class="ctm-chip-rule-label">${CoreAPI.escapeHtml(source)}</span>
        </span>
    `);
}

/** A variant chip inside a canonical group. */
function buildChip(variant, group) {
    const via = String(variant.matchedBy ?? '').startsWith('pattern:')
        ? ` — matched by rule ${variant.matchedBy.slice('pattern:'.length)}`
        : '';
    const chip = el(`
        <span class="ctm-chip${via ? ' ctm-chip-viarule' : ''}" title="Click to move${CoreAPI.escapeHtml(via)}">
            <span class="ctm-chip-label">${CoreAPI.escapeHtml(variant.tag)}</span>
            <span class="ctm-chip-count">${variant.count}</span>
            <span class="ctm-chip-x" title="Remove from group">✕</span>
        </span>
    `);
    const openMenu = (e) => { e.stopPropagation(); openChipMenu(chip, variant, group); };
    chip.querySelector('.ctm-chip-label').addEventListener('click', openMenu);
    chip.querySelector('.ctm-chip-count').addEventListener('click', openMenu);
    chip.querySelector('.ctm-chip-x').addEventListener('click', (e) => {
        e.stopPropagation();
        moveVariant(variant, group, 'unassigned');
    });
    return chip;
}

// ── Unassigned / Removed buckets (shared implementation) ─────────────────────

const BUCKET_META = {
    unassigned: {
        cls: 'ctm-bucket-unassigned',
        chipCls: 'ctm-chip-excluded',
        header: n => `Unassigned — no canonical mapping (${n})`,
        empty: 'Every tag on your cards is mapped or removed. 🎉',
        clickTitle: 'Click to assign to a canonical',
    },
    removed: {
        cls: 'ctm-bucket-removed',
        chipCls: 'ctm-chip-removed',
        header: n => `Removed — deleted from all cards on apply (${n})`,
        empty: 'No tags flagged for removal.',
        clickTitle: 'Click to move out of Removed',
    },
};

function bucketArr(kind) { return kind === 'removed' ? state.removed : state.unassigned; }

function refreshBucket(kind) {
    const node = document.querySelector(`#tagManagerBody .${BUCKET_META[kind].cls}`);
    if (node) node.replaceWith(buildBucket(kind));
}

function buildBucket(kind) {
    const meta = BUCKET_META[kind];
    const arr = bucketArr(kind);
    const visible = kind === 'removed' ? arr.filter(v => v.count > 0) : arr;
    const wrap = el(`<div class="ctm-excluded ${meta.cls}"></div>`);
    const inSelection = selectionBucket === kind;

    const headerRow = el(`<div class="ctm-excluded-header-row">
        <span class="ctm-excluded-header">${meta.header(visible.length)}</span>
        ${visible.length > 0 ? `<span class="ctm-link ctm-excluded-toggle">${inSelection ? 'Cancel' : 'Select'}</span>` : ''}
    </div>`);
    headerRow.querySelector('.ctm-excluded-toggle')?.addEventListener('click', () => {
        selectionBucket = inSelection ? null : kind;
        selected.clear();
        renderBody();
    });
    wrap.appendChild(headerRow);

    if (visible.length === 0) {
        wrap.appendChild(el(`<div class="ctm-excluded-empty">${meta.empty}</div>`));
        return wrap;
    }

    if (inSelection && selected.size > 0) wrap.appendChild(buildBulkActionBar(kind));

    const filter = el(`<input type="text" class="ctm-excluded-filter cl-input" placeholder="Filter ${visible.length} tags…" value="${CoreAPI.escapeHtml(bucketFilter[kind])}">`);
    wrap.appendChild(filter);
    const sorted = [...visible].sort((a, b) =>
        kind === 'removed'
            ? b.count - a.count
            : a.tag.toLowerCase().replace(/^#+/, '').localeCompare(b.tag.toLowerCase().replace(/^#+/, '')));
    const strip = el(`<div class="ctm-excluded-strip"></div>`);
    for (const v of sorted) {
        const chip = buildBucketChip(kind, v);
        chip.dataset.tag = v.tag.toLowerCase().replace(/^#+/, '');
        strip.appendChild(chip);
    }
    wrap.appendChild(strip);

    filter.addEventListener('input', (e) => { bucketFilter[kind] = e.target.value; applyBucketFilter(kind, strip); });
    applyBucketFilter(kind, strip);
    return wrap;
}

function buildBucketChip(kind, variant) {
    const meta = BUCKET_META[kind];
    const inSelection = selectionBucket === kind;
    const isSelected = selected.has(variant);
    const chip = el(`
        <span class="ctm-chip ${meta.chipCls}${isSelected ? ' ctm-chip-selected' : ''}"
              title="${inSelection ? 'Click to select' : meta.clickTitle}">
            <span class="ctm-chip-label">${CoreAPI.escapeHtml(variant.tag)}</span>
            <span class="ctm-chip-count">${variant.count}</span>
        </span>
    `);
    chip.addEventListener('click', (e) => {
        e.stopPropagation();
        if (inSelection) {
            if (selected.has(variant)) selected.delete(variant); else selected.add(variant);
            refreshBucket(kind);
        } else {
            openChipMenu(chip, variant, kind);
        }
    });
    return chip;
}

function buildBulkActionBar(kind) {
    const n = selected.size;
    const restoreLabel = kind === 'removed' ? '↩ To Unassigned' : '🗑 Remove';
    const restoreTo = kind === 'removed' ? 'unassigned' : 'removed';
    const bar = el(`<div class="ctm-bulk-bar">
        <span class="ctm-bulk-count">${n} selected</span>
        <div class="ctm-bulk-move-wrap">
            <input type="text" class="ctm-bulk-filter cl-input" placeholder="Move to canonical…">
            <div class="ctm-bulk-group-list" style="display:none;"></div>
        </div>
        <div class="ctm-bulk-btn ctm-bulk-newgroup">＋ New canonical</div>
        <div class="ctm-bulk-btn ctm-bulk-restore">${restoreLabel}</div>
        <span class="ctm-link ctm-bulk-clear">Deselect all</span>
    </div>`);

    const filterInput = bar.querySelector('.ctm-bulk-filter');
    const groupList = bar.querySelector('.ctm-bulk-group-list');

    function renderGroupList(q) {
        groupList.innerHTML = '';
        const filtered = state.groups.filter(g => !q || g.canonical.toLowerCase().includes(q));
        if (filtered.length === 0) {
            groupList.appendChild(el(`<div class="ctm-bulk-group-item ctm-chip-menu-empty">No matching canonicals</div>`));
            return;
        }
        for (const g of filtered.slice(0, 50)) {
            const item = el(`<div class="ctm-bulk-group-item">→ ${CoreAPI.escapeHtml(g.canonical)}</div>`);
            item.addEventListener('click', () => bulkMoveSelected(kind, g));
            groupList.appendChild(item);
        }
    }

    filterInput.addEventListener('focus', () => { groupList.style.display = 'block'; renderGroupList(filterInput.value.trim().toLowerCase()); });
    filterInput.addEventListener('input', (e) => renderGroupList(e.target.value.trim().toLowerCase()));
    filterInput.addEventListener('keydown', (e) => e.stopPropagation());
    filterInput.addEventListener('click', (e) => e.stopPropagation());
    filterInput.addEventListener('blur', () => setTimeout(() => { groupList.style.display = 'none'; }, 150));

    bar.querySelector('.ctm-bulk-newgroup').addEventListener('click', () => bulkMoveSelected(kind, 'new'));
    bar.querySelector('.ctm-bulk-restore').addEventListener('click', () => bulkMoveSelected(kind, restoreTo));
    bar.querySelector('.ctm-bulk-clear').addEventListener('click', () => { selected.clear(); refreshBucket(kind); });
    return bar;
}

function bulkMoveSelected(kind, to) {
    syncFromDom();
    const variants = [...selected];
    selected.clear();
    if (kind === 'removed') state.removed = state.removed.filter(v => !variants.includes(v));
    else state.unassigned = state.unassigned.filter(v => !variants.includes(v));

    if (to === 'new') {
        for (const v of variants) v.declared = true;
        state.groups.push({ id: `g${groupSeq++}`, canonical: pickCanonical(variants), variants });
    } else if (to === 'removed') {
        for (const v of variants) { v.declared = true; state.removed.push(v); }
    } else if (to === 'unassigned') {
        for (const v of variants) { v.declared = false; state.unassigned.push(v); }
    } else {
        for (const v of variants) { v.declared = true; to.variants.push(v); }
    }
    selectionBucket = null;
    persist();
    renderBody();
}

function applyBucketFilter(kind, strip) {
    const q = bucketFilter[kind].trim().toLowerCase().replace(/^#+/, '');
    for (const chip of strip.children) {
        chip.style.display = (!q || chip.dataset.tag.includes(q)) ? '' : 'none';
    }
}

function onNewEmptyGroup() {
    syncFromDom();
    state.groups.push({ id: `g${groupSeq++}`, canonical: 'New Tag', variants: [] });
    persist();
    renderBody();
}

// ── Chip move menu ─────────────────────────────────────────────────────────

let chipMenuEl = null;

function closeChipMenu() {
    chipMenuEl?.remove();
    chipMenuEl = null;
}

/** `from` is a group object, or 'unassigned' / 'removed' for bucket chips. */
function openChipMenu(anchor, variant, from) {
    closeChipMenu();
    syncFromDom();

    const fromGroup = typeof from === 'object' ? from : null;
    const groupItems = state.groups.filter(g => g !== fromGroup).map(g => ({ label: g.canonical, g }));

    const fixedItems = [];
    if (fromGroup) {
        fixedItems.push({ label: '✕ Unassign (leave unmapped)', onClick: () => moveVariant(variant, from, 'unassigned') });
        fixedItems.push({ label: '🗑 Remove (delete from cards)', onClick: () => moveVariant(variant, from, 'removed') });
    } else if (from === 'unassigned') {
        fixedItems.push({ label: '🗑 Remove (delete from cards)', onClick: () => moveVariant(variant, from, 'removed') });
    } else if (from === 'removed') {
        fixedItems.push({ label: '↩ Restore to Unassigned', onClick: () => moveVariant(variant, from, 'unassigned') });
    }
    fixedItems.push({ label: '＋ New canonical from this tag', onClick: () => moveVariant(variant, from, 'new') });

    chipMenuEl = el(`<div id="tagManagerChipMenu" class="ctm-chip-menu"></div>`);
    const filterInput = el(`<input type="text" class="ctm-chip-menu-filter cl-input" placeholder="Filter canonicals…">`);
    chipMenuEl.appendChild(filterInput);
    const list = el(`<div class="ctm-chip-menu-list"></div>`);
    chipMenuEl.appendChild(list);

    chipMenuEl.appendChild(el(`<div class="ctm-chip-menu-divider"></div>`));
    for (const item of fixedItems) {
        const row = el(`<div class="ctm-chip-menu-item ctm-chip-menu-item-fixed">${CoreAPI.escapeHtml(item.label)}</div>`);
        row.addEventListener('click', (e) => { e.stopPropagation(); closeChipMenu(); item.onClick(); });
        chipMenuEl.appendChild(row);
    }

    function renderList(q) {
        list.innerHTML = '';
        const filtered = (q ? groupItems.filter(i => i.label.toLowerCase().includes(q)) : groupItems).slice(0, 50);
        if (filtered.length === 0) list.appendChild(el(`<div class="ctm-chip-menu-empty">No matching canonicals</div>`));
        for (const item of filtered) {
            const row = el(`<div class="ctm-chip-menu-item">→ ${CoreAPI.escapeHtml(item.label)}</div>`);
            row.addEventListener('click', (e) => { e.stopPropagation(); closeChipMenu(); moveVariant(variant, from, item.g); });
            list.appendChild(row);
        }
    }

    renderList('');
    filterInput.addEventListener('input', (e) => renderList(e.target.value.trim().toLowerCase()));
    filterInput.addEventListener('keydown', (e) => e.stopPropagation());
    filterInput.addEventListener('click', (e) => e.stopPropagation());

    // Appended to document.body (not .cl-modal-content, which clips with
    // overflow:hidden and isn't position:relative) and positioned in
    // viewport coordinates, z-index above the modal's 10000.
    document.body.appendChild(chipMenuEl);
    filterInput.focus();

    const r = anchor.getBoundingClientRect();
    chipMenuEl.style.top = `${r.bottom + 4}px`;
    chipMenuEl.style.left = `${r.left}px`;
    const menuRect = chipMenuEl.getBoundingClientRect();
    if (menuRect.right > window.innerWidth) chipMenuEl.style.left = `${Math.max(4, window.innerWidth - menuRect.width - 8)}px`;
    if (menuRect.bottom > window.innerHeight) chipMenuEl.style.top = `${Math.max(4, r.top - menuRect.height - 4)}px`;
}

/**
 * Move a variant between groups / unassigned / removed / a new group, then persist.
 * @param {object} variant
 * @param {object|'unassigned'|'removed'} from  source group or bucket
 * @param {object|'unassigned'|'removed'|'new'} to  destination
 */
function moveVariant(variant, from, to) {
    syncFromDom();
    const fromGroup = typeof from === 'object' ? from : null;

    // Remove from source.
    if (fromGroup) fromGroup.variants = fromGroup.variants.filter(v => v !== variant);
    else if (from === 'removed') state.removed = state.removed.filter(v => v !== variant);
    else state.unassigned = state.unassigned.filter(v => v !== variant);

    // Add to destination.
    if (to === 'unassigned') {
        variant.declared = false;
        if (!state.unassigned.includes(variant)) state.unassigned.push(variant);
    } else if (to === 'removed') {
        variant.declared = true;
        if (!state.removed.includes(variant)) state.removed.push(variant);
    } else if (to === 'new') {
        variant.declared = true;
        state.groups.push({ id: `g${groupSeq++}`, canonical: pickCanonical([variant]), variants: [variant] });
    } else {
        variant.declared = true;
        to.variants.push(variant);
    }

    if (fromGroup && fromGroup.variants.length === 0) {
        state.groups = state.groups.filter(g => g !== fromGroup);
    }

    closeChipMenu();
    persist();
    renderBody();
}

/** Discard the user's edits and restore the shipped base dictionary. */
async function onResetTags() {
    closeChipMenu();
    const base = await loadBaseDictionary();
    if (!base || Object.keys(base.mapping).length === 0) {
        CoreAPI.showToast('Could not load the base dictionary.', 'error');
        return;
    }
    const confirmed = await CoreAPI.showConfirm({
        title: 'Reset to the shipped mapping?',
        message: 'This discards all your edits and restores the shipped default mapping. It does not change any cards.',
        icon: 'fa-solid fa-triangle-exclamation',
        iconColor: 'var(--cl-warning-bright)',
        confirmLabel: 'Reset Tags',
        cancelLabel: 'Cancel',
        danger: true,
    });
    if (!confirmed) return;

    loadState(base.mapping, base.removedTags);
    saveDictionary(base.mapping, base.removedTags);
    selectionBucket = null;
    selected.clear();
    bucketFilter = { unassigned: '', removed: '' };
    renderBody();
    CoreAPI.showToast('Dictionary reset to the shipped default.', 'success');
}

// ── modal chrome ─────────────────────────────────────────────────────────

function closeModal() {
    closeChipMenu();
    document.getElementById('tagManagerModal')?.classList.remove('visible');
}

function setupEventListeners() {
    document.getElementById('tagManagerCloseBtn')?.addEventListener('click', closeModal);
    document.getElementById('tagManagerDoneBtn')?.addEventListener('click', closeModal);
    document.getElementById('tagManagerApplyBtn')?.addEventListener('click', applyPlan);
    document.getElementById('tagManagerNewGroupBtn')?.addEventListener('click', onNewEmptyGroup);
    document.getElementById('tagManagerResetBtn')?.addEventListener('click', onResetTags);
    document.getElementById('tagManagerModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'tagManagerModal') closeModal();
        else if (!e.target.closest('.ctm-chip-menu') && !e.target.closest('.ctm-chip')) closeChipMenu();
    });
    // A fixed-position chip menu doesn't follow a scrolling anchor.
    document.getElementById('tagManagerBody')?.addEventListener('scroll', () => closeChipMenu());
}

function injectModal() {
    const modalHtml = `
    <div id="tagManagerModal" class="cl-modal">
        <div class="cl-modal-content tag-manager-modal-content" style="max-width: calc(900px * var(--modal-scale, 1));">
            <div class="cl-modal-header">
                <h3><i class="fa-solid fa-tags"></i> Tag Mapping</h3>
                <button id="tagManagerCloseBtn" class="cl-modal-close"><i class="fa-solid fa-xmark"></i></button>
            </div>

            <div class="cl-modal-body" id="tagManagerBody"></div>

            <div class="cl-modal-footer">
                <button id="tagManagerApplyBtn" class="cl-btn cl-btn-danger" title="Save the dictionary and apply it to your cards. Rewrites tags only." disabled><i class="fa-solid fa-tags"></i> Apply Tags</button>
                <button id="tagManagerNewGroupBtn" class="cl-btn cl-btn-secondary" title="Create an empty canonical tag"><i class="fa-solid fa-plus"></i> New canonical</button>
                <button id="tagManagerResetBtn" class="cl-btn cl-btn-secondary" title="Discard your edits and restore the shipped default mapping" disabled><i class="fa-solid fa-rotate-left"></i> Reset Tags</button>
                <button id="tagManagerDoneBtn" class="cl-btn cl-btn-secondary">Close</button>
            </div>
        </div>
    </div>`;

    document.body.insertAdjacentHTML('beforeend', modalHtml);
}

export default {
    init,
    openModal,
};
