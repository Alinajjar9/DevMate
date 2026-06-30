const assert = require('node:assert/strict');
const test = require('node:test');

const {
  parseInstallDependenciesArguments,
  validatePythonRequirementsManifest
} = require('../out/dependencyTools');

test('parses a workspace requirements manifest and derives its working directory', () => {
  assert.deepEqual(parseInstallDependenciesArguments({
    manifestPath: 'backend/requirements-dev.txt',
    timeoutSeconds: 600
  }), {
    manifestPath: 'backend/requirements-dev.txt',
    cwd: 'backend',
    timeoutSeconds: 600
  });
  assert.equal(parseInstallDependenciesArguments({
    manifestPath: 'requirements.txt'
  }).cwd, '');
});

test('accepts only simple registry requirements', () => {
  assert.deepEqual(validatePythonRequirementsManifest([
    '# Runtime dependencies',
    'Flask==3.1.3',
    'requests[security]>=2.32,<3',
    ''
  ].join('\n')), ['Flask==3.1.3', 'requests[security]>=2.32,<3']);
});

test('rejects unsafe manifests, paths, options, URLs, and environment markers', () => {
  for (const manifestPath of [
    '../requirements.txt',
    '.venv/requirements.txt',
    'pyproject.toml'
  ]) {
    assert.throws(() => parseInstallDependenciesArguments({ manifestPath }));
  }
  for (const requirement of [
    '-r other.txt',
    '--extra-index-url https://example.com/simple',
    'package @ https://example.com/package.whl',
    '../local-package',
    '-e .',
    'flask; python_version > "3.10"'
  ]) {
    assert.throws(() => validatePythonRequirementsManifest(requirement));
  }
});
