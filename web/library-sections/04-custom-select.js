// ========================================================================
// CUSTOM SELECT
// ========================================================================

// Native <select> is hidden but remains the data model - .value and 'change'
// events work transparently so existing code needs no changes.
function initCustomSelect(select) {
    if (!select || select._customSelect) return null;

    // Capture native value accessor before we override it
    const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
    const nativeValueSetter = descriptor.set;
    const nativeValueGetter = descriptor.get;

    const isSmall = select.classList.contains('glass-select-small');

    // --- Build container ---
    const container = document.createElement('div');
    container.className = 'custom-select-container';
    if (select.id) container.dataset.selectId = select.id;

    // Transfer non-glass classes from the select (e.g. browse-filter-hidden)
    for (const cls of select.classList) {
        if (cls !== 'glass-select' && cls !== 'glass-select-small') {
            container.classList.add(cls);
        }
    }

    // --- Trigger button ---
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = `glass-btn custom-select-trigger${isSmall ? ' small' : ''}`;
    if (select.title) trigger.title = select.title;
    trigger.setAttribute('aria-expanded', 'false');
    trigger.innerHTML = `
        <span class="trigger-text"></span>
        <i class="fa-solid fa-chevron-down trigger-arrow"></i>
    `;

    // --- Dropdown menu (appended to body for fixed positioning) ---
    const menu = document.createElement('div');
    menu.className = 'dropdown-menu custom-select-menu hidden';

    // Build / rebuild menu items from the <select>'s <option> / <optgroup> children
    function buildMenu() {
        menu.innerHTML = '';
        for (const child of select.children) {
            if (child.tagName === 'OPTGROUP') {
                const title = document.createElement('div');
                title.className = 'dropdown-section-title';
                title.textContent = child.label;
                menu.appendChild(title);
                for (const opt of child.children) {
                    menu.appendChild(createItem(opt));
                }
            } else if (child.tagName === 'OPTION') {
                menu.appendChild(createItem(child));
            }
        }
    }

    function createItem(option) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'dropdown-item custom-select-item';
        item.dataset.value = option.value;

        const isSelected = option.value === nativeValueGetter.call(select);
        if (isSelected) item.classList.add('selected');

        if (option.disabled) {
            item.classList.add('disabled');
            item.setAttribute('aria-disabled', 'true');
            if (option.title) item.title = option.title;
        }

        const iconClass = option.dataset.icon;
        const iconUrl = option.dataset.iconUrl;
        let iconHtml = '';
        if (iconUrl) {
            iconHtml = `<img src="${iconUrl}" class="item-icon-img" alt="">`;
        } else if (iconClass) {
            iconHtml = `<i class="${iconClass} item-icon"></i>`;
        }

        item.innerHTML = `${iconHtml}<span>${option.textContent}</span>${option.dataset.beta ? '<span class="provider-beta-badge">Beta</span>' : ''}`;

        item.addEventListener('click', (e) => {
            e.stopPropagation();
            if (option.disabled) return;
            nativeValueSetter.call(select, option.value);
            select.dispatchEvent(new Event('change', { bubbles: true }));
            syncVisuals();
            close();
        });
        return item;
    }

    function syncVisuals() {
        const selectedOpt = select.options[select.selectedIndex];
        const triggerText = trigger.querySelector('.trigger-text');
        if (triggerText && selectedOpt) {
            // Show icon image in trigger if available
            const existingImg = trigger.querySelector('.trigger-icon-img');
            if (existingImg) existingImg.remove();
            const iconUrl = selectedOpt.dataset.iconUrl;
            if (iconUrl) {
                const img = document.createElement('img');
                img.src = iconUrl;
                img.className = 'trigger-icon-img';
                img.alt = '';
                trigger.insertBefore(img, triggerText);
            }
            triggerText.textContent = selectedOpt.textContent;
        }
        menu.querySelectorAll('.custom-select-item').forEach(item => {
            const isSelected = item.dataset.value === nativeValueGetter.call(select);
            item.classList.toggle('selected', isSelected);
        });
    }

    function positionMenu() {
        const zoom = parseFloat(document.body.style.zoom) || 1;
        const rawRect = trigger.getBoundingClientRect();
        const rect = { left: rawRect.left / zoom, top: rawRect.top / zoom, bottom: rawRect.bottom / zoom, width: rawRect.width / zoom };
        const viewportH = window.innerHeight / zoom;
        const menuHeight = menu.scrollHeight || 200;
        const spaceBelow = viewportH - rect.bottom - 10;
        const spaceAbove = rect.top - 10;

        menu.style.left = rect.left + 'px';
        menu.style.width = Math.max(rect.width, 180) + 'px';

        if (spaceBelow >= menuHeight || spaceBelow >= spaceAbove) {
            menu.style.top = rect.bottom + 4 + 'px';
            menu.style.bottom = '';
            menu.style.maxHeight = Math.min(350, spaceBelow) + 'px';
        } else {
            menu.style.bottom = (viewportH - rect.top + 4) + 'px';
            menu.style.top = '';
            menu.style.maxHeight = Math.min(350, spaceAbove) + 'px';
        }
    }

    let openedAt = 0;
    let openTriggerRect = null;

    function open() {
        // Close any other open custom selects
        document.querySelectorAll('.custom-select-menu:not(.hidden)').forEach(m => {
            if (m !== menu) m.classList.add('hidden');
        });
        // Close topbar dropdown menus
        TOPBAR_DROPDOWN_IDS.forEach(id => document.getElementById(id)?.classList.add('hidden'));
        window.closeActiveBrowseDropdowns?.();
        menu.classList.remove('hidden');
        trigger.setAttribute('aria-expanded', 'true');
        openedAt = Date.now();
        positionMenu();
        syncVisuals();
        openTriggerRect = trigger.getBoundingClientRect();
        // Manual scroll instead of scrollIntoView to avoid ancestor scroll side-effects
        const selectedItem = menu.querySelector('.custom-select-item.selected');
        if (selectedItem) {
            const itemTop = selectedItem.offsetTop;
            const itemBottom = itemTop + selectedItem.offsetHeight;
            if (itemTop < menu.scrollTop) menu.scrollTop = itemTop;
            else if (itemBottom > menu.scrollTop + menu.clientHeight) menu.scrollTop = itemBottom - menu.clientHeight;
        }
    }

    function close() {
        menu.classList.add('hidden');
        trigger.setAttribute('aria-expanded', 'false');
    }

    function toggle() {
        if (menu.classList.contains('hidden')) open();
        else close();
    }

    buildMenu();
    syncVisuals();

    // --- Event listeners ---
    trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        // Decided at click time, not attach time, so a live mode flip switches sheet/menu.
        if (isMobileMode()) {
            window.openSelectorSheetFromSelect?.(select);
            return;
        }
        toggle();
    });

    window.addEventListener('click', (e) => {
        if (!menu.classList.contains('hidden') && !container.contains(e.target) && !menu.contains(e.target)) {
            close();
        }
    });

    // Close on scroll - only if the trigger's viewport position actually changed
    // (avoids false closes from unrelated scrolls behind fixed-position modals)
    window.addEventListener('scroll', (e) => {
        if (menu.classList.contains('hidden') || e.target === menu || Date.now() - openedAt <= 150) return;
        if (!openTriggerRect) { close(); return; }
        const r = trigger.getBoundingClientRect();
        if (Math.abs(r.top - openTriggerRect.top) > 1 || Math.abs(r.left - openTriggerRect.left) > 1) close();
    }, true);

    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !menu.classList.contains('hidden')) {
            close();
        }
    });

    // --- DOM assembly ---
    container.appendChild(trigger);
    document.body.appendChild(menu);

    select.parentNode.insertBefore(container, select);
    select.style.display = 'none';

    // Lock trigger width to the widest option so it doesn't resize on selection change.
    // Uses IntersectionObserver because selects in hidden views (chats, chub) have zero
    // scrollWidth until their container becomes visible.
    // Skip for .browse-sort-container and .cl-select-fluid selects: they size via CSS + ellipsis instead.
    const triggerText = trigger.querySelector('.trigger-text');
    const skipWidthLock = select.closest('.browse-sort-container') || select.classList.contains('cl-select-fluid');
    function lockTriggerWidth() {
        if (skipWidthLock || trigger.style.minWidth) return;
        let maxW = 0;
        const original = triggerText.textContent;
        for (const opt of select.options) {
            triggerText.textContent = opt.textContent;
            maxW = Math.max(maxW, trigger.scrollWidth);
        }
        triggerText.textContent = original;
        if (maxW > 0) trigger.style.minWidth = maxW + 'px';
    }
    const widthObserver = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting) {
            lockTriggerWidth();
            widthObserver.disconnect();
        }
    });
    widthObserver.observe(trigger);

    // Mode flips invalidate the locked width (measured under the old
    // mode's fonts/layout, it persists as an inline style and overflows
    // eg. the author-banner sort on mobile). Clears + re-measures on reveal.
    function relockWidth() {
        if (skipWidthLock) return;
        trigger.style.minWidth = '';
        const obs = new IntersectionObserver((entries) => {
            if (entries[0].isIntersecting) {
                lockTriggerWidth();
                obs.disconnect();
            }
        });
        obs.observe(trigger);
    }

    // Intercept .value to keep visuals in sync
    Object.defineProperty(select, 'value', {
        get() { return nativeValueGetter.call(this); },
        set(val) {
            nativeValueSetter.call(this, val);
            syncVisuals();
        },
        configurable: true
    });

    // --- Public API stored on the select element ---
    select._customSelect = { container, trigger, menu, open, close, toggle, relockWidth, refresh() { buildMenu(); syncVisuals(); }, update: syncVisuals };

    return container;
}

