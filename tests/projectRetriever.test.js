const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createEmptyProjectIndex,
  createIndexedProjectFile,
  retrieveProjectChunks
} = require('../out/projectIndex');
const { LexicalProjectRetriever } = require('../out/projectRetriever');

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

function indexedFile(relativePath, content) {
  return createIndexedProjectFile({
    filePath: `C:/repo/${relativePath}`,
    relativePath,
    languageId: 'typescript',
    content
  }, content.length, 1);
}
