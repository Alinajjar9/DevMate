import type { ConversationTurn } from './api/types';

export const MAX_CONVERSATION_TURNS = 6;
export const MAX_CONVERSATION_TURN_CHARACTERS = 6_000;
export const MAX_CONVERSATION_HISTORY_CHARACTERS = 20_000;

export function appendConversationTurn(
  history: ConversationTurn[],
  user: string,
  assistant: string
): ConversationTurn[] {
  const turn = {
    user: user.trim().slice(0, MAX_CONVERSATION_TURN_CHARACTERS),
    assistant: assistant.trim().slice(0, MAX_CONVERSATION_TURN_CHARACTERS)
  };
  if (!turn.user || !turn.assistant) {
    return boundConversationHistory(history);
  }
  return boundConversationHistory([...history, turn]);
}

export function boundConversationHistory(history: ConversationTurn[]): ConversationTurn[] {
  const bounded: ConversationTurn[] = [];
  let characters = 0;
  for (const candidate of history.slice(-MAX_CONVERSATION_TURNS).reverse()) {
    if (!candidate || typeof candidate.user !== 'string' || typeof candidate.assistant !== 'string') {
      continue;
    }
    const turn = {
      user: candidate.user.trim().slice(0, MAX_CONVERSATION_TURN_CHARACTERS),
      assistant: candidate.assistant.trim().slice(0, MAX_CONVERSATION_TURN_CHARACTERS)
    };
    if (!turn.user || !turn.assistant) {
      continue;
    }
    const turnCharacters = turn.user.length + turn.assistant.length;
    if (characters + turnCharacters > MAX_CONVERSATION_HISTORY_CHARACTERS) {
      continue;
    }
    bounded.push(turn);
    characters += turnCharacters;
  }
  return bounded.reverse();
}
