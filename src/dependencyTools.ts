import * as path from 'path';
import {
  MAX_COMMAND_TIMEOUT_SECONDS,
  MIN_COMMAND_TIMEOUT_SECONDS
} from './commandTools';
import { normalizeWorkspaceRelativePath } from './fileChanges';

export const MAX_DEPENDENCY_MANIFEST_BYTES = 64_000;
export const MAX_DEPENDENCY_REQUIREMENTS = 100;

const blockedManifestDirectories = new Set([
  '.git', '.venv', 'venv', 'env', 'node_modules', 'vendor', 'dist', 'build', 'target'
]);
const manifestNamePattern = /^requirements(?:-[a-z0-9._-]+)?\.txt$/i;
const requirementPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9_,.-]+\])?(?:\s*(?:(?:===|==|~=|!=|<=|>=|<|>)\s*[A-Za-z0-9*+!._-]+)(?:\s*,\s*(?:(?:===|==|~=|!=|<=|>=|<|>)\s*[A-Za-z0-9*+!._-]+))*)?$/;

export type InstallDependenciesToolArguments = {
  manifestPath: string;
  cwd: string;
  timeoutSeconds: number;
};

export function parseInstallDependenciesArguments(
  value: Record<string, unknown>
): InstallDependenciesToolArguments {
  if (typeof value.manifestPath !== 'string') {
    throw new Error('install_dependencies requires a requirements manifest path.');
  }
  const manifestPath = normalizeWorkspaceRelativePath(value.manifestPath);
  const parts = manifestPath.split('/');
  const fileName = parts.at(-1) ?? '';
  if (!manifestNamePattern.test(fileName)) {
    throw new Error('Dependency installation is limited to requirements*.txt manifests.');
  }
  if (parts.slice(0, -1).some((part) => blockedManifestDirectories.has(part.toLocaleLowerCase()))) {
    throw new Error('The dependency manifest is inside a blocked directory.');
  }
  const timeoutSeconds = value.timeoutSeconds === undefined
    ? MAX_COMMAND_TIMEOUT_SECONDS
    : value.timeoutSeconds;
  if (typeof timeoutSeconds !== 'number' || !Number.isInteger(timeoutSeconds)) {
    throw new Error('Dependency timeoutSeconds must be an integer.');
  }
  return {
    manifestPath,
    cwd: path.posix.dirname(manifestPath) === '.' ? '' : path.posix.dirname(manifestPath),
    timeoutSeconds: Math.min(
      MAX_COMMAND_TIMEOUT_SECONDS,
      Math.max(MIN_COMMAND_TIMEOUT_SECONDS, timeoutSeconds)
    )
  };
}

export function validatePythonRequirementsManifest(content: string): string[] {
  if (Buffer.byteLength(content, 'utf8') > MAX_DEPENDENCY_MANIFEST_BYTES) {
    throw new Error('The dependency manifest exceeds the 64 KB safety limit.');
  }
  const requirements: string[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    if (line.length > 300 || !requirementPattern.test(line)) {
      throw new Error(
        'The dependency manifest contains an unsupported requirement. '
        + 'URLs, local paths, editable installs, nested manifests, options, and environment markers are blocked.'
      );
    }
    requirements.push(line);
    if (requirements.length > MAX_DEPENDENCY_REQUIREMENTS) {
      throw new Error(`A dependency installation is limited to ${MAX_DEPENDENCY_REQUIREMENTS} requirements.`);
    }
  }
  if (requirements.length === 0) {
    throw new Error('The dependency manifest does not contain any installable requirements.');
  }
  return requirements;
}
