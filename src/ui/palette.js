/*
 * Command palette (Ctrl/Cmd+K).
 *
 * Also the app's shortcut registry: every command declares its own keybinding, so the
 * palette and the global key handler can never drift apart — there is one list.
 */

let commands = [];
let filtered = [];
let selectedIndex = 0;

let dialog;
let input;
let list;

export const isMac = () =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '');

/** 'mod+k' -> '⌘K' or 'Ctrl+K' */
export const formatKeys = (keys) => {
  if (!keys) {
    return '';
  }
  return keys
    .split('+')
    .map((part) => {
      if (part === 'mod') {
        return isMac() ? '⌘' : 'Ctrl';
      }
      if (part === 'shift') {
        return isMac() ? '⇧' : 'Shift';
      }
      return part.length === 1 ? part.toUpperCase() : part;
    })
    .join(isMac() ? '' : '+');
};

let matches = (command, query) => {
  if (!query) {
    return true;
  }
  return `${command.title} ${command.hint || ''}`.toLowerCase().includes(query.toLowerCase());
};

let render = () => {
  if (!list) {
    return;
  }

  list.textContent = '';

  if (filtered.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'sheet__empty';
    empty.textContent = 'No matching commands';
    list.appendChild(empty);
    return;
  }

  filtered.forEach((command, index) => {
    const item = document.createElement('li');

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sheet__item';
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', String(index === selectedIndex));

    const label = document.createElement('span');
    label.textContent = command.title;
    button.appendChild(label);

    if (command.keys) {
      const keys = document.createElement('span');
      keys.className = 'sheet__keys';
      keys.textContent = formatKeys(command.keys);
      button.appendChild(keys);
    }

    button.addEventListener('click', () => {
      close();
      command.run();
    });

    item.appendChild(button);
    list.appendChild(item);
  });
};

let applyFilter = () => {
  const query = input ? input.value : '';
  filtered = commands.filter((command) => matches(command, query));
  selectedIndex = 0;
  render();
};

export const close = () => {
  if (dialog && dialog.open) {
    dialog.close();
  }
};

export const open = () => {
  if (!dialog || dialog.open) {
    return;
  }
  input.value = '';
  applyFilter();
  dialog.showModal();
  input.focus();
};

export const toggle = () => (dialog && dialog.open ? close() : open());

/*
 * Global keybindings. Ignores keystrokes typed into an input so ⌘S in the title field
 * behaves normally — except for the palette itself, which must always be reachable.
 *
 * This handler covers the editor too. The one key it cannot see there is ⌘K, because
 * Monaco stops the keydown from reaching `document` for keys it binds itself — so the
 * editor registers its own ⌘K binding straight onto `toggle`. See the comment in
 * `src/editor/index.js`.
 */
let handleGlobalKeys = (event) => {
  const mod = isMac() ? event.metaKey : event.ctrlKey;
  if (!mod) {
    return;
  }

  const target = event.target;

  /*
   * Monaco's hidden input is a <textarea>, so a tag-name test alone classifies the editor
   * as a form field and drops every shortcut while the user is writing — the only time
   * they are wanted. The editor is not a form field; exclude it before the tag test.
   * `closest` is guarded because a keydown target is not always an element.
   */
  const inEditor = !!(target && target.closest && target.closest('.monaco-editor'));
  const inField =
    !inEditor &&
    target &&
    (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

  const key = event.key.toLowerCase();

  if (key === 'k') {
    event.preventDefault();
    toggle();
    return;
  }

  if (inField && !dialog.open) {
    return;
  }

  const command = commands.find((entry) => {
    if (!entry.keys) {
      return false;
    }
    const parts = entry.keys.split('+');
    const needsShift = parts.includes('shift');
    return parts[parts.length - 1] === key && needsShift === event.shiftKey;
  });

  if (command) {
    event.preventDefault();
    close();
    command.run();
  }
};

export const initPalette = (commandList) => {
  commands = commandList;
  dialog = document.getElementById('palette');
  input = document.getElementById('palette-input');
  list = document.getElementById('palette-list');

  if (!dialog || !input || !list) {
    return;
  }

  input.addEventListener('input', applyFilter);

  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      selectedIndex = Math.min(selectedIndex + 1, filtered.length - 1);
      render();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      selectedIndex = Math.max(selectedIndex - 1, 0);
      render();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const command = filtered[selectedIndex];
      if (command) {
        close();
        command.run();
      }
    }
  });

  // Clicking the backdrop closes; <dialog> reports those clicks on itself.
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) {
      close();
    }
  });

  document.addEventListener('keydown', handleGlobalKeys);

  const trigger = document.getElementById('menu-button');
  if (trigger) {
    trigger.addEventListener('click', toggle);
  }
};
