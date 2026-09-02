import type {
  AgentToolSettingsSubmission,
  DevMateSettingsSubmission,
  SettingsController
} from './settingsController';
import type { RememberedCommand } from './permissions';
import type { ExtensionToWebviewMessage } from './webviewProtocol';

export type SettingsPresenterHost = {
  rememberedCommands(): RememberedCommand[];
  workspaceTrusted(): boolean;
  permissionPolicyChanged(): void;
  postMessage(message: ExtensionToWebviewMessage): void;
  postStatus(text: string, level: 'info' | 'warning' | 'error'): void;
};

// This presenter turns saved settings into the messages used by the settings screen.
export class SettingsPresenter {
  constructor(
    private readonly settings: SettingsController,
    private readonly host: SettingsPresenterHost
  ) {}

  postState(): void {
    this.host.postMessage({
      command: 'settingsUpdated',
      settings: {
        ...this.settings.state(),
        rememberedCommands: this.host.rememberedCommands(),
        workspaceTrusted: this.host.workspaceTrusted()
      }
    });
  }

  async save(settings: DevMateSettingsSubmission): Promise<void> {
    const result = await this.settings.save(settings);
    if (!result.ok) {
      this.host.postStatus(result.message, result.level);
      return;
    }

    this.host.permissionPolicyChanged();
    this.postState();
    this.host.postMessage({ command: 'settingsSaved' });
  }

  async saveAgentToolSettings(
    settings: AgentToolSettingsSubmission
  ): Promise<void> {
    const result = await this.settings.saveAgentToolSettings(settings);
    if (!result.ok) {
      this.host.postStatus(result.message, result.level);
      return;
    }

    this.postState();
    this.host.postMessage({ command: 'agentToolSettingsSaved' });
    this.host.postStatus('Ready', 'info');
  }
}
