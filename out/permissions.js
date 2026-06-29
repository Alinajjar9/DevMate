"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_FILE_PERMISSION_POLICY = exports.FILE_PERMISSION_POLICY_STORAGE_KEY = void 0;
exports.parseFilePermissionPolicy = parseFilePermissionPolicy;
exports.permissionBehaviorForAction = permissionBehaviorForAction;
exports.allowActions = allowActions;
exports.permissionPolicyLabel = permissionPolicyLabel;
exports.FILE_PERMISSION_POLICY_STORAGE_KEY = 'devMate.filePermissionPolicy.v1';
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
    return action === 'create' ? policy.createFiles : policy.updateFiles;
}
function allowActions(policy, actions) {
    const updated = { ...policy };
    for (const action of actions) {
        if (action === 'create') {
            updated.createFiles = 'allow';
        }
        else {
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
function isPermissionBehavior(value) {
    return value === 'ask' || value === 'allow';
}
function isRecord(value) {
    return typeof value === 'object' && value !== null;
}
//# sourceMappingURL=permissions.js.map