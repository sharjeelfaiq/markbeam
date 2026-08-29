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
 */

import { formatStamp } from './stamp.js';

let dialog;
let list;
let actions;

let getDocuments = () => [];
let getActiveId = () => null;
let handlers = {};

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

  documents.forEach((entry) => {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sheet__item';
    button.dataset.docId = entry.id;

    // aria-current rather than a class: the active row is a state, not a decoration.
    if (entry.id === active) {
      button.setAttribute('aria-current', 'true');
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
    list.appendChild(item);
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
    { label: 'Delete current', run: () => handlers.onDelete?.() }
  ].forEach((action) => {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sheet__item';
    button.textContent = action.label;
    button.addEventListener('click', () => {
      /*
       * Close first. Rename and Delete both raise a native prompt/confirm, and a modal
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
