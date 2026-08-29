/*
 * Atomic Markdown formatting actions shared by Monaco shortcuts, the command palette and
 * the editor toolbar. `monaco` is injected by editor/index.js to avoid a circular import.
 */

const FORMAT_SOURCE = 'markbeam-format';

const selectionOffsets = (model, selection) => ({
  anchor: model.getOffsetAt({
    lineNumber: selection.selectionStartLineNumber,
    column: selection.selectionStartColumn
  }),
  active: model.getOffsetAt({
    lineNumber: selection.positionLineNumber,
    column: selection.positionColumn
  }),
  start: model.getOffsetAt(selection.getStartPosition()),
  end: model.getOffsetAt(selection.getEndPosition())
});

const setOffsetSelection = (editor, monaco, anchor, active = anchor) => {
  const model = editor.getModel();
  if (!model) return;
  const anchorPosition = model.getPositionAt(Math.max(0, Math.min(anchor, model.getValueLength())));
  const activePosition = model.getPositionAt(Math.max(0, Math.min(active, model.getValueLength())));
  editor.setSelection(
    new monaco.Selection(
      anchorPosition.lineNumber,
      anchorPosition.column,
      activePosition.lineNumber,
      activePosition.column
    )
  );
};

const replaceRange = (editor, monaco, range, text, anchorOffset, activeOffset = anchorOffset) => {
  editor.pushUndoStop();
  editor.executeEdits(FORMAT_SOURCE, [{ range, text, forceMoveMarkers: true }]);
  editor.pushUndoStop();
  setOffsetSelection(editor, monaco, anchorOffset, activeOffset);
  editor.focus();
};

const wrap = (editor, monaco, marker) => {
  const model = editor.getModel();
  const selection = editor.getSelection();
  if (!model || !selection) return;

  const offsets = selectionOffsets(model, selection);
  const value = model.getValue();
  const selected = value.slice(offsets.start, offsets.end);
  const direction = offsets.anchor <= offsets.active ? 1 : -1;
  const restoreDirection = (start, end) => (direction > 0 ? [start, end] : [end, start]);

  if (offsets.start === offsets.end) {
    const before = value.slice(offsets.start - marker.length, offsets.start);
    const after = value.slice(offsets.end, offsets.end + marker.length);
    if (before === marker && after === marker) {
      const range = monaco.Range.fromPositions(
        model.getPositionAt(offsets.start - marker.length),
        model.getPositionAt(offsets.end + marker.length)
      );
      replaceRange(editor, monaco, range, '', offsets.start - marker.length);
      return;
    }

    replaceRange(editor, monaco, selection, marker + marker, offsets.start + marker.length);
    return;
  }

  if (
    selected.startsWith(marker) &&
    selected.endsWith(marker) &&
    selected.length >= marker.length * 2
  ) {
    const next = selected.slice(marker.length, -marker.length);
    const [anchor, active] = restoreDirection(offsets.start, offsets.start + next.length);
    replaceRange(editor, monaco, selection, next, anchor, active);
    return;
  }

  const before = value.slice(offsets.start - marker.length, offsets.start);
  const after = value.slice(offsets.end, offsets.end + marker.length);
  if (before === marker && after === marker) {
    const expanded = new monaco.Range(
      selection.startLineNumber,
      Math.max(1, selection.startColumn - marker.length),
      selection.endLineNumber,
      selection.endColumn + marker.length
    );
    const [anchor, active] = restoreDirection(
      offsets.start - marker.length,
      offsets.start - marker.length + selected.length
    );
    replaceRange(editor, monaco, expanded, selected, anchor, active);
    return;
  }

  const [anchor, active] = restoreDirection(
    offsets.start + marker.length,
    offsets.start + marker.length + selected.length
  );
  replaceRange(editor, monaco, selection, `${marker}${selected}${marker}`, anchor, active);
};

const selectedLineRange = (selection) => {
  let endLine = selection.endLineNumber;
  if (!selection.isEmpty() && selection.endColumn === 1 && endLine > selection.startLineNumber) {
    endLine -= 1;
  }
  return { startLine: selection.startLineNumber, endLine };
};

