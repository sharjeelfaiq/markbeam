/*
 * `$…$` inline math and `$$…$$` display math.
 *
 * Parsing belongs in marked extensions so code spans and fenced blocks keep their normal
 * precedence. Rendering stays synchronous: until the lazy KaTeX chunk arrives, a token's
 * original delimiters are emitted as literal text; `main.js` re-renders the current editor
 * value once the chunk is ready.
 */

/*
 * Inline delimiters cannot cross a line, consume either half of `$$`, or have whitespace
 * at either edge. A closing dollar followed by a digit is not a delimiter: that is the
 * small but important rule that leaves prose such as `$5 and $10` intact while still
 * allowing a complete numeric formula such as `$5$`.
 *
 * A backslash plus its following character is consumed as a pair so `\$` inside a formula
 * does not close it.
 */
const INLINE_MATH = /^\$(?!\$)(?![ \t])((?:\\[^\r\n]|[^\\$\r\n])*?[^\s\\$])\$(?!\$|\d)/;

/*
 * A display can close on its opening line, after multiline source, or on a line by
 * itself. Requiring the closing pair to end its line keeps a later `$$` in prose from
 * being pulled backward into the block.
 */
const DISPLAY_MATH =
  /^\$\$[ \t]*([\s\S]*?\S)[ \t]*(?:\r?\n[ \t]*)?\$\$[ \t]*(?:\r?\n|$)/;

let renderWithKatex = null;
let loading = null;

const escapeHtml = (value) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const renderInline = (token) => {
  if (!renderWithKatex) {
    return escapeHtml(token.raw);
  }
  return `<span class="math-inline">${renderWithKatex(token.text, false)}</span>`;
};

const renderDisplay = (token) => {
  if (!renderWithKatex) {
    const literal = escapeHtml(token.raw.trimEnd()).replace(/\r?\n/g, '<br>');
    return `<p>${literal}</p>\n`;
  }
  return `<div class="math-display">${renderWithKatex(token.text, true)}</div>\n`;
};

/**
 * One idempotent dynamic import loads both the renderer and its CSS boundary. A blocked
 * or offline chunk is a soft failure: the extensions continue emitting literal source.
 */
export const loadMath = () => {
  if (renderWithKatex) {
    return Promise.resolve(false);
  }

  if (!loading) {
    loading = import('./katex-renderer.js')
      .then((module) => {
        renderWithKatex = module.renderWithKatex;
        return true;
      })
      .catch(() => false);
  }

  return loading;
};

/*
 * This is only a load hint, not the parser: the marked tokenizers below remain the source
 * of truth. False positives merely fetch the lazy chunk; false negatives would leave real
 * math literal, so the hint deliberately recognises the same two closed delimiter shapes.
 */
export const hasMath = (markdown) => {
  const source = String(markdown || '');
  const inline = /\$(?!\$)(?![ \t\r\n])(?:\\[^\r\n]|[^\\$\r\n])*?[^\s\\$]\$(?!\$|\d)/;
  const display =
    /(?:^|\r?\n)\$\$[ \t]*[\s\S]*?\S[ \t]*(?:\r?\n[ \t]*)?\$\$[ \t]*(?:\r?\n|$)/;
  return inline.test(source) || display.test(source);
};

export const inlineMathExtension = {
  name: 'inlineMath',
  level: 'inline',

  start(src) {
    return src.indexOf('$');
  },

  tokenizer(src) {
    const match = INLINE_MATH.exec(src);
    if (!match) {
      return undefined;
    }
    return { type: 'inlineMath', raw: match[0], text: match[1] };
  },

  renderer: renderInline
};

export const displayMathExtension = {
  name: 'displayMath',
  level: 'block',

  start(src) {
    const match = /\r?\n\$\$/.exec(src);
    return match ? match.index + match[0].length - 2 : -1;
  },

  tokenizer(src) {
    const match = DISPLAY_MATH.exec(src);
    if (!match || !match[1].trim()) {
      return undefined;
    }
    return { type: 'displayMath', raw: match[0], text: match[1].trim() };
  },

  renderer: renderDisplay
};
