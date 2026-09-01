import { seedDocument, sleep, withPage, ready } from './lib.mjs';

/*
 * `[TOC]` (T42).
 *
 * T35 gave the app an outline — a sheet you open. This puts a contents list *in the document*,
 * so it reaches the HTML and Word exports and the paginated PDF, which the outline never
 * could.
 *
 * Heading ids are new, and they reverse a decision T35 recorded deliberately. That makes the
 * duplicate-slug case worth exercising rather than assuming: two headings with the same text
 * are ordinary in a real document (`## Notes` under two sections), and a naive slugger gives
 * them the same id, so every link to the second one silently goes to the first.
 *
 * The PDF is a rasterised image — nothing in that path carries a link — so the entries become
 * jsPDF annotations laid over the bitmap. Check 7 parses them out of the file rather than
 * trusting that the code ran.
 */

const INSTRUMENT = `
window.__downloads = [];
const origCreate = URL.createObjectURL;
URL.createObjectURL = function (blob) {
  const url = origCreate.call(URL, blob);
  const record = { type: blob.type, size: blob.size, url, text: null, name: null };
  window.__downloads.push(record);
  blob.text().then((t) => { record.text = t; });
  return url;
};

const origClick = HTMLAnchorElement.prototype.click;
HTMLAnchorElement.prototype.click = function () {
  const hit = window.__downloads.find((d) => d.url === this.href);
  if (hit) { hit.name = this.getAttribute('download'); }
  // Deliberately not calling through: a real navigation would abort the page.
};
`;

/*
 * Two headings share the text "Notes" on purpose, and "Setup & Config" carries punctuation and
 * an ampersand — the two things a slugger gets wrong.
 */
const DOC = [
  '# Handbook',
  '',
  '[TOC]',
  '',
  '## Setup & Config',
  '',
  'Body text for setup.',
  '',
  '### Notes',
  '',
  'First notes section.',
  '',
  '## Usage',
  '',
  ...Array.from({ length: 160 }, (_, i) => `Usage paragraph ${i + 1}.`),
  '',
  '### Notes',
  '',
  'Second notes section, same heading text as the first.'
].join('\n');

const NO_TOC_DOC = ['# Plain', '', '## A section', '', 'No marker here.'].join('\n');

const boot = async (page) => {
  await ready(page);
};

const runCommand = async (page, title) => {
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
  await sleep(600);
  return clicked;
};

