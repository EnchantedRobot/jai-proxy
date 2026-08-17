// ========================================
// CHARACTER DUPLICATE DETECTION SYSTEM
// ========================================

// Duplicate scan cache
// Closing the duplicates modal mid-scan bumps the generation; the scan
// re-checks it at every await boundary and bails without caching.
let _dupScanGen = 0;
let _dupScanActive = false;

let duplicateScanCache = {
    timestamp: 0,
    charCount: 0,
    groups: [],
    normalizedData: null // Pre-computed normalized character data
};
const DUPLICATE_CACHE_TTL = 60000; // 1 minute cache validity

// State for returning to duplicate modal after viewing a card
let duplicateModalState = {
    wasOpen: false,
    expandedGroups: new Set(),
    scrollPosition: 0
};

// State for returning to bulk summary modal after viewing a character
let bulkSummaryModalState = {
    wasOpen: false,
    scrollPosition: 0,
    currentPage: 1,
    filterValue: 'all',
    searchValue: ''
};

/**
 * Pre-compute normalized data for all characters.
 * @param {Map|null} fullDataMap - When characters are slim, a Map of avatar→fullChar
 *                                 fetched via /characters/all for content comparison.
 */
function buildNormalizedCharacterData(fullDataMap) {
    return allCharacters.map(char => {
        if (!char) return null;
        
        // Use full data source when available (slim chars lack heavy text fields)
        const src = fullDataMap?.get(char.avatar) || char;
        
        const name = getCharField(char, 'name') || '';
        const normalizedName = normalizeCharName(name);
        const creator = (getCharField(char, 'creator') || '').toLowerCase().trim();
        const description = getCharField(src, 'description') || '';
        const firstMes = getCharField(src, 'first_mes') || '';
        const personality = getCharField(src, 'personality') || '';
        const scenario = getCharField(src, 'scenario') || '';
        const creatorNotes = getCharField(char, 'creator_notes') || '';
        const mesExample = getCharField(src, 'mes_example') || '';
        const systemPrompt = getCharField(src, 'system_prompt') || '';

        // Pre-extract words for content similarity (expensive operation)
        const getWords = (text) => {
            if (!text || text.length < 50) return null;
            const words = text.toLowerCase().match(/\b\w{3,}\b/g) || [];
            return new Set(words);
        };

        return {
            avatar: char.avatar,
            char: char,
            name: name,
            nameLower: name.toLowerCase().trim(),
            normalizedName: normalizedName,
            nameVariants: nameVariantsForDupe(name),
            creator: creator,
            creatorCompact: creator.replace(/[\s_-]/g, ''),
            description: description,
            firstMes: firstMes,
            personality: personality,
            scenario: scenario,
            creatorNotes: creatorNotes,
            mesExample: mesExample,
            systemPrompt: systemPrompt,
            descWords: getWords(description),
            firstMesWords: getWords(firstMes),
            persWords: getWords(personality),
            scenWords: getWords(scenario),
            creatorNotesWords: getWords(creatorNotes),
            mesExWords: getWords(mesExample),
            sysPromptWords: getWords(systemPrompt)
        };
    }).filter(Boolean);
}

/**
 * Fast word set similarity using pre-computed word sets
 */
function wordSetSimilarity(wordsA, wordsB) {
    if (!wordsA || !wordsB) return 0;
    if (wordsA.size === 0 || wordsB.size === 0) return 0;
    
    let intersection = 0;
    for (const word of wordsA) {
        if (wordsB.has(word)) intersection++;
    }
    
    const union = wordsA.size + wordsB.size - intersection;
    return union > 0 ? intersection / union : 0;
}

/**
 * Fast similarity calculation using pre-normalized data
 */
function calculateFastSimilarity(normA, normB) {
    let score = 0;
    const breakdown = {};
    const matchReasons = [];
    
    // === NAME COMPARISON ===
    let bestNameScore = 0;
    let bestNameReason = '';

    for (const va of normA.nameVariants) {
        if (va.length < 3) continue;
        for (const vb of normB.nameVariants) {
            if (vb.length < 3) continue;
            if (va === vb) {
                if (15 > bestNameScore) { bestNameScore = 15; bestNameReason = 'Exact name match'; }
            } else if (isNamePrefixMatch(va, vb)) {
                if (13 > bestNameScore) { bestNameScore = 13; bestNameReason = 'Name prefix match'; }
            } else {
                const sim = stringSimilarity(va, vb);
                if (sim >= 0.7) {
                    const s = Math.round(sim * 10);
                    if (s > bestNameScore) {
                        bestNameScore = s;
                        bestNameReason = sim >= 0.85 ? `${Math.round(sim * 100)}% name similarity` : '';
                    }
                }
            }
        }
    }

    if (bestNameScore > 0) {
        score += bestNameScore;
        breakdown.name = bestNameScore;
        if (bestNameReason) matchReasons.push(bestNameReason);
    }
    
    // Early exit if names don't match at all (no point comparing content)
    if (!breakdown.name) return { score: 0, breakdown: {}, confidence: null, matchReason: '', matchReasons: [] };
    
    // === CREATOR COMPARISON ===
    if (normA.creator && normB.creator) {
        if (normA.creatorCompact && normA.creatorCompact === normB.creatorCompact) {
            score += 15;
            breakdown.creator = 15;
            matchReasons.push('Same creator');
        } else {
            const creatorSim = stringSimilarity(normA.creator, normB.creator);
            if (creatorSim >= 0.75) {
                const creatorScore = Math.round(creatorSim * 15);
                score += creatorScore;
                breakdown.creator = creatorScore;
                matchReasons.push(creatorSim >= 0.95 ? 'Same creator' : 'Similar creator');
            }
        }
    }
    
    // === CREATOR NOTES COMPARISON ===
    if (normA.creatorNotesWords && normB.creatorNotesWords) {
        const cnSim = wordSetSimilarity(normA.creatorNotesWords, normB.creatorNotesWords);
        if (cnSim >= 0.25) {
            const cnScore = Math.round(cnSim * 25);
            score += cnScore;
            breakdown.creator_notes = cnScore;
            if (cnSim >= 0.6) matchReasons.push(`${Math.round(cnSim * 100)}% creator notes match`);
        }
    } else if (normA.creatorNotes && normB.creatorNotes && normA.creatorNotes.length > 10 && normB.creatorNotes.length > 10) {
        const cnSim = stringSimilarity(normA.creatorNotes, normB.creatorNotes);
        if (cnSim >= 0.25) {
            const cnScore = Math.round(cnSim * 25);
            score += cnScore;
            breakdown.creator_notes = cnScore;
        }
    }
    
    // === CONTENT COMPARISONS ===
    if (normA.descWords && normB.descWords) {
        const descSim = wordSetSimilarity(normA.descWords, normB.descWords);
        if (descSim >= 0.3) {
            const descScore = Math.round(descSim * 20);
            score += descScore;
            breakdown.description = descScore;
            if (descSim >= 0.7) matchReasons.push(`${Math.round(descSim * 100)}% description match`);
        }
    } else if (normA.description && normB.description) {
        // Fallback for short descriptions
        const descSim = stringSimilarity(normA.description, normB.description);
        if (descSim >= 0.3) {
            const descScore = Math.round(descSim * 20);
            score += descScore;
            breakdown.description = descScore;
        }
    }
    
    if (normA.firstMesWords && normB.firstMesWords) {
        const fmSim = wordSetSimilarity(normA.firstMesWords, normB.firstMesWords);
        if (fmSim >= 0.3) {
            const fmScore = Math.round(fmSim * 15);
            score += fmScore;
            breakdown.first_mes = fmScore;
            if (fmSim >= 0.7) matchReasons.push(`${Math.round(fmSim * 100)}% first message match`);
        }
    } else if (normA.firstMes && normB.firstMes) {
        const fmSim = stringSimilarity(normA.firstMes, normB.firstMes);
        if (fmSim >= 0.3) {
            const fmScore = Math.round(fmSim * 15);
            score += fmScore;
            breakdown.first_mes = fmScore;
        }
    }
    
    if (normA.persWords && normB.persWords) {
        const persSim = wordSetSimilarity(normA.persWords, normB.persWords);
        if (persSim >= 0.3) {
            const persScore = Math.round(persSim * 10);
            score += persScore;
            breakdown.personality = persScore;
        }
    }
    
    if (normA.scenWords && normB.scenWords) {
        const scenSim = wordSetSimilarity(normA.scenWords, normB.scenWords);
        if (scenSim >= 0.3) {
            const scenScore = Math.round(scenSim * 5);
            score += scenScore;
            breakdown.scenario = scenScore;
        }
    }
    
    // === CONTENT DIVERGENCE PENALTY ===
    const contentScore = (breakdown.description || 0) + (breakdown.first_mes || 0) +
                         (breakdown.personality || 0) + (breakdown.scenario || 0) +
                         (breakdown.creator_notes || 0);
    let substantialPairs = 0;
    if (normA.descWords && normB.descWords) substantialPairs++;
    if (normA.firstMesWords && normB.firstMesWords) substantialPairs++;
    if (normA.persWords && normB.persWords) substantialPairs++;
    if (normA.creatorNotesWords && normB.creatorNotesWords) substantialPairs++;
    if (score >= 25 && substantialPairs >= 1 && contentScore < 10) {
        const penalty = Math.min(score - 20, 15);
        if (penalty > 0) {
            score -= penalty;
            breakdown.divergence = -penalty;
        }
    }
    
    // === CONTENT IDENTICAL CHECK ===
    let contentIdentical = false;
    let strictIdentical = false;
    if (breakdown.name && breakdown.creator && substantialPairs >= 1) {
        // asymmetric catches "A has field, B doesnt" which threshold-gated checks used to miss.
        const has = (t) => !!(t && t.length > 0);
        const asymmetric = (a, b) => has(a) !== has(b);
        const wordsMismatch = (wA, wB, tA, tB) => has(tA) && has(tB) && wA && wB && wordSetSimilarity(wA, wB) < 1.0;

        contentIdentical = true;
        if (asymmetric(normA.description, normB.description) || wordsMismatch(normA.descWords, normB.descWords, normA.description, normB.description)) contentIdentical = false;
        if (asymmetric(normA.firstMes, normB.firstMes) || wordsMismatch(normA.firstMesWords, normB.firstMesWords, normA.firstMes, normB.firstMes)) contentIdentical = false;
        if (asymmetric(normA.personality, normB.personality) || wordsMismatch(normA.persWords, normB.persWords, normA.personality, normB.personality)) contentIdentical = false;
        if (asymmetric(normA.scenario, normB.scenario) || wordsMismatch(normA.scenWords, normB.scenWords, normA.scenario, normB.scenario)) contentIdentical = false;
        if (asymmetric(normA.creatorNotes, normB.creatorNotes) || wordsMismatch(normA.creatorNotesWords, normB.creatorNotesWords, normA.creatorNotes, normB.creatorNotes)) contentIdentical = false;
        if (asymmetric(normA.mesExample, normB.mesExample) || wordsMismatch(normA.mesExWords, normB.mesExWords, normA.mesExample, normB.mesExample)) contentIdentical = false;
        if (asymmetric(normA.systemPrompt, normB.systemPrompt) || wordsMismatch(normA.sysPromptWords, normB.sysPromptWords, normA.systemPrompt, normB.systemPrompt)) contentIdentical = false;

        if (contentIdentical) {
            // Exact-mode gate: byte equality only. Any drift bumps token count.
            const eq = (a, b) => (a || '') === (b || '');
            strictIdentical = true;
            if (!eq(normA.description, normB.description)) strictIdentical = false;
            if (!eq(normA.firstMes, normB.firstMes)) strictIdentical = false;
            if (!eq(normA.personality, normB.personality)) strictIdentical = false;
            if (!eq(normA.scenario, normB.scenario)) strictIdentical = false;
            if (!eq(normA.creatorNotes, normB.creatorNotes)) strictIdentical = false;
            if (!eq(normA.mesExample, normB.mesExample)) strictIdentical = false;
            if (!eq(normA.systemPrompt, normB.systemPrompt)) strictIdentical = false;
        }
    }
    
    // === DETERMINE CONFIDENCE ===
    // Fast scan uses a low fixed floor to cast a wide net for candidates.
    // The user's minScore threshold is applied in calculateCharacterSimilarity
    // (the full scorer) and in the post-rescore filter.
    let confidence = null;
    if (score >= 60) confidence = 'high';
    else if (score >= 40) confidence = 'medium';
    else if (score >= 25) confidence = 'low';
    
    let matchReason = matchReasons.length > 0 
        ? matchReasons.slice(0, 3).join(', ')
        : (confidence ? `${score} point similarity score` : '');
    
    return { score, breakdown, confidence, contentIdentical, strictIdentical, matchReason, matchReasons };
}

