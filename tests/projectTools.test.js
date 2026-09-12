const assert = require('node:assert/strict');
const test = require('node:test');
const {
  collectProjectInfo, matchesSearchLine, matchesSearchFilePattern, normalizeSearchFilePattern,
  parseGitStatus, readGitChanges, searchCodeSnippets
} = require('../out/projectTools');

test('project discovery reports real package scripts and nested runtimes without exposing script bodies', async () => {
  const files = new Map([
    ['package.json', JSON.stringify({ packageManager: 'pnpm@9.0.0', workspaces: ['apps/*'],
      dependencies: { react: '^19' }, devDependencies: { typescript: '^5' },
      scripts: { verify: 'API_KEY=private-script-body node check.js', build: 'compiler', dev: 'server' } })],
    ['backend/pyproject.toml', '[project]\ndependencies = ["fastapi", "pytest"]'],
    ['rust/Cargo.toml', '[workspace]\nmembers = ["app"]'],
    ['service/go.mod', 'module example.com/app'],
    ['desktop/App.csproj', '<Project />'],
    ['jvm/pom.xml', '<project />'],
    ['src/app.ts', 'source that should not be read for manifest discovery']
  ]);
  const reads = [];
  const summary = await collectProjectInfo([...files.keys()], async name => { reads.push(name); return files.get(name); });
  assert.match(summary.result, /package manager: pnpm/);
  assert.match(summary.result, /React, TypeScript/);
  assert.match(summary.result, /Available scripts: verify, build, dev/);
  assert.match(summary.result, /pnpm run verify/);
  assert.match(summary.result, /python -m pytest/);
  assert.match(summary.result, /Cargo workspace/);
  assert.match(summary.result, /go test/);
  assert.match(summary.result, /dotnet build/);
  assert.match(summary.result, /mvn verify/);
  assert.doesNotMatch(summary.result, /private-script-body|API_KEY=/);
  assert.equal(reads.includes('src/app.ts'), false);
  assert.deepEqual(summary.usedFiles, reads);
});

test('project discovery scopes nested manifests, tolerates malformed JSON and caps work', async () => {
  const files = new Map([['package.json', '{}'], ['app/package.json', '{broken'], ['app/pyproject.toml', '[project]'],
    ['apple/package.json', '{}'], ['../private/package.json', '{}']]);
  const scoped = await collectProjectInfo([...files.keys()], async name => files.get(name), 'app');
  assert.deepEqual(scoped.usedFiles, ['app/package.json', 'app/pyproject.toml']);
  assert.match(scoped.result, /Could not parse package.json/);
  assert.doesNotMatch(scoped.result, /apple\/|private/);
  await assert.rejects(collectProjectInfo([], async () => '', '../private'), /within the workspace/);
  let reads = 0;
  const many = await collectProjectInfo(Array.from({ length: 100 }, (_, index) => `app${index}/package.json`),
    async () => { reads += 1; return '{}'; });
  assert.ok(reads <= 24);
  assert.ok(many.result.length <= 10_000);
  assert.match(many.result, /additional manifests omitted/);
});

test('literal search supports case, Unicode identifier boundaries and real context line ranges', () => {
  assert.equal(matchesSearchLine('const a.b = 1', 'a.b'), true);
  assert.equal(matchesSearchLine('const axb = 1', 'a.b'), false);
  assert.equal(matchesSearchLine('const TOKEN = 1', 'token'), true);
  assert.equal(matchesSearchLine('const TOKEN = 1', 'token', { caseSensitive: true }), false);
  for (const value of ['myToken', 'token_value', '$token', 'tokené', 'étoken']) {
    assert.equal(matchesSearchLine(value, 'token', { wholeWord: true }), false, value);
  }
  assert.equal(matchesSearchLine('token + other', 'token', { wholeWord: true }), true);
  assert.deepEqual(searchCodeSnippets('before\r\nTOKEN\r\nafter\r\nlast', 'token', { contextLines: 1 }), [
    { line: 2, startLine: 1, endLine: 3, text: 'before\nTOKEN\nafter' }
  ]);
  assert.equal(searchCodeSnippets('token\ntoken\ntoken', 'token', { maxResults: 2 }).length, 2);
});

