/** Bounded discovery, literal search and read-only Git helpers. No project code is evaluated. */
import { execFile } from 'child_process';
import * as path from 'path';
import { parseRunCommandArguments, sanitizeCapturedTerminalText } from './commandTools';

export type ProjectToolResult = { result: string; usedFiles: string[] };
const MAX_RESULT_CHARACTERS = 10_000;
const MAX_MANIFEST_CHARACTERS = 64_000;
const MAX_MANIFESTS = 24;

export type SearchOptions = {
  caseSensitive?: boolean;
  wholeWord?: boolean;
  contextLines?: number;
  maxResults?: number;
};
export type SearchSnippet = { line: number; startLine: number; endLine: number; text: string };

export function normalizeSearchFilePattern(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value !== 'string') throw new Error('filePattern must be a workspace-relative glob string.');
  const pattern = value.trim().replace(/\\/g, '/');
  if (pattern.length > 200 || /[\u0000-\u001f\u007f:[\]!]/.test(pattern)
    || pattern.startsWith('/') || pattern.split('/').some(part => part === '..' || part === '.')) {
    throw new Error('filePattern must be a relative glob of at most 200 characters, using *, **, ? or a simple {a,b} list.');
  }
  expandGlobAlternatives(pattern);
  return pattern;
}

/** A plain filename pattern applies in every directory; slash-containing patterns start at the workspace root. */
export function matchesSearchFilePattern(relativePath: string, pattern: string): boolean {
  if (!pattern) return true;
  const normalized = relativePath.replace(/\\/g, '/');
  const target = pattern.includes('/') ? normalized : path.posix.basename(normalized);
  return expandGlobAlternatives(pattern).some(glob => globMatches(target, glob));
}

/** Match literal text. Word boundaries treat Unicode letters/numbers, underscore and dollar as identifier characters. */
export function matchesSearchLine(line: string, query: string, options: SearchOptions = {}): boolean {
  if (!query) return false;
  const expression = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), options.caseSensitive ? 'gu' : 'giu');
  for (const match of line.matchAll(expression)) {
    if (!options.wholeWord) return true;
    const start = match.index!;
    const before = Array.from(line.slice(0, start)).at(-1) ?? '';
    const after = Array.from(line.slice(start + match[0].length))[0] ?? '';
    if (!/[\p{L}\p{N}_$]/u.test(before) && !/[\p{L}\p{N}_$]/u.test(after)) return true;
  }
  return false;
}

export function searchCodeSnippets(content: string, query: string, options: SearchOptions = {}): SearchSnippet[] {
  const lines = content.split(/\r\n|\n|\r/);
  const context = integerWithin(options.contextLines, 0, 0, 5);
  const maximum = integerWithin(options.maxResults, 20, 1, 200);
  const snippets: SearchSnippet[] = [];
  for (let index = 0; index < lines.length && snippets.length < maximum; index += 1) {
    if (!matchesSearchLine(lines[index], query, options)) continue;
    const first = Math.max(0, index - context);
    const last = Math.min(lines.length - 1, index + context);
    snippets.push({ line: index + 1, startLine: first + 1, endLine: last + 1, text: lines.slice(first, last + 1).join('\n') });
  }
  return snippets;
}

