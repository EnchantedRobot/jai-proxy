// ==============================================
// Utility Functions
// ==============================================

const PROVIDER_EXT_KEYS = ['chub', 'janitorai', 'jannyai', 'pygmalion', 'wyvern', 'chartavern', 'datacat', 'saucepan', 'botbooru'];

function getListingNameFromExtensions(char) {
    const ext = char?.data?.extensions;
    if (!ext) return null;
    const activeProvider = window.ProviderRegistry?.getCharacterProvider(char);
    if (activeProvider?.linkInfo) {
        const pn = ext[activeProvider.provider.id]?.pageName;
        if (pn) return pn;
    }
    // CL-owned fallback checked before other provider namespaces, so a migrated cl value wins over a stale leftover.
    if (ext.cl?.pageName) return ext.cl.pageName;
    for (const key of PROVIDER_EXT_KEYS) {
        if (ext[key]?.pageName) return ext[key].pageName;
    }
    return null;
}

function getCharacterName(char, fallback = 'Unknown') {
    if (!char) return fallback;
    const prefs = getSetting('namePreferences') || {};
    const pref = prefs[char.avatar]
        || getSetting('displayNamePreference')
        || 'card';
    if (pref === 'listing') {
        const listingName = getListingNameFromExtensions(char);
        if (listingName) return listingName;
    }
    return char.name || char.data?.name || char.definition?.name || fallback;
}

// ARCHIVE FORK (see web/VENDORED.md): upstream inlined the gallery file URL
// `/user/images/<folder>/<file>` at a dozen call sites. Most of them become the
// src of an <img>, <video> or <audio>, which never passes through fetch(), so
// archive-api.js cannot rewrite them -- hence one helper, pointed at the
// archive. Note this is deliberately NOT used for the `deletePath` variables:
// those are request payloads naming a file, not URLs to load.
function galleryFileUrl(folder, fileName) {
    return `/api/v1/galleries/${encodeURIComponent(folder)}/files/${encodeURIComponent(fileName)}`;
}

// ARCHIVE FORK (see web/VENDORED.md): the three getCharacterAvatar*Url helpers
// below are the only place image URLs are built, and their results become
// <img src> attributes -- which never pass through fetch(), so archive-api.js
// cannot rewrite them. They point at the archive directly instead.
function getCharacterAvatarUrl(avatar) {
    if (!avatar) return '';
    const bust = _avatarCacheBust.get(avatar);
    return bust
        ? `/api/v1/characters/${encodeURIComponent(avatar)}/png?v=${bust}`
        : `/api/v1/characters/${encodeURIComponent(avatar)}/png`;
}

// Tagline lives in the active provider namespace (cl when unlinked).
function getDisplayTagline(char) {
    if (!char?.data?.extensions) return '';
    const activeId = window.ProviderRegistry?.getActiveTaglineNamespace?.(char) ?? 'cl';
    return char?.data?.extensions?.[activeId]?.tagline || '';
}

// Collapses and (re)wires the tagline row's expand toggle. onclick assignment replaces, never stacks.
function wireProviderTaglineExpand() {
    const taglineRow = document.getElementById('modalProviderTaglineRow');
    if (!taglineRow) return;
    taglineRow.classList.remove('expanded');
    taglineRow.setAttribute('aria-expanded', 'false');
    taglineRow.setAttribute('role', 'button');
    taglineRow.onclick = () => {
        const isExpanded = taglineRow.classList.toggle('expanded');
        taglineRow.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
    };
}

function renderProviderTaglineRow(char) {
    const taglineRow = document.getElementById('modalProviderTaglineRow');
    const taglineEl = document.getElementById('modalProviderTagline');
    if (!taglineRow || !taglineEl) return;
    const providerTagline = getDisplayTagline(char);
    if (getSetting('showProviderTagline') !== false && providerTagline) {
        taglineEl.innerHTML = sanitizeTaglineHtml(providerTagline, char.name);
        taglineRow.style.display = 'block';
    } else {
        taglineEl.textContent = '';
        taglineRow.style.display = 'none';
    }
}

// ST's built-in /thumbnail (96x144). For small avatars (chat list rows, modal header thumb, message bubbles, dupe-finder cards, recommender results) where even the hi-res thumb is overkill. Soft above ~64px target on retina; use getCharacterAvatarThumbUrl instead for hero-sized previews.
function getCharacterAvatarStThumbUrl(avatar) {
    if (!avatar) return '';
    const bust = _avatarCacheBust.get(avatar);
    // ARCHIVE FORK: no `size`, so this is the inherited 96x144 cache -- already
    // populated for all 3,839 cards, so these cost a file read and nothing else.
    return bust
        ? `/api/v1/characters/${encodeURIComponent(avatar)}/thumb?v=${bust}`
        : `/api/v1/characters/${encodeURIComponent(avatar)}/thumb`;
}

// Returns the URL the grid should request, picking based on the three-tier
// thumbnail setting. Callers should gate on getSetting('useGridThumbnails')
// first; this helper assumes the user wants a thumb.
function getCharacterAvatarThumbUrl(avatar) {
    if (!avatar) return '';
    const bust = _avatarCacheBust.get(avatar);
    const tail = bust ? `&v=${bust}` : '';
    // ARCHIVE FORK: one endpoint serves both tiers. The larger one is rendered
    // on demand into its own cache the first time a tile asks for it; the
    // smaller is the inherited 96x144 cache, which is already complete.
    if (getSetting('gridThumbnailsHiRes') !== false) {
        const size = getSetting('gridThumbnailSize') || 512;
        return `/api/v1/characters/${encodeURIComponent(avatar)}/thumb?size=${size}${tail}`;
    }
    return `/api/v1/characters/${encodeURIComponent(avatar)}/thumb${tail ? `?${tail.slice(1)}` : ''}`;
}

// Per-avatar cache-bust tokens for in-place image swaps, persisted so the new image survives a reload.
const AVATAR_CACHEBUST_KEY = 'cl_avatarCacheBust';
const AVATAR_CACHEBUST_CAP = 600;
const _avatarCacheBust = (() => {
    try {
        const raw = localStorage.getItem(AVATAR_CACHEBUST_KEY);
        if (raw) return new Map(Object.entries(JSON.parse(raw)));
    } catch {}
    return new Map();
})();
function bumpAvatarCacheBust(avatar) {
    if (!avatar) return;
    _avatarCacheBust.set(avatar, Date.now());
    if (_avatarCacheBust.size > AVATAR_CACHEBUST_CAP) {
        // Drop oldest; those swaps aged out of the browser cache long ago.
        const stale = [..._avatarCacheBust.entries()].sort((a, b) => a[1] - b[1]).slice(0, _avatarCacheBust.size - AVATAR_CACHEBUST_CAP);
        for (const [k] of stale) _avatarCacheBust.delete(k);
    }
    try { localStorage.setItem(AVATAR_CACHEBUST_KEY, JSON.stringify(Object.fromEntries(_avatarCacheBust))); } catch {}
}

/**
 * Render a lorebook entry as HTML
 * @param {Object} entry - Lorebook entry object
 * @param {number} index - Entry index
 * @returns {string} HTML string
 */
function renderLorebookEntryHtml(entry, index) {
    const keys = entry.keys || entry.key || [];
    const keyArr = Array.isArray(keys) ? keys : (keys ? [keys] : []);
    // V2 embedded uses secondary_keys; native world uses keysecondary.
    const secondaryKeys = entry.secondary_keys || entry.keysecondary || [];
    const secondaryKeyArr = Array.isArray(secondaryKeys) ? secondaryKeys : (secondaryKeys ? [secondaryKeys] : []);
    const content = entry.content || '';
    const name = entry.comment || entry.name || `Entry ${index + 1}`;
    // Embedded V2 entries use `enabled`; native world entries use `disable` (inverted).
    const enabled = entry.disable !== undefined ? !entry.disable : entry.enabled !== false;
    // "Selective" is only meaningful when secondary keys actually exist (filters the match).
    const selective = secondaryKeyArr.length > 0;
    const constant = entry.constant;

    // Build status indicators for expanded area (simple icon + text)
    let statusItems = [];
    if (selective) statusItems.push('<span class="lb-stat-sel" title="Selective: triggers only when both primary AND secondary keys match"><i class="fa-solid fa-filter"></i>Selective</span>');
    if (constant) statusItems.push('<span class="lb-stat-const" title="Constant: always injected into context"><i class="fa-solid fa-thumbtack"></i>Constant</span>');
    statusItems.push(`<span class="${enabled ? 'lb-stat-on' : 'lb-stat-off'}" title="${enabled ? 'Entry is active' : 'Entry is disabled'}"><i class="fa-solid fa-${enabled ? 'circle-check' : 'circle-xmark'}"></i>${enabled ? 'Active' : 'Off'}</span>`);
    const statusRow = statusItems.join('<span style="color:#444"> · </span>');
    
    // Build key chips
    const keyChips = keyArr.length 
        ? keyArr.map(k => `<span class="lb-key-chip">${escapeHtml(k.trim())}</span>`).join('')
        : '<span class="lb-empty-keys">no keys</span>';
    
    const secondaryChips = secondaryKeyArr.length
        ? secondaryKeyArr.map(k => `<span class="lb-key-chip lb-secondary">${escapeHtml(k.trim())}</span>`).join('')
        : '';
    
    return `<details class="lb-entry${enabled ? '' : ' lb-disabled'}"><summary><i class="fa-solid fa-caret-right lb-arrow"></i><i class="fa-solid fa-file-lines lb-icon"></i><span class="lb-name">${escapeHtml(name.trim())}</span></summary><div class="lb-entry-body"><div class="lb-status-row">${statusRow}</div><div class="lb-section"><div class="lb-section-header"><i class="fa-solid fa-key"></i> Keys</div><div class="lb-keys-list">${keyChips}</div></div>${secondaryChips ? `<div class="lb-section"><div class="lb-section-header"><i class="fa-solid fa-key"></i> Secondary Keys</div><div class="lb-keys-list">${secondaryChips}</div></div>` : ''}<div class="lb-section"><div class="lb-section-header"><i class="fa-solid fa-align-left"></i> Content</div><div class="lb-content-box">${escapeHtml(content.trim()) || '<em>No content</em>'}</div></div></div></details>`;
}

