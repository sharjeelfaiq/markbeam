/*
 * All persistence goes through here.
 *
 * Keys are plain and readable — `markbeam:last_state` — so stored state can be inspected
 * and cleared from devtools. An earlier version delegated to a third-party library that
 * hashed every key (MD5 of `namespace-key`), which made stored data opaque and meant a
 * key could never be reconstructed by hand.
 *
 * Anyone who used the site before that change still has content under the old hashed
 * keys, so `migrateLegacyStorage()` recovers it. See tests/storage.test.mjs.
 */

const PREFIX = 'markbeam:';
const LEGACY_NAMESPACE = 'com.markdownlivepreview';
const LEGACY_BOOT_THEME_KEY = 'com.markdownlivepreview_theme';
const MIGRATED_FLAG = `${PREFIX}_migrated`;

/*
 * The pre-paint boot script in index.html reads this key directly. It has to be a plain
 * string, not JSON, so that script can resolve the theme synchronously before first paint
 * without parsing anything.
 */
export const BOOT_THEME_KEY = `${PREFIX}theme`;

const KEYS = {
  content: 'last_state',
  scrollSync: 'scroll_bar_settings',
  theme: 'theme_settings',
  viewMode: 'view_mode',
  splitRatio: 'split_ratio',
  docTitle: 'doc_title',
  markdownMode: 'markdown_mode'
};

let read = (key) => {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw === null) {
      return null;
    }
    return JSON.parse(raw).v;
  } catch (error) {
    // Corrupt or unparseable entry — treat as absent rather than breaking startup.
    return null;
  }
};

let write = (key, value) => {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify({ v: value }));
  } catch (error) {
    // Quota exceeded, or storage disabled in private mode.
    // eslint-disable-next-line no-console
    console.warn(`Could not persist ${key}`, error);
  }
};

/*
 * Recover content written by the old hashed-key library.
 *
 * Those records embedded `{ namespace, key, value }` as JSON, so they can be found by
 * parsing every stored value and matching the namespace — no need to reimplement the MD5
 * key derivation just to read them. Runs once; the flag stops a later reload from
 * overwriting newer edits with stale legacy data.
 */
export const migrateLegacyStorage = () => {
  try {
    if (localStorage.getItem(MIGRATED_FLAG)) {
      return 0;
    }

    let recovered = 0;
    const stores = [localStorage, sessionStorage];

    for (const store of stores) {
      for (const storageKey of Object.keys(store)) {
        if (storageKey.startsWith(PREFIX)) {
          continue;
        }

        let record;
        try {
          record = JSON.parse(store.getItem(storageKey));
        } catch (error) {
          continue; // not one of ours
        }

        if (
          !record ||
          typeof record !== 'object' ||
          record.namespace !== LEGACY_NAMESPACE ||
          typeof record.key !== 'string' ||
          record.value === undefined
        ) {
          continue;
        }

        // Never clobber something already written under the new scheme.
        if (localStorage.getItem(PREFIX + record.key) === null) {
          write(record.key, record.value);
          recovered += 1;
        }
      }
    }

    // The boot theme key was stored outside the namespace, as a bare string.
    const legacyTheme = localStorage.getItem(LEGACY_BOOT_THEME_KEY);
    if (legacyTheme && localStorage.getItem(BOOT_THEME_KEY) === null) {
      localStorage.setItem(BOOT_THEME_KEY, legacyTheme === 'true' ? 'dark' : legacyTheme === 'false' ? 'light' : legacyTheme);
      recovered += 1;
    }

    localStorage.setItem(MIGRATED_FLAG, String(Date.now()));
    return recovered;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn('Legacy storage migration skipped', error);
    return 0;
  }
};

/*
 * Values may arrive as strings or booleans depending on when they were written, so
 * booleans are normalised on the way out. Use this for any new persisted boolean.
 */
let toBoolean = (value, fallback = false) => {
  if (value === true || value === 'true') {
    return true;
  }
  if (value === false || value === 'false') {
    return false;
  }
  return fallback;
};

export const loadContent = () => read(KEYS.content);
export const saveContent = (value) => write(KEYS.content, value);

export const loadScrollSync = () => toBoolean(read(KEYS.scrollSync), false);
export const saveScrollSync = (value) => write(KEYS.scrollSync, value);

export const loadViewMode = () => {
  const value = read(KEYS.viewMode);
  return value === 'editor' || value === 'preview' || value === 'split' ? value : 'split';
};
export const saveViewMode = (value) => write(KEYS.viewMode, value);

export const loadSplitRatio = () => {
  const value = Number(read(KEYS.splitRatio));
  return Number.isFinite(value) && value >= 0.1 && value <= 0.9 ? value : 0.5;
};
export const saveSplitRatio = (value) => write(KEYS.splitRatio, String(value));

export const loadDocTitle = () => read(KEYS.docTitle) || 'Untitled';
export const saveDocTitle = (value) => write(KEYS.docTitle, value);

/*
 * GFM is the compatibility default. Older builds had no mode setting, and experiments
 * may have left values such as `github` or booleans behind; none of those should silently
 * move an existing document onto the stricter CommonMark parser.
 */
export const loadMarkdownMode = () =>
  read(KEYS.markdownMode) === 'commonmark' ? 'commonmark' : 'gfm';
export const saveMarkdownMode = (value) =>
  write(KEYS.markdownMode, value === 'commonmark' ? 'commonmark' : 'gfm');

/*
 * Theme is tri-state: 'light' | 'dark' | 'system'. Older builds stored a boolean here,
 * and a bare string in the boot key; both shapes are accepted on read.
 */
export const loadThemePreference = () => {
  const stored = read(KEYS.theme);

  if (stored === 'light' || stored === 'dark' || stored === 'system') {
    return stored;
  }
  if (stored === true || stored === 'true') {
    return 'dark';
  }
  if (stored === false || stored === 'false') {
    return 'light';
  }

  try {
    const boot = localStorage.getItem(BOOT_THEME_KEY);
    if (boot === 'dark' || boot === 'light') {
      return boot;
    }
  } catch (error) {
    // storage unavailable; fall through to the default
  }

  return 'system';
};

export const saveThemePreference = (preference, resolved) => {
  write(KEYS.theme, preference);
  try {
    // The boot script needs a concrete theme, never 'system'.
    localStorage.setItem(BOOT_THEME_KEY, resolved);
  } catch (error) {
    // ignore storage errors
  }
};
