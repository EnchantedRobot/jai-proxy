// ========================================
// THEME CUSTOMIZER
// ========================================

const TOKEN_DEFS = [
    { section: 'Button XL',  name: '--btn-pad-v-xl', label: 'Pad V',  unit: 'px',  min: 4,    max: 24,   step: 1,    default: 10   },
    { section: 'Button XL',  name: '--btn-pad-h-xl', label: 'Pad H',  unit: 'px',  min: 8,    max: 48,   step: 1,    default: 24   },
    { section: 'Button XL',  name: '--btn-font-xl',  label: 'Font',   unit: 'rem', min: 0.7,  max: 1.1,  step: 0.01, default: 0.9  },
    { section: 'Button LG',  name: '--btn-pad-v-lg', label: 'Pad V',  unit: 'px',  min: 4,    max: 20,   step: 1,    default: 8    },
    { section: 'Button LG',  name: '--btn-pad-h-lg', label: 'Pad H',  unit: 'px',  min: 8,    max: 40,   step: 1,    default: 18   },
    { section: 'Button LG',  name: '--btn-font-lg',  label: 'Font',   unit: 'rem', min: 0.7,  max: 1.1,  step: 0.01, default: 0.85 },
    { section: 'Button MD',  name: '--btn-pad-v-md', label: 'Pad V',  unit: 'px',  min: 4,    max: 20,   step: 1,    default: 8    },
    { section: 'Button MD',  name: '--btn-pad-h-md', label: 'Pad H',  unit: 'px',  min: 8,    max: 40,   step: 1,    default: 15   },
    { section: 'Button MD',  name: '--btn-font-md',  label: 'Font',   unit: 'rem', min: 0.7,  max: 1.1,  step: 0.01, default: 0.85 },
    { section: 'Button SM',  name: '--btn-pad-v-sm', label: 'Pad V',  unit: 'px',  min: 2,    max: 16,   step: 1,    default: 7    },
    { section: 'Button SM',  name: '--btn-pad-h-sm', label: 'Pad H',  unit: 'px',  min: 4,    max: 32,   step: 1,    default: 14   },
    { section: 'Button SM',  name: '--btn-font-sm',  label: 'Font',   unit: 'rem', min: 0.65, max: 1.0,  step: 0.01, default: 0.8  },
    { section: 'Spacing', name: '--space-xs',  label: 'XS',  unit: 'px', min: 1,  max: 16, step: 1, default: 4  },
    { section: 'Spacing', name: '--space-sm',  label: 'SM',  unit: 'px', min: 2,  max: 24, step: 1, default: 8  },
    { section: 'Spacing', name: '--space-md',  label: 'MD',  unit: 'px', min: 4,  max: 32, step: 1, default: 12 },
    { section: 'Spacing', name: '--space-lg',  label: 'LG',  unit: 'px', min: 8,  max: 40, step: 1, default: 16 },
    { section: 'Spacing', name: '--space-xl',  label: 'XL',  unit: 'px', min: 8,  max: 48, step: 1, default: 20 },
    { section: 'Spacing', name: '--space-2xl', label: '2XL', unit: 'px', min: 12, max: 60, step: 1, default: 24 },
];

const CUSTOMIZER_LS_KEY = 'cl-custom-tokens';
let customizerInjected = false;

function applyTokenValue(name, value, unit) {
    setRuntimeToken(name, value + unit);
}

function loadCustomTokens() {
    try {
        const stored = localStorage.getItem(CUSTOMIZER_LS_KEY);
        if (!stored) return;
        const vals = JSON.parse(stored);
        for (const [name, value] of Object.entries(vals)) {
            setRuntimeToken(name, value);
        }
    } catch (e) { /* ignore malformed data */ }
}

const CUSTOM_CSS_MAX_BYTES = 65536;

function sanitizeCustomCSS(raw) {
    let s = typeof raw === 'string' ? raw : '';
    s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
    s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '');
    // Escape orphan </style so a malformed paste can't break out of the wrapper.
    s = s.replace(/<\/style/gi, '<\\/style');
    return s.slice(0, CUSTOM_CSS_MAX_BYTES);
}

