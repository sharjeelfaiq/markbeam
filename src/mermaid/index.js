import mermaid from 'mermaid';
import { getTheme } from '../theme.js';

/*
 * Mermaid rendering.
 *
 * Two things in here are load-bearing and were both bugs at some point:
 *
 * 1. `suppressErrorRendering`. On a parse error `mermaid.render` throws *before* it
 *    reaches its own `removeTempElements()`, stranding the temporary `d<renderId>`
 *    container it appended to <body>. Almost every keystroke mid-diagram fails to parse,
 *    so those containers stacked up until they covered the page.
 * 2. Deterministic render ids. A `Date.now()`-based id produced a fresh id every
 *    keystroke, which defeated Mermaid's own id-matching cleanup of stale containers.
 */

const RENDER_DEBOUNCE_MS = 150;

let renderTimer = null;
let renderVersion = 0;
const listeners = new Set();

/** Fires after a render pass settles — the beam pulse hangs off this. */
export const onMermaidRender = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

let mermaidTheme = (resolved) => (resolved === 'dark' ? 'dark' : 'default');

let configure = (theme) => {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    theme
  });
};

let removeTempElement = (renderId) => {
  const temp = document.getElementById(`d${renderId}`);
  if (temp) {
    temp.remove();
  }
};

let showError = (element, error) => {
  const message = error && error.message ? error.message : 'Unable to render Mermaid chart.';
  element.classList.add('mermaid-error');
  element.textContent = `Mermaid render error: ${message}`;
};

export const renderMermaidNow = async (theme = mermaidTheme(getTheme())) => {
  const outputElement = document.querySelector('#output');
  if (!outputElement) {
    return;
  }

  const version = ++renderVersion;
  configure(theme);

  const elements = Array.from(outputElement.querySelectorAll('.mermaid'));
  for (const [index, element] of elements.entries()) {
    // A newer pass started while we were awaiting — abandon this one.
    if (version !== renderVersion) {
      return;
    }

    /*
     * `element.innerHTML` is replaced by the rendered SVG, so the original source is
     * stashed on the element. Without it a theme switch would have nothing to re-render.
     */
    const source = element.dataset.mermaidSource || element.textContent;
    element.dataset.mermaidSource = source;
    element.classList.remove('mermaid-error');

    const renderId = `mermaid-${version}-${index}`;
    try {
      const { svg, bindFunctions } = await mermaid.render(renderId, source);
      if (version !== renderVersion) {
        return;
      }
      element.innerHTML = svg;
      if (typeof bindFunctions === 'function') {
        bindFunctions(element);
      }
    } catch (error) {
      showError(element, error);
    } finally {
      removeTempElement(renderId);
    }
  }

  listeners.forEach((listener) => listener());

  // Prepare light copies for printing once the visible render has settled.
  schedulePrerender();
};

export const scheduleMermaidRender = () => {
  if (renderTimer) {
    clearTimeout(renderTimer);
  }

  renderTimer = setTimeout(() => {
    renderTimer = null;
    renderMermaidNow();
  }, RENDER_DEBOUNCE_MS);
};

/** Undebounced — used by theme switches and before a PDF export. */
export const renderMermaidDiagrams = (theme) => {
  if (renderTimer) {
    clearTimeout(renderTimer);
    renderTimer = null;
  }

  return renderMermaidNow(theme);
};

export const renderMermaidForTheme = (resolved) => renderMermaidDiagrams(mermaidTheme(resolved));

/*
 * Light copies of every diagram, prepared ahead of printing.
 *
 * Mermaid bakes theme colours into the SVG it emits, so forcing the light token ramp does
 * nothing for a diagram — an SVG is not CSS. Printing from the dark theme therefore put
 * black-filled nodes on an otherwise light page.
 *
 * `beforeprint` is synchronous and a render is not, so re-rendering inside the event is a
 * race that merely usually wins. Instead the light copy is built on idle while nothing is
 * printing, and the swap at print time is a synchronous `innerHTML` assignment.
 *
 * Keyed by source rather than by element: `convert()` replaces `#output`'s children on
 * every keystroke, so an element-keyed cache would be discarded constantly, and identical
 * diagrams share one entry.
 */
