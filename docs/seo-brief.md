# SEO brief — current state

A prompt for an agent working on Markbeam's search visibility. Paste it into a fresh session
on this repo.

This file was originally written on 2026-08-28 as a plan for work that had not started. That
work shipped as **T27** (title and metadata), **T28** (content for crawlers) and **T29**
(robots and sitemap), so the file now describes what the site serves rather than what it
lacks. Re-check the facts below before relying on them; the last section says how.

---

You are working on **Markbeam**, a single-page Markdown editor deployed on Vercel. Read
`CLAUDE.md` first and treat its invariants as binding.

## Goal

Improve Markbeam's organic search visibility for Markdown-editor queries. Competitor
`markdownlivepreview.com` outranks it for "markdown viewer".

**Understand what is left before you start.** Product quality is not a ranking signal. The
platform-subdomain ceiling this brief was written under is **gone**: the site moved to
`markbeam.app` on 2026-08-31 (T58), apex canonical, with the old alias 308ing to it and its
own security headers. What remains is off-site — links and content — and the honest position
is that a fresh domain starts with no history at all, so expect a dip before a rise. Do not
pretend code changes substitute for that.

## What the site serves today — re-confirm, don't re-derive

- `index.html` has `<title>Markbeam — Online Markdown Editor & Viewer with Live Preview</title>` and a
  `<meta name="description">` inside the 50–160 character window search engines display.
- `<link rel="canonical">`, Open Graph and Twitter card tags, and JSON-LD
  `SoftwareApplication` structured data with a `featureList` are all present. The OG image is
  a real 1200×630 `public/og.png`.
- A `<noscript>` block carries an `<h1>` and real prose, so a visitor — or a crawler — without
  JavaScript gets substance rather than an empty shell. It is not cloaking: it says what the
  app says, and Googlebot executes JavaScript and sees the app itself.
- `public/about.html` is a real second page, served at `/about` (`cleanUrls` in
  `vercel.json`), with its own title, canonical, prose and `FAQPage` structured data, linked
  from the app's status bar. **That status-bar link is the only link off the app shell, and it
  stays** — nothing else points at the landing page. `/about` in turn links to the four topic
  pages, which link back to it and to each other, so the static pages are one connected set
  rather than orphans.
- Four topic pages (T61) — `/markdown-viewer`, `/markdown-to-pdf`, `/mermaid-diagrams`,
  `/markdown-slides` — each with its own canonical, description and ~2,000 characters of
  genuine prose. All five static pages share `public/page.css`.
- `public/robots.txt` allows everything and names the sitemap. `public/sitemap.xml` lists all
  six real pages by hand, with `lastmod` set to when the content changed rather than when it
  last deployed.
- The production alias returns `200` with no `X-Robots-Tag: noindex`.
- **`tests/seo.test.mjs` asserts all of the above**, including that the JSON-LD does not
  advertise offline support the app lacks, and that the pre-paint theme script stays inline in
  the `<head>` ahead of the app module. It is registered in `tests/run.mjs` like every other
  suite.

## What is still open

- **The domain move needs watching, not more work.** It shipped; what has not happened yet is
  reindexing. Search Console has to be re-verified for the new property, the sitemap
  resubmitted there, and the old property left in place — its 308s are what pass any accrued
  signal across. Expect the new host to rank worse than the old one did for a while; that is
  what a domain move looks like, not a regression to fix.
- **Backlinks**, which are the real ranking driver and mostly cannot be done from the
  codebase. If you raise them, be clear they are the owner's work: Show HN, Product Hunt,
  `awesome-*` lists, or a write-up of the genuinely interesting engineering here — the PDF
  banding around the browser's ~16384px canvas limit, or the Mermaid print pre-render.
- **Indexation, which has not happened yet.** `site:markbeam.app` returned nothing on
  2026-08-31. Search Console has to be verified for the new property, `sitemap.xml` submitted
  there, and Bing Webmaster Tools is worth the ten minutes — it indexes new domains faster.
