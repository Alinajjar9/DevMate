import { spawn } from 'child_process';
import type { ChildProcessWithoutNullStreams } from 'child_process';
import * as path from 'path';

export const BACKEND_HEALTH_INTERVAL_MS = 10_000;
export const BACKEND_START_ATTEMPTS = 20;
export const BACKEND_START_POLL_MS = 400;
export const MAX_BACKEND_RESTARTS = 3;
export const BACKEND_RESTART_WINDOW_MS = 60_000;

export type ManagedBackendState =
  | 'checking'
  | 'starting'
  | 'restarting'
  | 'online'
  | 'offline'
  | 'disabled';

export type ManagedBackendStatus = {
  state: ManagedBackendState;
  detail: string;
  managed: boolean;
  canRestart: boolean;
};

export type LocalBackendTarget = {
  url: string;
  host: string;
  port: number;
};

export type PythonLauncher = {
  executable: string;
  prefixArgs: string[];
  label: string;
};

export type BackendLauncher = PythonLauncher & {
  kind: 'python' | 'standalone';
};

export type LocalBackendManagerOptions = {
  extensionPath: string;
  getBackendUrl: () => string;
  isManagementEnabled: () => boolean;
  getConfiguredPythonPath: () => string;
  healthCheck: (backendUrl: string) => Promise<boolean>;
  fileExists: (filePath: string) => boolean;
  onStatus: (status: ManagedBackendStatus) => void;
  onOutput: (value: string) => void;
};

export function parseLocalBackendTarget(value: string): LocalBackendTarget | undefined {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLocaleLowerCase();
    const loopback = hostname === 'localhost'
      || hostname === '[::1]'
      || hostname === '::1'
      || isLoopbackIpv4(hostname);
    if (
      url.protocol !== 'http:'
      || !loopback
      || url.username
      || url.password
      || url.search
      || url.hash
      || (url.pathname !== '/' && url.pathname !== '')
      || !url.port
    ) {
      return undefined;
    }
    const port = Number(url.port);
    if (!Number.isInteger(port) || port < 1_024 || port > 65_535) {
      return undefined;
    }
    return {
      url: url.toString().replace(/\/$/, ''),
      host: hostname === 'localhost'
        ? '127.0.0.1'
        : hostname === '[::1]' || hostname === '::1'
          ? '::1'
          : hostname,
      port
    };
  } catch {
    return undefined;
  }
}

export function pythonLaunchCandidates(
  extensionPath: string,
  configuredPythonPath: string,
  platform = process.platform
): PythonLauncher[] {
  const candidates: PythonLauncher[] = [];
  const platformPath = platform === 'win32' ? path.win32 : path.posix;
  const configured = configuredPythonPath.trim();
  if (configured) {
    candidates.push({ executable: configured, prefixArgs: [], label: 'Configured Python' });
  }
  if (platform === 'win32') {
    candidates.push(
      {
        executable: platformPath.join(extensionPath, '.venv', 'Scripts', 'python.exe'),
        prefixArgs: [],
        label: 'Extension .venv'
      },
      {
        executable: platformPath.join(extensionPath, 'venv', 'Scripts', 'python.exe'),
        prefixArgs: [],
        label: 'Extension venv'
      },
      { executable: 'python', prefixArgs: [], label: 'Python on PATH' },
      { executable: 'py', prefixArgs: ['-3'], label: 'Python launcher' }
    );
  } else {
    candidates.push(
      {
        executable: platformPath.join(extensionPath, '.venv', 'bin', 'python'),
        prefixArgs: [],
        label: 'Extension .venv'
      },
      {
        executable: platformPath.join(extensionPath, 'venv', 'bin', 'python'),
        prefixArgs: [],
        label: 'Extension venv'
      },
      { executable: 'python3', prefixArgs: [], label: 'Python 3 on PATH' },
      { executable: 'python', prefixArgs: [], label: 'Python on PATH' }
    );
  }
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const signature = `${candidate.executable}\0${candidate.prefixArgs.join('\0')}`;
    if (seen.has(signature)) {
      return false;
    }
    seen.add(signature);
    return true;
  });
}

