/*
 * Transient feedback.
 *
 * Replaces the old trick of overwriting a link's text with "Copied!" for a second, which
 * was invisible to screen readers and destroyed the button's own label. The container
 * carries aria-live="polite", so messages are announced.
 */

const DEFAULT_MS = 2200;
const EXIT_MS = 220;

let container = () => document.getElementById('toasts');

/**
 * `action` puts a button in the toast — `{ label, run }`.
 *
 * It exists because a recovery nobody can find is not a recovery. Undoing a deletion has to be
 * offered at the moment of deletion, while the person is still thinking about what they just
 * did, rather than buried in a menu they would have to know to look in.
 */
export const toast = (message, { tone = 'info', duration = DEFAULT_MS, action = null } = {}) => {
  const host = container();
  if (!host) {
    return;
  }

  const element = document.createElement('div');
  element.className = 'toast';
  element.dataset.tone = tone;

  const text = document.createElement('span');
  text.textContent = message;
  element.appendChild(text);

  if (action && typeof action.run === 'function') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'toast__action';
    button.textContent = action.label || 'Undo';
    button.addEventListener('click', () => {
      remove();
      action.run();
    });
    element.appendChild(button);
  }

  host.appendChild(element);

  function remove() {
    element.dataset.leaving = 'true';
    setTimeout(() => element.remove(), EXIT_MS);
  }

  setTimeout(remove, duration);
  return remove;
};

export const toastError = (message) => toast(message, { tone: 'error', duration: 4000 });
