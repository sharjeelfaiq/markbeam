import * as monaco from 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/+esm';
import codiconUrl from 'monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.ttf?url';
import { defineThemes, themeFor } from './themes.js';

/*
 * Monaco is loaded from a hard-pinned CDN ESM URL rather than node_modules, so Vite
 * never bundles it. The `monaco-editor` entry in package.json exists only to pin the
 * version to match this URL — and, since the codicon font below is imported from that
 * package, the version now lives in three places. Keep all three in step.
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

/*
 * The icon font, self-hosted — without this every icon in the find widget is the same box.
 *
 * Monaco's own stylesheet asks for the font relatively: `src: url(./codicon.ttf)`. The CDN's
 * `+esm` build inlines that CSS into JavaScript and injects it as a <style> tag at runtime,
 * and a relative url() in an injected stylesheet resolves against **the document**, not
 * against the CDN. So the browser fetches `/codicon.ttf` from Markbeam's own origin.
 *
 * That does not even fail loudly. The dev server answers with index.html — 200, ~29 KB of
 * HTML — so there is no console error and no failed request to notice; the font simply never
 * parses. Every codicon is a separate glyph of that one family, so they all collapse to the
 * same missing-glyph box. The find widget is the only place this shows, because contextmenu,
 * folding, minimap and suggestions are all disabled below.
 *
 * Two details make the fix work:
 *
 * - **Declared after Monaco's.** Same family, same descriptors, so last one wins. Monaco's CSS
 *   is injected while its module evaluates, which is before this line runs.
 * - **`?url` rather than a CSS url().** Vite hashes it into /assets/, which is precisely what
 *   `isImmutable()` in `public/sw.js` serves cache-first — so the icons survive offline too.
 */
const codiconFace = document.createElement('style');
codiconFace.textContent = `@font-face{font-family:"codicon";font-display:block;src:url("${codiconUrl}") format("truetype")}`;
document.head.appendChild(codiconFace);

export const createEditor = (resolvedTheme, { onPaletteKey, onSearchKey } = {}) => {
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
   * Dragging to scroll gives up the caret, on touch devices only (T68).
   *
   * **Android's back button dismisses the keyboard without blurring anything.** After somebody
   * has tapped once and typed, the hidden `textarea.inputarea` keeps focus for the rest of the
   * session, so every later touch — including a drag meant to scroll — is a fresh gesture on a
   * focused text field, and the browser answers it with the keyboard. Dismissing it again
   * changes nothing, because dismissal was never the state that mattered. T64 removed the
   * focus granted at *boot*; this is the one left behind by *use*.
   *
   * A movement threshold separates the two gestures: a tap never travels 10px, so it falls
   * through to Monaco and still focuses. Only a scroll gives the caret up, and the cost of
   * that is one tap to resume typing — what every native editor does.
   *
   * **Not `visualViewport`.** Its resize does fire when the IME hides, but equally when the
   * URL bar collapses, on rotation and on zoom, so keying on it would blur people mid-sentence
   * for reasons that have nothing to do with the keyboard.
   *
   * `passive: true` matters: this must never be able to hold up a scroll.
   */
  if (window.matchMedia?.('(pointer: coarse)').matches) {
    const node = editor.getDomNode();
    let startY = 0;
    let startX = 0;

    node?.addEventListener(
      'touchstart',
      (event) => {
        const touch = event.touches[0];
        startX = touch?.clientX ?? 0;
        startY = touch?.clientY ?? 0;
      },
      { passive: true }
    );

    node?.addEventListener(
      'touchmove',
      (event) => {
        const touch = event.touches[0];
        if (!touch) {
          return;
        }
        const travelled = Math.hypot(touch.clientX - startX, touch.clientY - startY);
        const active = document.activeElement;
        if (travelled > 10 && active?.classList.contains('inputarea')) {
          active.blur();
        }
      },
      { passive: true }
    );
  }

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

  /*
   * The same treatment for cross-document search, and for the same reason: registered only on
   * the global handler it would work everywhere except the editor, which is where someone
   * writing actually is. Declared in both places, as the comment above requires.
   */
  if (onSearchKey) {
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyF, onSearchKey);
  }

  return editor;
};

export const setEditorTheme = (resolvedTheme) => {
  monaco.editor.setTheme(themeFor(resolvedTheme));
};

export { monaco };
