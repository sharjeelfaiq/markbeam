import { readFileSync } from 'node:fs';

/*
 * `.env` for the live checks, shared by `github.mjs` and `gitlab.mjs`.
 *
 * Read from a file rather than exported by hand, because a token typed into a shell lands in
 * that shell's history and stays there. `.env` is gitignored and is the one place in this repo
 * a credential may sit; `.env.example` documents the shape and holds no value.
 *
 * Parsed rather than pulling in `dotenv`: fifteen lines against a dependency the app does not
 * otherwise need, in a repo that pins what it loads and why.
 *
 * **A real environment variable wins over the file.** A one-off
 * `MARKBEAM_GL_TOKEN=… node tests/live/gitlab.mjs` must not be silently overridden by a stale
 * `.env` — the failure that would cause is a run you believe used one credential while it used
 * another, which is worse than no run at all.
 */
export const loadDotEnv = (from = new URL('../../.env', import.meta.url)) => {
  let body;
  try {
    body = readFileSync(from, 'utf8');
  } catch (error) {
    return; // no .env is perfectly normal
  }

  for (const line of body.split(/\r?\n/)) {
    if (line.trim().startsWith('#')) {
      continue;
    }
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/i.exec(line);
    if (!match || process.env[match[1]]) {
      continue;
    }
    process.env[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
};

/** Shas and commit ids are long; only the first characters are useful, and absent is worth saying. */
export const short = (value) => (value ? String(value).slice(0, 8) : 'absent');

/*
 * The reporting shape both harnesses use. Kept here so a check written in one reads the same in
 * the other, and so the leak guard at the end has the whole log to scan.
 */
export const createReport = () => {
  const log = [];
  const checks = [];

  const say = (line) => {
    log.push(line);
    process.stdout.write(`${line}\n`);
  };

  const check = (name, pass, detail) => {
    checks.push({ name, pass, detail });
    say(`  ${pass ? '✓' : '✗'} ${name}${detail ? `  — ${detail}` : ''}`);
  };

  /*
   * Exits the process, because a live check that reported a failure and returned 0 would be
   * green in a terminal and green in anything reading the exit code — the two places somebody
   * looks.
   */
  const finish = (label, token) => {
    const leaked = token && token.length > 8 && log.join('\n').includes(token);
    check('nothing in this output contains the token', !leaked, leaked ? 'LEAKED' : 'clean');

    const failed = checks.filter((entry) => !entry.pass);
    say('');
    say('────────────────────────────────────────────────');
    say(
      failed.length
        ? `FAIL  ${label} — ${failed.length}/${checks.length} failed`
        : `PASS  ${label} — ${checks.length}/${checks.length}`
    );
    say('────────────────────────────────────────────────');
    say('');
    process.exit(failed.length ? 1 : 0);
  };

  return { say, check, finish };
};
