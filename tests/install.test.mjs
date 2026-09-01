import { sleep, withPage, ready } from './lib.mjs';

/*
 * The install prompt (T60).
 *
 * Two things are being tested and they pull in opposite directions: that the offer *appears*,
 * and that it appears **only** when it has been earned. The second half is the harder one and
 * the reason this suite exists — an install banner that shows on arrival, or again after being
 * dismissed, is the exact pattern browsers removed their own infobars over.
 *
 * `beforeinstallprompt` is dispatched synthetically rather than waited for. Chrome may fire a
 * real one here (the manifest and the service worker do satisfy the criteria on localhost),
 * and that is harmless: every assertion below is about how the app reacts, not about who
 * dispatched the event. Waiting for the real one instead would make the suite depend on
 * Chrome's install heuristics, which are undocumented and change between versions.
 */

const STATE_KEY = 'markbeam:install';

/*
 * Installed before any app code runs, so the stashed event is a real object with a `prompt()`
 * we can observe. `evaluateOnNewDocument` is what makes it survive the reload each check does.
 */
const INSTRUMENT = `
  window.__installPrompts = 0;
  window.__fireInstallPrompt = () => {
    const event = new Event('beforeinstallprompt');
    event.prompt = () => {
      window.__installPrompts += 1;
      return Promise.resolve();
    };
    event.userChoice = Promise.resolve({ outcome: 'accepted' });
    window.dispatchEvent(event);
  };
`;

const boot = async (page) => {
  await ready(page);
};

/** Seeds the stored state directly: engagement is a clock, and no suite should wait 45s. */
const seedState = (page, state) =>
  page.evaluate(
    ({ key, value }) => {
      if (value === null) {
        localStorage.removeItem(key);
      } else {
        localStorage.setItem(key, JSON.stringify({ v: value }));
      }
    },
    { key: STATE_KEY, value: state }
  );

const readState = (page) =>
  page.evaluate((key) => {
    try {
      return JSON.parse(localStorage.getItem(key) || 'null')?.v ?? null;
    } catch (error) {
      return null;
    }
  }, STATE_KEY);

const bannerVisible = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('#install');
    if (!el || el.hidden) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });

/** Types into Monaco, which is what the character-count engagement signal counts. */
const typeIntoEditor = async (page, text) => {
  await page.evaluate(() => document.querySelector('#editor')?.click());
  await page.keyboard.type(text, { delay: 4 });
  await sleep(600);
};

const runCommand = async (page, needle) => {
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyK');
  await page.keyboard.up('Control');
  // The palette paints its items on open; wait for one to exist rather than for a duration.
  await page
    .waitForFunction(
      () =>
        document.querySelectorAll('#palette .sheet__item, #palette-list .sheet__item').length > 0,
      { timeout: 10000 }
    )
    .catch(() => {});
  const clicked = await page.evaluate((text) => {
    const item = [...document.querySelectorAll('#palette .sheet__item')].find((el) =>
      el.textContent.toLowerCase().includes(text.toLowerCase())
    );
    if (!item) return false;
    item.click();
    return true;
  }, needle);
  if (!clicked) {
    await page.keyboard.press('Escape');
  }
  await sleep(600);
  return clicked;
};

