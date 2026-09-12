/** Bind command approvals to the command and files reviewed by the user, not just a script name. */
import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { ValidatedCommand } from './commandTools';

export type CommandApprovalFiles = {
  canonicalPath(filePath: string): Promise<string>;
  readFile(filePath: string): Promise<Uint8Array | undefined>;
};
export type CommandApprovalIdentity = { signature: string; rememberable: boolean };
export const MAX_COMMAND_IDENTITY_FILES = 128;
export const MAX_COMMAND_IDENTITY_BYTES = 4_000_000;
export const MAX_COMMAND_IDENTITY_FILE_BYTES = 2_000_000;

const configurationFiles = [
  'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock',
  '.npmrc', '.yarnrc', '.yarnrc.yml', 'pyproject.toml', 'pytest.ini', 'tox.ini', 'setup.cfg',
  'ruff.toml', '.ruff.toml', 'tsconfig.json', 'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs',
  '.eslintrc', '.eslintrc.json', '.eslintrc.js', '.prettierrc', '.prettierrc.json', 'prettier.config.js',
  'Cargo.toml', 'Cargo.lock', 'go.mod', 'go.sum', 'pom.xml', 'build.gradle', 'build.gradle.kts',
  'settings.gradle', 'settings.gradle.kts', 'gradle.properties', 'gradle/wrapper/gradle-wrapper.properties',
  'gradle/wrapper/gradle-wrapper.jar', '.mvn/wrapper/maven-wrapper.properties', '.mvn/wrapper/maven-wrapper.jar'
];

/** Resolve bare tools once; invoking the resulting absolute path avoids shell aliases changing the target. */
export async function resolveCommandExecutable(command: ValidatedCommand, root: string): Promise<ValidatedCommand> {
  const candidates = command.executable.includes('/') || command.executable.includes('\\')
    ? [path.resolve(root, command.cwd, command.executable)]
    : (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).flatMap((directory) => {
      const base = path.join(directory.replace(/^"|"$/g, ''), command.executable);
      return process.platform === 'win32' && !path.extname(base)
        ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map((extension) => base + extension.toLowerCase())
        : [base];
    });
  for (const candidate of candidates) {
    try {
      const canonical = await fs.realpath(candidate);
      if ((await fs.stat(canonical)).isFile()) { return { ...command, executable: canonical }; }
    } catch { /* Try the next PATH location. */ }
  }
  // Remote/custom terminal environments may have different PATHs; those requests cannot be remembered.
  return command;
}

/**
 * Snapshot manifests (including pre/post hooks), wrappers and referenced config files.
 * Project code can load arbitrary dependencies, so those approvals remain one-time unless the
 * command is a bounded inspection/version command with a resolved executable identity.
 */
export async function commandApprovalIdentity(
  command: ValidatedCommand, root: string, files: CommandApprovalFiles
): Promise<CommandApprovalIdentity> {
  let complete = true;
  const canonical = async (value: string) => {
    try { return await files.canonicalPath(value); } catch { complete = false; return path.resolve(value); }
  };
  const canonicalRoot = await canonical(root);
  const canonicalCwd = await canonical(path.resolve(root, command.cwd));
  const entries = new Map<string, string>();
  let inspectedBytes = 0;
  const inspect = async (filePath: string) => {
    const key = path.resolve(filePath);
    if (entries.has(key)) { return; }
    if (entries.size >= MAX_COMMAND_IDENTITY_FILES || inspectedBytes >= MAX_COMMAND_IDENTITY_BYTES) {
      complete = false;
      return;
    }
    try {
      const bytes = await files.readFile(key);
      if (bytes === undefined) { entries.set(key, 'missing'); return; }
      inspectedBytes += bytes.byteLength;
      if (bytes.byteLength > MAX_COMMAND_IDENTITY_FILE_BYTES
        || inspectedBytes > MAX_COMMAND_IDENTITY_BYTES) {
        complete = false;
        entries.set(key, 'identity size limit');
        return;
      }
      const real = await canonical(key);
      entries.set(key, `${real}:${createHash('sha256').update(bytes).digest('hex')}`);
      if (path.basename(key) === 'package.json') {
        const manifest = JSON.parse(Buffer.from(bytes).toString('utf8')) as { scripts?: Record<string, unknown> };
        for (const script of Object.values(manifest.scripts ?? {})) {
          if (typeof script !== 'string') { continue; }
          // Read simple file references in all hooks too. Unresolved shell/program dependencies
          // are why package scripts deliberately never receive a remembered approval.
          for (const reference of script.match(/(?:\.?\/?[a-z0-9_./-]+)\.(?:[cm]?js|ts|py|sh|cmd|bat)\b/gi) ?? []) {
            const candidate = path.resolve(path.dirname(key), reference);
            if (candidate.startsWith(path.resolve(root) + path.sep)) { await inspect(candidate); }
          }
        }
      }
    } catch { complete = false; entries.set(key, 'unavailable'); }
  };
  const rootPrefix = path.resolve(root) + path.sep;
  for (let directory = path.resolve(root, command.cwd); directory === path.resolve(root) || directory.startsWith(rootPrefix); directory = path.dirname(directory)) {
    for (const file of configurationFiles) { await inspect(path.join(directory, file)); }
    if (directory === path.resolve(root)) { break; }
  }
  if (path.isAbsolute(command.executable)) {
    await inspect(command.executable);
    if (entries.get(path.resolve(command.executable)) === 'missing') { complete = false; }
  }
  else { complete = false; }
  for (const argument of command.args) {
    const value = argument.includes('=') ? argument.slice(argument.indexOf('=') + 1) : argument;
    if (!value.startsWith('-') && /\.(?:[cm]?js|ts|py|json|ya?ml|toml|xml|cfg|ini|bat|cmd|sh)$/i.test(value)) {
      const candidate = path.resolve(root, command.cwd, value);
      if (candidate.startsWith(rootPrefix)) { await inspect(candidate); }
    }
  }
  const name = path.basename(command.executable).toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
  // Git filters, package-manager plugins and Python import hooks can load code outside
  // this snapshot. Only direct runtime version queries are candidates for remembering.
  const inspection = ['node', 'python', 'python3', 'go', 'rustc', 'dotnet'].includes(name)
    && command.args.length === 1 && ['--version', 'version'].includes(command.args[0])
    && !/\.(?:cmd|bat|[cm]?js|py|sh)$/i.test(command.executable);
  const signature = 'command-v2:' + createHash('sha256').update(JSON.stringify({
    root: canonicalRoot, cwd: canonicalCwd, executable: command.executable,
    args: command.args, timeoutSeconds: command.timeoutSeconds, background: !!command.background,
    files: [...entries].sort(([left], [right]) => left.localeCompare(right))
  })).digest('hex');
  return { signature, rememberable: complete && inspection && !path.resolve(command.executable).startsWith(rootPrefix) };
}
