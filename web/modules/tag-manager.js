/**
 * tag-manager.js -- Phase 5 tag consolidation, read-only preview (step 6).
 *
 * Shows what a merge against the vendored dictionary (web/vendor/tag-tools/)
 * would do to the archive's real tags: which observed tag spellings would be
 * renamed onto a canonical, which are unassigned, and which are flagged for
 * removal -- plus the same summary counts docs/PHASE_5_TAGS_PLAN.md §1
 * measured (78 renames, 32 removals, 81 cards, 520 -> 416).
 *
 * `buildBuckets`/`buildApplyPayload` (vendored, unmodified) are the ONLY
 * decision point -- this module renders their output, it does not re-decide
 * anything. No edit affordance and no apply button yet: that is step 7, once
 * this preview has been checked against the live archive.
 */
import * as CoreAPI from './core-api.js';
import { getCardTags, buildBuckets, buildApplyPayload } from '../vendor/tag-tools/tag-analysis.js';

const debugLog = (...args) => {
    if (CoreAPI.getSetting?.('debugMode')) {
        console.log(...args);
    }
};

let isInitialized = false;
let dictionaryPromise = null;

export function init() {
    if (isInitialized) {
        console.warn('[TagManager] Already initialized');
        return;
    }

    injectModal();
    setupEventListeners();

    window.registerOverlay?.({ id: 'tagManagerModal', tier: 7, close: () => closeModal(), visible: (el) => el.classList.contains('visible') });

    isInitialized = true;
    debugLog('[TagManager] Module initialized');
}

export async function openModal() {
    if (!isInitialized) {
        console.error('[TagManager] Module not initialized');
        return;
    }

    document.getElementById('tagManagerModal')?.classList.add('visible');
    clearBuckets();
    setStatus('Loading the tag dictionary and scanning the archive…');

    try {
        const [{ mapping, removedTags }, characters] = await Promise.all([
            loadDictionary(),
            Promise.resolve(CoreAPI.getAllCharacters()),
        ]);

        const buckets = buildBuckets(characters, mapping, removedTags);
        const plan = buildApplyPayload(characters, mapping, removedTags);

        renderSummary(computeStats(characters, plan));
        renderGroups(buckets.groups);
        renderFlat('tagManagerUnassigned', buckets.unassigned, 'tm-tag-unassigned');
        renderFlat('tagManagerRemoved', buckets.removed, 'tm-tag-removed');
        setStatus(null);
    } catch (err) {
        console.error('[TagManager] Failed to build tag buckets:', err);
        setStatus('Could not load the tag dictionary or scan the archive. See the console for details.');
    }
}

// ── data ─────────────────────────────────────────────────────────────────

function loadDictionary() {
    if (!dictionaryPromise) {
        dictionaryPromise = fetch(new URL('../vendor/tag-tools/tag-dictionary.json', import.meta.url))
            .then((r) => r.json())
            .then(flattenDictionary);
    }
    return dictionaryPromise;
}