export const suite = {
  name: 'install prompt',
  async run() {
    const checks = [];

    // ---------- it does not appear on arrival ----------

    await withPage(async (page, errors) => {
      await page.evaluateOnNewDocument(INSTRUMENT);
      await page.goto((await page.url()) || 'about:blank').catch(() => {});
      await seedState(page, { visits: 0, dismissals: 0, lastDismissedAt: 0, installedAt: 0 });
      await page.reload({ waitUntil: 'networkidle2' });
      await boot(page);

      await page.evaluate(() => window.__fireInstallPrompt());
      await sleep(1200);

      checks.push({
        name: 'a first-time visitor who has done nothing is not asked',
        pass: (await bannerVisible(page)) === false,
        detail: 'banner hidden with no engagement'
      });

      // ---------- and appears once the editor has actually been used ----------

      await typeIntoEditor(page, 'Typing enough to count as using the editor rather than glancing at it.');
      await sleep(1200);

      checks.push({
        name: 'it appears once the visitor has really used the editor',
        pass: (await bannerVisible(page)) === true,
        detail: `banner visible=${await bannerVisible(page)}`
      });

      // ---------- Install goes through the browser's own prompt ----------

      const installed = await page.evaluate(() => {
        const button = document.querySelector('#install-accept');
        if (!button) return false;
        button.click();
        return true;
      });
      await sleep(900);

      const prompts = await page.evaluate(() => window.__installPrompts);
      checks.push({
        name: 'Install calls the browser prompt rather than faking one',
        pass: installed === true && prompts === 1,
        detail: `prompt() called ${prompts} time(s)`
      });

      checks.push({ name: 'no console errors', pass: errors.length === 0, detail: errors[0] });
    });

    // ---------- dismissal is remembered ----------

    await withPage(async (page, errors) => {
      await page.evaluateOnNewDocument(INSTRUMENT);
      await seedState(page, { visits: 2, dismissals: 0, lastDismissedAt: 0, installedAt: 0 });
      await page.reload({ waitUntil: 'networkidle2' });
      await boot(page);

      await page.evaluate(() => window.__fireInstallPrompt());
      await sleep(1200);

      const appearedForReturningVisitor = await bannerVisible(page);
      checks.push({
        name: 'a returning visitor is asked without having to type first',
        pass: appearedForReturningVisitor === true,
        detail: `visits=2, banner visible=${appearedForReturningVisitor}`
      });

      await page.evaluate(() => document.querySelector('#install-dismiss')?.click());
      await sleep(600);

      const afterDismiss = await readState(page);
      checks.push({
        name: 'dismissing it is recorded, not merely hidden',
        pass: !!afterDismiss && afterDismiss.dismissals === 1 && afterDismiss.lastDismissedAt > 0,
        detail: JSON.stringify(afterDismiss)
      });

      await page.reload({ waitUntil: 'networkidle2' });
      await boot(page);
      await page.evaluate(() => window.__fireInstallPrompt());
      await typeIntoEditor(page, 'More typing, which would otherwise be enough to trigger the offer.');
      await sleep(1200);

      checks.push({
        name: 'and it stays away on the next visit',
        pass: (await bannerVisible(page)) === false,
        detail: 'still hidden inside the backoff window'
      });

      checks.push({ name: 'no console errors', pass: errors.length === 0, detail: errors[0] });
    });

    // ---------- already installed, and the palette command ----------

    await withPage(async (page, errors) => {
      await page.evaluateOnNewDocument(INSTRUMENT);
      await seedState(page, {
        visits: 5,
        dismissals: 0,
        lastDismissedAt: 0,
        installedAt: 1756600000000
      });
      await page.reload({ waitUntil: 'networkidle2' });
      await boot(page);

      await page.evaluate(() => window.__fireInstallPrompt());
      await typeIntoEditor(page, 'Plenty of typing from somebody who already installed this.');
      await sleep(1200);

      checks.push({
        name: 'somebody who already installed it is never asked again',
        pass: (await bannerVisible(page)) === false,
        detail: 'banner hidden with installedAt set'
      });

      // The palette command is the way back for anyone who dismissed it.
      await seedState(page, { visits: 1, dismissals: 3, lastDismissedAt: Date.now(), installedAt: 0 });
      await page.reload({ waitUntil: 'networkidle2' });
      await boot(page);
      await page.evaluate(() => window.__fireInstallPrompt());

      const opened = await runCommand(page, 'install markbeam');
      await sleep(600);
      /*
       * Asking from the palette is explicit, so the right answer is the browser's own prompt
       * straight away — not our banner asking a second time. Where there is no prompt to fire
       * (iOS, or a browser that never offered one) the instructions or the banner stand in, so
       * all three count: what is being asserted is that three refusals do not lock somebody
       * out of installing, not which surface answers.
       */
      const reachable = await page.evaluate(() => {
        const banner = document.querySelector('#install');
        const help = document.querySelector('#install-help');
        return (
          window.__installPrompts > 0 ||
          (!!banner && !banner.hidden) ||
          (!!help && help.open === true)
        );
      });

      checks.push({
        name: 'the palette can still reach it after every refusal',
        pass: opened === true && reachable === true,
        detail: opened
          ? `prompts=${await page.evaluate(() => window.__installPrompts)}, reachable=${reachable}`
          : 'no install command in the palette'
      });

      // ---------- the banner must not break the narrow layout ----------

      await page.setViewport({ width: 375, height: 800 });
      await sleep(600);
      const narrow = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        bannerVisible: (() => {
          const el = document.querySelector('#install');
          return !!el && !el.hidden && el.getBoundingClientRect().height > 0;
        })()
      }));

      checks.push({
        name: 'no horizontal overflow at 375px with the banner up',
        pass: narrow.overflow <= 0,
        detail: `overflow ${narrow.overflow}px, banner visible=${narrow.bannerVisible}`
      });

      checks.push({ name: 'no console errors', pass: errors.length === 0, detail: errors[0] });
    });

    return checks;
  }
};
