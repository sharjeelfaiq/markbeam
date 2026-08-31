# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Markbeam — an online Markdown editor with live preview.

`LICENSE` is MIT, copyright Sharjeel Faiq alone. That is accurate rather than asserted:
the project began as a fork, and every piece of derived material has since been replaced —
most substantially the vendored github-markdown-css, which `src/styles/preview.css` was
written from scratch to displace. **Before adding third-party code, check whether its
licence obliges an attribution this file no longer carries.** The check is

```
git ls-files | grep -vE "package-lock|^CLAUDE\.md$|^docs/tasks\.md$" \
  | xargs grep -lI -i "tanabe\|hideaki\|sindre\|sorhus"
```

which must stay empty. The two exclusions are this file and `docs/tasks.md`: both quote the
names in the check itself, so without them the command always reports a false alarm. The
exclusions are anchored paths, so **moving either file means editing this regex** — that is how
the ledger's move out of the repo root was caught.

Legacy `com.markdownlivepreview` storage keys still exist in real users' browsers and are
migrated on load — see `migrateLegacyStorage()` in `src/storage.js`. Those strings are a
compatibility path for people's saved documents, not leftover attribution; removing them
would silently discard the work of anyone arriving from the original site.

## Workflow

The backlog lives in **`docs/tasks.md`**, ordered by priority — file order is priority
order. Two project commands drive it:

- **`/work`** — takes the next `[ ]` task (or a named one), marks it `[~]`, writes a
  regression test that must **fail against the unfixed code first**, implements, verifies,
  and stops without committing.
- **`/ship`** — re-runs the build and suite as a hard gate, records how to verify the
  change against the reference site (markdownlivepreview.com), flips the task to `[x]`,
  and commits `docs/tasks.md` together with the code before pushing to `origin main`.

Committing the ledger with the code is deliberate: it cannot drift from what shipped.

## Commands

```
make setup            # npm install
make dev              # vite dev server on :5173
make build            # vite build -> dist/
make preview          # vite preview of dist/
make build-serve      # build, then serve dist/ on :5001
make clean            # rm -rf dist

npm test              # all browser suites  (needs `npm run dev` running)
npm test -- mermaid   # one suite: mermaid | pdf | ui
```

`npm test` drives real Chrome against a **running dev server** — start `npm run dev`
first, or the runner exits telling you so. Override `CHROME_PATH` or `MARKBEAM_URL` when
your setup differs. There is no linter.

To build without disturbing anything, use a scratch output dir:
`npx vite build --outDir /tmp/check --emptyOutDir`.

There is no `vite.config.*`; Vite defaults apply (root = repo root, entry = `index.html`,
`public/` copied verbatim).

## Architecture

Single page, no framework. `src/main.js` is wiring only — it holds the app's mutable state
(`scrollSync`, `docTitle`, `exporting`) and connects modules that do not import each other:

```
src/
  main.js            entry + wiring — ~900 lines, and growing
  defaultDocument.js welcome text
  theme.js           light/dark/system resolution + the print theme swap
  storage.js         all persistence (plain keys) + legacy migrations
  history.js         autosave snapshots: cadence, thinning, byte budget
  share.js           document <-> URL fragment codec
  openFile.js        reading and validating a dropped or picked file
  images.js          paste/drop decode, resize to WebP, base64 embed
  documentLimits.js  the 1 MiB per-document ceiling images are measured against
  trash.js           deleted documents and their history, kept for seven days
  customCss.js       user stylesheet, parsed and scoped to the preview
  github.js          Contents API client — list, read, write, Gists. No DOM, no storage.
  gitlab.js          the same three calls against GitLab's Repository Files API
  remoteAuth.js      where the remote tokens live, and for how long — one slot per provider
  editor/            Monaco setup + markbeam-dark/light themes
  markdown/          marked + DOMPurify + renderer overrides, math, emoji, highlight
  mermaid/           lazy load, render, 150ms debounce, version guard, print copies
  export/            pdf.js (banding), html.js, document.js (Word), download.js
  ui/                viewmode, divider, statusbar, toasts, palette, documents,
                     history, stamp, formatToolbar, outline, remote, gist, style
  styles/            tokens.css, app.css, preview.css (imported by main.js)
tests/               browser suites + run.mjs
```

