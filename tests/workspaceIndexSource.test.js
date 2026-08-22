const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');

function createUri(fsPath, relativePath = '') {
  const normalized = fsPath.replace(/\\/g, '/');
  return {
    scheme: 'file',
    fsPath,
    relativePath,
    toString() {
      return `file:///${normalized.replace(/^\/+/, '')}`;
    }
  };
}

const folder = {
  name: 'Project',
  uri: createUri('C:\\repo')
};
const entries = new Map();

function key(relativePath) {
  return relativePath.replace(/\\/g, '/').toLocaleLowerCase('en-US');
}

function addDirectory(relativePath, type = 2) {
  entries.set(key(relativePath), { type, content: '', mtime: 1 });
}

function addFile(relativePath, content, type = 1, reportedSize) {
  entries.set(key(relativePath), {
    type,
    content,
    mtime: 2,
    reportedSize
  });
  return createUri(path.win32.join(folder.uri.fsPath, relativePath), relativePath);
}

const vscode = {
  FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
  RelativePattern: class RelativePattern {
    constructor(base, pattern) {
      this.base = base;
      this.pattern = pattern;
    }
  },
  Uri: {
    joinPath: (base, ...segments) => createUri(
      path.win32.join(base.fsPath, ...segments),
      segments.join('/')
    )
  },
  workspace: {
    workspaceFolders: [folder],
    asRelativePath: (uri) => uri.relativePath,
    findFiles: async () => [],
    fs: {
      stat: async (uri) => {
        const entry = entries.get(key(uri.relativePath));
        if (!entry) {
          throw new Error(`${uri.relativePath} is unavailable.`);
        }
        return {
          type: entry.type,
          size: entry.reportedSize ?? Buffer.byteLength(entry.content),
          ctime: 1,
          mtime: entry.mtime
        };
      },
      readFile: async (uri) => {
        const entry = entries.get(key(uri.relativePath));
        if (!entry) {
          throw new Error(`${uri.relativePath} is unavailable.`);
        }
        return new TextEncoder().encode(entry.content);
      }
    }
  }
};

const originalModuleLoad = Module._load;
Module._load = function loadWithVscodeMock(request, parent, isMain) {
  if (request === 'vscode') {
    return vscode;
  }
  return originalModuleLoad.call(this, request, parent, isMain);
};
const { VsCodeWorkspaceIndexSource } = require('../out/workspaceIndexSource');
Module._load = originalModuleLoad;

test('workspace source keeps only bounded regular files behind safe directories', async () => {
  entries.clear();
  addDirectory('src');
  addDirectory('linked', 2 | 64);
  const app = addFile('src/app.ts', 'export const app = true;\n');
  const ignored = addFile('src/app.js.map', '{}');
  const linked = addFile('linked/secret.ts', 'export const secret = true;');
  const symlink = addFile('src/link.ts', 'export const link = true;', 1 | 64);
  const large = addFile('src/large.ts', 'small fixture', 1, 200_001);
  const unavailable = createUri('C:\\repo\\src\\missing.ts', 'src/missing.ts');
  vscode.workspace.findFiles = async () => [
    unavailable,
    large,
    linked,
    ignored,
    symlink,
    app
  ];

  const snapshot = await new VsCodeWorkspaceIndexSource().scan(new AbortController().signal);

  assert.equal(snapshot.rootPath, folder.uri.fsPath);
  assert.deepEqual(snapshot.files.map((file) => file.relativePath), ['src/app.ts']);
  assert.deepEqual(snapshot.unavailablePaths, ['src/missing.ts']);
  const read = await snapshot.files[0].read(new AbortController().signal);
  assert.equal(new TextDecoder().decode(read.bytes), 'export const app = true;\n');
  assert.equal(read.sizeBytes, Buffer.byteLength('export const app = true;\n'));
  assert.equal(read.modifiedAt, 2);
});

test('workspace source skips non-file workspaces and honors cancellation', async () => {
  const originalScheme = folder.uri.scheme;
  folder.uri.scheme = 'vscode-remote';
  try {
    assert.equal(
      await new VsCodeWorkspaceIndexSource().scan(new AbortController().signal),
      undefined
    );
  } finally {
    folder.uri.scheme = originalScheme;
  }

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => new VsCodeWorkspaceIndexSource().scan(controller.signal),
    { name: 'AbortError' }
  );
});

test('workspace source rechecks parent links immediately around file reads', async () => {
  entries.clear();
  addDirectory('src');
  const app = addFile('src/app.ts', 'export const app = true;\n');
  vscode.workspace.findFiles = async () => [app];
  const snapshot = await new VsCodeWorkspaceIndexSource().scan(new AbortController().signal);

  entries.get(key('src')).type = 2 | 64;

  await assert.rejects(
    () => snapshot.files[0].read(new AbortController().signal),
    /symbolic-link directory/
  );
});
