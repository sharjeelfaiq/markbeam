import { getTheme } from '../theme.js';
import { renderMermaidDiagrams, renderMermaidForTheme } from '../mermaid/index.js';

/*
 * Standalone document exports: a single HTML file, and a Word-openable variant.
 *
 * This is the opposite problem to `html.js`. That one inlines table styles because a paste
 * target strips stylesheets; a file can carry its own `<style>`, which is both simpler and
 * covers every element rather than just tables.
 *
 * **The Word file is `.doc`, not `.docx`.** It is HTML served with Word's MIME type — Word,
 * Pages and Google Docs all open it and keep the headings, tables and styling. Real OOXML
 * would mean a 4.65 MB dependency plus hand-mapping the markdown AST to its object model,
 * and Mermaid and KaTeX would be dropped on the way. Naming it `.docx` would be a lie the
 * file itself would eventually tell, so the label says `.doc` everywhere.
 */

/*
 * The app's own rules, read back out of the live stylesheets rather than duplicated here.
 *
 * Two sheets matter: the token ramps and the preview typography. They are identified by
 * what they define rather than by filename, because the built CSS is bundled and renamed.
 * Reading them back is what stops an exported file drifting from what the preview actually
 * looks like.
 */
let collectStyles = () => {
  const wanted = [];

  for (const sheet of Array.from(document.styleSheets)) {
    let rules;
    try {
      rules = sheet.cssRules;
    } catch (error) {
      // A cross-origin sheet cannot be read; none of ours are, so skipping is correct.
      continue;
    }
    if (!rules) {
      continue;
    }

    const text = Array.from(rules)
      .map((rule) => rule.cssText)
      .join('\n');

    /*
     * KaTeX's sheet is collected too, and not only for looks: it carries the rule that
     * hides the MathML layer. Without it, every formula renders twice — once laid out and
     * once as raw MathML text beside it. That shipped in the first version of this export
     * and no assertion caught it; only opening the file did.
     */
    if (text.includes('--beam:') || text.includes('.mb-md') || text.includes('.katex')) {
      wanted.push(text);
    }
  }

  return wanted.join('\n');
};

/*
 * The token ramp, read out of the CSSOM rather than off an element (T69).
 *
 * **A probe element cannot be used here, and the obvious version of this fix is wrong.** The
 * light ramp is declared under `:root[data-theme='light']` in `src/styles/tokens.css`, and
 * `:root` matches only `<html>` — so a detached `<div data-theme="light">` inherits whatever the
 * live document is set to, which is dark most of the time. Resolving against that would bake
 * dark colours into a file destined for white paper, silently.
 *
 * Flipping `document.documentElement` to light for the duration is the other obvious route, and
 * is worse: it flashes the entire app while somebody exports.
 */
