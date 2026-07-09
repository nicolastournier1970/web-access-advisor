/** Minimal fixed-width table renderer (plain console, no color deps). */

export type ColumnAlign = 'l' | 'r';

/**
 * Render rows under headers with two-space column gaps. Numeric-looking
 * columns should pass 'r' alignment. Trailing whitespace is trimmed per line.
 */
export function renderTable(
  headers: readonly string[],
  rows: ReadonlyArray<readonly string[]>,
  align?: readonly ColumnAlign[],
): string {
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => (row[i] ?? '').length)),
  );
  const renderLine = (cells: readonly string[]): string =>
    cells
      .map((cell, i) =>
        (align?.[i] ?? 'l') === 'r' ? cell.padStart(widths[i]!) : cell.padEnd(widths[i]!),
      )
      .join('  ')
      .trimEnd();
  return [renderLine(headers), ...rows.map(renderLine)].join('\n');
}
