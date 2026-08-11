// ========================================
// SLIM INDEX
// ========================================

const HEAVY_FIELDS = [
    'description', 'first_mes', 'personality', 'scenario',
    'mes_example', 'system_prompt', 'post_history_instructions',
    'alternate_greetings', 'character_book'
];

/**
 * Build a slim copy of a character, keeping only grid/search/filter fields.
 * Heavy text content (description, first_mes, lorebook, etc.) is stripped.
 * @param {Object} char - Full character object from API
 * @returns {Object} Slim character with _slim: true marker
 */
function slimCharacter(char) {
    const slim = {
        avatar: char.avatar,
        name: char.name,
        fav: char.fav,
        date_added: char.date_added,
        create_date: char.create_date,
        creator: char.creator,
        tags: char.tags,
        creator_notes: char.creator_notes,
        character_version: char.character_version,
        chat: char.chat,
        _meta: char._meta,
        spec: char.spec,
        spec_version: char.spec_version,
        // Pre-computed keys (added by prepareCharacterKeys)
        _lowerName: char._lowerName,
        _lowerCreator: char._lowerCreator,
        _lowerListingName: char._lowerListingName || '',
        _lowerTagline: char._lowerTagline || '',
        _tagsLower: char._tagsLower,
        _lowerNotes: char._lowerNotes || '',
        _dateAdded: char._dateAdded,
        _createDate: char._createDate,
        _tokenEstimate: char._tokenEstimate,
        _slim: true
    };

    if (char.data) {
        slim.data = {
            name: char.data.name,
            nickname: char.data.nickname,
            creator: char.data.creator,
            tags: char.data.tags,
            extensions: char.data.extensions,
            creator_notes: char.data.creator_notes,
            character_version: char.data.character_version,
            create_date: char.data.create_date,
            spec: char.data.spec,
            spec_version: char.data.spec_version,
        };
    }

    return slim;
}

/**
 * Fetch full character data and merge heavy fields onto a slim object.
 * No-ops if the character is already hydrated (_slim !== true).
 * @param {Object} char - Character object (may be slim or already hydrated)
 * @returns {Promise<Object>} The same char, now with heavy fields populated
 */
async function hydrateCharacter(char) {
    if (!char || !char._slim) return char;

    try {
        const response = await apiRequest(ENDPOINTS.CHARACTERS_GET, 'POST', { avatar_url: char.avatar });
        if (!response.ok) {
            console.warn('[hydrateCharacter] Fetch failed:', response.status);
            return char;
        }

        const full = await response.json();
        if (!full) return char;

        for (const field of HEAVY_FIELDS) {
            if (full[field] !== undefined) char[field] = full[field];
            if (full.data?.[field] !== undefined) {
                if (!char.data) char.data = {};
                char.data[field] = full.data[field];
            }
        }

        for (const field of ['nickname', 'group_only_greetings']) {
            if (full.data?.[field] !== undefined) {
                if (!char.data) char.data = {};
                char.data[field] = full.data[field];
            }
        }

        // Also recover extensions in case ST lazy loading stripped them.
        // Verified-absent caches {} so the char counts as recovered, not unknown.
        if (full.data) {
            if (!char.data) char.data = {};
            char.data.extensions = full.data.extensions || {};
            _extensionsCache.set(char.avatar, char.data.extensions);
        }

        if (full.spec) char.spec = full.spec;
        if (full.spec_version) char.spec_version = full.spec_version;

        // Refresh now the heavy text is present (a save may have changed it).
        char._tokenEstimate = computeTokenEstimate(char);
        _tokenEstimateCache.set(char.avatar, char._tokenEstimate);

        char._slim = false;
        return char;
    } catch (e) {
        console.warn('[hydrateCharacter] Error:', e);
        return char;
    }
}

let _recoveryGeneration = 0;
let _extensionsCache = new Map();
// avatar -> token estimate, so a lazy-loading re-render restores it instead of recomputing 0 (like _extensionsCache).
let _tokenEstimateCache = new Map();

// mes_example deliberately excluded, matching the original modal estimate.
const TOKEN_ESTIMATE_FIELDS = ['description', 'personality', 'scenario', 'first_mes', 'system_prompt'];

