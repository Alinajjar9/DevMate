import { createHash } from 'crypto';

export const DEFAULT_COMMAND_TIMEOUT_SECONDS = 300;
export const MIN_COMMAND_TIMEOUT_SECONDS = 10;
export const MAX_COMMAND_TIMEOUT_SECONDS = 1_800;
export const MAX_COMMAND_ARGUMENTS = 50;
export const MAX_CHAT_COMMAND_OUTPUT_CHARACTERS = 20_000;
export const MAX_MODEL_COMMAND_OUTPUT_CHARACTERS = 10_000;

export type ValidatedCommand = {
  executable: string;
  args: string[];
  cwd: string;
  timeoutSeconds: number;
};

const packageScriptPattern = /(^|:)(test|lint|check|type-?check|build)(:|$)/i;
const forbiddenArgumentPattern = /[\0\r\n;&|<>`$'"(){}!^%]/;
const forbiddenBehaviorPattern = /(^|[-_:])(install|add|remove|uninstall|publish|deploy|serve|server|start|watch|dev|fix|write|generate|generator)([-_:]|$)/i;
const blockedWorkingDirectories = new Set([
  '.git', 'node_modules', '.venv', 'venv', 'out', 'dist', 'build', 'coverage',
  '.cache', '__pycache__', '.next', 'target', 'vendor'
]);

export function parseRunCommandArguments(value: Record<string, unknown>): ValidatedCommand {
  let executableValue = value.executable;
  let argumentsValue = value.args ?? value.arguments;
  if ((typeof executableValue !== 'string' || !executableValue.trim()) && typeof value.command === 'string') {
    const commandTokens = parseSimpleCommandText(value.command);
    executableValue = commandTokens.shift();
    if (argumentsValue === undefined) {
      argumentsValue = commandTokens;
    } else if (commandTokens.length > 0) {
      throw new Error('run_command cannot combine a full command string with separate arguments.');
    }
  }
  if (typeof executableValue !== 'string' || !executableValue.trim()) {
    throw new Error('run_command requires an executable.');
  }
  const executable = normalizeExecutable(executableValue);
  if (typeof argumentsValue === 'string') {
    const parsedArguments = parseSimpleCommandText(argumentsValue);
    if (sameCommandName(parsedArguments[0], executable)) {
      parsedArguments.shift();
    }
    argumentsValue = parsedArguments;
  }
  const args = parseArguments(argumentsValue);
  const cwd = normalizeCommandCwd(typeof value.cwd === 'string' ? value.cwd : '');
  const timeoutSeconds = boundedTimeout(value.timeoutSeconds);
  validateVerificationCommand(executable, args);
  return { executable, args, cwd, timeoutSeconds };
}

export function commandSignature(command: ValidatedCommand): string {
  const executable = process.platform === 'win32'
    ? command.executable.toLocaleLowerCase()
    : command.executable;
  return createHash('sha256').update(JSON.stringify({
    executable,
    args: command.args,
    cwd: command.cwd
  })).digest('hex');
}

export function commandLabel(command: ValidatedCommand): string {
  return [command.executable, ...command.args.map(displayArgument)].join(' ');
}

export function sanitizeCommandOutput(value: string): string {
  const withoutAnsi = value.replace(
    // ANSI CSI, OSC, and two-character escape sequences.
    /\u001b(?:\][^\u0007]*(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~]|[@-_])/g,
    ''
  );
  const normalized = withoutAnsi.replace(/\r\n?/g, '\n').replace(
    // Preserve tabs and new lines; remove the remaining C0/C1 controls.
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g,
    ''
  );
  return tail(normalized, MAX_CHAT_COMMAND_OUTPUT_CHARACTERS);
}

export function boundedModelCommandOutput(value: string): string {
  return tail(sanitizeCommandOutput(value), MAX_MODEL_COMMAND_OUTPUT_CHARACTERS);
}

function validateVerificationCommand(executable: string, args: string[]): void {
  const name = commandName(executable);
  const fileToolGuidance = filesystemCommandGuidance(name);
  if (fileToolGuidance) {
    throw new Error(fileToolGuidance);
  }
  if (args.some((argument) => forbiddenArgumentPattern.test(argument))) {
    throw new Error('Verification command arguments cannot contain shell operators or control characters.');
  }
  if (args.some(isOutsideWorkspaceArgument)) {
    throw new Error('Verification command arguments cannot reference absolute or parent paths.');
  }
  if (args.some((argument) => argument !== '--no-install' && forbiddenBehaviorPattern.test(argument))) {
    throw new Error('Installation, generation, watch, server, deploy, and write commands are blocked.');
  }

  if (['npm', 'pnpm', 'yarn'].includes(name)) {
    validatePackageCommand(name, args);
    return;
  }
  if (name === 'node') {
    requireFirstArgument(args, '--test', 'Only node --test is allowed.');
    rejectFlags(args, ['-e', '--eval', '-p', '--print', '--watch']);
    return;
  }
  if (name === 'npx') {
    if (args[0] !== '--no-install' || !['tsc', 'eslint', 'prettier'].includes(args[1] ?? '')) {
      throw new Error('npx is limited to --no-install tsc, eslint, or prettier.');
    }
    rejectFlags(args, ['--fix', '--write', '--watch']);
    if (args[1] === 'prettier' && !args.includes('--check')) {
      throw new Error('Prettier may only run with --check.');
    }
    return;
  }
  if (['python', 'python3', 'py'].includes(name)) {
    rejectFlags(args, ['-c', '--command']);
    if (args[0] !== '-m' || !['unittest', 'pytest'].includes(args[1] ?? '')) {
      throw new Error('Python is limited to -m unittest or -m pytest.');
    }
    return;
  }
  if (name === 'pytest' || name === 'mypy' || name === 'pyright') {
    return;
  }
  if (name === 'ruff') {
    requireFirstArgument(args, 'check', 'Ruff may only run its check command.');
    rejectFlags(args, ['--fix']);
    return;
  }
  if (name === 'cargo') {
    if (!['test', 'check', 'build', 'clippy', 'fmt'].includes(args[0] ?? '')) {
      throw new Error('Cargo is limited to test, check, build, clippy, or fmt --check.');
    }
    if (args[0] === 'fmt' && !args.includes('--check')) {
      throw new Error('cargo fmt may only run with --check.');
    }
    return;
  }
  if (name === 'go') {
    if (!['test', 'vet', 'build'].includes(args[0] ?? '')) {
      throw new Error('Go is limited to test, vet, or build.');
    }
    return;
  }
  if (name === 'dotnet') {
    if (!['test', 'build'].includes(args[0] ?? '')) {
      throw new Error('dotnet is limited to test or build.');
    }
    return;
  }
  if (['mvn', 'mvnw'].includes(name)) {
    validateBuildTasks(args, new Set(['test', 'verify', 'package']));
    return;
  }
  if (['gradle', 'gradlew'].includes(name)) {
    validateBuildTasks(args, new Set(['test', 'check', 'build']));
    return;
  }

  throw new Error(`${executable} is not in DevMate's verification-command registry.`);
}

