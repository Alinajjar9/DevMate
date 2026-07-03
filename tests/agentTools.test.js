const assert = require('node:assert/strict');
const test = require('node:test');

const {
  AGENT_TOOL_NAMES,
  DEFAULT_AGENT_TOOL_CALL_LIMIT,
  FILE_MUTATION_AGENT_TOOL_NAMES,
  MAX_AGENT_CONSECUTIVE_INSPECTIONS,
  MAX_AGENT_TOOL_CALL_LIMIT,
  MAX_AGENT_TOOL_ARGUMENT_HISTORY_CHARACTERS,
  MIN_AGENT_TOOL_CALL_LIMIT,
  READ_ONLY_AGENT_TOOL_NAMES,
  MAX_AGENT_TOOL_HISTORY_CHARACTERS,
  MAX_AGENT_TOOL_RESULT_CHARACTERS,
  agentToolCallSignature,
  boundedAgentToolCallLimit,
  boundedAgentToolHistoryArguments,
  compactAgentToolHistory,
  consecutiveAgentInspectionCalls,
  isDeferredAgentPlanAnswer,
  isFileMutationAgentTool,
  isReadOnlyAgentTool,
  normalizeAgentToolCallForWorkspace,
  normalizeAgentToolPath,
  parseAgentToolCall,
  summarizedAgentToolArguments,
  summarizeAgentToolHistory,
  truncateAgentToolResult
} = require('../out/agentTools');

const workspace = {
  name: 'testing the ai project',
  fsPath: 'C:\\Users\\ali\\Desktop\\testing the ai project'
};

test('bounds configurable agent tool-call limits', () => {
  assert.equal(boundedAgentToolCallLimit(undefined), DEFAULT_AGENT_TOOL_CALL_LIMIT);
  assert.equal(boundedAgentToolCallLimit(1), MIN_AGENT_TOOL_CALL_LIMIT);
  assert.equal(boundedAgentToolCallLimit(24), 24);
  assert.equal(boundedAgentToolCallLimit(100), 100);
  assert.equal(boundedAgentToolCallLimit(101), MAX_AGENT_TOOL_CALL_LIMIT);
});

test('keeps navigation tools inside the shared read-only group', () => {
  for (const name of ['get_symbols', 'find_definition', 'find_references']) {
    assert.equal(isReadOnlyAgentTool(name), true);
    assert.equal(isFileMutationAgentTool(name), false);
  }
  assert.equal(isFileMutationAgentTool('edit_file'), true);
});

test('classifies every supported agent tool exactly once', () => {
  const grouped = [
    ...READ_ONLY_AGENT_TOOL_NAMES,
    ...FILE_MUTATION_AGENT_TOOL_NAMES,
    'install_dependencies',
    'run_command'
  ];
  assert.deepEqual(new Set(grouped), new Set(AGENT_TOOL_NAMES));
  assert.equal(grouped.length, AGENT_TOOL_NAMES.length);
});

test('recognizes short future-action preambles as unfinished agent answers', () => {
  for (const answer of [
    "I'll start by reading the key files, then build the login modal.",
    'I will first inspect the project structure.',
    'Let me examine the current backend before implementing authentication.',
    'Sure, I’ll now reorganize the frontend assets.'
  ]) {
    assert.equal(isDeferredAgentPlanAnswer(answer), true);
  }
  for (const answer of [
    'Created the login modal and added the authentication endpoint.',
    'I could not edit the project because the workspace is untrusted.',
    'The issue is caused by a missing route registration.'
  ]) {
    assert.equal(isDeferredAgentPlanAnswer(answer), false);
  }
});

test('compacts oldest tool results when a higher call limit fills context', () => {
  const history = Array.from({ length: 10 }, (_, index) => ({
    name: 'read_file',
    result: String(index).repeat(10_000)
  }));
  const compacted = compactAgentToolHistory(history);
  assert.ok(compacted.reduce((total, step) => total + step.result.length, 0)
    <= MAX_AGENT_TOOL_HISTORY_CHARACTERS);
  assert.match(compacted[0].result, /omitted/);
  assert.equal(compacted.at(-1).result, history.at(-1).result);
  assert.equal(history[0].result.length, 10_000);
});

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

test('parses bounded ranged reads', () => {
  assert.deepEqual(parseAgentToolCall({
    id: 'range',
    name: 'read_file',
    arguments: { path: 'src/app.ts', startLine: 20, endLine: 40 }
  }).arguments, {
    path: 'src/app.ts',
    startLine: 20,
    endLine: 40
  });
  assert.deepEqual(parseAgentToolCall({
    id: 'range-configurable',
    name: 'read_file',
    arguments: { path: 'src/large.ts', startLine: 1, endLine: 700 }
  }).arguments, {
    path: 'src/large.ts',
    startLine: 1,
    endLine: 700
  });
  assert.throws(() => parseAgentToolCall({
    id: 'range-large',
    name: 'read_file',
    arguments: { path: 'src/app.ts', startLine: 1, endLine: 1001 }
  }), /at most 1000 lines/);
});

