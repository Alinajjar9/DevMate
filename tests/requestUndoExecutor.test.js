const assert = require('node:assert/strict');
const test = require('node:test');
const { createVscodeHarness } = require('./helpers/vscode');
const harness = createVscodeHarness();
const { vscode, folder, files, context, setFile } = harness;
const { DEFAULT_AGENT_TOOL_SETTINGS } = require('../out/agentTools');
const documents = new Map();
const applied = [];
const key = uri => uri.fsPath.toLowerCase();
let confirmUndo = true;
let beforeConfirmation;

vscode.Position = class { constructor(line, character) { this.line = line; this.character = character; } };
vscode.Range = class { constructor(start, end) { this.start = start; this.end = end; } };
vscode.ViewColumn = { One: 1 };
vscode.WorkspaceEdit = class {
  constructor() { this.operations = []; }
  createFile(uri, options) { this.operations.push({ type: 'create', uri, options }); }
  deleteFile(uri, options) { this.operations.push({ type: 'delete', uri, options }); }
  renameFile(uri, destination, options) { this.operations.push({ type: 'rename', uri, destination, options }); }
  replace(uri, range, content) { this.operations.push({ type: 'write', uri, content }); }
  insert(uri, position, content) { this.operations.push({ type: 'write', uri, content }); }
};
Object.defineProperty(vscode.workspace, 'textDocuments', { get: () => [...documents.values()] });
vscode.workspace.openTextDocument = async uri => {
  if (!files.has(key(uri))) throw vscode.FileSystemError.FileNotFound();
  if (!documents.has(key(uri))) documents.set(key(uri), {
    uri, isDirty: false, getText: () => files.get(key(uri))?.content ?? '', positionAt: offset => offset, save: async () => true
  });
  return documents.get(key(uri));
};
vscode.workspace.applyEdit = async edit => {
  applied.push(edit);
  for (const operation of edit.operations) {
    const existing = files.get(key(operation.uri));
    if (operation.type === 'create') {
      if (existing && !operation.options.overwrite) return false;
      await vscode.workspace.fs.writeFile(operation.uri, operation.options.contents ?? Buffer.from(''));
    } else if (operation.type === 'delete') {
      assert.equal(operation.options.recursive, false);
      files.delete(key(operation.uri));
      documents.delete(key(operation.uri));
    } else if (operation.type === 'rename') {
      if (!existing || files.has(key(operation.destination))) return false;
      await vscode.workspace.fs.writeFile(operation.destination, Buffer.from(existing.content));
      files.delete(key(operation.uri));
      documents.delete(key(operation.uri));
    } else {
      await vscode.workspace.fs.writeFile(operation.uri, Buffer.from(operation.content));
    }
  }
  return true;
};
vscode.window.showQuickPick = async choices => choices.find(choice => choice.undo);
vscode.window.showWarningMessage = async () => {
  await beforeConfirmation?.();
  return confirmUndo ? 'Undo request' : undefined;
};
const { ToolExecutor } = harness.load('toolExecutor');
const { WorkspaceContext } = harness.load('workspaceContext');

const providerEdit = (from, to, newText) => ({ range: { start: { line: 0, character: from }, end: { line: 0, character: to } }, newText });

test('symbol rename reviews and records every changed file and respects the remaining file budget', async () => {
  reset();
  const first = setFile('first.ts', 'const old = 1;');
  const second = setFile('second.ts', 'use(old);');
  const originalExecute = vscode.commands.executeCommand;
  vscode.commands.executeCommand = async name => {
    assert.equal(name, 'vscode.executeDocumentRenameProvider');
    return { entries: () => [[first, [providerEdit(6, 9, 'fresh')]], [second, [providerEdit(4, 7, 'fresh')]]] };
  };
  const tools = executor(); tools.beginRequest(false);
  try {
    const call = { id: 'rename', name: 'rename_symbol', arguments: { path: 'first.ts', line: 1, column: 7, newName: 'fresh' } };
    const rejected = await tools.executeAgentToolCall(call, 1000, 1);
    assert.equal(rejected.step.isError, true); assert.match(rejected.step.result, /file-edit budget/);
    assert.equal(applied.length, 0);
    const result = await tools.executeAgentToolCall(call, 1000, 2);
    assert.equal(result.step.isError, false, result.step.result);
    assert.equal(result.mutationFiles, 2);
    assert.equal(files.get(key(first)).content, 'const fresh = 1;');
    assert.equal(files.get(key(second)).content, 'use(fresh);');
    assert.equal((await tools.getUndoState()).files, 2);
    assert.equal(await tools.undoLastRequest(), true);
    assert.equal(files.get(key(second)).content, 'use(old);');
  } finally { vscode.commands.executeCommand = originalExecute; tools.dispose(); }
});

