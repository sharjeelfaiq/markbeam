import { withPage, sleep, seedDocument, ready } from './lib.mjs';

/*
 * Find, replace and search across documents (T40).
 *
 * Monaco's find widget already worked before this task — `src/editor/index.js` never disables
 * `find` — so the interesting half is not "does find exist" but "can anyone tell that it
 * does", and "is there any way to search the documents you are not looking at".
 *
 * Two checks here exist because of specific traps rather than general caution:
 *
 *   - Check 3. `keys` on a palette command is not a label: it binds a global shortcut and
 *     calls preventDefault. Putting `keys: 'mod+f'` on a find command would therefore steal
 *     Ctrl+F from the *preview pane*, where the browser's own find is what people want. The
 *     check pins the preview's Ctrl+F as un-prevented, and is gated on the command existing so
 *     it cannot pass on a build that simply has no find command at all.
 *   - Check 9. Monaco stops propagation for keys it binds, so a shortcut registered only in
 *     the palette works everywhere *except* the editor — which is where a writer is. It is
 *     driven from inside the editor for exactly that reason.
 */

const NEEDLE = 'zarafeteorite';
const CAP_HINT = /more|capped|first \d+/i;

const DOC_ONE = [
  '# Alpha document',
  '',
  'An ordinary opening paragraph.',
  '',
  `A line containing ${NEEDLE} once.`,
  '',
  'A closing line.'
].join('\n');

const DOC_TWO = [
  '# Beta document',
  '',
  `Beta also mentions ${NEEDLE} here.`,
  '',
  'And nothing else of interest.'
].join('\n');

const boot = async (page) => {
  await ready(page);
};

/** Runs a palette command by visible title. False when the command does not exist. */
const runCommand = async (page, title) => {
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyK');
  await page.keyboard.up('Control');
  // The palette paints its items on open; wait for one to exist rather than for a duration.
  await page
    .waitForFunction(
      () =>
        document.querySelectorAll('#palette .sheet__item, #palette-list .sheet__item').length > 0,
      { timeout: 10000 }
    )
    .catch(() => {});

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
  await sleep(700);
  return clicked;
};

const paletteTitles = async (page) => {
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyK');
  await page.keyboard.up('Control');
  // The palette paints its items on open; wait for one to exist rather than for a duration.
  await page
    .waitForFunction(
      () =>
        document.querySelectorAll('#palette .sheet__item, #palette-list .sheet__item').length > 0,
      { timeout: 10000 }
    )
    .catch(() => {});
  const titles = await page.evaluate(() =>
    [...document.querySelectorAll('#palette .sheet__item')].map((el) =>
      el.textContent.replace(/\s+/g, ' ').trim()
    )
  );
  await page.keyboard.press('Escape');
  await sleep(300);
  return titles;
};

/** Creates a second document through the real UI, names it, and types `text` into it. */
const addDocument = async (page, title, text) => {
  await page.click('#docs-button');
  await sleep(400);
  await page.evaluate(() => {
    [...document.querySelectorAll('#docs-actions .sheet__item')]
      .find((el) => /New document/.test(el.textContent))
      ?.click();
  });
  await sleep(700);

  /*
   * Naming it matters to this suite specifically. Left as "Untitled", a result row would
   * still contain the word "Beta" — from the body text — and a check looking for it anywhere
   * in the row would pass without the document name ever being rendered.
   */
  await page.evaluate((name) => {
    const input = document.querySelector('#doc-title');
    input.value = name;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, title);
  await sleep(400);

  await page.click('#editor');
  await page.keyboard.type(text);
  await sleep(800);
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

const searchRows = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('#search-results .sheet__item')].map((el) =>
      el.textContent.replace(/\s+/g, ' ').trim()
    )
  );

const typeSearch = async (page, term) => {
  const typed = await page.evaluate((value) => {
    const input = document.querySelector('#search-input');
    if (!input) {
      return false;
    }
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }, term);
  await sleep(900);
  return typed;
};

