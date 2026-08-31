import { readFile, rm, writeFile } from 'node:fs/promises';
import { URL as TARGET } from './lib.mjs';
import { refreshSources, secondsSinceTouched } from './freshness.mjs';

/*
 * The test runner's own guarantees (T55).
 *
 * No browser: these check the harness rather than the app. `run.mjs` calls `suite.run()` and
 * does not care whether a page was ever opened.
 *
 * **On the red/green rule.** Every other suite here was watched failing against the unfixed
 * code first. That is not achievable for this one: staleness in Vite's transform cache cannot
 * be produced on demand — it is a cache-invalidation race that happened once, under conditions
 * nothing reproduces reliably. The honest red is that `tests/freshness.mjs` did not exist, so
 * this suite could not import and threw. Recorded plainly rather than dressed up as a
 * behavioural failure it never was.
 */

const PROBE = 'src/__freshness_probe__.js';

export const suite = {
  name: 'tooling',
  async run() {
    const checks = [];

    // ---------- every source file is touched ----------

    const touched = await refreshSources('src');
    const ages = await Promise.all(
      touched.slice(0, 200).map(async (path) => ({ path, age: await secondsSinceTouched(path) }))
    );
    const stale = ages.filter((entry) => entry.age > 30);

    checks.push({
      name: 'the freshness pass touches every source file',
      pass: touched.length > 20 && stale.length === 0,
      detail: `${touched.length} files touched, ${stale.length} older than 30s${
        stale.length ? ` (${stale[0].path} at ${Math.round(stale[0].age)}s)` : ''
      }`
    });

    checks.push({
      name: 'it covers stylesheets too, not only scripts',
      // app.css was one of the two files served stale, so a JS-only sweep would have missed
      // half the original bug.
      pass: touched.some((path) => path.endsWith('.css')),
      detail: `${touched.filter((p) => p.endsWith('.css')).length} stylesheets in the sweep`
    });

    // ---------- the dev server really does serve what is on disk ----------

    /*
     * End to end rather than by inference: write a file with a token nothing else could
     * contain, ask the dev server for it, and require the token back. Cleaned up in `finally`,
     * because a stray file under `src/` would show up in `git status` and get committed by
     * the next person who runs `git add -A`.
     */
    const token = `freshness_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    let servedToken = null;
    let probeError = null;

    try {
      await writeFile(PROBE, `export const probe = '${token}';\n`, 'utf8');
      await refreshSources('src');
      await new Promise((resolve) => setTimeout(resolve, 400));

      const response = await fetch(new URL('/src/__freshness_probe__.js', TARGET).href);
      const body = response.ok ? await response.text() : '';
      servedToken = body.includes(token);
    } catch (error) {
      probeError = error.message;
    } finally {
      await rm(PROBE, { force: true });
    }

    checks.push({
      name: 'the dev server serves current file contents, not a cached transform',
      pass: servedToken === true,
      detail: probeError ? `probe failed: ${probeError}` : `token echoed back: ${servedToken}`
    });

    // ---------- and the probe left nothing behind ----------

    let leftover = false;
    try {
      await readFile(PROBE, 'utf8');
      leftover = true;
    } catch (error) {
      leftover = false;
    }

    checks.push({
      name: 'the probe file is removed afterwards',
      pass: !leftover,
      detail: leftover ? `${PROBE} still exists` : 'cleaned up'
    });

    // ---------- one canonical host ----------

    /*
     * The site moved to `markbeam.app` (T58), and a domain move is spread across files that
     * cannot reference each other: the canonical, OG and JSON-LD URLs in `index.html`, the
     * same three in `public/about.html`, `robots.txt`, `sitemap.xml`, the CI smoke target, and
     * prose in the README and the welcome document. Miss one and nothing breaks visibly — the
     * old host still serves — while a crawler is told the platform subdomain is the real
     * address.
     *
     * `docs/tasks.md` is excluded on purpose: its entries record checks run against the site
     * as it was, and editing history to say something that was not true then is worse than a
     * stale string.
     */
    const OLD_HOST = 'markbeam.vercel.app';
    const CANONICAL = 'https://markbeam.app';

    /*
     * Files that a visitor or a crawler is served, where the old host may not appear at all.
     * `vercel.json`, `.github/workflows/ci.yml`, `CLAUDE.md` and `docs/seo-brief.md` are
     * absent from this list on purpose — each *must* name the old host, to redirect it, to
     * assert the redirect, or to explain it. They get the positive checks below instead, which
     * is the stronger statement anyway: not "the string is gone" but "the redirect is wired".
     */
    const SERVED_SURFACE = [
      'index.html',
      'README.md',
      'public/about.html',
      'public/markdown-viewer.html',
      'public/markdown-to-pdf.html',
      'public/mermaid-diagrams.html',
      'public/markdown-slides.html',
      'public/page.css',
      'public/robots.txt',
      'public/sitemap.xml',
      'public/manifest.webmanifest',
      'src/defaultDocument.js'
    ];

    const stragglers = [];
    for (const path of SERVED_SURFACE) {
      try {
        const body = await readFile(path, 'utf8');
        if (body.includes(OLD_HOST)) {
          stragglers.push(path);
        }
      } catch (error) {
        stragglers.push(`${path} (unreadable: ${error.code || error.message})`);
      }
    }

    checks.push({
      name: 'nothing served still points at the old host',
      pass: stragglers.length === 0,
      detail: stragglers.length
        ? `${OLD_HOST} in ${stragglers.join(', ')}`
        : `${SERVED_SURFACE.length} files clean`
    });

    /*
     * And the old host is actually caught rather than merely unmentioned. Asserted against
     * the parsed config, not a grep: a redirect with the right strings in the wrong keys
     * reads fine and does nothing.
     */
    let redirect = null;
    let configError = null;
    try {
      const config = JSON.parse(await readFile('vercel.json', 'utf8'));
      redirect = (config.redirects || []).find((rule) =>
        (rule.has || []).some((cond) => cond.type === 'host' && cond.value === OLD_HOST)
      );
    } catch (error) {
      configError = error.message;
    }

    checks.push({
      name: 'the old host is permanently redirected to the canonical one',
      pass:
        !!redirect &&
        redirect.permanent === true &&
        String(redirect.destination || '').startsWith(CANONICAL),
      detail: configError
        ? `vercel.json unreadable: ${configError}`
        : redirect
          ? `-> ${redirect.destination} (permanent=${redirect.permanent})`
          : 'no redirect keyed on the old host'
    });

    const workflow = await readFile('.github/workflows/ci.yml', 'utf8').catch(() => '');
    checks.push({
      name: 'CI smoke-tests the canonical host',
      pass: new RegExp(`PRODUCTION_URL:\\s*${CANONICAL}\\s*$`, 'm').test(workflow),
      detail:
        (workflow.match(/PRODUCTION_URL:.*/) || ['no PRODUCTION_URL in the workflow'])[0].trim()
    });

    return checks;
  }
};
