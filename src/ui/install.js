/*
 * The install banner and the iOS instructions (T60).
 *
 * DOM only; `src/install.js` decides *whether* to show this, and `main.js` connects the two.
 *
 * **Not a `<dialog>`, deliberately.** A modal on arrival blocks the editor to ask a favour,
 * which is the thing being avoided — the banner sits above the status bar, takes a click or
 * gets ignored, and never traps anybody. It is also why dismissing is a real button rather
 * than a close cross: "Not now" is an answer the policy records, and an X invites a reflex.
 */

let banner;
let help;
let acceptButton;
let dismissButton;

let handlers = { onAccept: () => {}, onDismiss: () => {}, onHelp: () => {} };

/*
 * iOS has no `beforeinstallprompt` and no programmatic install at all — Share → Add to Home
 * Screen is the only route, so the button opens instructions instead of a prompt.
 *
 * iPadOS reports itself as a Mac, so the touch-point count is what separates an iPad from a
 * desktop Safari. Getting this wrong in the harmless direction shows instructions to somebody
 * who cannot follow them; in the other direction it shows nothing at all to a visitor who has
 * no other way in, which is why the check leans towards showing them.
 */
export const isIosSafari = () => {
  const ua = navigator.userAgent || '';
  const iOS = /iP(hone|od|ad)/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const webkit = /WebKit/.test(ua) && !/CriOS|FxiOS|EdgiOS|Chrome/.test(ua);
  return iOS && webkit;
};

/** True inside the installed app, where offering to install it again is nonsense. */
export const isStandalone = () => {
  try {
    return (
      window.matchMedia?.('(display-mode: standalone)').matches === true ||
      window.navigator.standalone === true
    );
  } catch (error) {
    return false;
  }
};

export const initInstall = (options = {}) => {
  handlers = { ...handlers, ...options };

  banner = document.querySelector('#install');
  help = document.querySelector('#install-help');
  acceptButton = document.querySelector('#install-accept');
  dismissButton = document.querySelector('#install-dismiss');

  if (!banner) {
    return;
  }

  acceptButton?.addEventListener('click', () => handlers.onAccept());
  dismissButton?.addEventListener('click', () => {
    hide();
    handlers.onDismiss();
  });

  help?.querySelector('#install-help-close')?.addEventListener('click', () => closeHelp());
  // Clicking the backdrop closes; <dialog> reports those clicks on itself, as the sheets do.
  help?.addEventListener('click', (event) => {
    if (event.target === help) {
      closeHelp();
    }
  });
};

export const show = () => {
  if (!banner) {
    return false;
  }
  // The label has to match what the button will actually do, or it lies on one platform.
  if (acceptButton) {
    acceptButton.textContent = isIosSafari() ? 'How' : 'Install';
  }
  banner.hidden = false;
  return true;
};

export const hide = () => {
  if (banner) {
    banner.hidden = true;
  }
};

export const isVisible = () => !!banner && !banner.hidden;

export const openHelp = () => {
  if (!help) {
    return false;
  }
  if (!help.open) {
    help.showModal();
  }
  return true;
};

export const closeHelp = () => {
  if (help?.open) {
    help.close();
  }
};
