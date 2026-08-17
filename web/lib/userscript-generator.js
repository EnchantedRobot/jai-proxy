// web/lib/userscript-generator.js
// Settings -> Userscripts: produce a Tampermonkey bridge configured for THIS
// server and hand it over as copyable text.
//
// The bridges have two constants a user has to set -- the server URL and the
// bulk tag filter -- and both used to be edited in a checkout and rebuilt with
// `make compile`. That is unavailable to the person this feature is for: the
// archive is a container on some other machine, and they have a browser and
// nothing else. The server does the compile (POST /api/v1/userscripts/<key>,
// proxy/userscripts.py); this file is only the form around it.
//
// Everything is self-contained: the three saved values go through setSettings,
// which Object.assigns, so the main Save Settings button never sees them and
// cannot clobber them. Wiring is lazy -- nothing here runs until the settings
// modal is opened for the first time.

const SETTING_KEYS = {
    key: 'userscriptKey',
    server: 'userscriptServerUrl',
    include: 'userscriptIncludeTags',
    exclude: 'userscriptExcludeTags',
};

let specs = [];
let generated = null;   // { filename, source }
let wired = false;

const $ = (id) => document.getElementById(id);

/** "a, b ,, c" -> ["a", "b", "c"]. Blank entries drop out, so a trailing comma
 *  is harmless. The server normalizes again; this is just what gets saved. */
function parseTags(value) {
    return String(value || '')
        .split(',')
        .map(t => t.trim())
        .filter(Boolean);
}

function currentSpec() {
    const select = $('userscriptSelect');
    return specs.find(s => s.key === select?.value) || specs[0] || null;
}

function setStatus(message, tone = '') {
    const el = $('userscriptStatus');
    if (!el) return;
    el.textContent = message;
    el.style.color = tone === 'error' ? 'var(--cl-error-bright, #ff6464)' : '';
}

/** Show/hide the tag-filter row and refresh the blurb for the selected script. */
function syncSpecUI() {
    const spec = currentSpec();
    const row = $('userscriptTagFilterRow');
    const desc = $('userscriptDescription');
    if (desc) desc.textContent = spec ? `${spec.description} Runs on ${spec.site}.` : '';
    // Hidden rather than disabled: a bridge with no bulk sweep has no filter at
    // all, and a greyed-out field invites "why can't I set this".
    if (row) row.style.display = spec && spec.supports_tag_filter ? '' : 'none';
    clearOutput();
}

function clearOutput() {
    generated = null;
    const group = $('userscriptOutputGroup');
    const output = $('userscriptOutput');
    if (output) output.value = '';
    if (group) group.hidden = true;
    const copyBtn = $('userscriptCopyBtn');
    const downloadBtn = $('userscriptDownloadBtn');
    if (copyBtn) copyBtn.disabled = true;
    if (downloadBtn) downloadBtn.disabled = true;
}

function loadSaved() {
    const get = window.getSetting || (() => null);
    const select = $('userscriptSelect');
    const savedKey = get(SETTING_KEYS.key);
    if (select && savedKey && specs.some(s => s.key === savedKey)) select.value = savedKey;

    // No saved URL -> this page's own origin, which is right far more often
    // than not: the browser reached the archive at that address, and the
    // userscript runs in the same browser.
    const server = $('userscriptServerUrl');
    if (server) server.value = get(SETTING_KEYS.server) || window.location.origin;

    const include = $('userscriptIncludeTags');
    const exclude = $('userscriptExcludeTags');
    const savedInclude = get(SETTING_KEYS.include);
    const savedExclude = get(SETTING_KEYS.exclude);
    if (include) include.value = Array.isArray(savedInclude) ? savedInclude.join(', ') : '';
    if (exclude) exclude.value = Array.isArray(savedExclude) ? savedExclude.join(', ') : '';
}

function persist(spec, serverUrl, include, exclude) {
    if (typeof window.setSettings !== 'function') return;
    window.setSettings({
        [SETTING_KEYS.key]: spec.key,
        [SETTING_KEYS.server]: serverUrl,
        [SETTING_KEYS.include]: include,
        [SETTING_KEYS.exclude]: exclude,
    });
}

