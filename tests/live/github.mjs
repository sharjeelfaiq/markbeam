/*
 * The GitHub client, against the real API (T52).
 *
 * Every check in `tests/github.test.mjs` is served from an intercepted fixture, and a fixture
 * agrees with whatever the client sends — so the request *shape* has never been proven. Two
 * claims in particular are ones only GitHub can settle:
 *
 *   - `writeFile()` looks the file up first and sends `sha` **only** when one exists, because
 *     GitHub requires it to replace a file and rejects it when creating. A fixture cannot
 *     confirm either half.
 *   - The 401 path, and that no failure message ever carries the token.
 *
 * **Deliberately not part of `npm test`.** It needs a credential and it writes to a real
 * repository, and a suite that quietly no-ops when an environment variable is missing is the
 * vacuous green this repo keeps catching. Being a separate command means it cannot report
 * success for a run that never happened — and CI, which has no token, never runs it.
 *
 *   # .env in the repo root (gitignored), or real environment variables — either works,
 *   # and an environment variable wins over the file.
 *   MARKBEAM_GH_TOKEN=github_pat_…            # fine-grained, Contents read+write, one repo
 *   MARKBEAM_GH_REPO=you/markbeam-scratch
 *
 *   node tests/live/github.mjs
 *
 * The output carries statuses, shas and file names. It does not carry the token — nothing
 * interpolates it, and the whole log is scanned for it before this exits.
 */

import { readFileSync } from 'node:fs';
import { listMarkdown, parseRepo, readFile, writeFile } from '../../src/github.js';

/** Shas are long and only the first characters are useful; absent is worth saying out loud. */
const short = (value) => (value ? String(value).slice(0, 8) : 'absent');

/*
 * `.env` is read here rather than exported by hand, because a token typed into a shell lands in
 * that shell's history and stays there. `.env` is gitignored (line 68) and is the one place in
 * this repo a credential may sit.
 *
 * Parsed rather than `dotenv`: fifteen lines against a dependency the app does not otherwise
 * need, in a repo that pins what it loads and why. A real environment variable **wins** over
 * the file, so CI or a one-off `MARKBEAM_GH_TOKEN=… node …` is never silently overridden by a
 * stale `.env`.
 */
