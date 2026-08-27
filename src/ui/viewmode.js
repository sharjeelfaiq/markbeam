import { loadViewMode, saveViewMode } from '../storage.js';

/*
 * Editor / Split / Preview.
 *
 * The mode lives in `data-view` on <body>; CSS does the rest. Below 768px the layout
 * only ever shows one pane, so 'split' is treated as 'editor' there — handled in CSS so
 * the stored preference survives a resize back to a wide window.
 */

export const VIEW_MODES = ['editor', 'split', 'preview'];

let current = 'split';
const listeners = new Set();

let syncButtons = () => {
  document.querySelectorAll('[data-view-mode]').forEach((button) => {
    const isNarrowTab = button.classList.contains('pane-tabs__item');
    // The narrow-screen tabs only offer two options; 'split' shows the editor there.
    const effective = isNarrowTab && current === 'split' ? 'editor' : current;
    button.setAttribute('aria-pressed', String(button.dataset.viewMode === effective));
  });
};

export const getViewMode = () => current;

export const setViewMode = (mode, { persist = true } = {}) => {
  if (!VIEW_MODES.includes(mode)) {
    return current;
  }

  current = mode;
  document.body.dataset.view = mode;
  syncButtons();

  if (persist) {
    saveViewMode(mode);
  }

  listeners.forEach((listener) => listener(mode));
  return current;
};

export const onViewModeChange = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const initViewMode = () => {
  document.querySelectorAll('[data-view-mode]').forEach((button) => {
    button.addEventListener('click', () => setViewMode(button.dataset.viewMode));
  });

  setViewMode(loadViewMode(), { persist: false });
  return current;
};