/**
 * Render lorebook entries for modal display
 * @param {Array} entries - Array of lorebook entries
 * @returns {string} HTML string
 */
function renderLorebookEntriesHtml(entries) {
    if (!entries || !entries.length) return '';
    return entries.map((entry, i) => renderLorebookEntryHtml(entry, i)).join('');
}

// Handles both class systems (cl-modal uses .visible, confirm-modal uses .hidden).
function hideModal(modalId) {
    const el = document.getElementById(modalId);
    if (!el) return;
    if (el.classList.contains('cl-modal')) el.classList.remove('visible');
    else el.classList.add('hidden');
}

// Escape HTML characters
function escapeHtml(text) {
    if (!text) return "";
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

/**
 * Sanitize HTML safely. Fails closed (escapes) when DOMPurify is unavailable.
 * Also forces rel="noopener noreferrer" on any <a> with a target attribute
 * to prevent tab-nabbing from card-supplied links.
 * @param {string} html - Pre-formatted HTML to sanitize
 * @param {object} [config] - DOMPurify config
 * @returns {string} Sanitized HTML, or escaped text if DOMPurify is missing
 */
function safePurify(html, config) {
    if (html == null || html === '') return '';
    if (typeof DOMPurify === 'undefined' || !DOMPurify || typeof DOMPurify.sanitize !== 'function') {
        return escapeHtml(String(html));
    }
    let sanitized = DOMPurify.sanitize(html, config || {});
    // Tab-nabbing post-pass: every <a target="..."> must have rel="noopener noreferrer"
    if (typeof sanitized === 'string' && sanitized.indexOf('<a') !== -1 && sanitized.indexOf('target') !== -1) {
        const tmp = document.createElement('div');
        tmp.innerHTML = sanitized;
        tmp.querySelectorAll('a[target]').forEach(a => {
            a.setAttribute('rel', 'noopener noreferrer');
        });
        sanitized = tmp.innerHTML;
    }
    return sanitized;
}

function formatNumber(num) {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num.toString();
}

/**
 * Sanitize a character name to match SillyTavern's folder naming convention
 * SillyTavern removes characters that are illegal in Windows folder names
 * @param {string} name - Character name
 * @returns {string} Sanitized folder name
 */
function sanitizeFolderName(name) {
    if (!name) return '';
    // Remove characters illegal in Windows folder names: \ / : * ? " < > |
    return name.replace(/[\\/:*?"<>|]/g, '').trim();
}

/**
 * Extract plain text from HTML/CSS content for tooltips
 * Strips all styling, tags, markdown, URLs and normalizes whitespace
 */
function extractPlainText(html, maxLength = 200) {
    if (!html) return '';
    
    let text = html
        // Remove style tags and their contents
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        // Remove script tags and their contents
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        // Remove CSS blocks (sometimes inline)
        .replace(/\{[^}]*\}/g, '')
        // Remove HTML comments
        .replace(/<!--[\s\S]*?-->/g, '')
        // Remove all HTML tags
        .replace(/<[^>]+>/g, ' ')
        // Remove markdown images: ![alt](url) or ![alt]
        .replace(/!\[[^\]]*\]\((?:(?:[^()]|\([^()]*\))*|[^)]*)\)/g, '')
        .replace(/!\[[^\]]*\]/g, '')
        // Remove markdown links but keep text: [text](url) -> text
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        // Remove standalone URLs (http/https)
        .replace(/https?:\/\/[^\s<>"')\]]+/gi, '')
        // Remove data URIs
        .replace(/data:[^\s<>"')\]]+/gi, '')
        // Decode common HTML entities
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#039;/gi, "'")
        .replace(/&apos;/gi, "'")
        // Remove any remaining CSS-like content (selectors, properties)
        .replace(/[.#][\w-]+\s*\{/g, '')
        .replace(/[\w-]+\s*:\s*[^;]+;/g, '')
        // Normalize whitespace
        .replace(/\s+/g, ' ')
        .trim();
    
    if (text.length > maxLength) {
        // Cut at word boundary if possible
        const truncated = text.substring(0, maxLength);
        const lastSpace = truncated.lastIndexOf(' ');
        text = (lastSpace > maxLength * 0.7 ? truncated.substring(0, lastSpace) : truncated) + '...';
    }
    
    return text;
}

// Format text with rich HTML rendering (for display, not editing)
function formatRichText(text, charName = '', preserveHtml = false) {
    if (!text) return "";
    
    let processedText = text.trim();
    
    // Normalize line endings (Windows \r\n and old Mac \r to Unix \n)
    processedText = processedText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    
    // Normalize whitespace: collapse multiple blank lines into max 2, trim trailing spaces
    processedText = processedText
        .replace(/[ \t]+$/gm, '')           // Remove trailing spaces/tabs from each line
        .replace(/\n{4,}/g, '\n\n\n')       // Collapse 4+ newlines to 3 (double paragraph break)
        .replace(/[ \t]{2,}/g, ' ');        // Collapse multiple spaces/tabs to single space
    
    // If preserving HTML (for creator notes with custom styling), use hybrid approach
    if (preserveHtml) {
        // Detect content type for appropriate processing
        // Ultra CSS: <style> tag near the START of content (first 200 chars) = fully styled card
        const hasStyleTagAtStart = /^[\s\S]{0,200}<style[^>]*>[\s\S]{50,}<\/style>/i.test(processedText);
        // Style tag anywhere (for later exclusion from markdown processing)
        const hasStyleTag = /<style[^>]*>[\s\S]*?<\/style>/i.test(processedText);
        const hasSignificantHtml = /<(div|table|center|font)[^>]*>/i.test(processedText);
        const hasInlineStyles = /style\s*=\s*["'][^"']*(?:display|position|flex|grid)[^"']*["']/i.test(processedText);
        
        // Ultra CSS mode: <style> tag at START with substantial CSS - touch almost nothing
        if (hasStyleTagAtStart) {
            // Only convert markdown images (safe - won't be in CSS)
            processedText = processedText.replace(/!\[([^\]]*)\]\(((?:[^\s()]|\([^\s()]*\))+|[^)\s]+)(?:\s*=[^)]*)?(?:\s+"[^"]*")?\)/g, (match, alt, src) => {
                // Allow http/https URLs and local paths (starting with /)
                if (!src.match(/^(https?:\/\/|\/)/i)) return match;
                const altAttr = alt ? ` alt="${alt.replace(/"/g, '&quot;')}"` : '';
                return `<img src="${src}"${altAttr} class="embedded-image" loading="lazy">`;
            });
            
            // Replace {{user}} and {{char}} placeholders (safe)
            const personaName = getPersonaName();
            processedText = processedText.replace(/\{\{user\}\}/gi, `<span class="placeholder-user">${personaName}</span>`);
            processedText = processedText.replace(/\{\{char\}\}/gi, `<span class="placeholder-char">${charName || '{{char}}'}</span>`);
            
            return processedText;
        }
        
        // For content with <style> at the end (footer banners), extract and protect it
        let styleBlocks = [];
        if (hasStyleTag) {
            processedText = processedText.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, (match) => {
                const placeholder = `\x00STYLEBLOCK${styleBlocks.length}\x00`;
                styleBlocks.push(match);
                return placeholder;
            });
        }
        
        // Pure CSS mode: has inline styles with layout properties - skip text formatting
        const isPureCssMode = hasInlineStyles;
        // HTML mode: has HTML structure tags  
        const isHtmlMode = hasSignificantHtml;
        
        // Convert markdown images and links (safe for all modes):
        
        // Convert linked images: [![alt](img-url)](link-url)
        processedText = processedText.replace(/\[\!\[([^\]]*)\]\(((?:[^\s()]|\([^\s()]*\))+|[^)\s]+)(?:\s*=[^)]*)?(?:\s+"[^"]*")?\)\]\(([^)]+)\)/g, (match, alt, imgSrc, linkHref) => {
            // Allow http/https URLs and local paths (starting with /)
            if (!imgSrc.match(/^(https?:\/\/|\/)/i)) return match;
            const altAttr = alt ? ` alt="${alt.replace(/"/g, '&quot;')}"` : '';
            const safeLink = linkHref.match(/^https?:\/\//i) ? linkHref : '#';
            return `<a href="${safeLink}" target="_blank" rel="noopener"><img src="${imgSrc}"${altAttr} class="embedded-image" loading="lazy"></a>`;
        });
        
        // Convert standalone markdown images: ![alt](url) or ![alt](url =WxH) or ![alt](url "title")
        processedText = processedText.replace(/!\[([^\]]*)\]\(((?:[^\s()]|\([^\s()]*\))+|[^)\s]+)(?:\s*=[^)]*)?(?:\s+"[^"]*")?\)/g, (match, alt, src) => {
            // Allow http/https URLs and local paths (starting with /)
            if (!src.match(/^(https?:\/\/|\/)/i)) return match;
            const altAttr = alt ? ` alt="${alt.replace(/"/g, '&quot;')}"` : '';
            return `<img src="${src}"${altAttr} class="embedded-image" loading="lazy">`;
        });
        
        // Convert markdown links: [text](url) - but not image links we just processed
        processedText = processedText.replace(/(?<!!)\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (match, text, href) => {
            return `<a href="${href}" target="_blank" rel="noopener" class="embedded-link">${text}</a>`;
        });
        
        // Apply markdown text formatting (but not in pure CSS mode)
        if (!isPureCssMode) {
            // Bold: **text** or __text__
            processedText = processedText.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
            processedText = processedText.replace(/__(.+?)__/g, '<strong>$1</strong>');
            
            // Italic: *text* or _text_ (careful not to match inside URLs, paths, or HTML attributes)
            // Use negative lookbehind for word chars, underscores, slashes, quotes, equals to avoid matching in URLs/paths
            processedText = processedText.replace(/(?<![\w*/"=])\*([^*\n]+?)\*(?![\w*])/g, '<em>$1</em>');
            processedText = processedText.replace(/(?<![\w_\/."'=])\s_([^_\n]+?)_(?![\w_])/g, ' <em>$1</em>');
            
            // Strikethrough: ~~text~~
            processedText = processedText.replace(/~~([^~]+?)~~/g, '<del>$1</del>');
        }
        
        // Replace {{user}} and {{char}} placeholders
        const personaName = getPersonaName();
        processedText = processedText.replace(/\{\{user\}\}/gi, `<span class="placeholder-user">${personaName}</span>`);
        processedText = processedText.replace(/\{\{char\}\}/gi, `<span class="placeholder-char">${charName || '{{char}}'}</span>`);
        
        // Newline handling based on mode
        // Only skip newlines if it's heavily structured HTML (many divs/tables) or has layout CSS
        const divCount = (processedText.match(/<div/gi) || []).length;
        const isHeavyHtml = divCount > 5 || /<table[^>]*>/i.test(processedText);
        
        if (isPureCssMode || isHeavyHtml) {
            // Pure CSS or heavy HTML mode: Don't convert newlines - layout handles it
        } else {
            // Mixed/Light HTML / Markdown mode: Convert newlines
            // But be careful around HTML tags - don't add breaks inside tag sequences
            processedText = processedText.replace(/\n\n+/g, '<br><br>');
            processedText = processedText.replace(/([^>])\n([^<])/g, '$1<br>$2');
        }
        
        // Restore style blocks
        styleBlocks.forEach((block, i) => {
            processedText = processedText.replace(`\x00STYLEBLOCK${i}\x00`, block);
        });
        
        return processedText;
    }
    
    // Standard mode: escape HTML for safety
    const placeholders = [];
    
    // Helper to add placeholder
    const addPlaceholder = (html) => {
        const placeholder = `__PLACEHOLDER_${placeholders.length}__`;
        placeholders.push(html);
        return placeholder;
    };
    
    // 1. Preserve existing HTML img tags (allow http/https and local paths)
    processedText = processedText.replace(/<img\s+[^>]*src=["']((?:https?:\/\/|\/)[^"']+)["'][^>]*\/?>/gi, (match, src) => {
        return addPlaceholder(`<img src="${src}" class="embedded-image" loading="lazy">`);
    });
    
    // 1b. Rebuild audio players from their (safe) src only, dropping author attributes so a crafted
    // <audio onerror> cant ride a verbatim tag past the escape step (img/source handlers already do this).
    processedText = processedText.replace(/<audio[^>]*>[\s\S]*?<\/audio>/gi, (match) => {
        const m = match.match(/\ssrc=["']((?:https?:\/\/|\/)[^"']+)["']/i);
        if (!m) return '';
        const src = m[1];
        const ext = (src.split(/[?#]/)[0].split('.').pop() || '').toLowerCase();
        const typeAttr = /^(mp3|wav|ogg|m4a|flac|aac)$/.test(ext) ? ` type="audio/${ext}"` : '';
        return addPlaceholder(`<audio controls class="audio-player embedded-audio" preload="metadata"><source src="${src}"${typeAttr}>Your browser does not support audio.</audio>`);
    });
    
    // 1c. Convert audio source tags to full audio players
    processedText = processedText.replace(/<source\s+[^>]*src=["']((?:https?:\/\/|\/)[^"']+\.(?:mp3|wav|ogg|m4a|flac|aac))["'][^>]*\/?>/gi, (match, src) => {
        const ext = src.split('.').pop().toLowerCase();
        return addPlaceholder(`<audio controls class="audio-player embedded-audio" preload="metadata"><source src="${src}" type="audio/${ext}">Your browser does not support audio.</audio>`);
    });
    
    // 2. Convert linked images: [![alt](img-url)](link-url)
    processedText = processedText.replace(/\[\!\[([^\]]*)\]\(((?:[^()]|\([^()]*\))+|[^)]+)\)\]\(([^)]+)\)/g, (match, alt, imgSrc, linkHref) => {
        // Allow http/https URLs and local paths (starting with /)
        if (!imgSrc.match(/^(https?:\/\/|\/)/i)) return match;
        const altAttr = alt ? ` alt="${alt.replace(/"/g, '&quot;')}"` : '';
        const safeLink = linkHref.match(/^https?:\/\//i) ? linkHref : '#';
        return addPlaceholder(`<a href="${safeLink}" target="_blank" rel="noopener"><img src="${imgSrc}"${altAttr} class="embedded-image" loading="lazy"></a>`);
    });
    
    // 3. Convert standalone markdown images: ![alt](url) or ![alt](url "title")
    processedText = processedText.replace(/!\[([^\]]*)\]\(((?:[^\s()]|\([^\s()]*\))+|[^)\s]+)(?:\s+"[^"]*")?\)/g, (match, alt, src) => {
        // Allow http/https URLs and local paths (starting with /)
        if (!src.match(/^(https?:\/\/|\/)/i)) return match;
        const altAttr = alt ? ` alt="${alt.replace(/"/g, '&quot;')}"` : '';
        return addPlaceholder(`<img src="${src}"${altAttr} class="embedded-image" loading="lazy">`);
    });
    
    // 3b. Convert markdown audio links: [any text](url.mp3) or [??](url.mp3)
    processedText = processedText.replace(/\[([^\]]*)\]\(((?:https?:\/\/|\/)[^)\s]+\.(?:mp3|wav|ogg|m4a|flac|aac))(?:\s+"[^"]*)?\)/gi, (match, text, src) => {
        const ext = src.split('.').pop().toLowerCase();
        return addPlaceholder(`<audio controls class="audio-player embedded-audio" preload="metadata" title="${escapeHtml(text || 'Audio')}"><source src="${src}" type="audio/${ext}">Your browser does not support audio.</audio>`);
    });
    
    // 4. Convert markdown links: [text](url)
    processedText = processedText.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (match, text, href) => {
        return addPlaceholder(`<a href="${href}" target="_blank" rel="noopener" class="embedded-link">${escapeHtml(text)}</a>`);
    });
    
    // 5. Preserve HTML heading tags
    processedText = processedText.replace(/<(h[1-6])>([^<]*)<\/\1>/gi, (match, tag, content) => {
        return addPlaceholder(`<${tag} class="embedded-heading">${escapeHtml(content)}</${tag}>`);
    });
    
    // Escape HTML to prevent XSS
    let formatted = escapeHtml(processedText);
    
    // Restore all placeholders
    placeholders.forEach((html, i) => {
        formatted = formatted.replace(`__PLACEHOLDER_${i}__`, html);
    });
    
    // Replace {{user}} and {{char}} placeholders
    const personaName = getPersonaName();
    formatted = formatted.replace(/\{\{user\}\}/gi, `<span class="placeholder-user">${personaName}</span>`);
    formatted = formatted.replace(/\{\{char\}\}/gi, `<span class="placeholder-char">${charName || '{{char}}'}</span>`);
    
    // Convert markdown-style formatting
    // Bold: **text** or __text__
    formatted = formatted.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    formatted = formatted.replace(/__(.+?)__/g, '<strong>$1</strong>');
    
    // Italic: *text* or _text_ (but not inside words or URLs)
    // Skip if underscore is part of a URL path or filename pattern
    // Require whitespace before underscore to avoid matching in file paths like localized_media_123
    formatted = formatted.replace(/(?<![\w*])\*([^*]+?)\*(?![\w*])/g, '<em>$1</em>');
    formatted = formatted.replace(/(?:^|(?<=\s))_([^_]+?)_(?![\w_])/g, '<em>$1</em>');
    
    // Quoted text: "text"
    formatted = formatted.replace(/&quot;(.+?)&quot;/g, '<span class="quoted-text">"$1"</span>');
    
    // Convert line breaks - use paragraph breaks for double newlines, single <br> for single
    // Also handle literal \n (escaped backslash-n from JSON) as actual newlines
    formatted = formatted.replace(/\\n/g, '\n');         // Convert literal \n to actual newlines first
    formatted = formatted.replace(/\n\n+/g, '</p><p>');  // Double+ newlines become paragraph breaks
    formatted = formatted.replace(/\n/g, '<br>');        // Single newlines become line breaks
    formatted = '<p>' + formatted + '</p>';              // Wrap in paragraphs
    formatted = formatted.replace(/<p><\/p>/g, '');      // Remove empty paragraphs
    
    return formatted;
}

