"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_MODEL_COMMAND_OUTPUT_CHARACTERS = exports.MAX_CHAT_COMMAND_OUTPUT_CHARACTERS = exports.MAX_COMMAND_ARGUMENTS = exports.MAX_COMMAND_TIMEOUT_SECONDS = exports.MIN_COMMAND_TIMEOUT_SECONDS = exports.DEFAULT_COMMAND_TIMEOUT_SECONDS = void 0;
exports.parseRunCommandArguments = parseRunCommandArguments;
exports.commandSignature = commandSignature;
exports.commandLabel = commandLabel;
exports.sanitizeCommandOutput = sanitizeCommandOutput;
exports.boundedModelCommandOutput = boundedModelCommandOutput;
const crypto_1 = require("crypto");
exports.DEFAULT_COMMAND_TIMEOUT_SECONDS = 300;
exports.MIN_COMMAND_TIMEOUT_SECONDS = 10;
exports.MAX_COMMAND_TIMEOUT_SECONDS = 1_800;
exports.MAX_COMMAND_ARGUMENTS = 50;
exports.MAX_CHAT_COMMAND_OUTPUT_CHARACTERS = 20_000;
exports.MAX_MODEL_COMMAND_OUTPUT_CHARACTERS = 10_000;
const packageScriptPattern = /(^|:)(test|lint|check|type-?check|build)(:|$)/i;
const forbiddenArgumentPattern = /[\0\r\n;&|<>`$'"(){}!^%]/;
const forbiddenBehaviorPattern = /(^|[-_:])(install|add|remove|uninstall|publish|deploy|serve|server|start|watch|dev|fix|write|generate|generator)([-_:]|$)/i;
const blockedWorkingDirectories = new Set([
    '.git', 'node_modules', '.venv', 'venv', 'out', 'dist', 'build', 'coverage',
    '.cache', '__pycache__', '.next', 'target', 'vendor'
]);
function parseRunCommandArguments(value) {
    if (typeof value.executable !== 'string' || !value.executable.trim()) {
        throw new Error('run_command requires an executable.');
    }
    const executable = normalizeExecutable(value.executable);
    const args = parseArguments(value.args);
    const cwd = normalizeCommandCwd(typeof value.cwd === 'string' ? value.cwd : '');
    const timeoutSeconds = boundedTimeout(value.timeoutSeconds);
    validateVerificationCommand(executable, args);
    return { executable, args, cwd, timeoutSeconds };
}
function commandSignature(command) {
    const executable = process.platform === 'win32'
        ? command.executable.toLocaleLowerCase()
        : command.executable;
    return (0, crypto_1.createHash)('sha256').update(JSON.stringify({
        executable,
        args: command.args,
        cwd: command.cwd
    })).digest('hex');
}
function commandLabel(command) {
    return [command.executable, ...command.args.map(displayArgument)].join(' ');
}
function sanitizeCommandOutput(value) {
    const withoutAnsi = value.replace(
    // ANSI CSI, OSC, and two-character escape sequences.
    /\u001b(?:\][^\u0007]*(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~]|[@-_])/g, '');
    const normalized = withoutAnsi.replace(/\r\n?/g, '\n').replace(
    // Preserve tabs and new lines; remove the remaining C0/C1 controls.
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '');
    return tail(normalized, exports.MAX_CHAT_COMMAND_OUTPUT_CHARACTERS);
}
function boundedModelCommandOutput(value) {
    return tail(sanitizeCommandOutput(value), exports.MAX_MODEL_COMMAND_OUTPUT_CHARACTERS);
}
function validateVerificationCommand(executable, args) {
    const name = commandName(executable);
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
function validatePackageCommand(name, args) {
    if (args[0] === 'test' && name !== 'yarn') {
        return;
    }
    const scriptIndex = args[0] === 'run' ? 1 : name === 'yarn' ? 0 : -1;
    const script = scriptIndex >= 0 ? args[scriptIndex] : undefined;
    if (!script || !packageScriptPattern.test(script) || forbiddenBehaviorPattern.test(script)) {
        throw new Error('Package managers are limited to test, lint, check, type-check, and build scripts.');
    }
}
function validateBuildTasks(args, allowedTasks) {
    const tasks = args.filter((argument) => !argument.startsWith('-'));
    if (tasks.length === 0 || tasks.some((task) => !allowedTasks.has(task))) {
        throw new Error(`Build tool tasks are limited to ${[...allowedTasks].join(', ')}.`);
    }
}
function normalizeExecutable(value) {
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
function parseArguments(value) {
    if (value === undefined) {
        return [];
    }
    if (!Array.isArray(value) || value.length > exports.MAX_COMMAND_ARGUMENTS) {
        throw new Error(`run_command accepts at most ${exports.MAX_COMMAND_ARGUMENTS} string arguments.`);
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
function normalizeCommandCwd(value) {
    const trimmed = value.trim();
    if (!trimmed || trimmed === '.' || trimmed === './' || trimmed === '.\\') {
        return '';
    }
    if (trimmed.startsWith('/') || trimmed.startsWith('\\') || /^[A-Za-z]:/.test(trimmed)) {
        throw new Error('Command working directories must be workspace-relative.');
    }
    const normalized = trimmed.replace(/\\/g, '/').replace(/\/$/, '');
    if (normalized.split('/').some((part) => !part || part === '.' || part === '..' || blockedWorkingDirectories.has(part.toLocaleLowerCase()))) {
        throw new Error('The command working directory contains unsafe segments.');
    }
    return normalized;
}
function boundedTimeout(value) {
    if (value === undefined) {
        return exports.MAX_COMMAND_TIMEOUT_SECONDS;
    }
    if (typeof value !== 'number' || !Number.isInteger(value)) {
        throw new Error('Command timeoutSeconds must be an integer.');
    }
    return Math.min(exports.MAX_COMMAND_TIMEOUT_SECONDS, Math.max(exports.MIN_COMMAND_TIMEOUT_SECONDS, value));
}
function commandName(executable) {
    const baseName = executable.replace(/^\.\//, '').split('/').at(-1) ?? executable;
    return baseName.toLocaleLowerCase().replace(/\.(exe|cmd|bat)$/, '');
}
function rejectFlags(args, flags) {
    if (args.some((argument) => flags.includes(argument))) {
        throw new Error(`The verification command cannot use ${flags.join(', ')}.`);
    }
}
function requireFirstArgument(args, expected, message) {
    if (args[0] !== expected) {
        throw new Error(message);
    }
}
function displayArgument(value) {
    return /\s/.test(value) ? JSON.stringify(value) : value;
}
function isOutsideWorkspaceArgument(value) {
    const normalized = value.replace(/\\/g, '/');
    return /(^|=)(?:\/|[A-Za-z]:\/)/.test(normalized)
        || /(^|[=/])\.\.(?:\/|$)/.test(normalized);
}
function tail(value, limit) {
    if (value.length <= limit) {
        return value;
    }
    const marker = '[Earlier output omitted]\n';
    return `${marker}${value.slice(value.length - (limit - marker.length))}`;
}
//# sourceMappingURL=commandTools.js.map