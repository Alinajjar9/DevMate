const Module = require('node:module');
const path = require('node:path');

function createVscodeHarness() {
  const root = path.resolve('C:/devmate-test-workspace');
  const files = new Map();
  const reads = [];
  const writes = [];
  const configuration = new Map();
  const normalize = value => path.resolve(value).toLowerCase();
  const uri = value => ({
    scheme: 'file',
    fsPath: path.resolve(value),
    path: path.resolve(value).replace(/\\/g, '/'),
    toString() {
      return `file:///${this.path.replace(/^\/+/, '')}`;
    }
  });
  const folder = { name: 'Project A', uri: uri(root) };
  class FileSystemError extends Error {
    constructor(code) {
      super(code);
      this.code = code;
    }
    static FileNotFound() {
      return new FileSystemError('FileNotFound');
    }
  }
  const vscode = {
    Uri: {
      file: uri,
      joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)),
      parse: value => ({ scheme: value.split(':')[0], toString: () => value })
    },
    FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
    FileSystemError,
    RelativePattern: class {
      constructor(base, pattern) {
        this.base = base;
        this.pattern = pattern;
      }
    },
    workspace: {
      workspaceFolders: [folder],
      isTrusted: true,
      asRelativePath: value => path.relative(root, value.fsPath).replace(/\\/g, '/'),
      getWorkspaceFolder: value => normalize(value.fsPath).startsWith(normalize(root)) ? folder : undefined,
      getConfiguration: () => ({ get: (key, fallback) => configuration.get(key) ?? fallback }),
      findFiles: async (_include, _exclude, limit) => [...files.values()].filter(file => file.uri.fsPath.startsWith(root)).slice(0, limit).map(file => file.uri),
      fs: {
        stat: async (value) => {
          const file = files.get(normalize(value.fsPath));
          if (file) {
            return { type: 1, size: Buffer.byteLength(file.content), mtime: file.mtime };
          }
          if (normalize(value.fsPath) === normalize(root) || [...files.keys()].some(name => name.startsWith(normalize(value.fsPath) + path.sep))) {
            return { type: 2, size: 0, mtime: 0 };
          }
          throw FileSystemError.FileNotFound();
        },
        readFile: async (value) => {
          reads.push(value.fsPath);
          const file = files.get(normalize(value.fsPath));
          if (!file) {
            throw FileSystemError.FileNotFound();
          }
          return Buffer.from(file.content);
        },
        createDirectory: async () => undefined,
        writeFile: async (value, bytes) => {
          writes.push(value.fsPath);
          files.set(normalize(value.fsPath), { uri: value, content: Buffer.from(bytes).toString(), mtime: Date.now() });
        }
      }
    },
    window: {
      activeTextEditor: undefined,
      onDidStartTerminalShellExecution: () => ({ dispose() {} }),
      onDidEndTerminalShellExecution: () => ({ dispose() {} }),
      showQuickPick: async (choices) => choices.filter(choice => choice.label === 'README.md'),
      showTextDocument: async () => undefined
    },
    commands: { executeCommand: async () => [] },
    languages: { getDiagnostics: () => [] },
    DiagnosticSeverity: {
      Error: 0,
      Warning: 1,
      Information: 2,
      Hint: 3
    }
  };
  function setFile(name, content, mtime = 1) {
    const fileUri = uri(path.join(root, name));
    files.set(normalize(fileUri.fsPath), { uri: fileUri, content, mtime });
    return fileUri;
  }
  function context(values = {}) {
    const globalValues = new Map(Object.entries(values.global ?? {}));
    const workspaceValues = new Map(Object.entries(values.workspace ?? {}));
    const state = entries => ({
      get: key => entries.get(key),
      update: async (key, value) => {
        if (value === undefined) {
          entries.delete(key);
        }
        else {
          entries.set(key, value);
        }
      }
    });
    return {
      extensionUri: uri('C:/devmate-test-extension'),
      storageUri: uri('C:/devmate-test-storage'),
      globalValues,
      workspaceValues,
      globalState: state(globalValues),
      workspaceState: state(workspaceValues),
      secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined }
    };
  }
  function load(relativeModule) {
    const originalLoad = Module._load;
    Module._load = function(request, parent, isMain) {
      return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain);
    };
    try {
      return require(path.resolve(__dirname, '../../out', relativeModule));
    } finally {
      Module._load = originalLoad;
    }
  }
  return {
    vscode,
    folder,
    uri,
    root,
    setFile,
    files,
    reads,
    writes,
    configuration,
    context,
    load
  };
}
async function withoutDelays(callback) {
  const original = global.setTimeout;
  global.setTimeout = (handler, _delay, ...args) => original(handler, 0, ...args);
  try {
    return await callback();
  } finally {
    global.setTimeout = original;
  }
}
module.exports = { createVscodeHarness, withoutDelays };