- **Content depth.** Six pages as of T61: the app, `/about`, and four topic pages aimed at
  specific intents (`/markdown-viewer`, `/markdown-to-pdf`, `/mermaid-diagrams`,
  `/markdown-slides`). More is fine *if* it is real content someone would read; a page that
  exists to hold a keyword is a doorway page and costs more than it earns.
- **Target the long tail, not "markdown viewer".** That query is held by exact-match domains
  (markdownviewer.org, mdview.io), dillinger.io and aggregators with a decade of links. The
  winnable queries are the differentiated ones — mermaid, markdown-to-pdf, slides, repository
  sync — which is what the topic pages are for.

Changing the domain again means editing the absolute URLs in `index.html`, all five pages in
`public/` (`about.html` and the four topic pages), `public/robots.txt`, `public/sitemap.xml`,
`vercel.json` and `.github/workflows/ci.yml` — which the comment block in `index.html` documents and
`tests/tooling.test.mjs` enforces. There is no build-time substitution: `.env` is gitignored, so Vite's
`%VITE_*%` replacement would ship an undefined canonical, and this project has no
`vite.config.*` and therefore no `transformIndexHtml` hook.

## Constraints from CLAUDE.md that this work touches

- **`index.html` carries an inline pre-paint theme script that must stay synchronous and
  intact.** It duplicates `src/theme.js` on purpose. Do not tidy it, do not move it below
  anything that blocks, and do not let new `<head>` tags delay it — `tests/seo.test.mjs`
  asserts its position relative to the app module.
- Never add a `[data-theme="dark"]` rule to a component stylesheet — add a token to
  `src/styles/tokens.css`.
- `src/styles/preview.css` is re-parsed by the PDF exporter. CSS the rasteriser cannot read
  breaks export while the app looks perfect. If you touch it, `tests/pdf.test.mjs` is the gate.
- Everything under `public/` is site content copied verbatim into the build, which is why
  `paths-ignore` in CI must never list it.
- `dist/` is gitignored. Build to a scratch dir:
  `npx vite build --outDir <tmp> --emptyOutDir`.
- Work directly on `main`. No branches.

## Workflow — follow the repo's, don't invent one

The backlog is `docs/tasks.md`, in priority order, driven by two commands:

- **`/work`** — claim the task as `[~]`, write a regression test that **fails against the
  unfixed code first**, implement, verify, stop without committing.
- **`/ship`** — re-run build and the full suite as a hard gate, write a "Verify vs reference"
  block, flip to `[x]`, commit code with `docs/tasks.md` in one commit.

**The failing test comes first, and watch it fail.** A test that passes before and after
proves nothing — that has happened in this repo more than once. The trap specific to this
work: a check asserting a tag *exists* passes against a page that already has some version of
it. Assert the **content**, not the presence.

## Verification

```
npx vite build --outDir "<tmp>/markbeam-check" --emptyOutDir
npm test                       # needs `npm run dev` running
npm test -- seo
```

Then measure what is measurable, and report the numbers:

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
- Set expectations plainly. "markdown viewer" is a broad, established query and will not be
  won quickly. The winnable targets are specific-intent queries where Markbeam is
  differentiated: "markdown editor with mermaid diagrams", "markdown to pdf online",
  "markdown editor with live preview and export", "markdown slides in the browser".

## Report at the end

What changed, the before/after test evidence including the failing baseline, the measured
numbers, anything contradicting `docs/tasks.md` or `CLAUDE.md`, and anything deliberately not
done and why.

---

## Re-checking this brief

```
grep -n "<title>" index.html public/about.html
grep -rniE "robots|sitemap|canonical|og:|twitter:|ld\+json" index.html public/ vercel.json
ls public/
grep -n "name: '" tests/seo.test.mjs
curl -sI https://markbeam.app | grep -iE "^HTTP|x-robots|strict-transport"
curl -sI https://markbeam.vercel.app | grep -iE "^HTTP|location"   # must 308 to the apex
```
