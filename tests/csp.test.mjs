import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize, sep } from 'node:path';
import puppeteer from 'puppeteer-core';
import { CHROME, sleep } from './lib.mjs';

/*
 * The Content-Security-Policy (T59).
 *
 * **Why this suite looks nothing like the others.** Every other suite drives the Vite dev
 * server, where `vercel.json` does not exist — its headers are applied by Vercel, in
 * production, to the built output. A policy verified only by reading `vercel.json` is a policy
 * the app has never once run under, and the failure mode of a wrong CSP is not an exception in
 * a log: it is a diagram that silently does not render, or a PDF that comes out blank.
 *
 * So this builds the app, serves that build from a throwaway server with the **real headers
 * from `vercel.json` attached**, and drives Chrome against it while collecting
 * `securitypolicyviolation` events. What is asserted is that the policy is actually present
 * *and* that nothing the app does trips it.
 *
 * The header check matters as much as the violation check: with no policy at all there are no
 * violations either, so a suite that only counted violations would pass against a build with
 * no CSP — the exact vacuous green this repo has been caught by before.
 */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.xml': 'application/xml',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf'
};

/** The headers Vercel would send, read from the file that will send them. */
const headersFromVercelConfig = async () => {
  const config = JSON.parse(await readFile('vercel.json', 'utf8'));
  const rule = (config.headers || []).find((entry) => entry.source === '/(.*)');
  const headers = {};
  for (const { key, value } of rule?.headers || []) {
    headers[key] = value;
  }
  return headers;
};

const buildTo = (outDir) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.platform === 'win32' ? 'npx.cmd' : 'npx',
      ['vite', 'build', '--outDir', outDir, '--emptyOutDir'],
      { stdio: 'ignore', shell: process.platform === 'win32' }
    );
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`vite build exited ${code}`))
    );
  });

/*
 * Static file serving with two behaviours copied from production, because both change what the
 * browser asks for: `cleanUrls` (so `/about` finds `about.html`) and an index fallback for `/`.
 * Anything missing is a real 404 — never `index.html`, which is the dev-server behaviour that
 * makes a missing page look like a working one.
 */
const serve = (root, headers) =>
  new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      let path = normalize(join(root, decodeURIComponent(url.pathname)));

      if (!path.startsWith(normalize(root) + sep) && path !== normalize(root)) {
        res.writeHead(403).end();
        return;
      }
      if (existsSync(path) && statSync(path).isDirectory()) {
        path = join(path, 'index.html');
      }
      if (!existsSync(path) && existsSync(`${path}.html`)) {
        path = `${path}.html`;
      }

      for (const [key, value] of Object.entries(headers)) {
        res.setHeader(key, value);
      }

      /*
       * `/_vercel/…` is Vercel's own surface — Speed Insights (T62) asks for a script there in
       * production builds, and this harness is not Vercel. Answered as an empty script rather
       * than left to 404: a 404 body is `text/plain`, `nosniff` then refuses to execute it, and
       * the resulting console error looks enough like a CSP failure to waste somebody's
       * afternoon. It is not one — the request is same-origin and `script-src 'self'` allows it.
       */
      if (url.pathname.startsWith('/_vercel/')) {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }).end('');
        return;
      }

      if (!existsSync(path)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
        return;
      }

      res.writeHead(200, { 'Content-Type': MIME[extname(path)] || 'application/octet-stream' });
      createReadStream(path).pipe(res);
    });

    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });

/*
 * Violations are collected in the page. The event is the only reliable signal — Chrome also
 * logs to the console, but the console text is not structured and CSP failures on *lazy*
 * chunks are easy to miss among ordinary noise.
 */
const COLLECT = `
  window.__cspViolations = [];
  document.addEventListener('securitypolicyviolation', (event) => {
    window.__cspViolations.push({
      directive: event.effectiveDirective || event.violatedDirective,
      blocked: String(event.blockedURI || '').slice(0, 120),
      sample: String(event.sample || '').slice(0, 60)
    });
  });
  window.__copied = null;
  if (navigator.clipboard) {
    navigator.clipboard.writeText = async (text) => { window.__copied = text; };
  }
  window.__pdfPages = [];
  const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function (...args) {
    try { window.__pdfPages.push(this.width); } catch (e) {}
    return origToDataURL.apply(this, args);
  };
`;

