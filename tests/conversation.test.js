const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createConversationSessionStore,
  MAX_CONVERSATION_HISTORY_CHARACTERS,
  MAX_CONVERSATION_TURNS,
  sessionModelHistoryAfter
} = require('../out/sessions');

test('keeps the newest bounded conversation turns', () => {
  const session = sessionWithTurns(Array.from(
    { length: MAX_CONVERSATION_TURNS + 3 },
    (_, index) => ({ user: `question ${index}`, assistant: `answer ${index}` })
  ));

  const history = sessionModelHistoryAfter(session);

  assert.equal(history.length, MAX_CONVERSATION_TURNS);
  assert.equal(history[0].user, 'question 3');
  assert.equal(history.at(-1).assistant, `answer ${MAX_CONVERSATION_TURNS + 2}`);
  assert.equal(session.turns.length, MAX_CONVERSATION_TURNS + 3);
});

test('bounds conversation characters and ignores incomplete turns', () => {
  const incomplete = sessionWithTurns([{ user: '', assistant: 'answer' }]);
  assert.deepEqual(sessionModelHistoryAfter(incomplete), []);
  const session = sessionWithTurns([
    ...Array.from({ length: 6 }, (_, index) => ({
      user: `question ${index}`, assistant: 'a'.repeat(6_000)
    })),
    { user: 'Still waiting for an answer', assistant: '' }
  ]);
  const originalTurns = structuredClone(session.turns);

  const history = sessionModelHistoryAfter(session);
  const characters = history.reduce(
    (total, turn) => total + turn.user.length + turn.assistant.length,
    0
  );
  assert.ok(history.length > 0);
  assert.ok(history.every((turn) => turn.user && turn.assistant));
  assert.ok(characters <= MAX_CONVERSATION_HISTORY_CHARACTERS);
  // Prompt limits must not delete or shorten the saved conversation.
  assert.deepEqual(session.turns, originalTurns);
});

function sessionWithTurns(turns) {
  const store = createConversationSessionStore('session', 1, {
    id: 'workspace', name: 'Workspace'
  });
  return { ...store.sessions[0], turns };
}
