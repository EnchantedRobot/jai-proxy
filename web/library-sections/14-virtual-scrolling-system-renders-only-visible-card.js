// ==============================================
// VIRTUAL SCROLLING SYSTEM
// Renders only visible cards + buffer for performance
// Scrollbar represents full content from the start
// ==============================================

// Virtual scroll state
let currentCharsList = [];
let activeCards = new Map(); // Track rendered cards by index
let lastRenderedStartIndex = -1;
let lastRenderedEndIndex = -1;
let isScrolling = false;
let scrollTimeout = null;
let cachedCardHeight = 0;
let cachedCardWidth = 0;
let cachedGridWidth = 0;       // cached grid.clientWidth - invalidated on resize
let cachedClientHeight = 0;    // cached scrollContainer.clientHeight - invalidated on resize
let cachedGridCols = 0;        // actual CSS column count - invalidated on resize
let characterGridDelegatesInitialized = false;
let currentCharByAvatar = new Map();

// Card dimensions (will be measured from actual cards)
const CARD_MIN_WIDTH = 200; // Matches CSS minmax(200px, 1fr)
const CARD_ASPECT_RATIO = 2 / 3; // width/height for portrait cards
const GRID_GAP_FALLBACK = 20;
let cachedGridGap = 0; // Read from CSS computed styles - invalidated on resize
let _gridMetricsCorrection = false; // recursion guard for fallback self-correction
const _seenAvatarUrls = new Set(); // populatd as avatars load so rerenders can skip the fade

function getGridGap() {
    if (cachedGridGap > 0) return cachedGridGap;
    const grid = document.getElementById('characterGrid');
    if (grid) cachedGridGap = parseInt(getComputedStyle(grid).rowGap, 10) || GRID_GAP_FALLBACK;
    return cachedGridGap || GRID_GAP_FALLBACK;
}

/**
 * Main render function - sets up virtual scrolling
 */
function renderGrid(chars) {
    const grid = document.getElementById('characterGrid');
    const scrollContainer = document.querySelector('.gallery-content');
    
    // Store chars reference
    currentCharsList = chars;
    currentCharByAvatar = new Map();
    for (let i = 0; i < chars.length; i++) {
        const char = chars[i];
        if (char?.avatar) currentCharByAvatar.set(char.avatar, char);
    }
    
    // Clear existing content and state
    grid.replaceChildren();
    activeCards.clear();
    lastRenderedStartIndex = -1;
    lastRenderedEndIndex = -1;
    cachedCardHeight = 0;
    cachedGridWidth = 0;
    cachedClientHeight = 0;
    cachedGridCols = 0;
    
    // Remove any existing sentinel (not needed with virtual scroll)
    const existingSentinel = document.getElementById('lazyLoadSentinel');
    if (existingSentinel) existingSentinel.remove();
    
    if (chars.length === 0) {
        const libraryEmpty = !Array.isArray(allCharacters) || allCharacters.length === 0;
        if (libraryEmpty) {
            renderEmptyState(grid, {
                icon: 'fa-solid fa-user-plus',
                title: 'Your library is empty',
                hint: 'Import a character card to get started. Drop a PNG anywhere on this page, paste a URL, or use the Import button.',
                actionLabel: 'Import a character',
                actionIcon: 'fa-solid fa-plus',
                onAction: () => document.getElementById('importBtn')?.click(),
                desktopText: 'No characters found',
            });
        } else {
            renderEmptyState(grid, {
                icon: 'fa-solid fa-ghost',
                title: 'No characters match',
                hint: 'Try clearing your filters or adjusting the search. Tag and creator filters may be too narrow.',
                actionLabel: 'Clear filters',
                actionIcon: 'fa-solid fa-xmark',
                onAction: () => {
                    const searchInput = document.getElementById('searchInput');
                    if (searchInput) { searchInput.value = ''; searchInput.dispatchEvent(new Event('input', { bubbles: true })); }
                    if (typeof clearAllAdvFilters === 'function') clearAllAdvFilters();
                },
                desktopText: 'No characters found',
            });
        }
        grid.style.minHeight = '';
        grid.style.paddingTop = '';
        return;
    }
    
    // Calculate and set total grid height
    updateGridHeight(grid);
    
    // Setup scroll listener
    setupVirtualScrollListener(grid, scrollContainer);
    
    // Initial render
    updateVisibleCards(grid, scrollContainer, true);
}

/**
 * Calculate and set the total grid height based on all items
 */
function updateGridHeight(grid) {
    const gridWidth = grid.clientWidth || 800;
    const { cols, cardHeight, gap } = getGridMetrics(gridWidth);
    
    const totalRows = Math.ceil(currentCharsList.length / cols);
    const totalHeight = (totalRows * cardHeight) + ((totalRows - 1) * gap);
    
    grid.style.minHeight = `${totalHeight}px`;
}

/**
 * Get grid layout metrics - reads actual CSS column count to stay in sync with auto-fill.
 */
function getGridMetrics(gridWidth) {
    const gap = getGridGap();

    if (cachedCardHeight > 0 && cachedGridCols > 0) {
        return { cols: cachedGridCols, cardHeight: cachedCardHeight, gap };
    }

    // Read actual column count from CSS resolved grid tracks
    const grid = document.getElementById('characterGrid');
    if (grid) {
        const tracks = getComputedStyle(grid).gridTemplateColumns;
        if (tracks && tracks !== 'none') {
            cachedGridCols = tracks.split(' ').length;
        }
    }

    // Measure card height from actual card if available
    const firstCard = document.querySelector('.char-card');
    if (firstCard) {
        cachedCardHeight = firstCard.offsetHeight;
        cachedCardWidth = firstCard.offsetWidth;
    }

    // Fallback column calculation only when no rendered grid is available
    if (!cachedGridCols) {
        const cardWidth = cachedCardWidth || CARD_MIN_WIDTH;
        cachedGridCols = Math.max(1, Math.floor((gridWidth + gap) / (cardWidth + gap)));
    }

    const cardHeight = cachedCardHeight || Math.round(CARD_MIN_WIDTH / CARD_ASPECT_RATIO);
    return { cols: cachedGridCols, cardHeight, gap };
}

/**
 * Update which cards are visible and render them
 */
