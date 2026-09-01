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

const ALL_SUITES = [toolingSuite, cspSuite, installSuite, presentSuite, tableEditSuite, autoSyncSuite, trashSuite, customCssSuite, gistSuite, gitlabSuite, deflistSuite, typographySuite, tocSuite, searchSuite, githubSuite, seoSuite, openFileSuite, offlineSuite, formatSuite, toolbarSuite, outlineSuite, imageSuite, storageSuite, documentsSuite, historySuite, exportSuite, shareSuite, printSuite, scrollSuite, alertsSuite, emojiSuite, highlightSuite, mathSuite, gfmSuite, editorSuite, copySuite, mermaidSuite, pdfSuite, uiSuite];

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

const results = [];

for (const suite of SUITES) {
  process.stdout.write(`\n▸ ${suite.name}\n`);
  try {
    const checks = await suite.run();
    const failed = checks.filter((check) => !check.pass);

    checks.forEach((check) => {
      const mark = check.pass ? '  ✓' : '  ✗';
      const detail = check.detail === undefined ? '' : `  — ${check.detail}`;
      process.stdout.write(`${mark} ${check.name}${detail}\n`);
    });

    results.push({ name: suite.name, passed: failed.length === 0, failed: failed.length });
  } catch (error) {
    process.stdout.write(`  ✗ suite threw: ${error.message}\n`);
    results.push({ name: suite.name, passed: false, failed: 1 });
  }
}

const broken = results.filter((result) => !result.passed);

process.stdout.write('\n' + '─'.repeat(48) + '\n');
results.forEach((result) => {
  process.stdout.write(`${result.passed ? 'PASS' : 'FAIL'}  ${result.name}\n`);
});
process.stdout.write('─'.repeat(48) + '\n');

if (broken.length > 0) {
  process.stdout.write(`\n${broken.length} suite(s) failed\n`);
  process.exit(1);
}

process.stdout.write('\nAll suites passed\n');
