import { seedDocument, sleep, withPage, ready } from './lib.mjs';

/*
 * Deleted documents are recoverable (T45).
 *
 * `deleteDocument()` called `forgetHistory()`, so one confirm removed the document *and* every
 * autosaved version of it — the exact loss T22 exists to prevent, reached by another route,
 * and with nothing able to bring it back.
 *
 * Two checks carry the weight:
 *
 *   - **The history comes back too.** Restoring the text alone would look like a fix while
 *     still having destroyed the thing T22 built. The fixture seeds history before deleting,
 *     so this can fail.
 *   - **The trash cannot exhaust the quota.** A recovery feature that fills localStorage takes
 *     the live documents down with it, which is a worse bug than the one being fixed.
 */

const MAX_TRASH_BYTES = 256 * 1024;

const boot = async (page) => {
  await ready(page);
};

const openDocs = async (page) => {
  await page.click('#docs-button');
  await sleep(400);
};

const clickAction = (page, needle) =>
  page.evaluate((text) => {
    const item = [...document.querySelectorAll('#docs-actions .sheet__item')].find((el) =>
      el.textContent.includes(text)
    );
    if (!item) return false;
    item.click();
    return true;
  }, needle);

const docIds = (page) =>
  page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('markbeam:doc:')));

const trash = (page) =>
  page.evaluate(() => {
    try {
      const raw = localStorage.getItem('markbeam:trash');
      return raw ? JSON.parse(raw).v : null;
    } catch (error) {
      return null;
    }
  });

export const suite = {
  name: 'trash',
  async run() {
    return withPage(async (page, errors) => {
      const checks = [];

      await seedDocument(page, '# Keeper\n\nOriginal text.', 'Keeper');
      await page.reload({ waitUntil: 'networkidle2' });
      await boot(page);

      // Give the document a history, so "the history came back" can actually fail.
      const target = await page.evaluate(() => {
        const id = JSON.parse(localStorage.getItem('markbeam:active_doc') || 'null')?.v;
        const now = Date.now();
        localStorage.setItem(
          'markbeam:history:' + id,
          JSON.stringify({
            v: [
              { at: now - 60000, text: '# Keeper\n\nAn earlier version.' },
              { at: now - 120000, text: '# Keeper\n\nThe oldest version.' }
            ]
          })
        );
        return id;
      });

      await page.reload({ waitUntil: 'networkidle2' });
      await boot(page);

      // A second document, so deleting the first is not the "last document" path.
      await openDocs(page);
      await clickAction(page, 'New document');
      await sleep(700);

      await page.evaluate((id) => {
        localStorage.setItem('markbeam:active_doc', JSON.stringify({ v: id }));
      }, target);
      await page.reload({ waitUntil: 'networkidle2' });
      await boot(page);

      const before = { docs: (await docIds(page)).length };

      page.once('dialog', (dialog) => dialog.accept());
      await openDocs(page);
      const deleted = await clickAction(page, 'Delete current');
      await sleep(900);

      const afterDelete = {
        docs: (await docIds(page)).length,
        trash: await trash(page),
        toast: await page.evaluate(() =>
          [...document.querySelectorAll('#toasts .toast')].map((el) => el.textContent.trim()).join(' | ')
        ),
        undoButton: await page.evaluate(
          () => !!document.querySelector('#toasts .toast button, #toasts .toast [role="button"]')
        )
      };

      checks.push({
        name: 'the deleted document is kept, not destroyed',
        pass: deleted && Array.isArray(afterDelete.trash) && afterDelete.trash.length === 1,
        detail: deleted
          ? `${afterDelete.docs} live documents, trash ${afterDelete.trash ? afterDelete.trash.length : 'absent'}`
          : 'no Delete action'
      });

      /*
       * Discoverable *at the moment of deletion*. A recovery that only exists in a menu is one
       * nobody finds while they are still thinking about what they just did.
       */
      checks.push({
        name: 'the confirmation offers to undo it there and then',
        pass: afterDelete.undoButton && /undo/i.test(afterDelete.toast),
        detail: `toast "${afterDelete.toast}", action button=${afterDelete.undoButton}`
      });

      const undone = await page.evaluate(() => {
        const button = document.querySelector('#toasts .toast button');
        if (!button) return false;
        button.click();
        return true;
      });
      await sleep(1000);

      const afterUndo = await page.evaluate((id) => {
        const index = JSON.parse(localStorage.getItem('markbeam:docs') || 'null')?.v || [];
        const text = JSON.parse(localStorage.getItem('markbeam:doc:' + id) || 'null')?.v || null;
        const history = JSON.parse(localStorage.getItem('markbeam:history:' + id) || 'null')?.v || null;
        return {
          restored: index.some((doc) => doc.id === id),
          titles: index.map((doc) => doc.title),
          text,
          historyLength: Array.isArray(history) ? history.length : 0
        };
      }, target);

      checks.push({
        name: 'undo brings the document back with its text',
        pass: undone && afterUndo.restored && /Original text/.test(afterUndo.text || ''),
        detail: undone
          ? `restored=${afterUndo.restored}, titles ${JSON.stringify(afterUndo.titles)}`
          : 'no undo control to click'
      });

      /*
       * The check that matters most. Restoring the text while leaving the history destroyed
       * would look like a fix and still have thrown away what T22 was built for.
       */
      checks.push({
        name: 'undo brings its autosave history back too',
        pass: afterUndo.historyLength >= 2,
        detail: `${afterUndo.historyLength} snapshots restored`
      });

      // ---------- the trash must not become a quota problem ----------

      const swept = await page.evaluate(
        ({ budget }) => {
          // Seed a trash far over budget, then provoke a write by deleting again.
          const bulk = 'x'.repeat(50 * 1024);
          const entries = Array.from({ length: 12 }, (_, i) => ({
            id: `gone-${i}`,
            title: `Gone ${i}`,
            text: bulk,
            history: [],
            deletedAt: Date.now() - i * 1000
          }));
          localStorage.setItem('markbeam:trash', JSON.stringify({ v: entries }));
          return { seeded: entries.length, budget };
        },
        { budget: MAX_TRASH_BYTES }
      );

      page.once('dialog', (dialog) => dialog.accept());
      await openDocs(page);
      await clickAction(page, 'Delete current');
      await sleep(1200);

      const bytes = await page.evaluate(() => {
        const raw = localStorage.getItem('markbeam:trash') || '';
        return { bytes: raw.length, entries: (JSON.parse(raw || '{"v":[]}').v || []).length };
      });

      checks.push({
        name: 'the trash is swept against a byte budget rather than growing without limit',
        pass: bytes.bytes <= MAX_TRASH_BYTES,
        detail: `seeded ${swept.seeded} oversized entries, now ${Math.round(bytes.bytes / 1024)} KB in ${bytes.entries} entries, budget ${MAX_TRASH_BYTES / 1024} KB`
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
