/*
 * When to offer to install Markbeam (T60).
 *
 * All of the policy, none of the DOM — the same split `src/autoSync.js` uses, and for the same
 * reason: "when do we interrupt someone?" is a question that should be answerable by reading
 * one short file rather than by tracing an event through a banner.
 *
 * The app has been installable since T33 — manifest, icons, a service worker — and said so
 * nowhere. Chrome removed its own mini-infobar years ago, so on most browsers the only signal
 * is an address-bar icon nobody looks at, and on iOS there is none at all.
 *
 * **The offer is earned, not automatic.** A prompt on arrival is the pattern browsers stopped
 * shipping, and it asks someone to install a tool they have not yet used. So it waits for one
 * of three signals that the visitor is actually writing, and it takes no for an answer.
 */

/** Characters typed in this session before the visitor counts as engaged. */
const ENGAGED_CHARS = 40;

/** Or this long with the tab in front of them. */
export const ENGAGED_MS = 45000;

/*
 * Or simply having come back. A second visit is the strongest signal of the three — nobody
 * returns to an editor by accident — which is why it needs no typing behind it.
 */
const RETURNING_VISITS = 2;

/*
 * Backoff, in days, indexed by how many times the offer has already been refused. Three
 * refusals is an answer, so the third entry is "never ask again".
 */
const BACKOFF_DAYS = [14, 90];
const DAY_MS = 24 * 60 * 60 * 1000;

const EMPTY = { visits: 0, dismissals: 0, lastDismissedAt: 0, installedAt: 0 };

/** Tolerates anything localStorage hands back, including a shape written by an older build. */
const normalise = (state) => {
  const value = state && typeof state === 'object' ? state : {};
  return {
    visits: Number(value.visits) || 0,
    dismissals: Number(value.dismissals) || 0,
    lastDismissedAt: Number(value.lastDismissedAt) || 0,
    installedAt: Number(value.installedAt) || 0
  };
};

export const createInstallPrompt = ({
  now = () => Date.now(),
  loadState = () => EMPTY,
  saveState = () => {},
  isStandalone = () => false
} = {}) => {
  let state = normalise(loadState());
  let typed = 0;
  let elapsed = false;
  /*
   * One offer per session. Without it, every later engagement signal — a keystroke after the
   * 45s timer, switching documents — re-opens a banner the visitor has already seen, which is
   * the nagging this whole file exists to avoid.
   */
  let offered = false;

  const persist = () => saveState(state);

  /*
   * A dismissal is remembered as a count *and* a date, because the count alone cannot express
   * "ask again later" and the date alone cannot express "they have said no three times".
   */
  const withinBackoff = () => {
    if (!state.dismissals) {
      return false;
    }
    const days = BACKOFF_DAYS[state.dismissals - 1];
    if (days === undefined) {
      return true; // refused often enough; stop asking entirely
    }
    return now() - state.lastDismissedAt < days * DAY_MS;
  };

  return {
    /** Counted once per load; the app calls this after the editor is up. */
    noteVisit() {
      state.visits += 1;
      persist();
    },

    noteEdit(characters) {
      typed += Math.max(0, Number(characters) || 0);
    },

    /** The 45s signal, delivered by whoever owns the timer. */
    tick() {
      elapsed = true;
    },

    /*
     * The whole decision, in one place and in this order: never when it is pointless (already
     * installed, or running *inside* the installed window), never when it has been refused,
     * and otherwise only once something says the visitor is actually using the editor.
     */
    shouldOffer() {
      if (offered || state.installedAt || isStandalone()) {
        return false;
      }
      if (withinBackoff()) {
        return false;
      }
      return typed >= ENGAGED_CHARS || elapsed || state.visits >= RETURNING_VISITS;
    },

    recordOffered() {
      offered = true;
    },

    recordDismissed() {
      state.dismissals += 1;
      state.lastDismissedAt = now();
      persist();
    },

    recordInstalled() {
      state.installedAt = now();
      persist();
    },

    /** For the palette command, which must be able to say "you already have it". */
    isInstalled() {
      return !!state.installedAt || isStandalone();
    },

    /** Test and debug seam; never used to make a decision. */
    snapshot() {
      return { ...state, typed, elapsed, offered };
    }
  };
};
