import { withPage, sleep, seedDocument } from './lib.mjs';

/*
 * Document outline (T35).
 *
 * Two checks carry the proof, and the rest would pass against a sheet that lists headings and
 * does nothing:
 *
 *   - picking a heading actually scrolls the preview to it;
 *   - picking from Editor-only view makes the preview visible first, because there the pane is
 *     `display: none` and scrolling it is a no-op.
 *
 * Rendered headings have no `id` — marked adds none here — so rows are matched by DOM index
 * rather than by fragment.
 */

// Long enough that the preview genuinely scrolls, with a heading far down to jump to.
const LONG_DOCUMENT = [
  '# Top level',
  '',
  ...Array.from({ length: 25 }, (_, i) => `Paragraph ${i + 1} under the first heading.`),
  '',
  '## Middle section',
  '',
  ...Array.from({ length: 25 }, (_, i) => `Paragraph ${i + 1} under the middle heading.`),
  '',
  '### Deeply nested',
  '',
  ...Array.from({ length: 25 }, (_, i) => `Paragraph ${i + 1} under the nested heading.`),
  '',
  '## Final destination',
  '',
  ...Array.from({ length: 25 }, (_, i) => `Paragraph ${i + 1} at the very end.`)
].join('\n');

const boot = async (page) => {
  await page.waitForFunction(() => !!document.querySelector('#editor .monaco-editor'), {
    timeout: 30000
  });
  await sleep(1800);
};

/** Opens the palette and clicks a command by visible text. False when it does not exist. */
const runCommand = async (page, title) => {
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyK');
  await page.keyboard.up('Control');
  await sleep(400);

  const clicked = await page.evaluate((needle) => {
    const item = [...document.querySelectorAll('#palette .sheet__item')].find((el) =>
      el.textContent.includes(needle)
    );
    if (!item) return false;
    item.click();
    return true;
  }, title);

  if (!clicked) {
    await page.keyboard.press('Escape');
  }
  await sleep(500);
  return clicked;
};

const outlineRows = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('#outline .sheet__item')].map((el) => ({
      text: el.textContent.replace(/\s+/g, ' ').trim(),
      level: el.dataset.level || null
    }))
  );

const previewState = (page) =>
  page.evaluate(() => {
    const pane = document.querySelector('.pane--preview');
    return {
      visible: !!pane && getComputedStyle(pane).display !== 'none',
      scrollTop: pane ? Math.round(pane.scrollTop) : null,
      scrollable: pane ? pane.scrollHeight - pane.clientHeight : 0
    };
  });

