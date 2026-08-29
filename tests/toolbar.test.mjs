import { seedDocument, sleep, withPage } from './lib.mjs';

const boot = async (page) => {
  await page.waitForFunction(() => !!document.querySelector('#editor .monaco-editor'), {
    timeout: 30000
  });
  await page.waitForSelector('#format-toolbar');
  await sleep(900);
};

const model = (page) =>
  page.evaluate(async () => {
    const monaco =
      window.monaco || (await import('https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/+esm'));
    return monaco.editor.getEditors()[0]?.getValue?.() ?? null;
  });

const setSelection = (page, value, start, end = start) =>
  page.evaluate(
    async ({ text, from, to }) => {
      const monaco =
        window.monaco || (await import('https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/+esm'));
      const editor = monaco.editor.getEditors()[0];
      if (!editor || !monaco) return false;
      editor.setValue(text);
      const editorModel = editor.getModel();
      editor.setSelection(
        monaco.Selection.fromPositions(editorModel.getPositionAt(from), editorModel.getPositionAt(to))
      );
      editor.focus();
      return true;
    },
    { text: value, from: start, to: end }
  );

const selectionOffsets = (page) =>
  page.evaluate(async () => {
    const monaco =
      window.monaco || (await import('https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/+esm'));
    const editor = monaco.editor.getEditors()[0];
    const editorModel = editor?.getModel();
    const selection = editor?.getSelection();
    if (!editorModel || !selection) return null;
    return {
      start: editorModel.getOffsetAt(selection.getStartPosition()),
      end: editorModel.getOffsetAt(selection.getEndPosition()),
      startLine: selection.startLineNumber,
      startColumn: selection.startColumn,
      selected: editorModel.getValueInRange(selection),
      focused: editor.hasTextFocus()
    };
  });

const clickFormat = async (page, name) => {
  await page.click(`[data-format="${name}"]`);
  await sleep(180);
};

