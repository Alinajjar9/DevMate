const assert = require('node:assert/strict');
const test = require('node:test');

const {
  boundConversationHistory,
  MAX_CONVERSATION_HISTORY_CHARACTERS,
  MAX_CONVERSATION_TURNS
} = require('../out/sessions');

test('keeps the newest bounded conversation turns', () => {
  let history = [];
  for (let index = 0; index < MAX_CONVERSATION_TURNS + 3; index += 1) {
    history.push({ user: `question ${index}`, assistant: `answer ${index}` });
  }
  history = boundConversationHistory(history);

  assert.equal(history.length, MAX_CONVERSATION_TURNS);
  assert.equal(history[0].user, 'question 3');
  assert.equal(history.at(-1).assistant, `answer ${MAX_CONVERSATION_TURNS + 2}`);
});

test('bounds conversation characters and ignores incomplete turns', () => {
  let history = boundConversationHistory([{ user: '', assistant: 'answer' }]);
  assert.deepEqual(history, []);
  for (let index = 0; index < 6; index += 1) {
    history.push({ user: `question ${index}`, assistant: 'a'.repeat(6_000) });
  }
  history = boundConversationHistory(history);
  const characters = history.reduce(
    (total, turn) => total + turn.user.length + turn.assistant.length,
    0
  );
  assert.ok(characters <= MAX_CONVERSATION_HISTORY_CHARACTERS);
});
