const assert = require('node:assert/strict');
const test = require('node:test');

const {
  extractMissingPythonModule,
  isPythonVerificationCommand,
  workspacePythonCandidates
} = require('../out/pythonEnvironment');

test('recognizes Python verification executables', () => {
  assert.equal(isPythonVerificationCommand({ executable: 'python', args: [], cwd: '', timeoutSeconds: 30 }), true);
  assert.equal(isPythonVerificationCommand({ executable: 'py.exe', args: [], cwd: '', timeoutSeconds: 30 }), true);
  assert.equal(isPythonVerificationCommand({ executable: 'pytest', args: [], cwd: '', timeoutSeconds: 30 }), false);
});

test('prefers a working-directory virtual environment before the workspace root', () => {
  assert.deepEqual(workspacePythonCandidates('backend', 'win32').slice(0, 4), [
    'backend/.venv/Scripts/python.exe',
    'backend/venv/Scripts/python.exe',
    'backend/env/Scripts/python.exe',
    '.venv/Scripts/python.exe'
  ]);
  assert.deepEqual(workspacePythonCandidates('', 'linux').slice(0, 2), [
    '.venv/bin/python',
    '.venv/bin/python3'
  ]);
});

test('extracts a missing Python package from unittest output', () => {
  assert.equal(
    extractMissingPythonModule("ModuleNotFoundError: No module named 'flask'"),
    'flask'
  );
  assert.equal(extractMissingPythonModule('FAILED (failures=1)'), undefined);
});