function applyCustomCSS() {
    const tag = document.getElementById('cl-custom-css');
    if (!tag) return;
    tag.textContent = sanitizeCustomCSS(getSetting('customCSS') || '');
    updateAccentOverrideWarning();
}

// True if any --accent* declaration is in the active customCSS blob.
function isAccentOverriddenByCustomCSS() {
    const css = getSetting('customCSS') || '';
    return /--accent[\w-]*\s*:/i.test(css);
}

function updateAccentOverrideWarning() {
    const warning = document.getElementById('accentOverrideWarning');
    if (!warning) return;
    warning.classList.toggle('hidden', !isAccentOverriddenByCustomCSS());
}

function saveCustomTokens() {
    const vals = {};
    for (const def of TOKEN_DEFS) {
        const current = getRuntimeToken(def.name);
        if (current) vals[def.name] = current;
    }
    localStorage.setItem(CUSTOMIZER_LS_KEY, JSON.stringify(vals));
    showToast('Token values saved', 'success', 2000);
}

function resetCustomTokens() {
    localStorage.removeItem(CUSTOMIZER_LS_KEY);
    for (const def of TOKEN_DEFS) {
        removeRuntimeToken(def.name);
    }
    syncCustomizerSliders();
    showToast('Tokens reset to defaults', 'info', 2000);
}

function getTokenCurrentValue(def) {
    const override = getRuntimeToken(def.name);
    if (override) return parseFloat(override);
    const computed = getComputedStyle(document.documentElement).getPropertyValue(def.name).trim();
    if (computed) return parseFloat(computed);
    return def.default;
}

function syncCustomizerSliders() {
    if (!customizerInjected) return;
    for (const def of TOKEN_DEFS) {
        const id = def.name.replace(/^--/, '');
        const slider = document.getElementById(`tc-range-${id}`);
        const numInput = document.getElementById(`tc-num-${id}`);
        if (!slider || !numInput) continue;
        const val = getTokenCurrentValue(def);
        slider.value = val;
        numInput.value = val;
    }
}

function buildCustomizerHTML() {
    const sections = [...new Set(TOKEN_DEFS.map(d => d.section))];

    const controlsHTML = sections.map(section => {
        const defs = TOKEN_DEFS.filter(d => d.section === section);
        const rows = defs.map(def => {
            const id = def.name.replace(/^--/, '');
            const val = getTokenCurrentValue(def);
            return `
            <div class="token-control">
                <span class="token-control-label">${def.label}</span>
                <input type="range" id="tc-range-${id}" min="${def.min}" max="${def.max}" step="${def.step}" value="${val}">
                <input type="number" id="tc-num-${id}" min="${def.min}" max="${def.max}" step="${def.step}" value="${val}">
            </div>`;
        }).join('');
        return `<div class="customizer-section">
            <div class="customizer-section-title">${section}</div>
            ${rows}
        </div>`;
    }).join('');

    const spacingVars = ['--space-xs', '--space-sm', '--space-md', '--space-lg', '--space-xl', '--space-2xl'];
    const spacingBlocks = spacingVars.map(n =>
        `<div class="preview-space-block">
            <div class="preview-space-bar" style="height: var(${n});"></div>
            <div class="preview-space-label">${n.replace('--space-', '')}</div>
        </div>`
    ).join('');

    return `
    <div class="theme-customizer-overlay hidden" id="themeCustomizerOverlay">
        <div class="theme-customizer-modal">
            <div class="theme-customizer-header">
                <h2><i class="fa-solid fa-sliders"></i> UI Token Customizer</h2>
                <button class="glass-btn icon-only" id="themeCustomizerCloseBtn" title="Close"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="theme-customizer-body">
                <div class="customizer-controls">
                    ${controlsHTML}
                </div>
                <div class="customizer-preview">
                    <div class="customizer-preview-title">Preview</div>
                    <div class="preview-section">
                        <div class="preview-section-label">XL Buttons</div>
                        <div class="preview-btns-row">
                            <button class="action-btn primary" style="padding: var(--btn-pad-v-xl) var(--btn-pad-h-xl); font-size: var(--btn-font-xl);">Save Changes</button>
                            <button class="action-btn" style="padding: var(--btn-pad-v-xl) var(--btn-pad-h-xl); font-size: var(--btn-font-xl);">Cancel</button>
                        </div>
                    </div>
                    <div class="preview-section">
                        <div class="preview-section-label">LG Buttons (action-btn)</div>
                        <div class="preview-btns-row">
                            <button class="action-btn primary">Import</button>
                            <button class="action-btn">Cancel</button>
                            <button class="action-btn danger">Delete</button>
                        </div>
                    </div>
                    <div class="preview-section">
                        <div class="preview-section-label">MD Buttons (glass-btn / cl-btn)</div>
                        <div class="preview-btns-row">
                            <button class="glass-btn"><i class="fa-solid fa-filter"></i> Filter</button>
                            <button class="glass-btn"><i class="fa-solid fa-sort"></i> Sort</button>
                            <button class="cl-btn cl-btn-primary">Apply</button>
                        </div>
                    </div>
                    <div class="preview-section">
                        <div class="preview-section-label">SM Buttons (action-btn.small)</div>
                        <div class="preview-btns-row">
                            <button class="action-btn small primary">Save</button>
                            <button class="action-btn small">Edit</button>
                            <button class="action-btn small danger">Remove</button>
                        </div>
                    </div>
                    <div class="preview-section">
                        <div class="preview-section-label">Spacing Scale</div>
                        <div class="preview-spacing-row">${spacingBlocks}</div>
                    </div>
                </div>
            </div>
            <div class="theme-customizer-footer">
                <button class="action-btn" id="themeCustomizerResetBtn"><i class="fa-solid fa-rotate-left"></i> Reset Defaults</button>
                <button class="action-btn primary" id="themeCustomizerSaveBtn"><i class="fa-solid fa-floppy-disk"></i> Save</button>
                <button class="action-btn" id="themeCustomizerCloseFooterBtn">Close</button>
            </div>
        </div>
    </div>`;
}