test('parses bounded code-navigation tools with one-based positions', () => {
  assert.deepEqual(parseAgentToolCall({
    id: 'symbols',
    name: 'get_symbols',
    arguments: { path: 'src/app.ts', maxResults: 999 }
  }).arguments, {
    path: 'src/app.ts',
    maxResults: 300
  });
  assert.deepEqual(parseAgentToolCall({
    id: 'definition',
    name: 'find_definition',
    arguments: { path: 'src/app.ts', line: 14, column: 8 }
  }).arguments, {
    path: 'src/app.ts',
    line: 14,
    column: 8,
    maxResults: 20
  });
  assert.deepEqual(parseAgentToolCall({
    id: 'references',
    name: 'find_references',
    arguments: { path: 'src/app.ts', line: 14, column: 8, maxResults: 80 }
  }).arguments, {
    path: 'src/app.ts',
    line: 14,
    column: 8,
    maxResults: 80
  });
  assert.throws(() => parseAgentToolCall({
    id: 'bad-position',
    name: 'find_definition',
    arguments: { path: 'src/app.ts', line: 0, column: 1 }
  }), /positive one-based line/);
});

test('normalizes harmless workspace-qualified model paths', () => {
  assert.equal(normalizeAgentToolCallForWorkspace({
    id: 'absolute-read',
    name: 'read_file',
    arguments: { path: 'C:\\Users\\ali\\Desktop\\testing the ai project\\app.py' }
  }, workspace).arguments.path, 'app.py');
  assert.equal(normalizeAgentToolCallForWorkspace({
    id: 'absolute-symbols',
    name: 'get_symbols',
    arguments: { path: 'C:\\Users\\ali\\Desktop\\testing the ai project\\src\\app.ts' }
  }, workspace).arguments.path, 'src/app.ts');
  assert.equal(normalizeAgentToolCallForWorkspace({
    id: 'named-root',
    name: 'list_files',
    arguments: { path: 'testing the ai project' }
  }, workspace).arguments.path, '');
  assert.equal(normalizeAgentToolCallForWorkspace({
    id: 'named-file',
    name: 'edit_file',
    arguments: { path: 'testing the ai project/test_app.py', replacements: [] }
  }, workspace).arguments.path, 'test_app.py');
  assert.deepEqual(normalizeAgentToolCallForWorkspace({
    id: 'named-move',
    name: 'move_file',
    arguments: {
      path: 'testing the ai project/app.py',
      newPath: 'testing the ai project/src/app.py'
    }
  }, workspace).arguments, {
    path: 'app.py',
    newPath: 'src/app.py'
  });
  assert.equal(normalizeAgentToolCallForWorkspace({
    id: 'dot-cwd',
    name: 'run_command',
    arguments: { executable: 'python', args: ['-m', 'unittest'], cwd: '.' }
  }, workspace).arguments.cwd, '');
  assert.equal(normalizeAgentToolCallForWorkspace({
    id: 'named-cwd',
    name: 'run_command',
    arguments: { executable: 'python', args: ['-m', 'unittest'], cwd: 'testing the ai project' }
  }, workspace).arguments.cwd, '');
});

test('keeps outside and traversing paths available for strict rejection', () => {
  assert.equal(normalizeAgentToolCallForWorkspace({
    id: 'outside',
    name: 'read_file',
    arguments: { path: 'C:\\Users\\ali\\Desktop\\outside.py' }
  }, workspace).arguments.path, 'C:\\Users\\ali\\Desktop\\outside.py');
  assert.equal(normalizeAgentToolCallForWorkspace({
    id: 'traversal',
    name: 'read_file',
    arguments: { path: 'testing the ai project/../outside.py' }
  }, workspace).arguments.path, '../outside.py');
});

test('parses mutation tools and summarizes large history arguments', () => {
  const create = parseAgentToolCall({
    id: 'create',
    name: 'create_file',
    arguments: { path: 'src/new.ts', content: 'export const ready = true;' }
  });
  const edit = parseAgentToolCall({
    id: 'edit',
    name: 'edit_file',
    arguments: {
      path: 'src/app.ts',
      replacements: [{ oldText: 'false', newText: 'true' }]
    }
  });

  assert.equal(create.arguments.path, 'src/new.ts');
  assert.deepEqual(edit.arguments.replacements, [{ oldText: 'false', newText: 'true' }]);
  assert.match(summarizedAgentToolArguments(create).content, /omitted after execution/);
  assert.match(summarizedAgentToolArguments(create).content, /never use as file content/);
  assert.notEqual(
    agentToolCallSignature({ ...create, arguments: { path: 'src/new.ts', content: 'one' } }),
    agentToolCallSignature({ ...create, arguments: { path: 'src/new.ts', content: 'two' } })
  );

  const largeEdit = parseAgentToolCall({
    id: 'large-edit',
    name: 'edit_file',
    arguments: {
      path: 'src/large.ts',
      replacements: Array.from({ length: 20 }, (_, index) => ({
        oldText: `old-${index}-${'x'.repeat(100)}`,
        newText: `new-${index}-${'y'.repeat(100)}`
      }))
    }
  });
  const editHistory = summarizedAgentToolArguments(largeEdit);
  assert.equal(editHistory.replacementCount, 20);
  assert.match(editHistory.replacements, /omitted after execution/);
  assert.ok(JSON.stringify(editHistory).length <= MAX_AGENT_TOOL_ARGUMENT_HISTORY_CHARACTERS);

  const invalidHistory = boundedAgentToolHistoryArguments('invalid', {
    value: 'z'.repeat(MAX_AGENT_TOOL_ARGUMENT_HISTORY_CHARACTERS + 1)
  });
  assert.match(invalidHistory.summary, /omitted after execution/);
  assert.ok(JSON.stringify(invalidHistory).length <= MAX_AGENT_TOOL_ARGUMENT_HISTORY_CHARACTERS);
});