function updateVisibleCards(grid, scrollContainer, force = false) {
    if (currentCharsList.length === 0) return;
    
    const scrollTop = scrollContainer.scrollTop;
    // Use cached dimensions to avoid forced reflow on every scroll frame.
    // These are invalidated on resize and on force (scroll-end) updates.
    if (force || cachedClientHeight === 0) {
        cachedClientHeight = scrollContainer.clientHeight;
        cachedGridWidth = grid.clientWidth || 800;
        cachedGridCols = 0; // Re-read column count from CSS
    }
    const clientHeight = cachedClientHeight;
    const gridWidth = cachedGridWidth;
    
    const { cols, cardHeight, gap } = getGridMetrics(gridWidth);
    
    const _isMobileMetrics = isMobileMode();
    const RENDER_BUFFER_PX = clientHeight * 2.5;
    const PRELOAD_BUFFER_PX = clientHeight * 6;
    
    // Calculate visible row range
    const startRow = Math.floor(Math.max(0, scrollTop - RENDER_BUFFER_PX) / (cardHeight + gap));
    const endRow = Math.ceil((scrollTop + clientHeight + RENDER_BUFFER_PX) / (cardHeight + gap));

    const startIndex = startRow * cols;
    const endIndex = Math.min(currentCharsList.length, (endRow + 1) * cols);

    const rangeChanged = force || startIndex !== lastRenderedStartIndex || endIndex !== lastRenderedEndIndex;
    if (rangeChanged) {
        lastRenderedStartIndex = startIndex;
        lastRenderedEndIndex = endIndex;
    }
    
    let cardsChanged = false;
    if (rangeChanged) {
    const paddingTop = startRow * (cardHeight + gap);
    grid.style.paddingTop = `${paddingTop}px`;

    // Remove cards outside the visible range
    for (const [index, card] of activeCards) {
        if (index < startIndex || index >= endIndex) {
            card.remove();
            activeCards.delete(index);
            cardsChanged = true;
        }
    }
    
    // Create missing cards and track which indices are new (already ascending order).
    // Mobile: batch via innerHTML so 50+ cards in one fast-flick rAF fit in the frame budget (~10-20ms vs ~50-150ms with per-card createElement). Desktop keeps the existing per-card path.
    const newCardIndices = [];
    if (_isMobileMetrics) {
        const toCreate = [];
        for (let i = startIndex; i < endIndex; i++) {
            if (!activeCards.has(i)) {
                const char = currentCharsList[i];
                if (char) {
                    toCreate.push({ char, index: i });
                    newCardIndices.push(i);
                    cardsChanged = true;
                }
            }
        }
        if (toCreate.length > 0) {
            const cards = createCardsBatchHTML(toCreate);
            for (let j = 0; j < toCreate.length; j++) {
                activeCards.set(toCreate[j].index, cards[j]);
            }
        }
    } else {
        for (let i = startIndex; i < endIndex; i++) {
            if (!activeCards.has(i)) {
                const char = currentCharsList[i];
                if (char) {
                    const card = createCharacterCard(char);
                    card.dataset.virtualIndex = i;
                    activeCards.set(i, card);
                    newCardIndices.push(i);
                    cardsChanged = true;
                }
            }
        }
    }
    
    // Surgical DOM update: only touch changed cards instead of clearing + rebuilding.
    // Normal scrolling removes cards from one edge and adds at the other, so a simple
    // append (down) or prepend (up) handles ~99% of updates with minimal DOM work.
    // Full ordered rebuild via DocumentFragment is the rare fallback for jump/resize.
    if (cardsChanged && newCardIndices.length > 0) {
        if (grid.children.length === 0) {
            // Grid is empty (first render or complete range change) - batch append all
            const fragment = document.createDocumentFragment();
            for (let i = startIndex; i < endIndex; i++) {
                const card = activeCards.get(i);
                if (card) fragment.appendChild(card);
            }
            grid.appendChild(fragment);

            // Self-correct fallback metrics: after first cards are in the DOM, measure
            // actual card dimensions and re-render if the fallback was significantly off.
            // This fires on every fresh renderGrid() call (view switch, import, search)
            // and replaces the one-shot MutationObserver approach.
            const measuredCard = grid.querySelector('.char-card');
            if (measuredCard && !_gridMetricsCorrection) {
                const actualHeight = measuredCard.offsetHeight;
                if (actualHeight > 0 && Math.abs(actualHeight - cardHeight) > 10) {
                    _gridMetricsCorrection = true;
                    cachedCardHeight = actualHeight;
                    cachedCardWidth = measuredCard.offsetWidth;
                    cachedGridCols = 0;
                    const tracks = getComputedStyle(grid).gridTemplateColumns;
                    if (tracks && tracks !== 'none') {
                        cachedGridCols = tracks.split(' ').length;
                    }
                    updateGridHeight(grid);
                    _gridMetricsCorrection = false;
                    return updateVisibleCards(grid, scrollContainer, true);
                }
            }
        } else {
            // Determine optimal insertion point based on where new cards fall
            // relative to what's already in the DOM
            const firstDomIndex = parseInt(grid.firstElementChild.dataset.virtualIndex);
            const lastDomIndex = parseInt(grid.lastElementChild.dataset.virtualIndex);
            const allAfter = newCardIndices[0] > lastDomIndex;
            const allBefore = newCardIndices[newCardIndices.length - 1] < firstDomIndex;
            
            if (allAfter) {
                // Scrolling down - append new cards at end
                const fragment = document.createDocumentFragment();
                for (const idx of newCardIndices) {
                    fragment.appendChild(activeCards.get(idx));
                }
                grid.appendChild(fragment);
            } else if (allBefore) {
                // Scrolling up - prepend new cards at start
                const fragment = document.createDocumentFragment();
                for (const idx of newCardIndices) {
                    fragment.appendChild(activeCards.get(idx));
                }
                grid.insertBefore(fragment, grid.firstChild);
            } else {
                // Jump/resize: new cards span both sides - full ordered rebuild
                const fragment = document.createDocumentFragment();
                for (let i = startIndex; i < endIndex; i++) {
                    const card = activeCards.get(i);
                    if (card) fragment.appendChild(card);
                }
                grid.replaceChildren(fragment);
            }
        }
    }

    // Preload only fires when the range changed, so scroll-frame work stays bounded.
    const visibleStartRow = Math.floor(scrollTop / (cardHeight + gap));
    const visibleEndRow = Math.ceil((scrollTop + clientHeight) / (cardHeight + gap));
    const aboveStartRow = Math.floor(Math.max(0, scrollTop - PRELOAD_BUFFER_PX) / (cardHeight + gap));
    const belowEndRow = Math.ceil((scrollTop + clientHeight + PRELOAD_BUFFER_PX) / (cardHeight + gap));
    const visibleStartIndex = visibleStartRow * cols;
    const visibleEndIndex = visibleEndRow * cols;
    const aboveStartIndex = aboveStartRow * cols;
    const preloadBelowEndIndex = Math.min(currentCharsList.length, belowEndRow * cols);
    // Below-visible first (typical scroll direction), then above; interleave so the cap covers both sides.
    const indices = [];
    const below = [];
    const above = [];
    for (let i = visibleEndIndex; i < preloadBelowEndIndex; i++) below.push(i);
    for (let i = visibleStartIndex - 1; i >= aboveStartIndex; i--) above.push(i);
    const maxLen = Math.max(below.length, above.length);
    for (let i = 0; i < maxLen; i++) {
        if (i < below.length) indices.push(below[i]);
        if (i < above.length) indices.push(above[i]);
    }
    preloadImages(indices);
    } // end rangeChanged guard

}

// Pre-decode via Image().decode() so the browser's decoded-image cache holds
// the bitmap when the real <img> lands in DOM. URL must match the shape the
// card path picks (gated on the same setting) so the cache key lines up.
const inFlightPreloads = new Set();
function preloadImages(indices) {
    const isMobile = isMobileMode();
    const cap = isMobile ? 10 : 12;
    if (inFlightPreloads.size >= cap) return;
    // Match the card path's URL choice exactly so the browser cache hits. Single source of truth for the
    // mode-aware thumb decision; isMobile above is still needed for the concurrency cap.
    const useThumbs = gridUsesThumbnails();
    for (const i of indices) {
        if (inFlightPreloads.size >= cap) break;
        if (inFlightPreloads.has(i)) continue;
        const char = currentCharsList[i];
        if (!char || !char.avatar) continue;
        inFlightPreloads.add(i);
        const img = new Image();
        img.src = useThumbs ? getCharacterAvatarThumbUrl(char.avatar) : getCharacterAvatarUrl(char.avatar);
        img.decode()
            .catch(() => {})
            .finally(() => inFlightPreloads.delete(i));
    }
}

/**
 * Setup scroll listener for virtual scrolling
 */
function setupVirtualScrollListener(grid, scrollContainer) {
    // Remove previous scroll listener if exists
    if (currentScrollHandler) {
        scrollContainer.removeEventListener('scroll', currentScrollHandler);
    }
    
    // Cancel any pending stale scroll timeout from previous render
    // (e.g. from a hidden-grid render during ChubAI download)
    clearTimeout(scrollTimeout);
    scrollTimeout = null;
    
    // Track when the last scroll event occurred for the debounce end-check
    let lastScrollEventTime = 0;
    const SCROLL_END_DELAY = 100;

    currentScrollHandler = () => {
        // .gallery-content also scrolls the chats/online views; dont drive the hidden character grid from their scroll events
        if (currentView !== 'characters') return;
        if (!isScrolling) {
            isScrolling = true;
            window.requestAnimationFrame(() => {
                updateVisibleCards(grid, scrollContainer, false);
                isScrolling = false;
            });
        }
        
        // Debounce for scroll end - uses a single persistent timeout that
        // re-checks elapsed time instead of clear+reset on every event.
        // Avoids 300+ clearTimeout/setTimeout pairs during fast scrolling.
        lastScrollEventTime = performance.now();
        if (!scrollTimeout) {
            scrollTimeout = setTimeout(function checkScrollEnd() {
                // view switched mid-scroll: drop the pending force update instead of measuring a display:none grid
                if (currentView !== 'characters') { scrollTimeout = null; return; }
                if (performance.now() - lastScrollEventTime >= SCROLL_END_DELAY) {
                    scrollTimeout = null;
                    updateVisibleCards(grid, scrollContainer, true);
                } else {
                    // Scroll still active - re-check after remaining time
                    scrollTimeout = setTimeout(checkScrollEnd,
                        SCROLL_END_DELAY - (performance.now() - lastScrollEventTime));
                }
            }, SCROLL_END_DELAY);
        }
    };
    
    scrollContainer.addEventListener('scroll', currentScrollHandler, { passive: true });
}

function setupCharacterGridDelegates() {
    if (characterGridDelegatesInitialized) return;

    const grid = document.getElementById('characterGrid');
    if (!grid) return;

    grid.addEventListener('click', (e) => {
        const card = e.target.closest('.char-card');
        if (!card || !grid.contains(card)) return;

        const avatar = card.dataset.avatar;
        const char = currentCharByAvatar.get(avatar);
        if (!char) return;

        // Delegate to multi-select module if active
        if (window.handleCardClickForMultiSelect && window.handleCardClickForMultiSelect(char, card)) {
            return; // Multi-select handled it
        }
        openModal(char);
    });

    // Preload the full avatar on mousedown so the modal-open path finds it cached. Only useful when the grid
    // shows thumbs (full PNG not loaded yet); with thumbs off the card already holds the full PNG, so skip.
    grid.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        if (document.body.classList.contains('multi-select-mode')) return;
        const card = e.target.closest('.char-card');
        if (!card || !grid.contains(card)) return;
        const avatar = card.dataset.avatar;
        if (avatar && gridUsesThumbnails()) new Image().src = getCharacterAvatarUrl(avatar);
    });

    grid.addEventListener('load', (e) => {
        if (e.target.classList.contains('card-image')) {
            e.target.closest('.char-card')?.classList.add('loaded');
        }
    }, true);

    grid.addEventListener('error', (e) => {
        if (e.target.classList.contains('card-image') && !e.target.dataset.fallback) {
            e.target.dataset.fallback = '1';
            e.target.src = '/img/No-Image-Placeholder.svg';
        }
    }, true);

    characterGridDelegatesInitialized = true;
}

