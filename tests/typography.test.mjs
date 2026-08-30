import { seedDocument, sleep, withPage } from './lib.mjs';

/*
 * Typographic punctuation (T44).
 *
 * StackEdit ships SmartyPants on. Markbeam ships it **off**, and that is the design rather
 * than caution: this is a developer-facing editor, so straight quotes inside prose are
 * frequently deliberate, and silently rewriting them corrupts the first shell snippet anyone
 * pastes into a paragraph.
 *
 * marked v15 removed its own `smartypants` option, so the transform is ours. It runs in
 * `renderer.text` on the token's **raw text, before escaping** — after escaping a straight
 * quote is already `&quot;` and the pattern would never match it.
 *
 * Code spans and fenced blocks route through `renderer.codespan` and `renderer.code`, which
 * the transform never touches. That makes "code is untouched" structural rather than a rule
 * someone has to remember, and the checks below hold it to that.
 */

const DOC = [
  '# Typography',
  '',
  'She said "hello" and then \'goodbye\' -- rather abruptly --- twice...',
  '',
  "Don't touch the apostrophe.",
  '',
  'Run `git log --oneline` and `curl -H "Accept: text/plain"` in the shell.',
  '',
  '```bash',
  'grep --count "needle" haystack.txt',
  "awk '{print $1}' file",
  '```'
].join('\n');

const CURLY = /[‘’“”–—…]/;

const boot = async (page) => {
  await page.waitForFunction(() => !!document.querySelector('#editor .monaco-editor'), {
    timeout: 30000
  });
  await sleep(1800);
};

const paletteTitles = async (page) => {
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyK');
  await page.keyboard.up('Control');
  await sleep(400);
  const titles = await page.evaluate(() =>
    [...document.querySelectorAll('#palette .sheet__item')].map((el) => el.textContent.trim())
  );
  await page.keyboard.press('Escape');
  await sleep(300);
  return titles;
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
  await sleep(800);
  return clicked;
};

/** Prose only — the paragraphs, with code spans and fenced blocks removed. */
const proseText = (page) =>
  page.evaluate(() => {
    const clone = document.querySelector('#output')?.cloneNode(true);
    if (!clone) return '';
    clone.querySelectorAll('code, pre').forEach((el) => el.remove());
    return clone.textContent.replace(/\s+/g, ' ').trim();
  });

const codeText = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('#output code')].map((el) => el.textContent).join(' | ')
  );

export const suite = {
  name: 'typography',
  async run() {
    return withPage(async (page, errors) => {
      const checks = [];

      await seedDocument(page, DOC, 'Typography');
      await page.reload({ waitUntil: 'networkidle2' });
      await boot(page);

      const titles = await paletteTitles(page);
      const hasCommand = titles.some((t) => /typograph|smart punctuation/i.test(t));
      checks.push({
        name: 'the palette offers a typographic punctuation toggle',
        pass: hasCommand,
        detail: JSON.stringify(titles.filter((t) => /typograph|punctuation|quote/i.test(t)))
      });

      /*
       * Gated on the command existing. "Straight quotes are preserved" is trivially true of a
       * build with no transform at all, and off-by-default is the claim that matters most
       * here — it has to be shown as a *choice*, not as an absence.
       */
      const proseBefore = await proseText(page);
      checks.push({
        name: 'it is off by default, so prose keeps exactly what was typed',
        pass: hasCommand && proseBefore.includes('"hello"') && !CURLY.test(proseBefore),
        detail: hasCommand
          ? `prose: ${proseBefore.slice(0, 80)}`
          : 'no toggle exists, so "off by default" is an absence rather than a default'
      });

      const enabled = await runCommand(page, 'typograph');
      const proseAfter = await proseText(page);

      checks.push({
        name: 'enabling it curls quotes and joins dashes',
        pass:
          enabled &&
          /[“]hello[”]/.test(proseAfter) &&
          /[‘]goodbye[’]/.test(proseAfter) &&
          proseAfter.includes('–') &&
          proseAfter.includes('—') &&
          proseAfter.includes('…'),
        detail: enabled ? `prose: ${proseAfter.slice(0, 100)}` : 'no toggle to enable'
      });

      checks.push({
        name: "an apostrophe becomes a right single quote, not an opening one",
        pass: /Don’t/.test(proseAfter),
        detail: proseAfter.match(/Don.t/)?.[0] || 'not found'
      });

      /*
       * The reason this is opt-in. A shell snippet in prose must survive it — both in a code
       * span and in a fenced block.
       */
      const code = await codeText(page);
      checks.push({
        name: 'code spans and fenced blocks are untouched',
        pass:
          enabled &&
          code.includes('git log --oneline') &&
          code.includes('"Accept: text/plain"') &&
          code.includes('grep --count "needle"') &&
          code.includes("awk '{print $1}'") &&
          !CURLY.test(code),
        detail: code.slice(0, 140)
      });

      // Persisted like the Markdown mode.
      await page.reload({ waitUntil: 'networkidle2' });
      await boot(page);
      const afterReload = await proseText(page);
      checks.push({
        name: 'the setting survives a reload',
        pass: /[“]hello[”]/.test(afterReload),
        detail: afterReload.slice(0, 80)
      });

      // …and turning it back off restores what was typed.
      await runCommand(page, 'typograph');
      const proseOff = await proseText(page);
      checks.push({
        // Gated on the toggle existing: with no feature, prose never curled in the first
        // place, so 'it went back' is a statement about nothing.
        name: 'turning it off gives the straight quotes back',
        pass: enabled && proseOff.includes('"hello"') && !CURLY.test(proseOff),
        detail: proseOff.slice(0, 80)
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
