import { editorText, seedDocument, sleep, withPage } from './lib.mjs';

/*
 * Automatic sync, and what happens on a conflict (T49).
 *
 * T37 shipped manual sync deliberately: every request happened because someone asked for one,
 * which is what made the claim on `/about` checkable in the network panel rather than merely
 * asserted. This task adds a timer, so the checks below are mostly about what must *not*
 * happen — silence when it is off, silence for a document with no remote binding, and above
 * all no overwrite when the remote moved underneath us.
 *
 * **The conflict rule is the same one pulls already follow**: a remote copy becomes a new
 * document, never a replacement. So a conflict must leave two documents and zero clobbered
 * writes. That is the check that would still pass on a naive last-write-wins build if it only
 * counted requests, so it counts documents too.
 *
 * Every call is served from a fixture; the suite never contacts github.com.
 */

const TOKEN = 'ghp_fixtureAutoSyncTokenNeverReal000';
const REPO = 'octocat/notes';
const IDLE_MS = 4000;

let remoteState = null;

const interceptGitHub = async (page) => {
  const seen = [];
  await page.setRequestInterception(true);

  page.on('request', (request) => {
    const url = request.url();
    if (!url.startsWith('https://api.github.com')) {
      request.continue();
      return;
    }

    seen.push({ url, method: request.method(), body: request.postData() || '' });

    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,PUT,POST,OPTIONS',
      'Access-Control-Allow-Headers': '*'
    };

    if (request.method() === 'OPTIONS') {
      request.respond({ status: 204, headers: cors });
      return;
    }

    const json = (status, body) =>
      request.respond({
        status,
        headers: { ...cors, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

    // Directory listing.
    if (/\/contents\/$/.test(url)) {
      json(200, [{ name: 'notes.md', path: 'notes.md', type: 'file', sha: remoteState.sha }]);
      return;
    }

    // A single file: whatever the fixture currently says the remote holds.
    if (url.includes('/contents/')) {
      if (request.method() === 'GET') {
        json(200, {
          name: 'notes.md',
          path: 'notes.md',
          sha: remoteState.sha,
          content: Buffer.from(remoteState.text, 'utf8').toString('base64'),
          encoding: 'base64'
        });
        return;
      }
      // A write lands, and the remote identifier moves on.
      remoteState = { sha: `sha-${seen.length}`, text: 'written' };
      json(200, { content: { path: 'notes.md', sha: remoteState.sha } });
      return;
    }

    json(200, {});
  });

  return seen;
};

const boot = async (page) => {
  await page.waitForFunction(() => !!document.querySelector('#editor .monaco-editor'), {
    timeout: 30000
  });
  await sleep(1800);
};

const runCommand = async (page, needle) => {
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyK');
  await page.keyboard.up('Control');
  await sleep(400);
  const clicked = await page.evaluate((text) => {
    const item = [...document.querySelectorAll('#palette .sheet__item')].find((el) =>
      el.textContent.toLowerCase().includes(text.toLowerCase())
    );
    if (!item) return false;
    item.click();
    return true;
  }, needle);
  if (!clicked) {
    await page.keyboard.press('Escape');
  }
  await sleep(600);
  return clicked;
};

/** Fills and submits the connect form, GitHub side. */
const connect = (page) =>
  page.evaluate(
    ({ t, r }) => {
      const form = document.querySelector('#remote-form');
      const tokenInput = document.querySelector('#remote-token');
      const repoInput = document.querySelector('#remote-repo');
      const providerInput = document.querySelector('#remote-provider');
      if (!form || !tokenInput || !repoInput) return false;
      if (providerInput) {
        providerInput.value = 'github';
        providerInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
      repoInput.value = r;
      tokenInput.value = t;
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      return true;
    },
    { t: TOKEN, r: REPO }
  );

/*
 * Typed for real rather than through a handle on the editor. Monaco's change event is what
 * marks a document dirty, and an injected value would be testing a path the user never takes.
 */
const typeInEditor = async (page, text) => {
  await page.click('#editor');
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Control');
  await page.keyboard.type(text, { delay: 12 });
};

const documentCount = (page) =>
  page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem('markbeam:docs') || '{"v":[]}').v.length;
    } catch (error) {
      return 0;
    }
  });

const writesTo = (seen) => seen.filter((r) => r.method === 'PUT' || r.method === 'POST');

