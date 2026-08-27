import { loadSplitRatio, saveSplitRatio } from '../storage.js';

/*
 * The beam — the draggable split between source and preview.
 *
 * Three things the previous implementation lacked, all of them real bugs:
 *
 * - It bound `mousedown`/`mousemove`, so dragging did nothing on touch devices.
 *   Pointer events cover mouse, touch and pen with one path.
 * - It was not focusable and had no ARIA, so the split could not be adjusted or even
 *   perceived without a mouse. It is now a `role="separator"` with arrow-key resizing.
 * - Panes were sized in pixels and recomputed on resize from a ratio that drag updated
 *   but double-click reset did not, so the two could disagree. Ratio is now the single
 *   source of truth and is persisted.
 */

const MIN_RATIO = 0.15;
const MAX_RATIO = 0.85;
const KEY_STEP = 0.02;
const KEY_STEP_LARGE = 0.1;

let ratio = 0.5;

let clamp = (value) => Math.min(MAX_RATIO, Math.max(MIN_RATIO, value));

export const getSplitRatio = () => ratio;

export const applySplitRatio = (value, { persist = false } = {}) => {
  ratio = clamp(value);

  const editorPane = document.getElementById('edit');
  const previewPane = document.getElementById('preview');
  const divider = document.getElementById('split-divider');

  if (editorPane && previewPane) {
    const percent = ratio * 100;
    editorPane.style.width = `${percent}%`;
    previewPane.style.width = `${100 - percent}%`;
  }

  if (divider) {
    divider.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
  }

  if (persist) {
    saveSplitRatio(ratio);
  }

  return ratio;
};

export const initDivider = () => {
  const divider = document.getElementById('split-divider');
  const workspace = document.getElementById('workspace');
  if (!divider || !workspace) {
    return;
  }

  applySplitRatio(loadSplitRatio());

  let dragging = false;

  let ratioFromClientX = (clientX) => {
    const rect = workspace.getBoundingClientRect();
    if (rect.width === 0) {
      return ratio;
    }
    return (clientX - rect.left) / rect.width;
  };

  divider.addEventListener('pointerdown', (event) => {
    dragging = true;
    divider.dataset.dragging = 'true';
    // Keeps events flowing to the divider even when the pointer outruns it.
    divider.setPointerCapture(event.pointerId);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    event.preventDefault();
  });

  divider.addEventListener('pointermove', (event) => {
    if (!dragging) {
      return;
    }
    applySplitRatio(ratioFromClientX(event.clientX));
  });

  let endDrag = (event) => {
    if (!dragging) {
      return;
    }
    dragging = false;
    delete divider.dataset.dragging;
    if (event && event.pointerId !== undefined && divider.hasPointerCapture(event.pointerId)) {
      divider.releasePointerCapture(event.pointerId);
    }
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    saveSplitRatio(ratio);
  };

  divider.addEventListener('pointerup', endDrag);
  divider.addEventListener('pointercancel', endDrag);

  divider.addEventListener('dblclick', () => {
    applySplitRatio(0.5, { persist: true });
  });

  divider.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
    let next = null;

    if (event.key === 'ArrowLeft') {
      next = ratio - step;
    } else if (event.key === 'ArrowRight') {
      next = ratio + step;
    } else if (event.key === 'Home') {
      next = MIN_RATIO;
    } else if (event.key === 'End') {
      next = MAX_RATIO;
    } else if (event.key === 'Enter' || event.key === ' ') {
      next = 0.5;
    }

    if (next !== null) {
      event.preventDefault();
      applySplitRatio(next, { persist: true });
    }
  });
};
