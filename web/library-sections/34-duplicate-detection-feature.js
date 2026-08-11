// ==============================================
// Duplicate Detection Feature
// ==============================================

/**
 * Simple hash function that works in non-secure contexts (HTTP)
 * Uses a combination of file size and content sampling
 */
function simpleHash(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    const len = bytes.length;
    
    // Create a fingerprint from: size + first 1KB + last 1KB + sampled bytes
    let hash = len;
    
    // Mix in first 1024 bytes
    const firstChunk = Math.min(1024, len);
    for (let i = 0; i < firstChunk; i++) {
        hash = ((hash << 5) - hash + bytes[i]) | 0;
    }
    
    // Mix in last 1024 bytes
    const lastStart = Math.max(0, len - 1024);
    for (let i = lastStart; i < len; i++) {
        hash = ((hash << 5) - hash + bytes[i]) | 0;
    }
    
    // Sample every 4KB for large files
    if (len > 8192) {
        const step = Math.floor(len / 100);
        for (let i = 0; i < len; i += step) {
            hash = ((hash << 5) - hash + bytes[i]) | 0;
        }
    }
    
    // Convert to hex string
    return (hash >>> 0).toString(16).padStart(8, '0') + '_' + len.toString(16);
}

/**
 * Calculate hash of an ArrayBuffer - uses crypto.subtle if available, falls back to simpleHash
 */
async function calculateHash(arrayBuffer) {
    // Try crypto.subtle first (only works in secure contexts - HTTPS or localhost)
    if (window.crypto && window.crypto.subtle) {
        try {
            const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        } catch (e) {
            debugLog('[Duplicates] crypto.subtle failed, using fallback hash');
        }
    }
    
    // Fallback to simple hash for HTTP contexts
    return simpleHash(arrayBuffer);
}

