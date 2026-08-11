// ==============================================
// Bulk Auto-Link Feature
// ==============================================

let bulkAutoLinkAborted = false;
let bulkAutoLinkIsScanning = false;
let bulkAutoLinkResults = {
    confident: [],   // { char, bestMatch, selected: true }
    uncertain: [],   // { char, options: [], selectedOption: null }
    nomatch: []      // { char }
};
// Track scan state for persistence across modal open/close
let bulkAutoLinkScanState = {
    scannedAvatars: new Set(),  // Set of character avatars that have been scanned
    scanComplete: false,        // Whether the scan finished (vs was stopped)
    lastUnlinkedCount: 0        // Track if library changed since last scan
};

/**
 * Open the bulk auto-link modal — preserves state if reopening.
 * Resolves the active provider dynamically from ProviderRegistry.
 */
function openBulkAutoLinkModal() {
    // Hide dropdown menu
    document.getElementById('moreOptionsMenu')?.classList.add('hidden');

    const registry = window.ProviderRegistry;
    if (!registry) { showToast('Provider system not loaded', 'error'); return; }
    const providers = registry.getAllProviders().filter(p => p.supportsBulkLink);
    if (providers.length === 0) { showToast('No provider supports auto-linking', 'error'); return; }
    
    const modal = document.getElementById('bulkAutoLinkModal');
    const scanningPhase = document.getElementById('bulkAutoLinkScanning');
    const resultsPhase = document.getElementById('bulkAutoLinkResults');
    const applyBtn = document.getElementById('bulkAutoLinkApplyBtn');
    const cancelBtn = document.getElementById('bulkAutoLinkCancelBtn');
    
    const hasResults = bulkAutoLinkResults.confident.length > 0 || 
                       bulkAutoLinkResults.uncertain.length > 0 || 
                       bulkAutoLinkResults.nomatch.length > 0;
    
    // Count current unlinked characters (check all providers)
    const currentUnlinkedCount = allCharacters.filter(char => {
        const linkInfo = registry.getLinkInfo(char);
        return !linkInfo || !linkInfo.fullPath;
    }).length;
    
    // If library changed significantly, reset state
    if (bulkAutoLinkScanState.lastUnlinkedCount !== currentUnlinkedCount && 
        Math.abs(bulkAutoLinkScanState.lastUnlinkedCount - currentUnlinkedCount) > 5) {
        // Library changed significantly - reset
        bulkAutoLinkResults = { confident: [], uncertain: [], nomatch: [] };
        bulkAutoLinkScanState = { scannedAvatars: new Set(), scanComplete: false, lastUnlinkedCount: 0 };
    }
    
    if (hasResults) {
        // We have existing results - show them
        modal.classList.add('visible');
        
        if (bulkAutoLinkScanState.scanComplete || bulkAutoLinkAborted) {
            // Scan was finished or stopped - show results directly
            showBulkAutoLinkResults();
            
            // If scan was incomplete (stopped), offer to resume
            if (!bulkAutoLinkScanState.scanComplete) {
                const remaining = currentUnlinkedCount - bulkAutoLinkScanState.scannedAvatars.size;
                if (remaining > 0) {
                    cancelBtn.innerHTML = '<i class="fa-solid fa-play"></i> Resume';
                    cancelBtn.onclick = () => {
                        // Reset abort flag and resume scanning
                        bulkAutoLinkAborted = false;
                        cancelBtn.innerHTML = '<i class="fa-solid fa-stop"></i> Stop';
                        cancelBtn.onclick = null; // Remove custom handler
                        
                        // Show scanning UI
                        scanningPhase.classList.remove('hidden');
                        resultsPhase.classList.add('hidden');
                        applyBtn.classList.add('hidden');
                        
                        runBulkAutoLinkScan();
                    };
                }
            }
        } else if (bulkAutoLinkIsScanning) {
            // Scan is still running - show scanning UI
            scanningPhase.classList.remove('hidden');
            resultsPhase.classList.add('hidden');
            applyBtn.classList.add('hidden');
            cancelBtn.innerHTML = '<i class="fa-solid fa-stop"></i> Stop';
        }
    } else {
        // Fresh start - reset everything
        bulkAutoLinkAborted = false;
        bulkAutoLinkResults = { confident: [], uncertain: [], nomatch: [] };
        bulkAutoLinkScanState = { scannedAvatars: new Set(), scanComplete: false, lastUnlinkedCount: currentUnlinkedCount };
        
        // Reset UI
        scanningPhase.classList.remove('hidden');
        resultsPhase.classList.add('hidden');
        applyBtn.classList.add('hidden');
        cancelBtn.innerHTML = '<i class="fa-solid fa-stop"></i> Stop';
        cancelBtn.onclick = null;
        
        document.getElementById('bulkAutoLinkScanAvatar').src = '';
        document.getElementById('bulkAutoLinkScanName').textContent = 'Preparing...';
        document.getElementById('bulkAutoLinkScanStatus').textContent = 'Scanning library for unlinked characters...';
        document.getElementById('bulkAutoLinkScanProgress').textContent = '0/0';
        document.getElementById('bulkAutoLinkScanFill').style.width = '0%';
        document.getElementById('bulkAutoLinkConfidentCount').textContent = '0';
        document.getElementById('bulkAutoLinkUncertainCount').textContent = '0';
        document.getElementById('bulkAutoLinkNoMatchCount').textContent = '0';

        modal.classList.add('visible');
        
        // Start scanning
        runBulkAutoLinkScan();
    }
}