const lightBySource = new Map();

/** The on-screen SVG while a print swap is in effect. A WeakMap, not a data- attribute:
 *  the markup is large and has no business sitting in the DOM. */
const screenMarkup = new WeakMap();

let prerenderTimer = null;

let diagramElements = () =>
  Array.from(document.querySelectorAll('#output .mermaid[data-mermaid-source]'));

/*
 * Renders each uncached diagram to a *string*. It never touches a live element, so it
 * cannot re-enter the render path, and it abandons the moment a screen render starts —
 * that pass reconfigures the theme itself.
 */
let prerenderLightDiagrams = async () => {
  if (mermaidTheme(getTheme()) !== 'dark') {
    return; // already light on screen; nothing to prepare
  }

  const pending = diagramElements()
    .map((element) => element.dataset.mermaidSource)
    .filter((source) => source && !lightBySource.has(source));

  if (pending.length === 0) {
    return;
  }

  const version = renderVersion;
  configure('default');

  try {
    for (const [index, source] of pending.entries()) {
      if (version !== renderVersion) {
        return;
      }

      const renderId = `mermaid-print-${index}`;
      try {
        const { svg } = await mermaid.render(renderId, source);
        if (version !== renderVersion) {
          return;
        }
        lightBySource.set(source, svg);
      } catch (error) {
        /*
         * An unrenderable diagram simply has no light copy, and printing falls back to
         * whatever is on screen. Warned rather than swallowed: a silent catch here hides a
         * systematic failure as "the cache is just cold", which is indistinguishable from
         * working until someone prints.
         */
        // eslint-disable-next-line no-console
        console.warn('Could not prepare a light copy of a diagram for printing', error);
      } finally {
        removeTempElement(renderId);
      }
    }
  } finally {
    // Put the configuration back however this exited, unless a newer pass owns it now.
    if (version === renderVersion) {
      configure(mermaidTheme(getTheme()));
    }
    markReadiness();
  }
};

/** Idle-scheduled so it never competes with typing. */
let schedulePrerender = () => {
  if (prerenderTimer) {
    clearTimeout(prerenderTimer);
  }
  prerenderTimer = setTimeout(() => {
    prerenderTimer = null;
    prerenderLightDiagrams();
  }, 400);
};

/** Synchronous: swap in the prepared light copies. Missing ones are left alone. */
export const applyPrintDiagrams = () => {
  for (const element of diagramElements()) {
    const light = lightBySource.get(element.dataset.mermaidSource);
    if (light && !screenMarkup.has(element)) {
      screenMarkup.set(element, element.innerHTML);
      element.innerHTML = light;
    }
  }
};

/** Synchronous: put the on-screen diagrams back. */
export const restoreScreenDiagrams = () => {
  for (const element of diagramElements()) {
    if (screenMarkup.has(element)) {
      element.innerHTML = screenMarkup.get(element);
      screenMarkup.delete(element);
    }
  }
};

/*
 * Mirrors cache readiness onto the DOM.
 *
 * Deliberately not an exported predicate: under Vite's dev server an edited module is
 * served as `?t=…`, so anything importing it from the page gets a *second* instance with
 * its own empty cache. That produced a readiness check which was always false while the
 * feature worked perfectly — an attribute is observable without importing anything.
 */
let markReadiness = () => {
  const output = document.querySelector('#output');
  if (!output) {
    return;
  }
  const ready = diagramElements().every((element) =>
    lightBySource.has(element.dataset.mermaidSource)
  );
  output.dataset.printDiagrams = ready ? 'ready' : 'pending';
};
