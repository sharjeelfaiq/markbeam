import { seedDocument, sleep, withPage } from './lib.mjs';

/*
 * `:emoji:` shortcodes (T5, #95).
 *
 * The emoji dataset is loaded lazily — node-emoji drags in emojilib, 326 KB unpacked, and
 * the codebase keeps that kind of weight out of the first paint. So the checks below wait
 * on the rendered result rather than on a fixed delay: a sleep long enough to be safe on a
 * slow machine would be pure padding on a fast one, and a sleep that is too short would
 * fail against working code.
 *
 * Most of these checks assert that something is *not* touched. They pass before the change
 * as well, by construction — with no extension there is nothing to corrupt. They exist
 * because a tokenizer that runs ahead of marked's own inline rules is exactly the kind of
 * thing that eats code spans and URLs, so they guard the fix rather than prove the bug.
 */

const DOC = [
  '# Emoji',
  '',
  'Known: :x: :tada: :+1:',
  '',
  'Unknown: :notanemoji:',
  '',
  'Code span: `:x:`',
  '',
  '```',
  'fenced :tada: block',
  '```',
  '',
  'Link: http://host:8080/x',
  '',
  'Time: 12:30 today.'
].join('\n');

const seed = async (page, markdown) => {
  await seedDocument(page, markdown);
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForFunction(() => !!document.querySelector('#editor .monaco-editor'), {
    timeout: 30000
  });
};

/** Waits for the lazily-loaded dataset to have been applied, or gives up. */
const waitForEmoji = async (page) => {
  try {
    await page.waitForFunction(
      () => document.querySelector('#output').textContent.includes('🎉'),
      { timeout: 8000 }
    );
    return true;
  } catch {
    return false;
  }
};

const outputText = (page) => page.evaluate(() => document.querySelector('#output').textContent);

export const suite = {
  name: 'emoji',
  async run() {
    return withPage(async (page, errors) => {
      const checks = [];

      await seed(page, DOC);
      const applied = await waitForEmoji(page);
      await sleep(400);
      const text = await outputText(page);

      checks.push({
        name: ':x:, :tada: and :+1: render as emoji',
        pass: text.includes('❌') && text.includes('🎉') && text.includes('👍'),
        detail: applied
          ? `known line reads "${(text.match(/Known:[^\n]*/) || ['(missing)'])[0].trim()}"`
          : 'no emoji appeared within 8s'
      });

      /*
       * Scoped to the line under test rather than the whole document: `:tada:` is also in
       * the fenced block below, where it is *supposed* to survive. Scanning everything made
       * this fail against a working implementation.
       */
      const knownLine = (text.match(/Known:[^\n]*/) || [''])[0];
      checks.push({
        name: 'the shortcodes are replaced, not left alongside the emoji',
        pass: !/:x:|:tada:|:\+1:/.test(knownLine),
        detail: knownLine.trim() || '(line missing)'
      });

      checks.push({
        name: 'an unknown shortcode stays literal',
        pass: text.includes(':notanemoji:'),
        detail: (text.match(/Unknown:[^\n]*/) || ['(missing)'])[0].trim()
      });

      // The tokenizer runs before marked's codespan rule, so this is the real risk.
      const codeSpans = await page.evaluate(() =>
        [...document.querySelectorAll('#output p code')].map((el) => el.textContent)
      );
      checks.push({
        name: 'a shortcode inside a code span is left alone',
        pass: codeSpans.includes(':x:'),
        detail: JSON.stringify(codeSpans)
      });

      const fenced = await page.evaluate(() =>
        [...document.querySelectorAll('#output pre code')].map((el) => el.textContent).join('|')
      );
      checks.push({
        name: 'a shortcode inside a fenced block is left alone',
        pass: fenced.includes(':tada:'),
        detail: fenced.trim().slice(0, 40)
      });

      checks.push({
        name: 'a URL with a port is untouched',
        pass: text.includes('http://host:8080/x'),
        detail: (text.match(/Link:[^\n]*/) || ['(missing)'])[0].trim()
      });

      checks.push({
        name: 'a clock time is untouched',
        pass: text.includes('12:30'),
        detail: (text.match(/Time:[^\n]*/) || ['(missing)'])[0].trim()
      });

      /*
       * The document is already on screen before the emoji chunk resolves, so the app has
       * to re-render once it arrives. Typing after load is the easy case; this is the one
       * that needs the re-render, and it is why `loadEmoji` reports whether it changed
       * anything.
       */
      checks.push({
        name: 'a document rendered before the chunk loaded is re-rendered with emoji',
        pass: applied,
        detail: applied ? 'emoji appeared without an edit' : 'never re-rendered'
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
