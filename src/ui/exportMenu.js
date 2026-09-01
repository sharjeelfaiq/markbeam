import { positionBelow } from './position.js';

/*
 * The Export menu (T66).
 *
 * The toolbar used to carry a PDF button while HTML, clipboard HTML, Word, Markdown and the
 * slide deck lived only in the command palette — five formats invisible to anyone who had not
 * pressed Ctrl+K.
 *
 * Modelled on the heading menu in `src/ui/formatToolbar.js` rather than invented: same
 * `role="menu"` element toggled with `hidden`, same `aria-expanded` on the button, same
 * Escape-and-outside-pointerdown closing, same positioner. Two menus that behave differently
 * would be a worse outcome than either one being slightly wrong.
 *
 * It knows nothing about exporting. `main.js` passes `[{ label, run }]`, which is the shape the
 * palette and the documents sheet already use.
 */

let button;
let menu;
let items = [];

export const isOpen = () => !!menu && !menu.hidden;

export const close = ({ restoreFocus = false } = {}) => {
  if (!menu || menu.hidden) {
    return;
  }
  menu.hidden = true;
  button?.setAttribute('aria-expanded', 'false');
  /*
   * Focus goes back to the button on Escape and after a choice. Without it a keyboard user is
   * left with focus on a hidden element, which browsers resolve by dropping them at the top of
   * the document — a long way from where they were.
   */
  if (restoreFocus) {
    button?.focus();
  }
};

export const open = ({ focus = 'first' } = {}) => {
  if (!menu || !button) {
    return;
  }
  menu.hidden = false;
  button.setAttribute('aria-expanded', 'true');
  // Positioned only once visible: a hidden element measures zero and would land in the corner.
  positionBelow(menu, button, 6);

  const buttons = Array.from(menu.querySelectorAll('[role="menuitem"]'));
  if (focus === 'last') {
    buttons[buttons.length - 1]?.focus();
  } else if (focus === 'first') {
    buttons[0]?.focus();
  }
};

export const toggle = () => (isOpen() ? close({ restoreFocus: true }) : open());

/** Arrow keys move between items; Home and End jump, as a menu is expected to. */
let moveFocus = (delta) => {
  const buttons = Array.from(menu.querySelectorAll('[role="menuitem"]'));
  const index = buttons.indexOf(document.activeElement);
  const next = (index + delta + buttons.length) % buttons.length;
  buttons[next]?.focus();
};

export const initExportMenu = ({ items: actions = [] } = {}) => {
  button = document.querySelector('#export-button');
  menu = document.querySelector('#export-menu');

  if (!button || !menu) {
    return;
  }

  items = actions;
  menu.textContent = '';

  for (const action of items) {
    const item = document.createElement('button');
    item.type = 'button';
    item.role = 'menuitem';
    item.textContent = action.label;
    item.addEventListener('click', () => {
      /*
       * Closed before the export runs, for the reason the documents sheet closes first: PDF
       * export takes seconds and repaints the page, and a menu still on screen through it looks
       * like the click was ignored.
       */
      close();
      action.run?.();
    });
    menu.appendChild(item);
  }

  button.addEventListener('click', () => toggle());

  button.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      open({ focus: 'first' });
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      open({ focus: 'last' });
    }
  });

  menu.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close({ restoreFocus: true });
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveFocus(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveFocus(-1);
    } else if (event.key === 'Tab') {
      // Tabbing out of a menu closes it; leaving it open behind other focus is a trap.
      close();
    }
  });

  document.addEventListener('pointerdown', (event) => {
    if (!isOpen()) {
      return;
    }
    if (!menu.contains(event.target) && !button.contains(event.target)) {
      close();
    }
  });

  window.addEventListener('resize', () => close());
};