const loadDotEnv = () => {
  let body;
  try {
    body = readFileSync(new URL('../../.env', import.meta.url), 'utf8');
  } catch (error) {
    return; // no .env is perfectly normal
  }

  for (const line of body.split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/i.exec(line);
    if (!match || line.trim().startsWith('#')) {
      continue;
    }
    const [, key, raw] = match;
    if (process.env[key]) {
      continue;
    }
    process.env[key] = raw.trim().replace(/^(['"])(.*)\1$/, '$2');
  }
};

loadDotEnv();

const TOKEN = process.env.MARKBEAM_GH_TOKEN || '';
const REPO = process.env.MARKBEAM_GH_REPO || '';

/*
 * Deliberately malformed rather than merely wrong: a well-formed token belonging to nobody
 * would still be a credential-shaped string in a log somewhere.
 */
const BAD_TOKEN = 'not-a-real-token-t52';

const log = [];
const say = (line) => {
  log.push(line);
  process.stdout.write(`${line}\n`);
};

const checks = [];
const check = (name, pass, detail) => {
  checks.push({ name, pass, detail });
  say(`  ${pass ? '✓' : '✗'} ${name}${detail ? `  — ${detail}` : ''}`);
};

if (!TOKEN || !REPO) {
  say('');
  say('T52 needs a scratch repository and a token, neither of which lives in this repo:');
  say('');
  say('  export MARKBEAM_GH_TOKEN=github_pat_…      # fine-grained: Contents read+write');
  say('  export MARKBEAM_GH_REPO=you/markbeam-scratch');
  say('  node tests/live/github.mjs');
  say('');
  say('Nothing was run. This is not a pass.');
  process.exit(2);
}

const target = parseRepo(REPO);
if (!target) {
  say(`MARKBEAM_GH_REPO must look like owner/repo — got ${JSON.stringify(REPO)}`);
  process.exit(2);
}

/*
 * Top level, because `listMarkdown()` reads the repository root and that is where the app
 * writes. Stamped so a failed run never collides with the next one.
 */
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const path = `markbeam-live-${stamp}.md`;
const CREATED = `# Created by T52\n\nFirst write, no sha sent.\n`;
const UPDATED = `# Updated by T52\n\nSecond write, sha sent.\n`;

say('');
say(`▸ github live — ${target.owner}/${target.repo}, ${path}`);

let createdSha = null;
let updatedSha = null;

// ---------- create: the branch that must omit `sha` ----------

const created = await writeFile(TOKEN, target, path, CREATED, 'T52: create');
check(
  'create writes a new file',
  created.ok === true,
  created.ok ? 'PUT accepted without a sha' : `status ${created.status}: ${created.reason}`
);

const afterCreate = await readFile(TOKEN, target, path);
createdSha = afterCreate.sha || null;
check(
  'and reading it back returns exactly what was written',
  afterCreate.ok === true && afterCreate.text === CREATED,
  afterCreate.ok
    ? `${afterCreate.text?.length} chars, sha ${short(createdSha)}`
    : `status ${afterCreate.status}: ${afterCreate.reason}`
);

// ---------- update: the branch that must include `sha` ----------

/*
 * The claim fixtures cannot make. GitHub answers a PUT with no sha, onto a path that exists,
 * with 422 — so if `writeFile()` failed to look the file up first, this is where it shows.
 */
const updated = await writeFile(TOKEN, target, path, UPDATED, 'T52: update');
check(
  'update replaces the file, sha and all',
  updated.ok === true,
  updated.ok ? 'PUT accepted with the looked-up sha' : `status ${updated.status}: ${updated.reason}`
);

const afterUpdate = await readFile(TOKEN, target, path);
updatedSha = afterUpdate.sha || null;
check(
  'the content changed and the sha moved with it',
  afterUpdate.ok === true && afterUpdate.text === UPDATED && !!updatedSha && updatedSha !== createdSha,
  afterUpdate.ok
    ? `${short(createdSha)} -> ${short(updatedSha)}`
    : `status ${afterUpdate.status}: ${afterUpdate.reason}`
);

check(
  'readFile reports `id` as the sha, which is what auto-sync compares',
  afterUpdate.id === afterUpdate.sha && !!afterUpdate.id,
  `id ${short(afterUpdate.id)}, sha ${short(afterUpdate.sha)}`
);

// ---------- list ----------

const listed = await listMarkdown(TOKEN, target);
const entry = listed.ok ? (listed.files || []).find((file) => file.path === path) : null;
check(
  'list finds it, with name, path and sha',
  !!entry && !!entry.name && !!entry.sha,
  listed.ok
    ? `${listed.files.length} markdown file(s); ours ${entry ? 'present' : 'MISSING'}`
    : `status ${listed.status}: ${listed.reason}`
);

// ---------- a rejected token ----------

/*
 * Runs against the live API with a token GitHub will refuse. Three things are asserted at once:
 * the failure is reported rather than thrown, the status is the 401 the app's disconnect logic
 * keys on, and the message a user would see carries no part of any credential.
 */
const refusedRead = await readFile(BAD_TOKEN, target, path);
const refusedList = await listMarkdown(BAD_TOKEN, target);
const refusedWrite = await writeFile(BAD_TOKEN, target, `${path}.rejected`, 'nope', 'T52: refused');

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
 * Deleting is done here rather than by adding an endpoint to `src/github.js`: the app never
 * deletes, and product code should not grow a method only a test calls.
 */
let deleted = { ok: !created.ok, detail: created.ok ? 'not attempted' : 'nothing was created' };
if (updatedSha) {
  const response = await fetch(
    `https://api.github.com/repos/${target.owner}/${target.repo}/contents/${encodeURI(path)}`,
    {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ message: 'T52: clean up', sha: updatedSha })
    }
  );
  deleted = { ok: response.ok, detail: `HTTP ${response.status}` };
}

check(
  'the file it created is removed again',
  deleted.ok === true,
  `${deleted.detail}${deleted.ok ? '' : ` — delete ${path} by hand`}`
);

// ---------- the token never reached the output ----------

const leaked = TOKEN.length > 8 && log.join('\n').includes(TOKEN);
check('nothing in this output contains the token', leaked === false, leaked ? 'LEAKED' : 'clean');

const failed = checks.filter((entry) => !entry.pass);
say('');
say('────────────────────────────────────────────────');
say(failed.length ? `FAIL  github live — ${failed.length}/${checks.length} failed` : `PASS  github live — ${checks.length}/${checks.length}`);
say('────────────────────────────────────────────────');
say('');

process.exit(failed.length ? 1 : 0);