function filesystemCommandGuidance(name: string): string | undefined {
  if (['mkdir', 'md'].includes(name)) {
    return 'Do not use run_command to create directories. create_file and move_file create destination directories automatically.';
  }
  if (['move', 'mv'].includes(name)) {
    return 'Use move_file with workspace-relative path and newPath arguments. It creates destination directories automatically.';
  }
  if (['ren', 'rename'].includes(name)) {
    return 'Use rename_file with workspace-relative path and newPath arguments.';
  }
  if (['del', 'erase', 'rm', 'unlink'].includes(name)) {
    return 'Use delete_file for one eligible workspace file. DevMate does not delete directories.';
  }
  if (['rmdir', 'rd'].includes(name)) {
    return 'DevMate does not delete directories. Remove eligible files individually with delete_file.';
  }
  if (['copy', 'cp'].includes(name)) {
    return 'Use read_file and then create_file when a workspace text file must be copied.';
  }
  if (name === 'touch') {
    return 'Use create_file to create a new workspace text file.';
  }
  return undefined;
}

function validatePackageCommand(name: string, args: string[]): void {
  if (args[0] === 'test' && name !== 'yarn') {
    return;
  }
  const scriptIndex = args[0] === 'run' ? 1 : name === 'yarn' ? 0 : -1;
  const script = scriptIndex >= 0 ? args[scriptIndex] : undefined;
  if (!script || !packageScriptPattern.test(script) || forbiddenBehaviorPattern.test(script)) {
    throw new Error('Package managers are limited to test, lint, check, type-check, and build scripts.');
  }
}

function validateBuildTasks(args: string[], allowedTasks: Set<string>): void {
  const tasks = args.filter((argument) => !argument.startsWith('-'));
  if (tasks.length === 0 || tasks.some((task) => !allowedTasks.has(task))) {
    throw new Error(`Build tool tasks are limited to ${[...allowedTasks].join(', ')}.`);
  }
}

