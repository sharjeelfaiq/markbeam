/*
 * The GitLab client, against the real API (T63).
 *
 * T52 did this for GitHub and found the client correct. GitLab is the riskier of the two and
 * was still fixture-only, and a fixture agrees with whatever the client sends. Four claims here
 * only GitLab can settle:
 *
 *   - `writeFile()` sends **PUT first** and falls back to **POST** on 400 or 404
 *     (`src/gitlab.js:144`), because GitLab splits create and update across two verbs and
 *     answers a POST onto an existing file with 400 rather than 404. For a *new* file that
 *     means the PUT is expected to fail and the POST to succeed — the reverse of how "create"
 *     usually reads, and the single most valuable thing to watch happen for real.
 *   - The branch is hardcoded to `main` (`:16`). A project defaulting to `master` would fail
 *     every read and write, and the symptom is an unexplained 404, so this script asks GitLab
 *     what the default actually is and says so before anything else runs.
 *   - `readFile()` reports `last_commit_id` as `id` (`:136`) — the value auto-sync compares to
 *     decide whether the remote moved.
 *   - The 401 path, and that no failure message ever carries the token.
 *
 * **Deliberately not part of `npm test`**, for the reasons `github.mjs` states: it needs a
 * credential and writes to a real project, and a suite that no-ops without one would report
 * success for a run that never happened. CI has no token and never runs it.
 *
 *   # .env in the repo root (gitignored), or real environment variables, which win over it
 *   MARKBEAM_GL_TOKEN=glpat-…                 # project access token with `api` scope if your
 *                                             # plan offers them — a personal token is
 *                                             # account-wide, so keep its life short
 *   MARKBEAM_GL_PROJECT=you/markbeam-scratch
 *
 *   node tests/live/gitlab.mjs
 */

import { listMarkdown, parseProject, readFile, writeFile } from '../../src/gitlab.js';
import { createReport, loadDotEnv, short } from './env.mjs';

loadDotEnv();

const API = 'https://gitlab.com/api/v4';
const TOKEN = process.env.MARKBEAM_GL_TOKEN || '';
const PROJECT = process.env.MARKBEAM_GL_PROJECT || '';

/** Malformed rather than merely wrong — see the note in `github.mjs`. */
const BAD_TOKEN = 'not-a-real-token-t63';

const { say, check, finish } = createReport();

if (!TOKEN || !PROJECT) {
  say('');
  say('T63 needs a scratch project and a token, neither of which lives in this repo:');
  say('');
  say('  MARKBEAM_GL_TOKEN=glpat-…                 # project access token, `api` scope');
  say('  MARKBEAM_GL_PROJECT=you/markbeam-scratch');
  say('  node tests/live/gitlab.mjs');
  say('');
  say('Nothing was run. This is not a pass.');
  process.exit(2);
}

const project = parseProject(PROJECT);
if (!project) {
  say(`MARKBEAM_GL_PROJECT must look like group/project — got ${JSON.stringify(PROJECT)}`);
  process.exit(2);
}

const route = `${API}/projects/${encodeURIComponent(project.path)}`;
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const path = `markbeam-live-${stamp}.md`;
const CREATED = `# Created by T63\n\nPUT should fail here, POST should carry it.\n`;
const UPDATED = `# Updated by T63\n\nPUT should carry this one.\n`;

say('');
say(`▸ gitlab live — ${project.path}, ${path}`);

// ---------- the hardcoded branch, before anything that depends on it ----------

/*
 * Asked first because it explains everything after it. `src/gitlab.js` hardcodes `main`, so a
 * project whose default is `master` fails every read and write with a 404 that looks like a
 * missing file rather than a wrong branch — and somebody would spend an afternoon on that.
 */
const projectInfo = await fetch(route, {
  headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' }
})
  .then((response) => (response.ok ? response.json() : null))
  .catch(() => null);

const defaultBranch = projectInfo?.default_branch || null;
check(
  'the project default branch is `main`, which the client assumes',
  defaultBranch === 'main',
  defaultBranch
    ? `default_branch=${defaultBranch}${defaultBranch === 'main' ? '' : ' — the client hardcodes `main`, so every call below will 404'}`
    : 'could not read the project — check the token scope and the project path'
);

