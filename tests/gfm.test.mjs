import { withPage, sleep } from './lib.mjs';

/*
 * Markdown modes, GFM features and footnotes (T8).
 *
 * This suite deliberately drives the mode through the command palette rather than
 * reaching into application modules. Its changing title, confirmation toast, and the
 * immediate preview update are all part of the user-visible contract.
 */

const FIXTURE = [
  '# Markdown modes',
  '',
  'A bare URL https://example.com/gfm and ~~removed words~~.',
  '',
  '| Feature | State |',
  '| --- | --- |',
  '| Table | GFM |',
  '',
  '- [ ] Open task',
  '- [x] Finished task',
  '',
  'Repeated note[^note] and the same note again[^note].',
  '',
  'Reference-shaped footnote[^plain].',
  '',
  '> [!NOTE]',
  '> Markbeam extensions keep ==highlight== and :sparkles:, while ~~alert strike~~ follows the mode.',
  '>',
  '> | Alert | Table |',
  '> | --- | --- |',
  '> | Nested | GFM |',
  '',
  'Inline math stays available: $x^2 + y^2$.',
  '',
  '`~~code~~ ==code== :sparkles: $x$ [^note]`',
  '',
  '```mermaid',
  'flowchart LR',
  '  A --> B',
  '```',
  '',
  '[^note]: First footnote paragraph.',
  '',
  '    Second paragraph with ==highlighted text==.',
  '',
  '    <script>window.__footnotePwned = true</script>',
  '',
  '    <a href="javascript:window.__footnotePwned=true">dangerous link</a>',
  '',
  '[^plain]: /ordinary-reference',
  ''
].join('\n');

const reload = async (page) => {
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForFunction(() => !!document.querySelector('#editor .monaco-editor'), {
    timeout: 30000
  });
  await sleep(1800);
};

const seed = async (page, mode) => {
  await page.evaluate(
    (markdown, storedMode) => {
      localStorage.clear();
      sessionStorage.clear();
      localStorage.setItem('markbeam:last_state', JSON.stringify({ v: markdown }));
      if (storedMode !== null) {
        localStorage.setItem('markbeam:markdown_mode', JSON.stringify({ v: storedMode }));
      }
    },
    FIXTURE,
    mode
  );
  await reload(page);
};

const paletteTitles = async (page) => {
  await page.click('#menu-button');
  await sleep(200);
  const titles = await page.$$eval('#palette-list .sheet__item', (items) =>
    items.map((item) => item.textContent.trim())
  );
  await page.keyboard.press('Escape');
  return titles;
};

const runPaletteCommand = async (page, title) => {
  await page.click('#menu-button');
  await sleep(150);
  const found = await page.evaluate((wanted) => {
    const button = [...document.querySelectorAll('#palette-list .sheet__item')].find(
      (item) => item.querySelector('span')?.textContent.trim() === wanted
    );
    if (button) {
      button.click();
      return true;
    }
    return false;
  }, title);
  await sleep(700);
  return found;
};

