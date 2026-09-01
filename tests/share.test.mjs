import { editorText, ready, seedDocument, sleep, withPage, URL as TARGET } from './lib.mjs';

/*
 * Shareable URL links (T11).
 *
 * The round trip is the requirement, and it is tested the way a recipient actually
 * experiences it: the link is opened in a browser context with empty storage, so nothing
 * can pass by reading state the sender happened to leave behind.
 *
 * Two of these checks exist because their failure modes are silent. A payload in the query
 * string works perfectly while quietly sending the document to the server on every open,
 * and a fragment left in place only shows up later as duplicate documents piling up on
 * every reload.
 */

const SHARED = [
  '# Shared note',
  '',
  'Body text with **bold**, a `code span` and an ünïcödé line — plus emoji 🎉.',
  '',
  '| A | B |',
  '| - | - |',
  '| 1 | 2 |'
].join('\n');

const boot = async (page) => {
  await ready(page);
};

/** Runs a palette command by visible title; false when there is no such command. */
const runCommand = async (page, title) => {
  await page.click('#menu-button');
  await sleep(400);
  const found = await page.evaluate((wanted) => {
    const item = [...document.querySelectorAll('#palette-list .sheet__item')].find((b) =>
      b.textContent.includes(wanted)
    );
    if (!item) return false;
    item.click();
    return true;
  }, title);
  if (!found) {
    await page.keyboard.press('Escape');
  }
  await sleep(700);
  return found;
};

const docIndex = (page) =>
  page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem('markbeam:docs')).v;
    } catch (error) {
      return null;
    }
  });

