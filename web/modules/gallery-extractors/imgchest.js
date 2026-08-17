/**
 * Imgchest Gallery Extractor
 *
 * Extracts images from imgchest.com post pages via embedded JSON data.
 * The page embeds a `data-page="..."` attribute containing a JSON object
 * with props.post.files[], each having a `link` to the CDN URL.
 *
 * Pattern: https://imgchest.com/p/{postId}
 * CDN URLs: https://cdn.imgchest.com/files/{filename}
 */

import { registerExtractor } from './extractor-registry.js';
import { proxyEncode } from '../providers/provider-utils.js';

const IMGCHEST_PATTERNS = [
    /imgchest\.com\/p\/[a-zA-Z0-9]+/
];

const DATA_PAGE_REGEX = /data-page="([^"]+)"/;
const CDN_URL_REGEX = /https?:\/\/cdn\.imgchest\.com\/files\/[^\s"'<>]+?\.(png|jpe?g|gif|webp)/gi;

const REQUEST_DELAY_MS = 300;

/**
 * @param {string} url - Imgchest post URL
 * @param {Object} opts
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<import('./extractor-registry.js').ExtractorResult>}
 */
async function extractImages(url, opts = {}) {
    const { signal } = opts;

    if (signal?.aborted) return { images: [], aborted: true };

    try {
        const html = await fetchPage(url, signal);

        if (isPasswordProtected(html)) {
            return { images: [], error: 'Password-protected post (not supported)' };
        }

        const images = extractFromDataPage(html);
        if (images.length > 0) return { images };

        const fallback = extractFromRegex(html);
        if (fallback.length > 0) return { images: fallback };

        return { images: [], error: 'No images found on page' };
    } catch (err) {
        if (err.name === 'AbortError') return { images: [], aborted: true };
        return { images: [], error: err.message };
    }
}

function isPasswordProtected(html) {
    return html.includes('PostPassword');
}

function extractFromDataPage(html) {
    const match = DATA_PAGE_REGEX.exec(html);
    if (!match) return [];

    try {
        const ta = document.createElement('textarea');
        ta.innerHTML = match[1];
        const decoded = ta.value;

        const data = JSON.parse(decoded);
        const files = data?.props?.post?.files;
        if (!Array.isArray(files) || files.length === 0) return [];

        return files
            .filter(f => f.link && typeof f.link === 'string')
            .map(f => ({
                url: f.link,
                filename: f.link.split('/').pop()
            }));
    } catch {
        return [];
    }
}

function extractFromRegex(html) {
    const found = new Set();
    CDN_URL_REGEX.lastIndex = 0;
    let m;
    while ((m = CDN_URL_REGEX.exec(html)) !== null) {
        found.add(m[0]);
    }
    return [...found].map(imgUrl => ({
        url: imgUrl,
        filename: imgUrl.split('/').pop()
    }));
}

async function fetchPage(url, signal) {
    let response;
    try {
        response = await fetch(url, { signal });
    } catch (_) {
        const proxyUrl = `/proxy/${proxyEncode(url)}`;
        response = await fetch(proxyUrl, { signal });
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
}

// Register
registerExtractor({
    id: 'imgchest',
    name: 'Imgchest',
    patterns: IMGCHEST_PATTERNS,
    extractImages,
    requestDelay: REQUEST_DELAY_MS
});
