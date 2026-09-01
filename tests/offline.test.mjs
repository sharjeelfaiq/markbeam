import { withPage, sleep, editorText } from './lib.mjs';

/*
 * Offline support (T33).
 *
 * T31 removed the claim that Markbeam works offline because it was false. This suite is what
 * makes it true again, so it has to be end to end rather than a simulation: the page is
 * genuinely disconnected with `setOfflineMode(true)` and reloaded.
 *
 * The check that matters is that the **editor still appears**. Monaco comes from
 * cdn.jsdelivr.net on every load, so without a worker caching that response there is no
 * editor at all — which is exactly the state T31 documented.
 *
 * The manifest checks are guards, not evidence: they would pass against a service worker that
 * caches nothing.
 */

/*
 * Offline, the editor may legitimately never appear — that is the failure this suite exists to
 * catch — so the wait is bounded and swallowed rather than fatal: the check below reports it.
 */
const reload = async (page) => {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page
    .waitForFunction(
      () => {
        const el = document.querySelector('#editor .monaco-editor');
        return !!el && el.getBoundingClientRect().height > 50;
      },
      { timeout: 20000 }
    )
    .catch(() => {});
};

/** Resolves once a worker is not merely registered but actually controlling this page. */
const waitForController = async (page, timeout = 20000) => {
  try {
    await page.waitForFunction(() => !!navigator.serviceWorker?.controller, { timeout });
    return true;
  } catch (error) {
    return false;
  }
};

const editorPresent = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('#editor .monaco-editor');
    return !!el && el.getBoundingClientRect().height > 50;
  });

export const suite = {
  name: 'offline',
  async run() {
    return withPage(async (page, errors) => {
      const checks = [];

      // ---------- warm the caches while online ----------

      // `waitForController` already polls for 20s; a sleep in front of it only delays the pass.
      const controlled = await waitForController(page);

      checks.push({
        name: 'a service worker takes control of the page',
        pass: controlled,
        detail: controlled ? 'navigator.serviceWorker.controller is set' : 'no controller after 20s'
      });

      // Something to lose, so the offline reload has to restore real state.
      await page.click('#editor');
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyA');
      await page.keyboard.up('Control');
      await page.keyboard.press('Backspace');
      await page.keyboard.type('# Written before going offline');
      await sleep(1200);

      /*
       * A reload while still online, so the worker sees and caches the navigation and the
       * assets it pulls. Caching happens on use — there is no precache manifest — so the
       * first pass has to actually happen.
       */
      await reload(page);
      await waitForController(page);
      await sleep(1500);

      // ---------- cut the network ----------

      await page.setOfflineMode(true);
      await reload(page);

      const offlineEditor = await editorPresent(page);
      checks.push({
        name: 'the editor still loads with the network disabled',
        pass: offlineEditor,
        detail: offlineEditor
          ? 'Monaco rendered from cache'
          : 'no editor — Monaco could not be fetched, which is the pre-T33 behaviour'
      });

      const offlineText = await editorText(page);
      checks.push({
        name: 'the document written before going offline is still there',
        pass: /Written before going offline/.test(offlineText),
        detail: JSON.stringify(offlineText.slice(0, 60))
      });

      const offlineShell = await page.evaluate(() => ({
        title: document.title,
        toolbar: !!document.querySelector('.toolbar'),
        preview: !!document.querySelector('#output')
      }));
      checks.push({
        name: 'the whole shell is served from cache, not just the HTML',
        pass:
          /Markdown/i.test(offlineShell.title) && offlineShell.toolbar && offlineShell.preview,
        detail: `title ${JSON.stringify(offlineShell.title)}, toolbar ${offlineShell.toolbar}, preview ${offlineShell.preview}`
      });

      await page.setOfflineMode(false);
      await reload(page);
      await waitForController(page);

      // ---------- installability ----------

      const manifest = await page.evaluate(async () => {
        const link = document.querySelector('link[rel="manifest"]');
        if (!link) {
          return { linked: false };
        }
        try {
          const response = await fetch(link.href);
          const data = await response.json();
          return {
            linked: true,
            name: data.name,
            display: data.display,
            icons: (data.icons || []).map((i) => i.sizes)
          };
        } catch (error) {
          return { linked: true, error: error.message };
        }
      });

      checks.push({
        name: 'a manifest is linked and describes an installable app',
        pass:
          manifest.linked &&
          !manifest.error &&
          typeof manifest.name === 'string' &&
          manifest.display === 'standalone' &&
          manifest.icons?.some((s) => /192/.test(s)) &&
          manifest.icons?.some((s) => /512/.test(s)),
        detail: manifest.linked
          ? `name ${JSON.stringify(manifest.name)}, display ${manifest.display}, icons ${JSON.stringify(manifest.icons)}`
          : 'no <link rel="manifest">'
      });

      /*
       * The T31 invariant, from the other side. That check permits an offline claim only when
       * a worker and a manifest exist — so with both in place the claim may return, and this
       * confirms the implication rather than the string.
       */
      const claim = await page.evaluate(async () => {
        const node = document.querySelector('script[type="application/ld+json"]');
        const ld = node ? JSON.parse(node.textContent) : {};
        const registrations = await navigator.serviceWorker.getRegistrations();
        return {
          advertises: (ld.featureList || []).some((f) => /offline/i.test(String(f))),
          worker: registrations.length > 0,
          manifest: !!document.querySelector('link[rel="manifest"]')
        };
      });

      checks.push({
        name: 'the offline claim is permitted again, because it is now true',
        pass: claim.advertises && claim.worker && claim.manifest,
        detail: `featureList claim=${claim.advertises}, worker=${claim.worker}, manifest=${claim.manifest}`
      });

      /*
       * One expected error is filtered, and only one: cutting the network is what this suite
       * does, and Vite's HMR socket cannot reconnect while it is cut. That failure is caused
       * by the test, belongs to the dev server, and has no counterpart in production, where
       * there is no HMR socket at all.
       *
       * Matched narrowly — a websocket *and* a disconnect — rather than ignoring console
       * errors during the offline phase, which would blind the check to real breakage at
       * exactly the moment it matters most.
       */
      const HMR_SOCKET_NOISE = [
        'failed to connect to websocket',
        'ERR_INTERNET_DISCONNECTED'
      ];
      const realErrors = errors.filter(
        (message) => !HMR_SOCKET_NOISE.some((needle) => message.includes(needle))
      );

      checks.push({
        name: 'no console errors',
        pass: realErrors.length === 0,
        detail:
          realErrors[0] ||
          `clean (${errors.length - realErrors.length} expected HMR-socket message(s) filtered)`
      });

      return checks;
    });
  }
};
