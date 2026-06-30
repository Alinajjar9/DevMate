const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('embedded DevMate webview script has valid JavaScript syntax', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'extension.ts'),
    'utf8'
  );
  const marker = '<script nonce="${nonce}">';
  const start = source.indexOf(marker);
  const end = source.indexOf('</script>', start);
  assert.ok(start >= 0 && end > start, 'webview script block was not found');
  const script = source.slice(start + marker.length, end);
  assert.doesNotThrow(() => new Function(script));
});

test('working card has visible motion with a reduced-motion fallback', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'extension.ts'),
    'utf8'
  );
  for (const animation of [
    'working-card-sheen',
    'working-edge-travel',
    'working-indicator-ring',
    'working-phase-sweep'
  ]) {
    assert.match(source, new RegExp('@keyframes\\s+' + animation));
  }
  assert.match(source, /@media \(prefers-reduced-motion: reduce\)/);
});