function sanitizeTaglineHtml(content, charName) {
    if (!content) return '';

    if (getSetting('allowRichTagline') !== true) {
        return escapeHtml(content);
    }

    const formatted = formatRichText(content, charName, true);

    const sanitized = safePurify(formatted, {
        ALLOWED_TAGS: [
            'p', 'br', 'hr', 'div', 'span',
            'strong', 'b', 'em', 'i', 'u', 's', 'del',
            'a', 'img', 'ul', 'ol', 'li', 'blockquote',
            'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
            'center', 'font'
        ],
        ALLOWED_ATTR: [
            'href', 'src', 'alt', 'title', 'target', 'rel', 'class',
            'color', 'size', 'align', 'style'
        ],
        ADD_ATTR: ['target'],
        FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'select', 'textarea', 'style', 'link'],
        FORBID_ATTR: ['onerror', 'onclick', 'onload', 'onmouseover'],
        ALLOW_UNKNOWN_PROTOCOLS: false,
        KEEP_CONTENT: true
    });

    return sanitizeTaglineStyles(sanitized);
}

function sanitizeTaglineStyles(html) {
    if (!html) return '';

    const container = document.createElement('div');
    container.innerHTML = html;

    const allowedProps = new Set([
        'color', 'background-color', 'font-size', 'font-weight', 'font-style',
        'text-align', 'text-decoration', 'line-height',
        'border', 'border-color', 'border-width', 'border-style', 'border-radius',
        'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
        'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left'
    ]);

    const hasUnsafeValue = (value) => {
        const lower = value.toLowerCase();
        return lower.includes('expression(') || lower.includes('javascript:') || lower.includes('url(');
    };

    container.querySelectorAll('[style]').forEach(node => {
        const style = node.getAttribute('style') || '';
        const safeParts = [];
        style.split(';').forEach(part => {
            const [rawProp, rawValue] = part.split(':');
            if (!rawProp || !rawValue) return;
            const prop = rawProp.trim().toLowerCase();
            const value = rawValue.trim();
            if (!allowedProps.has(prop)) return;
            if (!value || hasUnsafeValue(value)) return;
            safeParts.push(`${prop}: ${value}`);
        });

        if (safeParts.length > 0) {
            node.setAttribute('style', safeParts.join('; '));
        } else {
            node.removeAttribute('style');
        }
    });

    return container.innerHTML;
}

