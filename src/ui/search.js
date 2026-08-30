import { documentsMatched, MIN_QUERY, searchDocuments } from '../search.js';

/*
 * The search sheet.
 *
 * Same `sheet` classes as the palette and the other sheets, and the same contract: it owns no
 * application state. It asks for the corpus when it needs one and reports the chosen hit back
 * through a callback, leaving `main.js` the only place that knows how to open a document or
 * move a cursor.
 *
 * Results are recomputed on a short debounce rather than per keystroke. Searching is a scan of
 * every stored document, and on a large corpus doing that on each keypress makes typing feel
 * heavy — the one thing an editor must never do.
 */

const DEBOUNCE_MS = 160;

let dialog;
let input;
let list;
let note;

let getDocuments = () => [];
let handlers = {};
let timer = null;

let setNote = (text) => {
  if (!note) {
    return;
  }
  note.textContent = text || '';
  note.hidden = !text;
};

let renderEmpty = (message) => {
  const empty = document.createElement('li');
  empty.className = 'sheet__empty';
  empty.textContent = message;
  list.appendChild(empty);
};

let renderResults = () => {
  if (!list) {
    return;
  }

  list.textContent = '';

  const query = input ? input.value : '';
  const { hits, truncated, tooShort } = searchDocuments(getDocuments(), query);

  if (!query.trim()) {
    setNote('');
    renderEmpty('Type to search every document');
    return;
  }

  if (tooShort) {
    setNote('');
    renderEmpty(`Keep typing — at least ${MIN_QUERY} characters`);
    return;
  }

  if (hits.length === 0) {
    setNote('');
    renderEmpty(`No document contains “${query.trim()}”`);
    return;
  }

  hits.forEach((hit) => {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sheet__item sheet__item--result';

    const label = document.createElement('span');
    label.className = 'sheet__label';

    /*
     * The document name leads. "Which document did I write that in" is the question this
     * sheet exists to answer, so the answer cannot be the least prominent thing in the row.
     */
    const title = document.createElement('strong');
    title.className = 'sheet__result-title';
    title.textContent = hit.title;

    const text = document.createElement('span');
    text.className = 'sheet__result-line';
    text.textContent = hit.text;

    label.append(title, text);

    const where = document.createElement('span');
    where.className = 'sheet__hint';
    where.textContent = `line ${hit.line}`;

    button.append(label, where);
    button.addEventListener('click', () => {
      close();
      handlers.onPick?.(hit);
    });

    item.appendChild(button);
    list.appendChild(item);
  });

  const spread = documentsMatched(hits);
  const where = spread === 1 ? '1 document' : `${spread} documents`;
  setNote(
    truncated
      ? `Showing the first ${hits.length} matches across ${where} — narrow the search for more`
      : `${hits.length} ${hits.length === 1 ? 'match' : 'matches'} across ${where}`
  );
};

let scheduleRender = () => {
  if (timer) {
    clearTimeout(timer);
  }
  timer = setTimeout(() => {
    timer = null;
    renderResults();
  }, DEBOUNCE_MS);
};

export const open = () => {
  if (!dialog) {
    return;
  }

  // Opened fresh every time: documents change constantly, and stale results would point at
  // lines that have moved.
  renderResults();
  dialog.showModal();
  input?.focus();
  input?.select();
};

export const close = () => {
  if (dialog && dialog.open) {
    dialog.close();
  }
};

export const initSearch = (options) => {
  dialog = document.querySelector('#search');
  input = document.querySelector('#search-input');
  list = document.querySelector('#search-results');
  note = document.querySelector('#search-note');

  if (!dialog || !input || !list) {
    return;
  }

  getDocuments = options.getDocuments || getDocuments;
  handlers = options;

  input.addEventListener('input', scheduleRender);

  // Enter opens the first hit, so a search can be finished without reaching for the mouse.
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') {
      return;
    }
    event.preventDefault();
    const first = list.querySelector('.sheet__item');
    first?.click();
  });

  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) {
      close();
    }
  });

  setNote('');
};
