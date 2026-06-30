const assert = require('node:assert/strict');
const test = require('node:test');

const {
  appendConversationTurn,
  MAX_CONVERSATION_HISTORY_CHARACTERS,
  MAX_CONVERSATION_TURNS
} = require('../out/conversation');

test('keeps the newest bounded conversation turns', () => {
  let history = [];
  for (let index = 0; index < MAX_CONVERSATION_TURNS + 3; index += 1) {
    history = appendConversationTurn(history, `question ${index}`, `answer ${index}`);
  }

  assert.equal(history.length, MAX_CONVERSATION_TURNS);
  assert.equal(history[0].user, 'question 3');
  assert.equal(history.at(-1).assistant, `answer ${MAX_CONVERSATION_TURNS + 2}`);
});

test('bounds conversation characters and ignores incomplete turns', () => {
  let history = appendConversationTurn([], '', 'answer');
  assert.deepEqual(history, []);
  for (let index = 0; index < 6; index += 1) {
    history = appendConversationTurn(history, `question ${index}`, 'a'.repeat(6_000));
  }
  const characters = history.reduce(
    (total, turn) => total + turn.user.length + turn.assistant.length,
    0
  );
  assert.ok(characters <= MAX_CONVERSATION_HISTORY_CHARACTERS);
});
