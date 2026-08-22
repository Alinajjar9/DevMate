const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const test = require('node:test');

const {
  KNOWLEDGE_INDEX_CHUNKING_VERSION,
  KnowledgeIndexSynchronizer,
  knowledgeIndexWorkspaceKey
} = require('../out/indexSynchronization');
const {
  MAX_FILE_CHANGES_PER_BATCH,
  MAX_INDEX_BATCH_CONTENT_CHARACTERS
} = require('../out/api/types');

const ACCESS = {
  backendUrl: 'http://127.0.0.1:8000',
  backendToken: 'test-backend-token-that-is-long-enough'
};

test('initial synchronization hashes, chunks, and stores each workspace file', async () => {
  const reports = [];
  const api = createApi();
  const synchronizer = new KnowledgeIndexSynchronizer(source([
    sourceFile('src/auth.ts', 'export function authenticateUser() { return true; }\n', 10),
    sourceFile('README.md', '# Example project\n', 20)
  ]), api, (message) => reports.push(message));

  const result = await synchronizer.synchronize(ACCESS);

  assert.deepEqual(result, {
    kind: 'completed',
    indexState: 'ready',
    scannedFiles: 2,
    indexedFiles: 2,
    deletedFiles: 0,
    unchangedFiles: 0,
    unavailableFiles: 0
  });
  assert.equal(api.applyRequests.length, 1);
  assert.equal(api.applyRequests[0].upserts.length, 2);
  assert.deepEqual(api.applyRequests[0].deletedPaths, []);
  const auth = api.applyRequests[0].upserts.find((file) => file.relativePath === 'src/auth.ts');
  assert.equal(auth.contentHash, sha256('export function authenticateUser() { return true; }\n'));
  assert.equal(auth.chunks.length, 1);
  assert.equal(auth.chunks[0].ordinal, 0);
  assert.equal(auth.chunks[0].stableId, 'src/auth.ts:1-1');
  assert.equal(auth.chunks[0].chunkingVersion, KNOWLEDGE_INDEX_CHUNKING_VERSION);
  assert.deepEqual(api.metadataRequests.map((request) => request.indexState), [
    'indexing',
    'ready'
  ]);
  assert.match(api.metadataRequests[1].lastFullScanAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(reports.at(-1), /2 indexed, 0 deleted, 0 unchanged/);
});

test('incremental synchronization sends only changed files and known deletions', async () => {
  const unchanged = sourceFile('src/unchanged.ts', 'export const unchanged = true;\n', 10);
  const changed = sourceFile('src/changed.ts', 'export const current = true;\n', 20);
  const api = createApi({
    files: [
      fingerprint(unchanged),
      {
        relativePath: changed.relativePath,
        contentHash: sha256('export const previous = true;\n'),
        sizeBytes: Buffer.byteLength('export const previous = true;\n'),
        modifiedAt: 1
      },
      {
        relativePath: 'src/deleted.ts',
        contentHash: sha256('deleted'),
        sizeBytes: 7,
        modifiedAt: 1
      }
    ]
  });
  const synchronizer = new KnowledgeIndexSynchronizer(source([unchanged, changed]), api);

  const result = await synchronizer.synchronize(ACCESS);

  assert.equal(result.kind, 'completed');
  assert.equal(result.indexedFiles, 1);
  assert.equal(result.deletedFiles, 1);
  assert.equal(result.unchangedFiles, 1);
  assert.deepEqual(
    api.applyRequests.flatMap((request) => request.upserts.map((file) => file.relativePath)),
    ['src/changed.ts']
  );
  assert.deepEqual(
    api.applyRequests.flatMap((request) => request.deletedPaths),
    ['src/deleted.ts']
  );
});

test('chunking-version changes rebuild unchanged files before marking the index ready', async () => {
  const file = sourceFile('src/app.ts', 'export const app = true;\n', 10);
  const api = createApi({
    chunkingVersion: KNOWLEDGE_INDEX_CHUNKING_VERSION + 1,
    files: [fingerprint(file)]
  });
  const synchronizer = new KnowledgeIndexSynchronizer(source([file]), api);

  const result = await synchronizer.synchronize(ACCESS);

  assert.equal(result.kind, 'completed');
  assert.equal(result.indexedFiles, 1);
  assert.equal(result.unchangedFiles, 0);
  assert.equal(api.metadataRequests[0].chunkingVersion, KNOWLEDGE_INDEX_CHUNKING_VERSION);
  assert.equal(api.applyRequests[0].upserts[0].chunks[0].chunkingVersion,
    KNOWLEDGE_INDEX_CHUNKING_VERSION);
});

test('binary and missing files are removed or preserved without claiming a complete scan', async () => {
  const lockedPath = 'src/locked.ts';
  const binary = {
    relativePath: 'src/binary.dat',
    languageId: 'plaintext',
    read: async () => ({
      bytes: Uint8Array.from([65, 0, 66]),
      sizeBytes: 3,
      modifiedAt: 2
    })
  };
  const api = createApi({
    files: [
      {
        relativePath: binary.relativePath,
        contentHash: sha256('old binary'),
        sizeBytes: 10,
        modifiedAt: 1
      },
      {
        relativePath: lockedPath,
        contentHash: sha256('locked'),
        sizeBytes: 6,
        modifiedAt: 1
      }
    ]
  });
  const synchronizer = new KnowledgeIndexSynchronizer(
    source([binary], [lockedPath]),
    api
  );

  const result = await synchronizer.synchronize(ACCESS);

  assert.equal(result.kind, 'completed');
  assert.equal(result.indexState, 'stale');
  assert.equal(result.unavailableFiles, 1);
  assert.deepEqual(api.applyRequests.flatMap((request) => request.deletedPaths), [
    binary.relativePath
  ]);
  assert.equal(api.metadataRequests.at(-1).indexState, 'stale');
  assert.equal(api.metadataRequests.at(-1).lastFullScanAt, null);
});

test('large synchronization writes stay inside the shared API batch limits', async () => {
  const files = Array.from({ length: 25 }, (_, index) => sourceFile(
    `src/large-${String(index).padStart(2, '0')}.ts`,
    `export const item${index} = "${'value '.repeat(29_000)}";\n`,
    index + 1
  ));
  const api = createApi();
  const synchronizer = new KnowledgeIndexSynchronizer(source(files), api);

  const result = await synchronizer.synchronize(ACCESS);

  assert.equal(result.kind, 'completed');
  assert.equal(result.indexedFiles, files.length);
  assert.ok(api.applyRequests.length > 1);
  for (const request of api.applyRequests) {
    const changes = request.upserts.length + request.deletedPaths.length;
    const characters = request.upserts.reduce(
      (fileTotal, file) => fileTotal + file.chunks.reduce(
        (chunkTotal, chunk) => chunkTotal + chunk.content.length,
        0
      ),
      0
    );
    assert.ok(changes <= MAX_FILE_CHANGES_PER_BATCH);
    assert.ok(characters <= MAX_INDEX_BATCH_CONTENT_CHARACTERS);
  }
});

test('cancellation stops before file batches are sent', async () => {
  const controller = new AbortController();
  let receivedSignal;
  const file = {
    relativePath: 'src/app.ts',
    languageId: 'typescript',
    read: async (signal) => {
      receivedSignal = signal;
      controller.abort();
      return readResult('export const app = true;\n', 1);
    }
  };
  const api = createApi();
  const synchronizer = new KnowledgeIndexSynchronizer(source([file]), api);

  const result = await synchronizer.synchronize(ACCESS, controller.signal);

  assert.deepEqual(result, { kind: 'cancelled' });
  assert.equal(receivedSignal.aborted, true);
  assert.equal(api.applyRequests.length, 0);
  assert.deepEqual(api.metadataRequests.map((request) => request.indexState), ['indexing']);
});

test('failed batches leave a stable failed index state', async () => {
  const api = createApi({ applyFailure: 'The test index write failed.' });
  const synchronizer = new KnowledgeIndexSynchronizer(source([
    sourceFile('src/app.ts', 'export const app = true;\n', 1)
  ]), api);

  const result = await synchronizer.synchronize(ACCESS);

  assert.deepEqual(result, {
    kind: 'failed',
    message: 'The test index write failed.'
  });
  assert.deepEqual(api.metadataRequests.map((request) => request.indexState), [
    'indexing',
    'failed'
  ]);
});

test('workspace keys are stable across Windows path casing', () => {
  assert.equal(
    knowledgeIndexWorkspaceKey('file:///C:/Repo', 'win32'),
    knowledgeIndexWorkspaceKey('file:///c:/repo', 'win32')
  );
  assert.notEqual(
    knowledgeIndexWorkspaceKey('file:///C:/Repo', 'linux'),
    knowledgeIndexWorkspaceKey('file:///c:/repo', 'linux')
  );
});

function source(files, unavailablePaths = []) {
  return {
    scan: async () => ({
      workspaceKey: 'workspace:test',
      rootPath: 'C:/repo',
      files,
      unavailablePaths
    })
  };
}

function sourceFile(relativePath, content, modifiedAt) {
  return {
    relativePath,
    languageId: relativePath.endsWith('.ts') ? 'typescript' : 'markdown',
    read: async () => readResult(content, modifiedAt)
  };
}

function readResult(content, modifiedAt) {
  const bytes = new TextEncoder().encode(content);
  return {
    bytes,
    sizeBytes: bytes.byteLength,
    modifiedAt
  };
}

function fingerprint(file) {
  const originalRead = file.read;
  const contentByPath = {
    'src/unchanged.ts': 'export const unchanged = true;\n',
    'src/app.ts': 'export const app = true;\n'
  };
  const content = contentByPath[file.relativePath];
  if (!content || typeof originalRead !== 'function') {
    throw new Error(`Add deterministic fingerprint content for ${file.relativePath}.`);
  }
  const read = readResult(content, file.relativePath === 'src/unchanged.ts' ? 10 : 10);
  return {
    relativePath: file.relativePath,
    contentHash: sha256(content),
    sizeBytes: read.sizeBytes,
    modifiedAt: read.modifiedAt
  };
}

function createApi({ files = [], chunkingVersion = 1, applyFailure } = {}) {
  const api = {
    applyRequests: [],
    metadataRequests: [],
    open: async (_access, request) => ({
      status: 'ok',
      data: {
        workspace: {
          id: 1,
          workspaceKey: request.workspaceKey,
          rootPath: request.rootPath
        },
        metadata: {
          workspaceKey: request.workspaceKey,
          chunkingVersion,
          indexState: files.length > 0 ? 'ready' : 'empty',
          lastFullScanAt: null
        },
        files
      }
    }),
    apply: async (_access, request) => {
      api.applyRequests.push(request);
      if (applyFailure) {
        return { status: 'error', message: applyFailure, errorKind: 'http' };
      }
      return {
        status: 'ok',
        data: {
          upsertedFiles: request.upserts.length,
          deletedFiles: request.deletedPaths.length
        }
      };
    },
    updateMetadata: async (_access, request) => {
      api.metadataRequests.push(request);
      return { status: 'ok', data: request };
    }
  };
  return api;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
