/*
 * The `[TOC]` marker.
 *
 * A contents list *in the document*, unlike the outline sheet from T35 — which is why it
 * reaches the HTML and Word exports and the PDF, and the outline never could.
 *
 * The extension cannot see the document's headings by itself: marked tokenizes the whole
 * input before rendering anything, and a block tokenizer only ever sees the text from its own
 * position onward. So `renderMarkdown` lexes first, collects the headings with their slugs,
 * and hands them in through `getHeadings` — the same two-phase shape the heading ids rely on,
 * and the reason a `[TOC]` at the top of a file can list headings that come after it.
 */

const MARKER = /^\[TOC\][ \t]*(?:\n|$)/i;

/** Escapes text for an attribute or a text node; the render still passes through DOMPurify. */
let escapeHtml = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/*
 * Nested `<ul>`s built from heading depth. Levels are followed rather than assumed: a document
 * that jumps from `#` to `###` should not produce an empty intermediate list, and one that
 * starts at `##` should not be indented against nothing.
 */
let renderList = (headings) => {
  if (headings.length === 0) {
    return '<p class="mb-toc__empty">No headings yet</p>';
  }

  const base = Math.min(...headings.map((heading) => heading.depth));
  let html = '';
  let depth = base;
  let open = 0;

  html += '<ul>';
  open += 1;

  headings.forEach((heading) => {
    while (heading.depth > depth) {
      html += '<ul>';
      open += 1;
      depth += 1;
    }
    while (heading.depth < depth && open > 1) {
      html += '</ul>';
      open -= 1;
      depth -= 1;
    }

    html += `<li><a href="#${escapeHtml(heading.slug)}">${escapeHtml(heading.text)}</a></li>`;
  });

  while (open > 0) {
    html += '</ul>';
    open -= 1;
  }

  return html;
};

/**
 * `getHeadings` returns `[{ depth, text, slug }]` for the render currently in flight.
 */
export const createTocExtension = (getHeadings) => ({
  name: 'tableOfContents',
  level: 'block',

  start(src) {
    const match = /^\[TOC\]/im.exec(src);
    return match ? match.index : undefined;
  },

  tokenizer(src) {
    const match = MARKER.exec(src);
    if (!match) {
      return undefined;
    }
    return { type: 'tableOfContents', raw: match[0] };
  },

  renderer() {
    // `nav` rather than `div`: it is navigation, and screen readers should be told so.
    return `<nav class="mb-toc" aria-label="Table of contents">${renderList(getHeadings())}</nav>\n`;
  }
});
