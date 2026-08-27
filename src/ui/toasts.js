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

export const toast = (message, { tone = 'info', duration = DEFAULT_MS } = {}) => {
  const host = container();
  if (!host) {
    return;
  }

  const element = document.createElement('div');
  element.className = 'toast';
  element.dataset.tone = tone;
  element.textContent = message;
  host.appendChild(element);

  const remove = () => {
    element.dataset.leaving = 'true';
    setTimeout(() => element.remove(), EXIT_MS);
  };

  setTimeout(remove, duration);
  return remove;
};

export const toastError = (message) => toast(message, { tone: 'error', duration: 4000 });
