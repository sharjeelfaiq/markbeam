/*
 * Markbeam test runner.
 *
 * These are real browser tests — they drive Chrome against a running dev server, because
 * the things most likely to break here (Monaco, Mermaid rendering, canvas rasterisation)
 * cannot be meaningfully tested without a browser.
 *
 *   npm run dev        # in one terminal
 *   npm test           # in another
 *
 * Override CHROME_PATH or MARKBEAM_URL if your setup differs.
 */

import { URL as TARGET } from './lib.mjs';
import { refreshSources } from './freshness.mjs';
import { suite as uiSuite } from './ui.test.mjs';
import { suite as mermaidSuite } from './mermaid.test.mjs';
import { suite as pdfSuite } from './pdf.test.mjs';
import { suite as storageSuite } from './storage.test.mjs';
import { suite as scrollSuite } from './scroll.test.mjs';
import { suite as alertsSuite } from './alerts.test.mjs';
import { suite as editorSuite } from './editor.test.mjs';
import { suite as copySuite } from './copy.test.mjs';
import { suite as emojiSuite } from './emoji.test.mjs';
import { suite as highlightSuite } from './highlight.test.mjs';
import { suite as mathSuite } from './math.test.mjs';
import { suite as documentsSuite } from './documents.test.mjs';
import { suite as gfmSuite } from './gfm.test.mjs';
import { suite as exportSuite } from './export.test.mjs';
import { suite as shareSuite } from './share.test.mjs';
import { suite as printSuite } from './print.test.mjs';
import { suite as historySuite } from './history.test.mjs';
import { suite as seoSuite } from './seo.test.mjs';
import { suite as openFileSuite } from './openfile.test.mjs';
import { suite as offlineSuite } from './offline.test.mjs';
import { suite as formatSuite } from './format.test.mjs';
import { suite as outlineSuite } from './outline.test.mjs';
import { suite as imageSuite } from './images.test.mjs';
import { suite as toolbarSuite } from './toolbar.test.mjs';
import { suite as githubSuite } from './github.test.mjs';
import { suite as searchSuite } from './search.test.mjs';
import { suite as toolingSuite } from './tooling.test.mjs';
import { suite as deflistSuite } from './deflist.test.mjs';
import { suite as typographySuite } from './typography.test.mjs';
import { suite as tocSuite } from './toc.test.mjs';
import { suite as trashSuite } from './trash.test.mjs';
import { suite as customCssSuite } from './customcss.test.mjs';
import { suite as gistSuite } from './gist.test.mjs';
import { suite as gitlabSuite } from './gitlab.test.mjs';
import { suite as autoSyncSuite } from './autosync.test.mjs';
import { suite as tableEditSuite } from './tableedit.test.mjs';
import { suite as presentSuite } from './present.test.mjs';
import { suite as installSuite } from './install.test.mjs';
import { suite as cspSuite } from './csp.test.mjs';
import { suite as touchSuite } from './touch.test.mjs';
import { suite as exportMenuSuite } from './exportMenu.test.mjs';
import { suite as fileSystemSuite } from './filesystem.test.mjs';
import { runPool } from './pool.mjs';
import { cpus } from 'node:os';

const ALL_SUITES = [toolingSuite, fileSystemSuite, exportMenuSuite, touchSuite, cspSuite, installSuite, presentSuite, tableEditSuite, autoSyncSuite, trashSuite, customCssSuite, gistSuite, gitlabSuite, deflistSuite, typographySuite, tocSuite, searchSuite, githubSuite, seoSuite, openFileSuite, offlineSuite, formatSuite, toolbarSuite, outlineSuite, imageSuite, storageSuite, documentsSuite, historySuite, exportSuite, shareSuite, printSuite, scrollSuite, alertsSuite, emojiSuite, highlightSuite, mathSuite, gfmSuite, editorSuite, copySuite, mermaidSuite, pdfSuite, uiSuite];

// `npm test -- mermaid` runs just that suite; substring match on the suite name.
const filters = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
const SUITES = filters.length
  ? ALL_SUITES.filter((suite) => filters.some((f) => suite.name.includes(f.toLowerCase())))
  : ALL_SUITES;

if (SUITES.length === 0) {
  console.error(`No suite matches ${filters.join(', ')}`);
  console.error(`Available: ${ALL_SUITES.map((s) => s.name).join(', ')}`);
  process.exit(1);
}

let reachable = false;
try {
  const response = await fetch(TARGET, { method: 'GET' });
  reachable = response.ok;
} catch (error) {
  reachable = false;
}

if (!reachable) {
  console.error(`\nCannot reach ${TARGET}`);
  console.error('Start the dev server first:  npm run dev\n');
  process.exit(1);
}

/*
 * Force the dev server to re-transform every source file before anything runs.
 *
 * A long-lived dev server has served stale code here: during T41 it returned an old
 * `main.js` and an old `app.css` while both files on disk were correct, producing five
 * failures that looked entirely real and cost most of a debugging cycle. Touching the files
 * makes the question moot — the watcher invalidates, and the next request is transformed
 * from disk.
 *
 * Detection was considered and rejected: `?raw` and `?t=` are different module ids with
 * their own cache entries, so a probe through either can come back fresh while the module the
 * app actually imports is stale. `tests/tooling.test.mjs` proves this pass does what it says.
 */
const refreshed = await refreshSources('src');
// A brief pause so the watcher has processed the mtime changes before the first request.
await new Promise((resolve) => setTimeout(resolve, 500));
process.stdout.write('\nRefreshed ' + refreshed.length + ' source files\n');

