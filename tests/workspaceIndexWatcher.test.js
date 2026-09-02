const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');

const workspaceFolderListeners = new Set();
const renameListeners = new Set();
const watchers = [];
const rootPath = process.platform === 'win32' ? 'C:\\repo' : '/repo';
const folder = {
  name: 'Project',
  uri: createUri(rootPath)
};

class RelativePattern {
  constructor(base, pattern) {
    this.base = base;
    this.pattern = pattern;
  }
}

class FakeFileSystemWatcher {
  constructor(pattern) {
    this.pattern = pattern;
    this.createListeners = new Set();
    this.changeListeners = new Set();
    this.deleteListeners = new Set();
    this.disposed = false;
  }

  onDidCreate(listener) {
    return addListener(this.createListeners, listener);
  }

  onDidChange(listener) {
    return addListener(this.changeListeners, listener);
  }

  onDidDelete(listener) {
    return addListener(this.deleteListeners, listener);
  }

  fire(kind, uri) {
    const listeners = kind === 'create'
      ? this.createListeners
      : kind === 'change'
        ? this.changeListeners
        : this.deleteListeners;
    for (const listener of listeners) {
      listener(uri);
    }
  }

  dispose() {
    this.disposed = true;
    this.createListeners.clear();
    this.changeListeners.clear();
    this.deleteListeners.clear();
  }
}

const vscode = {
  RelativePattern,
  workspace: {
    workspaceFolders: [folder],
    createFileSystemWatcher: (pattern) => {
      const watcher = new FakeFileSystemWatcher(pattern);
      watchers.push(watcher);
      return watcher;
    },
    onDidChangeWorkspaceFolders: (listener) => addListener(
      workspaceFolderListeners,
      listener
    ),
    onDidRenameFiles: (listener) => addListener(renameListeners, listener)
  }
};

const originalModuleLoad = Module._load;
Module._load = function loadWithVscodeMock(request, parent, isMain) {
  if (request === 'vscode') {
    return vscode;
  }
  return originalModuleLoad.call(this, request, parent, isMain);
};
const {
  VsCodeWorkspaceIndexChangeSource,
  WorkspaceIndexCoordinator
} = require('../out/projectSearch/workspaceIndexWatcher');
Module._load = originalModuleLoad;

const ACCESS = {
  backendUrl: 'http://127.0.0.1:8000',
  backendToken: 'test-backend-token-that-is-long-enough'
};

test('coordinator starts immediately and debounces a burst into one synchronization', async () => {
  const changes = manualChangeSource();
  const timer = manualTimer();
  const calls = [];
  const coordinator = new WorkspaceIndexCoordinator(
    changes,
    async (access, signal) => {
      calls.push({ access, signal });
      return completedResult();
    },
    750,
    timer
  );

  coordinator.setBackendAccess(ACCESS);
  assert.equal(calls.length, 1);
  await settlePromises();

  changes.emit();
  changes.emit();
  changes.emit();

  assert.equal(timer.pendingCount(), 1);
  assert.deepEqual(timer.delays(), [750]);
  timer.runAll();
  await settlePromises();

  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.access), [ACCESS, ACCESS]);
  coordinator.dispose();
  assert.equal(changes.disposed, true);
});

test('changes during an active synchronization produce one trailing run', async () => {
  const changes = manualChangeSource();
  const timer = manualTimer();
  const firstRun = deferred();
  let callCount = 0;
  const coordinator = new WorkspaceIndexCoordinator(
    changes,
    async () => {
      callCount += 1;
      if (callCount === 1) {
        await firstRun.promise;
      }
      return completedResult();
    },
    500,
    timer
  );

  coordinator.setBackendAccess(ACCESS);
  changes.emit();
  changes.emit();
  assert.equal(callCount, 1);
  assert.equal(timer.pendingCount(), 0);

  firstRun.resolve();
  await settlePromises();
  assert.equal(timer.pendingCount(), 1);
  timer.runAll();
  await settlePromises();

  assert.equal(callCount, 2);
  coordinator.dispose();
});

