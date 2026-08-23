const assert = require('node:assert/strict');
const test = require('node:test');

const { LexicalProjectRetriever } = require('../out/projectSearch/projectRetriever');
const {
  evaluateProjectRetriever,
  loadProjectRetrievalFixture
} = require('./helpers/projectRetrievalEvaluation');

test('loads a retrieval corpus spanning exact, conceptual, architectural, and ambiguous queries', () => {
  const fixture = loadProjectRetrievalFixture();

  assert.equal(fixture.files.length, 12);
  assert.equal(fixture.cases.length, 11);
  assert.deepEqual(
    [...new Set(fixture.cases.map((evaluationCase) => evaluationCase.category))].sort(),
    ['ambiguous', 'architecture', 'conceptual', 'exact-identifier', 'exact-text']
  );
});

test('records the current lexical retrieval quality baseline', async () => {
  const report = await evaluateProjectRetriever(
    new LexicalProjectRetriever(),
    loadProjectRetrievalFixture()
  );

  assert.deepEqual({
    caseCount: report.caseCount,
    topOneHits: report.topOneHits,
    topThreeHits: report.topThreeHits,
    meanReciprocalRank: report.meanReciprocalRank,
    meanRecallAtFive: report.meanRecallAtFive,
    missedCaseIds: report.missedCaseIds
  }, {
    caseCount: 11,
    topOneHits: 5,
    topThreeHits: 7,
    meanReciprocalRank: 0.5455,
    meanRecallAtFive: 0.6364,
    missedCaseIds: [
      'conceptual-workspace-escape',
      'conceptual-provider-recovery',
      'conceptual-terminal-diagnostics',
      'conceptual-linked-directory'
    ]
  });

  assert.deepEqual(report.byCategory.conceptual, {
    caseCount: 4,
    topOneHits: 0,
    meanRecallAtFive: 0
  });
  assert.deepEqual(report.byCategory['exact-identifier'], {
    caseCount: 4,
    topOneHits: 3,
    meanRecallAtFive: 1
  });

  const architectureCase = report.cases.find(
    (evaluationCase) => evaluationCase.id === 'architecture-chat-request-flow'
  );
  const ambiguousCase = report.cases.find(
    (evaluationCase) => evaluationCase.id === 'ambiguous-edit-permission'
  );
  assert.equal(architectureCase.recallAtFive, 1);
  assert.equal(ambiguousCase.firstRelevantRank, 2);
});
