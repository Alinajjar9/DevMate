// Retrieve project candidates through SQLite when available, with a local lexical fallback.
// Reread and validate source before returning context so stale index text is not trusted.

import { createHash } from 'crypto';
import {
  searchKnowledgeIndex,
  searchKnowledgeIndexSemantically
} from '../api/client';
import {
  MAX_LEXICAL_QUERY_CHARACTERS,
  MAX_LEXICAL_RESULTS,
  MAX_SEMANTIC_QUERY_CHARACTERS,
  MAX_SEMANTIC_RESULTS
} from '../api/types';
import type {
  ApiResult,
  KnowledgeIndexSearchRequest,
  KnowledgeIndexSearchItem,
  KnowledgeIndexSearchResponse,
  KnowledgeIndexSemanticSearchRequest,
  KnowledgeIndexSemanticSearchResponse
} from '../api/types';
import type { ResolvedEmbeddingProfile } from '../settings/embeddingProfiles';
import type { KnowledgeIndexAccess } from './indexSynchronization';
import { retrieveProjectChunks } from './projectIndex';
import type {
  ProjectChunkRetrievalLimits,
  ProjectIndex,
  RetrievedProjectChunk
} from './projectIndex';
import { rankProjectSearchResults } from './projectSearchRanking';

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

export const SEMANTIC_SEARCH_CAPABILITY = 'semantic-search-v1';

export type KnowledgeIndexSearchAccess = KnowledgeIndexAccess & {
  capabilities?: readonly string[];
};

export type SelectedEmbeddingSearchProfile = ResolvedEmbeddingProfile;

export type KnowledgeIndexSemanticSearch = (
  access: KnowledgeIndexSearchAccess,
  request: KnowledgeIndexSemanticSearchRequest,
  providerApiKey: string | undefined,
  signal?: AbortSignal
) => Promise<ApiResult<KnowledgeIndexSemanticSearchResponse>>;

export type HybridProjectRetrieverOptions = {
  getAccess: () => KnowledgeIndexSearchAccess | undefined;
  getEmbeddingProfile?: () => PromiseLike<SelectedEmbeddingSearchProfile | undefined>;
  readCurrentFile: (
    relativePath: string,
    signal?: AbortSignal
  ) => Promise<CurrentProjectFile | undefined>;
  fallback?: ProjectRetriever;
  search?: KnowledgeIndexSearch;
  semanticSearch?: KnowledgeIndexSemanticSearch;
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

export class HybridProjectRetriever implements ProjectRetriever {
  private readonly fallback: ProjectRetriever;
  private readonly search: KnowledgeIndexSearch;
  private readonly semanticSearch: KnowledgeIndexSemanticSearch;

  constructor(private readonly options: HybridProjectRetrieverOptions) {
    this.fallback = options.fallback ?? new LexicalProjectRetriever();
    this.search = options.search ?? ((access, request, signal) => searchKnowledgeIndex(
      access.backendUrl,
      request,
      access.backendToken,
      signal
    ));
    this.semanticSearch = options.semanticSearch ?? (
      (access, request, providerApiKey, signal) => searchKnowledgeIndexSemantically(
        access.backendUrl,
        request,
        {
          backendToken: access.backendToken,
          ...(providerApiKey !== undefined ? { providerApiKey } : {})
        },
        undefined,
        signal
      )
    );
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

    const resultLimit = Math.max(20, maxChunks * 4);
    // Ask both retrievers independently. A missing embedding profile must not disable lexical search.
    const [lexicalResponse, semanticResponse] = await Promise.all([
      this.tryLexicalSearch(
        access,
        request,
        Math.min(MAX_LEXICAL_RESULTS, resultLimit)
      ),
      this.trySemanticSearch(
        access,
        request,
        Math.min(MAX_SEMANTIC_RESULTS, resultLimit)
      )
    ]);
    // Cancellation is not a search failure: do not start a fallback after the user stops the request.
    if (request.signal?.aborted
      || lexicalResponse?.errorKind === 'cancelled'
      || semanticResponse?.errorKind === 'cancelled') {
      return [];
    }
    const lexicalResults = successfulResults(lexicalResponse);
    const semanticResults = successfulResults(semanticResponse);
    const rankedResults = rankProjectSearchResults(
      lexicalResults,
      semanticResults,
      request.question,
      resultLimit
    );
    // The in-memory lexical index is still useful when the backend is unavailable or has no matches.
    if (rankedResults.length === 0) {
      return this.fallback.retrieve(request);
    }

    const chunks = await this.currentChunks(
      rankedResults,
      request,
      maxChunks,
      maxCharacters
    );
    if (request.signal?.aborted) {
      return [];
    }
    return chunks.length > 0
      ? chunks
      : this.fallback.retrieve(request);
  }

  private async tryLexicalSearch(
    access: KnowledgeIndexSearchAccess,
    request: ProjectRetrievalRequest,
    limit: number
  ): Promise<ApiResult<KnowledgeIndexSearchResponse> | undefined> {
    try {
      return await this.search(access, {
        workspaceKey: request.workspaceKey ?? '',
        query: request.question.slice(0, MAX_LEXICAL_QUERY_CHARACTERS),
        limit
      }, request.signal);
    } catch {
      return undefined;
    }
  }

  private async trySemanticSearch(
    access: KnowledgeIndexSearchAccess,
    request: ProjectRetrievalRequest,
    limit: number
  ): Promise<ApiResult<KnowledgeIndexSemanticSearchResponse> | undefined> {
    if (!access.capabilities?.includes(SEMANTIC_SEARCH_CAPABILITY)
      || !this.options.getEmbeddingProfile) {
      return undefined;
    }
    try {
      const profile = await this.options.getEmbeddingProfile();
      if (!profile || request.signal?.aborted) {
        return undefined;
      }
      return await this.semanticSearch(access, {
        workspaceKey: request.workspaceKey ?? '',
        query: request.question.slice(0, MAX_SEMANTIC_QUERY_CHARACTERS),
        profileId: profile.id,
        provider: profile.provider,
        model: profile.model,
        baseUrl: profile.baseUrl,
        remoteAllowed: profile.remoteAllowed,
        vectorVersion: 1,
        limit
      }, profile.apiKey, request.signal);
    } catch {
      return undefined;
    }
  }

  private async currentChunks(
    results: KnowledgeIndexSearchResponse['results'],
    request: ProjectRetrievalRequest,
    maxChunks: number,
    maxCharacters: number
  ): Promise<RetrievedProjectChunk[]> {
    const excludedPaths = new Set(
      [...(request.limits.excludedFilePaths ?? [])].map(normalizeFilePath)
    );
    const selected: RetrievedProjectChunk[] = [];
    // One result per file provides broader project coverage within the small context allowance.
    const selectedFiles = new Set<string>();
    let remainingCharacters = maxCharacters;

    for (const result of results) {
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
      // Indexed text is only a candidate. Reject it if the current file no longer contains that chunk.
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

    return selected;
  }
}

function successfulResults(
  response: ApiResult<KnowledgeIndexSearchResponse> | undefined
): KnowledgeIndexSearchItem[] {
  return response?.status === 'ok' && response.data
    ? response.data.results
    : [];
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
  // Check both content and location; identical text elsewhere in the file is not the indexed chunk.
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
