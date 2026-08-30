/*
 * The document outline.
 *
 * Same `sheet` classes as the palette, the documents sheet and the history sheet — this is
 * the same shape of list, so it reuses their styling rather than inventing more.
 *
 * Like those modules it owns no application state: it renders the headings it is handed and
 * reports the chosen one back through a callback, leaving `main.js` the only place that knows
 * how to find a heading in the preview or scroll to it.
 *
 * Rows are identified by their **index** in the rendered output, not by an id or a fragment.
 *
 * Headings *do* carry ids now — T42 added slugs so `[TOC]` links could work — but this list
 * still does not use them. An index cannot go stale between the sheet opening and a row being
 * clicked, whereas an id can be edited away mid-session, and the outline already re-renders
 * from the live DOM every time it opens.
 */

let dialog;
let list;

let getHeadings = () => [];
let handlers = {};

let renderList = () => {
  if (!list) {
    return;
  }

  list.textContent = '';
  const headings = getHeadings();

  if (headings.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'sheet__empty';
    empty.textContent = 'No headings in this document';
    list.appendChild(empty);
    return;
  }

  headings.forEach((heading) => {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sheet__item';

    /*
     * Depth is a data attribute rather than inline padding, so the indent comes from a token
     * in the stylesheet like every other measurement in the app.
     */
    button.dataset.level = String(heading.level);

    const label = document.createElement('span');
    label.className = 'sheet__label';
    label.textContent = heading.text;

    const hint = document.createElement('span');
    hint.className = 'sheet__hint';
    hint.textContent = `H${heading.level}`;

    button.append(label, hint);
    button.addEventListener('click', () => {
      close();
      handlers.onPick?.(heading.index);
    });

    item.appendChild(button);
    list.appendChild(item);
  });
};

export const refresh = renderList;

export const open = () => {
  if (!dialog) {
    return;
  }
  // Rendered fresh on every open: the document changes constantly, and a cached list would
  // point at headings that have moved or gone.
  renderList();
  dialog.showModal();
};

export const close = () => {
  if (dialog && dialog.open) {
    dialog.close();
  }
};

export const initOutline = (options) => {
  dialog = document.querySelector('#outline');
  list = document.querySelector('#outline-list');

  if (!dialog) {
    return;
  }

  getHeadings = options.getHeadings || getHeadings;
  handlers = options;

  // Clicking the backdrop closes it, matching the palette and the other sheets.
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) {
      close();
    }
  });
};
