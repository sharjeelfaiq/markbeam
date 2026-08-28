import { editorText, seedDocument, sleep, withPage } from './lib.mjs';

/*
 * Editor context menu and document clearing (#146).
 *
 * Monaco installs its own context menu, which on Android replaces the only route to
 * Select All. Disabling it hands the menu back to the browser.
 *
 * Detecting this correctly took two false starts. Counting `.context-view` elements is
 * useless — Monaco keeps empty ones in the DOM permanently, and that check passed whether
 * the option was on or off. What actually distinguishes the two states is event
 * propagation: with its menu enabled Monaco swallows the `contextmenu` event so it never
 * reaches `document`; with it disabled the event propagates un-prevented, which is exactly
 * the condition under which the browser shows its own menu.
 *
 * The native menu itself is browser chrome and invisible to automation. That it appears
 * and contains Select All has to be confirmed by hand on a device.
 *
 * `window.confirm` blocks automation, so dialogs are driven explicitly. Since both paths
 * have to be handled anyway, the declined path is asserted too: that is the branch a user
 * hits by mistake on a destructive action.
 */

const SAMPLE = '# Scratch document\n\nSome text that must survive a declined confirm.';

const seedAndReload = async (page, markdown) => {
  await seedDocument(page, markdown);
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForFunction(() => !!document.querySelector('#editor .monaco-editor'), {
    timeout: 30000
  });
  await sleep(1800);
};

/** Answers the next confirm() with accept or dismiss, once. */
const answerNextDialog = (page, accept) =>
  new Promise((resolve) => {
    page.once('dialog', async (dialog) => {
      const message = dialog.message();
      await (accept ? dialog.accept() : dialog.dismiss());
      resolve(message);
    });
  });

const centreOf = async (page, selector) =>
  page.$eval(selector, (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });

export const suite = {
  name: 'editor',
  async run() {
    return withPage(async (page, errors) => {
      const checks = [];

      await seedAndReload(page, SAMPLE);

      // ---- Monaco must not intercept the context menu ----
      // Bubble phase at document level, so Monaco's own handler has already run.
      await page.evaluate(() => {
        window.__ctxEvents = [];
        document.addEventListener('contextmenu', (e) => {
          window.__ctxEvents.push({ defaultPrevented: e.defaultPrevented });
        });
      });

      const spot = await centreOf(page, '#editor');
      await page.mouse.click(spot.x, spot.y, { button: 'right' });
      await sleep(600);

      const contextEvents = await page.evaluate(() => window.__ctxEvents || []);
      const reachedDocument = contextEvents.length > 0;
      const unprevented = contextEvents.some((e) => !e.defaultPrevented);

      checks.push({
        name: 'right-click reaches the browser instead of being taken by Monaco',
        pass: reachedDocument && unprevented,
        detail: reachedDocument
          ? `event propagated, defaultPrevented=${contextEvents.map((e) => e.defaultPrevented).join(',')}`
          : 'no contextmenu event reached document — Monaco swallowed it'
      });

      // dismiss anything that did open, so it cannot affect later steps
      await page.keyboard.press('Escape');
      await sleep(300);

      // ---- disabling it must not break selection ----
      await page.click('#editor');
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyA');
      await page.keyboard.up('Control');
      await sleep(400);
      const selectionLines = await page.evaluate(
        () => document.querySelectorAll('#editor .selected-text').length
      );
      checks.push({
        name: 'Ctrl+A still selects the document',
        pass: selectionLines > 0,
        detail: `${selectionLines} selected line region(s)`
      });
      await page.keyboard.press('ArrowRight');

      // ---- the Clear button exists and is reachable ----
      const button = await page.evaluate(() => {
        const el = document.querySelector('#clear-button');
        if (!el) {
          return null;
        }
        const r = el.getBoundingClientRect();
        return {
          visible: r.width > 0 && r.height > 0,
          label: el.getAttribute('aria-label') || el.getAttribute('title') || ''
        };
      });
      checks.push({
        name: 'a Clear button is present in the toolbar',
        pass: !!button && button.visible,
        detail: button ? `labelled "${button.label}"` : 'not found'
      });

      // ---- declining the confirm leaves the document intact ----
      if (button) {
        const dismissed = answerNextDialog(page, false);
        await page.click('#clear-button');
        const dismissedMessage = await dismissed;
        await sleep(500);

        const afterDecline = await editorText(page);
        checks.push({
          name: 'declining the confirm leaves the document untouched',
          pass: afterDecline.includes('Scratch document'),
          detail: `asked "${(dismissedMessage || '').slice(0, 28)}", editor now "${afterDecline.slice(0, 36)}"`
        });

        // ---- accepting empties both panes ----
        const accepted = answerNextDialog(page, true);
        await page.click('#clear-button');
        await accepted;
        await sleep(700);

        const cleared = {
          editor: await editorText(page),
          output: await page.evaluate(() => document.querySelector('#output').textContent.trim())
        };
        checks.push({
          name: 'accepting the confirm empties both panes',
          pass: cleared.editor === '' && cleared.output === '',
          detail: `editor "${cleared.editor.slice(0, 20)}", preview "${cleared.output.slice(0, 20)}"`
        });
      } else {
        checks.push({ name: 'declining the confirm leaves the document untouched', pass: false, detail: 'no button' });
        checks.push({ name: 'accepting the confirm empties both panes', pass: false, detail: 'no button' });
      }

      // ---- Reset still restores the welcome document ----
      // Reset only prompts when the document is non-empty. Puppeteer auto-dismisses
      // dialogs with no handler attached, which would silently decline the reset and make
      // this check depend on whatever the previous step left behind — so accept
      // unconditionally here.
      const acceptAll = (dialog) => dialog.accept();
      page.on('dialog', acceptAll);

      /*
       * Opened by button, not Ctrl+K. The shortcut works with the editor focused since
       * T19, but driving it from the button keeps this check about Reset — the two stay
       * independent, and `tests/ui.test.mjs` owns the shortcut itself.
       */
      await page.click('#menu-button');
      await sleep(500);
      await page.evaluate(() => {
        const item = [...document.querySelectorAll('#palette-list .sheet__item')].find((b) =>
          b.textContent.includes('Reset')
        );
        if (item) {
          item.click();
        }
      });
      await sleep(800);

      const afterReset = await page.evaluate(() =>
        document.querySelector('#output').textContent
      );
      page.off('dialog', acceptAll);
      checks.push({
        name: 'Reset still restores the welcome document',
        pass: afterReset.includes('Welcome to Markbeam'),
        detail: afterReset.trim().slice(0, 32)
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
