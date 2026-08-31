/*
 * Markbeam's service worker.
 *
 * Lives in `public/` and is copied verbatim, so it is plain ES5-ish script with no build
 * step and no imports — deliberately, because generating a precache manifest would need a
 * `vite.config.*` and this project documents having none.
 *
 * THE RULE THAT MATTERS: navigations are network-first. A cache-first `index.html` pins every
 * visitor to whatever build they first loaded, with no way to recover short of clearing site
 * data. A stale asset is a nuisance; a stale shell is a brick.
 *
 * There is no precache list. Caching happens on use, which:
 *   - needs no build-time asset manifest, so no Vite config;
 *   - behaves identically against the dev server (an unbundled module graph, ~70 requests)
 *     and production (~70 content-hashed chunks), where a hardcoded list would match neither;
 *   - avoids pulling the whole 6.5 MB build, most of which — jspdf, html2canvas-pro, katex,
 *     mermaid, cytoscape — a given visitor never touches.
 *
 * The honest consequence, which the site says out loud rather than burying: offline covers
 * what has already been used. Visit once online and it works offline; a Monaco language you
 * have never opened will not highlight, and PDF export needs one online run first.
 */

const VERSION = 'markbeam-v1';

/*
 * Cache-first is only ever correct for URLs whose contents cannot change:
 *   - `/assets/…` is content-hashed by Vite, so a changed file is a different URL;
 *   - the Monaco CDN is pinned to an exact version and served `immutable`, and it answers
 *     with CORS headers, so the response is inspectable rather than opaque.
 * Everything else goes network-first and falls back to the cache only when offline.
 */
const isImmutable = (url) =>
  url.origin === self.location.origin
    ? url.pathname.startsWith('/assets/')
    : url.host === 'cdn.jsdelivr.net';

/** Opaque responses cannot be checked for success, so they are never stored. */
const worthCaching = (response) =>
  response && response.ok && (response.type === 'basic' || response.type === 'cors');

const cacheFirst = async (request) => {
  const cached = await caches.match(request);
  if (cached) {
    return cached;
  }

  const response = await fetch(request);
  if (worthCaching(response)) {
    const cache = await caches.open(VERSION);
    cache.put(request, response.clone());
  }
  return response;
};

const networkFirst = async (request) => {
  try {
    const response = await fetch(request);
    if (worthCaching(response)) {
      const cache = await caches.open(VERSION);
      cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await caches.match(request);
    if (cached) {
      return cached;
    }

    /*
     * A navigation that was never cached under this exact URL — a share link with a fragment,
     * say — still deserves the app rather than the browser's error page.
     */
    if (request.mode === 'navigate') {
      const shell = await caches.match('/');
      if (shell) {
        return shell;
      }
    }

    throw error;
  }
};

self.addEventListener('install', (event) => {
  /*
   * Only the shell, and only so a first-time visitor who goes offline immediately still gets
   * something. Everything else arrives through use.
   */
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(['/']))
      .catch(() => undefined)
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  // Deleting every other cache is the kill switch: bump VERSION to evict a bad build.
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  if (request.method !== 'GET') {
    return;
  }

  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;
  const isMonacoCdn = url.host === 'cdn.jsdelivr.net';

  // Anything else — a third party we have not vetted — is left entirely alone.
  if (!sameOrigin && !isMonacoCdn) {
    return;
  }

  /*
   * Vercel's own endpoints (`/_vercel/speed-insights/…`, T62) are same-origin but are not this
   * app: caching the script would serve a stale one, and replaying telemetry from a cache
   * offline would report timings for a visit that is not happening. Left to the network, which
   * means it simply does not happen offline — the right answer for measurement.
   */
  if (sameOrigin && url.pathname.startsWith('/_vercel/')) {
    return;
  }

  event.respondWith(isImmutable(url) ? cacheFirst(request) : networkFirst(request));
});