/* Upload Helpers */
const toBase64 = file => file.arrayBuffer().then(buf => arrayBufferToBase64(buf));

async function uploadImages(files) {
    if (!activeChar) {
        console.warn('[Gallery] No active character for image upload');
        showToast('No character selected', 'error');
        return;
    }
    
    let uploadedCount = 0;
    let errorCount = 0;

    // Folder name (unique or standard)
    const folderName = getGalleryFolderName(activeChar);
    
    for (let file of files) {
        if (!file.type.startsWith('image/') && !file.type.startsWith('video/') && !file.type.startsWith('audio/')) {
            console.warn(`[Gallery] Skipping unsupported file: ${file.name}`);
            continue;
        }
        
        try {
            const base64 = await toBase64(file);
            const nameOnly = file.name.substring(0, file.name.lastIndexOf('.')) || file.name;
            const ext = file.name.includes('.') ? file.name.split('.').pop() : 'png';
            
            const res = await apiRequest(ENDPOINTS.IMAGES_UPLOAD, 'POST', {
                image: base64,
                filename: nameOnly,
                format: ext,
                ch_name: folderName
            });
            
            if (res.ok) {
                await res.text().catch(() => {});
                uploadedCount++;
            } else {
                const errorText = await res.text();
                console.error(`[Gallery] Upload error for ${nameOnly}:`, res.status, errorText);
                errorCount++;
            }
            
        } catch (e) {
            console.error(`[Gallery] Upload failed for ${file.name}:`, e);
            errorCount++;
        }
    }
    
    if (uploadedCount > 0) {
        showToast(`Uploaded ${uploadedCount} file(s)`, 'success');
        // Refresh the gallery - pass character object for unique folder support
        fetchCharacterImages(activeChar);
    } else if (errorCount > 0) {
        showToast(`Upload failed for ${errorCount} file(s)`, 'error');
    }
}

// ==================== CHARACTER IMPORTER ====================

const importModal = document.getElementById('importModal');
const importBtn = document.getElementById('importBtn');
const closeImportModal = document.getElementById('closeImportModal');
const startImportBtn = document.getElementById('startImportBtn');
const importUrlsInput = document.getElementById('importUrlsInput');
const importProgress = document.getElementById('importProgress');
const importProgressCount = document.getElementById('importProgressCount');
const importProgressFill = document.getElementById('importProgressFill');
const importLog = document.getElementById('importLog');
const importAutoDownloadGallery = document.getElementById('importAutoDownloadGallery');
const importAutoDownloadMedia = document.getElementById('importAutoDownloadMedia');

// Local import elements
const importSourceUrl = document.getElementById('importSourceUrl');
const importSourceLocal = document.getElementById('importSourceLocal');
const importDropZone = document.getElementById('importDropZone');
const importFileInput = document.getElementById('importFileInput');
const importDropPlaceholder = document.getElementById('importDropPlaceholder');
const importFileList = document.getElementById('importFileList');
const importFileCount = document.getElementById('importFileCount');
const importFileCountText = document.getElementById('importFileCountText');
const importClearFiles = document.getElementById('importClearFiles');
const importGalleryOption = document.getElementById('importGalleryOption');
const importInfoHint = document.getElementById('importInfoHint');

let isImporting = false;
let importSourceMode = 'url'; // 'url' or 'local'
let importLocalFiles = []; // Array of File objects for local import

// Track active import for cancellation
let importAbortState = {
    abort: false,
    controller: null  // AbortController for in-flight network requests
};

function resetImportAbortState() {
    importAbortState.abort = false;
    importAbortState.controller?.abort();
    importAbortState.controller = null;
}

function cancelActiveImport() {
    importAbortState.abort = true;
    importAbortState.controller?.abort();
}

// Open/close import modal
importBtn?.addEventListener('click', () => {
    importModal.classList.add('visible');
    importUrlsInput.value = '';
    importProgress.classList.add('hidden');
    importLog.innerHTML = '';
    startImportBtn.disabled = false;
    startImportBtn.innerHTML = '<i class="fa-solid fa-download"></i> Import';
    startImportBtn.classList.remove('success', 'cancelled', 'cancellable');
    syncImportAutoDownloadGallery();
    syncImportAutoDownloadMedia();
    // Hide stats when opening fresh
    const importStats = document.getElementById('importStats');
    if (importStats) importStats.classList.add('hidden');
    // Reset to URL mode
    switchImportSource('url');
    // Reset local file state
    clearImportLocalFiles();
    // Reset abort state
    resetImportAbortState();
});

function syncImportAutoDownloadGallery() {
    if (!importAutoDownloadGallery) return;
    const includeProviderGallery = getSetting('includeProviderGallery');
    importAutoDownloadGallery.checked = includeProviderGallery !== false;
}

function syncImportAutoDownloadMedia() {
    if (!importAutoDownloadMedia) return;
    const mediaLocalizationEnabled = getSetting('mediaLocalizationEnabled');
    importAutoDownloadMedia.checked = mediaLocalizationEnabled !== false;
}

closeImportModal?.addEventListener('click', async () => {
    if (isImporting) {
        const confirmClose = await showConfirm({
            title: 'Cancel import?',
            message: 'Import is still running. Cancel and close?',
            icon: 'fa-solid fa-triangle-exclamation',
            iconColor: 'var(--cl-warning-bright)',
            confirmLabel: 'Cancel Import',
            cancelLabel: 'Keep Importing',
            danger: true,
        });
        if (!confirmClose) return;
        cancelActiveImport();
    }
    importModal.classList.remove('visible');
});

importModal?.addEventListener('click', async (e) => {
    if (e.target !== importModal) return;
    if (isImporting) {
        const confirmClose = await showConfirm({
            title: 'Cancel import?',
            message: 'Import is still running. Cancel and close?',
            icon: 'fa-solid fa-triangle-exclamation',
            iconColor: 'var(--cl-warning-bright)',
            confirmLabel: 'Cancel Import',
            cancelLabel: 'Keep Importing',
            danger: true,
        });
        if (!confirmClose) return;
        cancelActiveImport();
    }
    importModal.classList.remove('visible');
});

// ==================== IMPORT SOURCE TOGGLE ====================

/**
 * Switch import modal between Chub URL and Local PNG modes
 * @param {string} source - 'chub' or 'local'
 */
function switchImportSource(source) {
    importSourceMode = source;
    
    // Update toggle buttons
    document.querySelectorAll('.import-source-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.source === source);
    });
    
    // Show/hide panels
    if (importSourceUrl) importSourceUrl.classList.toggle('hidden', source !== 'url');
    if (importSourceLocal) importSourceLocal.classList.toggle('hidden', source !== 'local');

    // Update info hint
    if (importInfoHint) {
        if (source === 'url') {
            importInfoHint.innerHTML = '<i class="fa-solid fa-info-circle"></i><span>Supports URLs from any registered provider. Characters will be imported as PNG files.</span>';
        } else {
            importInfoHint.innerHTML = '<i class="fa-solid fa-info-circle"></i><span>Import V2 character card PNG files directly. Card metadata will be preserved.</span>';
        }
    }
}

// Toggle button click handlers
document.querySelectorAll('.import-source-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        if (isImporting) return;
        switchImportSource(btn.dataset.source);
    });
});

// ==================== LOCAL FILE HANDLING ====================

/**
 * Format file size for display
 * @param {number} bytes
 * @returns {string}
 */
function formatImportFileSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
}

/**
 * Add files to the local import list (deduplicates by name+size)
 * @param {FileList|File[]} files
 */
function addImportLocalFiles(files) {
    // A CL bundle zip takes over the whole drop; the bundle importer has its own review flow.
    const bundle = [...files].find(f => f.name.toLowerCase().endsWith('.zip'));
    if (bundle) {
        if (files.length > 1) {
            showToast('Importing the bundle; other dropped files were ignored', 'info');
        }
        importModal?.classList.remove('visible');
        window.openBatchImportReview?.(bundle);
        return;
    }
    for (const file of files) {
        // Only accept PNG files
        if (!file.name.toLowerCase().endsWith('.png')) {
            showToast(`Skipped "${file.name}" — only PNG files are supported`, 'warning');
            continue;
        }
        // Deduplicate by name + size
        const isDupe = importLocalFiles.some(f => f.name === file.name && f.size === file.size);
        if (!isDupe) {
            importLocalFiles.push(file);
        }
    }
    renderImportFileList();
}

/**
 * Remove a file from the local import list by index
 * @param {number} index
 */
function removeImportLocalFile(index) {
    importLocalFiles.splice(index, 1);
    renderImportFileList();
}

/**
 * Clear all local import files
 */
function clearImportLocalFiles() {
    importLocalFiles = [];
    if (importFileInput) importFileInput.value = '';
    renderImportFileList();
}

/**
 * Render the file list UI for local imports
 */
function renderImportFileList() {
    if (!importFileList || !importDropPlaceholder || !importFileCount) return;
    
    if (importLocalFiles.length === 0) {
        importFileList.classList.add('hidden');
        importFileList.innerHTML = '';
        importDropPlaceholder.classList.remove('hidden');
        importFileCount.classList.add('hidden');
        return;
    }
    
    importDropPlaceholder.classList.add('hidden');
    importFileList.classList.remove('hidden');
    importFileCount.classList.remove('hidden');
    
    importFileList.innerHTML = importLocalFiles.map((file, idx) => `
        <div class="import-file-item" data-index="${idx}">
            <i class="fa-solid fa-file-image"></i>
            <span class="import-file-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
            <span class="import-file-size">${formatImportFileSize(file.size)}</span>
            <button class="import-file-remove" data-index="${idx}" title="Remove file">
                <i class="fa-solid fa-xmark"></i>
            </button>
        </div>
    `).join('');
    
    if (importFileCountText) {
        importFileCountText.textContent = `${importLocalFiles.length} file${importLocalFiles.length !== 1 ? 's' : ''} selected`;
    }
    
    // Attach remove handlers
    importFileList.querySelectorAll('.import-file-remove').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            removeImportLocalFile(parseInt(btn.dataset.index));
        });
    });
}

