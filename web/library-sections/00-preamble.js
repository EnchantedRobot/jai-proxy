// SillyTavern Character Library Logic

// Overlay registry bootstrap - must exist before any registerOverlay() calls
// elsewhere in this file. library-mobile.js (loaded after this script) reuses
// this same array via `window._overlayRegistry = window._overlayRegistry || []`.
window._overlayRegistry = window._overlayRegistry || [];
// Replace-by-id: mobile setup re-registers its overlays on every mode
// flip, and duplicate ids would make stale configs race the fresh ones.
window.registerOverlay = window.registerOverlay || function(cfg) {
    const i = window._overlayRegistry.findIndex(r => r.id === cfg.id);
    if (i !== -1) window._overlayRegistry[i] = cfg;
    else window._overlayRegistry.push(cfg);
};

const API_BASE = '/api'; 
let allCharacters = [];
let currentCharacters = [];

// Virtual scroll state - moved to renderGrid section
let currentScrollHandler = null;

// Card tab state (fields are always editable; no lock)
let originalValues = {};  // Form values baseline for dirty-checking / Revert
let originalRawData = {}; // Raw character data for Revert (alt greetings, lorebook)
let _saveInProgress = false; // re-entrancy guard for performSave (double-tap Apply)
let _editPanePopulated = false; // Deferred - set true after Card pane first populated this open
let editFieldsAutoGrowHandler = null;
let isCardDirty = false; // Card tab dirty flag (Apply/Revert visibility)
let isRawDirty = false; // Raw tab dirty flag (independent of the Card tab)
let _rawTabPopulated = false; // Deferred - set true after Raw tab first populated this open

// Pending avatar (card image) replacement state — set when user picks a new image in the Edit tab.
let pendingAvatarFile = null;
let pendingAvatarPreviewUrl = null;

// Favorites filter state
let showFavoritesOnly = false;

