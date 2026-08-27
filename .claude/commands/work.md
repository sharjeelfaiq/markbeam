---
description: Pick the next task from tasks.md and complete it (stops before committing)
argument-hint: "[task id, e.g. T3 — omit to take the next one]"
---

Complete one task from `tasks.md`, thoroughly. Stop before committing — `/ship` handles
verification, the ledger and the push.

Task requested: **$ARGUMENTS** (empty means take the next one).

## 1. Select

Read `tasks.md`. If an id was given, take that task. Otherwise take the **first `[ ]` in
file order** — file order is priority order.

If a `[~]` task already exists, resume that instead of starting a new one, and say so.

State which task you're taking and what "Done when" requires, before touching anything.

## 2. Claim it

Change the task's `[ ]` to `[~]` in `tasks.md` immediately, so an interrupted session is
recoverable.

## 3. Understand before changing

Read `CLAUDE.md` for the invariants covering the code path you're about to touch. Several
are load-bearing and non-obvious — the Mermaid version guard and `dataset.mermaidSource`
stash, the dual theme write, the HTML-escape in the Mermaid code-fence renderer, the PDF
banding constants. Breaking one produces a bug that looks unrelated to your change.

Read the actual files before editing. The task's "Approach" is a starting point, not a
specification — if the code contradicts it, trust the code and say so.

## 4. Write the failing test FIRST

Add a regression test in `tests/` following the existing suite shape
(`{ name, run() }` returning `{ name, pass, detail }` entries), then:

**Run it against the unfixed code and confirm it FAILS.**

This is not optional. A test that passes before *and* after the fix proves nothing. It has
already happened in this repo: a Mermaid test used a 45ms typing delay against a 150ms
render debounce, so no intermediate render ever fired and it passed against known-broken
code. Only a before/after comparison caught it.

If the test passes before the fix, the test is wrong. Fix the test, not the expectation.

## 5. Implement

Match the surrounding code — the codebase uses `let name = () => {}` helpers, comments
that explain *why* rather than *what*, and design tokens rather than hardcoded values.

**Never add a `[data-theme="dark"]` override to a component stylesheet.** Add a token to
`src/styles/tokens.css` instead.

## 6. Verify

```
npx vite build --outDir "$TMPDIR/markbeam-check" --emptyOutDir   # never touch dist/
npm test                                                         # needs `npm run dev`
```

Both must pass. Then re-run your new test and confirm it now passes.

For anything visual, take screenshots at 1400px and 375px in both themes and **look at
them**. Assertions do not catch a layout that is technically correct and visually wrong.

## 7. Report and stop

Summarise: what changed, the before/after test evidence, and anything you found that
contradicts `tasks.md` or `CLAUDE.md`.

**Do not commit. Do not push.** Leave the task at `[~]`.

## Constraints — each of these has already cost time in this repo

- **Never edit source while a browser test is running.** Vite hot-reloads mid-run and
  produces results that look real but are not. Wait for the run to finish.
- **`src/styles/preview.css` is re-parsed by the PDF exporter.** CSS the rasteriser cannot
  read breaks export completely while the app itself looks perfect, and no visual check
  catches it. This is why the dependency is `html2canvas-pro`, not `html2canvas`.
- **Work directly on `main`.** No branches, local or remote.
- **`dist/` is gitignored.** Never build into it, never commit build output.
- If the task turns out to be wrong, larger than described, or already done — say so and
  stop. Do not quietly redefine it.
