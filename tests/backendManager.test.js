const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  backendLaunchArguments,
  backendStatusLabel,
  bundledBackendLaunchCandidate,
  LocalBackendManager,
  parseLocalBackendTarget,
  pythonLaunchCandidates
} = require('../out/backendManager');

test('manager source handles synchronous process-launch failures', () => {
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'src', 'backendManager.ts'),
    'utf8'
  );
  assert.match(source, /try \{[\s\S]*?child = spawn\(/);
  assert.match(source, /Could not launch/);
});

test('accepts only manageable loopback backend targets', () => {
  assert.deepEqual(parseLocalBackendTarget('http://127.0.0.1:8000'), {
    url: 'http://127.0.0.1:8000',
    host: '127.0.0.1',
    port: 8000
  });
  assert.equal(parseLocalBackendTarget('http://localhost:8123').host, '127.0.0.1');
  assert.equal(parseLocalBackendTarget('http://[::1]:9000').host, '::1');
  for (const value of [
    'https://127.0.0.1:8000',
    'http://backend.example.com:8000',
    'http://127.0.0.1',
    'http://127.0.0.1:80',
    'http://user:pass@127.0.0.1:8000',
    'http://127.0.0.1:8000/api'
  ]) {
    assert.equal(parseLocalBackendTarget(value), undefined);
  }
});

test('adopts a healthy existing backend without claiming ownership', async () => {
  const statuses = [];
  const manager = new LocalBackendManager({
    extensionPath: 'C:\\DevMate',
    getBackendUrl: () => 'http://127.0.0.1:8000',
    isManagementEnabled: () => true,
    getConfiguredPythonPath: () => '',
    healthCheck: async () => true,
    fileExists: () => false,
    onStatus: (status) => statuses.push(status),
    onOutput: () => undefined
  });
  try {
    assert.equal(await manager.start(), true);
    assert.equal(manager.status.state, 'online');
    assert.equal(manager.status.managed, false);
    assert.equal(manager.status.canRestart, false);
    assert.match(manager.status.detail, /existing local backend/);
    assert.equal(statuses.at(-1).state, 'online');
  } finally {
    manager.dispose();
  }
});

test('reports missing bundled backend files without launching a process', async () => {
  const manager = new LocalBackendManager({
    extensionPath: 'C:\\DevMate',
    getBackendUrl: () => 'http://127.0.0.1:8000',
    isManagementEnabled: () => true,
    getConfiguredPythonPath: () => '',
    healthCheck: async () => false,
    fileExists: () => false,
    onStatus: () => undefined,
    onOutput: () => undefined
  });
  try {
    assert.equal(await manager.start(), false);
    assert.equal(manager.status.state, 'offline');
    assert.match(manager.status.detail, /backend files are missing/);
  } finally {
    manager.dispose();
  }
});

test('prefers configured and extension-local Python launchers', () => {
  const root = path.join('C:', 'DevMate');
  const windows = pythonLaunchCandidates(root, 'C:\\Python\\python.exe', 'win32');
  assert.equal(windows[0].executable, 'C:\\Python\\python.exe');
  assert.match(windows[1].executable.replace(/\\/g, '/'), /\.venv\/Scripts\/python\.exe$/);
  assert.deepEqual(windows.at(-1).prefixArgs, ['-3']);

  const unix = pythonLaunchCandidates('/opt/devmate', '', 'linux');
  assert.equal(unix[0].executable, '/opt/devmate/.venv/bin/python');
  assert.equal(unix.at(-1).executable, 'python');
});

test('finds the standalone backend for the current platform build', () => {
  const windows = bundledBackendLaunchCandidate('C:\\DevMate', 'win32', 'x64');
  assert.equal(windows.kind, 'standalone');
  assert.match(
    windows.executable.replace(/\\/g, '/'),
    /backend-runtime\/win32-x64\/devmate-backend\/devmate-backend\.exe$/
  );

  const linux = bundledBackendLaunchCandidate('/opt/devmate', 'linux', 'arm64');
  assert.match(
    linux.executable,
    /backend-runtime\/linux-arm64\/devmate-backend\/devmate-backend$/
  );

  assert.deepEqual(
    backendLaunchArguments(windows, {
      url: 'http://127.0.0.1:8123', host: '127.0.0.1', port: 8123
    }),
    ['--host', '127.0.0.1', '--port', '8123']
  );
  assert.deepEqual(
    backendLaunchArguments({
      executable: 'py', prefixArgs: ['-3'], label: 'Python', kind: 'python'
    }, {
      url: 'http://127.0.0.1:8123', host: '127.0.0.1', port: 8123
    }),
    ['-3', '-m', 'uvicorn', 'backend.app.main:app', '--host', '127.0.0.1', '--port', '8123']
  );
});

test('formats managed backend states for compact UI', () => {
  assert.equal(backendStatusLabel({
    state: 'online', detail: '', managed: true, canRestart: true
  }), 'Backend online');
  assert.equal(backendStatusLabel({
    state: 'online', detail: '', managed: false, canRestart: false
  }), 'Backend online · external');
  assert.equal(backendStatusLabel({
    state: 'restarting', detail: '', managed: true, canRestart: false
  }), 'Backend restarting');
  assert.equal(backendStatusLabel({
    state: 'offline', detail: '', managed: false, canRestart: true
  }), 'Backend offline');
});
