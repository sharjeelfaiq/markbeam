/*
 * Markdown formatting actions.
 *
 * `monaco` is passed in rather than imported: `editor/index.js` owns the CDN import, and
 * importing it back from here would make the two modules circular.
 *
 * Every edit goes through `executeEdits`, so each action is a single undo step — pressing
 * bold and then Ctrl+Z returns to exactly where you were, rather than unwinding character by
 * character.
 */

/*
 * Which keys Monaco already owns was measured rather than assumed, because `CLAUDE.md` warns
 * that a colliding shortcut never reaches the document listener in `ui/palette.js`. Two
 * separate questions, and the answers differ:
 *
 *   reaches `document`   — Ctrl+B, Ctrl+E, Ctrl+U, Ctrl+Shift+{K,L,H,E}
 *   swallowed by Monaco  — Ctrl+I, Ctrl+L, Ctrl+D, Ctrl+H, Ctrl+Shift+{7,8}
 *   actually mutates     — Ctrl+Shift+K alone (Delete Line)
 *
 * So Ctrl+I is invisible to the palette handler, and Ctrl+Shift+K would delete the line. Both
 * are handled the same way the palette's own Ctrl+K is: a dynamic keybinding registered here
 * shadows Monaco's, because dynamic bindings are appended after the defaults and the resolver
 * scans candidates backwards.
 *
 * Everything is registered, not only the two that collide. A future Monaco version that grabs
 * a different key cannot then break a shortcut silently.
 */

/** Does the text already carry this marker on both sides? */
let isWrapped = (text, marker) =>
  text.length >= marker.length * 2 && text.startsWith(marker) && text.endsWith(marker);

/*
 * Wrapping is a toggle. Without that, pressing bold twice — which is what people do when they
 * are not sure it worked — produces `****text****` rather than plain text again.
 */
let wrap = (editor, monaco, marker) => {
  const model = editor.getModel();
  const selection = editor.getSelection();
  if (!model || !selection) {
    return;
  }

  const selected = model.getValueInRange(selection);

  if (selected.length === 0) {
    // Nothing selected: drop the pair in and put the cursor between the halves.
    const position = selection.getStartPosition();
    editor.executeEdits('markbeam-format', [{ range: selection, text: marker + marker }]);
    const column = position.column + marker.length;
    editor.setSelection(new monaco.Selection(position.lineNumber, column, position.lineNumber, column));
    editor.focus();
    return;
  }

  const unwrapping = isWrapped(selected, marker);
  const next = unwrapping ? selected.slice(marker.length, -marker.length) : marker + selected + marker;

  editor.executeEdits('markbeam-format', [{ range: selection, text: next }]);

  // Keep the text selected so the action can be repeated or reversed immediately.
  editor.setSelection(
    new monaco.Selection(
      selection.startLineNumber,
      selection.startColumn,
      selection.startLineNumber === selection.endLineNumber
        ? selection.startColumn + next.length
        : selection.endColumn,
      selection.startLineNumber === selection.endLineNumber ? selection.startColumn + next.length : selection.endColumn
    )
  );
  editor.focus();
};

/** Toggles a line prefix across every line the selection touches. */
let prefixLines = (editor, monaco, prefix) => {
  const model = editor.getModel();
  const selection = editor.getSelection();
  if (!model || !selection) {
    return;
  }

  const edits = [];
  let removing = true;

  for (let line = selection.startLineNumber; line <= selection.endLineNumber; line += 1) {
    if (!model.getLineContent(line).startsWith(prefix)) {
      removing = false;
      break;
    }
  }

  for (let line = selection.startLineNumber; line <= selection.endLineNumber; line += 1) {
    const content = model.getLineContent(line);
    const next = removing ? content.slice(prefix.length) : prefix + content;
    edits.push({
      range: new monaco.Range(line, 1, line, content.length + 1),
      text: next
    });
  }

  editor.executeEdits('markbeam-format', edits);
  editor.focus();
};

/*
 * A link keeps the selection as the label and leaves the cursor in the URL, which is the part
 * that still needs typing.
 */
let insertLink = (editor, monaco) => {
  const model = editor.getModel();
  const selection = editor.getSelection();
  if (!model || !selection) {
    return;
  }

  const label = model.getValueInRange(selection);
  const text = `[${label}](url)`;
  editor.executeEdits('markbeam-format', [{ range: selection, text }]);

  const urlStart = selection.startColumn + label.length + 3;
  editor.setSelection(
    new monaco.Selection(selection.startLineNumber, urlStart, selection.startLineNumber, urlStart + 3)
  );
  editor.focus();
};

/**
 * Builds the actions and binds them inside Monaco. Returns them so `main.js` can put the same
 * functions in the command palette, which is what makes them work when the editor is blurred.
 */
export const createFormatting = (editor, monaco) => {
  const actions = {
    bold: () => wrap(editor, monaco, '**'),
    italic: () => wrap(editor, monaco, '*'),
    code: () => wrap(editor, monaco, '`'),
    link: () => insertLink(editor, monaco),
    heading: () => prefixLines(editor, monaco, '# '),
    list: () => prefixLines(editor, monaco, '- ')
  };

  const { CtrlCmd, Shift } = monaco.KeyMod;
  const bindings = [
    [CtrlCmd | monaco.KeyCode.KeyB, actions.bold],
    [CtrlCmd | monaco.KeyCode.KeyI, actions.italic],
    [CtrlCmd | monaco.KeyCode.KeyE, actions.code],
    [CtrlCmd | Shift | monaco.KeyCode.KeyK, actions.link],
    [CtrlCmd | Shift | monaco.KeyCode.KeyH, actions.heading],
    [CtrlCmd | Shift | monaco.KeyCode.KeyL, actions.list]
  ];

  for (const [keybinding, run] of bindings) {
    editor.addCommand(keybinding, run);
  }

  return actions;
};