// { category: { canonical: [alias…] } } -> { canonical: [alias…] }, exactly
// like the upstream extension's own loadBaseDictionary().
function flattenDictionary(raw) {
    const mapping = {};
    for (const canonicals of Object.values(raw.mapping ?? {})) {
        for (const [canonical, aliases] of Object.entries(canonicals)) {
            mapping[canonical] = Array.isArray(aliases) ? aliases : [];
        }
    }
    return { mapping, removedTags: Array.isArray(raw.removedTags) ? raw.removedTags : [] };
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

function renderSummary(stats) {
    const el = document.getElementById('tagManagerSummary');
    if (!el) return;
    el.innerHTML = `
        <div class="tm-stat"><span class="tm-stat-num">${stats.renames}</span><span class="tm-stat-label">renames</span></div>
        <div class="tm-stat"><span class="tm-stat-num">${stats.removals}</span><span class="tm-stat-label">removals</span></div>
        <div class="tm-stat"><span class="tm-stat-num">${stats.affectedCards}</span><span class="tm-stat-label">cards affected</span></div>
        <div class="tm-stat"><span class="tm-stat-num">${stats.vocabBefore} → ${stats.vocabAfter}</span><span class="tm-stat-label">vocabulary</span></div>
    `;
}

// Only groups/variants actually observed on a card are shown -- the
// dictionary's hundreds of declared-but-unused aliases would be noise in a
// preview of "what would change on my archive".
function renderGroups(groups) {
    const container = document.getElementById('tagManagerGroups');
    if (!container) return;

    const observed = groups
        .map((g) => ({ canonical: g.canonical, variants: g.variants.filter((v) => v.count > 0) }))
        .filter((g) => g.variants.length > 0)
        .sort((a, b) => a.canonical.localeCompare(b.canonical));

    if (observed.length === 0) {
        container.innerHTML = '<div class="tm-empty">No observed tags match a dictionary canonical.</div>';
        return;
    }

    container.innerHTML = observed
        .map(
            (g) => `
        <div class="tm-group">
            <div class="tm-group-label">${CoreAPI.escapeHtml(g.canonical)}</div>
            <div class="tm-group-pills">
                ${g.variants.map((v) => tagChip(v, v.tag === g.canonical ? 'tm-tag-canonical' : 'tm-tag-variant')).join('')}
            </div>
        </div>`,
        )
        .join('');
}

function renderFlat(containerId, list, cssClass) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const observed = list.filter((v) => v.count > 0);
    container.innerHTML = observed.length ? observed.map((v) => tagChip(v, cssClass)).join('') : '<div class="tm-empty">None.</div>';
}

function tagChip(v, cssClass) {
    const cards = v.count === 1 ? '1 card' : `${v.count} cards`;
    return `<span class="cl-tag ${cssClass}" title="${cards}">${CoreAPI.escapeHtml(v.tag)} <span class="tm-count">(${v.count})</span></span>`;
}

function clearBuckets() {
    document.getElementById('tagManagerSummary').innerHTML = '';
    document.getElementById('tagManagerGroups').innerHTML = '';
    document.getElementById('tagManagerUnassigned').innerHTML = '';
    document.getElementById('tagManagerRemoved').innerHTML = '';
}

function setStatus(message) {
    const el = document.getElementById('tagManagerStatus');
    if (!el) return;
    if (message) {
        el.textContent = message;
        el.classList.remove('hidden');
    } else {
        el.textContent = '';
        el.classList.add('hidden');
    }
}

// ── modal chrome ─────────────────────────────────────────────────────────

function closeModal() {
    document.getElementById('tagManagerModal')?.classList.remove('visible');
}

function setupEventListeners() {
    document.getElementById('tagManagerCloseBtn')?.addEventListener('click', closeModal);
    document.getElementById('tagManagerDoneBtn')?.addEventListener('click', closeModal);
    document.getElementById('tagManagerModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'tagManagerModal') {
            closeModal();
        }
    });
}

function injectModal() {
    const modalHtml = `
    <div id="tagManagerModal" class="cl-modal">
        <div class="cl-modal-content" style="max-width: calc(720px * var(--modal-scale, 1));">
            <div class="cl-modal-header">
                <h3><i class="fa-solid fa-tags"></i> Tag Consolidation</h3>
                <button id="tagManagerCloseBtn" class="cl-modal-close"><i class="fa-solid fa-xmark"></i></button>
            </div>

            <div class="cl-modal-body">
                <div id="tagManagerStatus" class="tm-status hidden"></div>
                <div id="tagManagerSummary" class="tm-summary"></div>

                <div class="tm-section">
                    <div class="tm-section-title"><i class="fa-solid fa-object-group"></i> Renames, by canonical</div>
                    <div id="tagManagerGroups" class="tm-groups"></div>
                </div>

                <div class="tm-section">
                    <div class="tm-section-title"><i class="fa-solid fa-circle-question"></i> Unassigned</div>
                    <div id="tagManagerUnassigned" class="tm-flat"></div>
                </div>

                <div class="tm-section">
                    <div class="tm-section-title"><i class="fa-solid fa-trash"></i> Removed</div>
                    <div id="tagManagerRemoved" class="tm-flat"></div>
                </div>

                <p class="tm-hint"><i class="fa-solid fa-lightbulb"></i> Read-only preview. Nothing on disk has changed.</p>
            </div>

            <div class="cl-modal-footer">
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
