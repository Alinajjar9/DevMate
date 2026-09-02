// Turn document symbols into bounded source chunks, using line chunks as a fallback.
// Chunk positions refer to exact source lines, not model-generated summaries.

import {
  MAX_PROJECT_CHUNK_CHARACTERS,
  splitProjectContent
} from './projectIndex';
import type { ProjectIndexChunk } from './projectIndex';

export const MAX_PROJECT_SYMBOL_RANGES = 2_048;

export type ProjectSymbolPosition = {
  line: number;
  character: number;
};

export type ProjectSymbolRange = {
  start: ProjectSymbolPosition;
  end: ProjectSymbolPosition;
};

export function splitProjectContentWithSymbols(
  content: string,
  relativePath: string,
  symbolRanges: ProjectSymbolRange[]
): ProjectIndexChunk[] {
  if (!content.trim() || symbolRanges.length === 0) {
    return splitProjectContent(content, relativePath);
  }
  const lineOffsets = collectLineOffsets(content);
  const boundaries = symbolBoundaries(content, lineOffsets, symbolRanges);
  if (!boundaries) {
    return splitProjectContent(content, relativePath);
  }

  const chunks: ProjectIndexChunk[] = [];
  const normalizedPath = relativePath.replace(/\\/g, '/');
  // Prefer symbol boundaries without producing lots of tiny chunks; oversized symbols still get split.
  const minimumPreferredSize = Math.floor(MAX_PROJECT_CHUNK_CHARACTERS * 0.6);
  let startOffset = 0;

  while (startOffset < content.length) {
    let endOffset = Math.min(
      content.length,
      startOffset + MAX_PROJECT_CHUNK_CHARACTERS
    );
    if (endOffset < content.length) {
      const preferredBoundary = lastBoundaryWithin(
        boundaries,
        startOffset + minimumPreferredSize,
        endOffset
      );
      if (preferredBoundary !== undefined) {
        endOffset = preferredBoundary;
      } else {
        const newlineBoundary = content.lastIndexOf('\n', endOffset);
        if (newlineBoundary >= startOffset + minimumPreferredSize) {
          endOffset = newlineBoundary + 1;
        }
      }
    }

    const chunkContent = content.slice(startOffset, endOffset);
    if (chunkContent.trim()) {
      const startLine = lineNumberAtOffset(lineOffsets, startOffset);
      const endLine = lineNumberAtOffset(
        lineOffsets,
        Math.max(startOffset, endOffset - 1)
      );
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

function symbolBoundaries(
  content: string,
  lineOffsets: number[],
  ranges: ProjectSymbolRange[]
): number[] | undefined {
  if (ranges.length > MAX_PROJECT_SYMBOL_RANGES) {
    return undefined;
  }
  const boundaries = new Set<number>();
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

function collectLineOffsets(content: string): number[] {
  const offsets = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === '\n') {
      offsets.push(index + 1);
    }
  }
  return offsets;
}

// VS Code symbol positions are zero-based; stored chunk line numbers are one-based.
function positionOffset(
  content: string,
  lineOffsets: number[],
  position: ProjectSymbolPosition
): number | undefined {
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

function lastBoundaryWithin(
  boundaries: number[],
  minimum: number,
  maximum: number
): number | undefined {
  let selected: number | undefined;
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

function lineNumberAtOffset(lineOffsets: number[], offset: number): number {
  // Binary search finds the containing line without rescanning the whole file for each chunk.
  let low = 0;
  let high = lineOffsets.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (lineOffsets[middle] <= offset) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return Math.max(1, low);
}
