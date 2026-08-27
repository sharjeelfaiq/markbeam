/*
 * `==highlight==` → `<mark>`.
 *
 * An inline extension rather than a pass over the rendered HTML: marked's tokenizer already
 * walks around code spans and fenced blocks, whereas a post-process would happily eat
 * `==code==` inside a backtick span.
 */

/*
 * The content may not begin or end with whitespace, which is the same rule `**bold**`
 * follows and the reason `a == b == c` stays literal instead of becoming
 * `a <mark>b</mark> c`.
 *
 * `=(?!=)` lets a single `=` sit inside the run (`==a=b==`) while never letting a `==`
 * close it early, and requiring a non-`=` first character leaves `===x===` alone.
 *
 * Worked through, and covered by tests: `==text==` and `==a==` match; `== b ==`,
 * `a == b`, `===` and a lone `=` do not.
 */
const HIGHLIGHT = /^==([^\s=](?:(?:[^=]|=(?!=))*?[^\s=])?)==/;

export const highlightExtension = {
  name: 'highlight',
  level: 'inline',

  start(src) {
    return src.indexOf('==');
  },

  tokenizer(src) {
    const match = HIGHLIGHT.exec(src);
    if (!match) {
      return undefined;
    }

    const text = match[1];

    /*
     * Child tokens, not a raw string: a highlight has to be able to contain emphasis, code
     * spans, links and the emoji shortcodes from T5. `this` is marked's lexer, which is why
     * these stay object methods rather than arrow functions.
     */
    return {
      type: 'highlight',
      raw: match[0],
      text,
      tokens: this.lexer.inlineTokens(text)
    };
  },

  renderer(token) {
    return `<mark>${this.parser.parseInline(token.tokens)}</mark>`;
  }
};