test('editor tools reject outside targets, changed files and invalid edits before writing', async () => {
  reset(); const source = setFile('first.ts', 'old');
  const originalExecute = vscode.commands.executeCommand;
  const tools = executor(); tools.beginRequest(false);
  const call = { id: 'rename', name: 'rename_symbol', arguments: { path: 'first.ts', line: 1, column: 1, newName: 'fresh' } };
  try {
    for (const entries of [[[vscode.Uri.file('C:/outside.ts'), [providerEdit(0, 3, 'fresh')]]],
      [[source, [providerEdit(0, 9, 'fresh')]]]]) {
      vscode.commands.executeCommand = async () => ({ entries: () => entries });
      const result = await tools.executeAgentToolCall(call);
      assert.equal(result.step.isError, true); assert.equal(applied.length, 0);
    }
    vscode.commands.executeCommand = async () => {
      setFile('first.ts', 'changed');
      return { entries: () => [[source, [providerEdit(0, 3, 'fresh')]]] };
    };
    const result = await tools.executeAgentToolCall(call);
    assert.equal(result.step.isError, true); assert.match(result.step.result, /source changed/);
    assert.equal(files.get(key(source)).content, 'changed'); assert.equal(applied.length, 0);
  } finally { vscode.commands.executeCommand = originalExecute; tools.dispose(); }
});

test('formatting uses the configured language provider and treats an empty edit list as no change', async () => {
  reset(); const source = setFile('app.ts', 'let x=1;');
  const originalExecute = vscode.commands.executeCommand;
  const tools = executor(); tools.beginRequest(false);
  const call = { id: 'format', name: 'format_file', arguments: { path: 'app.ts' } };
  try {
    vscode.commands.executeCommand = async (name, uri, options) => {
      assert.equal(name, 'vscode.executeFormatDocumentProvider'); assert.equal(key(uri), key(source));
      assert.deepEqual(options, { tabSize: 2, insertSpaces: true }); return [];
    };
    const noChange = await tools.executeAgentToolCall(call);
    assert.equal(noChange.step.isError, false); assert.equal(noChange.mutationApplied, false);
    assert.equal(applied.length, 0);
    vscode.commands.executeCommand = async () => [providerEdit(5, 6, ' = ')];
    const formatted = await tools.executeAgentToolCall(call);
    assert.equal(formatted.step.isError, false, formatted.step.result);
    assert.equal(files.get(key(source)).content, 'let x = 1;');
  } finally { vscode.commands.executeCommand = originalExecute; tools.dispose(); }
});

test('rename never applies stale offsets to a target that was closed before preparation', async () => {
  reset(); const source = setFile('a.ts', 'foo()'); const closed = setFile('b.ts', 'foo()');
  const originalExecute = vscode.commands.executeCommand;
  const tools = executor(); tools.beginRequest(false); let providerCalls = 0;
  try {
    vscode.commands.executeCommand = async () => {
      providerCalls++;
      if (providerCalls === 2) setFile('b.ts', '// foo()');
      return { entries: () => [[source, [providerEdit(0, 3, 'bar')]], [closed, [providerEdit(0, 3, 'bar')]]] };
    };
    const result = await tools.executeAgentToolCall({ id: 'rename', name: 'rename_symbol',
      arguments: { path: 'a.ts', line: 1, column: 1, newName: 'bar' } });
    assert.equal(result.step.isError, true); assert.match(result.step.result, /b.ts changed/);
    assert.equal(files.get(key(closed)).content, '// foo()'); assert.equal(applied.length, 0);
  } finally { vscode.commands.executeCommand = originalExecute; tools.dispose(); }
});

function reset() {
  files.clear(); documents.clear(); applied.length = 0;
  confirmUndo = true; beforeConfirmation = undefined;
  vscode.workspace.isTrusted = true;
}

function executor(storage = context({ workspace: { 'devMate.filePermissionPolicy.v2': { createFiles: 'allow', updateFiles: 'allow' } } })) {
  let tools;
  const events = {
    postMessage(message) {
      if (message.command === 'permissionRequest') {
        queueMicrotask(() => tools.handlePermissionDecision(message.requestId, 'allowOnce'));
      }
    },
    postStatus() {}, postSettingsState() {}, postPermissionPolicyState() {},
    getAgentToolSettings: () => DEFAULT_AGENT_TOOL_SETTINGS ?? {}, getActiveSignal: () => undefined
  };
  tools = new ToolExecutor(storage, new WorkspaceContext(storage, events), events);
  return tools;
}

