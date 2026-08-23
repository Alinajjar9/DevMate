const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const test = require('node:test');

const {
  MAX_PROJECT_SEARCH_QUERY_BOOST,
  rankProjectSearchResults
} = require('../out/projectSearch/projectSearchRanking');

test('exact code identifiers can outrank a nearby conceptual-only match', () => {
  const conceptual = searchItem(
    'src/security/accessRules.ts',
    'export function authorizeRequest() { return policy.allows(); }\n'
  );
  const exact = searchItem(
    'src/auth/tokenValidator.ts',
    'export function validateAccessToken(token) { return token.length > 10; }\n'
  );

  const ranked = rankProjectSearchResults(
    [],
    [conceptual, exact],
    'Where is validateAccessToken implemented?',
    2
  );

  assert.deepEqual(ranked.map((result) => result.relativePath), [
    'src/auth/tokenValidator.ts',
    'src/security/accessRules.ts'
  ]);
});

test('filename and path terms improve precise module lookups', () => {
  const generic = searchItem(
    'src/files/changeApplication.ts',
    'export async function applyChange() {}\n'
  );
  const namedModule = searchItem(
    'src/security/workspaceMutations.ts',
    'export const mutationService = createService();\n'
  );

  const ranked = rankProjectSearchResults(
    [],
    [generic, namedModule],
    'Show me the workspace mutations module',
    2
  );

  assert.equal(ranked[0].relativePath, 'src/security/workspaceMutations.ts');
});

test('query-aware boosts are capped and cannot beat strong cross-strategy agreement', () => {
  const agreed = searchItem(
    'src/security/accessRules.ts',
    'export function authorizeRequest() { return true; }\n'
  );
  const exact = searchItem(
    'src/auth/tokenValidator.ts',
    'export function validateAccessToken() { return true; }\n'
  );
  const fillers = Array.from({ length: 19 }, (_, index) => searchItem(
    `src/filler-${index}.ts`,
    `export const filler${index} = true;\n`
  ));

  const ranked = rankProjectSearchResults(
    [agreed, ...fillers, exact],
    [agreed],
    'Where is validateAccessToken in tokenValidator?',
    30
  );
  const exactResult = ranked.find((result) => result.relativePath === exact.relativePath);
  const exactBaseScore = 1 / (60 + 21);

  assert.equal(ranked[0].relativePath, agreed.relativePath);
  assert.ok(exactResult);
  assert.ok(exactResult.score - exactBaseScore <= MAX_PROJECT_SEARCH_QUERY_BOOST + 1e-12);
});

test('ranking stays deterministic when a query has no useful code signals', () => {
  const beta = searchItem('src/beta.ts', 'export const beta = true;\n');
  const alpha = searchItem('src/alpha.ts', 'export const alpha = true;\n');

  const first = rankProjectSearchResults([], [beta, alpha], 'How does it work?', 2);
  const second = rankProjectSearchResults([], [beta, alpha], 'How does it work?', 2);

  assert.deepEqual(first, second);
  assert.deepEqual(first.map((result) => result.relativePath), [
    'src/beta.ts',
    'src/alpha.ts'
  ]);
});

function searchItem(relativePath, content) {
  return {
    relativePath,
    languageId: 'typescript',
    stableId: `${relativePath}:1-1:0`,
    ordinal: 0,
    startLine: 1,
    endLine: 1,
    content,
    contentHash: createHash('sha256').update(content).digest('hex'),
    score: 1
  };
}