function initAllCustomSelects() {
    document.querySelectorAll('.glass-select, .glass-select-small').forEach(select => {
        initCustomSelect(select);
    });
}

/**
 * Pre-compute frequently-accessed sort/search keys on each character object.
 * Called once when character data loads (processAndRender), so that performSearch()
 * and sort comparators can use cheap property lookups instead of:
 *   - .toLowerCase() on every filter pass (10k calls per keystroke)
 *   - parseDateValue() inside sort comparator (130k+ calls per sort at 10k chars)
 *   - getTags() + join() + toLowerCase() per character per search
 */
// Stable random-sort keys; re-rolled by reshuffleRandomSort().
const _randomSortKeys = new Map();
function getRandomSortKey(char) {
    const k = char?.avatar;
    if (!k) return 0;
    let v = _randomSortKeys.get(k);
    if (v === undefined) {
        v = Math.random();
        _randomSortKeys.set(k, v);
    }
    return v;
}
// Comparator for the grid's sortSelect value; favorites float first when grouping is on.
// Reads the select + setting once per sort. Pre-computed _dateAdded/_createDate keys keep
// parseDateValue (regex + Date constructor) out of the hot comparator.
function makeCharSortComparator() {
    const sortSelect = document.getElementById('sortSelect');
    const sortType = sortSelect ? sortSelect.value : 'name_asc';
    const groupFavs = getSetting('groupFavoritesFirst') || false;
    return (a, b) => {
        if (groupFavs) {
            const favA = isCharacterFavorite(a), favB = isCharacterFavorite(b);
            if (favA !== favB) return favA ? -1 : 1;
        }
        if (sortType === 'name_asc') return a.name.localeCompare(b.name);
        if (sortType === 'name_desc') return b.name.localeCompare(a.name);
        if (sortType === 'date_new') return b._dateAdded - a._dateAdded;
        if (sortType === 'date_old') return a._dateAdded - b._dateAdded;
        if (sortType === 'created_new') return b._createDate - a._createDate;
        if (sortType === 'created_old') return a._createDate - b._createDate;
        if (sortType === 'tokens_high' || sortType === 'tokens_low') {
            const ta = a._tokenEstimate, tb = b._tokenEstimate;
            const ua = ta == null, ub = tb == null;
            // Unknown sorts last either direction.
            if (ua || ub) return (ua && ub) ? 0 : (ua ? 1 : -1);
            return sortType === 'tokens_high' ? tb - ta : ta - tb;
        }
        if (sortType === 'random') return getRandomSortKey(a) - getRandomSortKey(b);
        return 0;
    };
}
function reshuffleRandomSort() {
    _randomSortKeys.clear();
    if (Array.isArray(allCharacters)) {
        for (const c of allCharacters) {
            if (c?.avatar) _randomSortKeys.set(c.avatar, Math.random());
        }
    }
}

