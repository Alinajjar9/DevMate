const fs = require('node:fs');
const path = require('node:path');

const repositoryRoot = path.resolve(__dirname, '..');
const outputDirectory = path.resolve(repositoryRoot, 'out');

if (path.dirname(outputDirectory) !== repositoryRoot || path.basename(outputDirectory) !== 'out') {
  throw new Error(`Refusing to clean unexpected output directory: ${outputDirectory}`);
}

fs.rmSync(outputDirectory, { recursive: true, force: true });
