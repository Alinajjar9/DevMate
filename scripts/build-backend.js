const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const virtualEnvironmentPython = process.platform === 'win32'
  ? path.join(root, '.venv', 'Scripts', 'python.exe')
  : path.join(root, '.venv', 'bin', 'python');
const python = process.env.DEVMATE_BUILD_PYTHON
  || (fs.existsSync(virtualEnvironmentPython) ? virtualEnvironmentPython : 'python');
const platformTarget = `${process.platform}-${process.arch}`;
const runtimeRoot = path.join(root, 'backend-runtime', platformTarget);
const workRoot = path.join(root, '.pyinstaller-build');

const result = spawnSync(python, [
  '-m',
  'PyInstaller',
  '--noconfirm',
  '--clean',
  '--onedir',
  '--name',
  'devmate-backend',
  '--distpath',
  runtimeRoot,
  '--workpath',
  workRoot,
  '--specpath',
  workRoot,
  path.join(root, 'backend', 'run_backend.py')
], {
  cwd: root,
  stdio: 'inherit'
});

if (result.error) {
  console.error(`Could not start the backend build: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
