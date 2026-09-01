# Contributing to Markbeam

Contributions are welcome. Two things to know before you open a pull request, and one of them
is a legal requirement rather than a preference.

## The licence

Markbeam is **AGPL-3.0-only**. In practice that means:

- Use it, read it, fork it, change it — all fine.
- Run it, modified, as a service other people can reach, and you must offer those people the
  source of your modified version (§13). A link in the interface is enough; the status bar's
  *Source* link is exactly that for markbeam.app.
- There is no version of this you can take closed. That is the point of the choice.

It was **MIT until 2026-09-01**. Anything published before that stays MIT for whoever copied
it; the change binds what comes after.

## Sign your commits — DCO

Every commit must carry a `Signed-off-by:` line. Git adds it for you:

```
git commit -s -m "fix: whatever you fixed"
```

That sign-off is you certifying the [Developer Certificate of Origin](https://developercertificate.org/):
that you wrote the change, or have the right to submit it, and that it may be distributed under
this project's licence. You keep your copyright. Nobody is asking you to assign anything.

A pull request without sign-off cannot be merged — not as a formality, but because the
provenance of every line has to be traceable for the licence to mean anything.

## Before you open the pull request

Read **`CLAUDE.md`**. Several parts of this codebase look arbitrary and are not, and each is
documented with the failure that produced it — the Mermaid render-version guard, the deliberate
inconsistency in how dependencies load, why the PDF exporter depends on `html2canvas-pro` rather
than `html2canvas`, and why `src/styles/preview.css` is parsed twice. Changing one of those
without knowing why it is there produces a bug that looks unrelated to your change.

Then:

```
npm install
npm run dev          # in one terminal
npm test             # in another — every suite must pass
```

`npm test` drives real Chrome against the running dev server. There is no linter.

**Write the failing test first, and watch it fail.** A test that passes before *and* after your
change proves nothing, and this repo has been caught by exactly that: a Mermaid test used a 45ms
typing delay against a 150ms render debounce, so no intermediate render ever fired and the test
passed against known-broken code. Only the before/after comparison caught it.

Two more house rules worth stating, because breaking them is silent:

- **Never add a `[data-theme="dark"]` override to a component stylesheet.** Add a token to
  `src/styles/tokens.css`. The PDF exporter produces a light document by setting
  `data-theme="light"` on a cloned DOM, and an override defeats it.
- **Never edit source while a browser test is running.** Vite hot-reloads mid-run and gives you
  results that look real and are not.

## What gets merged

Anything that makes the editor better for people who write Markdown all day, with a test that
proves it. The backlog in `docs/tasks.md` is ordered by priority and records the reasoning
behind every completed change — it is the best guide to what this project considers worth doing
and how carefully it expects things to be done.

If you are unsure whether an idea fits, open an issue before building it.
