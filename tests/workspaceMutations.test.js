const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');

class MockFileSystemError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

class MockWorkspaceEdit {
  replace() {}
  createFile() {}
  insert() {}
  deleteFile() {}
  renameFile() {}
}

class MockPosition {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
}

class MockRange {
  constructor(start, end) {
    this.start = start;
    this.end = end;
  }
}

function createUri(fsPath) {
  const normalized = fsPath.replace(/\\/g, '/');
  return {
    scheme: 'file',
    fsPath,
    path: normalized,
    toString() {
      return `file:///${normalized.replace(/^\/+/, '')}`;
    }
  };
}

const folder = {
  name: 'Project A',
  uri: createUri('C:\\repo')
};
const entries = new Map();
let applyEditCalls = 0;

function entryKey(uri) {
  return uri.fsPath.replace(/\\/g, '/').toLocaleLowerCase('en-US');
}

function addDirectory(relativePath, type = 2) {
  const entry = {
    type,
    content: '',
    dirty: false
  };
  entries.set(entryKey(createUri(path.win32.join(folder.uri.fsPath, relativePath))), entry);
  return entry;
}

function addFile(relativePath, content, dirty = false) {
  const entry = {
    type: 1,
    content,
    dirty,
    saveResult: true
  };
  entries.set(entryKey(createUri(path.win32.join(folder.uri.fsPath, relativePath))), entry);
  return entry;
}

const vscode = {
  FileType: {
    File: 1,
    Directory: 2,
    SymbolicLink: 64
  },
  FileSystemError: MockFileSystemError,
  Position: MockPosition,
  Range: MockRange,
  Uri: {
    joinPath: (base, ...segments) => createUri(path.win32.join(base.fsPath, ...segments))
  },
  ViewColumn: { One: 1 },
  WorkspaceEdit: MockWorkspaceEdit,
  workspace: {
    workspaceFolders: [folder],
    isTrusted: true,
    fs: {
      stat: async (uri) => {
        const entry = entries.get(entryKey(uri));
        if (!entry) {
          throw new MockFileSystemError(`${uri.fsPath} was not found`, 'FileNotFound');
        }
        return {
          type: entry.type,
          size: Buffer.byteLength(entry.content),
          ctime: 1,
          mtime: 1
        };
      },
      readFile: async (uri) => {
        const entry = entries.get(entryKey(uri));
        if (!entry) {
          throw new MockFileSystemError(`${uri.fsPath} was not found`, 'FileNotFound');
        }
        return new TextEncoder().encode(entry.content);
      },
      createDirectory: async () => undefined
    },
    openTextDocument: async (uri) => {
      const entry = entries.get(entryKey(uri));
      if (!entry || (entry.type & 1) === 0) {
        throw new MockFileSystemError(`${uri.fsPath} was not found`, 'FileNotFound');
      }
      return {
        uri,
        get isDirty() {
          return entry.dirty;
        },
        getText: () => entry.content,
        positionAt: (offset) => new MockPosition(0, offset),
        save: async () => entry.saveResult
      };
    },
    applyEdit: async () => {
      applyEditCalls += 1;
      return true;
    }
  },
  window: {
    showTextDocument: async () => undefined
  }
};

const originalModuleLoad = Module._load;
Module._load = function loadWithVscodeMock(request, parent, isMain) {
  if (request === 'vscode') {
    return vscode;
  }
  return originalModuleLoad.call(this, request, parent, isMain);
};
const { WorkspaceMutations } = require('../out/workspace/workspaceMutations');
Module._load = originalModuleLoad;

function resetWorkspace() {
  entries.clear();
  addDirectory('src');
  applyEditCalls = 0;
  vscode.workspace.isTrusted = true;
}

function createMutations(requestPermission) {
  const statuses = [];
  const recordedDiffs = [];
  const mutations = new WorkspaceMutations({
    getPermissionPolicy: () => ({ createFiles: 'ask', updateFiles: 'ask' }),
    requestPermission,
    reportStatus: (status) => statuses.push(status),
    recordCompletedDiff: (...argumentsList) => recordedDiffs.push(argumentsList)
  });
  return { mutations, statuses, recordedDiffs };
}

test('permission denial performs no workspace edit', async () => {
  resetWorkspace();
  let requestedFiles;
  const { mutations, statuses, recordedDiffs } = createMutations(async (_summary, files) => {
    requestedFiles = files;
    return false;
  });

  const outcome = await mutations.confirmAndApplyFileChanges(
    [{ path: 'src/new.ts', content: 'export const value = 1;' }],
    'Create new.ts',
    new AbortController().signal
  );

  assert.equal(outcome, 'Proposed file changes were not applied.');
  assert.deepEqual(requestedFiles.map(({ path: filePath, operation }) => ({ filePath, operation })), [{
    filePath: 'src/new.ts',
    operation: 'create'
  }]);
  assert.deepEqual(statuses, ['Waiting for permission']);
  assert.equal(applyEditCalls, 0);
  assert.equal(recordedDiffs.length, 0);
});

