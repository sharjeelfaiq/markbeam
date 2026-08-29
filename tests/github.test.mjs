import { withPage, sleep, seedDocument } from './lib.mjs';

/*
 * GitHub sync (T37).
 *
 * The first feature that makes Markbeam hold a credential, which is why most of this suite is
 * about the token rather than about syncing.
 *
 * Every `api.github.com` call is fulfilled from a fixture. The suite must never contact GitHub
 * and must never need a real token — otherwise it cannot run in CI, and a test that only runs
 * on one machine is a test nobody runs. The interception pattern is the one in
 * `tests/math.test.mjs`.
 *
 * Two checks here are easy to write vacuously, and both have a precedent in this repo:
 *
 *   - "the token is in no history snapshot" passes trivially when there is no token concept
 *     at all. Every such check seeds a token *first* and then asserts absence, so it can only
 *     pass because the code kept the token out, not because nothing existed to leak.
 *   - "hostile remote content renders inert" would pass on a build that never fetched
 *     anything. It is gated on the document having actually been imported.
 */

const TOKEN = 'ghp_fixtureTokenNeverReal000000000000000';
const REPO = 'octocat/notes';
const API = 'https://api.github.com';

const REMOTE_FILES = [
  { name: 'roadmap.md', path: 'roadmap.md', type: 'file', sha: 'sha-roadmap' },
  { name: 'notes.md', path: 'notes.md', type: 'file', sha: 'sha-notes' },
  { name: 'logo.png', path: 'logo.png', type: 'file', sha: 'sha-logo' },
  { name: 'drafts', path: 'drafts', type: 'dir', sha: 'sha-drafts' }
];

const REMOTE_BODY = '# Roadmap\n\nPulled from the repository.';

/*
 * The same payload the share-link suite uses for its hostile document. Remote content is no
 * more trustworthy than a link somebody sent you.
 */
const HOSTILE = [
  '# Hostile remote',
  '',
  '<img src=x onerror="window.__pwned = true">',
  '<script>window.__pwned = true;<\/script>',
  '[click](javascript:window.__pwned=true)'
].join('\n');

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');

/**
 * Fulfils every GitHub API call from fixtures and records what was asked for.
 * `overrides` maps a substring of the URL to `{ status, body }`.
 */
