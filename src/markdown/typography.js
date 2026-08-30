/*
 * Typographic punctuation — straight quotes to curly, `--` to a dash, `...` to an ellipsis.
 *
 * **Off by default, and that is the design.** StackEdit ships this on. Markbeam is a
 * developer-facing editor, where a straight quote in prose is usually deliberate: on by
 * default, the first time someone pastes `curl -H "Accept: text/plain"` into a paragraph it
 * comes out corrupted, and they have no idea what did it.
 *
 * marked v15 dropped its own `smartypants` option, so this is ours. It runs on a text
 * token's **raw text, before escaping** — after escaping a straight quote is already
 * `&quot;` and none of these patterns would match.
 *
 * Code never reaches here. Code spans render through `renderer.codespan` and fenced blocks
 * through `renderer.code`, neither of which calls this. "Code is untouched" is therefore a
 * property of where the transform sits rather than a rule someone has to keep in mind.
 */

/*
 * Order matters and is not arbitrary:
 *
 * - `---` before `--`, or an em dash is eaten as an en dash followed by a stray hyphen.
 * - Opening quotes before closing ones, so the decision is made on the character *before*
 *   the quote — start of string, whitespace, or an opening bracket — and everything else
 *   falls through to the closing form. That is what makes `Don't` an apostrophe rather than
 *   an opening quote, without needing to know English.
 */
const RULES = [
  [/---/g, '—'],
  [/--/g, '–'],
  [/\.\.\./g, '…'],
  [/(^|[\s([{<])"/g, '$1“'],
  [/"/g, '”'],
  [/(^|[\s([{<])'/g, '$1‘'],
  [/'/g, '’']
];

export const applyTypography = (text) =>
  RULES.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), text);
