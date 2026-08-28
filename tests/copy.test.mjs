import { seedDocument, sleep, withPage } from './lib.mjs';

/*
 * Copy rendered HTML (T4, #39, #53).
 *
 * The real target is another application's paste handler — Outlook, Word, Gmail — which no
 * browser assertion can reach. What is testable is the markup we hand the clipboard, and
 * the two ways it can be wrong while still looking plausible:
 *
 * 1. Dark colours. Computed styles resolve to whatever theme is live, and the app is
 *    dark-first, so a naive implementation inlines a near-black table onto Word's white
 *    page. Hence the luminance check — checks for "border present" and "header shaded"
 *    both pass happily on a black-on-black table.
 * 2. `display: block`. The preview stylesheet sets it on tables so they scroll
 *    horizontally in-app. Inlined into the paste it stops being a grid: rows stack and the
 *    borders land in the wrong places.
 *
 * Clipboard access in headless Chrome is permission-gated, and granting it would make this
 * a test about permissions rather than about markup. So the write is intercepted instead,
 * the same instrument-before-app-code trick `pdf.test.mjs` uses on `toDataURL`.
 */

const INSTRUMENT = `
window.__clip = null;
window.__clipText = null;
const readItems = async (items) => {
  const out = {};
  for (const item of items) {
    for (const type of item.types) {
      out[type] = await (await item.getType(type)).text();
    }
  }
  return out;
};
navigator.clipboard.write = async (items) => { window.__clip = await readItems(items); };
navigator.clipboard.writeText = async (text) => { window.__clipText = text; };
`;

const TABLE_DOC = [
  '# Table test',
  '',
  '| Region | Revenue | Growth |',
  '| ------ | ------- | ------ |',
  '| North  | 1200    | 4%     |',
  '| South  | 900     | 11%    |',
  '',
  'Trailing paragraph.'
].join('\n');

/** Runs a palette command by its visible title. */
const runCommand = async (page, title) => {
  await page.click('#menu-button');
  await sleep(400);
  const found = await page.evaluate((wanted) => {
    const item = [...document.querySelectorAll('#palette-list .sheet__item')].find((b) =>
      b.textContent.includes(wanted)
    );
    if (item) {
      item.click();
      return true;
    }
    return false;
  }, title);
  await sleep(800);
  if (!found) {
    await page.keyboard.press('Escape');
    await sleep(200);
  }
  return found;
};

const seedAndReload = async (page, markdown) => {
  await seedDocument(page, markdown);
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForFunction(() => !!document.querySelector('#editor .monaco-editor'), {
    timeout: 30000
  });
  await sleep(1800);
};

/** rgb()/rgba() -> perceived luminance 0..255, or null when unparseable. */
const luminance = (colour) => {
  const match = /rgba?\(([^)]+)\)/.exec(colour || '');
  if (!match) {
    return null;
  }
  const [r, g, b] = match[1].split(',').map((n) => parseFloat(n));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/*
 * Reads the inline style declarations off the copied markup. Parsed in the browser with
 * DOMParser rather than by regex here: the assertions are about computed declarations, and
 * a regex over an attribute string would pass on markup no renderer would honour.
 */
const inspect = (page, html) =>
  page.evaluate((markup) => {
    const doc = new DOMParser().parseFromString(markup, 'text/html');
    const table = doc.querySelector('table');
    if (!table) {
      return { table: null };
    }
    const read = (el) => ({
      border: el.style.border || el.style.borderTopWidth || '',
      padding: el.style.padding || el.style.paddingTop || '',
      background: el.style.backgroundColor || '',
      textAlign: el.style.textAlign || '',
      fontWeight: el.style.fontWeight || '',
      display: el.style.display || ''
    });
    return {
      table: read(table),
      collapse: table.style.borderCollapse || '',
      width: table.style.width || '',
      overflow: table.style.overflow || '',
      headers: [...doc.querySelectorAll('th')].map(read),
      cells: [...doc.querySelectorAll('td')].map(read)
    };
  }, html);

