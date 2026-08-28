import { withPage } from './lib.mjs';

/*
 * Search and social metadata (T27).
 *
 * The trap this suite is written against: a check that asserts a tag *exists* passes the
 * moment any version of it is present, including a useless one. `<title>Markbeam</title>`
 * is a tag; it is also invisible for every query a person actually types. So every check
 * below asserts the **content**.
 *
 * All of it is static markup in `index.html`, which matters more than it looks. Social
 * scrapers — Slack, Twitter, iMessage — do not execute JavaScript at all, so metadata
 * injected at runtime is metadata they never see. Asserting through the DOM is fine because
 * these tags are in the served HTML; it would not be fine if they were added by a module.
 */

const KEYWORD = /markdown/i;

const meta = (page, selector) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el ? el.getAttribute('content') || el.getAttribute('href') : null;
  }, selector);

const absoluteHttps = (value) => typeof value === 'string' && /^https:\/\/[^\s]+$/.test(value);

export const suite = {
  name: 'seo',
  async run() {
    return withPage(async (page, errors) => {
      const checks = [];

      // ---------- title ----------

      const title = await page.title();
      /*
       * The brand name alone is the failure being fixed, so it is named explicitly. A title
       * has to carry the words someone searches for: "markdown" plus what the thing is.
       */
      checks.push({
        name: 'the title carries the words people search for, not just the brand',
        pass:
          KEYWORD.test(title) &&
          /editor|preview|viewer/i.test(title) &&
          title.trim() !== 'Markbeam' &&
          title.length <= 65,
        detail: `${JSON.stringify(title)} (${title.length} chars)`
      });

      // ---------- description ----------

      const description = await meta(page, 'meta[name="description"]');
      checks.push({
        name: 'the description is a real sentence in the length search engines display',
        pass:
          typeof description === 'string' &&
          KEYWORD.test(description) &&
          description.length >= 50 &&
          description.length <= 160,
        detail:
          description === null
            ? 'absent'
            : `${description.length} chars: ${JSON.stringify(description.slice(0, 70))}`
      });

      // ---------- canonical ----------

      const canonical = await meta(page, 'link[rel="canonical"]');
      checks.push({
        name: 'a canonical URL is declared, absolute and https',
        pass: absoluteHttps(canonical),
        detail: canonical === null ? 'absent' : JSON.stringify(canonical)
      });

      // ---------- Open Graph and Twitter ----------

      const og = {};
      for (const key of ['title', 'description', 'type', 'url', 'image', 'site_name']) {
        og[key] = await meta(page, `meta[property="og:${key}"]`);
      }
      const twitterCard = await meta(page, 'meta[name="twitter:card"]');

      checks.push({
        name: 'Open Graph tags carry content, and og:url and og:image are absolute',
        pass:
          KEYWORD.test(og.title || '') &&
          (og.description || '').length >= 50 &&
          og.type === 'website' &&
          absoluteHttps(og.url) &&
          absoluteHttps(og.image),
        detail: `title=${JSON.stringify(og.title)}, type=${JSON.stringify(og.type)}, url=${JSON.stringify(og.url)}, image=${JSON.stringify(og.image)}`
      });

      checks.push({
        name: 'the Twitter card is the large-image variant, not a bare link',
        pass: twitterCard === 'summary_large_image',
        detail: twitterCard === null ? 'absent' : JSON.stringify(twitterCard)
      });

      /*
       * An og:image that 404s is worse than none: the scraper renders a broken card. The
       * dimensions matter too — 1200×630 is what the platforms crop to, and a favicon-sized
       * image gets shown as a thumbnail instead of a banner.
       */
      const image = og.image
        ? await page.evaluate(
            (url) =>
              new Promise((resolve) => {
                const img = new Image();
                img.onload = () =>
                  resolve({ ok: true, width: img.naturalWidth, height: img.naturalHeight });
                img.onerror = () => resolve({ ok: false, width: 0, height: 0 });
                // Same-origin path so this works against the dev server and production alike.
                img.src = new URL(url).pathname;
              }),
            og.image
          )
        : { ok: false, width: 0, height: 0 };

      checks.push({
        name: 'the og:image actually loads and is 1200x630',
        pass: image.ok && image.width === 1200 && image.height === 630,
        detail: image.ok ? `${image.width}x${image.height}` : 'did not load'
      });

      // ---------- structured data ----------

      const jsonLd = await page.evaluate(() => {
        const node = document.querySelector('script[type="application/ld+json"]');
        if (!node) {
          return { present: false };
        }
        try {
          return { present: true, data: JSON.parse(node.textContent) };
        } catch (error) {
          return { present: true, error: error.message };
        }
      });

      const ld = jsonLd.data || {};
      checks.push({
        name: 'JSON-LD parses and describes a SoftwareApplication with real fields',
        pass:
          jsonLd.present &&
          !jsonLd.error &&
          ld['@context'] === 'https://schema.org' &&
          ld['@type'] === 'SoftwareApplication' &&
          // Both fields, not `name || description`: the name is the brand and never
          // contains the keyword, so the short-circuit made this assert nothing useful.
          KEYWORD.test(`${ld.name || ''} ${ld.description || ''}`) &&
          absoluteHttps(ld.url) &&
          typeof ld.applicationCategory === 'string',
        detail: !jsonLd.present
          ? 'absent'
          : jsonLd.error
            ? `invalid JSON: ${jsonLd.error}`
            : `@type=${ld['@type']}, name=${JSON.stringify(ld.name)}, url=${JSON.stringify(ld.url)}`
      });

      /*
       * Guard, not evidence. New <head> tags are exactly the kind of edit that pushes the
       * pre-paint theme script below the app module or splits it out of the <head>, which
       * brings back the wrong-theme flash on reload.
       *
       * Ordering is asserted relative to the app's own module, not by absolute position:
       * the dev server injects `/@vite/client` ahead of everything, so `script[0]` is not
       * ours and never will be in development.
       */
      const themeScript = await page.evaluate(() => {
        const scripts = [...document.querySelectorAll('head script')];
        const themeIndex = scripts.findIndex(
          (s) => !s.src && s.textContent.includes('data-theme')
        );
        const appIndex = scripts.findIndex((s) => s.src && /main\.js/.test(s.src));
        return {
          count: scripts.length,
          themeIndex,
          appIndex,
          resolved: document.documentElement.getAttribute('data-theme')
        };
      });

      checks.push({
        name: 'the pre-paint theme script is inline in the head, ahead of the app module',
        pass:
          themeScript.themeIndex !== -1 &&
          themeScript.appIndex !== -1 &&
          themeScript.themeIndex < themeScript.appIndex &&
          /^(dark|light)$/.test(themeScript.resolved || ''),
        detail: `${themeScript.count} head scripts, theme at ${themeScript.themeIndex}, app at ${themeScript.appIndex}, theme=${themeScript.resolved}`
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