function normalizeExecutable(value: string): string {
  const executable = value.trim().replace(/\\/g, '/');
  if (executable.includes('\0')
    || executable.includes('\n')
    || executable.includes('\r')
    || executable.startsWith('/')
    || /^[A-Za-z]:/.test(executable)
    || executable.split('/').some((part) => part === '..')
    || executable.split('/').length > 2
    || (executable.includes('/') && !executable.startsWith('./'))) {
    throw new Error('Command executables must be a known command name or workspace wrapper.');
  }
  if (forbiddenArgumentPattern.test(executable)) {
    throw new Error('Command executables cannot contain shell operators.');
  }
  return executable;
}

function parseArguments(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length > MAX_COMMAND_ARGUMENTS) {
    throw new Error(`run_command args must be an array of at most ${MAX_COMMAND_ARGUMENTS} strings.`);
  }
  let totalCharacters = 0;
  return value.map((argument) => {
    if (typeof argument !== 'string' || argument.length > 500) {
      throw new Error('Every command argument must be a string with 500 characters or fewer.');
    }
    totalCharacters += argument.length;
    if (totalCharacters > 2_000) {
      throw new Error('Command arguments exceed the total size limit.');
    }
    return argument;
  });
}

function parseSimpleCommandText(value: string): string[] {
  if (!value.trim() || value.length > 2_000 || /[\0\r\n]/.test(value)) {
    throw new Error('The command text is empty or exceeds the safe size limit.');
  }
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let tokenStarted = false;
  for (const character of value.trim()) {
    if (quote) {
      if (character === quote) {
        quote = undefined;
      } else {
        current += character;
      }
      tokenStarted = true;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (tokenStarted) {
        tokens.push(current);
        current = '';
        tokenStarted = false;
      }
      continue;
    }
    current += character;
    tokenStarted = true;
  }
  if (quote) {
    throw new Error('The command text contains an unterminated quote.');
  }
  if (tokenStarted) {
    tokens.push(current);
  }
  return tokens;
}

function sameCommandName(candidate: unknown, executable: string): boolean {
  return typeof candidate === 'string'
    && commandName(candidate) === commandName(executable);
}

function normalizeCommandCwd(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '.' || trimmed === './' || trimmed === '.\\') {
    return '';
  }
  if (trimmed.startsWith('/') || trimmed.startsWith('\\') || /^[A-Za-z]:/.test(trimmed)) {
    throw new Error('Command working directories must be workspace-relative.');
  }
  const normalized = trimmed.replace(/\\/g, '/').replace(/\/$/, '');
  if (normalized.split('/').some((part) =>
    !part || part === '.' || part === '..' || blockedWorkingDirectories.has(part.toLocaleLowerCase())
  )) {
    throw new Error('The command working directory contains unsafe segments.');
  }
  return normalized;
}

function boundedTimeout(value: unknown): number {
  if (value === undefined) {
    return MAX_COMMAND_TIMEOUT_SECONDS;
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error('Command timeoutSeconds must be an integer.');
  }
  return Math.min(MAX_COMMAND_TIMEOUT_SECONDS, Math.max(MIN_COMMAND_TIMEOUT_SECONDS, value));
}

function commandName(executable: string): string {
  const baseName = executable.replace(/^\.\//, '').split('/').at(-1) ?? executable;
  return baseName.toLocaleLowerCase().replace(/\.(exe|cmd|bat)$/, '');
}

function rejectFlags(args: string[], flags: string[]): void {
  if (args.some((argument) => flags.includes(argument))) {
    throw new Error(`The verification command cannot use ${flags.join(', ')}.`);
  }
}

function requireFirstArgument(args: string[], expected: string, message: string): void {
  if (args[0] !== expected) {
    throw new Error(message);
  }
}

function displayArgument(value: string): string {
  return /\s/.test(value) ? JSON.stringify(value) : value;
}

function isOutsideWorkspaceArgument(value: string): boolean {
  const normalized = value.replace(/\\/g, '/');
  return /(^|=)(?:\/|[A-Za-z]:\/)/.test(normalized)
    || /(^|[=/])\.\.(?:\/|$)/.test(normalized);
}

function tail(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  const marker = '[Earlier output omitted]\n';
  return `${marker}${value.slice(value.length - (limit - marker.length))}`;
}
