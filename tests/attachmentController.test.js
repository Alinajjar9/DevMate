const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

const vscodeState = {
  folders: [],
  files: [],
  selected: undefined,
  listError: undefined,
  quickPickItems: []
};

const vscode = {
  RelativePattern: class RelativePattern {
    constructor(folder, pattern) {
      this.folder = folder;
      this.pattern = pattern;
    }
  },
  workspace: {
    get workspaceFolders() {
      return vscodeState.folders;
    },
    findFiles: async () => {
      if (vscodeState.listError) {
        throw vscodeState.listError;
      }
      return vscodeState.files;
    },
    asRelativePath: (uri) => uri.relativePath
  },
  window: {
    showQuickPick: async (items) => {
      vscodeState.quickPickItems = items;
      if (vscodeState.selected === 'all') {
        return items;
      }
      if (Array.isArray(vscodeState.selected)) {
        return items.filter((item) => vscodeState.selected.includes(item.id));
      }
      return undefined;
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

const { AttachmentController } = require('../out/attachmentController');
const { MAX_ATTACHED_FILES } = require('../out/projectSearch/projectIndex');

test.beforeEach(() => {
  vscodeState.folders = [];
  vscodeState.files = [];
  vscodeState.selected = undefined;
  vscodeState.listError = undefined;
  vscodeState.quickPickItems = [];
});

test('reports when no workspace is available', async () => {
  const fixture = createFixture();

  await fixture.controller.pickWorkspaceFiles();

  assert.deepEqual(fixture.statuses, [{
    text: 'Open a folder before attaching files.',
    level: 'warning'
  }]);
  assert.deepEqual(fixture.controller.state(), []);
});

test('filters unsupported paths and keeps picker choices sorted', async () => {
  vscodeState.folders = [{ name: 'Project' }];
  vscodeState.files = [
    file('src/z.ts'),
    file('node_modules/pkg/index.js'),
    file('src/a.ts'),
    file('assets/logo.png')
  ];
  vscodeState.selected = [];
  const fixture = createFixture();

  await fixture.controller.pickWorkspaceFiles();

  assert.deepEqual(
    vscodeState.quickPickItems.map((item) => item.id),
    ['src/a.ts', 'src/z.ts']
  );
  assert.equal(fixture.statuses[0].text, 'Finding workspace files');
  assert.equal(fixture.statuses.at(-1).text, 'Ready');
});

test('keeps only validated selections and reports ignored files', async () => {
  vscodeState.folders = [{ name: 'Project' }];
  vscodeState.files = [file('src/app.ts'), file('src/large.ts')];
  vscodeState.selected = ['src/app.ts', 'src/large.ts'];
  const fixture = createFixture((uri) => uri.relativePath !== 'src/large.ts');

  await fixture.controller.pickWorkspaceFiles();

  assert.deepEqual(fixture.controller.state(), [{
    id: 'src/app.ts',
    label: 'src/app.ts'
  }]);
  assert.deepEqual(fixture.controller.uris(), [vscodeState.files[0]]);
  assert.deepEqual(fixture.changes.at(-1), fixture.controller.state());
  assert.deepEqual(fixture.statuses.at(-1), {
    text: '1 unsupported or oversized file(s) were ignored.',
    level: 'warning'
  });
});

test('removing a file immediately publishes the new attachment state', async () => {
  vscodeState.folders = [{ name: 'Project' }];
  vscodeState.files = [file('src/app.ts')];
  vscodeState.selected = ['src/app.ts'];
  const fixture = createFixture();
  await fixture.controller.pickWorkspaceFiles();

  fixture.controller.remove('src/app.ts');

  assert.deepEqual(fixture.controller.state(), []);
  assert.deepEqual(fixture.changes.at(-1), []);
});

test('rejects selections above the attachment limit', async () => {
  vscodeState.folders = [{ name: 'Project' }];
  vscodeState.files = Array.from(
    { length: MAX_ATTACHED_FILES + 1 },
    (_, index) => file(`src/file-${index}.ts`)
  );
  vscodeState.selected = 'all';
  const fixture = createFixture();

  await fixture.controller.pickWorkspaceFiles();

  assert.deepEqual(fixture.controller.state(), []);
  assert.deepEqual(fixture.statuses.at(-1), {
    text: `Attach at most ${MAX_ATTACHED_FILES} files.`,
    level: 'warning'
  });
});

test('keeps the previous selection when workspace listing fails', async () => {
  vscodeState.folders = [{ name: 'Project' }];
  vscodeState.files = [file('src/app.ts')];
  vscodeState.selected = ['src/app.ts'];
  const fixture = createFixture();
  await fixture.controller.pickWorkspaceFiles();

  vscodeState.listError = new Error('unavailable');
  await fixture.controller.pickWorkspaceFiles();
  assert.deepEqual(fixture.controller.state(), [{ id: 'src/app.ts', label: 'src/app.ts' }]);
  assert.deepEqual(fixture.statuses.at(-1), {
    text: 'Could not list files from the open folder.',
    level: 'error'
  });
});

function createFixture(isProjectCandidate = () => true) {
  const statuses = [];
  const changes = [];
  const controller = new AttachmentController({
    isProjectCandidate: async (uri) => isProjectCandidate(uri),
    reportStatus: (text, level = 'info') => statuses.push({ text, level }),
    attachmentsChanged: (attachments) => changes.push(structuredClone(attachments))
  });
  return { controller, statuses, changes };
}

function file(relativePath) {
  return { relativePath };
}