Modules communicate through small subscription functions rather than shared state:
`onThemeChange`, `onViewModeChange`, `onMermaidRender`. Reach for those before adding a
cross-module import.

### Data flow

Monaco `onDidChangeModelContent` → `convert()` in `main.js` → `renderMarkdown()`
(`marked.parse` → `DOMPurify.sanitize`) → `#output.innerHTML` → `scheduleMermaidRender()`.
Every keystroke also persists via `saveContent()` and updates the status bar.

### Design tokens

Every colour, space, radius and duration is a CSS custom property in
`src/styles/tokens.css`; the two themes are the same token names with different ramps.
**Do not add a `[data-theme="dark"]` override to a component stylesheet — add a token.**
There are exactly **two** places the ramp is duplicated, both unavoidable, and a token
change has to be carried into both:

- `src/editor/themes.js` — Monaco takes concrete hex values, not custom properties.
- `public/about.html` and the `<noscript><style>` block in `index.html` — `public/` is
  copied verbatim without passing through Vite, so it cannot import `tokens.css`; and every
  stylesheet is imported by `src/main.js`, so with scripting disabled the page has no CSS at
  all. Both hold ~6 values behind a `prefers-color-scheme` query. The alternative was a
  `vite.config.js` with a second Rollup input, which would reverse the no-config decision
  below.

### Dependency loading is deliberately inconsistent — respect it

- **Monaco** is imported from a hard-pinned CDN ESM URL
  (`cdn.jsdelivr.net/npm/monaco-editor@0.52.2/+esm`), *not* from `node_modules`, so Vite
  never bundles it. The `package.json` entry pins the version to match that URL **and** now
  supplies one real asset: the codicon icon font, imported with `?url` in
  `src/editor/index.js`. So the version lives in three places — the CDN URL, the
  `package.json` entry, and that import resolving out of `node_modules`. Keep all three in
  step.

  **The font has to be self-hosted, and this is not cosmetic.** Monaco's own stylesheet asks
  for it relatively (`src: url(./codicon.ttf)`), and the `+esm` build injects that CSS as a
  `<style>` tag, so the URL resolves against *the document* rather than the CDN — the browser
  fetches `/codicon.ttf` from our origin. That does not 404: the dev server answers with
  `index.html` (200, ~29 KB), so there is no failed request and no console error, and the font
  silently never parses. Every icon in the find widget is a distinct glyph of that one family,
  so they all render as the same box. Removing the `@font-face` override brings that straight
  back, invisibly.

  Note that `document.fonts.check('16px codicon')` is **not** a usable signal here: Monaco's
  broken face stays in the document, so the family always has one face that never loads.
  `tests/editor.test.mjs` asserts that *some* codicon face reached `loaded` instead.
  `self.MonacoEnvironment.getWorker` returns a no-op `Proxy` — **Monaco runs with zero web
  workers**, so anything worker-backed (real markdown validation, background tokenization)
  silently does nothing.
  Monaco also **stops propagation on any keydown it binds**, so a global shortcut that
  collides with a Monaco default never reaches the `document` listener in
  `src/ui/palette.js` while the editor has focus. `Ctrl/Cmd+K` is one — Monaco holds it as
  a chord prefix — and is re-claimed by an `editor.addCommand` in `src/editor/index.js`.
  Add a colliding shortcut in both places or it will only work when the editor is blurred.
- **jspdf** and **html2canvas-pro** are npm dependencies `import()`ed lazily inside the
  export handler, so they cost nothing until Export PDF is clicked. It is
  `html2canvas-pro`, **not** `html2canvas` — see PDF export below. Both replaced a CDN
  `html2pdf` bundle that exposed neither library as a global and left export permanently
  broken whenever the CDN was blocked.
- Fonts are self-hosted via `@fontsource` and imported in `main.js` — no font CDN.

### Pre-paint theme script

`index.html` carries an inline script that resolves the theme and injects the preview
stylesheet **before first paint**, so a reload never flashes the wrong theme. It duplicates
logic in `src/theme.js` on purpose: it must be synchronous and cannot wait for a module.
Change one, change the other.

### Persistence

Everything goes through `src/storage.js`. Keys are **plain and readable** —
`markbeam:last_state`, `markbeam:doc:<id>`, `markbeam:history:<id>` — each holding a JSON
`{ v: value }` envelope. An earlier build delegated to a third-party library that hashed
every key (MD5 of `namespace-key`); that is gone, and anything still describing keys as
hashed is out of date.

