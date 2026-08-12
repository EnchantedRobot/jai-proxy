// ========================================
// CORE API BRIDGE - DO NOT USE DIRECTLY FROM MODULES
// ========================================
// 
// ARCHITECTURE NOTE:
// These window.* properties are the BRIDGE between library.js (monolith) and CoreAPI.
// 
// ┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
// │   library.js    │ --> │ window.* bridge │ <-- │    core-api.js  │ <-- modules
// │   (monolith)    │     │ (this section)  │     │ (abstraction)   │
// └─────────────────┘     └─────────────────┘     └─────────────────┘
//
// MODULES MUST NOT:
// - Import from library.js directly
// - Access window.* properties directly (except through CoreAPI)
// - Use dependencies.* pattern
//
// MODULES MUST:
// - Import from core-api.js for all library functionality
//
// When adding new functionality for modules:
// 1. Expose the function here on window.*
// 2. Add a wrapper function in core-api.js
// 3. Export it from CoreAPI
// 4. Use CoreAPI.functionName() in modules
//
// This prevents modules from becoming tightly coupled to library.js internals,
// making future refactoring possible without breaking all modules.
// ========================================

// Global Escape handler. Closes the visible registered overlay that is actually painted on
// top, the same thing a click-outside would hit, instead of a hand-assigned tier order that
// drifts from the real stacking. Paint order for these fixed body-level + nested overlays is:
// a descendant always sits above its ancestor; otherwise higher computed z-index wins; exact
// ties break on later DOM order. Tier is no longer consulted here (the mobile back handler in
// library-mobile.js still uses it).
function _overlayZIndex(el) {
    const z = parseInt(getComputedStyle(el).zIndex, 10);
    return Number.isNaN(z) ? 0 : z;
}

function _overlayIsAbove(a, b) {
    const pos = a.compareDocumentPosition(b);
    if (pos & Node.DOCUMENT_POSITION_CONTAINED_BY) return false; // b nested in a, so b paints above
    if (pos & Node.DOCUMENT_POSITION_CONTAINS) return true;      // a nested in b, so a paints above
    const za = _overlayZIndex(a), zb = _overlayZIndex(b);
    if (za !== zb) return za > zb;
    return !!(pos & Node.DOCUMENT_POSITION_PRECEDING);           // b precedes a in DOM, so a is later/on top
}

function _isOverlayVisible(reg, el) {
    return reg.visible
        ? reg.visible(el)
        : el.classList.contains('cl-modal')
            ? el.classList.contains('visible')
            : !el.classList.contains('hidden');
}

function getTopmostOverlay() {
    let top = null;
    for (const reg of (window._overlayRegistry || [])) {
        if (reg.escape === false) continue;
        const el = document.getElementById(reg.id);
        if (!el || !_isOverlayVisible(reg, el)) continue;
        if (!top || _overlayIsAbove(el, top.el)) top = { reg, el };
    }
    return top;
}

document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const top = getTopmostOverlay();
    if (top) {
        e.stopPropagation();
        top.reg.close(top.el);
    }
}, true);

// API & Utilities
window.apiRequest = apiRequest;
window.showToast = showToast;
window.showConfirm = showConfirm;
window.escapeHtml = escapeHtml;
window.utf8ToBase64 = utf8ToBase64;
window.safePurify = safePurify;
window.isExtensionsRecoveryInProgress = function() { return !!window.extensionsRecoveryInProgress; };
window.getCSRFToken = getCSRFToken;
window.sanitizeFolderName = sanitizeFolderName;
window.initCustomSelect = initCustomSelect;
window.closeAllTopbarDropdowns = closeAllTopbarDropdowns;
window.debounce = debounce;
window.truncate = truncate;
window.isMobileMode = isMobileMode;
window.downloadBlobAsFile = downloadBlobAsFile;
window.crc32 = crc32;
window.sanitizeTaglineHtml = sanitizeTaglineHtml;

// Character Data
window.getAllCharacters = function() { return allCharacters; };
window.getCurrentCharacters = function() { return currentCharacters; };
window.getActiveChar = function() { return activeChar; };
window.openAvatarInGalleryViewer = openAvatarInGalleryViewer;
window.fetchCharacters = fetchCharacters;
window.fetchAndAddCharacter = fetchAndAddCharacter;
window.notifySTCharacterAdded = notifySTCharacterAdded;
window.hydrateCharacter = hydrateCharacter;
window.getTags = getTags;
window.getAllAvailableTags = getAllAvailableTags;
window.getGalleryFolderName = getGalleryFolderName;
window.isMediaLocalizationEnabled = isMediaLocalizationEnabled;
window.buildMediaLocalizationMap = buildMediaLocalizationMap;
window.replaceMediaUrlsInText = replaceMediaUrlsInText;
window.getGalleryThumbUrl = getGalleryThumbUrl;
window.createThumbLoader = createThumbLoader;
window.getCharacterGalleryInfo = getCharacterGalleryInfo;
window.getCharacterGalleryId = getCharacterGalleryId;
window.extensionsReady = extensionsReady;
window.getExistingImageFolders = getExistingImageFolders;
window.deleteCharacter = deleteCharacter;
window.showDeleteConfirmation = showDeleteConfirmation;
window.generateGalleryId = generateGalleryId;
window.getCharacterByAvatar = getCharacterByAvatar;