function initThemeCustomizer() {
    if (customizerInjected) return;
    customizerInjected = true;
    document.body.insertAdjacentHTML('beforeend', buildCustomizerHTML());

    for (const def of TOKEN_DEFS) {
        const id = def.name.replace(/^--/, '');
        const slider = document.getElementById(`tc-range-${id}`);
        const numInput = document.getElementById(`tc-num-${id}`);
        if (!slider || !numInput) continue;

        slider.addEventListener('input', () => {
            numInput.value = slider.value;
            applyTokenValue(def.name, slider.value, def.unit);
        });
        numInput.addEventListener('change', () => {
            const v = Math.min(def.max, Math.max(def.min, parseFloat(numInput.value) || def.default));
            numInput.value = v;
            slider.value = v;
            applyTokenValue(def.name, v, def.unit);
        });
    }

    document.getElementById('themeCustomizerCloseBtn').addEventListener('click', closeThemeCustomizer);
    document.getElementById('themeCustomizerCloseFooterBtn').addEventListener('click', closeThemeCustomizer);
    document.getElementById('themeCustomizerResetBtn').addEventListener('click', resetCustomTokens);
    document.getElementById('themeCustomizerSaveBtn').addEventListener('click', saveCustomTokens);
    document.getElementById('themeCustomizerOverlay').addEventListener('click', e => {
        if (e.target.id === 'themeCustomizerOverlay') closeThemeCustomizer();
    });

    window.registerOverlay({ id: 'themeCustomizerOverlay', tier: 5, close: () => closeThemeCustomizer() });
}

