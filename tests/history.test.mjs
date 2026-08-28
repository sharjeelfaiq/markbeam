import { withPage, sleep, editorText, seedDocument } from './lib.mjs';

/*
 * Autosave history (T22).
 *
 * Every keystroke overwrites `markbeam:doc:<id>`, so before this feature the previous text
 * was simply gone — no undo survived a reload, and Clear / Reset were one confirm away from
 * destroying a document permanently.
 *
 * Two checks here are the ones that matter, and both are easy to get wrong:
 *
 *   - Check 5 covers a pending snapshot outliving its document. The snapshot timer is
 *     debounced, and `openDocument()` calls `setValue()`, which fires Monaco's change event.
 *     A timer started while A was open, firing after a switch to B, writes A's text into B's
 *     history. That is silent data corruption rather than a visible failure, and nothing
 *     else in the suite would notice it.
 *   - Checks 6-8 cover growth. History that is merely "kept" fills the origin's quota and
 *     takes the documents down with it, so a cap that is never exercised is not a cap.
 *
 * The retention checks seed entries directly and assert the trim on the next write. Driving
 * thirty real snapshots would add ten minutes to the suite and prove nothing extra.
 */

const IDLE_MS = 20000;
const MAX_ENTRIES = 20;
const BUDGET_BYTES = 512 * 1024;

const historyKey = (id) => `markbeam:history:${id}`;

const reload = async (page) => {
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForFunction(() => !!document.querySelector('#editor .monaco-editor'), {
    timeout: 30000
  });
  await sleep(1500);
};

const activeId = (page) =>
  page.evaluate(() => {
    try {
      const raw = localStorage.getItem('markbeam:active_doc');
      return raw ? JSON.parse(raw).v : null;
    } catch (error) {
      return null;
    }
  });

/** Every history entry for one document, newest-first, or null when the key is absent. */
const historyFor = (page, id) =>
  page.evaluate((key) => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw).v : null;
    } catch (error) {
      return null;
    }
  }, historyKey(id));

const historyKeys = (page) =>
  page.evaluate(() =>
    Object.keys(localStorage).filter((k) => k.startsWith('markbeam:history:'))
  );

const historyBytes = (page) =>
  page.evaluate(() =>
    Object.keys(localStorage)
      .filter((k) => k.startsWith('markbeam:history:'))
      .reduce((total, k) => total + k.length + (localStorage.getItem(k) || '').length, 0)
  );

const seedHistory = (page, id, entries) =>
  page.evaluate(
    ({ key, value }) => localStorage.setItem(key, JSON.stringify({ v: value })),
    { key: historyKey(id), value: entries }
  );

const typeInto = async (page, value) => {
  await page.click('#editor');
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await page.keyboard.type(value);
  await sleep(600);
};

/** Runs a palette command by its visible title. False when the command does not exist. */
const runCommand = async (page, title) => {
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyK');
  await page.keyboard.up('Control');
  await sleep(400);

  const clicked = await page.evaluate((needle) => {
    const item = [...document.querySelectorAll('#palette .sheet__item')].find((el) =>
      el.textContent.includes(needle)
    );
    if (!item) {
      return false;
    }
    item.click();
    return true;
  }, title);

  if (!clicked) {
    await page.keyboard.press('Escape');
  }
  await sleep(500);
  return clicked;
};

const historySheetRows = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('#history .sheet__item')].map((el) =>
      el.textContent.replace(/\s+/g, ' ').trim()
    )
  );

