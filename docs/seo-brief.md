# SEO implementation brief

A prompt for an agent working on Markbeam's search visibility. Paste it into a fresh session
on this repo.

Every factual claim below was verified against the repo on 2026-08-28. The last section says
how to re-check them; if any stops matching, update this file before handing it to an agent.

---

You are working on **Markbeam**, a single-page Markdown editor deployed on Vercel. Read
`CLAUDE.md` first and treat its invariants as binding.

## Goal

Improve Markbeam's organic search visibility for Markdown-editor queries by fixing what the
site actually serves to a crawler. Competitor `markdownlivepreview.com` currently outranks it
for "markdown viewer".

**Understand the ceiling before you start.** Product quality is not a ranking signal, and the
site is on `markbeam.vercel.app` — a shared platform subdomain. Until a custom domain is in
place, on-site work has a hard limit on what it can achieve. That domain purchase is the
owner's decision, not yours. Do not pretend the code changes substitute for it.

## Verified starting state — re-confirm before editing, don't re-derive

- `index.html` has `<title>Markbeam</title>` — a brand name with zero query match — and a
  reasonable `<meta name="description">`.
- The served HTML contains **no `<h1>` and no body prose**:
  `curl -s https://markbeam.vercel.app | grep -oiE "<title>[^<]*</title>|<h1[^>]*>"`
- **Absent entirely:** `robots.txt`, `sitemap.xml`, `<link rel="canonical">`, Open Graph and
  Twitter card tags, JSON-LD structured data:
  `grep -rniE "robots|sitemap|canonical|og:|twitter:|ld\+json" index.html public/ vercel.json`
- `public/` holds only `favicon.svg` and `favicon.png`, and Vite copies it verbatim.
- The production alias returns `200` with **no** `X-Robots-Tag: noindex`, so the site is
  already crawlable.
- **No test suite asserts anything about `<head>`.** This work needs a new
  `tests/seo.test.mjs`, registered in `tests/run.mjs`.
- There is a `README.md`; there is no `docs/` besides this file.

## Scope — three tasks, in this order

### Task A · Make the title and metadata match real queries

Rewrite `<title>` and `<meta name="description">` around what people search for rather than
the brand name — e.g. *"Markbeam — Online Markdown Editor with Live Preview"*. Add:

- `<link rel="canonical">`
- Open Graph and Twitter card tags, including a real preview image (add one to `public/`,
  1200×630). Today every share in Slack or on social renders as a bare link.
- JSON-LD `SoftwareApplication` structured data.

**Canonical and sitemap URLs depend on a domain that does not exist yet.** Put the base URL in
exactly one place so switching it later is a one-line change, defaulting to the current
`https://markbeam.vercel.app`.

### Task B · Give a crawler real content, without cloaking and without breaking the app

The page is an app shell: `body` is `height: 100dvh; overflow: hidden`, and the visible text
arrives only after JS renders the welcome document into `#output`.

**Two shortcuts are forbidden.**

1. **No hidden or off-screen keyword text.** That is cloaking and risks a manual penalty —
   strictly worse than the current situation.
2. **Do not break the shell layout.** A visible marketing section bolted into a full-viewport
   editor will wreck it, and `tests/ui.test.mjs` checks the 375px layout for overflow.

The legitimate route: the initial content in `#output` should be **real HTML in the served
markup** — a pre-rendered form of the actual welcome document that the editor takes over on
boot. It is genuine, it is what the user sees, and it is not hidden. Consider also a
`<noscript>` block with the same substance, and a footer carrying real links.

If you conclude a separate static page (`/about`, or a landing page in front of the app) is
the better structure, say so and argue it rather than forcing content into the shell.

### Task C · Crawl plumbing

- `public/robots.txt` — allow crawling, point at the sitemap.
- `public/sitemap.xml` — using the single base URL from Task A.
- Confirm both are served at the root of the build, not from a subdirectory.

