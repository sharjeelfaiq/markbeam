import { seedDocument, sleep, withPage } from './lib.mjs';

/*
 * GitLab as a second sync target (T48).
 *
 * Token-based exactly like GitHub, so it needs no callback server and no OAuth — the
 * constraint that keeps Drive and Dropbox out of scope entirely.
 *
 * The interesting half is **coexistence**. One credential store with one slot would mean
 * connecting GitLab silently signs you out of GitHub, and the only way to notice is to try to
 * save and be asked to connect again. The seeded-GitHub-token check below is the one that
 * catches that, and it is written so it cannot pass on a build that has no GitLab at all.
 *
 * Every call is fulfilled from a fixture: the suite must never contact gitlab.com and must
 * never need a real token.
 */

const GH_TOKEN = 'ghp_fixtureGithubTokenNeverReal0000000';
const GL_TOKEN = 'glpat-fixtureGitlabTokenNeverReal000';
const GL_API = 'https://gitlab.com/api/v4';

const TREE = [
  { name: 'guide.md', path: 'guide.md', type: 'blob' },
  { name: 'logo.png', path: 'logo.png', type: 'blob' },
  { name: 'drafts', path: 'drafts', type: 'tree' }
];

const interceptGitLab = async (page, { failWith = null } = {}) => {
  const seen = [];
  await page.setRequestInterception(true);

  page.on('request', (request) => {
    const url = request.url();
    if (!url.startsWith('https://gitlab.com') && !url.startsWith('https://api.github.com')) {
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

    const json = (status, body) =>
      request.respond({
        status,
        headers: { ...cors, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

    if (failWith) {
      json(failWith, { message: '401 Unauthorized' });
      return;
    }

    if (url.includes('/repository/tree')) {
      json(200, TREE);
      return;
    }

    if (url.includes('/repository/files/')) {
      if (request.method() === 'GET') {
        json(200, {
          file_name: 'guide.md',
          content: Buffer.from('# Guide\n\nPulled from GitLab.', 'utf8').toString('base64'),
          encoding: 'base64'
        });
        return;
      }
      json(200, { file_path: 'saved.md', branch: 'main' });
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

const connectAs = (page, provider, token, project) =>
  page.evaluate(
    ({ p, t, r }) => {
      const form = document.querySelector('#remote-form');
      const tokenInput = document.querySelector('#remote-token');
      const repoInput = document.querySelector('#remote-repo');
      const providerInput = document.querySelector('#remote-provider');
      if (!form || !tokenInput || !repoInput || !providerInput) {
        return false;
      }
      providerInput.value = p;
      providerInput.dispatchEvent(new Event('change', { bubbles: true }));
      repoInput.value = r;
      tokenInput.value = t;
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      return true;
    },
    { p: provider, t: token, r: project }
  );

const storageDump = (page) =>
  page.evaluate(() =>
    Object.keys(localStorage)
      .filter((k) => k.startsWith('markbeam:'))
      .map((k) => `${k}=${localStorage.getItem(k)}`)
      .join('\n')
  );

export const suite = {
  name: 'gitlab',
  async run() {
    const checks = [];

    await withPage(async (page, errors) => {
      const seen = await interceptGitLab(page);
      await seedDocument(page, '# GitLab fixture\n\nBody to push.', 'GitLab fixture');
      await page.reload({ waitUntil: 'networkidle2' });
      await boot(page);

      await runCommand(page, 'Save to');
      const hasProvider = await page.evaluate(() => {
        const select = document.querySelector('#remote-provider');
        if (!select) return null;
        return [...select.options].map((o) => o.value);
      });

      checks.push({
        name: 'the connect prompt offers a provider, not just a repository',
        pass: Array.isArray(hasProvider) && hasProvider.includes('github') && hasProvider.includes('gitlab'),
        detail: hasProvider ? JSON.stringify(hasProvider) : 'no provider control'
      });

      const connected = await connectAs(page, 'gitlab', GL_TOKEN, 'octocat/handbook');
      await sleep(1500);

      const write = seen.find((r) => r.method === 'POST' || r.method === 'PUT');
      checks.push({
        name: 'saving reaches the GitLab API with the document',
        pass:
          connected &&
          !!write &&
          write.url.startsWith('https://gitlab.com/api/v4') &&
          /Body to push/.test(
            (() => {
              try {
                return Buffer.from(JSON.parse(write.body || '{}').content || '', 'base64').toString('utf8');
              } catch (error) {
                return JSON.parse(write.body || '{}').content || '';
              }
            })()
          ),
        detail: write ? `${write.method} ${write.url}` : `no write seen (connected=${connected})`
      });

      const authed = seen.filter((r) => r.method !== 'OPTIONS' && r.url.startsWith('https://gitlab.com'));
      checks.push({
        name: 'the token travels in a header and never in the URL',
        pass:
          authed.length > 0 &&
          authed.every((r) => {
            const header = r.headers.authorization || r.headers['private-token'] || '';
            return header.includes(GL_TOKEN);
          }) &&
          !authed.some((r) => r.url.includes(GL_TOKEN)),
        detail: `${authed.length} GitLab request(s), url leak=${authed.some((r) => r.url.includes(GL_TOKEN))}`
      });

      const dump = await storageDump(page);
      checks.push({
        name: 'the GitLab token is not persisted by default, like the GitHub one',
        pass: connected && !dump.includes(GL_TOKEN),
        detail: connected
          ? dump.includes(GL_TOKEN)
            ? 'token found in localStorage'
            : 'not stored'
          : 'never connected, so nothing could have been stored'
      });

      checks.push({
        name: 'no console errors while saving to GitLab',
        pass: errors.length === 0,
        detail: errors[0]
      });
    });

    // ---------- the two connections must not clobber each other ----------

    await withPage(async (page, errors) => {
      await interceptGitLab(page);
      await seedDocument(page, '# Coexist\n\nBody.', 'Coexist');
      await page.reload({ waitUntil: 'networkidle2' });
      await boot(page);

      // A remembered GitHub connection, as if from an earlier session.
      await page.evaluate((token) => {
        localStorage.setItem('markbeam:github_token', token);
        localStorage.setItem('markbeam:github_repo', JSON.stringify({ v: 'octocat/notes' }));
      }, GH_TOKEN);
      await page.reload({ waitUntil: 'networkidle2' });
      await boot(page);

      await runCommand(page, 'Save to');
      const switched = await connectAs(page, 'gitlab', GL_TOKEN, 'octocat/handbook');
      await sleep(1200);

      const after = await page.evaluate(() => ({
        github: localStorage.getItem('markbeam:github_token'),
        githubRepo: localStorage.getItem('markbeam:github_repo'),
        gitlabRepo: localStorage.getItem('markbeam:gitlab_repo')
      }));

      /*
       * Gated on the provider control existing. On a build with no GitLab, "the GitHub token
       * survived" is true because nothing could have touched it — which proves nothing about
       * coexistence.
       */
      checks.push({
        name: 'connecting GitLab leaves an existing GitHub connection alone',
        pass: switched && after.github === GH_TOKEN && !!after.githubRepo,
        detail: switched
          ? `github token intact=${after.github === GH_TOKEN}, github repo=${after.githubRepo}, gitlab repo=${after.gitlabRepo}`
          : 'no provider control, so there was nothing to switch between'
      });

      checks.push({
        name: 'no console errors while switching providers',
        pass: errors.length === 0,
        detail: errors[0]
      });
    });

    return checks;
  }
};
