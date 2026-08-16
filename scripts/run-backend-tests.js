const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repositoryRoot = path.resolve(__dirname, '..');
const virtualEnvironmentPython = process.platform === 'win32'
  ? path.join(repositoryRoot, '.venv', 'Scripts', 'python.exe')
  : path.join(repositoryRoot, '.venv', 'bin', 'python');

const candidates = process.env.PYTHON
  ? [process.env.PYTHON]
  : [
      ...(fs.existsSync(virtualEnvironmentPython) ? [virtualEnvironmentPython] : []),
      process.platform === 'win32' ? 'python' : 'python3'
    ];

const arguments = [
  '-m',
  'unittest',
  'discover',
  '-s',
  'backend/tests',
  '-p',
  'test_*.py',
  '-v'
];

for (const candidate of candidates) {
  console.log(`Running backend tests with ${candidate}`);
  const result = spawnSync(candidate, arguments, {
    cwd: repositoryRoot,
    stdio: 'inherit'
  });

  if (!result.error) {
    process.exit(result.status ?? 1);
  }
  if (result.error.code !== 'ENOENT') {
    throw result.error;
  }
}

throw new Error(`Could not find a Python interpreter. Tried: ${candidates.join(', ')}`);