export function bundledBackendLaunchCandidate(
  extensionPath: string,
  platform = process.platform,
  architecture = process.arch
): BackendLauncher {
  const platformPath = platform === 'win32' ? path.win32 : path.posix;
  const executableName = platform === 'win32' ? 'devmate-backend.exe' : 'devmate-backend';
  return {
    executable: platformPath.join(
      extensionPath,
      'backend-runtime',
      `${platform}-${architecture}`,
      'devmate-backend',
      executableName
    ),
    prefixArgs: [],
    label: `Bundled backend (${platform}-${architecture})`,
    kind: 'standalone'
  };
}

export function backendLaunchArguments(
  launcher: BackendLauncher,
  target: LocalBackendTarget
): string[] {
  if (launcher.kind === 'standalone') {
    return [
      ...launcher.prefixArgs,
      '--host',
      target.host,
      '--port',
      String(target.port)
    ];
  }
  return [
    ...launcher.prefixArgs,
    '-m',
    'uvicorn',
    'backend.app.main:app',
    '--host',
    target.host,
    '--port',
    String(target.port)
  ];
}

export function backendStatusLabel(status: ManagedBackendStatus): string {
  if (status.state === 'online') {
    return status.managed ? 'Backend online' : 'Backend online · external';
  }
  if (status.state === 'starting') {
    return 'Backend starting';
  }
  if (status.state === 'restarting') {
    return 'Backend restarting';
  }
  if (status.state === 'checking') {
    return 'Checking backend';
  }
  if (status.state === 'disabled') {
    return 'Backend unmanaged';
  }
  return 'Backend offline';
}

// The manager only stops processes it started itself. Existing local backends remain untouched.
export class LocalBackendManager {
  private statusValue: ManagedBackendStatus = {
    state: 'checking',
    detail: 'Checking the configured backend.',
    managed: false,
    canRestart: false
  };
  private ownedProcess?: ChildProcessWithoutNullStreams;
  private operation?: Promise<boolean>;
  private monitor?: NodeJS.Timeout;
  private restartTimer?: NodeJS.Timeout;
  private restartHistory: number[] = [];
  private disposed = false;
  private launching = false;

  constructor(private readonly options: LocalBackendManagerOptions) {}

  get status(): ManagedBackendStatus {
    return { ...this.statusValue };
  }

  start(): Promise<boolean> {
    return this.runExclusive(false);
  }

  restart(): Promise<boolean> {
    return this.runExclusive(true);
  }

  async reconfigure(): Promise<boolean> {
    await this.stopOwnedProcess();
    this.restartHistory = [];
    return this.runExclusive(false);
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimers();
    const child = this.ownedProcess;
    this.ownedProcess = undefined;
    if (child && child.exitCode === null) {
      child.stdout.removeAllListeners();
      child.stderr.removeAllListeners();
      child.removeAllListeners();
      child.kill();
    }
  }

  private runExclusive(forceRestart: boolean): Promise<boolean> {
    if (this.disposed) {
      return Promise.resolve(false);
    }
    if (this.operation) {
      return this.operation;
    }
    this.operation = this.ensureBackend(forceRestart).finally(() => {
      this.operation = undefined;
    });
    return this.operation;
  }

