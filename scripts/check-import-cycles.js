const fs = require('node:fs');
const path = require('node:path');

const sourceRoot = path.resolve(__dirname, '..', 'src');

function collectTypeScriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return collectTypeScriptFiles(entryPath);
    }
    return entry.name.endsWith('.ts') ? [path.normalize(entryPath)] : [];
  });
}

function resolveLocalImport(importer, requestedPath, knownFiles) {
  const basePath = path.resolve(path.dirname(importer), requestedPath);
  const candidates = path.extname(basePath)
    ? [basePath]
    : [`${basePath}.ts`, path.join(basePath, 'index.ts')];

  return candidates.map(path.normalize).find((candidate) => knownFiles.has(candidate));
}

function readLocalImports(filePath, knownFiles) {
  const source = fs.readFileSync(filePath, 'utf8');
  const imports = [];
  const importPattern = /(?:from\s+|import\s*)['"](\.[^'"]+)['"]/g;

  for (const match of source.matchAll(importPattern)) {
    const resolved = resolveLocalImport(filePath, match[1], knownFiles);
    if (resolved && !imports.includes(resolved)) {
      imports.push(resolved);
    }
  }
  return imports;
}

function findCycle(graph) {
  const state = new Map();
  const stack = [];

  function visit(filePath) {
    state.set(filePath, 'visiting');
    stack.push(filePath);

    for (const dependency of graph.get(filePath) ?? []) {
      if (state.get(dependency) === 'visiting') {
        return [...stack.slice(stack.indexOf(dependency)), dependency];
      }
      if (!state.has(dependency)) {
        const cycle = visit(dependency);
        if (cycle) {
          return cycle;
        }
      }
    }

    stack.pop();
    state.set(filePath, 'visited');
    return undefined;
  }

  for (const filePath of graph.keys()) {
    if (!state.has(filePath)) {
      const cycle = visit(filePath);
      if (cycle) {
        return cycle;
      }
    }
  }
  return undefined;
}

const files = collectTypeScriptFiles(sourceRoot);
const knownFiles = new Set(files);
const graph = new Map(
  files.map((filePath) => [filePath, readLocalImports(filePath, knownFiles)])
);
const cycle = findCycle(graph);

if (cycle) {
  console.error('TypeScript import cycle found:');
  for (const filePath of cycle) {
    console.error(`  ${path.relative(sourceRoot, filePath).replaceAll('\\', '/')}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Verified ${files.length} TypeScript modules have no relative import cycles.`);
}
