import { seedDocument, sleep, withPage, ready } from './lib.mjs';

/*
 * `==highlight==` syntax (T6, #89).
 *
 * Two halves to the requirement, and the second is the one worth engineering for. Producing
 * a `<mark>` is easy; producing one a reader can actually see is the part that can silently
 * fail, because `.mb-md mark` inherits a background tuned for large surfaces rather than for
 * marking a few words. So the tint is measured against the preview background in *both*
 * themes rather than merely asserting the element exists.
 *
 * Several checks here pass before the feature exists, by construction — with no extension
 * there is nothing to corrupt. They guard the fix against over-reaching, which is the real
 * hazard in a tokenizer that runs ahead of marked's own inline rules.
 */

const DOC = [
  '# Highlight',
  '',
  'Plain ==highlighted== text.',
  '',
  'Nested ==**bold** inside== a mark.',
  '',
  'Raw <mark>raw mark</mark> element.',
  '',
  'Literal single = sign, a bare == pair, and a == b spaced out, plus === three.',
  '',
  'Code span: `==code==`',
  '',
  '```',
  'fenced ==block== text',
  '```'
].join('\n');

const seed = async (page, markdown) => {
  await seedDocument(page, markdown);
  await page.reload({ waitUntil: 'networkidle2' });
  await ready(page);
};

/** Marks that came from `==…==`, excluding the deliberately raw one. */
const readMarks = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('#output mark')].map((el) => ({
      text: el.textContent,
      html: el.innerHTML,
      background: getComputedStyle(el).backgroundColor,
      colour: getComputedStyle(el).color
    }))
  );

const paneBackground = (page) =>
  page.evaluate(() => {
    // Walk up until something actually paints, since #output itself may be transparent.
    let el = document.querySelector('#output');
    while (el) {
      const bg = getComputedStyle(el).backgroundColor;
      if (bg && !/rgba?\(0,\s*0,\s*0,\s*0\)|transparent/.test(bg)) {
        return bg;
      }
      el = el.parentElement;
    }
    return 'rgb(255, 255, 255)';
  });

const channels = (colour) => {
  const match = /rgba?\(([^)]+)\)/.exec(colour || '');
  return match ? match[1].split(/[,/]/).map((n) => parseFloat(n)) : null;
};

const luminance = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/*
 * How far the highlight actually shifts the page, in perceived luminance.
 *
 * The mark's background is a low-alpha wash, so its computed value must be COMPOSITED over
 * the pane before it means anything. Comparing the raw rgba() instead scores the tint's
 * own brightness and reports a large difference for a highlight nobody can see — the first
 * version of this check did exactly that and passed against a feature that did not exist.
 */
const tintDelta = (markBackground, paneBackground) => {
  const fg = channels(markBackground);
  const bg = channels(paneBackground);
  if (!fg || !bg) {
    return -1;
  }

  const alpha = fg.length > 3 ? fg[3] : 1;
  const blended = [0, 1, 2].map((i) => alpha * fg[i] + (1 - alpha) * bg[i]);

  return Math.abs(luminance(blended) - luminance(bg));
};

const outputText = (page) => page.evaluate(() => document.querySelector('#output').textContent);

export const suite = {
  name: 'highlight',
  async run() {
    return withPage(async (page, errors) => {
      const checks = [];

      await seed(page, DOC);

      const marks = await readMarks(page);
      const text = await outputText(page);

      checks.push({
        name: '==text== produces a mark element',
        pass: marks.some((m) => m.text === 'highlighted'),
        detail: marks.length ? marks.map((m) => `"${m.text}"`).join(', ') : 'no <mark> at all'
      });

      const plainLine = (text.match(/Plain[^\n]*/) || [''])[0];
      checks.push({
        name: 'the == delimiters are gone from the rendered text',
        pass: plainLine.includes('highlighted') && !plainLine.includes('=='),
        detail: plainLine.trim() || '(line missing)'
      });

      checks.push({
        name: 'inline markup nested inside a highlight still renders',
        pass: marks.some((m) => /<strong>bold<\/strong>/.test(m.html)),
        detail: (marks.find((m) => m.text.includes('bold')) || {}).html || '(no nested mark)'
      });

      /*
       * The legibility half of the requirement. A mark whose background matches the page is
       * not a highlight, and every other check here would pass on one.
       */
      for (const theme of ['dark', 'light']) {
        await page.evaluate((t) => {
          localStorage.setItem('markbeam:theme_settings', JSON.stringify({ v: t }));
          localStorage.setItem('com.markdownlivepreview_theme', t);
        }, theme);
        await page.reload({ waitUntil: 'networkidle2' });
        await page.waitForFunction(() => !!document.querySelector('#editor .monaco-editor'), {
          timeout: 30000
        });
        await sleep(1200);

        const themed = await readMarks(page);
        const pane = await paneBackground(page);
        const first = themed[0];
        const delta = first ? tintDelta(first.background, pane) : -1;

        /*
         * 12/255 of perceived luminance. Below roughly this the wash reads as a rendering
         * artefact rather than a deliberate mark — checked by eye in both themes, not
         * picked from the air.
         */
        checks.push({
          name: `the highlight is visibly tinted in the ${theme} theme`,
          pass: delta >= 12,
          detail: first
            ? `mark ${first.background} over pane ${pane} -> luminance delta ${delta.toFixed(1)}`
            : 'no <mark> to measure'
        });
      }

      // ---- guards: these pass before the feature exists too ----

      const finalText = await outputText(page);
      const finalMarks = await readMarks(page);

      checks.push({
        name: 'a raw <mark> element still renders and survives sanitisation',
        pass: finalMarks.some((m) => m.text === 'raw mark'),
        detail: finalMarks.map((m) => `"${m.text}"`).join(', ') || 'none'
      });

      const literalLine = (finalText.match(/Literal[^\n]*/) || [''])[0];
      checks.push({
        name: 'a lone =, a bare ==, a spaced a == b and === all stay literal',
        pass:
          literalLine.includes('single = sign') &&
          literalLine.includes('bare == pair') &&
          literalLine.includes('a == b spaced out') &&
          literalLine.includes('=== three'),
        detail: literalLine.trim() || '(line missing)'
      });

      const codeSpans = await page.evaluate(() =>
        [...document.querySelectorAll('#output p code')].map((el) => el.textContent)
      );
      const fenced = await page.evaluate(() =>
        [...document.querySelectorAll('#output pre code')].map((el) => el.textContent).join('|')
      );
      checks.push({
        name: 'code spans and fenced blocks are left alone',
        pass: codeSpans.includes('==code==') && fenced.includes('==block=='),
        detail: `spans ${JSON.stringify(codeSpans)}, fenced "${fenced.trim().slice(0, 24)}"`
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
