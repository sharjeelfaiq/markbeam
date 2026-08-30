/*
 * The document sheet.
 *
 * Opened from the caret beside the title, because the switcher belongs with the thing that
 * names the document and the toolbar had no width to spare. Styling is the command
 * palette's `sheet` classes verbatim — this list is the same shape as that one.
 *
 * Like `palette.js`, this module owns no application state. It renders whatever it is
 * handed and reports intent back through callbacks, so `main.js` stays the only place that
 * knows how a document is loaded or saved.
 *
 * **Folders exist implicitly.** A folder is a string on a document, so one exists because a
 * document names it and disappears when the last document leaves. There is deliberately no
 * folder create, rename or delete: that absence is what keeps this a switcher rather than a
 * second file manager, and it means an orphaned folder is not a state that can occur.
 */

import { formatStamp } from './stamp.js';

let dialog;
let list;
let actions;

let getDocuments = () => [];
let getActiveId = () => null;
let getCollapsed = () => [];
let handlers = {};

/** Root documents first, then folders by name. Index order is preserved inside each group. */
let group = (documents) => {
  const root = [];
  const folders = new Map();

  documents.forEach((entry) => {
    if (!entry.folder) {
      root.push(entry);
      return;
    }
    if (!folders.has(entry.folder)) {
      folders.set(entry.folder, []);
    }
    folders.get(entry.folder).push(entry);
  });

  return {
    root,
    folders: [...folders.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  };
};

let documentRow = (entry, active) => {
  const item = document.createElement('li');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'sheet__item';
  button.dataset.docId = entry.id;

  // aria-current rather than a class: the active row is a state, not a decoration.
  if (entry.id === active) {
    button.setAttribute('aria-current', 'true');
  }
  if (entry.folder) {
    button.classList.add('sheet__item--nested');
  }

  const name = document.createElement('span');
  name.className = 'sheet__label';
  name.textContent = entry.title || 'Untitled';

  const stamp = document.createElement('span');
  stamp.className = 'sheet__hint';
  stamp.textContent = entry.id === active ? 'current' : formatStamp(entry.updatedAt);

  button.append(name, stamp);
  button.addEventListener('click', () => {
    close();
    if (entry.id !== active) {
      handlers.onSwitch?.(entry.id);
    }
  });

  item.appendChild(button);
  return item;
};

let folderRow = (name, entries, collapsed) => {
  const item = document.createElement('li');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'sheet__item sheet__item--folder';
  button.dataset.folder = name;
  button.setAttribute('aria-expanded', String(!collapsed));

  const label = document.createElement('span');
  label.className = 'sheet__label';
  // A triangle rather than an icon: the app ships no icon font of its own, and this row is
  // the only disclosure control in the UI.
  label.textContent = `${collapsed ? '▸' : '▾'} ${name}`;

  const count = document.createElement('span');
  count.className = 'sheet__hint';
  count.textContent = `${entries.length} ${entries.length === 1 ? 'doc' : 'docs'}`;

  button.append(label, count);
  button.addEventListener('click', () => handlers.onToggleFolder?.(name));

  item.appendChild(button);
  return item;
};

let renderList = () => {
  if (!list) {
    return;
  }

  list.textContent = '';
  const documents = getDocuments();
  const active = getActiveId();

  if (documents.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'sheet__empty';
    empty.textContent = 'No documents';
    list.appendChild(empty);
    return;
  }

  const { root, folders } = group(documents);
  const collapsed = new Set(getCollapsed());

  /*
   * The open document is never hidden. If it sits in a collapsed folder the folder is drawn
   * open regardless — a sheet with no "current" row in it reads as broken, and the one row
   * someone needs to see is the one they are already editing.
   */
  const activeFolder = documents.find((entry) => entry.id === active)?.folder;

  root.forEach((entry) => list.appendChild(documentRow(entry, active)));

  folders.forEach(([name, entries]) => {
    const isCollapsed = collapsed.has(name) && name !== activeFolder;
    list.appendChild(folderRow(name, entries, isCollapsed));

    if (!isCollapsed) {
      entries.forEach((entry) => list.appendChild(documentRow(entry, active)));
    }
  });
};

let renderActions = () => {
  if (!actions) {
    return;
  }

  actions.textContent = '';

  [
    { label: 'New document', run: () => handlers.onCreate?.() },
    { label: 'Open a file…', run: () => handlers.onOpenFile?.() },
    { label: 'Rename current', run: () => handlers.onRename?.() },
    { label: 'Move to folder…', run: () => handlers.onMove?.() },
    { label: 'Delete current', run: () => handlers.onDelete?.() }
  ].forEach((action) => {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sheet__item';
    button.textContent = action.label;
    button.addEventListener('click', () => {
      /*
       * Close first. Rename, Move and Delete all raise a native prompt/confirm, and a modal
       * <dialog> still on screen underneath swallows the focus return afterwards.
       */
      close();
      action.run();
    });
    item.appendChild(button);
    actions.appendChild(item);
  });
};

export const refresh = () => {
  renderList();
  renderActions();
};

export const open = () => {
  if (!dialog) {
    return;
  }
  refresh();
  dialog.showModal();
};

export const close = () => {
  if (dialog && dialog.open) {
    dialog.close();
  }
};

export const toggle = () => (dialog && dialog.open ? close() : open());

export const initDocuments = (options) => {
  dialog = document.querySelector('#docs');
  list = document.querySelector('#docs-list');
  actions = document.querySelector('#docs-actions');

  if (!dialog) {
    return;
  }

  getDocuments = options.getDocuments || getDocuments;
  getActiveId = options.getActiveId || getActiveId;
  getCollapsed = options.getCollapsed || getCollapsed;
  handlers = options;

  document.querySelector('#docs-button')?.addEventListener('click', toggle);

  // Clicking the backdrop closes it, matching the palette.
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) {
      close();
    }
  });

  refresh();
};
