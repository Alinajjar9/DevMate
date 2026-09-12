const assert = require('node:assert/strict');
const test = require('node:test');
const { formatReadFileResult } = require('../out/fileTools');

function read(content, options = {}) {
  return formatReadFileResult({
    path: 'app.ts', languageId: 'typescript', content, startLine: 1, endLine: 400,
    maxCharacters: 10_000, ...options
  });
}

function returnedContent(result) {
  return result.slice(result.indexOf('Content:\n') + 'Content:\n'.length);
}

test('read_file returns complete lines with an accurate range and continuation after the result limit', () => {
  const lines = ['a'.repeat(150), 'b'.repeat(150), 'c'.repeat(150)];
  const first = read(lines.join('\n'), { maxCharacters: 400 });
  assert.ok(first.result.length <= 400);
  assert.match(first.result, /Lines: 1-1 of 3/);
  assert.match(first.result, /Next read: startLine=2\. Line 2 was not returned/);
  assert.equal(returnedContent(first.result), lines[0]);
  assert.equal(first.resultSummary, '150 characters read');

  const remainder = read(lines.join('\n'), { startLine: 2, maxCharacters: 400 });
  assert.match(remainder.result, /Lines: 2-3 of 3/);
  assert.doesNotMatch(remainder.result, /Next read|truncated/);
  assert.equal(returnedContent(remainder.result), lines.slice(1).join('\n'));
});

test('read_file clearly reports an oversized line without returning a misleading partial line', () => {
  const oversized = 'x'.repeat(20_000);
  const response = read(`${oversized}\nsecond`);
  assert.ok(response.result.length <= 10_000);
  assert.match(response.result, /Lines: none of 2/);
  assert.match(response.result, /Line 1 cannot fit.*No text from this line was returned/);
  assert.match(response.result, /repeating this read will not help/);
  assert.equal(returnedContent(response.result), '');
  assert.equal(response.resultSummary, '0 characters read');
});

test('read_file suggests a single-line request when only its continuation note prevents a complete line from fitting', () => {
  const content = `${'x'.repeat(320)}\n${'y'.repeat(320)}`;
  const response = read(content, { maxCharacters: 400 });
  assert.match(response.result, /Read just this line with startLine=1, endLine=1/);
  assert.doesNotMatch(response.result, /cannot fit|repeating this read/);
  const single = read(content, { endLine: 1, maxCharacters: 400 });
  assert.equal(returnedContent(single.result), 'x'.repeat(320));
});

test('read_file preserves blank lines and normalizes CRLF for exact replacement matching', () => {
  const response = read('first\r\n\r\nlast\r\n', { startLine: 2, endLine: 4 });
  assert.match(response.result, /Lines: 2-4 of 4/);
  assert.equal(returnedContent(response.result), '\nlast\n');
  assert.equal(response.resultSummary, '6 characters read');
});

test('read_file reports an empty file without inventing a returned line', () => {
  const response = read('');
  assert.match(response.result, /Lines: none of 0 \(empty file\)/);
  assert.equal(returnedContent(response.result), '');
  assert.equal(response.resultSummary, '0 characters read');
});

test('read_file caps its range at EOF and includes a complete response exactly at the character limit', () => {
  const response = read('first\nsecond', { startLine: 2 });
  assert.match(response.result, /Lines: 2-2 of 2/);
  assert.equal(returnedContent(response.result), 'second');
  assert.equal(read('first\nsecond', { startLine: 2, maxCharacters: response.result.length }).result, response.result);
  assert.throws(() => read('first\nsecond', { startLine: 3 }), /has only 2 lines/);
});