**Images live inside the document text**, as base64 WebP produced by `src/images.js`. That is
what makes `MAX_DOCUMENT_BYTES` in `src/documentLimits.js` load-bearing rather than
decorative: a document is capped at 1 MiB, and without that cap a single screenshot would
exceed the entire 512 KB budget `history.js` sweeps against, evicting every snapshot the user
has. The alternative was an external image host, which would have broken the "nothing is
uploaded" promise `public/about.html` makes. Raise the cap and the history sweep stops
meaning anything.

Deleted documents go to a **separate** bucket with its own cap (`src/trash.js`: 10 entries,
256 KiB, seven days) rather than into the history budget. Sharing one budget would mean deleting
a document could evict the snapshots of documents still open — the loss T22 exists to prevent,
reached from the other side.

Read and write through `storage.js` anyway, not because the keys are opaque but because it
carries the migrations, the `{ v }` envelope and the `toBoolean()` normalisation. The tests
are the deliberate exception: they assert against real key names, which is only possible
because the names are stable.

### Remote tokens — the only credentials this app holds

`src/remoteAuth.js` owns them and is the only module that may. The rules below are security
properties, not style, and each one is a thing a later change breaks by accident:

**One slot per provider, never one slot.** GitHub and GitLab hold separate tokens under
separate keys (`markbeam:<provider>_token`). A single slot was the shape before T48, and a
second provider turns it into a bug that stays invisible until it matters: connecting one
silently signs you out of the other, discoverable only by trying to save and being asked to
connect again. For the same reason `disconnect()` takes a provider and forgets only that
one — a token GitLab rejected says nothing about a GitHub one.

- **Memory by default.** The token lives in a module-scope variable and dies with the tab.
  It reaches `localStorage` only when the user ticks *remember on this device*. This is not
  caution for its own sake: `readSharedPayload()` renders **attacker-controlled Markdown** in
  this origin, and DOMPurify is the only thing between that and script execution. Nothing to
  read is a better position than something to read.
- **`Authorization` header, never a URL.** A URL reaches browser history, the `Referer` of
  anything it links to, and every log in between. `src/github.js` and `src/gitlab.js` build
  every request; keep the credential out of the path and the query. GitLab identifies a project
  by a URL-encoded path, so the route carries a project name — never a token.
- **Never logged, never toasted, never in an error.** `describeFailure()` composes messages
  from the status code and GitHub's own text for exactly this reason.
- **Never in a document.** `src/history.js` snapshots document text up to twenty times, so a
  token that leaks into the document is a token persisted twenty times over. `tests/github.test.mjs`
  seeds a token and *then* asserts its absence from documents, history and the URL — asserting
  absence before a token exists proves nothing, which is how that check would rot.
- **A 401 disconnects.** A token the service has rejected is worthless and must not sit
  there looking like a working connection.

Both clients are covered only by intercepted fixtures — neither has ever met the real API.
That is T52, and it is a known gap rather than an oversight.

Sync is deliberately **manual**: two palette commands, no background traffic. That is what
makes the claim on `/about` — nothing leaves your browser unless you connect a repository —
checkable by watching the network panel rather than merely asserted.

Theme is stored twice: `saveThemePreference()` writes the namespaced preference *and* the
bare `markbeam:theme` string the pre-paint boot script reads, since that script cannot parse
JSON before first paint. `com.markdownlivepreview_theme` is read as a fallback for visitors
arriving from the original site. Keep both writes or dark mode flashes light on reload.

The preference is tri-state (`light` / `dark` / `system`); `loadThemePreference()` migrates
the booleans and bare strings earlier builds wrote — hence `toBoolean()`. Use it for any new
persisted boolean.

### Mermaid rendering