test('executor undoes create, edit, delete and move from a partial request in one edit after reload', async () => {
  reset();
  setFile('app.ts', '\ufefforiginal\r\n');
  setFile('old.ts', 'deleted content');
  setFile('move.ts', 'move content');
  const storage = context({ workspace: { 'devMate.filePermissionPolicy.v2': { createFiles: 'allow', updateFiles: 'allow' } } });
  let tools = executor(storage);
  tools.beginRequest(false);
  for (const [name, argumentsValue] of [
    ['edit_file', { path: 'app.ts', replacements: [{ oldText: 'original', newText: 'changed' }] }],
    ['create_file', { path: 'new.ts', content: 'created content' }],
    ['delete_file', { path: 'old.ts' }],
    ['move_file', { path: 'move.ts', newPath: 'src/moved.ts' }]
  ]) {
    const result = await tools.executeAgentToolCall({ id: name, name, arguments: argumentsValue });
    assert.equal(result.step.isError, false, result.step.result);
  }
  tools.cancelPendingWork();
  assert.equal((await tools.getUndoState()).files, 5);
  tools.dispose();
  tools = executor(storage);
  assert.equal((await tools.getUndoState()).available, true);
  const countBeforeUndo = applied.length;
  assert.equal(await tools.undoLastRequest(), true);
  assert.equal(applied.length, countBeforeUndo + 1);
  assert.equal(files.get(key(vscode.Uri.joinPath(folder.uri, 'app.ts'))).content, '\ufefforiginal\r\n');
  assert.equal(files.get(key(vscode.Uri.joinPath(folder.uri, 'old.ts'))).content, 'deleted content');
  assert.equal(files.get(key(vscode.Uri.joinPath(folder.uri, 'move.ts'))).content, 'move content');
  assert.equal(files.has(key(vscode.Uri.joinPath(folder.uri, 'new.ts'))), false);
  assert.equal(files.has(key(vscode.Uri.joinPath(folder.uri, 'src/moved.ts'))), false);
  assert.equal((await tools.getUndoState()).available, false);
  tools.dispose();
});

test('executor records complete-file proposals and refuses dirty files, manual edits or rejected confirmation', async () => {
  reset();
  const uri = setFile('app.ts', 'before');
  const tools = executor(); tools.beginRequest(false);
  await tools.confirmAndApplyFileChanges([{ path: 'app.ts', content: 'after' }], 'Apply code response', new AbortController().signal);
  const countBefore = applied.length;
  (await vscode.workspace.openTextDocument(uri)).isDirty = true;
  await assert.rejects(tools.undoLastRequest(), /unsaved changes/);
  documents.get(key(uri)).isDirty = false;
  confirmUndo = false;
  assert.equal(await tools.undoLastRequest(), false);
  confirmUndo = true;
  beforeConfirmation = () => setFile('app.ts', 'manual edit while reviewing');
  await assert.rejects(tools.undoLastRequest(), /newer changes/);
  assert.equal(applied.length, countBefore);
  assert.equal(files.get(key(uri)).content, 'manual edit while reviewing');
  tools.dispose();
});

test('executor keeps only the newest request journal and respects configurable tool gates', async () => {
  reset(); setFile('app.ts', 'before');
  const tools = executor(); tools.beginRequest(false);
  await tools.confirmAndApplyFileChanges([{ path: 'app.ts', content: 'after' }], 'Apply', new AbortController().signal);
  assert.equal((await tools.getUndoState()).available, true);
  tools.beginRequest(false);
  assert.equal((await tools.getUndoState()).available, false);
  const limits = { maxFileEdits: 2, maxCommands: 1, enabledTools: ['read_file', 'edit_file', 'run_command'] };
  assert.deepEqual(tools.enabledAgentTools('code', 0, 0, 0, limits), ['read_file', 'edit_file', 'run_command']);
  assert.deepEqual(tools.enabledAgentTools('code', 2, 1, 0, limits), ['read_file']);
  assert.deepEqual(tools.enabledAgentTools('ideas', 0, 0, 0, limits), ['read_file']);
  vscode.workspace.isTrusted = false;
  assert.deepEqual(tools.enabledAgentTools('code', 0, 0, 0, limits), ['read_file']);
  vscode.workspace.isTrusted = true;
  tools.dispose();
});

test('executor refuses a symlink introduced after the request and blocks writes if an old journal cannot be invalidated', async () => {
  reset();
  const uri = setFile('app.ts', 'before');
  const tools = executor(); tools.beginRequest(false);
  await tools.confirmAndApplyFileChanges([{ path: 'app.ts', content: 'after' }], 'Apply', new AbortController().signal);
  const originalStat = vscode.workspace.fs.stat;
  vscode.workspace.fs.stat = async value => key(value) === key(uri)
    ? { type: vscode.FileType.File | vscode.FileType.SymbolicLink, size: 5 } : originalStat(value);
  try {
    await assert.rejects(tools.undoLastRequest(), /symbolic-link path/);
  } finally {
    vscode.workspace.fs.stat = originalStat;
  }
  const originalWrite = vscode.workspace.fs.writeFile;
  vscode.workspace.fs.writeFile = async (value, contents) => {
    if (value.fsPath.includes('request-undo-')) throw new Error('Storage unavailable');
    return originalWrite(value, contents);
  };
  try {
    tools.beginRequest(false);
    assert.equal((await tools.getUndoState()).available, false);
    const result = await tools.executeAgentToolCall({ id: 'create', name: 'create_file', arguments: { path: 'new.ts', content: 'must not be written' } });
    assert.equal(result.step.isError, true);
    assert.match(result.step.result, /could not safely prepare the Undo journal/);
    assert.equal(files.has(key(vscode.Uri.joinPath(folder.uri, 'new.ts'))), false);
  } finally {
    vscode.workspace.fs.writeFile = originalWrite;
    tools.dispose();
  }
});
