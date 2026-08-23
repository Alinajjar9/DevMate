const fs = require('node:fs');
const path = require('node:path');

const {
  createEmptyProjectIndex,
  createIndexedProjectFile
} = require('../../out/projectSearch/projectIndex');

const DEFAULT_EVALUATION_LIMITS = Object.freeze({
  maxChunks: 5,
  maxCharacters: 40_000
});

function loadProjectRetrievalFixture(
  fixturePath = path.join(__dirname, '..', 'fixtures', 'project-retrieval-evaluation.json')
) {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  validateFixture(fixture);
  return fixture;
}

function buildEvaluationIndex(fixture) {
  const index = createEmptyProjectIndex(fixture.workspacePath);
  index.files = fixture.files.map((file, position) => createIndexedProjectFile({
    filePath: `${fixture.workspacePath}/${file.relativePath}`,
    relativePath: file.relativePath,
    languageId: file.languageId,
    content: file.content
  }, Buffer.byteLength(file.content, 'utf8'), position + 1));
  return index;
}

async function evaluateProjectRetriever(
  retriever,
  fixture,
  limits = DEFAULT_EVALUATION_LIMITS
) {
  const index = buildEvaluationIndex(fixture);
  const cases = [];

  for (const evaluationCase of fixture.cases) {
    const results = await retriever.retrieve({
      index,
      question: evaluationCase.question,
      limits
    });
    const rankedFiles = results.map((result) => result.relativePath);
    const relevantRanks = evaluationCase.relevantFiles.map((relevantFile) => {
      const resultIndex = rankedFiles.indexOf(relevantFile);
      return resultIndex < 0 ? null : resultIndex + 1;
    });
    const firstRelevantRank = relevantRanks
      .filter((rank) => rank !== null)
      .sort((left, right) => left - right)[0] ?? null;
    const relevantAtFive = relevantRanks.filter((rank) => rank !== null && rank <= 5).length;

    cases.push({
      id: evaluationCase.id,
      category: evaluationCase.category,
      rankedFiles,
      relevantRanks,
      firstRelevantRank,
      recallAtFive: relevantAtFive / evaluationCase.relevantFiles.length
    });
  }

  return createReport(cases);
}

function createReport(cases) {
  const categories = [...new Set(cases.map((evaluationCase) => evaluationCase.category))]
    .sort();
  return {
    caseCount: cases.length,
    topOneHits: cases.filter((evaluationCase) => evaluationCase.firstRelevantRank === 1).length,
    topThreeHits: cases.filter((evaluationCase) =>
      evaluationCase.firstRelevantRank !== null && evaluationCase.firstRelevantRank <= 3
    ).length,
    meanReciprocalRank: average(cases.map((evaluationCase) =>
      evaluationCase.firstRelevantRank === null ? 0 : 1 / evaluationCase.firstRelevantRank
    )),
    meanRecallAtFive: average(cases.map((evaluationCase) => evaluationCase.recallAtFive)),
    missedCaseIds: cases
      .filter((evaluationCase) => evaluationCase.firstRelevantRank === null)
      .map((evaluationCase) => evaluationCase.id),
    byCategory: Object.fromEntries(categories.map((category) => {
      const categoryCases = cases.filter((evaluationCase) => evaluationCase.category === category);
      return [category, {
        caseCount: categoryCases.length,
        topOneHits: categoryCases.filter((evaluationCase) =>
          evaluationCase.firstRelevantRank === 1
        ).length,
        meanRecallAtFive: average(categoryCases.map((evaluationCase) =>
          evaluationCase.recallAtFive
        ))
      }];
    })),
    cases
  };
}

function validateFixture(fixture) {
  if (!fixture
    || fixture.version !== 1
    || typeof fixture.workspacePath !== 'string'
    || !Array.isArray(fixture.files)
    || fixture.files.length === 0
    || !Array.isArray(fixture.cases)
    || fixture.cases.length === 0) {
    throw new Error('The project retrieval evaluation fixture is invalid.');
  }

  const filePaths = fixture.files.map((file) => file.relativePath);
  if (filePaths.some((filePath) => typeof filePath !== 'string')
    || new Set(filePaths).size !== filePaths.length
    || fixture.files.some((file) =>
      typeof file.languageId !== 'string' || typeof file.content !== 'string'
    )) {
    throw new Error('The project retrieval evaluation files are invalid.');
  }

  const caseIds = fixture.cases.map((evaluationCase) => evaluationCase.id);
  if (caseIds.some((caseId) => typeof caseId !== 'string')
    || new Set(caseIds).size !== caseIds.length) {
    throw new Error('The project retrieval evaluation case identifiers are invalid.');
  }

  const knownFiles = new Set(filePaths);
  for (const evaluationCase of fixture.cases) {
    if (typeof evaluationCase.category !== 'string'
      || typeof evaluationCase.question !== 'string'
      || !Array.isArray(evaluationCase.relevantFiles)
      || evaluationCase.relevantFiles.length === 0
      || evaluationCase.relevantFiles.some((filePath) => !knownFiles.has(filePath))) {
      throw new Error(`Project retrieval evaluation case ${evaluationCase.id} is invalid.`);
    }
  }
}

function average(values) {
  if (values.length === 0) {
    return 0;
  }
  return Number((values.reduce((total, value) => total + value, 0) / values.length).toFixed(4));
}

module.exports = {
  DEFAULT_EVALUATION_LIMITS,
  buildEvaluationIndex,
  evaluateProjectRetriever,
  loadProjectRetrievalFixture
};
