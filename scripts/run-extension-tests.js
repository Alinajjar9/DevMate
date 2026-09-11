const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repositoryRoot = path.resolve(__dirname, '..');
const testsDirectory = path.join(repositoryRoot, 'tests');
const testFiles = fs.readdirSync(testsDirectory)
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => path.join(testsDirectory, name));

// Limit discovery to this project; release/source may contain another source copy.
const result = spawnSync(process.execPath, ['--test', ...testFiles], {
  cwd: repositoryRoot,
  stdio: 'inherit'
});

if (result.error) {
  throw result.error;
}
process.exit(result.status ?? 1);
