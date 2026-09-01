import { seedDocument, sleep, withPage, ready } from './lib.mjs';

/*
 * The Export menu (T66).
 *
 * The toolbar used to carry a PDF button, and the other five exports — HTML, clipboard HTML,
 * Word, Markdown, the slide PDF — existed only in the command palette. Five features invisible
 * to anybody who had not pressed Ctrl+K.
 *
 * Two checks here are the ones a careless implementation breaks, and they are the reason this
 * suite is worth more than "the menu opens":
 *
 *   - **Ctrl+S still exports a PDF, without opening the menu.** A shortcut that opens a menu is
 *     not a shortcut, and the welcome document teaches Ctrl+S as "export a PDF".
 *   - **The menu stays inside the viewport at 375px.** `positionBelow()` clamps to an 8px
 *     gutter; a menu anchored to a right-hand button falls off the screen without it, and
 *     nothing else in the suite would notice.
 *
 * Downloads are observed with the same instrument `tests/export.test.mjs` uses — intercepting
 * `URL.createObjectURL` — rather than granting Chrome download permissions, which would make
 * this a test about Chrome's plumbing.
 */

const INSTRUMENT = `
window.__downloads = [];
const origCreate = URL.createObjectURL;
URL.createObjectURL = function (blob) {
  const url = origCreate.call(URL, blob);
  const record = { type: blob.type, url, name: null };
  window.__downloads.push(record);
  return url;
};
const origClick = HTMLAnchorElement.prototype.click;
HTMLAnchorElement.prototype.click = function () {
  const hit = window.__downloads.find((d) => d.url === this.href);
  if (hit) { hit.name = this.getAttribute('download'); }
  // Deliberately not calling through: a real navigation would abort the page.
};

// The PDF path rasterises; counting canvases proves which exporter actually ran.
window.__pdfPages = [];
const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
HTMLCanvasElement.prototype.toDataURL = function (...args) {
  try { window.__pdfPages.push(this.width); } catch (e) {}
  return origToDataURL.apply(this, args);
};
`;

const DOC = ['# Export menu fixture', '', 'Something short to export.'].join('\n');

const boot = async (page) => {
  await ready(page);
};

const menuState = (page) =>
  page.evaluate(() => {
    const menu = document.querySelector('#export-menu');
    const button = document.querySelector('#export-button');
    const items = menu ? [...menu.querySelectorAll('[role="menuitem"]')] : [];
    return {
      exists: !!menu,
      open: !!menu && !menu.hidden,
      expanded: button?.getAttribute('aria-expanded') || null,
      labels: items.map((item) => item.textContent.trim()),
      focusIsButton: document.activeElement === button
    };
  });

const openMenu = async (page) => {
  await page.click('#export-button');
  await sleep(400);
};

const chooseItem = async (page, needle) => {
  const clicked = await page.evaluate((text) => {
    const item = [...document.querySelectorAll('#export-menu [role="menuitem"]')].find((el) =>
      el.textContent.toLowerCase().includes(text.toLowerCase())
    );
    if (!item) return false;
    item.click();
    return true;
  }, needle);
  await sleep(600);
  return clicked;
};

