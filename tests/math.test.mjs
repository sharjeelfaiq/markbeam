import { seedDocument, sleep, withPage } from './lib.mjs';

/*
 * LaTeX / math rendering (T7, #108, #54).
 *
 * This suite deliberately exercises the browser output rather than the tokenizer in
 * isolation. The contract spans a lazy chunk, KaTeX's CSS and MathML, DOMPurify, theme
 * tokens, narrow layout and the PDF sandbox, so a string-level test would miss most of
 * the ways this feature can regress.
 */

const DOC = [
  '# Math',
  '',
  'Inline fraction $\\frac{1}{2}$ and superscript $x^2$.',
  '',
  '$$\\int_0^1 x^2\\,dx = \\frac{1}{3}$$',
  '',
  '$$',
  '\\sum_{n=1}^{\\infty} \\frac{1}{n^2}',
  '= \\frac{\\pi^2}{6}',
  '$$',
  '',
  '$$x +',
  'y = z$$',
  '',
  'Malformed $\\frac{1}$ stays non-fatal.',
  '',
  'Currency prose: $5 and $10 stays literal; unmatched $20 stays literal.',
  '',
  'Escaped dollars: \\$x^2\\$ stay literal.',
  '',
  'Cross-line source: $x +',
  'y$ stays literal across lines.',
  '',
  'Embedded display marker: prose $$x^2$$ stays literal.',
  '',
  'Code span: `$x^2$`',
  '',
  '```text',
  '$$\\frac{1}{2}$$',
  '```',
  '',
  '$$\\begin{matrix} a_1 & a_2 & a_3 & a_4 & a_5 & a_6 & a_7 & a_8 & a_9 & a_{10} & a_{11} & a_{12} & a_{13} & a_{14} & a_{15} & a_{16} \\end{matrix}$$'
].join('\n');

const PDF_DOC = '$$\\int_0^1 \\frac{x^2 + 1}{\\sqrt{x}}\\,dx = \\frac{16}{5}$$';

const seed = async (page, markdown) => {
  await seedDocument(page, markdown);
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForFunction(() => !!document.querySelector('#editor .monaco-editor'), {
    timeout: 30000
  });
  await sleep(2200);
};

const lineStarting = (page, prefix) =>
  page.evaluate(
    (start) =>
      [...document.querySelectorAll('#output p')]
        .find((element) => element.textContent.startsWith(start))
        ?.textContent || '',
    prefix
  );

