import { loadThemePreference, saveThemePreference } from './storage.js';

/*
 * Theme resolution. Preference is 'light' | 'dark' | 'system'; `resolved` is always a
 * concrete 'light' or 'dark'.
 *
 * The pre-paint script in index.html duplicates this resolution on purpose — it has to
 * run synchronously before first paint, and this module is loaded async.
 */

const lightQuery = () =>
  typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: light)') : null;

let preference = 'system';
const listeners = new Set();

export const resolveTheme = (value = preference) => {
  if (value === 'light' || value === 'dark') {
    return value;
  }
  const query = lightQuery();
  return query && query.matches ? 'light' : 'dark';
};

export const getPreference = () => preference;
export const getTheme = () => resolveTheme();

let apply = (notify = true) => {
  const resolved = resolveTheme();
  // The preview stylesheet is tokenised and bundled, so setting the attribute is the
  // whole of theming — there is no stylesheet to swap at runtime any more.
  document.documentElement.setAttribute('data-theme', resolved);
  saveThemePreference(preference, resolved);

  if (notify) {
    listeners.forEach((listener) => listener(resolved, preference));
  }

  return resolved;
};

export const setPreference = (value) => {
  preference = value === 'light' || value === 'dark' ? value : 'system';
  return apply();
};

/*
 * The theme button's whole interaction: light → dark → system → …
 *
 * When the preference is 'system' the next step is anchored to the theme currently on
 * screen, not to a fixed position in the list. Otherwise a user whose OS is dark would
 * click "change theme" and watch nothing happen, because system already resolved to the
 * value the list wanted to move to next.
 */
export const cyclePreference = () => {
  const resolved = resolveTheme();
  const next =
    preference === 'system'
      ? resolved === 'dark'
        ? 'light'
        : 'dark'
      : preference === 'light'
        ? 'dark'
        : 'system';

  setPreference(next);
  return next;
};

export const onThemeChange = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const initTheme = () => {
  preference = loadThemePreference();

  // Follow the OS while the preference is 'system'.
  const query = lightQuery();
  if (query) {
    const handler = () => {
      if (preference === 'system') {
        apply();
      }
    };
    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', handler);
    } else if (typeof query.addListener === 'function') {
      query.addListener(handler);
    }
  }

  return apply(false);
};
