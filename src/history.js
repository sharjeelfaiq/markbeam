import {
  deleteHistory,
  historyBytes,
  historyDocIds,
  loadHistory,
  saveHistory
} from './storage.js';

/*
 * Autosave history.
 *
 * Every keystroke overwrites the document, so without this the previous text is gone —
 * there is no undo across a reload, and Clear and Reset are one confirm away from
 * destroying work.
 *
 * Three constraints shaped what is here:
 *
 * 1. **It must not cost anything while typing.** Snapshots are debounced to a pause in
 *    editing rather than taken on a timer, and identical text is skipped outright, so an
 *    idle tab accumulates nothing at all.
 * 2. **It must not fill the quota.** localStorage is a few megabytes for the whole origin,
 *    shared with the documents themselves. History that only ever grows would eventually
 *    take the documents down with it, so entries are thinned by age, capped, and swept
 *    against a byte budget.
 * 3. **It must never cost a document save.** Storage failures disable history rather than
 *    propagating. Losing a snapshot is a nuisance; losing the document is not.
 */

const IDLE_MS = 20000;
const MAX_ENTRIES = 20;
const BUDGET_BYTES = 512 * 1024;

const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

let timer = null;
let pendingDocId = null;
let disabled = false;

/*
 * How far apart two kept snapshots must be, given the age of the older one. Recent edits
 * stay dense because that is where an accidental deletion is noticed; older ones collapse,
 * so twenty entries reach back days instead of the last twenty minutes.
 */
let minGap = (age) => {
  if (age < 10 * MINUTE) {
    return 0;
  }
  if (age < 2 * HOUR) {
    return 30 * MINUTE;
  }
  if (age < DAY) {
    return 4 * HOUR;
  }
  return DAY;
};

/** `entries` is newest-first, and so is the result. */
let thin = (entries, now) => {
  const kept = [];
  let last = null;

  for (const entry of entries) {
    if (last === null || last.at - entry.at >= minGap(now - entry.at)) {
      kept.push(entry);
      last = entry;
    }
  }

  return kept.slice(0, MAX_ENTRIES);
};

/*
 * Drop the oldest snapshot anywhere until the budget is met. Across every document rather
 * than the current one: a document edited once last week should lose its history before an
 * actively edited one loses today's.
 */
let sweepBudget = () => {
  // Bounded so a storage layer misreporting its size cannot spin here.
  for (let guard = 0; guard < 500 && historyBytes() > BUDGET_BYTES; guard += 1) {
    let oldest = null;

    for (const id of historyDocIds()) {
      const entries = loadHistory(id);
      if (entries.length === 0) {
        deleteHistory(id);
        continue;
      }

      const last = entries[entries.length - 1];
      if (!oldest || last.at < oldest.at) {
        oldest = { id, at: last.at, entries };
      }
    }

    if (!oldest) {
      return;
    }

    oldest.entries.pop();
    if (oldest.entries.length === 0) {
      deleteHistory(oldest.id);
    } else {
      saveHistory(oldest.id, oldest.entries);
    }
  }
};

/*
 * A quota failure is recoverable once — halving the list frees room for the snapshot that
 * matters, the newest. A second failure means history cannot be written at all, so it stops
 * trying rather than throwing on every keystroke thereafter.
 */
let persist = (id, entries) => {
  if (saveHistory(id, entries)) {
    return true;
  }

  const half = entries.slice(0, Math.max(1, Math.ceil(entries.length / 2)));
  if (saveHistory(id, half)) {
    return true;
  }

  disabled = true;
  // eslint-disable-next-line no-console
  console.warn('Autosave history disabled — localStorage has no room for snapshots');
  return false;
};

/** Records `text` against `id` now. Returns false when nothing was written. */
export const snapshot = (id, text) => {
  if (disabled || !id || typeof text !== 'string') {
    return false;
  }

  const entries = loadHistory(id);
  // Nothing changed, so there is nothing worth keeping a second copy of.
  if (entries.length > 0 && entries[0].text === text) {
    return false;
  }
  /*
   * A new document is created empty and then opened, which fires the editor's change event
   * and schedules a snapshot. Without this, every document starts life with a stored
   * history containing one empty string.
   */
  if (text === '' && entries.length === 0) {
    return false;
  }

  const now = Date.now();
  if (!persist(id, thin([{ at: now, text }, ...entries], now))) {
    return false;
  }

  sweepBudget();
  return true;
};

export const cancelSnapshot = () => {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  pendingDocId = null;
};

/*
 * `getText` is called when the timer fires, not now, so the snapshot holds the text as it
 * was at the pause rather than at the first keystroke of the burst. It may return null to
 * decline — `main.js` uses that to refuse a snapshot whose document is no longer open,
 * which is the one failure mode here that would silently corrupt data rather than merely
 * lose a snapshot.
 */
export const scheduleSnapshot = (id, getText) => {
  if (disabled) {
    return;
  }

  cancelSnapshot();
  pendingDocId = id;

  timer = setTimeout(() => {
    timer = null;
    const target = pendingDocId;
    pendingDocId = null;
    if (target) {
      snapshot(target, getText());
    }
  }, IDLE_MS);
};

/** Takes the pending snapshot immediately, if one is due. Used before leaving a document. */
export const flushSnapshot = (id, text) => {
  cancelSnapshot();
  return snapshot(id, text);
};

export const historyFor = (id) => (id ? loadHistory(id) : []);

export const forgetHistory = (id) => {
  if (pendingDocId === id) {
    cancelSnapshot();
  }
  deleteHistory(id);
};