test('bounds consecutive inspection loops until meaningful progress', () => {
  const inspections = Array.from({ length: MAX_AGENT_CONSECUTIVE_INSPECTIONS }, (_, index) => ({
    name: index % 2 === 0 ? 'read_file' : 'search_code',
    isError: false
  }));
  assert.equal(consecutiveAgentInspectionCalls(inspections), MAX_AGENT_CONSECUTIVE_INSPECTIONS);
  assert.equal(consecutiveAgentInspectionCalls([
    ...inspections,
    { name: 'edit_file', isError: false },
    { name: 'get_diagnostics', isError: false },
    { name: 'find_references', isError: false },
    { name: 'read_terminal_errors', isError: false }
  ]), 3);
});

test('builds an honest local summary when a model cannot finalize tool work', () => {
  const summary = summarizeAgentToolHistory([
    {
      name: 'create_file',
      arguments: { path: 'static/styles.css', content: '[history omitted]' },
      result: 'Applied file changes:\n- Created static/styles.css',
      isError: false
    },
    {
      name: 'run_command',
      arguments: { executable: 'npm', args: ['test'], cwd: '' },
      result: 'Exit code: 0\nDuration: 1 second',
      isError: false
    },
    {
      name: 'read_file',
      arguments: { path: 'missing.css' },
      result: 'The file does not exist.',
      isError: true
    }
  ], 'The model requested another tool when DevMate required a final answer.');

  assert.match(summary, /Created static\/styles\.css/);
  assert.match(summary, /npm test exited with code 0/);
  assert.match(summary, /1 tool request failed or was rejected/);
  assert.match(summary, /requested another tool/);
});

test('parses and signs file lifecycle tools', () => {
  const deletion = parseAgentToolCall({
    id: 'delete',
    name: 'delete_file',
    arguments: { path: 'src/old.ts' }
  });
  const rename = parseAgentToolCall({
    id: 'rename',
    name: 'rename_file',
    arguments: { path: 'src/old.ts', newPath: 'src/new.ts' }
  });
  const move = parseAgentToolCall({
    id: 'move',
    name: 'move_file',
    arguments: { path: 'src/new.ts', newPath: 'archive/new.ts' }
  });

  assert.deepEqual(deletion.arguments, { path: 'src/old.ts' });
  assert.equal(rename.arguments.newPath, 'src/new.ts');
  assert.equal(move.arguments.newPath, 'archive/new.ts');
  assert.notEqual(
    agentToolCallSignature({ ...move, arguments: { path: 'src/new.ts', newPath: 'one/new.ts' } }),
    agentToolCallSignature({ ...move, arguments: { path: 'src/new.ts', newPath: 'two/new.ts' } })
  );
});

test('parses verification command calls through the safe registry', () => {
  assert.deepEqual(parseAgentToolCall({
    id: 'command',
    name: 'run_command',
    arguments: { executable: 'npm', args: ['test'], cwd: 'frontend' }
  }).arguments, {
    executable: 'npm',
    args: ['test'],
    cwd: 'frontend',
    timeoutSeconds: 1800
  });
});

test('parses manifest-based dependency installation calls', () => {
  assert.deepEqual(parseAgentToolCall({
    id: 'dependencies',
    name: 'install_dependencies',
    arguments: { manifestPath: 'backend/requirements.txt', timeoutSeconds: 900 }
  }).arguments, {
    manifestPath: 'backend/requirements.txt',
    cwd: 'backend',
    timeoutSeconds: 900
  });
});

test('parses bounded read-only tool calls', () => {
  assert.deepEqual(parseAgentToolCall({
    id: 'call-1',
    name: 'list_files',
    arguments: { path: 'src', maxResults: 999 }
  }), {
    id: 'call-1',
    name: 'list_files',
    arguments: { path: 'src', maxResults: 500 }
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

  assert.deepEqual(parseAgentToolCall({
    id: 'diagnostics',
    name: 'get_diagnostics',
    arguments: { path: 'src\\api', maxResults: 999 }
  }).arguments, {
    path: 'src/api',
    maxResults: 300
  });

  assert.deepEqual(parseAgentToolCall({
    id: 'terminal-errors',
    name: 'read_terminal_errors',
    arguments: { maxResults: 999 }
  }).arguments, {
    maxResults: 10
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