`createRenderer()` (`src/markdown/index.js`) overrides `renderer.code` so ```` ```mermaid ````
fences become `<pre class="mermaid">` with **HTML-escaped** text. The escape is required
because that output passes through DOMPurify before Mermaid ever sees it.

In `src/mermaid/index.js`:

- `configure()` sets **`suppressErrorRendering: true`** and every render is cleaned up in a
  `finally`. Without it, `mermaid.render` throws on a parse error *before* reaching its own
  `removeTempElements()`, stranding a `d<renderId>` container in `<body>`. Since nearly
  every keystroke mid-diagram fails to parse, those containers used to stack up until they
  covered the page.
- Render ids must stay **deterministic** (`mermaid-<version>-<index>`). A `Date.now()` id
  defeats Mermaid's own id-matching cleanup of stale containers.
- `renderMermaidNow()` guards races with a module-scope `renderVersion` counter re-checked
  after **every** `await`; a stale pass bails out.
- Because `innerHTML` is replaced by the SVG, the source is stashed on
  `element.dataset.mermaidSource` so theme switches can re-render.

Preserve the version guard, the dataset stash, and the deterministic ids when editing this
path. `tests/mermaid.test.mjs` covers all of it.

### PDF export

`exportPreviewToPdf()` clones `#output` into an **offscreen fixed-width sandbox** (720px,
so output does not depend on the split-divider position), computes page boundaries that
fall between top-level blocks (`computePageOffsets`), groups pages into **bands** of up to
6 pages / 6000px (`groupPagesIntoBands`), rasterises one band per `html2canvas-pro` call,
and cuts pages out of the band bitmap with `drawImage` (`cropPageFromBand`).

Two failure modes shaped this design, both of which shipped at some point:

1. **Blank pages.** Rasterising a long document as a single canvas exceeds the browser's
   ~16384px canvas limit and silently returns an empty bitmap — the PDF downloads fine and
   every page is white. Hence one bounded canvas per page.
2. **Clone cost.** The rasteriser clones the whole document on *every* call, so one call
   per page made long exports scale badly — a 69-page document once took over five
   minutes. Banding cuts the number of calls ~6×. Measured now: 18 pages / 3.2s,
   35 pages / 5.5s, 69 pages / ~20s. Within a run, page crops cost ~0.05s and the band
   rasterisation ~1.2s, so the band call is the whole cost — that is the number to watch
   if export ever slows down again.

Mermaid is force-rendered in the `'default'` theme before cloning and restored in
`finally`; the cloned document gets light colours via `onclone`, so the PDF is always
light-themed without the user seeing the page change.

**User CSS is switched off for the duration of the export.** The sandbox carries `mb-md`,
so a preview-scoped user stylesheet applies to it and the rasteriser re-parses it — which is
exactly the blank-document failure described below. `exportPreviewToPdf()` disables
`#markbeam-user-css` and restores it in `finally`. Excluded rather than validated: no allowlist
is as trustworthy as not handing the rasteriser the sheet at all, and the `#style` sheet says
so to the user rather than letting them discover it from a blank PDF.

**`onclone` may change colours and nothing else.** Page offsets are measured against the
live sandbox, so a rule there that alters layout moves the content away from the boundaries
the crops were computed for. An svg width clamp used to live in `onclone` for exactly this
reason and was removed.

**Mermaid SVGs are converted to `<img>` before rasterising** (`rasteriseMermaidDiagrams`),
and this must happen *before* `computePageOffsets` so measurement matches what is drawn.
html2canvas renders an inline `<svg>` itself and draws Mermaid's output larger than its
laid-out box, clipping the right-hand side inside the svg's own viewport — measured at
340px drawn of a 458px-wide diagram, losing two nodes. The DOM geometry is correct
throughout, so no CSS fixes it; setting explicit `width`/`height` attributes and stripping
Mermaid's inline `max-width` were both tried and changed nothing. Handing the rasteriser a
bitmap avoids its SVG path entirely.

#### The preview stylesheet is re-parsed by the exporter

**`src/styles/preview.css` is parsed twice: once by the browser, once by the PDF
rasteriser.** CSS the rasteriser cannot understand breaks export completely while the app
itself looks perfect — and no visual check catches it.

This is why the dependency is `html2canvas-pro`: the original `html2canvas`'s colour parser
predates modern CSS colour syntax and throws
`Attempting to parse an unsupported color function "color"` on `color-mix()`, which
`preview.css` uses. **Do not "simplify" that dependency back.**

`tests/pdf.test.mjs` treats console errors during export as a failure specifically to catch
this class of bug.

### Preview styling

