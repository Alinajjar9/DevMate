const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const test = require('node:test');

const {
  createEmptyProjectIndex,
  createIndexedProjectFile,
  retrieveProjectChunks
} = require('../out/projectIndex');
const {
  fuseProjectSearchResults,
  LexicalProjectRetriever,
  RECIPROCAL_RANK_FUSION_CONSTANT,
  SqliteProjectRetriever
} = require('../out/projectRetriever');

const ACCESS = {
  backendUrl: 'http://127.0.0.1:8000',
  backendToken: 'test-backend-token-that-is-long-enough'
};
const SEMANTIC_ACCESS = {
  ...ACCESS,
  capabilities: ['knowledge-index-v1', 'semantic-search-v1']
};

test('lexical project retriever preserves the existing ranking and limits', async () => {
  const index = createEmptyProjectIndex('C:/repo');
  index.files = [
    indexedFile('src/catalog.ts', 'export function listProducts() { return []; }'),
    indexedFile(
      'src/auth/login.ts',
      'export function validateLoginToken(token) { return token.length > 10; }'
    ),
    indexedFile('README.md', '# Login token documentation')
  ];
  const request = {
    index,
    question: 'Where is the login token validated?',
    limits: {
      maxChunks: 2,
      maxCharacters: 4_000,
      excludedFilePaths: new Set(['C:/repo/README.md'])
    }
  };

  const expected = retrieveProjectChunks(index, request.question, request.limits);
  const actual = await new LexicalProjectRetriever().retrieve(request);

  assert.deepEqual(actual, expected);
  assert.equal(actual[0].relativePath, 'src/auth/login.ts');
  assert.equal(actual.some((result) => result.relativePath === 'README.md'), false);
});

test('SQLite lexical retrieval returns only exact current source without loading JSON', async () => {
  const authContent = [
    'export function validateLoginToken(token) {',
    '  return token.length > 10;',
    '}',
    ''
  ].join('\n');
  const catalogContent = 'export function listProducts() { return []; }\n';
  let fallbackLoads = 0;
  const searchCalls = [];
  const files = new Map([
    ['src/auth.ts', currentFile('src/auth.ts', authContent)],
    ['src/catalog.ts', currentFile('src/catalog.ts', catalogContent)]
  ]);
  const retriever = new SqliteProjectRetriever({
    getAccess: () => ACCESS,
    readCurrentFile: async (relativePath) => files.get(relativePath),
    search: async (access, request, signal) => {
      searchCalls.push({ access, request, signal });
      return {
        status: 'ok',
        data: {
          results: [
            searchItem('src/auth.ts', authContent, 1, 3, 4),
            searchItem('src/auth.ts', authContent, 1, 3, 3),
            searchItem('src/catalog.ts', catalogContent, 1, 1, 2)
          ]
        }
      };
    }
  });
  const signal = new AbortController().signal;

  const results = await retriever.retrieve({
    workspaceKey: 'workspace:test',
    question: 'Where is the login token validated?',
    loadIndex: async () => {
      fallbackLoads += 1;
      return createEmptyProjectIndex('C:/repo');
    },
    limits: {
      maxChunks: 2,
      maxCharacters: 4_000,
      excludedFilePaths: new Set(['C:/repo/src/catalog.ts'])
    },
    signal
  });

  assert.equal(fallbackLoads, 0);
  assert.equal(searchCalls.length, 1);
  assert.deepEqual(searchCalls[0], {
    access: ACCESS,
    request: {
      workspaceKey: 'workspace:test',
      query: 'Where is the login token validated?',
      limit: 20
    },
    signal
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].relativePath, 'src/auth.ts');
  assert.equal(results[0].content, authContent);
  assert.equal(results[0].totalCharacters, authContent.length);
});

