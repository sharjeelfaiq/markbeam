import { editorText, withPage, sleep } from './lib.mjs';

/*
 * Shell behaviour: view modes, the beam divider, palette, toasts, theme persistence and
 * the narrow-screen layout.
 */

const chord = async (page, key) => {
  await page.keyboard.down('Control');
  await page.keyboard.press(key);
  await page.keyboard.up('Control');
  await sleep(350);
};

export const suite = {
  name: 'ui shell',
  async run() {
    return withPage(async (page, errors) => {
      const checks = [];
      await sleep(2500);

      // ---- fonts actually loaded (self-hosted, no CDN) ----
      const fonts = await page.evaluate(async () => {
        await document.fonts.ready;
        return {
          display: document.fonts.check('16px Newsreader'),
          mono: document.fonts.check('14px "Commit Mono"')
        };
      });
      checks.push({
        name: 'self-hosted fonts load',
        pass: fonts.display && fonts.mono,
        detail: `Newsreader ${fonts.display}, Commit Mono ${fonts.mono}`
      });

      // ---- view modes ----
      await page.click('[data-view-mode="preview"]');
      await sleep(350);
      const previewOnly = await page.evaluate(() => ({
        editor: document.querySelector('#edit').offsetWidth,
        preview: document.querySelector('#preview').offsetWidth
      }));
      checks.push({
        name: 'preview-only hides the editor',
        pass: previewOnly.editor === 0 && previewOnly.preview > 0
      });

      await page.click('[data-view-mode="editor"]');
      await sleep(350);
      const editorOnly = await page.evaluate(() => ({
        editor: document.querySelector('#edit').offsetWidth,
        preview: document.querySelector('#preview').offsetWidth
      }));
      checks.push({
        name: 'editor-only hides the preview',
        pass: editorOnly.preview === 0 && editorOnly.editor > 0
      });

      await page.click('[data-view-mode="split"]');
      await sleep(350);

      // ---- divider is keyboard operable (it used to be mouse-only) ----
      await page.focus('#split-divider');
      const widthBefore = await page.evaluate(() => document.querySelector('#edit').offsetWidth);
      for (let i = 0; i < 5; i++) {
        await page.keyboard.press('ArrowRight');
      }
      await sleep(300);
      const widthAfter = await page.evaluate(() => document.querySelector('#edit').offsetWidth);
      const ariaNow = await page.$eval('#split-divider', (el) => el.getAttribute('aria-valuenow'));
      checks.push({
        name: 'divider resizes with the keyboard',
        pass: widthAfter > widthBefore && ariaNow !== '50',
        detail: `${widthBefore}px -> ${widthAfter}px, aria-valuenow ${ariaNow}`
      });

      // ---- command palette ----
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyK');
      await page.keyboard.up('Control');
      await sleep(350);
      const palette = await page.evaluate(() => ({
        open: document.querySelector('#palette').open,
        items: document.querySelectorAll('#palette-list .sheet__item').length
      }));
      checks.push({
        name: 'command palette opens with Ctrl+K',
        pass: palette.open && palette.items > 0,
        detail: `${palette.items} commands`
      });
      await page.keyboard.press('Escape');
      await sleep(250);

      /*
       * ---- and again with the editor focused (T19) ----
       *
       * The check above passes only because focus is still on #split-divider from the
       * divider check. Monaco binds Ctrl+K as a chord prefix and calls stopPropagation on
       * it, so the document-level handler never sees the keystroke while the editor is
       * focused — which is essentially always while writing. Focus is asserted explicitly
       * rather than assumed: a click that failed to land in Monaco would make this pass
       * for the wrong reason.
       */
      await page.click('#editor');
      await sleep(250);

      const focusedInEditor = await page.evaluate(() => {
        const active = document.activeElement;
        return !!active && active.classList.contains('inputarea');
      });
      checks.push({
        name: 'clicking the editor focuses Monaco',
        pass: focusedInEditor,
        detail: focusedInEditor ? 'textarea.inputarea' : 'focus went elsewhere'
      });

      const textBeforeShortcut = await editorText(page);

      await page.keyboard.down('Control');
      await page.keyboard.press('KeyK');
      await page.keyboard.up('Control');
      await sleep(350);

      const fromEditor = await page.evaluate(() => ({
        open: document.querySelector('#palette').open,
        items: document.querySelectorAll('#palette-list .sheet__item').length
      }));
      checks.push({
        name: 'command palette opens with Ctrl+K while the editor has focus',
        pass: fromEditor.open && fromEditor.items > 0,
        detail: `open=${fromEditor.open}, ${fromEditor.items} commands`
      });

      /*
       * A chord prefix consumes the keystroke that follows it. Ctrl+K Ctrl+C is Monaco's
       * addCommentLine, so if chord mode was entered the Ctrl+C below wraps the current
       * line in an HTML comment. Nothing may reach the document.
       */
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyC');
      await page.keyboard.up('Control');
      await sleep(350);

      const textAfterShortcut = await editorText(page);
      checks.push({
        name: 'Ctrl+K does not put Monaco into chord mode',
        pass: textAfterShortcut === textBeforeShortcut,
        detail:
          textAfterShortcut === textBeforeShortcut
            ? 'document unchanged'
            : `document changed to "${textAfterShortcut.slice(0, 48)}"`
      });

      // Closing must leave no chord state behind, or the next keystroke is eaten.
      await page.keyboard.press('Escape');
      await sleep(250);
      await page.click('#editor');
      await page.keyboard.type('Z');
      await sleep(400);

      const textAfterTyping = await editorText(page);
      checks.push({
        name: 'typing still reaches the editor afterwards',
        pass: textAfterTyping !== textBeforeShortcut && textAfterTyping.includes('Z'),
        detail: textAfterTyping.slice(0, 48)
      });

      // Undo the probe character so later checks see the document they expect.
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyZ');
      await page.keyboard.up('Control');
      await sleep(400);

      /*
       * ---- the rest of the shortcuts, with the editor focused (T20) ----
       *
       * Ctrl+K was exempt from `handleGlobalKeys`'s form-field guard because it is handled
       * above it. Everything else was not: Monaco's hidden input is a <textarea>, so the
       * guard classified the editor as a form field and discarded the keystroke. Monaco is
       * not involved — these keys do reach `document`, our own handler drops them.
       */
      await page.click('#editor');
      await sleep(250);

      const focusedForViewKeys = await page.evaluate(
        () => !!document.activeElement && document.activeElement.classList.contains('inputarea')
      );

      await chord(page, 'Digit1');
      const afterCtrl1 = await page.evaluate(() => ({
        preview: document.querySelector('#preview').offsetWidth,
        view: document.body.dataset.view
      }));
      checks.push({
        name: 'Ctrl+1 switches to editor-only with the editor focused',
        pass: focusedForViewKeys && afterCtrl1.preview === 0,
        detail: `data-view=${afterCtrl1.view}, preview ${afterCtrl1.preview}px`
      });

      await chord(page, 'Digit3');
      const afterCtrl3 = await page.evaluate(() => ({
        edit: document.querySelector('#edit').offsetWidth,
        view: document.body.dataset.view
      }));
      checks.push({
        name: 'Ctrl+3 switches to preview-only with the editor focused',
        pass: afterCtrl3.edit === 0,
        detail: `data-view=${afterCtrl3.view}, editor ${afterCtrl3.edit}px`
      });

      // Back to split, so the checks below see both panes.
      await page.click('[data-view-mode="split"]');
      await sleep(350);

      /*
       * Ctrl+S. The export machinery is the pdf suite's business; all that matters here is
       * that the keystroke reaches the command, which the disabled button proves.
       * `defaultPrevented` is asserted too: without it the keystroke falls through to the
       * browser's own Save Page dialog, which is what happens today.
       */
      await page.evaluate(() => {
        window.__savePrevented = null;
        // Registered after initPalette's listener, so it observes the outcome of it.
        document.addEventListener('keydown', (e) => {
          if (e.ctrlKey && e.key.toLowerCase() === 's') {
            window.__savePrevented = e.defaultPrevented;
          }
        });
      });

      await page.click('#editor');
      await sleep(250);
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyS');
      await page.keyboard.up('Control');

      let exportStarted = false;
      for (let i = 0; i < 20; i++) {
        await sleep(100);
        if (await page.evaluate(() => document.querySelector('#export-button').disabled)) {
          exportStarted = true;
          break;
        }
      }

      checks.push({
        name: 'Ctrl+S starts an export with the editor focused',
        pass: exportStarted,
        detail: exportStarted ? 'export button went busy' : 'export never started'
      });
      checks.push({
        name: 'Ctrl+S is taken from the browser rather than opening Save Page',
        pass: (await page.evaluate(() => window.__savePrevented)) === true,
        detail: `defaultPrevented=${await page.evaluate(() => window.__savePrevented)}`
      });

      // Let any export finish before continuing — same wait the pdf suite uses.
      for (let i = 0; i < 60; i++) {
        await sleep(1000);
        if (!(await page.evaluate(() => document.querySelector('#export-button').disabled))) {
          break;
        }
      }
      await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));

      /*
       * The guard itself must survive: the title input is a real form field and Ctrl+1
       * there must stay inert. Expected to pass before the fix as well — this one guards
       * against the fix over-reaching, it does not demonstrate the bug.
       */
      await page.click('[data-view-mode="split"]');
      await sleep(300);
      await page.click('#doc-title');
      await sleep(200);
      await chord(page, 'Digit1');
      const afterTitleCtrl1 = await page.evaluate(() => document.body.dataset.view);
      checks.push({
        name: 'Ctrl+1 stays inert while the title input has focus',
        pass: afterTitleCtrl1 === 'split',
        detail: `data-view=${afterTitleCtrl1}`
      });
      await page.click('[data-view-mode="split"]');
      await sleep(300);

      // ---- toast feedback ----
      await page.click('#copy-button');
      await sleep(500);
      const toasts = await page.$$eval('.toast', (els) => els.map((el) => el.textContent));
      checks.push({
        name: 'copy raises a toast',
        pass: toasts.length === 1,
        detail: toasts[0]
      });

      // ---- theme switch + persistence across reload ----
      const themeBefore = await page.evaluate(() =>
        document.documentElement.getAttribute('data-theme'));
      const themeColourBefore = await page.evaluate(
        () => getComputedStyle(document.querySelector('#output')).color
      );
      await page.click('#theme-button');
      await sleep(800);
      const themeAfter = await page.evaluate(() =>
        document.documentElement.getAttribute('data-theme'));
      // Theming is token-driven now: no stylesheet is swapped, so assert the preview's
      // resolved colour actually changed rather than looking for a <link> href.
      const previewColour = await page.evaluate(
        () => getComputedStyle(document.querySelector('#output')).color
      );
      checks.push({
        name: 'theme button changes the visible theme',
        pass: themeAfter !== themeBefore,
        detail: `${themeBefore} -> ${themeAfter}`
      });
      checks.push({
        name: 'preview colours follow the theme',
        pass: previewColour !== themeColourBefore,
        detail: `${themeColourBefore} -> ${previewColour}`
      });

      await page.reload({ waitUntil: 'networkidle2' });
      await page.waitForFunction(() => !!document.querySelector('#editor .monaco-editor'), {
        timeout: 30000
      });
      await sleep(1000);
      const themeReloaded = await page.evaluate(() =>
        document.documentElement.getAttribute('data-theme'));
      checks.push({
        name: 'theme survives reload without flashing',
        pass: themeReloaded === themeAfter,
        detail: themeReloaded
      });

      /*
       * ---- sync scroll must be reachable without the palette (T18) ----
       *
       * The redesign replaced a checkbox with a palette command, which hid the feature
       * well enough that nobody could tell T1 had fixed it. Asserting `aria-pressed`
       * alone would pass on a control that looks identical either way — which is the
       * defect — so the rendered colour is compared across the two states, the same way
       * `alerts.test.mjs` proves its five accents are distinct.
       */
      await page.click('[data-view-mode="split"]');
      await sleep(350);

      const syncButton = await page.evaluate(() => {
        const el = document.querySelector('#sync-button');
        if (!el) {
          return null;
        }
        const rect = el.getBoundingClientRect();
        return { visible: rect.width > 0 && rect.height > 0, label: el.textContent.trim() };
      });
      checks.push({
        name: 'a sync scroll toggle is present in the toolbar',
        pass: !!syncButton && syncButton.visible,
        detail: syncButton ? `labelled "${syncButton.label}"` : 'not found'
      });

      const readSync = () =>
        page.evaluate(() => {
          const el = document.querySelector('#sync-button');
          if (!el) {
            return null;
          }
          return {
            pressed: el.getAttribute('aria-pressed'),
            disabled: el.getAttribute('aria-disabled'),
            colour: getComputedStyle(el).color,
            background: getComputedStyle(el).backgroundColor
          };
        });

      const before = await readSync();
      if (syncButton) {
        await page.click('#sync-button');
        await sleep(400);
      }
      const after = await readSync();

      checks.push({
        name: 'the toggle changes state and looks different when it does',
        pass:
          !!before &&
          !!after &&
          before.pressed !== after.pressed &&
          (before.colour !== after.colour || before.background !== after.background),
        detail: before
          ? `${before.pressed} ${before.colour} -> ${after.pressed} ${after.colour}`
          : 'no button'
      });

      // Bound to the real setting, not just to its own appearance.
      const persisted = await page.evaluate(() =>
        localStorage.getItem('markbeam:scroll_bar_settings')
      );
      await page.reload({ waitUntil: 'networkidle2' });
      await page.waitForFunction(() => !!document.querySelector('#editor .monaco-editor'), {
        timeout: 30000
      });
      await sleep(1500);
      const afterReload = await readSync();
      checks.push({
        name: 'the toggle drives the stored setting and survives a reload',
        pass: !!afterReload && afterReload.pressed === 'true' && /true/i.test(String(persisted)),
        detail: `stored ${persisted}, aria-pressed ${afterReload && afterReload.pressed}`
      });

      // Nothing to sync when only one pane is on screen.
      await page.click('[data-view-mode="editor"]');
      await sleep(350);
      const inEditorOnly = await readSync();
      await page.click('[data-view-mode="preview"]');
      await sleep(350);
      const inPreviewOnly = await readSync();
      await page.click('[data-view-mode="split"]');
      await sleep(350);
      const backInSplit = await readSync();

      checks.push({
        name: 'the toggle is marked unavailable outside split view',
        pass:
          !!inEditorOnly &&
          inEditorOnly.disabled === 'true' &&
          inPreviewOnly.disabled === 'true' &&
          backInSplit.disabled !== 'true',
        detail: `editor ${inEditorOnly && inEditorOnly.disabled}, preview ${inPreviewOnly && inPreviewOnly.disabled}, split ${backInSplit && backInSplit.disabled}`
      });

      // ---- narrow screen ----
      await page.setViewport({ width: 375, height: 720 });
      await sleep(600);
      const mobile = await page.evaluate(() => ({
        tabs: document.querySelector('.pane-tabs').offsetHeight > 0,
        beam: document.querySelector('#split-divider').offsetWidth,
        overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
        sync: document.querySelector('#sync-button')
          ? document.querySelector('#sync-button').offsetWidth
          : -1
      }));
      checks.push({
        name: 'narrow screens show pane tabs, hide the divider',
        pass: mobile.tabs && mobile.beam === 0
      });
      // Below 768px only one pane is ever on screen, so there is nothing to sync — the
      // toggle goes with the divider and the segmented control it sits beside.
      checks.push({
        name: 'the sync toggle is hidden at 375px, like the divider',
        pass: mobile.sync === 0,
        detail: mobile.sync === -1 ? 'no sync button at all' : `${mobile.sync}px wide`
      });
      checks.push({
        name: 'no horizontal overflow at 375px',
        pass: mobile.overflow === false
      });

      // ---- source link ----
      await page.setViewport({ width: 1400, height: 900 });
      await sleep(500);
      const source = await page.evaluate(() => {
        const el = document.querySelector('#source-link');
        if (!el) {
          return null;
        }
        const r = el.getBoundingClientRect();
        return {
          href: el.getAttribute('href'),
          rel: el.getAttribute('rel') || '',
          visible: r.width > 0 && r.height > 0,
          inlineSvg: !!el.querySelector('svg'),
          // an external badge image would defeat the point of inlining it
          externalImg: !!el.querySelector('img')
        };
      });
      checks.push({
        name: 'source link points at the repository, with an inline icon',
        pass:
          !!source &&
          source.visible &&
          source.href === 'https://github.com/sharjeelfaiq/markbeam' &&
          source.inlineSvg &&
          !source.externalImg &&
          source.rel.includes('noopener'),
        detail: source ? `${source.href} (rel="${source.rel}")` : 'not found'
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
