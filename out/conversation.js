"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_CONVERSATION_HISTORY_CHARACTERS = exports.MAX_CONVERSATION_TURN_CHARACTERS = exports.MAX_CONVERSATION_TURNS = void 0;
exports.appendConversationTurn = appendConversationTurn;
exports.boundConversationHistory = boundConversationHistory;
exports.MAX_CONVERSATION_TURNS = 6;
exports.MAX_CONVERSATION_TURN_CHARACTERS = 6_000;
exports.MAX_CONVERSATION_HISTORY_CHARACTERS = 20_000;
function appendConversationTurn(history, user, assistant) {
    const turn = {
        user: user.trim().slice(0, exports.MAX_CONVERSATION_TURN_CHARACTERS),
        assistant: assistant.trim().slice(0, exports.MAX_CONVERSATION_TURN_CHARACTERS)
    };
    if (!turn.user || !turn.assistant) {
        return boundConversationHistory(history);
    }
    return boundConversationHistory([...history, turn]);
}
function boundConversationHistory(history) {
    const bounded = [];
    let characters = 0;
    for (const candidate of history.slice(-exports.MAX_CONVERSATION_TURNS).reverse()) {
        if (!candidate || typeof candidate.user !== 'string' || typeof candidate.assistant !== 'string') {
            continue;
        }
        const turn = {
            user: candidate.user.trim().slice(0, exports.MAX_CONVERSATION_TURN_CHARACTERS),
            assistant: candidate.assistant.trim().slice(0, exports.MAX_CONVERSATION_TURN_CHARACTERS)
        };
        if (!turn.user || !turn.assistant) {
            continue;
        }
        const turnCharacters = turn.user.length + turn.assistant.length;
        if (characters + turnCharacters > exports.MAX_CONVERSATION_HISTORY_CHARACTERS) {
            continue;
        }
        bounded.push(turn);
        characters += turnCharacters;
    }
    return bounded.reverse();
}
//# sourceMappingURL=conversation.js.map