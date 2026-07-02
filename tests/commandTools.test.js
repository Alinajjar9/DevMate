const assert = require('node:assert/strict');
const test = require('node:test');

const {
  boundedModelCommandOutput,
  commandLabel,
  commandSignature,
  MAX_MODEL_COMMAND_OUTPUT_CHARACTERS,
  parseRunCommandArguments,
  sanitizeCommandOutput
} = require('../out/commandTools');

test('accepts bounded verification commands', () => {
  const commands = [
    { executable: 'npm', args: ['test'] },
    { executable: 'npm', args: ['run', 'typecheck'] },
    { executable: 'npx', args: ['--no-install', 'tsc', '--noEmit'] },
    { executable: 'py', args: ['-m', 'unittest'] },
    { executable: 'cargo', args: ['fmt', '--check'] },
    { executable: './gradlew', args: ['test'] }
  ];

  for (const command of commands) {
    assert.doesNotThrow(() => parseRunCommandArguments(command));
  }
});

test('normalizes safe legacy command strings without invoking a shell', () => {
  assert.deepEqual(parseRunCommandArguments({
    command: 'python -m unittest test_app.py -v',
    cwd: '.'
  }), {
    executable: 'python',
    args: ['-m', 'unittest', 'test_app.py', '-v'],
    cwd: '',
    timeoutSeconds: 1800
  });
  assert.deepEqual(parseRunCommandArguments({
    executable: 'python',
    args: 'python -m unittest "test app.py" -v'
  }).args, ['-m', 'unittest', 'test app.py', '-v']);
  assert.throws(() => parseRunCommandArguments({
    command: 'python -m unittest test_app.py && calc'
  }), /shell operators/);
});

test('rejects shell, install, write, watch, git, and arbitrary commands', () => {
  const commands = [
    { executable: 'npm', args: ['install'] },
    { executable: 'npm', args: ['run', 'test:watch'] },
    { executable: 'prettier', args: ['--write', '.'] },
    { executable: 'npx', args: ['eslint', '.'] },
    { executable: 'python', args: ['-c', 'print(1)'] },
    { executable: 'git', args: ['status'] },
    { executable: 'npm', args: ['test', '; rm -rf .'] },
    { executable: 'powershell', args: ['-Command', 'npm test'] },
    { executable: 'npm', args: ['test'], cwd: 'node_modules/pkg' },
    { executable: 'node', args: ['--test', 'C:\\outside\\test.js'] },
    { executable: 'pytest', args: ['../outside'] }
  ];

  for (const command of commands) {
    assert.throws(() => parseRunCommandArguments(command));
  }
});

test('redirects filesystem commands to dedicated agent tools', () => {
  const cases = [
    [{ executable: 'mkdir', args: ['templates'] }, /create_file and move_file create destination directories/],
    [{ executable: 'move', args: ['index.html', 'templates/index.html'] }, /Use move_file/],
    [{ executable: 'mv', args: ['index.html', 'templates/index.html'] }, /Use move_file/],
    [{ executable: 'rename', args: ['app.py', 'main.py'] }, /Use rename_file/],
    [{ executable: 'rm', args: ['old.py'] }, /Use delete_file/],
    [{ executable: 'rmdir', args: ['old'] }, /does not delete directories/],
    [{ executable: 'copy', args: ['a.py', 'b.py'] }, /read_file and then create_file/],
    [{ executable: 'touch', args: ['app.py'] }, /Use create_file/]
  ];

  for (const [command, expected] of cases) {
    assert.throws(() => parseRunCommandArguments(command), expected);
  }
});

test('normalizes exact command signatures by command, arguments, and cwd', () => {
  const first = parseRunCommandArguments({ executable: 'npm', args: ['test'], cwd: 'frontend' });
  const same = parseRunCommandArguments({ executable: 'npm', args: ['test'], cwd: 'frontend/' });
  const different = parseRunCommandArguments({ executable: 'npm', args: ['test'], cwd: 'backend' });

  assert.equal(commandSignature(first), commandSignature(same));
  assert.notEqual(commandSignature(first), commandSignature(different));
  assert.equal(commandLabel(first), 'npm test');
  assert.equal(
    commandSignature(parseRunCommandArguments({ executable: 'npm', args: ['test'], cwd: '.' })),
    commandSignature(parseRunCommandArguments({ executable: 'npm', args: ['test'] }))
  );
});

test('sanitizes and bounds command output', () => {
  assert.equal(sanitizeCommandOutput('\u001b[31mfailed\u001b[0m\r\nnext\u0000'), 'failed\nnext');
  const bounded = boundedModelCommandOutput('x'.repeat(MAX_MODEL_COMMAND_OUTPUT_CHARACTERS + 100));
  assert.match(bounded, /Earlier output omitted/);
  assert.ok(bounded.length <= MAX_MODEL_COMMAND_OUTPUT_CHARACTERS);
});
