import { seedDocument, sleep, withPage, ready } from './lib.mjs';

/*
 * Print stylesheet (T12).
 *
 * Hiding the chrome is the easy half and the half that looks convincing. The layout is
 * built for an app — `body { height: 100dvh; overflow: hidden }` with the preview pane on
 * `overflow-y: auto` — and a printed page has no viewport, so without releasing those
 * constraints the output is a single tidy page containing only whatever was scrolled into
 * view, with the rest of the document gone.
 *
 * That is why the page-count check exists. Every structural check below can pass on a
 * document that has been silently truncated to one page, because a clipped page is not
 * blank, it is just wrong.
 */

const LONG_DOCUMENT = [
  '# Print fixture',
  '',
  '```mermaid\ngraph LR\n  A[Write] --> B[Print]\n```',
  '',
  ...Array.from({ length: 220 }, (_, i) => `Paragraph ${i + 1} of a document that must span several printed pages.`)
].join('\n\n');

const boot = async (page) => {
  await ready(page);
};

/** Is the element actually rendered? `display:none` gives a null offsetParent and 0 boxes. */
const rendered = (page, selector) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) {
      return { missing: true, visible: false };
    }
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return {
      missing: false,
      display: style.display,
      visible: style.display !== 'none' && rect.width > 0 && rect.height > 0,
      width: Math.round(rect.width)
    };
  }, selector);

/** Page count of a real print render — the only way to see clipping. */
const printedPages = async (page) => {
  const pdf = await page.pdf({ format: 'A4', printBackground: true });
  const text = Buffer.from(pdf).toString('latin1');
  // Every page object in a PDF is a `/Type /Page` dictionary; /Pages is the tree root.
  const matches = text.match(/\/Type\s*\/Page[^s]/g);
  return matches ? matches.length : 0;
};

