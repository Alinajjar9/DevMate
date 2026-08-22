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
exports.VsCodeWorkspaceIndexSource = void 0;
const vscode = __importStar(require("vscode"));
const types_1 = require("./api/types");
const indexSynchronization_1 = require("./indexSynchronization");
const projectChunking_1 = require("./projectChunking");
const projectIndex_1 = require("./projectIndex");
const workspaceContext_1 = require("./workspaceContext");
class VsCodeWorkspaceIndexSource {
    async readCurrentFile(relativePath, signal) {
        const folder = vscode.workspace.workspaceFolders?.[0];
        const normalizedPath = (0, workspaceContext_1.normalizeRelativeWorkspacePath)(relativePath);
        if (!folder
            || folder.uri.scheme !== 'file'
            || !isSafeRelativePath(normalizedPath)
            || (0, projectIndex_1.shouldSkipProjectFile)(normalizedPath)) {
            return undefined;
        }
        const readSignal = signal ?? new AbortController().signal;
        try {
            const uri = vscode.Uri.joinPath(folder.uri, ...normalizedPath.split('/'));
            const read = await readValidatedWorkspaceFile(folder, uri, normalizedPath, readSignal);
            if ((0, projectIndex_1.containsBinaryData)(read.bytes)) {
                return undefined;
            }
            return {
                filePath: uri.fsPath,
                relativePath: normalizedPath,
                languageId: (0, projectIndex_1.languageIdForPath)(normalizedPath),
                content: new TextDecoder('utf-8').decode(read.bytes)
            };
        }
        catch (error) {
            assertNotCancelled(readSignal);
            return undefined;
        }
    }
    async scan(signal) {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder || folder.uri.scheme !== 'file') {
            return undefined;
        }
        const rootPath = folder.uri.fsPath;
        if (!rootPath || rootPath.length > types_1.MAX_WORKSPACE_ROOT_CHARACTERS) {
            return undefined;
        }
        assertNotCancelled(signal);
        const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*'), projectIndex_1.PROJECT_EXCLUDE_GLOB, projectIndex_1.MAX_PROJECT_INDEX_FILES);
        const files = [];
        const unavailablePaths = [];
        const safeDirectories = new Set();
        for (const uri of [...uris].sort((left, right) => vscode.workspace.asRelativePath(left, false).localeCompare(vscode.workspace.asRelativePath(right, false)))) {
            assertNotCancelled(signal);
            const relativePath = (0, workspaceContext_1.normalizeRelativeWorkspacePath)(vscode.workspace.asRelativePath(uri, false));
            if (!isSafeRelativePath(relativePath) || (0, projectIndex_1.shouldSkipProjectFile)(relativePath)) {
                continue;
            }
            let stat;
            try {
                const parentsSafe = await hasSafeParentDirectories(folder, relativePath, safeDirectories);
                if (!parentsSafe) {
                    continue;
                }
                stat = await vscode.workspace.fs.stat(uri);
            }
            catch {
                unavailablePaths.push(relativePath);
                continue;
            }
            if ((stat.type & vscode.FileType.File) === 0
                || (stat.type & vscode.FileType.SymbolicLink) !== 0
                || stat.size > projectIndex_1.MAX_PROJECT_FILE_BYTES) {
                continue;
            }
            files.push({
                relativePath,
                languageId: (0, projectIndex_1.languageIdForPath)(relativePath),
                read: (readSignal) => readValidatedWorkspaceFile(folder, uri, relativePath, readSignal),
                readSymbolRanges: (expectedFile, readSignal) => readDocumentSymbolRanges(folder, uri, relativePath, expectedFile, readSignal)
            });
        }
        return {
            workspaceKey: (0, indexSynchronization_1.knowledgeIndexWorkspaceKey)(folder.uri.toString(true)),
            rootPath,
            files,
            unavailablePaths: [...new Set(unavailablePaths)].sort()
        };
    }
}
exports.VsCodeWorkspaceIndexSource = VsCodeWorkspaceIndexSource;
async function readValidatedWorkspaceFile(folder, uri, relativePath, signal) {
    assertNotCancelled(signal);
    if (!await hasSafeParentDirectories(folder, relativePath, new Set())) {
        throw new Error(`${relativePath} is behind a symbolic-link directory.`);
    }
    const initialStat = await vscode.workspace.fs.stat(uri);
    if ((initialStat.type & vscode.FileType.File) === 0
        || (initialStat.type & vscode.FileType.SymbolicLink) !== 0
        || initialStat.size > projectIndex_1.MAX_PROJECT_FILE_BYTES) {
        throw new Error(`${relativePath} is not a safe indexable file.`);
    }
    const bytes = await vscode.workspace.fs.readFile(uri);
    const currentStat = await vscode.workspace.fs.stat(uri);
    const parentsRemainSafe = await hasSafeParentDirectories(folder, relativePath, new Set());
    assertNotCancelled(signal);
    if (!parentsRemainSafe
        || (currentStat.type & vscode.FileType.File) === 0
        || (currentStat.type & vscode.FileType.SymbolicLink) !== 0
        || currentStat.size > projectIndex_1.MAX_PROJECT_FILE_BYTES
        || currentStat.size !== bytes.byteLength) {
        throw new Error(`${relativePath} changed while it was being indexed.`);
    }
    return {
        bytes,
        sizeBytes: currentStat.size,
        modifiedAt: Math.max(0, Math.trunc(currentStat.mtime))
    };
}
async function readDocumentSymbolRanges(folder, uri, relativePath, expectedFile, signal) {
    assertNotCancelled(signal);
    try {
        if (!await hasSafeParentDirectories(folder, relativePath, new Set())) {
            return undefined;
        }
        const stat = await vscode.workspace.fs.stat(uri);
        if (!matchesExpectedFile(stat, expectedFile)) {
            return undefined;
        }
        const provided = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', uri);
        assertNotCancelled(signal);
        const currentBytes = await vscode.workspace.fs.readFile(uri);
        const currentStat = await vscode.workspace.fs.stat(uri);
        if (!await hasSafeParentDirectories(folder, relativePath, new Set())
            || !matchesExpectedFile(currentStat, expectedFile)
            || !sameBytes(currentBytes, expectedFile.bytes)) {
            return undefined;
        }
        return collectDocumentSymbolRanges(uri, provided);
    }
    catch (error) {
        assertNotCancelled(signal);
        return undefined;
    }
}
function matchesExpectedFile(stat, expectedFile) {
    return (stat.type & vscode.FileType.File) !== 0
        && (stat.type & vscode.FileType.SymbolicLink) === 0
        && stat.size <= projectIndex_1.MAX_PROJECT_FILE_BYTES
        && stat.size === expectedFile.sizeBytes
        && Math.max(0, Math.trunc(stat.mtime)) === expectedFile.modifiedAt;
}
function sameBytes(left, right) {
    if (left.byteLength !== right.byteLength) {
        return false;
    }
    for (let index = 0; index < left.byteLength; index += 1) {
        if (left[index] !== right[index]) {
            return false;
        }
    }
    return true;
}
function collectDocumentSymbolRanges(uri, provided) {
    if (!Array.isArray(provided)) {
        return undefined;
    }
    const ranges = [];
    let exceededLimit = false;
    const visit = (symbols) => {
        for (const symbol of symbols) {
            if (ranges.length >= projectChunking_1.MAX_PROJECT_SYMBOL_RANGES) {
                exceededLimit = true;
                return;
            }
            if (isDocumentSymbol(symbol)) {
                ranges.push(projectSymbolRange(symbol.range));
                visit(symbol.children);
            }
            else if (sameUri(symbol.location.uri, uri)) {
                ranges.push(projectSymbolRange(symbol.location.range));
            }
        }
    };
    visit(provided);
    return ranges.length > 0 && !exceededLimit ? ranges : undefined;
}
function isDocumentSymbol(symbol) {
    return 'selectionRange' in symbol && Array.isArray(symbol.children);
}
function projectSymbolRange(range) {
    return {
        start: {
            line: range.start.line,
            character: range.start.character
        },
        end: {
            line: range.end.line,
            character: range.end.character
        }
    };
}
function sameUri(left, right) {
    return left.toString(true) === right.toString(true);
}
function isSafeRelativePath(relativePath) {
    if (!relativePath
        || relativePath.length > types_1.MAX_RELATIVE_PATH_CHARACTERS
        || relativePath.startsWith('/')
        || /[\u0000-\u001f\u007f]/.test(relativePath)) {
        return false;
    }
    const segments = relativePath.split('/');
    return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}
async function hasSafeParentDirectories(folder, relativePath, safeDirectories) {
    const segments = relativePath.split('/');
    for (let index = 1; index < segments.length; index += 1) {
        const directoryPath = segments.slice(0, index).join('/');
        if (safeDirectories.has(directoryPath)) {
            continue;
        }
        const stat = await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder.uri, ...segments.slice(0, index)));
        if ((stat.type & vscode.FileType.Directory) === 0
            || (stat.type & vscode.FileType.SymbolicLink) !== 0) {
            return false;
        }
        safeDirectories.add(directoryPath);
    }
    return true;
}
function assertNotCancelled(signal) {
    if (signal.aborted) {
        const error = new Error('The workspace scan was cancelled.');
        error.name = 'AbortError';
        throw error;
    }
}
//# sourceMappingURL=workspaceIndexSource.js.map