/*
 * How the run is scheduled (T94).
 *
 * **`tooling` runs alone, first.** It writes a probe into `src/` and calls `refreshSources`,
 * which touches every source file — Vite's watcher then hot-reloads every open page. Any suite
 * running beside it would be reloaded mid-assertion, and `CLAUDE.md` records what that produces:
 * results that look real and are not. Everything else is safe together, because Puppeteer gives
 * each `launch()` a fresh temporary profile, so no two suites share `localStorage`.
 *
 * Concurrency defaults to four or one fewer than the cores, whichever is smaller. Several suites
 * rasterise PDFs and are CPU-bound, so oversubscribing makes the whole run slower rather than
 * faster.
 */
const EXCLUSIVE = new Set(['tooling']);
const CONCURRENCY = Math.max(
  1,
  Number(process.env.MARKBEAM_CONCURRENCY) || Math.min(4, Math.max(1, cpus().length - 1))
);

/*
 * Longest first, **measured rather than guessed**. Starting a heavy suite late leaves one
 * straggler running alone while every other worker idles: the first ordering here was written
 * from intuition, put `history` nowhere in the list, and `history` turned out to be the longest
 * suite in the run at 150s. It started around the halfway mark and finished last, so it alone
 * set the wall clock at 306s against an ideal of 257s.
 *
 * `history` is long for a reason that cannot be optimised away from the test side: it waits out
 * the real 20s autosave fuse six times, and three of those are *absence* assertions — proving no
 * snapshot appeared means waiting the whole window, not waiting for a result. So it has to go
 * first.
 *
 * These names must match `suite.name`, not the file name. Re-measure from the summary this
 * runner prints rather than editing the list from memory.
 */
const HEAVY = [
  'history',
  'auto sync',
  'github sync',
  'content security policy',
  'install prompt',
  'search',
  'math',
  'local images',
  'ui shell',
  'table of contents',
  'documents',
  'gitlab',
  'share links',
  'scroll sync',
  'file system',
  'presentation',
  'custom css',
  'trash',
  'pdf export',
  'gfm modes',
  'outline',
  'export menu',
  'touch'
];
/*
 * A name in `HEAVY` that matches nothing is a silent no-op — the suite it was meant to schedule
 * first goes back to running last, and the only symptom is a slower run. Say so out loud.
 */
const unknown = HEAVY.filter((name) => !ALL_SUITES.some((suite) => suite.name === name));
if (unknown.length > 0) {
  process.stdout.write(`\nHEAVY names no suite: ${unknown.join(', ')}\n`);
}

const weight = (suite) => {
  const index = HEAVY.indexOf(suite.name);
  return index === -1 ? HEAVY.length : index;
};

const exclusive = SUITES.filter((suite) => EXCLUSIVE.has(suite.name));
const shared = SUITES.filter((suite) => !EXCLUSIVE.has(suite.name)).sort((a, b) => weight(a) - weight(b));

/*
 * Output is buffered per suite and printed when that suite finishes. Four suites writing to
 * stdout as they go would interleave into something unreadable, and a failing check has to stay
 * attached to the suite it came from.
 */
const runSuite = async (suite) => {
  const started = Date.now();
  const lines = [`
▸ ${suite.name}`];

  try {
    const checks = await suite.run();
    const failed = checks.filter((check) => !check.pass);

    checks.forEach((check) => {
      const mark = check.pass ? '  ✓' : '  ✗';
      const detail = check.detail === undefined ? '' : `  — ${check.detail}`;
      lines.push(`${mark} ${check.name}${detail}`);
    });

    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    process.stdout.write(lines.join('\n') + '\n');
    return { name: suite.name, passed: failed.length === 0, failed: failed.length, seconds };
  } catch (error) {
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    lines.push(`  ✗ suite threw: ${error.message}`);
    process.stdout.write(lines.join('\n') + '\n');
    return { name: suite.name, passed: false, failed: 1, seconds };
  }
};

const startedAll = Date.now();
const results = [];

for (const suite of exclusive) {
  results.push(await runSuite(suite));
}

results.push(...(await runPool(shared, CONCURRENCY, runSuite)));

const broken = results.filter((result) => !result.passed);

process.stdout.write('\n' + '─'.repeat(48) + '\n');
results.forEach((result) => {
  process.stdout.write(`${result.passed ? 'PASS' : 'FAIL'}  ${result.name}  ${result.seconds}s\n`);
});
process.stdout.write('─'.repeat(48) + '\n');

/*
 * The wall clock and the five slowest suites, printed every run.
 *
 * This task began with nobody knowing where fifteen minutes went, and the answer took a
 * measuring session to find. Printing it means the next person optimising the suite starts from
 * a number rather than a guess — and a suite that quietly becomes the new bottleneck announces
 * itself instead of hiding inside the total.
 */
const slowest = [...results].sort((a, b) => Number(b.seconds) - Number(a.seconds)).slice(0, 5);
process.stdout.write(
  `${((Date.now() - startedAll) / 1000).toFixed(1)}s wall clock, ${CONCURRENCY} suite(s) at a time\n`
);
process.stdout.write(`slowest: ${slowest.map((r) => `${r.name} ${r.seconds}s`).join(' · ')}\n`);

if (broken.length > 0) {
  process.stdout.write(`\n${broken.length} suite(s) failed\n`);
  process.exit(1);
}

process.stdout.write('\nAll suites passed\n');
