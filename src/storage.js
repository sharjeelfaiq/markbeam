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

const DOC_PREFIX = `${PREFIX}doc:`;

const KEYS = {
  docs: 'docs',
  activeDoc: 'active_doc',
  content: 'last_state',
  scrollSync: 'scroll_bar_settings',
  theme: 'theme_settings',
  viewMode: 'view_mode',
  splitRatio: 'split_ratio',
  docTitle: 'doc_title',
  markdownMode: 'markdown_mode',
  collapsedFolders: 'folders_collapsed',
  typography: 'typography',
  trash: 'trash',
  customCss: 'custom_css'
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

/*
 * An image edit is large enough that a swallowed QuotaExceededError would mean real data
 * loss on reload. Probe with the exact JSON shape used by a document before Monaco changes;
 * replacing the real content keys then needs no more space than this successful temporary
 * write did. The fixed internal key is always removed, including after a failed write.
 */
const CAPACITY_PROBE_KEY = `${PREFIX}_capacity_probe`;

export const canPersistContent = (value) => {
  try {
    localStorage.setItem(CAPACITY_PROBE_KEY, JSON.stringify({ v: value }));
    return true;
  } catch (error) {
    return false;
  } finally {
    try {
      localStorage.removeItem(CAPACITY_PROBE_KEY);
    } catch (error) {
      // Storage is unavailable; the attempted write has already reported the failure.
    }
  }
};

/*
 * Documents.
 *
 * `markbeam:docs` holds the index — id, title and last-edited stamp — and each document's
 * text lives under its own `markbeam:doc:<id>` key. One key per document rather than a
 * single blob: a blob would rewrite every document on every keystroke, and one oversized
 * document would take all the others down with it when quota is reached.
 */
/*
 * `folder` is optional and normalised on the way out, which is the whole of the folders
 * migration: an index written before folders existed has no such field, reads as root, and is
 * never rewritten. There is no migration step that could drop a document because there is no
 * migration step.
 */
let normaliseFolder = (value) => {
  const name = typeof value === 'string' ? value.trim() : '';
  return name || undefined;
};

export const loadDocIndex = () => {
  const value = read(KEYS.docs);
  if (!Array.isArray(value)) {
    return null;
  }
  return value
    .filter((entry) => entry && typeof entry.id === 'string')
    .map((entry) => {
      const folder = normaliseFolder(entry.folder);
      return folder ? { ...entry, folder } : { ...entry, folder: undefined };
    });
};

/*
 * Which folders are collapsed. Keyed by name, because a folder has no identity beyond its
 * name — it exists only while some document names it. A name that stops existing leaves a
 * stale entry, so the list is pruned against the live folders when it is written.
 */
export const loadCollapsedFolders = () => {
  const value = read(KEYS.collapsedFolders);
  return Array.isArray(value) ? value.filter((name) => typeof name === 'string') : [];
};

export const saveCollapsedFolders = (names, existing) => {
  const live = new Set(existing || names);
  write(KEYS.collapsedFolders, [...new Set(names)].filter((name) => live.has(name)));
};

export const saveDocIndex = (entries) => write(KEYS.docs, entries);

export const loadActiveDocId = () => {
  const value = read(KEYS.activeDoc);
  return typeof value === 'string' ? value : null;
};
export const saveActiveDocId = (id) => write(KEYS.activeDoc, id);

export const loadDoc = (id) => {
  const value = read(`doc:${id}`);
  return typeof value === 'string' ? value : '';
};
export const saveDoc = (id, text) => write(`doc:${id}`, text);

export const deleteDoc = (id) => {
  try {
    localStorage.removeItem(DOC_PREFIX + id);
  } catch (error) {
    // storage unavailable; the index update below is what actually matters
  }
};

/** Ids only need to be unique within one browser profile. */
export const newDocId = () =>
  `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/*
 * Adopt the pre-multi-document profile.
 *
 * Runs after `migrateLegacyStorage()`, so whatever that recovered is what gets adopted.
 * The old `last_state` and `doc_title` keys are deliberately left in place: they cost
 * almost nothing, and they mean a rollback to an earlier build still finds the user's
 * document instead of an empty editor.
 */
export const migrateSingleDocument = () => {
  if (loadDocIndex()) {
    return null;
  }

  const id = newDocId();
  const text = read(KEYS.content);
  const title = read(KEYS.docTitle) || 'Untitled';

  saveDoc(id, typeof text === 'string' ? text : '');
  saveDocIndex([{ id, title, updatedAt: Date.now() }]);
  saveActiveDocId(id);

  return id;
};

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
/*
 * Off unless explicitly turned on. `toBoolean` because earlier builds wrote booleans as
 * strings, and this setting is new enough to have no legacy shapes of its own — it uses the
 * same normalisation for consistency rather than necessity.
 */
export const loadTypography = () => toBoolean(read(KEYS.typography), false);
export const saveTypography = (value) => write(KEYS.typography, Boolean(value));

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

/*
 * Autosave history.
 *
 * One key per document holding the whole snapshot list, which is the opposite of the
 * per-document content keys above — and deliberately so. Content is rewritten on every
 * keystroke, where a single blob would mean re-serialising every document each time.
 * Snapshots happen at most once every twenty seconds, so rewriting one small array costs
 * nothing and keeps a document's history atomic with itself.
 *
 * `saveHistory` reports failure instead of warning and moving on, because the caller has a
 * recovery path: history is expendable, and a full quota means dropping snapshots rather
 * than letting the document save fail.
 */
const HISTORY_PREFIX = `${PREFIX}history:`;

let validEntry = (entry) =>
  entry && typeof entry.text === 'string' && Number.isFinite(entry.at);

export const loadHistory = (id) => {
  const value = read(`history:${id}`);
  return Array.isArray(value) ? value.filter(validEntry) : [];
};

export const saveHistory = (id, entries) => {
  try {
    localStorage.setItem(HISTORY_PREFIX + id, JSON.stringify({ v: entries }));
    return true;
  } catch (error) {
    return false;
  }
};

export const deleteHistory = (id) => {
  try {
    localStorage.removeItem(HISTORY_PREFIX + id);
  } catch (error) {
    // storage unavailable; nothing to remove
  }
};

/** Document ids that currently hold history, including ones whose document is long gone. */
export const historyDocIds = () => {
  try {
    return Object.keys(localStorage)
      .filter((key) => key.startsWith(HISTORY_PREFIX))
      .map((key) => key.slice(HISTORY_PREFIX.length));
  } catch (error) {
    return [];
  }
};

/*
 * Deleted documents, awaiting restore. One key holding the whole list rather than one per
 * entry: the trash is written only when something is deleted or restored, so rewriting a
 * small array costs nothing, and it keeps the sweep in `src/trash.js` able to see the whole
 * budget at once.
 */
export const loadCustomCss = () => {
  const value = read(KEYS.customCss);
  return typeof value === 'string' ? value : '';
};

export const saveCustomCss = (value) => write(KEYS.customCss, String(value || ''));

export const loadTrash = () => {
  const value = read(KEYS.trash);
  return Array.isArray(value) ? value : [];
};

export const saveTrash = (entries) => write(KEYS.trash, entries);

export const trashBytes = () => {
  try {
    const raw = localStorage.getItem(`${PREFIX}${KEYS.trash}`);
    return raw ? raw.length : 0;
  } catch (error) {
    return 0;
  }
};

/** Rough bytes held by history — key plus value, which is what the quota actually counts. */
export const historyBytes = () => {
  try {
    return Object.keys(localStorage)
      .filter((key) => key.startsWith(HISTORY_PREFIX))
      .reduce((total, key) => total + key.length + (localStorage.getItem(key) || '').length, 0);
  } catch (error) {
    return 0;
  }
};

/*
 * Remote sync credentials (T37, made per-provider by T48).
 *
 * The project name and the token are separated on purpose. `owner/repo` is not a secret and
 * is always remembered; the token is written here **only** when the user ticks "remember on
 * this device", and `src/remoteAuth.js` is the only caller. See that module for why the
 * default is memory-only.
 *
 * **The provider is part of the key**, so a GitHub and a GitLab connection cannot overwrite
 * one another. A single slot would mean connecting one silently signs you out of the other,
 * and the only way to find out is to try to save and be asked to connect again.
 *
 * The token is deliberately not wrapped in the `{ v }` envelope helpers above — it is read
 * and written as a bare string through its own pair of functions, so a future change to the
 * generic helpers cannot start round-tripping a credential through anything unexpected.
 *
 * `markbeam:github_token` and `markbeam:github_repo` are the names T37 already wrote, so an
 * existing connection keeps working without a migration.
 */
const PROVIDER_TOKEN_KEY = (provider) => `${PREFIX}${provider}_token`;

export const loadProviderToken = (provider) => {
  try {
    const value = localStorage.getItem(PROVIDER_TOKEN_KEY(provider));
    return typeof value === 'string' && value ? value : null;
  } catch (error) {
    return null;
  }
};

export const saveProviderToken = (provider, value) => {
  try {
    localStorage.setItem(PROVIDER_TOKEN_KEY(provider), value);
    return true;
  } catch (error) {
    // Never warned: the message would be attached to the credential write.
    return false;
  }
};

export const clearProviderToken = (provider) => {
  try {
    localStorage.removeItem(PROVIDER_TOKEN_KEY(provider));
  } catch (error) {
    // storage unavailable; nothing to clear
  }
};

export const loadProviderRepo = (provider) => {
  const value = read(`${provider}_repo`);
  return typeof value === 'string' && value ? value : null;
};

export const saveProviderRepo = (provider, value) => write(`${provider}_repo`, value);