  private async ensureBackend(forceRestart: boolean): Promise<boolean> {
    const backendUrl = this.options.getBackendUrl();
    const target = parseLocalBackendTarget(backendUrl);
    if (!target) {
      const online = await this.options.healthCheck(backendUrl);
      this.updateStatus({
        state: online ? 'online' : 'disabled',
        detail: online
          ? 'Connected to a backend that DevMate does not manage.'
          : 'Automatic management requires a plain HTTP loopback URL with an explicit port.',
        managed: false,
        canRestart: false
      });
      this.startMonitor();
      return online;
    }

    if (!this.options.isManagementEnabled()) {
      const online = await this.options.healthCheck(target.url);
      this.updateStatus({
        state: online ? 'online' : 'disabled',
        detail: online
          ? 'Connected to an externally managed local backend.'
          : 'Automatic local backend management is disabled in VS Code settings.',
        managed: false,
        canRestart: false
      });
      this.startMonitor();
      return online;
    }

    if (forceRestart && this.ownedProcess) {
      this.updateStatus({
        state: 'restarting',
        detail: 'Stopping the managed backend before restart.',
        managed: true,
        canRestart: false
      });
      await this.stopOwnedProcess();
    } else if (forceRestart && await this.options.healthCheck(target.url)) {
      this.updateStatus({
        state: 'online',
        detail: 'The running backend was started outside DevMate and cannot be restarted safely.',
        managed: false,
        canRestart: false
      });
      return true;
    }

    if (!forceRestart && await this.options.healthCheck(target.url)) {
      this.updateStatus({
        state: 'online',
        detail: this.ownedProcess
          ? 'The local backend is healthy and managed by DevMate.'
          : 'Connected to an existing local backend. DevMate will take over if it stops.',
        managed: Boolean(this.ownedProcess),
        canRestart: Boolean(this.ownedProcess)
      });
      this.startMonitor();
      return true;
    }

    const bundledLauncher = bundledBackendLaunchCandidate(this.options.extensionPath);
    const hasBundledBackend = this.options.fileExists(bundledLauncher.executable);
    const backendEntry = path.join(this.options.extensionPath, 'backend', 'app', 'main.py');
    const hasBackendSource = this.options.fileExists(backendEntry);
    if (!hasBundledBackend && !hasBackendSource) {
      this.updateStatus({
        state: 'offline',
        detail: 'The DevMate backend files are missing from this extension installation.',
        managed: false,
        canRestart: false
      });
      return false;
    }

    this.updateStatus({
      state: forceRestart ? 'restarting' : 'starting',
      detail: 'Starting the local backend without development auto-reload.',
      managed: true,
      canRestart: false
    });
    const launchers: BackendLauncher[] = [
      ...(hasBundledBackend ? [bundledLauncher] : []),
      ...(hasBackendSource
        ? pythonLaunchCandidates(
          this.options.extensionPath,
          this.options.getConfiguredPythonPath()
        ).map((launcher): BackendLauncher => ({ ...launcher, kind: 'python' }))
        : [])
    ].filter((launcher) => !path.isAbsolute(launcher.executable)
      || this.options.fileExists(launcher.executable));

    this.launching = true;
    try {
      for (const launcher of launchers) {
        if (await this.launchWith(launcher, target)) {
          this.updateStatus({
            state: 'online',
            detail: `Managed backend is healthy via ${launcher.label}.`,
            managed: true,
            canRestart: true
          });
          this.startMonitor();
          return true;
        }
      }
    } finally {
      this.launching = false;
    }

    this.updateStatus({
      state: 'offline',
      detail: 'DevMate could not start the backend. Open backend logs and verify Python dependencies.',
      managed: false,
      canRestart: true
    });
    this.scheduleRestart();
    return false;
  }

  private async launchWith(
    launcher: BackendLauncher,
    target: LocalBackendTarget
  ): Promise<boolean> {
    this.options.onOutput(
      `\n[DevMate] Starting backend with ${launcher.label}: ${launcher.executable}\n`
    );
    const argumentsList = backendLaunchArguments(launcher, target);
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(
        launcher.executable,
        argumentsList,
        {
          cwd: launcher.kind === 'standalone'
            ? path.dirname(launcher.executable)
            : this.options.extensionPath,
          windowsHide: true,
          env: {
            ...process.env,
            PYTHONUNBUFFERED: '1',
            PYTHONDONTWRITEBYTECODE: '1'
          }
        }
      );
    } catch (error) {
      this.options.onOutput(
        `[DevMate] Could not launch ${launcher.label}: `
        + `${error instanceof Error ? error.message : 'unknown process error'}\n`
      );
      return false;
    }
    this.ownedProcess = child;
    child.stdout.on('data', (value: Buffer | string) => this.options.onOutput(String(value)));
    child.stderr.on('data', (value: Buffer | string) => this.options.onOutput(String(value)));
    child.on('error', (error) => {
      this.options.onOutput(`[DevMate] Backend process error: ${error.message}\n`);
    });
    child.on('close', (code, signal) => {
      if (this.ownedProcess === child) {
        this.ownedProcess = undefined;
      }
      this.options.onOutput(
        `[DevMate] Backend process exited (code ${String(code)}, signal ${String(signal)}).\n`
      );
      if (!this.disposed && !this.launching && this.statusValue.state === 'online') {
        this.updateStatus({
          state: 'offline',
          detail: 'The managed backend exited unexpectedly.',
          managed: false,
          canRestart: true
        });
        this.scheduleRestart();
      }
    });