// Update grid height on window resize (throttled to avoid jank during drag-resize)
let resizeRAF = null;
window.addEventListener('resize', () => {
    // Soft keyboard up on mobile fires this with the shrunk layout viewport on Android; reflowing the grid then visibly shifts cards under the search-overlay scrim.
    if (document.documentElement.classList.contains('cl-keyboard-open')) return;
    if (resizeRAF) return; // Already scheduled
    resizeRAF = requestAnimationFrame(() => {
        resizeRAF = null;
        cachedCardHeight = 0;
        cachedCardWidth = 0;
        cachedGridWidth = 0;
        cachedClientHeight = 0;
        cachedGridGap = 0;
        cachedGridCols = 0;
        const grid = document.getElementById('characterGrid');
        // cache clearing above still runs in other views; the re-render waits for performSearch on view re-entry
        if (grid && currentCharsList.length > 0 && currentView === 'characters') {
            updateGridHeight(grid);
            const scrollContainer = document.querySelector('.gallery-content');
            updateVisibleCards(grid, scrollContainer, true);
        }
    });
});

// Mobile innerHTML batch path. 50 cards in one parse runs ~10-20ms vs ~50-150ms for per-card createElement, so a fast-flick rAF stays under frame budget. Tooltip omitted on mobile (no hover anyway, extractPlainText was the expensive part). Output DOM matches createCharacterCard.
function buildCharacterCardHTML(char, virtualIndex) {
    const isFav = isCharacterFavorite(char);
    const name = getCharacterName(char);
    // buildCharacterCardHTML is only invoked from the mobile branch of updateVisibleCards, so the master toggle alone is enough here.
    const imgPath = getSetting('useGridThumbnails') === true
        ? getCharacterAvatarThumbUrl(char.avatar)
        : getCharacterAvatarUrl(char.avatar);
    const tagsAll = getTags(char);
    const tags = tagsAll.length > 3 ? tagsAll.slice(0, 3) : tagsAll;

    const initiallyLoaded = _seenAvatarUrls.has(imgPath);
    const isSelected = !!(window.MultiSelect?.isSelected?.(char.avatar));

    const classes = ['char-card'];
    if (isFav) classes.push('is-favorite');
    if (initiallyLoaded) classes.push('loaded');
    if (isSelected) classes.push('selected');

    const parts = ['<div class="', classes.join(' '), '" data-avatar="', escapeHtml(char.avatar), '" data-virtual-index="', virtualIndex, '">'];
    if (isFav) parts.push('<div class="favorite-indicator"><i class="fa-solid fa-star"></i></div>');
    parts.push('<div class="char-card-checkbox" aria-hidden="true"><i class="fa-solid fa-check"></i></div>');
    parts.push('<img class="card-image" src="', escapeHtml(imgPath), '" alt="" decoding="async">');
    parts.push('<div class="card-overlay"><div class="card-name">', escapeHtml(name), '</div><div class="card-tags">');
    for (const tag of tags) parts.push('<span class="card-tag">', escapeHtml(tag), '</span>');
    parts.push('</div></div></div>');

    return parts.join('');
}

function createCardsBatchHTML(charsWithIndices) {
    if (charsWithIndices.length === 0) return [];
    const html = charsWithIndices.map(({ char, index }) => buildCharacterCardHTML(char, index)).join('');
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    const cards = Array.from(tmp.children);
    // Sync cache-hit promotion: buildCharacterCardHTML only consults the Set, so urls cached by the browser but not yet in the Set (eg. first view-switch) still flash. img.complete catches those.
    for (const card of cards) {
        if (card.classList.contains('loaded')) continue;
        const img = card.querySelector('.card-image');
        if (img && img.complete && img.naturalWidth > 0) {
            _seenAvatarUrls.add(img.src);
            card.classList.add('loaded');
        }
    }
    return cards;
}

/**
 * Create a single character card element
 */
function createCharacterCard(char) {
    const card = document.createElement('div');
    card.className = 'char-card';
    
    const isFavorite = isCharacterFavorite(char);
    if (isFavorite) {
        card.classList.add('is-favorite');
    }
    
    const name = getCharacterName(char);
    // createCharacterCard is desktop-only; thumbs require both master AND the explicit desktop opt-in.
    const imgPath = (getSetting('useGridThumbnails') === true && getSetting('gridThumbnailsDesktop') === true)
        ? getCharacterAvatarThumbUrl(char.avatar)
        : getCharacterAvatarUrl(char.avatar);
    const tags = getTags(char);
    
    // Use creator_notes as hover tooltip - extract plain text only
    // For online imports, this contains the public character description (often with HTML/CSS)
    const creatorNotes = char.data?.creator_notes || char.creator_notes || '';
    const cacheKey = 'plainText:' + char.avatar;
    let tooltipText = getCached(cacheKey);
    if (tooltipText === undefined) {
        tooltipText = extractPlainText(creatorNotes, 200);
        setCached(cacheKey, tooltipText);
    }
    if (tooltipText) {
        card.title = tooltipText;
    }
    
    // Build card DOM directly instead of innerHTML - avoids HTML parser overhead
    // and escapeHtml regex chains. textContent auto-escapes safely.
    
    // Favorite indicator
    if (isFavorite) {
        const favDiv = document.createElement('div');
        favDiv.className = 'favorite-indicator';
        const favIcon = document.createElement('i');
        favIcon.className = 'fa-solid fa-star';
        favDiv.appendChild(favIcon);
        card.appendChild(favDiv);
    }

    // always in dom, body.multi-select-mode reveals; real div not pseudo so themers can target it like .favorite-indicator
    const checkbox = document.createElement('div');
    checkbox.className = 'char-card-checkbox';
    checkbox.setAttribute('aria-hidden', 'true');
    const checkIcon = document.createElement('i');
    checkIcon.className = 'fa-solid fa-check';
    checkbox.appendChild(checkIcon);
    card.appendChild(checkbox);
    
    // Avatar image
    const img = document.createElement('img');
    img.className = 'card-image';
    img.decoding = 'async';
    img.src = imgPath;
    // Mobile sometimes reports img.complete=false right after src= even on cached avatars, so the Set lets rerenders skip the fade anyway
    const looksCached = _seenAvatarUrls.has(imgPath) || (img.complete && img.naturalWidth > 0);
    if (looksCached) {
        _seenAvatarUrls.add(imgPath);
        card.classList.add('loaded');
    } else {
        img.addEventListener('load', () => {
            _seenAvatarUrls.add(imgPath);
            card.classList.add('loaded');
        }, { once: true });
    }
    card.appendChild(img);
    
    // Overlay
    const overlay = document.createElement('div');
    overlay.className = 'card-overlay';
    
    const nameDiv = document.createElement('div');
    nameDiv.className = 'card-name';
    nameDiv.textContent = name; // textContent auto-escapes
    overlay.appendChild(nameDiv);
    
    const tagsDiv = document.createElement('div');
    tagsDiv.className = 'card-tags';
    const tagSlice = tags.length > 3 ? tags.slice(0, 3) : tags;
    for (let i = 0; i < tagSlice.length; i++) {
        const tagSpan = document.createElement('span');
        tagSpan.className = 'card-tag';
        tagSpan.textContent = tagSlice[i]; // auto-escaped
        tagsDiv.appendChild(tagSpan);
    }
    overlay.appendChild(tagsDiv);
    card.appendChild(overlay);
    
    // Store avatar for multi-select lookup
    card.dataset.avatar = char.avatar;

    if (window.MultiSelect?.isSelected?.(char.avatar)) {
        card.classList.add('selected');
    }
    
    // Context menu is handled via event delegation in module-loader.js
    // No per-card attachment needed
    
    return card;
}

// Modal Logic
const modal = document.getElementById('charModal');
let activeChar = null;
// Per-session override for the detail modal's prev/next source (eg. recommender results); null = grid default.
let modalNavList = null;
const getModalNavList = () => modalNavList ?? currentCharsList;
let _modalOpenGen = 0;

// Cached tab element references - these are static DOM nodes, queried once
let _cachedTabButtons = null;
let _cachedTabPanes = null;

function getTabButtons() {
    if (!_cachedTabButtons) _cachedTabButtons = document.querySelectorAll('.tab-btn');
    return _cachedTabButtons;
}

function getTabPanes() {
    if (!_cachedTabPanes) _cachedTabPanes = document.querySelectorAll('.tab-pane');
    return _cachedTabPanes;
}

