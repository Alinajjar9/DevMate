const fs = require('node:fs');
const path = require('node:path');

const repositoryRoot = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
}

function capture(source, pattern, label) {
  const match = source.match(pattern);
  if (!match) {
    throw new Error(`Could not find ${label}.`);
  }
  return match[1];
}

function quotedValues(value) {
  return [...value.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]);
}

function assertSameValues(label, typeScriptValues, pythonValues) {
  const left = [...typeScriptValues].sort();
  const right = [...pythonValues].sort();
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error(`${label} differs between TypeScript and Python.\nTypeScript: ${left.join(', ')}\nPython: ${right.join(', ')}`);
  }
}

function numericConstant(source, name, language) {
  const prefix = language === 'typescript' ? `export const ${name} =` : `${name} =`;
  const expression = capture(
    source,
    new RegExp(`${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*([0-9_]+)`),
    `${language} constant ${name}`
  );
  return Number(expression.replaceAll('_', ''));
}

function stringConstant(source, name, language) {
  const prefix = language === 'typescript' ? `export const ${name} =` : `${name} =`;
  return capture(
    source,
    new RegExp(`${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*["']([^"']+)["']`),
    `${language} constant ${name}`
  );
}

const apiTypes = read('src/api/types.ts');
const agentTools = read('src/agentTools.ts');
const projectIndex = read('src/projectIndex.ts');
const sessions = read('src/sessions.ts');
const backendApiModels = read('backend/app/api_models.py');
const embeddingProfiles = read('src/embeddingProfiles.ts');
const backendEmbeddingProviders = read('backend/app/embedding_providers.py');
const backendKnowledgeStore = read('backend/app/knowledge_store.py');
const backendKnowledgeContracts = read('backend/app/knowledge_contracts.py');

const literalContracts = [
  {
    label: 'AssistantMode',
    typeScript: quotedValues(capture(apiTypes, /export type AssistantMode\s*=\s*([^;]+);/, 'TypeScript AssistantMode')),
    python: quotedValues(capture(backendApiModels, /AssistantMode\s*=\s*Literal\[([^\]]+)\]/, 'Python AssistantMode'))
  },
  {
    label: 'ScopeType',
    typeScript: quotedValues(capture(apiTypes, /export type ScopeType\s*=\s*([^;]+);/, 'TypeScript ScopeType')),
    python: quotedValues(capture(backendApiModels, /ScopeType\s*=\s*Literal\[([^\]]+)\]/, 'Python ScopeType'))
  },
  {
    label: 'ContextSource',
    typeScript: quotedValues(capture(apiTypes, /export type ContextSource\s*=\s*([^;]+);/, 'TypeScript ContextSource')),
    python: quotedValues(capture(backendApiModels, /ContextSource\s*=\s*Literal\[([^\]]+)\]/, 'Python ContextSource'))
  },
  {
    label: 'AgentToolName',
    typeScript: quotedValues(capture(agentTools, /export const AGENT_TOOL_NAMES\s*=\s*\[([\s\S]*?)\]\s*as const;/, 'TypeScript agent tools')),
    python: quotedValues(capture(backendApiModels, /AgentToolName\s*=\s*Literal\[([\s\S]*?)\]/, 'Python agent tools'))
  },
  {
    label: 'BackendCapability',
    typeScript: quotedValues(capture(apiTypes, /export const DEVMATE_BACKEND_CAPABILITIES\s*=\s*\[([\s\S]*?)\]\s*as const;/, 'TypeScript backend capabilities')),
    python: quotedValues(capture(backendApiModels, /BackendCapability\s*=\s*Literal\[([^\]]+)\]/, 'Python backend capabilities'))
  },
  {
    label: 'BackendErrorCode',
    typeScript: quotedValues(capture(apiTypes, /export const DEVMATE_BACKEND_ERROR_CODES\s*=\s*\[([\s\S]*?)\]\s*as const;/, 'TypeScript backend error codes')),
    python: quotedValues(capture(backendApiModels, /BackendErrorCode\s*=\s*Literal\[([\s\S]*?)\]/, 'Python backend error codes'))
  },
  {
    label: 'EmbeddingProviderName',
    typeScript: quotedValues(capture(embeddingProfiles, /export const EMBEDDING_PROVIDER_NAMES\s*=\s*\[([^\]]+)\]\s*as const;/, 'TypeScript embedding providers')),
    python: quotedValues(capture(backendEmbeddingProviders, /EmbeddingProviderName\s*=\s*Literal\[([^\]]+)\]/, 'Python embedding providers'))
  },
  {
    label: 'KnowledgeIndexState',
    typeScript: quotedValues(capture(apiTypes, /export type KnowledgeIndexState\s*=\s*([^;]+);/, 'TypeScript knowledge index states')),
    python: quotedValues(capture(backendKnowledgeContracts, /IndexState\s*=\s*Literal\[([^\]]+)\]/, 'Python knowledge index states'))
  }
];

for (const contract of literalContracts) {
  assertSameValues(contract.label, contract.typeScript, contract.python);
}