`src/styles/preview.css` defines the rendered-Markdown pane **in full**. It previously sat
on top of a vendored copy of github-markdown-css and only overrode its look; that
third-party stylesheet is gone, so this file now owns every element.

Both themes resolve through tokens in `src/styles/tokens.css`. **Never add a
`[data-theme="dark"]` rule to a component stylesheet — add a token.** That is not a style
preference: it is what lets the PDF exporter produce a light document by setting
`data-theme="light"` on its cloned DOM, and what removed the runtime stylesheet swap
(`#gh-markdown-link`), the `?v=` cache-bust strings and a `fetch` in the export path.

Selectors are prefixed `.mb-md`, carried by `#output` and by the PDF export clone.

Alert accent colours are `--alert-*` tokens, tuned to the Beam palette rather than
transcribed from GitHub. `tests/alerts.test.mjs` asserts the five are *distinct*, which is
what proves the CSS actually binds rather than the class names merely being present.

## Testing

Suites live in `tests/`, each exporting `{ name, run() }` returning an array of
`{ name, pass, detail }`. `tests/run.mjs` aggregates them.

Three rules learned the hard way here:

- **Run a new regression test against the unfixed code first and watch it fail.** A test
  that passes before *and* after proves nothing. One mermaid test did exactly that: its
  typing delay was shorter than the 150ms render debounce, so no intermediate render ever
  fired and the bug never reproduced.
- **Never edit source while a browser test is running.** Vite hot-reloads mid-run and
  produces results that look real but are not.
- **A green local run does not predict CI.** Three consecutive commits went out green here
  and failed in CI, each on an environment difference rather than a product bug:

  1. The host's **colour scheme**. The default theme preference is `system`; a dark
     workstation resolves dark and a headless Linux runner resolves light, so a suite that
     never pins the theme measures a different app in each place. Pin it — write
     `markbeam:theme_settings` before the reload, as `tests/print.test.mjs` does.
  2. **Timing around CDP emulation.** `page.emulateMediaType(null)` resolving does not mean
     the page's `matchMedia` listeners have run. Anything depending on that must
     `waitForFunction` on the state it is about to measure, never `sleep`.
  3. **Readiness signals that are never written.** An early return that skips the code
     setting a signal turns any wait on it into a hang. Mirror readiness onto the DOM and
     write it on *every* exit path.

  Where a check cannot be proved locally, say so and treat the CI run as the gate rather
  than reporting the fix as verified.

## Deployment

Vercel builds from source (`vercel.json`, framework `vite`). **`dist/` is gitignored** — do
not commit build output.

`.github/workflows/ci.yml` gates deployment on the suite: `verify` → `check-secrets` →
`deploy`, and a push to `main` only reaches Vercel if every suite passed. The smoke test at
the end curls **the production alias** (`markbeam.vercel.app`), never the per-deployment URL
that `vercel deploy` prints — deployment URLs on a team sit behind Vercel's Deployment
Protection and answer an anonymous request with a 302 to SSO, or a 404 in the window right
after deploy. Pointing the check at one produced a hard CI failure on a deployment that was
live and healthy. Likewise `--scope` takes the team **slug**, not the org id.

**Documentation-only pushes do not trigger the pipeline.** `paths-ignore` on both `push` and
`pull_request` covers `README.md`, `CLAUDE.md`, `LICENSE`, `docs/**` (which is where the
ledger now lives) and `.gitignore`. The ledger is committed alongside every shipped task, so those pushes are
frequent, and a nine-minute browser suite plus a production deploy prove nothing about them.

Three things to know before editing that list:

- **Never add `public/**` or a blanket `**/*.md`.** Everything under `public/` is site content
  copied verbatim into the build — `public/about.html` is a real page — so ignoring it would
  silently skip deploying a content change.
- **The two lists are duplicated on purpose.** GitHub Actions does not support YAML anchors,
  so `&docs` / `*docs` fails to parse. Keep them in step by hand.
- `paths-ignore` creates **no run at all**, not a green one. Harmless while work goes straight
  to main; if branch protection ever requires "Build and test", a docs-only PR would block on
  a check that never runs. `workflow_dispatch` is kept so a run can be forced.

All work happens directly on `main`. No feature branches, locally or on the remote.

## Resume Claude Code Session

- claude --resume 50bedfcf-b2ec-454d-83b2-e6ae8ab1a68b
