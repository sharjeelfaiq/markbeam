import { withPage, sleep } from './lib.mjs';

/*
 * Regression cover for the Mermaid error-container leak.
 *
 * `mermaid.render` throws on a parse error *before* reaching its own cleanup, stranding
 * a `d<renderId>` container in <body>. While a diagram is being typed almost every
 * intermediate state fails to parse, so those containers used to stack up until they
 * covered the page and the editor became unusable.
 *
 * The pauses below are load-bearing: rendering is debounced 150ms, so typing faster than
 * that never triggers an intermediate render and the bug does not reproduce at all. An
 * earlier version of this test used 45ms and passed against known-broken code.
 */

const orphanCount = (page) =>
  page.evaluate(() => document.querySelectorAll('body > div[id^="dmermaid"]').length);

const clearEditor = async (page) => {
  await page.click('#editor');
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await sleep(400);
};

const type = async (page, text) => {
  for (const char of text) {
    if (char === '\n') {
      await page.keyboard.press('Enter');
    } else {
      await page.keyboard.type(char);
    }
  }
};

export const suite = {
  name: 'mermaid',
  async run() {
    return withPage(async (page, errors) => {
      const checks = [];

      // The default document renders its diagram.
      const defaultSvgs = await page.$$eval('#output .mermaid svg', (els) => els.length);
      checks.push({
        name: 'default document renders its diagram',
        pass: defaultSvgs === 1,
        detail: `${defaultSvgs} svg`
      });

      // Build a fence a fragment at a time, pausing past the render debounce.
      await clearEditor(page);
      const steps = [
        '```mermaid\n',
        'graph TD\n',
        '  A',
        '[Start]',
        ' --',
        '>',
        ' B',
        '{Dec',
        'ision}\n'
      ];

      let maxOrphans = 0;
      for (const step of steps) {
        await type(page, step);
        await sleep(320);
        maxOrphans = Math.max(maxOrphans, await orphanCount(page));
      }
      await sleep(1200);

      checks.push({
        name: 'no orphaned error containers while typing',
        pass: maxOrphans === 0,
        detail: `peak ${maxOrphans}`
      });

      const svgs = await page.$$eval('#output .mermaid svg', (els) => els.length);
      checks.push({
        name: 'completed diagram renders',
        pass: svgs === 1,
        detail: `${svgs} svg`
      });

      // An unrecoverable diagram shows exactly one inline error, and no body orphans.
      await clearEditor(page);
      await type(page, '```mermaid\nthis is not a diagram @@@\n');
      await sleep(1400);

      const errorBoxes = await page.$$eval('#output .mermaid-error', (els) => els.length);
      const orphans = await orphanCount(page);
      checks.push({
        name: 'invalid diagram shows one inline error',
        pass: errorBoxes === 1 && orphans === 0,
        detail: `${errorBoxes} error, ${orphans} orphans`
      });

      // Correcting the diagram recovers.
      await clearEditor(page);
      await type(page, '```mermaid\ngraph TD\n  A-->B\n');
      await sleep(1400);

      const recovered = await page.$$eval('#output .mermaid svg', (els) => els.length);
      const leftover = await page.$$eval('#output .mermaid-error', (els) => els.length);
      checks.push({
        name: 'recovers after the diagram is fixed',
        pass: recovered === 1 && leftover === 0,
        detail: `${recovered} svg, ${leftover} errors`
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
