import { withPage, sleep } from './lib.mjs';

/*
 * Sync scroll, both directions (#61).
 *
 * The editor drove the preview but nothing listened to the preview, so scrolling the
 * preview left the editor behind.
 *
 * Two things make this awkward to test:
 *
 * - Monaco uses emulated scrollbars, so its container has no meaningful `scrollTop`, and
 *   the app deliberately does not expose `monaco` on `window`. We read the smallest
 *   visible line number instead: 1 at the top, higher once scrolled. The *minimum* rather
 *   than the first in DOM order, because Monaco recycles line nodes and DOM order stops
 *   matching visual order after scrolling around.
 * - The setting is only reachable through the command palette. Seeding localStorage and
 *   reloading keeps this suite about scrolling rather than about the palette.
 */

const LONG_DOCUMENT = Array.from(
  { length: 300 },
  (_, i) => `Line ${i + 1} of a long document.`
).join('\n\n');

const seed = (page, syncEnabled) =>
  page.evaluate(
    (doc, sync) => {
      localStorage.setItem('markbeam:last_state', JSON.stringify({ v: doc }));
      localStorage.setItem('markbeam:scroll_bar_settings', JSON.stringify({ v: sync }));
    },
    LONG_DOCUMENT,
    syncEnabled
  );

const reload = async (page) => {
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForFunction(() => !!document.querySelector('#editor .monaco-editor'), {
    timeout: 30000
  });
  await sleep(2200);
};

/** Smallest visible line number — Monaco's scroll position, read semantically. */
const editorTopLine = (page) =>
  page.evaluate(() => {
    const numbers = [...document.querySelectorAll('#editor .line-numbers')]
      .map((n) => Number(n.textContent.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
    return numbers.length ? Math.min(...numbers) : null;
  });

const previewScroll = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('#preview');
    return { top: el.scrollTop, max: el.scrollHeight - el.clientHeight };
  });

const scrollPreviewTo = (page, fraction) =>
  page.evaluate((f) => {
    const el = document.querySelector('#preview');
    el.scrollTo(0, (el.scrollHeight - el.clientHeight) * f);
  }, fraction);

const wheelOverEditor = async (page, deltaY) => {
  const box = await page.$eval('#editor', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.move(box.x, box.y);
  await page.mouse.wheel({ deltaY });
};

/** Both panes back to the top: a large negative wheel, then the preview. */
const resetPositions = async (page) => {
  await wheelOverEditor(page, -20000);
  await sleep(300);
  await page.evaluate(() => document.querySelector('#preview').scrollTo(0, 0));
  await sleep(400);
};

export const suite = {
  name: 'scroll sync',
  async run() {
    return withPage(async (page, errors) => {
      const checks = [];

      await seed(page, true);
      await reload(page);

      // ---- editor drives the preview (this direction already worked) ----
      await wheelOverEditor(page, 1500);
      await sleep(700);
      const previewAfterEditor = await previewScroll(page);
      checks.push({
        name: 'scrolling the editor moves the preview',
        pass: previewAfterEditor.top > 0,
        detail: `preview at ${Math.round(previewAfterEditor.top)}px`
      });

      // ---- preview drives the editor (this is the bug) ----
      await resetPositions(page);
      const lineBefore = await editorTopLine(page);
      await scrollPreviewTo(page, 0.5);
      await sleep(700);
      const lineAfter = await editorTopLine(page);

      checks.push({
        name: 'scrolling the preview moves the editor',
        pass: lineAfter !== null && lineBefore !== null && lineAfter > lineBefore + 5,
        detail: `top line ${lineBefore} -> ${lineAfter}`
      });

      // ---- no runaway feedback loop ----
      for (const fraction of [0.2, 0.8, 0.35, 0.65]) {
        await scrollPreviewTo(page, fraction);
        await sleep(120);
        await wheelOverEditor(page, 400);
        await sleep(120);
      }
      await sleep(900);
      const settleA = { line: await editorTopLine(page), preview: (await previewScroll(page)).top };
      await sleep(500);
      const settleB = { line: await editorTopLine(page), preview: (await previewScroll(page)).top };

      checks.push({
        name: 'alternating scrolls settle instead of oscillating',
        pass:
          settleA.line === settleB.line && Math.abs(settleA.preview - settleB.preview) <= 1,
        detail: `line ${settleA.line}->${settleB.line}, preview ${Math.round(settleA.preview)}->${Math.round(settleB.preview)}`
      });

      // ---- disabled: neither direction syncs, and the setting persisted ----
      await seed(page, false);
      await reload(page);
      const lineOffBefore = await editorTopLine(page);
      await scrollPreviewTo(page, 0.5);
      await sleep(700);
      const lineOffAfter = await editorTopLine(page);

      checks.push({
        name: 'with sync off the preview does not move the editor',
        pass: lineOffAfter === lineOffBefore,
        detail: `top line ${lineOffBefore} -> ${lineOffAfter}`
      });

      await page.evaluate(() => document.querySelector('#preview').scrollTo(0, 0));
      await sleep(300);
      await wheelOverEditor(page, 1500);
      await sleep(700);
      const previewOff = await previewScroll(page);
      checks.push({
        name: 'with sync off the editor does not move the preview',
        pass: previewOff.top === 0,
        detail: `preview at ${Math.round(previewOff.top)}px`
      });

      // ---- the setting survives a reload ----
      await seed(page, true);
      await reload(page);
      const persisted = await page.evaluate(() =>
        JSON.parse(localStorage.getItem('markbeam:scroll_bar_settings') || 'null')
      );
      await scrollPreviewTo(page, 0.4);
      await sleep(700);
      const lineAfterReload = await editorTopLine(page);
      checks.push({
        name: 'the setting survives a reload and still syncs',
        pass: persisted && persisted.v === true && lineAfterReload > 5,
        detail: `stored ${JSON.stringify(persisted)}, top line ${lineAfterReload}`
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
