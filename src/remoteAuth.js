import {
  clearProviderToken,
  loadProviderRepo,
  loadProviderToken,
  saveProviderRepo,
  saveProviderToken
} from './storage.js';

/*
 * Where remote credentials live, and for how long.
 *
 * Replaces the single-slot `githubAuth.js` from T37. The rules are unchanged and still the
 * only security-sensitive state in the app; what changed is that there are now two of them.
 *
 * **One slot per provider, not one slot.** With a single credential, connecting GitLab would
 * silently sign you out of GitHub — and the only way to find out is to try to save and be
 * asked to connect again, long after the connection was lost. Keeping them apart is the whole
 * of T48's "coexist without one clobbering the other".
 *
 * **Memory by default**, per provider. A token reaches `localStorage` only when the user ticks
 * *remember on this device*, because `readSharedPayload()` renders attacker-controlled
 * Markdown in this origin and DOMPurify is the only thing between that and script execution.
 * Nothing to read is a better position than something to read.
 *
 * The project or repository name is not a secret and is always remembered; retyping
 * `owner/repo` every session buys nothing.
 */

export const PROVIDERS = ['github', 'gitlab'];

let state = {};

for (const provider of PROVIDERS) {
  const stored = loadProviderToken(provider);
  state[provider] = {
    token: stored || null,
    repo: loadProviderRepo(provider),
    persisted: Boolean(stored)
  };
}

let active = PROVIDERS.find((provider) => state[provider].token && state[provider].repo) || 'github';

let slot = (provider) => state[provider] || state.github;

export const getActiveProvider = () => active;
export const setActiveProvider = (provider) => {
  if (PROVIDERS.includes(provider)) {
    active = provider;
  }
  return active;
};

export const getToken = (provider = active) => slot(provider).token;
export const getRepo = (provider = active) => slot(provider).repo;
export const isPersisted = (provider = active) => slot(provider).persisted;
export const isConnected = (provider = active) =>
  Boolean(slot(provider).token && slot(provider).repo);

/** `remember` writes the token to this device. Anything else keeps it for the tab only. */
export const connect = (provider, token, repo, { remember = false } = {}) => {
  if (!PROVIDERS.includes(provider)) {
    return;
  }

  state[provider].token = token || null;
  state[provider].repo = repo || null;
  active = provider;

  if (repo) {
    saveProviderRepo(provider, repo);
  }

  if (token && remember) {
    saveProviderToken(provider, token);
    state[provider].persisted = true;
  } else {
    /*
     * Cleared rather than left alone: connecting without "remember" after having remembered
     * once must not keep the old token on disk — the user just said not to. Only this
     * provider's token is touched.
     */
    clearProviderToken(provider);
    state[provider].persisted = false;
  }
};

/*
 * Forgets one provider. Called on Disconnect and on a 401: a token the server has rejected is
 * worth nothing and must not sit there looking like a working connection. The other provider
 * is deliberately untouched — a rejected GitLab token says nothing about a GitHub one.
 */
export const disconnect = (provider = active) => {
  if (!PROVIDERS.includes(provider)) {
    return;
  }
  state[provider].token = null;
  state[provider].persisted = false;
  clearProviderToken(provider);
};
