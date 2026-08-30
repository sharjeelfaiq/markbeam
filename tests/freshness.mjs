import { readdir, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';

/*
 * Making the dev server serve current code, rather than hoping it does.
 *
 * During T41 the dev server served an old `main.js` and an old `app.css` while both files on
 * disk were correct. Five checks failed and one CSS rule silently did nothing. Every failure
 * looked real — right suite, right names, plausible details — and most of a debugging cycle
 * went into the feature before `curl` showed the served file had none of the new code in it.
 *
 * **This forces freshness instead of detecting staleness**, which is deliberate. There is no
 * reliable way to ask Vite whether its transform cache is current: `?raw` and `?t=` are
 * different module ids with their own cache entries, so a probe through either can come back
 * fresh while the module the app actually imports is stale. Touching the files makes the
 * question moot — the watcher invalidates, and the next request is transformed from disk.
 *
 * Only mtimes change; no byte of content is written. Cheap enough to do on every run.
 */

const SOURCE_EXTENSIONS = /\.(js|css|html)$/;

let walk = async (dir) => {
  const found = [];
  let entries;

  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    return found;
  }

  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await walk(path)));
    } else if (SOURCE_EXTENSIONS.test(entry.name)) {
      found.push(path);
    }
  }

  return found;
};

/**
 * Bumps the mtime of every source file so Vite re-transforms on the next request.
 * Resolves to the list of paths touched.
 */
export const refreshSources = async (root = 'src') => {
  const files = await walk(root);
  const now = new Date();

  await Promise.all(
    files.map(async (path) => {
      try {
        await utimes(path, now, now);
      } catch (error) {
        // A file that vanished between the walk and here is not worth failing a test run for.
      }
    })
  );

  return files;
};

/** Seconds since a file was last modified — used to prove the bump actually happened. */
export const secondsSinceTouched = async (path) => {
  const info = await stat(path);
  return (Date.now() - info.mtimeMs) / 1000;
};
