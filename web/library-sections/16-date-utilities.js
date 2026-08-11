// ==============================================
// DATE UTILITIES
// ==============================================

/**
 * Resolve a character's create_date value from any supported location.
 * Some sources store it at the top level, others under _meta or data.
 *
 * @param {object} char - Character object
 * @returns {string} Date string or empty string
 */
function getCharacterCreateDateValue(char) {
    if (!char) return '';
    const candidates = [
        char._meta?.create_date,
        char.create_date,
        char.data?.create_date,
    ].filter(Boolean);
    const withTime = candidates.find(value =>
        typeof value === 'number' || /T\d{2}:\d{2}:\d{2}/.test(String(value))
    );
    return withTime || candidates[0] || '';
}

/**
 * Parse a date string or number into a Date object.
 * Falls back to manual ISO parsing to avoid Date() misparsing in some runtimes.
 *
 * @param {string|number} rawValue - Date value
 * @returns {Date|null} Parsed Date or null
 */
function parseDateValue(rawValue) {
    if (rawValue === undefined || rawValue === null || rawValue === '') return null;
    if (typeof rawValue === 'number') {
        const d = new Date(rawValue);
        return isNaN(d.getTime()) ? null : d;
    }
    const rawString = String(rawValue).trim();
    const isoMatch = rawString.match(
        /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(?:Z)?$/
    );
    if (isoMatch) {
        const year = Number(isoMatch[1]);
        const month = Number(isoMatch[2]) - 1;
        const day = Number(isoMatch[3]);
        const hour = Number(isoMatch[4]);
        const minute = Number(isoMatch[5]);
        const second = Number(isoMatch[6]);
        const ms = isoMatch[7] ? Number(isoMatch[7].padEnd(3, '0')) : 0;
        const d = new Date(Date.UTC(year, month, day, hour, minute, second, ms));
        return isNaN(d.getTime()) ? null : d;
    }
    const d = new Date(rawString);
    return isNaN(d.getTime()) ? null : d;
}

/**
 * Format a date string/number into a locale date+time string.
 * Falls back to the raw value if parsing fails.
 *
 * @param {string|number} rawValue - Date value
 * @returns {string} Formatted date string
 */
function formatDateTime(rawValue) {
    if (!rawValue) return '(not available)';
    const d = parseDateValue(rawValue);
    if (!d) return String(rawValue);
    return new Intl.DateTimeFormat(undefined, {
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit'
    }).format(d);
}

/**
 * Get the date a character was added to SillyTavern (file system time).
 * This changes whenever the character file is edited/rewritten.
 * 
 * @param {object} char - Character object
 * @returns {number} Timestamp in milliseconds for sorting
 */
function getCharacterDateAdded(char) {
    if (!char) return 0;
    if (char.date_added) {
        return Number(char.date_added) || 0;
    }
    return 0;
}

/**
 * Get the original creation date of a character (from PNG metadata).
 * This is stable and doesn't change when the character is edited.
 * 
 * @param {object} char - Character object
 * @returns {number} Timestamp in milliseconds for sorting
 */
function getCharacterCreateDate(char) {
    if (!char) return 0;
    const rawCreateDate = getCharacterCreateDateValue(char);
    if (rawCreateDate) {
        const d = parseDateValue(rawCreateDate);
        if (d) return d.getTime();
    }
    return 0;
}