/** Inspect a bounded selection of eligible manifests. Scripts are listed by name; their bodies are never run or returned. */
export async function collectProjectInfo(
  paths: readonly string[],
  readFile: (relativePath: string) => Promise<string | undefined>,
  directory = ''
): Promise<ProjectToolResult> {
  const scope = safeRelativePath(directory, true);
  const eligible = [...new Set(paths.filter(candidate => isSafeRelativePath(candidate)
    && (!scope || candidate === scope || candidate.startsWith(`${scope}/`))))].sort();
  const manifests = eligible.filter(isProjectManifest);
  const selected = manifests.slice(0, MAX_MANIFESTS);
  const sections: string[] = [`Project overview: ${scope || '.'}`, `Eligible files: ${eligible.length}`];
  const usedFiles: string[] = [];
  let readCharacters = 0;
  for (const manifest of selected) {
    if (readCharacters >= 256_000) { sections.push('Further manifests omitted at the read budget.'); break; }
    const content = await readFile(manifest);
    if (content === undefined) continue;
    if (content.length > MAX_MANIFEST_CHARACTERS) { sections.push(`${manifest}: manifest exceeds the 64,000-character limit.`); continue; }
    readCharacters += content.length;
    usedFiles.push(manifest);
    const folder = path.posix.dirname(manifest);
    const base = path.posix.basename(manifest).toLowerCase();
    const lines = [`\n${manifest} (project directory: ${folder})`];
    if (base === 'package.json') {
      try {
        const data: unknown = JSON.parse(content);
        if (!isRecord(data)) throw new Error('Expected an object');
        const manager = packageManagerFor(data, eligible, folder);
        lines.push(`Language/runtime: JavaScript or TypeScript; package manager: ${manager}`);
        const dependencies = new Set([...Object.keys(isRecord(data.dependencies) ? data.dependencies : {}),
          ...Object.keys(isRecord(data.devDependencies) ? data.devDependencies : {})]);
        const frameworks = Object.entries({ next: 'Next.js', react: 'React', vue: 'Vue', nuxt: 'Nuxt',
          svelte: 'Svelte', '@angular/core': 'Angular', express: 'Express', fastify: 'Fastify',
          '@types/vscode': 'VS Code extension', typescript: 'TypeScript', vite: 'Vite' })
          .filter(([dependency]) => dependencies.has(dependency)).map(([, label]) => label);
        if (frameworks.length) lines.push(`Detected tooling/frameworks: ${frameworks.join(', ')}`);
        const scripts = isRecord(data.scripts)
          ? Object.keys(data.scripts).filter(name => /^[A-Za-z0-9_.:-]{1,100}$/.test(name)).slice(0, 40) : [];
        if (scripts.length) lines.push(`Available scripts: ${scripts.join(', ')}`);
        const checks = scripts.filter(name => {
          try { parseRunCommandArguments({ executable: manager, args: ['run', name] }); return true; }
          catch { return false; }
        });
        if (checks.length) lines.push(`Standard check commands: ${checks.map(name => `${manager} run ${name}`).join('; ')}`);
        if (Array.isArray(data.workspaces) || isRecord(data.workspaces)) lines.push('Workspace packages are configured; nested manifests are listed separately.');
      } catch { lines.push('Could not parse package.json; inspect the manifest directly.'); }
    } else if (base === 'pyproject.toml' || /^requirements.*\.txt$/.test(base) || base === 'setup.py' || base === 'setup.cfg') {
      lines.push('Language/runtime: Python');
      const frameworks = ['django', 'fastapi', 'flask', 'pytest', 'ruff', 'mypy']
        .filter(name => new RegExp(`(?:^|[^A-Za-z0-9_-])${name}(?:[^A-Za-z0-9_-]|$)`, 'im').test(content));
      if (frameworks.length) lines.push(`Detected tooling/frameworks: ${frameworks.join(', ')}`);
      lines.push(`Package manager: ${hasSibling(eligible, folder, 'uv.lock') ? 'uv' : /\[tool\.poetry\]/.test(content) ? 'Poetry' : 'pip / Python environment'}`);
      lines.push(`Check commands: python -m unittest${frameworks.includes('pytest') ? '; python -m pytest' : ''}`);
    } else if (base === 'cargo.toml') {
      lines.push('Language/runtime: Rust; package manager: Cargo', 'Check commands: cargo check; cargo test');
      if (/^\s*\[workspace\]/m.test(content)) lines.push('A Cargo workspace is configured.');
    } else if (base === 'go.mod') {
      lines.push('Language/runtime: Go; package manager: Go modules', 'Check commands: go test ./...; go vet ./...');
    } else if (base.endsWith('.csproj') || base.endsWith('.fsproj')) {
      lines.push(`Language/runtime: ${base.endsWith('.fsproj') ? 'F#' : 'C#'} / .NET`, 'Check commands: dotnet build; dotnet test');
    } else if (base === 'pom.xml') {
      lines.push('Language/runtime: JVM; build tool: Maven', 'Check commands: mvn test; mvn verify');
    } else if (base === 'build.gradle' || base === 'build.gradle.kts') {
      lines.push('Language/runtime: JVM; build tool: Gradle', 'Check commands: gradle test; gradle check');
    }
    sections.push(lines.join('\n'));
    if (sections.join('\n').length >= MAX_RESULT_CHARACTERS) break;
  }
  if (!manifests.length) sections.push('No supported project manifests were found in this scope.');
  else if (manifests.length > selected.length) sections.push(`${manifests.length - selected.length} additional manifests omitted; use a narrower path.`);
  sections.push('Detected frameworks and check commands are hints from manifests; commands have not been run.');
  return { result: boundedResult(sections.join('\n')), usedFiles };
}

export type GitReadOptions = {
  rootPath: string;
  path?: string;
  staged?: boolean;
  isPathAllowed: (relativePath: string) => Promise<boolean>;
  signal?: AbortSignal;
};
export type GitCommandRunner = (args: string[], options: { cwd: string; signal?: AbortSignal; timeout: number }) => Promise<string>;