// Sums field lengths / 4 without concat, keeping the prepare loop allocation-free.
function computeTokenEstimate(src) {
    if (!src) return 0;
    let total = 0;
    for (const field of TOKEN_ESTIMATE_FIELDS) total += getCharField(src, field).length;
    return Math.round(total / 4);
}

/**
 * Recover data.extensions for characters received with ST lazy loading (shallow mode).
 * ST's toShallow() strips all extensions except fav, breaking provider links,
 * gallery IDs, and version UIDs. This fetches individual characters in parallel
 * batches and patches their extensions onto our slim objects.
 *
 * Uses a persistent cache so that subsequent processAndRender calls (e.g. after import)
 * transfer known extensions instantly and only fetch new/unknown characters.
 * A generation counter prevents concurrent recoveries from interfering.
 */
async function recoverShallowExtensions(generation) {
    const BATCH_SIZE = 50;
    const chars = allCharacters.filter(c => !_extensionsCache.has(c.avatar));
    let recovered = 0;

    if (chars.length === 0) {
        debugLog('[ShallowRecovery] All extensions already cached, skipping recovery');
        window.extensionsRecoveryInProgress = false;
        window.ProviderRegistry?.hideRecoveryBanner?.();
        window.ProviderRegistry?.rebuildAllBrowseLookups?.();
        window.ProviderRegistry?.refreshActiveBrowseBadges?.();
        runGallerySyncAudit();
        return;
    }

    debugLog(`[ShallowRecovery] Recovering extensions for ${chars.length} characters (${_extensionsCache.size} already cached)...`);
    const cachedBefore = _extensionsCache.size;
    const totalForProgress = chars.length + cachedBefore;

    try {
        for (let i = 0; i < chars.length; i += BATCH_SIZE) {
            if (generation !== _recoveryGeneration) {
                debugLog('[ShallowRecovery] Superseded by newer recovery, aborting');
                return;
            }

            const batch = chars.slice(i, i + BATCH_SIZE);
            await Promise.allSettled(
                batch.map(async (char) => {
                    try {
                        const response = await apiRequest(ENDPOINTS.CHARACTERS_GET, 'POST', { avatar_url: char.avatar });
                        if (!response.ok) return;
                        const full = await response.json();
                        if (!full) return;

                        // Piggyback the estimate on this full fetch, before the extensions guard so extension-less cards still get it.
                        const tok = computeTokenEstimate(full);
                        char._tokenEstimate = tok;
                        _tokenEstimateCache.set(char.avatar, tok);

                        if (!full.data) return;

                        // A verified card with no extensions still counts as recovered: cache {} so
                        // it isnt treated as unknown forever (and re-fetched every run).
                        if (!char.data) char.data = {};
                        char.data.extensions = full.data.extensions || {};
                        if (full.spec) char.spec = full.spec;
                        if (full.spec_version) char.spec_version = full.spec_version;
                        char._lowerListingName = (getListingNameFromExtensions(char) || '').toLowerCase();
                        char._lowerTagline = getDisplayTagline(char).toLowerCase();
                        _extensionsCache.set(char.avatar, char.data.extensions);
                        recovered++;
                    } catch { /* skip */ }
                })
            );

            const done = cachedBefore + Math.min(i + BATCH_SIZE, chars.length);
            window.ProviderRegistry?.updateRecoveryProgress?.(Math.min(done, totalForProgress), totalForProgress);

            await new Promise(r => setTimeout(r, 0));
        }
    } finally {
        if (generation === _recoveryGeneration) {
            window.extensionsRecoveryInProgress = false;
            window.ProviderRegistry?.hideRecoveryBanner?.();
        }
    }

    if (generation !== _recoveryGeneration) return;

    debugLog(`[ShallowRecovery] Recovered extensions for ${recovered} new characters (${_extensionsCache.size} total cached)`);

    window.ProviderRegistry?.rebuildAllBrowseLookups?.();
    window.ProviderRegistry?.refreshActiveBrowseBadges?.();

    // Re-render the characters grid now that extensions are available.
    // The initial render happened before recovery (shallow chars had no extensions),
    // so features like alt display names couldn't resolve listing names.
    if ((getCurrentView() || 'characters') === 'characters') {
        performSearch();
    }

    document.dispatchEvent(new CustomEvent('cl-extensions-recovered'));

    runGallerySyncAudit();
}

