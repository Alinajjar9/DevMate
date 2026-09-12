/** Opaque provider continuation data. Keep it out of tool arguments, chat text and progress events. */
export type ProviderState = {
  endpoint: string;
  model: string;
  outputItems: ProviderOutputItem[];
};

export type ProviderOutputItem =
  | {
    id: string;
    type: 'reasoning';
    summary: [];
    encrypted_content: string;
  }
  | {
    id?: string;
    type: 'function_call';
    call_id: string;
    name: string;
    arguments: string;
  }
  | {
    id?: string;
    type: 'message';
    role: 'assistant';
    content: { type: 'output_text'; text: string; annotations: [] }[];
    phase?: 'commentary' | 'final_answer';
  };

export const MAX_PROVIDER_STATE_CHARACTERS = 2_000_000;
export const MAX_PROVIDER_HISTORY_CHARACTERS = 8_000_000;

/** Validate data received from the backend or a saved checkpoint without interpreting encrypted reasoning. */
export function parseProviderState(value: unknown): ProviderState | undefined {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['endpoint', 'model', 'outputItems'])
    || !boundedString(value.endpoint, 2_048)
    || !boundedString(value.model, 120)
    || !Array.isArray(value.outputItems)
    || value.outputItems.length > 16) {
    return undefined;
  }
  const outputItems: ProviderOutputItem[] = [];
  for (const item of value.outputItems) {
    const parsed = parseOutputItem(item);
    if (!parsed) {
      return undefined;
    }
    outputItems.push(parsed);
  }
  const state: ProviderState = { endpoint: value.endpoint, model: value.model, outputItems };
  return JSON.stringify(state).length <= MAX_PROVIDER_STATE_CHARACTERS ? state : undefined;
}

function parseOutputItem(value: unknown): ProviderOutputItem | undefined {
  if (!isRecord(value) || (value.id !== undefined && !boundedString(value.id, 200))) {
    return undefined;
  }
  const identity = value.id === undefined ? {} : { id: value.id as string };
  if (value.type === 'reasoning'
    && hasOnlyKeys(value, ['id', 'type', 'summary', 'encrypted_content'])
    && boundedString(value.id, 200)
    && Array.isArray(value.summary) && value.summary.length === 0
    && boundedString(value.encrypted_content, 1_000_000)) {
    return { id: value.id, type: 'reasoning', summary: [], encrypted_content: value.encrypted_content };
  }
  if (value.type === 'function_call'
    && hasOnlyKeys(value, ['id', 'type', 'call_id', 'name', 'arguments'])
    && boundedString(value.call_id, 120)
    && boundedString(value.name, 120)
    && typeof value.arguments === 'string' && value.arguments.length <= 1_200_000) {
    return { ...identity, type: 'function_call', call_id: value.call_id, name: value.name, arguments: value.arguments };
  }
  if (value.type !== 'message'
    || !hasOnlyKeys(value, ['id', 'type', 'role', 'content', 'phase'])
    || value.role !== 'assistant'
    || !Array.isArray(value.content) || value.content.length > 8
    || (value.phase !== undefined && value.phase !== 'commentary' && value.phase !== 'final_answer')) {
    return undefined;
  }
  const content: Extract<ProviderOutputItem, { type: 'message' }>['content'] = [];
  for (const part of value.content) {
    if (!isRecord(part)
      || !hasOnlyKeys(part, ['type', 'text', 'annotations'])
      || part.type !== 'output_text'
      || typeof part.text !== 'string' || part.text.length > 400_000
      || !Array.isArray(part.annotations) || part.annotations.length !== 0) {
      return undefined;
    }
    content.push({ type: 'output_text', text: part.text, annotations: [] });
  }
  return { ...identity, type: 'message', role: 'assistant', content, ...(value.phase ? { phase: value.phase } : {}) };
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