const readGfm = (page) =>
  page.evaluate(() => {
    const output = document.querySelector('#output');
    const references = [...output.querySelectorAll('[data-footnote-ref]')];
    const backReferences = [...output.querySelectorAll('[data-footnote-backref]')];
    const tasks = [...output.querySelectorAll('input[type="checkbox"]')];
    const dangerous = [...output.querySelectorAll('a')].find((link) =>
      link.textContent.includes('dangerous link')
    );
    const code = [...output.querySelectorAll('code')].find((element) =>
      element.textContent.includes('~~code~~')
    );

    return {
      tableCount: output.querySelectorAll('table').length,
      strikeCount: output.querySelectorAll('del').length,
      bareUrlLinked: [...output.querySelectorAll('a')].some(
        (link) => link.textContent === 'https://example.com/gfm'
      ),
      tasks: tasks.map((task) => ({ checked: task.checked, disabled: task.disabled })),
      editorCheckboxes: document.querySelectorAll('#edit input[type="checkbox"]').length,
      footnotes: output.querySelectorAll('section.footnotes[data-footnotes]').length,
      heading: (() => {
        const element = output.querySelector('#footnote-label');
        return element
          ? { text: element.textContent.trim(), className: element.className }
          : null;
      })(),
      references: references.map((link) => ({
        id: link.id,
        href: link.getAttribute('href'),
        describedBy: link.getAttribute('aria-describedby'),
        hasData: link.hasAttribute('data-footnote-ref'),
        tabIndex: link.tabIndex
      })),
      backReferences: backReferences.map((link) => ({
        href: link.getAttribute('href'),
        label: link.getAttribute('aria-label'),
        hasData: link.hasAttribute('data-footnote-backref'),
        tabIndex: link.tabIndex
      })),
      noteParagraphs: output.querySelectorAll('#footnote-note p').length,
      noteText: output.querySelector('#footnote-note')?.textContent || '',
      scriptCount: output.querySelectorAll('script').length,
      dangerousHref: dangerous?.getAttribute('href') ?? null,
      pwned: window.__footnotePwned === true,
      alert: {
        present: !!output.querySelector('.markdown-alert'),
        table: !!output.querySelector('.markdown-alert table'),
        strike: !!output.querySelector('.markdown-alert del'),
        highlight: !!output.querySelector('.markdown-alert mark'),
        emoji: output.querySelector('.markdown-alert')?.textContent.includes('✨') || false
      },
      math: !!output.querySelector('.math-inline .katex'),
      mermaid: !!output.querySelector('.mermaid svg'),
      code: code?.textContent || ''
    };
  });

const readFootnoteStyle = (page) =>
  page.evaluate(() => {
    const section = document.querySelector('.footnotes');
    const heading = document.querySelector('#footnote-label');
    const reference = document.querySelector('[data-footnote-ref]');
    if (!section || !heading || !reference) {
      return null;
    }
    const sectionStyle = getComputedStyle(section);
    const headingStyle = getComputedStyle(heading);
    reference.focus();
    const referenceStyle = getComputedStyle(reference);
    return {
      colour: sectionStyle.color,
      border: sectionStyle.borderTopColor,
      wrap: sectionStyle.overflowWrap,
      hiddenHeading: {
        position: headingStyle.position,
        width: headingStyle.width,
        height: headingStyle.height,
        overflow: headingStyle.overflow
      },
      focused: document.activeElement === reference,
      outline: referenceStyle.outlineStyle,
      outlineWidth: referenceStyle.outlineWidth
    };
  });