function deactivateAllTabs() {
    getTabButtons().forEach(b => b.classList.remove('active'));
    getTabPanes().forEach(p => p.classList.remove('active'));
}

function resetTabScrollPositions() {
    getTabPanes().forEach(p => p.scrollTop = 0);
    const sidebar = document.querySelector('.modal-sidebar');
    if (sidebar) sidebar.scrollTop = 0;
    // Mobile makes .modal-body the scroll container (panes are overflow:visible). The early reset in
    // openModal runs while the modal is still hidden on a fresh open, so reset here post-show too.
    const modalBody = document.querySelector('#charModal .modal-body');
    if (modalBody) modalBody.scrollTop = 0;
}

// Fetch User Images for Character
// charOrName can be a character object or a character name string
// If unique gallery folders are enabled, we use the unique folder name
async function fetchCharacterImages(charOrName) {
    const grid = document.getElementById('spritesGrid');
    grid.innerHTML = '<div class="cl-spinner-inline"><i class="fa-solid fa-spinner fa-spin"></i> Loading media...</div>';
    
    // Determine the folder name to use
    let folderName;
    let displayName;
    
    if (charOrName && typeof charOrName === 'object') {
        // It's a character object - use getGalleryFolderName for proper unique folder support
        folderName = getGalleryFolderName(charOrName);
        displayName = charOrName.name || folderName;
    } else {
        // It's a string - try to find the character and get their unique folder
        const charName = String(charOrName);
        displayName = charName;
        
        // Try to find a matching character for unique folder lookup
        // First check activeChar (most common case when viewing gallery)
        if (activeChar && activeChar.name === charName) {
            folderName = getGalleryFolderName(activeChar);
        } else {
            // Try to find by name in allCharacters
            const matchingChars = allCharacters.filter(c => c.name === charName);
            if (matchingChars.length === 1) {
                // Exactly one match - use its unique folder
                folderName = getGalleryFolderName(matchingChars[0]);
            } else {
                // Multiple or no matches - use the name as-is
                // This is the fallback for shared name scenarios
                folderName = charName;
            }
        }
    }
    
    debugLog(`[Gallery] Fetching images from folder: ${folderName} (display: ${displayName})`);

    try {
        const response = await apiRequest(ENDPOINTS.IMAGES_LIST, 'POST', { folder: folderName, type: 7 });

        if (response.ok) {
            const files = await response.json();
            renderGalleryImages(files, folderName);
        } else {
            // A missing folder is a 200 [] (ST mkdirs it), so non-ok is a real failure, not an empty gallery.
            console.warn(`[Gallery] Failed to list images: ${response.status}`);
            grid.innerHTML = modalLoadErrorHtml('Failed to load gallery. Check your connection to SillyTavern.');
        }
    } catch (e) {
        console.error("Error fetching images:", e);
        grid.innerHTML = modalLoadErrorHtml('Failed to load gallery. Check your connection to SillyTavern.');
    }
}


const GALLERY_PAGE_SIZE = 100;
const GALLERY_THUMB_SIZE = 384;
const GALLERY_THUMB_CONCURRENCY = 6;
const GALLERY_PREWARM_CONCURRENCY = 4;
const PREWARM_EXTENSIONS = /\.(png|jpe?g|webp)$/i;
let _galleryState = null;
let _galleryThumbObserver = null;
// Per-surface thumbnail loader: capped-concurrency FIFO over <img> elements
// carrying dataset.thumbUrl/.fullUrl. The gallery tab and the fullscreen
// viewer each own an instance; they run concurrently (viewer stacks over the
// tab) so queue state must never be shared. reset() aborts in-flight loads
// and revokes issued blob URLs; callers replace their grid DOM wholesale in
// the same task before re-enqueueing, so revocation cant blank a visible image.
function createThumbLoader({ concurrency, onSettled = null } = {}) {
    let active = 0;
    let queue = [];
    let blobUrls = new Set();
    let abort = new AbortController();

    async function load(img) {
        try {
            const resp = await apiRequest(img.dataset.thumbUrl, 'GET', null, { signal: abort.signal });
            if (!resp.ok) throw new Error(resp.status);
            const blob = await resp.blob();
            const blobUrl = URL.createObjectURL(blob);
            blobUrls.add(blobUrl);
            img.src = blobUrl;
        } catch (err) {
            // reset() already zeroed the counter; draining here would double-decrement
            if (err?.name === 'AbortError') return;
            img.src = img.dataset.fullUrl || '';
        }
        onSettled?.(img);
        drain();
    }

    function drain() {
        active = Math.max(0, active - 1);
        if (queue.length > 0) {
            active++;
            load(queue.shift());
        }
    }

    return {
        enqueue(img) {
            if (active < concurrency) {
                active++;
                load(img);
            } else {
                queue.push(img);
            }
        },
        reset() {
            abort.abort();
            abort = new AbortController();
            queue = [];
            active = 0;
            blobUrls.forEach(u => URL.revokeObjectURL(u));
            blobUrls.clear();
        },
    };
}

const _tabThumbLoader = createThumbLoader({
    concurrency: GALLERY_THUMB_CONCURRENCY,
    onSettled: (img) => img.closest('.sprite-item')?.classList.remove('sprite-thumb-loading'),
});

function buildGalleryThumbUrl(folderName, fileName) {
    return `/plugins/cl-helper/gallery-thumb/${encodeURIComponent(folderName)}/${encodeURIComponent(fileName)}?s=${GALLERY_THUMB_SIZE}`;
}

function getGalleryThumbUrl(folderName, fileName) {
    return buildGalleryThumbUrl(folderName, fileName);
}

function cleanupThumbCache(folderName) {
    fetch(`/api/v1/galleries/${encodeURIComponent(folderName)}/thumbs/prune`, { method: 'POST' })
        .catch(() => {});
}

function prewarmThumbnails(folderName, fileNames) {
    const imageFiles = fileNames.filter(f => PREWARM_EXTENSIONS.test(f));
    if (imageFiles.length === 0) return;
    debugLog(`[Thumbs] Pre-warming ${imageFiles.length} thumbnails for ${folderName}`);
    let active = 0;
    let idx = 0;
    function drain() {
        while (active < GALLERY_PREWARM_CONCURRENCY && idx < imageFiles.length) {
            const file = imageFiles[idx++];
            active++;
            const url = buildGalleryThumbUrl(folderName, file);
            apiRequest(url).then(() => { active--; drain(); }).catch(() => { active--; drain(); });
        }
    }
    drain();
}

function _populateGalleryGrid(startIndex, endIndex) {
    if (!_galleryState) return;
    _populateGalleryGridThumb(startIndex, endIndex);
}

function _populateGalleryGridThumb(startIndex, endIndex) {
    const state = _galleryState;
    if (!state) return;

    if (!_galleryThumbObserver) {
        _galleryThumbObserver = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                const img = entry.target;
                _galleryThumbObserver.unobserve(img);
                _tabThumbLoader.enqueue(img);
            }
        }, { rootMargin: '200px' });
    }

    const fragment = document.createDocumentFragment();

    for (let i = startIndex; i < endIndex; i++) {
        const { fileName, type } = state.visualMedia[i];
        const mediaUrl = state.galleryMedia[i].url;
        const mediaContainer = document.createElement('div');
        const mediaIsGif = type === 'image' && /\.gif$/i.test(fileName);
        mediaContainer.className = `sprite-item sprite-thumb-loading${mediaIsGif ? ' gif-thumb' : ''}`;
        mediaContainer.dataset.galleryIndex = i;

        if (type === 'video') {
            mediaContainer.classList.remove('sprite-thumb-loading');
            mediaContainer.innerHTML = `
                <div class="video-thumbnail" title="${escapeHtml(fileName)}">
                    <video src="${mediaUrl}" preload="metadata" muted></video>
                    <div class="video-play-overlay"><i class="fa-solid fa-play"></i></div>
                </div>
            `;
        } else {
            // types cl-helper's Jimp cant decode go straight to the full URL
            const thumbUrl = /\.(bmp|avif|tiff?)$/i.test(fileName)
                ? mediaUrl
                : buildGalleryThumbUrl(state.safeFolderName, fileName);
            const img = document.createElement('img');
            img.decoding = 'async';
            img.title = fileName;
            img.dataset.gif = mediaIsGif ? '1' : '0';
            img.dataset.thumbUrl = thumbUrl;
            img.dataset.fullUrl = mediaUrl;
            img.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'/%3E";
            _galleryThumbObserver.observe(img);
            mediaContainer.appendChild(img);
        }

        fragment.appendChild(mediaContainer);
    }

    state.imagesGrid.appendChild(fragment);
}