const numericContracts = [
  ['DEVMATE_BACKEND_PROTOCOL_VERSION', apiTypes],
  ['MIN_BACKEND_TOKEN_CHARACTERS', apiTypes],
  ['MAX_BACKEND_TOKEN_CHARACTERS', apiTypes],
  ['MAX_CONTEXT_CHARACTERS', projectIndex],
  ['MAX_PROJECT_FILE_CHARACTERS', projectIndex],
  ['MAX_PROJECT_CONTEXT_CHARACTERS', projectIndex],
  ['MAX_ATTACHED_FILES', projectIndex],
  ['MAX_AGENT_TOOL_RESULT_CHARACTERS', agentTools],
  ['MAX_AGENT_TOOL_HISTORY_CHARACTERS', agentTools],
  ['MAX_CONVERSATION_TURNS', sessions],
  ['MAX_CONVERSATION_TURN_CHARACTERS', sessions],
  ['MAX_CONVERSATION_HISTORY_CHARACTERS', sessions]
];

for (const [name, typeScriptSource] of numericContracts) {
  const typeScriptValue = numericConstant(typeScriptSource, name, 'typescript');
  const pythonValue = numericConstant(backendApiModels, name, 'python');
  if (typeScriptValue !== pythonValue) {
    throw new Error(`${name} differs between TypeScript (${typeScriptValue}) and Python (${pythonValue}).`);
  }
}

const knowledgeNumericContracts = [
  'DEVMATE_KNOWLEDGE_INDEX_API_VERSION',
  'MAX_WORKSPACE_KEY_CHARACTERS',
  'MAX_WORKSPACE_ROOT_CHARACTERS',
  'MAX_RELATIVE_PATH_CHARACTERS',
  'MAX_LANGUAGE_ID_CHARACTERS',
  'MAX_CONTENT_HASH_CHARACTERS',
  'MAX_CHUNK_STABLE_ID_CHARACTERS',
  'MAX_CHUNK_CHARACTERS',
  'MAX_CHUNKS_PER_FILE',
  'MAX_FILE_CHANGES_PER_BATCH',
  'MAX_INDEX_BATCH_CONTENT_CHARACTERS',
  'MAX_LEXICAL_QUERY_CHARACTERS',
  'MAX_LEXICAL_QUERY_TERMS',
  'MAX_LEXICAL_RESULTS',
  'MAX_SEMANTIC_QUERY_CHARACTERS',
  'MAX_SEMANTIC_RESULTS',
  'MAX_INDEX_INTEGER'
];

for (const name of knowledgeNumericContracts) {
  const typeScriptValue = numericConstant(apiTypes, name, 'typescript');
  const pythonValue = numericConstant(backendKnowledgeContracts, name, 'python');
  if (typeScriptValue !== pythonValue) {
    throw new Error(`${name} differs between TypeScript (${typeScriptValue}) and Python (${pythonValue}).`);
  }
}

const embeddingNumericContracts = [
  'MAX_EMBEDDING_PROFILE_ID_CHARACTERS',
  'MAX_EMBEDDING_MODEL_CHARACTERS',
  'MAX_EMBEDDING_DIMENSIONS',
  'MAX_EMBEDDING_BATCH_SIZE',
  'MAX_EMBEDDING_BASE_URL_CHARACTERS',
  'MAX_EMBEDDING_API_KEY_CHARACTERS',
  'MAX_EMBEDDING_INDEX_BATCHES_PER_RUN'
];

for (const name of embeddingNumericContracts) {
  const typeScriptValue = numericConstant(apiTypes, name, 'typescript');
  const pythonValue = numericConstant(backendEmbeddingProviders, name, 'python');
  if (typeScriptValue !== pythonValue) {
    throw new Error(`${name} differs between TypeScript (${typeScriptValue}) and Python (${pythonValue}).`);
  }
}

const stringContracts = [
  'DEVMATE_BACKEND_SERVICE',
  'DEVMATE_BACKEND_TOKEN_HEADER',
  'DEVMATE_BACKEND_TOKEN_ENVIRONMENT_VARIABLE'
];

for (const name of stringContracts) {
  const typeScriptValue = stringConstant(apiTypes, name, 'typescript');
  const pythonValue = stringConstant(backendApiModels, name, 'python');
  if (typeScriptValue !== pythonValue) {
    throw new Error(`${name} differs between TypeScript (${typeScriptValue}) and Python (${pythonValue}).`);
  }
}

const knowledgeStoreStringContracts = [
  'DEVMATE_KNOWLEDGE_STORE_PATH_ENVIRONMENT_VARIABLE',
  'DEVMATE_KNOWLEDGE_STORE_FILE_NAME'
];

for (const name of knowledgeStoreStringContracts) {
  const typeScriptValue = stringConstant(apiTypes, name, 'typescript');
  const pythonValue = stringConstant(backendKnowledgeStore, name, 'python');
  if (typeScriptValue !== pythonValue) {
    throw new Error(`${name} differs between TypeScript (${typeScriptValue}) and Python (${pythonValue}).`);
  }
}

console.log(`Verified ${literalContracts.length + numericContracts.length + knowledgeNumericContracts.length + embeddingNumericContracts.length + stringContracts.length + knowledgeStoreStringContracts.length} TypeScript/Python API contracts.`);
