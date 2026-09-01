import { sleep, withPage, ready, editorText } from './lib.mjs';

/*
 * Editing a real file on disk (T70).
 *
 * The File System Access API is the one thing here that cannot be exercised honestly end to
 * end: `showOpenFilePicker` requires a user gesture on a real picker, and a real
 * `FileSystemFileHandle` cannot be manufactured. So the picker is stubbed and what is asserted
 * is **what the app does with a handle**, which is where every interesting decision lives.
 *
 * Two checks here are the ones a careless implementation breaks:
 *
 *   - **Ctrl+S still exports a PDF and does not write the file.** The welcome document teaches
 *     Ctrl+S as "export a PDF", and a save-to-disk feature is exactly the change that would
 *     quietly steal it. T66 already cost two suites this way.
 *   - **A file that moved on disk is not overwritten.** `src/autoSync.js` refuses to merge for
 *     the same reason, and a file changed underneath you is that situation through a different
 *     door. Silently clobbering it is a data-loss path, and no other check would notice.
 *
 * The fake handle carries methods, so it is **not structured-cloneable** and IndexedDB will
 * refuse it with a DataCloneError. That is deliberate rather than a limitation worked around:
 * persistence has to be best-effort anyway — a browser in private mode refuses the same way —
 * and this suite proves the app still opens and saves when the durability layer fails. Whether
 * a handle actually survives a reload needs a real picker and is verified by hand.
 */

const FILE_NAME = 'notes-from-disk.md';
const ORIGINAL = '# From disk\n\nThe original contents.';

const INSTRUMENT = `
window.__fs = {
  written: [],
  lastModified: 1700000000000,
  contents: ${JSON.stringify(ORIGINAL)},
  permission: 'granted',
  permissionRequests: 0,
  pickerCalls: 0
};

window.__makeHandle = (name) => ({
  kind: 'file',
  name,
  async getFile() {
    return new File([window.__fs.contents], name, {
      type: 'text/markdown',
      lastModified: window.__fs.lastModified
    });
  },
  async createWritable() {
    let buffer = '';
    return {
      async write(chunk) { buffer += typeof chunk === 'string' ? chunk : ''; },
      async close() {
        window.__fs.written.push(buffer);
        window.__fs.contents = buffer;
        // A real write moves the timestamp; the app must record the new one or its own save
        // would look like somebody else's edit on the very next save.
        window.__fs.lastModified += 5000;
      }
    };
  },
  async queryPermission() { return window.__fs.permission; },
  async requestPermission() {
    window.__fs.permissionRequests += 1;
    window.__fs.permission = 'granted';
    return 'granted';
  }
});

window.__fsHandle = window.__makeHandle(${JSON.stringify(FILE_NAME)});
window.showOpenFilePicker = async () => {
  window.__fs.pickerCalls += 1;
  return [window.__fsHandle];
};

// The PDF path rasterises; counting canvases proves which action actually ran.
window.__pdfPages = [];
const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
HTMLCanvasElement.prototype.toDataURL = function (...args) {
  try { window.__pdfPages.push(this.width); } catch (e) {}
  return origToDataURL.apply(this, args);
};
`;

/** Runs a palette command by visible title; false when there is no such command. */
const runCommand = async (page, title) => {
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyK');
  await page.keyboard.up('Control');
  await page
    .waitForFunction(
      () => document.querySelectorAll('#palette .sheet__item').length > 0,
      { timeout: 10000 }
    )
    .catch(() => {});

  const clicked = await page.evaluate((needle) => {
    const item = [...document.querySelectorAll('#palette .sheet__item')].find((el) =>
      el.textContent.toLowerCase().includes(needle.toLowerCase())
    );
    if (!item) return false;
    item.click();
    return true;
  }, title);

  if (!clicked) {
    await page.keyboard.press('Escape');
  }
  await sleep(600);
  return clicked;
};

const commandTitles = async (page) => {
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyK');
  await page.keyboard.up('Control');
  await page
    .waitForFunction(
      () => document.querySelectorAll('#palette .sheet__item').length > 0,
      { timeout: 10000 }
    )
    .catch(() => {});
  const titles = await page.evaluate(() =>
    [...document.querySelectorAll('#palette .sheet__item')].map((el) => el.textContent.trim())
  );
  await page.keyboard.press('Escape');
  await sleep(300);
  return titles;
};

