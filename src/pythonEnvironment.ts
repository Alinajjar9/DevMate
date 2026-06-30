import * as path from 'path';
import type { ValidatedCommand } from './commandTools';

export function isPythonVerificationCommand(command: ValidatedCommand): boolean {
  const executable = command.executable.replace(/\\/g, '/').split('/').at(-1)?.toLocaleLowerCase();
  return executable === 'python'
    || executable === 'python.exe'
    || executable === 'python3'
    || executable === 'python3.exe'
    || executable === 'py'
    || executable === 'py.exe';
}

export function workspacePythonCandidates(
  cwd: string,
  platform: NodeJS.Platform = process.platform
): string[] {
  const normalizedCwd = cwd.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const roots = normalizedCwd ? [normalizedCwd, ''] : [''];
  const environments = ['.venv', 'venv', 'env'];
  const executables = platform === 'win32'
    ? ['Scripts/python.exe']
    : ['bin/python', 'bin/python3'];
  const candidates: string[] = [];
  for (const root of roots) {
    for (const environment of environments) {
      for (const executable of executables) {
        const candidate = [root, environment, executable].filter(Boolean).join('/');
        if (!candidates.includes(candidate)) {
          candidates.push(candidate);
        }
      }
    }
  }
  return candidates;
}

export function workspacePythonExecutable(candidate: string, cwd: string): string {
  const normalizedCandidate = candidate.replace(/\\/g, '/');
  const normalizedCwd = cwd.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') || '.';
  const relative = path.posix.relative(normalizedCwd, normalizedCandidate);
  return relative.startsWith('../') ? relative : `./${relative.replace(/^\.\//, '')}`;
}

export function extractMissingPythonModule(output: string): string | undefined {
  const match = output.match(/ModuleNotFoundError:\s*No module named\s*['"]([A-Za-z0-9_.-]+)['"]/i);
  return match?.[1];
}
