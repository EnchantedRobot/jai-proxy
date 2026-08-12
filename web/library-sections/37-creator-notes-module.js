// ============================================================================
// CREATOR NOTES MODULE - Secure iframe-based rich content rendering
// ============================================================================

/**
 * Configuration for Creator Notes rendering
 */
const CreatorNotesConfig = {
    MIN_HEIGHT: 50,
    MAX_HEIGHT: 600,  // Height before scrollbar kicks in
    MIN_LINES_FOR_EXPAND: 10, // Show expand button when content has at least this many lines
    MIN_CHARS_FOR_EXPAND: 500, // Or when content exceeds this character count
    BODY_PADDING: 10, // 5px top + 5px bottom
    RESIZE_DEBOUNCE: 16, // ~60fps
};

/**
 * Sanitize CSS content to remove dangerous patterns
 * @param {string} content - Raw CSS/HTML content
 * @returns {string} - Sanitized content
 */
function sanitizeCreatorNotesCSS(content) {
    const dangerousPatterns = [
        /position\s*:\s*(fixed|sticky)/gi,
        /z-index\s*:\s*(\d{4,}|[5-9]\d{2})/gi,
        /-moz-binding\s*:/gi,
        /behavior\s*:/gi,
        /expression\s*\(/gi,
        /@import\s+(?!url\s*\()/gi,
        /javascript\s*:/gi,
        /vbscript\s*:/gi,
    ];
    
    let sanitized = content;
    dangerousPatterns.forEach(pattern => {
        sanitized = sanitized.replace(pattern, '/* blocked */ ');
    });
    return sanitized;
}

/**
 * Sanitize HTML content with DOMPurify (permissive for rich styling)
 * @param {string} content - Raw HTML content
 * @returns {string} - Sanitized HTML
 */
function sanitizeCreatorNotesHTML(content) {
    return safePurify(content, {
        ALLOWED_TAGS: [
            'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'div', 'span',
            'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'del', 'ins', 'mark',
            'a', 'img', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
            'table', 'tr', 'td', 'th', 'thead', 'tbody', 'tfoot', 'caption', 'colgroup', 'col',
            'center', 'font', 'sub', 'sup', 'small', 'big',
            'details', 'summary', 'abbr', 'cite', 'q', 'dl', 'dt', 'dd',
            'figure', 'figcaption', 'article', 'section', 'aside', 'header', 'footer', 'nav', 'main',
            'address', 'time', 'ruby', 'rt', 'rp', 'bdi', 'bdo', 'wbr',
            'style'
        ],
        ALLOWED_ATTR: [
            'href', 'src', 'alt', 'title', 'class', 'id', 'style', 'target',
            'width', 'height', 'align', 'valign', 'border', 'cellpadding', 'cellspacing',
            'colspan', 'rowspan', 'color', 'face', 'size', 'name', 'rel',
            'bgcolor', 'background', 'start', 'type', 'value', 'reversed',
            'dir', 'lang', 'translate', 'hidden', 'tabindex', 'accesskey',
            'data-*'
        ],
        ADD_ATTR: ['target'],
        FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'select', 'textarea', 'meta', 'link', 'base', 'noscript'],
        FORBID_ATTR: ['onerror', 'onclick', 'onload', 'onmouseover', 'onmouseout', 'onmousedown', 'onmouseup', 'onfocus', 'onblur', 'onchange', 'onsubmit', 'onkeydown', 'onkeyup', 'onkeypress'],
        ALLOW_DATA_ATTR: true,
        ALLOW_UNKNOWN_PROTOCOLS: false,
        KEEP_CONTENT: true
    });
}

/**
 * Add referrer policy to media elements for privacy
 * @param {string} content - HTML content
 * @returns {string} - Hardened HTML
 */
function hardenCreatorNotesMedia(content) {
    return content
        .replace(/<img\s/gi, '<img referrerpolicy="no-referrer" ')
        .replace(/<video\s/gi, '<video referrerpolicy="no-referrer" ')
        .replace(/<audio\s/gi, '<audio referrerpolicy="no-referrer" ');
}

/**
 * Generate the base CSS styles for iframe content
 * @returns {string} - CSS style block
 */
function getCreatorNotesBaseStyles() {
    return `
        <style>
            * {
                box-sizing: border-box;
                scrollbar-width: thin;
                scrollbar-color: rgba(255, 255, 255, 0.15) transparent;
            }
            ::-webkit-scrollbar { width: 8px; height: 8px; }
            ::-webkit-scrollbar-track { background: transparent; }
            ::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.15); border-radius: var(--radius-sm); }
            ::-webkit-scrollbar-thumb:hover { background: rgba(255, 255, 255, 0.25); }
            ::-webkit-scrollbar-corner { background: transparent; }
            html {
                margin: 0;
                padding: 0;
                background: transparent;
                color-scheme: dark;
            }
            body {
                margin: 0;
                padding: 5px;
                font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                color: #e0e0e0;
                background: transparent;
                line-height: 1.5;
                overflow-wrap: break-word;
                word-wrap: break-word;
                font-size: 0.95rem;
            }
            #content-wrapper {
                display: block;
                width: 100%;
            }
            
            img, video, canvas, svg {
                max-width: 100% !important;
                height: auto !important;
                display: block;
                margin: 10px auto;
                border-radius: var(--radius-lg);
            }
            
            a { color: #4a9eff; text-decoration: none; }
            a:hover { text-decoration: underline; }
            
            h1 { color: #4a9eff; margin: 12px 0 8px 0; font-size: 1.6em; }
            h2 { color: #4a9eff; margin: 12px 0 8px 0; font-size: 1.4em; }
            h3 { color: #4a9eff; margin: 10px 0 6px 0; font-size: 1.2em; }
            h4, h5, h6 { color: #4a9eff; margin: 8px 0 4px 0; font-size: 1.1em; }
            
            strong, b { color: #fff; }
            em, i { color: #ddd; font-style: italic; }
            
            p { margin: 0 0 0.8em 0; }
            
            blockquote {
                margin: 10px 0;
                padding: 10px 15px;
                border-left: 3px solid #4a9eff;
                background: rgba(var(--accent-rgb), 0.1);
                border-radius: 0 8px 8px 0;
            }
            
            pre {
                background: rgba(0,0,0,0.3);
                padding: 10px;
                border-radius: var(--radius-md);
                overflow-x: auto;
                white-space: pre-wrap;
                word-wrap: break-word;
            }
            
            code {
                background: rgba(0,0,0,0.3);
                padding: 2px 6px;
                border-radius: var(--radius-sm);
                font-family: 'Consolas', 'Monaco', monospace;
            }
            
            table {
                width: 100%;
                border-collapse: collapse;
                margin: 10px 0;
                background: rgba(0,0,0,0.2);
                border-radius: var(--radius-lg);
                overflow: hidden;
            }
            td, th {
                padding: 8px 12px;
                border: 1px solid rgba(255,255,255,0.1);
            }
            th {
                background: rgba(var(--accent-rgb), 0.2);
                color: #4a9eff;
            }
            
            hr {
                border: none;
                border-top: 1px solid rgba(255,255,255,0.15);
                margin: 15px 0;
            }
            
            ul, ol { padding-left: 25px; margin: 8px 0; }
            li { margin: 4px 0; }
            
            .embedded-image {
                max-width: 100% !important;
                height: auto !important;
                border-radius: var(--radius-lg);
                margin: 10px auto;
                display: block;
            }
            
            .embedded-link { color: #4a9eff; }
            
            .audio-player,
            .embedded-audio {
                width: 100%;
                max-width: 400px;
                height: 40px;
                margin: 10px 0;
                display: block;
                border-radius: var(--radius-lg);
                background: rgba(0, 0, 0, 0.3);
            }
            .audio-player::-webkit-media-controls-panel {
                background: rgba(255, 255, 255, 0.1);
            }
            .audio-player::-webkit-media-controls-play-button,
            .audio-player::-webkit-media-controls-mute-button {
                filter: invert(1);
            }
            
            .placeholder-user { color: #2ecc71; font-weight: bold; }
            .placeholder-char { color: #e74c3c; font-weight: bold; }
            
            /* Neutralize dangerous positioning from user CSS */
            [style*="position: fixed"], [style*="position:fixed"],
            [style*="position: sticky"], [style*="position:sticky"] {
                position: static !important;
            }
            [style*="z-index"] {
                z-index: auto !important;
            }
            @media (max-width: 768px) {
                body { font-size: 0.88rem; padding: 3px; }
            }
        </style>
    `;
}

/**
 * Build complete iframe HTML document
 * @param {string} content - Sanitized content
 * @returns {string} - Complete HTML document
 */
function buildCreatorNotesIframeDoc(content) {
    const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'self' data: blob:; script-src 'none'; object-src 'none'; form-action 'none'; img-src * data: blob:; media-src * data: blob:; style-src 'self' 'unsafe-inline'; font-src * data:;">`;
    const styles = getCreatorNotesBaseStyles();
    
    return `<!DOCTYPE html><html><head><meta charset="UTF-8">${csp}${styles}</head><body><div id="content-wrapper">${content}</div></body></html>`;
}

function estimateCreatorNotesHeight(html) {
    const imgCount = (html.match(/<img[\s>]/gi) || []).length;
    const textLength = html.replace(/<[^>]+>/g, '').length;
    const hasTable = /<table[\s>]/i.test(html);

    let estimate = 0;
    // ~20px per 80 chars of text (rough line-wrap heuristic at ~400px container width)
    estimate += Math.ceil(textLength / 80) * 20;
    // Images: assume ~200px each on average
    estimate += imgCount * 200;
    // Tables add some bulk
    if (hasTable) estimate += 100;

    estimate = Math.max(CreatorNotesConfig.MIN_HEIGHT, Math.min(estimate, CreatorNotesConfig.MAX_HEIGHT));
    return estimate;
}

/**
 * Create and configure the sandboxed iframe
 * @param {string} srcdoc - The iframe document content
 * @param {number} [initialHeight] - Optional initial height in pixels
 * @returns {HTMLIFrameElement} - Configured iframe element
 */
function createCreatorNotesIframe(srcdoc, initialHeight) {
    const iframe = document.createElement('iframe');
    iframe.sandbox = 'allow-same-origin allow-popups allow-popups-to-escape-sandbox';
    const h = initialHeight || CreatorNotesConfig.MIN_HEIGHT;
    iframe.style.cssText = `
        width: 100%;
        height: ${h}px;
        min-height: ${CreatorNotesConfig.MIN_HEIGHT}px;
        max-height: none;
        border: none;
        background: transparent;
        border-radius: var(--radius-lg);
        display: block;
    `;
    iframe.srcdoc = srcdoc;
    return iframe;
}

/**
 * Setup auto-resize behavior for creator notes iframe
 * Handles both short content (auto-fit) and long content (scrollable)
 * @param {HTMLIFrameElement} iframe - The iframe element
 */
function setupCreatorNotesResize(iframe, onSettled) {
    let settled = false;
    const settle = () => { if (settled) return; settled = true; try { onSettled?.(); } catch (e) { /* ignore */ } };
    iframe.onload = () => {
        try {
            const doc = iframe.contentDocument;
            const wrapper = doc?.getElementById('content-wrapper');

            if (!doc || !wrapper) {
                iframe.style.height = '200px';
                settle();
                return;
            }
            
            let currentHeight = 0;
            let resizeObserver = null;
            
            const measureAndApply = () => {
                if (!wrapper) return;
                
                const rect = wrapper.getBoundingClientRect();
                const contentHeight = Math.ceil(rect.height) + CreatorNotesConfig.BODY_PADDING;
                
                // If content fits within max height, show it all (no scroll)
                // If content exceeds max height, cap at max and enable scrolling
                const needsScroll = contentHeight > CreatorNotesConfig.MAX_HEIGHT;
                const targetHeight = needsScroll 
                    ? CreatorNotesConfig.MAX_HEIGHT 
                    : Math.max(CreatorNotesConfig.MIN_HEIGHT, contentHeight);
                
                // Apply overflow based on whether we need scrolling
                doc.body.style.overflowY = needsScroll ? 'auto' : 'hidden';
                doc.body.style.overflowX = 'hidden';
                
                // Only update if changed significantly
                if (Math.abs(targetHeight - currentHeight) > 3) {
                    currentHeight = targetHeight;
                    iframe.style.height = targetHeight + 'px';
                }
            };
            
            // Use ResizeObserver for dynamic content
            if (typeof ResizeObserver !== 'undefined') {
                resizeObserver = new ResizeObserver(measureAndApply);
                resizeObserver.observe(wrapper);
                // Store on iframe so cleanup can disconnect it
                iframe._resizeObserver = resizeObserver;
            }
            
            // Handle lazy-loaded images
            doc.querySelectorAll('img').forEach(img => {
                if (!img.complete) {
                    img.addEventListener('load', measureAndApply);
                    img.addEventListener('error', measureAndApply);
                }
            });
            
            // Initial measurements with delays for CSS parsing
            measureAndApply();
            setTimeout(measureAndApply, 50);
            // Reveal behind the curtain at near-final height; image-heavy notes wait for pending images (capped) so they dont show mid-reflow.
            const pendingImgs = Array.from(doc.images).filter(img => !img.complete);
            if (pendingImgs.length === 0) {
                setTimeout(() => { measureAndApply(); settle(); }, 150);
            } else {
                let waiting = pendingImgs.length;
                const imgDone = () => { if (--waiting === 0) { measureAndApply(); settle(); } };
                pendingImgs.forEach(img => {
                    img.addEventListener('load', imgDone, { once: true });
                    img.addEventListener('error', imgDone, { once: true });
                });
                setTimeout(() => { measureAndApply(); settle(); }, 1200);
            }
            setTimeout(measureAndApply, 400);

        } catch (e) {
            console.error('Creator notes resize error:', e);
            iframe.style.height = '200px';
            settle();
        }
    };
}

/**
 * Render creator notes in a sandboxed iframe with full CSS support
 * Main entry point for rich creator notes rendering
 * @param {string} content - The creator notes content
 * @param {string} charName - Character name for placeholder replacement
 * @param {HTMLElement} container - Container element to render into
 */
/**
 * Clean up an existing creator notes iframe - disconnect observer, blank src, remove DOM
 * @param {HTMLElement} container - The container holding the iframe
 */
function cleanupCreatorNotesContainer(container) {
    if (!container) return;
    // All iframes, not the first: the reveal bridge legitimately holds two during a re-render window.
    for (const iframe of container.querySelectorAll('iframe')) {
        // Disconnect the ResizeObserver to break circular references
        if (iframe._resizeObserver) {
            try { iframe._resizeObserver.disconnect(); } catch (e) { /* ignore */ }
            iframe._resizeObserver = null;
        }
        // Clear onload to prevent stale closure from firing
        iframe.onload = null;
        try { iframe.src = 'about:blank'; } catch (e) { /* ignore */ }
    }
    container.innerHTML = '';
}

/**
 * Paint the detail modal's Creator Notes panel from `char`, and return the raw
 * notes string so callers can hand it on (media localization wants it).
 *
 * Called twice per open: once on the synchronous paint, and again after
 * hydrateCharacter resolves -- a slim card carries no notes (the archive's list
 * payload has no prose), so the first call always hides the panel and the second
 * is the one that fills it. Shared rather than duplicated because the two call
 * sites drifting is what hid the panel in the first place.
 *
 * @param {Object} char
 * @returns {string} the notes, or '' when the card has none
 */
function renderModalCreatorNotes(char) {
    const creatorNotes = char.creator_notes || (char.data ? char.data.creator_notes : "") || "";
    const notesBox = document.getElementById('modalCreatorNotesBox');
    const notesContainer = document.getElementById('modalCreatorNotes');

    if (creatorNotes && notesBox && notesContainer) {
        notesBox.style.display = 'block';
        const detailsEl = document.getElementById('creatorNotesDetails');
        if (detailsEl) detailsEl.open = !!getSetting('expandCreatorNotes');
        // Store raw content for fullscreen expand feature
        window.currentCreatorNotesContent = creatorNotes;
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

    return creatorNotes;
}

function renderCreatorNotesSecure(content, charName, container) {
    if (!content || !container) return;

    if (!getSetting('richCreatorNotes')) {
        cleanupCreatorNotesContainer(container);
        renderCreatorNotesSimple(content, charName, container);
        return;
    }

    renderCardHtmlSecure(content, charName, container);
}

/** Sandboxed-iframe render for any third-party card field; authored CSS applies inside the frame, never to the app. */
function renderCardHtmlSecure(content, charName, container) {
    if (!content || !container) return;

    // Disconnect old observers but leave DOM in place; the prior render bridges the new iframe's
    // first paint. All iframes, not the first: a re-render inside the bridge window finds two.
    for (const oldIframe of container.querySelectorAll('iframe')) {
        if (oldIframe._resizeObserver) {
            try { oldIframe._resizeObserver.disconnect(); } catch (e) { /* ignore */ }
            oldIframe._resizeObserver = null;
        }
        oldIframe.onload = null;
    }

    const formatted = formatRichText(content, charName, true);
    const sanitizedHTML = sanitizeCreatorNotesHTML(formatted);
    const sanitizedCSS = sanitizeCreatorNotesCSS(sanitizedHTML);
    const hardened = hardenCreatorNotesMedia(sanitizedCSS);

    const iframeDoc = buildCreatorNotesIframeDoc(hardened);
    const initialHeight = estimateCreatorNotesHeight(hardened);

    // Bridge only for the same character; identity changes and empty containers hold the slot
    // with estimate-sized skeletons (padded to land where the first text line renders).
    const renderKey = charName || '';
    if (container.childElementCount === 0 || container._clnCharKey !== renderKey) {
        const lineCount = Math.max(3, Math.min(8, Math.round(initialHeight / 45)));
        let bars = '';
        for (let i = 0; i < lineCount; i++) bars += `<div class="cl-skeleton-line${i % 3 === 2 ? ' short' : ''}"></div>`;
        container.innerHTML = `<div class="cl-notes-skeleton" style="padding: var(--space-md) var(--space-2xs) var(--space-sm);">${bars}</div>`;
    }
    container._clnCharKey = renderKey;

    const iframe = createCreatorNotesIframe(iframeDoc, initialHeight);

    const priorChildren = Array.from(container.children);
    const hasBridge = priorChildren.length > 0;
    // Skeleton bridges fade the content in; real-content bridges swap instantly (cross-fades looked bad on fast prev/next).
    const fadeIn = !hasBridge || priorChildren.every(el => el.classList?.contains('cl-notes-skeleton'));

    // Keep prior notes visible until the new iframe loads, then swap instantly (cross-fading looked bad on fast prev/next).
    // Iframe stays opacity 0 until load so unstyled content never flashes; a render token drops superseded late renders.
    const prevContainerPosition = container.style.position;
    if (hasBridge) {
        // Overlay the new iframe so the still-visible prior notes hold the section height until the swap.
        container.style.position = 'relative';
        iframe.style.position = 'absolute';
        iframe.style.top = '0';
        iframe.style.left = '0';
        iframe.style.right = '0';
    }

    iframe.style.height = `${initialHeight}px`;
    // Override the iframe cssText min-height too; measureAndApply re-floors via height post-load.
    iframe.style.minHeight = '0';
    iframe.style.opacity = '0';
    iframe.style.transition = fadeIn ? 'opacity 0.25s ease-out' : '';

    const myToken = (container._clnRenderToken = (container._clnRenderToken || 0) + 1);
    container.appendChild(iframe);

    let revealed = false;
    const reveal = () => {
        if (revealed) return;
        revealed = true;
        // Skip if cleanupCreatorNotesContainer wiped the iframe between bridge start and reveal.
        if (!iframe.isConnected) return;
        // Superseded by a newer render (rapid prev/next): drop this stale frame instead of swapping in.
        if (container._clnRenderToken !== myToken) {
            try { iframe.remove(); } catch (e) { /* ignore */ }
            return;
        }
        // Join the flow at the bridge height, then morph to the settled height so the sections below slide instead of snapping.
        const targetHeight = iframe.style.height;
        const fromHeight = container.offsetHeight;
        priorChildren.forEach(el => { try { el.remove(); } catch (e) { /* ignore */ } });
        iframe.style.transition = '';
        iframe.style.position = '';
        iframe.style.top = '';
        iframe.style.left = '';
        iframe.style.right = '';
        container.style.position = prevContainerPosition;
        iframe.style.height = `${fromHeight}px`;
        void iframe.offsetHeight;
        iframe.style.transition = (fadeIn ? 'opacity 0.25s ease-out, ' : '') + 'height 0.25s ease-out';
        iframe.style.opacity = '1';
        iframe.style.height = targetHeight;
    };

    // Reveal once the height has settled (driven by setupCreatorNotesResize) so the settle snaps stay hidden
    // behind the opacity/bridge curtain. Kill-switch in case load/settle never fires.
    setTimeout(reveal, 3000);

    setupCreatorNotesResize(iframe, reveal);
}

/**
 * Open creator notes in a fullscreen modal
 * Shows content with more vertical space for reading
 * @param {string} content - The creator notes content  
 * @param {string} charName - Character name for placeholder replacement
 * @param {Object} [urlMap] - Pre-built localization map (optional)
 */
function openCreatorNotesFullscreen(content, charName, urlMap) {
    if (!content) {
        showToast('No creator notes to display', 'warning');
        return;
    }
    
    // Apply media localization if urlMap is provided
    let localizedContent = content;
    if (urlMap && Object.keys(urlMap).length > 0) {
        localizedContent = replaceMediaUrlsInText(content, urlMap);
    }
    
    // Process content through the same pipeline
    const formatted = formatRichText(localizedContent, charName, true);
    const sanitizedHTML = sanitizeCreatorNotesHTML(formatted);
    const sanitizedCSS = sanitizeCreatorNotesCSS(sanitizedHTML);
    const hardened = hardenCreatorNotesMedia(sanitizedCSS);
    
    // Build simple iframe document - content fills width naturally
    const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'self' data: blob:; script-src 'none'; object-src 'none'; form-action 'none'; img-src * data: blob:; media-src * data: blob:; style-src 'self' 'unsafe-inline'; font-src * data:;">`;
    const styles = getCreatorNotesBaseStyles();
    const iframeDoc = `<!DOCTYPE html><html><head><meta charset="UTF-8">${csp}${styles}</head><body style="overflow-y: auto; overflow-x: hidden; height: 100%; padding: 15px;"><div id="content-wrapper">${hardened}</div></body></html>`;
    
    // Build simple fullscreen modal - size and zoom buttons
    const modalHtml = `
        <div id="creatorNotesFullscreenModal" class="modal-overlay">
            <div class="modal-glass creator-notes-fullscreen-modal" id="creatorNotesFullscreenInner" data-size="normal">
                <div class="modal-header">
                    <h2><i class="fa-solid fa-feather-pointed"></i> Creator's Notes</h2>
                    <div class="creator-notes-display-controls">
                        <div class="display-control-btns zoom-controls" id="zoomControlBtns">
                            <button type="button" class="display-control-btn" data-zoom="out" title="Zoom Out">
                                <i class="fa-solid fa-minus"></i>
                            </button>
                            <span class="zoom-level" id="zoomLevelDisplay">100%</span>
                            <button type="button" class="display-control-btn" data-zoom="in" title="Zoom In">
                                <i class="fa-solid fa-plus"></i>
                            </button>
                            <button type="button" class="display-control-btn" data-zoom="reset" title="Reset Zoom">
                                <i class="fa-solid fa-rotate-left"></i>
                            </button>
                        </div>
                        <div class="display-control-btns" id="sizeControlBtns">
                            <button type="button" class="display-control-btn" data-size="compact" title="Compact">
                                <i class="fa-solid fa-compress"></i>
                            </button>
                            <button type="button" class="display-control-btn active" data-size="normal" title="Normal">
                                <i class="fa-regular fa-window-maximize"></i>
                            </button>
                            <button type="button" class="display-control-btn" data-size="wide" title="Wide">
                                <i class="fa-solid fa-expand"></i>
                            </button>
                        </div>
                    </div>
                    <div class="modal-controls">
                        <button class="close-btn" id="creatorNotesFullscreenClose">&times;</button>
                    </div>
                </div>
                <div class="creator-notes-fullscreen-body">
                    <iframe 
                        id="creatorNotesFullscreenIframe"
                        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
                    ></iframe>
                </div>
            </div>
        </div>
    `;
    
    // Remove existing modal if any
    const existingModal = document.getElementById('creatorNotesFullscreenModal');
    if (existingModal) existingModal.remove();
    
    document.body.insertAdjacentHTML('beforeend', modalHtml);
    
    const modal = document.getElementById('creatorNotesFullscreenModal');
    const modalInner = document.getElementById('creatorNotesFullscreenInner');
    const iframe = document.getElementById('creatorNotesFullscreenIframe');
    
    // Set iframe content
    iframe.srcdoc = iframeDoc;
    
    // Size control handlers - just toggle class on modal
    on('sizeControlBtns', 'click', (e) => {
        const btn = e.target.closest('.display-control-btn[data-size]');
        if (!btn) return;
        
        const size = btn.dataset.size;
        document.querySelectorAll('#sizeControlBtns .display-control-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        modalInner.dataset.size = size;
    });
    
    // Zoom control handlers for iframe content
    let currentZoom = 100;
    const zoomDisplay = document.getElementById('zoomLevelDisplay');
    
    const updateIframeZoom = (zoom) => {
        currentZoom = Math.max(50, Math.min(200, zoom));
        zoomDisplay.textContent = `${currentZoom}%`;
        const scale = currentZoom / 100;
        
        const applyZoom = () => {
            try {
                const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
                if (iframeDoc && iframeDoc.body) {
                    const wrapper = iframeDoc.getElementById('content-wrapper');
                    if (wrapper) {
                        // Use transform on wrapper - scales everything including images
                        wrapper.style.transform = `scale(${scale})`;
                        // Use top center origin to keep content horizontally centered
                        wrapper.style.transformOrigin = 'top center';
                        // Adjust wrapper width so scaled content fits properly
                        wrapper.style.width = scale <= 1 ? '100%' : `${100 / scale}%`;
                        // Center the wrapper itself
                        wrapper.style.margin = '0 auto';
                    }
                    // Also try CSS zoom as fallback for browsers that support it
                    iframeDoc.body.style.zoom = scale;
                }
            } catch (e) {
                console.warn('Could not apply zoom to iframe:', e);
            }
        };
        
        applyZoom();
    };
    
    // Apply zoom after iframe content loads
    iframe.addEventListener('load', () => {
        // Small delay to ensure content is fully rendered
        setTimeout(() => updateIframeZoom(currentZoom), 50);
    });
    
    on('zoomControlBtns', 'click', (e) => {
        const btn = e.target.closest('.display-control-btn[data-zoom]');
        if (!btn) return;
        
        const action = btn.dataset.zoom;
        if (action === 'in') updateIframeZoom(currentZoom + 10);
        else if (action === 'out') updateIframeZoom(currentZoom - 10);
        else if (action === 'reset') updateIframeZoom(100);
    });
    
    // Close handlers
    const closeModal = () => {
        modal.remove();
        document.removeEventListener('keydown', handleKeydown);
    };
    
    const handleKeydown = (e) => {
        if (e.key === 'Escape') closeModal();
    };
    
    document.getElementById('creatorNotesFullscreenClose').onclick = closeModal;
    modal.onclick = (e) => { if (e.target === modal) closeModal(); };
    document.addEventListener('keydown', handleKeydown);
}

/**
 * Initialize creator notes event handlers
 * Call this after modal content is loaded
 */
function initCreatorNotesHandlers() {
    const expandBtn = document.getElementById('creatorNotesExpandBtn');
    
    // Expand button opens fullscreen modal
    // Use a named handler reference to prevent listener accumulation across modal opens
    if (expandBtn) {
        // Remove any previously attached handler before adding a new one
        if (expandBtn._creatorNotesHandler) {
            expandBtn.removeEventListener('click', expandBtn._creatorNotesHandler);
        }
        expandBtn._creatorNotesHandler = async (e) => {
            e.preventDefault();
            e.stopPropagation(); // Prevent toggling the details

            const charName = getCharacterName(activeChar) || 'Character';

            if (window.currentCreatorNotesContent) {
                // Build localization map if enabled for this character
                let urlMap = null;
                if (activeChar && activeChar.avatar && isMediaLocalizationEnabled(activeChar.avatar)) {
                    const folderName = getGalleryFolderName(activeChar);
                    urlMap = await buildMediaLocalizationMap(folderName, activeChar.avatar);
                }
                openCreatorNotesFullscreen(window.currentCreatorNotesContent, charName, urlMap);
            } else {
                showToast('Creator notes not available', 'warning');
            }
        };
        expandBtn.addEventListener('click', expandBtn._creatorNotesHandler);
    }
}

/**
 * Open content in a fullscreen modal
 * Generic fullscreen viewer for description, first message, etc.
 * @param {string} content - Raw content to display
 * @param {string} title - Modal title
 * @param {string} icon - FontAwesome icon class (e.g., 'fa-message')
 * @param {string} charName - Character name for placeholder replacement
 * @param {Object} [urlMap] - Pre-built localization map (optional)
 */
function openContentFullscreen(content, title, icon, charName, urlMap) {
    if (!content) {
        showToast('No content to display', 'warning');
        return;
    }
    
    // Apply media localization if urlMap is provided
    let localizedContent = content;
    if (urlMap && Object.keys(urlMap).length > 0) {
        localizedContent = replaceMediaUrlsInText(content, urlMap);
    }
    
    // Format and sanitize content
    const formatted = formatRichText(localizedContent, charName);
    const sanitized = safePurify(formatted, {
        ALLOWED_TAGS: ['p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'del', 
                       'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'code', 'pre',
                       'ul', 'ol', 'li', 'a', 'img', 'span', 'div', 'hr', 'table', 
                       'thead', 'tbody', 'tr', 'th', 'td', 'sup', 'sub', 'details', 'summary'],
        ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'class', 'style', 'target', 'rel', 'width', 'height'],
        ALLOW_DATA_ATTR: false
    });
    
    const modalHtml = `
        <div id="contentFullscreenModal" class="modal-overlay">
            <div class="modal-glass content-fullscreen-modal" id="contentFullscreenInner" data-size="normal">
                <div class="modal-header">
                    <h2><i class="fa-solid ${icon}"></i> ${escapeHtml(title)}</h2>
                    <div class="creator-notes-display-controls">
                        <div class="display-control-btns" id="contentSizeControlBtns">
                            <button type="button" class="display-control-btn" data-size="compact" title="Compact">
                                <i class="fa-solid fa-compress"></i>
                            </button>
                            <button type="button" class="display-control-btn active" data-size="normal" title="Normal">
                                <i class="fa-regular fa-window-maximize"></i>
                            </button>
                            <button type="button" class="display-control-btn" data-size="wide" title="Wide">
                                <i class="fa-solid fa-expand"></i>
                            </button>
                        </div>
                    </div>
                    <div class="modal-controls">
                        <button class="close-btn" id="contentFullscreenClose">&times;</button>
                    </div>
                </div>
                <div class="content-fullscreen-body">
                    <div class="content-wrapper">${sanitized}</div>
                </div>
            </div>
        </div>
    `;
    
    // Remove existing modal if any
    const existingModal = document.getElementById('contentFullscreenModal');
    if (existingModal) existingModal.remove();
    
    document.body.insertAdjacentHTML('beforeend', modalHtml);
    
    const modal = document.getElementById('contentFullscreenModal');
    const modalInner = document.getElementById('contentFullscreenInner');
    
    // Size control handlers
    on('contentSizeControlBtns', 'click', (e) => {
        const btn = e.target.closest('.display-control-btn[data-size]');
        if (!btn) return;
        
        const size = btn.dataset.size;
        document.querySelectorAll('#contentSizeControlBtns .display-control-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        modalInner.dataset.size = size;
    });
    
    // Close handlers
    const closeModal = () => {
        modal.remove();
        document.removeEventListener('keydown', handleKeydown);
    };
    
    const handleKeydown = (e) => {
        if (e.key === 'Escape') closeModal();
    };
    
    document.getElementById('contentFullscreenClose').onclick = closeModal;
    modal.onclick = (e) => { if (e.target === modal) closeModal(); };
    document.addEventListener('keydown', handleKeydown);
}

/**
 * Open alternate greetings in a fullscreen modal with navigation
 * @param {Array} greetings - Array of greeting strings
 * @param {string} charName - Character name for placeholder replacement
 * @param {Object} [urlMap] - Pre-built localization map (optional)
 */
function openAltGreetingsFullscreen(greetings, charName, urlMap) {
    if (!greetings || greetings.length === 0) {
        showToast('No alternate greetings to display', 'warning');
        return;
    }
    
    // Only format the first greeting now; others lazily when navigated to
    const formatGreeting = (text) => {
        let content = (text || '').trim();
        if (urlMap && Object.keys(urlMap).length > 0) {
            content = replaceMediaUrlsInText(content, urlMap);
        }
        const formatted = formatRichText(content, charName);
        return safePurify(formatted, {
            ALLOWED_TAGS: ['p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'del', 
                           'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'code', 'pre',
                           'ul', 'ol', 'li', 'a', 'img', 'span', 'div', 'hr', 'table', 
                           'thead', 'tbody', 'tr', 'th', 'td', 'sup', 'sub', 'details', 'summary'],
            ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'class', 'style', 'target', 'rel', 'width', 'height'],
            ALLOW_DATA_ATTR: false
        });
    };
    
    // Build navigation dots
    const navHtml = greetings.map((g, i) => 
        `<button type="button" class="greeting-nav-btn${i === 0 ? ' active' : ''}" data-index="${i}" title="Greeting #${i + 1}">${i + 1}</button>`
    ).join('');
    
    // Build greeting cards - only the first card has content, others render lazily
    const cardsHtml = greetings.map((g, i) => `
        <div class="greeting-card" data-greeting-index="${i}" style="${i !== 0 ? 'display: none;' : ''}">
            <div class="greeting-header">
                <div class="greeting-number">${i + 1}</div>
                <div class="greeting-label">Alternate Greeting</div>
            </div>
            <div class="greeting-content">${i === 0 ? formatGreeting(g) : ''}</div>
        </div>
    `).join('');
    
    const modalHtml = `
        <div id="altGreetingsFullscreenModal" class="modal-overlay">
            <div class="modal-glass content-fullscreen-modal" id="altGreetingsFullscreenInner" data-size="normal">
                <div class="modal-header">
                    <h2><i class="fa-solid fa-comments"></i> Alternate Greetings <span style="color: var(--text-faint); font-weight: 400; font-size: 0.9rem;">(${greetings.length})</span></h2>
                    <div class="creator-notes-display-controls">
                        <div class="display-control-btns" id="altGreetingsSizeControlBtns">
                            <button type="button" class="display-control-btn" data-size="compact" title="Compact">
                                <i class="fa-solid fa-compress"></i>
                            </button>
                            <button type="button" class="display-control-btn active" data-size="normal" title="Normal">
                                <i class="fa-regular fa-window-maximize"></i>
                            </button>
                            <button type="button" class="display-control-btn" data-size="wide" title="Wide">
                                <i class="fa-solid fa-expand"></i>
                            </button>
                        </div>
                    </div>
                    <div class="modal-controls">
                        <button class="close-btn" id="altGreetingsFullscreenClose">&times;</button>
                    </div>
                </div>
                ${greetings.length > 1 ? `<div class="greeting-nav" id="greetingNav">${navHtml}</div>` : ''}
                <div class="content-fullscreen-body">
                    ${cardsHtml}
                </div>
            </div>
        </div>
    `;
    
    // Remove existing modal if any
    const existingModal = document.getElementById('altGreetingsFullscreenModal');
    if (existingModal) existingModal.remove();
    
    document.body.insertAdjacentHTML('beforeend', modalHtml);
    
    const modal = document.getElementById('altGreetingsFullscreenModal');
    const modalInner = document.getElementById('altGreetingsFullscreenInner');
    
    // Navigation handlers
    const greetingNav = document.getElementById('greetingNav');
    if (greetingNav) {
        greetingNav.addEventListener('click', (e) => {
            const btn = e.target.closest('.greeting-nav-btn[data-index]');
            if (!btn) return;
            
            const index = parseInt(btn.dataset.index);
            
            // Update nav buttons
            greetingNav.querySelectorAll('.greeting-nav-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            
            // Show selected greeting, hide others - lazy-render on first view
            modal.querySelectorAll('.greeting-card').forEach((card, i) => {
                if (i === index) {
                    card.style.display = '';
                    // Lazy-render if content is empty
                    const contentEl = card.querySelector('.greeting-content');
                    if (contentEl && !contentEl.innerHTML.trim()) {
                        contentEl.innerHTML = formatGreeting(greetings[i]);
                    }
                } else {
                    card.style.display = 'none';
                }
            });
        });
    }
    
    // Size control handlers
    on('altGreetingsSizeControlBtns', 'click', (e) => {
        const btn = e.target.closest('.display-control-btn[data-size]');
        if (!btn) return;
        
        const size = btn.dataset.size;
        document.querySelectorAll('#altGreetingsSizeControlBtns .display-control-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        modalInner.dataset.size = size;
    });
    
    // Close handlers
    const closeModal = () => {
        modal.remove();
        document.removeEventListener('keydown', handleKeydown);
    };
    
    const handleKeydown = (e) => {
        if (e.key === 'Escape') closeModal();
    };
    
    document.getElementById('altGreetingsFullscreenClose').onclick = closeModal;
    modal.onclick = (e) => { if (e.target === modal) closeModal(); };
    document.addEventListener('keydown', handleKeydown);
}

/**
 * Initialize content expand button handlers
 * Call this after modal content is loaded
 */
function initContentExpandHandlers() {
    const charName = getCharacterName(activeChar) || 'Character';
    
    // First Message expand - clickable title
    // Use stored handler references to prevent listener accumulation across modal opens
    const firstMesTitleExpand = document.getElementById('firstMesTitleExpand');
    if (firstMesTitleExpand) {
        if (firstMesTitleExpand._expandHandler) {
            firstMesTitleExpand.removeEventListener('click', firstMesTitleExpand._expandHandler);
        }
        firstMesTitleExpand._expandHandler = async () => {
            const content = window.currentFirstMesContent;
            if (!content) {
                showToast('No first message to display', 'warning');
                return;
            }
            
            let urlMap = null;
            if (activeChar && activeChar.avatar && isMediaLocalizationEnabled(activeChar.avatar)) {
                const folderName = getGalleryFolderName(activeChar);
                urlMap = await buildMediaLocalizationMap(folderName, activeChar.avatar);
            }
            openContentFullscreen(content, 'First Message', 'fa-message', charName, urlMap);
        };
        firstMesTitleExpand.addEventListener('click', firstMesTitleExpand._expandHandler);
    }
    
    // Alt Greetings expand button
    const altGreetingsExpandBtn = document.getElementById('altGreetingsExpandBtn');
    if (altGreetingsExpandBtn) {
        if (altGreetingsExpandBtn._expandHandler) {
            altGreetingsExpandBtn.removeEventListener('click', altGreetingsExpandBtn._expandHandler);
        }
        altGreetingsExpandBtn._expandHandler = async (e) => {
            e.preventDefault();
            e.stopPropagation(); // Prevent toggling the details
            
            const greetings = window.currentAltGreetingsContent;
            if (!greetings || greetings.length === 0) {
                showToast('No alternate greetings to display', 'warning');
                return;
            }
            
            let urlMap = null;
            if (activeChar && activeChar.avatar && isMediaLocalizationEnabled(activeChar.avatar)) {
                const folderName = getGalleryFolderName(activeChar);
                urlMap = await buildMediaLocalizationMap(folderName, activeChar.avatar);
            }
            openAltGreetingsFullscreen(greetings, charName, urlMap);
        };
        altGreetingsExpandBtn.addEventListener('click', altGreetingsExpandBtn._expandHandler);
    }
}

