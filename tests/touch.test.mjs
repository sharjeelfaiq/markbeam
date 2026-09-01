import puppeteer from 'puppeteer-core';
import { CHROME, URL as TARGET, sleep } from './lib.mjs';

/*
 * The keyboard on a phone (T64).
 *
 * Reported from a real device: dragging to scroll over the source pane raised the on-screen
 * keyboard every time, while a fresh load was quiet.
 *
 * **The obvious explanation is wrong, and this suite exists partly to record that.** The first
 * theory was that Monaco focuses its hidden textarea when a touch lands in the editor. Measured
 * under touch emulation, a drag focuses nothing — `activeElement` stays `body`. The real
 * sequence is:
 *
 *   1. `setValue()` calls `editor.focus()` on boot, for the welcome document, on every load.
 *   2. A *programmatic* focus cannot raise a keyboard — browsers require a user gesture — so
 *      the page looks quiet, which is exactly what made the report say "not on load".
 *   3. The first touch anywhere in the editor **is** that gesture. The browser sees a touch on
 *      an already-focused text field and shows the keyboard. Scrolling never focused anything;
 *      it redeemed a focus granted at boot.
 *
 * So what is asserted here is that **the editor is not focused on arrival on a touch device**,
 * and that tapping still focuses it. Focus is the testable proxy: a headless browser has no
 * on-screen keyboard, and focus is precisely what summons one.
 *
 * Its own browser rather than `withPage`, because `hasTouch` has to be set at launch — a page
 * that started as a desktop viewport does not reliably become a touch device afterwards.
 */

const EDITOR = '#editor .monaco-editor';

/** Monaco's hidden textarea is what holds the caret, and what a phone reacts to. */
const focused = (page) =>
  page.evaluate(() => {
    const active = document.activeElement;
    return {
      inputarea: !!active && active.classList.contains('inputarea'),
      what: active ? active.className.split(' ')[0] || active.tagName.toLowerCase() : 'none'
    };
  });

const launch = (hasTouch) =>
  puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    protocolTimeout: 600000,
    defaultViewport: hasTouch
      ? { width: 390, height: 780, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }
      : { width: 1400, height: 900 }
  });

const boot = async (page) => {
  await page.goto(TARGET, { waitUntil: 'networkidle2', timeout: 60000 });
  await page.waitForSelector(EDITOR, { timeout: 30000 });
  await sleep(2500);
};

export const suite = {
  name: 'touch',
  async run() {
    const checks = [];

    // ---------- a phone ----------

    const phone = await launch(true);
    try {
      const page = await phone.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(`console.error: ${message.text()}`);
      });

      await boot(page);

      const onArrival = await focused(page);
      checks.push({
        name: 'the editor is not focused on arrival, so the first touch cannot raise a keyboard',
        // The whole bug in one assertion. Focused here means the browser owes the visitor a
        // keyboard, and pays it the moment they touch the screen — including to scroll.
        pass: onArrival.inputarea === false,
        detail: `activeElement=${onArrival.what}`
      });

      // Below ~900px the panes are tabs; the editor must be the visible one for this to mean
      // anything, and switching to it must not focus either.
      await page.evaluate(() => document.querySelector('[data-view-mode="editor"]')?.click());
      await sleep(600);

      const afterTab = await focused(page);
      checks.push({
        name: 'and switching to the editor tab does not focus it either',
        pass: afterTab.inputarea === false,
        detail: `activeElement=${afterTab.what}`
      });

      const box = await page.evaluate(() => {
        const rect = document.querySelector('#editor').getBoundingClientRect();
        return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
      });

      await page.touchscreen.touchStart(box.x, box.y + 150);
      for (let step = 1; step <= 8; step += 1) {
        await page.touchscreen.touchMove(box.x, box.y + 150 - step * 30);
        await sleep(25);
      }
      await page.touchscreen.touchEnd();
      await sleep(700);

      const afterDrag = await focused(page);
      checks.push({
        name: 'dragging to scroll leaves it unfocused',
        pass: afterDrag.inputarea === false,
        detail: `activeElement=${afterDrag.what}`
      });

      // The half that stops the fix becoming "never focus", which would leave the editor
      // untypable on a phone — a worse bug than the one being fixed.
      await page.touchscreen.tap(box.x, box.y);
      await sleep(700);

      const afterTap = await focused(page);
      checks.push({
        name: 'tapping the editor still focuses it, so the keyboard opens when asked for',
        pass: afterTap.inputarea === true,
        detail: `activeElement=${afterTap.what}`
      });

      /*
       * ---- the sequence that was actually reported (T68) ----
       *
       * T64 removed the focus granted at boot. This is the focus left behind after somebody
       * has typed: Android's back button dismisses the keyboard **without blurring anything**,
       * so the field stays focused and every later touch — including a drag meant to scroll —
       * is a fresh gesture on a focused text field, which the browser answers with the
       * keyboard. Dismissing it again changes nothing, because dismissal was never the state
       * that mattered.
       *
       * The tap below is asserted before the drag on purpose: if focusing were broken, the
       * drag check would pass for entirely the wrong reason.
       */
      await page.touchscreen.tap(box.x, box.y);
      await sleep(600);
      const beforeScroll = await focused(page);

      checks.push({
        name: 'tapping first focuses the editor, as it should',
        pass: beforeScroll.inputarea === true,
        detail: `activeElement=${beforeScroll.what}`
      });

      await page.touchscreen.touchStart(box.x, box.y + 150);
      for (let step = 1; step <= 8; step += 1) {
        await page.touchscreen.touchMove(box.x, box.y + 150 - step * 30);
        await sleep(25);
      }
      await page.touchscreen.touchEnd();
      await sleep(700);

      const afterScrollWhileFocused = await focused(page);
      checks.push({
        name: 'and dragging afterwards lets the focus go, so the keyboard stays shut',
        pass: afterScrollWhileFocused.inputarea === false,
        detail: `activeElement=${afterScrollWhileFocused.what}`
      });

      await page.touchscreen.tap(box.x, box.y);
      await sleep(600);
      const backAgain = await focused(page);
      checks.push({
        name: 'and tapping again brings it back, so the editor is still typable',
        // Without this, "fixed" and "focus removed for good" look identical from here.
        pass: backAgain.inputarea === true,
        detail: `activeElement=${backAgain.what}`
      });

      checks.push({ name: 'no console errors on a phone', pass: errors.length === 0, detail: errors[0] });
    } finally {
      await phone.close().catch(() => {});
    }

    // ---------- and a desktop, which must keep the behaviour it has ----------

    /*
     * The fix is conditional on a coarse pointer, so this is the other side of it: on a mouse
     * machine, opening a document should still land the caret in the editor. Without this
     * check, "fix" and "remove the focus entirely" look identical from the phone side.
     */
    const desktop = await launch(false);
    try {
      const page = await desktop.newPage();
      await boot(page);

      const onArrival = await focused(page);
      checks.push({
        name: 'on a mouse machine the editor is still focused on arrival',
        pass: onArrival.inputarea === true,
        detail: `activeElement=${onArrival.what}`
      });
    } finally {
      await desktop.close().catch(() => {});
    }

    return checks;
  }
};
