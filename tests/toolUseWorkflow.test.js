// A deterministic tool-loop regression, not a benchmark of a real model's coding ability.
// Only the provider and filesystem are scripted; argument parsing, editing, and the runner are real.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { AgentRunner } = require('../out/agentRunner');
const { parseAgentToolCall } = require('../out/agentTools');
const { applyExactReplacements, formatReadFileResult, validateFileChanges } = require('../out/fileTools');

const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures/html-cleanup', name), 'utf8')
  .replace(/\r\n/g, '\n');
const originalHtml = fixture('before.html');
const expectedHtml = fixture('after.html');
const rawCss = '  <!-- Pasted styling from an earlier draft. -->\n'
  + '  body { font-family: sans-serif; background: #eee; }\n'
  + '  .legacy-outline { border: 4px solid red; }\n';
const inlineScript = "  <script>\n"
  + "    document.querySelector('#task-form').addEventListener('submit', function (event) {\n"
  + "      event.preventDefault();\n"
  + "      console.log('legacy inline handler');\n"
  + "    });\n"
  + "  </script>\n";

function cleanupRun({ repair = true } = {}) {
  const files = new Map([
    ['index.html', originalHtml],
    ['styles.css', 'body { font-family: system-ui; }\n'],
    ['app.js', "document.querySelector('#task-form').addEventListener('submit', handleTask);\n"]
  ]);
  const initialAssets = new Map(files);
  const counts = { reads: 0, rejectedEdits: 0, successfulEdits: 0, guardRejections: 0, providerCalls: 0 };
  const rejectedSnapshots = [];
  const requests = [];
  const checkpoints = [];
  const failures = [];
  const resultStep = (call, result, isError = false, mutationCharacters = 0) => ({
    step: { callId: call.id, name: call.name, arguments: call.arguments, result, isError },
    usedFiles: [call.arguments.path],
    mutationCharacters,
    mutationApplied: !isError && call.name === 'edit_file'
  });
  const tools = {
    enabledAgentTools: () => ['read_file', 'edit_file'],
    postAgentToolActivity() {},
    rejectedToolExecution(call, message) {
      counts.guardRejections += 1;
      return resultStep(call, message, true);
    },
    async executeAgentToolCall(rawCall) {
      const before = files.get(rawCall.arguments.path);
      try {
        const call = parseAgentToolCall(rawCall);
        assert.ok(files.has(call.arguments.path), 'The scenario must stay inside its in-memory project');
        if (call.name === 'read_file') {
          counts.reads += 1;
          const read = formatReadFileResult({
            path: call.arguments.path, languageId: 'html', content: before,
            startLine: call.arguments.startLine, endLine: call.arguments.endLine, maxCharacters: 10_000
          });
          return resultStep(call, read.result);
        }
        assert.equal(call.name, 'edit_file');
        // No write occurs until every replacement and the complete proposed file have passed validation.
        const content = applyExactReplacements(before, call.arguments.replacements);
        const [change] = validateFileChanges([{ path: call.arguments.path, content }]);
        files.set(change.path, change.content);
        counts.successfulEdits += 1;
        return resultStep(call, `Updated ${change.path}.`, false, change.content.length);
      } catch (error) {
        counts.rejectedEdits += 1;
        rejectedSnapshots.push({ before, after: files.get(rawCall.arguments.path), error: error.message });
        return resultStep(rawCall, error.message, true);
      }
    }
  };
  const final = answer => ({ status: 'ok', data: { answer, usedFiles: ['index.html'], changes: [], toolCalls: [] } });
  const tool = (id, name, args) => ({ ...final('').data, toolCalls: [{ id, name, arguments: args }] });
  const read = (id, narrow = false) => tool(id, 'read_file', {
    path: 'index.html', startLine: narrow ? 15 : 1, endLine: narrow ? 21 : 60
  });
  const transport = {
    ask: async () => assert.fail('The workflow uses the streaming transport'),
    async askStream(_url, request) {
      requests.push(request);
      counts.providerCalls += 1;
      assert.ok(counts.providerCalls <= 8, 'The runner must stop repair attempts instead of looping');
      const history = request.toolHistory;
      const previous = history.at(-1);
      let result;
      if (request.forceFinalAnswer) {
        assert.deepEqual(request.enabledTools, []);
        result = final('The HTML edit could not be completed. The original file is unchanged.');
      } else if (!previous) {
        result = { status: 'ok', data: read('read-initial') };
      } else if (previous.name === 'edit_file') {
        // After an error, inspect the real source again rather than assuming partial edits were saved.
        result = { status: 'ok', data: read(`read-after-edit-${history.length}`, previous.isError) };
      } else if (counts.successfulEdits) {
        assert.match(previous.result, /Create task/);
        assert.doesNotMatch(previous.result, /legacy inline handler|legacy-outline/);
        result = final('Removed the pasted CSS and inline handler, preserved external assets, and checked the HTML.');
      } else {
        const failed = history.filter(step => step.name === 'edit_file' && step.isError).length;
        if (failed) {
          assert.match(history.findLast(step => step.isError).result, /Replacement 3 did not match/);
          assert.match(previous.result, /Add task/);
        }
        const oldLabel = repair && failed ? 'Add task' : `Add missing item ${failed}`;
        result = { status: 'ok', data: tool(`edit-${failed + 1}`, 'edit_file', {
          path: 'index.html',
          replacements: [
            { oldText: rawCss, newText: '' },
            { oldText: inlineScript, newText: '' },
            { oldText: `<button type="submit">${oldLabel}</button>`, newText: '<button type="submit">Create task</button>' }
          ]
        }) };
      }
      return { unsupported: false, result };
    }
  };
  const events = {
    postMessage() {}, postStatus() {},
    postRequestFailure: message => failures.push(message),
    finishCancelledRequest: signal => signal.aborted,
    saveAgentCheckpoint: async checkpoint => checkpoints.push(checkpoint),
    getConversationWorkspace: () => ({ id: 'file:///html-project', name: 'HTML project' }),
    getConversationHistory: () => [],
    ensureBackendStarted: async () => true,
    getBackendUrl: () => 'http://127.0.0.1:8000',
    getWorkspaceFolder: () => ({ name: 'HTML project', fsPath: 'C:/html-project' })
  };
  const input = {
    question: 'Clean index.html: remove the pasted raw CSS and inline JavaScript. Keep styles.css and app.js linked. Rename Add task to Create task.',
    mode: 'code', scopeKind: 'project', scope: { type: 'project', items: [] },
    settings: { provider: 'ollama', model: 'scripted-test-model', api: 'auto', maxTokens: 2048,
      temperature: 0.2, timeoutSeconds: 900, reasoningEffort: 'auto' },
    sessionId: 'html-cleanup', getReasoningEffort: () => 'auto', toolCallLimit: 20
  };
  return { runner: new AgentRunner(tools, events, transport), input, files, initialAssets,
    counts, rejectedSnapshots, requests, checkpoints, failures };
}

