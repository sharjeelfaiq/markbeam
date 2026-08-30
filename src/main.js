import '@fontsource/newsreader/400.css';
import '@fontsource/newsreader/600.css';
import '@fontsource/newsreader/400-italic.css';
import '@fontsource/commit-mono/400.css';
import '@fontsource/commit-mono/700.css';

import './styles/tokens.css';
import './styles/app.css';
import './styles/preview.css';

import { DEFAULT_DOCUMENT } from './defaultDocument.js';
import { createEditor, setEditorTheme, monaco } from './editor/index.js';
import { createFormatting } from './editor/format.js';
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
  loadCollapsedFolders,
  saveCollapsedFolders,
  loadDoc,
  saveDoc,
  deleteDoc,
  newDocId,
  loadMarkdownMode,
  loadScrollSync,
  canPersistContent,
  saveContent,
  saveDocTitle,
  saveMarkdownMode,
  saveScrollSync
} from './storage.js';
import { initPalette, isMac, toggle as togglePalette } from './ui/palette.js';
import { initDocuments, refresh as refreshDocuments } from './ui/documents.js';
import { initHistory, open as openHistorySheet } from './ui/history.js';
import { initOutline, open as openOutlineSheet } from './ui/outline.js';
// Aliased: main.js already has an openFiles() for the local file picker, and inside init()
// that declaration shadows the import — the GitHub listing was being handed to the Markdown
// file reader as if its entries were File objects.
import { initRemote, openConnect, openFiles as openRemoteFiles } from './ui/remote.js';
import { initSearch, open as openSearchSheet } from './ui/search.js';
import { listMarkdown, parseRepo, readFile, writeFile } from './github.js';
import {
  connect as connectGithub,
  disconnect as disconnectGithub,
  getRepo as getGithubRepo,
  getToken as getGithubToken,
  isConnected as githubConnected
} from './githubAuth.js';
import { initFormatToolbar } from './ui/formatToolbar.js';
import { formatStamp } from './ui/stamp.js';
import { readMarkdownFile, titleFromFilename } from './openFile.js';
import { documentBytes, MAX_DOCUMENT_BYTES } from './documentLimits.js';
import { classifyImageFile, optimizeImage } from './images.js';
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
  const editor = createEditor(resolvedTheme, {
    onPaletteKey: togglePalette,
    onSearchKey: () => openSearchSheet()
  });

  /*
   * Formatting binds inside Monaco as well as in the palette below, and both are required.
   * Ctrl+I never reaches the document listener — Monaco swallows it — and Ctrl+Shift+K is
   * Monaco's Delete Line, which would destroy the line rather than link it. Registering on the
   * editor shadows both, the same way the palette's own Ctrl+K does.
   */
  const formatting = createFormatting(editor, monaco);

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

  /*
   * Folders.
   *
   * A folder is a string on a document — nothing more. It exists because a document names it
   * and vanishes when the last one leaves, which is why there is no folder create, rename or
   * delete to write. Collapse state is the only folder-specific thing worth persisting.
   */
  let collapsedFolders = loadCollapsedFolders();

  let folderNames = () =>
    [...new Set(documents.map((doc) => doc.folder).filter(Boolean))].sort((a, b) =>
      a.localeCompare(b)
    );

  let persistCollapsed = () => saveCollapsedFolders(collapsedFolders, folderNames());

  let toggleFolder = (name) => {
    collapsedFolders = collapsedFolders.includes(name)
      ? collapsedFolders.filter((entry) => entry !== name)
      : [...collapsedFolders, name];
    persistCollapsed();
    refreshDocuments();
  };

  /*
   * `window.prompt` to match Rename, which is the neighbouring action and already works this
   * way. The existing folder names go in the message: without them, reusing a folder means
   * recalling its exact spelling, and one typo silently creates a near-duplicate.
   */
  let moveToFolder = () => {
    const entry = documents.find((doc) => doc.id === activeDocId);
    if (!entry) {
      return;
    }

    const existing = folderNames();
    const message = existing.length
      ? `Move "${entry.title || 'Untitled'}" to which folder?\n\nExisting: ${existing.join(', ')}\nLeave empty for no folder.`
      : `Move "${entry.title || 'Untitled'}" to which folder?\n\nLeave empty for no folder.`;

    const answer = window.prompt(message, entry.folder || '');
    if (answer === null) {
      return;
    }

    const folder = answer.trim();
    entry.folder = folder || undefined;
    persistDocuments();
    // A folder that just lost its last document should not linger in the collapsed list.
    persistCollapsed();
    refreshDocuments();

    toast(folder ? `Moved to ${folder}` : 'Moved out of its folder');
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

  /*
   * Image insertion.
   *
   * Every file is prepared before the model changes. This keeps a multi-image batch all or
   * nothing, and the one `executeEdits` call below makes the whole insertion one undo step.
   * A document switch during asynchronous canvas work cancels the insertion rather than
   * placing an image into a document that did not receive the paste/drop event.
   */
  let insertImages = async (fileList) => {
    const files = Array.from(fileList || []);
    if (files.length === 0) {
      return;
    }
    const startedIn = activeDocId;
    const prepared = [];

    try {
      for (const file of files) {
        prepared.push(await optimizeImage(file));
      }
    } catch (error) {
      toastError(error.message || 'Could not process that image');
      return;
    }

    if (activeDocId !== startedIn) {
      toastError('Image insertion was cancelled because the active document changed');
      return;
    }

    const model = editor.getModel();
    const selection = editor.getSelection();
    if (!model || !selection) {
      toastError('Could not find an editor selection for the image');
      return;
    }

    const insertion = prepared.map((image) => image.markdown).join('\n\n');
    const startOffset = model.getOffsetAt(selection.getStartPosition());
    const endOffset = model.getOffsetAt(selection.getEndPosition());
    const current = model.getValue();
    const next = current.slice(0, startOffset) + insertion + current.slice(endOffset);

    if (documentBytes(next) > MAX_DOCUMENT_BYTES) {
      toastError('Those images would make this document larger than the 1 MiB browser limit');
      return;
    }

    if (!canPersistContent(next)) {
      toastError('There is not enough browser storage space to insert those images');
      return;
    }

    editor.pushUndoStop();
    editor.executeEdits('markbeam-local-images', [
      { range: selection, text: insertion, forceMoveMarkers: true }
    ]);
    editor.pushUndoStop();

    const end = model.getPositionAt(startOffset + insertion.length);
    editor.setSelection(monaco.Selection.fromPositions(end));
    editor.revealPositionInCenterIfOutsideViewport(end);
    editor.focus();

    toast(`Inserted ${prepared.length === 1 ? 'image' : `${prepared.length} images`}`);
  };

  let imageClassifications = (files) =>
    files.map((file) => ({ file, ...classifyImageFile(file) }));

  let refuseImageBatch = (classified, source) => {
    const includesOther = classified.some((entry) => entry.kind === 'other');
    if (includesOther) {
      toastError(
        `${source === 'drop' ? 'Drop' : 'Paste'} images separately from Markdown documents or other files`
      );
      return true;
    }

    const unsupported = classified.find((entry) => entry.kind === 'unsupported-image');
    if (unsupported) {
      toastError(unsupported.reason);
      return true;
    }

    return false;
  };

  const fileInput = document.querySelector('#file-input');
  const imageInput = document.querySelector('#image-input');

  let openFilePicker = () => fileInput?.click();
  let openImagePicker = () => imageInput?.click();

  if (fileInput) {
    fileInput.addEventListener('change', () => {
      openFiles(fileInput.files);
      // Cleared so choosing the same file twice in a row still fires `change`.
      fileInput.value = '';
    });
  }

  if (imageInput) {
    imageInput.addEventListener('change', async () => {
      try {
        await insertImages(imageInput.files);
      } finally {
        // Choosing the same image twice must still dispatch a fresh change event.
        imageInput.value = '';
        editor.focus();
      }
    });
  }

  initFormatToolbar({ editor, formatting, onInsertImage: openImagePicker });

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
    const files = Array.from(event.dataTransfer?.files || []);
    if (files.length === 0) {
      return;
    }
    event.preventDefault();

    const classified = imageClassifications(files);
    const includesImage = classified.some((entry) => entry.kind !== 'other');
    if (!includesImage) {
      openFiles(files);
      return;
    }

    if (!refuseImageBatch(classified, 'drop')) {
      insertImages(files);
    }
  });

  document.addEventListener('paste', (event) => {
    if (!editor.hasTextFocus()) {
      return;
    }

    const files = Array.from(event.clipboardData?.files || []);
    if (files.length === 0) {
      return;
    }

    const classified = imageClassifications(files);
    if (!classified.some((entry) => entry.kind !== 'other')) {
      return;
    }

    event.preventDefault();
    if (!refuseImageBatch(classified, 'paste')) {
      insertImages(files);
    }
  }, { capture: true });

  /*
   * The outline.
   *
   * Headings are read from the rendered preview rather than from the Markdown source, so
   * anything the parser decided is a heading is what appears — no second, subtly different
   * parse to keep in step. They carry no ids, so a row is identified by its index in that
   * list and the pick re-queries at the same index.
   */
  let collectHeadings = () =>
    Array.from(outputElement?.querySelectorAll('h1, h2, h3, h4, h5, h6') || []).map(
      (heading, index) => ({
        index,
        level: Number(heading.tagName.slice(1)),
        text: heading.textContent.trim() || `Untitled ${heading.tagName}`
      })
    );

  let scrollPreviewToHeading = (index) => {
    const heading = collectHeadingElements()[index];
    if (heading) {
      revealInPreview(heading);
    }
  };

  /*
   * Bring something in the preview into view, by scrolling the pane.
   *
   * The pane is the scroll container; `#preview-wrapper` does not scroll. Measured from
   * bounding rects rather than `offsetTop`, because the target's `offsetParent` is not the
   * pane — `offsetTop` would be relative to the wrong box. A small margin keeps it clear of
   * the pane's top edge.
   *
   * In Editor-only view the pane is `display: none`, so scrolling it does nothing. Reveal it
   * first: jumping to something you cannot see is not a jump.
   */
  let revealInPreview = (target) => {
    if (getViewMode() === 'editor') {
      setViewMode('split');
    }

    const pane = document.querySelector('.pane--preview');
    if (!pane || !target) {
      return;
    }

    const top = target.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop;
    pane.scrollTo({ top: Math.max(0, top - 12), behavior: 'smooth' });
  };

  /*
   * Links into the document scroll the pane, never the page.
   *
   * Left alone, `<a href="#footnote-ref-1">` is fragment navigation, and the browser scrolls
   * *every* scrollable ancestor to reveal the target — including the document root. That
   * takes the toolbar off screen and leaves a band of empty space at the bottom, because the
   * shell is a fixed-height grid. `body { height: 100dvh; overflow: hidden }` does not prevent
   * it: overflow:hidden suppresses scrollbars and user scrolling, not programmatic or
   * fragment scrolling.
   *
   * Not updating `location.hash` is deliberate beyond avoiding the scroll — the fragment is
   * where share links live (`src/share.js`), so leaving `#footnote-ref-1` in the URL puts
   * unrelated content in the one place the app treats as a document payload.
   */
  let handleInDocumentLink = (event) => {
    const link = event.target.closest?.('a[href^="#"]');
    if (!link || !outputElement?.contains(link)) {
      return;
    }

    const id = decodeURIComponent(link.getAttribute('href').slice(1));
    if (!id) {
      return;
    }

    // Scoped to the preview: a link to an id elsewhere in the app is not ours to act on.
    const target = outputElement.querySelector(`[id="${CSS.escape(id)}"]`);
    if (!target) {
      return;
    }

    event.preventDefault();
    revealInPreview(target);
  };

  outputElement?.addEventListener('click', handleInDocumentLink);

  let collectHeadingElements = () =>
    Array.from(outputElement?.querySelectorAll('h1, h2, h3, h4, h5, h6') || []);

  let openOutline = () => openOutlineSheet();

  /*
   * GitHub sync.
   *
   * Manual on purpose: two commands, no background traffic. Every request happens because
   * somebody just asked for one, which is what makes the claim on /about — nothing leaves
   * your browser unless you connect a repository — something a person can actually check by
   * watching the network panel.
   *
   * `pending` is what the user wanted before being asked to connect, so that connecting
   * finishes the errand instead of dropping them back where they started.
   */
  let pending = null;

  let githubTarget = () => parseRepo(getGithubRepo());

  let requireConnection = (intent, message) => {
    if (githubConnected() && githubTarget()) {
      return true;
    }
    pending = intent;
    openConnect(message);
    return false;
  };

  /*
   * A 401 means the token is worthless, so it is dropped rather than left looking connected.
   * Anything else may well be transient — a rate limit, a network blip — and the credential
   * is still good, so it stays.
   */
  let handleFailure = (result) => {
    if (result.status === 401) {
      disconnectGithub();
      openConnect(result.reason);
      return;
    }
    toastError(result.reason || 'GitHub request failed');
  };

  /** `My notes.md` from the document title, since that is what the user will look for. */
  let remoteFilename = () => `${filenameFromTitle(docTitle, 'md')}`;

  let saveToGithub = async () => {
    if (!requireConnection('save', null)) {
      return;
    }

    const path = remoteFilename();
    toast(`Saving ${path} to GitHub…`);

    const result = await writeFile(
      getGithubToken(),
      githubTarget(),
      path,
      editor.getValue(),
      `Update ${path} from Markbeam`
    );

    if (!result.ok) {
      handleFailure(result);
      return;
    }

    toast(`Saved ${path} to GitHub`);
  };

  let openFromGithub = async () => {
    if (!requireConnection('open', null)) {
      return;
    }

    const result = await listMarkdown(getGithubToken(), githubTarget());
    if (!result.ok) {
      handleFailure(result);
      return;
    }

    openRemoteFiles(result.files);
  };

  /*
   * Pulled files become new documents, never a replacement for the open one — the same rule
   * share links follow. A remote fetch that silently overwrites local work is a data-loss
   * path, and the remote copy is not automatically the newer one.
   */
  let importFromGithub = async (fileEntry) => {
    const result = await readFile(getGithubToken(), githubTarget(), fileEntry.path);
    if (!result.ok) {
      handleFailure(result);
      return;
    }

    if (documentBytes(result.text) > MAX_DOCUMENT_BYTES) {
      toastError(`“${fileEntry.name}” is too large to store in the browser`);
      return;
    }

    createDocument({ silent: true });
    setValue(result.text);
    setDocTitle(titleFromFilename(fileEntry.name));
    toast(`Opened ${fileEntry.name} from GitHub`);
  };

  let onGithubConnect = ({ token, repo, remember }) => {
    const target = parseRepo(repo);
    if (!target) {
      openConnect('That does not look like owner/repository');
      return;
    }
    if (!token) {
      openConnect('A token is needed to reach GitHub');
      return;
    }

    connectGithub(token, `${target.owner}/${target.repo}`, { remember });

    const intent = pending;
    pending = null;
    if (intent === 'save') {
      saveToGithub();
    } else if (intent === 'open') {
      openFromGithub();
    }
  };

  let disconnectFromGithub = () => {
    disconnectGithub();
    toast('Disconnected from GitHub');
  };

  /*
   * Find, replace, and search across documents.
   *
   * Monaco's find widget already worked; nothing advertised it. These two commands are pure
   * discoverability — they trigger Monaco's own actions rather than reimplementing anything,
   * and they carry `hint` rather than `keys` so the palette shows the shortcut **without**
   * binding it. Binding Ctrl+F globally would take it from the preview pane, where the
   * browser's own find is the right behaviour.
   *
   * The editor has to be focused first: the palette closes before running a command, and
   * Monaco will not show the widget for an editor that does not have focus.
   */
  let runEditorAction = (action) => {
    editor.focus();
    editor.getAction(action)?.run();
  };

  let findInDocument = () => runEditorAction('actions.find');
  let findAndReplace = () => runEditorAction('editor.action.startFindReplaceAction');

  /*
   * The corpus for a cross-document search. The open document is read from the editor rather
   * than from storage: the two agree today, because `saveDoc` runs on every keystroke, but a
   * search that silently depends on that would start lying the moment saving is debounced.
   */
  let searchCorpus = () =>
    documents.map((entry) => ({
      id: entry.id,
      title: entry.title || 'Untitled',
      text: entry.id === activeDocId ? editor.getValue() : loadDoc(entry.id)
    }));

  let openSearch = () => openSearchSheet();

  /*
   * Arriving *at* the hit, not merely at the document. `openDocument` calls `setValue`, which
   * puts the cursor back at the start, so the selection has to be applied afterwards.
   */
  let goToHit = (hit) => {
    if (!hit) {
      return;
    }

    if (hit.id !== activeDocId) {
      openDocument(hit.id);
    }

    editor.setSelection({
      startLineNumber: hit.line,
      startColumn: hit.column,
      endLineNumber: hit.line,
      endColumn: hit.column + hit.length
    });
    editor.revealLineInCenter(hit.line);
    editor.focus();
  };

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
    { title: 'Bold', keys: 'mod+b', run: formatting.bold },
    { title: 'Italic', keys: 'mod+i', run: formatting.italic },
    { title: 'Strikethrough', run: formatting.strike },
    { title: 'Inline code', keys: 'mod+e', run: formatting.code },
    { title: 'Link', keys: 'mod+shift+k', run: formatting.link },
    { title: 'Heading 1', keys: 'mod+shift+h', run: formatting.heading },
    { title: 'Heading 2', run: () => formatting.setHeading(2) },
    { title: 'Heading 3', run: () => formatting.setHeading(3) },
    { title: 'Paragraph', run: formatting.paragraph },
    { title: 'Bullet list', keys: 'mod+shift+l', run: formatting.list },
    { title: 'Ordered list', run: formatting.orderedList },
    { title: 'Task list', run: formatting.taskList },
    { title: 'Blockquote', run: formatting.blockquote },
    { title: 'Fenced code block', run: formatting.codeBlock },
    { title: 'Insert table', run: formatting.table },
    { title: 'Insert local image…', run: openImagePicker },
    { title: 'Open a Markdown file…', run: openFilePicker },
    {
      title: 'Find in document',
      // A hint, never a binding — see runEditorAction above.
      hint: isMac() ? '⌘F' : 'Ctrl+F',
      run: findInDocument
    },
    {
      title: 'Find and replace',
      // Monaco's own replace binding differs by platform, so the label has to as well.
      hint: isMac() ? '⌥⌘F' : 'Ctrl+H',
      run: findAndReplace
    },
    { title: 'Search all documents', keys: 'mod+shift+f', run: openSearch },
    { title: 'Document outline', run: openOutline },
    { title: 'Save to GitHub…', run: saveToGithub },
    { title: 'Open from GitHub…', run: openFromGithub },
    { title: 'Disconnect GitHub', run: disconnectFromGithub },
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

  /*
   * The service worker, registered after `load` so it never competes with first paint, and
   * guarded because `navigator.serviceWorker` is absent in Firefox private windows and
   * anywhere the page is not a secure context.
   */
  if ('serviceWorker' in navigator) {
    const register = () => {
      navigator.serviceWorker.register('/sw.js').catch((error) => {
        // Offline support is a bonus; losing it must never take the app down with it.
        // eslint-disable-next-line no-console
        console.warn('Offline support unavailable', error);
      });
    };

    /*
     * `readyState` is checked rather than trusting the `load` event on its own. This module
     * runs after awaiting Monaco from the CDN, so by the time it gets here `load` has usually
     * already fired — and a listener added afterwards is never called. Registration silently
     * never happened, which looked exactly like a broken service worker.
     */
    if (document.readyState === 'complete') {
      register();
    } else {
      window.addEventListener('load', register);
    }
  }

  // ---------- boot ----------

  onMermaidRender(pulseBeam);

  /*
   * Adopt the pre-multi-document profile, then open whichever document was last active.
   * `migrateSingleDocument` is a no-op once an index exists, so this is safe on every load.
   */
  migrateSingleDocument();
  documents = loadDocIndex() || [];

  initSearch({
    getDocuments: searchCorpus,
    onPick: goToHit
  });

  initRemote({
    getRepo: getGithubRepo,
    onConnect: onGithubConnect,
    onPick: importFromGithub
  });

  initOutline({
    getHeadings: collectHeadings,
    onPick: scrollPreviewToHeading
  });

  initHistory({
    getEntries: () => historyFor(activeDocId),
    getCurrentText: () => editor.getValue(),
    onRestore: restoreSnapshot
  });

  initDocuments({
    getDocuments: () => documents,
    getActiveId: () => activeDocId,
    getCollapsed: () => collapsedFolders,
    onToggleFolder: toggleFolder,
    onMove: moveToFolder,
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