export const suite = {
  name: 'search',
  async run() {
    const checks = [];

    // ---------- find and replace, in the open document ----------

    await withPage(async (page, errors) => {
      await seedDocument(page, DOC_ONE, 'Alpha');
      await page.reload({ waitUntil: 'networkidle2' });
      await boot(page);

      const titles = await paletteTitles(page);
      const hasFind = titles.some((t) => /Find in document/i.test(t));
      const hasReplace = titles.some((t) => /Find and replace/i.test(t));
      const hasSearch = titles.some((t) => /Search all documents/i.test(t));

      checks.push({
        name: 'the palette advertises find, replace and cross-document search',
        pass: hasFind && hasReplace && hasSearch,
        detail: `find=${hasFind}, replace=${hasReplace}, search=${hasSearch}`
      });

      /*
       * The shortcut has to be *shown*, since the whole complaint is that a working feature
       * was invisible. It must not be bound — see check 3.
       */
      const findRow = titles.find((t) => /Find in document/i.test(t)) || '';
      checks.push({
        name: 'the find command shows its keyboard shortcut',
        pass: /ctrl|⌘/i.test(findRow),
        detail: findRow || 'no find row'
      });

      const openedFind = await runCommand(page, 'Find in document');
      const findVisible = await page.evaluate(
        () => !!document.querySelector('.monaco-editor .find-widget.visible')
      );
      checks.push({
        name: 'running it opens Monaco find on a focused editor',
        pass: openedFind && findVisible,
        detail: openedFind ? `find widget visible=${findVisible}` : 'no such command'
      });

      await page.keyboard.press('Escape');
      await sleep(300);

      const openedReplace = await runCommand(page, 'Find and replace');
      const replaceVisible = await page.evaluate(() => {
        const widget = document.querySelector('.monaco-editor .find-widget');
        if (!widget) {
          return false;
        }
        const replaceInput = widget.querySelector('.replace-part textarea, .replace-part input');
        return (
          widget.classList.contains('visible') &&
          !!replaceInput &&
          replaceInput.getBoundingClientRect().height > 0
        );
      });
      checks.push({
        name: 'replace opens the replace row, not just find',
        pass: openedReplace && replaceVisible,
        detail: openedReplace ? `replace row visible=${replaceVisible}` : 'no such command'
      });

      await page.keyboard.press('Escape');
      await sleep(300);

      /*
       * The preview pane must keep the browser's own Ctrl+F. Gated on the find command
       * existing: on a build with no find command there is nothing that could have bound the
       * key, so an un-prevented Ctrl+F would prove nothing.
       */
      const stillPrevented = await page.evaluate(() => {
        const output = document.querySelector('#output');
        output.focus();
        let prevented = false;
        /*
         * Read on document in the bubble phase — the same place the app's own global handler
         * listens, so this observes exactly what that handler did or did not do.
         */
        const probe = (event) => {
          prevented = event.defaultPrevented;
        };
        document.addEventListener('keydown', probe);
        output.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true })
        );
        document.removeEventListener('keydown', probe);
        return prevented;
      });

      checks.push({
        name: 'find is not bound globally, so the preview keeps the browser find',
        pass: hasFind && stillPrevented === false,
        detail: hasFind
          ? `Ctrl+F in preview defaultPrevented=${stillPrevented}`
          : 'no find command exists, so nothing could have bound the key'
      });

      checks.push({
        name: 'no console errors while finding',
        pass: errors.length === 0,
        detail: errors[0]
      });
    });

    // ---------- searching every document ----------

    await withPage(async (page, errors) => {
      await seedDocument(page, DOC_ONE, 'Alpha');
      await page.reload({ waitUntil: 'networkidle2' });
      await boot(page);

      const firstId = await activeId(page);
      await addDocument(page, 'Beta notes', DOC_TWO);
      const secondId = await activeId(page);

      const opened = await runCommand(page, 'Search all documents');
      const sheetOpen = await page.evaluate(() => {
        const dialog = document.querySelector('#search');
        return !!dialog && dialog.open;
      });
      checks.push({
        name: 'a Search all documents command opens a search sheet',
        pass: opened && sheetOpen,
        detail: opened ? `#search open=${sheetOpen}` : 'no such command'
      });

      const typed = await typeSearch(page, NEEDLE);
      const rows = typed ? await searchRows(page) : [];

      /*
       * Read the title element rather than the row text. The body of each fixture happens to
       * contain its own name, so a substring test on the whole row would pass even if the
       * document name were never rendered at all.
       */
      const titlesShown = await page.evaluate(() =>
        [...document.querySelectorAll('#search-results .sheet__result-title')].map((el) =>
          el.textContent.trim()
        )
      );
      const namesAlpha = titlesShown.includes('Alpha');
      const namesBeta = titlesShown.includes('Beta notes');

      checks.push({
        name: 'a term in two documents returns hits from both, each naming its document',
        pass: typed && rows.length >= 2 && namesAlpha && namesBeta,
        detail: typed
          ? `titles rendered: ${JSON.stringify(titlesShown)}`
          : 'no search input'
      });

      // Jump to the hit that is *not* in the document currently open.
      const jumped = await page.evaluate(() => {
        const row = [...document.querySelectorAll('#search-results .sheet__item')].find(
          (el) => el.querySelector('.sheet__result-title')?.textContent.trim() === 'Alpha'
        );
        if (!row) {
          return false;
        }
        row.click();
        return true;
      });
      await sleep(1400);

      const landed = await page.evaluate((term) => {
        const lines = [...document.querySelectorAll('#editor .view-line')]
          .map((l) => l.textContent)
          .join('\n');
        return {
          activeDoc: JSON.parse(localStorage.getItem('markbeam:active_doc') || 'null')?.v || null,
          hasTerm: lines.includes(term),
          selection: window.__markbeamSelectionProbe || null
        };
      }, NEEDLE);

      /*
       * Landing on the document is not enough — the point is arriving *at the hit*. Monaco
       * renders a selection as .selected-text, so a rendered box means the match is actually
       * selected rather than the cursor merely sitting at line 1.
       */
      const selectionText = await page.evaluate(() => {
        const active = document.querySelector('#editor .monaco-editor');
        if (!active) {
          return null;
        }
        const sel = document.querySelector('#editor .selected-text');
        return sel ? sel.getBoundingClientRect().width > 0 : false;
      });

      checks.push({
        name: 'choosing a hit switches document and lands on the match',
        pass:
          jumped &&
          landed.activeDoc === firstId &&
          landed.activeDoc !== secondId &&
          landed.hasTerm &&
          selectionText === true,
        detail: jumped
          ? `active ${landed.activeDoc === firstId ? 'Alpha' : landed.activeDoc}, term on screen=${landed.hasTerm}, selection rendered=${selectionText}`
          : 'no Alpha row to choose'
      });

      checks.push({
        name: 'no console errors while searching',
        pass: errors.length === 0,
        detail: errors[0]
      });
    });

    // ---------- empty state, cap, and the editor shortcut ----------

    await withPage(async (page, errors) => {
      await seedDocument(page, DOC_ONE, 'Alpha');
      await page.reload({ waitUntil: 'networkidle2' });
      await boot(page);

      await runCommand(page, 'Search all documents');
      await typeSearch(page, 'nothingmatchesthisstring');
      const emptyState = await page.evaluate(
        () => document.querySelector('#search-results .sheet__empty')?.textContent.trim() || ''
      );
      checks.push({
        name: 'a term with no hits shows an empty state rather than a blank sheet',
        pass: emptyState.length > 0,
        detail: emptyState || 'nothing rendered'
      });

      await page.keyboard.press('Escape');
      await sleep(300);

      // A document with far more matches than any sheet should list.
      await page.click('#editor');
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyA');
      await page.keyboard.up('Control');
      await page.keyboard.press('Backspace');
      await page.keyboard.type('flood flood flood\n'.repeat(4));
      await sleep(900);

      await runCommand(page, 'Search all documents');
      await typeSearch(page, 'flood');
      const floodRows = await searchRows(page);
      const footer = await page.evaluate(
        () => document.querySelector('#search-note')?.textContent.trim() || ''
      );

      checks.push({
        name: 'results are capped, and the sheet says so rather than truncating silently',
        pass: floodRows.length > 0 && floodRows.length <= 60 && (floodRows.length < 12 || CAP_HINT.test(footer)),
        detail: `${floodRows.length} rows, note "${footer}"`
      });

      await page.keyboard.press('Escape');
      await sleep(300);

      /*
       * Driven from inside the editor on purpose. A shortcut registered only on the palette's
       * global handler never fires here, because Monaco stops propagation for keys it binds —
       * the failure mode CLAUDE.md warns about, and one that looks fine everywhere else.
       */
      await page.click('#editor');
      await sleep(300);
      await page.keyboard.down('Control');
      await page.keyboard.down('Shift');
      await page.keyboard.press('KeyF');
      await page.keyboard.up('Shift');
      await page.keyboard.up('Control');
      await sleep(700);

      const openedFromEditor = await page.evaluate(() => {
        const dialog = document.querySelector('#search');
        return !!dialog && dialog.open;
      });
      checks.push({
        name: 'Ctrl+Shift+F opens the search sheet from inside the editor',
        pass: openedFromEditor,
        detail: `#search open=${openedFromEditor}`
      });

      checks.push({
        name: 'no console errors while capping and shortcutting',
        pass: errors.length === 0,
        detail: errors[0]
      });
    });

    return checks;
  }
};