export const suite = {
  name: 'outline',
  async run() {
    return withPage(async (page, errors) => {
      const checks = [];

      await seedDocument(page, LONG_DOCUMENT, 'Outline fixture');
      await page.reload({ waitUntil: 'networkidle2' });
      await boot(page);

      // ---------- the command and the list ----------

      const opened = await runCommand(page, 'Document outline');
      const rows = opened ? await outlineRows(page) : [];

      checks.push({
        name: 'the palette offers a Document outline command',
        pass: opened,
        detail: opened ? 'opened' : 'no such palette command'
      });

      checks.push({
        name: 'every heading in the document is listed',
        pass:
          rows.length === 4 &&
          rows.some((r) => /Top level/.test(r.text)) &&
          rows.some((r) => /Middle section/.test(r.text)) &&
          rows.some((r) => /Deeply nested/.test(r.text)) &&
          rows.some((r) => /Final destination/.test(r.text)),
        detail: `${rows.length} rows: ${JSON.stringify(rows.map((r) => r.text))}`
      });

      checks.push({
        name: 'nesting depth is carried on the row, not flattened away',
        pass:
          rows.length > 0 &&
          rows.every((r) => r.level !== null) &&
          new Set(rows.map((r) => r.level)).size >= 3,
        detail: `levels: ${JSON.stringify(rows.map((r) => r.level))}`
      });

      // ---------- the check that matters: it actually scrolls ----------

      const before = await previewState(page);

      const picked = await page.evaluate(() => {
        const item = [...document.querySelectorAll('#outline .sheet__item')].find((el) =>
          el.textContent.includes('Middle section')
        );
        if (!item) return false;
        item.click();
        return true;
      });
      // Smooth scrolling needs time to land.
      await sleep(1600);

      const after = await previewState(page);
      const headingNearTop = await page.evaluate(() => {
        const pane = document.querySelector('.pane--preview');
        const heading = [...document.querySelectorAll('#output h1,#output h2,#output h3')].find(
          (h) => /Middle section/.test(h.textContent)
        );
        if (!pane || !heading) return null;
        return Math.round(heading.getBoundingClientRect().top - pane.getBoundingClientRect().top);
      });

      /*
       * Either the heading reached the top of the pane, or the pane ran out of scroll trying.
       * The second case is not a failure and is not hypothetical: a heading in the last
       * screenful of a document can never sit at the top, because there is nothing below it to
       * scroll up. An earlier version of this check asserted only the first condition and
       * failed against correct behaviour — 871 of 871 pixels scrolled, heading 480px down.
       */
      const atScrollEnd = after.scrollTop >= before.scrollable - 2;

      checks.push({
        name: 'choosing a heading scrolls the preview to it',
        pass:
          picked &&
          before.scrollable > 100 &&
          after.scrollTop > before.scrollTop &&
          headingNearTop !== null &&
          (Math.abs(headingNearTop) < 120 || atScrollEnd),
        detail: picked
          ? `scrollTop ${before.scrollTop} -> ${after.scrollTop} of ${before.scrollable}, heading ${headingNearTop}px from the pane top${atScrollEnd ? ' (pane at its scroll end)' : ''}`
          : 'no row to choose'
      });

      // ---------- Editor-only view, where a naive scroll is a no-op ----------

      await page.click('[data-view-mode="editor"]');
      await sleep(500);
      const hiddenBefore = await previewState(page);

      const openedFromEditor = await runCommand(page, 'Document outline');
      if (openedFromEditor) {
        await page.evaluate(() => {
          const item = [...document.querySelectorAll('#outline .sheet__item')].find((el) =>
            el.textContent.includes('Middle section')
          );
          item?.click();
        });
        await sleep(1400);
      }

      const shownAfter = await previewState(page);
      checks.push({
        name: 'choosing a heading from Editor-only view reveals the preview first',
        pass: hiddenBefore.visible === false && shownAfter.visible === true,
        detail: `preview visible ${hiddenBefore.visible} -> ${shownAfter.visible}`
      });

      await page.click('[data-view-mode="split"]');
      await sleep(400);

      // ---------- the list follows the document ----------

      await page.click('#editor');
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyA');
      await page.keyboard.up('Control');
      await page.keyboard.press('Backspace');
      await page.keyboard.type('# Only heading now');
      await sleep(900);

      const afterEdit = (await runCommand(page, 'Document outline'))
        ? await outlineRows(page)
        : [];
      await page.keyboard.press('Escape');
      await sleep(300);

      checks.push({
        name: 'the outline reflects the document as it is now, not as it was',
        pass: afterEdit.length === 1 && /Only heading now/.test(afterEdit[0]?.text || ''),
        detail: `${afterEdit.length} rows: ${JSON.stringify(afterEdit.map((r) => r.text))}`
      });

      // ---------- empty state ----------

      await page.click('#editor');
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyA');
      await page.keyboard.up('Control');
      await page.keyboard.press('Backspace');
      await page.keyboard.type('Just prose, no headings at all.');
      await sleep(900);

      const emptyOpened = await runCommand(page, 'Document outline');
      const emptyState = emptyOpened
        ? await page.evaluate(() => {
            const empty = document.querySelector('#outline .sheet__empty');
            return {
              rows: document.querySelectorAll('#outline .sheet__item').length,
              message: empty ? empty.textContent.trim() : null
            };
          })
        : null;
      await page.keyboard.press('Escape');
      await sleep(300);

      checks.push({
        name: 'a document with no headings shows an empty state rather than a blank sheet',
        pass: !!emptyState && emptyState.rows === 0 && !!emptyState.message,
        detail: emptyState
          ? `${emptyState.rows} rows, message ${JSON.stringify(emptyState.message)}`
          : 'outline did not open'
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
