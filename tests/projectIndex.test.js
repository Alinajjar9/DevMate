const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createEmptyProjectIndex,
  createIndexedProjectFile,
  MAX_PROJECT_CHUNK_CHARACTERS,
  MAX_PROJECT_INDEX_FILE_CHARACTERS,
  parseStoredProjectIndex,
  retrieveProjectChunks,
  splitProjectContent
} = require('../out/projectIndex');
const {
  MAX_PROJECT_SYMBOL_RANGES,
  splitProjectContentWithSymbols
} = require('../out/projectChunking');

test('splits project files into bounded overlapping line-aware chunks', () => {
  const content = Array.from(
    { length: 100 },
    (_, index) => `export const item${index} = "${'value '.repeat(18)}";`
  ).join('\n');
  const chunks = splitProjectContent(content, 'src/items.ts');

  assert.ok(chunks.length > 1);
  assert.equal(chunks.every((chunk) => chunk.content.length <= MAX_PROJECT_CHUNK_CHARACTERS), true);
  assert.equal(chunks.every((chunk) => chunk.startLine <= chunk.endLine), true);
  assert.ok(chunks[1].startLine <= chunks[0].endLine);
  assert.match(chunks[0].id, /^src\/items\.ts:\d+-\d+$/);
});

test('prefers valid document-symbol boundaries while retaining complete source', () => {
  const firstSymbol = [
    'export function firstSymbol() {',
    ...Array.from({ length: 150 }, () => '  firstValue += 1;'),
    '}',
    ''
  ].join('\n');
  const secondSymbol = [
    'export function secondSymbol() {',
    ...Array.from({ length: 150 }, () => '  secondValue += 1;'),
    '}',
    ''
  ].join('\n');
  const content = firstSymbol + secondSymbol;
  const chunks = splitProjectContentWithSymbols(content, 'src/symbols.ts', [
    offsetRange(content, 0, firstSymbol.length),
    offsetRange(content, firstSymbol.length, content.length)
  ]);

  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].content, firstSymbol);
  assert.equal(chunks[1].content, secondSymbol);
  assert.equal(chunks.map((chunk) => chunk.content).join(''), content);
  assert.equal(chunks.every((chunk) => chunk.content.length <= MAX_PROJECT_CHUNK_CHARACTERS), true);
});

test('falls back to line chunks for invalid or unbounded symbol ranges', () => {
  const content = 'export const fallback = true;\n'.repeat(200);
  const fallback = splitProjectContent(content, 'src/fallback.ts');

  assert.deepEqual(splitProjectContentWithSymbols(content, 'src/fallback.ts', [{
    start: { line: 999, character: 0 },
    end: { line: 1_000, character: 0 }
  }]), fallback);
  assert.deepEqual(splitProjectContentWithSymbols(
    content,
    'src/fallback.ts',
    Array.from({ length: MAX_PROJECT_SYMBOL_RANGES + 1 }, () => ({
      start: { line: 0, character: 0 },
      end: { line: 0, character: 1 }
    }))
  ), fallback);
});

test('creates a bounded index entry while retaining original file metadata', () => {
  const content = 'const token = true;\n'.repeat(3_000);
  const file = indexedFile('src/large.ts', content, 42, 1234);

  assert.equal(file.size, 42);
  assert.equal(file.modifiedAt, 1234);
  assert.equal(file.totalCharacters, content.length);
  assert.ok(file.chunks.reduce((total, chunk) => total + chunk.content.length, 0)
    <= MAX_PROJECT_INDEX_FILE_CHARACTERS * 1.2);
});

test('retrieves the strongest matching chunk and keeps file results diverse', () => {
  const index = createEmptyProjectIndex('C:/repo');
  index.files = [
    indexedFile('README.md', '# Example project\nGeneral setup instructions.'),
    indexedFile(
      'src/auth/login.ts',
      'export function validateLoginToken(token) { return token.length > 10; }\n'.repeat(100)
    ),
    indexedFile('src/catalog.ts', 'export function listProducts() { return []; }')
  ];

  const results = retrieveProjectChunks(index, 'Where is the login token validated?', {
    maxChunks: 3,
    maxCharacters: 8_000
  });

  assert.equal(results[0].relativePath, 'src/auth/login.ts');
  assert.equal(new Set(results.map((result) => result.filePath)).size, results.length);
  assert.equal(results.reduce((total, result) => total + result.content.length, 0) <= 8_000, true);
});

test('characterizes lexical path boosts, deterministic ties, and stop-word queries', () => {
  const pathBoostIndex = createEmptyProjectIndex('C:/repo');
  pathBoostIndex.files = [
    indexedFile('src/session/store.ts', 'export function saveState() {}'),
    indexedFile('src/util.ts', 'session session session session session')
  ];
  assert.equal(
    retrieveProjectChunks(pathBoostIndex, 'session')[0].relativePath,
    'src/session/store.ts'
  );

  const tiedIndex = createEmptyProjectIndex('C:/repo');
  tiedIndex.files = [
    indexedFile('src/b.ts', 'export const needle = true;'),
    indexedFile('src/a.ts', 'export const needle = true;')
  ];
  assert.deepEqual(
    retrieveProjectChunks(tiedIndex, 'needle').map((result) => result.relativePath),
    ['src/a.ts', 'src/b.ts']
  );
  assert.deepEqual(retrieveProjectChunks(tiedIndex, 'the and this'), []);
});

test('excludes explicitly attached files from local retrieval', () => {
  const index = createEmptyProjectIndex('C:/repo');
  const authFile = indexedFile('src/auth.ts', 'export function authenticateUser() {}');
  index.files = [authFile, indexedFile('src/user.ts', 'export function loadUser() {}')];

  const results = retrieveProjectChunks(index, 'authenticate user', {
    excludedFilePaths: new Set([authFile.filePath])
  });

  assert.equal(results.some((result) => result.filePath === authFile.filePath), false);
});

test('loads only a compatible index for the current workspace', () => {
  const index = createEmptyProjectIndex('C:/repo');
  index.files = [indexedFile('src/app.ts', 'export const app = true;')];

  assert.deepEqual(parseStoredProjectIndex(index, 'C:/repo'), index);
  assert.equal(parseStoredProjectIndex(index, 'C:/other'), undefined);
  assert.equal(parseStoredProjectIndex({ ...index, version: 999 }, 'C:/repo'), undefined);
});

function indexedFile(relativePath, content, size = content.length, modifiedAt = 1) {
  return createIndexedProjectFile({
    filePath: `C:/repo/${relativePath}`,
    relativePath,
    languageId: 'typescript',
    content
  }, size, modifiedAt);
}

function offsetRange(content, startOffset, endOffset) {
  return {
    start: positionAt(content, startOffset),
    end: positionAt(content, endOffset)
  };
}

function positionAt(content, offset) {
  const prefix = content.slice(0, offset);
  const line = (prefix.match(/\n/g) ?? []).length;
  const lastNewline = prefix.lastIndexOf('\n');
  return {
    line,
    character: offset - lastNewline - 1
  };
}
