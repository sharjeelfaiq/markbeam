import { Marked, Renderer } from 'marked';
import markedFootnote from 'marked-footnote';
import DOMPurify from 'dompurify';
import { emojiExtension } from './emoji.js';
import { highlightExtension } from './highlight.js';
import { definitionListExtension } from './deflist.js';
import { applyTypography } from './typography.js';
import { displayMathExtension, inlineMathExtension } from './math.js';

/*
 * Markdown → sanitised HTML.
 *
 * Order matters: marked renders, DOMPurify sanitises, and only then does the result
 * reach the DOM. Anything a renderer emits must therefore survive sanitisation.
 */

let escapeHtml = (value) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/*
 * Alert icons.
 *
 * Drawn here rather than transcribed from GitHub's octicons: reproducing exact path data
 * from memory risks subtly wrong artwork, and a dependency for five glyphs is
 * disproportionate. Stroked at 1.4 on a 16 unit grid to match the toolbar icons, and
 * sized in `em` so they track the title text.
 *
 * These pass through DOMPurify before reaching the DOM, so they stay to plain
 * `svg`/`circle`/`path` with a `viewBox` — no external references, no styling that would
 * need the sanitiser relaxed.
 */
const icon = (body) =>
  `<svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const ALERTS = {
  note: {
    label: 'Note',
    icon: icon('<circle cx="8" cy="8" r="6.4"/><path d="M8 7.4v3.8M8 4.9v.5"/>')
  },
  tip: {
    label: 'Tip',
    icon: icon('<path d="M8 1.9a4.1 4.1 0 0 0-2.5 7.4c.4.3.6.8.6 1.3h3.8c0-.5.2-1 .6-1.3A4.1 4.1 0 0 0 8 1.9Z"/><path d="M6.6 12.6h2.8M7 14.2h2"/>')
  },
  important: {
    label: 'Important',
    icon: icon('<path d="M13.6 2.9H2.4a.9.9 0 0 0-.9.9v6.4a.9.9 0 0 0 .9.9h2.1v2.4l2.6-2.4h6.5a.9.9 0 0 0 .9-.9V3.8a.9.9 0 0 0-.9-.9Z"/><path d="M8 5.2v2.6M8 9.3v.5"/>')
  },
  warning: {
    label: 'Warning',
    icon: icon('<path d="M8 2.2 1.6 13.1a.7.7 0 0 0 .6 1.1h11.6a.7.7 0 0 0 .6-1.1Z"/><path d="M8 6.4V9M8 11.2v.5"/>')
  },
  caution: {
    label: 'Caution',
    icon: icon('<path d="M5.4 1.8h5.2l3.6 3.6v5.2l-3.6 3.6H5.4L1.8 10.6V5.4Z"/><path d="M8 4.9v3.2M8 10.6v.5"/>')
  }
};

/*
 * GitHub requires the marker to sit alone on the first line. A marker sharing its line
 * with text is an ordinary blockquote there, so it must stay one here too — hence the
 * required newline or end-of-string.
 */
const ALERT_MARKER = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\n|$)/i;

/*
 * Whether typographic punctuation is on for the render currently in flight.
 *
 * A module-scope flag rather than a fourth and fifth parser: `parse()` is synchronous, so
 * nothing can interleave between setting this and reading it, and doubling the parser count
 * to carry one boolean would be a poor trade.
 */
let typographyEnabled = false;

let createRenderer = () => {
  const renderer = new Renderer();
  const renderCode = renderer.code.bind(renderer);
  const renderBlockquote = renderer.blockquote.bind(renderer);
  const renderText = renderer.text.bind(renderer);

  /*
   * Transform the token's raw text and let marked escape the result — the reverse order
   * would be matching against `&quot;` and finding nothing.
   *
   * A token carrying child tokens is a container; its children arrive here individually, so
   * transforming the container's rendered HTML as well would corrupt any code span inside it.
   */
  renderer.text = (token) => {
    if (!typographyEnabled || (token.tokens && token.tokens.length > 0)) {
      return renderText(token);
    }
    return renderText({ ...token, text: applyTypography(token.text) });
  };

  renderer.blockquote = (token) => {
    const match = ALERT_MARKER.exec(token.text);
    if (!match) {
      return renderBlockquote(token);
    }

    const alert = ALERTS[match[1].toLowerCase()];

    /*
     * The blockquote body has already been tokenized by the active Marked instance. Keep
     * those tokens and remove the marker from the leading paragraph rather than lexing
     * again. That preserves the selected mode inside alerts (tables and strikethrough in
     * GFM, literal syntax in CommonMark) and avoids disturbing the footnote extension's
     * per-parse bookkeeping.
     */
    const bodyTokens = token.tokens.slice();
    const first = bodyTokens[0];

    if (first?.type === 'paragraph') {
      const paragraph = { ...first };
      const paragraphMarker = ALERT_MARKER.exec(paragraph.text);

      if (paragraphMarker) {
        paragraph.raw = paragraph.raw.slice(paragraphMarker[0].length);
        paragraph.text = paragraph.text.slice(paragraphMarker[0].length);
        paragraph.tokens = paragraph.tokens.slice();

        const firstInline = paragraph.tokens[0];
        if (firstInline?.type === 'text') {
          const inlineMarker = ALERT_MARKER.exec(firstInline.raw);
          if (inlineMarker) {
            const trimmedInline = {
              ...firstInline,
              raw: firstInline.raw.slice(inlineMarker[0].length),
              text: firstInline.text.slice(inlineMarker[0].length)
            };
            paragraph.tokens[0] = trimmedInline;
            if (!trimmedInline.raw && !trimmedInline.text) {
              paragraph.tokens.shift();
            }
          }
        }

        if (!paragraph.raw && paragraph.tokens.length === 0) {
          bodyTokens.shift();
        } else {
          bodyTokens[0] = paragraph;
        }
      }
    }

    const content = bodyTokens.length ? renderer.parser.parse(bodyTokens) : '';

    return (
      `<div class="markdown-alert markdown-alert-${match[1].toLowerCase()}">` +
      `<p class="markdown-alert-title">${alert.icon}${alert.label}</p>` +
      `${content}</div>\n`
    );
  };

  renderer.code = (token) => {
    const lang = (token.lang || '').match(/^\S*/)?.[0].toLowerCase();
    if (lang !== 'mermaid') {
      return renderCode(token);
    }

    /*
     * The diagram source is HTML-escaped here because this output passes through
     * DOMPurify before Mermaid ever sees it. Unescaped, a diagram containing markup
     * would be mangled — or stripped — by the sanitiser.
     */
    return `<pre class="mermaid">${escapeHtml(token.text)}</pre>\n`;
  };

  return renderer;
};

const MARKBEAM_EXTENSIONS = [
  emojiExtension,
  highlightExtension,
  displayMathExtension,
  inlineMathExtension,
  // Block-level, so it is consulted before the inline ones and never sees fenced code.
  definitionListExtension
];

/*
 * Marked configuration is mutable, so modes must not share an instance. Otherwise adding
 * footnotes to GFM also teaches the CommonMark path about them, and per-render options are
 * not enough to undo an installed tokenizer. Both instances keep Markbeam's own extensions;
 * only GFM receives marked-footnote.
 */
const createMarkdownParser = ({ gfm, footnotes = false }) => {
  const parser = new Marked();
  parser.setOptions({
    gfm,
    headerIds: false,
    mangle: false,
    renderer: createRenderer()
  });

  parser.use({ extensions: MARKBEAM_EXTENSIONS });
  if (footnotes) {
    parser.use(markedFootnote());
  }

  return parser;
};

const gfmParser = createMarkdownParser({ gfm: true, footnotes: true });
const commonMarkParser = createMarkdownParser({ gfm: false });

export const renderMarkdown = (markdown, mode = 'gfm', { typography = false } = {}) => {
  const parser = mode === 'commonmark' ? commonMarkParser : gfmParser;

  /*
   * Cleared in `finally`, not after the call. A parse that throws would otherwise leave the
   * flag set, and every later render — including ones for documents whose author never turned
   * this on — would silently curl quotes with no way to tell why.
   */
  let html;
  typographyEnabled = typography;
  try {
    html = parser.parse(markdown);
  } finally {
    typographyEnabled = false;
  }

  return DOMPurify.sanitize(html, {
    // KaTeX's accessible MathML tree uses both; keep every other DOMPurify default intact.
    ADD_TAGS: ['semantics', 'annotation']
  });
};