// Process and Render (extracted to be reusable)
function processAndRender(data) {
    _needsCharacterRefresh = false;
    const activeCharAvatar = activeChar ? activeChar.avatar : null;
    
    allCharacters = Array.isArray(data) ? data : (data.data || []);
    
    // Filter valid
    allCharacters = allCharacters.filter(c => c && c.avatar);
    
    // Detect ST lazy loading - toShallow() sets { shallow: true } and strips
    // data.extensions.* (except fav), which breaks provider links, gallery IDs, etc.
    const isSTShallow = allCharacters.length > 0 && allCharacters[0].shallow === true;
    // Persist shallow-mode so extensionsReady can distinguish lazy-off from lazy-on after recovery.
    window.stShallowMode = isSTShallow;

    // Restore previously recovered extensions from cache before slimming.
    // Without this, every processAndRender call would discard recovered extensions
    // and trigger a full re-recovery of all characters.
    if (isSTShallow && _extensionsCache.size > 0) {
        let transferred = 0;
        for (const char of allCharacters) {
            const cached = _extensionsCache.get(char.avatar);
            if (cached) {
                if (!char.data) char.data = {};
                char.data.extensions = cached;
                transferred++;
            }
        }
        if (transferred > 0) {
            debugLog(`[processAndRender] Restored ${transferred}/${allCharacters.length} cached extensions`);
        }
    }
    
    // Pre-compute sort/search keys once (avoids repeated toLowerCase, date parsing, etc.)
    prepareCharacterKeys(allCharacters);
    
    // Strip heavy text fields to keep idle memory low (~2-5 KB/char instead of ~50-100 KB).
    // Full data is fetched on demand when the detail modal opens (hydrateCharacter).
    allCharacters = allCharacters.map(c => slimCharacter(c));
    
    // Re-link activeChar to the new object in allCharacters if modal is open
    if (activeCharAvatar) {
        const updatedChar = allCharacters.find(c => c.avatar === activeCharAvatar);
        if (updatedChar) {
            activeChar = updatedChar;
        }
    }
    
    // If ST lazy loading stripped extensions, recover them in the background.
    // Provider links, gallery IDs, version UIDs all live in data.extensions.
    // The generation counter ensures only the latest recovery runs to completion.
    if (isSTShallow) {
        _recoveryGeneration++;
        window.extensionsRecoveryInProgress = true;
        recoverShallowExtensions(_recoveryGeneration);
    }
    
    // Populate Tags set for the filter dropdown
    const allTags = new Map();
    allCharacters.forEach(c => {
         const tags = getTags(c);
         if (Array.isArray(tags)) {
             tags.forEach(t => allTags.set(t, (allTags.get(t) || 0) + 1));
         }
    });

    populateTagFilter(allTags);
    
    currentCharacters = [...allCharacters];

    // Build lookup for online browse "in library" matching.
    // Under ST shallow, byProviderId needs extensions that are not recovered yet, so the
    // recovery completion does the authoritative rebuild; here just invalidate the shared
    // base (so a stale one is not reused) and skip the doomed full rebuild.
    if (isSTShallow) {
        window.ProviderRegistry?.invalidateBrowseLookupBase?.();
    } else {
        window.ProviderRegistry?.rebuildAllBrowseLookups?.();
    }
    
    // Apply current sort/filter settings and render the grid.
    // If the characters view isn't active (e.g. we're on the online view after a download),
    // the grid is hidden and rendering now would use stale dimensions. In that case just
    // sort/update currentCharacters without rendering - switchView('characters') will call
    // performSearch() again with correct dimensions when the user navigates back.
    if ((getCurrentView() || 'characters') === 'characters') {
        performSearch();
    } else {
        // Still sort currentCharacters so the data is ready when the user switches views,
        // but don't render to a hidden grid (avoids wrong dimensions / stale virtual scroll).
        currentCharacters.sort(makeCharSortComparator());
    }
    
    document.getElementById('loading').style.display = 'none';

    // Load signal for modules that defer work until characters exist (fires
    // even in the shallow case; extensions recovery has its own event)
    document.dispatchEvent(new CustomEvent('cl-characters-loaded'));

    // ST lazy loading: skip gallery sync here - gallery_ids are stripped.
    // recoverShallowExtensions() re-runs sync+audit after patching extensions.
    if (isSTShallow) return;

    // Audit only checks for missing gallery_ids; folder mapping is computed live by the Proxy in index.js.
}

