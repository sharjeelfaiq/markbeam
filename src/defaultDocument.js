/*
 * The welcome document — the only thing a first-time visitor reads, so it has two jobs at
 * once: name every feature, and demonstrate the syntax while doing it.
 *
 * It is a tour rather than a greeting because nothing else in the app lists what the app can
 * do. The palette holds every command but only shows them one search at a time, and a feature
 * nobody knows about may as well not have shipped.
 *
 * Three constraints, two enforced by the suites:
 *
 * - It must contain "Welcome to Markbeam" (`tests/editor.test.mjs` checks Reset restores it).
 * - It must contain **exactly one** Mermaid fence (`tests/mermaid.test.mjs` counts one svg).
 * - **No `$…$` pair anywhere, including inside backticks.** `hasMath()` in
 *   `src/markdown/math.js` tests the raw source and knows nothing about code spans, so even
 *   ``$x^2$`` inside backticks pulls the KaTeX chunk. Measured, after writing it that way and
 *   watching KaTeX load anyway. `/about` promises Markbeam "does not fetch things you have
 *   never used", so the maths line describes the syntax in prose instead.
 *
 * Mermaid is the deliberate exception to that last rule, and predates it. `:emoji:` is not an
 * exception at all: `loadEmoji()` runs at boot regardless of what the document contains.
 *
 * There is deliberately **no `---`** in here. It would render as a horizontal rule, and it
 * would also cut the document into slides in presentation mode — a tour that presents as
 * three unrelated decks is worse than one that presents as a single slide.
 */