/**
 * Run the bulk auto-link scan across ALL providers with supportsBulkLink
 */
async function runBulkAutoLinkScan() {
    bulkAutoLinkIsScanning = true;
    bulkAutoLinkScanState.scanComplete = false;

    const registry = window.ProviderRegistry;
    const providers = registry ? registry.getAllProviders().filter(p => p.supportsBulkLink) : [];
    
    const unlinkedChars = allCharacters.filter(char => {
        const linkInfo = registry?.getLinkInfo(char);
        return !linkInfo || !linkInfo.fullPath;
    });
    
    if (unlinkedChars.length === 0) {
        document.getElementById('bulkAutoLinkScanStatus').textContent = 'All characters are already linked!';
        document.getElementById('bulkAutoLinkCancelBtn').innerHTML = '<i class="fa-solid fa-check"></i> Done';
        bulkAutoLinkIsScanning = false;
        bulkAutoLinkScanState.scanComplete = true;
        return;
    }
    
    // Filter out characters we've already scanned (for resume functionality)
    const charsToScan = unlinkedChars.filter(char => !bulkAutoLinkScanState.scannedAvatars.has(char.avatar));
    const alreadyScanned = unlinkedChars.length - charsToScan.length;
    const total = unlinkedChars.length;
    
    if (charsToScan.length === 0) {
        // All characters already scanned
        bulkAutoLinkIsScanning = false;
        bulkAutoLinkScanState.scanComplete = true;
        showBulkAutoLinkResults();
        return;
    }
    
    // Update initial counts from existing results
    document.getElementById('bulkAutoLinkConfidentCount').textContent = bulkAutoLinkResults.confident.length;
    document.getElementById('bulkAutoLinkUncertainCount').textContent = bulkAutoLinkResults.uncertain.length;
    document.getElementById('bulkAutoLinkNoMatchCount').textContent = bulkAutoLinkResults.nomatch.length;
    
    for (let i = 0; i < charsToScan.length; i++) {
        if (bulkAutoLinkAborted) break;
        
        const char = charsToScan[i];
        const charName = getCharacterName(char, 'Unknown');
        const charCreator = String(char.creator || char.data?.creator || '').trim();
        
        const currentProgress = alreadyScanned + i + 1;
        
        // Update UI
        document.getElementById('bulkAutoLinkScanAvatar').src = getCharacterAvatarStThumbUrl(char.avatar);
        document.getElementById('bulkAutoLinkScanName').textContent = charName;
        document.getElementById('bulkAutoLinkScanStatus').textContent = `Searching ${providers.length} providers for "${charName}"...`;
        document.getElementById('bulkAutoLinkScanProgress').textContent = `${currentProgress}/${total}`;
        document.getElementById('bulkAutoLinkScanFill').style.width = `${(currentProgress / total) * 100}%`;
        
        // Search ALL providers in parallel, tag results with providerId
        const providerPromises = providers.map(async (prov) => {
            try {
                const results = await prov.searchForBulkLink(charName, charCreator);
                return results.map(r => ({ ...r, providerId: prov.id }));
            } catch (e) {
                debugLog(`[bulkAutoLink] ${prov.name} search failed for "${charName}":`, e.message);
                return [];
            }
        });
        const allProviderResults = await Promise.all(providerPromises);
        const searchResults = allProviderResults.flat();
        
        // Mark this character as scanned
        bulkAutoLinkScanState.scannedAvatars.add(char.avatar);
        
        if (searchResults.length === 0) {
            // No match found
            bulkAutoLinkResults.nomatch.push({ char });
            document.getElementById('bulkAutoLinkNoMatchCount').textContent = bulkAutoLinkResults.nomatch.length;
        } else {
            // Hydrate so content similarity has description/first_mes/personality
            await hydrateCharacter(char);
            
            // Sort results by content similarity for better ordering in review UI
            const sortedResults = sortResultsByContentSimilarity(searchResults, char);
            
            // Check for confident match
            const confidentMatch = findConfidentMatch(char, sortedResults);
            
            if (confidentMatch) {
                // Find the index of the confident match in sorted results
                const confidentIdx = sortedResults.findIndex(r => r.fullPath === confidentMatch.fullPath);
                bulkAutoLinkResults.confident.push({
                    char,
                    bestMatch: confidentMatch,
                    options: sortedResults.slice(0, 5), // Store top 5 sorted by content similarity
                    selectedOption: confidentIdx >= 0 && confidentIdx < 5 ? confidentIdx : 0, // Pre-select the confident match
                    selected: true
                });
                document.getElementById('bulkAutoLinkConfidentCount').textContent = bulkAutoLinkResults.confident.length;
            } else {
                // Multiple options, needs review - sorted by content similarity
                bulkAutoLinkResults.uncertain.push({
                    char,
                    options: sortedResults.slice(0, 5), // Top 5 sorted by content similarity
                    selectedOption: null
                });
                document.getElementById('bulkAutoLinkUncertainCount').textContent = bulkAutoLinkResults.uncertain.length;
            }
        }
        
        // Rate limiting - wait between requests
        if (!bulkAutoLinkAborted) {
            await new Promise(resolve => setTimeout(resolve, 300));
        }
    }
    
    bulkAutoLinkIsScanning = false;
    
    // Mark scan as complete only if we weren't aborted
    if (!bulkAutoLinkAborted) {
        bulkAutoLinkScanState.scanComplete = true;
    }
    
    // Show results (even if aborted, show what we found so far)
    if (bulkAutoLinkResults.confident.length > 0 || bulkAutoLinkResults.uncertain.length > 0 || bulkAutoLinkResults.nomatch.length > 0) {
        showBulkAutoLinkResults();
    } else {
        // Nothing found at all
        document.getElementById('bulkAutoLinkScanStatus').textContent = bulkAutoLinkAborted ? 'Scan stopped - no matches found yet' : 'Scan complete - no matches found';
        document.getElementById('bulkAutoLinkCancelBtn').innerHTML = '<i class="fa-solid fa-times"></i> Close';
    }
}

