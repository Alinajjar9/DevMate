/** Starting-context preferences. These filters do not grant or revoke tool permissions. */

export type ContextPreferences = {
  contextCharacters: number;
  pinnedFiles: string[];
  excludedPaths: string[];
};

/** Support simple workspace globs (*, ** and ?) and directory names without a dependency. */
export function isContextExcluded(relativePath: string, patterns: readonly string[]): boolean {
  const candidate = relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
  return patterns.some(pattern => {
    const normalized = pattern.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    if (!normalized) { return false; }
    let expression = '';
    for (let index = 0; index < normalized.length; index += 1) {
      const character = normalized[index];
      if (character === '*' && normalized[index + 1] === '*') {
        index += 1;
        if (normalized[index + 1] === '/') { expression += '(?:.*/)?'; index += 1; }
        else { expression += '.*'; }
      } else if (character === '*') { expression += '[^/]*'; }
      else if (character === '?') { expression += '[^/]'; }
      else { expression += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
    }
    const prefix = normalized.includes('/') ? '^' : '(?:^|/)';
    return new RegExp(`${prefix}${expression}(?:/.*)?$`, process.platform === 'win32' ? 'i' : '').test(candidate);
  });
}