// File input change handler
importFileInput?.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
        addImportLocalFiles(e.target.files);
    }
});

// Browse button click (delegated)
importDropZone?.addEventListener('click', (e) => {
    if (e.target.closest('.import-browse-btn')) {
        importFileInput?.click();
    }
});

// Drag & drop handlers
importDropZone?.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    importDropZone.classList.add('drag-over');
});

importDropZone?.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    // Only remove highlight if leaving the drop zone entirely
    if (!importDropZone.contains(e.relatedTarget)) {
        importDropZone.classList.remove('drag-over');
    }
});

importDropZone?.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    importDropZone.classList.remove('drag-over');
    if (e.dataTransfer.files.length > 0) {
        addImportLocalFiles(e.dataTransfer.files);
    }
});

// Clear files button
importClearFiles?.addEventListener('click', () => {
    clearImportLocalFiles();
});

// ==================== LOCAL PNG IMPORT ====================

/**
 * Import a single local PNG character card into the archive
 * Reads the PNG, extracts card metadata, and posts it to the archive's intake
 * @param {File} file - The PNG file
 * @returns {Promise<Object>} Import result: { success, fileName, fullPath, avatarUrl, error }
 */
// Direct-URL import, in the browser. This used to try ST's server-side
// /content/importURL first (its host handlers plus config.yaml
// whitelistImportDomains, no CORS involved) and fall back to the hardened media
// fetch. The archive has no server-side URL fetcher, so the first leg could only
// ever fail -- one guaranteed-refused request per link -- and the fallback is now
// the whole path. Returns a File for the local-import pipeline.
async function fetchDirectImportFile(url, signal) {
    const nameFromUrl = () => {
        let name = '';
        try { name = decodeURIComponent(new URL(url).pathname.split('/').pop() || ''); } catch {}
        if (!name) name = 'character';
        return /\.png$/i.test(name) ? name : `${name}.png`;
    };

    const dl = await downloadMediaToMemory(url, 30000, signal);
    if (!dl.success) {
        throw new Error(`download failed: ${dl.error || 'unknown error'} (the browser fetches these directly, so a host that blocks cross-origin reads cannot be imported by URL)`);
    }
    if (!/^image\/png$/i.test(dl.detectedType || dl.contentType || '')) {
        throw new Error(`URL is ${dl.detectedType || dl.contentType || 'not a PNG'}; only PNG character cards are supported`);
    }
    return new File([dl.arrayBuffer], nameFromUrl(), { type: 'image/png' });
}

// ST's import endpoint responded with the extensionless base name, while everything
// downstream (avatar lookups, /characters/get, folder resolution) keys on the real
// .png filename; canonicalize at the seam.
function ensurePngExt(name) {
    return /\.png$/i.test(String(name)) ? name : `${name}.png`;
}

async function importLocalCharacter(file) {
    try {
        const arrayBuffer = await file.arrayBuffer();
        
        // Extract character data to validate it's a proper card and get metadata
        let cardData = extractCharacterDataFromPng(arrayBuffer);
        if (!cardData) {
            throw new Error('No character card data found in PNG — is this a V2 character card?');
        }
        
        // Normalize V1 cards (flat object with name/description at top level) to V2 wrapper
        if (!cardData.data && cardData.name) {
            cardData = { spec: 'chara_card_v2', spec_version: '2.0', data: cardData };
        }
        if (!cardData.data) cardData.data = {};
        if (!cardData.data.extensions) cardData.data.extensions = {};
        
        const characterName = cardData.data.name || file.name.replace(/\.png$/i, '');
        
        // Assign unique gallery_id if enabled and not already present
        let needsReembed = false;
        if (getSetting('uniqueGalleryFolders') && !cardData.data.extensions.gallery_id) {
            cardData.data.extensions.gallery_id = generateGalleryId();
            debugLog('[Local Import] Assigned gallery_id:', cardData.data.extensions.gallery_id);
            needsReembed = true;
        }
        
        // Ask registered providers to detect and enrich this card
        // Each provider checks for its own extension metadata first (instant),
        // then optionally searches its API to auto-detect and enrich unlinked cards.
        let providerResult = null;
        const registry = window.ProviderRegistry;
        if (registry) {
            for (const provider of registry.getAllProviders()) {
                try {
                    const enrichment = await provider.enrichLocalImport(cardData, file.name);
                    if (enrichment) {
                        if (enrichment.cardData && enrichment.cardData !== cardData) {
                            cardData = enrichment.cardData;
                        }
                        providerResult = enrichment.providerInfo;
                        needsReembed = true;
                        debugLog(`[Local Import] Enriched by ${provider.name}:`, providerResult);
                        break;
                    }
                } catch (e) {
                    debugLog(`[Local Import] ${provider.name} enrichment failed:`, e.message);
                }
            }
        }
        
        const galleryId = cardData.data?.extensions?.gallery_id || null;
        
        // Check for embedded media URLs (split by source)
        const { embeddedUrls: importEmbeddedUrls, lorebookUrls: importLorebookUrls } = findCharacterMediaUrls(cardData, { split: true });
        
        // Check for external gallery page URLs (imgchest, imgbb, etc.)
        await window.ensureExtractorsLoaded?.();
        const importGalleryPageUrls = typeof window.findCharacterGalleryUrls === 'function'
            ? window.findCharacterGalleryUrls(cardData) : [];
        
        // Re-embed updated card data if enrichment or gallery_id changed it
        let pngToUpload = needsReembed ? embedCharacterDataInPng(arrayBuffer, cardData) : arrayBuffer;
        
        // Hand the card to the archive's intake, which cleans it, crops and
        // quantizes the image, stamps provenance and names the file.
        const uploadFile = new File([pngToUpload], file.name, { type: 'image/png' });
        const formData = new FormData();
        formData.append('avatar', uploadFile);
        formData.append('file_type', 'png');
        
        const csrfToken = getCSRFToken();
        
        const importResponse = await fetch('/api/characters/import', {
            method: 'POST',
            headers: { 'X-CSRF-Token': csrfToken },
            body: formData
        });
        
        const responseText = await importResponse.text();
        debugLog('[Local Import] Response:', importResponse.status, responseText);
        
        if (!importResponse.ok) {
            throw new Error(`Import error: ${responseText}`);
        }
        
        let result;
        try {
            result = JSON.parse(responseText);
        } catch (e) {
            throw new Error(`Invalid JSON response: ${responseText}`);
        }
        
        if (result.error) {
            throw new Error('Import failed: Server returned error');
        }
        
        return {
            success: true,
            fileName: ensurePngExt(result.file_name || file.name),
            characterName: characterName,
            embeddedMediaUrls: importEmbeddedUrls,
            lorebookMediaUrls: importLorebookUrls,
            galleryPageUrls: importGalleryPageUrls,
            galleryId: galleryId,
            linkedProvider: providerResult?.providerId || null,
            providerCharId: providerResult?.charId || null,
            fullPath: providerResult?.fullPath || null,
            hasGallery: providerResult?.hasGallery || false,
            avatarUrl: providerResult?.avatarUrl || null,
            cardData: cardData.data || null,
        };
        
    } catch (error) {
        console.error(`Failed to import local file ${file.name}:`, error);
        return { success: false, error: error.message };
    }
}

// Calculate CRC32 for PNG chunks
function crc32(data) {
    let crc = -1;
    for (let i = 0; i < data.length; i++) {
        crc = (crc >>> 8) ^ crc32Table[(crc ^ data[i]) & 0xff];
    }
    return (crc ^ -1) >>> 0;
}

// Pre-computed CRC32 table
const crc32Table = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
        c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    crc32Table[i] = c;
}

// Anchor-click download for a Blob. Revoke is deferred: an immediate revoke can
// abort a still-starting download in some engines.
function downloadBlobAsFile(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Convert any image (WebP, JPEG, etc.) to PNG using canvas
 * @param {ArrayBuffer} imageBuffer - The source image data
 * @returns {Promise<ArrayBuffer>} PNG image data
 */
async function convertImageToPng(imageBuffer) {
    return new Promise((resolve, reject) => {
        let blob = new Blob([imageBuffer]);
        const url = URL.createObjectURL(blob);
        const img = new Image();
        
        img.onload = () => {
            URL.revokeObjectURL(url);
            blob = null; // Release source blob — image is decoded, blob no longer needed
            
            const canvas = document.createElement('canvas');
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0);
            
            // Release decoded image bitmap
            img.src = '';
            
            canvas.toBlob((pngBlob) => {
                // Release canvas backing store (can be 10-20MB for high-res images)
                canvas.width = 0;
                canvas.height = 0;
                
                if (pngBlob) {
                    pngBlob.arrayBuffer().then(resolve).catch(reject);
                } else {
                    reject(new Error('Failed to convert image to PNG'));
                }
            }, 'image/png');
        };
        
        img.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error('Failed to load image for conversion'));
        };
        
        img.src = url;
    });
}

function createTextChunk(keyword, text) {
    const keywordBytes = new TextEncoder().encode(keyword);
    const textBytes = new TextEncoder().encode(text);
    const dataLength = keywordBytes.length + 1 + textBytes.length; // +1 for null separator
    
    // Chunk: length (4) + type (4) + data + crc (4)
    const chunk = new Uint8Array(12 + dataLength);
    const view = new DataView(chunk.buffer);
    
    // Length (big-endian)
    view.setUint32(0, dataLength, false);
    
    // Type: 'tEXt'
    chunk[4] = 0x74; // t
    chunk[5] = 0x45; // E
    chunk[6] = 0x58; // X
    chunk[7] = 0x74; // t
    
    // Keyword
    chunk.set(keywordBytes, 8);
    
    // Null separator
    chunk[8 + keywordBytes.length] = 0;
    
    // Text
    chunk.set(textBytes, 9 + keywordBytes.length);
    
    // CRC (type + data)
    const crcData = chunk.slice(4, 8 + dataLength);
    const crcValue = crc32(crcData);
    view.setUint32(8 + dataLength, crcValue, false);
    
    return chunk;
}

