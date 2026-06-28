"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_CONTEXT_CHARACTERS = void 0;
exports.createBoundedContextItem = createBoundedContextItem;
exports.MAX_CONTEXT_CHARACTERS = 20_000;
function createBoundedContextItem(source, filePath, languageId, content, maxCharacters = exports.MAX_CONTEXT_CHARACTERS) {
    const safeLimit = Math.min(Math.max(0, maxCharacters), exports.MAX_CONTEXT_CHARACTERS);
    const boundedContent = content.slice(0, safeLimit);
    return {
        source,
        filePath,
        languageId,
        content: boundedContent,
        includedCharacters: boundedContent.length,
        totalCharacters: content.length,
        truncated: boundedContent.length < content.length
    };
}
//# sourceMappingURL=context.js.map