/*
 * Editing a file that exists on disk (T70).
 *
 * Every browser Markdown editor traps your text in its own storage and makes you copy in and
 * copy out. This is the module that does not. It imports nothing and touches neither the DOM
 * nor storage — `main.js` wires it — so the one question worth being sure about can be answered
 * by reading one short file: **when is this allowed to overwrite somebody's file?**
 *
 * The answer, and it is borrowed rather than invented:
 *
 * > Only when the file on disk is still the one we last read. Otherwise, never — keep both.
 *
 * `src/autoSync.js` already refuses to merge a repository conflict, because a write that
 * silently replaces work is a data-loss path and a merge that is wrong once costs someone a
 * document. A file changed underneath you is that same situation arriving through a different
 * door, so it gets the same answer and for the same reason. There is no merge here and there
 * must not be one.
 *
 * **The stamp has to be re-read after our own write.** A successful write moves the file's
 * `lastModified`, so an app that keeps comparing against the timestamp it saw at open would
 * read *its own* save as somebody else's edit and refuse every save after the first — a feature
 * that works exactly once. `tests/filesystem.test.mjs` saves twice for that reason alone.
 *
 * Chromium only. Safari and Firefox have no `showOpenFilePicker`, so `isSupported()` gates every
 * affordance and the existing drop-and-download path stays exactly as it is. An offer that
 * cannot work is worse than no offer.
 */

/** Whether this browser can open a file by handle at all. Gates the UI, not just the calls. */
export const isSupported = () =>
  typeof window !== 'undefined' && typeof window.showOpenFilePicker === 'function';

/*
 * Markdown, plus a catch-all. `.md` files frequently arrive with an empty MIME type, so the
 * extension list is the part that does the work; `description` is what the OS dialog shows.
 */
const PICKER_TYPES = [
  {
    description: 'Markdown',
    accept: { 'text/markdown': ['.md', '.markdown', '.mdown', '.mkd', '.mkdn'], 'text/plain': ['.txt', '.text'] }
  }
];

/**
 * Shows the picker. Resolves to a handle, or **null when the user cancelled** — an abort is an
 * answer, not a failure, and must not raise a toast telling somebody their own decision failed.
 */
export const pickFile = async () => {
  if (!isSupported()) {
    return null;
  }

  try {
    const [handle] = await window.showOpenFilePicker({ multiple: false, types: PICKER_TYPES });
    return handle || null;
  } catch (error) {
    if (error && error.name === 'AbortError') {
      return null;
    }
    throw error;
  }
};

/*
 * Permission, in two moods. Querying is free and silent; requesting shows the browser's own
 * prompt and **must run inside a user gesture**, which is why the save command calls this
 * straight off the click rather than after any awaited work of its own.
 */
export const hasPermission = async (handle, { request = false } = {}) => {
  if (!handle) {
    return false;
  }

  const mode = { mode: 'readwrite' };

  try {
    if ((await handle.queryPermission?.(mode)) === 'granted') {
      return true;
    }
    if (!request) {
      return false;
    }
    return (await handle.requestPermission?.(mode)) === 'granted';
  } catch (error) {
    return false;
  }
};

/** Reads the file behind a handle, with the stamp the divergence check is made against. */
export const readHandle = async (handle) => {
  const file = await handle.getFile();
  return { file, stamp: file.lastModified };
};

/**
 * Has the file moved since `stamp`?
 *
 * A missing stamp answers **yes**: not knowing when we last read a file is not a licence to
 * overwrite it, and the safe direction here is the one that keeps both copies.
 */
export const hasMoved = (file, stamp) =>
  !Number.isFinite(stamp) || !file || file.lastModified !== stamp;

/**
 * Writes `text` and returns the **new** stamp, so the caller records what it just created
 * rather than what it read — see the header.
 */
export const writeHandle = async (handle, text) => {
  const writable = await handle.createWritable();
  await writable.write(text);
  await writable.close();

  // Re-read rather than guessing: the filesystem, not this app, decides the timestamp.
  try {
    const file = await handle.getFile();
    return file.lastModified;
  } catch (error) {
    // The write succeeded; only the bookkeeping failed. An undefined stamp makes the *next*
    // save ask rather than overwrite, which is the right way round to be wrong.
    return undefined;
  }
};