function renderGalleryImages(files, folderName) {
    const grid = document.getElementById('spritesGrid');
    grid.innerHTML = '';
    if (_galleryThumbObserver) { _galleryThumbObserver.disconnect(); _galleryThumbObserver = null; }
    _tabThumbLoader.reset();
    if (_gifFreezePending) { cancelAnimationFrame(_gifFreezePending); _gifFreezePending = null; }
    _galleryState = null;
    // Reset grid class - we'll manage layout with sections inside
    grid.className = 'gallery-media-container';
    
    if (!files || files.length === 0) {
        renderSimpleEmpty(grid, 'No media found.');
        return;
    }

    // Separate images, videos, and audio files
    const imageFiles = [];
    const videoFiles = [];
    const audioFiles = [];
    
    files.forEach(file => {
        const fileName = (typeof file === 'string') ? file : file.name;
        if (!fileName) return;
        
        if (GALLERY_IMAGE_RE.test(fileName)) {
            imageFiles.push(fileName);
        } else if (GALLERY_VIDEO_RE.test(fileName)) {
            videoFiles.push(fileName);
        } else if (/\.(mp3|wav|ogg|m4a|flac|aac)$/i.test(fileName)) {
            audioFiles.push(fileName);
        }
    });
    
    // Trim folder name and sanitize to match SillyTavern's folder naming
    const safeFolderName = sanitizeFolderName(folderName);
    
    // Render audio files first if any exist
    if (audioFiles.length > 0) {
        const audioSection = document.createElement('div');
        audioSection.className = 'gallery-audio-section';
        
        const collapseThreshold = isMobileMode() ? 2 : 4;
        const shouldCollapse = audioFiles.length > collapseThreshold;
        
        const titleEl = document.createElement('div');
        titleEl.className = 'gallery-section-title';
        if (shouldCollapse) titleEl.classList.add('collapsible');
        titleEl.innerHTML = `<i class="fa-solid fa-music"></i> Audio Files (${audioFiles.length})${shouldCollapse ? '<i class="fa-solid fa-chevron-down audio-collapse-icon"></i>' : ''}`;
        audioSection.appendChild(titleEl);
        
        const audioGrid = document.createElement('div');
        audioGrid.className = 'audio-files-grid';
        if (shouldCollapse) audioGrid.classList.add('collapsed');
        
        if (shouldCollapse) {
            titleEl.addEventListener('click', () => {
                audioGrid.classList.toggle('collapsed');
                titleEl.classList.toggle('expanded');
            });
        }
        
        audioFiles.forEach(fileName => {
            const audioUrl = galleryFileUrl(safeFolderName, fileName);
            const audioItem = document.createElement('div');
            audioItem.className = 'audio-item';
            audioItem.innerHTML = `
                <div class="audio-item-icon">
                    <i class="fa-solid fa-music"></i>
                </div>
                <div class="audio-item-info">
                    <div class="audio-item-name" title="${escapeHtml(fileName)}">${escapeHtml(fileName)}</div>
                    <audio controls class="audio-player" preload="metadata">
                        <source src="${audioUrl}" type="audio/${fileName.split('.').pop().toLowerCase()}">
                        Your browser does not support audio playback.
                    </audio>
                </div>
            `;
            audioGrid.appendChild(audioItem);
        });
        
        audioSection.appendChild(audioGrid);
        grid.appendChild(audioSection);
    }
    
    // Combine images and videos for the visual media section
    const visualMedia = [
        ...imageFiles.map(fileName => ({ fileName, type: 'image' })),
        ...videoFiles.map(fileName => ({ fileName, type: 'video' }))
    ];
    
    // Render visual media (images + videos)
    if (visualMedia.length > 0) {
        const imagesSection = document.createElement('div');
        imagesSection.className = 'gallery-images-section';
        
        const hasOtherMedia = audioFiles.length > 0;
        const imageCount = imageFiles.length;
        const videoCount = videoFiles.length;
        
        if (hasOtherMedia) {
            // Add section title if we also have audio
            let titleText = '';
            if (imageCount > 0 && videoCount > 0) {
                titleText = `Images & Videos (${imageCount} + ${videoCount})`;
            } else if (videoCount > 0) {
                titleText = `Videos (${videoCount})`;
            } else {
                titleText = `Images (${imageCount})`;
            }
            imagesSection.innerHTML = `<div class="gallery-section-title"><i class="fa-solid fa-photo-film"></i> ${titleText}</div>`;
        }
        
        const imagesGrid = document.createElement('div');
        imagesGrid.className = 'gallery-sprites-grid';
        
        const galleryMedia = visualMedia.map(({ fileName, type }) => ({
            name: fileName,
            url: galleryFileUrl(safeFolderName, fileName),
            type: type
        }));
        
        _galleryState = { visualMedia, galleryMedia, safeFolderName, imagesGrid, imagesSection, currentPage: 0, paginationEls: [] };
        
        imagesGrid.addEventListener('click', _handleGalleryGridClick);
        
        if (visualMedia.length > GALLERY_PAGE_SIZE) {
            const paginationTop = _createGalleryPagination();
            imagesSection.appendChild(paginationTop);
            imagesSection.appendChild(imagesGrid);
            const paginationBottom = _createGalleryPagination();
            imagesSection.appendChild(paginationBottom);
            _renderGalleryPage(0, false);
        } else {
            _populateGalleryGrid(0, visualMedia.length);
            imagesSection.appendChild(imagesGrid);
        }
        
        grid.appendChild(imagesSection);
    }
    
    // Show empty state if no media at all
    if (imageFiles.length === 0 && videoFiles.length === 0 && audioFiles.length === 0) {
        renderSimpleEmpty(grid, 'No media found.');
    }
}

function _handleGalleryGridClick(e) {
    const item = e.target.closest('.sprite-item');
    if (!item || !_galleryState) return;
    const index = parseInt(item.dataset.galleryIndex, 10);
    if (isNaN(index)) return;
    if (window.openGalleryViewerWithImages) {
        const charName = activeChar?.name || 'Gallery';
        window.openGalleryViewerWithImages(_galleryState.galleryMedia, index, charName, _galleryState.safeFolderName);
    } else {
        const media = _galleryState.galleryMedia[index];
        if (media) window.open(media.url, '_blank');
    }
}

const GIF_FREEZE_BATCH_SIZE = 4;
let _gifFreezePending = null;

function _scheduleGifFreeze(images) {
    if (_gifFreezePending) cancelAnimationFrame(_gifFreezePending);
    const queue = images.slice();
    function processBatch() {
        const batch = queue.splice(0, GIF_FREEZE_BATCH_SIZE);
        for (const img of batch) freezeGifThumbnailImage(img);
        if (queue.length > 0) {
            _gifFreezePending = requestAnimationFrame(processBatch);
        } else {
            _gifFreezePending = null;
        }
    }
    _gifFreezePending = requestAnimationFrame(processBatch);
}

function _renderGalleryPage(page, scroll = true) {
    const state = _galleryState;
    if (!state) return;
    const totalPages = Math.ceil(state.visualMedia.length / GALLERY_PAGE_SIZE);
    page = Math.max(0, Math.min(page, totalPages - 1));
    state.currentPage = page;

    state.imagesGrid.innerHTML = '';
    if (_galleryThumbObserver) { _galleryThumbObserver.disconnect(); _galleryThumbObserver = null; }
    _tabThumbLoader.reset();
    if (_gifFreezePending) { cancelAnimationFrame(_gifFreezePending); _gifFreezePending = null; }

    const start = page * GALLERY_PAGE_SIZE;
    const end = Math.min(start + GALLERY_PAGE_SIZE, state.visualMedia.length);
    _populateGalleryGrid(start, end);

    _updateGalleryPagination();

    if (scroll) {
        const tabPane = state.imagesSection.closest('.tab-pane');
        if (tabPane) tabPane.scrollTop = 0;
    }
}

function _createGalleryPagination() {
    const state = _galleryState;
    const totalPages = Math.ceil(state.visualMedia.length / GALLERY_PAGE_SIZE);

    const container = document.createElement('div');
    container.className = 'gallery-pagination';

    const nav = document.createElement('div');
    nav.className = 'gallery-page-nav';

    const prevBtn = document.createElement('button');
    prevBtn.className = 'gallery-page-btn gallery-page-prev';
    prevBtn.title = 'Previous page';
    prevBtn.innerHTML = '<i class="fa-solid fa-chevron-left"></i>';
    prevBtn.addEventListener('click', () => {
        if (_galleryState && _galleryState.currentPage > 0) {
            _renderGalleryPage(_galleryState.currentPage - 1);
        }
    });

    const info = document.createElement('span');
    info.className = 'gallery-page-info';

    const pageInput = document.createElement('input');
    pageInput.type = 'text';
    pageInput.inputMode = 'numeric';
    pageInput.className = 'gallery-page-input';
    pageInput.value = '1';
    pageInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const p = parseInt(pageInput.value, 10);
            if (!isNaN(p) && _galleryState) {
                _renderGalleryPage(p - 1);
            }
        }
    });
    pageInput.addEventListener('blur', () => {
        if (_galleryState) pageInput.value = _galleryState.currentPage + 1;
    });

    const totalSpan = document.createElement('span');
    totalSpan.className = 'gallery-page-total';
    totalSpan.textContent = totalPages;

    info.append(pageInput, ' / ', totalSpan);

    const nextBtn = document.createElement('button');
    nextBtn.className = 'gallery-page-btn gallery-page-next';
    nextBtn.title = 'Next page';
    nextBtn.innerHTML = '<i class="fa-solid fa-chevron-right"></i>';
    nextBtn.addEventListener('click', () => {
        if (_galleryState) {
            const tp = Math.ceil(_galleryState.visualMedia.length / GALLERY_PAGE_SIZE);
            if (_galleryState.currentPage < tp - 1) {
                _renderGalleryPage(_galleryState.currentPage + 1);
            }
        }
    });

    nav.append(prevBtn, info, nextBtn);
    container.append(nav);
    state.paginationEls.push(container);
    return container;
}