/**
 * Common/generic creators that shouldn't be trusted for matching
 */
const GENERIC_CREATORS = new Set([
    'anonymous', 'anon', 'unknown', 'user', 'admin', 'test', 
    'guest', '', 'none', 'na', 'n/a', 'character'
]);

/**
 * Sort search results by content similarity to a local character
 * Results with higher content similarity appear first
 * @param {Array} results - Search results from provider API
 * @param {Object} localChar - Local character to compare against
 * @returns {Array} - Results sorted by content similarity (descending)
 */
function sortResultsByContentSimilarity(results, localChar) {
    if (!localChar || !results || results.length === 0) return results;
    
    const charDescription = getCharField(localChar, 'description') || '';
    const charCreatorNotes = getCharField(localChar, 'creator_notes') || '';
    const charFirstMes = getCharField(localChar, 'first_mes') || '';
    const charName = getCharacterName(localChar, '').toLowerCase().trim();
    const charCreator = String(localChar.creator || localChar.data?.creator || '').toLowerCase().trim();
    const charNameWords = charName.split(/\s+/).filter(w => w.length > 2);
    
    // Combine local content for matching
    const localContent = `${charDescription} ${charCreatorNotes} ${charFirstMes}`.trim();
    const hasLocalContent = localContent.length > 100;
    
    // Calculate scores for each result
    const scoredResults = results.map(result => {
        const remoteName = (result.name || '').toLowerCase().trim();
        const remoteCreator = (result.fullPath || '').split('/')[0].toLowerCase().trim();
        const remoteTagline = result.tagline || '';
        const remoteDescription = result.description || result.tagline || '';
        const remoteNameWords = remoteName.split(/\s+/).filter(w => w.length > 2);
        
        // Combine remote content
        const remoteContent = `${remoteDescription} ${remoteTagline}`.trim();
        
        let score = 0;
        let matchReasons = [];
        
        // === NAME MATCHING ===
        
        // Exact name match gets biggest boost
        if (remoteName === charName) {
            score += 100;
            matchReasons.push('exact name');
        }
        // Remote name STARTS with local name (e.g., "Ghost Exorcism Simulator" starts with "Ghost")
        else if (remoteName.startsWith(charName + ' ') || remoteName.startsWith(charName + ':') || remoteName.startsWith(charName + ',')) {
            score += 90;
            matchReasons.push('name prefix');
        }
        // First word exact match (e.g., "Ghost" = first word of "Ghost Exorcism Simulator")
        else if (remoteNameWords.length > 0 && charNameWords.length > 0 && remoteNameWords[0] === charNameWords[0]) {
            score += 85;
            matchReasons.push('first word');
        }
        // Local name is contained in remote name
        else if (remoteName.includes(charName) && charName.length > 3) {
            score += 75;
            matchReasons.push('name in title');
        }
        // Any significant word from local name is in remote name
        else if (charNameWords.length > 0 && charNameWords.some(w => remoteName.includes(w))) {
            score += 60;
            matchReasons.push('word match');
        }
        
        // === CREATOR MATCHING ===
        if (charCreator && remoteCreator === charCreator) {
            score += 50;
            matchReasons.push('creator');
        }
        
        // === CONTENT SIMILARITY ===
        if (hasLocalContent && remoteContent.length > 50) {
            // Compare description to description
            const descToDescSim = calculateTextSimilarity(charDescription, remoteDescription);
            
            // Compare description to tagline (often very useful)
            const descToTaglineSim = calculateTextSimilarity(charDescription, remoteTagline);
            
            // Compare creator_notes to tagline (creators often put tagline in notes)
            const notesToTaglineSim = charCreatorNotes ? calculateTextSimilarity(charCreatorNotes, remoteTagline) : 0;
            
            // Compare creator_notes to description
            const notesToDescSim = charCreatorNotes ? calculateTextSimilarity(charCreatorNotes, remoteDescription) : 0;
            
            // Compare first_mes to description (can help identify unique characters)
            const firstMesToDescSim = charFirstMes ? calculateTextSimilarity(charFirstMes, remoteDescription) : 0;
            
            // Full content comparison
            const fullContentSim = calculateTextSimilarity(localContent, remoteContent);
            
            // Take the best match from all comparisons
            const bestContentMatch = Math.max(
                descToDescSim, 
                descToTaglineSim, 
                notesToTaglineSim, 
                notesToDescSim,
                firstMesToDescSim,
                fullContentSim
            );
            
            // Content similarity is HUGE - up to 100 points for high match
            // This helps when names don't match but content clearly does
            if (bestContentMatch >= 0.5) {
                score += bestContentMatch * 100; // 50-100 points for good content match
                matchReasons.push(`${Math.round(bestContentMatch * 100)}% content`);
            } else if (bestContentMatch >= 0.25) {
                score += bestContentMatch * 60; // 15-30 points for partial content match
                matchReasons.push(`${Math.round(bestContentMatch * 100)}% content`);
            } else if (bestContentMatch > 0.1) {
                score += bestContentMatch * 30; // Small boost for weak match
            }
        }
        
        // Keep original API order as tiebreaker (download count)
        score += (results.length - results.indexOf(result)) * 0.01;
        
        return { result, score, matchReasons };
    });
    
    // Sort by score descending
    scoredResults.sort((a, b) => b.score - a.score);
    
    // Debug log for top results
    if (scoredResults.length > 0 && scoredResults[0].score > 50) {
        debugLog(`[BulkSearch] Top match: "${scoredResults[0].result.name}" (score: ${scoredResults[0].score.toFixed(1)}, reasons: ${scoredResults[0].matchReasons.join(', ')})`);
    }
    
    return scoredResults.map(s => s.result);
}