const DOC = [
  '# Policy check',
  '',
  'Inline maths $E = mc^2$ pulls the KaTeX chunk, and an image is a data URL:',
  '',
  '![dot](data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7)',
  '',
  '```mermaid',
  'graph LR',
  '  A[Write] --> B[Render]',
  '```',
  '',
  '---',
  '',
  '# Second slide',
  '',
  'Text after a slide break.'
].join('\n');

const violations = (page) => page.evaluate(() => window.__cspViolations || []);

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

export const suite = {
  name: 'content security policy',
  async run() {
    const checks = [];
    const outDir = await mkdtemp(join(tmpdir(), 'markbeam-csp-'));
    let server = null;
    let browser = null;

    try {
      const headers = await headersFromVercelConfig();
      const policy = headers['Content-Security-Policy'] || '';

      await buildTo(outDir);

      // ---------- the hash in the policy matches the script in the build ----------

      /*
       * The pre-paint theme script is inline and must stay inline (CLAUDE.md), so `script-src`
       * carries its hash rather than `'unsafe-inline'`. Edit that script without updating the
       * policy and the browser blocks it: no error a user would report, just the wrong theme
       * on every reload. Recomputing it from the built page is the only check that catches it.
       */
      const built = await readFile(join(outDir, 'index.html'), 'utf8');
      const inline = [...built.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
      const hashes = inline.map(
        (body) => `sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}`
      );

      checks.push({
        name: 'every inline script in the build is hashed in the policy',
        pass: inline.length > 0 && hashes.every((hash) => policy.includes(hash)),
        detail:
          inline.length === 0
            ? 'no inline script found in the built page'
            : `${inline.length} inline script(s): ${hashes.map((h) => (policy.includes(h) ? `${h.slice(0, 22)}… ok` : `${h} MISSING`)).join(', ')}`
      });

      const started = await serve(outDir, headers);
      server = started.server;
      const origin = `http://127.0.0.1:${started.port}`;

      browser = await puppeteer.launch({
        executablePath: CHROME,
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1400,900'],
        protocolTimeout: 600000,
        defaultViewport: { width: 1400, height: 900 }
      });

      const page = await browser.newPage();
      const consoleErrors = [];
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });
      page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));
      await page.evaluateOnNewDocument(COLLECT);

      // ---------- the policy is actually served ----------

      const response = await page.goto(origin, { waitUntil: 'networkidle2', timeout: 60000 });
      const served = response.headers()['content-security-policy'] || '';

      checks.push({
        name: 'the response carries a Content-Security-Policy',
        // Without this the suite would pass against a build with no policy at all: no policy
        // means no violations either, and every check below would be vacuously green.
        pass: served.includes('script-src') && served.includes("default-src 'self'"),
        detail: served ? `${served.length} chars: ${served.slice(0, 90)}…` : 'no CSP header served'
      });

      // ---------- the app boots under it ----------

      const booted = await page
        .waitForFunction(() => !!document.querySelector('#editor .monaco-editor'), {
          timeout: 40000
        })
        .then(() => true)
        .catch(() => false);
      await sleep(2000);

      checks.push({
        name: 'Monaco loads from the CDN under the policy',
        // The one off-origin script the app has. A missing cdn.jsdelivr.net in script-src is
        // not a degraded editor — it is no editor at all.
        pass: booted === true,
        detail: booted ? 'editor present' : 'no editor: script-src likely blocks the CDN'
      });

      // ---------- the lazy paths, each of which loads something new ----------

      await page.evaluate(() => {
        const el = document.querySelector('#editor');
        if (el) el.click();
      });
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyA');
      await page.keyboard.up('Control');
      await page.keyboard.type(DOC, { delay: 3 });
      await sleep(4000);

      const rendered = await page.evaluate(() => ({
        mermaid: document.querySelectorAll('#output .mermaid svg').length,
        katex: document.querySelectorAll('#output .katex').length,
        image: document.querySelectorAll('#output img[src^="data:"]').length
      }));

      checks.push({
        name: 'mermaid, KaTeX and a data: image all render',
        pass: rendered.mermaid >= 1 && rendered.katex >= 1 && rendered.image >= 1,
        detail: `mermaid svg=${rendered.mermaid}, katex=${rendered.katex}, data image=${rendered.image}`
      });

      // Custom preview CSS is injected as a <style> tag — the reason style-src needs
      // 'unsafe-inline', and worth proving rather than assuming.
      await runCommand(page, 'Custom preview CSS');
      await sleep(400);
      await page.evaluate(() => {
        const area = document.querySelector('#style-input');
        if (!area) return;
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype,
          'value'
        ).set;
        setter.call(area, 'h1 { color: rgb(200, 0, 100); }');
        area.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('#style-form')?.requestSubmit();
      });
      await sleep(900);

      const userCss = await page.evaluate(() => {
        const heading = document.querySelector('#output h1');
        return {
          applied: heading ? getComputedStyle(heading).color : null,
          sheet: !!document.getElementById('markbeam-user-css')
        };
      });

      checks.push({
        name: 'a user stylesheet is injected and applies',
        pass: userCss.sheet === true && userCss.applied === 'rgb(200, 0, 100)',
        detail: `sheet=${userCss.sheet}, colour=${userCss.applied}`
      });

      // PDF export: the heaviest path, and the one where a CSP failure shows up as a blank
      // document rather than an error.
      await page.evaluate(() => {
        window.__pdfPages = [];
      });
      await runCommand(page, 'Export as PDF');
      for (let i = 0; i < 60; i += 1) {
        await sleep(1000);
        const done = await page.evaluate(
          () => !document.querySelector('#export-button')?.disabled && window.__pdfPages.length > 0
        );
        if (done) break;
      }
      const pdfPages = await page.evaluate(() => window.__pdfPages.filter((w) => w > 400).length);

      checks.push({
        name: 'PDF export runs to completion under the policy',
        pass: pdfPages > 0,
        detail: `${pdfPages} rasterised page(s)`
      });

      await page.evaluate(() => {
        window.__pdfPages = [];
      });
      await runCommand(page, 'Export slides as PDF');
      for (let i = 0; i < 60; i += 1) {
        await sleep(1000);
        const done = await page.evaluate(
          () => !document.querySelector('#export-button')?.disabled && window.__pdfPages.length > 0
        );
        if (done) break;
      }
      const slidePages = await page.evaluate(() => window.__pdfPages.filter((w) => w > 400).length);

      checks.push({
        name: 'slide export runs to completion under the policy',
        pass: slidePages > 0,
        detail: `${slidePages} rasterised slide(s)`
      });

      // A share link is the reason this policy exists: the document in it was written by
      // somebody else. Round-tripping one proves the receiving path works under the CSP.
      await runCommand(page, 'Copy share link');
      await sleep(600);
      const shareUrl = await page.evaluate(() => window.__copied);
      let shared = null;
      if (shareUrl) {
        const target = new globalThis.URL(shareUrl);
        await page.goto(`${origin}/${target.hash}`, { waitUntil: 'networkidle2' });
        await page
          .waitForFunction(() => !!document.querySelector('#editor .monaco-editor'), {
            timeout: 40000
          })
          .catch(() => {});
        await sleep(2500);
        shared = await page.evaluate(() =>
          (document.querySelector('#output')?.textContent || '').includes('Policy check')
        );
      }

      checks.push({
        name: 'a shared document opens under the policy',
        pass: shared === true,
        detail: shareUrl ? `restored=${shared}` : 'no share link produced'
      });

      // ---------- and nothing tripped it ----------

      const found = await violations(page);
      checks.push({
        name: 'no directive was violated by any of that',
        pass: found.length === 0,
        detail: found.length
          ? found
              .slice(0, 4)
              .map((v) => `${v.directive} blocked ${v.blocked || v.sample}`)
              .join(' | ')
          : 'zero violations across boot, mermaid, KaTeX, images, user CSS, both exports and a share link'
      });

      const cspConsole = consoleErrors.filter((text) => /content security policy/i.test(text));
      checks.push({
        name: 'and the console is clear of CSP complaints',
        pass: cspConsole.length === 0,
        detail: cspConsole[0] || `${consoleErrors.length} unrelated console error(s)`
      });
    } catch (error) {
      checks.push({
        name: 'the CSP suite ran',
        pass: false,
        detail: `${error.message}`
      });
    } finally {
      if (browser) await browser.close().catch(() => {});
      if (server) await new Promise((resolve) => server.close(resolve));
      await rm(outDir, { recursive: true, force: true }).catch(() => {});
    }

    return checks;
  }
};
