import { withPage, sleep, editorText } from './lib.mjs';

/*
 * Multiple documents (T9).
 *
 * The app used to hold exactly one document in one key. These checks cover the four verbs
 * — create, rename, switch, delete — plus the migration that matters most: the single
 * document a returning user already has must become document #1 rather than being orphaned
 * by the new schema.
 *
 * The trap in this suite is check 7. Seeding `markbeam:last_state` and reloading shows that
 * content *today*, because that is how every other suite seeds a document, so asserting
 * "the text is on screen" would pass against the unfixed code and prove nothing. It has to
 * assert the content became addressable — an index exists, holds exactly one entry, and
 * that entry carries the old title.
 */

const DOCS_KEY = 'markbeam:docs';
const ACTIVE_KEY = 'markbeam:active_doc';

const reload = async (page) => {
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForFunction(() => !!document.querySelector('#editor .monaco-editor'), {
    timeout: 30000
  });
  await sleep(1500);
};

/** Wipes every markbeam key, so each phase starts from a known profile. */
const resetStorage = async (page) => {
  await page.evaluate(() => {
    Object.keys(localStorage)
      .filter((k) => k.startsWith('markbeam:') || k.startsWith('com.markdownlivepreview'))
      .forEach((k) => localStorage.removeItem(k));
  });
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

const activeId = (page) =>
  page.evaluate((key) => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw).v : null;
    } catch (error) {
      return null;
    }
  }, ACTIVE_KEY);

const docKeys = (page) =>
  page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('markbeam:doc:')));

const titleValue = (page) => page.$eval('#doc-title', (el) => el.value);

/** Opens the document sheet from the toolbar. Returns false when there is no way in. */
const openDocs = async (page) => {
  const trigger = await page.$('#docs-button');
  if (!trigger) {
    return false;
  }
  await trigger.click();
  await sleep(400);
  return page.evaluate(() => {
    const sheet = document.querySelector('#docs');
    return !!sheet && sheet.open;
  });
};

const closeDocs = async (page) => {
  await page.keyboard.press('Escape');
  await sleep(300);
};

const sheetEntries = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('#docs-list .sheet__item')].map((el) =>
      el.textContent.replace(/\s+/g, ' ').trim()
    )
  );

/** Clicks an action or a document by its visible text. */
const clickInSheet = async (page, needle) =>
  page.evaluate((text) => {
    const item = [...document.querySelectorAll('#docs .sheet__item')].find((el) =>
      el.textContent.includes(text)
    );
    if (!item) {
      return false;
    }
    item.click();
    return true;
  }, needle);

const setEditorValue = async (page, value) => {
  await page.click('#editor');
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await page.keyboard.type(value);
  await sleep(700);
};

/*
 * window.confirm and window.prompt block automation, so answer them explicitly.
 *
 * The timeout is load-bearing rather than defensive: against the unfixed code the action
 * being clicked does not exist, so no dialog ever fires. Without it the suite hangs
 * forever instead of reporting a failure, which is exactly what happened on the first
 * baseline run.
 */
const answerDialog = (page, response, timeoutMs = 4000) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => {
      page.off('dialog', handler);
      resolve(null);
    }, timeoutMs);

    async function handler(dialog) {
      clearTimeout(timer);
      const message = dialog.message();
      if (response === false) {
        await dialog.dismiss();
      } else {
        await dialog.accept(typeof response === 'string' ? response : undefined);
      }
      resolve(message);
    }

    page.once('dialog', handler);
  });