// Tag filter states: Map<tagName, 'include' | 'exclude'>
// undefined/not in map = neutral (unchecked)
let activeTagFilters = new Map();

// Tag filter logic modes: 'any' (OR) or 'all' (AND)
// Initialized from settings in initTagLogicToggles() after settings are loaded
let tagIncludeMode = 'any';
let tagExcludeMode = 'all';

function initTagLogicToggles() {
    const includeBtn = document.getElementById('includeLogicBtn');
    const excludeBtn = document.getElementById('excludeLogicBtn');
    if (!includeBtn || !excludeBtn) return;

    tagIncludeMode = getSetting('tagIncludeMode') || 'any';
    tagExcludeMode = getSetting('tagExcludeMode') || 'all';

    applyTagLogicButtonState(includeBtn, tagIncludeMode, 'Match');
    applyTagLogicButtonState(excludeBtn, tagExcludeMode, 'Hide');

    includeBtn.onclick = () => {
        tagIncludeMode = tagIncludeMode === 'any' ? 'all' : 'any';
        setSetting('tagIncludeMode', tagIncludeMode);
        applyTagLogicButtonState(includeBtn, tagIncludeMode, 'Match');
        updateTagFilterButtonIndicator();
        document.getElementById('searchInput').dispatchEvent(new Event('input'));
    };

    excludeBtn.onclick = () => {
        tagExcludeMode = tagExcludeMode === 'any' ? 'all' : 'any';
        setSetting('tagExcludeMode', tagExcludeMode);
        applyTagLogicButtonState(excludeBtn, tagExcludeMode, 'Hide');
        updateTagFilterButtonIndicator();
        document.getElementById('searchInput').dispatchEvent(new Event('input'));
    };
}

function applyTagLogicButtonState(btn, mode, label) {
    btn.dataset.mode = mode;
    const modeLabel = mode === 'any' ? 'Any' : 'All';
    btn.querySelector('span').textContent = `${label} ${modeLabel}`;
    btn.title = mode === 'any'
        ? `${label} Any (OR): click to switch to All (AND)`
        : `${label} All (AND): click to switch to Any (OR)`;
}

function updateTagLogicRowVisibility() {
    const row = document.getElementById('tagLogicRow');
    if (!row) return;
    row.classList.toggle('hidden', activeTagFilters.size === 0);
}