/**
 * Normalize a character name for comparison
 * Removes version suffixes, extra whitespace, etc.
 */
function normalizeCharName(name) {
    if (!name) return '';
    return name
        .toLowerCase()
        .trim()
        // Remove version suffixes like v2, v3, ver2, version 2, etc.
        .replace(/\s*[\(\[\{]?\s*v(?:er(?:sion)?)?\.?\s*\d+[\)\]\}]?\s*$/i, '')
        .replace(/\s*-?\s*v\d+(\.\d+)*$/i, '')
        // Remove common suffixes
        .replace(/\s*[\(\[\{]?(?:updated?|fixed?|new|old|alt(?:ernate)?|edit(?:ed)?|copy|backup|nsfw)[\)\]\}]?\s*$/i, '')
        // Normalize whitespace
        .replace(/\s+/g, ' ')
        .trim();
}

function nameVariantsForDupe(rawName) {
    const full = normalizeCharName(rawName);
    const variants = new Set();
    if (full) variants.add(full);
    if (rawName.includes('||')) {
        const primary = normalizeCharName(rawName.split('||')[0]);
        if (primary) variants.add(primary);
    }
    return [...variants];
}

function isNamePrefixMatch(a, b) {
    if (!a || !b || a.length === b.length) return false;
    const shorter = a.length < b.length ? a : b;
    const longer = a.length < b.length ? b : a;
    if (shorter.length < 4) return false;
    return longer.startsWith(shorter) && /[\s\-|:,.]/.test(longer[shorter.length]);
}

/**
 * Calculate similarity between two strings (0-1)
 * Uses Levenshtein distance for fuzzy matching
 */
function stringSimilarity(str1, str2) {
    if (!str1 || !str2) return 0;
    
    const s1 = str1.toLowerCase().trim();
    const s2 = str2.toLowerCase().trim();
    
    if (s1 === s2) return 1;
    if (!s1 || !s2) return 0;
    
    // Levenshtein distance for fuzzy matching
    const len1 = s1.length;
    const len2 = s2.length;
    
    // Quick exit for very different lengths
    if (Math.abs(len1 - len2) > Math.max(len1, len2) * 0.5) return 0;
    
    const matrix = [];
    for (let i = 0; i <= len1; i++) {
        matrix[i] = [i];
    }
    for (let j = 0; j <= len2; j++) {
        matrix[0][j] = j;
    }
    
    for (let i = 1; i <= len1; i++) {
        for (let j = 1; j <= len2; j++) {
            const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
            matrix[i][j] = Math.min(
                matrix[i - 1][j] + 1,
                matrix[i][j - 1] + 1,
                matrix[i - 1][j - 1] + cost
            );
        }
    }
    
    const distance = matrix[len1][len2];
    const maxLen = Math.max(len1, len2);
    return 1 - (distance / maxLen);
}

/**
 * Calculate content similarity for longer text fields
 * Uses word overlap / Jaccard similarity for better performance on long texts
 */
function contentSimilarity(text1, text2) {
    if (!text1 || !text2) return 0;
    
    const t1 = text1.toLowerCase().trim();
    const t2 = text2.toLowerCase().trim();
    
    if (t1 === t2) return 1;
    if (!t1 || !t2) return 0;
    
    // For very short texts, use string similarity
    if (t1.length < 50 || t2.length < 50) {
        return stringSimilarity(t1, t2);
    }
    
    // Extract words (3+ chars) for comparison
    const getWords = (text) => {
        const words = text.match(/\b\w{3,}\b/g) || [];
        return new Set(words.map(w => w.toLowerCase()));
    };
    
    const words1 = getWords(t1);
    const words2 = getWords(t2);
    
    if (words1.size === 0 || words2.size === 0) return 0;
    
    // Jaccard similarity: intersection / union
    let intersection = 0;
    for (const word of words1) {
        if (words2.has(word)) intersection++;
    }
    
    const union = words1.size + words2.size - intersection;
    return union > 0 ? intersection / union : 0;
}

/**
 * Get character field value with fallbacks
 */
function getCharField(char, field) {
    if (!char) return '';
    const val = char[field] || (char.data ? char.data[field] : '') || '';
    return typeof val === 'string' ? val : String(val);
}

// Slim chars read the precomputed key (definition fields are stripped); hydrated compute fresh.
function estimateTokens(char) {
    if (char?._slim) return char._tokenEstimate ?? _tokenEstimateCache.get(char.avatar) ?? 0;
    return computeTokenEstimate(char);
}

/**
 * Calculate a comprehensive similarity score between two characters
 * Returns { score, breakdown, confidence, matchReasons }
 * 
 * Scoring weights:
 * - Name exact variant match: 15 pts
 * - Name prefix match: 13 pts
 * - Name similarity (scaled): up to 10 pts
 * - Same creator (non-empty): 15 pts
 * - Creator notes similarity: up to 25 pts
 * - Description similarity: up to 25 pts
 * - First message similarity: up to 15 pts
 * - Personality similarity: up to 10 pts
 * - Scenario similarity: up to 5 pts
 * - Content divergence penalty: up to -15 pts
 * 
 * Confidence thresholds:
 * - High: 60+ points
 * - Medium: 40-59 points
 * - Low: configurable minimum (default 35) - 39 points
 * - No match: below minimum threshold
 */
function calculateCharacterSimilarity(charA, charB) {
    let score = 0;
    const breakdown = {};
    const matchReasons = [];
    
    // === NAME COMPARISON ===
    const nameA = getCharField(charA, 'name') || '';
    const nameB = getCharField(charB, 'name') || '';

    let bestNameScore = 0;
    let bestNameReason = '';

    const variantsA = nameVariantsForDupe(nameA);
    const variantsB = nameVariantsForDupe(nameB);

    for (const va of variantsA) {
        if (va.length < 3) continue;
        for (const vb of variantsB) {
            if (vb.length < 3) continue;
            if (va === vb) {
                if (15 > bestNameScore) { bestNameScore = 15; bestNameReason = 'Exact name match'; }
            } else if (isNamePrefixMatch(va, vb)) {
                if (13 > bestNameScore) { bestNameScore = 13; bestNameReason = 'Name prefix match'; }
            } else {
                const sim = stringSimilarity(va, vb);
                if (sim >= 0.7) {
                    const s = Math.round(sim * 10);
                    if (s > bestNameScore) {
                        bestNameScore = s;
                        bestNameReason = sim >= 0.85 ? `${Math.round(sim * 100)}% name similarity` : '';
                    }
                }
            }
        }
    }

    if (bestNameScore > 0) {
        score += bestNameScore;
        breakdown.name = bestNameScore;
        if (bestNameReason) matchReasons.push(bestNameReason);
    }
    
    // === CREATOR COMPARISON ===
    const creatorA = getCharField(charA, 'creator') || '';
    const creatorB = getCharField(charB, 'creator') || '';
    
    if (creatorA && creatorB) {
        const caLower = creatorA.toLowerCase().trim();
        const cbLower = creatorB.toLowerCase().trim();
        const caCompact = caLower.replace(/[\s_-]/g, '');
        const cbCompact = cbLower.replace(/[\s_-]/g, '');
        if (caCompact === cbCompact) {
            score += 15;
            breakdown.creator = 15;
            matchReasons.push('Same creator');
        } else {
            const creatorSim = stringSimilarity(creatorA, creatorB);
            if (creatorSim >= 0.75) {
                const creatorScore = Math.round(creatorSim * 15);
                score += creatorScore;
                breakdown.creator = creatorScore;
                matchReasons.push(creatorSim >= 0.95 ? 'Same creator' : 'Similar creator');
            }
        }
    }
    
    // === CREATOR NOTES COMPARISON ===
    const notesA = getCharField(charA, 'creator_notes') || '';
    const notesB = getCharField(charB, 'creator_notes') || '';
    
    if (notesA && notesB && notesA.length > 50 && notesB.length > 50) {
        const notesSim = contentSimilarity(notesA, notesB);
        if (notesSim >= 0.25) { // Lower threshold - creator notes often have CSS/HTML differences
            const notesScore = Math.round(notesSim * 25);
            score += notesScore;
            breakdown.creator_notes = notesScore;
            if (notesSim >= 0.6) {
                matchReasons.push(`${Math.round(notesSim * 100)}% creator notes match`);
            }
        }
    }
    
    // === DESCRIPTION COMPARISON ===
    const descA = getCharField(charA, 'description') || '';
    const descB = getCharField(charB, 'description') || '';
    
    if (descA && descB && descA.length > 50 && descB.length > 50) {
        const descSim = contentSimilarity(descA, descB);
        if (descSim >= 0.25) { // Lower threshold
            const descScore = Math.round(descSim * 25);
            score += descScore;
            breakdown.description = descScore;
            if (descSim >= 0.6) {
                matchReasons.push(`${Math.round(descSim * 100)}% description match`);
            }
        }
    }
    
    // === FIRST MESSAGE COMPARISON ===
    const firstMesA = getCharField(charA, 'first_mes') || '';
    const firstMesB = getCharField(charB, 'first_mes') || '';
    
    if (firstMesA && firstMesB && firstMesA.length > 30 && firstMesB.length > 30) {
        const firstMesSim = contentSimilarity(firstMesA, firstMesB);
        if (firstMesSim >= 0.25) {
            const fmScore = Math.round(firstMesSim * 15);
            score += fmScore;
            breakdown.first_mes = fmScore;
            if (firstMesSim >= 0.6) {
                matchReasons.push(`${Math.round(firstMesSim * 100)}% first message match`);
            }
        }
    }
    
    // === PERSONALITY COMPARISON ===
    const persA = getCharField(charA, 'personality') || '';
    const persB = getCharField(charB, 'personality') || '';
    
    if (persA && persB && persA.length > 20 && persB.length > 20) {
        const persSim = contentSimilarity(persA, persB);
        if (persSim >= 0.3) {
            const persScore = Math.round(persSim * 10);
            score += persScore;
            breakdown.personality = persScore;
            if (persSim >= 0.7) {
                matchReasons.push(`${Math.round(persSim * 100)}% personality match`);
            }
        }
    }
    
    // === SCENARIO COMPARISON ===
    const scenA = getCharField(charA, 'scenario') || '';
    const scenB = getCharField(charB, 'scenario') || '';
    
    if (scenA && scenB && scenA.length > 20 && scenB.length > 20) {
        const scenSim = contentSimilarity(scenA, scenB);
        if (scenSim >= 0.3) {
            const scenScore = Math.round(scenSim * 5);
            score += scenScore;
            breakdown.scenario = scenScore;
        }
    }

    // === CONTENT DIVERGENCE PENALTY ===
    const contentScore = (breakdown.description || 0) + (breakdown.first_mes || 0) +
                         (breakdown.personality || 0) + (breakdown.scenario || 0) +
                         (breakdown.creator_notes || 0);
    let substantialPairs = 0;
    if (descA && descB && descA.length > 50 && descB.length > 50) substantialPairs++;
    if (firstMesA && firstMesB && firstMesA.length > 30 && firstMesB.length > 30) substantialPairs++;
    if (persA && persB && persA.length > 20 && persB.length > 20) substantialPairs++;
    if (notesA && notesB && notesA.length > 50 && notesB.length > 50) substantialPairs++;
    if (score >= 25 && substantialPairs >= 1 && contentScore < 10) {
        const penalty = Math.min(score - 20, 15);
        if (penalty > 0) {
            score -= penalty;
            breakdown.divergence = -penalty;
        }
    }
    
    // === CONTENT IDENTICAL CHECK ===
    let contentIdentical = false;
    let strictIdentical = false;
    if (breakdown.name && breakdown.creator && substantialPairs >= 1) {
        const has = (t) => !!(t && t.length > 0);
        const asymmetric = (a, b) => has(a) !== has(b);
        const textMismatch = (a, b) => has(a) && has(b) && contentSimilarity(a, b) < 1.0;

        const mesExA = getCharField(charA, 'mes_example') || '';
        const mesExB = getCharField(charB, 'mes_example') || '';
        const sysPromptA = getCharField(charA, 'system_prompt') || '';
        const sysPromptB = getCharField(charB, 'system_prompt') || '';

        contentIdentical = true;
        if (asymmetric(descA, descB) || textMismatch(descA, descB)) contentIdentical = false;
        if (asymmetric(firstMesA, firstMesB) || textMismatch(firstMesA, firstMesB)) contentIdentical = false;
        if (asymmetric(persA, persB) || textMismatch(persA, persB)) contentIdentical = false;
        if (asymmetric(scenA, scenB) || textMismatch(scenA, scenB)) contentIdentical = false;
        if (asymmetric(notesA, notesB) || textMismatch(notesA, notesB)) contentIdentical = false;
        if (asymmetric(mesExA, mesExB) || textMismatch(mesExA, mesExB)) contentIdentical = false;
        if (asymmetric(sysPromptA, sysPromptB) || textMismatch(sysPromptA, sysPromptB)) contentIdentical = false;

        if (contentIdentical) {
            const eq = (a, b) => (a || '') === (b || '');
            strictIdentical = true;
            if (!eq(descA, descB)) strictIdentical = false;
            if (!eq(firstMesA, firstMesB)) strictIdentical = false;
            if (!eq(persA, persB)) strictIdentical = false;
            if (!eq(scenA, scenB)) strictIdentical = false;
            if (!eq(notesA, notesB)) strictIdentical = false;
            if (!eq(mesExA, mesExB)) strictIdentical = false;
            if (!eq(sysPromptA, sysPromptB)) strictIdentical = false;
        }
    }
    
    // === DETERMINE CONFIDENCE ===
    let confidence = null;
    if (score >= 60) confidence = 'high';
    else if (score >= 40) confidence = 'medium';
    else if (score >= 25) confidence = 'low';
    
    // Build match reason string
    let matchReason = '';
    if (matchReasons.length > 0) {
        matchReason = matchReasons.slice(0, 3).join(', '); // Max 3 reasons
    } else if (confidence) {
        matchReason = `${score} point similarity score`;
    }
    
    return {
        score,
        breakdown,
        confidence,
        contentIdentical,
        strictIdentical,
        matchReason,
        matchReasons
    };
}

