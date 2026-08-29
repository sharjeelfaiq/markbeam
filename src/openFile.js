/*
 * Reading a Markdown file the user hands us.
 *
 * No DOM beyond the File API, so the rules below can be reasoned about on their own: this
 * module decides whether a file is acceptable and what it should be called, and `main.js`
 * decides what to do about it.
 *
 * Both guards exist because of how storage fails, not for tidiness:
 *
 * - `write()` in `storage.js` catches QuotaExceededError and only warns. An oversized file
 *   would therefore *appear* to open, silently fail to persist, and be gone on the next
 *   reload — and because the failure is a console.warn, even the suites' console-error
 *   checks would stay quiet about it. Refusing up front is the only honest outcome.
 * - A binary file decoded as UTF-8 produces mojibake, not an error. Dropping a screenshot
 *   would otherwise fill the editor with replacement characters and save them.
 */

/** Comfortably past any real Markdown document, and well clear of the storage quota. */
const MAX_BYTES = 1024 * 1024;

const TEXT_EXTENSION = /\.(md|markdown|mdown|mkd|mkdn|text|txt)$/i;

/** A NUL anywhere means the decode produced nonsense, whatever the extension claimed. */
const NUL = '\u0000';

/** `notes.md` → `notes`. The extension is noise once the file is a document. */
export const titleFromFilename = (name) =>
  String(name || '')
    .replace(/\.[^./\\]+$/, '')
    .trim() || 'Untitled';

/*
 * Extension or MIME type. Neither alone is enough: a `.md` file often arrives with an empty
 * `type`, and a text file saved without an extension still reports `text/plain`.
 */
let looksLikeText = (file) => TEXT_EXTENSION.test(file.name || '') || /^text\//.test(file.type || '');

let describeSize = (bytes) => `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`;

/**
 * Resolves to `{ ok: true, title, text }`, or `{ ok: false, reason }` with a message written
 * for a toast rather than a log.
 */
export const readMarkdownFile = async (file) => {
  if (!file) {
    return { ok: false, reason: 'No file to open' };
  }

  if (file.size > MAX_BYTES) {
    return {
      ok: false,
      reason: `“${file.name}” is ${describeSize(file.size)} — too large to store in the browser`
    };
  }

  if (!looksLikeText(file)) {
    return { ok: false, reason: `“${file.name}” is not a text file` };
  }

  let text;
  try {
    text = await file.text();
  } catch (error) {
    return { ok: false, reason: `Could not read “${file.name}”` };
  }

  if (text.includes(NUL)) {
    return { ok: false, reason: `“${file.name}” is not a text file` };
  }

  return { ok: true, title: titleFromFilename(file.name), text };
};
