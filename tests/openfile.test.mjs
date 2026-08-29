import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withPage, sleep, editorText, seedDocument } from './lib.mjs';

/*
 * Opening a Markdown file (T32).
 *
 * Two things here are easy to get wrong and are the reason the checks are shaped as they
 * are:
 *
 *   - "the previous document survives" must be asserted by **id and content**, not by
 *     counting documents. Two documents existing proves nothing about whether the first one
 *     still holds what it held.
 *   - the size guard is not cosmetic. `write()` in src/storage.js catches
 *     QuotaExceededError and only console.warns, so an oversized file would appear to open,
 *     fail to persist, and be gone on reload — silent data loss that the suites' console
 *     *error* checks would not catch either.
 */

const DOCS_KEY = 'markbeam:docs';

const reload = async (page) => {
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForFunction(() => !!document.querySelector('#editor .monaco-editor'), {
    timeout: 30000
  });
  await sleep(1500);
};

const readIndex = (page) =>
  page.evaluate((key) => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw).v : null;
    } catch (error) {
      return null;
    }
  }, DOCS_KEY);

const docContent = (page, id) =>
  page.evaluate((docId) => {
    try {
      const raw = localStorage.getItem(`markbeam:doc:${docId}`);
      return raw ? JSON.parse(raw).v : null;
    } catch (error) {
      return null;
    }
  }, id);

const activeId = (page) =>
  page.evaluate(() => {
    try {
      const raw = localStorage.getItem('markbeam:active_doc');
      return raw ? JSON.parse(raw).v : null;
    } catch (error) {
      return null;
    }
  });

const toastText = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('#toasts .toast')]
      .map((el) => `${el.dataset.tone || 'info'}: ${el.textContent.trim()}`)
      .join(' | ')
  );

/*
 * Drops a file without touching the disk: a File and a DataTransfer are synthesised in the
 * page, which is the only way to drive a real `drop` event from Puppeteer.
 */
const dropFile = (page, name, contents) =>
  page.evaluate(
    ({ fileName, text }) => {
      const file = new File([text], fileName, { type: 'text/markdown' });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      document.dispatchEvent(
        new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer })
      );
    },
    { fileName: name, text: contents }
  );

/** Same, for a file whose bytes are not text at all. */
const dropBinary = (page, name) =>
  page.evaluate((fileName) => {
    // A ZIP-like payload is genuinely unsupported. PNG is now a supported editor input,
    // so using it here would make this old refusal check contradict the image suite.
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x01, 0x00, 0x02]);
    const file = new File([bytes], fileName, { type: 'application/octet-stream' });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    document.dispatchEvent(
      new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer })
    );
  }, name);

export const suite = {
  name: 'open file',
  async run() {
    const fixtures = mkdtempSync(join(tmpdir(), 'markbeam-open-'));

    try {
      return await withPage(async (page, errors) => {
        const checks = [];

        await seedDocument(page, '# Original\n\nText that must survive.', 'Original');
        await reload(page);

        const originalId = await activeId(page);
        const originalBefore = await docContent(page, originalId);

        // ---------- the command exists ----------

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
        await sleep(300);

        checks.push({
          name: 'the palette offers a command for opening a file',
          pass: commands.some((c) => /open.*file/i.test(c)),
          detail: commands.find((c) => /open/i.test(c)) || 'no open command in the palette'
        });

        // ---------- the picker ----------

        const fixture = join(fixtures, 'picked-notes.md');
        writeFileSync(fixture, '# Picked\n\nOpened through the file picker.');

        const input = await page.$('input[type="file"]');
        if (input) {
          await input.uploadFile(fixture);
          await sleep(1200);
        }

        const afterPicker = await editorText(page);
        checks.push({
          name: 'a file chosen in the picker becomes the open document',
          pass: !!input && /Opened through the file picker/.test(afterPicker),
          detail: input
            ? JSON.stringify(afterPicker.slice(0, 60))
            : 'no <input type="file"> in the page'
        });

        // ---------- drag and drop ----------

        await dropFile(page, 'dropped-notes.md', '# Dropped\n\nArrived by drag and drop.');
        await sleep(1200);

        const afterDrop = await editorText(page);
        const index = await readIndex(page);
        const droppedEntry = (index || []).find((entry) => /dropped-notes/i.test(entry.title));

        checks.push({
          name: 'a dropped file becomes a new document titled from its filename',
          pass:
            /Arrived by drag and drop/.test(afterDrop) &&
            !!droppedEntry &&
            !/\.md$/i.test(droppedEntry.title),
          detail: droppedEntry
            ? `title ${JSON.stringify(droppedEntry.title)}, editor ${JSON.stringify(afterDrop.slice(0, 40))}`
            : `no document titled from the file; index ${JSON.stringify((index || []).map((e) => e.title))}`
        });

        /*
         * By id and content, not by count. "Two documents exist" would pass even if the
         * original had been overwritten.
         */
        const originalAfter = await docContent(page, originalId);
        checks.push({
          name: 'the document that was open before is untouched',
          pass:
            typeof originalAfter === 'string' &&
            originalAfter === originalBefore &&
            /Text that must survive/.test(originalAfter),
          detail:
            originalAfter === null
              ? 'the original document key is gone'
              : `unchanged=${originalAfter === originalBefore}, ${JSON.stringify(originalAfter.slice(0, 40))}`
        });

        // ---------- refusals ----------

        const beforeOversize = (await readIndex(page))?.length ?? 0;
        await page.evaluate(() => {
          document.querySelectorAll('#toasts .toast').forEach((el) => el.remove());
        });

        // 2 MB, comfortably past any sane limit for a Markdown file.
        await dropFile(page, 'huge.md', 'x'.repeat(2 * 1024 * 1024));
        await sleep(1200);

        const afterOversize = (await readIndex(page))?.length ?? 0;
        const oversizeToast = await toastText(page);
        checks.push({
          name: 'an oversized file is refused instead of silently failing to save',
          pass: afterOversize === beforeOversize && /error/i.test(oversizeToast),
          detail: `${beforeOversize} -> ${afterOversize} documents, toast ${JSON.stringify(oversizeToast)}`
        });

        const beforeBinary = (await readIndex(page))?.length ?? 0;
        await page.evaluate(() => {
          document.querySelectorAll('#toasts .toast').forEach((el) => el.remove());
        });

        await dropBinary(page, 'archive.zip');
        await sleep(1200);

        const afterBinary = (await readIndex(page))?.length ?? 0;
        const binaryToast = await toastText(page);
        checks.push({
          name: 'a file that is not text is refused',
          pass: afterBinary === beforeBinary && /error/i.test(binaryToast),
          detail: `${beforeBinary} -> ${afterBinary} documents, toast ${JSON.stringify(binaryToast)}`
        });

        checks.push({
          name: 'no console errors',
          pass: errors.length === 0,
          detail: errors[0]
        });

        return checks;
      });
    } finally {
      rmSync(fixtures, { recursive: true, force: true });
    }
  }
};