## Constraints from CLAUDE.md that this work will touch

- **`index.html` carries an inline pre-paint theme script that must stay synchronous and
  intact.** It duplicates `src/theme.js` on purpose. Do not tidy it, do not move it below
  anything that blocks, and do not let new `<head>` tags delay it.
- Never add a `[data-theme="dark"]` rule to a component stylesheet — add a token to
  `src/styles/tokens.css`.
- `src/styles/preview.css` is re-parsed by the PDF exporter. CSS the rasteriser cannot read
  breaks export while the app looks perfect. If you touch it, `tests/pdf.test.mjs` is the gate.
- `dist/` is gitignored. Build to a scratch dir:
  `npx vite build --outDir <tmp> --emptyOutDir`.
- Work directly on `main`. No branches.

## Workflow — follow the repo's, don't invent one

The backlog is `tasks.md`, in priority order, driven by two commands:

- **`/work`** — claim the task as `[~]`, write a regression test that **fails against the
  unfixed code first**, implement, verify, stop without committing.
- **`/ship`** — re-run build and the full suite as a hard gate, write a "Verify vs reference"
  block, flip to `[x]`, commit code with `tasks.md` in one commit.

A, B and C are separate tasks with their own **Done when** criteria. Do not bundle them.

**The failing test comes first, and watch it fail.** A test that passes before and after
proves nothing — that has happened in this repo more than once. The trap specific to this
work: a check asserting a tag *exists* will often pass against a page that already has some
version of it. Assert the **content**, not the presence.

## Verification

```
npx vite build --outDir "<tmp>/markbeam-check" --emptyOutDir
npm test                       # needs `npm run dev` running
npm test -- seo
```

Then measure what is actually measurable, and report the numbers:

- The **built** `index.html` — not the source — contains the title, canonical, OG tags and
  JSON-LD. Vite transforms `index.html`, so the source is not proof.
- `robots.txt` and `sitemap.xml` are reachable at the root of the build.
- The JSON-LD parses and validates as `SoftwareApplication`.
- A crawler-view diff, before and after:
  `curl -s <url> | grep -oiE "<title>[^<]*</title>|<h1[^>]*>"`
- Lighthouse SEO score before and after, if available.

## Honesty requirements — not optional

- **Never claim a ranking improvement.** Rankings are not observable from this repo and not
  attributable to a commit. Report only what was measured: served markup, validity, scores.
- If a check cannot be proved locally, say so and treat CI as the gate. `CLAUDE.md` records
  three consecutive commits that were green locally and failed in CI on environment
  differences.
- Do not suggest buying links, private blog networks, keyword stuffing, doorway pages or
  hidden text. Beyond being ineffective, those are the specific things that get a site
  penalised, and they would undo the legitimate work.
- Backlinks are the real ranking driver and mostly cannot be done from the codebase. If you
  raise them, be clear they are the owner's work: Show HN, Product Hunt, the GitHub repo,
  `awesome-*` lists, or a write-up of the genuinely interesting engineering here — the PDF
  banding around the browser's ~16384px canvas limit, or the Mermaid print pre-render.
- Set expectations plainly. "markdown viewer" is a broad, established query and will not be
  won quickly. The winnable targets are specific-intent queries where Markbeam is
  differentiated: "markdown editor with mermaid diagrams", "markdown to pdf online",
  "markdown editor with live preview and export".

## Report at the end

Per task: what changed, the before/after test evidence including the failing baseline, the
measured numbers, anything contradicting `tasks.md` or `CLAUDE.md`, and anything deliberately
not done and why.

---

## Re-checking this brief

```
grep -n "<title>" index.html
grep -rniE "robots|sitemap|canonical|og:|twitter:|ld\+json" index.html public/ vercel.json
ls public/
grep -n "title\|meta\|head" tests/ui.test.mjs
curl -sI https://markbeam.vercel.app | grep -iE "^HTTP|x-robots"
```
