// ==============================================
// Visual Tag Editing in Sidebar
// ==============================================

/**
 * Get all unique tags from all characters for autocomplete
 */
function getAllAvailableTags() {
    const tags = new Set();
    allCharacters.forEach(c => {
        const charTags = getTags(c);
        if (Array.isArray(charTags)) {
            charTags.forEach(t => tags.add(t));
        }
    });
    return Array.from(tags).sort((a, b) => a.localeCompare(b));
}

/**
 * Get current tags from the in-memory backing array
 */
let _editTagsArray = [];
function getCurrentTagsArray() {
    return [..._editTagsArray];
}

/**
 * Set tags in the backing array
 */
function setTagsFromArray(tagsArray) {
    _editTagsArray = [...tagsArray];
}

/**
 * Add a tag to the current character
 */
function addTag(tag) {
    const trimmedTag = tag.trim();
    if (!trimmedTag) return;
    
    const currentTags = getCurrentTagsArray();
    
    if (currentTags.some(t => t.toLowerCase() === trimmedTag.toLowerCase())) {
        showToast(`Tag "${trimmedTag}" already exists`, 'info');
        return;
    }
    
    currentTags.push(trimmedTag);
    setTagsFromArray(currentTags);
    renderSidebarTags(currentTags, true);
    refreshApplyState?.();

    // Clear sidebar input
    const tagInput = document.getElementById('tagInput');
    if (tagInput) tagInput.value = '';

    hideTagAutocomplete();
}

/**
 * Remove a tag from the current character
 */
function removeTag(tag) {
    const currentTags = getCurrentTagsArray();
    const newTags = currentTags.filter(t => t !== tag);
    setTagsFromArray(newTags);
    renderSidebarTags(newTags, true);
    refreshApplyState?.();
}

/**
 * Render tags in the sidebar with optional edit controls
 */
function renderSidebarTags(tags, editable = false) {
    const tagsContainer = document.getElementById('modalTags');
    if (!tagsContainer) return;
    
    if (!tags || tags.length === 0) {
        tagsContainer.innerHTML = editable 
            ? '<span class="no-tags-hint">No tags yet. Type below to add.</span>'
            : '';
        return;
    }
    
    if (editable) {
        tagsContainer.innerHTML = tags.map(t => `
            <span class="modal-tag editable">
                ${escapeHtml(t)}
                <button class="tag-remove-btn" data-tag="${escapeHtml(t)}" title="Remove tag">
                    <i class="fa-solid fa-times"></i>
                </button>
            </span>
        `).join('');
        
        // Add click handlers for remove buttons
        tagsContainer.querySelectorAll('.tag-remove-btn').forEach(btn => {
            btn.onclick = (e) => {
                e.stopPropagation();
                const tagToRemove = btn.dataset.tag;
                removeTag(tagToRemove);
            };
        });
    } else {
        tagsContainer.innerHTML = tags.map(t => 
            `<span class="modal-tag">${escapeHtml(t)}</span>`
        ).join('');
    }
}

/**
 * Show tag autocomplete dropdown
 */
function showTagAutocomplete(filterText = '') {
    const autocomplete = document.getElementById('tagAutocomplete');
    if (!autocomplete) return;
    
    const allTags = getAllAvailableTags();
    const currentTags = getCurrentTagsArray().map(t => t.toLowerCase());
    const filter = filterText.toLowerCase();
    
    // Filter tags: match filter and not already added
    const suggestions = allTags.filter(tag => {
        const tagLower = tag.toLowerCase();
        return tagLower.includes(filter) && !currentTags.includes(tagLower);
    }).slice(0, 10); // Limit to 10 suggestions
    
    if (suggestions.length === 0 && filterText.trim()) {
        // Show "create new tag" option
        autocomplete.innerHTML = `
            <div class="tag-autocomplete-item create-new" data-tag="${escapeHtml(filterText.trim())}">
                <i class="fa-solid fa-plus"></i> Create "${escapeHtml(filterText.trim())}"
            </div>
        `;
        autocomplete.classList.add('visible');
    } else if (suggestions.length > 0) {
        autocomplete.innerHTML = suggestions.map(tag => `
            <div class="tag-autocomplete-item" data-tag="${escapeHtml(tag)}">
                ${escapeHtml(tag)}
            </div>
        `).join('');
        autocomplete.classList.add('visible');
    } else {
        hideTagAutocomplete();
        return;
    }
    
    // Add click handlers
    autocomplete.querySelectorAll('.tag-autocomplete-item').forEach(item => {
        item.onclick = () => {
            addTag(item.dataset.tag);
        };
    });
}

/**
 * Hide tag autocomplete dropdown
 */
function hideTagAutocomplete() {
    const autocomplete = document.getElementById('tagAutocomplete');
    if (autocomplete) {
        autocomplete.classList.remove('visible');
    }
}

// Tag Input Event Listeners
document.addEventListener('DOMContentLoaded', () => {
    const tagInput = document.getElementById('tagInput');
    const tagAutocomplete = document.getElementById('tagAutocomplete');
    
    if (tagInput) {
        // Show autocomplete on input
        tagInput.addEventListener('input', (e) => {
            showTagAutocomplete(e.target.value);
        });
        
        // Show autocomplete on focus
        tagInput.addEventListener('focus', () => {
            showTagAutocomplete(tagInput.value);
        });
        
        // Handle Enter key to add tag
        tagInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                const value = tagInput.value.trim();
                if (value) {
                    addTag(value);
                }
            } else if (e.key === 'Escape') {
                hideTagAutocomplete();
                tagInput.blur();
            } else if (e.key === 'ArrowDown') {
                // Navigate to first autocomplete item
                const firstItem = tagAutocomplete?.querySelector('.tag-autocomplete-item');
                if (firstItem) {
                    e.preventDefault();
                    firstItem.focus();
                }
            }
        });
    }
    
    // Hide autocomplete when clicking outside
    document.addEventListener('click', (e) => {
        const wrapper = document.getElementById('tagInputWrapper');
        if (wrapper && !wrapper.contains(e.target)) {
            hideTagAutocomplete();
        }
    });
    
    initExpandFieldButtons();
    initSectionExpandButtons();
    initBrowseExpandButtons();

});

