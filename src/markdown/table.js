/*
 * Editing a Markdown table (T50).
 *
 * Pure: strings in, strings out, no DOM and no editor. `main.js` maps the cursor to a line
 * number and hands the lines over, which is what lets the awkward half — splitting and
 * re-escaping cells — be tested directly rather than through Monaco.
 *
 * **A pipe always splits a cell unless it is backslash-escaped, even inside backticks.** That
 * reads like a bug and is not: GFM requires `\|` for a literal pipe *including inside other
 * inline spans*, so `` `a|b` `` is two cells, not one. Special-casing code spans here would
 * disagree with the renderer sitting next to it, and the source would stop meaning what the
 * preview shows.
 */

const DELIMITER = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

/** A row is anything with a pipe in it that is not a fence or a heading. */
const looksLikeRow = (line) =>
  typeof line === 'string' && line.includes('|') && !/^\s*(```|~~~)/.test(line);

/*
 * Split on unescaped pipes only. Written as a scan rather than a regex split because the
 * escape has to be consumed as one unit — a `split(/(?<!\\)\|/)` leaves the backslash behind
 * in the cell and it reappears, doubled, on the next round trip.
 */
export const splitCells = (line) => {
  const cells = [];
  let cell = '';

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '\\' && line[i + 1] === '|') {
      cell += '|';
      i += 1;
    } else if (ch === '|') {
      cells.push(cell);
      cell = '';
    } else {
      cell += ch;
    }
  }
  cells.push(cell);

  // A leading and trailing pipe are conventional, and produce one empty cell at each end.
  if (cells.length && cells[0].trim() === '') cells.shift();
  if (cells.length && cells[cells.length - 1].trim() === '') cells.pop();

  return cells.map((value) => value.trim());
};

/** The inverse: a literal pipe goes back out escaped, so the row still parses as it was. */
const escapeCell = (value) => String(value ?? '').replace(/\|/g, '\\|');

const alignmentOf = (spec) => {
  const value = spec.trim();
  const left = value.startsWith(':');
  const right = value.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return 'none';
};

const delimiterFor = (align, width) => {
  const dashes = '-'.repeat(Math.max(3, width));
  if (align === 'center') return `:${dashes.slice(2)}:`;
  if (align === 'right') return `${dashes.slice(1)}:`;
  if (align === 'left') return `:${dashes.slice(1)}`;
  return dashes;
};

/*
 * The table containing `index`, or null. Walks outwards over row-shaped lines and then insists
 * on a delimiter as the *second* line — that requirement is the whole difference between a
 * table and a run of lines that merely contain pipes.
 */
export const findTableAt = (lines, index) => {
  if (!looksLikeRow(lines[index]) && !DELIMITER.test(lines[index] || '')) {
    return null;
  }

  let start = index;
  while (start > 0 && looksLikeRow(lines[start - 1])) {
    start -= 1;
  }

  let end = index;
  while (end < lines.length - 1 && looksLikeRow(lines[end + 1])) {
    end += 1;
  }

  if (end - start < 1 || !DELIMITER.test(lines[start + 1] || '')) {
    return null;
  }

  return { start, end };
};

export const parseTable = (lines) => {
  const header = splitCells(lines[0]);
  const align = splitCells(lines[1]).map(alignmentOf);
  const rows = lines.slice(2).map((line) => splitCells(line));

  // Ragged input is legal Markdown; normalise so every operation can assume a rectangle.
  const width = Math.max(header.length, align.length, ...rows.map((r) => r.length), 1);
  const pad = (cells) => Array.from({ length: width }, (_, i) => cells[i] ?? '');

  return {
    header: pad(header),
    align: Array.from({ length: width }, (_, i) => align[i] || 'none'),
    rows: rows.map(pad)
  };
};

/*
 * Re-emitted padded to even columns. That is most of the point of the feature: the reason
 * tables are miserable by hand is that keeping them readable means re-counting every column
 * after every edit.
 */
export const formatTable = ({ header, align, rows }) => {
  const cells = [header, ...rows].map((row) => row.map(escapeCell));
  const widths = header.map((_, column) =>
    Math.max(3, ...cells.map((row) => (row[column] || '').length))
  );

  const line = (row) => `| ${row.map((value, i) => (value || '').padEnd(widths[i])).join(' | ')} |`;

  return [
    line(cells[0]),
    `| ${align.map((a, i) => delimiterFor(a, widths[i])).join(' | ')} |`,
    ...cells.slice(1).map(line)
  ];
};

const blankRow = (width) => Array.from({ length: width }, () => '');

/* Each operation takes and returns a table, so they compose and stay trivially testable. */
export const addRow = (table, after) => {
  const rows = table.rows.slice();
  const at = Number.isInteger(after) ? Math.min(Math.max(after + 1, 0), rows.length) : rows.length;
  rows.splice(at, 0, blankRow(table.header.length));
  return { ...table, rows };
};

export const removeRow = (table, index) => {
  if (!table.rows.length) {
    return table;
  }
  const rows = table.rows.slice();
  rows.splice(Number.isInteger(index) ? Math.min(index, rows.length - 1) : rows.length - 1, 1);
  return { ...table, rows };
};

export const addColumn = (table, after) => {
  const at = Number.isInteger(after)
    ? Math.min(Math.max(after + 1, 0), table.header.length)
    : table.header.length;
  const insert = (row, value) => {
    const next = row.slice();
    next.splice(at, 0, value);
    return next;
  };
  return {
    header: insert(table.header, ''),
    align: insert(table.align, 'none'),
    rows: table.rows.map((row) => insert(row, ''))
  };
};

export const removeColumn = (table, index) => {
  // A table with no columns is not a table; refuse rather than emit something unparseable.
  if (table.header.length <= 1) {
    return table;
  }
  const at = Number.isInteger(index) ? Math.min(index, table.header.length - 1) : table.header.length - 1;
  const drop = (row) => row.filter((_, i) => i !== at);
  return { header: drop(table.header), align: drop(table.align), rows: table.rows.map(drop) };
};

const ORDER = ['none', 'left', 'center', 'right'];

export const cycleAlign = (table, index) => {
  const at = Number.isInteger(index) ? Math.min(index, table.align.length - 1) : 0;
  const align = table.align.slice();
  align[at] = ORDER[(ORDER.indexOf(align[at]) + 1) % ORDER.length];
  return { ...table, align };
};

/** Which column a character offset falls in, so an edit lands where the cursor is. */
export const columnAt = (line, offset) => {
  let column = 0;
  for (let i = 0; i < Math.min(offset, line.length); i += 1) {
    if (line[i] === '\\' && line[i + 1] === '|') {
      i += 1;
    } else if (line[i] === '|') {
      column += 1;
    }
  }
  // A leading pipe opens the first cell rather than closing a previous one.
  return Math.max(0, line.trimStart().startsWith('|') ? column - 1 : column);
};
