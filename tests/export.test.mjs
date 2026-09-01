import { seedDocument, sleep, withPage, ready } from './lib.mjs';

/*
 * File exports: HTML, Word and Markdown (T10, #99, #57).
 *
 * Downloads are awkward to observe in headless Chrome, and granting download permissions
 * would make this a test about Chrome's plumbing rather than about the files. So the suite
 * intercepts `URL.createObjectURL` before app code runs — the same instrument-first trick
 * `pdf.test.mjs` uses on `toDataURL` and `copy.test.mjs` on the clipboard — and records
 * each Blob's MIME type and text alongside the anchor's `download` attribute.
 *
 * "Opens correctly" is the half no assertion here reaches. The HTML file is rendered and
 * looked at separately; the Word file has to be opened in Word by hand, and that is not
 * claimed by this suite.
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

// The anchor carries the filename, and it is clicked immediately after the URL is made.
const origClick = HTMLAnchorElement.prototype.click;
HTMLAnchorElement.prototype.click = function () {
  const hit = window.__downloads.find((d) => d.url === this.href);
  if (hit) { hit.name = this.getAttribute('download'); }
  // Deliberately not calling through: a real navigation would abort the page.
};
`;

const RICH_DOC = [
  '# Export fixture',
  '',
  'Prose with **bold**, `code` and a [link](https://example.com).',
  '',
  '| Region | Revenue |',
  '| ------ | ------- |',
  '| North  | 1200    |',
  '',
  '```js',
  'const beam = 1;',
  '```',
  '',
  '```mermaid',
  'graph LR',
  '  A[Write] --> B[Export]',
  '```',
  '',
  'Math: $x^2 + 1$'
].join('\n');

const boot = async (page) => {
  await page.reload({ waitUntil: 'networkidle2' });
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
  await sleep(900);
  return found;
};

const paletteTitles = async (page) => {
  await page.click('#menu-button');
  await sleep(400);
  const titles = await page.evaluate(() =>
    [...document.querySelectorAll('#palette-list .sheet__item')].map((b) =>
      b.textContent.replace(/\s+/g, ' ').trim()
    )
  );
  await page.keyboard.press('Escape');
  await sleep(250);
  return titles;
};

const downloads = (page) => page.evaluate(() => window.__downloads);

const reset = (page) => page.evaluate(() => { window.__downloads = []; });

export const suite = {
  name: 'export files',
  async run() {
    return withPage(async (page, errors) => {
      const checks = [];

      await page.evaluateOnNewDocument(INSTRUMENT);
      await seedDocument(page, RICH_DOC, 'My Export Doc!');
      await boot(page);

      const titles = await paletteTitles(page);
      const wanted = ['Export as HTML', 'Export as Word', 'Export as Markdown'];
      const missing = wanted.filter((w) => !titles.some((t) => t.includes(w)));
      checks.push({
        name: 'the palette offers HTML, Word and Markdown exports',
        pass: missing.length === 0,
        detail: missing.length ? `missing: ${missing.join(', ')}` : titles.filter((t) => t.includes('Export')).join(' | ')
      });

      // ---------- markdown ----------
      await reset(page);
      const ranMd = await runCommand(page, 'Export as Markdown');
      await sleep(400);
      const mdFiles = await downloads(page);
      const md = mdFiles[0];
      const editorValue = await page.evaluate(() =>
        window.monaco?.editor?.getModels?.()[0]?.getValue?.() ?? null
      );
      checks.push({
        name: 'Markdown export carries the editor source exactly',
        pass: ranMd && !!md && typeof md.text === 'string' && md.text.includes('# Export fixture') && md.text.includes('graph LR'),
        detail: md ? `${md.type || '(no type)'}, ${md.size}B, "${(md.text || '').slice(0, 28)}"` : 'nothing downloaded'
      });

      // ---------- html ----------
      await reset(page);
      const ranHtml = await runCommand(page, 'Export as HTML');
      await sleep(600);
      const htmlFiles = await downloads(page);
      const html = htmlFiles[0];
      const htmlText = (html && html.text) || '';
      checks.push({
        name: 'HTML export is a standalone document with its own styles',
        pass:
          ranHtml &&
          /<!doctype html>/i.test(htmlText) &&
          /<style[\s>]/i.test(htmlText) &&
          htmlText.includes('.mb-md') &&
          htmlText.includes('Export fixture'),
        detail: html
          ? `${html.type}, ${html.size}B, doctype=${/<!doctype/i.test(htmlText)}, style=${/<style/i.test(htmlText)}, mb-md=${htmlText.includes('.mb-md')}`
          : 'nothing downloaded'
      });

      checks.push({
        name: 'the Mermaid diagram survives into the HTML export',
        pass: /<svg[\s>]/i.test(htmlText) && /aria-roledescription|flowchart/i.test(htmlText),
        detail: `svg=${/<svg[\s>]/i.test(htmlText)}, flowchart=${/flowchart/i.test(htmlText)}`
      });

      // ---------- word ----------
      await reset(page);
      const ranWord = await runCommand(page, 'Export as Word');
      await sleep(600);
      const wordFiles = await downloads(page);
      const word = wordFiles[0];
      checks.push({
        name: 'Word export uses the Word MIME type and a .doc name',
        pass:
          ranWord &&
          !!word &&
          /application\/msword/.test(word.type || '') &&
          /\.doc$/.test(word.name || ''),
        detail: word ? `type "${word.type}", name "${word.name}"` : 'nothing downloaded'
      });

      /*
       * ---- the Word file has to be readable by Word (T69) ----
       *
       * The `.doc` embeds the app's live stylesheets, and those are token-driven — `var(--…)`
       * appears 92 times in `preview.css`, including the table border and the header shading,
       * plus one `color-mix()`. **Word's HTML engine resolves neither**, and a declaration it
       * cannot parse is dropped whole, so an unresolved file opens with no borders and no
       * shading while looking perfectly fine in a browser.
       */
      const wordText = (word && word.text) || '';

      checks.push({
        name: 'the Word file carries no CSS custom properties or color-mix()',
        pass: wordText.length > 0 && !wordText.includes('var(--') && !wordText.includes('color-mix('),
        detail: wordText
          ? `var(--) x${(wordText.match(/var\(--/g) || []).length}, color-mix x${(wordText.match(/color-mix\(/g) || []).length}`
          : 'nothing downloaded'
      });

      /*
       * Resolved to *something real*. Substituting an empty string would satisfy the check
       * above while producing precisely the borderless table this task exists to prevent.
       */
      const wordTableColour = /(?:th|td)[^{}]*\{[^{}]*border[^{}]*(?:rgb|#[0-9a-f]{3})/i.test(wordText);
      checks.push({
        name: 'and its table borders resolved to a real colour',
        pass: wordTableColour,
        detail: wordTableColour
          ? 'table border carries a concrete colour'
          : 'no th/td border rule with an rgb() or hex value'
      });

      /*
       * Control. The standalone HTML file is opened in a browser, which resolves custom
       * properties perfectly well, so that path is deliberately left alone — without this,
       * a change that flattened every export would be indistinguishable from the intended one.
       */
      checks.push({
        name: 'the HTML file still uses the tokens, because a browser can read them',
        pass: htmlText.includes('var(--'),
        detail: `var(--) x${(htmlText.match(/var\(--/g) || []).length} in the HTML export`
      });

      // ---------- filenames follow the title ----------
      const names = {
        md: md && md.name,
        html: html && html.name,
        word: word && word.name
      };
      checks.push({
        name: 'filenames are the slugified document title',
        pass:
          names.md === 'my-export-doc.md' &&
          names.html === 'my-export-doc.html' &&
          names.word === 'my-export-doc.doc',
        detail: JSON.stringify(names)
      });

      // renaming the document must change the filename
      await page.evaluate(() => {
        const input = document.querySelector('#doc-title');
        input.value = 'Second Name';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await sleep(600);
      await reset(page);
      await runCommand(page, 'Export as Markdown');
      await sleep(400);
      const renamed = (await downloads(page))[0];
      checks.push({
        name: 'renaming the document renames the exported file',
        pass: !!renamed && renamed.name === 'second-name.md',
        detail: renamed ? `"${renamed.name}"` : 'nothing downloaded'
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
