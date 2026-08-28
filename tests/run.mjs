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

const ALL_SUITES = [storageSuite, documentsSuite, exportSuite, scrollSuite, alertsSuite, emojiSuite, highlightSuite, mathSuite, gfmSuite, editorSuite, copySuite, mermaidSuite, pdfSuite, uiSuite];

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
