export const FILE_PERMISSION_POLICY_STORAGE_KEY = 'devMate.filePermissionPolicy.v2';
export const LEGACY_FILE_PERMISSION_POLICY_STORAGE_KEY = 'devMate.filePermissionPolicy.v1';
export const REMEMBERED_COMMANDS_STORAGE_KEY = 'devMate.rememberedCommands.v1';
export const MAX_REMEMBERED_COMMANDS = 50;

export type PermissionBehavior = 'ask' | 'allow';
export type FilePermissionAction = 'create' | 'update' | 'delete' | 'rename' | 'move';

export type FilePermissionPolicy = {
  createFiles: PermissionBehavior;
  updateFiles: PermissionBehavior;
};

export type RememberedCommand = {
  signature: string;
  label: string;
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
  if (action === 'create') {
    return policy.createFiles;
  }
  if (action === 'update') {
    return policy.updateFiles;
  }
  return 'ask';
}

export function allowActions(
  policy: FilePermissionPolicy,
  actions: Iterable<FilePermissionAction>
): FilePermissionPolicy {
  const updated = { ...policy };
  for (const action of actions) {
    if (action === 'create') {
      updated.createFiles = 'allow';
    } else if (action === 'update') {
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

export function parseRememberedCommands(value: unknown): RememberedCommand[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const commands: RememberedCommand[] = [];
  const signatures = new Set<string>();
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
    if (commands.length >= MAX_REMEMBERED_COMMANDS) {
      break;
    }
  }
  return commands;
}

export function rememberCommand(
  commands: RememberedCommand[],
  command: RememberedCommand
): RememberedCommand[] {
  const parsed = parseRememberedCommands(commands);
  if (parsed.some((candidate) => candidate.signature === command.signature)) {
    return parsed;
  }
  const available = parsed.length >= MAX_REMEMBERED_COMMANDS ? parsed.slice(1) : parsed;
  return parseRememberedCommands([...available, command]);
}

export function revokeRememberedCommand(
  commands: RememberedCommand[],
  signature: string
): RememberedCommand[] {
  return parseRememberedCommands(commands).filter(
    (command) => command.signature !== signature
  );
}

function isPermissionBehavior(value: unknown): value is PermissionBehavior {
  return value === 'ask' || value === 'allow';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
