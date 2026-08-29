import { withPage, sleep, editorText, seedDocument } from './lib.mjs';

/*
 * Formatting shortcuts (T34).
 *
 * The check that carries the proof is italic. `CLAUDE.md` warns that Monaco stops propagation
 * on keydowns it binds, so a shortcut colliding with a Monaco default never reaches the
 * `document` listener in `src/ui/palette.js`. Measured with the editor focused, Ctrl+I is one
 * of those — along with Ctrl+L, Ctrl+D, Ctrl+H, Ctrl+Shift+7 and Ctrl+Shift+8.
 *
 * So an implementation registered only in the palette passes every other check here while
 * being broken exactly where it is used: with the cursor in the editor.
 */

const boot = async (page) => {
  await page.waitForFunction(() => !!document.querySelector('#editor .monaco-editor'), {
    timeout: 30000
  });
  await sleep(1500);
};

/** Puts a known line in the editor and selects the word `target` inside it. */
const selectWord = async (page, line, word) => {
  await page.click('#editor');
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await page.keyboard.type(line);
  await sleep(400);

  // Select by searching the model, so the selection is exact rather than click-positioned.
  const selected = await page.evaluate((needle) => {
    const editors = window.monaco?.editor?.getEditors?.() || [];
    const editor = editors[0];
    if (!editor) return false;
    const model = editor.getModel();
    const match = model.findMatches(needle, false, false, true, null, false)[0];
    if (!match) return false;
    editor.setSelection(match.range);
    editor.focus();
    return true;
  }, word);

  await sleep(250);
  return selected;
};

const press = async (page, key, { shift = false } = {}) => {
  await page.keyboard.down('Control');
  if (shift) await page.keyboard.down('Shift');
  await page.keyboard.press(key);
  if (shift) await page.keyboard.up('Shift');
  await page.keyboard.up('Control');
  await sleep(350);
};

export const suite = {
  name: 'format',
  async run() {
    return withPage(async (page, errors) => {
      const checks = [];

      await seedDocument(page, 'Plain sentence here.', 'Format fixture');
      await page.reload({ waitUntil: 'networkidle2' });
      await boot(page);

      /*
       * `window.monaco` is only present if the app exposes it. If it does not, fall back to
       * keyboard selection so the suite still measures something real rather than erroring.
       */
      const canSelectPrecisely = await page.evaluate(() => !!window.monaco?.editor?.getEditors);

      const selectViaKeyboard = async (line) => {
        await page.click('#editor');
        await page.keyboard.down('Control');
        await page.keyboard.press('KeyA');
        await page.keyboard.up('Control');
        await page.keyboard.press('Backspace');
        await page.keyboard.type(line);
        await sleep(300);
        await page.keyboard.down('Control');
        await page.keyboard.press('KeyA');
        await page.keyboard.up('Control');
        await sleep(200);
      };

      const setup = async (line, word) => {
        if (canSelectPrecisely) {
          const ok = await selectWord(page, line, word);
          if (ok) return;
        }
        await selectViaKeyboard(line);
      };

      // ---------- bold ----------

      await setup('Plain sentence here.', 'sentence');
      await press(page, 'KeyB');
      const afterBold = await editorText(page);
      checks.push({
        name: 'Ctrl+B wraps the selection in bold markers',
        pass: /\*\*sentence\*\*/.test(afterBold) || /\*\*Plain sentence here\.\*\*/.test(afterBold),
        detail: JSON.stringify(afterBold.slice(0, 70))
      });

      // ---------- bold again unwraps ----------

      await press(page, 'KeyB');
      const afterUnbold = await editorText(page);
      checks.push({
        name: 'pressing bold twice unwraps rather than nesting markers',
        pass: !/\*\*\*\*/.test(afterUnbold) && !/\*\*/.test(afterUnbold),
        detail: JSON.stringify(afterUnbold.slice(0, 70))
      });

      // ---------- italic: the one Monaco swallows ----------

      await setup('Plain sentence here.', 'sentence');
      await press(page, 'KeyI');
      const afterItalic = await editorText(page);
      checks.push({
        name: 'Ctrl+I italicises with the editor focused, despite Monaco binding that key',
        pass: /(^|[^*])\*sentence\*/.test(afterItalic) || /\*Plain sentence here\.\*/.test(afterItalic),
        detail: JSON.stringify(afterItalic.slice(0, 70))
      });

      // ---------- inline code ----------

      await setup('Plain sentence here.', 'sentence');
      await press(page, 'KeyE');
      const afterCode = await editorText(page);
      checks.push({
        name: 'Ctrl+E wraps the selection in a code span',
        pass: /`sentence`/.test(afterCode) || /`Plain sentence here\.`/.test(afterCode),
        detail: JSON.stringify(afterCode.slice(0, 70))
      });

      // ---------- link ----------

      await setup('Plain sentence here.', 'sentence');
      await press(page, 'KeyK', { shift: true });
      const afterLink = await editorText(page);
      checks.push({
        name: 'Ctrl+Shift+K turns the selection into a link',
        pass: /\[sentence\]\(/.test(afterLink) || /\[Plain sentence here\.\]\(/.test(afterLink),
        detail: JSON.stringify(afterLink.slice(0, 70))
      });

      // ---------- heading ----------

      await setup('Plain sentence here.', 'sentence');
      await press(page, 'KeyH', { shift: true });
      const afterHeading = await editorText(page);
      checks.push({
        name: 'Ctrl+Shift+H makes the line a heading',
        pass: /^#\s/.test(afterHeading.trim()),
        detail: JSON.stringify(afterHeading.slice(0, 70))
      });

      // ---------- list ----------

      await setup('Plain sentence here.', 'sentence');
      await press(page, 'KeyL', { shift: true });
      const afterList = await editorText(page);
      checks.push({
        name: 'Ctrl+Shift+L makes the line a list item',
        pass: /^-\s/.test(afterList.trim()),
        detail: JSON.stringify(afterList.slice(0, 70))
      });

      // ---------- palette ----------

      await page.keyboard.down('Control');
      await page.keyboard.press('KeyK');
      await page.keyboard.up('Control');
      await sleep(400);
      const commands = await page.evaluate(() =>
        [...document.querySelectorAll('#palette .sheet__item')].map((el) =>
          el.textContent.replace(/\s+/g, ' ').trim()
        )
      );
      await page.keyboard.press('Escape');
      await sleep(250);

      const wanted = ['bold', 'italic', 'code', 'link', 'heading', 'list'];
      const missing = wanted.filter((w) => !commands.some((c) => new RegExp(w, 'i').test(c)));
      checks.push({
        name: 'every formatting command is reachable from the palette',
        pass: missing.length === 0,
        detail: missing.length ? `missing: ${missing.join(', ')}` : `${wanted.length} present`
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
