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
exports.VsCodeWorkspaceIndexChangeSource = exports.WorkspaceIndexCoordinator = exports.DEFAULT_WORKSPACE_INDEX_DEBOUNCE_MS = void 0;
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const projectIndex_1 = require("./projectIndex");
exports.DEFAULT_WORKSPACE_INDEX_DEBOUNCE_MS = 750;
const defaultTimer = {
    schedule: (callback, delayMilliseconds) => setTimeout(callback, delayMilliseconds),
    cancel: (handle) => clearTimeout(handle)
};
class WorkspaceIndexCoordinator {
    changeSource;
    synchronize;
    debounceMilliseconds;
    timer;
    changeSubscription;
    backendAccess;
    activeController;
    debounceHandle;
    pending = false;
    pendingImmediately = false;
    disposed = false;
    constructor(changeSource, synchronize, debounceMilliseconds = exports.DEFAULT_WORKSPACE_INDEX_DEBOUNCE_MS, timer = defaultTimer) {
        this.changeSource = changeSource;
        this.synchronize = synchronize;
        this.debounceMilliseconds = debounceMilliseconds;
        this.timer = timer;
        this.changeSubscription = changeSource.onDidChange(() => {
            this.requestSynchronization(false);
        });
    }
    setBackendAccess(access) {
        if (this.disposed) {
            return;
        }
        if (!access) {
            this.backendAccess = undefined;
            this.pending = false;
            this.pendingImmediately = false;
            this.clearDebounce();
            this.activeController?.abort();
            return;
        }
        const accessChanged = !sameAccess(this.backendAccess, access);
        this.backendAccess = { ...access };
        if (accessChanged) {
            this.activeController?.abort();
        }
        this.requestSynchronization(true);
    }
    dispose() {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.backendAccess = undefined;
        this.pending = false;
        this.pendingImmediately = false;
        this.clearDebounce();
        this.activeController?.abort();
        this.changeSubscription.dispose();
        this.changeSource.dispose();
    }
    requestSynchronization(immediately) {
        if (this.disposed || !this.backendAccess) {
            return;
        }
        this.pending = true;
        this.pendingImmediately ||= immediately;
        if (this.activeController) {
            return;
        }
        this.schedulePending();
    }
    schedulePending() {
        if (this.disposed || !this.backendAccess || !this.pending) {
            return;
        }
        this.clearDebounce();
        if (this.pendingImmediately) {
            void this.runPending();
            return;
        }
        this.debounceHandle = this.timer.schedule(() => {
            this.debounceHandle = undefined;
            void this.runPending();
        }, Math.max(0, this.debounceMilliseconds));
    }
    async runPending() {
        if (this.disposed
            || !this.backendAccess
            || !this.pending
            || this.activeController) {
            return;
        }
        const access = { ...this.backendAccess };
        const controller = new AbortController();
        this.pending = false;
        this.pendingImmediately = false;
        this.activeController = controller;
        try {
            await this.synchronize(access, controller.signal);
        }
        finally {
            if (this.activeController === controller) {
                this.activeController = undefined;
            }
            this.schedulePending();
        }
    }
    clearDebounce() {
        if (this.debounceHandle === undefined) {
            return;
        }
        this.timer.cancel(this.debounceHandle);
        this.debounceHandle = undefined;
    }
}
exports.WorkspaceIndexCoordinator = WorkspaceIndexCoordinator;
class VsCodeWorkspaceIndexChangeSource {
    listeners = new Set();
    workspaceFolderSubscription;
    renameSubscription;
    watcher;
    watcherSubscriptions = [];
    disposed = false;
    constructor() {
        this.workspaceFolderSubscription = vscode.workspace.onDidChangeWorkspaceFolders(() => {
            this.rebuildWatcher();
            this.emitChange();
        });
        this.renameSubscription = vscode.workspace.onDidRenameFiles((event) => {
            const folder = currentLocalWorkspaceFolder();
            if (folder && event.files.some((file) => shouldWatchUri(folder, file.oldUri) || shouldWatchUri(folder, file.newUri))) {
                this.emitChange();
            }
        });
        this.rebuildWatcher();
    }
    onDidChange(listener) {
        if (this.disposed) {
            return { dispose: () => undefined };
        }
        this.listeners.add(listener);
        return {
            dispose: () => this.listeners.delete(listener)
        };
    }
    dispose() {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.disposeWatcher();
        this.workspaceFolderSubscription.dispose();
        this.renameSubscription.dispose();
        this.listeners.clear();
    }
    rebuildWatcher() {
        this.disposeWatcher();
        if (this.disposed) {
            return;
        }
        const folder = currentLocalWorkspaceFolder();
        if (!folder) {
            return;
        }
        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '**/*'));
        const handleUri = (uri) => {
            if (shouldWatchUri(folder, uri)) {
                this.emitChange();
            }
        };
        this.watcher = watcher;
        this.watcherSubscriptions = [
            watcher.onDidCreate(handleUri),
            watcher.onDidChange(handleUri),
            watcher.onDidDelete(handleUri)
        ];
    }
    disposeWatcher() {
        for (const subscription of this.watcherSubscriptions) {
            subscription.dispose();
        }
        this.watcherSubscriptions = [];
        this.watcher?.dispose();
        this.watcher = undefined;
    }
    emitChange() {
        for (const listener of this.listeners) {
            listener();
        }
    }
}
exports.VsCodeWorkspaceIndexChangeSource = VsCodeWorkspaceIndexChangeSource;
function currentLocalWorkspaceFolder() {
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder?.uri.scheme === 'file' ? folder : undefined;
}
function shouldWatchUri(folder, uri) {
    if (uri.scheme !== 'file') {
        return false;
    }
    const relativePath = path.relative(folder.uri.fsPath, uri.fsPath).replace(/\\/g, '/');
    if (!relativePath) {
        return true;
    }
    if (path.isAbsolute(relativePath)
        || relativePath === '..'
        || relativePath.startsWith('../')) {
        return false;
    }
    return !(0, projectIndex_1.shouldSkipProjectFile)(relativePath);
}
function sameAccess(left, right) {
    return left?.backendUrl === right.backendUrl
        && left.backendToken === right.backendToken;
}
//# sourceMappingURL=workspaceIndexWatcher.js.map