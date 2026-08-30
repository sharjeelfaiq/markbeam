/*
 * Markdown Extra definition lists: `Term` on one line, `: definition` on the next.
 *
 * A **block-level** extension, unlike the inline ones beside it — a definition list is a
 * block container, and inline extensions never see the line structure this needs.
 *
 * The hard part is not matching definitions; it is *not* matching everything else. A line
 * beginning with a colon is ordinary punctuation far more often than it is markup, and a
 * greedy tokenizer quietly restructures documents that merely contain a time, a ratio or a
 * pasted YAML block. So the pattern is deliberately strict:
 *
 * - The colon must be the **first non-space character of its own line**, followed by at least
 *   one space. `14:30` and `3:1` are mid-line and never considered.
 * - The term line must be a single non-empty line that is not itself a definition, a heading,
 *   a list item, a quote or a fence. That is what keeps `A line ending in a colon:` followed
 *   by prose from becoming a term with no definition.
 * - Nothing here runs inside fenced code, because marked's block lexer consumes a fence whole
 *   before extensions are consulted — the same reason the highlight extension can ignore
 *   backticks entirely.
 *
 * `tests/deflist.test.mjs` covers each of those false-positive cases; they matter more than
 * the happy path, which is why they outnumber it there.
 */

/** A definition line: optional indent, a colon, a space, then content. */
const DEFINITION = /^ {0,3}:[ \t]+(\S.*)$/;

/** Lines that can never be a term, because they already mean something else. */
const NOT_A_TERM = /^ {0,3}(#{1,6}\s|>|[-*+]\s|\d+[.)]\s|```|~~~|\||:)/;

export const definitionListExtension = {
  name: 'definitionList',
  level: 'block',

  start(src) {
    // Cheap bail-out for the common case: no line in the remainder starts with a colon.
    const match = /^ {0,3}:[ \t]/m.exec(src);
    return match ? match.index : undefined;
  },

  tokenizer(src) {
    const lines = src.split('\n');
    const items = [];
    let index = 0;
    let consumed = 0;

    while (index < lines.length) {
      const termLine = lines[index];

      if (!termLine.trim() || NOT_A_TERM.test(termLine)) {
        break;
      }

      // A term is only a term if the line after it defines it.
      const definitions = [];
      let cursor = index + 1;

      while (cursor < lines.length) {
        const match = DEFINITION.exec(lines[cursor]);
        if (!match) {
          break;
        }
        definitions.push(match[1].trim());
        cursor += 1;
      }

      if (definitions.length === 0) {
        break;
      }

      items.push({ term: termLine.trim(), definitions });
      consumed = cursor;

      // A blank line may separate one term from the next without ending the list.
      index = cursor;
      if (lines[index] !== undefined && !lines[index].trim()) {
        index += 1;
      }
    }

    if (items.length === 0) {
      return undefined;
    }

    const raw = lines.slice(0, consumed).join('\n');

    return {
      type: 'definitionList',
      raw,
      items: items.map((item) => ({
        term: item.term,
        termTokens: this.lexer.inlineTokens(item.term),
        definitions: item.definitions.map((text) => ({
          text,
          tokens: this.lexer.inlineTokens(text)
        }))
      }))
    };
  },

  renderer(token) {
    const body = token.items
      .map((item) => {
        const term = `<dt>${this.parser.parseInline(item.termTokens)}</dt>`;
        const definitions = item.definitions
          .map((definition) => `<dd>${this.parser.parseInline(definition.tokens)}</dd>`)
          .join('');
        return term + definitions;
      })
      .join('');

    return `<dl>${body}</dl>\n`;
  }
};
