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

/*
 * Printing always uses the light ramp.
 *
 * Printing the dark theme wastes ink and, where a printer drops backgrounds, puts white
 * text on white paper. The attribute is swapped rather than the token values being
 * duplicated inside `@media print`, so the printed page uses exactly the same light ramp
 * as the screen and the two can never drift apart. Storage is untouched — this is a
 * temporary display state, not a preference.
 *
 * Two signals, because neither covers every case on its own: `beforeprint` fires for
 * Ctrl+P and for headless PDF rendering but not when print media is merely emulated, while
 * a `matchMedia('print')` change fires for emulation. Measured, not assumed.
 */
let printRestore = null;
let printHooks = {};

let enterPrint = () => {
  /*
   * Idempotent rather than early-returning. Both signals can fire for one print job, and
   * an early return meant a second `enterPrint` left the page on whatever theme it
   * happened to be showing — which produced a dark printout after a few media changes.
   * Capture the screen theme once; assert the light one every time.
   */
  if (printRestore === null) {
    printRestore = document.documentElement.getAttribute('data-theme');
  }
  document.documentElement.setAttribute('data-theme', 'light');
  printHooks.onEnter?.();
};

let leavePrint = () => {
  if (printRestore === null) {
    return;
  }

  /*
   * The two signals must cooperate rather than race. `afterprint` can arrive while print
   * media is still active — a PDF render inside an already-printing context does exactly
   * that — and restoring then would drop the page back to the dark ramp mid-print. The
   * media query is the authority on whether printing is still happening.
   */
  if (typeof window.matchMedia === 'function' && window.matchMedia('print').matches) {
    return;
  }

  document.documentElement.setAttribute('data-theme', printRestore);
  printRestore = null;
  printHooks.onLeave?.();
};

/*
 * `hooks` rather than an import of the mermaid module: that module imports this one, and
 * the codebase passes callbacks across module boundaries instead of forming cycles.
 */
export const initPrintTheme = (hooks = {}) => {
  printHooks = hooks;

  window.addEventListener('beforeprint', enterPrint);
  window.addEventListener('afterprint', leavePrint);

  if (typeof window.matchMedia === 'function') {
    const printQuery = window.matchMedia('print');
    const onChange = (event) => (event.matches ? enterPrint() : leavePrint());
    if (typeof printQuery.addEventListener === 'function') {
      printQuery.addEventListener('change', onChange);
    }
  }
};
