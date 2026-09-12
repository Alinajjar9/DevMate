/** Track only terminals started by DevMate. IDs never grant access to arbitrary terminals or process IDs. */
import { randomUUID } from 'crypto';
import { sanitizeCommandOutput } from './commandTools';

export const MAX_MANAGED_COMMANDS = 3;
type ManagedCommand = {
  id: string; label: string; output: string; status: string;
  cleanup: (stop: boolean) => void;
};

export class ManagedCommandRegistry {
  private readonly commands = new Map<string, ManagedCommand>();
  constructor(private readonly changed: () => void) {}

  assertCapacity(): void {
    if (this.active().length >= MAX_MANAGED_COMMANDS) {
      throw new Error(`Stop an existing DevMate server before starting another (maximum ${MAX_MANAGED_COMMANDS}).`);
    }
  }

  add(label: string, cleanup: (stop: boolean) => void): string {
    this.assertCapacity();
    const id = randomUUID();
    this.commands.set(id, { id, label, output: '', status: 'running', cleanup });
    this.changed();
    return id;
  }

  append(id: string, output: string): void {
    const command = this.commands.get(id);
    if (command) { command.output = sanitizeCommandOutput(command.output + output); }
  }

  finish(id: string, status: string): void {
    const command = this.commands.get(id);
    if (!command || command.status !== 'running') { return; }
    command.status = status;
    command.cleanup(false);
    this.trim();
    this.changed();
  }

  stop(id: string): boolean {
    const command = this.commands.get(id);
    if (!command) { return false; }
    if (command.status === 'running') {
      command.status = 'terminal closed';
      command.cleanup(true);
      this.trim();
      this.changed();
    }
    return true;
  }

  stopAll(): void {
    for (const command of this.active()) { this.stop(command.id); }
  }

  active(): { id: string; label: string }[] {
    return [...this.commands.values()].filter((command) => command.status === 'running')
      .map(({ id, label }) => ({ id, label }));
  }

  read(id: string): { label: string; status: string; output: string } | undefined {
    const command = this.commands.get(id);
    return command && { label: command.label, status: command.status, output: command.output };
  }

  private trim(): void {
    const finished = [...this.commands.values()].filter((command) => command.status !== 'running');
    for (const command of finished.slice(0, Math.max(0, finished.length - 10))) { this.commands.delete(command.id); }
  }
}
