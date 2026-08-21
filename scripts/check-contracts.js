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
const backendMain = read('backend/app/main.py');
const backendPrompts = read('backend/app/prompts.py');

const literalContracts = [
  {
    label: 'AssistantMode',
    typeScript: quotedValues(capture(apiTypes, /export type AssistantMode\s*=\s*([^;]+);/, 'TypeScript AssistantMode')),
    python: quotedValues(capture(backendPrompts, /AssistantMode\s*=\s*Literal\[([^\]]+)\]/, 'Python AssistantMode'))
  },
  {
    label: 'ScopeType',
    typeScript: quotedValues(capture(apiTypes, /export type ScopeType\s*=\s*([^;]+);/, 'TypeScript ScopeType')),
    python: quotedValues(capture(backendPrompts, /ScopeType\s*=\s*Literal\[([^\]]+)\]/, 'Python ScopeType'))
  },
  {
    label: 'ContextSource',
    typeScript: quotedValues(capture(apiTypes, /export type ContextSource\s*=\s*([^;]+);/, 'TypeScript ContextSource')),
    python: quotedValues(capture(backendMain, /ContextSource\s*=\s*Literal\[([^\]]+)\]/, 'Python ContextSource'))
  },
  {
    label: 'AgentToolName',
    typeScript: quotedValues(capture(agentTools, /export const AGENT_TOOL_NAMES\s*=\s*\[([\s\S]*?)\]\s*as const;/, 'TypeScript agent tools')),
    python: quotedValues(capture(backendMain, /AgentToolName\s*=\s*Literal\[([\s\S]*?)\]/, 'Python agent tools'))
  },
  {
    label: 'BackendCapability',
    typeScript: quotedValues(capture(apiTypes, /export const DEVMATE_BACKEND_CAPABILITIES\s*=\s*\[([\s\S]*?)\]\s*as const;/, 'TypeScript backend capabilities')),
    python: quotedValues(capture(backendMain, /BackendCapability\s*=\s*Literal\[([^\]]+)\]/, 'Python backend capabilities'))
  },
  {
    label: 'BackendErrorCode',
    typeScript: quotedValues(capture(apiTypes, /export const DEVMATE_BACKEND_ERROR_CODES\s*=\s*\[([\s\S]*?)\]\s*as const;/, 'TypeScript backend error codes')),
    python: quotedValues(capture(backendMain, /BackendErrorCode\s*=\s*Literal\[([\s\S]*?)\]/, 'Python backend error codes'))
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
  const pythonValue = numericConstant(backendMain, name, 'python');
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
  const pythonValue = stringConstant(backendMain, name, 'python');
  if (typeScriptValue !== pythonValue) {
    throw new Error(`${name} differs between TypeScript (${typeScriptValue}) and Python (${pythonValue}).`);
  }
}

console.log(`Verified ${literalContracts.length + numericContracts.length + stringContracts.length} TypeScript/Python API contracts.`);