// Overlay registrations for library.js modals
window.registerOverlay?.({ id: 'charModal', tier: 8, close: () => maybeCloseModal() });
window.registerOverlay?.({ id: 'disableGalleryFoldersModal', tier: 6, static: false, close: (el) => el?._closeFn ? el._closeFn() : el?.remove() });
window.registerOverlay?.({ id: 'greetingsExpandModal', tier: 5, static: false, close: (el) => el.remove() });
window.registerOverlay?.({ id: 'lorebookExpandModal', tier: 5, static: false, close: (el) => el.remove() });
window.registerOverlay?.({ id: 'expandFieldModal', tier: 5, static: false, close: (el) => el.remove() });
window.registerOverlay?.({ id: 'chubExpandModal', tier: 5, static: false, close: (el) => el.remove() });
window.registerOverlay?.({ id: 'creatorNotesFullscreenModal', tier: 3, static: false, close: (el) => el.remove() });
window.registerOverlay?.({ id: 'contentFullscreenModal', tier: 3, static: false, close: (el) => el.remove() });
window.registerOverlay?.({ id: 'altGreetingsFullscreenModal', tier: 3, static: false, close: (el) => el.remove() });
window.registerOverlay?.({ id: 'importSummaryModal', tier: 4, close: () => handleImportSummaryCloseRequest() });

// Tier 7 so they close before charModal (tier 8) on back/Escape.
const _hideClModalVisible = id => () => document.getElementById(id)?.classList.remove('visible');
window.registerOverlay?.({ id: 'gallerySettingsModal',      tier: 7, close: _hideClModalVisible('gallerySettingsModal') });
window.registerOverlay?.({ id: 'importModal',               tier: 7, close: _hideClModalVisible('importModal') });
window.registerOverlay?.({ id: 'localizeModal',             tier: 7, close: _hideClModalVisible('localizeModal') });
window.registerOverlay?.({ id: 'bulkLocalizeModal',         tier: 7, close: _hideClModalVisible('bulkLocalizeModal') });
window.registerOverlay?.({ id: 'bulkLocalizeSummaryModal',  tier: 7, close: _hideClModalVisible('bulkLocalizeSummaryModal') });
window.registerOverlay?.({ id: 'bulkAutoLinkModal',         tier: 7, close: _hideClModalVisible('bulkAutoLinkModal') });
window.registerOverlay?.({ id: 'charDuplicatesModal',       tier: 7, close: () => closeCharDuplicatesModal() });
window.registerOverlay?.({ id: 'preImportDuplicateModal',   tier: 7, close: _hideClModalVisible('preImportDuplicateModal') });
window.registerOverlay?.({ id: 'providerLinkModal',         tier: 7, close: _hideClModalVisible('providerLinkModal') });

// Static .confirm-modal in HTML (uses .hidden toggle, not .visible).
window.registerOverlay?.({ id: 'confirmSaveModal', tier: 7, close: (el) => el?.classList.add('hidden') });

// Dynamic confirm-modals (created/removed each invocation; registry entry persists).
window.registerOverlay?.({ id: 'deleteConfirmModal',  tier: 7, static: false, close: (el) => el?.remove() });
window.registerOverlay?.({ id: 'deleteDuplicateModal', tier: 7, static: false, close: (el) => el?.remove() });
window.registerOverlay?.({ id: 'folderMappingModal',   tier: 7, static: false, close: (el) => el?._closeFn ? el._closeFn() : el?.remove() });
window.registerOverlay?.({ id: 'orphanedFoldersModal', tier: 7, static: false, close: (el) => el?._closeFn ? el._closeFn() : el?.remove() });

function openThemeCustomizer() {
    initThemeCustomizer();
    syncCustomizerSliders();
    document.getElementById('themeCustomizerOverlay').classList.remove('hidden');
}

function closeThemeCustomizer() {
    const el = document.getElementById('themeCustomizerOverlay');
    if (el) el.classList.add('hidden');
}

// Emergency console escape hatches when custom CSS has broken the UI.
window.clDisableCSS = function () {
    const tag = document.getElementById('cl-custom-css');
    if (tag) tag.textContent = '';
    console.info('[CL] Custom CSS disabled for this session. Reload to revert, or run clResetCSS() to clear it permanently.');
    return 'Custom CSS disabled (session-only)';
};
window.clResetCSS = function () {
    try {
        setSetting('customCSS', '');
        applyCustomCSS();
        console.info('[CL] Custom CSS cleared. Snippets in the editor are preserved; re-Apply them after fixing.');
        return 'Custom CSS cleared permanently';
    } catch (e) {
        console.error('[CL] clResetCSS failed:', e);
        return 'Failed, see error above';
    }
};