test('cancellation after approval performs no workspace edit', async () => {
  resetWorkspace();
  const controller = new AbortController();
  const { mutations, recordedDiffs } = createMutations(async () => {
    controller.abort();
    return true;
  });

  const outcome = await mutations.confirmAndApplyFileChanges(
    [{ path: 'src/new.ts', content: 'export const value = 1;' }],
    'Create new.ts',
    controller.signal
  );

  assert.equal(outcome, 'Proposed file changes were not applied.');
  assert.equal(applyEditCalls, 0);
  assert.equal(recordedDiffs.length, 0);
});

test('trust revoked while approval is pending blocks the mutation', async () => {
  resetWorkspace();
  const { mutations, recordedDiffs } = createMutations(async () => {
    vscode.workspace.isTrusted = false;
    return true;
  });

  await assert.rejects(
    () => mutations.confirmAndApplyFileChanges(
      [{ path: 'src/new.ts', content: 'export const value = 1;' }],
      'Create new.ts',
      new AbortController().signal
    ),
    /Workspace Trust changed/
  );
  assert.equal(applyEditCalls, 0);
  assert.equal(recordedDiffs.length, 0);
});

test('an existing file changed while approval is pending is rejected', async () => {
  resetWorkspace();
  const file = addFile('src/app.ts', 'export const value = 1;');
  const { mutations, recordedDiffs } = createMutations(async () => {
    file.content = 'export const value = 2;';
    return true;
  });

  await assert.rejects(
    () => mutations.confirmAndApplyFileChanges(
      [{ path: 'src/app.ts', content: 'export const value = 3;' }],
      'Update app.ts',
      new AbortController().signal
    ),
    /changed while permission was pending/
  );
  assert.equal(applyEditCalls, 0);
  assert.equal(recordedDiffs.length, 0);
});

test('a missing target created while approval is pending is rejected', async () => {
  resetWorkspace();
  const { mutations, recordedDiffs } = createMutations(async () => {
    addFile('src/new.ts', 'created elsewhere');
    return true;
  });

  await assert.rejects(
    () => mutations.confirmAndApplyFileChanges(
      [{ path: 'src/new.ts', content: 'export const value = 1;' }],
      'Create new.ts',
      new AbortController().signal
    ),
    /was created while permission was pending/
  );
  assert.equal(applyEditCalls, 0);
  assert.equal(recordedDiffs.length, 0);
});

test('a create parent changed to a symbolic link while approval is pending is rejected', async () => {
  resetWorkspace();
  const sourceDirectory = entries.get(entryKey(createUri('C:\\repo\\src')));
  const { mutations, recordedDiffs } = createMutations(async () => {
    sourceDirectory.type = vscode.FileType.Directory | vscode.FileType.SymbolicLink;
    return true;
  });

  await assert.rejects(
    () => mutations.confirmAndApplyFileChanges(
      [{ path: 'src/new.ts', content: 'export const value = 1;' }],
      'Create new.ts',
      new AbortController().signal
    ),
    /symbolic-link path src/
  );
  assert.equal(applyEditCalls, 0);
  assert.equal(recordedDiffs.length, 0);
});

test('an update target changed to a symbolic link while approval is pending is rejected', async () => {
  resetWorkspace();
  const file = addFile('src/app.ts', 'export const value = 1;');
  const { mutations, recordedDiffs } = createMutations(async () => {
    file.type = vscode.FileType.File | vscode.FileType.SymbolicLink;
    return true;
  });

  await assert.rejects(
    () => mutations.confirmAndApplyFileChanges(
      [{ path: 'src/app.ts', content: 'export const value = 2;' }],
      'Update app.ts',
      new AbortController().signal
    ),
    /symbolic-link path src\/app\.ts/
  );
  assert.equal(applyEditCalls, 0);
  assert.equal(recordedDiffs.length, 0);
});

test('symbolic-link path segments are rejected before mutation', async () => {
  resetWorkspace();
  addDirectory('linked', vscode.FileType.Directory | vscode.FileType.SymbolicLink);
  const { mutations } = createMutations(async () => true);

  await assert.rejects(
    () => mutations.assertNoWorkspaceSymlink(folder, 'linked/file.ts', true),
    /symbolic-link path linked/
  );
});

test('an approved unchanged file is applied and recorded', async () => {
  resetWorkspace();
  addFile('src/app.ts', 'export const value = 1;');
  const { mutations, statuses, recordedDiffs } = createMutations(async () => true);

  const outcome = await mutations.confirmAndApplyFileChanges(
    [{ path: 'src/app.ts', content: 'export const value = 2;' }],
    'Update app.ts',
    new AbortController().signal
  );

  assert.equal(outcome, 'Applied file changes:\n- Updated src/app.ts');
  assert.deepEqual(statuses, ['Waiting for permission', 'Applying file changes']);
  assert.equal(applyEditCalls, 1);
  assert.deepEqual(recordedDiffs, [[
    'src/app.ts',
    'export const value = 1;',
    'export const value = 2;'
  ]]);
});
