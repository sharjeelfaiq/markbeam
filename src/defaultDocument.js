/*
 * The welcome document — the only thing a first-time visitor reads, so it has two jobs at
 * once: name every feature, and demonstrate the syntax while doing it.
 *
 * Two constraints, both enforced by the suites:
 *
 * - It must contain "Welcome to Markbeam" (`tests/editor.test.mjs` checks Reset restores it).
 * - It must contain **exactly one** Mermaid fence (`tests/mermaid.test.mjs` counts one svg).
 *
 * And one that is not enforced but matters more: **do not demonstrate a lazily-loaded
 * feature here.** Math and emoji fetch a chunk the first time a document uses them, and
 * `/about` promises Markbeam "does not fetch things you have never used". A live formula in
 * the welcome text would make every first visit download KaTeX and quietly break that claim.
 *
 * A code span is **not** enough to avoid that: `hasMath()` in `src/markdown/math.js` tests
 * the raw source and knows nothing about code spans, so even ``$x^2$`` inside backticks pulls
 * the chunk. Measured, after writing it that way and watching KaTeX load anyway. Hence the
 * maths line describes the syntax in prose rather than showing a dollar-delimited pair.
 *
 * Mermaid is the deliberate exception, and predates the rule.
 */

export const DEFAULT_DOCUMENT = `# Welcome to Markbeam

Write Markdown on the left, watch it render on the right. Everything stays in your
browser — no account, no upload.

## Start here

| Do this | Press |
| --- | --- |
| Command palette — everything lives in it | <kbd>Ctrl</kbd>+<kbd>K</kbd> |
| Switch editor / split / preview | <kbd>Ctrl</kbd>+<kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> |
| Bold, italic, inline code | <kbd>Ctrl</kbd>+<kbd>B</kbd> <kbd>I</kbd> <kbd>E</kbd> |
| Export a PDF | <kbd>Ctrl</kbd>+<kbd>S</kbd> |

Prefer clicking? The toolbar above the editor does all of the formatting.

## What Markdown you can write

*Italic*, **bold**, \`inline code\`, ~~strikethrough~~, ==highlight==, and
[links](https://markbeam.vercel.app). Footnotes work as well.[^1]

- [x] Task lists
- [ ] Ordered, bulleted and nested lists
- Tables, quotes, and fenced code with syntax highlighting

> [!NOTE]
> GitHub-style callouts — Note, Tip, Important, Warning and Caution.

Wrap TeX in single dollar signs for inline maths, type \`:tada:\` for emoji, and open a
\`mermaid\` fence for a diagram:

\`\`\`mermaid
graph LR
  A[Write] --> B{Markbeam}
  B --> C[Preview]
  B --> D[PDF]
\`\`\`

## What else is here

- **Images** — paste or drop one; it is resized and embedded, never uploaded
- **Outline** — jump between headings of a long document
- **Search** — <kbd>Ctrl</kbd>+<kbd>F</kbd> in this document,
  <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd> across every document you have
- **History** — earlier versions are saved as you pause; restore any of them
- **Several documents** — kept side by side, from the menu beside the title
- **Export** — PDF, HTML, Word, Markdown, or a link that carries the whole document in itself
- **GitHub** — save this document to a repository, or open one from it
- **Offline** — after the first visit it works with no connection, and installs as an app
- **Themes** — light, dark, or whatever your system is set to

Everything above is in the command palette. Clear this text and start writing.

[^1]: Like this one — click the arrow to jump back up.
`;
