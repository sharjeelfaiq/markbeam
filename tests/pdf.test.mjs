import { seedDocument, sleep, withPage, ready } from './lib.mjs';

/*
 * Regression cover for PDF export.
 *
 * Two failures this guards against, both of which shipped at some point:
 *
 * 1. Blank pages. Rasterising a long document as one canvas exceeds the browser's
 *    maximum canvas size and silently yields an empty bitmap — the PDF downloads fine
 *    and every page is white. So we measure actual ink per page rather than trusting
 *    that a file was produced.
 * 2. A stylesheet the rasteriser cannot parse. The preview CSS is re-parsed during
 *    export, so a colour function the library does not understand breaks export
 *    completely while the app itself looks perfect. Console errors are therefore a
 *    failure here, not a warning.
 */

/*
 * Wraps toDataURL to sample how much non-white ink each exported page carries.
 * Runs in the page, before app code — this is Puppeteer's evaluateOnNewDocument,
 * not JavaScript eval.
 */
const INSTRUMENT = `
window.__pdfPages = [];
window.__pdfLog = [];
const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
HTMLCanvasElement.prototype.toDataURL = function (...args) {
  try {
    const ctx = this.getContext('2d');
    const { width, height } = this;
    let ink = 0, sampled = 0;
    const step = Math.max(1, Math.floor(Math.min(width, height) / 100));
    const data = ctx.getImageData(0, 0, width, height).data;
    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < width; x += step) {
        const i = (y * width + x) * 4;
        sampled++;
        if (data[i] < 240 || data[i+1] < 240 || data[i+2] < 240) ink++;
      }
    }
    window.__pdfPages.push({ width, height, inkRatio: sampled ? ink / sampled : 0 });
  } catch (e) {
    window.__pdfPages.push({ error: String(e) });
  }
  return origToDataURL.apply(this, args);
};
const origError = console.error;
console.error = function (...a) {
  window.__pdfLog.push(a.map(String).join(' '));
  return origError.apply(this, a);
};
window.alert = function (m) { window.__pdfLog.push('alert: ' + m); };
`;

/*
 * A Mermaid diagram alone, so the only ink on the page is the diagram and its panel.
 * `graph LR` because a left-to-right flowchart is wide, which is what makes a horizontal
 * crop visible at all.
 */
const DIAGRAM_DOC = [
  '```mermaid',
  'graph LR',
  '  A[Write] --> B{Markbeam}',
  '  B --> C[Preview]',
  '  B --> D[PDF]',
  '```'
].join('\n');

/*
 * Measures the widest run of ink in a page canvas, ignoring a 20px inset so the diagram
 * panel's own border and rounded corners are not mistaken for diagram content.
 */
const MEASURE_INK = `
window.__inkWidths = [];
const origToDataURL2 = HTMLCanvasElement.prototype.toDataURL;
HTMLCanvasElement.prototype.toDataURL = function (...args) {
  try {
    if (this.width > 400) {
      const ctx = this.getContext('2d');
      const { width, height } = this;
      const inset = 20 * 2;
      const data = ctx.getImageData(0, 0, width, height).data;
      let minX = width, maxX = -1;
      for (let y = 0; y < height; y += 2) {
        for (let x = inset; x < width - inset; x += 2) {
          const i = (y * width + x) * 4;
          if (data[i] < 220 || data[i + 1] < 220 || data[i + 2] < 220) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
          }
        }
      }
      window.__inkWidths.push(maxX < 0 ? 0 : (maxX - minX) / 2);
    }
  } catch (e) {
    window.__inkWidths.push(-1);
  }
  return origToDataURL2.apply(this, args);
};
`;

/*
 * Export is a menu now (T66), so a click on the button opens it rather than starting a PDF.
 * The button keeps its id and its busy state, which is what the waits below still read.
 */
const exportPdfFromMenu = async (page) => {
  await page.click('#export-button');
  await new Promise((resolve) => setTimeout(resolve, 350));
  return page.evaluate(() => {
    const item = [...document.querySelectorAll('#export-menu [role="menuitem"]')].find(
      (el) => el.textContent.trim() === 'PDF'
    );
    if (!item) return false;
    item.click();
    return true;
  });
};

