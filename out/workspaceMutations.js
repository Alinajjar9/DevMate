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
exports.WorkspaceMutations = void 0;
const vscode = __importStar(require("vscode"));
const fileTools_1 = require("./fileTools");
const projectIndex_1 = require("./projectIndex");
const permissions_1 = require("./permissions");
class WorkspaceMutations {
    callbacks;
    constructor(callbacks) {
        this.callbacks = callbacks;
    }
    async deleteFile(folder, relativePath, remainingMutationCharacters, signal) {
        this.assertTrustedFileLifecycle();
        const source = await this.inspectLifecycleFile(folder, relativePath);
        if (source.content.length > remainingMutationCharacters) {
            throw new Error('This request reached the total file-mutation size limit.');
        }
        this.callbacks.reportStatus('Waiting for permission');
        const allowed = await this.callbacks.requestPermission(`Delete ${relativePath}`, [{
                path: relativePath,
                operation: 'delete',
                originalContent: source.content,
                proposedContent: ''
            }]);
        if (!allowed) {
            throw new Error('Permission to delete the file was denied.');
        }
        if (signal?.aborted) {
            throw new Error('The file deletion was cancelled.');
        }
        this.assertTrustedFileLifecycle();
        await this.assertNoWorkspaceSymlink(folder, relativePath, false);
        await this.revalidateLifecycleFile(source);
        this.callbacks.reportStatus('Deleting file');
        const workspaceEdit = new vscode.WorkspaceEdit();
        workspaceEdit.deleteFile(source.uri, { recursive: false, ignoreIfNotExists: false });
        if (!await vscode.workspace.applyEdit(workspaceEdit)) {
            throw new Error('VS Code could not delete the approved file.');
        }
        this.callbacks.recordCompletedDiff(relativePath, source.content, '');
        return {
            result: `Applied file changes:\n- Deleted ${relativePath}`,
            resultSummary: `Deleted ${relativePath}`,
            usedFiles: [source.displayPath],
            mutationCharacters: source.content.length,
            mutationApplied: true
        };
    }
    async relocateFile(folder, relativePath, newRelativePath, operation, signal) {
        this.assertTrustedFileLifecycle();
        const source = await this.inspectLifecycleFile(folder, relativePath);
        await this.assertNoWorkspaceSymlink(folder, newRelativePath, true);
        const destinationUri = vscode.Uri.joinPath(folder.uri, ...newRelativePath.split('/'));
        await this.assertLifecycleDestinationAvailable(destinationUri, newRelativePath);
        const operationLabel = operation === 'rename' ? 'Rename' : 'Move';
        this.callbacks.reportStatus('Waiting for permission');
        const allowed = await this.callbacks.requestPermission(`${operationLabel} ${relativePath} to ${newRelativePath}`, [{
                path: `${relativePath} → ${newRelativePath}`,
                operation,
                originalContent: source.content,
                proposedContent: source.content
            }]);
        if (!allowed) {
            throw new Error(`Permission to ${operation} the file was denied.`);
        }
        if (signal?.aborted) {
            throw new Error(`The file ${operation} was cancelled.`);
        }
        this.assertTrustedFileLifecycle();
        await this.assertNoWorkspaceSymlink(folder, relativePath, false);
        await this.assertNoWorkspaceSymlink(folder, newRelativePath, true);
        await this.revalidateLifecycleFile(source);
        await this.assertLifecycleDestinationAvailable(destinationUri, newRelativePath);
        const parentSegments = newRelativePath.split('/').slice(0, -1);
        if (parentSegments.length > 0) {
            await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder.uri, ...parentSegments));
        }
        this.callbacks.reportStatus(operation === 'rename' ? 'Renaming file' : 'Moving file');
        const workspaceEdit = new vscode.WorkspaceEdit();
        workspaceEdit.renameFile(source.uri, destinationUri, {
            overwrite: false,
            ignoreIfExists: false
        });
        if (!await vscode.workspace.applyEdit(workspaceEdit)) {
            throw new Error(`VS Code could not ${operation} the approved file.`);
        }
        this.callbacks.recordCompletedDiff(newRelativePath, source.content, source.content, relativePath);
        let openNote = '';
        try {
            const document = await vscode.workspace.openTextDocument(destinationUri);
            if (!await document.save()) {
                openNote = '\n\nThe file was relocated, but VS Code could not confirm it was saved.';
            }
            await vscode.window.showTextDocument(document, {
                viewColumn: vscode.ViewColumn.One,
                preview: false,
                preserveFocus: false
            });
        }
        catch {
            openNote = '\n\nThe file was relocated, but VS Code could not open the destination.';
        }
        return {
            result: `Applied file changes:\n- ${operation === 'rename' ? 'Renamed' : 'Moved'} `
                + `${relativePath} to ${newRelativePath}${openNote}`,
            resultSummary: `${operation === 'rename' ? 'Renamed' : 'Moved'} ${relativePath}`,
            usedFiles: [
                source.displayPath,
                destinationUri.scheme === 'file' ? destinationUri.fsPath : destinationUri.toString()
            ],
            mutationCharacters: 0,
            mutationApplied: true
        };
    }
    async confirmAndApplyFileChanges(changes, summary, signal) {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) {
            throw new Error('Open a workspace folder before applying file changes.');
        }
        if (!vscode.workspace.isTrusted) {
            throw new Error('Trust this workspace before allowing DevMate to change files.');
        }
        const plannedChanges = await Promise.all(changes.map(async (change) => {
            await this.assertNoWorkspaceSymlink(folder, change.path, true);
            const uri = vscode.Uri.joinPath(folder.uri, ...change.path.split('/'));
            let exists = false;
            let originalContent = '';
            try {
                const stat = await vscode.workspace.fs.stat(uri);
                if ((stat.type & vscode.FileType.Directory) !== 0) {
                    throw new Error(`${change.path} is a directory, not a file.`);
                }
                exists = true;
                const document = await vscode.workspace.openTextDocument(uri);
                if (document.isDirty) {
                    throw new Error(`Save or discard your unsaved changes in ${change.path} before DevMate edits it.`);
                }
                originalContent = document.getText();
            }
            catch (error) {
                if (!(error instanceof vscode.FileSystemError && error.code === 'FileNotFound')) {
                    throw new Error(error instanceof Error
                        ? `Could not inspect ${change.path}: ${error.message}`
                        : `Could not inspect ${change.path}.`);
                }
            }
            return { ...change, uri, exists, originalContent };
        }));
        const permissionFiles = plannedChanges.map((change) => ({
            path: change.path,
            operation: change.exists ? 'update' : 'create',
            originalContent: change.originalContent,
            proposedContent: change.content
        }));
        const permissionPolicy = this.callbacks.getPermissionPolicy();
        const requiresApproval = permissionFiles.some((file) => (0, permissions_1.permissionBehaviorForAction)(permissionPolicy, file.operation) === 'ask');
        if (requiresApproval) {
            this.callbacks.reportStatus('Waiting for permission');
            const allowed = await this.callbacks.requestPermission(summary, permissionFiles);
            if (!allowed) {
                return 'Proposed file changes were not applied.';
            }
        }
        if (signal.aborted) {
            return 'Proposed file changes were not applied.';
        }
        if (!vscode.workspace.isTrusted) {
            throw new Error('Workspace Trust changed while permission was pending; the files were not changed.');
        }
        for (const change of plannedChanges) {
            await this.assertNoWorkspaceSymlink(folder, change.path, true);
            if (change.exists) {
                const document = await vscode.workspace.openTextDocument(change.uri);
                if (document.isDirty || document.getText() !== change.originalContent) {
                    throw new Error(`${change.path} changed while permission was pending. Review the request again.`);
                }
            }
            else {
                try {
                    await vscode.workspace.fs.stat(change.uri);
                    throw new Error(`${change.path} was created while permission was pending. Review the request again.`);
                }
                catch (error) {
                    if (!(error instanceof vscode.FileSystemError && error.code === 'FileNotFound')) {
                        throw error;
                    }
                }
            }
        }
        this.callbacks.reportStatus('Applying file changes');
        for (const change of plannedChanges.filter((item) => !item.exists)) {
            const parentSegments = change.path.split('/').slice(0, -1);
            if (parentSegments.length > 0) {
                await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder.uri, ...parentSegments));
            }
        }
        await Promise.all(plannedChanges.map((change) => this.assertNoWorkspaceSymlink(folder, change.path, true)));
        const workspaceEdit = new vscode.WorkspaceEdit();
        for (const change of plannedChanges) {
            if (change.exists) {
                const document = await vscode.workspace.openTextDocument(change.uri);
                const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
                workspaceEdit.replace(change.uri, fullRange, change.content);
            }
            else {
                workspaceEdit.createFile(change.uri, { ignoreIfExists: false, overwrite: false });
                workspaceEdit.insert(change.uri, new vscode.Position(0, 0), change.content);
            }
        }
        const applied = await vscode.workspace.applyEdit(workspaceEdit);
        if (!applied) {
            throw new Error('VS Code could not apply the proposed workspace edit.');
        }
        const saved = await Promise.all(plannedChanges.map(async (change) => {
            const document = await vscode.workspace.openTextDocument(change.uri);
            return document.save();
        }));
        if (saved.some((didSave) => !didSave)) {
            throw new Error('DevMate applied the changes, but VS Code could not save every file.');
        }
        for (const change of plannedChanges) {
            this.callbacks.recordCompletedDiff(change.path, change.originalContent, change.content);
        }
        let openNote = '';
        try {
            const primaryDocument = await vscode.workspace.openTextDocument(plannedChanges[0].uri);
            await vscode.window.showTextDocument(primaryDocument, {
                viewColumn: vscode.ViewColumn.One,
                preview: false,
                preserveFocus: false
            });
        }
        catch {
            openNote = '\n\nThe changes were applied, but VS Code could not open the first file.';
        }
        return [
            'Applied file changes:',
            ...plannedChanges.map((change) => `- ${change.exists ? 'Updated' : 'Created'} ${change.path}`)
        ].join('\n') + openNote;
    }
    async assertNoWorkspaceSymlink(folder, relativePath, allowMissing) {
        const segments = relativePath.split('/').filter(Boolean);
        for (let index = 1; index <= segments.length; index += 1) {
            const uri = vscode.Uri.joinPath(folder.uri, ...segments.slice(0, index));
            try {
                const stat = await vscode.workspace.fs.stat(uri);
                if ((stat.type & vscode.FileType.SymbolicLink) !== 0) {
                    throw new Error(`DevMate will not use the symbolic-link path ${segments.slice(0, index).join('/')}.`);
                }
            }
            catch (error) {
                if (allowMissing && error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
                    return;
                }
                throw error;
            }
        }
    }
    assertTrustedFileLifecycle() {
        if (!vscode.workspace.isTrusted) {
            throw new Error('Trust this workspace before allowing DevMate to delete, rename, or move files.');
        }
    }
    async inspectLifecycleFile(folder, relativePath) {
        await this.assertNoWorkspaceSymlink(folder, relativePath, false);
        const uri = vscode.Uri.joinPath(folder.uri, ...relativePath.split('/'));
        let stat;
        try {
            stat = await vscode.workspace.fs.stat(uri);
        }
        catch {
            throw new Error(`${relativePath} does not exist or cannot be inspected.`);
        }
        if ((stat.type & vscode.FileType.File) === 0) {
            throw new Error(`${relativePath} is not a file. Recursive directory operations are blocked.`);
        }
        if (stat.size > projectIndex_1.MAX_PROJECT_FILE_BYTES) {
            throw new Error(`${relativePath} exceeds the file-size limit.`);
        }
        const bytes = await vscode.workspace.fs.readFile(uri);
        if ((0, projectIndex_1.containsBinaryData)(bytes)) {
            throw new Error(`DevMate will not change binary content at ${relativePath}.`);
        }
        const document = await vscode.workspace.openTextDocument(uri);
        if (document.isDirty) {
            throw new Error(`Save or discard your unsaved changes in ${relativePath} before DevMate changes it.`);
        }
        const content = document.getText();
        if (content.length > fileTools_1.MAX_FILE_CHANGE_CHARACTERS) {
            throw new Error(`${relativePath} exceeds the per-file change limit.`);
        }
        return {
            path: relativePath,
            uri,
            displayPath: uri.scheme === 'file' ? uri.fsPath : uri.toString(),
            content
        };
    }
    async revalidateLifecycleFile(source) {
        let document;
        try {
            const stat = await vscode.workspace.fs.stat(source.uri);
            if ((stat.type & vscode.FileType.File) === 0) {
                throw new Error('The source is no longer a file.');
            }
            document = await vscode.workspace.openTextDocument(source.uri);
        }
        catch {
            throw new Error(`${source.path} changed while permission was pending. Review the request again.`);
        }
        if (document.isDirty || document.getText() !== source.content) {
            throw new Error(`${source.path} changed while permission was pending. Review the request again.`);
        }
    }
    async assertLifecycleDestinationAvailable(uri, relativePath) {
        try {
            await vscode.workspace.fs.stat(uri);
            throw new Error(`${relativePath} already exists; choose a different destination.`);
        }
        catch (error) {
            if (!(error instanceof vscode.FileSystemError && error.code === 'FileNotFound')) {
                throw error;
            }
        }
    }
}
exports.WorkspaceMutations = WorkspaceMutations;
//# sourceMappingURL=workspaceMutations.js.map