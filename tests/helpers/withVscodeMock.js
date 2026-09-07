const Module = require('node:module');

// Scope the loader override to synchronous imports. Each test supplies only the
// VS Code surface it needs; no shared fake editor state leaks between suites.
function withVscodeMock(vscode, load) {
  const originalLoad = Module._load;
  Module._load = function loadWithVscodeMock(request, parent, isMain) {
    return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain);
  };
  try {
    return load();
  } finally {
    Module._load = originalLoad;
  }
}

module.exports = { withVscodeMock };
