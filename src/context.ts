import type { AskContextItem, ContextSource } from './api/types';

export const MAX_CONTEXT_CHARACTERS = 20_000;

export function createBoundedContextItem(
  source: ContextSource,
  filePath: string,
  languageId: string,
  content: string
): AskContextItem {
  const boundedContent = content.slice(0, MAX_CONTEXT_CHARACTERS);

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