export const suite = {
  name: 'export menu',
  async run() {
    const checks = [];

    await withPage(async (page, errors) => {
      await page.evaluateOnNewDocument(INSTRUMENT);
      await seedDocument(page, DOC, 'Export menu');
      await page.reload({ waitUntil: 'networkidle2' });
      await boot(page);

      // ---------- it opens, and offers everything ----------

      await openMenu(page);
      const opened = await menuState(page);

      checks.push({
        name: 'the export button opens a menu',
        pass: opened.exists && opened.open && opened.expanded === 'true',
        detail: opened.exists
          ? `open=${opened.open}, aria-expanded=${opened.expanded}`
          : 'no #export-menu in the document'
      });

      /*
       * Every format the app can produce, named. The count is asserted as well as the contents:
       * an item silently dropped in a later edit is exactly the regression this task exists to
       * undo, and a `some()` check would not see it.
       */
      const wanted = ['PDF', 'Slides', 'HTML', 'Word', 'Markdown'];
      const missing = wanted.filter(
        (name) => !opened.labels.some((label) => label.toLowerCase().includes(name.toLowerCase()))
      );

      checks.push({
        name: 'it lists every format the app can export',
        pass: missing.length === 0 && opened.labels.length >= 6,
        detail: `${opened.labels.length} items: ${opened.labels.join(' · ')}${
          missing.length ? ` — missing ${missing.join(', ')}` : ''
        }`
      });

      // ---------- Escape closes it and gives focus back ----------

      await page.keyboard.press('Escape');
      await sleep(400);
      const closed = await menuState(page);

      checks.push({
        name: 'Escape closes it and returns focus to the button',
        // Focus returning matters: without it, Escape leaves a keyboard user nowhere.
        pass: closed.open === false && closed.expanded === 'false' && closed.focusIsButton === true,
        detail: `open=${closed.open}, aria-expanded=${closed.expanded}, focus back=${closed.focusIsButton}`
      });

      // ---------- an item exports what it says ----------

      await page.evaluate(() => {
        window.__downloads = [];
        window.__pdfPages = [];
      });
      await openMenu(page);
      const choseMarkdown = await chooseItem(page, 'Markdown');
      await sleep(900);

      const afterMarkdown = await page.evaluate(() => ({
        downloads: window.__downloads.map((d) => ({ type: d.type, name: d.name })),
        rasterised: window.__pdfPages.length,
        menuOpen: !document.querySelector('#export-menu')?.hidden
      }));

      checks.push({
        name: 'choosing Markdown downloads Markdown, not the old default',
        // `rasterised === 0` is the half that matters: it proves the item ran its own exporter
        // rather than the PDF one the button used to be wired to.
        pass:
          choseMarkdown &&
          afterMarkdown.downloads.length === 1 &&
          /\.md$/.test(afterMarkdown.downloads[0]?.name || '') &&
          afterMarkdown.rasterised === 0,
        detail: choseMarkdown
          ? `${JSON.stringify(afterMarkdown.downloads)}, canvases=${afterMarkdown.rasterised}`
          : 'no Markdown item'
      });

      checks.push({
        name: 'and choosing closes the menu',
        pass: afterMarkdown.menuOpen === false,
        detail: `open=${afterMarkdown.menuOpen}`
      });

      // ---------- Ctrl+S stays a shortcut, not a menu opener ----------

      await page.evaluate(() => {
        window.__pdfPages = [];
      });
      await page.click('#editor');
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyS');
      await page.keyboard.up('Control');
      await sleep(700);

      const afterShortcut = await page.evaluate(() => ({
        menuOpen: !document.querySelector('#export-menu')?.hidden,
        busy: document.querySelector('#export-button')?.disabled === true
      }));

      // The export takes a moment; either it is still running or it has already produced a page.
      for (let i = 0; i < 40; i += 1) {
        const done = await page.evaluate(() => window.__pdfPages.length > 0);
        if (done) break;
        await sleep(500);
      }
      const rasterised = await page.evaluate(() => window.__pdfPages.length);

      checks.push({
        name: 'Ctrl+S still exports a PDF without opening the menu',
        pass: afterShortcut.menuOpen === false && (afterShortcut.busy || rasterised > 0),
        detail: `menu open=${afterShortcut.menuOpen}, button busy=${afterShortcut.busy}, canvases=${rasterised}`
      });

      checks.push({ name: 'no console errors', pass: errors.length === 0, detail: errors[0] });
    });

    // ---------- and it fits on a phone ----------

    await withPage(async (page) => {
      await page.setViewport({ width: 375, height: 780 });
      await sleep(600);
      await openMenu(page);

      const rect = await page.evaluate(() => {
        const menu = document.querySelector('#export-menu');
        if (!menu || menu.hidden) return null;
        const box = menu.getBoundingClientRect();
        return {
          left: Math.round(box.left),
          right: Math.round(box.right),
          bottom: Math.round(box.bottom),
          viewport: window.innerWidth,
          height: window.innerHeight
        };
      });

      checks.push({
        name: 'the menu stays inside the viewport at 375px',
        // Anchored to a button at the right-hand edge, an unclamped menu hangs off the screen —
        // and no other check in the suite would ever see it.
        pass: !!rect && rect.left >= 0 && rect.right <= rect.viewport && rect.bottom <= rect.height,
        detail: rect
          ? `left ${rect.left}, right ${rect.right} of ${rect.viewport}, bottom ${rect.bottom} of ${rect.height}`
          : 'menu did not open at 375px'
      });
    });

    return checks;
  }
};