function _updateGalleryPagination() {
    const state = _galleryState;
    if (!state) return;
    const totalPages = Math.ceil(state.visualMedia.length / GALLERY_PAGE_SIZE);

    for (const el of state.paginationEls) {
        const prevBtn = el.querySelector('.gallery-page-prev');
        const nextBtn = el.querySelector('.gallery-page-next');
        const pageInput = el.querySelector('.gallery-page-input');
        const totalSpan = el.querySelector('.gallery-page-total');

        if (prevBtn) prevBtn.disabled = state.currentPage === 0;
        if (nextBtn) nextBtn.disabled = state.currentPage >= totalPages - 1;
        if (pageInput) pageInput.value = state.currentPage + 1;
        if (totalSpan) totalSpan.textContent = totalPages;
    }
}

function freezeGifThumbnailImage(imgEl, maxSize = 192) {
    if (!imgEl || imgEl.dataset.gifThumbFrozen === '1' || imgEl.dataset.gifThumbPending === '1') return;
    imgEl.dataset.gifThumbPending = '1';

    const finalize = () => {
        delete imgEl.dataset.gifThumbPending;
    };

    const renderPoster = () => {
        if (!imgEl.isConnected || imgEl.dataset.gifThumbFrozen === '1') {
            finalize();
            return;
        }

        const src = imgEl.currentSrc || imgEl.src;
        const w = imgEl.naturalWidth;
        const h = imgEl.naturalHeight;
        if (!src || src.startsWith('data:') || !w || !h) {
            finalize();
            return;
        }

        try {
            const scale = Math.min(1, maxSize / Math.max(w, h));
            const tw = Math.max(1, Math.round(w * scale));
            const th = Math.max(1, Math.round(h * scale));
            const canvas = document.createElement('canvas');
            canvas.width = tw;
            canvas.height = th;

            const ctx = canvas.getContext('2d', { alpha: true });
            if (!ctx) {
                canvas.width = 0;
                canvas.height = 0;
                finalize();
                return;
            }

            ctx.drawImage(imgEl, 0, 0, tw, th);
            const dataUrl = canvas.toDataURL('image/webp', 0.82);
            canvas.width = 0;
            canvas.height = 0;

            imgEl.src = dataUrl;
            imgEl.dataset.gifThumbFrozen = '1';
        } catch (e) {
            // Keep original GIF thumbnail when poster conversion fails.
        } finally {
            finalize();
        }
    };

    if (imgEl.complete && imgEl.naturalWidth > 0) {
        renderPoster();
    } else {
        imgEl.addEventListener('load', renderPoster, { once: true });
        imgEl.addEventListener('error', finalize, { once: true });
    }
}

function openCharModalElevated(char, navList) {
    const charModal = document.getElementById('charModal');
    if (!charModal) return;
    // Pin existing visible modals so char-modal-above only elevates new ones. Includes other
    // open .modal-overlay modals: on mobile library-mobile.css forces every .modal-overlay to
    // z-index:200 !important, so without pinning one would tie/win against the elevated charModal.
    // 2000 keeps them below charModal's 10002 but above page chrome.
    const pinnedModals = [
        ...document.querySelectorAll('.confirm-modal:not(.hidden), .cl-modal.visible, .modal-overlay:not(.hidden)'),
    ].filter(m => m !== charModal);
    pinnedModals.forEach(m => m.style.setProperty('z-index', '2000', 'important'));
    document.body.classList.add('char-modal-above');
    const restore = () => {
        document.body.classList.remove('char-modal-above');
        pinnedModals.forEach(m => m.style.removeProperty('z-index'));
        modalNavList = null;
        obs.disconnect();
    };
    const obs = new MutationObserver(() => {
        if (charModal.classList.contains('hidden')) restore();
    });
    obs.observe(charModal, { attributes: true, attributeFilter: ['class'] });
    openModal(char, { navList });
}

// Steps prev/next through getModalNavList() (elevated opener's list, else the grid); gate + teardown live in openModal.
function navigateModal(direction) {
    if (!activeChar) return;
    if (getSetting('enableCharDetailNav') === false) return;
    const navList = getModalNavList();
    const idx = navList.findIndex(c => c.avatar === activeChar.avatar);
    if (idx === -1) return;
    const targetIdx = idx + direction;
    if (targetIdx < 0 || targetIdx >= navList.length) return;
    openModal(navList[targetIdx]);
}

// Mirror the preload path's thumb gate so the modal-hero prefetch agrees on cache-warmth.
function gridUsesThumbnails() {
    if (getSetting('useGridThumbnails') !== true) return false;
    const isMobile = isMobileMode();
    return !!(isMobile || getSetting('gridThumbnailsDesktop') === true);
}

function prefetchModalNeighbors(currentChar) {
    if (!currentChar || getSetting('enableCharDetailNav') === false) return;
    const navList = getModalNavList();
    if (!Array.isArray(navList) || navList.length < 2) return;
    const idx = navList.findIndex(c => c && c.avatar === currentChar.avatar);
    if (idx === -1) return;
    const warmHero = gridUsesThumbnails(); // full PNG needs warming only when the grid isnt already loading it
    for (const offset of [1, -1, 2, -2]) { // forward first: next is the common direction
        const neighbor = navList[idx + offset];
        if (!neighbor) continue;
        if (neighbor._slim) hydrateCharacter(neighbor);
        if (warmHero && neighbor.avatar) new Image().src = getCharacterAvatarUrl(neighbor.avatar);
    }
}

function isCharModalDirty() {
    if (!activeChar || isEditLocked) return false;
    if (pendingAvatarFile) return true;
    try {
        const current = collectEditValues();
        return generateChangesDiff(originalValues, current).length > 0;
    } catch (_) {
        return false;
    }
}

function confirmDiscardCharModalEdits() {
    return showConfirm({
        title: 'Discard unsaved edits?',
        message: `You have unsaved changes to ${getCharacterName(activeChar) || 'this character'}. Discard them?`,
        confirmLabel: 'Discard',
        cancelLabel: 'Keep Editing',
        danger: true,
    });
}

// User-initiated close. Programmatic closers (post-delete cleanup, save success) keep calling closeModal directly.
async function maybeCloseModal() {
    if (isCharModalDirty()) {
        const ok = await confirmDiscardCharModalEdits();
        if (!ok) return;
    }
    closeModal();
}

function updateCharModalNavState() {
    const prevBtn = document.getElementById('charModalNavPrev');
    const nextBtn = document.getElementById('charModalNavNext');
    if (!prevBtn || !nextBtn) return;
    const enabled = getSetting('enableCharDetailNav') !== false && !!activeChar;
    const navList = getModalNavList();
    const idx = enabled ? navList.findIndex(c => c.avatar === activeChar.avatar) : -1;
    const show = idx !== -1;
    prevBtn.style.display = show ? '' : 'none';
    nextBtn.style.display = show ? '' : 'none';
    if (!show) return;
    prevBtn.disabled = idx === 0;
    nextBtn.disabled = idx >= navList.length - 1;
}

