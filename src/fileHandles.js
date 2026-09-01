/*
 * Where a `FileSystemFileHandle` lives (T70).
 *
 * **This is the only IndexedDB in the codebase, and it is here because it has to be.** Every
 * other persisted thing goes through `src/storage.js`, which writes JSON `{ v: value }`
 * envelopes into `localStorage`. A file handle is *structured-cloneable* but not
 * JSON-serialisable — `JSON.stringify(handle)` yields `{}` and the file is gone — so the one
 * store that can hold it is IndexedDB. Reaching for it anywhere else in this app would be
 * reaching past a simpler thing that works.
 *
 * Two layers, and the split is what makes the feature usable rather than merely correct:
 *
 * - **A module-scope `Map` is the source of truth for this tab.** Every save reads from here,
 *   so saving works even when the durability layer below refuses.
 * - **IndexedDB is best-effort durability, for the next visit.** It is wrapped in try/catch and
 *   downgrades to a warning, because it genuinely fails in the ordinary course of events: a
 *   private window may refuse to open a database at all, and a handle that is not
 *   structured-cloneable (a test double, most obviously) throws `DataCloneError` on `put`.
 *   Neither is a reason the user should be unable to save the file they just opened.
 *
 * A restored handle carries **no permission**. The spec requires a user gesture to re-grant it,
 * which is why "reopen the file I had" is a prompt rather than something that happens on boot —
 * see `src/fileSystem.js`, which owns that half.
 */

const DB_NAME = 'markbeam';
const DB_VERSION = 1;
const STORE = 'file-handles';

/** The session's handles. Authoritative while the tab is open; see the note above. */
const session = new Map();

let dbPromise = null;

let openDatabase = () => {
  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('no indexedDB'));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('indexedDB refused'));
    // A blocked upgrade never fires either handler, and an unbounded promise here would hang
    // every save behind it.
    request.onblocked = () => reject(new Error('indexedDB blocked'));
  }).catch((error) => {
    dbPromise = null;
    throw error;
  });

  return dbPromise;
};

let withStore = async (mode, run) => {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const result = run(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
  });
};

/** The handle bound to this document in *this tab*, or null. Synchronous on purpose: the save
 *  path runs from a click and must not lose the user gesture to an await it does not need. */
export const handleFor = (docId) => (docId && session.get(docId)) || null;

/**
 * Binds a handle to a document. Resolves either way — the caller has a working handle in the
 * session Map regardless of whether it reached disk, and a save must not fail because next
 * week's convenience could not be arranged.
 */
export const rememberHandle = async (docId, handle) => {
  if (!docId || !handle) {
    return false;
  }

  session.set(docId, handle);

  try {
    await withStore('readwrite', (store) => store.put(handle, docId));
    return true;
  } catch (error) {
    // Expected in a private window, and for any handle that is not structured-cloneable.
    console.warn('Markbeam: this file will not be remembered after a reload', error?.name || error);
    return false;
  }
};

/** Pulls a stored handle back into the session. Still unpermissioned — see the header. */
export const restoreHandle = async (docId) => {
  if (!docId) {
    return null;
  }
  if (session.has(docId)) {
    return session.get(docId);
  }

  try {
    const handle = await withStore('readonly', (store) => store.get(docId));
    if (handle) {
      session.set(docId, handle);
    }
    return handle || null;
  } catch (error) {
    return null;
  }
};

/** Unbinds a document, in both layers. Deleting a document must not leave a handle behind. */
export const forgetHandle = async (docId) => {
  if (!docId) {
    return;
  }
  session.delete(docId);
  try {
    await withStore('readwrite', (store) => store.delete(docId));
  } catch (error) {
    /* Nothing to do: the session copy is gone, which is what this tab acts on. */
  }
};