export const suite = {
  name: 'gfm modes',
  async run() {
    return withPage(async (page, errors) => {
      const checks = [];

      // No mode key is the backward-compatible path: existing users stay on GFM.
      await seed(page, null);
      const initial = await readGfm(page);

      checks.push({
        name: 'GFM is the default and renders tables, bare autolinks and strikethrough',
        pass: initial.tableCount >= 2 && initial.bareUrlLinked && initial.strikeCount >= 2,
        detail: `${initial.tableCount} tables, autolink ${initial.bareUrlLinked}, ${initial.strikeCount} strikes`
      });

      checks.push({
        name: 'checked and unchecked task items are disabled preview-only controls',
        pass:
          initial.tasks.length === 2 &&
          initial.tasks.every((task) => task.disabled) &&
          initial.tasks.some((task) => task.checked) &&
          initial.tasks.some((task) => !task.checked) &&
          initial.editorCheckboxes === 0,
        detail: `${initial.tasks.length} preview tasks, ${initial.editorCheckboxes} editor checkboxes`
      });

      checks.push({
        name: 'repeated and multiline footnotes render with references and back-references',
        pass:
          initial.footnotes === 1 &&
          initial.references.length === 3 &&
          initial.backReferences.length === 3 &&
          initial.noteParagraphs >= 2 &&
          initial.noteText.includes('Second paragraph'),
        detail: `${initial.references.length} refs, ${initial.backReferences.length} backrefs, ${initial.noteParagraphs} paragraphs`
      });

      const attributesSurvive =
        initial.references.every(
          (ref) =>
            ref.id.startsWith('footnote-ref-') &&
            ref.href?.startsWith('#footnote-') &&
            ref.describedBy === 'footnote-label' &&
            ref.hasData &&
            ref.tabIndex === 0
        ) &&
        initial.backReferences.every(
          (ref) =>
            ref.href?.startsWith('#footnote-ref-') &&
            ref.label?.startsWith('Back to reference') &&
            ref.hasData &&
            ref.tabIndex === 0
        );
      checks.push({
        name: 'footnote IDs, fragment links, data attributes and ARIA survive sanitization',
        pass: initial.references.length === 3 && attributesSurvive,
        detail: initial.references[0]
          ? `${initial.references[0].id} -> ${initial.references[0].href}`
          : 'no footnote reference'
      });

      checks.push({
        name: 'malicious footnote content is sanitized',
        pass:
          initial.scriptCount === 0 &&
          initial.dangerousHref === null &&
          initial.pwned === false,
        detail: `${initial.scriptCount} scripts, href ${initial.dangerousHref}, executed ${initial.pwned}`
      });

      checks.push({
        name: 'Markbeam extensions and code isolation work in GFM mode',
        pass:
          initial.alert.present &&
          initial.alert.table &&
          initial.alert.strike &&
          initial.alert.highlight &&
          initial.alert.emoji &&
          initial.math &&
          initial.mermaid &&
          initial.code.includes('~~code~~ ==code== :sparkles: $x$ [^note]'),
        detail: `alert/table ${initial.alert.table}, math ${initial.math}, Mermaid ${initial.mermaid}`
      });

      const styleBefore = await readFootnoteStyle(page);
      checks.push({
        name: 'footnotes have a hidden accessible heading, wrapping and a visible focus state',
        pass:
          initial.heading?.text === 'Footnotes' &&
          initial.heading.className.includes('sr-only') &&
          styleBefore?.hiddenHeading.position === 'absolute' &&
          styleBefore.hiddenHeading.width === '1px' &&
          styleBefore.hiddenHeading.height === '1px' &&
          styleBefore.hiddenHeading.overflow === 'hidden' &&
          styleBefore.wrap !== 'normal' &&
          styleBefore.focused &&
          styleBefore.outline !== 'none' &&
          styleBefore.outlineWidth !== '0px',
        detail: styleBefore
          ? `${styleBefore.hiddenHeading.width} heading, wrap ${styleBefore.wrap}, outline ${styleBefore.outline}`
          : 'footnote styles missing'
      });

      await page.click('#theme-button');
      await sleep(500);
      const styleAfter = await readFootnoteStyle(page);
      checks.push({
        name: 'footnote colours follow both themes',
        pass:
          !!styleBefore &&
          !!styleAfter &&
          (styleBefore.colour !== styleAfter.colour || styleBefore.border !== styleAfter.border),
        detail: styleBefore && styleAfter ? `${styleBefore.colour} -> ${styleAfter.colour}` : 'styles missing'
      });

      const initialTitles = await paletteTitles(page);
      checks.push({
        name: 'the palette offers the next mode',
        pass: initialTitles.some((title) => title.startsWith('Switch to CommonMark')),
        detail: initialTitles.find((title) => title.startsWith('Switch to')) || 'mode command missing'
      });

      const switched = await runPaletteCommand(page, 'Switch to CommonMark');
      const commonmark = await readGfm(page);
      const commonmarkStored = await page.evaluate(() => {
        try {
          return JSON.parse(localStorage.getItem('markbeam:markdown_mode')).v;
        } catch (error) {
          return null;
        }
      });
      const commonmarkToast = await page.$$eval('.toast', (items) =>
        items.map((item) => item.textContent.trim()).at(-1)
      );

      checks.push({
        name: 'switching to CommonMark re-renders immediately and persists the mode',
        pass:
          switched &&
          commonmarkStored === 'commonmark' &&
          commonmark.footnotes === 0 &&
          commonmark.tableCount === 0 &&
          commonmark.strikeCount === 0 &&
          commonmark.tasks.length === 0 &&
          !commonmark.bareUrlLinked,
        detail: `stored ${commonmarkStored}, ${commonmark.footnotes} footnotes, ${commonmark.tableCount} tables`
      });

      const commonmarkReference = await page.evaluate(() => {
        const link = [...document.querySelectorAll('#output a')].find(
          (element) => element.textContent === '^plain'
        );
        return link?.getAttribute('href') || null;
      });
      checks.push({
        name: 'footnote-shaped syntax follows normal reference-link parsing in CommonMark',
        pass: commonmarkReference === '/ordinary-reference',
        detail: commonmarkReference || 'ordinary reference link missing'
      });

      checks.push({
        name: 'the CommonMark confirmation toast names the active mode',
        pass: commonmarkToast === 'CommonMark mode',
        detail: commonmarkToast
      });

      checks.push({
        name: 'Markbeam extensions remain active and nested alerts follow CommonMark',
        pass:
          commonmark.alert.present &&
          !commonmark.alert.table &&
          !commonmark.alert.strike &&
          commonmark.alert.highlight &&
          commonmark.alert.emoji &&
          commonmark.math &&
          commonmark.mermaid &&
          commonmark.code.includes('~~code~~ ==code== :sparkles: $x$ [^note]'),
        detail: `alert/table ${commonmark.alert.table}, highlight ${commonmark.alert.highlight}, math ${commonmark.math}`
      });

      await reload(page);
      const persistedCommonmark = await readGfm(page);
      const persistedTitles = await paletteTitles(page);
      checks.push({
        name: 'CommonMark survives reload and the command title updates',
        pass:
          persistedCommonmark.footnotes === 0 &&
          persistedTitles.some((title) => title.startsWith('Switch to GitHub-Flavored Markdown')),
        detail:
          persistedTitles.find((title) => title.startsWith('Switch to')) || 'mode command missing'
      });

      const switchedBack = await runPaletteCommand(page, 'Switch to GitHub-Flavored Markdown');
      const restored = await readGfm(page);
      const restoredToast = await page.$$eval('.toast', (items) =>
        items.map((item) => item.textContent.trim()).at(-1)
      );
      checks.push({
        name: 'switching back restores GFM output and confirms the active mode',
        pass:
          switchedBack &&
          restored.footnotes === 1 &&
          restored.tableCount >= 2 &&
          restored.tasks.length === 2 &&
          restoredToast === 'GitHub-Flavored Markdown mode',
        detail: `${restored.footnotes} footnote section, toast ${restoredToast}`
      });

      await page.evaluate(() =>
        localStorage.setItem('markbeam:markdown_mode', JSON.stringify({ v: 'github' }))
      );
      await reload(page);
      const legacyFallback = await readGfm(page);

      await page.evaluate(() =>
        localStorage.setItem('markbeam:markdown_mode', '{not valid JSON')
      );
      await reload(page);
      const corruptFallback = await readGfm(page);
      const fallbackTitles = await paletteTitles(page);
      checks.push({
        name: 'corrupt and legacy stored values fall back to GFM',
        pass:
          legacyFallback.footnotes === 1 &&
          legacyFallback.tableCount >= 2 &&
          corruptFallback.footnotes === 1 &&
          corruptFallback.tableCount >= 2 &&
          fallbackTitles.some((title) => title.startsWith('Switch to CommonMark')),
        detail: `legacy ${legacyFallback.footnotes}/${legacyFallback.tableCount}, corrupt ${corruptFallback.footnotes}/${corruptFallback.tableCount}`
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
