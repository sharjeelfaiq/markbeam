import { seedDocument, sleep, withPage } from './lib.mjs';

/*
 * Presentation mode (T51).
 *
 * **Slides are split on the rendered `<hr>`, never on the text `---`.** In Markdown a `---`
 * is also a setext heading underline and a front-matter fence, and inside a code block it is
 * just three characters. Splitting the source would break all three; the rendered output has
 * already resolved the ambiguity, which is why the fenced-code check below matters more than
 * it looks — it is the one that fails on the obvious implementation.
 */

const DOC = [
  '# One',
  '',
  'First slide.',
  '',
  '---',
  '',
  '# Two',
  '',
  '```',
  'not --- a slide break',
  '---',
  '```',
  '',
  '---',
  '',
  '# Three',
  '',
  'Last slide.'
].join('\n');

const INSTRUMENT = `
window.__pdfPages = [];
const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
HTMLCanvasElement.prototype.toDataURL = function (...args) {
  try {
    window.__pdfPages.push({ width: this.width, height: this.height });
  } catch (e) {}
  return origToDataURL.apply(this, args);
};
`;

const boot = async (page) => {
  await page.waitForFunction(() => !!document.querySelector('#editor .monaco-editor'), {
    timeout: 30000
  });
  await sleep(2000);
};

const runCommand = async (page, needle) => {
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyK');
  await page.keyboard.up('Control');
  await sleep(400);
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
  await sleep(700);
  return clicked;
};

const slideState = (page) =>
  page.evaluate(() => {
    const root = document.querySelector('#present');
    if (!root || root.hidden) return null;
    const slides = [...root.querySelectorAll('.present__slide')];
    const visible = slides.filter((s) => !s.hidden && s.offsetParent !== null);
    return {
      total: slides.length,
      visible: visible.length,
      text: (visible[0]?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40)
    };
  });

export const suite = {
  name: 'presentation',
  async run() {
    const checks = [];

    await withPage(async (page, errors) => {
      await page.evaluateOnNewDocument(INSTRUMENT);
      await seedDocument(page, DOC, 'Deck');
      await page.reload({ waitUntil: 'networkidle2' });
      await boot(page);

      const opened = await runCommand(page, 'present');
      await sleep(600);
      const state = await slideState(page);

      checks.push({
        name: 'a palette command opens presentation mode',
        pass: opened === true && !!state,
        detail: opened ? JSON.stringify(state) : 'no present command'
      });

      checks.push({
        name: 'a --- inside a fenced code block is not a slide break',
        pass: !!state && state.total === 3,
        detail: state ? `${state.total} slides (3 expected)` : 'not open'
      });

      checks.push({
        name: 'exactly one slide is on screen at a time',
        pass: !!state && state.visible === 1 && /One/.test(state.text),
        detail: state ? `${state.visible} visible, "${state.text}"` : 'not open'
      });

      await page.keyboard.press('ArrowRight');
      await sleep(400);
      const second = await slideState(page);
      checks.push({
        name: 'the keyboard advances a slide',
        pass: !!second && second.visible === 1 && /Two/.test(second.text),
        detail: second ? `"${second.text}"` : 'not open'
      });

      await page.keyboard.press('ArrowLeft');
      await sleep(400);
      const back = await slideState(page);
      checks.push({
        name: 'and goes back',
        pass: !!back && /One/.test(back.text),
        detail: back ? `"${back.text}"` : 'not open'
      });

      await page.keyboard.press('Escape');
      await sleep(500);
      const closed = await page.evaluate(() => {
        const root = document.querySelector('#present');
        return !root || root.hidden;
      });
      checks.push({
        name: 'Escape leaves presentation mode',
        pass: closed === true,
        detail: closed ? 'closed' : 'still open'
      });

      checks.push({ name: 'no console errors', pass: errors.length === 0, detail: errors[0] });
    });

    // ---------- one slide per PDF page ----------

    await withPage(async (page, errors) => {
      await page.evaluateOnNewDocument(INSTRUMENT);
      await seedDocument(page, DOC, 'Deck');
      await page.reload({ waitUntil: 'networkidle2' });
      await boot(page);

      const exported = await runCommand(page, 'export slides');
      if (exported) {
        for (let i = 0; i < 90; i += 1) {
          await sleep(1000);
          const done = await page.evaluate(() => (window.__pdfPages || []).length > 0);
          if (done) break;
        }
        await sleep(1500);
      }

      // jsPDF also makes a small scratch canvas; real pages are the wide ones.
      const pages = await page.evaluate(() =>
        (window.__pdfPages || []).filter((p) => (p.width || 0) > 400).length
      );

      checks.push({
        name: 'the slide deck exports one PDF page per slide',
        pass: exported === true && pages === 3,
        detail: exported ? `${pages} page(s) for 3 slides` : 'no export-slides command'
      });

      checks.push({ name: 'no console errors during slide export', pass: errors.length === 0, detail: errors[0] });
    });

    return checks;
  }
};