// ---------- create: PUT is expected to fail, POST to succeed ----------

const created = await writeFile(TOKEN, project, path, CREATED, 'T63: create');
check(
  'create writes a new file, via the POST fallback',
  created.ok === true,
  created.ok ? 'accepted' : `status ${created.status}: ${created.reason}`
);

const afterCreate = await readFile(TOKEN, project, path);
const createdId = afterCreate.id || null;
check(
  'and reading it back returns exactly what was written',
  afterCreate.ok === true && afterCreate.text === CREATED,
  afterCreate.ok
    ? `${afterCreate.text?.length} chars, last_commit_id ${short(createdId)}`
    : `status ${afterCreate.status}: ${afterCreate.reason}`
);

// ---------- update: the PUT branch ----------

const updated = await writeFile(TOKEN, project, path, UPDATED, 'T63: update');
check(
  'update replaces the file, via PUT',
  updated.ok === true,
  updated.ok ? 'accepted' : `status ${updated.status}: ${updated.reason}`
);

const afterUpdate = await readFile(TOKEN, project, path);
const updatedId = afterUpdate.id || null;
check(
  'the content changed and `id` moved with it',
  afterUpdate.ok === true && afterUpdate.text === UPDATED && !!updatedId && updatedId !== createdId,
  afterUpdate.ok
    ? `${short(createdId)} -> ${short(updatedId)}`
    : `status ${afterUpdate.status}: ${afterUpdate.reason}`
);

check(
  '`id` comes from last_commit_id, which is what auto-sync compares',
  !!updatedId && updatedId !== afterUpdate.content_sha256,
  `id ${short(updatedId)}`
);

// ---------- list ----------

/*
 * `listMarkdown()` returns `{ name, path }` and drops GitLab's tree `id`, unlike the GitHub
 * client which carries `sha`. Asserted as the code is, not as the task description guessed.
 */
const listed = await listMarkdown(TOKEN, project);
const entry = listed.ok ? (listed.files || []).find((file) => file.path === path) : null;
check(
  'list finds it, with name and path',
  !!entry && !!entry.name && !!entry.path,
  listed.ok
    ? `${listed.files.length} markdown file(s); ours ${entry ? 'present' : 'MISSING'}`
    : `status ${listed.status}: ${listed.reason}`
);

// ---------- a rejected token ----------

const refusedRead = await readFile(BAD_TOKEN, project, path);
const refusedList = await listMarkdown(BAD_TOKEN, project);
const refusedWrite = await writeFile(BAD_TOKEN, project, `${path}.rejected`, 'nope', 'T63: refused');

check(
  'a rejected token fails with 401 rather than throwing',
  refusedRead.ok === false &&
    refusedList.ok === false &&
    refusedWrite.ok === false &&
    refusedRead.status === 401 &&
    refusedList.status === 401,
  `read ${refusedRead.status}, list ${refusedList.status}, write ${refusedWrite.status ?? 'n/a'}`
);

check(
  'and the message it produces names no credential',
  ![refusedRead.reason, refusedList.reason, refusedWrite.reason]
    .join(' ')
    .match(new RegExp(`${BAD_TOKEN}|${TOKEN.slice(0, 8)}`, 'i')),
  JSON.stringify(refusedRead.reason)
);

// ---------- cleanup ----------

/*
 * In the script rather than in `src/gitlab.js`: the app never deletes, and product code should
 * not grow an endpoint only a test calls. GitLab wants the branch and a commit message on the
 * delete, which is the same asymmetry with GitHub the client exists to absorb.
 */
let deleted = { ok: !created.ok, detail: created.ok ? 'not attempted' : 'nothing was created' };
if (created.ok) {
  const response = await fetch(`${route}/repository/files/${encodeURIComponent(path)}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ branch: 'main', commit_message: 'T63: clean up' })
  });
  deleted = { ok: response.ok, detail: `HTTP ${response.status}` };
}

check(
  'the file it created is removed again',
  deleted.ok === true,
  `${deleted.detail}${deleted.ok ? '' : ` — delete ${path} by hand`}`
);

finish('gitlab live', TOKEN);
