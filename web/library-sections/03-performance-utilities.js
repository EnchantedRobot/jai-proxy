// ========================================
// PERFORMANCE UTILITIES
// ========================================

function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

function truncate(str, max) {
    if (!str) return '';
    return str.length <= max ? str : str.slice(0, max - 3) + '...';
}



// Simple cache for expensive computations
const computationCache = new Map();
const CACHE_MAX_SIZE = 2000;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCached(key) {
    const entry = computationCache.get(key);
    if (entry && Date.now() - entry.time < CACHE_TTL) {
        return entry.value;
    }
    computationCache.delete(key);
    return undefined;
}

function setCached(key, value) {
    // Evict oldest entries if cache is full
    if (computationCache.size >= CACHE_MAX_SIZE) {
        const firstKey = computationCache.keys().next().value;
        computationCache.delete(firstKey);
    }
    computationCache.set(key, { value, time: Date.now() });
}

function clearCache() {
    computationCache.clear();
}

