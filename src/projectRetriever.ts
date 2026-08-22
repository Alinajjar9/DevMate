import { createHash } from 'crypto';
import { searchKnowledgeIndex } from './api/client';
import {
  MAX_LEXICAL_QUERY_CHARACTERS,
  MAX_LEXICAL_RESULTS
} from './api/types';
import type {
  ApiResult,
  KnowledgeIndexSearchRequest,
  KnowledgeIndexSearchResponse
} from './api/types';
import type { KnowledgeIndexAccess } from './indexSynchronization';
import { retrieveProjectChunks } from './projectIndex';
import type {
  ProjectChunkRetrievalLimits,
  ProjectIndex,
  RetrievedProjectChunk
} from './projectIndex';

export type ProjectRetrievalRequest = {
  index?: ProjectIndex;
  loadIndex?: () => Promise<ProjectIndex>;
  workspaceKey?: string;
  workspacePath?: string;
  question: string;
  limits: ProjectChunkRetrievalLimits;
  signal?: AbortSignal;
};

export type CurrentProjectFile = {
  filePath: string;
  relativePath: string;
  languageId: string;
  content: string;
};

export type KnowledgeIndexSearch = (
  access: KnowledgeIndexAccess,
  request: KnowledgeIndexSearchRequest,
  signal?: AbortSignal
) => Promise<ApiResult<KnowledgeIndexSearchResponse>>;

export type SqliteLexicalProjectRetrieverOptions = {
  getAccess: () => KnowledgeIndexAccess | undefined;
  readCurrentFile: (
    relativePath: string,
    signal?: AbortSignal
  ) => Promise<CurrentProjectFile | undefined>;
  fallback?: ProjectRetriever;
  search?: KnowledgeIndexSearch;
};

export interface ProjectRetriever {
  retrieve(request: ProjectRetrievalRequest): Promise<RetrievedProjectChunk[]>;
}

export class LexicalProjectRetriever implements ProjectRetriever {
  async retrieve(request: ProjectRetrievalRequest): Promise<RetrievedProjectChunk[]> {
    const index = request.index ?? await request.loadIndex?.();
    return index
      ? retrieveProjectChunks(index, request.question, request.limits)
      : [];
  }
}

export class SqliteLexicalProjectRetriever implements ProjectRetriever {
  private readonly fallback: ProjectRetriever;
  private readonly search: KnowledgeIndexSearch;

  constructor(private readonly options: SqliteLexicalProjectRetrieverOptions) {
    this.fallback = options.fallback ?? new LexicalProjectRetriever();
    this.search = options.search ?? ((access, request, signal) => searchKnowledgeIndex(
      access.backendUrl,
      request,
      access.backendToken,
      signal
    ));
  }

  async retrieve(request: ProjectRetrievalRequest): Promise<RetrievedProjectChunk[]> {
    const access = this.options.getAccess();
    const maxChunks = Math.max(0, Math.min(request.limits.maxChunks ?? 5, 5));
    const maxCharacters = Math.max(0, request.limits.maxCharacters ?? 40_000);
    if (maxChunks === 0 || maxCharacters === 0) {
      return [];
    }
    if (!access || !request.workspaceKey) {
      return this.fallback.retrieve(request);
    }
    if (request.signal?.aborted) {
      return [];
    }

    const response = await this.search(access, {
      workspaceKey: request.workspaceKey,
      query: request.question.slice(0, MAX_LEXICAL_QUERY_CHARACTERS),
      limit: Math.min(MAX_LEXICAL_RESULTS, Math.max(20, maxChunks * 4))
    }, request.signal);
    if (request.signal?.aborted || response.errorKind === 'cancelled') {
      return [];
    }
    if (response.status !== 'ok' || !response.data || response.data.results.length === 0) {
      return this.fallback.retrieve(request);
    }

    const excludedPaths = new Set(
      [...(request.limits.excludedFilePaths ?? [])].map(normalizeFilePath)
    );
    const selected: RetrievedProjectChunk[] = [];
    const selectedFiles = new Set<string>();
    let remainingCharacters = maxCharacters;

    for (const result of response.data.results) {
      if (selected.length >= maxChunks || remainingCharacters <= 0) {
        break;
      }
      if (request.signal?.aborted) {
        return [];
      }
      const normalizedRelativePath = normalizeFilePath(result.relativePath);
      if (selectedFiles.has(normalizedRelativePath)) {
        continue;
      }
      const currentFile = await this.options.readCurrentFile(
        result.relativePath,
        request.signal
      );
      if (!currentFile
        || excludedPaths.has(normalizeFilePath(currentFile.filePath))
        || normalizeFilePath(currentFile.relativePath) !== normalizedRelativePath) {
        continue;
      }
      const exactContent = exactCurrentChunk(currentFile.content, result);
      if (exactContent === undefined) {
        continue;
      }

      const content = exactContent.slice(0, remainingCharacters);
      selected.push({
        filePath: currentFile.filePath,
        relativePath: currentFile.relativePath,
        languageId: currentFile.languageId,
        totalCharacters: currentFile.content.length,
        startLine: result.startLine,
        endLine: result.endLine,
        content,
        score: result.score
      });
      selectedFiles.add(normalizedRelativePath);
      remainingCharacters -= content.length;
    }

    return selected.length > 0
      ? selected
      : this.fallback.retrieve(request);
  }
}

function exactCurrentChunk(
  fileContent: string,
  result: KnowledgeIndexSearchResponse['results'][number]
): string | undefined {
  if (sha256Hex(result.content) !== result.contentHash) {
    return undefined;
  }
  const lineOffsets = collectLineOffsets(fileContent);
  const expectedLineIndex = result.startLine - 1;
  if (expectedLineIndex < 0 || expectedLineIndex >= lineOffsets.length) {
    return undefined;
  }
  const firstMatchOffset = lineOffsets[expectedLineIndex];
  const maximumMatchOffset = lineOffsets[expectedLineIndex + 1] ?? fileContent.length + 1;
  let matchOffset = fileContent.indexOf(result.content, firstMatchOffset);
  while (matchOffset >= 0 && matchOffset < maximumMatchOffset) {
    const startLine = lineNumberAtOffset(lineOffsets, matchOffset);
    const endLine = lineNumberAtOffset(
      lineOffsets,
      matchOffset + Math.max(0, result.content.length - 1)
    );
    if (startLine === result.startLine && endLine === result.endLine) {
      return fileContent.slice(matchOffset, matchOffset + result.content.length);
    }
    matchOffset = fileContent.indexOf(result.content, matchOffset + 1);
  }
  return undefined;
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

function lineNumberAtOffset(lineOffsets: number[], offset: number): number {
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

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeFilePath(value: string): string {
  const normalized = value.replace(/\\/g, '/');
  return process.platform === 'win32'
    ? normalized.toLocaleLowerCase('en-US')
    : normalized;
}
