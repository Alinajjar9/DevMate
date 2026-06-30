"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.isPythonVerificationCommand = isPythonVerificationCommand;
exports.workspacePythonCandidates = workspacePythonCandidates;
exports.workspacePythonExecutable = workspacePythonExecutable;
exports.extractMissingPythonModule = extractMissingPythonModule;
const path = __importStar(require("path"));
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
function workspacePythonExecutable(candidate, cwd) {
    const normalizedCandidate = candidate.replace(/\\/g, '/');
    const normalizedCwd = cwd.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') || '.';
    const relative = path.posix.relative(normalizedCwd, normalizedCandidate);
    return relative.startsWith('../') ? relative : `./${relative.replace(/^\.\//, '')}`;
}
function extractMissingPythonModule(output) {
    const match = output.match(/ModuleNotFoundError:\s*No module named\s*['"]([A-Za-z0-9_.-]+)['"]/i);
    return match?.[1];
}
//# sourceMappingURL=pythonEnvironment.js.map