const PDF_INSTRUMENT = `
window.__mathPdf = { sandbox: null, pages: [] };
const observer = new MutationObserver((records) => {
  for (const record of records) {
    for (const node of record.addedNodes) {
      if (node.id !== 'pdf-export-sandbox') continue;
      const formulas = [...node.querySelectorAll('.katex')];
      window.__mathPdf.sandbox = {
        formulas: formulas.length,
        semantics: node.querySelectorAll('math semantics annotation').length,
        laidOut: formulas.every((formula) => {
          const rect = formula.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        })
      };
    }
  }
});
observer.observe(document.body, { childList: true });

const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
HTMLCanvasElement.prototype.toDataURL = function (...args) {
  try {
    if (this.width > 400) {
      const context = this.getContext('2d');
      const data = context.getImageData(0, 0, this.width, this.height).data;
      const step = 3;
      let ink = 0;
      let sampled = 0;
      for (let y = 0; y < this.height; y += step) {
        for (let x = 0; x < this.width; x += step) {
          const index = (y * this.width + x) * 4;
          sampled += 1;
          if (data[index] < 240 || data[index + 1] < 240 || data[index + 2] < 240) ink += 1;
        }
      }
      window.__mathPdf.pages.push({
        width: this.width,
        height: this.height,
        inkRatio: sampled ? ink / sampled : 0
      });
    }
  } catch (error) {
    window.__mathPdf.pages.push({ error: String(error) });
  }
  return originalToDataURL.apply(this, args);
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
  name: 'math',
  async run() {
    const renderingChecks = await withPage(async (page, errors) => {
      const checks = [];
      await seed(page, DOC);

      const formulas = await page.evaluate(() => ({
        inline: document.querySelectorAll('#output .math-inline .katex').length,
        fractions: document.querySelectorAll('#output .math-inline .mfrac').length,
        superscripts: document.querySelectorAll('#output .math-inline .msupsub').length,
        displays: document.querySelectorAll('#output .math-display .katex-display').length,
        annotations: [...document.querySelectorAll('#output math semantics annotation')].map(
          (element) => ({ encoding: element.getAttribute('encoding'), text: element.textContent })
        )
      }));

      checks.push({
        name: 'inline fractions and superscripts render with KaTeX',
        pass: formulas.inline === 2 && formulas.fractions >= 1 && formulas.superscripts >= 1,
        detail: `${formulas.inline} inline, ${formulas.fractions} fractions, ${formulas.superscripts} superscripts`
      });
      checks.push({
        name: 'same-line and multiline display blocks render',
        pass: formulas.displays === 4,
        detail: `${formulas.displays} displays`
      });
      checks.push({
        name: 'DOMPurify retains KaTeX MathML semantics and TeX annotations',
        pass:
          formulas.annotations.length >= 5 &&
          formulas.annotations.every((entry) => entry.encoding === 'application/x-tex') &&
          formulas.annotations.some((entry) => entry.text.includes('\\sum')),
        detail: `${formulas.annotations.length} annotations`
      });

      const malformed = await page.evaluate(() => {
        const error = document.querySelector('#output .katex-error');
        const probe = document.createElement('span');
        probe.style.color = 'var(--danger)';
        document.body.appendChild(probe);
        const expected = getComputedStyle(probe).color;
        probe.remove();
        return error
          ? {
              count: document.querySelectorAll('#output .katex-error').length,
              text: error.textContent,
              title: error.getAttribute('title'),
              colour: getComputedStyle(error).color,
              expected
            }
          : { count: 0, expected };
      });
      checks.push({
        name: 'closed malformed TeX renders a non-fatal token-coloured error',
        pass:
          malformed.count === 1 &&
          malformed.title?.includes('ParseError') &&
          malformed.colour === malformed.expected,
        detail: malformed.count
          ? `${malformed.colour}, ${malformed.title}`
          : 'no .katex-error rendered'
      });

      const currency = await lineStarting(page, 'Currency prose:');
      const escaped = await lineStarting(page, 'Escaped dollars:');
      const crossLine = await lineStarting(page, 'Cross-line source:');
      const embeddedDisplay = await lineStarting(page, 'Embedded display marker:');
      const isolated = await page.evaluate(() => ({
        code: [...document.querySelectorAll('#output p code')].map((element) => element.textContent),
        fence: [...document.querySelectorAll('#output pre code')].map((element) => element.textContent),
        mathInCode: document.querySelectorAll('#output code .katex, #output pre .katex').length
      }));
      checks.push({
        name: 'currency prose and unmatched dollars remain literal',
        pass:
          currency.includes('$5 and $10') &&
          currency.includes('unmatched $20') &&
          !currency.includes('katex'),
        detail: currency
      });
      checks.push({
        name: 'escaped dollar delimiters remain literal',
        pass: escaped.includes('$x^2$'),
        detail: escaped
      });
      checks.push({
        name: 'inline math cannot cross lines or consume an embedded $$ pair',
        pass:
          crossLine.includes('$x +') &&
          crossLine.includes('y$') &&
          embeddedDisplay.includes('$$x^2$$'),
        detail: `${crossLine} | ${embeddedDisplay}`
      });
      checks.push({
        name: 'code spans and fenced code are isolated from math parsing',
        pass:
          isolated.code.includes('$x^2$') &&
          isolated.fence.some((value) => value.includes('$$\\frac{1}{2}$$')) &&
          isolated.mathInCode === 0,
        detail: `${isolated.mathInCode} formulas in code`
      });

      const themedColours = {};
      for (const theme of ['dark', 'light']) {
        await page.evaluate((value) => {
          localStorage.setItem('markbeam:theme_settings', JSON.stringify({ v: value }));
          localStorage.setItem('com.markdownlivepreview_theme', value);
        }, theme);
        await page.reload({ waitUntil: 'networkidle2' });
        await sleep(1800);
        themedColours[theme] = await page.evaluate(() => {
          const formula = document.querySelector('#output .math-inline .katex');
          const output = document.querySelector('#output');
          return formula
            ? { formula: getComputedStyle(formula).color, output: getComputedStyle(output).color }
            : null;
        });
      }
      checks.push({
        name: 'math inherits preview colours in both themes',
        pass:
          themedColours.dark?.formula === themedColours.dark?.output &&
          themedColours.light?.formula === themedColours.light?.output &&
          themedColours.dark?.formula !== themedColours.light?.formula,
        detail: `dark ${themedColours.dark?.formula || 'missing'}, light ${themedColours.light?.formula || 'missing'}`
      });

      await page.setViewport({ width: 375, height: 812, deviceScaleFactor: 1 });
      await page.evaluate(() => document.querySelector('[data-view-mode="preview"]')?.click());
      await sleep(350);
      const narrow = await page.evaluate(() => {
        const host = [...document.querySelectorAll('#output .math-display')].at(-1);
        return host
          ? {
              client: host.clientWidth,
              scroll: host.scrollWidth,
              overflowX: getComputedStyle(host).overflowX,
              page: document.documentElement.scrollWidth,
              viewport: window.innerWidth
            }
          : null;
      });
      checks.push({
        name: 'wide display math scrolls inside a narrow preview',
        pass:
          narrow &&
          narrow.scroll > narrow.client + 8 &&
          ['auto', 'scroll'].includes(narrow.overflowX) &&
          narrow.page <= narrow.viewport,
        detail: narrow
          ? `${narrow.client}/${narrow.scroll}px, overflow ${narrow.overflowX}, page ${narrow.page}px`
          : 'wide display missing'
      });

      checks.push({
        name: 'no console errors while rendering math',
        pass: errors.length === 0,
        detail: errors[0]
      });

      return checks;
    });

    const failureChecks = await withPage(async (page) => {
      const checks = [];

      /*
       * Aborting the request is not enough once a service worker exists (T33). Its cache-first
       * rule answers from cache without ever hitting the network, so `request.abort()` is
       * never reached and the chunk loads anyway — the probe silently stopped probing.
       *
       * The premise here is "the KaTeX chunk cannot be obtained", and with a worker in play
       * that means unregistered *and* uncached. This is a fix to the test environment, not a
       * relaxation of what is asserted.
       */
      await page.evaluate(async () => {
        if ('serviceWorker' in navigator) {
          const registrations = await navigator.serviceWorker.getRegistrations();
          await Promise.all(registrations.map((registration) => registration.unregister()));
        }
        if (window.caches) {
          const keys = await caches.keys();
          await Promise.all(keys.map((key) => caches.delete(key)));
        }
      });

      await page.setRequestInterception(true);
      page.on('request', (request) => {
        if (request.url().toLowerCase().includes('katex')) {
          request.abort();
        } else {
          request.continue();
        }
      });
      await seed(page, 'Failure probe $x^2$.');
      const fallback = await page.evaluate(() => ({
        text: document.querySelector('#output').textContent,
        formulas: document.querySelectorAll('#output .katex').length
      }));
      checks.push({
        name: 'a failed lazy load leaves math literal',
        pass: fallback.text.includes('$x^2$') && fallback.formulas === 0,
        detail: `${fallback.formulas} formulas, “${fallback.text.trim()}”`
      });
      return checks;
    });

    const pdfChecks = await withPage(async (page, errors) => {
      const checks = [];
      await seed(page, PDF_DOC);
      await page.evaluate(PDF_INSTRUMENT);

      await exportPdfFromMenu(page);
      let finished = false;
      for (let attempt = 0; attempt < 60; attempt += 1) {
        await sleep(500);
        const state = await page.evaluate(() => ({
          busy: document.querySelector('#export-button').disabled,
          pages: window.__mathPdf.pages.length
        }));
        if (!state.busy && state.pages > 0) {
          finished = true;
          break;
        }
      }

      const result = await page.evaluate(() => ({
        ...window.__mathPdf,
        sandboxLeft: !!document.getElementById('pdf-export-sandbox')
      }));
      const inked = result.pages.some((pageResult) => (pageResult.inkRatio || 0) > 0);

      checks.push({ name: 'math PDF export completes', pass: finished });
      checks.push({
        name: 'the PDF sandbox contains laid-out KaTeX and retained MathML',
        pass:
          result.sandbox?.formulas > 0 &&
          result.sandbox?.semantics > 0 &&
          result.sandbox?.laidOut === true,
        detail: result.sandbox
          ? `${result.sandbox.formulas} formulas, ${result.sandbox.semantics} annotations, laid out ${result.sandbox.laidOut}`
          : 'sandbox was not observed'
      });
      checks.push({
        name: 'the exported math page contains ink',
        pass: inked,
        detail: result.pages.map((pageResult) => pageResult.inkRatio || 0).join(', ')
      });
      checks.push({ name: 'the math PDF sandbox is cleaned up', pass: result.sandboxLeft === false });
      checks.push({
        name: 'no console errors during math PDF export',
        pass: errors.length === 0,
        detail: errors[0]
      });

      return checks;
    });

    return [...renderingChecks, ...failureChecks, ...pdfChecks];
  }
};