test('SQLite project retrieval uses semantic ranking when a selected profile is ready', async () => {
  const workerContent = [
    'export async function runQueuedJobs() {',
    '  await queue.drain();',
    '}',
    ''
  ].join('\n');
  const semanticCalls = [];
  let lexicalCalls = 0;
  const retriever = new SqliteProjectRetriever({
    getAccess: () => SEMANTIC_ACCESS,
    getEmbeddingProfile: async () => ({
      id: 'local-embedding',
      provider: 'ollama',
      model: 'nomic-embed-text',
      baseUrl: 'http://127.0.0.1:11434',
      remoteAllowed: false,
      apiKey: 'semantic-secret'
    }),
    readCurrentFile: async (relativePath) => currentFile(relativePath, workerContent),
    semanticSearch: async (access, request, providerApiKey, signal) => {
      semanticCalls.push({ access, request, providerApiKey, signal });
      return {
        status: 'ok',
        data: {
          configuration: {
            profileId: 'local-embedding',
            provider: 'ollama',
            model: 'nomic-embed-text',
            dimensions: 768,
            vectorVersion: 1
          },
          results: [searchItem('src/worker.ts', workerContent, 1, 3, 0.94)]
        }
      };
    },
    search: async () => {
      lexicalCalls += 1;
      return { status: 'ok', data: { results: [] } };
    }
  });
  const signal = new AbortController().signal;

  const results = await retriever.retrieve({
    workspaceKey: 'workspace:test',
    question: 'Where does deferred background work execute?',
    limits: { maxChunks: 2, maxCharacters: 4_000 },
    signal
  });

  assert.equal(lexicalCalls, 1);
  assert.equal(results.length, 1);
  assert.equal(results[0].relativePath, 'src/worker.ts');
  assert.equal(results[0].content, workerContent);
  assert.deepEqual(semanticCalls, [{
    access: SEMANTIC_ACCESS,
    request: {
      workspaceKey: 'workspace:test',
      query: 'Where does deferred background work execute?',
      profileId: 'local-embedding',
      provider: 'ollama',
      model: 'nomic-embed-text',
      baseUrl: 'http://127.0.0.1:11434',
      remoteAllowed: false,
      vectorVersion: 1,
      limit: 20
    },
    providerApiKey: 'semantic-secret',
    signal
  }]);
});

test('reciprocal rank fusion rewards agreement and preserves semantic-only matches', () => {
  const auth = searchItem(
    'src/auth.ts',
    'export function validateSession() { return true; }\n',
    1,
    1,
    20
  );
  const catalog = searchItem(
    'src/catalog.ts',
    'export function listProducts() { return []; }\n',
    1,
    1,
    10
  );
  const worker = searchItem(
    'src/worker.ts',
    'export async function runQueuedJobs() {}\n',
    1,
    1,
    0.98
  );

  const fused = fuseProjectSearchResults(
    [auth, catalog],
    [worker, { ...auth, score: 0.75 }],
    3
  );

  assert.equal(RECIPROCAL_RANK_FUSION_CONSTANT, 60);
  assert.deepEqual(fused.map((result) => result.relativePath), [
    'src/auth.ts',
    'src/worker.ts',
    'src/catalog.ts'
  ]);
  assert.ok(fused[0].score > fused[1].score);
  assert.equal(fused.filter((result) => result.relativePath === 'src/auth.ts').length, 1);
  assert.deepEqual(fuseProjectSearchResults([auth], [worker], 0), []);
});

test('semantic failures and stale semantic chunks fall through to SQLite lexical search', async () => {
  const lexicalContent = 'export function validateSession() { return true; }\n';
  for (const semanticResult of [
    { status: 'error', errorKind: 'http', message: 'Provider unavailable.' },
    {
      status: 'ok',
      data: {
        configuration: null,
        results: []
      }
    },
    {
      status: 'ok',
      data: {
        configuration: {
          profileId: 'local-embedding',
          provider: 'ollama',
          model: 'nomic-embed-text',
          dimensions: 768,
          vectorVersion: 1
        },
        results: [searchItem(
          'src/stale.ts',
          'export const staleSemanticChunk = true;\n',
          1,
          1,
          0.9
        )]
      }
    }
  ]) {
    let lexicalCalls = 0;
    const retriever = new SqliteProjectRetriever({
      getAccess: () => SEMANTIC_ACCESS,
      getEmbeddingProfile: async () => ({
        id: 'local-embedding',
        provider: 'ollama',
        model: 'nomic-embed-text',
        baseUrl: 'http://127.0.0.1:11434',
        remoteAllowed: false
      }),
      readCurrentFile: async (relativePath) => currentFile(relativePath, lexicalContent),
      semanticSearch: async () => semanticResult,
      search: async () => {
        lexicalCalls += 1;
        return {
          status: 'ok',
          data: {
            results: [searchItem('src/auth.ts', lexicalContent, 1, 1, 4)]
          }
        };
      }
    });

    const results = await retriever.retrieve({
      workspaceKey: 'workspace:test',
      question: 'session checks',
      limits: { maxChunks: 2, maxCharacters: 4_000 }
    });

    assert.equal(lexicalCalls, 1);
    assert.equal(results[0].relativePath, 'src/auth.ts');
  }
});