/**
 * Calculate word set similarity (Jaccard index) between two texts
 * Wrapper for contentSimilarity used in auto-link matching
 */
function calculateTextSimilarity(textA, textB) {
    return contentSimilarity(textA, textB);
}

/**
 * Find a confident match for a character
 * Uses name, creator, and content similarity for matching
 * Handles generic creators like "Anonymous" by requiring content match
 */
function findConfidentMatch(char, searchResults) {
    const charName = getCharacterName(char, '').toLowerCase().trim();
    const charCreator = String(char.creator || char.data?.creator || '').toLowerCase().trim();
    const charDescription = getCharField(char, 'description') || '';
    const charFirstMes = getCharField(char, 'first_mes') || '';
    const charPersonality = getCharField(char, 'personality') || '';
    
    // Combine content for matching
    const charContent = `${charDescription} ${charFirstMes} ${charPersonality}`.trim();
    
    // Is creator generic/untrustworthy?
    const isGenericCreator = GENERIC_CREATORS.has(charCreator);
    
    for (const result of searchResults) {
        const remoteName = (result.name || '').toLowerCase().trim();
        const remoteCreator = (result.fullPath || '').split('/')[0].toLowerCase().trim();
        const remoteTagline = result.tagline || '';
        const remoteDescription = result.description || result.tagline || '';
        const remoteTokens = result.nTokens || result.n_tokens || 0;
        
        // Exact name match is always required
        if (remoteName !== charName) continue;
        
        // Calculate content similarity using tagline/description from search results
        const contentSimilarity = calculateTextSimilarity(charDescription, remoteDescription);
        const taglineSimilarity = calculateTextSimilarity(charDescription, remoteTagline);
        const bestContentSimilarity = Math.max(contentSimilarity, taglineSimilarity);
        
        // Case 1: Generic creator (like "Anonymous") - require content match
        if (isGenericCreator || GENERIC_CREATORS.has(remoteCreator)) {
            // For generic creators, require significant content similarity
            if (bestContentSimilarity >= 0.4) {
                debugLog(`[bulkAutoLink] Content match for "${charName}": ${(bestContentSimilarity * 100).toFixed(1)}% similarity`);
                return result;
            }
            // Or if it's the top result with matching generic creator and high download count
            if (remoteCreator === charCreator && searchResults.indexOf(result) === 0 && (result.downloadCount || result.starCount || 0) > 100) {
                debugLog(`[bulkAutoLink] Top popular result match for "${charName}" by generic creator`);
                return result;
            }
            continue;
        }
        
        // Case 2: Specific creator - creator match is sufficient
        if (charCreator && remoteCreator === charCreator) {
            debugLog(`[bulkAutoLink] Creator match for "${charName}" by ${charCreator}`);
            return result;
        }
        
        // Case 3: No local creator but remote has one - use content + position
        if (!charCreator && searchResults.indexOf(result) === 0) {
            // Top result with good content match
            if (bestContentSimilarity >= 0.3) {
                debugLog(`[bulkAutoLink] Top result with content match for "${charName}": ${(bestContentSimilarity * 100).toFixed(1)}%`);
                return result;
            }
        }
    }
    
    return null;
}