const lineEndpoint = (selection, anchor) =>
  anchor
    ? { line: selection.selectionStartLineNumber, column: selection.selectionStartColumn }
    : { line: selection.positionLineNumber, column: selection.positionColumn };

/*
 * Rewrites complete lines but maps both selection endpoints through the old/new prefix
 * lengths. This keeps the selected source content stable even when markers change width.
 */
const transformSelectedLines = (editor, monaco, transform) => {
  const model = editor.getModel();
  const selection = editor.getSelection();
  if (!model || !selection) return;

  const { startLine, endLine } = selectedLineRange(selection);
  const mappings = new Map();
  const edits = [];

  for (let line = startLine; line <= endLine; line += 1) {
    const content = model.getLineContent(line);
    const result = transform(content, line - startLine, line);
    const next = typeof result === 'string' ? result : result.text;
    const oldPrefixLength = typeof result === 'string' ? 0 : result.oldPrefixLength || 0;
    const newPrefixLength = typeof result === 'string' ? 0 : result.newPrefixLength || 0;
    mappings.set(line, { oldPrefixLength, newPrefixLength, nextLength: next.length });
    if (next !== content) {
      edits.push({
        range: new monaco.Range(line, 1, line, content.length + 1),
        text: next,
        forceMoveMarkers: true
      });
    }
  }

  if (edits.length === 0) {
    editor.focus();
    return;
  }

  const mapEndpoint = ({ line, column }) => {
    const mapping = mappings.get(line);
    if (!mapping) return { lineNumber: line, column };
    const contentOffset = Math.max(0, column - 1 - mapping.oldPrefixLength);
    return {
      lineNumber: line,
      column: Math.min(mapping.nextLength + 1, mapping.newPrefixLength + contentOffset + 1)
    };
  };

  const anchor = mapEndpoint(lineEndpoint(selection, true));
  const active = mapEndpoint(lineEndpoint(selection, false));
  editor.pushUndoStop();
  editor.executeEdits(FORMAT_SOURCE, edits);
  editor.pushUndoStop();
  editor.setSelection(
    new monaco.Selection(anchor.lineNumber, anchor.column, active.lineNumber, active.column)
  );
  editor.focus();
};

