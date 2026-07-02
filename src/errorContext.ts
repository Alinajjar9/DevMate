import { sanitizeCommandOutput } from './commandTools';

export const MAX_CAPTURED_TERMINAL_ERRORS = 5;
export const MAX_CAPTURED_TERMINAL_OUTPUT_CHARACTERS = 8_000;

export type CapturedTerminalError = {
  command: string;
  cwd: string;
  terminalName: string;
  exitCode: number;
  output: string;
  capturedAt: number;
};

export function sanitizeCapturedTerminalText(value: string): string {
  const sanitized = sanitizeCommandOutput(value)
    .replace(
      /(authorization\s*:\s*(?:bearer|basic)\s+)[^\s]+/gi,
      '$1[REDACTED]'
    )
    .replace(
      /((?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s]+)/gi,
      '$1[REDACTED]'
    )
    .replace(
      /(--(?:api-key|token|password|secret)(?:=|\s+))[^\s]+/gi,
      '$1[REDACTED]'
    )
    .replace(
      /([a-z][a-z0-9+.-]*:\/\/[^:\s/]+:)[^@\s/]+@/gi,
      '$1[REDACTED]@'
    )
    .replace(
      /\b(?:sk|nvapi)-[a-z0-9_-]{12,}\b/gi,
      '[REDACTED]'
    );
  return tail(sanitized, MAX_CAPTURED_TERMINAL_OUTPUT_CHARACTERS);
}

export function formatCapturedTerminalErrors(
  entries: CapturedTerminalError[],
  maxResults: number
): string {
  const selected = entries.slice(0, Math.max(1, Math.min(MAX_CAPTURED_TERMINAL_ERRORS, maxResults)));
  if (selected.length === 0) {
    return [
      'No failed workspace terminal commands have been captured.',
      'DevMate can only capture commands run after activation when VS Code Terminal Shell Integration is available.'
    ].join('\n');
  }

  const sections = selected.map((entry, index) => [
    `Failure ${index + 1}:`,
    `Command: ${sanitizeCapturedTerminalText(entry.command) || '(unavailable)'}`,
    `Terminal: ${sanitizeCapturedTerminalText(entry.terminalName) || '(unnamed)'}`,
    `Working directory: ${entry.cwd || '.'}`,
    `Exit code: ${entry.exitCode}`,
    entry.output
      ? `Output:\n${sanitizeCapturedTerminalText(entry.output)}`
      : 'Output: (none captured)'
  ].join('\n'));

  return `Recent failed workspace terminal commands (${selected.length}, newest first):\n\n${sections.join('\n\n')}`;
}

function tail(value: string, maximum: number): string {
  if (value.length <= maximum) {
    return value;
  }
  const marker = '[Earlier output omitted]\n';
  return `${marker}${value.slice(-(maximum - marker.length))}`;
}
