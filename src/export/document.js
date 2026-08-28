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
      styles: collectStyles(),
      body: outputElement ? outputElement.innerHTML : '',
      wordNamespace: true
    })
  );