export const suite = {
  name: 'documents',
  async run() {
    return withPage(async (page, errors) => {
      const checks = [];

      // ---------- migration, on a profile holding only the old single-document keys ----------
      await resetStorage(page);
      await page.evaluate(() => {
        localStorage.setItem('markbeam:last_state', JSON.stringify({ v: '# Legacy note\n\nkeep me' }));
        localStorage.setItem('markbeam:doc_title', JSON.stringify({ v: 'Legacy note' }));
      });
      await reload(page);

      const migratedIndex = await readIndex(page);
      const migratedText = await editorText(page);
      checks.push({
        name: 'a pre-existing single document is adopted as document #1',
        pass:
          Array.isArray(migratedIndex) &&
          migratedIndex.length === 1 &&
          migratedIndex[0].title === 'Legacy note' &&
          migratedText.includes('Legacy note'),
        detail: migratedIndex
          ? `index ${JSON.stringify(migratedIndex.map((d) => d.title))}, editor "${migratedText.slice(0, 24)}"`
          : 'no document index exists'
      });

      // ---------- the menu ----------
      const opened = await openDocs(page);
      checks.push({
        name: 'a document menu opens from the toolbar, without the palette',
        pass: opened,
        detail: opened ? 'sheet open' : 'no #docs-button, or it opened nothing'
      });
      if (opened) {
        await closeDocs(page);
      }

      // ---------- create ----------
      await openDocs(page);
      const created = await clickInSheet(page, 'New document');
      await sleep(800);

      const afterCreateTitle = await titleValue(page);
      const afterCreateText = await editorText(page);
      const indexAfterCreate = await readIndex(page);
      checks.push({
        name: 'creating a document switches to it and leaves the previous one intact',
        pass:
          created &&
          Array.isArray(indexAfterCreate) &&
          indexAfterCreate.length === 2 &&
          !afterCreateText.includes('keep me'),
        detail: created
          ? `${(indexAfterCreate || []).length} documents, now on "${afterCreateTitle}", editor "${afterCreateText.slice(0, 20)}"`
          : 'no New document action'
      });

      await setEditorValue(page, '# Second document');

      // switching back must restore the first document's text
      await openDocs(page);
      await clickInSheet(page, 'Legacy note');
      await sleep(800);
      const backText = await editorText(page);
      checks.push({
        name: 'switching back restores the other document, unchanged',
        pass: backText.includes('keep me') && !backText.includes('Second document'),
        detail: `editor "${backText.slice(0, 32)}"`
      });

      // ---------- each document in its own key ----------
      const keys = await docKeys(page);
      checks.push({
        name: 'each document is stored under its own key',
        pass: keys.length === 2,
        detail: `${keys.length} markbeam:doc:* keys`
      });

      // ---------- rename ----------
      await openDocs(page);
      const renamePrompt = answerDialog(page, 'Renamed note');
      await clickInSheet(page, 'Rename');
      await renamePrompt;
      await sleep(800);

      const renamedTitle = await titleValue(page);
      const renamedIndex = await readIndex(page);
      checks.push({
        name: 'renaming updates the title and the entry in the list',
        pass:
          renamedTitle === 'Renamed note' &&
          (renamedIndex || []).some((d) => d.title === 'Renamed note'),
        detail: `title "${renamedTitle}", index ${JSON.stringify((renamedIndex || []).map((d) => d.title))}`
      });

      // ---------- reload keeps the active document ----------
      const idBeforeReload = await activeId(page);
      await reload(page);
      const idAfterReload = await activeId(page);
      const textAfterReload = await editorText(page);
      checks.push({
        name: 'the active document survives a reload',
        pass: !!idBeforeReload && idBeforeReload === idAfterReload && textAfterReload.includes('keep me'),
        detail: `${idBeforeReload} -> ${idAfterReload}, editor "${textAfterReload.slice(0, 24)}"`
      });

      // ---------- delete ----------
      await openDocs(page);
      const deleteConfirm = answerDialog(page, true);
      await clickInSheet(page, 'Delete');
      await deleteConfirm;
      await sleep(900);

      const afterDeleteIndex = await readIndex(page);
      checks.push({
        name: 'deleting removes it and falls back to another document',
        pass: Array.isArray(afterDeleteIndex) && afterDeleteIndex.length === 1,
        detail: `${(afterDeleteIndex || []).length} left: ${JSON.stringify((afterDeleteIndex || []).map((d) => d.title))}`
      });

      // ---------- deleting the last one leaves an empty Untitled, never zero ----------
      await openDocs(page);
      const lastConfirm = answerDialog(page, true);
      await clickInSheet(page, 'Delete');
      await lastConfirm;
      await sleep(900);

      const finalIndex = await readIndex(page);
      const finalTitle = await titleValue(page);
      const finalText = await editorText(page);
      checks.push({
        name: 'deleting the last document leaves one empty Untitled, never zero',
        pass:
          Array.isArray(finalIndex) &&
          finalIndex.length === 1 &&
          finalTitle === 'Untitled' &&
          finalText === '',
        detail: `${(finalIndex || []).length} documents, title "${finalTitle}", editor "${finalText.slice(0, 20)}"`
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
