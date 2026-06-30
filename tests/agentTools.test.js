const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MAX_AGENT_TOOL_RESULT_CHARACTERS,
  agentToolCallSignature,
  normalizeAgentToolPath,
  parseAgentToolCall,
  truncateAgentToolResult
} = require('../out/agentTools');

test('canonicalizes semantically identical tool calls', () => {
  const first = agentToolCallSignature({
    id: 'call-1',
    name: 'read_file',
    arguments: { path: 'src\\app.ts' }
  });
  const second = agentToolCallSignature({
    id: 'call-2',
    name: 'read_file',
    arguments: { ignored: true, path: 'src/app.ts' }
  });

  assert.equal(first, second);
});

test('parses bounded read-only tool calls', () => {
  assert.deepEqual(parseAgentToolCall({
    id: 'call-1',
    name: 'list_files',
    arguments: { path: 'src', maxResults: 999 }
  }), {
    id: 'call-1',
    name: 'list_files',
    arguments: { path: 'src', maxResults: 200 }
  });

  assert.deepEqual(parseAgentToolCall({
    id: 'call-2',
    name: 'search_code',
    arguments: { query: 'permission', path: 'src\\api' }
  }), {
    id: 'call-2',
    name: 'search_code',
    arguments: { query: 'permission', path: 'src/api', maxResults: 20 }
  });
});

test('rejects absolute, traversal, and missing read paths', () => {
  for (const filePath of ['C:\\repo\\app.ts', '../app.ts', '/repo/app.ts', 'src/../app.ts']) {
    assert.throws(() => normalizeAgentToolPath(filePath), /workspace-relative|unsafe/);
  }
  assert.throws(() => parseAgentToolCall({
    id: 'call-3',
    name: 'read_file',
    arguments: {}
  }), /requires a path/);
  assert.throws(() => parseAgentToolCall({
    id: 'call-4',
    name: 'run_terminal',
    arguments: { command: 'npm test' }
  }), /unsupported tool/);
});

test('truncates oversized tool output', () => {
  const output = truncateAgentToolResult('a'.repeat(MAX_AGENT_TOOL_RESULT_CHARACTERS + 10));
  assert.match(output, /Tool result truncated/);
  assert.equal(output.length, MAX_AGENT_TOOL_RESULT_CHARACTERS);
});
