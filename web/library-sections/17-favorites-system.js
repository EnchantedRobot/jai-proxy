// ==============================================
// FAVORITES SYSTEM
// ==============================================

/**
 * Check if a character is marked as favorite
 * SillyTavern stores favorites in both root level 'fav' and data.extensions.fav
 * @param {object} char - Character object
 * @returns {boolean} True if character is a favorite
 */
function isCharacterFavorite(char) {
    if (!char) return false;
    // Check both locations - root level and spec v2 location
    // SillyTavern uses both boolean and string 'true'
    const rootFav = char.fav === true || char.fav === 'true';
    const extFav = char.data?.extensions?.fav === true || char.data?.extensions?.fav === 'true';
    return rootFav || extFav;
}

/**
 * Toggle the favorite status of a character
 * Uses SillyTavern's merge-attributes API to update the character
 * @param {object} char - Character object to toggle
 */
async function toggleCharacterFavorite(char) {
    if (!char || !char.avatar) {
        showToast('No character selected', 'error');
        return;
    }

    const currentFavStatus = isCharacterFavorite(char);
    const newFavStatus = !currentFavStatus;

    hapticFeedback(12);

    try {
        // Route through applyCardFieldUpdates; ST notify mirrors fav into the main window via getOneCharacter.
        const success = await window.applyCardFieldUpdates(char.avatar, {
            'extensions.fav': newFavStatus,
        });
        if (!success) {
            showToast('Error updating favorite', 'error');
            return;
        }
        // Mirror root-level char.fav for back-compat with readers that check the root field directly.
        char.fav = newFavStatus;

        // Same-tick ST sync; the helper's notify refetch is async, this gives instant visibility.
        try {
            const context = getSTContext();
            if (context && context.characters) {
                const stIdx = context.characters.findIndex(c => c.avatar === char.avatar);
                if (stIdx !== -1) {
                    context.characters[stIdx].fav = newFavStatus;
                    if (context.characters[stIdx].data?.extensions) {
                        context.characters[stIdx].data.extensions.fav = newFavStatus;
                    }
                }
            }
        } catch (e) {
            console.warn('[Favorites] Could not update main window:', e);
        }

        // Update UI
        updateFavoriteButtonUI(newFavStatus);
        updateCharacterCardFavoriteStatus(char.avatar, newFavStatus);

        showToast(newFavStatus ? 'Added to favorites!' : 'Removed from favorites', 'success');

        // If showing favorites only and just unfavorited, refresh grid
        if (showFavoritesOnly && !newFavStatus) {
            performSearch();
        }
    } catch (e) {
        showToast('Network error: ' + e.message, 'error');
    }
}

/**
 * Update the favorite button UI in the modal
 * @param {boolean} isFavorite - Whether the character is a favorite
 */
function updateFavoriteButtonUI(isFavorite) {
    const btn = document.getElementById('favoriteCharBtn');
    if (!btn) return;
    
    if (isFavorite) {
        btn.classList.add('is-favorite');
        btn.innerHTML = '<i class="fa-solid fa-star"></i>';
        btn.title = 'Remove from Favorites';
    } else {
        btn.classList.remove('is-favorite');
        btn.innerHTML = '<i class="fa-regular fa-star"></i>';
        btn.title = 'Add to Favorites';
    }
}

/**
 * Update the favorite indicator on a character card in the grid
 * @param {string} avatar - Character avatar filename
 * @param {boolean} isFavorite - Whether the character is a favorite
 */
function updateCharacterCardFavoriteStatus(avatar, isFavorite) {
    const card = findCardElement(avatar);
    if (!card) return;
    if (isFavorite) {
        card.classList.add('is-favorite');
        if (!card.querySelector('.favorite-indicator')) {
            const indicator = document.createElement('div');
            indicator.className = 'favorite-indicator';
            indicator.innerHTML = '<i class="fa-solid fa-star"></i>';
            card.appendChild(indicator);
        }
    } else {
        card.classList.remove('is-favorite');
        const indicator = card.querySelector('.favorite-indicator');
        if (indicator) indicator.remove();
    }
}

/**
 * Toggle the favorites-only filter
 */
function toggleFavoritesFilter(forceState) {
    const checkbox = document.getElementById('searchFavoritesOnly');
    if (typeof forceState === 'boolean') {
        showFavoritesOnly = forceState;
        if (checkbox) checkbox.checked = forceState;
    } else {
        showFavoritesOnly = checkbox ? checkbox.checked : !showFavoritesOnly;
    }
    const settingsBtn = document.getElementById('searchSettingsBtn');
    if (settingsBtn) {
        settingsBtn.classList.toggle('active', showFavoritesOnly);
    }
    const filterBtn = document.getElementById('favoritesFilterBtn');
    if (filterBtn) {
        filterBtn.classList.toggle('is-active', showFavoritesOnly);
        filterBtn.setAttribute('aria-pressed', String(showFavoritesOnly));
    }
    performSearch();
}

