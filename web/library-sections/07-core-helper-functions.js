// ========================================
// CORE HELPER FUNCTIONS
// ========================================

/**
 * Make an API request with CSRF token automatically included
 * @param {string} endpoint - API endpoint (e.g., '/characters/get')
 * @param {string} method - HTTP method (default: 'GET')
 * @param {object|null} data - Request body data (will be JSON stringified)
 * @param {object} options - Additional fetch options
 * @returns {Promise<Response>} Fetch response
 */
async function apiRequest(endpoint, method = 'GET', data = null, options = {}) {
    const csrfToken = getCSRFToken();
    const config = {
        method,
        headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken,
            ...options.headers
        },
        ...options
    };
    if (data !== null) {
        config.body = JSON.stringify(data);
    }
    return fetch(`${API_BASE}${endpoint}`, config);
}

/**
 * Shorthand event listener registration
 * @param {string} id - Element ID
 * @param {string} event - Event type (e.g., 'click')
 * @param {Function} handler - Event handler function
 * @returns {boolean} True if listener was attached
 */
function on(id, event, handler) {
    const el = document.getElementById(id);
    if (el) {
        el.addEventListener(event, handler);
        return true;
    }
    return false;
}

function show(id) {
    document.getElementById(id)?.classList.remove('hidden');
}

function hide(id) {
    document.getElementById(id)?.classList.add('hidden');
}

function findCardElement(avatar) {
    return document.querySelector(`.char-card[data-avatar="${CSS.escape(avatar)}"]`);
}

function getCharacterByAvatar(avatar) {
    return allCharacters.find(c => c.avatar === avatar);
}

function isMultiSelectEnabled() {
    return window.MultiSelect?.enabled || false;
}

