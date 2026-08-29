<h1>Markbeam</h1>

[![CI](https://github.com/sharjeelfaiq/markbeam/actions/workflows/ci.yml/badge.svg)](https://github.com/sharjeelfaiq/markbeam/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

An online Markdown editor with live preview — **[markbeam.vercel.app](https://markbeam.vercel.app)**

Write on the left, read on the right. No account, no upload: the document lives in your
browser's local storage and never leaves the machine.

## What it does

- **Live preview** — Monaco on the left, rendered Markdown on the right, synced both ways
  as you scroll
- **Mermaid diagrams** — ` ```mermaid ` fences render as you type, with a debounce so a
  half-typed diagram does not flash errors at you
- **Local images** — paste or drop PNG, JPEG and WebP files; they are resized and embedded
  in the Markdown without being uploaded
- **PDF export** — page breaks fall between blocks, so a heading or a table row is never
  sliced in half
- **GitHub-style alerts** — `> [!NOTE]`, `TIP`, `IMPORTANT`, `WARNING`, `CAUTION`
- **Three view modes** — edit, split, read, with a draggable divider
- **Light, dark and system themes**, resolved before first paint so a reload never flashes
- **Command palette** on `Ctrl+K`
- **No third-party requests.** Fonts are self-hosted, there is no analytics tag, and the
  GitHub link in the status bar is an inline SVG rather than a hotlinked badge.

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
npm test -- mermaid  # a single suite: storage | scroll | alerts | editor | mermaid | pdf | ui
```

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
  editor/       Monaco setup and themes
  markdown/     marked + DOMPurify + renderer overrides
  mermaid/      render, debounce, version guard
  export/       PDF export
  ui/           view modes, divider, status bar, toasts, palette
  styles/       tokens.css, app.css, preview.css
```

Every colour, space, radius and duration is a design token in `src/styles/tokens.css`; the
two themes are the same token names with different ramps.

**Read [`CLAUDE.md`](CLAUDE.md) before changing anything.** Several parts of this codebase
look arbitrary and are not — the Mermaid render-version guard, the deliberately
inconsistent dependency loading, and the reason the PDF exporter depends on
`html2canvas-pro` rather than `html2canvas`. Each is documented there with the failure that
produced it.

The backlog lives in [`tasks.md`](tasks.md), ordered by priority, with the root cause and
measurements kept for every completed item.

## Licence

[MIT](LICENSE) © Sharjeel Faiq
