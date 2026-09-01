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
/*
 * Resolves with the confirm's message, or with `null` if none arrives.
 *
 * **The timeout is not defensive padding.** Without it this waits forever, and a check that
 * arms it *before* an action that turns out not to exist deadlocks the whole run rather than
 * failing — which is exactly what happened while T67 was being written: the Clear action had
 * moved out of the toolbar and not yet into the documents sheet, so no dialog ever fired and
 * the suite sat for half an hour with nothing to show. A missing dialog is a failed assertion,
 * never a hung suite.
 */
const answerNextDialog = (page, accept, timeoutMs = 8000) =>
  new Promise((resolve) => {
    let settled = false;

    /*
     * `settled` and the try/catch are both load-bearing. A timed-out arming leaves this suite
     * able to arm a second handler, and if the first dialog then arrives late, two handlers
     * answer the same one — Puppeteer throws `Cannot accept dialog which is already handled`
     * and takes the whole suite down. A dialog answered twice is a harmless race; a suite that
     * dies on it is not.
     */
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      page.off('dialog', handler);
      resolve(value);
    };

    async function handler(dialog) {
      const message = dialog.message();
      try {
        await (accept ? dialog.accept() : dialog.dismiss());
      } catch (error) {
        // Already answered by another armed handler; the message is still what we came for.
      }
      finish(message);
    }

    const timer = setTimeout(() => finish(null), timeoutMs);
    page.on('dialog', handler);
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

      // ---- Clear lives with the other document actions, not beside Export (T67) ----

      /*
       * It used to be a toolbar button wearing a page-with-an-X, a thumb's width from Export.
       * The icon read as "delete this file" rather than "empty this document", and a
       * destructive control does not belong next to the one people click most. It now sits in
       * the documents sheet beside Rename, Move and Delete — the other things that act on the
       * current document.
       *
       * Both halves of the confirm are still asserted; only the route changed. The extra check
       * is that the toolbar really did let go of it: leaving both would be the worst outcome,
       * two ways to wipe a document and one of them still in the wrong place.
       */
      const openClear = async () => {
        await page.evaluate(() => document.querySelector('#docs-button')?.click());
        await sleep(400);
        return page.evaluate(() => {
          const item = [...document.querySelectorAll('#docs-actions .sheet__item')].find((el) =>
            /clear/i.test(el.textContent || '')
          );
          if (!item) return false;
          item.click();
          return true;
        });
      };

      const toolbarStillHasIt = await page.evaluate(() => !!document.querySelector('#clear-button'));
      checks.push({
        name: 'Clear is no longer a toolbar button beside Export',
        pass: toolbarStillHasIt === false,
        detail: toolbarStillHasIt ? '#clear-button is still in the toolbar' : 'gone from the toolbar'
      });

      const reachable = await page.evaluate(() => {
        const item = [...document.querySelectorAll('#docs-actions .sheet__item')].map((el) =>
          el.textContent.trim()
        );
        return item;
      });

      // ---- declining the confirm leaves the document intact ----
      const dismissed = answerNextDialog(page, false);
      const foundDeclining = await openClear();
      const dismissedMessage = await dismissed;
      await sleep(500);

      const afterDecline = await editorText(page);
      checks.push({
        name: 'Clear is offered in the documents sheet, and declining leaves the document alone',
        pass: foundDeclining && afterDecline.includes('Scratch document'),
        detail: foundDeclining
          ? `asked "${(dismissedMessage || '').slice(0, 28)}", editor now "${afterDecline.slice(0, 36)}"`
          : `no Clear action; sheet offers: ${reachable.join(', ')}`
      });

      // ---- accepting empties both panes ----
      const accepted = answerNextDialog(page, true);
      await openClear();
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

      /*
       * The find widget's icons (T54).
       *
       * Monaco asks for its icon font relatively — `src: url(./codicon.ttf)` — and the CDN's
       * `+esm` build injects that CSS as a <style> tag, so the URL resolves against *this*
       * document rather than the CDN. The request therefore goes to Markbeam's own origin,
       * where the dev server answers it with index.html: HTTP 200, ~29 KB, no console error,
       * no failed request. The font silently never parses and all eleven icons in the widget
       * render as the same missing-glyph box.
       *
       * Getting the *signal* right took two attempts, and both wrong versions are worth
       * naming:
       *
       * - "a codicon request happened with a non-zero size" passed against the broken build,
       *   because 29 KB of HTML is a non-zero size.
       * - `document.fonts.check('16px codicon')` fails even when the fix works. Monaco's
       *   broken @font-face stays in the document, so the family has two faces — ours loaded,
       *   theirs permanently unloaded — and `check()` is only true when *every* matching face
       *   has loaded.
       *
       * What actually distinguishes the two states is whether any codicon face reached
       * `loaded`. Before the fix none can: the only face points at a URL that returns HTML.
       */
      await page.click('#editor');
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyF');
      await page.keyboard.up('Control');
      await sleep(1000);

      const icons = await page.evaluate(() => {
        const widget = document.querySelector('.monaco-editor .find-widget');
        const icon = widget?.querySelector('.codicon');

        const faces = [];
        document.fonts.forEach((face) => {
          if (/codicon/i.test(face.family)) {
            faces.push(face.status);
          }
        });

        return {
          widgetVisible: !!widget && widget.classList.contains('visible'),
          count: widget ? widget.querySelectorAll('.codicon').length : 0,
          fontFamily: icon ? getComputedStyle(icon).fontFamily : null,
          faces,
          anyLoaded: faces.includes('loaded'),
          // The broken relative URL, if anything still asks for it.
          servedFromDocumentRoot: performance
            .getEntriesByType('resource')
            .some((entry) => new URL(entry.name).pathname === '/codicon.ttf')
        };
      });

      checks.push({
        name: 'the find widget renders real icons rather than one repeated glyph',
        pass: icons.widgetVisible && icons.count > 0 && icons.anyLoaded,
        detail: `${icons.count} icons, font-family ${icons.fontFamily}, faces [${icons.faces.join(', ')}]`
      });

      checks.push({
        name: 'nothing fetches the icon font from the page root any more',
        pass: icons.anyLoaded && !icons.servedFromDocumentRoot,
        detail: icons.servedFromDocumentRoot
          ? 'something requested /codicon.ttf from the document root — the broken relative URL is still live'
          : 'no page-root codicon request'
      });

      await page.keyboard.press('Escape');
      await sleep(300);

      checks.push({
        name: 'no console errors',
        pass: errors.length === 0,
        detail: errors[0]
      });

      return checks;
    });
  }
};
