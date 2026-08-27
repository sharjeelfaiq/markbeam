import * as monaco from 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/+esm';
import { defineThemes, themeFor } from './themes.js';

/*
 * Monaco is loaded from a hard-pinned CDN ESM URL rather than node_modules, so Vite
 * never bundles it. The `monaco-editor` entry in package.json exists only to pin the
 * version to match this URL — keep the two in step.
 */

/*
 * No web workers. `getWorker` returns a no-op Proxy, which means anything worker-backed
 * (real markdown validation, background tokenization) silently does nothing. Do not
 * build a feature that depends on a Monaco worker without first changing this.
 */
self.MonacoEnvironment = {
  getWorker() {
    return new Proxy({}, { get: () => () => {} });
  }
};

export const createEditor = (resolvedTheme, { onPaletteKey } = {}) => {
  defineThemes(monaco);

  const editor = monaco.editor.create(document.querySelector('#editor'), {
    fontSize: 14,
    fontFamily: "'Commit Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    lineHeight: 1.65,
    language: 'markdown',
    theme: themeFor(resolvedTheme),
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    automaticLayout: true,
    padding: { top: 20, bottom: 20 },
    lineNumbers: 'on',
    lineDecorationsWidth: 12,
    renderLineHighlight: 'line',
    scrollbar: {
      vertical: 'visible',
      horizontal: 'auto',
      verticalScrollbarSize: 10,
      useShadows: false
    },
    wordWrap: 'on',
    wrappingStrategy: 'advanced',
    hover: { enabled: false },
    /*
     * Hand the context menu back to the browser. Monaco's own menu replaces the native
     * one, and on Android the native menu is the only route to Select All — so with
     * Monaco's in place there is no way to select the document at all.
     *
     * The cost is Monaco's editor-specific entries (Command Palette, Go to Definition,
     * Format Document). The native menu still offers Cut / Copy / Paste / Select All,
     * which is the whole vocabulary prose needs, and our own palette is on Ctrl+K —
     * which is only true because of the keybinding registered below.
     */
    contextmenu: false,
    quickSuggestions: false,
    suggestOnTriggerCharacters: false,
    occurrencesHighlight: 'off',
    folding: false,
    smoothScrolling: true
  });

  /*
   * Monaco owns Ctrl/Cmd+K as a *chord prefix* (Ctrl+K Ctrl+C to comment, Ctrl+K Ctrl+X to
   * trim whitespace, and so on). Entering chord mode calls both preventDefault and
   * stopPropagation on the keydown, so the app's global handler — which listens on
   * `document` in the bubble phase — never saw the keystroke while the editor had focus,
   * and the command palette was unreachable exactly when it was most needed.
   *
   * Registering a *single-chord* Ctrl/Cmd+K here fixes that by configuration rather than
   * by racing Monaco for the event: dynamic keybindings are appended after the defaults
   * and the resolver scans candidates backwards, so this entry shadows the chord prefixes.
   * The resolver then reports a complete match instead of "more chords needed", which is
   * what stops chord mode being entered at all.
   *
   * A new global shortcut that collides with a Monaco default needs the same treatment.
   */
  if (onPaletteKey) {
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, onPaletteKey);
  }

  return editor;
};

export const setEditorTheme = (resolvedTheme) => {
  monaco.editor.setTheme(themeFor(resolvedTheme));
};

export { monaco };