/**
 * Show the results phase
 */
function showBulkAutoLinkResults() {
    const scanningPhase = document.getElementById('bulkAutoLinkScanning');
    const resultsPhase = document.getElementById('bulkAutoLinkResults');
    const applyBtn = document.getElementById('bulkAutoLinkApplyBtn');
    const cancelBtn = document.getElementById('bulkAutoLinkCancelBtn');
    
    scanningPhase.classList.add('hidden');
    resultsPhase.classList.remove('hidden');
    applyBtn.classList.remove('hidden');
    
    const registry = window.ProviderRegistry;
    const unlinkedCount = allCharacters.filter(char => {
        const linkInfo = registry?.getLinkInfo(char);
        return !linkInfo || !linkInfo.fullPath;
    }).length;
    const remaining = unlinkedCount - bulkAutoLinkScanState.scannedAvatars.size;
    
    if (!bulkAutoLinkScanState.scanComplete && remaining > 0) {
        // Scan was stopped - offer resume option
        cancelBtn.innerHTML = `<i class="fa-solid fa-play"></i> Resume (${remaining} left)`;
        cancelBtn.onclick = () => {
            bulkAutoLinkAborted = false;
            cancelBtn.innerHTML = '<i class="fa-solid fa-stop"></i> Stop';
            cancelBtn.onclick = null;
            
            scanningPhase.classList.remove('hidden');
            resultsPhase.classList.add('hidden');
            applyBtn.classList.add('hidden');
            
            runBulkAutoLinkScan();
        };
    } else {
        cancelBtn.innerHTML = '<i class="fa-solid fa-times"></i> Close';
        cancelBtn.onclick = null;
    }
    
    // Update tab counts
    document.getElementById('bulkAutoLinkConfidentTabCount').textContent = bulkAutoLinkResults.confident.length;
    document.getElementById('bulkAutoLinkUncertainTabCount').textContent = bulkAutoLinkResults.uncertain.length;
    document.getElementById('bulkAutoLinkNoMatchTabCount').textContent = bulkAutoLinkResults.nomatch.length;
    
    // Render lists
    renderBulkAutoLinkConfidentList();
    renderBulkAutoLinkUncertainList();
    renderBulkAutoLinkNoMatchList();
    
    // Update selected count
    updateBulkAutoLinkSelectedCount();
    
    // Show confident tab by default
    switchBulkAutoLinkTab('confident');
}

/**
 * Render the confident matches list
 */
