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

    return checks;
  }
};