/**
 * Extract character card data from a PNG file
 * Reads the 'chara' tEXt/iTXt chunk and decodes the base64 JSON
 * @param {ArrayBuffer} pngBuffer - The PNG file data
 * @returns {Object|null} The parsed character card object, or null if not found/invalid
 */
function extractCharacterDataFromPng(pngBuffer) {
    try {
        const bytes = new Uint8Array(pngBuffer);
        
        // Verify PNG signature
        const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
        for (let i = 0; i < 8; i++) {
            if (bytes[i] !== pngSignature[i]) {
                debugLog('[PNG Extract] Invalid PNG signature');
                return null;
            }
        }
        
        // Parse chunks looking for tEXt/iTXt with 'chara' keyword.
        // We always read from the V2 'chara' chunk — it's the canonical source with
        // complete field data. The V3 'ccv3' chunk is provider-dependent and may be
        // incomplete. The embed function strips both chunks so ST reads our modified data.
        let pos = 8;
        
        while (pos < bytes.length) {
            const view = new DataView(bytes.buffer, pos);
            const length = view.getUint32(0, false);
            const typeBytes = bytes.slice(pos + 4, pos + 8);
            const type = String.fromCharCode(...typeBytes);
            const chunkEnd = pos + 12 + length;
            
            if (type === 'tEXt' || type === 'iTXt') {
                // Check keyword (null-terminated string at start of data)
                const dataStart = pos + 8;
                let keyword = '';
                let keywordEnd = dataStart;
                
                for (let i = dataStart; i < dataStart + Math.min(20, length); i++) {
                    if (bytes[i] === 0) {
                        keywordEnd = i;
                        break;
                    }
                    keyword += String.fromCharCode(bytes[i]);
                }
                
                if (keyword.toLowerCase() === 'chara') {
                    debugLog('[PNG Extract] Found chara chunk, type:', type);
                    
                    // Extract the base64 data after the null terminator
                    let textStart = keywordEnd + 1;
                    
                    // For iTXt, skip compression flag, compression method, language tag, and translated keyword
                    if (type === 'iTXt') {
                        textStart += 2;
                        while (textStart < dataStart + length && bytes[textStart] !== 0) textStart++;
                        textStart++;
                        while (textStart < dataStart + length && bytes[textStart] !== 0) textStart++;
                        textStart++;
                    }
                    
                    const textEnd = dataStart + length;
                    // Build base64 string in chunks (avoid spread operator stack overflow on large data)
                    let base64Data = '';
                    const slice = bytes.subarray(textStart, textEnd);
                    const chunkSz = 32768;
                    for (let ci = 0; ci < slice.length; ci += chunkSz) {
                        base64Data += String.fromCharCode.apply(null, slice.subarray(ci, Math.min(ci + chunkSz, slice.length)));
                    }
                    
                    try {
                        const jsonString = decodeURIComponent(escape(atob(base64Data)));
                        const cardData = JSON.parse(jsonString);
                        debugLog('[PNG Extract] Successfully extracted card data:', {
                            spec: cardData.spec,
                            spec_version: cardData.spec_version,
                            name: cardData.data?.name
                        });
                        return cardData;
                    } catch (decodeError) {
                        debugLog('[PNG Extract] Failed to decode chara data:', decodeError.message);
                        return null;
                    }
                }
            }
            
            pos = chunkEnd;
        }
        
        debugLog('[PNG Extract] No chara chunk found in PNG');
        return null;
        
    } catch (error) {
        debugLog('[PNG Extract] Error extracting character data:', error.message);
        return null;
    }
}

// Embed character data into PNG (removes existing chara and ccv3 chunks first)
function embedCharacterDataInPng(pngBuffer, characterJson) {
    const bytes = new Uint8Array(pngBuffer);
    
    // Verify PNG signature
    const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
    for (let i = 0; i < 8; i++) {
        if (bytes[i] !== pngSignature[i]) {
            throw new Error('Invalid PNG file');
        }
    }
    
    // First pass: find chunk boundaries and identify which to keep/skip.
    // Uses subarray views (zero-copy) instead of slice copies.
    const chunkRanges = []; // [{start, end, type, skip}]
    let pos = 8;
    
    while (pos < bytes.length) {
        const view = new DataView(bytes.buffer, bytes.byteOffset + pos);
        const length = view.getUint32(0, false);
        const type = String.fromCharCode(bytes[pos+4], bytes[pos+5], bytes[pos+6], bytes[pos+7]);
        const chunkEnd = pos + 12 + length;
        
        // Skip any character card tEXt chunks (chara = V2, ccv3 = V3)
        let skipChunk = false;
        if (type === 'tEXt' || type === 'iTXt' || type === 'zTXt') {
            const dataStart = pos + 8;
            let keyword = '';
            for (let j = dataStart; j < dataStart + Math.min(20, length); j++) {
                if (bytes[j] === 0) break;
                keyword += String.fromCharCode(bytes[j]);
            }
            const kwLower = keyword.toLowerCase();
            if (kwLower === 'chara' || kwLower === 'ccv3') {
                debugLog(`[PNG] Removing existing '${type}' chunk with '${keyword}' keyword`);
                skipChunk = true;
            }
        }
        
        chunkRanges.push({ start: pos, end: chunkEnd, type, skip: skipChunk });
        pos = chunkEnd;
    }
    
    // Find IEND chunk index
    const iendIndex = chunkRanges.findIndex(c => c.type === 'IEND');
    if (iendIndex === -1) {
        throw new Error('Invalid PNG: IEND chunk not found');
    }
    
    const jsonString = JSON.stringify(characterJson);
    const base64Data = btoa(unescape(encodeURIComponent(jsonString)));
    const textChunk = createTextChunk('chara', base64Data);
    
    debugLog(`[PNG] Adding new chara chunk: JSON=${jsonString.length} chars, base64=${base64Data.length} chars`);
    
    // Calculate total size (no intermediate copies)
    let totalSize = 8 + textChunk.length; // PNG signature + new chara chunk
    for (const range of chunkRanges) {
        if (!range.skip) totalSize += (range.end - range.start);
    }
    
    // Build the new PNG — write directly from source using subarray views
    const result = new Uint8Array(totalSize);
    result.set(bytes.subarray(0, 8), 0); // PNG signature (view, no copy until set)
    
    let offset = 8;
    for (let i = 0; i < chunkRanges.length; i++) {
        if (i === iendIndex) {
            result.set(textChunk, offset);
            offset += textChunk.length;
        }
        const range = chunkRanges[i];
        if (!range.skip) {
            result.set(bytes.subarray(range.start, range.end), offset);
            offset += (range.end - range.start);
        }
    }
    
    return result;
}

// Shared log entry icons
const LOG_ICONS = {
    success: 'fa-check-circle',
    error: 'fa-times-circle',
    pending: 'fa-spinner fa-spin',
    info: 'fa-info-circle',
    divider: 'fa-minus'
};

/**
 * Add an entry to a log container
 * @param {HTMLElement} container - The log container element
 * @param {string} message - The message to display
 * @param {string} status - Status: 'success', 'error', 'pending', 'info', or 'divider'
 * @returns {HTMLElement} The created log entry element
 */
function addLogEntry(container, message, status = 'pending') {
    const entry = document.createElement('div');
    
    // Handle divider specially
    if (status === 'divider') {
        entry.className = 'import-log-divider';
        entry.innerHTML = '<hr>';
    } else {
        entry.className = `import-log-entry ${status}`;
        entry.innerHTML = `<i class="fa-solid ${LOG_ICONS[status] || LOG_ICONS.pending}"></i>${escapeHtml(message)}`;
    }
    container.appendChild(entry);
    container.scrollTop = container.scrollHeight;
    return entry;
}

/**
 * Update an existing log entry
 * @param {HTMLElement} entry - The log entry element to update
 * @param {string} message - The new message
 * @param {string} status - The new status
 */
function updateLogEntryStatus(entry, message, status) {
    entry.className = `import-log-entry ${status}`;
    entry.innerHTML = `<i class="fa-solid ${LOG_ICONS[status]}"></i>${escapeHtml(message)}`;
}

// Convenience wrappers for specific logs
function addImportLogEntry(message, status = 'pending') {
    return addLogEntry(importLog, message, status);
}

function updateLogEntry(entry, message, status) {
    updateLogEntryStatus(entry, message, status);
}

