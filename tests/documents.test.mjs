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

      // ---------- folders (T41) ----------

      /*
       * The index gains one optional field, `folder`. Nothing rewrites existing entries, so
       * the migration cannot orphan a document — but "cannot" is a claim, and the checks below
       * are what turn it into evidence.
       *
       * Seeded straight into storage rather than driven through the UI: the point is what
       * happens to an index written by an *older build*, which the UI cannot produce.
       */
      await resetStorage(page);
      await page.evaluate(() => {
        const docs = [
          { id: 'd-root-1', title: 'Loose note', updatedAt: Date.now() },
          { id: 'd-work-1', title: 'Roadmap', updatedAt: Date.now(), folder: 'Work' },
          { id: 'd-work-2', title: 'Postmortem', updatedAt: Date.now(), folder: 'Work' },
          { id: 'd-home-1', title: 'Recipes', updatedAt: Date.now(), folder: 'Personal' }
        ];
        localStorage.setItem('markbeam:docs', JSON.stringify({ v: docs }));
        localStorage.setItem('markbeam:active_doc', JSON.stringify({ v: 'd-root-1' }));
        docs.forEach((doc) => {
          localStorage.setItem('markbeam:doc:' + doc.id, JSON.stringify({ v: '# ' + doc.title }));
        });
      });
      await reload(page);
      await openDocs(page);

      const grouped = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('#docs-list li')];
        return {
          headings: rows
            .filter((r) => r.querySelector('[data-folder]'))
            .map((r) => r.querySelector('[data-folder]').dataset.folder),
          documentTitles: [...document.querySelectorAll('#docs-list [data-doc-id]')].map((el) =>
            el.querySelector('.sheet__label')?.textContent.trim()
          )
        };
      });

      checks.push({
        name: 'documents with a folder are grouped under it, and the rest stay at the root',
        pass:
          grouped.headings.includes('Work') &&
          grouped.headings.includes('Personal') &&
          grouped.documentTitles.length === 4,
        detail: `headings ${JSON.stringify(grouped.headings)}, ${grouped.documentTitles.length} documents: ${JSON.stringify(grouped.documentTitles)}`
      });

      const counts = await page.evaluate(() =>
        [...document.querySelectorAll('#docs-list [data-folder]')].map((el) => ({
          name: el.dataset.folder,
          hint: el.querySelector('.sheet__hint')?.textContent.trim()
        }))
      );
      checks.push({
        name: 'a folder heading says how many documents it holds',
        pass: counts.some((c) => c.name === 'Work' && /2/.test(c.hint || '')),
        detail: JSON.stringify(counts)
      });

      // Collapse "Work" and confirm its documents leave the list.
      await page.evaluate(() => {
        document.querySelector('#docs-list [data-folder="Work"]')?.click();
      });
      await sleep(400);
      const collapsed = await page.evaluate(() =>
        [...document.querySelectorAll('#docs-list [data-doc-id]')].map((el) =>
          el.querySelector('.sheet__label')?.textContent.trim()
        )
      );
      checks.push({
        name: 'collapsing a folder hides its documents',
        pass: !collapsed.includes('Roadmap') && collapsed.includes('Recipes'),
        detail: JSON.stringify(collapsed)
      });

      await closeDocs(page);
      await reload(page);
      await openDocs(page);
      const afterReload = await page.evaluate(() =>
        [...document.querySelectorAll('#docs-list [data-doc-id]')].map((el) =>
          el.querySelector('.sheet__label')?.textContent.trim()
        )
      );
      checks.push({
        name: 'the collapsed state survives a reload',
        pass: !afterReload.includes('Roadmap'),
        detail: JSON.stringify(afterReload)
      });

      /*
       * The active document must never be hidden. With "Work" collapsed and Roadmap open, the
       * sheet has to expand that folder — otherwise there is no "current" row and the sheet
       * looks broken.
       */
      await closeDocs(page);
      await page.evaluate(() => {
        localStorage.setItem('markbeam:active_doc', JSON.stringify({ v: 'd-work-1' }));
      });
      await reload(page);
      await openDocs(page);
      const withActive = await page.evaluate(() => ({
        titles: [...document.querySelectorAll('#docs-list [data-doc-id]')].map((el) =>
          el.querySelector('.sheet__label')?.textContent.trim()
        ),
        current: [...document.querySelectorAll('#docs-list [data-doc-id]')]
          .filter((el) => el.getAttribute('aria-current') === 'true')
          .map((el) => el.querySelector('.sheet__label')?.textContent.trim()),
        headings: [...document.querySelectorAll('#docs-list [data-folder]')].map(
          (el) => el.dataset.folder
        ),
        collapsedInStorage: (() => {
          try {
            return JSON.parse(localStorage.getItem('markbeam:folders_collapsed') || 'null')?.v || [];
          } catch (error) {
            return [];
          }
        })()
      }));
      checks.push({
        /*
         * Gated on the folder existing *and* on Work still being recorded as collapsed. Without
         * both, this passes on a build with no folders at all — every document is visible when
         * nothing can be hidden, which proves nothing about the case it is named for.
         */
        name: 'the folder holding the open document is expanded, collapsed or not',
        pass:
          withActive.headings.includes('Work') &&
          withActive.collapsedInStorage.includes('Work') &&
          withActive.titles.includes('Roadmap') &&
          withActive.current.includes('Roadmap'),
        detail: withActive.headings.includes('Work')
          ? `collapsed ${JSON.stringify(withActive.collapsedInStorage)}, visible ${JSON.stringify(withActive.titles)}, current ${JSON.stringify(withActive.current)}`
          : 'no folder headings exist, so nothing could have been collapsed'
      });

      // ---------- moving between folders ----------

      const movePrompt = answerDialog(page, 'Personal');
      const moved = await clickInSheet(page, 'Move to folder');
      const promptText = await movePrompt;
      await sleep(700);
      await openDocs(page);

      const afterMove = await page.evaluate(() => {
        const headings = [...document.querySelectorAll('#docs-list [data-folder]')].map(
          (el) => el.dataset.folder
        );
        const stored = JSON.parse(localStorage.getItem('markbeam:docs') || 'null')?.v || [];
        return { headings, folders: stored.map((d) => `${d.title}:${d.folder || 'root'}`) };
      });

      checks.push({
        name: 'Move to folder puts the open document in that folder',
        pass: moved && afterMove.folders.includes('Roadmap:Personal'),
        detail: moved
          ? `asked "${(promptText || '').slice(0, 60)}", now ${JSON.stringify(afterMove.folders)}`
          : 'no Move to folder action'
      });

      /*
       * Work held two documents; one has just left. Moving the other out must make the folder
       * disappear entirely — folders exist only because a document names one, which is what
       * keeps this from needing folder deletion as a feature.
       */
      await closeDocs(page);
      await page.evaluate(() => {
        localStorage.setItem('markbeam:active_doc', JSON.stringify({ v: 'd-work-2' }));
      });
      await reload(page);
      const emptyPrompt = answerDialog(page, '');
      await openDocs(page);
      await clickInSheet(page, 'Move to folder');
      await emptyPrompt;
      await sleep(700);
      await openDocs(page);

      const afterEmptying = await page.evaluate(() =>
        [...document.querySelectorAll('#docs-list [data-folder]')].map((el) => el.dataset.folder)
      );
      checks.push({
        name: 'a folder disappears once its last document leaves',
        pass: !afterEmptying.includes('Work') && afterEmptying.includes('Personal'),
        detail: `headings now ${JSON.stringify(afterEmptying)}`
      });

      /*
       * Guard, not evidence — green before this task and after. An index written by an older
       * build has no `folder` anywhere; nothing rewrites it, so nothing can be lost. Recorded
       * because the Done-when calls the migration the part that matters, and a claim with no
       * check behind it is just a claim.
       */
      await closeDocs(page);
      await resetStorage(page);
      await page.evaluate(() => {
        const docs = [
          { id: 'old-1', title: 'First', updatedAt: Date.now() },
          { id: 'old-2', title: 'Second', updatedAt: Date.now() },
          { id: 'old-3', title: 'Third', updatedAt: Date.now() }
        ];
        localStorage.setItem('markbeam:docs', JSON.stringify({ v: docs }));
        localStorage.setItem('markbeam:active_doc', JSON.stringify({ v: 'old-2' }));
        docs.forEach((doc) => {
          localStorage.setItem('markbeam:doc:' + doc.id, JSON.stringify({ v: '# ' + doc.title }));
        });
      });
      await reload(page);
      await openDocs(page);
      const legacy = await page.evaluate(() => ({
        titles: [...document.querySelectorAll('#docs-list .sheet__item')]
          .filter((el) => !el.dataset.folder)
          .map((el) => el.querySelector('.sheet__label')?.textContent.trim())
          .filter(Boolean),
        stored: (JSON.parse(localStorage.getItem('markbeam:docs') || 'null')?.v || []).length
      }));
      await closeDocs(page);

      checks.push({
        name: 'guard: an index written before folders existed still lists every document',
        pass: legacy.stored === 3 && ['First', 'Second', 'Third'].every((t) => legacy.titles.includes(t)),
        detail: `${legacy.stored} stored, listed ${JSON.stringify(legacy.titles)} — green before and after, a regression guard rather than evidence`
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
