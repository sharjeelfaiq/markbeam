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
import {
  applyPrintDiagrams,
  onMermaidRender,
  renderMermaidForTheme,
  restoreScreenDiagrams,
  scheduleMermaidRender
} from './mermaid/index.js';
import { exportPreviewToPdf, filenameFromTitle } from './export/pdf.js';
import { buildStandaloneHtml, buildWordDocument } from './export/document.js';
import { downloadText } from './export/download.js';
import { copyPreviewAsHtml } from './export/html.js';
import { getPreference, cyclePreference, initPrintTheme, initTheme, onThemeChange } from './theme.js';
import {
  buildShareUrl,
  clearSharedFragment,
  decodeDocument,
  readSharedPayload,
  LONG_LINK
} from './share.js';
import {
  migrateLegacyStorage,
  migrateSingleDocument,
  loadContent,
  loadDocTitle,
  loadDocIndex,
  saveDocIndex,
  loadActiveDocId,
  saveActiveDocId,
  loadDoc,
  saveDoc,
  deleteDoc,
  newDocId,
  loadMarkdownMode,
  loadScrollSync,
  saveContent,
  saveDocTitle,
  saveMarkdownMode,
  saveScrollSync
} from './storage.js';
import { initPalette, toggle as togglePalette } from './ui/palette.js';
import { initDocuments, refresh as refreshDocuments } from './ui/documents.js';
import { initHistory, open as openHistorySheet } from './ui/history.js';
import { formatStamp } from './ui/stamp.js';
import { readMarkdownFile } from './openFile.js';
import {
  flushSnapshot,
  forgetHistory,
  historyFor,
  scheduleSnapshot,
  snapshot
} from './history.js';
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
  /*
   * Callbacks rather than a direct import inside `theme.js`: the mermaid module already
   * imports it, and this codebase passes functions across boundaries instead of cycling.
   */
  initPrintTheme({ onEnter: applyPrintDiagrams, onLeave: restoreScreenDiagrams });

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

  /*
   * Documents.
   *
   * `documents` mirrors the stored index and `activeDocId` names the open one. Content is
   * written per document; `saveContent` keeps writing the legacy single-document key too,
   * so an older build — or a rollback — still finds the document the user last had open.
   */
  let documents = [];
  let activeDocId = null;

  let touchActive = () => {
    const entry = documents.find((doc) => doc.id === activeDocId);
    if (entry) {
      entry.updatedAt = Date.now();
    }
  };

  let persistDocuments = () => saveDocIndex(documents);

  editor.onDidChangeModelContent(() => {
    const value = editor.getValue();
    convert(value);
    ensureMath(value);

    if (activeDocId) {
      saveDoc(activeDocId, value);
      touchActive();
      persistDocuments();
    }
    /*
     * Autosave history rides on the same event but on a much longer fuse — a pause in
     * editing, not a keystroke. The closure re-checks `activeDocId` when the timer fires:
     * `openDocument()` calls `setValue()`, which fires this very event, so a timer started
     * under one document could otherwise write its text into whichever document is open
     * twenty seconds later. That failure is silent, which is what makes it worth guarding
     * twice — here, and by cancelling in `flushActive()`.
     */
    if (activeDocId) {
      const scheduledFor = activeDocId;
      scheduleSnapshot(scheduledFor, () =>
        activeDocId === scheduledFor ? editor.getValue() : null
      );
    }

    // Kept in step so a downgrade still opens the document the user was last editing.
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

  let setDocTitle = (value) => {
    docTitle = value.trim() || 'Untitled';
    saveDocTitle(docTitle);

    if (titleInput) {
      titleInput.value = docTitle;
    }

    const entry = documents.find((doc) => doc.id === activeDocId);
    if (entry) {
      entry.title = docTitle;
      persistDocuments();
      refreshDocuments();
    }
  };

  if (titleInput) {
    titleInput.value = docTitle;

    titleInput.addEventListener('input', () => {
      // Deliberately not routed through setDocTitle: rewriting `titleInput.value` while
      // someone is typing in it would move the caret to the end on every keystroke.
      docTitle = titleInput.value.trim() || 'Untitled';
      saveDocTitle(docTitle);

      const entry = documents.find((doc) => doc.id === activeDocId);
      if (entry) {
        entry.title = docTitle;
        persistDocuments();
      }
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

  // ---------- documents ----------

  /*
   * Flush before leaving a document. Monaco's change event has already saved every
   * keystroke, but switching is the one moment where losing the last one would be
   * unrecoverable, so it costs nothing to be certain.
   */
  let flushActive = () => {
    if (!activeDocId) {
      return;
    }
    saveDoc(activeDocId, editor.getValue());
    touchActive();
    persistDocuments();

    // Leaving is the last chance to record this document, and the pending timer must not
    // survive into the next one.
    flushSnapshot(activeDocId, editor.getValue());
  };

  let openDocument = (id) => {
    const entry = documents.find((doc) => doc.id === id);
    if (!entry) {
      return;
    }

    activeDocId = id;
    saveActiveDocId(id);
    setValue(loadDoc(id));

    docTitle = entry.title || 'Untitled';
    saveDocTitle(docTitle);
    if (titleInput) {
      titleInput.value = docTitle;
    }

    ensureMath(editor.getValue());
    updateCounts(editor.getValue());
    refreshDocuments();
  };

  let switchDocument = (id) => {
    if (id === activeDocId) {
      return;
    }
    flushActive();
    openDocument(id);
    toast(`Switched to ${documents.find((doc) => doc.id === id)?.title || 'document'}`);
  };

  let createDocument = ({ silent = false } = {}) => {
    flushActive();

    const id = newDocId();
    documents.unshift({ id, title: 'Untitled', updatedAt: Date.now() });
    saveDoc(id, '');
    persistDocuments();
    openDocument(id);

    if (!silent) {
      toast('New document');
    }
    return id;
  };

  let renameDocument = () => {
    const entry = documents.find((doc) => doc.id === activeDocId);
    const next = window.prompt('Rename document', entry ? entry.title : docTitle);
    if (next === null) {
      return;
    }

    setDocTitle(next);
    toast(`Renamed to ${docTitle}`);
  };

  let deleteDocument = () => {
    if (!activeDocId) {
      return;
    }

    const entry = documents.find((doc) => doc.id === activeDocId);
    if (!window.confirm(`Delete "${entry ? entry.title : docTitle}"? This cannot be undone.`)) {
      return;
    }

    deleteDoc(activeDocId);
    forgetHistory(activeDocId);
    documents = documents.filter((doc) => doc.id !== activeDocId);
    persistDocuments();

    /*
     * Never leave the app with nothing open. Deleting the last document hands back a fresh
     * empty one rather than an editor bound to no document, which would silently drop
     * anything typed next.
     */
    if (documents.length === 0) {
      activeDocId = null;
      createDocument({ silent: true });
      toast('Document deleted');
      return;
    }

    openDocument(documents[0].id);
    toast('Document deleted');
  };

  /*
   * Restore takes a snapshot of the present *first*. Without that, restoring the wrong
   * entry destroys the version the user was actually working on, and the feature meant to
   * protect against a misclick becomes a way to lose work to one.
   */
  let restoreSnapshot = (entry) => {
    if (!entry || typeof entry.text !== 'string') {
      return;
    }

    snapshot(activeDocId, editor.getValue());
    setValue(entry.text);

    if (activeDocId) {
      saveDoc(activeDocId, entry.text);
      touchActive();
      persistDocuments();
    }

    toast(`Restored the version from ${formatStamp(entry.at)}`);
  };

  let openHistory = () => openHistorySheet();

  /*
   * A closing tab is the case history exists for and the one the idle timer cannot cover.
   * `pagehide` and a hidden `visibilitychange`, not `beforeunload`: that event is unreliable
   * on mobile Safari, which is exactly where a tab disappears without warning.
   */
  let snapshotOnLeave = () => {
    if (activeDocId) {
      flushSnapshot(activeDocId, editor.getValue());
    }
  };

  window.addEventListener('pagehide', snapshotOnLeave);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      snapshotOnLeave();
    }
  });

  /*
   * Opening files.
   *
   * Each file becomes its own document through `createDocument()`, which already flushes and
   * snapshots the outgoing one — so nothing here has to protect the document that was open.
   * The last file opened is the one left on screen, which falls out of that rather than being
   * a rule.
   */
  let openFiles = async (fileList) => {
    const files = Array.from(fileList || []);
    if (files.length === 0) {
      return;
    }

    let opened = 0;
    for (const file of files) {
      const result = await readMarkdownFile(file);

      if (!result.ok) {
        toastError(result.reason);
        continue;
      }

      createDocument({ silent: true });
      setValue(result.text);
      setDocTitle(result.title);
      opened += 1;
    }

    if (opened === 1) {
      toast(`Opened ${docTitle}`);
    } else if (opened > 1) {
      toast(`Opened ${opened} documents`);
    }
  };

  const fileInput = document.querySelector('#file-input');

  let openFilePicker = () => fileInput?.click();

  if (fileInput) {
    fileInput.addEventListener('change', () => {
      openFiles(fileInput.files);
      // Cleared so choosing the same file twice in a row still fires `change`.
      fileInput.value = '';
    });
  }

  /*
   * Drag and drop, on the document so anywhere on the page accepts a file.
   *
   * `preventDefault` only when files are actually involved: Monaco has its own drag-and-drop
   * for moving text inside the editor, and swallowing every dragover would break it.
   */
  let carriesFiles = (event) =>
    Array.from(event.dataTransfer?.types || []).includes('Files');

  document.addEventListener('dragover', (event) => {
    if (carriesFiles(event)) {
      event.preventDefault();
    }
  });

  document.addEventListener('drop', (event) => {
    const files = event.dataTransfer?.files;
    if (!files || files.length === 0) {
      return;
    }
    event.preventDefault();
    openFiles(files);
  });

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

  /*
   * File exports. All three share `filenameFromTitle`, so one document produces one
   * basename across every format.
   *
   * The Word file is `.doc` — HTML with Word's MIME type — not `.docx`. Real OOXML would
   * cost a 4.65 MB dependency and hand-mapping the markdown AST, losing Mermaid and KaTeX
   * on the way. The label says `.doc` so the name never overstates what the file is.
   */
  /*
   * A share link carries the whole document in the fragment, so it works from any host and
   * never reaches a server. Long documents make long links — browsers cope, but chat and
   * mail clients start mangling well before that, so say so rather than hand over a link
   * that will arrive broken.
   */
  let copyShareLink = async () => {
    try {
      const url = await buildShareUrl({ title: docTitle, text: editor.getValue() });
      await navigator.clipboard.writeText(url);
      toast(
        url.length > LONG_LINK
          ? `Share link copied — ${url.length} characters, which some chat apps will truncate`
          : 'Share link copied to clipboard'
      );
    } catch (error) {
      toastError('Could not create a share link');
    }
  };

  let exportMarkdown = () => {
    downloadText(filenameFromTitle(docTitle, 'md'), editor.getValue(), 'text/markdown;charset=utf-8');
    toast('Markdown downloaded');
  };

  // Async because both re-render Mermaid light first, so a diagram exported from dark
  // mode does not arrive as black boxes on a white page.
  let exportHtml = async () => {
    downloadText(
      filenameFromTitle(docTitle, 'html'),
      await buildStandaloneHtml(outputElement, docTitle),
      'text/html;charset=utf-8'
    );
    toast('HTML downloaded');
  };

  let exportWord = async () => {
    downloadText(
      filenameFromTitle(docTitle, 'doc'),
      await buildWordDocument(outputElement, docTitle),
      'application/msword'
    );
    toast('Word document downloaded');
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
    // Snapshot before destroying, not after — this is the moment history exists for.
    snapshot(activeDocId, editor.getValue());
    setValue(DEFAULT_DOCUMENT);
    toast('Reset to the welcome document');
  };

  let clearDocument = () => {
    if (editor.getValue().trim() && !window.confirm(CONFIRM_CLEAR)) {
      return;
    }
    snapshot(activeDocId, editor.getValue());
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
    { title: 'Export as HTML', run: exportHtml },
    { title: 'Export as Word (.doc)', run: exportWord },
    { title: 'Export as Markdown', run: exportMarkdown },
    { title: 'Editor only', keys: 'mod+1', run: () => setViewMode('editor') },
    { title: 'Split view', keys: 'mod+2', run: () => setViewMode('split') },
    { title: 'Preview only', keys: 'mod+3', run: () => setViewMode('preview') },
    { title: 'Copy Markdown source', run: copySource },
    { title: 'Copy rendered HTML', run: copyHtml },
    { title: 'Copy share link', run: copyShareLink },
    { title: 'Toggle sync scroll', run: toggleScrollSync },
    markdownModeCommand,
    { title: 'Open a Markdown file…', run: openFilePicker },
    { title: 'Document history', run: openHistory },
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

  /*
   * Adopt the pre-multi-document profile, then open whichever document was last active.
   * `migrateSingleDocument` is a no-op once an index exists, so this is safe on every load.
   */
  migrateSingleDocument();
  documents = loadDocIndex() || [];

  initHistory({
    getEntries: () => historyFor(activeDocId),
    getCurrentText: () => editor.getValue(),
    onRestore: restoreSnapshot
  });

  initDocuments({
    getDocuments: () => documents,
    getActiveId: () => activeDocId,
    onSwitch: switchDocument,
    onCreate: createDocument,
    onOpenFile: openFilePicker,
    onRename: renameDocument,
    onDelete: deleteDocument
  });

  const storedActive = loadActiveDocId();
  const startId = documents.some((doc) => doc.id === storedActive)
    ? storedActive
    : documents[0]?.id;

  if (startId) {
    openDocument(startId);
    // A brand-new profile has an empty document; give it the welcome text as before.
    if (!editor.getValue()) {
      setValue(DEFAULT_DOCUMENT);
    }
  } else {
    createDocument({ silent: true });
    setValue(DEFAULT_DOCUMENT);
  }

  /*
   * A shared link imports rather than replaces. People keep several documents now, so a
   * link that overwrote the open one would be a data-loss path — and the fragment is
   * cleared afterwards, or every reload would import the same document again.
   *
   * `init` is not async, so this hangs off a promise the same way the emoji chunk does.
   * The imported text still goes through `renderMarkdown`, and therefore DOMPurify, exactly
   * like anything typed by hand.
   */
  let importSharedDocument = (payload) =>
    decodeDocument(payload).then((shared) => {
      clearSharedFragment();

      if (!shared) {
        toastError('That share link could not be read');
        return;
      }

      createDocument({ silent: true });
      setDocTitle(shared.title);
      setValue(shared.text);
      toast(`Imported "${docTitle}" from a share link`);
    });

  const sharedPayload = readSharedPayload();
  if (sharedPayload) {
    importSharedDocument(sharedPayload);
  }

  /*
   * Pasting a link into a tab that already has Markbeam open changes only the fragment,
   * which is a same-document navigation: no reload, no second `init`. Without this the
   * link would appear to do nothing at all, which is exactly how the first version behaved.
   */
  window.addEventListener('hashchange', () => {
    const payload = readSharedPayload();
    if (payload) {
      importSharedDocument(payload);
    }
  });

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