test('HTML cleanup repairs an atomic third-replacement failure and preserves external assets', async () => {
  const run = cleanupRun();
  const result = await run.runner.run(run.input, new AbortController().signal);
  assert.ok(result);
  assert.deepEqual(run.counts, { reads: 3, rejectedEdits: 1, successfulEdits: 1, guardRejections: 0, providerCalls: 6 });
  assert.equal(run.rejectedSnapshots[0].before, originalHtml);
  assert.equal(run.rejectedSnapshots[0].after, originalHtml);
  assert.match(run.rejectedSnapshots[0].error, /Replacement 3 did not match/);
  assert.match(run.rejectedSnapshots[0].error, /No changes from this edit_file call were applied/);
  assert.equal(run.files.get('index.html'), expectedHtml);
  for (const asset of ['styles.css', 'app.js']) {
    assert.equal(run.files.get(asset), run.initialAssets.get(asset));
  }
  assert.match(run.files.get('index.html'), /<link rel="stylesheet" href="styles\.css">/);
  assert.match(run.files.get('index.html'), /<script src="app\.js" defer><\/script>/);
  assert.doesNotMatch(run.files.get('index.html'), /<style|<script>|legacy-outline|legacy inline handler/);
  assert.deepEqual(result.toolHistory.map(step => [step.name, step.isError]), [
    ['read_file', false], ['edit_file', true], ['read_file', false], ['edit_file', false], ['read_file', false]
  ]);
  assert.equal(run.checkpoints.at(-1).workspaceRevision, 1);
  assert.equal(run.checkpoints.at(-1).fileMutationCalls, 1);
  assert.deepEqual(run.failures, []);
});

test('HTML cleanup stops after three changed but unsuccessful repair attempts', async () => {
  const run = cleanupRun({ repair: false });
  const result = await run.runner.run(run.input, new AbortController().signal);
  assert.ok(result);
  assert.deepEqual(run.counts, { reads: 3, rejectedEdits: 3, successfulEdits: 0, guardRejections: 0, providerCalls: 7 });
  assert.ok(run.rejectedSnapshots.every(snapshot => snapshot.before === originalHtml && snapshot.after === originalHtml));
  assert.equal(run.files.get('index.html'), originalHtml);
  assert.match(result.toolHistory.at(-1).result, /3 failed attempts/);
  assert.match(result.response.answer, /could not be completed/);
  assert.equal(run.requests.at(-1).forceFinalAnswer, true);
  assert.deepEqual(run.requests.at(-1).enabledTools, []);
  assert.equal(run.checkpoints.at(-1).workspaceRevision, 0);
  assert.equal(run.checkpoints.at(-1).fileMutationCalls, 0);
  assert.deepEqual(run.failures, []);
});