async function generate() {
    const spec = currentSpec();
    if (!spec) return;
    const serverUrl = ($('userscriptServerUrl')?.value || '').trim();
    const include = parseTags($('userscriptIncludeTags')?.value);
    const exclude = parseTags($('userscriptExcludeTags')?.value);

    if (!serverUrl) {
        setStatus('Enter a server URL first.', 'error');
        return;
    }

    setStatus('Generating…');
    let response;
    try {
        response = await fetch(`/api/v1/userscripts/${encodeURIComponent(spec.key)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                server_url: serverUrl,
                // Always sent, so clearing both lists is honoured rather than
                // silently falling back to the repo defaults.
                include_tags: include,
                exclude_tags: exclude,
            }),
        });
    } catch (err) {
        setStatus(`Could not reach the server: ${err.message}`, 'error');
        return;
    }

    if (!response.ok) {
        let detail = `HTTP ${response.status}`;
        try { detail = (await response.json()).detail || detail; } catch { /* keep the status */ }
        setStatus(detail, 'error');
        return;
    }

    const body = await response.json();
    generated = { filename: body.filename, source: body.source };

    const output = $('userscriptOutput');
    if (output) output.value = body.source;
    const group = $('userscriptOutputGroup');
    if (group) group.hidden = false;
    const title = $('userscriptOutputTitle');
    if (title) title.textContent = body.filename;
    const copyBtn = $('userscriptCopyBtn');
    const downloadBtn = $('userscriptDownloadBtn');
    if (copyBtn) copyBtn.disabled = false;
    if (downloadBtn) downloadBtn.disabled = false;

    persist(spec, serverUrl, include, exclude);
    setStatus(`Generated ${(body.bytes / 1024).toFixed(1)} KB — settings saved.`);
    group?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function copy() {
    if (!generated) return;
    // The archive is normally served over plain http on a LAN, where
    // navigator.clipboard does not exist at all -- copyTextToClipboard's
    // textarea fallback is the path that actually runs, not a nicety.
    const ok = typeof window.copyTextToClipboard === 'function'
        ? await window.copyTextToClipboard(generated.source)
        : false;
    if (ok) {
        setStatus('Copied. Paste it into a new Tampermonkey script.');
        window.showToast?.('Userscript copied to clipboard', 'success');
    } else {
        setStatus('Copy failed — select the text below and copy it by hand.', 'error');
    }
}

function download() {
    if (!generated) return;
    const blob = new Blob([generated.source], { type: 'text/javascript' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = generated.filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    // Tampermonkey offers to install a .user.js opened from disk, but a browser
    // that just saved it will not do that on its own -- say what to do next.
    setStatus(`Saved ${generated.filename}. Open it in the browser to let Tampermonkey install it.`);
}

/** Populate the picker. Runs once, the first time the settings modal opens. */
async function init() {
    if (wired) return;
    wired = true;
    const select = $('userscriptSelect');
    if (!select) return;

    try {
        const response = await fetch('/api/v1/userscripts');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        specs = await response.json();
    } catch (err) {
        setStatus(`Could not load the script list: ${err.message}`, 'error');
        return;
    }

    select.innerHTML = specs
        .map(s => `<option value="${s.key}">${s.label}</option>`)
        .join('');

    // `.glass-select` is swept into a custom dropdown at page init
    // (initAllCustomSelects), long before these options exist -- the native
    // element is then hidden and its menu is what the user actually sees. So
    // the menu has to be rebuilt from the options just added, or the picker
    // renders empty while `select.value` looks perfectly fine.
    if (select._customSelect) select._customSelect.refresh();
    else window.initCustomSelect?.(select);

    loadSaved();
    syncSpecUI();

    select.addEventListener('change', syncSpecUI);
    $('userscriptGenerateBtn')?.addEventListener('click', generate);
    $('userscriptCopyBtn')?.addEventListener('click', copy);
    $('userscriptDownloadBtn')?.addEventListener('click', download);
    $('userscriptUseThisOrigin')?.addEventListener('click', () => {
        const server = $('userscriptServerUrl');
        if (server) server.value = window.location.origin;
        clearOutput();
    });
    // A changed input invalidates whatever is on screen, so the Copy button
    // can never hand over a script that does not match the form.
    for (const id of ['userscriptServerUrl', 'userscriptIncludeTags', 'userscriptExcludeTags']) {
        $(id)?.addEventListener('input', clearOutput);
    }
}

// Lazy: hooked to the settings button rather than page load, so the list
// request only happens for someone who opens settings. The button is in the
// static HTML, so this listener is safe to attach at module load.
document.getElementById('gallerySettingsBtn')?.addEventListener('click', () => { init(); });
// Belt and braces: the settings modal can also be reached without that button
// (the settings search jumps straight to a panel), and init() is idempotent.
document.querySelector('.settings-nav-item[data-section="userscripts"]')
    ?.addEventListener('click', () => { init(); });

export { init as initUserscriptGenerator };
