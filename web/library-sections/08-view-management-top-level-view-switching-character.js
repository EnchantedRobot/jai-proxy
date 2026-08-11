// ========================================
// VIEW MANAGEMENT
// Top-level view switching (characters, online)
// Exposed on window.* so CoreAPI proxies and modules can access it.
// ========================================

let currentView = 'characters';
const viewEnterCallbacks = {}; // view → callback[]
const viewExitCallbacks = {}; // view → callback[]
let lastOnlineProviderId = null;
let providerSelectorInitialized = false;

/**
 * Ask the provider registry to render and activate a view provider into
 * the Online tab containers. Shows a provider selector when 2+ providers
 * have a browsable view. Remembers the last active provider across tab switches.
 * @param {string} [requestedId] — provider ID to activate (defaults to last-used or first)
 */
function activateOnlineProvider(requestedId) {
    const registry = window.ProviderRegistry;
    if (!registry) return;

    const viewProviders = registry.getViewProviders();
    if (viewProviders.length === 0) return;

    const container = document.getElementById('onlineView');
    const filterContent = document.getElementById('onlineFilterContent');
    if (!container) return;

    // Pick which provider to show
    const targetId = requestedId
        || lastOnlineProviderId
        || viewProviders[0].id;

    // Inject provider selector pills (once)
    if (!providerSelectorInitialized && viewProviders.length >= 2) {
        const selectorArea = document.getElementById('providerSelectorArea');
        if (selectorArea) {
            selectorArea.innerHTML = registry.renderProviderSelector(targetId);
            registry.initProviderSelector((id) => activateOnlineProvider(id));
            providerSelectorInitialized = true;
        }
    }

    lastOnlineProviderId = targetId;
    registry.activateProvider(targetId, container, filterContent);
}

/**
 * Switch between top-level views (characters, online).
 * Handles UI toggles for filter areas, buttons, scroll reset, etc.
 * Modules register lazy-load hooks via onViewEnter().
 * @param {string} view - 'characters' | 'online'
 */
function switchView(view) {
    debugLog('[View] Switching to:', view);

    // Fire exit callbacks for the view we're leaving
    const exitCallbacks = viewExitCallbacks[currentView];
    if (exitCallbacks) {
        for (const cb of exitCallbacks) cb();
    }

    currentView = view;

    // Re-render advanced filter panel for new view's field set
    closeAdvFilterPanel();
    rerenderAdvFilterRows();
    updateAdvFilterIndicator();

    // Update toggle buttons
    document.querySelectorAll('.view-toggle-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.view === view);
    });

    // Update search placeholder
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
        if (view === 'characters') {
            searchInput.placeholder = 'Search characters...';
        } else {
            searchInput.placeholder = 'Search library...';
        }
    }

    // Get elements
    const charFilters = document.getElementById('filterArea');
    const onlineFilters = document.getElementById('onlineFilterArea');
    const importBtn = document.getElementById('importBtn');
    const searchSettings = document.querySelector('.search-settings-container');
    const mainSearch = document.querySelector('.search-area');

    hide('characterGrid');
    hide('onlineView');

    // When leaving online view, notify provider to clean up
    if (view !== 'online') {
        window.ProviderRegistry?.deactivateCurrentProvider();
    }

    // Reset scroll position when switching views
    const scrollContainer = document.querySelector('.gallery-content');
    if (scrollContainer) {
        scrollContainer.scrollTop = 0;
    }

    // Hide all filter areas using display:none for cleaner switching
    if (charFilters) charFilters.style.display = 'none';
    if (onlineFilters) onlineFilters.style.display = 'none';

    // Online view needs filters-wrapper to grow so the left/right split works
    const filtersWrapper = document.querySelector('.filters-wrapper');
    if (filtersWrapper) filtersWrapper.style.flex = (view === 'online') ? '1' : '';

    if (view === 'characters') {
        if (charFilters) charFilters.style.display = 'flex';
        if (importBtn) importBtn.style.display = '';
        if (searchSettings) searchSettings.style.display = '';
        if (mainSearch) {
            mainSearch.style.display = '';
            mainSearch.style.visibility = 'visible';
            mainSearch.style.pointerEvents = '';
        }
        show('characterGrid');

        // Re-apply current filters and sort when returning to characters view.
        // Defer so the grid has reflowed after removing 'hidden' class.
        requestAnimationFrame(() => performSearch());

        // If a lightweight incremental add was used (e.g. from a browse import),
        // do the full API refresh now that the user is back on this view and the
        // browse view's memory has been released. The paint above already shows
        // the surgically-added import, so the refresh lands silently behind it.
        if (_needsCharacterRefresh) {
            fetchCharacters(true);
        }
    } else if (view === 'online') {
        if (onlineFilters) onlineFilters.style.display = 'flex';
        if (importBtn) importBtn.style.display = 'none';
        if (searchSettings) searchSettings.style.display = 'none';
        if (mainSearch) {
            mainSearch.style.display = 'none';
        }
        show('onlineView');
        requestAnimationFrame(() => activateOnlineProvider());
    }

    // Fire registered callbacks for this view
    const callbacks = viewEnterCallbacks[view];
    if (callbacks) {
        for (const cb of callbacks) cb();
    }
}

