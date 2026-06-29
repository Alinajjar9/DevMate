export const FILE_PERMISSION_POLICY_STORAGE_KEY = 'devMate.filePermissionPolicy.v1';

export type PermissionBehavior = 'ask' | 'allow';
export type FilePermissionAction = 'create' | 'update';

export type FilePermissionPolicy = {
  createFiles: PermissionBehavior;
  updateFiles: PermissionBehavior;
};

export const DEFAULT_FILE_PERMISSION_POLICY: FilePermissionPolicy = {
  createFiles: 'ask',
  updateFiles: 'ask'
};

export function parseFilePermissionPolicy(value: unknown): FilePermissionPolicy {
  if (!isRecord(value)) {
    return { ...DEFAULT_FILE_PERMISSION_POLICY };
  }

  return {
    createFiles: isPermissionBehavior(value.createFiles) ? value.createFiles : 'ask',
    updateFiles: isPermissionBehavior(value.updateFiles) ? value.updateFiles : 'ask'
  };
}

export function permissionBehaviorForAction(
  policy: FilePermissionPolicy,
  action: FilePermissionAction
): PermissionBehavior {
  return action === 'create' ? policy.createFiles : policy.updateFiles;
}

export function allowActions(
  policy: FilePermissionPolicy,
  actions: Iterable<FilePermissionAction>
): FilePermissionPolicy {
  const updated = { ...policy };
  for (const action of actions) {
    if (action === 'create') {
      updated.createFiles = 'allow';
    } else {
      updated.updateFiles = 'allow';
    }
  }
  return updated;
}

export function permissionPolicyLabel(policy: FilePermissionPolicy): string {
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

function isPermissionBehavior(value: unknown): value is PermissionBehavior {
  return value === 'ask' || value === 'allow';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