function prepareCharacterKeys(chars) {
    for (let i = 0; i < chars.length; i++) {
        const c = chars[i];
        if (!c) continue;
        // Normalize name to root level (some chars store it only in data.name)
        if (!c.name) c.name = c.data?.name || c.definition?.name || 'Unknown';
        // Pre-compute lowercase fields for text search
        c._lowerName = c.name.toLowerCase();
        c._lowerCreator = String(c.creator || c.data?.creator || '').toLowerCase();
        c._lowerListingName = (getListingNameFromExtensions(c) || '').toLowerCase();
        c._lowerTagline = getDisplayTagline(c).toLowerCase();
        const tags = getTags(c);
        c._tagsLower = tags.length > 0 ? tags.join(' ').toLowerCase() : '';
        c._lowerNotes = String(c.creator_notes || c.data?.creator_notes || '').toLowerCase();
        // Pre-compute numeric timestamps for date sorting
        c._dateAdded = getCharacterDateAdded(c);
        c._createDate = getCharacterCreateDate(c);
        // Shallow cards have no heavy text; undefined = "not known yet" (sorts last / filters out) until recovery fills it.
        if (c.shallow) {
            c._tokenEstimate = _tokenEstimateCache.has(c.avatar) ? _tokenEstimateCache.get(c.avatar) : undefined;
        } else if (typeof c.token_estimate === 'number') {
            // ARCHIVE FORK (see web/VENDORED.md): the archive's list endpoint
            // sends no prose, so computeTokenEstimate() would sum five empty
            // strings and score every card 0. It sends this instead -- the same
            // sum of the same five fields, taken server-side at parse time.
            c._tokenEstimate = c.token_estimate;
            _tokenEstimateCache.set(c.avatar, c._tokenEstimate);
        } else {
            c._tokenEstimate = computeTokenEstimate(c);
            _tokenEstimateCache.set(c.avatar, c._tokenEstimate);
        }
    }
}