function renderBulkAutoLinkConfidentList() {
    const container = document.getElementById('bulkAutoLinkConfidentList');
    const registry = window.ProviderRegistry;
    
    if (bulkAutoLinkResults.confident.length === 0) {
        container.innerHTML = '<div class="bulk-auto-link-empty"><i class="fa-solid fa-search"></i>No confident matches found</div>';
        return;
    }
    
    container.innerHTML = bulkAutoLinkResults.confident.map((item, idx) => {
        const charName = getCharacterName(item.char, 'Unknown');
        const charCreator = String(item.char.creator || item.char.data?.creator || '');
        const selectedOpt = item.options[item.selectedOption] || item.bestMatch;
        const selectedProvider = registry?.getProvider(selectedOpt.providerId);
        const selectedAvatarUrl = selectedProvider?.getResultAvatarUrl?.(selectedOpt) || selectedOpt.avatarUrl || '';
        
        // Build options HTML
        let optionsHtml = item.options.map((opt, optIdx) => {
            const optProvider = registry?.getProvider(opt.providerId);
            const optAvatarUrl = optProvider?.getResultAvatarUrl?.(opt) || opt.avatarUrl || '';
            const isSelected = item.selectedOption === optIdx;
            const isConfidentMatch = opt.fullPath === item.bestMatch.fullPath;
            const stars = opt.starCount || 0;
            const rating = opt.rating ? opt.rating.toFixed(1) : 'N/A';
            
            return `
                <div class="bulk-auto-link-option${isSelected ? ' selected' : ''}" data-item-idx="${idx}" data-opt-idx="${optIdx}">
                    <img src="${optAvatarUrl}" alt="" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><rect fill=%22%23333%22 width=%22100%22 height=%22100%22/></svg>'">
                    <div class="bulk-auto-link-option-info">
                        <span class="bulk-auto-link-option-name">${escapeHtml(opt.name || opt.fullPath.split('/').pop())}${isConfidentMatch ? ' <span class="confident-badge">Exact Match</span>' : ''}</span>
                        <span class="bulk-auto-link-option-path">${escapeHtml(opt.fullPath)} · ${escapeHtml(optProvider?.name || opt.providerId)}</span>
                    </div>
                    <span class="bulk-auto-link-option-stats"><i class="fa-solid fa-star"></i> ${rating} | <i class="fa-solid fa-heart"></i> ${stars}</span>
                </div>
            `;
        }).join('');
        
        return `
            <div class="bulk-auto-link-item bulk-auto-link-item-confident${item.selected ? ' selected' : ''}" data-type="confident" data-idx="${idx}">
                <div class="bulk-auto-link-item-confident-header">
                    <input type="checkbox" class="bulk-auto-link-item-checkbox" ${item.selected ? 'checked' : ''}>
                    <div class="bulk-auto-link-item-local">
                        <img src="${getCharacterAvatarStThumbUrl(item.char.avatar)}" alt="" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><rect fill=%22%23333%22 width=%22100%22 height=%22100%22/></svg>'">
                        <div class="bulk-auto-link-item-local-info">
                            <span class="bulk-auto-link-item-local-name" title="${escapeHtml(charName)}">${escapeHtml(charName)}</span>
                            <span class="bulk-auto-link-item-local-creator">${charCreator ? 'by ' + escapeHtml(charCreator) : 'No creator'}</span>
                        </div>
                    </div>
                    <i class="fa-solid fa-arrow-right bulk-auto-link-item-arrow"></i>
                    <div class="bulk-auto-link-item-remote">
                        <img src="${selectedAvatarUrl}" alt="" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><rect fill=%22%23333%22 width=%22100%22 height=%22100%22/></svg>'">
                        <div class="bulk-auto-link-item-remote-info">
                            <span class="bulk-auto-link-item-remote-name">${escapeHtml(selectedOpt.name || selectedOpt.fullPath.split('/').pop())}</span>
                            <span class="bulk-auto-link-item-remote-path">${escapeHtml(selectedOpt.fullPath)}</span>
                        </div>
                    </div>
                    <span class="bulk-auto-link-item-confidence high">Exact Match</span>
                    <i class="fa-solid fa-chevron-down expand-icon"></i>
                </div>
                <div class="bulk-auto-link-item-options">
                    ${optionsHtml}
                </div>
            </div>
        `;
    }).join('');
}

/**
 * Render the uncertain matches list
 */