export const suite = {
  name: 'pdf export',
  async run() {
    const checks = await withPage(async (page) => {
      const checks = [];

      await page.evaluateOnNewDocument(INSTRUMENT);
      await page.reload({ waitUntil: 'networkidle2' });
      await ready(page);

      await page.evaluate(() => {
        window.__pdfPages = [];
        window.__pdfLog = [];
      });

      await exportPdfFromMenu(page);

      let finished = false;
      for (let i = 0; i < 180; i++) {
        await sleep(1000);
        const state = await page.evaluate(() => ({
          busy: document.querySelector('#export-button').disabled,
          pages: window.__pdfPages.length
        }));
        if (!state.busy && state.pages > 0) {
          finished = true;
          break;
        }
      }

      const result = await page.evaluate(() => ({
        pages: window.__pdfPages,
        log: window.__pdfLog,
        sandboxLeft: !!document.getElementById('pdf-export-sandbox')
      }));

      // jsPDF also creates a small scratch canvas; real pages are the wide ones.
      const pages = result.pages.filter((entry) => (entry.width || 0) > 400);
      const blank = pages.filter((entry) => (entry.inkRatio ?? 0) < 0.001);
      const oversized = pages.filter((entry) => entry.width > 16384 || entry.height > 16384);

      checks.push({ name: 'export completes', pass: finished });
      checks.push({
        name: 'produces at least one page',
        pass: pages.length > 0,
        detail: `${pages.length} pages`
      });
      checks.push({
        name: 'no blank pages',
        pass: blank.length === 0,
        detail: `${blank.length} blank`
      });
      checks.push({
        name: 'every canvas within the browser size limit',
        pass: oversized.length === 0
      });
      checks.push({
        name: 'offscreen sandbox cleaned up',
        pass: result.sandboxLeft === false
      });
      checks.push({
        name: 'no errors during export',
        pass: result.log.length === 0,
        detail: result.log[0]
      });

      return checks;
    });

    /*
     * Mermaid diagrams must survive the rasteriser whole.
     *
     * html2canvas draws an inline <svg> itself, and it renders Mermaid's output larger
     * than the box it was laid out in, so the right-hand side is clipped away inside the
     * svg's own viewport. Nothing above catches it: the page is not blank, carries plenty
     * of ink, and the geometry in the DOM is correct — only the pixels are wrong.
     *
     * A white-gutter check would not catch it either, and was tried: the svg box ends well
     * short of the panel, so there is a gutter whether or not the diagram is cropped. What
     * does discriminate is the width of the drawn diagram against the width the svg was
     * laid out at — 74% of it when clipped, 96% when whole.
     */
    const diagramChecks = await withPage(async (page) => {
      const out = [];

      await page.evaluateOnNewDocument(MEASURE_INK);
      await seedDocument(page, DIAGRAM_DOC);
      await page.reload({ waitUntil: 'networkidle2' });
      await page.waitForFunction(() => !!document.querySelector('#output .mermaid svg'), {
        timeout: 30000
      });
      // A present svg is not a laid-out one, and the ink measurement below reads its geometry.
      await page
        .waitForFunction(
          () => {
            const svg = document.querySelector('#output .mermaid svg');
            return !!svg && svg.getBoundingClientRect().width > 0;
          },
          { timeout: 15000 }
        )
        .catch(() => {});
      await page.evaluate(() => document.fonts.ready).catch(() => {});

      // The width the browser actually lays the diagram out at — the yardstick.
      const laidOutWidth = await page.evaluate(() =>
        Math.round(document.querySelector('#output .mermaid svg').getBoundingClientRect().width)
      );

      await page.evaluate(() => {
        window.__inkWidths = [];
      });
      await exportPdfFromMenu(page);

      for (let i = 0; i < 120; i++) {
        await sleep(500);
        const done = await page.evaluate(
          () =>
            !document.querySelector('#export-button').disabled && window.__inkWidths.length > 0
        );
        if (done) {
          break;
        }
      }

      const widths = await page.evaluate(() => window.__inkWidths);
      const drawn = widths.length ? Math.max(...widths) : 0;
      const ratio = laidOutWidth > 0 ? drawn / laidOutWidth : 0;

      out.push({
        name: 'a Mermaid diagram is exported whole, not clipped at its right edge',
        pass: ratio >= 0.9,
        detail: `drawn ${Math.round(drawn)}px of ${laidOutWidth}px laid out (${Math.round(ratio * 100)}%)`
      });

      return out;
    });

    return [...checks, ...diagramChecks];
  }
};
