/** Apply language-provider text edits only after checking exact positions and overlap. */
export type ProviderTextEdit = {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  newText: string;
};

export function applyProviderTextEdits(source: string, edits: readonly ProviderTextEdit[]): string {
  if (!Array.isArray(edits) || edits.length > 10_000) throw new Error('The language provider returned too many edits.');
  const starts = [0];
  const ends: number[] = [];
  for (const match of source.matchAll(/\r\n|\r|\n/g)) {
    ends.push(match.index!);
    starts.push(match.index! + match[0].length);
  }
  ends.push(source.length);
  const offset = (position: { line: number; character: number }) => {
    if (!position || !Number.isInteger(position.line) || !Number.isInteger(position.character)
      || position.line < 0 || position.line >= starts.length || position.character < 0
      || position.character > ends[position.line] - starts[position.line]) {
      throw new Error('The language provider returned an invalid source position. No changes were applied.');
    }
    return starts[position.line] + position.character;
  };
  const replacements = edits.map(edit => {
    if (!edit?.range || typeof edit.newText !== 'string') throw new Error('The language provider returned an unsupported edit.');
    const start = offset(edit.range.start), end = offset(edit.range.end);
    if (end < start) throw new Error('The language provider returned a reversed range.');
    return { start, end, text: edit.newText };
  }).sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < replacements.length; i += 1) {
    if (replacements[i].start < replacements[i - 1].end || replacements[i].start === replacements[i - 1].start) {
      throw new Error('The language provider returned overlapping edits. No changes were applied.');
    }
  }
  let result = source;
  for (const edit of replacements.reverse()) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  return result;
}