export const suite = {
  name: 'history',
  async run() {
    return withPage(async (page, errors) => {
      const checks = [];

      // ---------- cadence ----------

      await seedDocument(page, '# History fixture\n\nFirst version of the text.', 'History');
      await reload(page);

      const docId = await activeId(page);
      await typeInto(page, '# History fixture\n\nSecond version of the text.');

      const beforeIdle = await historyFor(page, docId);
      /*
       * One real wait past the idle window. A test-only override would mean shipping a hook
       * into production purely to make this faster, and the thing being measured *is* the
       * delay.
       */
      await sleep(IDLE_MS + 2500);
      const afterIdle = await historyFor(page, docId);

      checks.push({
        name: 'typing then going idle records exactly one snapshot',
        pass: Array.isArray(afterIdle) && afterIdle.length === 1,
        detail: `before ${beforeIdle === null ? 'no key' : `${beforeIdle.length} entries`}, after ${
          afterIdle === null ? 'no key' : `${afterIdle.length} entries`
        }`
      });

      checks.push({
        name: 'the snapshot holds the text as it was, not a placeholder',
        pass: Array.isArray(afterIdle) && /Second version/.test(afterIdle[0]?.text || ''),
        detail: Array.isArray(afterIdle)
          ? JSON.stringify((afterIdle[0]?.text || '').slice(0, 40))
          : 'no history'
      });

      // Idling again without touching the document must not stack up duplicates.
      await sleep(IDLE_MS + 2500);
      const afterSecondIdle = await historyFor(page, docId);
      checks.push({
        name: 'an idle tab with unchanged text records nothing further',
        pass: Array.isArray(afterSecondIdle) && afterSecondIdle.length === 1,
        detail: `${afterSecondIdle === null ? 'no key' : afterSecondIdle.length} entries after a second idle window`
      });

      // ---------- restore ----------

      const opened = await runCommand(page, 'Document history');
      const rows = opened ? await historySheetRows(page) : [];
      checks.push({
        name: 'a Document history command opens a sheet listing the snapshots',
        pass: opened && rows.length > 0,
        detail: opened ? `rows: ${JSON.stringify(rows)}` : 'no such palette command'
      });

      let restored = false;
      if (opened) {
        restored = await page.evaluate(() => {
          const item = [...document.querySelectorAll('#history .sheet__item')].find(
            (el) => !/current/i.test(el.textContent)
          );
          if (!item) {
            return false;
          }
          item.click();
          return true;
        });
        await sleep(900);
      }

      const editorAfterRestore = await editorText(page);
      checks.push({
        name: 'restoring an earlier snapshot puts that text back in the editor',
        pass: restored && /Second version/.test(editorAfterRestore),
        detail: restored ? JSON.stringify(editorAfterRestore.slice(0, 60)) : 'nothing to restore'
      });

      const previewAfterRestore = await page.evaluate(
        () => document.querySelector('#output')?.textContent.replace(/\s+/g, ' ').trim() || ''
      );
      checks.push({
        name: 'the preview follows the restore, not just the editor',
        // Gated on a restore having actually happened: the editor already held this text,
        // so without the gate this passes against code that has no history at all.
        pass: restored && /Second version/.test(previewAfterRestore),
        detail: restored
          ? JSON.stringify(previewAfterRestore.slice(0, 60))
          : 'nothing was restored'
      });

      // ---------- a pending snapshot must not cross documents ----------

      /*
       * Type in A, then switch to B before the idle window elapses. If the debounced timer
       * is not tied to the document that scheduled it, A's text lands in B's history — and
       * nothing on screen would ever show it.
       */
      await typeInto(page, '# Document A\n\nUnmistakable alpha content.');
      await page.click('#docs-button');
      await sleep(400);
      await page.evaluate(() => {
        const item = [...document.querySelectorAll('#docs-actions .sheet__item')].find((el) =>
          /New document/.test(el.textContent)
        );
        item?.click();
      });
      await sleep(600);

      const otherId = await activeId(page);
      await sleep(IDLE_MS + 2500);
      const otherHistory = await historyFor(page, otherId);
      const originHistory = await historyFor(page, docId);
      const leaked = (otherHistory || []).some((entry) => /Unmistakable alpha/.test(entry.text));
      /*
       * "B has no history" is not evidence — with the feature absent, nothing has a history
       * and this passes for the wrong reason. The snapshot must be shown to have landed
       * somewhere, and that somewhere must be A.
       */
      const landedInOrigin = (originHistory || []).some((entry) =>
        /Unmistakable alpha/.test(entry.text)
      );

      checks.push({
        name: "a pending snapshot lands in its own document's history, never another's",
        pass: otherId !== docId && landedInOrigin && !leaked,
        detail: `origin ${
          originHistory === null ? 'no history' : `${originHistory.length} entries`
        }, kept alpha=${landedInOrigin}; other ${
          otherHistory === null ? 'no history' : `${otherHistory.length} entries`
        }, leaked=${leaked}`
      });

      // ---------- retention ----------

      const now = Date.now();
      const many = Array.from({ length: 30 }, (_, i) => ({
        at: now - i * 60000,
        text: `# Seeded ${i}\n\nBody ${i}.`
      }));
      await seedHistory(page, docId, many);

      // Provoke one real write so the trim runs.
      await page.evaluate((id) => {
        try {
          localStorage.setItem('markbeam:active_doc', JSON.stringify({ v: id }));
        } catch (error) {
          /* ignore */
        }
      }, docId);
      await reload(page);
      await typeInto(page, '# History fixture\n\nA change that forces a trim.');
      await sleep(IDLE_MS + 2500);

      const trimmed = await historyFor(page, docId);
      checks.push({
        name: 'history is capped rather than growing without limit',
        pass: Array.isArray(trimmed) && trimmed.length <= MAX_ENTRIES,
        detail: `${trimmed === null ? 'no key' : trimmed.length} entries, cap ${MAX_ENTRIES}`
      });

      checks.push({
        name: 'the newest snapshot survives the trim',
        pass: Array.isArray(trimmed) && /forces a trim/.test(trimmed[0]?.text || ''),
        detail: Array.isArray(trimmed)
          ? JSON.stringify((trimmed[0]?.text || '').slice(0, 40))
          : 'no history'
      });

      /*
       * Thinning, not just capping. Twenty entries one minute apart cover twenty minutes;
       * the point of thinning is that they reach back days instead. Seeded across a week,
       * something older than a day must survive.
       */
      const day = 86400000;
      const spread = [
        ...Array.from({ length: 12 }, (_, i) => ({ at: now - i * 60000, text: `recent ${i}` })),
        ...Array.from({ length: 8 }, (_, i) => ({ at: now - (i + 1) * day, text: `old ${i}` }))
      ];
      await seedHistory(page, docId, spread);
      await reload(page);
      await typeInto(page, '# History fixture\n\nAnother change, to thin the seeded set.');
      await sleep(IDLE_MS + 2500);

      const thinned = await historyFor(page, docId);
      const reachesBack = (thinned || []).some((entry) => now - entry.at > day);
      /*
       * Reading the seed straight back also "reaches back", so the write has to be shown to
       * have happened at all — the newest entry must be the text just typed.
       */
      const wasRewritten = /thin the seeded set/.test(thinned?.[0]?.text || '');
      checks.push({
        name: 'thinning keeps entries older than a day rather than only the last few minutes',
        pass: wasRewritten && reachesBack && thinned.length <= MAX_ENTRIES,
        detail: Array.isArray(thinned)
          ? `${thinned.length} entries, rewritten=${wasRewritten}, oldest ${Math.round((now - thinned[thinned.length - 1].at) / 3600000)}h back`
          : 'no history'
      });

      // ---------- quota ----------

      const bulk = '# Large\n\n' + 'Lorem ipsum dolor sit amet. '.repeat(3000);
      await seedHistory(
        page,
        docId,
        Array.from({ length: 20 }, (_, i) => ({ at: now - i * 60000, text: `${bulk}${i}` }))
      );
      await reload(page);
      await typeInto(page, '# History fixture\n\nOne more change against a full history.');
      await sleep(IDLE_MS + 2500);

      const bytes = await historyBytes(page);
      checks.push({
        name: 'history stays inside its byte budget instead of consuming the quota',
        pass: bytes <= BUDGET_BYTES,
        detail: `${Math.round(bytes / 1024)} KB used, budget ${BUDGET_BYTES / 1024} KB`
      });

      // ---------- lifecycle ----------

      const keysBeforeDelete = await historyKeys(page);
      await page.click('#docs-button');
      await sleep(400);
      page.once('dialog', (dialog) => dialog.accept());
      await page.evaluate(() => {
        const item = [...document.querySelectorAll('#docs-actions .sheet__item')].find((el) =>
          /Delete current/.test(el.textContent)
        );
        item?.click();
      });
      await sleep(900);

      const keysAfterDelete = await historyKeys(page);
      checks.push({
        name: 'deleting a document deletes its history with it',
        pass: !keysAfterDelete.includes(historyKey(docId)) && keysBeforeDelete.length > 0,
        detail: `${keysBeforeDelete.length} -> ${keysAfterDelete.length} history keys`
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