// UI / Modals
window.openModal = openModal;
window.openCharModalElevated = openCharModalElevated;
window.closeModal = closeModal;
window.maybeCloseModal = maybeCloseModal;
window.navigateModal = navigateModal;
window.openProviderLinkModal = openProviderLinkModal;
window.hideModal = hideModal;
window.checkCharacterForDuplicatesAsync = checkCharacterForDuplicatesAsync;
window.showPreImportDuplicateWarning = showPreImportDuplicateWarning;
window.showImportSummaryModal = showImportSummaryModal;
window.queueImportMediaJobs = queueImportMediaJobs;

// View Management
window.switchView = switchView;
window.getCurrentView = getCurrentView;
window.onViewEnter = onViewEnter;
window.onViewExit = onViewExit;

// DOM / Rendering helpers
window.renderLoadingState = renderLoadingState;
window.renderSkeletonGrid = renderSkeletonGrid;
window.renderEmptyState = renderEmptyState;
window.getActiveFilterState = getActiveFilterState;
window.getCharacterAvatarStThumbUrl = getCharacterAvatarStThumbUrl;
window.getCharacterAvatarUrl = getCharacterAvatarUrl;
window.notifySTCharacterEdited = notifySTCharacterEdited;
window.copyTextToClipboard = copyTextToClipboard;
window.isStShallowMode = () => window.stShallowMode === true;
window.getListingNameFromExtensions = getListingNameFromExtensions;
window.bumpAvatarCacheBust = bumpAvatarCacheBust;
window.getDisplayTagline = getDisplayTagline;
window.getCharacterName = getCharacterName;
window.formatRichText = formatRichText;
window.renderLorebookEntriesHtml = renderLorebookEntriesHtml;
window.debugLog = debugLog;
window.performSearch = performSearch;
window.toggleFavoritesFilter = toggleFavoritesFilter;
window.toggleCharacterFavorite = toggleCharacterFavorite;
window.updateCharacterCardFavoriteStatus = updateCharacterCardFavoriteStatus;
window.showElement = show;
window.hideElement = hide;
window.onElement = on;
window.findCardElement = findCardElement;
window.isMultiSelectEnabled = isMultiSelectEnabled;

// Host window / ST context access
window.getHostWindow = getHostWindow;
window.getSTContext = getSTContext;

// Settings
window.getSetting = getSetting;
window.setSetting = setSetting;
window.setSettings = setSettings;
window.getProviderExcludeTags = getProviderExcludeTags;
window.setProviderExcludeTags = setProviderExcludeTags;
window.applyCustomCSS = applyCustomCSS;
window.CUSTOM_CSS_MAX_BYTES = CUSTOM_CSS_MAX_BYTES;

// Import pipeline utilities - PNG manipulation, media download, etc.
window.extractCharacterDataFromPng = extractCharacterDataFromPng;
window.convertImageToPng = convertImageToPng;
window.embedCharacterDataInPng = embedCharacterDataInPng;
window.findCharacterMediaUrls = findCharacterMediaUrls;
window.collectCardTextChunks = collectCardTextChunks;

// Generic import pipeline utilities - used by provider importCharacter() implementations
window.downloadMediaToMemory = downloadMediaToMemory;
window.isUrlSafeForDownload = isUrlSafeForDownload;
window.calculateHash = calculateHash;
window.extractSanitizedUrlName = extractSanitizedUrlName;
window.sanitizeMediaFilename = sanitizeMediaFilename;
window.downloadViaServerRoute = downloadViaServerRoute;
window.downloadBytesViaServerRoute = downloadBytesViaServerRoute;
window.downloadCharacterMedia = downloadCharacterMedia;
window.markMediaLocalizationComplete = markMediaLocalizationComplete;
window.getCompletedMediaLocalizations = getCompletedMediaLocalizations;
window.registerNotificationSection = registerNotificationSection;
window.refreshNotificationsUI = refreshNotificationsUI;
window.openNotificationsDropdown = openNotificationsDropdown;
window.arrayBufferToBase64 = arrayBufferToBase64;
window.ENDPOINTS = ENDPOINTS;

// Creator Notes - shared between local modal and browse preview
window.renderCreatorNotesSecure = renderCreatorNotesSecure;
window.renderCardHtmlSecure = renderCardHtmlSecure;
window.cleanupCreatorNotesContainer = cleanupCreatorNotesContainer;

// Provider System - hooks set by provider modules at load time
// (openChubTokenModal, etc. are set by provider modules)
window.isUpdateLocked = isUpdateLocked;
window.setUpdateLocked = setUpdateLocked;
window.ST_UNSET_SENTINEL = ST_UNSET_SENTINEL;
window.getExtensionDeleteValue = getExtensionDeleteValue;

