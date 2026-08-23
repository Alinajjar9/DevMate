"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_PROJECT_SEARCH_QUERY_BOOST = exports.RECIPROCAL_RANK_FUSION_CONSTANT = void 0;
exports.rankProjectSearchResults = rankProjectSearchResults;
exports.fuseProjectSearchResults = fuseProjectSearchResults;
exports.RECIPROCAL_RANK_FUSION_CONSTANT = 60;
exports.MAX_PROJECT_SEARCH_QUERY_BOOST = 0.01;
const MAX_FILENAME_BOOST = 0.004;
const MAX_PATH_BOOST = 0.0015;
const MAX_IDENTIFIER_BOOST = 0.006;
const IDENTIFIER_PATTERN = /[A-Za-z_$][A-Za-z0-9_$]*/g;
const QUERY_STOP_WORDS = new Set([
    'and', 'are', 'can', 'class', 'code', 'defined', 'does', 'file', 'find',
    'for', 'from', 'function', 'how', 'implementation', 'implemented', 'implements',
    'into', 'module', 'that', 'the', 'this', 'what', 'when', 'where', 'which',
    'with'
]);
function rankProjectSearchResults(lexicalResults, semanticResults, query, limit) {
    const entries = mergeRankings(lexicalResults, semanticResults);
    const signals = collectQuerySignals(query);
    return selectResults(entries, limit, (result) => querySignalBoost(result, signals));
}
function fuseProjectSearchResults(lexicalResults, semanticResults, limit) {
    return selectResults(mergeRankings(lexicalResults, semanticResults), limit, () => 0);
}
function mergeRankings(lexicalResults, semanticResults) {
    const entries = new Map();
    const addRanking = (results) => {
        const seen = new Set();
        for (let index = 0; index < results.length; index += 1) {
            const result = results[index];
            const key = searchResultKey(result);
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            const rank = index + 1;
            const contribution = 1 / (exports.RECIPROCAL_RANK_FUSION_CONSTANT + rank);
            const existing = entries.get(key);
            if (existing) {
                existing.score += contribution;
                existing.bestRank = Math.min(existing.bestRank, rank);
                existing.sourceCount += 1;
            }
            else {
                entries.set(key, {
                    result,
                    score: contribution,
                    bestRank: rank,
                    sourceCount: 1
                });
            }
        }
    };
    addRanking(lexicalResults);
    addRanking(semanticResults);
    return [...entries.values()];
}
function selectResults(entries, limit, boost) {
    const boundedLimit = Number.isFinite(limit)
        ? Math.max(0, Math.floor(limit))
        : 0;
    if (boundedLimit === 0) {
        return [];
    }
    return entries
        .map((entry) => ({ ...entry, adjustedScore: entry.score + boost(entry.result) }))
        .sort((left, right) => (right.adjustedScore - left.adjustedScore
        || right.sourceCount - left.sourceCount
        || right.score - left.score
        || left.bestRank - right.bestRank
        || compareSearchResults(left.result, right.result)))
        .slice(0, boundedLimit)
        .map((entry) => ({ ...entry.result, score: entry.adjustedScore }));
}
function collectQuerySignals(query) {
    const queryTokens = (query.match(IDENTIFIER_PATTERN) ?? [])
        .filter(isSignificantQueryToken);
    return {
        compact: normalizeCompact(query),
        identifiers: [...new Set(queryTokens.filter(isCodeLikeIdentifier))],
        terms: new Set(queryTokens.flatMap(splitTerms).filter(isSignificantTerm))
    };
}
function querySignalBoost(result, signals) {
    if (signals.identifiers.length === 0 && signals.terms.size === 0) {
        return 0;
    }
    const normalizedPath = result.relativePath.replace(/\\/g, '/');
    const pathParts = normalizedPath.split('/');
    const filename = pathParts.at(-1) ?? normalizedPath;
    const extensionIndex = filename.lastIndexOf('.');
    const stem = extensionIndex > 0 ? filename.slice(0, extensionIndex) : filename;
    const filenameTerms = [...new Set(splitTerms(stem).filter(isSignificantTerm))];
    const pathTerms = [...new Set(splitTerms(normalizedPath).filter(isSignificantTerm))];
    const normalizedStem = normalizeCompact(stem);
    const exactFilenameMatch = normalizedStem.length >= 3
        && signals.compact.includes(normalizedStem);
    const filenameCoverage = termCoverage(filenameTerms, signals.terms);
    const filenameBoost = exactFilenameMatch
        ? MAX_FILENAME_BOOST
        : MAX_FILENAME_BOOST * filenameCoverage;
    const pathMatches = pathTerms.filter((term) => signals.terms.has(term)).length;
    const pathDenominator = Math.min(3, Math.max(1, signals.terms.size));
    const pathBoost = MAX_PATH_BOOST * Math.min(1, pathMatches / pathDenominator);
    const contentIdentifiers = new Set(result.content.match(IDENTIFIER_PATTERN) ?? []);
    const exactIdentifierMatch = signals.identifiers.some((identifier) => contentIdentifiers.has(identifier));
    const contentIdentifiersLower = exactIdentifierMatch
        ? undefined
        : new Set([...contentIdentifiers].map((identifier) => identifier.toLocaleLowerCase('en-US')));
    const caseInsensitiveIdentifierMatch = contentIdentifiersLower !== undefined
        && signals.identifiers.some((identifier) => contentIdentifiersLower.has(identifier.toLocaleLowerCase('en-US')));
    const identifierBoost = exactIdentifierMatch
        ? MAX_IDENTIFIER_BOOST
        : caseInsensitiveIdentifierMatch
            ? MAX_IDENTIFIER_BOOST * 0.5
            : 0;
    return Math.min(exports.MAX_PROJECT_SEARCH_QUERY_BOOST, filenameBoost + pathBoost + identifierBoost);
}
function isSignificantQueryToken(token) {
    return token.length >= 3
        && !QUERY_STOP_WORDS.has(token.toLocaleLowerCase('en-US'));
}
function isCodeLikeIdentifier(token) {
    return /[_$]/.test(token)
        || /[a-z0-9][A-Z]/.test(token)
        || /[A-Z].*[A-Z]/.test(token)
        || /\d/.test(token);
}
function isSignificantTerm(term) {
    return term.length >= 3 && !QUERY_STOP_WORDS.has(term);
}
function splitTerms(value) {
    return value
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .split(/[^A-Za-z0-9]+/)
        .map((term) => term.toLocaleLowerCase('en-US'))
        .filter(Boolean);
}
function termCoverage(terms, queryTerms) {
    if (terms.length === 0) {
        return 0;
    }
    return terms.filter((term) => queryTerms.has(term)).length / terms.length;
}
function normalizeCompact(value) {
    return value.replace(/[^A-Za-z0-9]+/g, '').toLocaleLowerCase('en-US');
}
function searchResultKey(result) {
    return `${normalizeFilePath(result.relativePath)}\0${result.stableId}`;
}
function compareSearchResults(left, right) {
    return compareText(left.relativePath.toLocaleLowerCase('en-US'), right.relativePath.toLocaleLowerCase('en-US'))
        || compareText(left.relativePath, right.relativePath)
        || left.ordinal - right.ordinal
        || compareText(left.stableId, right.stableId);
}
function compareText(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}
function normalizeFilePath(filePath) {
    return filePath.replace(/\\/g, '/').toLocaleLowerCase('en-US');
}
//# sourceMappingURL=projectSearchRanking.js.map