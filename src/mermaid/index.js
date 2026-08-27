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
