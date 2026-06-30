"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isPythonVerificationCommand = isPythonVerificationCommand;
exports.workspacePythonCandidates = workspacePythonCandidates;
exports.extractMissingPythonModule = extractMissingPythonModule;
function isPythonVerificationCommand(command) {
    const executable = command.executable.replace(/\\/g, '/').split('/').at(-1)?.toLocaleLowerCase();
    return executable === 'python'
        || executable === 'python.exe'
        || executable === 'python3'
        || executable === 'python3.exe'
        || executable === 'py'
        || executable === 'py.exe';
}
function workspacePythonCandidates(cwd, platform = process.platform) {
    const normalizedCwd = cwd.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const roots = normalizedCwd ? [normalizedCwd, ''] : [''];
    const environments = ['.venv', 'venv', 'env'];
    const executables = platform === 'win32'
        ? ['Scripts/python.exe']
        : ['bin/python', 'bin/python3'];
    const candidates = [];
    for (const root of roots) {
        for (const environment of environments) {
            for (const executable of executables) {
                const candidate = [root, environment, executable].filter(Boolean).join('/');
                if (!candidates.includes(candidate)) {
                    candidates.push(candidate);
                }
            }
        }
    }
    return candidates;
}
function extractMissingPythonModule(output) {
    const match = output.match(/ModuleNotFoundError:\s*No module named\s*['"]([A-Za-z0-9_.-]+)['"]/i);
    return match?.[1];
}
//# sourceMappingURL=pythonEnvironment.js.map