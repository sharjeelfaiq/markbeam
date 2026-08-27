import { withPage, sleep } from './lib.mjs';

/*
 * Storage migration.
 *
 * Content used to be persisted by a third-party library that hashed its keys (MD5 of
 * `namespace-key`), which made stored data unreadable and undebuggable. We now write
 * plain `markbeam:*` keys.
 *
 * Anyone who used the site before that change has documents under the old hashed keys.
 * This suite proves they are migrated rather than orphaned — that is the entire risk of
 * dropping the dependency.
 *
 * The old records embedded `{namespace, key, value}` as JSON, so migration finds them by
 * parsing stored values rather than by recomputing the hash. No MD5 implementation is
 * needed, which is why the dependency could be removed outright instead of vendored.
 */

const LEGACY_NAMESPACE = 'com.markdownlivepreview';

const seedLegacy = (page, records) =>
  page.evaluate(
    (ns, list) => {
      localStorage.clear();
      sessionStorage.clear();
      for (const [hashedKey, key, value] of list) {
        localStorage.setItem(
          hashedKey,
          JSON.stringify({
            namespace: ns,
            key,
            value,
            expire: new Date(2099, 1, 1).getTime()
          })
        );
      }
    },
    LEGACY_NAMESPACE,
    records
  );

const reload = async (page) => {
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForFunction(() => !!document.querySelector('#editor .monaco-editor'), {
    timeout: 30000
  });
  await sleep(1500);
};

export const suite = {
  name: 'storage',
  async run() {
    return withPage(async (page, errors) => {
      const checks = [];
      const marker = '# Recovered from the old storage format';

      // Plant records in the exact shape the old library produced, under
      // arbitrary hash-looking keys — migration must not depend on the hash value.
      await seedLegacy(page, [
        ['9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c', 'last_state', marker],
        ['a1b2c3d4e5f60718293a4b5c6d7e8f90', 'doc_title', 'Legacy Doc'],
        ['ffeeddccbbaa99887766554433221100', 'theme_settings', 'light']
      ]);

      await reload(page);

      const migrated = await page.evaluate(() => ({
        content: localStorage.getItem('markbeam:last_state'),
        title: localStorage.getItem('markbeam:doc_title'),
        theme: localStorage.getItem('markbeam:theme_settings'),
        keys: Object.keys(localStorage).filter((k) => k.startsWith('markbeam:'))
      }));

      checks.push({
        name: 'legacy document content is migrated',
        pass: typeof migrated.content === 'string' && migrated.content.includes(marker),
        detail: migrated.content ? 'found' : 'MISSING — user content would be lost'
      });

      checks.push({
        name: 'legacy document title is migrated',
        pass: typeof migrated.title === 'string' && migrated.title.includes('Legacy Doc'),
        detail: migrated.title
      });

      checks.push({
        name: 'legacy theme preference is migrated',
        pass: typeof migrated.theme === 'string' && migrated.theme.includes('light'),
        detail: migrated.theme
      });

      // The migrated document must actually be the one loaded into the editor.
      const shown = await page.evaluate(
        () => document.querySelector('#output')?.textContent || ''
      );
      checks.push({
        name: 'migrated document is the one loaded in the editor',
        pass: shown.includes('Recovered from the old storage format'),
        detail: shown.slice(0, 48)
      });

      // Second load must be a no-op, not a re-migration that clobbers newer edits.
      await page.evaluate(() =>
        localStorage.setItem('markbeam:last_state', JSON.stringify({ v: '# Edited after migrating' }))
      );
      await reload(page);
      const afterSecondLoad = await page.evaluate(() =>
        localStorage.getItem('markbeam:last_state')
      );
      checks.push({
        name: 'migration does not re-run and overwrite newer content',
        pass: typeof afterSecondLoad === 'string' && afterSecondLoad.includes('Edited after migrating'),
        detail: (afterSecondLoad || '').slice(0, 48)
      });

      // A clean browser must work with no legacy data present.
      await page.evaluate(() => {
        localStorage.clear();
        sessionStorage.clear();
      });
      await reload(page);
      const fresh = await page.evaluate(() => ({
        wrote: Object.keys(localStorage).filter((k) => k.startsWith('markbeam:')).length,
        rendered: (document.querySelector('#output')?.textContent || '').includes('Markbeam')
      }));
      checks.push({
        name: 'clean browser starts on the welcome document',
        pass: fresh.rendered && fresh.wrote > 0,
        detail: `${fresh.wrote} markbeam keys written`
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
