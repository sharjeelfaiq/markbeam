/*
 * Relative time for sheet rows.
 *
 * Shared by the documents sheet and the history sheet rather than copied, because the two
 * lists sit one keystroke apart in the palette and reading `3d ago` in one beside a date in
 * the other would look like a bug.
 *
 * Past a day it switches to an absolute date. `7d ago` is not something anyone converts
 * into a moment they remember, and history is the one list that routinely reaches back
 * that far.
 */

const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const formatStamp = (value) => {
  if (!value) {
    return '';
  }

  const elapsed = Date.now() - value;

  if (elapsed < MINUTE) {
    return 'just now';
  }
  if (elapsed < HOUR) {
    return `${Math.floor(elapsed / MINUTE)}m ago`;
  }
  if (elapsed < DAY) {
    return `${Math.floor(elapsed / HOUR)}h ago`;
  }

  const date = new Date(value);
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

  if (elapsed < 2 * DAY) {
    return `Yesterday ${time}`;
  }

  return `${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`;
};

/** Word count shown beside a snapshot, matching how the status bar counts. */
export const wordCount = (text) => {
  const words = String(text || '').trim().match(/\S+/g);
  return words ? words.length : 0;
};
