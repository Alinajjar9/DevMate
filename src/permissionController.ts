import {
  allowActions,
  FILE_PERMISSION_POLICY_STORAGE_KEY,
  parseFilePermissionPolicy,
  parseRememberedCommands,
  REMEMBERED_COMMANDS_STORAGE_KEY,
  rememberCommand,
  revokeRememberedCommand
} from './permissions';
import type {
  FilePermissionAction,
  FilePermissionPolicy,
  RememberedCommand
} from './permissions';

export type PermissionDecision = 'deny' | 'allowOnce' | 'allowAlways';

export interface PermissionPersistence {
  readState(key: string): unknown;
  writeState(key: string, value: unknown): PromiseLike<void>;
}

export type PermissionRequestStart = {
  promise: Promise<boolean>;
  rememberable: boolean;
  replacedRequestId?: string;
};

export type CommandPermissionRequestStart = PermissionRequestStart & {
  requiresDecision: boolean;
};

export type FilePermissionDecisionResult =
  | { handled: false }
  | {
      handled: true;
      policyChanged: boolean;
      preferenceSaveFailed: boolean;
    };

export type CommandPermissionDecisionResult =
  | { handled: false }
  | {
      handled: true;
      rememberedCommandsChanged: boolean;
      preferenceSaveFailed: boolean;
    };

export type PermissionStorageResult =
  | { ok: true; changed: boolean }
  | { ok: false; message: string };

type PendingFilePermission = {
  id: string;
  actions: Set<FilePermissionAction>;
  rememberable: boolean;
  resolve: (allowed: boolean) => void;
};

type PendingCommandPermission = {
  id: string;
  signature: string;
  label: string;
  rememberable: boolean;
  resolve: (allowed: boolean) => void;
};

// This controller owns permission decisions but does not know how their dialogs look.
export class PermissionController {
  private pendingFilePermission?: PendingFilePermission;
  private pendingCommandPermission?: PendingCommandPermission;

  constructor(private readonly persistence: PermissionPersistence) {}

  policy(): FilePermissionPolicy {
    return parseFilePermissionPolicy(
      this.persistence.readState(FILE_PERMISSION_POLICY_STORAGE_KEY)
    );
  }

  rememberedCommands(): RememberedCommand[] {
    return parseRememberedCommands(
      this.persistence.readState(REMEMBERED_COMMANDS_STORAGE_KEY)
    );
  }

  beginFilePermission(
    requestId: string,
    actions: Iterable<FilePermissionAction>
  ): PermissionRequestStart {
    const actionSet = new Set(actions);
    const rememberable = [...actionSet].every(
      (action) => action === 'create' || action === 'update'
    );
    const replacedRequestId = this.pendingFilePermission?.id;
    this.pendingFilePermission?.resolve(false);

    let resolveRequest: (allowed: boolean) => void = () => undefined;
    const promise = new Promise<boolean>((resolve) => {
      resolveRequest = resolve;
    });
    this.pendingFilePermission = {
      id: requestId,
      actions: actionSet,
      rememberable,
      resolve: resolveRequest
    };

    return { promise, rememberable, replacedRequestId };
  }

  async decideFilePermission(
    requestId: string,
    decision: PermissionDecision
  ): Promise<FilePermissionDecisionResult> {
    const pending = this.pendingFilePermission;
    if (!pending || pending.id !== requestId) {
      return { handled: false };
    }
    this.pendingFilePermission = undefined;

    let policyChanged = false;
    let preferenceSaveFailed = false;
    if (decision === 'allowAlways' && pending.rememberable) {
      try {
        const updatedPolicy = allowActions(this.policy(), pending.actions);
        await this.persistence.writeState(
          FILE_PERMISSION_POLICY_STORAGE_KEY,
          updatedPolicy
        );
        policyChanged = true;
      } catch {
        preferenceSaveFailed = true;
      }
    }

    pending.resolve(decision !== 'deny');
    return { handled: true, policyChanged, preferenceSaveFailed };
  }

  beginCommandPermission(
    requestId: string,
    signature: string,
    label: string,
    rememberable: boolean
  ): CommandPermissionRequestStart {
    if (rememberable && this.rememberedCommands().some(
      (command) => command.signature === signature
    )) {
      return {
        promise: Promise.resolve(true),
        rememberable,
        requiresDecision: false
      };
    }

    const replacedRequestId = this.pendingCommandPermission?.id;
    this.pendingCommandPermission?.resolve(false);
    let resolveRequest: (allowed: boolean) => void = () => undefined;
    const promise = new Promise<boolean>((resolve) => {
      resolveRequest = resolve;
    });
    this.pendingCommandPermission = {
      id: requestId,
      signature,
      label,
      rememberable,
      resolve: resolveRequest
    };

    return {
      promise,
      rememberable,
      replacedRequestId,
      requiresDecision: true
    };
  }

  async decideCommandPermission(
    requestId: string,
    decision: PermissionDecision
  ): Promise<CommandPermissionDecisionResult> {
    const pending = this.pendingCommandPermission;
    if (!pending || pending.id !== requestId) {
      return { handled: false };
    }
    this.pendingCommandPermission = undefined;

    let rememberedCommandsChanged = false;
    let preferenceSaveFailed = false;
    if (decision === 'allowAlways' && pending.rememberable) {
      try {
        const updated = rememberCommand(this.rememberedCommands(), {
          signature: pending.signature,
          label: pending.label
        });
        await this.persistence.writeState(REMEMBERED_COMMANDS_STORAGE_KEY, updated);
        rememberedCommandsChanged = true;
      } catch {
        preferenceSaveFailed = true;
      }
    }

    const allowed = decision === 'allowOnce'
      || (decision === 'allowAlways' && pending.rememberable);
    pending.resolve(allowed);
    return {
      handled: true,
      rememberedCommandsChanged,
      preferenceSaveFailed
    };
  }

  cancelPending(): { fileRequestId?: string; commandRequestId?: string } {
    const fileRequestId = this.pendingFilePermission?.id;
    const commandRequestId = this.pendingCommandPermission?.id;
    this.pendingFilePermission?.resolve(false);
    this.pendingCommandPermission?.resolve(false);
    this.pendingFilePermission = undefined;
    this.pendingCommandPermission = undefined;
    return { fileRequestId, commandRequestId };
  }

  async revokeRememberedCommand(signature: string): Promise<PermissionStorageResult> {
    const current = this.rememberedCommands();
    const updated = revokeRememberedCommand(current, signature);
    try {
      await this.persistence.writeState(REMEMBERED_COMMANDS_STORAGE_KEY, updated);
      return { ok: true, changed: updated.length !== current.length };
    } catch {
      return { ok: false, message: 'DevMate could not forget that command.' };
    }
  }

  async clearRememberedCommands(): Promise<PermissionStorageResult> {
    const changed = this.rememberedCommands().length > 0;
    try {
      await this.persistence.writeState(REMEMBERED_COMMANDS_STORAGE_KEY, []);
      return { ok: true, changed };
    } catch {
      return { ok: false, message: 'DevMate could not clear the remembered commands.' };
    }
  }
}