const interceptGitHub = async (page, { overrides = {}, contents = REMOTE_BODY } = {}) => {
  const seen = [];
  await page.setRequestInterception(true);

  page.on('request', (request) => {
    const url = request.url();

    if (!url.startsWith(API)) {
      request.continue();
      return;
    }

    const record = {
      url,
      method: request.method(),
      headers: request.headers(),
      body: request.postData() || ''
    };
    seen.push(record);

    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,PUT,POST,OPTIONS',
      'Access-Control-Allow-Headers': '*'
    };

    // A cross-origin PUT with Authorization and JSON provokes a preflight first.
    if (record.method === 'OPTIONS') {
      request.respond({ status: 204, headers: cors });
      return;
    }

    const override = Object.keys(overrides).find((key) => url.includes(key));
    if (override) {
      const { status, body } = overrides[override];
      request.respond({
        status,
        headers: { ...cors, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      return;
    }

    const json = (status, body) =>
      request.respond({
        status,
        headers: { ...cors, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

    // Directory listing.
    if (/\/contents\/?(\?|$)/.test(url)) {
      json(200, REMOTE_FILES);
      return;
    }

    // A single file.
    if (url.includes('/contents/')) {
      if (record.method === 'PUT') {
        json(200, { content: { path: 'saved.md', sha: 'sha-new' }, commit: { sha: 'commit' } });
        return;
      }
      json(200, {
        name: 'roadmap.md',
        path: 'roadmap.md',
        sha: 'sha-roadmap',
        encoding: 'base64',
        content: Buffer.from(contents, 'utf8').toString('base64')
      });
      return;
    }

    json(404, { message: 'Not Found' });
  });

  return seen;
};

const boot = async (page, markdown = '# Local document\n\nUntouched.', title = 'Local') => {
  await seedDocument(page, markdown, title);
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForFunction(() => !!document.querySelector('#editor .monaco-editor'), {
    timeout: 30000
  });
  await sleep(1800);
};

/** Runs a palette command by visible title. False when the command does not exist. */
const runCommand = async (page, title) => {
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyK');
  await page.keyboard.up('Control');
  await sleep(400);

  const clicked = await page.evaluate((needle) => {
    const item = [...document.querySelectorAll('#palette .sheet__item')].find((el) =>
      el.textContent.includes(needle)
    );
    if (!item) {
      return false;
    }
    item.click();
    return true;
  }, title);

  if (!clicked) {
    await page.keyboard.press('Escape');
  }
  await sleep(600);
  return clicked;
};

/** Fills and submits the connect form. False when the form is not on screen. */
const connect = async (page, { token = TOKEN, repo = REPO, remember = false } = {}) =>
  page.evaluate(
    ({ t, r, keep }) => {
      const dialog = document.querySelector('#remote');
      const tokenInput = document.querySelector('#remote-token');
      const repoInput = document.querySelector('#remote-repo');
      const rememberBox = document.querySelector('#remote-remember');
      const form = document.querySelector('#remote-form');
      if (!dialog || !tokenInput || !repoInput || !form) {
        return false;
      }

      const set = (el, value) => {
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      set(repoInput, r);
      set(tokenInput, t);
      if (rememberBox) {
        rememberBox.checked = keep;
        rememberBox.dispatchEvent(new Event('change', { bubbles: true }));
      }

      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      return true;
    },
    { t: token, r: repo, keep: remember }
  );

/** Every markbeam value in localStorage, as one string — for "is the token in here" checks. */
const storageDump = (page) =>
  page.evaluate(() =>
    Object.keys(localStorage)
      .filter((k) => k.startsWith('markbeam:'))
      .map((k) => `${k}=${localStorage.getItem(k)}`)
      .join('\n')
  );

const toastText = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('#toasts .toast')].map((el) => el.textContent.trim()).join(' | ')
  );

export const suite = {
  name: 'github sync',
  async run() {
    const checks = [];

    // ---------- connecting, and not calling out before you do ----------

    await withPage(async (page) => {
      const seen = await interceptGitHub(page);
      await boot(page);

      const opened = await runCommand(page, 'Save to GitHub');
      const promptShown = await page.evaluate(() => {
        const dialog = document.querySelector('#remote');
        return !!dialog && dialog.open;
      });

      checks.push({
        name: 'a Save to GitHub command exists and asks to connect before doing anything',
        pass: opened && promptShown,
        detail: opened ? `#remote open=${promptShown}` : 'no such palette command'
      });

      checks.push({
        // Gated on the command existing: with no feature at all, "made no request" is true
        // and meaningless.
        name: 'no request is made to GitHub before a token is given',
        pass: opened && seen.length === 0,
        detail: opened
          ? `${seen.length} request(s): ${seen.map((r) => `${r.method} ${r.url}`).join(', ')}`
          : 'no command to invoke, so nothing could have been requested'
      });

      const guidance = await page.evaluate(
        () => document.querySelector('#remote')?.textContent.replace(/\s+/g, ' ').trim() || ''
      );
      checks.push({
        name: 'the connect prompt tells the user to scope the token narrowly',
        pass: /fine-grained/i.test(guidance) && /contents/i.test(guidance),
        detail: guidance.slice(0, 160) || 'no prompt text'
      });
    });

    // ---------- saving ----------

    await withPage(async (page, errors) => {
      const seen = await interceptGitHub(page);
      await boot(page, '# Local document\n\nBody to push.', 'Local');

      await runCommand(page, 'Save to GitHub');
      const connected = await connect(page);
      await sleep(1200);

      const put = seen.find((r) => r.method === 'PUT');
      checks.push({
        name: 'saving issues a Contents API PUT carrying the document',
        pass:
          connected &&
          !!put &&
          /\/repos\/octocat\/notes\/contents\//.test(put.url) &&
          /Body to push/.test(Buffer.from(JSON.parse(put.body || '{}').content || '', 'base64').toString('utf8')),
        detail: put ? `${put.method} ${put.url}` : `no PUT seen (connected=${connected})`
      });

      const authed = seen.filter((r) => r.method !== 'OPTIONS');
      const headerCarries = authed.every((r) => {
        const value = r.headers.authorization || r.headers.Authorization || '';
        return value.includes(TOKEN);
      });
      const urlLeaks = authed.some((r) => r.url.includes(TOKEN));

      checks.push({
        name: 'the token travels in the Authorization header and never in the URL',
        pass: authed.length > 0 && headerCarries && !urlLeaks,
        detail: `${authed.length} authed request(s), header ok=${headerCarries}, url leak=${urlLeaks}`
      });

      checks.push({
        name: 'saving raises a toast naming what happened',
        pass: /github/i.test(await toastText(page)),
        detail: (await toastText(page)) || 'no toast'
      });

      checks.push({
        name: 'no console errors while saving',
        pass: errors.length === 0,
        detail: errors[0]
      });
    });

    // ---------- the token's lifetime ----------

    await withPage(async (page) => {
      await interceptGitHub(page);
      await boot(page);

      await runCommand(page, 'Save to GitHub');
      const connected = await connect(page, { remember: false });
      await sleep(1000);

      /*
       * A token has to have been accepted for "it was not persisted" to mean anything.
       * Without this gate the check passes on a build that has no concept of a token, which
       * is the exact shape of vacuous pass this repo has shipped twice before.
       */
      const sessionDump = await storageDump(page);
      checks.push({
        name: 'by default the token is not written to localStorage',
        pass: connected && !sessionDump.includes(TOKEN),
        detail: connected
          ? sessionDump.includes(TOKEN)
            ? 'token found in localStorage'
            : `${sessionDump.split('\n').length} markbeam keys, none holding the token`
          : 'no connect form, so no token was ever offered'
      });

      // …and it does not survive the tab.
      await page.reload({ waitUntil: 'networkidle2' });
      await sleep(1500);
      const afterReload = await storageDump(page);
      checks.push({
        name: 'a session-only token is gone after a reload',
        pass: connected && !afterReload.includes(TOKEN),
        detail: connected
          ? afterReload.includes(TOKEN)
            ? 'token survived the reload'
            : 'token absent'
          : 'no connect form, so nothing could have survived'
      });
    });

    await withPage(async (page) => {
      await interceptGitHub(page);
      await boot(page);

      await runCommand(page, 'Save to GitHub');
      await connect(page, { remember: true });
      await sleep(1000);

      const remembered = await storageDump(page);
      checks.push({
        name: 'with "remember on this device" ticked the token is persisted',
        pass: remembered.includes(TOKEN),
        detail: remembered.includes(TOKEN) ? 'token persisted as asked' : 'token was not stored'
      });

      const disconnected = await runCommand(page, 'Disconnect GitHub');
      await sleep(800);
      const afterDisconnect = await storageDump(page);
      checks.push({
        name: 'disconnecting clears the stored token',
        pass: disconnected && !afterDisconnect.includes(TOKEN),
        detail: disconnected
          ? afterDisconnect.includes(TOKEN)
            ? 'token still stored after disconnect'
            : 'token cleared'
          : 'no Disconnect GitHub command'
      });
    });

    // ---------- opening ----------

    await withPage(async (page, errors) => {
      await interceptGitHub(page);
      await boot(page, '# Local document\n\nMust survive.', 'Local');

      await runCommand(page, 'Open from GitHub');
      await connect(page);
      await sleep(1200);

      const rows = await page.evaluate(() =>
        [...document.querySelectorAll('#remote-list .sheet__item')].map((el) =>
          el.textContent.replace(/\s+/g, ' ').trim()
        )
      );
      checks.push({
        name: 'the repository listing shows Markdown files and hides the rest',
        pass:
          rows.length === 2 &&
          rows.some((r) => r.includes('roadmap.md')) &&
          !rows.some((r) => r.includes('logo.png')) &&
          !rows.some((r) => r.includes('drafts')),
        detail: JSON.stringify(rows)
      });

      /*
       * The connect form must actually be gone, not merely marked hidden. `.sheet__form` sets
       * `display: flex`, which beats the user-agent `[hidden] { display: none }` rule — so the
       * form sat behind the file list, both on screen at once. Checking `hidden` alone would
       * have reported success; this measures the rendered box, which is what the eye sees.
       */
      const formVisible = await page.evaluate(() => {
        const form = document.querySelector('#remote-form');
        if (!form) {
          return false;
        }
        const rect = form.getBoundingClientRect();
        return getComputedStyle(form).display !== 'none' && rect.height > 0;
      });
      checks.push({
        name: 'the connect form gives way to the file list rather than sitting behind it',
        pass: rows.length > 0 && !formVisible,
        detail: `${rows.length} row(s) listed, form still rendered=${formVisible}`
      });

      const before = await page.evaluate(() =>
        Object.keys(localStorage).filter((k) => k.startsWith('markbeam:doc:')).length
      );

      await page.evaluate(() => {
        [...document.querySelectorAll('#remote-list .sheet__item')]
          .find((el) => el.textContent.includes('roadmap.md'))
          ?.click();
      });
      await sleep(1400);

      const after = await page.evaluate(() => ({
        docs: Object.keys(localStorage).filter((k) => k.startsWith('markbeam:doc:')).length,
        editor: [...document.querySelectorAll('#editor .view-line')]
          .map((l) => l.textContent)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim()
      }));

      checks.push({
        name: 'opening a remote file adds a document instead of overwriting the open one',
        pass: after.docs === before + 1 && /Pulled from the repository/.test(after.editor),
        detail: `${before} -> ${after.docs} documents, editor "${after.editor.slice(0, 50)}"`
      });

      checks.push({
        name: 'no console errors while opening',
        pass: errors.length === 0,
        detail: errors[0]
      });
    });

    // ---------- remote content is not trusted ----------

    await withPage(async (page) => {
      await interceptGitHub(page, { contents: HOSTILE });
      await boot(page);
      await page.evaluate(() => {
        window.__pwned = false;
      });

      await runCommand(page, 'Open from GitHub');
      await connect(page);
      await sleep(1200);
      await page.evaluate(() => {
        [...document.querySelectorAll('#remote-list .sheet__item')]
          .find((el) => el.textContent.includes('roadmap.md'))
          ?.click();
      });
      await sleep(1400);

      const result = await page.evaluate(() => ({
        imported: /Hostile remote/.test(document.querySelector('#output')?.textContent || ''),
        pwned: window.__pwned === true,
        scripts: document.querySelectorAll('#output script').length,
        handlers: document.querySelectorAll('#output [onerror]').length
      }));

      checks.push({
        // Gated on the import having happened: a build that fetches nothing would otherwise
        // sail through this by never rendering anything at all.
        name: 'a hostile remote document renders inert',
        pass: result.imported && !result.pwned && result.scripts === 0 && result.handlers === 0,
        detail: `imported=${result.imported}, executed=${result.pwned}, scripts=${result.scripts}, handlers=${result.handlers}`
      });
    });

    // ---------- the token must not leak into anything the app writes ----------

    await withPage(async (page) => {
      await interceptGitHub(page);
      await boot(page, '# Leak probe\n\nSome text.', 'Leak probe');

      // Seed the token first — asserting absence before a token exists proves nothing.
      await runCommand(page, 'Save to GitHub');
      await connect(page, { remember: true });
      await sleep(1200);

      const tokenPresent = (await storageDump(page)).includes(TOKEN);

      // Force a history snapshot rather than waiting out the idle window.
      await page.click('#editor');
      await page.keyboard.type(' more');
      await sleep(600);
      await runCommand(page, 'Copy share link');
      await sleep(800);

      const leaks = await page.evaluate(() => {
        const history = Object.keys(localStorage)
          .filter((k) => k.startsWith('markbeam:history:'))
          .map((k) => localStorage.getItem(k) || '')
          .join('\n');
        const documents = Object.keys(localStorage)
          .filter((k) => k.startsWith('markbeam:doc:') || k === 'markbeam:last_state')
          .map((k) => localStorage.getItem(k) || '')
          .join('\n');
        return { history, documents, url: location.href, editor: document.title };
      });

      checks.push({
        name: 'the token reaches no document, no history snapshot and no URL',
        pass:
          tokenPresent &&
          !leaks.history.includes(TOKEN) &&
          !leaks.documents.includes(TOKEN) &&
          !leaks.url.includes(TOKEN),
        detail: tokenPresent
          ? `history=${leaks.history.includes(TOKEN)}, documents=${leaks.documents.includes(TOKEN)}, url=${leaks.url.includes(TOKEN)}`
          : 'token was never stored, so this check would prove nothing'
      });
    });

    // ---------- failure is reported, not swallowed ----------

    await withPage(async (page) => {
      await interceptGitHub(page, {
        overrides: { '/contents/': { status: 401, body: { message: 'Bad credentials' } } }
      });
      await boot(page);

      await runCommand(page, 'Save to GitHub');
      const offered = await connect(page);
      await sleep(1400);

      /*
       * Either surface counts. A rejected token reopens the connect prompt with the reason on
       * it, which is better than a toast — the message lands where the fix happens — but the
       * check is about the failure being *said out loud*, not about which element says it.
       */
      const surfaced = await page.evaluate(() => {
        const toasts = [...document.querySelectorAll('#toasts .toast')]
          .map((el) => el.textContent.trim())
          .join(' | ');
        const status = document.querySelector('#remote-status');
        const inline = status && !status.hidden ? status.textContent.trim() : '';
        return [toasts, inline].filter(Boolean).join(' | ');
      });

      checks.push({
        name: 'a rejected token surfaces a specific message rather than silence',
        pass: /token|credential|denied|unauthor|expired/i.test(surfaced),
        detail: surfaced || 'nothing surfaced, in a toast or on the prompt'
      });

      const afterRejection = await storageDump(page);
      checks.push({
        name: 'the rejected token is not left behind as if it worked',
        pass: offered && !afterRejection.includes(TOKEN),
        detail: offered
          ? afterRejection.includes(TOKEN)
            ? 'stored anyway'
            : 'not stored'
          : 'no connect form, so no token was ever offered'
      });
    });

    return checks;
  }
};