function populateTagFilter(tagMap) {
    const sortedTags = Array.from(tagMap.keys()).sort((a, b) => {
        const aActive = activeTagFilters.has(a) ? 0 : 1;
        const bActive = activeTagFilters.has(b) ? 0 : 1;
        if (aActive !== bActive) return aActive - bActive;
        return a.localeCompare(b);
    });
    const content = document.getElementById('tagFilterContent');
    const searchInput = document.getElementById('tagSearchInput');

    if (content) {
        const buildRow = (tag) => {
            const item = document.createElement('div');
            item.className = 'tag-filter-item';
            item.dataset.tag = tag.toLowerCase();

            const currentState = activeTagFilters.get(tag); // 'include', 'exclude', or undefined

            // Create tri-state button
            const stateBtn = document.createElement('button');
            stateBtn.className = 'tag-state-btn';
            stateBtn.dataset.state = currentState || 'neutral';
            updateTagStateButton(stateBtn, currentState);

            const label = document.createElement('span');
            label.className = 'tag-label';
            label.textContent = tag;

            const count = document.createElement('span');
            count.className = 'tag-count';
            count.textContent = tagMap.get(tag) || '';

            // Tri-state cycling: neutral -> include -> exclude -> neutral
            const cycleState = (e) => {
                e.stopPropagation();
                const current = stateBtn.dataset.state;
                let newState;
                if (current === 'neutral') {
                    newState = 'include';
                    activeTagFilters.set(tag, 'include');
                } else if (current === 'include') {
                    newState = 'exclude';
                    activeTagFilters.set(tag, 'exclude');
                } else {
                    newState = 'neutral';
                    activeTagFilters.delete(tag);
                }
                stateBtn.dataset.state = newState;
                updateTagStateButton(stateBtn, newState === 'neutral' ? undefined : newState);

                // Update tag button indicator and logic row visibility
                updateTagFilterButtonIndicator();
                updateTagLogicRowVisibility();

                // Trigger Search/Filter update
                document.getElementById('searchInput').dispatchEvent(new Event('input'));
            };

            stateBtn.onclick = cycleState;
            label.onclick = cycleState;

            item.appendChild(stateBtn);
            item.appendChild(label);
            item.appendChild(count);
            return item;
        };

        // Windowed render: booru-tagged libraries reach 5 digits of unique tags, and
        // styling that many rows makes the popup toggle take seconds. Only a chunk is
        // in the DOM; scrolling near the bottom appends the next one.
        const CHUNK = 300;
        let matchedTags = sortedTags;
        let renderedCount = 0;

        const renderChunk = () => {
            const end = Math.min(renderedCount + CHUNK, matchedTags.length);
            const frag = document.createDocumentFragment();
            for (let i = renderedCount; i < end; i++) frag.appendChild(buildRow(matchedTags[i]));
            renderedCount = end;
            content.appendChild(frag);
        };

        const renderList = (filterText = '') => {
            const lowerFilter = filterText.toLowerCase();
            matchedTags = !lowerFilter ? sortedTags : sortedTags.filter(t => t.toLowerCase().includes(lowerFilter));
            renderedCount = 0;
            content.innerHTML = '';
            renderChunk();
        };

        renderList(searchInput?.value || '');

        content.onscroll = () => {
            if (renderedCount >= matchedTags.length) return;
            if (content.scrollTop + content.clientHeight >= content.scrollHeight - 200) renderChunk();
        };

        // Search Listener
        if (searchInput) {
            searchInput.oninput = (e) => {
                renderList(e.target.value);
            };
            // Prevent popup closing when clicking search
            searchInput.onclick = (e) => e.stopPropagation();
        }

        // Update indicator on initial load
        updateTagFilterButtonIndicator();
        initTagLogicToggles();
        updateTagLogicRowVisibility();
    }
}

function updateTagStateButton(btn, state) {
    if (state === 'include') {
        btn.innerHTML = '<i class="fa-solid fa-check"></i>';
        btn.className = 'tag-state-btn state-include';
        btn.title = 'Included - click to exclude';
    } else if (state === 'exclude') {
        btn.innerHTML = '<i class="fa-solid fa-minus"></i>';
        btn.className = 'tag-state-btn state-exclude';
        btn.title = 'Excluded - click to clear';
    } else {
        btn.innerHTML = '';
        btn.className = 'tag-state-btn state-neutral';
        btn.title = 'Neutral - click to include';
    }
}

function updateTagFilterButtonIndicator() {
    const tagLabel = document.getElementById('tagFilterLabel');
    if (!tagLabel) return;
    
    const includeCount = Array.from(activeTagFilters.values()).filter(v => v === 'include').length;
    const excludeCount = Array.from(activeTagFilters.values()).filter(v => v === 'exclude').length;
    
    // Update button text/indicator
    let indicator = '';
    if (includeCount > 0 || excludeCount > 0) {
        const parts = [];
        if (includeCount > 0) {
            parts.push(tagIncludeMode === 'all' ? `+${includeCount} all` : `+${includeCount}`);
        }
        if (excludeCount > 0) {
            parts.push(tagExcludeMode === 'all' ? `-${excludeCount} all` : `-${excludeCount}`);
        }
        indicator = ` (${parts.join('/')})`;
    }
    
    tagLabel.textContent = `Tags${indicator}`;
}

/**
 * Clear all active tag filters
 */
function clearAllTagFilters() {
    activeTagFilters.clear();
    
    document.querySelectorAll('.tag-filter-item .tag-state-btn').forEach(btn => {
        btn.dataset.state = 'neutral';
        updateTagStateButton(btn, undefined);
    });
    
    updateTagFilterButtonIndicator();
    updateTagLogicRowVisibility();
    
    // Trigger search update
    document.getElementById('searchInput').dispatchEvent(new Event('input'));
}

function getTags(char) {
    if (Array.isArray(char.tags)) return char.tags;
    if (char.data && Array.isArray(char.data.tags)) return char.data.tags;
    return [];
}

