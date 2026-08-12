// web/lib/index.js
// Aggregator for library code migrated off the classic web/library-sections/
// scripts into real ES modules. Every window.* publication for migrated code
// lives here so the bridge surface stays greppable in one place.

import './world-info-api.js';   // side-effect only: window.getWorldInfoData / saveWorldInfoData / listWorldInfoFiles
import './scrollbar-auto-hide.js';   // side-effect only
import './keyboard-navigation.js';   // side-effect only
import { FALLBACK_AVATAR_SVG } from './fallback-images.js';
import { isMobileMode } from './mobile-mode.js';
import { ENDPOINTS } from './api-endpoints.js';
import { highlightText, clearHighlights } from './search-highlighting.js';
import {
    getCharacterCreateDateValue,
    parseDateValue,
    formatDateTime,
    getCharacterDateAdded,
    getCharacterCreateDate,
} from './date-utilities.js';
import {
    initExpandFieldButtons,
    initSectionExpandButtons,
    initBrowseExpandButtons,
} from './expand-field-modal.js';   // also self-publishes window.resetBrowseSectionCollapseState / window.setBrowseAltGreetings

window.FALLBACK_AVATAR_SVG = FALLBACK_AVATAR_SVG;
window.isMobileMode = isMobileMode;
window.ENDPOINTS = ENDPOINTS;
window.highlightText = highlightText;
window.clearHighlights = clearHighlights;
window.getCharacterCreateDateValue = getCharacterCreateDateValue;
window.parseDateValue = parseDateValue;
window.formatDateTime = formatDateTime;
window.getCharacterDateAdded = getCharacterDateAdded;
window.getCharacterCreateDate = getCharacterCreateDate;
window.initExpandFieldButtons = initExpandFieldButtons;
window.initSectionExpandButtons = initSectionExpandButtons;
window.initBrowseExpandButtons = initBrowseExpandButtons;