const headingPrefix = (line) => {
  const match = line.match(/^(\s{0,3})(#{1,6})[ \t]+/);
  return match
    ? { indent: match[1], level: match[2].length, length: match[0].length }
    : { indent: (line.match(/^\s{0,3}/) || [''])[0], level: 0, length: 0 };
};

const setHeading = (editor, monaco, level) => {
  const model = editor.getModel();
  const selection = editor.getSelection();
  if (!model || !selection) return;
  const { startLine, endLine } = selectedLineRange(selection);
  const nonEmpty = [];
  for (let line = startLine; line <= endLine; line += 1) {
    if (model.getLineContent(line).trim()) nonEmpty.push(model.getLineContent(line));
  }
  const removing =
    level > 0 &&
    nonEmpty.length > 0 &&
    nonEmpty.every((line) => headingPrefix(line).level === level);
  const target = removing ? 0 : level;

  transformSelectedLines(editor, monaco, (line) => {
    if (!line.trim()) return { text: line, oldPrefixLength: 0, newPrefixLength: 0 };
    const current = headingPrefix(line);
    const body = current.length ? line.slice(current.length) : line.slice(current.indent.length);
    const oldPrefixLength = current.length || current.indent.length;
    const prefix = target ? `${current.indent}${'#'.repeat(target)} ` : current.indent;
    return {
      text: prefix + body,
      oldPrefixLength,
      newPrefixLength: prefix.length
    };
  });
};

const listPrefix = (line) => {
  const task = line.match(/^(\s*)[-+*][ \t]+\[([ xX])\][ \t]+/);
  if (task) return { indent: task[1], kind: 'task', length: task[0].length };
  const bullet = line.match(/^(\s*)[-+*][ \t]+/);
  if (bullet) return { indent: bullet[1], kind: 'bullet', length: bullet[0].length };
  const ordered = line.match(/^(\s*)\d+[.)][ \t]+/);
  if (ordered) return { indent: ordered[1], kind: 'ordered', length: ordered[0].length };
  const indent = (line.match(/^\s*/) || [''])[0];
  return { indent, kind: null, length: indent.length };
};

const setList = (editor, monaco, kind) => {
  const model = editor.getModel();
  const selection = editor.getSelection();
  if (!model || !selection) return;
  const { startLine, endLine } = selectedLineRange(selection);
  const nonEmpty = [];
  for (let line = startLine; line <= endLine; line += 1) {
    const content = model.getLineContent(line);
    if (content.trim()) nonEmpty.push(content);
  }
  const removing = nonEmpty.length > 0 && nonEmpty.every((line) => listPrefix(line).kind === kind);
  let ordinal = 0;

  transformSelectedLines(editor, monaco, (line) => {
    if (!line.trim()) return { text: line, oldPrefixLength: 0, newPrefixLength: 0 };
    const current = listPrefix(line);
    const body = line.slice(current.length);
    ordinal += 1;
    const marker = removing
      ? ''
      : kind === 'ordered'
        ? `${ordinal}. `
        : kind === 'task'
          ? '- [ ] '
          : '- ';
    const prefix = current.indent + marker;
    return {
      text: prefix + body,
      oldPrefixLength: current.length,
      newPrefixLength: prefix.length
    };
  });
};

const blockquotePrefix = (line) => {
  const match = line.match(/^(\s*)>[ \t]?/);
  const indent = match ? match[1] : (line.match(/^\s*/) || [''])[0];
  return { indent, present: !!match, length: match ? match[0].length : indent.length };
};

const toggleBlockquote = (editor, monaco) => {
  const model = editor.getModel();
  const selection = editor.getSelection();
  if (!model || !selection) return;
  const { startLine, endLine } = selectedLineRange(selection);
  const nonEmpty = [];
  for (let line = startLine; line <= endLine; line += 1) {
    const content = model.getLineContent(line);
    if (content.trim()) nonEmpty.push(content);
  }
  const removing =
    nonEmpty.length > 0 && nonEmpty.every((line) => blockquotePrefix(line).present);

  transformSelectedLines(editor, monaco, (line) => {
    if (!line.trim()) return { text: line, oldPrefixLength: 0, newPrefixLength: 0 };
    const current = blockquotePrefix(line);
    const body = line.slice(current.length);
    const prefix = removing
      ? current.indent
      : current.present
        ? line.slice(0, current.length)
        : `${current.indent}> `;
    return {
      text: prefix + body,
      oldPrefixLength: current.length,
      newPrefixLength: prefix.length
    };
  });
};

const fenceRanges = (model) => {
  const ranges = [];
  let open = null;
  for (let line = 1; line <= model.getLineCount(); line += 1) {
    const content = model.getLineContent(line);
    const match = content.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (!match) continue;
    if (!open) {
      open = { line, character: match[1][0], length: match[1].length };
    } else if (match[1][0] === open.character && match[1].length >= open.length) {
      ranges.push({ startLine: open.line, endLine: line });
      open = null;
    }
  }
  if (open) ranges.push({ startLine: open.line, endLine: model.getLineCount() });
  return ranges;
};

const selectionFence = (model, selection) => {
  const selected = selectedLineRange(selection);
  return fenceRanges(model).find(
    (range) => selected.startLine >= range.startLine && selected.endLine <= range.endLine
  );
};

const selectionTouchesFence = (model, selection) => {
  const selected = selectedLineRange(selection);
  return fenceRanges(model).some(
    (range) => selected.endLine >= range.startLine && selected.startLine <= range.endLine
  );
};

const toggleCodeBlock = (editor, monaco) => {
  const model = editor.getModel();
  const selection = editor.getSelection();
  if (!model || !selection) return;
  const offsets = selectionOffsets(model, selection);
  const direction = offsets.anchor <= offsets.active ? 1 : -1;
  const enclosing = selectionFence(model, selection);

  if (enclosing && enclosing.endLine > enclosing.startLine) {
    const opening = model.getLineContent(enclosing.startLine);
    const closing = model.getLineContent(enclosing.endLine);
    if (
      /^\s{0,3}(`{3,}|~{3,})/.test(opening) &&
      /^\s{0,3}(`{3,}|~{3,})\s*$/.test(closing)
    ) {
      const range = new monaco.Range(
        enclosing.startLine,
        1,
        enclosing.endLine,
        closing.length + 1
      );
      const innerLines = [];
      for (let line = enclosing.startLine + 1; line < enclosing.endLine; line += 1) {
        innerLines.push(model.getLineContent(line));
      }
      const text = innerLines.join('\n');
      const rangeStart = model.getOffsetAt(range.getStartPosition());
      const innerStart = model.getOffsetAt({ lineNumber: enclosing.startLine + 1, column: 1 });
      const map = (offset) => rangeStart + Math.max(0, Math.min(text.length, offset - innerStart));
      replaceRange(editor, monaco, range, text, map(offsets.anchor), map(offsets.active));
      return;
    }
  }

  const selected = model.getValueInRange(selection);
  const exact = selected.match(/^\s*(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n\1\s*$/);
  if (exact) {
    const text = exact[2];
    const start = offsets.start;
    const [anchor, active] =
      direction > 0 ? [start, start + text.length] : [start + text.length, start];
    replaceRange(editor, monaco, selection, text, anchor, active);
    return;
  }

  if (selection.isEmpty()) {
    replaceRange(editor, monaco, selection, '```\n\n```', offsets.start + 3 + model.getEOL().length);
    return;
  }

  const text = '```\n' + selected + '\n```';
  const innerStart = offsets.start + 3 + model.getEOL().length;
  const [anchor, active] =
    direction > 0
      ? [innerStart, innerStart + selected.length]
      : [innerStart + selected.length, innerStart];
  replaceRange(editor, monaco, selection, text, anchor, active);
};

const insertLink = (editor, monaco) => {
  const model = editor.getModel();
  const selection = editor.getSelection();
  if (!model || !selection) return;
  const offsets = selectionOffsets(model, selection);
  const selected = model.getValueInRange(selection);
  const label = selected || 'link text';
  const text = `[${label}](url)`;

  if (!selected) {
    replaceRange(
      editor,
      monaco,
      selection,
      text,
      offsets.start + 1,
      offsets.start + 1 + label.length
    );
    return;
  }

  const urlStart = offsets.start + label.length + 3;
  replaceRange(editor, monaco, selection, text, urlStart, urlStart + 3);
};

const insertTable = (editor, monaco) => {
  const model = editor.getModel();
  const selection = editor.getSelection();
  if (!model || !selection) return;
  const offsets = selectionOffsets(model, selection);
  const cell = model
    .getValueInRange(selection)
    .replace(/\|/g, '\\|')
    .replace(/\s+/g, ' ')
    .trim();
  const header = '| Column 1 | Column 2 |';
  const divider = '| --- | --- |';
  const body = `| ${cell} |  |`;
  const text = `${header}\n${divider}\n${body}`;
  const nextCell =
    offsets.start +
    header.length +
    divider.length +
    model.getEOL().length * 2 +
    `| ${cell} | `.length;
  replaceRange(editor, monaco, selection, text, nextCell);
};

const unescapedMarkerPositions = (line, marker) => {
  const positions = [];
  for (let index = 0; index <= line.length - marker.length; index += 1) {
    if (line.slice(index, index + marker.length) !== marker) continue;
    let slashes = 0;
    for (let before = index - 1; before >= 0 && line[before] === '\\'; before -= 1) slashes += 1;
    if (slashes % 2) continue;
    const character = marker[0];
    if (line[index - 1] === character || line[index + marker.length] === character) continue;
    positions.push(index);
    index += marker.length - 1;
  }
  return positions;
};

const inlineActive = (line, marker, startColumn, endColumn) => {
  const positions = unescapedMarkerPositions(line, marker);
  if (positions.length < 2 || positions.length % 2 !== 0) return false;
  const start = startColumn - 1;
  const end = endColumn - 1;
  const containing = [];
  for (let index = 0; index < positions.length; index += 2) {
    const open = positions[index];
    const close = positions[index + 1];
    const inside = start >= open + marker.length && end <= close;
    const includesPair = start === open && end === close + marker.length;
    if (inside || includesPair) containing.push([open, close]);
  }
  return containing.length === 1;
};

const allSelectedNonEmpty = (model, selection, predicate) => {
  const { startLine, endLine } = selectedLineRange(selection);
  const lines = [];
  for (let line = startLine; line <= endLine; line += 1) {
    const content = model.getLineContent(line);
    if (content.trim()) lines.push(content);
  }
  return lines.length > 0 && lines.every(predicate);
};

const getState = (editor) => {
  const model = editor.getModel();
  const selection = editor.getSelection();
  const empty = {
    bold: false,
    italic: false,
    strike: false,
    code: false,
    heading: 0,
    paragraph: false,
    bulletList: false,
    orderedList: false,
    taskList: false,
    blockquote: false,
    codeBlock: false,
    inFencedCode: false
  };
  if (!model || !selection) return empty;

  const inFencedCode = selectionTouchesFence(model, selection);
  if (inFencedCode) return { ...empty, inFencedCode: true };

  let heading = 0;
  for (const level of [1, 2, 3]) {
    if (allSelectedNonEmpty(model, selection, (line) => headingPrefix(line).level === level)) {
      heading = level;
      break;
    }
  }

  const sameLine = selection.startLineNumber === selection.endLineNumber;
  const line = sameLine ? model.getLineContent(selection.startLineNumber) : '';

  return {
    bold: sameLine && inlineActive(line, '**', selection.startColumn, selection.endColumn),
    italic: sameLine && inlineActive(line, '*', selection.startColumn, selection.endColumn),
    strike: sameLine && inlineActive(line, '~~', selection.startColumn, selection.endColumn),
    code: sameLine && inlineActive(line, '`', selection.startColumn, selection.endColumn),
    heading,
    paragraph: allSelectedNonEmpty(model, selection, (content) => headingPrefix(content).level === 0),
    bulletList: allSelectedNonEmpty(
      model,
      selection,
      (content) => listPrefix(content).kind === 'bullet'
    ),
    orderedList: allSelectedNonEmpty(
      model,
      selection,
      (content) => listPrefix(content).kind === 'ordered'
    ),
    taskList: allSelectedNonEmpty(
      model,
      selection,
      (content) => listPrefix(content).kind === 'task'
    ),
    blockquote: allSelectedNonEmpty(
      model,
      selection,
      (content) => blockquotePrefix(content).present
    ),
    codeBlock: false,
    inFencedCode: false
  };
};

/** Creates all shared actions and retains the original six Monaco shortcuts. */
export const createFormatting = (editor, monaco) => {
  const actions = {
    bold: () => wrap(editor, monaco, '**'),
    italic: () => wrap(editor, monaco, '*'),
    strike: () => wrap(editor, monaco, '~~'),
    code: () => wrap(editor, monaco, '`'),
    link: () => insertLink(editor, monaco),
    setHeading: (level) => setHeading(editor, monaco, level),
    paragraph: () => setHeading(editor, monaco, 0),
    list: () => setList(editor, monaco, 'bullet'),
    orderedList: () => setList(editor, monaco, 'ordered'),
    taskList: () => setList(editor, monaco, 'task'),
    blockquote: () => toggleBlockquote(editor, monaco),
    codeBlock: () => toggleCodeBlock(editor, monaco),
    table: () => insertTable(editor, monaco),
    getState: () => getState(editor)
  };
  actions.heading = () => actions.setHeading(1);

  const { CtrlCmd, Shift } = monaco.KeyMod;
  const bindings = [
    [CtrlCmd | monaco.KeyCode.KeyB, actions.bold],
    [CtrlCmd | monaco.KeyCode.KeyI, actions.italic],
    [CtrlCmd | monaco.KeyCode.KeyE, actions.code],
    [CtrlCmd | Shift | monaco.KeyCode.KeyK, actions.link],
    [CtrlCmd | Shift | monaco.KeyCode.KeyH, actions.heading],
    [CtrlCmd | Shift | monaco.KeyCode.KeyL, actions.list]
  ];

  for (const [keybinding, run] of bindings) editor.addCommand(keybinding, run);
  return actions;
};
