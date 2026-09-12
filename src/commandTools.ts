/** Validate supported command forms. This is an allowlist, not a sandbox for project code. */

import { createHash } from 'crypto';

export const DEFAULT_COMMAND_TIMEOUT_SECONDS = 300;
export const MIN_COMMAND_TIMEOUT_SECONDS = 10;
export const MAX_COMMAND_TIMEOUT_SECONDS = 1_800;
export const MAX_COMMAND_ARGUMENTS = 50;
export const MAX_CHAT_COMMAND_OUTPUT_CHARACTERS = 20_000;
export const MAX_MODEL_COMMAND_OUTPUT_CHARACTERS = 10_000;
export const MAX_CAPTURED_TERMINAL_ERRORS = 5;
export const MAX_CAPTURED_TERMINAL_OUTPUT_CHARACTERS = 8_000;
export const COMMAND_ACCESS_STORAGE_KEY = 'devMate.commandAccess.v1';
export type CommandAccess = 'standard' | 'extended';

/** Access comes from extension workspace state, never a project file or model argument. */
export function parseCommandAccess(value: unknown): CommandAccess {
  return value === 'extended' ? 'extended' : 'standard';
}

export type ValidatedCommand = {
  executable: string;
  args: string[];
  cwd: string;
  timeoutSeconds: number;
  background?: boolean;
};
export type CapturedTerminalError = {
  command: string;
  cwd: string;
  terminalName: string;
  exitCode: number;
  output: string;
  capturedAt: number;
};

