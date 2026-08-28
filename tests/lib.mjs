import puppeteer from 'puppeteer-core';

export const CHROME =
  process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
export const URL = process.env.MARKBEAM_URL || 'http://localhost:5173/';

export async function withPage(fn, opts = {}) {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'shell' in opts ? opts.shell : true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1400,900'],
    protocolTimeout: 600000,
    defaultViewport: { width: 1400, height: 900 },
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
  try {
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForFunction(() => !!document.querySelector('#editor .monaco-editor'), { timeout: 30000 });
    return await fn(page, errors, browser);
  } finally {
    await browser.close();
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/*
 * Monaco renders spaces inside `.view-line` as non-breaking spaces, so raw textContent
 * never matches a plain-text needle. Normalising here is the difference between a check
 * that works and one that silently fails on text which is visibly present.
 */
export const editorText = async (page) => {
  const raw = await page.evaluate(() =>
    [...document.querySelectorAll('#editor .view-line')].map((l) => l.textContent).join('\n')
  );
  return raw.replace(/\s+/g, ' ').trim();
};

/*
 * Seed the document a suite wants open, then let the app adopt it on the next load.
 *
 * Since multiple documents landed, `markbeam:last_state` is a compatibility mirror rather
 * than the source of truth — the app reads the document index instead, and rewrites the
 * mirror from whatever it opened. Writing that key alone therefore seeds nothing: the app
 * had already built an index on the first load and simply overwrote it. Clearing the index
 * puts the profile back into the pre-multi-document shape, so the app's own migration
 * adopts this content, which is also the path a returning user takes.
 */
export const seedDocument = async (page, markdown, title = 'Untitled') => {
  await page.evaluate(
    ({ md, t }) => {
      Object.keys(localStorage)
        .filter(
          (key) =>
            key === 'markbeam:docs' ||
            key === 'markbeam:active_doc' ||
            key.startsWith('markbeam:doc:')
        )
        .forEach((key) => localStorage.removeItem(key));

      localStorage.setItem('markbeam:last_state', JSON.stringify({ v: md }));
      localStorage.setItem('markbeam:doc_title', JSON.stringify({ v: t }));
    },
    { md: markdown, t: title }
  );
};