async function openModal(char, { navList } = {}) {
    // Swap-while-open gate: dirty-edit prompt + per-character teardown live here so every modal-to-modal entry point (navigateModal, openRelatedCharacter, anywhere else) inherits the same protection.
    const charModalEl = document.getElementById('charModal');
    const isSwap = charModalEl && !charModalEl.classList.contains('hidden') && activeChar && activeChar.avatar !== char.avatar;
    // Fresh open picks the nav source; swaps/steps pass no navList so the session's source persists while paging.
    if (!isSwap) modalNavList = navList ?? null;
    if (isSwap && isCharModalDirty()) {
        const ok = await confirmDiscardCharModalEdits();
        if (!ok) return;
    }
    if (isSwap) {
        setEditLock(true);
        clearPendingAvatar();
    }

    if (isMobileMode()) {
        const modal = document.getElementById('charModal');
        if (modal) {
            const modalBody = modal.querySelector('.modal-body');
            if (modalBody) modalBody.scrollTop = 0;
            getTabPanes().forEach(pane => {
                pane.scrollTop = 0;
            });
        }
    }

    const gen = ++_modalOpenGen;
    activeChar = char;
    updateCharModalNavState();

    // Show loading state for avatar while new image loads
    const modalImg = document.getElementById('modalImage');
    modalImg.classList.add('loading');

    // Race the full-avatar fetch with hydrate so when grid uses thumbs we dont serialize the two network waits.
    new Image().src = getCharacterAvatarUrl(char.avatar);

    // Update the mobile header thumbnail src as early as possible so by the time the modal becomes visible the new char's thumb is already decoded; otherwise the previous char's thumb stays painted until the lazy observer-driven update fires.
    const _mobileHeader = document.querySelector('#charModal .mobile-header-avatar');
    if (_mobileHeader) _mobileHeader.src = getCharacterAvatarStThumbUrl(char.avatar);

    // Hydrate await is deferred until after the modal shows so a slow /characters/get cant gate the open.
    const imgPath = getCharacterAvatarUrl(char.avatar);

    // Load avatar with transition: keep spinner until the correct image is ready
    modalImg.onload = modalImg.onerror = () => { modalImg.classList.remove('loading'); };
    modalImg.src = imgPath;
    document.getElementById('modalTitle').innerText = getCharacterName(char);
    
    // Update favorite button state
    updateFavoriteButtonUI(isCharacterFavorite(char));
    
    // Update per-character media localization toggle with override indicator
    const charLocalizeToggle = document.getElementById('charLocalizeToggle');
    const localizeToggleLabel = document.querySelector('.localize-toggle');
    if (charLocalizeToggle && char.avatar) {
        const status = getMediaLocalizationStatus(char.avatar);
        charLocalizeToggle.checked = status.isEnabled;
        
        // Update visual indicator for override status
        if (localizeToggleLabel) {
            localizeToggleLabel.classList.toggle('has-override', status.hasOverride);
            
            // Update tooltip to explain the status
            if (status.hasOverride) {
                const overrideType = status.isEnabled ? 'ENABLED' : 'DISABLED';
                const globalStatus = status.globalEnabled ? 'enabled' : 'disabled';
                localizeToggleLabel.title = `Override: ${overrideType} for this character (global is ${globalStatus})`;
            } else {
                const globalStatus = status.globalEnabled ? 'enabled' : 'disabled';
                localizeToggleLabel.title = `Using global setting (${globalStatus})`;
            }
        }
    }

    // Dates/Tokens
    let dateDisplay = 'Unknown';
    if (char.date_added) {
        const d = new Date(Number(char.date_added));
        if (!isNaN(d.getTime())) dateDisplay = d.toLocaleDateString();
    } else {
        const rawCreateDate = getCharacterCreateDateValue(char);
        if (rawCreateDate) {
            const d = new Date(rawCreateDate);
            if (!isNaN(d.getTime())) dateDisplay = formatDateTime(rawCreateDate);
            else if (rawCreateDate.length < 20) dateDisplay = rawCreateDate;
        }
    }
    
    document.getElementById('modalDate').innerText = dateDisplay;

    // Author
    const author = char.creator || (char.data ? char.data.creator : "") || "";
    const authContainer = document.getElementById('modalAuthorContainer');
    const authorEl = document.getElementById('modalAuthor');
    if (author && authContainer) {
        authorEl.innerText = author;
        authorEl.onclick = async (e) => {
            e.preventDefault();
            // Dirty-checked close; only filter when the modal actually closed
            await maybeCloseModal();
            if (modal.classList.contains('hidden')) filterLocalByCreator(author);
        };
        authContainer.style.display = 'inline';
    } else if (authContainer) {
        authContainer.style.display = 'none';
    }

    // Provider Link Indicator (generic). Show loading until hydrate, so a linked card never flashes "unlinked" under lazy loading.
    if (extensionsReady(char)) updateProviderLinkIndicator(char);
    else setProviderLinkIndicatorLoading();

    // Tagline lives in the active namespace (provider id when linked, cl when unlinked).
    // Wire unconditionally: a lazy-loading card's hidden row must be clickable once hydrate reveals it.
    wireProviderTaglineExpand();
    if (extensionsReady(char)) {
        renderProviderTaglineRow(char);
    } else {
        const taglineRow = document.getElementById('modalProviderTaglineRow');
        if (taglineRow) taglineRow.style.display = 'none';
    }

    // Creator Notes - Secure rendering with DOMPurify + sandboxed iframe
    const creatorNotes = char.creator_notes || (char.data ? char.data.creator_notes : "") || "";
    const notesBox = document.getElementById('modalCreatorNotesBox');
    const notesContainer = document.getElementById('modalCreatorNotes');

    if (creatorNotes && notesBox && notesContainer) {
        notesBox.style.display = 'block';
        const detailsEl = document.getElementById('creatorNotesDetails');
        if (detailsEl) detailsEl.open = !!getSetting('expandCreatorNotes');
        // Store raw content for fullscreen expand feature
        window.currentCreatorNotesContent = creatorNotes;
        // Use the shared secure rendering function
        renderCreatorNotesSecure(creatorNotes, char.name, notesContainer);
        initCreatorNotesHandlers();
        // Show/hide expand button based on content length
        const expandBtn = document.getElementById('creatorNotesExpandBtn');
        if (expandBtn) {
            const lineCount = (creatorNotes.match(/\n/g) || []).length + 1;
            const charCount = creatorNotes.length;
            const showExpand = lineCount >= CreatorNotesConfig.MIN_LINES_FOR_EXPAND || 
                               charCount >= CreatorNotesConfig.MIN_CHARS_FOR_EXPAND;
            expandBtn.style.display = showExpand ? 'flex' : 'none';
        }
    } else if (notesBox) {
        notesBox.style.display = 'none';
        window.currentCreatorNotesContent = null;
    }

    if (char._slim) {
        const sk = '<div class="cl-skeleton-line"></div><div class="cl-skeleton-line"></div><div class="cl-skeleton-line short"></div>';
        document.getElementById('modalDescription').innerHTML = sk;
        document.getElementById('modalFirstMes').innerHTML = sk;
        const skAlt = document.getElementById('modalAltGreetingsBox');
        if (skAlt) skAlt.style.display = 'none';
        const skLb = document.getElementById('modalLorebookBox');
        if (skLb) skLb.style.display = 'none';
    }

    // Edit pane is populated lazily on first Edit tab click (see populateEditPane)
    _editPanePopulated = false;
    
    // Render tags in sidebar (will be made editable when edit is unlocked)
    renderSidebarTags(getTags(char));


    deactivateAllTabs();
    document.querySelector('.tab-btn[data-tab="details"]').classList.add('active');
    document.getElementById('pane-details').classList.add('active');

    
    // Reset scroll positions to top
    resetTabScrollPositions();

    // Edit tab logic (deferred population)
    const editTabBtn = document.querySelector('.tab-btn[data-tab="edit"]');
    if (editTabBtn) {
        editTabBtn.onclick = () => {
            deactivateAllTabs();
            editTabBtn.classList.add('active');
            document.getElementById('pane-edit').classList.add('active');
            populateEditPane();
        };
    }

    // Gallery tab logic
    const galleryTabBtn = document.querySelector('.tab-btn[data-tab="gallery"]');
    if (galleryTabBtn) {
        galleryTabBtn.onclick = () => {
             // Switch tabs
            deactivateAllTabs();
            galleryTabBtn.classList.add('active');
            document.getElementById('pane-gallery').classList.add('active');
            
            // Fetch - pass character object for unique folder support
            fetchCharacterImages(char);
            
            // Check for legacy folder images (async, updates button visibility)

            // Show warning if uniqueGalleryFolders is enabled but character has no gallery_id
            updateGalleryIdWarning(char);
        };
    }
    
    // Related tab logic
    const relatedTabBtn = document.querySelector('.tab-btn[data-tab="related"]');
    if (relatedTabBtn) {
        relatedTabBtn.onclick = () => {
            // Switch tabs
            deactivateAllTabs();
            relatedTabBtn.classList.add('active');
            document.getElementById('pane-related').classList.add('active');
            
            // Find related characters
            findRelatedCharacters(char);
        };
    }

    // Info tab logic (developer/debugging feature)
    const infoTabBtn = document.getElementById('infoTabBtn');
    if (infoTabBtn) {
        // Show/hide based on setting - explicitly check for true (default is false/hidden)
        const showInfoTab = getSetting('showInfoTab') === true;
        if (showInfoTab) {
            infoTabBtn.classList.remove('hidden');
        } else {
            infoTabBtn.classList.add('hidden');
        }
        
        infoTabBtn.onclick = async () => {
            // Switch tabs
            deactivateAllTabs();
            infoTabBtn.classList.add('active');
            document.getElementById('pane-info').classList.add('active');

            // Info reads heavy fields (lorebook, greetings, media urls); a slim card would report zeros as fact.
            let c = activeChar;
            if (!c) return;
            setPaneLoadingState('pane-info', 'hidden');
            if (c._slim) {
                const avatar = c.avatar;
                setPaneLoadingState('pane-info', 'loading');
                await hydrateCharacter(c);
                c = activeChar; // re-resolve: a concurrent refresh may have swapped activeChar
                if (!c || c.avatar !== avatar) { setPaneLoadingState('pane-info', 'hidden'); return; } // modal swapped mid-fetch
                if (c._slim) { setPaneLoadingState('pane-info', 'error'); return; } // hydrate failed; leave covered
                setPaneLoadingState('pane-info', 'hidden');
            }
            populateInfoTab(c);
        };
    }

    // Show modal
    modal.classList.remove('hidden');

    // Reset scroll positions after modal is visible (using setTimeout to ensure DOM is ready)
    setTimeout(() => resetTabScrollPositions(), 0);

    // Deferred hydrate: slim cards hydrate after the open so /characters/get cant gate the modal.
    if (char._slim) {
        await hydrateCharacter(char);
        if (gen !== _modalOpenGen) return;

        // processAndRender may have replaced activeChar with a new slim object during the await
        // (non-awaited fetchCharacters(true) from _needsCharacterRefresh). Transfer hydrated data to
        // the array-linked object so Edit tab etc. stay in sync.
        if (activeChar !== char && activeChar?.avatar === char.avatar && activeChar._slim) {
            for (const field of HEAVY_FIELDS) {
                if (char[field] !== undefined) activeChar[field] = char[field];
                if (char.data?.[field] !== undefined) {
                    if (!activeChar.data) activeChar.data = {};
                    activeChar.data[field] = char.data[field];
                }
            }
            if (char.data?.extensions) {
                if (!activeChar.data) activeChar.data = {};
                activeChar.data.extensions = char.data.extensions;
            }
            if (char.spec) activeChar.spec = char.spec;
            if (char.spec_version) activeChar.spec_version = char.spec_version;
            activeChar._tokenEstimate = char._tokenEstimate;
            activeChar._slim = false;
            char = activeChar;
        }

        if (extensionsReady(char)) {
            updateProviderLinkIndicator(char);
            renderProviderTaglineRow(char);
        }

        // Hydrate failed: an honest error beats painting undefined as an empty card.
        if (char._slim) {
            const err = modalLoadErrorHtml('Failed to load character details. Check your connection to SillyTavern and reopen.');
            document.getElementById('modalDescription').innerHTML = err;
            document.getElementById('modalFirstMes').innerHTML = err;
            return;
        }
    }

    paintModalHeavyContent(char, creatorNotes, gen);

    // Warm the prev/next neighbors so the next navigation lands on a hydrated card (no skeleton flash).
    if (gen === _modalOpenGen) prefetchModalNeighbors(char);
}