function renderBulkAutoLinkUncertainList() {
    const container = document.getElementById('bulkAutoLinkUncertainList');
    const registry = window.ProviderRegistry;
    
    if (bulkAutoLinkResults.uncertain.length === 0) {
        container.innerHTML = '<div class="bulk-auto-link-empty"><i class="fa-solid fa-check-circle"></i>No uncertain matches</div>';
        return;
    }
    
    container.innerHTML = bulkAutoLinkResults.uncertain.map((item, idx) => {
        const charName = getCharacterName(item.char, 'Unknown');
        const charCreator = String(item.char.creator || item.char.data?.creator || '');
        const hasSelection = item.selectedOption !== null;
        
        let optionsHtml = item.options.map((opt, optIdx) => {
            const optProvider = registry?.getProvider(opt.providerId);
            const optAvatarUrl = optProvider?.getResultAvatarUrl?.(opt) || opt.avatarUrl || '';
            const isSelected = item.selectedOption === optIdx;
            const stars = opt.starCount || 0;
            const rating = opt.rating ? opt.rating.toFixed(1) : 'N/A';
            
            return `
                <div class="bulk-auto-link-option${isSelected ? ' selected' : ''}" data-item-idx="${idx}" data-opt-idx="${optIdx}">
                    <img src="${optAvatarUrl}" alt="" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><rect fill=%22%23333%22 width=%22100%22 height=%22100%22/></svg>'">
                    <div class="bulk-auto-link-option-info">
                        <span class="bulk-auto-link-option-name">${escapeHtml(opt.name || opt.fullPath.split('/').pop())}</span>
                        <span class="bulk-auto-link-option-path">${escapeHtml(opt.fullPath)} · ${escapeHtml(optProvider?.name || opt.providerId)}</span>
                    </div>
                    <span class="bulk-auto-link-option-stats"><i class="fa-solid fa-star"></i> ${rating} | <i class="fa-solid fa-heart"></i> ${stars}</span>
                </div>
            `;
        }).join('');
        
        return `
            <div class="bulk-auto-link-item bulk-auto-link-item-uncertain${hasSelection ? ' selected' : ''}" data-type="uncertain" data-idx="${idx}">
                <div class="bulk-auto-link-item-uncertain-header">
                    <input type="checkbox" class="bulk-auto-link-item-checkbox" ${hasSelection ? 'checked' : ''}>
                    <div class="bulk-auto-link-item-local">
                        <img src="${getCharacterAvatarStThumbUrl(item.char.avatar)}" alt="" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><rect fill=%22%23333%22 width=%22100%22 height=%22100%22/></svg>'">
                        <div class="bulk-auto-link-item-local-info">
                            <span class="bulk-auto-link-item-local-name" title="${escapeHtml(charName)}">${escapeHtml(charName)}</span>
                            <span class="bulk-auto-link-item-local-creator">${charCreator ? 'by ' + escapeHtml(charCreator) : 'No creator'}</span>
                        </div>
                    </div>
                    <i class="fa-solid fa-arrow-right bulk-auto-link-item-arrow"></i>
                    <div class="bulk-auto-link-item-remote">
                        ${hasSelection 
                            ? `<span>${escapeHtml(item.options[item.selectedOption].fullPath)}</span>` 
                            : `<span style="color: var(--text-muted);">${item.options.length} possible matches - click to select</span>`
                        }
                    </div>
                    <span class="bulk-auto-link-item-confidence medium">${item.options.length} Options</span>
                    <i class="fa-solid fa-chevron-down expand-icon"></i>
                </div>
                <div class="bulk-auto-link-item-options">
                    ${optionsHtml}
                </div>
            </div>
        `;
    }).join('');
}

/**
 * Render the no match list
 */
function renderBulkAutoLinkNoMatchList() {
    const container = document.getElementById('bulkAutoLinkNoMatchList');
    
    if (bulkAutoLinkResults.nomatch.length === 0) {
        container.innerHTML = '<div class="bulk-auto-link-empty"><i class="fa-solid fa-check-circle"></i>All characters had potential matches!</div>';
        return;
    }
    
    container.innerHTML = bulkAutoLinkResults.nomatch.map((item) => {
        const charName = getCharacterName(item.char, 'Unknown');
        const charCreator = String(item.char.creator || item.char.data?.creator || '');
        
        return `
            <div class="bulk-auto-link-item bulk-auto-link-item-nomatch">
                <div class="bulk-auto-link-item-local">
                    <img src="${getCharacterAvatarStThumbUrl(item.char.avatar)}" alt="" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><rect fill=%22%23333%22 width=%22100%22 height=%22100%22/></svg>'">
                    <div class="bulk-auto-link-item-local-info">
                        <span class="bulk-auto-link-item-local-name" title="${escapeHtml(charName)}">${escapeHtml(charName)}</span>
                        <span class="bulk-auto-link-item-local-creator">${charCreator ? 'by ' + escapeHtml(charCreator) : 'No creator'}</span>
                    </div>
                </div>
                <i class="fa-solid fa-arrow-right bulk-auto-link-item-arrow" style="opacity: 0.3;"></i>
                <div class="bulk-auto-link-item-remote">
                    <span><i class="fa-solid fa-times-circle"></i> No matches found</span>
                </div>
            </div>
        `;
    }).join('');
}

function toggleBulkAutoLinkItem(type, idx) {
    if (type === 'confident') {
        bulkAutoLinkResults.confident[idx].selected = !bulkAutoLinkResults.confident[idx].selected;
        renderBulkAutoLinkConfidentList();
    }
    updateBulkAutoLinkSelectedCount();
}

function toggleBulkAutoLinkConfidentExpand(idx) {
    const items = document.querySelectorAll('.bulk-auto-link-item-confident');
    items[idx]?.classList.toggle('expanded');
}

function selectBulkAutoLinkConfidentOption(itemIdx, optionIdx) {
    bulkAutoLinkResults.confident[itemIdx].selectedOption = optionIdx;
    bulkAutoLinkResults.confident[itemIdx].selected = true;
    renderBulkAutoLinkConfidentList();
    updateBulkAutoLinkSelectedCount();
}

