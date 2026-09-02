import { randomUUID } from 'crypto';
import type { DiffPresenter } from './diffPresenter';
import type {
  PermissionController,
  PermissionDecision
} from './permissionController';
import type { FilePermissionPolicy, RememberedCommand } from './permissions';
import type { WorkspaceMutationPermissionFile } from './workspaceMutations';
import type { ExtensionToWebviewMessage } from './webviewProtocol';

export type CommandPermissionOptions = {
  rememberable?: boolean;
  title?: string;
  warning?: string;
};

export type PermissionPresenterHost = {
  postMessage(message: ExtensionToWebviewMessage): void;
  postStatus(text: string, level: 'info' | 'warning' | 'error'): void;
  settingsChanged(): void;
};

type PermissionDiffPresenter = Pick<
  DiffPresenter,
  'clearPendingFileDiffs' | 'rememberPendingFileDiffs' | 'openPendingFileDiff'
>;

// This presenter connects permission decisions to their webview messages and diff previews.
export class PermissionPresenter {
  constructor(
    private readonly permissions: PermissionController,
    private readonly diffs: PermissionDiffPresenter,
    private readonly host: PermissionPresenterHost,
    private readonly createRequestId: () => string = randomUUID
  ) {}

  policy(): FilePermissionPolicy {
    return this.permissions.policy();
  }

  rememberedCommands(): RememberedCommand[] {
    return this.permissions.rememberedCommands();
  }

  postPolicyState(): void {
    this.host.postMessage({
      command: 'permissionPolicyUpdated',
      policy: this.permissions.policy()
    });
  }

  requestFileChanges(
    summary: string,
    files: WorkspaceMutationPermissionFile[]
  ): Promise<boolean> {
    const requestId = this.createRequestId();
    const actions = new Set(files.map((file) => file.operation));
    const request = this.permissions.beginFilePermission(requestId, actions);
    this.diffs.clearPendingFileDiffs(request.replacedRequestId);
    this.diffs.rememberPendingFileDiffs(requestId, files);
    this.host.postMessage({
      command: 'permissionRequest',
      requestId,
      summary,
      rememberable: request.rememberable,
      files: files.map(({ path, operation }) => ({
        path,
        operation,
        canReview: true
      }))
    });
    return request.promise;
  }

  async decideFilePermission(
    requestId: string,
    decision: PermissionDecision
  ): Promise<void> {
    const result = await this.permissions.decideFilePermission(requestId, decision);
    if (!result.handled) {
      return;
    }
    if (result.policyChanged) {
      this.postPolicyState();
    }
    if (result.preferenceSaveFailed) {
      this.host.postStatus(
        'The changes are allowed this time, but the permission preference could not be saved.',
        'warning'
      );
    }
    this.diffs.clearPendingFileDiffs(requestId);
  }

  async reviewFileDiff(requestId: string, filePath: string): Promise<void> {
    if (!await this.diffs.openPendingFileDiff(requestId, filePath)) {
      this.host.postStatus(
        'That proposed diff is no longer available.',
        'warning'
      );
    }
  }

  requestCommand(
    signature: string,
    label: string,
    cwd: string,
    options: CommandPermissionOptions = {}
  ): Promise<boolean> {
    const rememberable = options.rememberable !== false;
    const requestId = this.createRequestId();
    const request = this.permissions.beginCommandPermission(
      requestId,
      signature,
      `${label} · ${cwd || 'workspace root'}`,
      rememberable
    );
    if (!request.requiresDecision) {
      return request.promise;
    }
    this.host.postMessage({
      command: 'commandPermissionRequest',
      requestId,
      label,
      cwd: cwd || 'Workspace root',
      rememberable,
      title: options.title,
      warning: options.warning
    });
    return request.promise;
  }

  async decideCommandPermission(
    requestId: string,
    decision: PermissionDecision
  ): Promise<void> {
    const result = await this.permissions.decideCommandPermission(requestId, decision);
    if (!result.handled) {
      return;
    }
    if (result.rememberedCommandsChanged) {
      this.host.settingsChanged();
    }
    if (result.preferenceSaveFailed) {
      this.host.postStatus(
        'The command is allowed this time, but it could not be remembered.',
        'warning'
      );
    }
  }

  cancelPending(): void {
    const cancelled = this.permissions.cancelPending();
    this.diffs.clearPendingFileDiffs(cancelled.fileRequestId);
  }

  async revokeRememberedCommand(signature: string): Promise<void> {
    const result = await this.permissions.revokeRememberedCommand(signature);
    if (!result.ok) {
      this.host.postStatus(result.message, 'error');
      return;
    }
    this.host.settingsChanged();
  }

  async clearRememberedCommands(): Promise<void> {
    const result = await this.permissions.clearRememberedCommands();
    if (!result.ok) {
      this.host.postStatus(result.message, 'error');
      return;
    }
    this.host.settingsChanged();
  }
}
