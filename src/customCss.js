/*
 * User-supplied preview CSS, scoped so it cannot leave the preview.
 *
 * Parsed by the browser rather than by a regex. Handing the text to a stylesheet and reading
 * the rules back gives three things at once:
 *
 * 1. **Scoping.** Every selector is rewritten to sit under `.mb-md`, so a pasted
 *    `.toolbar { display: none }` restyles nothing outside the preview. A user cannot break
 *    the app out of its own stylesheet.
 * 2. **Sanitising.** The output is re-serialised from the CSSOM, so a `</style>` in the input
 *    cannot survive to close the tag it is injected into.
 * 3. **Validation.** Text that parses to no rules at all is refused, rather than silently
 *    doing nothing and looking like a bug in the feature.
 *
 * `@import` is dropped deliberately: it is a network request from a stylesheet, and "nothing
 * leaves your browser unless you ask" is a claim `/about` makes.
 */

const SCOPE = '.mb-md';

/*
 * `body` and `:root` mean "the whole document" to someone writing CSS; inside the preview the
 * nearest honest equivalent is the preview container itself, so they map onto the scope rather
 * than being nested under it.
 */
let scopeSelector = (selector) =>
  selector
    .split(',')
    .map((part) => {
      const trimmed = part.trim();
      if (!trimmed) {
        return '';
      }
      if (/^(body|html|:root)$/i.test(trimmed)) {
        return SCOPE;
      }
      return `${SCOPE} ${trimmed}`;
    })
    .filter(Boolean)
    .join(', ');

let scopeRules = (rules) => {
  const out = [];

  for (const rule of Array.from(rules)) {
    // CSSStyleRule
    if (rule.selectorText) {
      /*
       * A rule with no declarations is dropped, and that is what makes the refusal below
       * work. The CSSOM is forgiving: `this is not css at all {{{` parses happily as a
       * selector with an empty body, so counting rules alone would accept nonsense, apply
       * nothing, and quietly replace a stylesheet that had been working.
       */
      const declarations = rule.style.cssText.trim();
      if (declarations) {
        out.push(`${scopeSelector(rule.selectorText)} { ${declarations} }`);
      }
      continue;
    }

    // @media and @supports keep their condition and scope what is inside them.
    if (rule.cssRules && rule.conditionText !== undefined) {
      const inner = scopeRules(rule.cssRules);
      if (inner) {
        const at = rule.constructor.name === 'CSSSupportsRule' ? '@supports' : '@media';
        out.push(`${at} ${rule.conditionText} { ${inner} }`);
      }
      continue;
    }

    // @font-face and @keyframes carry no selector to scope and are harmless as they are.
    if (/^@(font-face|keyframes)/i.test(rule.cssText || '')) {
      out.push(rule.cssText);
    }

    // Anything else — @import above all — is dropped without comment.
  }

  return out.join('\n');
};

/**
 * Returns `{ ok: true, css }` with every rule scoped, or `{ ok: false, reason }` with a
 * message written for a person rather than a log.
 */
export const scopeCustomCss = (input) => {
  const text = String(input || '').trim();

  if (!text) {
    return { ok: true, css: '' };
  }

  let sheet;
  try {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(text);
  } catch (error) {
    return { ok: false, reason: 'That stylesheet could not be parsed' };
  }

  const css = scopeRules(sheet.cssRules);

  /*
   * The CSSOM drops rules it cannot understand instead of complaining, and treats plain
   * nonsense as a selector with an empty body, so "no rule with any declarations survived" is
   * the only reliable signal that the input was not CSS. Refusing beats applying nothing and
   * leaving someone to wonder which half of it worked — or worse, silently replacing a
   * stylesheet that was doing its job.
   */
  if (!css) {
    return { ok: false, reason: 'No usable CSS rules were found in that stylesheet' };
  }

  return { ok: true, css };
};