function toggleBulkAutoLinkExpand(idx) {
    const items = document.querySelectorAll('.bulk-auto-link-item-uncertain');
    items[idx]?.classList.toggle('expanded');
}

function selectBulkAutoLinkOption(itemIdx, optionIdx) {
    bulkAutoLinkResults.uncertain[itemIdx].selectedOption = optionIdx;
    renderBulkAutoLinkUncertainList();
    updateBulkAutoLinkSelectedCount();
}

function clearBulkAutoLinkSelection(idx, checkbox) {
    if (!checkbox.checked) {
        bulkAutoLinkResults.uncertain[idx].selectedOption = null;
        renderBulkAutoLinkUncertainList();
        updateBulkAutoLinkSelectedCount();
    }
}

function switchBulkAutoLinkTab(tabName) {
    debugLog('[bulkAutoLink] Switching to tab:', tabName);
    
    document.querySelectorAll('.bulk-auto-link-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.tab === tabName);
    });
    
    const confidentList = document.getElementById('bulkAutoLinkConfidentList');
    const uncertainList = document.getElementById('bulkAutoLinkUncertainList');
    const nomatchList = document.getElementById('bulkAutoLinkNoMatchList');
    
    if (confidentList) confidentList.style.display = tabName === 'confident' ? 'flex' : 'none';
    if (uncertainList) uncertainList.style.display = tabName === 'uncertain' ? 'flex' : 'none';
    if (nomatchList) nomatchList.style.display = tabName === 'nomatch' ? 'flex' : 'none';
    
    const actionsBar = document.getElementById('bulkAutoLinkConfidentActions');
    if (actionsBar) {
        actionsBar.style.display = tabName === 'confident' ? 'flex' : 'none';
    }
}

function bulkAutoLinkSelectAll() {
    bulkAutoLinkResults.confident.forEach(item => item.selected = true);
    renderBulkAutoLinkConfidentList();
    updateBulkAutoLinkSelectedCount();
}

function bulkAutoLinkDeselectAll() {
    bulkAutoLinkResults.confident.forEach(item => item.selected = false);
    renderBulkAutoLinkConfidentList();
    updateBulkAutoLinkSelectedCount();
}

/**
 * Update selected count
 */
function updateBulkAutoLinkSelectedCount() {
    const confidentSelected = bulkAutoLinkResults.confident.filter(i => i.selected).length;
    const uncertainSelected = bulkAutoLinkResults.uncertain.filter(i => i.selectedOption !== null).length;
    const total = confidentSelected + uncertainSelected;
    
    document.getElementById('bulkAutoLinkSelectedCount').textContent = total;
    
    // Disable apply button if nothing selected
    const applyBtn = document.getElementById('bulkAutoLinkApplyBtn');
    applyBtn.disabled = total === 0;
}

/**
 * Persist a provider link for a character.
 * Updates in-memory state via the provider's setLinkInfo, then saves to server.
 */
async function saveProviderLink(char, provider, linkInfo) {
    if (!char?.avatar) throw new Error('No character or avatar');

    // Non-blocking auto-snapshot before link (overwrites the cl namespace).

    // Populate provider namespace + drop cl in-memory so the spread carries the new link and the cl-delete has a target.
    provider.setLinkInfo(char, linkInfo);
    const charInArray = allCharacters.find(c => c.avatar === char.avatar);
    if (charInArray && charInArray !== char) {
        provider.setLinkInfo(charInArray, linkInfo);
    }
    for (const c of [char, charInArray].filter(Boolean)) {
        if (c.data?.extensions && 'cl' in c.data.extensions) delete c.data.extensions.cl;
    }

    // Persist via applyCardFieldUpdates; the provider namespace rides the existing-extensions spread, so only the cl-delete is a dot-path update.
    const success = await window.applyCardFieldUpdates(char.avatar, {
        'extensions.cl': ST_UNSET_SENTINEL,
    });
    if (!success) throw new Error('Failed to save provider link');

    // Recompute the listing-name + tagline search keys (CL-side state outside char.data; helper doesnt know about it).
    const listingName = getListingNameFromExtensions(char);
    char._lowerListingName = listingName ? listingName.toLowerCase() : '';
    char._lowerTagline = getDisplayTagline(char).toLowerCase();
    if (charInArray && charInArray !== char) {
        charInArray._lowerListingName = char._lowerListingName;
        charInArray._lowerTagline = char._lowerTagline;
    }

    // Same-tick ST sync: setLinkInfo on mainChar makes the new link visible immediately, ahead of the async refetch.
    try {
        const context = getSTContext();
        const mainChar = context?.characters?.find(c => c.avatar === char.avatar);
        if (mainChar) provider.setLinkInfo(mainChar, linkInfo);
    } catch (_) { /* non-critical */ }
}

