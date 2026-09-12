const assert = require('node:assert/strict');
const test = require('node:test');
const { parseRunCommandArguments: parse, parseCommandAccess, commandExecutionArguments } = require('../out/commandTools');
const { canRememberCommandApproval } = require('../out/permissions');

test('Standard adds bounded inspection and verify/compile commands', () => {
  for (const command of [
    'npm run verify', 'pnpm run compile', 'node --version', 'python --version',
    'npm list --depth=1 --json', 'python -m pip list --format=json', 'python -m pip show pytest',
    'git status --short', 'git diff --stat -- src/index.ts', 'git log --oneline --max-count=5'
  ]) { assert.doesNotThrow(() => parse({ command }), command); }
  assert.equal(parseCommandAccess({ extended: true }), 'standard');
  assert.equal(parseCommandAccess('extended'), 'extended');
});

test('Git inspection cannot select external helpers, pagers, arbitrary config or writes', () => {
  for (const command of ['git -c alias.x=bad status', 'git diff --output=README.md',
    'git log --max-count=100000', 'git diff --ext-diff', 'git status --ignore-submodules',
    'git checkout main', 'git log --format=anything']) {
    assert.throws(() => parse({ command }, 'extended'), command);
  }
  const args = commandExecutionArguments(parse({ command: 'git diff --stat -- a.ts' }));
  assert.ok(args.includes('--no-pager'));
  assert.ok(args.includes('core.fsmonitor=false'));
  assert.ok(args.includes('--no-ext-diff'));
  assert.ok(args.includes('--no-textconv'));
  assert.deepEqual(args.slice(-3), ['--stat', '--', 'a.ts']);
});

test('Extended supports project scripts, fixes, installs and explicitly tracked servers', () => {
  for (const command of ['node scripts/generate.js', 'python scripts/analyse.py',
    'npx --no-install prettier --write src', 'npx --no-install eslint --fix src',
    'ruff check --fix .', 'npm run codegen', 'pnpm install --frozen-lockfile',
    'npm install --save-dev typescript@5.9.3', 'yarn add lodash']) {
    assert.doesNotThrow(() => parse({ command }, 'extended'), command);
    assert.throws(() => parse({ command }), command);
  }
  assert.equal(parse({ command: 'npm run dev', background: true }, 'extended').background, true);
  assert.throws(() => parse({ command: 'npm run dev' }, 'extended'), /background/);
  assert.throws(() => parse({ command: 'npm run dev', background: true }), /Extended/);
  assert.throws(() => parse({ command: 'npm run build', background: true }, 'extended'), /dev\/start\/serve/);
});

test('Deferred parsing is not permission and retains common structural restrictions', () => {
  assert.doesNotThrow(() => parse({ command: 'npm install' }, 'deferred'));
  assert.throws(() => parse({ command: 'npm install' }));
  for (const command of ['node -e bad', 'python -c bad', 'npm install -g typescript',
    'npm install --prefix=other', 'npm install https://example.com/code.tgz',
    'npm run deploy', 'npm publish', 'bash script.sh', 'powershell -Command bad',
    'npm test --script-shell=anything']) {
    assert.throws(() => parse({ command }, 'extended'), command);
  }
  assert.throws(() => parse({ command: 'node scripts/a.js && whoami' }, 'deferred'));
  assert.throws(() => parse({ command: 'node scripts/a.js', cwd: 'foo:stream' }, 'extended'));
  assert.throws(() => parse({ command: 'npm test', background: 'true' }, 'deferred'));
  assert.equal(canRememberCommandApproval('extended', true), false);
  assert.equal(canRememberCommandApproval('standard', false), false);
  assert.equal(canRememberCommandApproval('standard', true), true);
});