test('coordinator cancels work without backend access and resumes with a new token', async () => {
  const changes = manualChangeSource();
  const timer = manualTimer();
  const firstRun = deferred();
  const calls = [];
  const coordinator = new WorkspaceIndexCoordinator(
    changes,
    async (access, signal) => {
      calls.push({ access, signal });
      if (calls.length === 1) {
        await firstRun.promise;
      }
      return signal.aborted ? { kind: 'cancelled' } : completedResult();
    },
    500,
    timer
  );

  coordinator.setBackendAccess(ACCESS);
  coordinator.setBackendAccess(undefined);
  assert.equal(calls[0].signal.aborted, true);

  changes.emit();
  assert.equal(timer.pendingCount(), 0);

  const replacementAccess = {
    ...ACCESS,
    backendToken: 'replacement-backend-token-that-is-long-enough'
  };
  coordinator.setBackendAccess(replacementAccess);
  assert.equal(calls.length, 1);

  firstRun.resolve();
  await settlePromises();

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].access, replacementAccess);
  assert.equal(calls[1].signal.aborted, false);
  coordinator.dispose();
});

test('VS Code change source filters ignored paths and rebuilds for workspace changes', () => {
  watchers.length = 0;
  workspaceFolderListeners.clear();
  renameListeners.clear();
  const source = new VsCodeWorkspaceIndexChangeSource();
  let changes = 0;
  source.onDidChange(() => {
    changes += 1;
  });

  assert.equal(watchers.length, 1);
  assert.equal(watchers[0].pattern.base, folder);
  assert.equal(watchers[0].pattern.pattern, '**/*');

  watchers[0].fire('change', createUri(path.join(rootPath, 'src', 'app.ts')));
  watchers[0].fire('create', createUri(path.join(rootPath, 'out', 'generated.js')));
  watchers[0].fire('delete', createUri(path.join(rootPath, 'src', 'app.js.map')));
  watchers[0].fire('change', createUri(path.join(path.dirname(rootPath), 'outside.ts')));
  assert.equal(changes, 1);

  emit(renameListeners, {
    files: [{
      oldUri: createUri(path.join(rootPath, 'src', 'old.ts')),
      newUri: createUri(path.join(rootPath, 'src', 'new.ts'))
    }]
  });
  assert.equal(changes, 2);

  emit(workspaceFolderListeners, { added: [], removed: [] });
  assert.equal(changes, 3);
  assert.equal(watchers[0].disposed, true);
  assert.equal(watchers.length, 2);

  source.dispose();
  assert.equal(watchers[1].disposed, true);
  assert.equal(workspaceFolderListeners.size, 0);
  assert.equal(renameListeners.size, 0);
});

function createUri(fsPath) {
  return {
    scheme: 'file',
    fsPath,
    toString: () => `file://${fsPath.replace(/\\/g, '/')}`
  };
}

function addListener(listeners, listener) {
  listeners.add(listener);
  return {
    dispose: () => listeners.delete(listener)
  };
}

function emit(listeners, event) {
  for (const listener of listeners) {
    listener(event);
  }
}

function manualChangeSource() {
  const listeners = new Set();
  return {
    disposed: false,
    onDidChange(listener) {
      return addListener(listeners, listener);
    },
    emit() {
      emit(listeners);
    },
    dispose() {
      this.disposed = true;
      listeners.clear();
    }
  };
}

function manualTimer() {
  let nextId = 1;
  const tasks = new Map();
  return {
    schedule(callback, delayMilliseconds) {
      const id = nextId;
      nextId += 1;
      tasks.set(id, { callback, delayMilliseconds });
      return id;
    },
    cancel(handle) {
      tasks.delete(handle);
    },
    pendingCount() {
      return tasks.size;
    },
    delays() {
      return [...tasks.values()].map((task) => task.delayMilliseconds);
    },
    runAll() {
      const pending = [...tasks.values()];
      tasks.clear();
      for (const task of pending) {
        task.callback();
      }
    }
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function completedResult() {
  return {
    kind: 'completed',
    workspaceKey: 'workspace:test',
    indexState: 'ready',
    scannedFiles: 0,
    indexedFiles: 0,
    deletedFiles: 0,
    unchangedFiles: 0,
    unavailableFiles: 0
  };
}

async function settlePromises() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
