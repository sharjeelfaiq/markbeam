/*
 * The Gist sheet.
 *
 * Same `sheet` classes as the rest, and the same contract: no application state, no knowledge
 * of tokens. It collects a description and a visibility, and hands them back.
 *
 * **Secret is checked by default and the label says what public means.** The two options are
 * not symmetric — publishing something publicly by accident cannot be undone by deleting it
 * afterwards, because it was already readable — so the safer one is the one already selected.
 */

let dialog;
let form;
let description;
let secret;
let status;
let handlers = {};

let setStatus = (message) => {
  if (!status) {
    return;
  }
  status.textContent = message || '';
  status.hidden = !message;
};

export const open = (suggestedDescription) => {
  if (!dialog) {
    return;
  }
  if (description) {
    description.value = suggestedDescription || '';
  }
  if (secret) {
    secret.checked = true;
  }
  setStatus('');
  dialog.showModal();
  description?.focus();
};

export const close = () => {
  if (dialog && dialog.open) {
    dialog.close();
  }
};

export const fail = (message) => {
  if (!dialog) {
    return;
  }
  if (!dialog.open) {
    dialog.showModal();
  }
  setStatus(message);
};

export const initGist = (options) => {
  dialog = document.querySelector('#gist');
  form = document.querySelector('#gist-form');
  description = document.querySelector('#gist-description');
  secret = document.querySelector('#gist-secret');
  status = document.querySelector('#gist-status');

  if (!dialog || !form) {
    return;
  }

  handlers = options || {};

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    close();
    handlers.onPublish?.({
      description: description ? description.value.trim() : '',
      isPublic: secret ? !secret.checked : false
    });
  });

  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) {
      close();
    }
  });
};
