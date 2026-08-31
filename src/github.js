/*
 * The GitHub Contents API, and nothing else.
 *
 * No DOM, no storage, no token lifetime — `src/remoteAuth.js` owns the credential and hands
 * one in per call. Keeping those apart is what lets the token rules be checked by reading a
 * single small file rather than tracing the whole feature.
 *
 * Two rules here are security properties rather than style, and both are easy to break by
 * accident later:
 *
 * 1. **The token goes in the `Authorization` header, never in the URL.** A URL reaches
 *    browser history, the `Referer` header of anything it links to, and every log between
 *    here and GitHub. A header reaches none of those.
 * 2. **Errors never carry the token.** `describeFailure` builds messages from the status and
 *    GitHub's own text, so a toast or a console line cannot end up quoting the credential
 *    back at whoever is watching.
 */

const API = 'https://api.github.com';

/** `octocat/notes` → `{ owner, repo }`, or null when it is not that shape. */
export const parseRepo = (value) => {
  const match = /^\s*([\w.-]+)\s*\/\s*([\w.-]+?)(?:\.git)?\s*$/.exec(String(value || ''));
  if (!match) {
    return null;
  }
  return { owner: match[1], repo: match[2] };
};

/*
 * `btoa` handles Latin-1 only, so anything outside it — an em dash, an emoji, a diagram —
 * throws. Encoding to UTF-8 bytes first is what makes a document with real punctuation
 * survive the round trip.
 */
let toBase64 = (text) => {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
};

let fromBase64 = (value) => {
  const binary = atob(String(value || '').replace(/\s/g, ''));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
};

/** A message fit for a toast. Never includes the token — see the header comment. */
let describeFailure = (status, payload) => {
  const detail = payload && typeof payload.message === 'string' ? payload.message : '';

  if (status === 401) {
    return 'GitHub rejected that token — check it has not expired';
  }
  if (status === 403) {
    return detail.includes('rate limit')
      ? 'GitHub rate limit reached — try again shortly'
      : 'That token is not permitted to do this — it needs Contents write access';
  }
  if (status === 404) {
    return 'Repository not found, or the token cannot see it';
  }
  if (status === 409) {
    return 'The file changed on GitHub since it was last read';
  }
  return detail ? `GitHub said: ${detail}` : `GitHub returned ${status}`;
};

let request = async (token, path, { method = 'GET', body } = {}) => {
  let response;
  try {
    response = await fetch(`${API}${path}`, {
      method,
      headers: {
        // The credential travels here. Never as a query parameter.
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (error) {
    // Offline, DNS, or a blocked request. The error object is not surfaced — it can carry
    // the request URL, and there is nothing useful in it for the person reading the toast.
    return { ok: false, reason: 'Could not reach GitHub' };
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch (error) {
    payload = null;
  }

  if (!response.ok) {
    return { ok: false, status: response.status, reason: describeFailure(response.status, payload) };
  }

  return { ok: true, payload };
};

/**
 * Creates a Gist. `isPublic` is required rather than defaulted, because the difference is a
 * disclosure that cannot be withdrawn — a caller has to have decided.
 */
export const createGist = async (token, { filename, content, description, isPublic }) => {
  const result = await request(token, '/gists', {
    method: 'POST',
    body: {
      description: description || '',
      public: isPublic === true,
      files: { [filename || 'document.md']: { content } }
    }
  });

  if (!result.ok) {
    return result;
  }

  return { ok: true, url: result.payload?.html_url || null, id: result.payload?.id || null };
};

/** Markdown files at the top level of the repository, newest API shape, name-sorted. */
export const listMarkdown = async (token, { owner, repo }) => {
  const result = await request(token, `/repos/${owner}/${repo}/contents/`);
  if (!result.ok) {
    return result;
  }

  const entries = Array.isArray(result.payload) ? result.payload : [];
  const files = entries
    .filter((entry) => entry && entry.type === 'file' && /\.(md|markdown)$/i.test(entry.name || ''))
    .map((entry) => ({ name: entry.name, path: entry.path, sha: entry.sha }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { ok: true, files };
};

export const readFile = async (token, { owner, repo }, path) => {
  const result = await request(token, `/repos/${owner}/${repo}/contents/${encodeURI(path)}`);
  if (!result.ok) {
    return result;
  }

  const payload = result.payload || {};
  if (typeof payload.content !== 'string') {
    return { ok: false, reason: `“${path}” is not a file Markbeam can read` };
  }

  let text;
  try {
    text = fromBase64(payload.content);
  } catch (error) {
    return { ok: false, reason: `“${path}” could not be decoded as text` };
  }

  /*
   * `id` is the same field as `sha`, named for what auto-sync uses it for: "has the remote
   * moved since we last wrote". GitLab has no sha to offer, so the shared name is what lets
   * one code path serve both providers.
   */
  return { ok: true, text, sha: payload.sha, id: payload.sha, path: payload.path || path };
};

/*
 * Create or update. GitHub requires the current `sha` to replace a file and rejects one when
 * creating, so the existing file is looked up first — a 404 there is the ordinary "this is
 * new" case, not a failure.
 */
export const writeFile = async (token, target, path, text, message) => {
  const existing = await readFile(token, target, path);
  if (!existing.ok && existing.status && existing.status !== 404) {
    return existing;
  }

  const { owner, repo } = target;
  return request(token, `/repos/${owner}/${repo}/contents/${encodeURI(path)}`, {
    method: 'PUT',
    body: {
      message: message || `Update ${path} from Markbeam`,
      content: toBase64(text),
      ...(existing.ok && existing.sha ? { sha: existing.sha } : {})
    }
  });
};