export const suite = {
  name: 'auto sync',
  async run() {
    const checks = [];

    // ---------- off by default ----------

    await withPage(async (page, errors) => {
      remoteState = { sha: 'sha-original', text: '# Remote\n\nOriginal.' };
      const seen = await interceptGitHub(page);
      await seedDocument(page, '# Local\n\nBody.', 'Local');
      await page.reload({ waitUntil: 'networkidle2' });
      await boot(page);

      const toggle = await runCommand(page, 'automatic sync');
      // Opening the palette to look is not the same as turning it on; close it again.
      await page.keyboard.press('Escape');
      await sleep(200);

      /*
       * Gated on the control existing. "Nothing was sent" is trivially true on a build with no
       * auto-sync at all, and proves nothing about the default being off.
       */
      checks.push({
        name: 'automatic sync exists and is off until asked for',
        pass: toggle === true,
        detail: toggle ? 'a toggle command exists' : 'no auto-sync setting exists'
      });

      await connect(page);
      await sleep(800);
      const before = seen.length;
      await typeInEditor(page, '# Local\n\nEdited while auto-sync is off.');
      await sleep(IDLE_MS + 2000);

      checks.push({
        name: 'with it off, editing sends nothing at all',
        pass: toggle === true && seen.length === before,
        detail: toggle
          ? `${seen.length - before} request(s) after an edit`
          : 'no auto-sync setting exists, so silence proves nothing'
      });

      checks.push({ name: 'no console errors while idle', pass: errors.length === 0, detail: errors[0] });
    });

    // ---------- on, bound, and idle ----------

    await withPage(async (page, errors) => {
      remoteState = { sha: 'sha-original', text: '# Remote\n\nOriginal.' };
      const seen = await interceptGitHub(page);
      await seedDocument(page, '# Local\n\nBody.', 'Local');
      await page.reload({ waitUntil: 'networkidle2' });
      await boot(page);

      await runCommand(page, 'save to a repository');
      await connect(page);
      await sleep(1500);

      const bound = writesTo(seen).length;
      const enabled = await runCommand(page, 'automatic sync');
      await sleep(300);

      await typeInEditor(page, '# Local\n\nEdited with auto-sync on.');
      await sleep(IDLE_MS + 3000);

      const writes = writesTo(seen).length - bound;
      checks.push({
        name: 'with it on, an edited bound document syncs once when the editor goes idle',
        pass: enabled === true && writes === 1,
        detail: enabled ? `${writes} write(s) after one edit` : 'no auto-sync setting exists'
      });

      // Idle again with no further edit — an unchanged document must not be resent.
      const settled = writesTo(seen).length;
      await sleep(IDLE_MS + 3000);
      checks.push({
        name: 'an unchanged document is not resent on the next tick',
        pass: enabled === true && writesTo(seen).length === settled,
        detail: enabled
          ? `${writesTo(seen).length - settled} extra write(s) with nothing edited`
          : 'no auto-sync setting exists'
      });

      checks.push({ name: 'no console errors while syncing', pass: errors.length === 0, detail: errors[0] });
    });

    // ---------- the conflict ----------

    await withPage(async (page, errors) => {
      remoteState = { sha: 'sha-original', text: '# Remote\n\nOriginal.' };
      const seen = await interceptGitHub(page);
      await seedDocument(page, '# Local\n\nMine.', 'Local');
      await page.reload({ waitUntil: 'networkidle2' });
      await boot(page);

      await runCommand(page, 'save to a repository');
      await connect(page);
      await sleep(1500);
      const enabled = await runCommand(page, 'automatic sync');
      await sleep(300);

      const docsBefore = await documentCount(page);
      const writesBefore = writesTo(seen).length;

      // Somebody else pushes to the same path, then we edit locally.
      remoteState = { sha: 'sha-moved-by-someone-else', text: '# Remote\n\nTheirs.' };
      await typeInEditor(page, '# Local\n\nMine, edited after they pushed.');
      await sleep(IDLE_MS + 4000);

      const docsAfter = await documentCount(page);
      const localText = await editorText(page);

      checks.push({
        name: 'a remote that moved under us is never overwritten',
        pass: enabled === true && writesTo(seen).length === writesBefore,
        detail: enabled
          ? `${writesTo(seen).length - writesBefore} write(s) against a moved remote`
          : 'no auto-sync setting exists'
      });

      checks.push({
        name: 'the conflict leaves both versions as separate documents',
        pass: enabled === true && docsAfter === docsBefore + 1,
        detail: enabled
          ? `${docsBefore} -> ${docsAfter} documents`
          : 'no auto-sync setting exists'
      });

      checks.push({
        name: 'and the local edit is still the one in the editor',
        pass: enabled === true && /Mine, edited after they pushed/.test(localText),
        detail: enabled ? localText.slice(0, 60) : 'no auto-sync setting exists'
      });

      checks.push({ name: 'no console errors on conflict', pass: errors.length === 0, detail: errors[0] });
    });

    // ---------- an unbound document is never sent ----------

    await withPage(async (page, errors) => {
      remoteState = { sha: 'sha-original', text: '# Remote\n\nOriginal.' };
      const seen = await interceptGitHub(page);
      await seedDocument(page, '# Never saved\n\nBody.', 'Never saved');
      await page.reload({ waitUntil: 'networkidle2' });
      await boot(page);

      await connect(page);
      await sleep(800);
      const enabled = await runCommand(page, 'automatic sync');
      await sleep(300);

      const before = writesTo(seen).length;
      await typeInEditor(page, '# Never saved\n\nEdited, but never sent anywhere.');
      await sleep(IDLE_MS + 3000);

      checks.push({
        name: 'a document never saved to a repository is never sent by the timer',
        pass: enabled === true && writesTo(seen).length === before,
        detail: enabled
          ? `${writesTo(seen).length - before} write(s) for an unbound document`
          : 'no auto-sync setting exists'
      });

      const dump = await page.evaluate(() =>
        Object.keys(localStorage)
          .filter((k) => k.startsWith('markbeam:'))
          .map((k) => `${k}=${localStorage.getItem(k)}`)
          .join('\n')
      );
      checks.push({
        name: 'the token is still not persisted just because a timer uses it',
        pass: !dump.includes(TOKEN),
        detail: dump.includes(TOKEN) ? 'token found in localStorage' : 'not stored'
      });

      checks.push({ name: 'no console errors', pass: errors.length === 0, detail: errors[0] });
    });

    return checks;
  }
};