export const suite = {
  name: 'print',
  async run() {
    return withPage(async (page, errors) => {
      const checks = [];

      await seedDocument(page, LONG_DOCUMENT, 'Print fixture');
      /*
       * Pin the theme instead of inheriting the host's. Everything below measures the
       * dark-to-light print path, and the default preference is 'system' — so on a machine
       * whose OS asks for light, this suite silently measured a light app and asserted the
       * opposite. Not hypothetical: it passed on a dark workstation and timed out on CI,
       * where the headless host reports a light preference.
       */
      await page.evaluate(() => {
        localStorage.setItem('markbeam:theme_settings', JSON.stringify({ v: 'dark' }));
        localStorage.setItem('markbeam:theme', 'dark');
      });
      await page.reload({ waitUntil: 'networkidle2' });
      await boot(page);
      await page.waitForFunction(() => !!document.querySelector('#output .mermaid svg'), {
        timeout: 30000
      });
      /*
       * Wait for the light print copies rather than sleeping. Boot fires several render
       * passes as the emoji and math chunks land, and each cancels an in-flight prerender,
       * so a fixed delay is a guess that fails on a slow machine and pads a fast one.
       *
       * Read off the DOM, not by importing the module: Vite serves an edited module as
       * `?t=…`, so a plain `import()` from the page yields a second instance with an empty
       * cache — a readiness check that reads false while the feature works.
       */
      await page.waitForFunction(
        () => document.querySelector('#output')?.dataset.printDiagrams === 'ready',
        { timeout: 25000 }
      );

      await page.emulateMediaType('print');
      await sleep(600);

      const toolbar = await rendered(page, '.toolbar');
      checks.push({
        name: 'the toolbar is not rendered when printing',
        pass: !toolbar.visible,
        detail: toolbar.missing ? 'element absent' : `display ${toolbar.display}, ${toolbar.width}px`
      });

      const statusbar = await rendered(page, '.statusbar');
      checks.push({
        name: 'the status bar is not rendered when printing',
        pass: !statusbar.visible,
        detail: statusbar.missing ? 'element absent' : `display ${statusbar.display}, ${statusbar.width}px`
      });

      const editor = await rendered(page, '.pane--editor');
      const divider = await rendered(page, '#split-divider');
      const tabs = await rendered(page, '.pane-tabs');
      checks.push({
        name: 'the editor, divider and pane tabs are not rendered when printing',
        pass: !editor.visible && !divider.visible && !tabs.visible,
        detail: `editor ${editor.display}, divider ${divider.display}, tabs ${tabs.display}`
      });

      /*
       * Full width and, critically, not a scroll container. A pane that still clips its
       * overflow prints exactly one screenful however wide it is.
       */
      const preview = await page.evaluate(() => {
        const pane = document.querySelector('.pane--preview');
        const style = getComputedStyle(pane);
        const bodyStyle = getComputedStyle(document.body);
        return {
          width: Math.round(pane.getBoundingClientRect().width),
          viewport: window.innerWidth,
          paneOverflowY: style.overflowY,
          bodyOverflow: bodyStyle.overflow,
          bodyHeight: bodyStyle.height
        };
      });
      checks.push({
        name: 'the preview fills the page and stops clipping its overflow',
        pass:
          preview.width >= preview.viewport - 2 &&
          preview.paneOverflowY === 'visible' &&
          !/hidden/.test(preview.bodyOverflow),
        detail: `pane ${preview.width}/${preview.viewport}px, pane overflow-y ${preview.paneOverflowY}, body overflow ${preview.bodyOverflow}, body height ${preview.bodyHeight}`
      });

      /*
       * Printing must not depend on which pane happens to be on screen.
       * `body[data-view='editor'] .pane--preview { display: none }` is a screen rule, and
       * before this task it survived into print media: printing from Editor-only view gave
       * a blank page.
       */
      await page.emulateMediaType(null);
      await page.click('[data-view-mode="editor"]');
      await sleep(400);
      await page.emulateMediaType('print');
      await sleep(400);
      const fromEditorView = await page.evaluate(() => ({
        view: document.body.dataset.view,
        display: getComputedStyle(document.querySelector('.pane--preview')).display,
        outputHeight: Math.round(document.querySelector('#output').getBoundingClientRect().height)
      }));
      checks.push({
        name: 'the document still prints when the app is in Editor-only view',
        pass: fromEditorView.display !== 'none' && fromEditorView.outputHeight > 100,
        detail: `data-view=${fromEditorView.view}, preview display ${fromEditorView.display}, #output ${fromEditorView.outputHeight}px`
      });

      await page.emulateMediaType(null);
      await page.click('[data-view-mode="split"]');
      await sleep(400);
      await page.emulateMediaType('print');
      await sleep(400);

      /*
       * The check that actually matters. 220 paragraphs cannot fit on one A4 page, so a
       * result of 1 means the document was truncated to the viewport.
       */
      const pages = await printedPages(page);
      checks.push({
        name: 'a long document prints to more than one page',
        pass: pages > 1,
        detail: `${pages} page${pages === 1 ? '' : 's'} rendered`
      });

      /*
       * Printing the dark theme would put white text on white paper. The app is dark by
       * default, so this is measured rather than assumed.
       *
       * Sampled *inside* `beforeprint`, which is the event a real Ctrl+P fires and the
       * moment the printer actually reads the page. Reading it under emulated print media
       * instead would be measuring a state that never occurs in real use — emulation flips
       * the media query without ever announcing a print job.
       */
      await page.emulateMediaType(null);
      /*
       * Wait for the restore instead of assuming it has happened.
       *
       * `printedPages()` above renders a PDF *while* print media is emulated, so its
       * `afterprint` hits `leavePrint()`'s guard — `matchMedia('print')` still matches, and
       * the theme deliberately stays light. The restore therefore rides on the media-query
       * change handler fired by the line above, which is a round-trip later than that call
       * resolves. Reading immediately is a race this machine wins and CI loses: it measured
       * `themeBeforePrinting` as light and failed two checks that describe correct
       * behaviour. Waiting on the exact state about to be measured makes it an assertion,
       * and if the restore never comes that is a real bug and this fails loudly.
       */
      await page.waitForFunction(
        () => document.documentElement.getAttribute('data-theme') === 'dark',
        { timeout: 5000 }
      );
      await page.evaluate(() => {
        window.__printSample = null;
        const luminance = (value) => {
          const m = /rgba?\(([^)]+)\)/.exec(value || '');
          if (!m) return null;
          const [r, g, b] = m[1].split(/[,/]/).map((n) => parseFloat(n));
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        window.addEventListener('beforeprint', () => {
          const output = document.querySelector('#output');
          const pane = document.querySelector('.pane--preview');
          const node = document.querySelector('#output .mermaid svg .node rect, #output .mermaid svg rect.basic');
          const nodeFill = node ? getComputedStyle(node).fill : null;
          window.__printSample = {
            theme: document.documentElement.getAttribute('data-theme'),
            text: getComputedStyle(output).color,
            textLuminance: luminance(getComputedStyle(output).color),
            paneBg: getComputedStyle(pane).backgroundColor,
            paneBgLuminance: luminance(getComputedStyle(pane).backgroundColor),
            nodeFill,
            nodeFillLuminance: luminance(nodeFill)
          };
        });
      });

      const themeBeforePrinting = await page.evaluate(
        () => document.documentElement.getAttribute('data-theme')
      );
      await page.pdf({ format: 'A4' });
      const colours = (await page.evaluate(() => window.__printSample)) || {
        theme: null,
        text: null,
        textLuminance: null,
        paneBg: null,
        paneBgLuminance: null
      };

      /*
       * Bounded wait, not a bare read. The restore runs in an `afterprint` handler during
       * the render above, and `page.pdf()` resolving does not guarantee it has been
       * observed here. A wait that expires still reports whatever the theme actually is, so
       * a genuine failure to restore fails on its merits rather than timing out.
       */
      let themeAfterPrinting;
      try {
        await page.waitForFunction(
          (expected) => document.documentElement.getAttribute('data-theme') === expected,
          { timeout: 5000 },
          themeBeforePrinting
        );
        themeAfterPrinting = themeBeforePrinting;
      } catch (error) {
        themeAfterPrinting = await page.evaluate(
          () => document.documentElement.getAttribute('data-theme')
        );
      }
      checks.push({
        name: 'printed text is dark on a light background, even from the dark theme',
        pass:
          themeBeforePrinting === 'dark' &&
          colours.textLuminance !== null &&
          colours.textLuminance < 120,
        detail: `app theme ${themeBeforePrinting}, at print time ${colours.theme}, text ${colours.text} (${colours.textLuminance === null ? 'n/a' : colours.textLuminance.toFixed(0)})`
      });

      /*
       * Forcing the light token ramp does nothing for a diagram: Mermaid bakes theme
       * colours into the SVG it emits, and an SVG is not CSS. A light copy is prepared
       * ahead of time and swapped in synchronously, because `beforeprint` cannot await a
       * re-render.
       */
      checks.push({
        name: 'a diagram printed from the dark theme uses light node fills',
        pass: colours.nodeFillLuminance !== null && colours.nodeFillLuminance > 180,
        detail:
          colours.nodeFill === null || colours.nodeFillLuminance === null
            ? `no diagram node sampled (fill ${colours.nodeFill})`
            : `node fill ${colours.nodeFill} (${colours.nodeFillLuminance.toFixed(0)}/255)`
      });

      // Guard, not evidence: the print swap must not leak onto the screen.
      const screenFill = await page.evaluate(() => {
        const node = document.querySelector('#output .mermaid svg .node rect, #output .mermaid svg rect.basic');
        return node ? getComputedStyle(node).fill : null;
      });
      checks.push({
        name: 'the on-screen diagram is still the dark one after printing',
        pass: screenFill !== null && screenFill !== colours.nodeFill,
        detail: `screen ${screenFill}, printed ${colours.nodeFill}`
      });

      // …and the screen must not be left light once the print job is over.
      checks.push({
        name: 'the screen theme is restored after printing',
        pass: themeAfterPrinting === themeBeforePrinting,
        detail: `${themeBeforePrinting} -> ${themeAfterPrinting}`
      });

      /*
       * The light path has to settle too. With the screen already light there is nothing to
       * prepare, and the prerender returned early without ever writing the readiness
       * attribute — so anything waiting on it waited forever. Printing itself still worked,
       * which is what let it survive: the only symptom was a wait that never resolved.
       */
      await page.evaluate(() => {
        localStorage.setItem('markbeam:theme_settings', JSON.stringify({ v: 'light' }));
        localStorage.setItem('markbeam:theme', 'light');
      });
      await page.reload({ waitUntil: 'networkidle2' });
      await boot(page);
      await page.waitForFunction(() => !!document.querySelector('#output .mermaid svg'), {
        timeout: 30000
      });

      let lightReadiness;
      try {
        await page.waitForFunction(
          () => document.querySelector('#output')?.dataset.printDiagrams === 'ready',
          { timeout: 8000 }
        );
        lightReadiness = 'ready';
      } catch (error) {
        lightReadiness = await page.evaluate(
          () => document.querySelector('#output')?.dataset.printDiagrams ?? '(never written)'
        );
      }
      checks.push({
        name: 'print readiness settles in the light theme, where there is nothing to prepare',
        pass: lightReadiness === 'ready',
        detail: `app theme light, #output[data-print-diagrams] = ${lightReadiness}`
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
