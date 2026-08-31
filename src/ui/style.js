import { scopeCustomCss } from '../customCss.js';

/*
 * The custom-CSS sheet.
 *
 * Same `sheet` classes as every other dialog. Like them it owns no application state: it
 * validates what was typed, reports the failure in place, and hands the scoped result back.
 *
 * Validation happens here rather than after saving so a stylesheet that parses to nothing is
 * refused while the person is still looking at it, with the previous one left in effect.
 */

let dialog;
let form;
let input;
let status;
let handlers = {};

let setStatus = (message) => {
  if (!status) {
    return;
  }
  status.textContent = message || '';
  status.hidden = !message;
};

export const open = () => {
  if (!dialog) {
    return;
  }
  if (input) {
    input.value = handlers.getCss ? handlers.getCss() : '';
  }
  setStatus('');
  dialog.showModal();
  input?.focus();
};

export const close = () => {
  if (dialog && dialog.open) {
    dialog.close();
  }
};

export const initStyle = (options) => {
  dialog = document.querySelector('#style');
  form = document.querySelector('#style-form');
  input = document.querySelector('#style-input');
  status = document.querySelector('#style-status');

  if (!dialog || !form) {
    return;
  }

  handlers = options || {};

  form.addEventListener('submit', (event) => {
    event.preventDefault();

    const raw = input ? input.value : '';
    const result = scopeCustomCss(raw);

    if (!result.ok) {
      setStatus(result.reason);
      return;
    }

    setStatus('');
    close();
    handlers.onApply?.({ raw, css: result.css });
  });

  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) {
      close();
    }
  });
};