const docCount = (page) =>
  page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem('markbeam:docs') || 'null')?.v?.length ?? 0;
    } catch (error) {
      return 0;
    }
  });

const typeIntoEditor = async (page, text) => {
  await page.evaluate(() => document.querySelector('#editor')?.click());
  await page.keyboard.type(text, { delay: 4 });
  await sleep(600);
};

export const suite = {
  name: 'file system',
  async run() {
    const checks = [];

    // ---------- opening a file from disk, and saving back to it ----------

    await withPage(async (page, errors) => {
      await page.evaluateOnNewDocument(INSTRUMENT);
      await page.reload({ waitUntil: 'networkidle2' });
      await ready(page);

      const opened = await runCommand(page, 'Open a file from disk');

      const afterOpen = await page.evaluate(() => ({
        picker: window.__fs.pickerCalls,
        // `#doc-title` is an <input>, so the title is its value, not its text.
        title: document.querySelector('#doc-title')?.value?.trim() || null
      }));
      const textAfterOpen = await editorText(page);

      checks.push({
        name: 'the picker opens the chosen file into the editor',
        pass:
          opened === true &&
          afterOpen.picker === 1 &&
          textAfterOpen.includes('The original contents'),
        detail: opened
          ? `picker called ${afterOpen.picker}x, editor "${textAfterOpen.slice(0, 40)}"`
          : 'no "Open a file from disk" command'
      });

      checks.push({
        name: 'and titles the document from the file name, without the extension',
        // `titleFromFilename()` in src/openFile.js already owns this; the picker path must
        // reuse it rather than growing a second rule that drifts.
        pass: afterOpen.title === 'notes-from-disk',
        detail: `title ${JSON.stringify(afterOpen.title)}`
      });

      // ---------- Ctrl+S must still be the PDF, not the file ----------

      await page.evaluate(() => {
        window.__pdfPages = [];
        window.__fs.written = [];
      });
      await page.click('#editor');
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyS');
      await page.keyboard.up('Control');

      // The export takes a moment; wait for a rasterised page rather than a fixed delay.
      await page
        .waitForFunction(() => window.__pdfPages.length > 0, { timeout: 30000 })
        .catch(() => {});

      const afterShortcut = await page.evaluate(() => ({
        rasterised: window.__pdfPages.length,
        writes: window.__fs.written.length
      }));

      checks.push({
        name: 'Ctrl+S still exports a PDF and does not write the file',
        pass: afterShortcut.rasterised > 0 && afterShortcut.writes === 0,
        detail: `canvases=${afterShortcut.rasterised}, file writes=${afterShortcut.writes}` +
          ' — green before and after, a regression guard rather than evidence'
      });

      // ---------- saving writes the current text through to the handle ----------

      await typeIntoEditor(page, '\n\nEdited in the browser.');
      const saved = await runCommand(page, 'Save to file');
      await page
        .waitForFunction(() => window.__fs.written.length > 0, { timeout: 15000 })
        .catch(() => {});

      const afterSave = await page.evaluate(() => ({
        writes: window.__fs.written.length,
        last: window.__fs.written[window.__fs.written.length - 1] || ''
      }));

      checks.push({
        name: 'Save to file writes the edited text back to that file',
        pass:
          saved === true &&
          afterSave.writes === 1 &&
          afterSave.last.includes('Edited in the browser') &&
          afterSave.last.includes('The original contents'),
        detail: saved
          ? `${afterSave.writes} write(s), ${afterSave.last.length} chars`
          : 'no "Save to file" command'
      });

      /*
       * A write moves the file's own timestamp. If the app compares against the timestamp it
       * read at open, its *own* save looks like somebody else's edit and the very next save
       * refuses — the bug that makes this feature useless after one use.
       */
      await typeIntoEditor(page, '\n\nA second edit.');
      await runCommand(page, 'Save to file');
      await page
        .waitForFunction(() => window.__fs.written.length > 1, { timeout: 15000 })
        .catch(() => {});

      const afterSecond = await page.evaluate(() => window.__fs.written.length);
      checks.push({
        name: 'saving twice in a row works — our own write is not read as a conflict',
        pass: afterSecond === 2,
        detail: `${afterSecond} write(s) after two saves`
      });

      /*
       * The shortcut, pressed **with focus in the editor** — the only state where the bug
       * appears. Monaco stops propagation on any key it binds, so a global shortcut that
       * collides with one of its defaults never reaches the `document` listener in
       * `src/ui/palette.js`. `mod+shift+f` already needs registering in both places for exactly
       * this reason; whether `mod+shift+s` does is a measurement, not a guess, and this is it.
       */
      await page.evaluate(() => {
        window.__fs.written = [];
      });
      await typeIntoEditor(page, '\n\nSaved with the keyboard.');
      await page.click('#editor');
      await page.keyboard.down('Control');
      await page.keyboard.down('Shift');
      await page.keyboard.press('KeyS');
      await page.keyboard.up('Shift');
      await page.keyboard.up('Control');
      await page
        .waitForFunction(() => window.__fs.written.length > 0, { timeout: 15000 })
        .catch(() => {});

      const byShortcut = await page.evaluate(() => ({
        writes: window.__fs.written.length,
        last: window.__fs.written[window.__fs.written.length - 1] || ''
      }));

      checks.push({
        name: 'Ctrl+Shift+S saves from inside the editor, where Monaco could have swallowed it',
        pass: byShortcut.writes === 1 && byShortcut.last.includes('Saved with the keyboard'),
        detail: `${byShortcut.writes} write(s) from the shortcut`
      });

      checks.push({ name: 'no console errors', pass: errors.length === 0, detail: errors[0] });
    });

    // ---------- a file that moved on disk is never overwritten ----------

    await withPage(async (page, errors) => {
      await page.evaluateOnNewDocument(INSTRUMENT);
      await page.reload({ waitUntil: 'networkidle2' });
      await ready(page);

      await runCommand(page, 'Open a file from disk');
      const before = await docCount(page);

      // Somebody else edits the file while it is open here.
      await page.evaluate(() => {
        window.__fs.contents = '# From disk\n\nChanged by somebody else.';
        window.__fs.lastModified += 900000;
        window.__fs.written = [];
      });

      await typeIntoEditor(page, '\n\nMy own change.');
      await runCommand(page, 'Save to file');
      await sleep(1200);

      const after = await page.evaluate(() => ({
        writes: window.__fs.written.length,
        contents: window.__fs.contents
      }));
      const nowCount = await docCount(page);

      checks.push({
        name: 'a file changed on disk is not overwritten',
        // The whole point: their work survives. `src/autoSync.js` makes the same promise about
        // a repository, and a merge that is wrong once costs somebody a document.
        pass: after.writes === 0 && after.contents.includes('Changed by somebody else'),
        detail: `${after.writes} write(s); file still says ${JSON.stringify(after.contents.slice(0, 40))}`
      });

      checks.push({
        name: 'and the disk version is kept beside the open one rather than discarded',
        pass: nowCount === before + 1,
        detail: `${before} -> ${nowCount} documents`
      });

      checks.push({ name: 'no console errors', pass: errors.length === 0, detail: errors[0] });
    });

    // ---------- a browser without the API behaves exactly as it does today ----------

    await withPage(async (page, errors) => {
      await page.evaluateOnNewDocument(`
        delete window.showOpenFilePicker;
        Object.defineProperty(window, 'showOpenFilePicker', { value: undefined, configurable: true });
      `);
      await page.reload({ waitUntil: 'networkidle2' });
      await ready(page);

      const titles = await commandTitles(page);
      const offersDiskCommands = titles.some((t) =>
        /save to file|open a file from disk/i.test(t)
      );
      const keepsFallback = titles.some((t) => /open a markdown file/i.test(t));

      checks.push({
        name: 'without the API, nothing offers to save to disk',
        // The UI must not imply a capability the browser lacks — Safari and Firefox have no
        // showOpenFilePicker, and an offer that fails is worse than no offer.
        pass: offersDiskCommands === false,
        detail: offersDiskCommands ? `still offered: ${titles.join(' · ')}` : 'no disk commands'
      });

      checks.push({
        name: 'and the existing open-a-file path is untouched',
        pass: keepsFallback === true && !!(await page.$('#file-input')),
        detail: `fallback command present=${keepsFallback}`
      });

      checks.push({ name: 'no console errors', pass: errors.length === 0, detail: errors[0] });
    });

    return checks;
  }
};