    for (let attempt = 0; attempt < BACKEND_START_ATTEMPTS; attempt += 1) {
      if (this.disposed || child.exitCode !== null) {
        break;
      }
      if (await this.options.healthCheck(target.url)) {
        return true;
      }
      await wait(BACKEND_START_POLL_MS);
    }
    if (this.ownedProcess === child) {
      await this.stopOwnedProcess();
    }
    return false;
  }

  private startMonitor(): void {
    if (this.monitor || this.disposed) {
      return;
    }
    this.monitor = setInterval(() => {
      void this.monitorHealth();
    }, BACKEND_HEALTH_INTERVAL_MS);
  }

  private async monitorHealth(): Promise<void> {
    if (this.disposed || this.operation || this.statusValue.state === 'disabled') {
      return;
    }
    const backendUrl = this.options.getBackendUrl();
    if (await this.options.healthCheck(backendUrl)) {
      return;
    }
    this.options.onOutput('[DevMate] Backend health check failed.\n');
    const target = parseLocalBackendTarget(backendUrl);
    if (!target || !this.options.isManagementEnabled()) {
      this.updateStatus({
        state: 'disabled',
        detail: target
          ? 'The externally managed local backend is offline.'
          : 'The configured external backend is offline and cannot be restarted by DevMate.',
        managed: false,
        canRestart: false
      });
      return;
    }
    this.updateStatus({
      state: 'restarting',
      detail: 'Backend health check failed; attempting recovery.',
      managed: Boolean(this.ownedProcess),
      canRestart: false
    });
    if (this.ownedProcess) {
      await this.stopOwnedProcess();
    }
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (this.disposed || this.restartTimer || !this.options.isManagementEnabled()) {
      return;
    }
    const now = Date.now();
    this.restartHistory = this.restartHistory.filter(
      (timestamp) => now - timestamp <= BACKEND_RESTART_WINDOW_MS
    );
    if (this.restartHistory.length >= MAX_BACKEND_RESTARTS) {
      this.updateStatus({
        state: 'offline',
        detail: 'Automatic restart paused after three failures in one minute. Check backend logs.',
        managed: false,
        canRestart: true
      });
      return;
    }
    this.restartHistory.push(now);
    this.updateStatus({
      state: 'restarting',
      detail: 'Restarting the local backend in two seconds.',
      managed: false,
      canRestart: false
    });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      void this.runExclusive(false);
    }, 2_000);
  }

  private async stopOwnedProcess(): Promise<void> {
    const child = this.ownedProcess;
    this.ownedProcess = undefined;
    if (!child || child.exitCode !== null) {
      return;
    }
    child.kill();
    await Promise.race([
      new Promise<void>((resolve) => child.once('close', () => resolve())),
      wait(1_500)
    ]);
    if (child.exitCode === null) {
      child.kill('SIGKILL');
    }
  }

  private clearTimers(): void {
    if (this.monitor) {
      clearInterval(this.monitor);
      this.monitor = undefined;
    }
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
  }

  private updateStatus(status: ManagedBackendStatus): void {
    this.statusValue = status;
    this.options.onStatus(this.status);
  }
}

function isLoopbackIpv4(hostname: string): boolean {
  const parts = hostname.split('.');
  return parts.length === 4
    && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
