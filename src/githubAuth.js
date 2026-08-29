import {
  clearGithubToken,
  loadGithubRepo,
  loadGithubToken,
  saveGithubRepo,
  saveGithubToken
} from './storage.js';

/*
 * Where the GitHub credential lives, and for how long.
 *
 * Its own module because this is the only security-sensitive state in the app, and it should
 * be reviewable without reading the sync feature around it.
 *
 * **The default is memory only.** The token sits in a module-scope variable and dies with the
 * tab. Persisting it is opt-in, per device, because of what the app already does: a share
 * link is attacker-controlled Markdown that Markbeam renders in this origin. DOMPurify stands
 * between that and script execution, and if it ever fails, whatever is in `localStorage` is
 * readable. Nothing to read is a better position than something to read.
 *
 * The repository name is not a secret and is always remembered — retyping `owner/repo` every
 * session, to reach a repository the token already names, is friction that buys nothing.
 */

let token = null;
let repo = loadGithubRepo();
let persisted = false;

/*
 * A remembered token is adopted on load. `loadGithubToken()` returning null is the ordinary
 * case, and the one the app is designed around.
 */
let stored = loadGithubToken();
if (stored) {
  token = stored;
  persisted = true;
}
stored = null;

export const getToken = () => token;
export const getRepo = () => repo;
export const isConnected = () => Boolean(token && repo);
export const isPersisted = () => persisted;

/**
 * `remember` writes the token to this device. Anything else keeps it in memory for the tab.
 */
export const connect = (nextToken, nextRepo, { remember = false } = {}) => {
  token = nextToken || null;
  repo = nextRepo || null;

  if (repo) {
    saveGithubRepo(repo);
  }

  if (token && remember) {
    saveGithubToken(token);
    persisted = true;
  } else {
    /*
     * Clear rather than leave alone. Connecting without "remember" after having remembered
     * once must not silently keep the old token on disk — the user just told us not to.
     */
    clearGithubToken();
    persisted = false;
  }
};

/*
 * Forget the credential everywhere. Called on Disconnect, and on a 401: a token GitHub has
 * rejected is worth nothing and should not sit around looking like a working connection.
 */
export const disconnect = () => {
  token = null;
  persisted = false;
  clearGithubToken();
};
