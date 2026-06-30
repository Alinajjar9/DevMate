"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_FILE_PERMISSION_POLICY = exports.MAX_REMEMBERED_COMMANDS = exports.REMEMBERED_COMMANDS_STORAGE_KEY = exports.LEGACY_FILE_PERMISSION_POLICY_STORAGE_KEY = exports.FILE_PERMISSION_POLICY_STORAGE_KEY = void 0;
exports.parseFilePermissionPolicy = parseFilePermissionPolicy;
exports.permissionBehaviorForAction = permissionBehaviorForAction;
exports.allowActions = allowActions;
exports.permissionPolicyLabel = permissionPolicyLabel;
exports.parseRememberedCommands = parseRememberedCommands;
exports.rememberCommand = rememberCommand;
exports.revokeRememberedCommand = revokeRememberedCommand;
exports.FILE_PERMISSION_POLICY_STORAGE_KEY = 'devMate.filePermissionPolicy.v2';
exports.LEGACY_FILE_PERMISSION_POLICY_STORAGE_KEY = 'devMate.filePermissionPolicy.v1';
exports.REMEMBERED_COMMANDS_STORAGE_KEY = 'devMate.rememberedCommands.v1';
exports.MAX_REMEMBERED_COMMANDS = 50;
exports.DEFAULT_FILE_PERMISSION_POLICY = {
    createFiles: 'ask',
    updateFiles: 'ask'
};
function parseFilePermissionPolicy(value) {
    if (!isRecord(value)) {
        return { ...exports.DEFAULT_FILE_PERMISSION_POLICY };
    }
    return {
        createFiles: isPermissionBehavior(value.createFiles) ? value.createFiles : 'ask',
        updateFiles: isPermissionBehavior(value.updateFiles) ? value.updateFiles : 'ask'
    };
}
function permissionBehaviorForAction(policy, action) {
    if (action === 'create') {
        return policy.createFiles;
    }
    if (action === 'update') {
        return policy.updateFiles;
    }
    return 'ask';
}
function allowActions(policy, actions) {
    const updated = { ...policy };
    for (const action of actions) {
        if (action === 'create') {
            updated.createFiles = 'allow';
        }
        else if (action === 'update') {
            updated.updateFiles = 'allow';
        }
    }
    return updated;
}
function permissionPolicyLabel(policy) {
    if (policy.createFiles === 'allow' && policy.updateFiles === 'allow') {
        return 'Changes allowed';
    }
    if (policy.createFiles === 'allow') {
        return 'Creates allowed';
    }
    if (policy.updateFiles === 'allow') {
        return 'Edits allowed';
    }
    return 'Ask for changes';
}
function parseRememberedCommands(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    const commands = [];
    const signatures = new Set();
    for (const candidate of value) {
        if (!isRecord(candidate)
            || typeof candidate.signature !== 'string'
            || typeof candidate.label !== 'string') {
            continue;
        }
        const signature = candidate.signature.trim();
        const label = candidate.label.trim();
        if (!signature || !label || signature.length > 1_000 || label.length > 500 || signatures.has(signature)) {
            continue;
        }
        signatures.add(signature);
        commands.push({ signature, label });
        if (commands.length >= exports.MAX_REMEMBERED_COMMANDS) {
            break;
        }
    }
    return commands;
}
function rememberCommand(commands, command) {
    const parsed = parseRememberedCommands(commands);
    if (parsed.some((candidate) => candidate.signature === command.signature)) {
        return parsed;
    }
    const available = parsed.length >= exports.MAX_REMEMBERED_COMMANDS ? parsed.slice(1) : parsed;
    return parseRememberedCommands([...available, command]);
}
function revokeRememberedCommand(commands, signature) {
    return parseRememberedCommands(commands).filter((command) => command.signature !== signature);
}
function isPermissionBehavior(value) {
    return value === 'ask' || value === 'allow';
}
function isRecord(value) {
    return typeof value === 'object' && value !== null;
}
//# sourceMappingURL=permissions.js.map