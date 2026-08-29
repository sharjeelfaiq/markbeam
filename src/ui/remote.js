/*
 * The GitHub sheet: connect, then pick a file.
 *
 * One dialog with two faces rather than two dialogs, because they are one errand — you only
 * ever connect in order to do something, and being bounced between two modals to finish a
 * single action reads as a mistake.
 *
 * Same `sheet` classes as the palette and the other sheets. Like them, this module owns no
 * application state: it collects what the user typed and hands it back, leaving `main.js` the
 * only place that knows what a repository or a document is.
 *
 * **It never stores the token and never reads it back.** The value goes straight to the
 * callback and the field is cleared, so the credential is not sitting in a DOM node for the
 * rest of the session — the same reason it is not persisted by default.
 */

let dialog;
let form;
let list;
let tokenInput;
let repoInput;
let rememberInput;
let intro;
let statusLine;

let handlers = {};
let mode = 'connect';

let show = (element, visible) => {
  if (element) {
    element.hidden = !visible;
  }
};

let renderConnect = (message) => {
  mode = 'connect';
  show(form, true);
  show(list, false);

  if (statusLine) {
    statusLine.textContent = message || '';
    show(statusLine, Boolean(message));
  }

  if (repoInput && !repoInput.value && handlers.getRepo) {
    repoInput.value = handlers.getRepo() || '';
  }
};

let renderFiles = (files) => {
  mode = 'files';
  show(form, false);
  show(list, true);

  if (!list) {
    return;
  }

  list.textContent = '';

  if (files.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'sheet__empty';
    empty.textContent = 'No Markdown files in that repository';
    list.appendChild(empty);
    return;
  }

  files.forEach((file) => {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sheet__item';

    const label = document.createElement('span');
    label.className = 'sheet__label';
    label.textContent = file.name;

    const hint = document.createElement('span');
    hint.className = 'sheet__hint';
    hint.textContent = 'Open';

    button.append(label, hint);
    button.addEventListener('click', () => {
      close();
      handlers.onPick?.(file);
    });

    item.appendChild(button);
    list.appendChild(item);
  });
};

export const openConnect = (message) => {
  if (!dialog) {
    return;
  }
  renderConnect(message);
  dialog.showModal();
  repoInput?.focus();
};

export const openFiles = (files) => {
  if (!dialog) {
    return;
  }
  renderFiles(files);
  if (!dialog.open) {
    dialog.showModal();
  }
};

export const close = () => {
  if (dialog && dialog.open) {
    dialog.close();
  }
};

export const initRemote = (options) => {
  dialog = document.querySelector('#remote');
  form = document.querySelector('#remote-form');
  list = document.querySelector('#remote-list');
  tokenInput = document.querySelector('#remote-token');
  repoInput = document.querySelector('#remote-repo');
  rememberInput = document.querySelector('#remote-remember');
  intro = document.querySelector('#remote-intro');
  statusLine = document.querySelector('#remote-status');

  if (!dialog || !form) {
    return;
  }

  handlers = options || {};

  form.addEventListener('submit', (event) => {
    event.preventDefault();

    const token = tokenInput ? tokenInput.value.trim() : '';
    const repo = repoInput ? repoInput.value.trim() : '';
    const remember = Boolean(rememberInput && rememberInput.checked);

    // Cleared immediately: the callback has it, and there is no reason for it to stay in a
    // form field where the next thing to read the DOM can find it.
    if (tokenInput) {
      tokenInput.value = '';
    }

    handlers.onConnect?.({ token, repo, remember });
  });

  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) {
      close();
    }
  });

  // Leaving the sheet must not leave the credential behind in the field either.
  dialog.addEventListener('close', () => {
    if (tokenInput) {
      tokenInput.value = '';
    }
  });

  show(list, false);
  show(intro, true);
};