export const suite = {
  name: 'share links',
  async run() {
    const checks = [];
    let shareUrl = null;

    // ---------- sender ----------
    await withPage(async (page, errors) => {
      // The clipboard is permission-gated in headless Chrome, so the write is intercepted
      // rather than granted — the same approach copy.test.mjs uses.
      await page.evaluateOnNewDocument(`
        window.__copied = null;
        navigator.clipboard.writeText = async (t) => { window.__copied = t; };
      `);
      await seedDocument(page, SHARED, 'Shared note');
      await page.reload({ waitUntil: 'networkidle2' });
      await boot(page);

      const ran = await runCommand(page, 'Copy share link');
      await sleep(500);
      shareUrl = await page.evaluate(() => window.__copied);

      checks.push({
        name: 'the palette offers a Copy share link command',
        pass: ran,
        detail: ran ? 'found and clicked' : 'no such command'
      });

      let parsed = null;
      try {
        parsed = shareUrl ? new globalThis.URL(shareUrl) : null;
      } catch (error) {
        parsed = null;
      }

      checks.push({
        name: 'the payload rides in the fragment, never the query or path',
        pass:
          !!parsed &&
          parsed.hash.length > 16 &&
          parsed.search === '' &&
          !/Shared note/.test(parsed.pathname + parsed.search),
        detail: parsed
          ? `hash ${parsed.hash.length} chars, search "${parsed.search}", path "${parsed.pathname}"`
          : `not a URL: ${String(shareUrl).slice(0, 40)}`
      });

      checks.push({
        name: 'no console errors while sharing',
        pass: errors.length === 0,
        detail: errors[0]
      });
    });

    // ---------- recipient: a clean profile that has never seen this document ----------
    await withPage(async (page, errors) => {
      if (!shareUrl) {
        checks.push({ name: 'opening the link reproduces the document text', pass: false, detail: 'no link to open' });
        checks.push({ name: 'opening the link reproduces the document title', pass: false, detail: 'no link to open' });
        checks.push({ name: 'importing adds a document rather than replacing one', pass: false, detail: 'no link to open' });
        checks.push({ name: 'the fragment is cleared, so a reload imports no duplicate', pass: false, detail: 'no link to open' });
        return;
      }

      // Land on the app first so storage is same-origin, then wipe it: this profile must
      // know nothing about the sender's document.
      await page.goto(TARGET, { waitUntil: 'networkidle2' });
      await page.evaluate(() => localStorage.clear());

      const beforeCount = 1; // the app always boots with exactly one document

      /*
       * `goto` from `/` to `/#doc=…` differs only in the fragment, which is a
       * same-document navigation — no reload, no second `init`. The first version of this
       * test did exactly that and reported a broken feature; what it had actually found is
       * that pasting a link into an already-open tab imported nothing. That is now handled
       * by a `hashchange` listener and covered separately below, but this check wants a
       * genuine cold load, so it forces one.
       */
      await page.goto(shareUrl, { waitUntil: 'networkidle2' });
      await page.reload({ waitUntil: 'networkidle2' });
      await boot(page);
      await sleep(1500);

      const text = await editorText(page);
      const title = await page.$eval('#doc-title', (el) => el.value);
      const index = await docIndex(page);

      checks.push({
        name: 'opening the link reproduces the document text',
        pass: text.includes('Shared note') && text.includes('ünïcödé') && text.includes('🎉'),
        detail: `"${text.slice(0, 52)}"`
      });

      checks.push({
        name: 'opening the link reproduces the document title',
        pass: title === 'Shared note',
        detail: `title "${title}"`
      });

      checks.push({
        name: 'importing adds a document rather than replacing one',
        pass: Array.isArray(index) && index.length > beforeCount,
        detail: index ? `${index.length} documents: ${JSON.stringify(index.map((d) => d.title))}` : 'no index'
      });

      const hashAfter = await page.evaluate(() => location.hash);
      await page.reload({ waitUntil: 'networkidle2' });
      await boot(page);
      const afterReload = await docIndex(page);

      checks.push({
        name: 'the fragment is cleared, so a reload imports no duplicate',
        pass:
          hashAfter === '' &&
          Array.isArray(afterReload) &&
          Array.isArray(index) &&
          afterReload.length === index.length,
        detail: `hash "${hashAfter}", ${index ? index.length : '?'} -> ${afterReload ? afterReload.length : '?'} documents`
      });

      checks.push({
        name: 'no console errors while importing',
        pass: errors.length === 0,
        detail: errors[0]
      });
    });

    // ---------- pasting a link into a tab that is already open ----------
    await withPage(async (page, errors) => {
      if (!shareUrl) {
        checks.push({ name: 'a link pasted into an open tab imports too', pass: false, detail: 'no link to open' });
        return;
      }

      await boot(page);
      const before = (await docIndex(page)) || [];

      // Same-document navigation: only the fragment changes, so nothing reloads.
      await page.evaluate((url) => {
        location.hash = new globalThis.URL(url).hash;
      }, shareUrl);
      // The import is a hashchange handler, so wait for its result rather than for a duration.
      await page
        .waitForFunction(
          (count) => JSON.parse(localStorage.getItem('markbeam:docs') || 'null')?.v?.length > count,
          { timeout: 15000 },
          before.length
        )
        .catch(() => {});

      const text = await editorText(page);
      const after = (await docIndex(page)) || [];

      checks.push({
        name: 'a link pasted into an open tab imports too',
        pass: text.includes('Shared note') && after.length === before.length + 1,
        detail: `${before.length} -> ${after.length} documents, editor "${text.slice(0, 30)}"`
      });

      checks.push({
        name: 'no console errors on the pasted link',
        pass: errors.length === 0,
        detail: errors[0]
      });
    });

    /*
     * A feature that renders content straight from a URL is where a sanitiser regression
     * would matter most. Passes before the change too — there is no importer yet — so this
     * guards the fix rather than demonstrating a bug.
     */
    await withPage(async (page, errors) => {
      await page.evaluateOnNewDocument(`
        window.__copied = null;
        window.__xss = false;
        navigator.clipboard.writeText = async (t) => { window.__copied = t; };
      `);
      await seedDocument(
        page,
        'Hostile: <script>window.__xss = true;<\/script> <img src=x onerror="window.__xss = true">',
        'Hostile'
      );
      await page.reload({ waitUntil: 'networkidle2' });
      await boot(page);

      const ran = await runCommand(page, 'Copy share link');
      const hostileUrl = ran ? await page.evaluate(() => window.__copied) : null;

      if (hostileUrl) {
        await page.goto(hostileUrl, { waitUntil: 'networkidle2' });
        await boot(page);
        await sleep(1200);
      }

      const state = await page.evaluate(() => ({
        executed: window.__xss === true,
        scripts: document.querySelectorAll('#output script').length,
        handlers: document.querySelectorAll('#output [onerror]').length
      }));

      checks.push({
        name: 'a hostile link renders inert — no script, no event handler, nothing executed',
        pass: !state.executed && state.scripts === 0 && state.handlers === 0,
        detail: `executed=${state.executed}, scripts=${state.scripts}, onerror=${state.handlers}`
      });

      checks.push({
        name: 'no console errors on the hostile document',
        pass: errors.length === 0,
        detail: errors[0]
      });
    });

    return checks;
  }
};