function getCurrentView() {
    return currentView;
}

function onViewEnter(view, callback) {
    if (!viewEnterCallbacks[view]) viewEnterCallbacks[view] = [];
    viewEnterCallbacks[view].push(callback);
}

function onViewExit(view, callback) {
    if (!viewExitCallbacks[view]) viewExitCallbacks[view] = [];
    viewExitCallbacks[view].push(callback);
}

/**
 * Render a loading spinner in a container
 * @param {HTMLElement|string} container - Container element or ID
 * @param {string} message - Loading message to display
 * @param {string} className - Optional custom class (default: 'loading-spinner')
 */
function renderLoadingState(container, message, className = 'loading-spinner') {
    const el = typeof container === 'string' ? document.getElementById(container) : container;
    if (el) {
        const cleaned = String(message ?? '').replace(/[.\u2026]+\s*$/, '');
        el.innerHTML = `
            <div class="${className} cl-loading">
                <div class="cl-loading-icon"><i class="fa-solid fa-layer-group"></i></div>
                <div class="cl-loading-label">${escapeHtml(cleaned)}</div>
                <div class="cl-loading-bar" aria-hidden="true"><span></span></div>
            </div>
        `;
    }
}

/**
 * Render a simple empty state with just a message
 * @param {HTMLElement|string} container - Container element or ID
 * @param {string} message - Message to display
 * @param {string} className - Optional custom class (default: 'empty-state')
 */
function renderSimpleEmpty(container, message, className = 'empty-state') {
    const el = typeof container === 'string' ? document.getElementById(container) : container;
    if (el) {
        el.innerHTML = `<div class="${className}">${escapeHtml(message)}</div>`;
    }
}

/**
 * Skeleton card grid for loading states. Mobile shows shimmer cards;
 * desktop falls back to the hero spinner so canon UX is unchanged.
 * Cards inject as direct children of `container` so the parent's grid
 * layout drives placement (no layout shift when real cards arrive).
 * @param {HTMLElement|string} container
 * @param {number} [count=12]
 * @param {string} [desktopLabel='Loading…'] hero spinner text on desktop
 */
function renderSkeletonGrid(container, count = 12, desktopLabel = 'Loading…') {
    const isMobile = isMobileMode();
    if (!isMobile) {
        renderLoadingState(container, desktopLabel, 'browse-loading');
        return;
    }
    const el = typeof container === 'string' ? document.getElementById(container) : container;
    if (!el) return;
    const cards = Array.from({ length: count }, () => `
        <div class="cl-skeleton-card">
            <div class="cl-skeleton-img"></div>
            <div class="cl-skeleton-meta">
                <div class="cl-skeleton-line"></div>
                <div class="cl-skeleton-line short"></div>
            </div>
        </div>
    `).join('');
    el.innerHTML = cards;
}

/**
 * Rich empty-state UI. Mobile shows icon + headline + hint + CTA; desktop
 * falls back to renderSimpleEmpty using `desktopText` (or `title`).
 * @param {HTMLElement|string} container
 * @param {{icon?:string, title:string, hint?:string, actionLabel?:string,
 *          onAction?:Function, actionIcon?:string, desktopText?:string}} opts
 */
function renderEmptyState(container, opts = {}) {
    const isMobile = isMobileMode();
    if (!isMobile) {
        renderSimpleEmpty(container, opts.desktopText || opts.title || '');
        return;
    }
    const el = typeof container === 'string' ? document.getElementById(container) : container;
    if (!el) return;
    const { icon, title, hint, actionLabel, onAction, actionIcon } = opts;
    const iconClass = icon || 'fa-solid fa-ghost';
    const actionHtml = (actionLabel && onAction)
        ? `<button type="button" class="action-btn primary cl-empty-state-action">${actionIcon ? `<i class="${actionIcon}"></i> ` : ''}${escapeHtml(actionLabel)}</button>`
        : '';
    el.innerHTML = `
        <div class="cl-empty-state">
            <div class="cl-empty-state-icon"><i class="${iconClass}"></i></div>
            <h3 class="cl-empty-state-title">${escapeHtml(title || '')}</h3>
            ${hint ? `<p class="cl-empty-state-hint">${escapeHtml(hint)}</p>` : ''}
            ${actionHtml}
        </div>
    `;
    if (actionLabel && onAction) {
        el.querySelector('.cl-empty-state-action')?.addEventListener('click', onAction);
    }
}