export const suite = {
  name: 'copy html',
  async run() {
    const checks = [];

    await withPage(async (page, errors) => {
      await page.evaluateOnNewDocument(INSTRUMENT);
      await seedAndReload(page, TABLE_DOC);

      const themeBefore = await page.evaluate(() =>
        document.documentElement.getAttribute('data-theme')
      );

      const commandFound = await runCommand(page, 'Copy rendered HTML');
      checks.push({
        name: 'a Copy rendered HTML command exists in the palette',
        pass: commandFound,
        detail: commandFound ? 'found and clicked' : 'no such command'
      });

      const clip = await page.evaluate(() => window.__clip);
      const html = clip ? clip['text/html'] : null;

      checks.push({
        name: 'the clipboard receives a text/plain flavour alongside text/html',
        pass: !!clip && typeof clip['text/plain'] === 'string' && clip['text/plain'].length > 0,
        detail: clip ? `flavours: ${Object.keys(clip).join(', ')}` : 'nothing written'
      });

      const styles = html ? await inspect(page, html) : { table: null };

      const cells = styles.table ? [...(styles.headers || []), ...(styles.cells || [])] : [];
      const missing = cells.filter((c) => !c.border || !c.padding);
      checks.push({
        name: 'every th and td carries an inline border and padding',
        pass: cells.length > 0 && missing.length === 0,
        detail: styles.table
          ? `${cells.length} cells, ${missing.length} missing`
          : 'no table in the copied markup'
      });

      const headerBg = styles.headers && styles.headers[0] ? styles.headers[0].background : '';
      const cellBg = styles.cells && styles.cells[0] ? styles.cells[0].background : '';
      checks.push({
        name: 'the header row is shaded differently from body cells',
        pass: !!headerBg && headerBg !== cellBg,
        detail: `th ${headerBg || '(none)'} vs td ${cellBg || '(none)'}`
      });

      /*
       * The app is dark by default, so this is the check that catches an implementation
       * reading the live theme's tokens. A dark table passes every check above.
       */
      const shades = cells.map((c) => luminance(c.background)).filter((n) => n !== null);
      const darkest = shades.length ? Math.min(...shades) : null;
      checks.push({
        name: 'copied colours are light even though the app is dark',
        pass: darkest !== null && darkest > 180,
        detail:
          darkest === null
            ? 'no parseable background colours'
            : `theme=${themeBefore}, darkest inlined background luminance ${darkest.toFixed(0)}/255`
      });

      checks.push({
        name: 'the table is not pinned to display:block',
        pass: !!styles.table && !styles.table.display && !styles.width && !styles.overflow,
        detail: styles.table
          ? `display="${styles.table.display}" width="${styles.width}" overflow="${styles.overflow}"`
          : 'no table'
      });

      checks.push({
        name: 'border-collapse survives onto the table element',
        pass: styles.collapse === 'collapse',
        detail: `border-collapse="${styles.collapse}"`
      });

      const themeAfter = await page.evaluate(() =>
        document.documentElement.getAttribute('data-theme')
      );
      checks.push({
        name: 'the live theme is left exactly as it was',
        pass: themeAfter === themeBefore,
        detail: `${themeBefore} -> ${themeAfter}`
      });

      /*
       * Guards the existing Copy against collateral damage. Expected to pass before the
       * change as well — it is not evidence of the bug.
       */
      await page.evaluate(() => {
        window.__clipText = null;
      });
      await page.click('#copy-button');
      await sleep(600);
      const copiedText = await page.evaluate(() => window.__clipText);
      checks.push({
        name: 'the toolbar Copy button still copies Markdown source',
        pass: typeof copiedText === 'string' && copiedText.startsWith('# Table test'),
        detail: (copiedText || '(nothing)').slice(0, 32)
      });

      checks.push({
        name: 'no console errors',
        pass: errors.length === 0,
        detail: errors[0]
      });
    });

    /*
     * Fallback path: ClipboardItem is removed before app code runs, so the feature test
     * must fall back to writeText with the same markup.
     */
    await withPage(async (page) => {
      await page.evaluateOnNewDocument(`delete window.ClipboardItem;`);
      await page.evaluateOnNewDocument(INSTRUMENT);
      await seedAndReload(page, TABLE_DOC);

      await runCommand(page, 'Copy rendered HTML');
      const fallback = await page.evaluate(() => window.__clipText);
      checks.push({
        name: 'without ClipboardItem it falls back to writeText with the HTML',
        pass: typeof fallback === 'string' && fallback.includes('<table'),
        detail: (fallback || '(nothing)').slice(0, 40)
      });
    });

    return checks;
  }
};
