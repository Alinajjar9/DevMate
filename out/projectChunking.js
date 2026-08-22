"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_PROJECT_SYMBOL_RANGES = void 0;
exports.splitProjectContentWithSymbols = splitProjectContentWithSymbols;
const projectIndex_1 = require("./projectIndex");
exports.MAX_PROJECT_SYMBOL_RANGES = 2_048;
function splitProjectContentWithSymbols(content, relativePath, symbolRanges) {
    if (!content.trim() || symbolRanges.length === 0) {
        return (0, projectIndex_1.splitProjectContent)(content, relativePath);
    }
    const lineOffsets = collectLineOffsets(content);
    const boundaries = symbolBoundaries(content, lineOffsets, symbolRanges);
    if (!boundaries) {
        return (0, projectIndex_1.splitProjectContent)(content, relativePath);
    }
    const chunks = [];
    const normalizedPath = relativePath.replace(/\\/g, '/');
    const minimumPreferredSize = Math.floor(projectIndex_1.MAX_PROJECT_CHUNK_CHARACTERS * 0.6);
    let startOffset = 0;
    while (startOffset < content.length) {
        let endOffset = Math.min(content.length, startOffset + projectIndex_1.MAX_PROJECT_CHUNK_CHARACTERS);
        if (endOffset < content.length) {
            const preferredBoundary = lastBoundaryWithin(boundaries, startOffset + minimumPreferredSize, endOffset);
            if (preferredBoundary !== undefined) {
                endOffset = preferredBoundary;
            }
            else {
                const newlineBoundary = content.lastIndexOf('\n', endOffset);
                if (newlineBoundary >= startOffset + minimumPreferredSize) {
                    endOffset = newlineBoundary + 1;
                }
            }
        }
        const chunkContent = content.slice(startOffset, endOffset);
        if (chunkContent.trim()) {
            const startLine = lineNumberAtOffset(lineOffsets, startOffset);
            const endLine = lineNumberAtOffset(lineOffsets, Math.max(startOffset, endOffset - 1));
            chunks.push({
                id: `${normalizedPath}:${startLine}-${endLine}`,
                startLine,
                endLine,
                content: chunkContent
            });
        }
        startOffset = endOffset;
    }
    return chunks;
}
function symbolBoundaries(content, lineOffsets, ranges) {
    if (ranges.length > exports.MAX_PROJECT_SYMBOL_RANGES) {
        return undefined;
    }
    const boundaries = new Set();
    for (const range of ranges) {
        const startOffset = positionOffset(content, lineOffsets, range.start);
        const endOffset = positionOffset(content, lineOffsets, range.end);
        if (startOffset === undefined
            || endOffset === undefined
            || endOffset <= startOffset) {
            return undefined;
        }
        if (startOffset > 0 && startOffset < content.length) {
            boundaries.add(startOffset);
        }
        if (endOffset > 0 && endOffset < content.length) {
            boundaries.add(endOffset);
        }
    }
    return boundaries.size > 0
        ? [...boundaries].sort((left, right) => left - right)
        : undefined;
}
function collectLineOffsets(content) {
    const offsets = [0];
    for (let index = 0; index < content.length; index += 1) {
        if (content[index] === '\n') {
            offsets.push(index + 1);
        }
    }
    return offsets;
}
function positionOffset(content, lineOffsets, position) {
    if (!Number.isInteger(position.line)
        || !Number.isInteger(position.character)
        || position.line < 0
        || position.line >= lineOffsets.length
        || position.character < 0) {
        return undefined;
    }
    const startOffset = lineOffsets[position.line];
    let endOffset = position.line + 1 < lineOffsets.length
        ? lineOffsets[position.line + 1] - 1
        : content.length;
    if (endOffset > startOffset && content[endOffset - 1] === '\r') {
        endOffset -= 1;
    }
    return position.character <= endOffset - startOffset
        ? startOffset + position.character
        : undefined;
}
function lastBoundaryWithin(boundaries, minimum, maximum) {
    let selected;
    for (const boundary of boundaries) {
        if (boundary > maximum) {
            break;
        }
        if (boundary >= minimum) {
            selected = boundary;
        }
    }
    return selected;
}
function lineNumberAtOffset(lineOffsets, offset) {
    let low = 0;
    let high = lineOffsets.length;
    while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (lineOffsets[middle] <= offset) {
            low = middle + 1;
        }
        else {
            high = middle;
        }
    }
    return Math.max(1, low);
}
//# sourceMappingURL=projectChunking.js.map