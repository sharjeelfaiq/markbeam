/*
 * The GitLab Repository Files API, mirroring `src/github.js`.
 *
 * Same shape on purpose: list, read, write, and the same rules about where the credential is
 * allowed to appear. Two clients rather than one abstraction because the two APIs disagree on
 * almost everything that matters — how a project is identified, how a file path is encoded,
 * which verb creates versus updates, and where the branch is named. A shared wrapper would be
 * mostly branches.
 *
 * The token goes in `Authorization: Bearer`. GitLab also accepts a `PRIVATE-TOKEN` header, but
 * using the same header as the GitHub client means one rule to state and one place to check
 * it, and `CLAUDE.md` states that rule once for both.
 */

const API = 'https://gitlab.com/api/v4';
const DEFAULT_BRANCH = 'main';

/** `group/project` or `group/sub/project` — GitLab allows nesting, GitHub does not. */
export const parseProject = (value) => {
  const path = String(value || '').trim().replace(/^\/+|\/+$/g, '');
  if (!/^[\w.-]+(?:\/[\w.-]+)+$/.test(path)) {
    return null;
  }
  return { path };
};

/*
 * The project path is URL-encoded into the route because that is GitLab's own addressing
 * scheme. Note what is *not* there: the token. A project name in a URL is public information;
 * a credential in one reaches history, referrers and logs.
 */
let projectRoute = (project) => `/projects/${encodeURIComponent(project.path)}`;

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

/** Fit for a toast, and never containing the token — same rule as the GitHub client. */
let describeFailure = (status, payload) => {
  const detail = payload && typeof payload.message === 'string' ? payload.message : '';

  if (status === 401) {
    return 'GitLab rejected that token — check it has not expired';
  }
  if (status === 403) {
    return 'That token is not permitted to do this — it needs api or write_repository scope';
  }
  if (status === 404) {
    return 'Project not found, or the token cannot see it';
  }
  return detail ? `GitLab said: ${detail}` : `GitLab returned ${status}`;
};

let request = async (token, path, { method = 'GET', body } = {}) => {
  let response;
  try {
    response = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (error) {
    return { ok: false, reason: 'Could not reach GitLab' };
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

export const listMarkdown = async (token, project) => {
  const result = await request(token, `${projectRoute(project)}/repository/tree?per_page=100`);
  if (!result.ok) {
    return result;
  }

  const entries = Array.isArray(result.payload) ? result.payload : [];
  const files = entries
    // GitLab calls a file a "blob"; a directory is a "tree".
    .filter((entry) => entry && entry.type === 'blob' && /\.(md|markdown)$/i.test(entry.name || ''))
    .map((entry) => ({ name: entry.name, path: entry.path }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { ok: true, files };
};

export const readFile = async (token, project, path, branch = DEFAULT_BRANCH) => {
  const route = `${projectRoute(project)}/repository/files/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`;
  const result = await request(token, route);
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
   * `last_commit_id` is GitLab's answer to "has this file moved", and is reported as `id` to
   * match the GitHub client — see the note there. `content_sha256` would also work, but it
   * changes only when the bytes change, so two people writing identical text would look like
   * no conflict at all.
   */
  return { ok: true, text, id: payload.last_commit_id || null, path };
};

/*
 * GitLab splits create and update across two verbs and returns 400 rather than 404 when a POST
 * hits an existing file, so the update is tried first and the create is the fallback. The
 * reverse order would report "already exists" as the failure for the common case.
 */
export const writeFile = async (token, project, path, text, message, branch = DEFAULT_BRANCH) => {
  const route = `${projectRoute(project)}/repository/files/${encodeURIComponent(path)}`;
  const body = {
    branch,
    content: toBase64(text),
    encoding: 'base64',
    commit_message: message || `Update ${path} from Markbeam`
  };

  const updated = await request(token, route, { method: 'PUT', body });
  if (updated.ok) {
    return updated;
  }

  if (updated.status === 400 || updated.status === 404) {
    return request(token, route, { method: 'POST', body });
  }

  return updated;
};