const packageScriptPattern = /(^|:)(test|lint|check|type-?check|build|verify|compile)(:|$)/i;
const forbiddenArgumentPattern = /[\0\r\n;&|<>`$'"(){}!^%]/;
const forbiddenBehaviorPattern = /(^|[-_:])(install|add|remove|uninstall|publish|deploy|serve|server|start|watch|dev|fix|write|generate|generator)([-_:]|$)/i;
const blockedWorkingDirectories = new Set([
  '.git', 'node_modules', '.venv', 'venv', 'out', 'dist', 'build', 'coverage',
  '.cache', '__pycache__', '.next', 'target', 'vendor'
]);

/**
 * Remove terminal controls and redact common credential patterns before keeping captured failures.
 * This is a best-effort filter; it cannot recognize every possible secret format.
 */
export function sanitizeCapturedTerminalText(value: string): string {
  const sanitized = sanitizeCommandOutput(value)
    .replace(
      /(authorization\s*:\s*(?:bearer|basic)\s+)[^\s]+/gi,
      '$1[REDACTED]'
    )
    .replace(
      /((?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s]+)/gi,
      '$1[REDACTED]'
    )
    .replace(
      /(--(?:api-key|token|password|secret)(?:=|\s+))[^\s]+/gi,
      '$1[REDACTED]'
    )
    .replace(
      /([a-z][a-z0-9+.-]*:\/\/[^:\s/]+:)[^@\s/]+@/gi,
      '$1[REDACTED]@'
    )
    .replace(
      /\b(?:sk|nvapi)-[a-z0-9_-]{12,}\b/gi,
      '[REDACTED]'
    );
  return tail(sanitized, MAX_CAPTURED_TERMINAL_OUTPUT_CHARACTERS);
}

export function formatCapturedTerminalErrors(
  entries: CapturedTerminalError[],
  maxResults: number
): string {
  const selected = entries.slice(0, Math.max(1, Math.min(MAX_CAPTURED_TERMINAL_ERRORS, maxResults)));
  if (selected.length === 0) {
    return [
      'No failed workspace terminal commands have been captured.',
      'DevMate can only capture commands run after activation when VS Code Terminal Shell Integration is available.'
    ].join('\n');
  }

  const sections = selected.map((entry, index) => [
    `Failure ${index + 1}:`,
    `Command: ${sanitizeCapturedTerminalText(entry.command) || '(unavailable)'}`,
    `Terminal: ${sanitizeCapturedTerminalText(entry.terminalName) || '(unnamed)'}`,
    `Working directory: ${entry.cwd || '.'}`,
    `Exit code: ${entry.exitCode}`,
    entry.output
      ? `Output:\n${sanitizeCapturedTerminalText(entry.output)}`
      : 'Output: (none captured)'
  ].join('\n'));

  return `Recent failed workspace terminal commands (${selected.length}, newest first):\n\n${sections.join('\n\n')}`;
}

/** Accept structured arguments or a simple command string, then enforce the verification-command registry. */
export function parseRunCommandArguments(
  value: Record<string, unknown>,
  access: CommandAccess | 'deferred' = 'standard'
): ValidatedCommand {
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
  if (value.background !== undefined && typeof value.background !== 'boolean') {
    throw new Error('run_command background must be a boolean.');
  }
  validateCommonCommandArguments(executable, args);
  if (access !== 'deferred') {
    if (value.background && (access !== 'extended' || !isServerCommand(executable, args))) {
      throw new Error('Background commands require Extended access and a supported project dev/start/serve script.');
    }
    if (access === 'standard') {
      validateVerificationCommand(executable, args);
    } else {
      validateExtendedCommand(executable, args, value.background === true);
    }
  }
  return { executable, args, cwd, timeoutSeconds, ...(value.background ? { background: true } : {}) };
}

/** Identify approval by executable, arguments and working directory, so approval does not extend to another command. */
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

/** Restrict model requests to known check/build/test forms. These checks do not sandbox project scripts. */
function validateCommonCommandArguments(executable: string, args: string[]): void {
  const name = commandName(executable);
  const fileToolGuidance = filesystemCommandGuidance(name);
  if (fileToolGuidance) {
    throw new Error(fileToolGuidance);
  }
  if (args.some((argument) => forbiddenArgumentPattern.test(argument))) {
    throw new Error('Command arguments cannot contain shell operators or control characters.');
  }
  if (args.some(isOutsideWorkspaceArgument)) {
    throw new Error('Command arguments cannot reference absolute or parent paths.');
  }
}

function validateVerificationCommand(executable: string, args: string[]): void {
  const name = commandName(executable);
  if (isRuntimeVersion(name, args) || isDependencyListing(name, args)) { return; }
  if (name === 'git') { validateGitInspection(args); return; }
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
  rejectFlags(args, ['--script-shell', '--prefix', '--global', '-g', '--dir', '-C', '--cwd', '--userconfig', '--globalconfig']);
  if (args[0] === 'test' && name !== 'yarn') {
    return;
  }
  const scriptIndex = args[0] === 'run' ? 1 : name === 'yarn' ? 0 : -1;
  const script = scriptIndex >= 0 ? args[scriptIndex] : undefined;
  if (!script || !packageScriptPattern.test(script) || forbiddenBehaviorPattern.test(script)) {
    throw new Error('Package managers are limited to test, lint, check, type-check, build, verify, and compile scripts in Standard access.');
  }
}

function isRuntimeVersion(name: string, args: string[]): boolean {
  return ['node', 'npm', 'pnpm', 'yarn', 'python', 'python3', 'py', 'git', 'cargo', 'rustc', 'dotnet', 'pytest', 'ruff'].includes(name)
    && args.length === 1 && args[0] === '--version'
    || name === 'go' && args.length === 1 && args[0] === 'version';
}

function isDependencyListing(name: string, args: string[]): boolean {
  if (['npm', 'pnpm', 'yarn'].includes(name) && ['list', 'ls'].includes(args[0] ?? '')) {
    if (!args.slice(1).every((arg) => ['--json', '--all', '--long', '--production', '--dev'].includes(arg)
      || /^--depth=[0-5]$/.test(arg))) {
      throw new Error('Dependency listings accept --depth=0 through --depth=5, --json, --all, --long, --production, or --dev.');
    }
    return true;
  }
  if (['python', 'python3', 'py'].includes(name) && args[0] === '-m' && args[1] === 'pip') {
    if (args[2] === 'list' && args.slice(3).every((arg) => ['--format=json', '--format=columns', '--local', '--not-required'].includes(arg))) {
      return true;
    }
    if (args[2] === 'show' && args.length > 3 && args.slice(3).every((arg) => /^[a-z0-9][a-z0-9._-]*$/i.test(arg))) {
      return true;
    }
    throw new Error('Python pip commands are limited to list and show; use install_dependencies for a requirements file.');
  }
  return false;
}

/** Git receives only inspection options; execution adds flags disabling pagers and external diff helpers. */
function validateGitInspection(args: string[]): void {
  const [operation, ...rest] = args;
  const allowed = operation === 'status'
    ? new Set(['--short', '--branch', '--porcelain', '--porcelain=v1', '--untracked-files=no', '--untracked-files=normal'])
    : operation === 'diff'
      ? new Set(['--stat', '--name-only', '--name-status', '--cached', '--staged', '--check', '--no-color'])
      : operation === 'log'
        ? new Set(['--oneline', '--no-decorate', '--no-color', '--stat', '--name-only'])
        : undefined;
  if (!allowed) { throw new Error('Git is limited to status, diff, log, or --version. Git writes are not supported.'); }
  let paths = false;
  for (const argument of rest) {
    if (argument === '--' && operation !== 'log' && !paths) { paths = true; continue; }
    if (paths) {
      if (!argument || argument.startsWith('-') || argument.startsWith(':')) {
        throw new Error('Git paths must be simple relative paths after --.');
      }
    } else if (!allowed.has(argument)
      && !(operation === 'log' && /^--max-count=([1-9]|[1-4][0-9]|50)$/.test(argument))) {
      throw new Error('This Git inspection option is not supported. Use bounded status, diff, or log options.');
    }
  }
}

/** Produce the actual Git invocation after policy validation, so config cannot start a pager or diff helper. */
export function commandExecutionArguments(command: ValidatedCommand): string[] {
  if (commandName(command.executable) !== 'git' || command.args[0] === '--version') { return [...command.args]; }
  const [operation, ...rest] = command.args;
  return ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', operation,
    ...(operation === 'diff' || operation === 'log' ? ['--no-ext-diff', '--no-textconv'] : []),
    ...(operation === 'log' ? ['--max-count=20'] : []), ...rest];
}

export function commandProjectScript(command: ValidatedCommand): string | undefined {
  const name = commandName(command.executable);
  if (['node', 'python', 'python3', 'py'].includes(name) && command.args[0] && !command.args[0].startsWith('-')) {
    return command.args[0].replace(/^\.\//, '');
  }
  return undefined;
}

function isServerCommand(executable: string, args: string[]): boolean {
  const name = commandName(executable);
  if (!['npm', 'pnpm', 'yarn'].includes(name)) { return false; }
  const script = args[0] === 'run' ? args[1] : args[0];
  return /^(dev|start|serve)(:[a-z0-9_-]+)*$/i.test(script ?? '');
}

function validateExtendedCommand(executable: string, args: string[], background: boolean): void {
  const name = commandName(executable);
  // Extension access still does not accept shell execution, deployment, deletion, or global installation.
  rejectFlags(args, ['--global', '-g', '--prefix', '--script-shell', '--userconfig', '--globalconfig', '--cwd', '--dir', '-C']);
  if (args.some((argument) => /(^|[-_:])(publish|deploy|uninstall|remove|delete)([-_:]|$)/i.test(argument))) {
    throw new Error('Publish, deploy, removal, and global commands are not supported.');
  }
  if (['npm', 'pnpm', 'yarn'].includes(name)) {
    if (['install', 'ci', 'add'].includes(args[0] ?? '')) {
      if (background || args[0] === 'ci' && name !== 'npm'
        || !args.slice(1).every((arg) => ['--save-dev', '-D', '--save-exact', '--frozen-lockfile', '--ignore-scripts', '--no-audit', '--no-fund'].includes(arg)
          || /^(@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*(@[a-z0-9.*~+_-]+)?$/i.test(arg))) {
        throw new Error('Project installs accept package names and supported local install flags only. URLs and global installs are blocked.');
      }
      return;
    }
    const scriptIndex = args[0] === 'run' ? 1 : name === 'yarn' || ['test', 'start'].includes(args[0] ?? '') ? 0 : -1;
    const script = scriptIndex >= 0 ? args[scriptIndex] : undefined;
    if (script && /^[a-z0-9][a-z0-9:_-]*$/i.test(script)
      && (packageScriptPattern.test(script) || /(^|:)(generate|codegen|format|fix|dev|start|serve)(:|$)/i.test(script))) {
      if (isServerCommand(executable, args) && !background) {
        throw new Error('Use background:true for dev/start/serve scripts so DevMate can track and stop the server.');
      }
      return;
    }
  }
  if (name === 'node' || ['python', 'python3', 'py'].includes(name)) {
    const script = args[0] ?? '';
    if (script && !script.startsWith('-') && (name === 'node' ? /\.(c?js|mjs)$/i : /\.py$/i).test(script)) {
      rejectFlags(args, ['-e', '--eval', '-p', '--print', '-c', '--command', '--require', '--import', '--loader', '--experimental-loader']);
      return;
    }
  }
  if (name === 'npx' && args[0] === '--no-install' && ['eslint', 'prettier'].includes(args[1] ?? '')) {
    rejectFlags(args, ['--watch']);
    return;
  }
  if (name === 'ruff' && ['check', 'format'].includes(args[0] ?? '')) { return; }
  if (name === 'cargo' && args[0] === 'fmt') { return; }
  validateVerificationCommand(executable, args);
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

/** Split the small supported command syntax without invoking a shell or expanding shell expressions. */
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
  if (trimmed.length > 500 || trimmed.split(/[\\/]/).length > 30) {
    throw new Error('Command working directories exceed the supported path length.');
  }
  if (!trimmed || trimmed === '.' || trimmed === './' || trimmed === '.\\') {
    return '';
  }
  if (trimmed.startsWith('/') || trimmed.startsWith('\\') || /^[A-Za-z]:/.test(trimmed)) {
    throw new Error('Command working directories must be workspace-relative.');
  }
  const normalized = trimmed.replace(/\\/g, '/').replace(/\/$/, '');
  if (/[\0-\x1f:<>"|?*]/.test(normalized) || normalized.split('/').some((part) =>
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
  if (args.some((argument) => flags.some((flag) => argument === flag || argument.startsWith(`${flag}=`)))) {
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
