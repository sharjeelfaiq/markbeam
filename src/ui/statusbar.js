/*
 * Status bar: counts, reading time, cursor position, save state.
 *
 * Counting runs on every keystroke, so it stays cheap — no DOM work, no markdown
 * parsing, and the result is written only when the rendered string actually changes.
 */

const WORDS_PER_MINUTE = 220;
const SAVED_LABEL_DELAY_MS = 600;

let savedTimer = null;

let els = {};

let cache = { words: '', chars: '', read: '', cursor: '' };

let set = (key, element, value) => {
  if (element && cache[key] !== value) {
    cache[key] = value;
    element.textContent = value;
  }
};

let plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

export const countWords = (text) => {
  const trimmed = text.trim();
  if (!trimmed) {
    return 0;
  }
  return trimmed.split(/\s+/).length;
};

export const updateCounts = (text) => {
  const words = countWords(text);
  const minutes = words === 0 ? 0 : Math.max(1, Math.round(words / WORDS_PER_MINUTE));

  set('words', els.words, plural(words, 'word'));
  set('chars', els.chars, plural(text.length, 'character'));
  set('read', els.read, `${minutes} min read`);
};

export const updateCursor = (position) => {
  if (!position) {
    return;
  }
  set('cursor', els.cursor, `Ln ${position.lineNumber}, Col ${position.column}`);
};

export const markSaving = () => {
  if (!els.dot) {
    return;
  }
  els.dot.dataset.state = 'saving';
  if (els.saveLabel) {
    els.saveLabel.textContent = 'Saving';
  }

  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => {
    els.dot.dataset.state = 'saved';
    if (els.saveLabel) {
      els.saveLabel.textContent = 'Saved';
    }
  }, SAVED_LABEL_DELAY_MS);
};

export const initStatusBar = () => {
  els = {
    words: document.getElementById('status-words'),
    chars: document.getElementById('status-chars'),
    read: document.getElementById('status-read'),
    cursor: document.getElementById('status-cursor'),
    dot: document.getElementById('save-dot'),
    saveLabel: document.getElementById('save-label')
  };
};
