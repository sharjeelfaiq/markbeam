<h1>Markbeam</h1>

[![CI](https://github.com/sharjeelfaiq/markbeam/actions/workflows/ci.yml/badge.svg)](https://github.com/sharjeelfaiq/markbeam/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

An online Markdown editor with live preview — **[markbeam.app](https://markbeam.app)**

Write on the left, read on the right. No account: the document lives in your browser's
local storage and stays there unless you connect a GitHub or GitLab repository yourself.

## What it does

- **Live preview** — Monaco on the left, rendered Markdown on the right, synced both ways
  as you scroll
- **Mermaid diagrams** — ` ```mermaid ` fences render as you type, with a debounce so a
  half-typed diagram does not flash errors at you
- **Local images** — paste or drop PNG, JPEG and WebP files; they are resized and embedded
  in the Markdown without being uploaded
- **PDF export** — page breaks fall between blocks, so a heading or a table row is never
  sliced in half
- **Table editing** — add and remove rows and columns and change a column's alignment from
  the palette, with the cursor in the table. The source is rewritten aligned, and a cell
  containing a pipe stays escaped
- **Presentation mode** — `---` separates slides; present full-screen with the arrow keys, or
  export the deck as a PDF with one landscape page per slide
- **GitHub-style alerts** — `> [!NOTE]`, `TIP`, `IMPORTANT`, `WARNING`, `CAUTION`
- **The rest of the syntax** — footnotes, task lists, `==highlight==`, `:emoji:` shortcodes,
  definition lists, `[TOC]` with links that survive every export, KaTeX maths, and optional
  typographic punctuation. GitHub-Flavored by default, CommonMark when you ask for it
- **Several documents** — grouped into folders, with cross-document search on
  `Ctrl+Shift+F`, an outline, an autosave history per document, and a seven-day trash that
  keeps a deleted document *and* its snapshots
- **Every export** — PDF, print, standalone HTML, HTML to the clipboard with table borders
  intact, Word, Markdown, and a share link that carries the whole document in the URL
  fragment rather than on a server
- **Custom preview CSS** — scoped to the preview and carried into the HTML and Word exports.
  The PDF excludes it on purpose: that export rasterises the page, and CSS its renderer
  cannot parse yields a blank document rather than an error
- **Three view modes** — edit, split, read, with a draggable divider
- **Light, dark and system themes**, resolved before first paint so a reload never flashes
- **Offline, and installable** — a service worker serves a second visit with no connection,
  and Markbeam offers to install itself once you have actually used it: never on arrival,
  never twice after you decline, and always available from the palette
- **Command palette** on `Ctrl+K`
- **GitHub and GitLab sync** — save the open document to a repository, or open one from it,
  with a scoped token you supply, and publish to a secret or public Gist. Manual by default.
  **Automatic sync is opt-in**: once on, a document you have already saved is resent when you
  pause typing — never one you have not saved there yourself, and never on a blind timer
- **Conflicts are never merged** — if the remote moved since you last wrote it, both versions
  are kept as separate documents and you pick. Nothing is overwritten
- **No third-party requests unless you ask for one.** Fonts are self-hosted, there is no
  analytics tag or cookie, and no page the app serves carries an external image, badge or
  link — the status bar links only to `/about`, on this origin. Page-speed measurements
  (Web Vitals, no visitor identity, nothing about your document) are collected on this domain
  in production only. The only outbound calls are the ones repository sync makes,
  after you connect a repository — on demand, or on a pause in typing if you switched
  automatic sync on.

## Getting started

```
make setup      # npm install
make dev        # vite dev server on :5173
make build      # production build into dist/
make preview    # serve the built output
make clean      # rm -rf dist
```

Requires Node 22+.

## Tests

The suites drive a real Chrome against a **running dev server** — Monaco, Mermaid and
canvas rasterisation cannot be meaningfully tested without one.

```
npm run dev          # in one terminal
npm test             # in another — runs every suite
npm test -- mermaid  # substring match on a suite name; several names may be given
```

Every file in `tests/` ending `.test.mjs` is a suite, registered in `tests/run.mjs`. The
filter is a substring of the suite's own `name`, so `npm test -- "auto sync" present` runs
those two.

Override `CHROME_PATH` or `MARKBEAM_URL` if your setup differs. There is no linter.

## Architecture

A single page, no framework. `src/main.js` is wiring only: it holds the small amount of
mutable app state and connects modules that do not import each other, communicating
through subscription functions (`onThemeChange`, `onViewModeChange`, `onMermaidRender`)
rather than shared state.

```
src/
  main.js       entry + wiring
  theme.js      light/dark/system resolution
  storage.js    persistence and legacy migrations
  history.js    autosave snapshots; trash.js  deleted documents, seven days
  share.js      document <-> URL fragment codec
  images.js     paste/drop decode, resize to WebP, embed
  customCss.js  user stylesheet, parsed and scoped to the preview
  github.js     gitlab.js  remote clients; remoteAuth.js  the tokens
  autoSync.js   when a bound document may be resent, and what a conflict does
  editor/       Monaco setup and themes
  markdown/     marked + DOMPurify + renderer overrides, incl. table.js
  mermaid/      render, debounce, version guard
  export/       PDF (pages and slides), HTML, Word, download
  ui/           view modes, divider, status bar, toasts, palette, sheets,
                present (the slide overlay)
  styles/       tokens.css, app.css, preview.css
```

Every colour, space, radius and duration is a design token in `src/styles/tokens.css`; the
two themes are the same token names with different ramps.

**Read [`CLAUDE.md`](CLAUDE.md) before changing anything.** Several parts of this codebase
look arbitrary and are not — the Mermaid render-version guard, the deliberately
inconsistent dependency loading, and the reason the PDF exporter depends on
`html2canvas-pro` rather than `html2canvas`. Each is documented there with the failure that
produced it.

The backlog lives in [`docs/tasks.md`](docs/tasks.md), ordered by priority, with the root cause and
measurements kept for every completed item.

## Licence

[MIT](LICENSE) © Sharjeel Faiq
