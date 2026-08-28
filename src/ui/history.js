import { formatStamp, wordCount } from './stamp.js';

/*
 * The history sheet.
 *
 * Its own dialog rather than a third list inside `#docs`: that sheet is about *which*
 * document is open, this one is about which version of it, and history routinely runs to
 * twenty rows. Styling is the palette's `sheet` classes verbatim, exactly as the documents
 * sheet does — this list is the same shape.
 *
 * Like `palette.js` and `documents.js`, this module owns no application state. It renders
 * what it is handed and reports intent through callbacks, so `main.js` remains the only
 * place that knows how a document is loaded or saved.
 */

let dialog;
let list;

let getEntries = () => [];
let getCurrentText = () => '';
let handlers = {};

let addRow = (label, hint, { current = false, onPick = null } = {}) => {
  const item = document.createElement('li');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'sheet__item';

  // aria-current rather than a class: the live version is a state, not a decoration.
  if (current) {
    button.setAttribute('aria-current', 'true');
  }

  const name = document.createElement('span');
  name.className = 'sheet__label';
  name.textContent = label;

  const stamp = document.createElement('span');
  stamp.className = 'sheet__hint';
  stamp.textContent = hint;

  button.append(name, stamp);

  if (onPick) {
    button.addEventListener('click', () => {
      close();
      onPick();
    });
  } else {
    button.disabled = true;
  }

  item.appendChild(button);
  list.appendChild(item);
};

let renderList = () => {
  if (!list) {
    return;
  }

  list.textContent = '';

  // The live document heads the list, so restoring is always a comparison rather than a
  // guess about what is currently on screen.
  addRow(`Current · ${wordCount(getCurrentText())} words`, 'now', { current: true });

  const entries = getEntries();
  if (entries.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'sheet__empty';
    empty.textContent = 'No earlier versions yet';
    list.appendChild(empty);
    return;
  }

  entries.forEach((entry, index) => {
    addRow(`${wordCount(entry.text)} words`, formatStamp(entry.at), {
      onPick: () => handlers.onRestore?.(entry, index)
    });
  });
};

export const refresh = renderList;

export const open = () => {
  if (!dialog) {
    return;
  }
  renderList();
  dialog.showModal();
};

export const close = () => {
  if (dialog && dialog.open) {
    dialog.close();
  }
};

export const toggle = () => (dialog && dialog.open ? close() : open());

export const initHistory = (options) => {
  dialog = document.querySelector('#history');
  list = document.querySelector('#history-list');

  if (!dialog) {
    return;
  }

  getEntries = options.getEntries || getEntries;
  getCurrentText = options.getCurrentText || getCurrentText;
  handlers = options;

  // Clicking the backdrop closes it, matching the palette and the documents sheet.
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) {
      close();
    }
  });
};
