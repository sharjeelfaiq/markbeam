import '@fontsource/newsreader/400.css';
import '@fontsource/newsreader/600.css';
import '@fontsource/newsreader/400-italic.css';
import '@fontsource/commit-mono/400.css';
import '@fontsource/commit-mono/700.css';

import './styles/tokens.css';
import './styles/app.css';
import './styles/preview.css';

import { DEFAULT_DOCUMENT } from './defaultDocument.js';
import { createEditor, setEditorTheme } from './editor/index.js';
import { renderMarkdown } from './markdown/index.js';
import { loadEmoji } from './markdown/emoji.js';
import { hasMath, loadMath } from './markdown/math.js';
import { onMermaidRender, renderMermaidForTheme, scheduleMermaidRender } from './mermaid/index.js';
import { exportPreviewToPdf } from './export/pdf.js';
import { copyPreviewAsHtml } from './export/html.js';
import { getPreference, cyclePreference, initTheme, onThemeChange } from './theme.js';
import {
  migrateLegacyStorage,
  loadContent,
  loadDocTitle,
  loadMarkdownMode,
  loadScrollSync,
  saveContent,
  saveDocTitle,
  saveMarkdownMode,
  saveScrollSync
} from './storage.js';
import { initPalette, toggle as togglePalette } from './ui/palette.js';
import { getViewMode, initViewMode, onViewModeChange, setViewMode } from './ui/viewmode.js';
import { initDivider } from './ui/divider.js';
import { initStatusBar, markSaving, updateCounts, updateCursor } from './ui/statusbar.js';
import { toast, toastError } from './ui/toasts.js';

const CONFIRM_RESET = 'Replace the current document with the Markbeam welcome text?';
const CONFIRM_CLEAR = 'Clear the document? This cannot be undone.';
const PULSE_MS = 460;