test('cancelled hybrid searches do not continue into JSON retrieval', async () => {
  let lexicalCalls = 0;
  let fallbackCalls = 0;
  const retriever = new SqliteProjectRetriever({
    getAccess: () => SEMANTIC_ACCESS,
    getEmbeddingProfile: async () => ({
      id: 'local-embedding',
      provider: 'ollama',
      model: 'nomic-embed-text',
      baseUrl: 'http://127.0.0.1:11434',
      remoteAllowed: false
    }),
    readCurrentFile: async () => undefined,
    semanticSearch: async () => ({ status: 'error', errorKind: 'cancelled' }),
    search: async () => {
      lexicalCalls += 1;
      return { status: 'ok', data: { results: [] } };
    },
    fallback: {
      retrieve: async () => {
        fallbackCalls += 1;
        return [];
      }
    }
  });

  assert.deepEqual(await retriever.retrieve({
    workspaceKey: 'workspace:test',
    question: 'background work',
    limits: { maxChunks: 5, maxCharacters: 40_000 }
  }), []);
  assert.equal(lexicalCalls, 1);
  assert.equal(fallbackCalls, 0);
});

test('SQLite lexical retrieval falls back for missing access, failed searches, and stale source', async () => {
  const fallbackResult = {
    filePath: 'C:/repo/src/fallback.ts',
    relativePath: 'src/fallback.ts',
    languageId: 'typescript',
    totalCharacters: 22,
    startLine: 1,
    endLine: 1,
    content: 'export const fallback;',
    score: 1
  };
  const fallbackRequests = [];
  const fallback = {
    retrieve: async (request) => {
      fallbackRequests.push(request);
      return [fallbackResult];
    }
  };
  const noAccess = new SqliteProjectRetriever({
    getAccess: () => undefined,
    readCurrentFile: async () => undefined,
    fallback,
    search: async () => {
      throw new Error('Search must not run without authenticated access.');
    }
  });
  const request = {
    workspaceKey: 'workspace:test',
    question: 'fallback',
    limits: { maxChunks: 2, maxCharacters: 4_000 }
  };

  assert.deepEqual(await noAccess.retrieve(request), [fallbackResult]);

  const failedSearch = new SqliteProjectRetriever({
    getAccess: () => ACCESS,
    readCurrentFile: async () => undefined,
    fallback,
    search: async () => ({
      status: 'error',
      errorKind: 'http',
      message: 'The index is unavailable.'
    })
  });
  assert.deepEqual(await failedSearch.retrieve(request), [fallbackResult]);

  const emptySearch = new SqliteProjectRetriever({
    getAccess: () => ACCESS,
    readCurrentFile: async () => undefined,
    fallback,
    search: async () => ({
      status: 'ok',
      data: { results: [] }
    })
  });
  assert.deepEqual(await emptySearch.retrieve(request), [fallbackResult]);

  const stale = new SqliteProjectRetriever({
    getAccess: () => ACCESS,
    readCurrentFile: async (relativePath) => currentFile(
      relativePath,
      'export const current = true;\n'
    ),
    fallback,
    search: async () => ({
      status: 'ok',
      data: {
        results: [searchItem(
          'src/stale.ts',
          'export const stale = true;\n',
          1,
          1,
          1
        )]
      }
    })
  });

  assert.deepEqual(await stale.retrieve(request), [fallbackResult]);
  assert.equal(fallbackRequests.length, 4);
});

test('cancelled SQLite searches do not start expensive fallback indexing', async () => {
  let fallbackCalls = 0;
  const retriever = new SqliteProjectRetriever({
    getAccess: () => ACCESS,
    readCurrentFile: async () => undefined,
    fallback: {
      retrieve: async () => {
        fallbackCalls += 1;
        return [];
      }
    },
    search: async () => ({
      status: 'error',
      errorKind: 'cancelled'
    })
  });

  const results = await retriever.retrieve({
    workspaceKey: 'workspace:test',
    question: 'cancelled',
    limits: { maxChunks: 5, maxCharacters: 40_000 }
  });

  assert.deepEqual(results, []);
  assert.equal(fallbackCalls, 0);
});

function indexedFile(relativePath, content) {
  return createIndexedProjectFile({
    filePath: `C:/repo/${relativePath}`,
    relativePath,
    languageId: 'typescript',
    content
  }, content.length, 1);
}

function currentFile(relativePath, content) {
  return {
    filePath: `C:/repo/${relativePath}`,
    relativePath,
    languageId: 'typescript',
    content
  };
}

function searchItem(relativePath, content, startLine, endLine, score) {
  return {
    relativePath,
    languageId: 'typescript',
    stableId: `${relativePath}:${startLine}-${endLine}:0`,
    ordinal: 0,
    startLine,
    endLine,
    content,
    contentHash: createHash('sha256').update(content).digest('hex'),
    score
  };
}
