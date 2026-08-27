/*
 * Copy the rendered preview as styled HTML.
 *
 * Pasting into Outlook, Word or Gmail carries markup and nothing else — the receiving
 * application never sees `src/styles/preview.css`, so anything that matters must be
 * written into inline `style` attributes before the copy.
 *
 * Only table styling is inlined. Headings, lists, emphasis and code paste as semantic HTML
 * and every target renders those acceptably on its own; tables are the case that collapses
 * into an unreadable grid without borders, padding and header shading.
 */

/*
 * Deliberately absent from this list: `display`, `width` and `overflow`.
 *
 * `.mb-md table` is `display: block; width: max-content; overflow: auto` so that a wide
 * table scrolls sideways inside the preview pane. Inlined into the clipboard that stops
 * being a table at all — the receiving application stacks the rows and scatters the
 * borders. Left off, the paste target applies its own `display: table` default, which is
 * the behaviour we want. This is not an oversight; do not "complete" the list.
 */
const CELL_PROPERTIES = ['border', 'padding', 'background-color', 'font-weight', 'text-align'];

const STYLED_SELECTOR = 'table, thead, tbody, tr, th, td';

/** A computed background of `rgba(0, 0, 0, 0)` means "inherit the page", not "paint black". */
let isTransparent = (colour) => !colour || colour === 'transparent' || /,\s*0\)$/.test(colour);

let isZeroLength = (value) => !value || /^0(px)?( 0(px)?)*$/.test(value.trim());

let meaningful = (property, value) => {
  if (!value) {
    return false;
  }
  if (property === 'background-color') {
    return !isTransparent(value);
  }
  if (property === 'border') {
    return !/(^|\s)0px(\s|$)/.test(value) && !value.includes('none');
  }
  if (property === 'padding') {
    return !isZeroLength(value);
  }
  /*
   * `font-weight: 400` and `text-align: start` are the computed defaults every element
   * reports. Writing them onto each table, thead and tr triples the size of the copied
   * markup and changes nothing in the paste.
   */
  if (property === 'font-weight') {
    return value !== '400' && value !== 'normal';
  }
  if (property === 'text-align') {
    return value !== 'start';
  }
  return true;
};

/*
 * An offscreen copy of the preview, in the document so that styles resolve against it.
 * Mirrors the sandbox in `pdf.js`, minus the page-slicing machinery this does not need.
 */
let createSandbox = (outputElement) => {
  const sandbox = document.createElement('div');
  sandbox.id = 'html-copy-sandbox';
  sandbox.style.cssText = 'position:fixed;left:-10000px;top:0;pointer-events:none';

  const content = document.createElement('div');
  // Carries `markdown-body mb-md`, so `.mb-md table th` and friends still match.
  content.className = outputElement.className;

  for (const child of Array.from(outputElement.childNodes)) {
    content.appendChild(child.cloneNode(true));
  }

  sandbox.appendChild(content);
  document.body.appendChild(sandbox);

  return { sandbox, content };
};

export const buildStyledHtml = (outputElement) => {
  if (!outputElement) {
    return '';
  }

  const { sandbox, content } = createSandbox(outputElement);
  const root = document.documentElement;
  const previousTheme = root.getAttribute('data-theme');

  try {
    /*
     * Tokens are defined on `:root[data-theme='light']`, so setting the attribute on the
     * sandbox would not re-resolve them — it has to go on the document element. Copying in
     * dark mode would otherwise inline a near-black table onto the paste target's white
     * page.
     *
     * Everything between this flip and the restore below must stay SYNCHRONOUS. A paint
     * only happens between tasks, so with no `await` in the middle the user never sees a
     * light frame; add one and the page visibly flashes on every copy.
     */
    root.setAttribute('data-theme', 'light');

    // Read every declaration before writing any, so an inline style written onto one node
    // can never influence what is measured on the next.
    const elements = Array.from(content.querySelectorAll(STYLED_SELECTOR));
    const declarations = elements.map((element) => {
      const computed = window.getComputedStyle(element);
      const pairs = CELL_PROPERTIES.filter((property) =>
        meaningful(property, computed.getPropertyValue(property))
      ).map((property) => [property, computed.getPropertyValue(property)]);

      // Only the table itself needs it, and it is what joins the cell borders up.
      if (element.tagName === 'TABLE') {
        pairs.push(['border-collapse', computed.getPropertyValue('border-collapse')]);
      }

      return { element, pairs };
    });

    declarations.forEach(({ element, pairs }) => {
      pairs.forEach(([property, value]) => element.style.setProperty(property, value));
    });

    return content.innerHTML;
  } finally {
    if (previousTheme === null) {
      root.removeAttribute('data-theme');
    } else {
      root.setAttribute('data-theme', previousTheme);
    }
    sandbox.remove();
  }
};

export const copyPreviewAsHtml = async (outputElement) => {
  const html = buildStyledHtml(outputElement);

  if (!html) {
    throw new Error('Nothing to copy');
  }

  // ClipboardItem is what carries a rich flavour; without it the best available is the
  // markup as text, which is what the plain-text flavour holds anyway.
  if (typeof ClipboardItem === 'function' && navigator.clipboard && navigator.clipboard.write) {
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([html], { type: 'text/plain' })
      })
    ]);
  } else {
    await navigator.clipboard.writeText(html);
  }

  return html;
};