/** Query only eligible changed paths. Diff drivers, text conversion, fsmonitor hooks, optional locks and paging are disabled. */
export async function readGitChanges(options: GitReadOptions, runGit: GitCommandRunner = executeGit): Promise<ProjectToolResult> {
  const scope = safeRelativePath(options.path ?? '', true);
  const deadline = Date.now() + 15_000;
  const disabledFilters: string[] = [];
  const invoke = (args: string[]) => {
    if (options.signal?.aborted) throw new Error('Git inspection was cancelled.');
    const timeout = Math.max(1, deadline - Date.now());
    if (timeout <= 1) throw new Error('Git inspection exceeded its time limit.');
    return runGit(['--no-pager', '--no-optional-locks', '--literal-pathspecs',
      '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'color.ui=false',
      '-c', 'core.quotePath=false', '-c', 'status.relativePaths=true', ...disabledFilters, ...args], {
      cwd: options.rootPath, signal: options.signal, timeout
    });
  };
  // Git may execute clean/process filters while hashing files, even when external diffs are disabled.
  // Read their names first and disable them for every subsequent inspection command.
  let filterConfiguration = '';
  try { filterConfiguration = await invoke(['config', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|smudge|process|required)$']); }
  catch (error) { if ((error as { code?: unknown }).code !== 1) throw error; }
  const drivers = new Set<string>();
  for (const key of filterConfiguration.split('\0').filter(Boolean)) {
    const match = /^filter\.([A-Za-z0-9_.-]{1,120})\.(?:clean|smudge|process|required)$/.exec(key);
    if (!match || drivers.size >= 64) throw new Error('Git filter configuration cannot be safely inspected.');
    drivers.add(match[1]);
  }
  for (const driver of drivers) {
    disabledFilters.push('-c', `filter.${driver}.clean=`, '-c', `filter.${driver}.smudge=`,
      '-c', `filter.${driver}.process=`, '-c', `filter.${driver}.required=false`);
  }
  const rawStatus = await invoke(['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--ignore-submodules=all', '--', scope || '.']);
  let branch = '(detached HEAD)';
  try { branch = (await invoke(['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim() || branch; }
  catch { if (options.signal?.aborted) throw new Error('Git inspection was cancelled.'); }
  const entries = parseGitStatus(rawStatus);
  const allowed: GitStatusEntry[] = [];
  for (const entry of entries) {
    if (!isSafeRelativePath(entry.path) || scope && entry.path !== scope && !entry.path.startsWith(`${scope}/`)) continue;
    if (!(await options.isPathAllowed(entry.path))) continue;
    if (entry.originalPath && (!isSafeRelativePath(entry.originalPath) || !(await options.isPathAllowed(entry.originalPath)))) continue;
    allowed.push(entry);
    if (allowed.length >= 40) break;
  }
  const sections = [`Branch: ${sanitizeCapturedTerminalText(branch).slice(0, 200)}`,
    `Scope: ${scope || '.'}; diff: ${options.staged ? 'staged' : 'unstaged'}`,
    'Status (eligible paths only):', ...allowed.map(entry => `${entry.status} ${entry.path}${entry.originalPath ? ` (from ${entry.originalPath})` : ''}`)];
  if (!allowed.length) sections.push('No eligible changed files in this scope.');
  if (allowed.length === 40) sections.push('Status list capped at 40 eligible files; narrow the path for more detail.');
  const usedFiles: string[] = [];
  for (const entry of allowed) {
    const status = entry.status[options.staged ? 0 : 1];
    if (status === ' ' || status === '?' || entry.status === '??') continue;
    if (usedFiles.length >= 12 || sections.join('\n').length >= 8_000) {
      sections.push('Further diffs omitted; narrow the path for more detail.'); break;
    }
    try {
      const diff = await invoke(['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--ignore-submodules=all',
        '--src-prefix=a/', '--dst-prefix=b/', '--unified=3', ...(options.staged ? ['--cached'] : []), '--', entry.path]);
      sections.push(`\n${sanitizeCapturedTerminalText(diff) || `${entry.path}: no textual diff.`}`);
      usedFiles.push(entry.path);
    } catch {
      if (options.signal?.aborted) throw new Error('Git inspection was cancelled.');
      sections.push(`${entry.path}: diff unavailable or exceeds the output/time limit.`);
    }
  }
  if (allowed.some(entry => entry.status === '??')) sections.push('Untracked file contents are omitted; use read_file to inspect them.');
  return { result: boundedResult(sections.join('\n')), usedFiles };
}

export type GitStatusEntry = { status: string; path: string; originalPath?: string };
export function parseGitStatus(value: string): GitStatusEntry[] {
  const records = value.split('\0');
  const result: GitStatusEntry[] = [];
  for (let index = 0; index < records.length && result.length < 2_000; index += 1) {
    const record = records[index];
    if (record.length < 4 || record[2] !== ' ') continue;
    const status = record.slice(0, 2);
    const originalPath = /[RC]/.test(status) ? records[++index] : undefined;
    result.push({ status, path: record.slice(3), ...(originalPath ? { originalPath } : {}) });
  }
  return result;
}

function executeGit(args: string[], options: { cwd: string; signal?: AbortSignal; timeout: number }): Promise<string> {
  // Ignore inherited Git configuration overrides so a custom external driver cannot be enabled through the environment.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  return new Promise((resolve, reject) => execFile('git', args, {
    ...options, env: { ...env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' },
    windowsHide: true, encoding: 'utf8', maxBuffer: 64_000
  }, (error, stdout) => {
    if (!error) { resolve(stdout); return; }
    const failure = new Error('Git inspection failed; open a Git repository with Git available on PATH.') as Error & { code?: unknown };
    failure.code = error.code;
    reject(failure);
  }));
}

function isProjectManifest(value: string): boolean {
  return /(?:^|\/)(?:package\.json|pyproject\.toml|requirements[^/]*\.txt|setup\.(?:py|cfg)|Cargo\.toml|go\.mod|[^/]+\.(?:csproj|fsproj)|pom\.xml|build\.gradle(?:\.kts)?)$/i.test(value);
}
function packageManagerFor(data: Record<string, unknown>, paths: string[], directory: string): string {
  const declared = typeof data.packageManager === 'string' ? /^(npm|pnpm|yarn)@/.exec(data.packageManager)?.[1] : undefined;
  return declared ?? (hasSibling(paths, directory, 'pnpm-lock.yaml') ? 'pnpm'
    : hasSibling(paths, directory, 'yarn.lock') ? 'yarn' : 'npm');
}
function hasSibling(paths: string[], directory: string, name: string): boolean {
  return paths.includes(directory === '.' ? name : `${directory}/${name}`);
}
function safeRelativePath(value: string, allowRoot = false): string {
  if (allowRoot && !value) return '';
  if (!isSafeRelativePath(value)) throw new Error('The project path must stay within the workspace.');
  return value;
}
function isSafeRelativePath(value: string): boolean {
  return Boolean(value) && value.length <= 1_000 && !/[\u0000-\u001f\u007f\\:]/.test(value)
    && !value.startsWith('/') && !value.split('/').some(part => !part || part === '.' || part === '..');
}
function boundedResult(value: string): string {
  const marker = '\n[Output limit reached; use a narrower path.]';
  return value.length <= MAX_RESULT_CHARACTERS ? value : value.slice(0, MAX_RESULT_CHARACTERS - marker.length) + marker;
}
function integerWithin(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  return typeof value === 'number' && Number.isInteger(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function expandGlobAlternatives(pattern: string): string[] {
  const first = pattern.indexOf('{');
  if (first < 0) {
    if (pattern.includes('}')) throw new Error('filePattern contains an unmatched brace.');
    return [pattern];
  }
  const last = pattern.indexOf('}', first);
  if (last < 0 || pattern.slice(first + 1, last).includes('{') || /[{}]/.test(pattern.slice(last + 1))) {
    throw new Error('filePattern supports one simple brace list, such as **/*.{ts,tsx}.');
  }
  const alternatives = pattern.slice(first + 1, last).split(',');
  if (alternatives.length > 10 || alternatives.some(value => !value)) throw new Error('filePattern brace lists require 1–10 nonempty alternatives.');
  return alternatives.map(value => pattern.slice(0, first) + value + pattern.slice(last + 1));
}
/** Memoized matching avoids turning user-supplied globs into potentially expensive regular expressions. */
function globMatches(value: string, pattern: string): boolean {
  const memo = new Map<string, boolean>();
  const visit = (input: number, glob: number): boolean => {
    const key = `${input}:${glob}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let matches: boolean;
    if (glob === pattern.length) matches = input === value.length;
    else if (pattern[glob] === '*') {
      const recursive = pattern[glob + 1] === '*';
      const next = glob + (recursive ? 2 : 1);
      matches = visit(input, next) || recursive && pattern[next] === '/' && visit(input, next + 1)
        || input < value.length && (recursive || value[input] !== '/') && visit(input + 1, glob);
    } else matches = input < value.length
      && (pattern[glob] === '?' ? value[input] !== '/' : pattern[glob] === value[input]) && visit(input + 1, glob + 1);
    memo.set(key, matches);
    return matches;
  };
  return visit(0, 0);
}
