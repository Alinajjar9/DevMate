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