// Start import process
startImportBtn?.addEventListener('click', async () => {
    // If in "Done" / "Cancelled" state, just close the modal
    if (startImportBtn.classList.contains('success') || startImportBtn.classList.contains('cancelled')) {
        importModal.classList.remove('visible');
        return;
    }
    
    // If currently importing, this click means "Cancel"
    if (isImporting) {
        cancelActiveImport();
        return;
    }
    
    // ==================== VALIDATE INPUT ====================
    let importItems = []; // Array of { displayName, identifier?, provider?, file? }
    
    if (importSourceMode === 'url') {
        const text = importUrlsInput.value.trim();
        if (!text) {
            showToast('Please enter at least one URL', 'warning');
            return;
        }
        
        // Parse URLs through provider registry
        const lines = text.split('\n').map(l => l.trim()).filter(l => l);
        const directDownloadEnabled = getSetting('importDirectDownloads') === true;
        let skippedDirectCandidates = 0;

        for (const line of lines) {
            const provider = window.ProviderRegistry?.getProviderForUrl(line, { accept: (p) => !!p.parseUrl?.(line) });
            if (provider) {
                const identifier = provider.parseUrl(line);
                if (identifier) {
                    const slug = String(identifier).split('/').pop() || identifier;
                    importItems.push({ displayName: slug, identifier, provider, url: line });
                }
            } else if (directDownloadEnabled && /^https?:\/\//i.test(line)) {
                // Unrecognized URL: treat as a direct card download (issue #25)
                let displayName = line;
                try { displayName = decodeURIComponent(new URL(line).pathname.split('/').pop() || line); } catch {}
                importItems.push({ displayName: displayName.replace(/\.png$/i, ''), directUrl: line });
            } else if (/^https?:\/\//i.test(line)) {
                skippedDirectCandidates++;
            }
        }

        if (importItems.length === 0) {
            showToast(skippedDirectCandidates > 0
                ? `No recognized provider for ${skippedDirectCandidates === 1 ? 'that link' : 'those links'}. To import plain file links (catbox, Discord, etc.), turn on Direct Downloads in Settings > General > Imports.`
                : 'No valid character URLs found. Make sure a provider supports the URL format.', 'error');
            return;
        }
        if (skippedDirectCandidates > 0) {
            showToast(`${skippedDirectCandidates} unrecognized link${skippedDirectCandidates === 1 ? '' : 's'} skipped. Turn on Direct Downloads in Settings > General > Imports to import plain file links.`, 'info');
        }
    } else {
        // Local PNG mode
        if (importLocalFiles.length === 0) {
            showToast('Please select at least one PNG file', 'warning');
            return;
        }
        
        importItems = importLocalFiles.map(file => ({
            displayName: file.name.replace(/\.png$/i, ''),
            file: file
        }));
    }
    
    // Get import options
    const skipDuplicates = document.getElementById('importSkipDuplicates')?.checked ?? true;
    const autoDownloadGallery = document.getElementById('importAutoDownloadGallery')?.checked ?? false;
    const autoDownloadMedia = document.getElementById('importAutoDownloadMedia')?.checked ?? false;
    
    // ==================== START IMPORTING ====================
    isImporting = true;
    resetImportAbortState();
    importAbortState.controller = new AbortController();
    
    // Show Cancel button (not disabled — clickable to cancel)
    startImportBtn.disabled = false;
    startImportBtn.innerHTML = '<i class="fa-solid fa-stop"></i> Cancel';
    startImportBtn.classList.add('cancellable');
    if (importSourceMode === 'url') {
        importUrlsInput.disabled = true;
    }
    // Disable source toggle during import
    document.querySelectorAll('.import-source-btn').forEach(btn => btn.disabled = true);
    
    importProgress.classList.remove('hidden');
    importLog.innerHTML = '';
    importProgressFill.style.width = '0%';
    importProgressCount.textContent = `0/${importItems.length}`;
    
    let successCount = 0;
    let errorCount = 0;
    let skippedCount = 0;
    let mediaDownloadCount = 0;
    let wasCancelled = false;
    const importedFileNames = [];
    
    // Get stat elements
    const importStats = document.getElementById('importStats');
    const importStatImported = document.getElementById('importStatImported');
    const importStatSkipped = document.getElementById('importStatSkipped');
    const importStatMedia = document.getElementById('importStatMedia');
    const importStatErrors = document.getElementById('importStatErrors');
    const importMediaProgress = document.getElementById('importMediaProgress');
    const importMediaProgressFill = document.getElementById('importMediaProgressFill');
    const importMediaProgressCount = document.getElementById('importMediaProgressCount');
    
    // Show stats section
    if (importStats) {
        importStats.classList.remove('hidden');
        importStatImported.textContent = '0';
        importStatSkipped.textContent = '0';
        importStatMedia.textContent = '0';
        importStatErrors.textContent = '0';
    }
    
    // Helper to update stats display
    const updateStats = () => {
        if (importStatImported) importStatImported.textContent = successCount;
        if (importStatSkipped) importStatSkipped.textContent = skippedCount;
        if (importStatMedia) importStatMedia.textContent = mediaDownloadCount;
        if (importStatErrors) importStatErrors.textContent = errorCount;
    };
    
    // Helper to check if we should stop
    const shouldStop = () => importAbortState.abort;
    
    const linkIndex = skipDuplicates ? buildProviderLinkIndex() : null;
    const batchImportedIds = new Set();

    for (let i = 0; i < importItems.length; i++) {
        // === ABORT CHECK: top of each iteration ===
        if (shouldStop()) {
            wasCancelled = true;
            break;
        }
        
        const item = importItems[i];
        const displayName = item.displayName;
        
        const logEntry = addImportLogEntry(`Checking ${displayName}`, 'pending');

        // Direct-URL items download first so the file-based checks below apply
        if (item.directUrl && !item.file) {
            try {
                updateLogEntry(logEntry, `Downloading ${displayName}`, 'pending');
                item.file = await fetchDirectImportFile(item.directUrl, importAbortState.controller.signal);
                updateLogEntry(logEntry, `Checking ${displayName}`, 'pending');
            } catch (e) {
                if (shouldStop()) { wasCancelled = true; break; }
                errorCount++;
                updateStats();
                updateLogEntry(logEntry, `${displayName}: ${e.message}`, 'error');
                const progress = ((i + 1) / importItems.length) * 100;
                importProgressFill.style.width = `${progress}%`;
                importProgressCount.textContent = `${i + 1}/${importItems.length}`;
                continue;
            }
        }

        // === PRE-IMPORT DUPLICATE CHECK ===
        if (skipDuplicates) {
            try {
                if (shouldStop()) { wasCancelled = true; break; }

                if (item.provider) {
                    // URL mode: check if any existing character is linked to same provider+identifier
                    const importId = String(item.identifier).toLowerCase();
                    const batchKey = `${item.provider.id}:${importId}`;
                    
                    // Check within current batch first
                    if (batchImportedIds.has(batchKey)) {
                        skippedCount++;
                        updateStats();
                        updateLogEntry(logEntry, `${displayName} skipped - duplicate URL in this batch`, 'info');
                        const progress = ((i + 1) / importItems.length) * 100;
                        importProgressFill.style.width = `${progress}%`;
                        importProgressCount.textContent = `${i + 1}/${importItems.length}`;
                        continue;
                    }
                    
                    const existingMatch = linkIndex
                        ? (linkIndex.providerIndex.get(batchKey) || null)
                        : allCharacters.find(char => {
                            const linkInfo = item.provider.getLinkInfo(char);
                            if (!linkInfo) return false;
                            const linkPath = (linkInfo.fullPath || '').toLowerCase();
                            return linkPath === importId || String(linkInfo.id).toLowerCase() === importId;
                        });
                    
                    if (existingMatch) {
                        const existingName = getCharField(existingMatch, 'name');
                        skippedCount++;
                        updateStats();
                        updateLogEntry(logEntry, `${displayName} skipped - already exists as "${existingName}" (same ${item.provider.name} character)`, 'info');
                        
                        const progress = ((i + 1) / importItems.length) * 100;
                        importProgressFill.style.width = `${progress}%`;
                        importProgressCount.textContent = `${i + 1}/${importItems.length}`;
                        continue;
                    }
                } else {
                    // Local mode: read PNG to extract card data for duplicate check
                    const tempBuffer = await item.file.arrayBuffer();
                    let cardData = extractCharacterDataFromPng(tempBuffer);
                    
                    if (shouldStop()) { wasCancelled = true; break; }
                    
                    // Normalize V1 (flat) cards to V2 wrapper
                    if (cardData && !cardData.data && cardData.name) {
                        cardData = { spec: 'chara_card_v2', data: cardData };
                    }
                    
                    if (cardData && cardData.data) {
                        const characterName = cardData.data.name || displayName;
                        const characterCreator = cardData.data.creator || '';
                        
                        // Check all providers for path-based dedup
                        let providerFullPath = null;
                        const allProviders = window.ProviderRegistry?.getAllProviders() || [];
                        for (const provider of allProviders) {
                            const linkInfo = provider.getLinkInfo({ data: cardData.data });
                            if (linkInfo?.fullPath) { providerFullPath = linkInfo.fullPath; break; }
                        }
                        
                        const duplicateMatches = checkCharacterForDuplicates({
                            name: characterName,
                            creator: characterCreator,
                            fullPath: providerFullPath,
                            definition: {
                                description: cardData.data.description || '',
                                personality: cardData.data.personality || '',
                                first_mes: cardData.data.first_mes || '',
                                scenario: cardData.data.scenario || ''
                            }
                        }, linkIndex);
                        
                        if (duplicateMatches.length > 0) {
                            const bestMatch = duplicateMatches[0];
                            const existingName = getCharField(bestMatch.char, 'name');
                            skippedCount++;
                            updateStats();
                            updateLogEntry(logEntry, `${displayName} skipped - already exists as "${existingName}" (${bestMatch.matchReason})`, 'info');
                            
                            const progress = ((i + 1) / importItems.length) * 100;
                            importProgressFill.style.width = `${progress}%`;
                            importProgressCount.textContent = `${i + 1}/${importItems.length}`;
                            continue;
                        }
                    }
                }
            } catch (e) {
                debugLog('[Import] Error checking for duplicates:', e);
                // Continue with import if duplicate check fails
            }
        }
        // === END DUPLICATE CHECK ===
        
        if (shouldStop()) { wasCancelled = true; break; }
        
        updateLogEntry(logEntry, `Importing ${displayName}`, 'pending');
        
        // Execute the import based on item shape (provider URL vs local/direct file)
        const result = item.provider
            ? await item.provider.importCharacter(item.identifier)
            : await importLocalCharacter(item.file);
        
        // Check abort AFTER import completes (import itself is atomic — card was already uploaded)
        if (shouldStop()) {
            // If the import succeeded, still count it since the card is already saved
            if (result.success) {
                successCount++;
                if (result.fileName) importedFileNames.push(result.fileName);
                if (item.provider) batchImportedIds.add(`${item.provider.id}:${String(item.identifier).toLowerCase()}`);
                updateStats();
                updateLogEntry(logEntry, `${displayName} imported successfully`, 'success');
            }
            wasCancelled = true;
            break;
        }
        
        // Yield to browser for GC + UI updates between imports (critical for mobile)
        await new Promise(r => setTimeout(r, 50));
        
        if (result.success) {
            successCount++;
            if (result.fileName) importedFileNames.push(result.fileName);
            if (item.provider) batchImportedIds.add(`${item.provider.id}:${String(item.identifier).toLowerCase()}`);
            updateStats();
            updateLogEntry(logEntry, `${displayName} imported successfully`, 'success');
            
            // Determine folder name for media downloads
            let folderName;
            if (result.galleryId && getSetting('uniqueGalleryFolders')) {
                const safeName = result.characterName.replace(/[<>:"/\\|?*]/g, '_').trim();
                folderName = `${safeName}_${result.galleryId}`;
                debugLog('[Import] Using unique gallery folder:', folderName);
            } else {
                // Name-first: media downloads run before the batch's characters enter
                // allCharacters, and a deduped filename stem (sam3) can never recover the
                // name; the name IS the off-mode folder in every window.
                folderName = resolveGalleryFolderName(result.characterName || result.fileName);
                debugLog('[Import] Using name-based folder:', folderName);
            }
            
            // Auto-download media via unified pipeline
            let galleryProvider = null;
            let galleryLinkInfo = null;
            if (item.provider) {
                galleryProvider = item.provider;
                galleryLinkInfo = { id: result.providerCharId, fullPath: result.fullPath };
            } else if (result.linkedProvider) {
                galleryProvider = window.ProviderRegistry?.getProvider(result.linkedProvider) || null;
                galleryLinkInfo = { id: result.providerCharId, fullPath: result.fullPath };
            }

            const importPhases = [];
            if (autoDownloadMedia) {
                if (result.embeddedMediaUrls?.length > 0) importPhases.push('embedded');
                if (result.lorebookMediaUrls?.length > 0) importPhases.push('lorebook');
                if (getSetting('includeExternalGalleries') !== false && result.galleryPageUrls?.length > 0) importPhases.push('extGallery');
            }
            if (autoDownloadGallery && result.hasGallery && galleryProvider?.supportsGallery && galleryLinkInfo) {
                importPhases.push('providerGallery');
            }

            if (importPhases.length > 0 && getSetting('importMediaAction') === 'background') {
                // Background mode: hand the already-computed payload to the queue
                // and keep importing; the import itself already succeeded
                window.enqueueMediaDownloadJob?.({
                    avatar: result.fileName,
                    name: result.characterName,
                    folderName,
                    phases: importPhases,
                    embeddedUrls: result.embeddedMediaUrls || [],
                    lorebookUrls: result.lorebookMediaUrls || [],
                    galleryPageUrls: result.galleryPageUrls || [],
                    providerOverride: galleryProvider ? { provider: galleryProvider, linkInfo: galleryLinkInfo } : undefined,
                    pseudoChar: { avatar: result.fileName, name: result.characterName, data: result.cardData || { extensions: {} }, _slim: false },
                });
                addImportLogEntry('  ↳ Media downloads queued in background', 'info');
            } else if (importPhases.length > 0) {
                if (shouldStop()) { wasCancelled = true; break; }

                const pseudoChar = { avatar: result.fileName, name: result.characterName, data: result.cardData || { extensions: {} }, _slim: false };
                const totalMediaUrls = (result.embeddedMediaUrls?.length || 0) + (result.lorebookMediaUrls?.length || 0);
                const embeddedCount = result.embeddedMediaUrls?.length || 0;
                const phaseLogEntries = {};
                const phaseLabels = {
                    embedded: 'Embedded Media',
                    lorebook: 'Lorebook Media',
                    providerGallery: `${galleryProvider?.name || 'Provider'} Gallery`,
                    extGallery: 'External Galleries'
                };

                const pipelineResult = await downloadCharacterMedia(pseudoChar, folderName, {
                    embeddedUrls: result.embeddedMediaUrls || [],
                    lorebookUrls: result.lorebookMediaUrls || [],
                    galleryPageUrls: result.galleryPageUrls || [],
                    providerOverride: galleryProvider ? { provider: galleryProvider, linkInfo: galleryLinkInfo } : undefined,
                    phases: importPhases,
                    signal: importAbortState.controller.signal,
                    shouldAbort: shouldStop,
                    onPhaseStart: (phase, ctx) => {
                        if (importMediaProgress) {
                            importMediaProgress.classList.remove('hidden');
                            importMediaProgressFill.style.width = '0%';
                            importMediaProgressCount.textContent = (phase === 'embedded' || phase === 'lorebook')
                                ? `0/${totalMediaUrls}` : `0/${ctx.count || '?'}`;
                        }
                        const label = phaseLabels[phase] || phase;
                        const msg = phase === 'extGallery'
                            ? `  ↳ ${label}: resolving ${ctx.count} URL(s)...`
                            : `  ↳ ${label}: downloading${ctx.count ? ` ${ctx.count} file(s)` : ''}...`;
                        phaseLogEntries[phase] = addImportLogEntry(msg, 'pending');
                    },
                    onPhaseEnd: (phase, pr) => {
                        const entry = phaseLogEntries[phase];
                        if (!entry) return;
                        const label = phaseLabels[phase] || phase;
                        if (pr.aborted) {
                            updateLogEntry(entry, `  ↳ ${label}: cancelled (${pr.success || 0} downloaded before stop)`, 'warning');
                        } else if (pr.success > 0) {
                            updateLogEntry(entry, `  ↳ ${label}: ${pr.success} downloaded, ${pr.skipped || 0} skipped, ${pr.errors || 0} failed`, 'success');
                        } else if (pr.skipped > 0) {
                            updateLogEntry(entry, `  ↳ ${label}: ${pr.skipped} already exist`, 'info');
                        } else {
                            const noMsg = phase === 'providerGallery' ? 'no images available'
                                : phase === 'extGallery' ? 'no images found' : 'no files downloaded';
                            updateLogEntry(entry, `  ↳ ${label}: ${noMsg}`, 'info');
                        }
                    },
                    onProgress: (phase, current, total) => {
                        if (!importMediaProgressFill) return;
                        if (phase === 'embedded' || phase === 'lorebook') {
                            const done = (phase === 'lorebook' ? embeddedCount : 0) + current;
                            importMediaProgressFill.style.width = `${(done / totalMediaUrls) * 100}%`;
                            importMediaProgressCount.textContent = `${done}/${totalMediaUrls}`;
                        } else {
                            importMediaProgressFill.style.width = `${(current / total) * 100}%`;
                            importMediaProgressCount.textContent = `${current}/${total}`;
                        }
                    }
                });

                mediaDownloadCount += pipelineResult.totals.success;
                updateStats();

                if (pipelineResult.aborted) {
                    wasCancelled = true;
                    break;
                }
            }
        } else {
            errorCount++;
            updateStats();
            updateLogEntry(logEntry, `${displayName}: ${result.error}`, 'error');
        }
        
        // Update progress
        const progress = ((i + 1) / importItems.length) * 100;
        importProgressFill.style.width = `${progress}%`;
        importProgressCount.textContent = `${i + 1}/${importItems.length}`;
    }
    
    // ==================== FINALIZE ====================
    
    // Log cancellation
    if (wasCancelled) {
        addImportLogEntry('Import cancelled by user', 'warning');
    }
    
    // Clean up state
    isImporting = false;
    importAbortState.controller = null;
    importUrlsInput.disabled = false;
    startImportBtn.classList.remove('cancellable');
    // Re-enable source toggle
    document.querySelectorAll('.import-source-btn').forEach(btn => btn.disabled = false);
    
    // Set button to final state
    if (wasCancelled) {
        startImportBtn.disabled = false;
        startImportBtn.innerHTML = '<i class="fa-solid fa-ban"></i> Cancelled';
        startImportBtn.classList.add('cancelled');
    } else {
        startImportBtn.disabled = false;
        startImportBtn.innerHTML = '<i class="fa-solid fa-check"></i> Done';
        startImportBtn.classList.add('success');
    }
    
    // Hide media progress
    if (importMediaProgress) {
        importMediaProgress.classList.add('hidden');
    }
    
    // Show summary toast
    if (successCount > 0 || skippedCount > 0) {
        const parts = [];
        if (successCount > 0) parts.push(`Imported ${successCount}`);
        if (skippedCount > 0) parts.push(`${skippedCount} skipped`);
        if (mediaDownloadCount > 0) parts.push(`${mediaDownloadCount} media`);
        if (errorCount > 0) parts.push(`${errorCount} failed`);
        if (wasCancelled) parts.push('cancelled');
        showToast(parts.join(', '), successCount > 0 ? 'success' : 'info');
        
        // Only refresh if we actually imported something
        if (successCount > 0) {
            // Try lightweight incremental adds for small batches (avoids OOM on mobile).
            // For large batches fall back to full reload - many individual fetches would be slower.
            const INCREMENTAL_THRESHOLD = 10;
            let incrementalDone = false;

            if (importedFileNames.length > 0 && importedFileNames.length <= INCREMENTAL_THRESHOLD) {
                let allAdded = true;
                for (const fn of importedFileNames) {
                    const ok = await fetchAndAddCharacter(fn, { skipNotify: true });
                    if (!ok) { allAdded = false; break; }
                }
                incrementalDone = allAdded;
            }

            if (!incrementalDone) {
                await fetchCharacters(true);
            } else {
                // Incremental adds dont touch the browse In-Library lookup; invalidate the
                // shared base so the next Online-tab open reflects the new characters.
                window.ProviderRegistry?.invalidateBrowseLookupBase?.();
                // Surgical adds bypass processAndRender, so nothing else repaints the grid.
                if ((getCurrentView() || 'characters') === 'characters') performSearch();
            }

            // Also refresh the main SillyTavern window's character list (fire-and-forget)
            try {
                const context = getSTContext();
                if (context && typeof context.getCharacters === 'function') {
                    debugLog('Triggering character refresh in main window...');
                    context.getCharacters().catch(e => console.warn('Main window refresh failed:', e));
                }
            } catch (e) {
                console.warn('Could not refresh main window characters:', e);
            }
        }
    } else if (!wasCancelled) {
        showToast(`Import failed: ${errorCount} error${errorCount > 1 ? 's' : ''}`, 'error');
    } else {
        showToast('Import cancelled', 'info');
    }
});

