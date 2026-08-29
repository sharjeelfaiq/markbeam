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

      // ---------- claims the site makes about itself ----------

      /*
       * Advertising offline support requires actually having it.
       *
       * Written as an implication rather than "the word must be absent", because an honest
       * page still says "offline" — in "Markbeam does not work offline yet". A check on the
       * word would fail against a correct fix, and would have to be deleted the moment T33
       * makes offline real. This one keeps holding either way.
       *
       * The two conditions are a service worker and a manifest, because those are what turn
       * a second visit without a connection into a working app. Neither exists today, and
       * `src/editor/index.js` imports Monaco from a CDN, so every load needs the network.
       */
      const offlineSupport = await page.evaluate(async () => {
        const registrations =
          'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistrations() : [];
        return {
          serviceWorker: registrations.length > 0,
          manifest: !!document.querySelector('link[rel="manifest"]')
        };
      });

      const featureList = Array.isArray(ld.featureList) ? ld.featureList : [];
      const advertisesOffline = featureList.some((entry) => /offline/i.test(String(entry)));
      const reallyWorksOffline = offlineSupport.serviceWorker && offlineSupport.manifest;

      checks.push({
        name: 'structured data does not advertise offline support the app lacks',
        pass: !advertisesOffline || reallyWorksOffline,
        detail: `featureList offline claim=${advertisesOffline}, service worker=${offlineSupport.serviceWorker}, manifest=${offlineSupport.manifest}`
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

      // ---------- content a crawler, or a visitor without JavaScript, can read ----------

      /*
       * With scripting enabled the browser parses <noscript> children as raw text rather
       * than DOM, so `textContent` hands back the markup string. That is enough to assert
       * the content is there and substantial, without launching a second browser with
       * JavaScript disabled.
       *
       * Measured before this existed: with JS off the page rendered 0 headings and 109
       * characters, all of it button labels — a dead shell with no explanation of what the
       * site is.
       */
      const noscript = await page.evaluate(() => {
        /*
         * There is more than one <noscript>: the first is the no-JS stylesheet in <head>.
         * `querySelector('noscript')` returned that one — 478 characters of CSS and no
         * heading — so the check failed against a fallback that was in fact correct. Pick
         * the one that carries the content.
         */
        const el = [...document.querySelectorAll('noscript')].find((node) =>
          /<h1[s>]/i.test(node.textContent)
        );
        return el ? el.textContent : null;
      });

      checks.push({
        name: 'a noscript fallback explains the app to visitors without JavaScript',
        pass:
          typeof noscript === 'string' &&
          /<h1[\s>]/i.test(noscript) &&
          KEYWORD.test(noscript) &&
          noscript.replace(/<[^>]*>/g, '').trim().length >= 200,
        detail:
          noscript === null
            ? 'no noscript element'
            : `${noscript.replace(/<[^>]*>/g, '').trim().length} chars of prose, h1=${/<h1[\s>]/i.test(noscript)}`
      });

      // The landing page has to be reachable from the app, or nothing links to it.
      const aboutLink = await page.evaluate(() => {
        const link = [...document.querySelectorAll('footer a')].find((a) =>
          /about/i.test(a.getAttribute('href') || '')
        );
        return link ? { href: link.getAttribute('href'), text: link.textContent.trim() } : null;
      });

      checks.push({
        name: 'the footer links to the landing page',
        pass: !!aboutLink,
        detail: aboutLink ? JSON.stringify(aboutLink) : 'no link to /about in the footer'
      });

      /*
       * Adding markup to the shell is exactly how the full-viewport layout gets broken, so
       * this is checked at the narrow width rather than assumed.
       */
      await page.setViewport({ width: 375, height: 800 });
      await page.evaluate(() => new Promise((r) => setTimeout(r, 400)));
      const narrow = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        editorVisible: (document.querySelector('#editor')?.getBoundingClientRect().height || 0) > 100
      }));
      await page.setViewport({ width: 1400, height: 900 });

      checks.push({
        name: 'the app shell still fits at 375px with the fallback markup present',
        pass: narrow.overflow <= 0 && narrow.editorVisible,
        detail: `horizontal overflow ${narrow.overflow}px, editor visible ${narrow.editorVisible}`
      });

      // ---------- crawl plumbing ----------

      /*
       * Status is not evidence here. The dev server falls back to index.html for unknown
       * paths, so a missing robots.txt still answers 200 — with HTML. Both checks therefore
       * assert the content is the file it claims to be.
       */
      const fetchText = (target, path) =>
        target.evaluate(async (p) => {
          const response = await fetch(p, { cache: 'no-store' });
          return { status: response.status, body: await response.text() };
        }, path);

      const robots = await fetchText(page, '/robots.txt');
      checks.push({
        name: 'robots.txt is served and points crawlers at the sitemap',
        pass:
          robots.status === 200 &&
          !/<html/i.test(robots.body) &&
          /^\s*User-agent:\s*\*/im.test(robots.body) &&
          /^\s*Sitemap:\s*https:\/\/\S+sitemap\.xml\s*$/im.test(robots.body),
        detail: /<html/i.test(robots.body)
          ? 'served index.html — the file does not exist'
          : JSON.stringify(robots.body.replace(/\s+/g, ' ').trim().slice(0, 90))
      });

      const sitemap = await fetchText(page, '/sitemap.xml');
      const sitemapUrls = [...sitemap.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
      const parsedOk = await page.evaluate((xml) => {
        const doc = new DOMParser().parseFromString(xml, 'application/xml');
        return (
          !doc.querySelector('parsererror') &&
          doc.documentElement.tagName.toLowerCase() === 'urlset'
        );
      }, sitemap.body);

      checks.push({
        name: 'sitemap.xml parses as a urlset and lists both real pages',
        pass:
          sitemap.status === 200 &&
          !/<html/i.test(sitemap.body) &&
          parsedOk &&
          sitemapUrls.length === 2 &&
          sitemapUrls.some((u) => /\/$/.test(u)) &&
          // `/about`, not `/about.html`: cleanUrls redirects the .html form, and listing a
          // redirect source sends crawlers through a needless hop.
          sitemapUrls.some((u) => /\/about$/.test(u)),
        detail: /<html/i.test(sitemap.body)
          ? 'served index.html — the file does not exist'
          : `parses=${parsedOk}, urls=${JSON.stringify(sitemapUrls)}`
      });

      /*
       * The landing page itself. Checked last, because it navigates away from the app.
       *
       * `/about.html`, not `/about`: the clean URL is a Vercel behaviour and the Vite dev
       * server this suite runs against knows nothing about it, so testing `/about` would
       * fail locally for a reason that has nothing to do with the product.
       */
      const aboutResponse = await page.goto(new URL('about.html', page.url()).href, {
        waitUntil: 'domcontentloaded'
      });

      const about = await page.evaluate(() => {
        const h1 = document.querySelector('h1');
        const canonical = document.querySelector('link[rel="canonical"]');
        return {
          /*
           * The dev server falls back to index.html for unknown paths, so a 200 proves
           * nothing on its own — this check passed against a landing page that did not
           * exist, measuring the app instead. The app shell always carries #editor; a
           * static page never does. That absence is what makes the assertion real.
           */
          isApp: !!document.querySelector('#editor'),
          title: document.title,
          h1: h1 ? h1.textContent.trim() : null,
          canonical: canonical ? canonical.getAttribute('href') : null,
          bodyChars: document.body.innerText.replace(/\s+/g, ' ').trim().length,
          headings: document.querySelectorAll('h2, h3').length,
          backLink: [...document.querySelectorAll('a')].some(
            (a) => (a.getAttribute('href') || '') === '/'
          )
        };
      });

      checks.push({
        name: 'the landing page serves a real heading and substantial prose',
        pass:
          aboutResponse.status() === 200 &&
          !about.isApp &&
          KEYWORD.test(about.h1 || '') &&
          about.bodyChars >= 800 &&
          about.headings >= 2,
        detail: `HTTP ${aboutResponse.status()}, app-fallback=${about.isApp}, h1=${JSON.stringify(about.h1)}, ${about.bodyChars} chars, ${about.headings} subheadings`
      });

      checks.push({
        name: 'the landing page has its own title and canonical, and links back to the app',
        pass:
          !about.isApp &&
          KEYWORD.test(about.title || '') &&
          absoluteHttps(about.canonical) &&
          // Its own canonical, not the homepage's — otherwise the fallback satisfies this.
          //about/?$/.test(about.canonical || '') &&
          about.backLink,
        detail: `app-fallback=${about.isApp}, title=${JSON.stringify(about.title)}, canonical=${JSON.stringify(about.canonical)}, links home=${about.backLink}`
      });

      /*
       * The landing page has to say the same thing. Matching the limitation rather than the
       * absence of the word, for the reason above.
       */
      const offlineAnswer = await page.evaluate(() => {
        const heading = [...document.querySelectorAll('h3')].find((h) =>
          /offline/i.test(h.textContent)
        );
        return heading?.nextElementSibling?.textContent.replace(/\s+/g, ' ').trim() || null;
      });

      checks.push({
        name: 'the landing page answers the offline question honestly',
        /*
         * An implication, matching the JSON-LD check above, rather than a demand for one
         * particular answer.
         *
         * T31 wrote this as "the answer must be negative", which was correct while offline
         * did not work. T33 made it work, and the check then failed against a page telling
         * the truth — a test enforcing a claim that had become false in the other
         * direction.
         *
         * What holds in both directions: an affirmative answer is permitted only when a
         * worker and a manifest exist, and either answer has to say what it depends on.
         */
        pass:
          typeof offlineAnswer === 'string' &&
          /connection|network|online|first visit/i.test(offlineAnswer) &&
          (/\bno\b|\bnot yet\b|does not|doesn't/i.test(offlineAnswer) || reallyWorksOffline),
        detail:
          offlineAnswer === null
            ? 'no offline FAQ answer found'
            : `worksOffline=${reallyWorksOffline}, ${JSON.stringify(offlineAnswer.slice(0, 90))}`
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