export const suite = {
  name: 'toolbar',
  async run() {
    return withPage(async (page, errors) => {
      const checks = [];

      await seedDocument(page, 'alpha\nbeta\ngamma', 'Toolbar fixture');
      await page.reload({ waitUntil: 'networkidle2' });
      await boot(page);
      const httpImages = [];
      page.on('request', (request) => {
        if (request.resourceType() === 'image' && /^https?:/i.test(request.url())) {
          httpImages.push(request.url());
        }
      });

      const structure = await page.evaluate(() => {
        const toolbar = document.querySelector('#format-toolbar');
        const buttons = [...(toolbar?.querySelectorAll('button') || [])];
        const groups = [...(toolbar?.querySelectorAll('.format-toolbar__group') || [])];
        const rect = toolbar?.getBoundingClientRect();
        return {
          role: toolbar?.getAttribute('role'),
          label: toolbar?.getAttribute('aria-label'),
          height: rect?.height,
          groups: groups.length,
          controls: buttons.map((button) => ({
            format: button.dataset.format,
            label: button.getAttribute('aria-label'),
            title: button.getAttribute('title'),
            tabIndex: button.tabIndex
          }))
        };
      });
      const expected = [
        'heading', 'bold', 'italic', 'strike', 'code', 'bullet-list', 'ordered-list',
        'task-list', 'blockquote', 'code-block', 'table', 'link', 'image'
      ];
      checks.push({
        name: 'the editor has a labelled 42px four-group formatting toolbar',
        pass:
          structure.role === 'toolbar' &&
          /format/i.test(structure.label || '') &&
          Math.abs((structure.height || 0) - 42) <= 1 &&
          structure.groups === 4 &&
          expected.every((name) => structure.controls.some((control) => control.format === name)),
        detail: JSON.stringify(structure)
      });
      checks.push({
        name: 'every toolbar control has an accessible label and native tooltip fallback',
        pass:
          structure.controls.length >= expected.length &&
          structure.controls.every((control) => control.label && control.title),
        detail: `${structure.controls.length} controls`
      });
      checks.push({
        name: 'toolbar uses one roving tab stop',
        pass: structure.controls.filter((control) => control.tabIndex === 0).length === 1,
        detail: structure.controls.map((control) => control.tabIndex).join(',')
      });

      const contrast = await page.evaluate(() => {
        const original = document.documentElement.dataset.theme;
        const luminance = ([red, green, blue]) => {
          const channels = [red, green, blue].map((value) => {
            const channel = value / 255;
            return channel <= 0.03928
              ? channel / 12.92
              : Math.pow((channel + 0.055) / 1.055, 2.4);
          });
          return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
        };
        const rgb = (value) => (value.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
        const ratio = (first, second) => {
          const one = luminance(rgb(first));
          const two = luminance(rgb(second));
          return (Math.max(one, two) + 0.05) / (Math.min(one, two) + 0.05);
        };
        const button = document.querySelector('[data-format="bold"]');
        const toolbar = document.querySelector('#format-toolbar');
        const result = {};
        const transition = button.style.transition;
        // Theme switching is animated in the product. Contrast is a steady-state property,
        // so do not accidentally sample the old text colour over the new surface mid-tween.
        button.style.transition = 'none';
        for (const theme of ['dark', 'light']) {
          document.documentElement.dataset.theme = theme;
          void button.offsetWidth;
          button.setAttribute('aria-pressed', 'false');
          const surface = getComputedStyle(toolbar).backgroundColor;
          const ordinary = getComputedStyle(button).color;
          button.setAttribute('aria-pressed', 'true');
          const active = getComputedStyle(button).color;
          result[theme] = {
            ordinary: ratio(ordinary, surface),
            active: ratio(active, surface)
          };
        }
        button.setAttribute('aria-pressed', 'false');
        button.style.transition = transition;
        document.documentElement.dataset.theme = original;
        return result;
      });
      checks.push({
        name: 'toolbar controls retain readable contrast in both themes',
        pass: Object.values(contrast).every(
          (theme) => theme.ordinary >= 4.5 && theme.active >= 3
        ),
        detail: JSON.stringify(contrast)
      });

      const visibility = {};
      for (const view of ['split', 'editor', 'preview']) {
        await page.click(`[data-view-mode="${view}"]`);
        await sleep(100);
        visibility[view] = await page.$eval('#format-toolbar', (toolbar) =>
          getComputedStyle(toolbar).display !== 'none' && toolbar.getBoundingClientRect().height > 0
        );
      }
      checks.push({
        name: 'toolbar is present in Split and Editor modes and absent in Preview-only mode',
        pass: visibility.split && visibility.editor && !visibility.preview,
        detail: JSON.stringify(visibility)
      });
      await page.click('[data-view-mode="editor"]');

      await page.setViewport({ width: 375, height: 760 });
      await sleep(150);
      const mobile = await page.evaluate(() => {
        const pane = document.querySelector('.pane--editor');
        const toolbar = document.querySelector('#format-toolbar');
        const rail = document.querySelector('.format-toolbar__rail');
        const control = toolbar?.querySelector('button');
        return {
          paneWidth: pane?.getBoundingClientRect().width,
          toolbarWidth: toolbar?.getBoundingClientRect().width,
          railClient: rail?.clientWidth,
          railScroll: rail?.scrollWidth,
          overflowX: rail ? getComputedStyle(rail).overflowX : '',
          controlHeight: control?.getBoundingClientRect().height
        };
      });
      checks.push({
        name: 'the 375px toolbar scrolls within the editor and keeps 36px controls',
        pass:
          mobile.toolbarWidth <= mobile.paneWidth + 1 &&
          mobile.railScroll > mobile.railClient &&
          ['auto', 'scroll'].includes(mobile.overflowX) &&
          Math.abs((mobile.controlHeight || 0) - 36) <= 1,
        detail: JSON.stringify(mobile)
      });
      await page.setViewport({ width: 1400, height: 900 });

      // Pointer activation must use the selection Monaco held before the button was pressed.
      await setSelection(page, 'alpha target omega', 6, 12);
      await clickFormat(page, 'bold');
      const bold = await model(page);
      const boldSelection = await selectionOffsets(page);
      checks.push({
        name: 'pointer formatting preserves the Monaco edit range and returns focus',
        pass:
          bold === 'alpha **target** omega' &&
          boldSelection?.selected === 'target' &&
          boldSelection.focused,
        detail: `${JSON.stringify(bold)} ${JSON.stringify(boldSelection)}`
      });
      await clickFormat(page, 'bold');
      checks.push({
        name: 'inline formatting toggles off around a preserved selection',
        pass: (await model(page)) === 'alpha target omega',
        detail: JSON.stringify(await model(page))
      });

      const inlineCases = [
        ['italic', '*target*'],
        ['strike', '~~target~~'],
        ['code', '`target`']
      ];
      for (const [name, wanted] of inlineCases) {
        await setSelection(page, 'target', 0, 6);
        await clickFormat(page, name);
        checks.push({
          name: `${name} wraps selected text`,
          pass: (await model(page)) === wanted && (await selectionOffsets(page))?.selected === 'target',
          detail: JSON.stringify(await model(page))
        });
      }

      await setSelection(page, 'one\ntwo\nthree', 0, 8); // end at column 1 of line three
      await clickFormat(page, 'ordered-list');
      checks.push({
        name: 'line formatting excludes a selection ending at column 1 of the next line',
        pass: (await model(page)) === '1. one\n2. two\nthree',
        detail: JSON.stringify(await model(page))
      });
      await clickFormat(page, 'task-list');
      checks.push({
        name: 'list actions mutually normalize ordered, bullet, and task markers',
        pass: (await model(page)) === '- [ ] one\n- [ ] two\nthree',
        detail: JSON.stringify(await model(page))
      });

      await setSelection(page, '## Alpha\n## Beta', 0, 18);
      await page.click('[data-format="heading"]');
      await sleep(100);
      const menuOpen = await page.$eval('#format-heading-menu', (menu) => !menu.hidden);
      await page.click('[data-heading-level="3"]');
      await sleep(160);
      checks.push({
        name: 'the heading menu opens accessibly and normalizes selected headings',
        pass: menuOpen && (await model(page)) === '### Alpha\n### Beta',
        detail: JSON.stringify(await model(page))
      });
      await page.click('[data-format="heading"]');
      await page.click('[data-heading-level="paragraph"]');
      await sleep(160);
      checks.push({
        name: 'Paragraph removes heading markers without changing text',
        pass: (await model(page)) === 'Alpha\nBeta',
        detail: JSON.stringify(await model(page))
      });

      await setSelection(page, 'alpha\nbeta', 0, 10);
      await clickFormat(page, 'blockquote');
      const quoted = await model(page);
      await clickFormat(page, 'blockquote');
      checks.push({
        name: 'blockquote toggles across multiple lines',
        pass: quoted === '> alpha\n> beta' && (await model(page)) === 'alpha\nbeta',
        detail: `${JSON.stringify(quoted)} -> ${JSON.stringify(await model(page))}`
      });

      await setSelection(page, 'const beam = true;', 0, 18);
      await clickFormat(page, 'code-block');
      const fenced = await model(page);
      await clickFormat(page, 'code-block');
      checks.push({
        name: 'fenced code wraps, preserves, and unwraps selected content',
        pass:
          fenced?.replace(/\r\n/g, '\n') === '```\nconst beam = true;\n```' &&
          (await model(page)) === 'const beam = true;',
        detail: `${JSON.stringify(fenced)} -> ${JSON.stringify(await model(page))}`
      });

      await setSelection(page, 'a | b\n  c', 0, 9);
      await clickFormat(page, 'table');
      const table = await model(page);
      const tableSelection = await selectionOffsets(page);
      checks.push({
        name: 'table inserts selected text safely into the first body cell and advances',
        pass:
          table.includes('| a \\| b c |  |') &&
          tableSelection?.start === tableSelection?.end &&
          tableSelection.start > table.indexOf('a \\| b c'),
        detail: `${JSON.stringify(table)} ${JSON.stringify(tableSelection)}`
      });
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyZ');
      await page.keyboard.up('Control');
      await sleep(160);
      checks.push({
        name: 'a toolbar transformation reverses in one undo step',
        pass: (await model(page)) === 'a | b\n  c',
        detail: JSON.stringify(await model(page))
      });

      await setSelection(page, '', 0);
      await clickFormat(page, 'bold');
      const emptyBoldSelection = await selectionOffsets(page);
      checks.push({
        name: 'an empty inline action places the cursor inside its marker pair',
        pass:
          (await model(page)) === '****' &&
          emptyBoldSelection?.start === 2 &&
          emptyBoldSelection?.end === 2,
        detail: `${JSON.stringify(await model(page))} ${JSON.stringify(emptyBoldSelection)}`
      });

      await setSelection(page, '', 0);
      await clickFormat(page, 'code-block');
      const emptyFenceSelection = await selectionOffsets(page);
      checks.push({
        name: 'an empty fenced-code action places the cursor on its blank body line',
        pass:
          (await model(page))?.replace(/\r\n/g, '\n') === '```\n\n```' &&
          emptyFenceSelection?.startLine === 2 &&
          emptyFenceSelection?.startColumn === 1 &&
          emptyFenceSelection?.start === emptyFenceSelection?.end,
        detail: `${JSON.stringify(await model(page))} ${JSON.stringify(emptyFenceSelection)}`
      });

      await setSelection(page, '', 0);
      await clickFormat(page, 'link');
      checks.push({
        name: 'an empty link inserts useful placeholders',
        pass: (await model(page)) === '[link text](url)',
        detail: JSON.stringify(await model(page))
      });

      // Active state is source-derived, mutually exclusive, and suppressed inside fences.
      await setSelection(page, '- [ ] task', 7);
      await sleep(150);
      const taskState = await page.evaluate(() =>
        ['bullet-list', 'ordered-list', 'task-list'].map((name) =>
          document.querySelector(`[data-format="${name}"]`)?.getAttribute('aria-pressed')
        )
      );
      await setSelection(page, '```\n**bold**\n```', 8);
      await sleep(150);
      const fenceState = await page.evaluate(() =>
        [...document.querySelectorAll('#format-toolbar [aria-pressed="true"]')].map(
          (button) => button.dataset.format
        )
      );
      checks.push({
        name: 'task list state is exclusive and all active states suppress inside fenced code',
        pass: taskState.join(',') === 'false,false,true' && fenceState.length === 0,
        detail: `${JSON.stringify(taskState)} fenced=${JSON.stringify(fenceState)}`
      });

      // Roving navigation wraps; heading menu supports ArrowDown and Escape.
      await page.focus('[data-format="heading"]');
      await page.keyboard.press('ArrowLeft');
      const wrappedFocus = await page.evaluate(() => document.activeElement?.dataset?.format);
      await page.focus('[data-format="heading"]');
      await page.keyboard.press('ArrowDown');
      const menuFocus = await page.evaluate(() => ({
        open: !document.querySelector('#format-heading-menu')?.hidden,
        level: document.activeElement?.dataset?.headingLevel
      }));
      await page.keyboard.press('Escape');
      const returned = await page.evaluate(() => document.activeElement?.dataset?.format);
      checks.push({
        name: 'roving toolbar and heading-menu keyboard navigation wrap and return focus',
        pass: wrappedFocus === 'image' && menuFocus.open && !!menuFocus.level && returned === 'heading',
        detail: JSON.stringify({ wrappedFocus, menuFocus, returned })
      });

      await page.hover('[data-format="strike"]');
      await sleep(400);
      const tooltip = await page.evaluate(() => {
        const tip = document.querySelector('#format-tooltip');
        const control = document.querySelector('[data-format="strike"]');
        return {
          count: document.querySelectorAll('#format-tooltip').length,
          role: tip?.getAttribute('role'),
          visible: tip ? getComputedStyle(tip).visibility === 'visible' : false,
          described: control?.getAttribute('aria-describedby') === tip?.id,
          text: tip?.textContent?.trim()
        };
      });
      checks.push({
        name: 'one unclipped floating tooltip describes hovered controls',
        pass: tooltip.count === 1 && tooltip.role === 'tooltip' && tooltip.visible && tooltip.described && /strike/i.test(tooltip.text || ''),
        detail: JSON.stringify(tooltip)
      });

      await page.keyboard.down('Control');
      await page.keyboard.press('KeyK');
      await page.keyboard.up('Control');
      await sleep(250);
      const palette = await page.evaluate(() =>
        [...document.querySelectorAll('#palette .sheet__item')].map((item) => item.textContent.toLowerCase())
      );
      await page.keyboard.press('Escape');
      const paletteWanted = [
        'strikethrough', 'heading 1', 'heading 2', 'heading 3', 'paragraph', 'ordered list',
        'task list', 'blockquote', 'fenced code', 'table', 'local image'
      ];
      checks.push({
        name: 'all added formatting and image actions have command-palette parity',
        pass: paletteWanted.every((name) => palette.some((command) => command.includes(name))),
        detail: paletteWanted.filter((name) => !palette.some((command) => command.includes(name))).join(', ')
      });

      const pickerOpened = await page.evaluate(() => {
        const input = document.querySelector('#image-input');
        let opened = 0;
        input.addEventListener(
          'click',
          (event) => {
            opened += 1;
            event.preventDefault();
          },
          { once: true }
        );
        document.querySelector('[data-format="image"]').click();
        return opened;
      });
      checks.push({
        name: 'the toolbar image action opens the dedicated private image picker',
        pass:
          pickerOpened === 1 &&
          (await page.$eval('#image-input', (input) => input.accept)).includes('image/webp'),
        detail: `opened=${pickerOpened}`
      });

      await setSelection(page, '# Local image\n\n', 15);
      const documentsBeforeImage = await page.evaluate(
        () => JSON.parse(localStorage.getItem('markbeam:docs'))?.v?.length || 0
      );
      await page.evaluate(async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 24;
        canvas.height = 18;
        const context = canvas.getContext('2d');
        context.fillStyle = '#0d9488';
        context.fillRect(0, 0, canvas.width, canvas.height);
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
        const transfer = new DataTransfer();
        transfer.items.add(new File([blob], 'Toolbar photo.png', { type: 'image/png' }));
        const input = document.querySelector('#image-input');
        input.files = transfer.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await page.waitForFunction(async () => {
        const monaco =
          window.monaco || (await import('https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/+esm'));
        return /!\[Toolbar photo\]\(data:image\/webp;base64,/.test(
          monaco.editor.getEditors()[0]?.getValue() || ''
        );
      });
      await sleep(300);
      const toolbarImage = await model(page);
      const imageInputCleared = await page.$eval('#image-input', (input) => !input.value);
      const documentsAfterImage = await page.evaluate(
        () => JSON.parse(localStorage.getItem('markbeam:docs'))?.v?.length || 0
      );
      checks.push({
        name: 'picker changes reuse the local WebP insertion path without a document or network image',
        pass:
          /!\[Toolbar photo\]\(data:image\/webp;base64,/.test(toolbarImage || '') &&
          imageInputCleared &&
          documentsAfterImage === documentsBeforeImage &&
          httpImages.length === 0,
        detail: `documents ${documentsBeforeImage}->${documentsAfterImage}, input cleared=${imageInputCleared}, HTTP images=${httpImages.length}`
      });

      const printHidden = await page.evaluate(() => {
        const style = document.createElement('style');
        style.media = 'print';
        document.head.appendChild(style);
        return [...document.styleSheets].some((sheet) => {
          try {
            return [...sheet.cssRules].some(
              (rule) => rule.media?.mediaText === 'print' && rule.cssText.includes('.format-toolbar')
            );
          } catch {
            return false;
          }
        });
      });
      checks.push({
        name: 'print CSS explicitly excludes the formatting toolbar',
        pass: printHidden,
        detail: String(printHidden)
      });

      checks.push({ name: 'no console errors', pass: errors.length === 0, detail: errors[0] });
      return checks;
    });
  }
};
