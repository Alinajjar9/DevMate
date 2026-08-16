const fs = require('node:fs');
const path = require('node:path');

const repositoryRoot = path.resolve(__dirname, '..');
const sourceDirectory = path.join(repositoryRoot, 'src');
const outputDirectory = path.join(repositoryRoot, 'out');

function collectFiles(directory, extension) {
  if (!fs.existsSync(directory)) {
    return [];
  }

  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return collectFiles(entryPath, extension);
    }
    return entry.isFile() && entry.name.endsWith(extension) ? [entryPath] : [];
  });
}

function relativeFiles(directory, extension) {
  return collectFiles(directory, extension)
    .map((filePath) => path.relative(directory, filePath).split(path.sep).join('/'))
    .sort();
}

const expectedJavaScript = relativeFiles(sourceDirectory, '.ts')
  .filter((filePath) => !filePath.endsWith('.d.ts'))
  .map((filePath) => filePath.slice(0, -3) + '.js');
const emittedJavaScript = relativeFiles(outputDirectory, '.js');

const expectedSet = new Set(expectedJavaScript);
const emittedSet = new Set(emittedJavaScript);
const missing = expectedJavaScript.filter((filePath) => !emittedSet.has(filePath));
const orphaned = emittedJavaScript.filter((filePath) => !expectedSet.has(filePath));

if (missing.length > 0 || orphaned.length > 0) {
  const details = [
    missing.length > 0 ? `Missing emitted files:\n  ${missing.join('\n  ')}` : '',
    orphaned.length > 0 ? `Orphaned emitted files:\n  ${orphaned.join('\n  ')}` : ''
  ].filter(Boolean);
  throw new Error(`The out directory does not match src.\n${details.join('\n')}`);
}

console.log(`Verified ${emittedJavaScript.length} emitted JavaScript files against current TypeScript sources.`);