/** Tab-pane cover ('loading'|'error'|'hidden'): while shown the pane content is hidden behind the loader. */
function setPaneLoadingState(paneId, state, errorMsg) {
    const pane = document.getElementById(paneId);
    if (!pane) return;
    if (state === 'hidden') {
        pane.classList.remove('pane-loading');
        const existing = pane.querySelector('.pane-loader');
        if (existing) existing.remove();
        return;
    }
    let loader = pane.querySelector('.pane-loader');
    if (!loader) {
        loader = document.createElement('div');
        loader.className = 'pane-loader';
        pane.appendChild(loader);
    }
    pane.classList.add('pane-loading');
    loader.innerHTML = state === 'error'
        ? `<i class="fa-solid fa-triangle-exclamation"></i><span>${errorMsg || 'Failed to load character details. Check your connection to SillyTavern.'}</span>`
        : '<i class="fa-solid fa-spinner fa-spin"></i><span>Loading card data...</span>';
}

/** Edit-tab cover: while shown the form is hidden so a slim card cant be saved empty. */
function setEditPaneLoadingState(state) {
    setPaneLoadingState('pane-edit', state, 'Couldn\'t load this card. Check your connection, then reopen the Edit tab.');
}

/** Inline load-failure notice for detail-modal content slots (spans the full row in grid containers). */
function modalLoadErrorHtml(message) {
    return `<div class="modal-load-error"><i class="fa-solid fa-triangle-exclamation"></i><span>${escapeHtml(message)}</span></div>`;
}

/** Populate the Edit tab form fields, editors, and original-value baselines. Called once per modal open. */
async function populateEditPane() {
    if (_editPanePopulated) return;
    _editPanePopulated = true;

    let char = activeChar;
    if (!char) { _editPanePopulated = false; return; }

    setEditPaneLoadingState('hidden'); // drop any stale loader from a prior open

    if (char._slim) {
        const avatar = char.avatar;
        setEditPaneLoadingState('loading');
        await hydrateCharacter(char);
        char = activeChar; // re-resolve: a concurrent refresh may have swapped activeChar for a fresh object
        if (!char || char.avatar !== avatar) { setEditPaneLoadingState('hidden'); _editPanePopulated = false; return; } // modal swapped mid-fetch
        if (char._slim) { setEditPaneLoadingState('error'); _editPanePopulated = false; return; } // hydrate failed or re-slimmed; leave covered
        setEditPaneLoadingState('hidden');
    }

    const desc = char.description || (char.data ? char.data.description : "") || "";
    const firstMes = char.first_mes || (char.data ? char.data.first_mes : "") || "";
    const author = char.creator || (char.data ? char.data.creator : "") || "";

    document.getElementById('editName').value = char.name;
    document.getElementById('editDescription').value = desc;
    document.getElementById('editFirstMes').value = firstMes;

    const personality = char.personality || (char.data ? char.data.personality : "") || "";
    const scenario = char.scenario || (char.data ? char.data.scenario : "") || "";
    const mesExample = char.mes_example || (char.data ? char.data.mes_example : "") || "";
    const systemPrompt = char.system_prompt || (char.data ? char.data.system_prompt : "") || "";
    const postHistoryInstructions = char.post_history_instructions || (char.data ? char.data.post_history_instructions : "") || "";
    const creatorNotesEdit = char.creator_notes || (char.data ? char.data.creator_notes : "") || "";
    const charVersion = char.character_version || (char.data ? char.data.character_version : "") || "";

    // Tags: always store as array, never as comma-delimited string
    const rawTags = char.tags || (char.data ? char.data.tags : []) || [];
    if (Array.isArray(rawTags)) {
        _editTagsArray = [...rawTags];
    } else if (typeof rawTags === "string") {
        _editTagsArray = rawTags.split(',').map(t => t.trim()).filter(t => t);
    } else {
        _editTagsArray = [];
    }

    document.getElementById('editCreator').value = author;
    document.getElementById('editVersion').value = charVersion;
    // Read tagline from the active namespace (not getDisplayTagline) so a linked card's stored value stays editable.
    const editTaglineNs = window.ProviderRegistry?.getActiveTaglineNamespace?.(char) ?? 'cl';
    document.getElementById('editTagline').value = char?.data?.extensions?.[editTaglineNs]?.tagline || '';
    // Listing name loads from the resolver so the field shows the same value as the Details tab; the save writes it back to the active namespace.
    document.getElementById('editListingName').value = getListingNameFromExtensions(char) || '';
    document.getElementById('editPersonality').value = personality;
    document.getElementById('editScenario').value = scenario;
    document.getElementById('editMesExample').value = mesExample;
    document.getElementById('editSystemPrompt').value = systemPrompt;
    document.getElementById('editPostHistoryInstructions').value = postHistoryInstructions;
    document.getElementById('editCreatorNotes').value = creatorNotesEdit;

    // Populate alternate greetings editor
    const altGreetings = char.alternate_greetings || (char.data ? char.data.alternate_greetings : []) || [];
    populateAltGreetingsEditor(altGreetings);

    // Populate lorebook editor
    const characterBook = char.character_book || (char.data ? char.data.character_book : null);
    populateLorebookEditor(characterBook);

    // Store raw data for cancel/restore
    originalRawData = {
        altGreetings: altGreetings ? [...altGreetings] : [],
        characterBook: characterBook ? JSON.parse(JSON.stringify(characterBook)) : null
    };

    // Read original values back from the form elements (not the model) so the diff
    // sees the same browser normalization (\r\n -> \n) the eventual save will see.
    originalValues = {
        name: document.getElementById('editName').value,
        description: document.getElementById('editDescription').value,
        first_mes: document.getElementById('editFirstMes').value,
        creator: document.getElementById('editCreator').value,
        character_version: document.getElementById('editVersion').value,
        tagline: document.getElementById('editTagline').value,
        listingName: document.getElementById('editListingName').value,
        tagsArray: [..._editTagsArray],
        personality: document.getElementById('editPersonality').value,
        scenario: document.getElementById('editScenario').value,
        mes_example: document.getElementById('editMesExample').value,
        system_prompt: document.getElementById('editSystemPrompt').value,
        post_history_instructions: document.getElementById('editPostHistoryInstructions').value,
        creator_notes: document.getElementById('editCreatorNotes').value,
        alternate_greetings: getAltGreetingsFromEditor(),
        character_book: getCharacterBookFromEditor()
    };

    // Lock edit fields by default (must come after editor population so dynamic elements are locked)
    setEditLock(true);
}

