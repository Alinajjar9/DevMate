const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MAX_CAPTURED_TERMINAL_OUTPUT_CHARACTERS,
  formatCapturedTerminalErrors,
  sanitizeCapturedTerminalText
} = require('../out/errorContext');

test('sanitizes terminal control sequences and common secrets', () => {
  const value = [
    '\u001b[31mfailed\u001b[0m',
    'Authorization: Bearer abc123',
    'API_KEY=super-secret',
    '--token hidden',
    'https://user:private-password@example.com',
    'nvapi-1234567890abcdef'
  ].join('\r\n');
  const sanitized = sanitizeCapturedTerminalText(value);

  assert.match(sanitized, /^failed/m);
  assert.doesNotMatch(sanitized, /abc123|super-secret|hidden|private-password|nvapi-/);
  assert.match(sanitized, /\[REDACTED\]/);
});

test('bounds and formats newest terminal failures for model context', () => {
  const entries = Array.from({ length: 6 }, (_, index) => ({
    command: `npm test ${index}`,
    cwd: 'frontend',
    terminalName: 'PowerShell',
    exitCode: index + 1,
    output: index === 0 ? 'x'.repeat(MAX_CAPTURED_TERMINAL_OUTPUT_CHARACTERS + 100) : `failed ${index}`,
    capturedAt: 100 - index
  }));
  const formatted = formatCapturedTerminalErrors(entries, 2);

  assert.match(formatted, /failed workspace terminal commands \(2, newest first\)/);
  assert.match(formatted, /npm test 0/);
  assert.match(formatted, /Earlier output omitted/);
  assert.doesNotMatch(formatted, /npm test 2/);
});

test('explains when no shell-integrated terminal failure was captured', () => {
  assert.match(formatCapturedTerminalErrors([], 3), /No failed workspace terminal commands/);
  assert.match(formatCapturedTerminalErrors([], 3), /Shell Integration/);
});