const init = () => {
  // Must run before anything reads storage: recovers content saved by older builds
  // under the previous hashed-key scheme.
  migrateLegacyStorage();

  const resolvedTheme = initTheme();

  initStatusBar();
  // The palette is wired below, but `toggle` is a module-level export: passing it here is
  // safe because it no-ops until initPalette() has found the dialog.
  const editor = createEditor(resolvedTheme, { onPaletteKey: togglePalette });

  const outputElement = document.querySelector('#output');
  const previewPane = document.querySelector('#preview');
  const beam = document.querySelector('#split-divider');
  const titleInput = document.querySelector('#doc-title');

  let scrollSync = loadScrollSync();
  let markdownMode = loadMarkdownMode();
  let exporting = false;

  /*
   * Which pane is currently driving a synced scroll, or null.
   *
   * Syncing one pane scrolls the other, which fires that pane's own scroll handler, which
   * would scroll the first pane back — a loop that locks the UI if it escapes. The pane
   * that initiated a sync claims ownership so the echoed event is ignored, and releases it
   * on the next animation frame. That ordering is sound: scroll events are dispatched
   * during the rendering update *before* requestAnimationFrame callbacks run, so the echo
   * always arrives while the claim is still held.
   */
  let syncingFrom = null;
  let releaseScrollSync = () => {
    syncingFrom = null;
  };

  // ---------- render ----------

  let pulseTimer = null;
  let pulseBeam = () => {
    if (!beam) {
      return;
    }
    beam.dataset.pulse = 'true';
    clearTimeout(pulseTimer);
    // Clearing the flag is what allows the animation to restart on the next render.
    pulseTimer = setTimeout(() => delete beam.dataset.pulse, PULSE_MS);
  };

  let convert = (markdown) => {
    outputElement.innerHTML = renderMarkdown(markdown, markdownMode);
    scheduleMermaidRender();
    pulseBeam();
  };

  /*
   * The promise doubles as a version guard: several keystrokes can arrive while the
   * chunk is in flight, but only its first request gets to trigger the one catch-up
   * render. That render always reads the current editor value rather than the value that
   * originally caused the load.
   */
  let mathLoad = null;
  let ensureMath = (markdown) => {
    if (mathLoad || !hasMath(markdown)) {
      return;
    }
    mathLoad = loadMath().then((loaded) => {
      if (loaded) {
        convert(editor.getValue());
      }
    });
  };

  // ---------- document ----------

  let setValue = (value) => {
    editor.setValue(value);
    editor.revealPosition({ lineNumber: 1, column: 1 });
    editor.focus();
  };

  editor.onDidChangeModelContent(() => {
    const value = editor.getValue();
    convert(value);
    ensureMath(value);
    saveContent(value);
    updateCounts(value);
    markSaving();
  });

  editor.onDidChangeCursorPosition((event) => updateCursor(event.position));

  editor.onDidScrollChange((event) => {
    if (!scrollSync || !previewPane || syncingFrom === 'preview') {
      return;
    }

    // A document shorter than the viewport has nothing to scroll; without this the ratio
    // below would be a division by zero.
    const maxScrollTop = event.scrollHeight - editor.getLayoutInfo().height;
    if (maxScrollTop <= 0) {
      return;
    }

    const scrollRatio = event.scrollTop / maxScrollTop;
    const target = (previewPane.scrollHeight - previewPane.clientHeight) * scrollRatio;

    // The two panes are different heights, so a ratio never round-trips exactly. Ignoring
    // sub-pixel differences stops the panes nudging each other back and forth.
    if (Math.abs(previewPane.scrollTop - target) <= 1) {
      return;
    }

    syncingFrom = 'editor';
    previewPane.scrollTo(0, target);
    requestAnimationFrame(releaseScrollSync);
  });

  if (previewPane) {
    previewPane.addEventListener('scroll', () => {
      if (!scrollSync || syncingFrom === 'editor') {
        return;
      }

      const maxPreviewScroll = previewPane.scrollHeight - previewPane.clientHeight;
      const maxEditorScroll = editor.getScrollHeight() - editor.getLayoutInfo().height;
      if (maxPreviewScroll <= 0 || maxEditorScroll <= 0) {
        return;
      }

      const scrollRatio = previewPane.scrollTop / maxPreviewScroll;
      const target = maxEditorScroll * scrollRatio;

      if (Math.abs(editor.getScrollTop() - target) <= 1) {
        return;
      }

      syncingFrom = 'preview';
      editor.setScrollTop(target);
      requestAnimationFrame(releaseScrollSync);
    });
  }

  // ---------- title ----------

  let docTitle = loadDocTitle();
  if (titleInput) {
    titleInput.value = docTitle;

    titleInput.addEventListener('input', () => {
      docTitle = titleInput.value.trim() || 'Untitled';
      saveDocTitle(docTitle);
    });

    titleInput.addEventListener('blur', () => {
      titleInput.value = docTitle;
    });

    titleInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        titleInput.blur();
        editor.focus();
      }
    });
  }

  // ---------- actions ----------

  let copySource = async () => {
    try {
      await navigator.clipboard.writeText(editor.getValue());
      toast('Markdown copied to clipboard');
    } catch (error) {
      toastError('Could not copy — clipboard access was denied');
    }
  };

  /*
   * Copies the rendered preview with table styling written inline, because a paste target
   * never sees our stylesheet. The plain Copy above keeps copying Markdown source.
   */
  let copyHtml = async () => {
    try {
      await copyPreviewAsHtml(outputElement);
      toast('Rendered HTML copied to clipboard');
    } catch (error) {
      toastError('Could not copy — clipboard access was denied');
    }
  };

  let exportPdf = async () => {
    if (exporting) {
      return;
    }
    exporting = true;

    const button = document.querySelector('#export-button');
    const label = button ? button.querySelector('.toolbar__label') : null;
    const original = label ? label.textContent : '';
    if (button) {
      button.disabled = true;
    }

    try {
      const result = await exportPreviewToPdf({
        title: docTitle,
        onProgress: (page, total) => {
          if (label) {
            label.textContent = `${page}/${total}`;
          }
        }
      });
      toast(`Exported ${result.pages} page${result.pages === 1 ? '' : 's'}`);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Failed to export PDF', error);
      toastError('Could not generate the PDF');
    } finally {
      exporting = false;
      if (label) {
        label.textContent = original;
      }
      if (button) {
        button.disabled = false;
      }
    }
  };

  let resetDocument = () => {
    if (editor.getValue().trim() && !window.confirm(CONFIRM_RESET)) {
      return;
    }
    setValue(DEFAULT_DOCUMENT);
    toast('Reset to the welcome document');
  };

  let clearDocument = () => {
    if (editor.getValue().trim() && !window.confirm(CONFIRM_CLEAR)) {
      return;
    }
    setValue('');
    toast('Document cleared');
  };

  const syncButton = document.querySelector('#sync-button');

  /*
   * Sync scroll only means anything with both panes on screen, so outside split view the
   * button is dimmed and declines the click. The stored preference is left alone, so it
   * returns as it was. The palette command still toggles in any view — it is a settings
   * surface, whereas this button advertises availability.
   */
  let syncSyncButton = () => {
    if (!syncButton) {
      return;
    }

    const available = getViewMode() === 'split';
    syncButton.setAttribute('aria-pressed', String(scrollSync));
    syncButton.setAttribute('aria-disabled', String(!available));
    syncButton.title = available
      ? `Sync scroll ${scrollSync ? 'on' : 'off'}`
      : 'Sync scroll — available in Split view';
  };

  let toggleScrollSync = () => {
    scrollSync = !scrollSync;
    saveScrollSync(scrollSync);
    syncSyncButton();
    toast(scrollSync ? 'Sync scroll on' : 'Sync scroll off');
  };

  // ---------- Markdown mode ----------

  const markdownModeCommand = {
    title: '',
    run: () => {
      markdownMode = markdownMode === 'gfm' ? 'commonmark' : 'gfm';
      saveMarkdownMode(markdownMode);
      syncMarkdownModeCommand();
      convert(editor.getValue());
      toast(markdownMode === 'gfm' ? 'GitHub-Flavored Markdown mode' : 'CommonMark mode');
    }
  };

  function syncMarkdownModeCommand() {
    markdownModeCommand.title =
      markdownMode === 'gfm' ? 'Switch to CommonMark' : 'Switch to GitHub-Flavored Markdown';
  }

  syncMarkdownModeCommand();

  // ---------- theme ----------

  const themeButton = document.querySelector('#theme-button');

  let syncThemeButton = (resolved, preference) => {
    if (!themeButton) {
      return;
    }

    const label = preference === 'system' ? `Theme: system (${resolved})` : `Theme: ${preference}`;
    themeButton.setAttribute('aria-label', `${label} — click to change`);
    themeButton.title = label;

    const darkIcon = themeButton.querySelector('.icon-dark');
    const lightIcon = themeButton.querySelector('.icon-light');
    if (darkIcon && lightIcon) {
      darkIcon.style.display = resolved === 'dark' ? '' : 'none';
      lightIcon.style.display = resolved === 'dark' ? 'none' : '';
    }
  };

  onThemeChange((resolved, preference) => {
    setEditorTheme(resolved);
    renderMermaidForTheme(resolved);
    syncThemeButton(resolved, preference);
  });

  if (themeButton) {
    themeButton.addEventListener('click', () => {
      const next = cyclePreference();
      toast(next === 'system' ? 'Following system theme' : `${next} theme`);
    });
  }

  syncThemeButton(resolvedTheme, getPreference());

  // ---------- layout ----------

  initViewMode();
  initDivider();

  // Panes are sized in percentages, so a window resize needs no recalculation. Monaco
  // has automaticLayout, but relayout on a view change so it is not a frame behind CSS.
  onViewModeChange(() => {
    editor.layout();
    syncSyncButton();
  });

  // ---------- commands ----------

  /*
   * Single source of truth for both the palette and the global key handler, so a
   * shortcut can never exist in one and not the other.
   *
   * Deliberately no binding for copy: Ctrl/Cmd+C must keep copying the selection.
   */
  initPalette([
    { title: 'Export as PDF', keys: 'mod+s', run: exportPdf },
    { title: 'Editor only', keys: 'mod+1', run: () => setViewMode('editor') },
    { title: 'Split view', keys: 'mod+2', run: () => setViewMode('split') },
    { title: 'Preview only', keys: 'mod+3', run: () => setViewMode('preview') },
    { title: 'Copy Markdown source', run: copySource },
    { title: 'Copy rendered HTML', run: copyHtml },
    { title: 'Toggle sync scroll', run: toggleScrollSync },
    markdownModeCommand,
    { title: 'Reset to welcome document', run: resetDocument },
    { title: 'Clear document', run: clearDocument },
    { title: 'Switch theme', run: () => cyclePreference() }
  ]);

  document.querySelector('#copy-button')?.addEventListener('click', copySource);
  document.querySelector('#export-button')?.addEventListener('click', exportPdf);
  document.querySelector('#clear-button')?.addEventListener('click', clearDocument);

  syncButton?.addEventListener('click', () => {
    if (syncButton.getAttribute('aria-disabled') === 'true') {
      return;
    }
    toggleScrollSync();
  });
  syncSyncButton();

  // ---------- boot ----------

  onMermaidRender(pulseBeam);

  const saved = loadContent();
  setValue(saved || DEFAULT_DOCUMENT);
  ensureMath(editor.getValue());
  updateCounts(editor.getValue());
  updateCursor(editor.getPosition());

  /*
   * The emoji dataset is a separate chunk, so the document above renders before it lands.
   * Re-convert once it does — but only when the open document could actually contain a
   * shortcode, so the common case costs nothing and no needless Mermaid pass is triggered.
   */
  loadEmoji().then((loaded) => {
    const value = editor.getValue();
    if (loaded && /:[a-z0-9_+-]+:/.test(value)) {
      convert(value);
    }
  });
};

window.addEventListener('load', init);
