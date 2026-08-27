---
description: Verify the in-progress task, mark it done in tasks.md, commit and push
---

Finalize the task currently in progress: verify it actually works, record how to check it
against the reference site, mark it done, commit and push.

## 1. Find the in-progress task

Read `tasks.md` and locate the `[~]` task.

**If there is no `[~]` task, stop and say so.** Do not pick one, do not infer one from the
diff, do not invent one. Report what is uncommitted and let the user decide.

## 2. Verify — this is a gate, not a formality

```
git status --short          # what actually changed
npx vite build --outDir "$TMPDIR/markbeam-check" --emptyOutDir
npm test                    # needs `npm run dev` running
```

**If the build fails, any suite fails, or there are console errors: STOP.**
Do not mark the task done. Do not commit. Do not push. Report the failure with the actual
output and hand back.

Then check the work against the task's own **Done when** criteria, one by one. Review the
diff for anything unrelated that crept in. If a criterion is not met, say which and stop —
partial completion is not completion.

For visual changes, take screenshots at 1400px and 375px in both themes and look at them.

## 3. Write the "Verify vs reference" block

This is the point of the command. The user has repeatedly needed to know what they can see
for themselves, and that answer must live in the repo, not in chat.

Write a block describing:
- what to do on **https://markdownlivepreview.com** (the reference), and what happens
- what to do on **http://localhost:5173** (ours), and what happens instead
- where relevant, an exact console one-liner or measurement rather than a vague impression

Be specific enough to follow without context. Include any precondition that makes the
difference reproducible — for example, Mermaid rendering is debounced 150ms, so typing
fast will not reproduce the error-container bug at all.

If a change genuinely has no user-visible difference (refactor, tooling), say that plainly
instead of inventing one.

## 4. Update the ledger

- Flip `[~]` → `[x]`.
- Move the task into the **Completed** section with today's date, keeping the root cause
  and any measurements — the value is in why it broke, not that it closed.
- Append the "Verify vs reference" block.
- Trim the task body to what stays useful: root cause, measurement, verification. Drop the
  now-redundant Approach.

## 5. Commit and push

Commit code and `tasks.md` **together, in one commit**, so the ledger can never drift from
the code it describes.

Commit message in this repo's established style:
- Subject: what changed, imperative, with the issue number if there is one
- Body: why it was broken — root cause, naming the file and line where it's illuminating
- The measurement or test evidence that proves the fix
- Note any deliberate trade-off or deferred work
- End with:

```
Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
```

Then `git push origin main`.

## 6. Report

Give the pushed commit hash, the verification steps the user can now follow, and what
`/work` will pick up next.

## Constraints

- **Never mark a task done that you have not verified passing.** A green ledger with a
  broken build is worse than an honest red one.
- Push goes to `origin main` — the public product repo. The test suite is the only gate
  between a change and being public, so treat a failing test as a hard stop.
- Never use `--no-verify`, never skip hooks.
- If tests fail for a reason unrelated to this task, report that rather than working
  around it.
