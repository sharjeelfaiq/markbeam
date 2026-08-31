import { seedDocument, sleep, withPage } from './lib.mjs';

/*
 * Publishing to a Gist (T47).
 *
 * The smallest real extension of T37: same token, same client, same auth model. No new
 * credential and no new trust decision — which is exactly why it is worth doing before any of
 * the sync targets that would need one.
 *
 * Every `api.github.com` call is fulfilled from a fixture, as in `tests/github.test.mjs`. The
 * suite must never contact GitHub and must never need a real token.
 *
 * The check that matters is **public or secret being an explicit choice**. A Gist created
 * public when someone assumed otherwise is a disclosure they cannot take back, so the default
 * cannot be a silent one.
 */

const TOKEN = 'ghp_fixtureTokenNeverReal000000000000000';
const REPO = 'octocat/notes';
const API = 'https://api.github.com';
const GIST_URL = 'https://gist.github.com/octocat/abc123';

const interceptGitHub = async (page) => {
  const seen = [];
  await page.setRequestInterception(true);

  page.on('request', (request) => {
    const url = request.url();
    if (!url.startsWith(API)) {
      request.continue();
      return;
    }

    seen.push({
      url,
      method: request.method(),
      headers: request.headers(),
      body: request.postData() || ''
    });

    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,PUT,POST,OPTIONS',
      'Access-Control-Allow-Headers': '*'
    };

    if (request.method() === 'OPTIONS') {
      request.respond({ status: 204, headers: cors });
      return;
    }

    if (url.endsWith('/gists')) {
      request.respond({
        status: 201,
        headers: { ...cors, 'Content-Type': 'application/json' },
        body: JSON.stringify({ html_url: GIST_URL, id: 'abc123' })
      });
      return;
    }

    request.respond({
      status: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify([])
    });
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
      el.textContent.includes(text)
    );
    if (!item) return false;
    item.click();
    return true;
  }, needle);
  if (!clicked) {
    await page.keyboard.press('Escape');
  }
  await sleep(700);
  return clicked;
};

const connect = (page) =>
  page.evaluate((token) => {
    const form = document.querySelector('#remote-form');
    const tokenInput = document.querySelector('#remote-token');
    const repoInput = document.querySelector('#remote-repo');
    if (!form || !tokenInput || !repoInput) return false;
    repoInput.value = 'octocat/notes';
    tokenInput.value = token;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    return true;
  }, TOKEN);

const toastText = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('#toasts .toast')].map((el) => el.textContent.trim()).join(' | ')
  );

export const suite = {
  name: 'gist',
  async run() {
    return withPage(async (page, errors) => {
      const checks = [];

      const seen = await interceptGitHub(page);
      await page.evaluateOnNewDocument(`
        window.__copied = [];
        navigator.clipboard.writeText = (text) => {
          window.__copied.push(text);
          return Promise.resolve();
        };
      `);

      await seedDocument(page, '# Gist fixture\n\nBody to publish.', 'Gist fixture');
      await page.reload({ waitUntil: 'networkidle2' });
      await boot(page);

      const opened = await runCommand(page, 'Publish as Gist');
      const promptShown = await page.evaluate(() => {
        const dialog = document.querySelector('#remote');
        return !!dialog && dialog.open;
      });

      checks.push({
        name: 'a Publish as Gist command exists and asks to connect first',
        pass: opened && promptShown,
        detail: opened ? `connect prompt open=${promptShown}` : 'no such command'
      });

      checks.push({
        name: 'nothing is sent to GitHub before a token is given',
        pass: opened && seen.length === 0,
        detail: opened
          ? `${seen.length} request(s)`
          : 'no command exists, so nothing could have been sent'
      });

      await connect(page);
      await sleep(1400);

      /*
       * Visibility has to be asked, not assumed. A Gist created public when someone expected
       * a secret one is a disclosure that cannot be withdrawn.
       */
      const choice = await page.evaluate(() => {
        const dialog = document.querySelector('#gist');
        if (!dialog || !dialog.open) {
          return null;
        }
        const inputs = [...dialog.querySelectorAll('input[type="radio"], input[type="checkbox"]')];
        return {
          open: true,
          controls: inputs.map((i) => ({ name: i.name || i.id, checked: i.checked })),
          text: dialog.textContent.replace(/\s+/g, ' ').trim().slice(0, 160)
        };
      });

      checks.push({
        name: 'public or secret is an explicit choice, offered before anything is created',
        pass:
          !!choice &&
          choice.controls.length >= 1 &&
          /secret|public/i.test(choice.text) &&
          seen.filter((r) => r.method === 'POST').length === 0,
        detail: choice
          ? `${choice.controls.length} control(s), no POST yet: ${JSON.stringify(choice.controls)}`
          : 'no visibility prompt appeared'
      });

      const published = await page.evaluate(() => {
        const form = document.querySelector('#gist-form');
        if (!form) return false;
        const secret = document.querySelector('#gist-secret');
        if (secret) secret.checked = true;
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        return true;
      });
      await sleep(1400);

      const post = seen.find((r) => r.method === 'POST' && r.url.endsWith('/gists'));
      let body = null;
      try {
        body = post ? JSON.parse(post.body) : null;
      } catch (error) {
        body = null;
      }

      checks.push({
        name: 'publishing POSTs the document to the Gists endpoint',
        pass:
          published &&
          !!post &&
          !!body &&
          Object.values(body.files || {}).some((f) => /Body to publish/.test(f.content || '')),
        detail: post ? `${post.method} ${post.url}, files ${Object.keys(body?.files || {})}` : 'no POST seen'
      });

      checks.push({
        name: 'the chosen visibility is what gets sent',
        pass: !!body && body.public === false,
        detail: `public=${body ? body.public : 'no body'} (secret was chosen)`
      });

      checks.push({
        name: 'the token rides in the Authorization header, never the URL',
        pass:
          !!post &&
          (post.headers.authorization || '').includes(TOKEN) &&
          !post.url.includes(TOKEN),
        detail: post
          ? `header carries it=${(post.headers.authorization || '').includes(TOKEN)}, url leaks=${post.url.includes(TOKEN)}`
          : 'no POST seen'
      });

      const copied = await page.evaluate(() => window.__copied || []);
      const toasts = await toastText(page);
      checks.push({
        name: 'the resulting URL is offered rather than left on screen to retype',
        pass: copied.some((text) => text.includes('gist.github.com')) || /gist.github.com/.test(toasts),
        detail: `clipboard ${JSON.stringify(copied)}, toast "${toasts}"`
      });

      checks.push({
        name: 'no console errors',
        pass: errors.length === 0,
        detail: errors[0]
      });

      return checks;
    });
  }
};
