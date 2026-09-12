const assert = require('node:assert/strict');
const test = require('node:test');
const { ManagedCommandRegistry } = require('../out/managedCommands');

test('managed IDs stop only owned commands, maintain bounds and release completed slots', () => {
  const cleaned = [];
  let changes = 0;
  const registry = new ManagedCommandRegistry(() => { changes++; });
  const one = registry.add('first', stop => cleaned.push(['first', stop]));
  const two = registry.add('second', stop => cleaned.push(['second', stop]));
  registry.add('third', stop => cleaned.push(['third', stop]));
  assert.throws(() => registry.add('fourth', () => {}), /maximum 3/);
  assert.equal(registry.stop('arbitrary-user-terminal'), false);
  assert.equal(cleaned.length, 0);
  registry.append(one, '\u001b[31m' + 'x'.repeat(25000));
  assert.ok(registry.read(one).output.length <= 20000);
  registry.finish(one, 'exited (0)');
  assert.deepEqual(cleaned, [['first', false]]);
  assert.equal(registry.stop(one), true);
  assert.equal(cleaned.length, 1);
  registry.add('replacement', stop => cleaned.push(['replacement', stop]));
  registry.stop(two);
  registry.stopAll();
  assert.equal(registry.active().length, 0);
  assert.deepEqual(cleaned.slice(1), [['second', true], ['third', true], ['replacement', true]]);
  assert.ok(changes >= 8);
});