export const DEFAULT_DOCUMENT = `# Welcome to Markbeam

Write Markdown on the left, watch it render on the right. Everything stays in your
browser — no account, no upload, nothing to sign up for.

[TOC]

## Start here

| Do this | Press |
| --- | --- |
| Command palette — every feature below lives in it | <kbd>Ctrl</kbd>+<kbd>K</kbd> |
| Switch editor / split / preview | <kbd>Ctrl</kbd>+<kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> |
| Bold, italic, inline code | <kbd>Ctrl</kbd>+<kbd>B</kbd> <kbd>I</kbd> <kbd>E</kbd> |
| Find in this document | <kbd>Ctrl</kbd>+<kbd>F</kbd> |
| Search every document | <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd> |
| Export a PDF | <kbd>Ctrl</kbd>+<kbd>S</kbd> |

Prefer clicking? The toolbar above the editor does all of the formatting. Along the top
right there are three buttons: **Copy** for the Markdown source, **Export** for every
format Markbeam can produce, and the one that opens the palette.

## What you can write

*Italic*, **bold**, \`inline code\`, ~~strikethrough~~, ==highlight==, and
[links](https://markbeam.app). Footnotes work as well.[^1] Shortcodes like
:tada: become emoji, and \`[TOC]\` — the list above — builds itself from your headings
and links to them, in the preview, the PDF, the HTML and the Word export alike.

- [x] Task lists
- [ ] Ordered, bulleted and nested lists
- Tables, quotes, and fenced code with syntax highlighting

Definition lists, from Markdown Extra:

Markdown
: Plain text that reads fine as plain text.

Markbeam
: The thing rendering it half a second after you type it.

> [!NOTE]
> GitHub-style callouts — Note, Tip, Important, Warning and Caution.

For maths, wrap TeX in single dollar signs for an inline formula, or a pair of them on
their own lines for a display block; KaTeX renders it. Open a \`mermaid\` fence for a
diagram:

\`\`\`mermaid
graph LR
  A[Write] --> B{Markbeam}
  B --> C[Preview]
  B --> D[PDF]
  B --> E[Slides]
\`\`\`

Two parsers are available: GitHub-Flavored Markdown by default, and stricter CommonMark
when you want it — *Switch to CommonMark* in the palette. **Typographic
punctuation** — curly quotes, en dashes, ellipses — is off until you turn it on, because
it rewrites what you typed.

## Editing, not just writing

- **Format toolbar** — headings, lists, quotes, code, links and tables, above the editor
- **Table editor** — put the cursor in a table, then *Table: add row*, *add column*,
  *remove* either, or *change column alignment*. The source is rewritten aligned, and one
  <kbd>Ctrl</kbd>+<kbd>Z</kbd> undoes the whole change
- **Find and replace** — <kbd>Ctrl</kbd>+<kbd>F</kbd> and <kbd>Ctrl</kbd>+<kbd>H</kbd>
- **Search every document** — <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd>, with matches
  in context
- **Outline** — jump between the headings of a long document
- **Sync scroll** — the two panes follow each other, either way; turn it off from the
  status bar

## Your documents

- **Several at once** — the menu beside the title, and folders to group them. That menu also
  renames the open document, moves it to a folder, empties it, or deletes it
- **History** — versions are snapshotted as you pause; restore any of them
- **Trash** — a deleted document keeps its history and comes back for seven days, and the
  toast that announces the deletion offers **Undo** on the spot
- **Images** — paste or drop PNG, JPEG or WebP; each one is resized in your browser and
  embedded in the Markdown, never uploaded. Documents are capped at 1 MiB so one
  screenshot cannot evict your saved versions
- **Open a file** — drop a \`.md\` file anywhere on the window, or pick one from the palette

## Getting it out again

The **Export** button holds six of these — PDF, slides as PDF, an HTML file, rendered HTML
on the clipboard, Word and Markdown — so none of them is hidden behind a shortcut. Printing
and share links are in the palette.

- **PDF** — page breaks fall between blocks, so a heading, table row or diagram is never
  sliced in half
- **Print** — the document, not the app: no toolbar, no editor pane, light background
  whatever theme you use
- **Slides** — separate them with three dashes on their own line, then *Present slides…*
  for a full-screen deck with arrow keys, or *Export slides as PDF…* for one landscape
  page per slide
- **HTML** — a standalone file with its styles inlined, or copied to the clipboard with
  table borders intact so it survives a paste into an email
- **Word** (\`.doc\`) **and Markdown** — the original source, unchanged
- **Share link** — the whole document is compressed into the URL itself, so the link works
  without anything being stored on a server
- **Custom preview CSS** — your own stylesheet, scoped to the preview, applied to the HTML
  and Word exports too. The PDF ignores it on purpose: that export rasterises the page, and
  CSS its renderer cannot read produces a blank document rather than an error

## Repositories, if you want them

- **GitHub and GitLab** — save this document to a repository, or open one from it, with a
  scoped token you supply. The token is kept only until the tab closes unless you ask
  otherwise
- **Gists** — publish to a secret or public Gist; the link lands on your clipboard
- **Automatic sync** — off until you switch it on. Once on, it resends only a document you
  have *already* saved to a repository, only after you change it, and only when you pause —
  never a document you have not sent there yourself, and never on a blind timer
- **Conflicts are never merged** — if the file moved in the repository since you last wrote
  it, both versions are kept as separate documents and you choose. Nothing is overwritten

## Everything else

- **Status bar** — words, characters, reading time and where the cursor is, and a dot that
  says when the document was last saved. It saves on every keystroke, so that dot is
  reassurance rather than a button
- **Themes** — light, dark, or whatever your system is set to, resolved before the page
  paints so a reload never flashes the wrong one
- **Offline** — after the first visit it works with no connection. *Install Markbeam* in the
  palette gives it its own window, on a desktop or a phone home screen
- **On a phone** — below about 900 pixels the two panes become tabs, so you switch between
  writing and reading instead of splitting a narrow screen
- **Nothing is uploaded** — no account, no tracking, no font CDN. Outbound requests are the
  ones a repository you connected makes, plus anonymous page-speed timings that say nothing
  about you or this document
- **Open source** — AGPL-3.0. The *Source* link in the status bar goes to the code, and it
  is there because the licence requires anyone running a modified Markbeam as a service to
  offer their users the same thing

Everything above is in the command palette. When you are ready, *Clear document* empties
this one — or *Reset to welcome document* brings this text back if you want it again.

[^1]: Like this one — click the arrow to jump back up.
`;