let readTokens = () => {
  const tokens = new Map();

  const absorb = (rule) => {
    const style = rule.style;
    for (let i = 0; i < style.length; i += 1) {
      const name = style.item(i);
      if (name.startsWith('--')) {
        tokens.set(name, style.getPropertyValue(name).trim());
      }
    }
  };

  for (const sheet of Array.from(document.styleSheets)) {
    let rules;
    try {
      rules = sheet.cssRules;
    } catch (error) {
      continue; // cross-origin, same as collectStyles()
    }
    if (!rules) {
      continue;
    }

    /*
     * Matched by pattern, not by string equality. **The CSSOM re-serialises selectors**, so
     * `[data-theme='light']` as written in `tokens.css` comes back as `[data-theme="light"]`,
     * and an exact comparison quietly matches only the base `:root` rule — which holds the
     * spacing and typography tokens but none of the colours. The symptom is an export that
     * looks *mostly* resolved: 60 of 99 substituted, every remaining one a colour, which is
     * precisely the set that matters for table borders.
     */
    const selectorOf = (rule) => String(rule.selectorText || '');
    const isLight = (rule) => /:root\[data-theme=['"]light['"]\]/.test(selectorOf(rule));
    const isBase = (rule) => /(^|,)\s*:root\s*(,|$)/.test(selectorOf(rule)) || /:root\[data-theme=['"]dark['"]\]/.test(selectorOf(rule));

    // Base first, then the light overrides, so light wins wherever both define a name.
    for (const rule of Array.from(rules)) {
      if (rule.style && isBase(rule)) {
        absorb(rule);
      }
    }
    for (const rule of Array.from(rules)) {
      if (rule.style && isLight(rule)) {
        absorb(rule);
      }
    }
  }

  return tokens;
};

/*
 * `color-mix()` is handed to the browser rather than implemented here. There is one use today
 * (`preview.css`, the alert border), and mixing sRGB by hand is a small pile of arithmetic with
 * a subtly wrong answer at the end. The probe is offscreen and removed immediately — the same
 * shape the PDF sandbox uses.
 */
let resolveColorMix = (value) => {
  if (!value.includes('color-mix(')) {
    return value;
  }

  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;left:-10000px;top:0;pointer-events:none';
  document.body.appendChild(probe);

  try {
    return value.replace(/color-mix\([^()]*(?:\([^()]*\)[^()]*)*\)/g, (expression) => {
      probe.style.color = '';
      probe.style.color = expression;
      const computed = getComputedStyle(probe).color;
      // An expression the browser also refuses leaves the original text, which is no worse.
      return computed && computed !== '' ? computed : expression;
    });
  } finally {
    probe.remove();
  }
};

/*
 * Custom properties substituted into concrete values, for consumers that cannot resolve them.
 *
 * Tokens reference tokens — `--editor-bg: var(--void)` — so this runs to a fixed point rather
 * than once. The pass limit is a stop for a cycle rather than an expected depth; two passes
 * cover everything the ramp does today.
 */
let resolveTokens = (css) => {
  const tokens = readTokens();
  let out = css;

  for (let pass = 0; pass < 6 && out.includes('var(--'); pass += 1) {
    out = out.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g, (whole, name, fallback) => {
      const value = tokens.get(name);
      if (value) {
        return value;
      }
      return fallback !== undefined ? fallback.trim() : whole;
    });
  }

  return resolveColorMix(out);
};

let escapeHtml = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

/*
 * Light theme, fixed. An exported file lands on someone else's white page, and the same
 * reasoning already governs the PDF exporter and the clipboard HTML.
 */
let shell = ({ title, styles, body, wordNamespace = false }) => {
  const htmlTag = wordNamespace
    ? '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/1999/xhtml" data-theme="light">'
    : '<html lang="en" data-theme="light">';

  return `<!doctype html>
${htmlTag}
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
${styles}
body { margin: 0; padding: 2rem; background: #ffffff; }
.mb-md { max-width: 48rem; margin: 0 auto; }
</style>
</head>
<body>
<div class="markdown-body mb-md">
${body}
</div>
</body>
</html>`;
};

/*
 * Mermaid bakes theme colours into the SVG it emits, so a diagram exported from dark mode
 * arrives as black boxes on the white page. The PDF exporter has the same problem and
 * solves it the same way: re-render light, take the markup, restore.
 *
 * Diagrams still need no rasterisation here — unlike the PDF path, inline SVG survives
 * into an HTML file intact.
 */
let withLightDiagrams = async (build) => {
  const restoreDark = getTheme() === 'dark';
  try {
    await renderMermaidDiagrams('default');
    return build();
  } finally {
    if (restoreDark) {
      renderMermaidForTheme('dark');
    }
  }
};

/*
 * **The two paths resolve differently on purpose, and the asymmetry is the point.**
 *
 * The HTML file below is opened in a browser, which resolves `var(--…)` perfectly well, so it
 * carries the tokens exactly as the app defines them and stays honest to the preview.
 *
 * The Word file is opened by an engine that supports neither custom properties nor
 * `color-mix()`, and drops whole declarations it cannot parse — table borders and header
 * shading among them (T69). So that path, and only that path, is flattened.
 */

/** The rendered preview as one self-contained HTML file. */
export const buildStandaloneHtml = (outputElement, title) =>
  withLightDiagrams(() =>
    shell({
      title: title || 'Untitled',
      styles: collectStyles(),
      body: outputElement ? outputElement.innerHTML : ''
    })
  );

/** The same document, wrapped so Word opens it. */
export const buildWordDocument = (outputElement, title) =>
  withLightDiagrams(() =>
    shell({
      title: title || 'Untitled',
      styles: resolveTokens(collectStyles()),
      body: outputElement ? outputElement.innerHTML : '',
      wordNamespace: true
    })
  );
