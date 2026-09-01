import { editorText, seedDocument, sleep, withPage, ready } from './lib.mjs';

/*
 * Editing a Markdown table (T50).
 *
 * Two halves, deliberately. The awkward part — splitting cells, re-escaping pipes, padding
 * columns — is pure and checked directly in Node, because driving it through Monaco would
 * hide which of the two broke. The palette commands then get one browser pass to prove they
 * reach a real document.
 *
 * **The pipe rules are the substance.** GFM wants a literal pipe written `\|` *even inside a
 * code span*, so `` `a|b` `` is two cells. A round trip that quietly loses the backslash, or
 * adds a second one each time, corrupts the table a little more on every edit — which is the
 * failure worth a test rather than "does a row get added".
 */

const TABLE = [
  '| Command | Does |',
  '| --- | --- |',
  '| `a\\|b` | a pipe in code |',
  '| plain | nothing |'
];

const DOCUMENT = `# Tables\n\n${TABLE.join('\n')}\n\nAfter.\n`;

const boot = async (page) => {
  await ready(page);
};

const runCommand = async (page, needle) => {
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
  const clicked = await page.evaluate((text) => {
    const item = [...document.querySelectorAll('#palette .sheet__item')].find((el) =>
      el.textContent.toLowerCase().includes(text.toLowerCase())
    );
    if (!item) return false;
    item.click();
    return true;
  }, needle);
  if (!clicked) {
    await page.keyboard.press('Escape');
  }
  await sleep(500);
  return clicked;
};

export const suite = {
  name: 'table editor',
  async run() {
    const checks = [];

    // ---------- the pure half ----------

    let table = null;
    let loadError = null;
    try {
      table = await import('../src/markdown/table.js');
    } catch (error) {
      loadError = error.message;
    }

    const gated = (name, fn) => {
      if (!table) {
        checks.push({ name, pass: false, detail: `no table module: ${loadError}` });
        return;
      }
      try {
        checks.push({ name, ...fn() });
      } catch (error) {
        checks.push({ name, pass: false, detail: `threw: ${error.message}` });
      }
    };

    gated('an escaped pipe is one cell, not two', () => {
      const cells = table.splitCells('| `a\\|b` | second |');
      return { pass: cells.length === 2 && cells[0] === '`a|b`', detail: JSON.stringify(cells) };
    });

    gated('an unescaped pipe splits, even inside backticks', () => {
      // GFM's rule, and it surprises people: the code span does not protect the pipe.
      const cells = table.splitCells('| `a|b` | second |');
      return { pass: cells.length === 3, detail: JSON.stringify(cells) };
    });

    gated('a cell containing a pipe survives a round trip unchanged', () => {
      const parsed = table.parseTable(TABLE);
      const out = table.formatTable(parsed);
      const reparsed = table.parseTable(out);
      return {
        pass: reparsed.rows[0][0] === '`a|b`' && /\\\|/.test(out[2]) && !/\\\\\|/.test(out[2]),
        detail: out[2]
      };
    });

    gated('the source comes back padded rather than ragged', () => {
      const out = table.formatTable(table.parseTable(['|a|b|', '|-|-|', '|longer cell|c|']));
      const widths = out.map((line) => line.length);
      return { pass: new Set(widths).size === 1, detail: JSON.stringify(out) };
    });

    gated('a row can be added and removed', () => {
      const parsed = table.parseTable(TABLE);
      const added = table.addRow(parsed, 0);
      const removed = table.removeRow(added, 1);
      return {
        pass: added.rows.length === parsed.rows.length + 1 && removed.rows.length === parsed.rows.length,
        detail: `${parsed.rows.length} -> ${added.rows.length} -> ${removed.rows.length}`
      };
    });

    gated('a column can be added and removed across every row', () => {
      const parsed = table.parseTable(TABLE);
      const added = table.addColumn(parsed, 0);
      const widthsEven =
        added.header.length === parsed.header.length + 1 &&
        added.align.length === added.header.length &&
        added.rows.every((row) => row.length === added.header.length);
      const removed = table.removeColumn(added, 1);
      return {
        pass: widthsEven && removed.header.length === parsed.header.length,
        detail: `header ${added.header.length}, rows ${added.rows.map((r) => r.length).join(',')}`
      };
    });

    gated('the last column cannot be removed, since that is not a table', () => {
      const one = table.parseTable(['| only |', '| --- |', '| a |']);
      return { pass: table.removeColumn(one, 0).header.length === 1, detail: 'refused' };
    });

    gated('alignment cycles and is re-emitted as a delimiter', () => {
      const parsed = table.parseTable(TABLE);
      const centred = table.cycleAlign(table.cycleAlign(parsed, 0), 0);
      const out = table.formatTable(centred);
      return { pass: /^\|\s*:-+:\s*\|/.test(out[1]), detail: out[1] };
    });

    gated('a run of lines with pipes is not mistaken for a table', () => {
      const lines = ['a | b', 'c | d', 'e | f'];
      return { pass: table.findTableAt(lines, 1) === null, detail: 'no delimiter row, so not a table' };
    });

    gated('the table under the cursor is the one found', () => {
      const lines = [...TABLE, '', 'Between.', '', '| x | y |', '| --- | --- |', '| 1 | 2 |'];
      // TABLE occupies 0-3; the blank, 'Between.' and blank are 4-6, so the second table is 7-9.
      const found = table.findTableAt(lines, 8);
      return {
        pass: !!found && found.start === 7 && found.end === 9,
        detail: JSON.stringify(found)
      };
    });

    // ---------- the palette half ----------

    await withPage(async (page, errors) => {
      await seedDocument(page, DOCUMENT, 'Tables');
      await page.reload({ waitUntil: 'networkidle2' });
      await boot(page);

      /*
       * Driven with real keys. Dispatching a synthetic mousedown on a `.view-line` does not
       * move Monaco's cursor, so the commands correctly reported "put the cursor in a table
       * first" and nothing changed — a test artefact that looks exactly like a broken feature.
       *
       * The document is: 1 `# Tables`, 2 blank, 3 header, 4 delimiter, 5 and 6 data rows.
       */
      await page.click('#editor');
      await page.keyboard.down('Control');
      await page.keyboard.press('Home');
      await page.keyboard.up('Control');
      for (let i = 0; i < 4; i += 1) {
        await page.keyboard.press('ArrowDown');
      }
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowRight');
      await sleep(300);

      const before = await editorText(page);
      const added = await runCommand(page, 'add row');
      await sleep(400);
      const after = await editorText(page);

      checks.push({
        name: 'a palette command adds a row to the table under the cursor',
        pass: added === true && after !== before,
        detail: added ? `changed=${after !== before}` : 'no add-row command'
      });

      const addedColumn = await runCommand(page, 'add column');
      await sleep(400);
      const withColumn = await editorText(page);

      checks.push({
        name: 'and a column, without disturbing the text around the table',
        pass: addedColumn === true && withColumn !== after && /After\./.test(withColumn),
        detail: addedColumn ? withColumn.slice(0, 90) : 'no add-column command'
      });

      checks.push({ name: 'no console errors', pass: errors.length === 0, detail: errors[0] });
    });

    return checks;
  }
};
