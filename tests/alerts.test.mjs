import { seedDocument, sleep, withPage } from './lib.mjs';

/*
 * GitHub alert callouts (#127).
 *
 * `> [!NOTE]` and friends used to render as plain blockquotes. The CSS for them was
 * already vendored in github-markdown-*.css; only the renderer was missing.
 *
 * Two checks here are doing more work than they look:
 *
 * - The border colour comparison. Class names alone can all be correct while the
 *   callouts still render as identical grey boxes, if our markup does not match what the
 *   vendored stylesheet selects. Distinct computed colours prove the CSS actually binds.
 * - The icon check. Rendered HTML passes through DOMPurify before reaching the DOM, and
 *   `viewBox` casing is a known hazard when SVG is parsed in an HTML context. If this
 *   fails, the fix is a CSS-drawn glyph — not a loosened sanitiser.
 */

const TYPES = [
  { key: 'note', label: 'Note', body: 'Useful information a reader should notice.' },
  { key: 'tip', label: 'Tip', body: 'An optional shortcut worth knowing.' },
  { key: 'important', label: 'Important', body: 'Crucial detail for the task at hand.' },
  { key: 'warning', label: 'Warning', body: 'Urgent content needing attention.' },
  { key: 'caution', label: 'Caution', body: 'Advises about risks or negative outcomes.' }
];

const FIXTURE = [
  '# Alerts',
  '',
  ...TYPES.flatMap((t) => [`> [!${t.key.toUpperCase()}]`, `> ${t.body}`, '']),
  '> An ordinary blockquote that must stay a blockquote.',
  '',
  '> Outer quote.',
  '>',
  '>> Nested quote inside it.',
  '',
  '> [!NOTE] Marker sharing its line is not an alert on GitHub either.',
  ''
].join('\n');

const seedAndReload = async (page, markdown) => {
  await seedDocument(page, markdown);
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForFunction(() => !!document.querySelector('#editor .monaco-editor'), {
    timeout: 30000
  });
  await sleep(2000);
};

const readAlerts = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('#output .markdown-alert')].map((el) => {
      const title = el.querySelector('.markdown-alert-title');
      const svg = title ? title.querySelector('svg') : null;
      return {
        classes: [...el.classList],
        title: title ? title.textContent.trim() : null,
        hasIcon: !!svg,
        // getAttribute preserves original casing; a mangled viewBox reads null here
        viewBox: svg ? svg.getAttribute('viewBox') : null,
        borderColor: getComputedStyle(el).borderLeftColor,
        text: el.textContent
      };
    })
  );

export const suite = {
  name: 'alerts',
  async run() {
    return withPage(async (page, errors) => {
      const checks = [];

      await seedAndReload(page, FIXTURE);
      const alerts = await readAlerts(page);

      checks.push({
        name: 'all five alert types render as callouts',
        pass: alerts.length === 5,
        detail: `${alerts.length} of 5`
      });

      const missingClass = TYPES.filter(
        (t, i) => !alerts[i] || !alerts[i].classes.includes(`markdown-alert-${t.key}`)
      ).map((t) => t.key);
      checks.push({
        name: 'each alert carries its own type class',
        pass: missingClass.length === 0,
        detail: missingClass.length ? `missing: ${missingClass.join(', ')}` : 'all present'
      });

      const wrongTitle = TYPES.filter(
        (t, i) => !alerts[i] || alerts[i].title !== t.label
      ).map((t, i) => `${t.label}≠${alerts[i] ? alerts[i].title : 'none'}`);
      checks.push({
        name: 'titles read Note / Tip / Important / Warning / Caution',
        pass: wrongTitle.length === 0,
        detail: wrongTitle.length ? wrongTitle.join(', ') : 'all correct'
      });

      const noIcon = alerts.filter((a) => !a.hasIcon).length;
      const badViewBox = alerts.filter((a) => a.hasIcon && !a.viewBox).length;
      checks.push({
        name: 'icons survive DOMPurify with viewBox intact',
        pass: alerts.length > 0 && noIcon === 0 && badViewBox === 0,
        detail: `${noIcon} missing icon, ${badViewBox} lost viewBox`
      });

      const missingBody = TYPES.filter((t, i) => !alerts[i] || !alerts[i].text.includes(t.body));
      checks.push({
        name: 'alert body content renders inside the callout',
        pass: missingBody.length === 0,
        detail: missingBody.length ? `missing body: ${missingBody.map((t) => t.key).join(', ')}` : 'all present'
      });

      // Distinct colours prove the vendored stylesheet binds to our markup, rather than
      // the classes merely being present on unstyled boxes.
      const colours = new Set(alerts.map((a) => a.borderColor));
      checks.push({
        name: 'each type gets its own border colour from the vendored CSS',
        pass: colours.size >= 4,
        detail: `${colours.size} distinct colours: ${[...colours].join(' | ')}`
      });

      const quotes = await page.evaluate(() => {
        const plain = [...document.querySelectorAll('#output blockquote')];
        return {
          plainCount: plain.length,
          plainKept: plain.some((b) => b.textContent.includes('ordinary blockquote')),
          nested: !!document.querySelector('#output blockquote blockquote'),
          inlineMarkerNotAnAlert: plain.some((b) =>
            b.textContent.includes('Marker sharing its line')
          )
        };
      });

      checks.push({
        name: 'an ordinary blockquote is still a blockquote',
        pass: quotes.plainKept,
        detail: `${quotes.plainCount} blockquotes`
      });
      checks.push({
        name: 'nested blockquotes are unaffected',
        pass: quotes.nested
      });
      checks.push({
        name: 'a marker sharing its line is not treated as an alert',
        pass: quotes.inlineMarkerNotAnAlert,
        detail: 'matches GitHub behaviour'
      });

      // ---- the other theme ----
      const darkColours = alerts.map((a) => a.borderColor).join('|');
      await page.click('#theme-button');
      await sleep(900);
      const afterTheme = await readAlerts(page);
      checks.push({
        name: 'alert colours follow the theme',
        pass:
          afterTheme.length === 5 && afterTheme.map((a) => a.borderColor).join('|') !== darkColours,
        detail: afterTheme.length ? afterTheme[0].borderColor : 'no alerts'
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