test('file globs match root and nested files without allowing traversal or regex query syntax', () => {
  for (const file of ['app.ts', 'src/app.ts', 'src/deep/app.ts']) {
    assert.equal(matchesSearchFilePattern(file, '**/*.ts'), true, file);
    assert.equal(matchesSearchFilePattern(file, '*.ts'), true, file);
  }
  assert.equal(matchesSearchFilePattern('src/app.tsx', '**/*.{ts,tsx}'), true);
  assert.equal(matchesSearchFilePattern('other/app.ts', 'src/*.ts'), false);
  assert.equal(matchesSearchFilePattern('src/deep/app.ts', 'src/*.ts'), false);
  assert.equal(matchesSearchFilePattern('src/deep/app.ts', 'src/**/*.ts'), true);
  assert.equal(matchesSearchFilePattern('src/a.ts', 'src/?.ts'), true);
  assert.equal(matchesSearchFilePattern('src/ab.ts', 'src/?.ts'), false);
  assert.equal(normalizeSearchFilePattern('src\\*.ts'), 'src/*.ts');
  for (const pattern of ['../*.ts', '/tmp/*.ts', 'C:/repo/*', '**/*.{ts,{tsx,js}}', '*.[tj]s']) {
    assert.throws(() => normalizeSearchFilePattern(pattern));
  }
});

test('Git status parsing preserves spaces and tracks both paths of a rename', () => {
  assert.deepEqual(parseGitStatus(' M src/my file.ts\0R  src/new.ts\0src/old.ts\0?? new.txt\0'), [
    { status: ' M', path: 'src/my file.ts' },
    { status: 'R ', path: 'src/new.ts', originalPath: 'src/old.ts' },
    { status: '??', path: 'new.txt' }
  ]);
});

test('Git inspection filters protected paths before diffing and disables executable Git drivers', async () => {
  const calls = [];
  const result = await readGitChanges({ rootPath: 'C:/repo', isPathAllowed: async name => !name.includes('secret') }, async args => {
    calls.push(args);
    if (args.includes('config')) return 'filter.lfs.clean\0filter.lfs.process\0filter.custom.required\0';
    assert.ok(args.includes('filter.lfs.clean='));
    assert.ok(args.includes('filter.lfs.process='));
    assert.ok(args.includes('filter.custom.required=false'));
    assert.ok(args.includes('core.fsmonitor=false'));
    assert.ok(args.includes('--no-optional-locks'));
    if (args.includes('status')) return ' M src/app.ts\0 M secret.env\0R  src/new.ts\0secret-old.ts\0?? src/new.txt\0';
    if (args.includes('symbolic-ref')) return 'component\n';
    assert.equal(args.at(-1), 'src/app.ts');
    assert.ok(args.includes('--no-ext-diff'));
    assert.ok(args.includes('--no-textconv'));
    assert.ok(args.includes('--literal-pathspecs'));
    return 'diff --git a/src/app.ts b/src/app.ts\n+api_key=private-test-value\n+const value = 1;\n';
  });
  assert.equal(calls.filter(args => args.includes('diff')).length, 1);
  assert.match(result.result, /Branch: component/);
  assert.match(result.result, /const value = 1/);
  assert.match(result.result, /\[REDACTED\]/);
  assert.match(result.result, /Untracked file contents are omitted/);
  assert.doesNotMatch(result.result, /secret|private-test-value|src\/new.ts/);
  assert.deepEqual(result.usedFiles, ['src/app.ts']);
});

test('Git staged inspection uses a literal scoped path, bounds output and stops on cancellation', async () => {
  const paths = [];
  const result = await readGitChanges({ rootPath: 'C:/repo', path: 'src/a[1].ts', staged: true,
    isPathAllowed: async name => { paths.push(name); return true; } }, async args => {
    if (args.includes('config')) { const missing = new Error('No filters'); missing.code = 1; throw missing; }
    if (args.includes('status')) return 'M  src/a[1].ts\0 M other.ts\0';
    if (args.includes('symbolic-ref')) return 'component';
    assert.ok(args.includes('--cached'));
    assert.equal(args.at(-1), 'src/a[1].ts');
    return '+line\n'.repeat(5000);
  });
  assert.deepEqual(paths, ['src/a[1].ts']);
  assert.ok(result.result.length <= 10_000);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readGitChanges({ rootPath: 'C:/repo', signal: controller.signal, isPathAllowed: async () => true },
    async () => assert.fail('Cancelled inspection must not invoke Git')), /cancelled/);
  await assert.rejects(readGitChanges({ rootPath: 'C:/repo', path: '../outside', isPathAllowed: async () => true },
    async () => assert.fail('Traversal must not invoke Git')), /within the workspace/);
});

test('Git inspection fails closed when filter driver names cannot be disabled safely', async () => {
  let calls = 0;
  await assert.rejects(readGitChanges({ rootPath: 'C:/repo', isPathAllowed: async () => true }, async args => {
    calls += 1;
    assert.ok(args.includes('config'));
    return 'filter.unsupported driver.clean\0';
  }), /safely inspected/);
  assert.equal(calls, 1);
});
