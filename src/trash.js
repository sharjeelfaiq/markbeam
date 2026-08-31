import {
  deleteHistory,
  loadHistory,
  loadTrash,
  saveHistory,
  saveTrash,
  trashBytes
} from './storage.js';

/*
 * Deleted documents, kept for a while.
 *
 * `deleteDocument()` used to remove the document *and* call `forgetHistory()`, so one confirm
 * destroyed every autosaved version too — the exact loss T22 was built to prevent, reached by
 * a different route, and with nothing able to undo it.
 *
 * Three constraints, and the third is the one that makes this safe rather than a new problem:
 *
 * 1. **The history goes with it.** Restoring text alone would look like a fix while still
 *    having thrown away what T22 exists for, so a trash entry carries the snapshots and puts
 *    them back on restore.
 * 2. **It is bounded.** Entries expire, and only a few are kept — a trash that grows forever
 *    is a leak with a friendly name.
 * 3. **It is swept against a byte budget.** `src/history.js` already sweeps its own 512 KB
 *    against the origin quota; a trash that quietly ate the rest of localStorage would take
 *    the live documents down with it, which is worse than the bug being fixed.
 */

const MAX_ENTRIES = 10;
const MAX_TRASH_BYTES = 256 * 1024;
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/*
 * Newest first, expired dropped, then trimmed to the count and the byte budget in that order:
 * age is the user-visible rule, and the budget is the backstop for a few very large documents
 * that are all recent.
 */
let prune = (entries) => {
  const now = Date.now();
  const kept = entries
    .filter((entry) => entry && typeof entry.id === 'string')
    .filter((entry) => now - (entry.deletedAt || 0) < KEEP_MS)
    .sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0))
    .slice(0, MAX_ENTRIES);

  // Drop the oldest until the whole trash fits. Measured on the serialised form, because that
  // is what the quota actually counts.
  while (kept.length > 0 && JSON.stringify({ v: kept }).length > MAX_TRASH_BYTES) {
    kept.pop();
  }

  return kept;
};

/**
 * Moves a document into the trash, snapshots and all. Returns false when nothing was kept —
 * a document larger than the whole budget cannot be, and saying so beats pretending.
 */
export const rememberDeleted = ({ id, title, text }) => {
  if (!id) {
    return false;
  }

  const entry = {
    id,
    title: title || 'Untitled',
    text: typeof text === 'string' ? text : '',
    history: loadHistory(id),
    deletedAt: Date.now()
  };

  const kept = prune([entry, ...loadTrash()]);
  saveTrash(kept);

  // Only true if this entry actually survived the prune.
  return kept.some((item) => item.id === id);
};

/** Puts a document and its snapshots back. Returns the entry, or null if it has aged out. */
export const restoreDeleted = (id) => {
  const entries = loadTrash();
  const entry = entries.find((item) => item.id === id);
  if (!entry) {
    return null;
  }

  if (Array.isArray(entry.history) && entry.history.length > 0) {
    saveHistory(id, entry.history);
  } else {
    // No snapshots to restore, and any stale key for this id would be misleading.
    deleteHistory(id);
  }

  saveTrash(entries.filter((item) => item.id !== id));
  return entry;
};

export const listDeleted = () => prune(loadTrash());

/** Bytes currently held, for anyone reasoning about the origin's quota. */
export const trashSize = () => trashBytes();
