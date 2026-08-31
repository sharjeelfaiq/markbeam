import { seedDocument, sleep, withPage } from './lib.mjs';

/*
 * Custom preview CSS (T46).
 *
 * StackEdit offers Handlebars templates for custom output; ours were fixed. The risk is not
 * the feature, it is where the CSS is allowed to reach:
 *
 *   - **The app chrome.** A stylesheet the user pastes must not be able to restyle the
 *     toolbar, the palette or the editor. Every rule is scoped to the preview.
 *   - **The PDF.** `src/styles/preview.css` is re-parsed by html2canvas-pro, and CSS it cannot
 *     understand breaks export completely while the app itself looks perfect — that is why the
 *     dependency is the `-pro` fork. User CSS is therefore *excluded* from the PDF, and the
 *     check below proves the stylesheet is actually disabled at rasterisation time rather than
 *     trusting that it is.
 */

const INSTRUMENT = `
window.__userCssDuringExport = [];
const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
HTMLCanvasElement.prototype.toDataURL = function (...args) {
  // Sampled at the moment a page bitmap is produced — the instant that matters.
  const sheet = document.getElementById('markbeam-user-css');
  window.__userCssDuringExport.push(sheet ? sheet.disabled : 'no sheet');
  return origToDataURL.apply(this, args);
};

window.__downloads = [];
const origCreate = URL.createObjectURL;
URL.createObjectURL = function (blob) {
  const url = origCreate.call(URL, blob);
  const record = { type: blob.type, size: blob.size, url, text: null };
  window.__downloads.push(record);
  blob.text().then((t) => { record.text = t; });
  return url;
};
HTMLAnchorElement.prototype.click = function () {};
`;

const DOC = ['# Styled', '', 'Body paragraph.', '', '## Second', '', 'More text.'].join('\n');

const CSS_OK = 'h1 { color: rgb(200, 0, 100); }\n.toolbar { display: none; }';
const CSS_BROKEN = 'this is not css at all {{{';

const boot = async (page) => {
  await page.waitForFunction(() => !!document.querySelector('#editor .monaco-editor'), {
    timeout: 30000
  });
  await sleep(1800);
};

const runCommand = async (page, needle) => {
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyK');
  await page.keyboard.up('Control');
  await sleep(400);
  const clicked = await page.evaluate((text) => {
    const item = [...document.querySelectorAll('#palette .sheet__item')].find((el) =>
      el.textContent.includes(text)
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

const applyCss = (page, css) =>
  page.evaluate((value) => {
    const area = document.querySelector('#style-input');
    const form = document.querySelector('#style-form');
    if (!area || !form) return false;
    area.value = value;
    area.dispatchEvent(new Event('input', { bubbles: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    return true;
  }, css);

export const suite = {
  name: 'custom css',
  async run() {
    return withPage(async (page, errors) => {
      const checks = [];

      await page.evaluateOnNewDocument(INSTRUMENT);
      await seedDocument(page, DOC, 'Styled');
      await page.reload({ waitUntil: 'networkidle2' });
      await boot(page);

      const opened = await runCommand(page, 'Custom preview CSS');
      const sheetOpen = await page.evaluate(() => {
        const dialog = document.querySelector('#style');
        return !!dialog && dialog.open;
      });

      checks.push({
        name: 'a palette command opens a stylesheet editor',
        pass: opened && sheetOpen,
        detail: opened ? `#style open=${sheetOpen}` : 'no such command'
      });

      const applied = await applyCss(page, CSS_OK);
      await sleep(700);

      const effect = await page.evaluate(() => ({
        headingColour: getComputedStyle(document.querySelector('#output h1')).color,
        toolbarDisplay: getComputedStyle(document.querySelector('.toolbar')).display,
        toolbarVisible: (document.querySelector('.toolbar')?.getBoundingClientRect().height || 0) > 0
      }));

      checks.push({
        name: 'the stylesheet changes the preview',
        pass: applied && effect.headingColour === 'rgb(200, 0, 100)',
        detail: applied ? `h1 colour ${effect.headingColour}` : 'no editor to apply through'
      });

      /*
       * The same stylesheet contains `.toolbar { display: none }`. Scoping is what stops a
       * pasted snippet from hiding the app's own chrome — the rule has to land inside the
       * preview or nowhere.
       */
      checks.push({
        name: 'rules are scoped to the preview and cannot restyle the app chrome',
        pass: applied && effect.toolbarVisible && effect.toolbarDisplay !== 'none',
        detail: `toolbar display ${effect.toolbarDisplay}, visible=${effect.toolbarVisible}`
      });

      await page.reload({ waitUntil: 'networkidle2' });
      await boot(page);
      const afterReload = await page.evaluate(
        () => getComputedStyle(document.querySelector('#output h1')).color
      );
      checks.push({
        name: 'it survives a reload',
        pass: afterReload === 'rgb(200, 0, 100)',
        detail: `h1 colour ${afterReload}`
      });

      // ---------- exports ----------

      await runCommand(page, 'Export as HTML');
      await sleep(1000);
      const html = await page.evaluate(() => {
        const file = window.__downloads.find((d) => (d.type || '').includes('text/html'));
        return file?.text || '';
      });

      checks.push({
        name: 'the HTML export carries the custom stylesheet',
        pass: /rgb\(200,\s*0,\s*100\)/.test(html),
        detail: html ? `${Math.round(html.length / 1024)} KB, rule present=${/rgb\(200,\s*0,\s*100\)/.test(html)}` : 'no export captured'
      });

      await runCommand(page, 'Export as PDF');
      await page.waitForFunction(
        () => window.__downloads.some((d) => (d.type || '').includes('pdf') && d.text),
        { timeout: 120000 }
      );

      const pdfRun = await page.evaluate(() => ({
        samples: window.__userCssDuringExport,
        stillEnabledNow: document.getElementById('markbeam-user-css')?.disabled,
        pdfSize: window.__downloads.find((d) => (d.type || '').includes('pdf'))?.size || 0
      }));

      /*
       * The point of the whole design. html2canvas-pro re-parses whatever CSS applies, and a
       * rule it cannot read yields a blank page with no error at all — so user CSS is
       * switched off for the duration rather than trusted.
       */
      checks.push({
        name: 'the user stylesheet is disabled while the PDF is rasterised',
        pass: pdfRun.samples.length > 0 && pdfRun.samples.every((s) => s === true),
        detail: `samples at page-render time: ${JSON.stringify(pdfRun.samples)}`
      });

      checks.push({
        name: 'and switched back on afterwards',
        pass: pdfRun.stillEnabledNow === false && pdfRun.pdfSize > 0,
        detail: `disabled now=${pdfRun.stillEnabledNow}, pdf ${Math.round(pdfRun.pdfSize / 1024)} KB`
      });

      // ---------- refusal ----------

      await runCommand(page, 'Custom preview CSS');
      await applyCss(page, CSS_BROKEN);
      await sleep(700);

      const refusal = await page.evaluate(() => ({
        message: document.querySelector('#style-status')?.textContent.trim() || '',
        stillPink: getComputedStyle(document.querySelector('#output h1')).color
      }));

      checks.push({
        name: 'a stylesheet that parses to nothing is refused, not silently applied',
        pass: refusal.message.length > 0 && refusal.stillPink === 'rgb(200, 0, 100)',
        detail: `message "${refusal.message}", previous rule still in effect=${refusal.stillPink === 'rgb(200, 0, 100)'}`
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