export const suite = {
  name: 'table of contents',
  async run() {
    const checks = [];

    await withPage(async (page, errors) => {
      await page.evaluateOnNewDocument(INSTRUMENT);
      await seedDocument(page, DOC, 'Handbook');
      await page.reload({ waitUntil: 'networkidle2' });
      await boot(page);

      const rendered = await page.evaluate(() => {
        const nav = document.querySelector('#output .mb-toc');
        const links = nav ? [...nav.querySelectorAll('a')] : [];
        return {
          hasNav: !!nav,
          nested: nav ? nav.querySelectorAll('ul ul').length : 0,
          entries: links.map((a) => ({
            text: a.textContent.trim(),
            href: a.getAttribute('href')
          })),
          headingIds: [...document.querySelectorAll('#output h1, #output h2, #output h3')].map(
            (h) => h.id
          ),
          markerLeft: /\[TOC\]/.test(document.querySelector('#output')?.textContent || '')
        };
      });

      checks.push({
        name: 'the marker renders a nested contents list, and does not survive as text',
        pass: rendered.hasNav && rendered.entries.length >= 5 && rendered.nested >= 1 && !rendered.markerLeft,
        detail: `nav=${rendered.hasNav}, ${rendered.entries.length} entries, ${rendered.nested} nested lists, marker left=${rendered.markerLeft}`
      });

      checks.push({
        name: 'headings get GitHub-style slugs, and a repeated heading is not a duplicate id',
        pass:
          rendered.headingIds.includes('setup-config') &&
          rendered.headingIds.includes('notes') &&
          rendered.headingIds.includes('notes-1') &&
          new Set(rendered.headingIds).size === rendered.headingIds.length,
        detail: JSON.stringify(rendered.headingIds)
      });

      /*
       * The check the duplicate case exists for. A naive slugger gives both "Notes" headings
       * the same id, so the second entry links to the first section and nobody notices until
       * they click it.
       */
      const resolve = await page.evaluate(() => {
        const nav = document.querySelector('#output .mb-toc');
        if (!nav) return null;
        return [...nav.querySelectorAll('a')].map((a) => {
          const id = decodeURIComponent(a.getAttribute('href').slice(1));
          const target = document.querySelector(`#output [id="${CSS.escape(id)}"]`);
          return { href: a.getAttribute('href'), resolves: !!target, text: target?.textContent.trim() };
        });
      });

      checks.push({
        name: 'every entry resolves to a distinct heading that exists',
        pass:
          Array.isArray(resolve) &&
          resolve.length >= 5 &&
          resolve.every((r) => r.resolves) &&
          new Set(resolve.map((r) => r.href)).size === resolve.length,
        detail: resolve ? JSON.stringify(resolve.map((r) => `${r.href}->${r.resolves}`)) : 'no nav'
      });

      // Clicking one uses T56's pane-scrolling path, so the shell must not move.
      const jumped = await page.evaluate(() => {
        document.documentElement.scrollTop = 0;
        const link = document.querySelector('#output .mb-toc a[href="#usage"]');
        if (!link) return null;
        /*
         * A dispatched event, not `.click()`. This suite's download instrument replaces
         * `HTMLAnchorElement.prototype.click` with a stub that deliberately does not call
         * through — otherwise a real export navigation would abort the page — and a TOC entry
         * is an anchor, so `.click()` here would silently do nothing and look like a broken
         * feature.
         */
        link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return true;
      });

      /*
       * Waited on rather than slept through. `revealInPreview` scrolls smoothly, so a fixed
       * delay races the animation — the first version of this check read 0 and looked like a
       * broken feature when the scroll simply had not finished.
       */
      await page
        .waitForFunction(
          () => {
            const pane = document.querySelector('.pane--preview');
            if (!pane || pane.scrollTop === 0) {
              return false;
            }
            // Settled, not merely started: waiting on "> 0" alone returns two pixels into a
            // smooth scroll and reports a number that proves far less than it appears to.
            const last = window.__lastPaneScroll;
            window.__lastPaneScroll = pane.scrollTop;
            return last === pane.scrollTop;
          },
          { timeout: 5000, polling: 100 }
        )
        .catch(() => {});

      const afterJump = await page.evaluate(() => ({
        rootScroll: Math.round(document.documentElement.scrollTop),
        toolbarTop: Math.round(document.querySelector('.toolbar')?.getBoundingClientRect().top ?? NaN),
        paneScroll: Math.round(document.querySelector('.pane--preview')?.scrollTop ?? -1)
      }));

      checks.push({
        name: 'clicking an entry scrolls the preview and leaves the app shell still',
        pass: jumped === true && afterJump.rootScroll === 0 && afterJump.toolbarTop === 0 && afterJump.paneScroll > 0,
        detail: jumped
          ? `root ${afterJump.rootScroll}, toolbar ${afterJump.toolbarTop}, pane ${afterJump.paneScroll}`
          : 'no entry to click'
      });

      // ---------- exports ----------

      await runCommand(page, 'Export as HTML');
      await sleep(900);
      await runCommand(page, 'Export as Word');
      await sleep(900);

      const exported = await page.evaluate(() => window.__downloads.map((d) => ({ type: d.type, text: d.text })));

      const checkExport = (needle) => {
        const file = exported.find((d) => (d.type || '').includes(needle));
        if (!file || !file.text) return { ok: false, detail: 'no export captured' };
        const hasAnchors = /href="#setup-config"/.test(file.text);
        const hasIds = /id="setup-config"/.test(file.text);
        const hasDedup = /id="notes-1"/.test(file.text) && /href="#notes-1"/.test(file.text);
        return {
          ok: hasAnchors && hasIds && hasDedup,
          detail: `anchors=${hasAnchors}, ids=${hasIds}, deduped pair=${hasDedup}`
        };
      };

      const html = checkExport('text/html');
      checks.push({
        name: 'the HTML export carries both the anchors and the ids they point at',
        pass: html.ok,
        detail: html.detail
      });

      const word = checkExport('msword');
      checks.push({
        name: 'the Word export carries them too',
        pass: word.ok,
        detail: word.detail
      });

      checks.push({
        name: 'no console errors while rendering and exporting',
        pass: errors.length === 0,
        detail: errors[0]
      });
    });

    // ---------- the PDF, in its own page so the export has room ----------

    await withPage(async (page, errors) => {
      await page.evaluateOnNewDocument(INSTRUMENT);
      await seedDocument(page, DOC, 'Handbook');
      await page.reload({ waitUntil: 'networkidle2' });
      await boot(page);

      await runCommand(page, 'Export as PDF');
      await page.waitForFunction(
        () => window.__downloads.some((d) => (d.type || '').includes('pdf') && d.text),
        { timeout: 120000 }
      );

      const pdf = await page.evaluate(() => {
        const file = window.__downloads.find((d) => (d.type || '').includes('pdf'));
        const text = file?.text || '';
        /*
         * Each annotation carries `/Dest [ N 0 R ... ]`, where N is the object number of the
         * page it jumps to. Distinct N values are what prove the entries point at different
         * places — a count alone would pass just as happily if every link went to page one.
         */
        const destinations = [...text.matchAll(/\/Dest\s*\[\s*(\d+)\s+0\s+R/g)].map((m) => m[1]);
        return {
          size: file?.size || 0,
          linkAnnotations: (text.match(/\/Subtype\s*\/Link/g) || []).length,
          pages: (text.match(/\/Type\s*\/Page[^s]/g) || []).length,
          destinations,
          distinctDestinations: new Set(destinations).size
        };
      });

      /*
       * The PDF is an image of the document, so a contents entry can only be a link if an
       * annotation was laid over it. Parsed from the file rather than inferred from the code
       * having run.
       */
      checks.push({
        name: 'the PDF carries a link annotation for each contents entry',
        pass: pdf.linkAnnotations >= 5 && pdf.pages > 1,
        detail: `${pdf.linkAnnotations} link annotations across ${pdf.pages} pages, ${Math.round(pdf.size / 1024)} KB`
      });

      checks.push({
        name: 'those annotations point at more than one destination',
        pass: pdf.distinctDestinations > 1,
        detail: `${pdf.destinations.length} destinations, ${pdf.distinctDestinations} distinct: ${JSON.stringify(pdf.destinations)}`
      });

      checks.push({
        name: 'no console errors during PDF export',
        pass: errors.length === 0,
        detail: errors[0]
      });
    });

    // ---------- the marker is opt-in ----------

    await withPage(async (page) => {
      await seedDocument(page, NO_TOC_DOC, 'Plain');
      await page.reload({ waitUntil: 'networkidle2' });
      await boot(page);

      const plain = await page.evaluate(() => ({
        nav: !!document.querySelector('#output .mb-toc'),
        headingIds: [...document.querySelectorAll('#output h1, #output h2')].map((h) => h.id)
      }));

      checks.push({
        /*
         * Gated on the ids existing. "No nav" is trivially true of a build with no feature at
         * all, so without the gate this passes for the wrong reason.
         */
        name: 'a document without the marker gets no contents list, but still gets slugs',
        pass: !plain.nav && plain.headingIds.includes('a-section'),
        detail: `nav=${plain.nav}, ids ${JSON.stringify(plain.headingIds)}`
      });
    });

    return checks;
  }
};
