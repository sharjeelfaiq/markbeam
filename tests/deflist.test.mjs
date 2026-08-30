import { seedDocument, sleep, withPage } from './lib.mjs';

/*
 * Definition lists (T43).
 *
 * Markdown Extra's `Term` / `: definition`, the one common list type Markbeam could not
 * express. A block-level marked extension, in the shape of the inline ones in
 * `src/markdown/highlight.js` and the math extension.
 *
 * The interesting cases are the ones that must **not** become definition lists. A colon
 * starting a line is ordinary punctuation far more often than it is markup — a time, a ratio,
 * a YAML-looking line inside prose — and a tokenizer that grabs all of them turns normal
 * documents into nonsense. Those checks matter more than the happy path.
 */

const DOC = [
  '# Definitions',
  '',
  'Markbeam',
  ': An online Markdown editor with live preview.',
  '',
  'Mermaid',
  ': Diagrams from fenced code blocks.',
  ': A second definition for the same term.',
  '',
  '## Not definition lists',
  '',
  'A line ending in a colon:',
  'and the next line, which is just prose.',
  '',
  'The meeting is at 14:30 today.',
  '',
  '```yaml',
  'key: value',
  '```',
  '',
  'Ratio 3:1 in a sentence.'
].join('\n');

const boot = async (page) => {
  await page.waitForFunction(() => !!document.querySelector('#editor .monaco-editor'), {
    timeout: 30000
  });
  await sleep(1800);
};

export const suite = {
  name: 'definition lists',
  async run() {
    return withPage(async (page, errors) => {
      const checks = [];

      await seedDocument(page, DOC, 'Definitions');
      await page.reload({ waitUntil: 'networkidle2' });
      await boot(page);

      const shape = await page.evaluate(() => {
        const lists = [...document.querySelectorAll('#output dl')];
        return {
          count: lists.length,
          terms: [...document.querySelectorAll('#output dt')].map((el) => el.textContent.trim()),
          definitions: [...document.querySelectorAll('#output dd')].map((el) =>
            el.textContent.trim()
          )
        };
      });

      checks.push({
        name: 'a term followed by a colon line renders as dl / dt / dd',
        pass: shape.count >= 1 && shape.terms.includes('Markbeam'),
        detail: `${shape.count} lists, terms ${JSON.stringify(shape.terms)}`
      });

      checks.push({
        name: 'one term can carry several definitions',
        pass:
          shape.terms.includes('Mermaid') &&
          shape.definitions.some((d) => /A second definition/.test(d)),
        detail: JSON.stringify(shape.definitions)
      });

      /*
       * The whole risk of this feature. A colon at the start of a line is usually prose, and
       * a greedy tokenizer would silently restructure documents that contain a time, a ratio
       * or a YAML block.
       */
      const falsePositives = await page.evaluate(() => {
        const text = document.querySelector('#output')?.textContent || '';
        return {
          keptProse: /and the next line, which is just prose\./.test(text),
          keptTime: /14:30/.test(text),
          keptRatio: /Ratio 3:1/.test(text),
          codeUntouched: !!document.querySelector('#output pre code'),
          codeHasNoDl: !document.querySelector('#output pre dl, #output code dl'),
          termsSeen: [...document.querySelectorAll('#output dt')].map((el) => el.textContent.trim())
        };
      });

      /*
       * Gated on the feature existing. "No false positives" is trivially true of a build with
       * no definition lists at all, so without the gate this passes for the wrong reason —
       * and it is the check that guards the risky half of the feature.
       */
      checks.push({
        name: 'a colon in ordinary prose is not turned into a definition list',
        pass:
          shape.count >= 1 &&
          falsePositives.keptProse &&
          falsePositives.keptTime &&
          falsePositives.keptRatio &&
          !falsePositives.termsSeen.some((t) => /meeting|Ratio|colon/i.test(t)),
        detail:
          shape.count >= 1
            ? `terms found: ${JSON.stringify(falsePositives.termsSeen)}`
            : 'no definition lists render at all, so nothing could be a false positive'
      });

      checks.push({
        name: 'a colon inside a fenced block stays code',
        pass: shape.count >= 1 && falsePositives.codeUntouched && falsePositives.codeHasNoDl,
        detail:
          shape.count >= 1
            ? `code block present=${falsePositives.codeUntouched}, no dl inside=${falsePositives.codeHasNoDl}`
            : 'no definition lists render at all, so the fence was never at risk'
      });

      // Sanitisation: dl/dt/dd are standard, but the whole render passes through DOMPurify.
      const survived = await page.evaluate(
        () => document.querySelectorAll('#output dl dt, #output dl dd').length
      );
      checks.push({
        name: 'the tags survive DOMPurify',
        pass: survived >= 4,
        detail: `${survived} dt/dd elements inside a dl`
      });

      // Both themes come from tokens; a definition must not be invisible in either.
      const contrast = await page.evaluate(async () => {
        const read = () => {
          const dd = document.querySelector('#output dd');
          const pane = document.querySelector('.pane--preview');
          return {
            colour: dd ? getComputedStyle(dd).color : null,
            background: pane ? getComputedStyle(pane).backgroundColor : null,
            indented: dd ? Math.round(dd.getBoundingClientRect().left) : null
          };
        };

        const results = {};
        for (const theme of ['dark', 'light']) {
          document.documentElement.setAttribute('data-theme', theme);
          await new Promise((r) => setTimeout(r, 120));
          results[theme] = read();
        }
        return results;
      });

      const luminance = (value) => {
        const m = /rgba?\(([^)]+)\)/.exec(value || '');
        if (!m) return null;
        const [r, g, b] = m[1].split(/[,/]/).map(Number);
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };

      const readable = ['dark', 'light'].every((theme) => {
        const text = luminance(contrast[theme]?.colour);
        const bg = luminance(contrast[theme]?.background);
        return text !== null && bg !== null && Math.abs(text - bg) > 40;
      });

      checks.push({
        name: 'definitions are legible in both themes and indented from the term',
        pass: readable && (contrast.dark?.indented || 0) > 0,
        detail: JSON.stringify(contrast)
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
