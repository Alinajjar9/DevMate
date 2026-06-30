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
exports.MAX_DEPENDENCY_REQUIREMENTS = exports.MAX_DEPENDENCY_MANIFEST_BYTES = void 0;
exports.parseInstallDependenciesArguments = parseInstallDependenciesArguments;
exports.validatePythonRequirementsManifest = validatePythonRequirementsManifest;
const path = __importStar(require("path"));
const commandTools_1 = require("./commandTools");
const fileChanges_1 = require("./fileChanges");
exports.MAX_DEPENDENCY_MANIFEST_BYTES = 64_000;
exports.MAX_DEPENDENCY_REQUIREMENTS = 100;
const blockedManifestDirectories = new Set([
    '.git', '.venv', 'venv', 'env', 'node_modules', 'vendor', 'dist', 'build', 'target'
]);
const manifestNamePattern = /^requirements(?:-[a-z0-9._-]+)?\.txt$/i;
const requirementPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9_,.-]+\])?(?:\s*(?:(?:===|==|~=|!=|<=|>=|<|>)\s*[A-Za-z0-9*+!._-]+)(?:\s*,\s*(?:(?:===|==|~=|!=|<=|>=|<|>)\s*[A-Za-z0-9*+!._-]+))*)?$/;
function parseInstallDependenciesArguments(value) {
    if (typeof value.manifestPath !== 'string') {
        throw new Error('install_dependencies requires a requirements manifest path.');
    }
    const manifestPath = (0, fileChanges_1.normalizeWorkspaceRelativePath)(value.manifestPath);
    const parts = manifestPath.split('/');
    const fileName = parts.at(-1) ?? '';
    if (!manifestNamePattern.test(fileName)) {
        throw new Error('Dependency installation is limited to requirements*.txt manifests.');
    }
    if (parts.slice(0, -1).some((part) => blockedManifestDirectories.has(part.toLocaleLowerCase()))) {
        throw new Error('The dependency manifest is inside a blocked directory.');
    }
    const timeoutSeconds = value.timeoutSeconds === undefined
        ? commandTools_1.MAX_COMMAND_TIMEOUT_SECONDS
        : value.timeoutSeconds;
    if (typeof timeoutSeconds !== 'number' || !Number.isInteger(timeoutSeconds)) {
        throw new Error('Dependency timeoutSeconds must be an integer.');
    }
    return {
        manifestPath,
        cwd: path.posix.dirname(manifestPath) === '.' ? '' : path.posix.dirname(manifestPath),
        timeoutSeconds: Math.min(commandTools_1.MAX_COMMAND_TIMEOUT_SECONDS, Math.max(commandTools_1.MIN_COMMAND_TIMEOUT_SECONDS, timeoutSeconds))
    };
}
function validatePythonRequirementsManifest(content) {
    if (Buffer.byteLength(content, 'utf8') > exports.MAX_DEPENDENCY_MANIFEST_BYTES) {
        throw new Error('The dependency manifest exceeds the 64 KB safety limit.');
    }
    const requirements = [];
    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.replace(/\s+#.*$/, '').trim();
        if (!line || line.startsWith('#')) {
            continue;
        }
        if (line.length > 300 || !requirementPattern.test(line)) {
            throw new Error('The dependency manifest contains an unsupported requirement. '
                + 'URLs, local paths, editable installs, nested manifests, options, and environment markers are blocked.');
        }
        requirements.push(line);
        if (requirements.length > exports.MAX_DEPENDENCY_REQUIREMENTS) {
            throw new Error(`A dependency installation is limited to ${exports.MAX_DEPENDENCY_REQUIREMENTS} requirements.`);
        }
    }
    if (requirements.length === 0) {
        throw new Error('The dependency manifest does not contain any installable requirements.');
    }
    return requirements;
}
//# sourceMappingURL=dependencyTools.js.map