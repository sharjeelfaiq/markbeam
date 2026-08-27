import katex from 'katex';
import 'katex/dist/katex.min.css';

/*
 * This module is the lazy boundary for both KaTeX and its stylesheet. Keeping the CSS
 * beside the renderer means `loadMath()` needs one dynamic import, and Vite keeps the
 * implementation, CSS and fonts out of the initial application chunk.
 */
export const renderWithKatex = (source, displayMode) =>
  katex.renderToString(source, {
    displayMode,
    output: 'htmlAndMathml',
    trust: false,
    throwOnError: false,
    strict: 'ignore'
  });
