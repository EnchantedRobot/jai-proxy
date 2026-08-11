// ========================================
// WORLD INFO API
// ========================================

/*
 * ARCHIVE FORK: the standalone world-file helpers, answered locally.
 *
 * These wrapped SillyTavern's `/api/worldinfo/{get,edit,list,delete}`, which
 * read and wrote `.json` files in ST's `worlds/` directory. The archive has no
 * such directory and will not grow one: a standalone World Info file is a
 * SillyTavern concept, and this archive's lorebooks live *inside* their cards as
 * `character_book`, edited through the card modal and written by the card write
 * path. That is a format the archive owns; a sidecar file store beside it is
 * host compatibility, which is the thing this migration exists to cut.
 *
 * So they answer without a request rather than posting into a 501. The one
 * caller that remains -- the bundle exporter's linked-lorebook include option --
 * already handles "there are none". The `/api/worldinfo/` route in
 * archive-api.js stays as the backstop for anything that reaches for the
 * endpoint directly.
 *
 * The Lorebook Manager module and the in-modal Linked Lorebook feature (which
 * let a character point at one of these external files) were both deleted;
 * create/delete/rename went with them since nothing links to a world file anymore.
 */

/** @returns {Promise<Object|null>} Always null: the archive stores no world files. */
window.getWorldInfoData = async function() {
    return null;
};

/** @returns {Promise<boolean>} Always false: there is nowhere to write a world file. */
window.saveWorldInfoData = async function() {
    return false;
};

/** @returns {Promise<Array>} Always empty: the archive has no world files to list. */
window.listWorldInfoFiles = async function() {
    return [];
};