/**
 * Find all potential duplicate groups in the library (async with progress)
 * Uses caching and chunked processing to avoid blocking the browser
 */
async function findCharacterDuplicates(forceRefresh = false) {
    const now = Date.now();
    
    // Check cache validity
    if (!forceRefresh && 
        duplicateScanCache.groups.length > 0 &&
        duplicateScanCache.charCount === allCharacters.length &&
        (now - duplicateScanCache.timestamp) < DUPLICATE_CACHE_TTL) {
        debugLog('[Duplicates] Using cached results');
        return applyDuplicateMinScoreFilter(duplicateScanCache.groups);
    }
    
    const statusEl = document.getElementById('charDuplicatesScanStatus');
    const totalChars = allCharacters.length;

    const scanGen = ++_dupScanGen;
    _dupScanActive = true;
    const scanCancelled = () => scanGen !== _dupScanGen;

    debugLog('[Duplicates] Scanning', totalChars, 'characters...');

    // Phase 1: Build normalized data (show progress)
    if (statusEl) {
        statusEl.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Preparing character data...';
    }

    // Yield to UI
    await new Promise(r => setTimeout(r, 10));
    if (scanCancelled()) return null;
    
    // Fetch full data for content comparison (allCharacters stores slim objects)
    let fullDataMap = null;
    if (allCharacters.length > 0) {
        try {
            if (statusEl) {
                statusEl.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Fetching full character data for deep comparison...';
            }
            const response = await apiRequest(ENDPOINTS.CHARACTERS_ALL, 'POST', {});
            if (!response.ok) {
                console.warn('[Duplicates] /characters/all returned', response.status);
            } else {
                const data = await response.json();
                const arr = Array.isArray(data) ? data : (data.data || []);
                if (arr.length > 0 && arr[0].shallow) {
                    console.warn('[Duplicates] Server returned shallow data — will re-score via individual hydration');
                } else if (arr.length > 0) {
                    fullDataMap = new Map();
                    for (const c of arr) {
                        if (c?.avatar) fullDataMap.set(c.avatar, c);
                    }
                }
            }
        } catch (e) {
            console.warn('[Duplicates] Failed to fetch full data:', e.message);
        }
    }
    
    if (scanCancelled()) return null;
    const normalizedData = buildNormalizedCharacterData(fullDataMap);
    const hadFullData = fullDataMap !== null;
    fullDataMap = null; // Release full data - normalizedData has extracted what it needs
    
    if (statusEl) {
        statusEl.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Comparing characters (0%)...';
    }
    
    // Phase 2: Compare characters in chunks
    const groups = [];
    const processed = new Set();
    const CHUNK_SIZE = 50; // Process 50 characters per chunk
    
    for (let i = 0; i < normalizedData.length; i++) {
        const normA = normalizedData[i];
        if (!normA || processed.has(normA.avatar)) continue;
        
        const duplicates = [];
        
        for (let j = i + 1; j < normalizedData.length; j++) {
            const normB = normalizedData[j];
            if (!normB || processed.has(normB.avatar)) continue;
            
            // Use fast similarity with pre-normalized data
            const similarity = calculateFastSimilarity(normA, normB);
            
            if (similarity.confidence) {
                duplicates.push({
                    char: normB.char,
                    confidence: similarity.confidence,
                    contentIdentical: similarity.contentIdentical || false,
                    strictIdentical: similarity.strictIdentical || false,
                    matchReason: similarity.matchReason,
                    score: similarity.score,
                    breakdown: similarity.breakdown
                });
            }
        }
        
        if (duplicates.length > 0) {
            processed.add(normA.avatar);
            duplicates.forEach(d => processed.add(d.char.avatar));
            
            const confidenceOrder = { high: 3, medium: 2, low: 1 };
            const groupConfidence = duplicates.reduce((max, d) => 
                confidenceOrder[d.confidence] > confidenceOrder[max] ? d.confidence : max
            , duplicates[0].confidence);
            
            duplicates.sort((a, b) => b.score - a.score);
            
            groups.push({
                reference: normA.char,
                duplicates,
                confidence: groupConfidence
            });
        }
        
        // Update progress and yield to UI every chunk
        if (i % CHUNK_SIZE === 0 && i > 0) {
            const percent = Math.round((i / normalizedData.length) * 100);
            if (statusEl) {
                statusEl.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Comparing characters (${percent}%)...`;
            }
            await new Promise(r => setTimeout(r, 0)); // Yield to UI
            if (scanCancelled()) return null;
        }
    }
    
    // If full data was unavailable (ST lazy loading, API error, etc.), the batch
    // scan only matched on name/creator. Hydrate just the detected group members
    // individually and re-score with full content for accurate results.
    if (!hadFullData && groups.length > 0) {
        if (statusEl) {
            statusEl.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Refining scores with full data...';
        }
        await new Promise(r => setTimeout(r, 0));
        if (scanCancelled()) return null;

        const charsToHydrate = new Set();
        for (const group of groups) {
            charsToHydrate.add(group.reference);
            for (const dup of group.duplicates) charsToHydrate.add(dup.char);
        }
        await Promise.all([...charsToHydrate].map(c => hydrateCharacter(c)));
        if (scanCancelled()) return null;
        
        // Re-score each pair with hydrated content
        const minScore = getSetting('duplicateMinScore') || 35;
        for (const group of groups) {
            for (const dup of group.duplicates) {
                const rescore = calculateCharacterSimilarity(group.reference, dup.char);
                dup.score = rescore.score;
                dup.breakdown = rescore.breakdown;
                dup.confidence = rescore.confidence;
                dup.contentIdentical = rescore.contentIdentical || false;
                dup.strictIdentical = rescore.strictIdentical || false;
                dup.matchReason = rescore.matchReason;
                dup.matchReasons = rescore.matchReasons;
            }
            // Drop dupes that fell below threshold after re-score (but keep content-identical)
            group.duplicates = group.duplicates.filter(d => d.confidence || d.contentIdentical);
            // Recalculate group confidence
            if (group.duplicates.length > 0) {
                const confidenceOrder = { high: 3, medium: 2, low: 1 };
                group.confidence = group.duplicates.reduce((max, d) =>
                    confidenceOrder[d.confidence] > confidenceOrder[max] ? d.confidence : max
                , group.duplicates[0].confidence);
                group.duplicates.sort((a, b) => b.score - a.score);
            }
        }
        // Remove groups with no remaining duplicates
        const filtered = groups.filter(g => g.duplicates.length > 0);
        groups.length = 0;
        groups.push(...filtered);
    }
    
    // Sort groups
    const confidenceSort = { high: 0, medium: 1, low: 2 };
    groups.sort((a, b) => {
        const confDiff = confidenceSort[a.confidence] - confidenceSort[b.confidence];
        if (confDiff !== 0) return confDiff;
        const aMaxScore = Math.max(...a.duplicates.map(d => d.score));
        const bMaxScore = Math.max(...b.duplicates.map(d => d.score));
        return bMaxScore - aMaxScore;
    });
    
    if (scanCancelled()) return null;

    // Update cache
    duplicateScanCache = {
        timestamp: now,
        charCount: allCharacters.length,
        groups: groups,
        normalizedData: normalizedData
    };

    debugLog('[Duplicates] Found', groups.length, 'potential duplicate groups');

    _dupScanActive = false;
    return applyDuplicateMinScoreFilter(groups);
}

// Shared min-score predicate so the filtered render and the transfer-target list cant drift apart.
function dupePassesMinScore(d, minScore, exactMode) {
    return exactMode ? d.strictIdentical : (d.contentIdentical || d.score >= minScore);
}

function applyDuplicateMinScoreFilter(groups) {
    const minScore = getSetting('duplicateMinScore') || 35;
    const exactMode = minScore >= 120;
    const filtered = [];
    for (const group of groups) {
        const dupes = group.duplicates.filter(d => dupePassesMinScore(d, minScore, exactMode));
        if (dupes.length > 0) {
            filtered.push({ ...group, duplicates: dupes });
        }
    }
    return filtered;
}

/**
 * Build a lookup index of all provider links across allCharacters.
 * Called once before batch operations to avoid O(N*P) getLinkInfo calls per item.
 * @returns {{ pathIndex: Map<string, {char, providerName}>, providerIndex: Map<string, Object> }}
 */
function buildProviderLinkIndex() {
    const pathIndex = new Map();
    const providerIndex = new Map();
    const allProviders = window.ProviderRegistry?.getAllProviders() || [];

    for (const existing of allCharacters) {
        if (!existing) continue;

        for (const provider of allProviders) {
            const linkInfo = provider.getLinkInfo(existing);
            if (!linkInfo) continue;

            if (linkInfo.fullPath) {
                const path = linkInfo.fullPath.toLowerCase();
                if (!pathIndex.has(path)) {
                    pathIndex.set(path, { char: existing, providerName: provider.name });
                }
                providerIndex.set(`${provider.id}:${path}`, existing);
            }
            if (linkInfo.id != null) {
                providerIndex.set(`${provider.id}:${String(linkInfo.id).toLowerCase()}`, existing);
            }
        }

        // Legacy chub fields (pre-provider-system characters)
        const chubUrl = existing.data?.extensions?.chub?.url ||
                       existing.data?.extensions?.chub?.full_path ||
                       existing.chub_url || existing.source_url || '';
        if (chubUrl) {
            const urlMatch = chubUrl.match(/characters\/([^\/]+\/[^\/\?]+)/);
            const chubPath = urlMatch ? urlMatch[1].toLowerCase() : chubUrl.toLowerCase();
            if (!pathIndex.has(chubPath)) {
                pathIndex.set(chubPath, { char: existing, providerName: null });
            }
        }
    }

    return { pathIndex, providerIndex };
}

/**
 * Check if a new character has potential duplicates in library
 * @param {Object} newChar
 * @param {{ pathIndex: Map, providerIndex: Map }|null} linkIndex - Pre-built index from buildProviderLinkIndex()
 * @returns {Array}
 */
// Loose path equality for the provider-path duplicate checks. Substring
// matching exists for URL-vs-path flexibility, but empty paths never match
// and purely numeric ids (eg. botbooru post ids) only match exactly:
// "148402".includes("48402") is not the same card.
function providerPathsMatch(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    if (/^\d+$/.test(a) || /^\d+$/.test(b)) return false;
    return a.includes(b) || b.includes(a);
}

function checkCharacterForDuplicates(newChar, linkIndex) {
    const matches = [];
    
    const newFullPath = (newChar.fullPath || newChar.full_path || '').toLowerCase();
    
    // Build a pseudo-character object for comparison
    const newCharObj = {
        name: newChar.name || newChar.definition?.name || '',
        creator: newChar.creator || newChar.definition?.creator || '',
        description: newChar.description || newChar.definition?.description || '',
        first_mes: newChar.first_mes || newChar.definition?.first_mes || '',
        personality: newChar.personality || newChar.definition?.personality || '',
        scenario: newChar.scenario || newChar.definition?.scenario || '',
        creator_notes: newChar.creator_notes || newChar.definition?.creator_notes || ''
    };
    
    const pathMatchedAvatars = new Set();

    if (linkIndex && newFullPath) {
        // Fast path: use pre-built index for provider path matching
        const exactHit = linkIndex.pathIndex.get(newFullPath);
        if (exactHit) {
            matches.push({
                char: exactHit.char,
                confidence: 'high',
                matchReason: exactHit.providerName
                    ? `Same ${exactHit.providerName} character (exact path match)`
                    : 'Same character (exact path match)',
                score: 100,
                breakdown: { providerPath: 100 }
            });
            pathMatchedAvatars.add(exactHit.char.avatar);
        } else {
            // Substring fallback: scan index entries (still no getLinkInfo calls)
            for (const [indexedPath, entry] of linkIndex.pathIndex) {
                if (providerPathsMatch(indexedPath, newFullPath)) {
                    matches.push({
                        char: entry.char,
                        confidence: 'high',
                        matchReason: entry.providerName
                            ? `Same ${entry.providerName} character (exact path match)`
                            : 'Same character (exact path match)',
                        score: 100,
                        breakdown: { providerPath: 100 }
                    });
                    pathMatchedAvatars.add(entry.char.avatar);
                    break;
                }
            }
        }
    }

    for (const existing of allCharacters) {
        if (!existing) continue;
        if (pathMatchedAvatars.has(existing.avatar)) continue;
        
        // Inline provider path matching when no pre-built index is available
        let providerPathMatched = false;
        if (!linkIndex && newFullPath) {
            const allProviders = window.ProviderRegistry?.getAllProviders() || [];
            for (const provider of allProviders) {
                const linkInfo = provider.getLinkInfo(existing);
                if (!linkInfo) continue;
                const existingPath = (linkInfo.fullPath || '').toLowerCase();
                if (providerPathsMatch(existingPath, newFullPath)) {
                    matches.push({
                        char: existing,
                        confidence: 'high',
                        matchReason: `Same ${provider.name} character (exact path match)`,
                        score: 100,
                        breakdown: { providerPath: 100 }
                    });
                    providerPathMatched = true;
                    break;
                }
            }
            
            if (!providerPathMatched) {
                const existingChubUrl = existing.data?.extensions?.chub?.url || 
                                       existing.data?.extensions?.chub?.full_path ||
                                       existing.chub_url || 
                                       existing.source_url || '';
                if (existingChubUrl) {
                    const match = existingChubUrl.match(/characters\/([^\/]+\/[^\/\?]+)/);
                    const existingPath = match ? match[1].toLowerCase() : existingChubUrl.toLowerCase();
                    if (providerPathsMatch(existingPath, newFullPath)) {
                        matches.push({
                            char: existing,
                            confidence: 'high',
                            matchReason: 'Same character (exact path match)',
                            score: 100,
                            breakdown: { providerPath: 100 }
                        });
                        providerPathMatched = true;
                    }
                }
            }
        }
        if (providerPathMatched) continue;
        
        // Calculate comprehensive similarity
        const similarity = calculateCharacterSimilarity(newCharObj, existing);
        
        if (similarity.confidence) {
            matches.push({
                char: existing,
                confidence: similarity.confidence,
                contentIdentical: similarity.contentIdentical || false,
                strictIdentical: similarity.strictIdentical || false,
                matchReason: similarity.matchReason,
                score: similarity.score,
                breakdown: similarity.breakdown
            });
        }
    }
    
    // Sort by score (highest first)
    matches.sort((a, b) => b.score - a.score);
    
    return matches;
}

async function checkCharacterForDuplicatesAsync(newChar) {
    const syncMatches = checkCharacterForDuplicates(newChar);

    if (syncMatches.length > 0 && syncMatches[0].score >= 60) {
        return syncMatches;
    }

    const newName = normalizeCharName(newChar.name || newChar.definition?.name || '');
    const newCreator = String(newChar.creator || newChar.definition?.creator || '').toLowerCase().trim();
    const newNameRaw = newChar.name || newChar.definition?.name || '';
    const newNameVariants = nameVariantsForDupe(newNameRaw);

    if (newName.length < 4 && newCreator.length < 3) return syncMatches;

    const candidateSet = new Set();

    // Slim chars from sync matches already scored on partial data; hydrating may push them above threshold
    for (const match of syncMatches) {
        if (match.char?._slim) candidateSet.add(match.char);
    }

    // Name match: exact variant or word-boundary prefix (including || splits)
    const newPrefixVariants = newNameVariants.filter(v => v.length >= 4);
    if (newPrefixVariants.length > 0) {
        for (const existing of allCharacters) {
            if (!existing?._slim || candidateSet.has(existing)) continue;
            const existingVariants = nameVariantsForDupe(existing.name || '');
            let matched = false;

            for (const nv of newPrefixVariants) {
                for (const ev of existingVariants) {
                    if (ev.length < 4) continue;
                    if (ev === nv || isNamePrefixMatch(nv, ev)) {
                        matched = true;
                        break;
                    }
                }
                if (matched) break;
            }

            if (matched) {
                candidateSet.add(existing);
                if (candidateSet.size >= 15) break;
            }
        }
    }

    // Same creator (fuzzy) with different name: catches cross-provider clones
    if (newCreator.length >= 3 && candidateSet.size < 15) {
        const newCreatorCompact = newCreator.replace(/[\s_-]/g, '');
        const creatorCandidates = [];
        for (const existing of allCharacters) {
            if (!existing?._slim || candidateSet.has(existing)) continue;
            const existingCreator = String(existing.data?.creator || '').toLowerCase().trim();
            if (existingCreator.length < 3) continue;
            const existingCompact = existingCreator.replace(/[\s_-]/g, '');
            if (newCreatorCompact === existingCompact || stringSimilarity(newCreator, existingCreator) >= 0.75) {
                const nameScore = newName.length >= 4
                    ? stringSimilarity(newName, normalizeCharName(existing.name || ''))
                    : 0;
                creatorCandidates.push({ char: existing, nameScore });
            }
        }
        creatorCandidates.sort((a, b) => b.nameScore - a.nameScore);
        const slots = Math.min(5, 15 - candidateSet.size);
        for (let i = 0; i < Math.min(slots, creatorCandidates.length); i++) {
            candidateSet.add(creatorCandidates[i].char);
        }
    }

    if (candidateSet.size === 0) return syncMatches;

    const toHydrate = [...candidateSet].slice(0, 15);
    await Promise.all(toHydrate.map(c => hydrateCharacter(c)));

    const newCharObj = {
        name: newChar.name || newChar.definition?.name || '',
        creator: newChar.creator || newChar.definition?.creator || '',
        description: newChar.description || newChar.definition?.description || '',
        first_mes: newChar.first_mes || newChar.definition?.first_mes || '',
        personality: newChar.personality || newChar.definition?.personality || '',
        scenario: newChar.scenario || newChar.definition?.scenario || '',
        creator_notes: newChar.creator_notes || newChar.definition?.creator_notes || ''
    };

    for (const existing of toHydrate) {
        const similarity = calculateCharacterSimilarity(newCharObj, existing);
        const existingMatch = syncMatches.find(m => m.char === existing);
        if (existingMatch) {
            // Hydrated re-score always wins: it has more data (descriptions, first_mes)
            // and can apply divergence penalties that slim scoring can't
            existingMatch.score = similarity.score;
            existingMatch.confidence = similarity.confidence;
            existingMatch.contentIdentical = similarity.contentIdentical || false;
            existingMatch.strictIdentical = similarity.strictIdentical || false;
            existingMatch.matchReason = similarity.matchReason;
            existingMatch.breakdown = similarity.breakdown;
        } else if (similarity.confidence) {
            syncMatches.push({
                char: existing,
                confidence: similarity.confidence,
                contentIdentical: similarity.contentIdentical || false,
                strictIdentical: similarity.strictIdentical || false,
                matchReason: similarity.matchReason,
                score: similarity.score,
                breakdown: similarity.breakdown
            });
        }
    }

    // Remove matches that fell below threshold after hydrated re-scoring
    const minScore = getSetting('duplicateMinScore') || 35;
    for (let i = syncMatches.length - 1; i >= 0; i--) {
        if (!syncMatches[i].confidence) syncMatches.splice(i, 1);
    }

    syncMatches.sort((a, b) => b.score - a.score);
    return syncMatches;
}

/**
 * Render a field diff between two characters - side by side comparison
 */
function renderFieldDiff(fieldName, valueA, valueB, labelA = 'Keep', labelB = 'Duplicate') {
    valueA = valueA || '';
    valueB = valueB || '';
    
    // Normalize for comparison - handle invisible whitespace differences
    const normalizeText = (text) => {
        return text
            .replace(/\r\n/g, '\n')           // Normalize line endings
            .replace(/\r/g, '\n')             // Handle old Mac line endings
            .replace(/\u00A0/g, ' ')          // Non-breaking space to regular space
            .replace(/\u200B/g, '')           // Remove zero-width spaces
            .replace(/\t/g, '    ')           // Tabs to 4 spaces
            .replace(/ +/g, ' ')              // Multiple spaces to single
            .replace(/ *\n */g, '\n')         // Trim spaces around newlines
            .trim();
    };
    
    const normA = normalizeText(valueA);
    const normB = normalizeText(valueB);
    const isSame = normA === normB;
    
    // Check if normalization made a difference (raw values differ but normalized are same)
    const rawDiffers = valueA !== valueB;
    const normalizedAway = isSame && rawDiffers;
    
    // Both empty - don't show
    if (isSame && !normA) return { html: '', isSame: true, isEmpty: true, normalizedAway: false };
    
    // Get icon for field type
    const icons = {
        'Description': 'fa-solid fa-scroll',
        'Personality': 'fa-solid fa-brain',
        'First Message': 'fa-solid fa-comment',
        'Scenario': 'fa-solid fa-map',
        'Example Messages': 'fa-solid fa-comments',
        'System Prompt': 'fa-solid fa-terminal',
        'Creator Notes': 'fa-solid fa-sticky-note',
        'Tags': 'fa-solid fa-tags'
    };
    const icon = icons[fieldName] || 'fa-solid fa-file-alt';
    
    // Identical content (after normalization) - show once
    if (isSame) {
        const wsNote = normalizedAway ? '<span class="diff-ws-note" title="The raw text differs only in whitespace (spaces, tabs, line endings)"><i class="fa-solid fa-asterisk"></i> whitespace differs</span>' : '';
        const html = `<div class="char-dup-diff-section"><div class="char-dup-diff-label"><i class="${icon}"></i> ${escapeHtml(fieldName)} ${wsNote}</div><div class="char-dup-diff-content same"><div class="char-dup-diff-content-label">Both versions identical</div><div class="diff-text-content">${escapeHtml(normA)}</div></div></div>`;
        return { html, isSame: true, isEmpty: false, normalizedAway };
    }
    
    // Different content - show with diff highlighting
    let keepHtml, dupHtml;
    
    if (!normA) {
        keepHtml = '<span class="diff-empty">(empty)</span>';
        dupHtml = `<span class="diff-added">${escapeHtml(normB)}</span>`;
    } else if (!normB) {
        keepHtml = `<span class="diff-removed">${escapeHtml(normA)}</span>`;
        dupHtml = '<span class="diff-empty">(empty)</span>';
    } else {
        // Both have content - find and highlight differences
        const diffStart = findFirstDifference(normA, normB);
        const diffEnd = findLastDifference(normA, normB);
        
        if (diffStart === -1) {
            // No difference found (shouldn't happen since we checked isSame)
            keepHtml = escapeHtml(normA);
            dupHtml = escapeHtml(normB);
        } else {
            const oldChangeEnd = diffEnd.pos1 + 1;
            const newChangeEnd = diffEnd.pos2 + 1;
            keepHtml = buildHighlightedString(normA, diffStart, oldChangeEnd, 'diff-removed');
            dupHtml = buildHighlightedString(normB, diffStart, newChangeEnd, 'diff-added');
        }
    }
    
    const html = `<div class="char-dup-diff-section"><div class="char-dup-diff-label"><i class="${icon}"></i> ${escapeHtml(fieldName)}</div><div class="char-dup-diff-stack"><div class="char-dup-diff-content keep"><div class="char-dup-diff-content-label"><i class="fa-solid fa-check"></i> ${escapeHtml(labelA)}</div><div class="diff-text-content">${keepHtml}</div></div><div class="char-dup-diff-content duplicate"><div class="char-dup-diff-content-label"><i class="fa-solid fa-trash"></i> ${escapeHtml(labelB)}</div><div class="diff-text-content">${dupHtml}</div></div></div></div>`;
    return { html, isSame: false, isEmpty: false, normalizedAway: false };
}

/**
 * Render a tag comparison diff for duplicate detection
 * @param {Array} tagsA - Tags from the first character
 * @param {Array} tagsB - Tags from the second character
 * @returns {Object} Object with html, isSame, isEmpty flags
 */
function renderTagsDiff(tagsA, tagsB) {
    const arrA = Array.isArray(tagsA) ? tagsA.map(t => String(t).trim()).filter(t => t) : [];
    const arrB = Array.isArray(tagsB) ? tagsB.map(t => String(t).trim()).filter(t => t) : [];
    
    const setA = new Set(arrA);
    const setB = new Set(arrB);
    
    // Find differences
    const onlyInA = arrA.filter(t => !setB.has(t));
    const onlyInB = arrB.filter(t => !setA.has(t));
    const inBoth = arrA.filter(t => setB.has(t));
    
    const isSame = onlyInA.length === 0 && onlyInB.length === 0;
    const isEmpty = arrA.length === 0 && arrB.length === 0;
    
    if (isEmpty) return { html: '', isSame: true, isEmpty: true };
    
    const icon = 'fa-solid fa-tags';
    
    // Helper to render tag pills
    const renderTagPill = (tag, className = '') => 
        `<span class="dup-tag-pill ${className}">${escapeHtml(tag)}</span>`;
    
    if (isSame) {
        // All tags identical
        const tagPills = arrA.map(t => renderTagPill(t)).join('');
        const html = `
            <div class="char-dup-diff-section">
                <div class="char-dup-diff-label"><i class="${icon}"></i> Tags (${arrA.length})</div>
                <div class="char-dup-diff-content same">
                    <div class="char-dup-diff-content-label">Both versions identical</div>
                    <div class="dup-tags-container">${tagPills}</div>
                </div>
            </div>`;
        return { html, isSame: true, isEmpty: false };
    }
    
    // Tags differ - show comparison
    const keepTagsHtml = arrA.length === 0 
        ? '<span class="diff-empty">(no tags)</span>'
        : arrA.map(t => renderTagPill(t, setB.has(t) ? 'dup-tag-same' : 'dup-tag-removed')).join('');
    
    const dupTagsHtml = arrB.length === 0
        ? '<span class="diff-empty">(no tags)</span>'
        : arrB.map(t => renderTagPill(t, setA.has(t) ? 'dup-tag-same' : 'dup-tag-added')).join('');
    
    // Summary of differences
    const diffSummary = [];
    if (onlyInA.length > 0) diffSummary.push(`${onlyInA.length} only in Keep`);
    if (onlyInB.length > 0) diffSummary.push(`${onlyInB.length} only in Duplicate`);
    if (inBoth.length > 0) diffSummary.push(`${inBoth.length} shared`);
    
    const html = `
        <div class="char-dup-diff-section">
            <div class="char-dup-diff-label"><i class="${icon}"></i> Tags <span class="dup-diff-summary">(${diffSummary.join(', ')})</span></div>
            <div class="char-dup-diff-container">
                <div class="char-dup-diff-stack">
                    <div class="char-dup-diff-content keep">
                        <div class="char-dup-diff-content-label">Keep (${arrA.length})</div>
                        <div class="dup-tags-container">${keepTagsHtml}</div>
                    </div>
                    <div class="char-dup-diff-content duplicate">
                        <div class="char-dup-diff-content-label">Duplicate (${arrB.length})</div>
                        <div class="dup-tags-container">${dupTagsHtml}</div>
                    </div>
                </div>
            </div>
        </div>`;
    
    return { html, isSame: false, isEmpty: false };
}

/**
 * Compare two characters and return difference indicators
 * @param {Object} refChar - Reference character
 * @param {Object} dupChar - Duplicate character to compare
 * @returns {Object} Object with diff flags for each field
 */
function compareCharacterDifferences(refChar, dupChar) {
    const refName = getCharField(refChar, 'name') || '';
    const dupName = getCharField(dupChar, 'name') || '';
    const refCreator = getCharField(refChar, 'creator') || '';
    const dupCreator = getCharField(dupChar, 'creator') || '';
    const refTokens = estimateTokens(refChar);
    const dupTokens = estimateTokens(dupChar);
    
    // Get dates
    let refDate = null, dupDate = null;
    if (refChar.date_added) refDate = new Date(Number(refChar.date_added));
    else if (refChar.create_date) refDate = new Date(refChar.create_date);
    if (dupChar.date_added) dupDate = new Date(Number(dupChar.date_added));
    else if (dupChar.create_date) dupDate = new Date(dupChar.create_date);
    
    // Compare content fields
    const refDesc = (getCharField(refChar, 'description') || '').trim();
    const dupDesc = (getCharField(dupChar, 'description') || '').trim();
    const refFirstMes = (getCharField(refChar, 'first_mes') || '').trim();
    const dupFirstMes = (getCharField(dupChar, 'first_mes') || '').trim();
    const refPers = (getCharField(refChar, 'personality') || '').trim();
    const dupPers = (getCharField(dupChar, 'personality') || '').trim();
    const refScenario = (getCharField(refChar, 'scenario') || '').trim();
    const dupScenario = (getCharField(dupChar, 'scenario') || '').trim();
    
    // Compare tags
    const refTags = getTags(refChar);
    const dupTags = getTags(dupChar);
    const refTagSet = new Set(refTags.map(t => String(t).toLowerCase().trim()));
    const dupTagSet = new Set(dupTags.map(t => String(t).toLowerCase().trim()));
    const tagsMatch = refTagSet.size === dupTagSet.size && [...refTagSet].every(t => dupTagSet.has(t));
    const tagDiff = dupTags.length - refTags.length;
    // Count tags that are different (unique to each side)
    const tagsOnlyInRef = [...refTagSet].filter(t => !dupTagSet.has(t)).length;
    const tagsOnlyInDup = [...dupTagSet].filter(t => !refTagSet.has(t)).length;
    
    // Token difference threshold (consider different if >5% difference)
    const tokenDiffPercent = refTokens > 0 ? Math.abs(refTokens - dupTokens) / refTokens : 0;
    
    return {
        name: refName.toLowerCase() !== dupName.toLowerCase(),
        creator: refCreator.toLowerCase() !== dupCreator.toLowerCase(),
        tokens: tokenDiffPercent > 0.05,
        date: refDate && dupDate && refDate.toDateString() !== dupDate.toDateString(),
        description: refDesc !== dupDesc,
        firstMessage: refFirstMes !== dupFirstMes,
        personality: refPers !== dupPers,
        scenario: refScenario !== dupScenario,
        // Which is newer
        isNewer: dupDate && refDate && dupDate > refDate,
        isOlder: dupDate && refDate && dupDate < refDate,
        hasMoreTokens: dupTokens > refTokens,
        hasLessTokens: dupTokens < refTokens,
        tags: !tagsMatch,
        tagDiff: tagDiff,  // positive = more tags, negative = fewer tags
        tagsOnlyInKeep: tagsOnlyInRef,  // tags unique to keep/reference
        tagsOnlyInDup: tagsOnlyInDup    // tags unique to duplicate
    };
}

function getDuplicateScoreLabel(score, isStrictIdentical = false) {
    if (isStrictIdentical) return 'Identical';
    if (score >= 80) return 'Near-Identical';
    if (score >= 60) return 'Very Similar';
    if (score >= 40) return 'Similar';
    return 'Possible Match';
}

function renderCharDupCard(char, type, charIdx = 0, diffs = null) {
    const name = getCharField(char, 'name') || 'Unknown';
    const creator = getCharField(char, 'creator') || 'Unknown creator';
    const avatarPath = getCharacterAvatarStThumbUrl(char.avatar);
    const tokens = estimateTokens(char);
    
    // Date
    let dateStr = 'Unknown';
    if (char.date_added) {
        const d = new Date(Number(char.date_added));
        if (!isNaN(d.getTime())) dateStr = d.toLocaleDateString();
    } else if (char.create_date) {
        const d = new Date(char.create_date);
        if (!isNaN(d.getTime())) dateStr = d.toLocaleDateString();
    }
    
    const isReference = type === 'reference';
    const label = isReference ? 'Keep' : 'Potential Duplicate';
    
    // Build difference badges for duplicate cards
    let diffBadges = '';
    if (diffs && !isReference) {
        const badges = [];
        if (diffs.isNewer) badges.push('<span class="diff-badge newer" title="This version is newer"><i class="fa-solid fa-arrow-up"></i> Newer</span>');
        if (diffs.isOlder) badges.push('<span class="diff-badge older" title="This version is older"><i class="fa-solid fa-arrow-down"></i> Older</span>');
        if (diffs.hasMoreTokens) badges.push('<span class="diff-badge more-tokens" title="Has more content"><i class="fa-solid fa-plus"></i> More</span>');
        if (diffs.hasLessTokens) badges.push('<span class="diff-badge less-tokens" title="Has less content"><i class="fa-solid fa-minus"></i> Less</span>');
        if (diffs.description) badges.push('<span class="diff-badge content-diff" title="Description differs"><i class="fa-solid fa-file-alt"></i> Desc</span>');
        if (diffs.firstMessage) badges.push('<span class="diff-badge content-diff" title="First message differs"><i class="fa-solid fa-comment"></i> 1st Msg</span>');
        if (diffs.personality) badges.push('<span class="diff-badge content-diff" title="Personality differs"><i class="fa-solid fa-brain"></i> Pers</span>');
        if (diffs.scenario) badges.push('<span class="diff-badge content-diff" title="Scenario differs"><i class="fa-solid fa-map"></i> Scen</span>');
        if (diffs.tags) {
            let tagTooltip;
            if (diffs.tagDiff > 0) {
                tagTooltip = `Has ${diffs.tagDiff} more tag${diffs.tagDiff !== 1 ? 's' : ''}`;
            } else if (diffs.tagDiff < 0) {
                tagTooltip = `Has ${Math.abs(diffs.tagDiff)} fewer tag${Math.abs(diffs.tagDiff) !== 1 ? 's' : ''}`;
            } else {
                // Same count but different tags - show breakdown
                tagTooltip = `${diffs.tagsOnlyInDup} unique here, ${diffs.tagsOnlyInKeep} unique in Keep`;
            }
            badges.push(`<span class="diff-badge tags-diff" title="${tagTooltip}"><i class="fa-solid fa-tags"></i> Tags</span>`);
        }
        
        if (badges.length > 0) {
            diffBadges = `<div class="char-dup-card-diffs">${badges.join('')}</div>`;
        }
    }
    
    // Highlight differing fields
    const dateClass = diffs && diffs.date ? 'diff-highlight' : '';
    const tokenClass = diffs && diffs.tokens ? 'diff-highlight' : '';
    
    const galleryCountId = `gallery-count-${char.avatar.replace(/[^a-zA-Z0-9]/g, '_')}`;
    
    return `
        <div class="char-dup-card ${type}" data-avatar="${escapeHtml(char.avatar)}">
            <div class="char-dup-card-label">${label}</div>
            ${diffBadges}
            <div class="char-dup-card-header">
                <img class="char-dup-card-avatar" src="${avatarPath}" alt="${escapeHtml(name)}" loading="lazy" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><rect fill=%22%23333%22 width=%22100%22 height=%22100%22/><text x=%2250%22 y=%2255%22 text-anchor=%22middle%22 fill=%22%23666%22 font-size=%2240%22>?</text></svg>'">
                <div class="char-dup-card-title">
                    <div class="char-dup-card-name">${escapeHtml(name)}</div>
                    <div class="char-dup-card-creator">by ${escapeHtml(creator)}</div>
                </div>
            </div>
            <div class="char-dup-card-meta">
                <div class="char-dup-card-meta-item ${dateClass}"><i class="fa-solid fa-calendar"></i> ${dateStr}</div>
                <div class="char-dup-card-meta-item ${tokenClass}"><i class="fa-solid fa-code"></i> ~${tokens} tokens</div>
                <div class="char-dup-card-meta-item gallery-count-item" id="${galleryCountId}" data-avatar="${escapeHtml(char.avatar)}" title="Gallery images"><i class="fa-solid fa-images"></i> <span class="gallery-count-value">...</span></div>
            </div>
            <div class="char-dup-card-actions">
                <button class="action-btn secondary small dup-view-btn">
                    <i class="fa-solid fa-eye"></i> View
                </button>
                <button class="action-btn danger-hover small dup-delete-btn">
                    <i class="fa-solid fa-trash"></i> Delete
                </button>
            </div>
        </div>
    `;
}

function getCharDateMs(char) {
    if (char.date_added) return Number(char.date_added);
    if (char.create_date) return new Date(char.create_date).getTime();
    return 0;
}

/**
 * Render duplicate groups in the modal
 */
async function renderDuplicateGroups(groups) {
    const modalEl = document.getElementById('charDuplicatesModal');
    if (!modalEl?.classList.contains('visible')) return; // closed while results were being prepared
    const resultsEl = document.getElementById('charDuplicatesResults');
    const statusEl = document.getElementById('charDuplicatesScanStatus');
    
    if (groups.length === 0) {
        statusEl.innerHTML = '<i class="fa-solid fa-check-circle"></i> No duplicates found in your library!';
        statusEl.className = 'char-duplicates-status no-results';
        resultsEl.innerHTML = '';
        return;
    }
    
    // Hydrate all chars involved in duplicate groups so diff fields are available
    const charsToHydrate = new Set();
    for (const group of groups) {
        charsToHydrate.add(group.reference);
        for (const dup of group.duplicates) charsToHydrate.add(dup.char);
    }
    await Promise.all([...charsToHydrate].map(c => hydrateCharacter(c)));
    
    let totalDuplicates = groups.reduce((sum, g) => sum + g.duplicates.length, 0);
    const isExactMode = (getSetting('duplicateMinScore') || 35) >= 120;
    statusEl.innerHTML = `<i class="fa-solid fa-exclamation-triangle"></i> Found ${totalDuplicates} potential duplicate(s) in ${groups.length} group(s)`
;
    statusEl.className = 'char-duplicates-status complete';
    
    let html = '';
    
    groups.forEach((group, idx) => {
        const ref = group.reference;
        const refName = getCharField(ref, 'name') || 'Unknown';
        const refAvatar = getCharacterAvatarStThumbUrl(ref.avatar);
        const maxScore = Math.max(...group.duplicates.map(d => d.score || 0));
        
        // Pre-compute content identity for each duplicate to inform the header
        const dupResults = [];
        let allContentIdentical = true;
        let allStrictIdentical = group.duplicates.every(d => d.strictIdentical === true);

        group.duplicates.forEach((dup, dupIdx) => {
            const dupChar = dup.char;
            const diffs = compareCharacterDifferences(ref, dupChar);

            const descDiff = renderFieldDiff('Description', 
                getCharField(ref, 'description'), 
                getCharField(dupChar, 'description'));
            const persDiff = renderFieldDiff('Personality', 
                getCharField(ref, 'personality'), 
                getCharField(dupChar, 'personality'));
            const firstMesDiff = renderFieldDiff('First Message', 
                getCharField(ref, 'first_mes'), 
                getCharField(dupChar, 'first_mes'));
            const scenarioDiff = renderFieldDiff('Scenario', 
                getCharField(ref, 'scenario'), 
                getCharField(dupChar, 'scenario'));
            const mesExampleDiff = renderFieldDiff('Example Messages', 
                getCharField(ref, 'mes_example'), 
                getCharField(dupChar, 'mes_example'));
            const systemPromptDiff = renderFieldDiff('System Prompt', 
                getCharField(ref, 'system_prompt'), 
                getCharField(dupChar, 'system_prompt'));
            const creatorNotesDiff = renderFieldDiff('Creator Notes', 
                getCharField(ref, 'creator_notes'), 
                getCharField(dupChar, 'creator_notes'));
            const tagsDiff = renderTagsDiff(
                getTags(ref), 
                getTags(dupChar));

            const allDiffs = [descDiff, persDiff, scenarioDiff, firstMesDiff, mesExampleDiff, systemPromptDiff, creatorNotesDiff, tagsDiff];
            const identicalCount = allDiffs.filter(d => d.isSame && !d.isEmpty).length;
            const differentCount = allDiffs.filter(d => !d.isSame && !d.isEmpty).length;
            const isContentIdentical = differentCount === 0 && identicalCount > 0;

            if (!isContentIdentical) allContentIdentical = false;

            dupResults.push({ dup, dupIdx, dupChar, diffs, allDiffs, identicalCount, differentCount, isContentIdentical });
        });

        const headerLabel = getDuplicateScoreLabel(maxScore, allStrictIdentical);
        
        html += `
            <div class="char-dup-group" id="dup-group-${idx}">
                <div class="char-dup-group-header">
                    <i class="fa-solid fa-chevron-right char-dup-group-toggle"></i>
                    <img class="char-dup-group-avatar" src="${refAvatar}" alt="${escapeHtml(refName)}" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><rect fill=%22%23333%22 width=%22100%22 height=%22100%22/><text x=%2250%22 y=%2255%22 text-anchor=%22middle%22 fill=%22%23666%22 font-size=%2240%22>?</text></svg>'">
                    <div class="char-dup-group-info">
                        <div class="char-dup-group-name">${escapeHtml(refName)}</div>
                        <div class="char-dup-group-meta">
                            <span>${group.duplicates.length} potential duplicate(s)</span>
                            <span style="opacity: 0.7;">\u2022 ${headerLabel}</span>
                        </div>
                    </div>
                    <div class="char-dup-group-confidence ${group.confidence}">${group.confidence}</div>
                </div>
                <div class="char-dup-group-content">
        `;
        
        // Render comparison for each duplicate
        for (const { dup, dupIdx, dupChar, diffs, allDiffs, identicalCount, differentCount, isContentIdentical } of dupResults) {
            const identicalFields = allDiffs.filter(d => d.isSame && !d.isEmpty).map(d => d.html).join('');
            const differentFields = allDiffs.filter(d => !d.isSame && !d.isEmpty).map(d => d.html).join('');

            // Build score breakdown display
            let scoreBreakdown = '';
            if (dup.breakdown) {
                const parts = [];
                if (dup.breakdown.name) parts.push(`Name: ${dup.breakdown.name}`);
                if (dup.breakdown.creator) parts.push(`Creator: ${dup.breakdown.creator}`);
                if (dup.breakdown.creator_notes) parts.push(`Notes: ${dup.breakdown.creator_notes}`);
                if (dup.breakdown.description) parts.push(`Desc: ${dup.breakdown.description}`);
                if (dup.breakdown.first_mes) parts.push(`1st Msg: ${dup.breakdown.first_mes}`);
                if (dup.breakdown.personality) parts.push(`Pers: ${dup.breakdown.personality}`);
                if (dup.breakdown.scenario) parts.push(`Scen: ${dup.breakdown.scenario}`);
                if (dup.breakdown.divergence) parts.push(`Divergence: ${dup.breakdown.divergence}`);
                if (parts.length > 0) {
                    scoreBreakdown = `<div class="match-breakdown">${parts.join(' \u2022 ')}</div>`;
                }
            }

            const scoreLabel = getDuplicateScoreLabel(dup.score || 0, dup.strictIdentical === true);
            
            const wsNormalizedCount = allDiffs.filter(d => d.normalizedAway).length;
            
            // Build the diff summary message when all content is identical
            let diffSummary = '';
            if (differentCount === 0 && identicalCount > 0) {
                // All content is identical - explain what differs (file/metadata)
                const refAvatar = ref.avatar || '';
                const dupAvatar = dupChar.avatar || '';
                const refDate = ref.date_added ? new Date(Number(ref.date_added)) : (ref.create_date ? new Date(ref.create_date) : null);
                const dupDate = dupChar.date_added ? new Date(Number(dupChar.date_added)) : (dupChar.create_date ? new Date(dupChar.create_date) : null);
                
                const metaDiffs = [];
                if (refAvatar !== dupAvatar) {
                    metaDiffs.push(`<div class="meta-diff-item"><i class="fa-solid fa-file-image"></i> <strong>Different files:</strong> <code>${escapeHtml(refAvatar)}</code> vs <code>${escapeHtml(dupAvatar)}</code></div>`);
                }
                if (refDate && dupDate && refDate.getTime() !== dupDate.getTime()) {
                    const formatDate = (d) => d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
                    metaDiffs.push(`<div class="meta-diff-item"><i class="fa-solid fa-calendar"></i> <strong>Added:</strong> ${formatDate(refDate)} vs ${formatDate(dupDate)}</div>`);
                }
                
                // Note about whitespace differences
                const wsNote = wsNormalizedCount > 0 
                    ? `<div class="ws-diff-note"><i class="fa-solid fa-asterisk"></i> ${wsNormalizedCount} field${wsNormalizedCount !== 1 ? 's have' : ' has'} minor whitespace differences (extra spaces, line endings)</div>` 
                    : '';
                
                diffSummary = `
                    <div class="char-dup-identical-notice">
                        <div class="identical-notice-header">
                            <i class="fa-solid fa-clone"></i>
                            <strong>Content Identical</strong> — These are duplicate files with the same character data
                        </div>
                        ${wsNote}
                        ${metaDiffs.length > 0 ? `<div class="meta-diffs">${metaDiffs.join('')}</div>` : ''}
                        <div class="identical-notice-hint">
                            <i class="fa-solid fa-lightbulb"></i>
                            You can safely delete one. Check chat sessions and gallery images before deciding which to keep.
                        </div>
                    </div>
                `;
            }
            
            html += `
                <div class="char-dup-comparison" data-dup-idx="${dupIdx}">
                    ${renderCharDupCard(ref, 'reference')}
                    <div class="char-dup-divider">
                        <i class="fa-solid fa-arrows-left-right"></i>
                        <div class="char-dup-group-confidence ${dup.confidence} match-score" title="${dup.score || 0} pts">
                            ${scoreLabel}
                        </div>
                        <div class="match-reason">
                            ${dup.matchReason}
                        </div>
                        ${scoreBreakdown}
                    </div>
                    ${renderCharDupCard(dupChar, 'duplicate', dupIdx, diffs)}
                </div>
                ${diffSummary}
                ${differentFields ? `
                    <div class="char-dup-diff-container">
                        <div class="char-dup-diff differs">
                            <details open>
                                <summary>
                                    <i class="fa-solid fa-triangle-exclamation"></i> 
                                    Different Fields
                                    <span class="diff-count">${differentCount}</span>
                                </summary>
                                ${differentFields}
                            </details>
                        </div>
                    </div>
                ` : ''}
                ${identicalFields && differentCount > 0 ? `
                    <div class="char-dup-diff-container">
                        <div class="char-dup-diff identical">
                            <details>
                                <summary>
                                    <i class="fa-solid fa-check-circle"></i> 
                                    Identical Fields
                                    <span class="diff-count">${identicalCount}</span>
                                </summary>
                                ${identicalFields}
                            </details>
                        </div>
                    </div>
                ` : ''}
            `;
        }
        
        html += `
                </div>
            </div>
        `;
    });
    
    resultsEl.innerHTML = html;
    
    // Load gallery and chat counts asynchronously after rendering
    loadDuplicateGalleryCounts(groups);
}

/**
 * Open the gallery viewer for a character from the duplicate scanner
 * @param {HTMLElement} el - The clicked gallery-count-item element
 */
async function viewDupCharGallery(el) {
    const avatar = el?.dataset?.avatar;
    if (!avatar) return;

    const char = allCharacters.find(c => c.avatar === avatar);
    if (!char) {
        showToast('Character not found', 'error');
        return;
    }

    const countValue = el.querySelector('.gallery-count-value');
    const count = parseInt(countValue?.textContent, 10);
    if (!count || count <= 0) {
        showToast('No gallery images for this character', 'info');
        return;
    }

    try {
        const info = await getCharacterGalleryInfo(char);
        if (!info.files || info.files.length === 0) {
            showToast('No gallery images found', 'info');
            return;
        }

        const images = buildGalleryViewerMedia(info.files, info.folder);
        if (!images.length) {
            showToast('No viewable media found', 'info');
            return;
        }

        if (window.openGalleryViewerWithImages) {
            window.openGalleryViewerWithImages(images, 0, char.name || 'Gallery', info.folder);
        } else {
            showToast('Gallery viewer not available', 'error');
        }
    } catch (err) {
        console.error('[Duplicates] Error opening gallery:', err);
        showToast('Failed to load gallery', 'error');
    }
}


// Detail-modal hero avatar -> gallery viewer; avatar is image 0, then the char's viewable gallery media (images + videos, no audio) via the shared builder so it matches the gallery tab.
async function openAvatarInGalleryViewer(char) {
    if (!char || !window.openGalleryViewerWithImages) return;
    const images = [{ name: char.name || 'Avatar', url: getCharacterAvatarUrl(char.avatar), type: 'image' }];
    let folder = null;
    try {
        const info = await getCharacterGalleryInfo(char);
        folder = info.folder || null;
        images.push(...buildGalleryViewerMedia(info.files, info.folder));
    } catch (e) {
        debugLog('[AvatarViewer] gallery fetch failed, showing avatar only:', e);
    }
    window.openGalleryViewerWithImages(images, 0, char.name || 'Gallery', folder);
}

/**
 * Load and display gallery image counts for all characters in duplicate groups
 * @param {Array} groups - The duplicate groups
 */
async function loadDuplicateGalleryCounts(groups) {
    const characters = new Map();
    
    groups.forEach(group => {
        characters.set(group.reference.avatar, group.reference);
        group.duplicates.forEach(dup => {
            characters.set(dup.char.avatar, dup.char);
        });
    });
    
    // Load counts in parallel with a limit to avoid overloading
    const BATCH_SIZE = 5;
    const avatars = Array.from(characters.keys());
    
    for (let i = 0; i < avatars.length; i += BATCH_SIZE) {
        const batch = avatars.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(async (avatar) => {
            const char = characters.get(avatar);
            try {
                const galleryInfo = await getCharacterGalleryInfo(char);
                const countEl = document.getElementById(`gallery-count-${avatar.replace(/[^a-zA-Z0-9]/g, '_')}`);
                if (countEl) {
                    const countValue = countEl.querySelector('.gallery-count-value');
                    if (countValue) {
                        countValue.textContent = galleryInfo.count.toString();
                        // Highlight if has images (yellow for warning about deletion)
                        if (galleryInfo.count > 0) {
                            countEl.classList.add('has-images');
                            countEl.title = `${galleryInfo.count} gallery image${galleryInfo.count !== 1 ? 's' : ''} - will be deleted if character is removed`;
                        } else {
                            countEl.title = 'No gallery images';
                        }
                    }
                }
            } catch (e) {
                debugLog(`[Gallery] Error loading count for ${avatar}:`, e);
            }
        }));
    }
}

/**
 * Toggle duplicate group expansion
 */
function toggleDupGroup(idx) {
    const group = document.getElementById(`dup-group-${idx}`);
    if (group) {
        const wasExpanded = group.classList.contains('expanded');
        group.classList.toggle('expanded');
        
        // Track expanded state for restoration
        if (wasExpanded) {
            duplicateModalState.expandedGroups.delete(idx);
        } else {
            duplicateModalState.expandedGroups.add(idx);
        }
    }
}

/**
 * Save current duplicate modal state for restoration
 */
function saveDuplicateModalState() {
    const modal = document.getElementById('charDuplicatesModal');
    const resultsEl = document.getElementById('charDuplicatesResults');

    duplicateModalState.wasOpen = modal && modal.classList.contains('visible');
    duplicateModalState.scrollPosition = resultsEl ? resultsEl.scrollTop : 0;
    
    // Track which groups are expanded
    duplicateModalState.expandedGroups = new Set();
    document.querySelectorAll('.char-dup-group.expanded').forEach(el => {
        const match = el.id.match(/dup-group-(\d+)/);
        if (match) duplicateModalState.expandedGroups.add(parseInt(match[1]));
    });
}

/**
 * Restore duplicate modal state after viewing a card
 */
function restoreDuplicateModalState() {
    if (!duplicateModalState.wasOpen) return;
    
    const modal = document.getElementById('charDuplicatesModal');
    const resultsEl = document.getElementById('charDuplicatesResults');

    modal.classList.add('visible');
    
    // Restore expanded groups
    duplicateModalState.expandedGroups.forEach(idx => {
        const group = document.getElementById(`dup-group-${idx}`);
        if (group) group.classList.add('expanded');
    });
    
    // Restore scroll position
    if (resultsEl) {
        setTimeout(() => {
            resultsEl.scrollTop = duplicateModalState.scrollPosition;
        }, 50);
    }
}

/**
 * View a character from the duplicates modal
 * Hides duplicates modal, shows character modal, and allows returning
 */
function viewCharFromDuplicates(avatar) {
    const char = allCharacters.find(c => c.avatar === avatar);
    if (!char) return;
    
    saveDuplicateModalState();
    
    // Hide duplicates modal
    document.getElementById('charDuplicatesModal').classList.remove('visible');
    
    // Open character modal
    openModal(char);
}

/**
 * Delete a duplicate character with option to transfer gallery images
 */
async function deleteDuplicateChar(avatar) {
    const char = allCharacters.find(c => c.avatar === avatar);
    if (!char) return;
    
    const name = getCharField(char, 'name') || avatar;
    const avatarPath = getCharacterAvatarUrl(avatar);
    
    // Get gallery info for this character (hydrate first if extensions arent recovered yet)
    if (window.extensionsRecoveryInProgress) {
        try { await hydrateCharacter(char); } catch (_) {}
    }
    const galleryInfo = await getCharacterGalleryInfo(char);
    const hasImages = galleryInfo.count > 0;

    // Only offer gallery deletion/transfer for unique galleries (with gallery_id)
    // Shared galleries should NOT be modified as they may contain other characters' images
    const hasUniqueGallery = !!getCharacterGalleryId(char);
    
    // Match by identity, not index: the rendered list is min-score-filtered, so an index into the unfiltered cache mis-points.
    const currentGroup = duplicateScanCache.groups?.find(g =>
        g.reference?.avatar === avatar || g.duplicates?.some(d => d.char?.avatar === avatar)
    );
    const transferTargets = [];

    if (currentGroup) {
        const minScore = getSetting('duplicateMinScore') || 35;
        const exactMode = minScore >= 120;
        // Reference anchors the group; always a valid target.
        if (currentGroup.reference.avatar !== avatar) {
            transferTargets.push(currentGroup.reference);
        }
        // Match the rendered group's filter so a target is never a low-score match the user never saw.
        currentGroup.duplicates.forEach(d => {
            if (d.char.avatar !== avatar && dupePassesMinScore(d, minScore, exactMode)) {
                transferTargets.push(d.char);
            }
        });
    }
    
    // Create enhanced delete confirmation modal
    const deleteModal = document.createElement('div');
    deleteModal.className = 'confirm-modal cl-modal-drawer';
    deleteModal.id = 'deleteDuplicateModal';
    
    // Only allow gallery modification when:
    // 1. Unique gallery folders feature is ENABLED
    // 2. Character has a gallery_id (unique gallery)
    const uniqueFoldersEnabled = getSetting('uniqueGalleryFolders') || false;
    const canModifyGallery = uniqueFoldersEnabled && hasUniqueGallery;
    
    // Build transfer targets HTML with more details
    let transferTargetsHtml = '';
    if (hasImages && canModifyGallery && transferTargets.length > 0) {
        // Has unique gallery AND transfer targets - show all options
        transferTargetsHtml = `
            <div class="dup-delete-transfer-section">
                <div class="dup-delete-transfer-header">
                    <i class="fa-solid fa-images"></i>
                    <strong>Gallery Contains ${galleryInfo.count} File${galleryInfo.count !== 1 ? 's' : ''}</strong>
                </div>
                <div class="dup-delete-image-options">
                    <label class="dup-delete-option-radio selected" data-action="transfer">
                        <input type="radio" name="imageAction" value="transfer" checked>
                        <div class="option-content">
                            <i class="fa-solid fa-arrow-right-arrow-left"></i>
                            <div class="option-text">
                                <strong>Transfer images</strong>
                                <span>Move to another character's gallery</span>
                            </div>
                        </div>
                    </label>
                    <label class="dup-delete-option-radio" data-action="delete">
                        <input type="radio" name="imageAction" value="delete">
                        <div class="option-content">
                            <i class="fa-solid fa-trash-can"></i>
                            <div class="option-text">
                                <strong>Delete images</strong>
                                <span>Permanently remove all gallery images</span>
                            </div>
                        </div>
                    </label>
                    <label class="dup-delete-option-radio" data-action="keep">
                        <input type="radio" name="imageAction" value="keep">
                        <div class="option-content">
                            <i class="fa-solid fa-folder-open"></i>
                            <div class="option-text">
                                <strong>Keep images</strong>
                                <span>Leave in folder (can reassign later)</span>
                            </div>
                        </div>
                    </label>
                </div>
                <div class="dup-delete-transfer-target" id="transferTargetWrapper">
                    <label>Transfer to:</label>
                    <div class="dup-delete-transfer-select-wrapper">
                        ${transferTargets.map((t, idx) => {
                            const tName = getCharField(t, 'name') || t.avatar;
                            const tAvatar = getCharacterAvatarStThumbUrl(t.avatar);
                            return `
                                <label class="dup-delete-transfer-radio ${idx === 0 ? 'selected' : ''}" data-avatar="${escapeHtml(t.avatar)}">
                                    <input type="radio" name="transferTarget" value="${escapeHtml(t.avatar)}" ${idx === 0 ? 'checked' : ''}>
                                    <img src="${tAvatar}" onerror="this.src='/img/ai4.png'" alt="">
                                    <span>${escapeHtml(tName)}</span>
                                </label>
                            `;
                        }).join('')}
                    </div>
                </div>
            </div>
        `;
    } else if (hasImages && canModifyGallery) {
        // Has unique gallery but no transfer targets - show delete/keep options
        transferTargetsHtml = `
            <div class="dup-delete-transfer-section warning-only">
                <div class="dup-delete-transfer-header">
                    <i class="fa-solid fa-images"></i>
                    <strong>Gallery Contains ${galleryInfo.count} File${galleryInfo.count !== 1 ? 's' : ''}</strong>
                </div>
                <div class="dup-delete-image-options">
                    <label class="dup-delete-option-radio selected" data-action="keep">
                        <input type="radio" name="imageAction" value="keep" checked>
                        <div class="option-content">
                            <i class="fa-solid fa-folder-open"></i>
                            <div class="option-text">
                                <strong>Keep images</strong>
                                <span>Leave in folder (can reassign later)</span>
                            </div>
                        </div>
                    </label>
                    <label class="dup-delete-option-radio" data-action="delete">
                        <input type="radio" name="imageAction" value="delete">
                        <div class="option-content">
                            <i class="fa-solid fa-trash-can"></i>
                            <div class="option-text">
                                <strong>Delete images</strong>
                                <span>Permanently remove all gallery images</span>
                            </div>
                        </div>
                    </label>
                </div>
            </div>
        `;
    } else if (hasImages) {
        // Shared/unmanaged gallery - just show info, no delete option
        const reason = !uniqueFoldersEnabled 
            ? 'Unique gallery folders feature is disabled.'
            : "This character doesn't have a unique gallery ID.";
        transferTargetsHtml = `
            <div class="dup-delete-transfer-section warning-only">
                <div class="dup-delete-transfer-header">
                    <i class="fa-solid fa-images"></i>
                    <strong>Gallery Contains ${galleryInfo.count} File${galleryInfo.count !== 1 ? 's' : ''}</strong>
                </div>
                <div class="dup-delete-shared-warning">
                    <i class="fa-solid fa-info-circle"></i>
                    <span>${reason} Gallery files will not be deleted.</span>
                </div>
            </div>
        `;
    }
    
    deleteModal.innerHTML = `
        <div class="confirm-modal-content dup-delete-modal-content">
            <div class="confirm-modal-header dup-delete-header">
                <h3>
                    <i class="fa-solid fa-trash"></i>
                    Delete Character
                </h3>
                <button class="close-confirm-btn" id="closeDuplicateDeleteModal">&times;</button>
            </div>
            <div class="confirm-modal-body">
                <div class="dup-delete-char-info">
                    <img src="${avatarPath}" 
                         alt="${escapeHtml(name)}" 
                         class="dup-delete-avatar"
                         onerror="this.src='/img/ai4.png'">
                    <div class="dup-delete-char-details">
                        <h4>${escapeHtml(name)}</h4>
                        <p>by ${escapeHtml(getCharField(char, 'creator') || 'Unknown')}</p>
                    </div>
                </div>
                
                ${transferTargetsHtml}
                
                <p class="dup-delete-confirm-text">
                    <i class="fa-solid fa-exclamation-circle"></i>
                    Are you sure you want to delete this character? This cannot be undone.
                </p>
            </div>
            <div class="confirm-modal-footer">
                <button class="action-btn secondary" id="cancelDuplicateDeleteBtn">
                    <i class="fa-solid fa-xmark"></i> Cancel
                </button>
                <button class="action-btn danger" id="confirmDuplicateDeleteBtn">
                    <i class="fa-solid fa-trash"></i> Delete
                </button>
            </div>
        </div>
    `;
    
    document.body.appendChild(deleteModal);
    
    // Setup event handlers
    const closeModal = () => deleteModal.remove();
    
    deleteModal.querySelector('#closeDuplicateDeleteModal').addEventListener('click', closeModal);
    deleteModal.querySelector('#cancelDuplicateDeleteBtn').addEventListener('click', closeModal);
    deleteModal.addEventListener('click', (e) => {
        if (e.target === deleteModal) closeModal();
    });
    
    // Image action radio button handling
    const confirmBtn = deleteModal.querySelector('#confirmDuplicateDeleteBtn');
    const transferTargetWrapper = deleteModal.querySelector('#transferTargetWrapper');
    
    const updateButtonText = () => {
        const selectedAction = deleteModal.querySelector('input[name="imageAction"]:checked')?.value;
        if (selectedAction === 'transfer') {
            confirmBtn.innerHTML = '<i class="fa-solid fa-trash"></i> Delete & Transfer';
        } else if (selectedAction === 'delete') {
            confirmBtn.innerHTML = '<i class="fa-solid fa-trash"></i> Delete All';
        } else {
            confirmBtn.innerHTML = '<i class="fa-solid fa-trash"></i> Delete';
        }
    };
    
    deleteModal.querySelectorAll('.dup-delete-option-radio').forEach(option => {
        option.addEventListener('click', () => {
            deleteModal.querySelectorAll('.dup-delete-option-radio').forEach(o => o.classList.remove('selected'));
            option.classList.add('selected');
            option.querySelector('input').checked = true;
            
            // Show/hide transfer target selector
            if (transferTargetWrapper) {
                transferTargetWrapper.style.display = option.dataset.action === 'transfer' ? 'block' : 'none';
            }
            updateButtonText();
        });
    });
    
    updateButtonText();

    // Radio button selection styling for transfer targets
    deleteModal.querySelectorAll('.dup-delete-transfer-radio').forEach(radio => {
        radio.addEventListener('click', () => {
            deleteModal.querySelectorAll('.dup-delete-transfer-radio').forEach(r => r.classList.remove('selected'));
            radio.classList.add('selected');
            radio.querySelector('input').checked = true;
        });
    });
    
    // Handle delete confirmation
    deleteModal.querySelector('#confirmDuplicateDeleteBtn').addEventListener('click', async () => {
        confirmBtn.disabled = true;
        confirmBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Processing...';
        
        const imageAction = deleteModal.querySelector('input[name="imageAction"]:checked')?.value || 'keep';
        
        // Handle images based on selected action (only possible for unique galleries)
        if (hasUniqueGallery && imageAction === 'transfer') {
            // Transfer images to selected target
            const selectedRadio = deleteModal.querySelector('input[name="transferTarget"]:checked');
            if (selectedRadio?.value) {
                const targetAvatar = selectedRadio.value;
                const targetChar = allCharacters.find(c => c.avatar === targetAvatar);
                
                if (targetChar) {
                    const targetFolder = getGalleryFolderName(targetChar);
                    let transferred = 0;
                    let errors = 0;
                    
                    confirmBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Transferring images...`;
                    
                    for (const fileName of galleryInfo.files) {
                        const result = await moveImageToFolder(galleryInfo.folder, targetFolder, fileName, true);
                        if (result.success) {
                            transferred++;
                        } else {
                            errors++;
                            debugLog(`[Transfer] Failed to transfer ${fileName}: ${result.error}`);
                        }
                    }
                    
                    if (transferred > 0) {
                        showToast(`Transferred ${transferred} image${transferred !== 1 ? 's' : ''} to ${getCharField(targetChar, 'name')}`, 'success');
                    }
                    if (errors > 0) {
                        showToast(`Failed to transfer ${errors} image${errors !== 1 ? 's' : ''}`, 'error');
                    }
                }
            }
        } else if (hasUniqueGallery && imageAction === 'delete') {
            // Delete all gallery images (only for unique galleries)
            confirmBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Deleting images...`;
            let deleted = 0;
            let errors = 0;
            
            const safeFolderName = sanitizeFolderName(galleryInfo.folder);
            for (const fileName of galleryInfo.files) {
                try {
                    const deletePath = `/user/images/${safeFolderName}/${fileName}`;
                    const response = await apiRequest(ENDPOINTS.IMAGES_DELETE, 'POST', {
                        path: deletePath
                    });
                    await response.text().catch(() => {});
                    if (response.ok) {
                        deleted++;
                    } else {
                        errors++;
                        debugLog(`[Delete] Failed to delete ${fileName}: ${response.status}`);
                    }
                } catch (e) {
                    errors++;
                    debugLog(`[Delete] Failed to delete ${fileName}:`, e);
                }
            }
            
            if (deleted > 0) {
                showToast(`Deleted ${deleted} image${deleted !== 1 ? 's' : ''}`, 'info');
                cleanupThumbCache(safeFolderName);
            }
            if (errors > 0) {
                showToast(`Failed to delete ${errors} image${errors !== 1 ? 's' : ''}`, 'error');
            }
        }
        // If imageAction === 'keep', do nothing with images
        
        confirmBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Deleting...';
        
        // Use the main deleteCharacter function which handles ST sync
        const success = await deleteCharacter(char, false);
        
        if (success) {
            showToast(`Deleted "${name}"`, 'success');
            closeModal();
            
            // Invalidate cache
            duplicateScanCache.timestamp = 0;
            
            // Refresh the gallery
            await fetchCharacters(true);
            
            // Re-run duplicate scan with new data
            const groups = await findCharacterDuplicates(true);
            if (groups) await renderDuplicateGroups(groups);
        } else {
            showToast(`Failed to delete "${name}"`, 'error');
            confirmBtn.disabled = false;
            confirmBtn.innerHTML = '<i class="fa-solid fa-trash"></i> Delete';
        }
    });
}

/**
 * Open the character duplicates scanner modal
 */
async function openCharDuplicatesModal(useCache = true) {
    const modal = document.getElementById('charDuplicatesModal');
    const statusEl = document.getElementById('charDuplicatesScanStatus');
    const resultsEl = document.getElementById('charDuplicatesResults');
    
    // Reset state
    statusEl.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Scanning library for duplicates...';
    statusEl.className = 'char-duplicates-status';
    resultsEl.innerHTML = '';

    modal.classList.add('visible');
    
    // Run scan (async)
    await new Promise(r => setTimeout(r, 50)); // Let modal render
    const groups = await findCharacterDuplicates(!useCache);
    if (!groups) return; // scan cancelled by closing the modal
    await renderDuplicateGroups(groups);
}

/**
 * Close the duplicates modal; a scan still in flight gets a cancel confirm first.
 */
async function closeCharDuplicatesModal() {
    if (_dupScanActive) {
        const cancelScan = await showConfirm({
            title: 'Cancel duplicate scan?',
            message: 'The scan is still running. Close the window and cancel it?',
            icon: 'fa-solid fa-clone',
            confirmLabel: 'Cancel Scan',
            cancelLabel: 'Keep Scanning',
        });
        if (!cancelScan) return;
        // The scan may have finished while the prompt was open
        if (_dupScanActive) {
            _dupScanGen++;
            _dupScanActive = false;
            showToast('Duplicate scan cancelled', 'info');
        }
    }
    hideModal('charDuplicatesModal');
}

// Character Duplicates Modal Event Listeners
on('checkDuplicatesBtn', 'click', () => openCharDuplicatesModal());

document.getElementById('charDuplicatesResults')?.addEventListener('click', (e) => {
    const header = e.target.closest('.char-dup-group-header');
    if (header) {
        const group = header.closest('.char-dup-group');
        const idx = parseInt(group?.id?.replace('dup-group-', ''));
        if (!isNaN(idx)) toggleDupGroup(idx);
        return;
    }

    const galleryItem = e.target.closest('.gallery-count-item');
    if (galleryItem) { viewDupCharGallery(galleryItem); return; }

    const card = e.target.closest('.char-dup-card');
    if (!card) return;
    const avatar = card.dataset.avatar;
    if (!avatar) return;

    if (e.target.closest('.dup-view-btn')) { viewCharFromDuplicates(avatar); return; }

    const deleteBtn = e.target.closest('.dup-delete-btn');
    if (deleteBtn) {
        deleteDuplicateChar(avatar);
    }
});

on('closeCharDuplicatesModal', 'click', () => closeCharDuplicatesModal());

on('closeCharDuplicatesModalBtn', 'click', () => closeCharDuplicatesModal());

