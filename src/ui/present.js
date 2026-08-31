/*
 * Presentation mode (T51).
 *
 * **Slides are cut on the rendered `<hr>`, never on the text `---`.** In Markdown those three
 * characters are also a setext heading underline and a front-matter fence, and inside a code
 * block they are just characters. The renderer has already decided which of those a given
 * `---` was, so reading its output is the only split that agrees with what the user sees.
 *
 * Nodes are cloned out of `#output` rather than re-rendered. That is the same reasoning the
 * PDF sandbox uses: a clone carries the already-rendered Mermaid SVGs and KaTeX verbatim, and
 * re-parsing would mean a second chance to disagree with the preview.
 */

let overlay;
let stage;
let counter;
let slides = [];
let index = 0;
let onExit = null;

let show = () => {
  slides.forEach((slide, i) => {
    slide.hidden = i !== index;
  });
  if (counter) {
    counter.textContent = slides.length ? `${index + 1} / ${slides.length}` : '';
  }
};

let go = (delta) => {
  if (!slides.length) {
    return;
  }
  index = Math.min(Math.max(index + delta, 0), slides.length - 1);
  show();
};

/*
 * Bound on `document` while the overlay is open. Monaco stops propagation on keys it binds,
 * but it is blurred behind a modal overlay, so nothing it holds can reach here — and the
 * listener is removed on exit rather than left checking a flag forever.
 */
let onKey = (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    close();
    return;
  }
  if (event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === ' ') {
    event.preventDefault();
    go(1);
    return;
  }
  if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
    event.preventDefault();
    go(-1);
    return;
  }
  if (event.key === 'Home') {
    event.preventDefault();
    index = 0;
    show();
    return;
  }
  if (event.key === 'End') {
    event.preventDefault();
    index = slides.length - 1;
    show();
  }
};

/*
 * Groups the preview's top-level children into slides, breaking at each `<hr>`. Returns an
 * array of arrays of nodes; the `<hr>` itself is dropped, since it was punctuation rather
 * than content.
 */
export const splitIntoSlides = (outputElement) => {
  const groups = [[]];

  for (const child of Array.from(outputElement.children)) {
    if (child.tagName === 'HR') {
      groups.push([]);
    } else {
      groups[groups.length - 1].push(child);
    }
  }

  // A trailing separator should not leave an empty slide at the end of the deck.
  return groups.filter((group) => group.length > 0);
};

export const open = (outputElement, { onClose } = {}) => {
  if (!overlay || !stage) {
    return 0;
  }

  onExit = onClose || null;
  stage.textContent = '';
  slides = [];
  index = 0;

  for (const group of splitIntoSlides(outputElement)) {
    const slide = document.createElement('div');
    slide.className = 'present__slide';
    // Carries the preview's own classes so a slide is styled exactly like the preview is.
    slide.classList.add(...outputElement.className.split(/\s+/).filter(Boolean));
    group.forEach((node) => slide.appendChild(node.cloneNode(true)));
    stage.appendChild(slide);
    slides.push(slide);
  }

  overlay.hidden = false;
  show();
  document.addEventListener('keydown', onKey, true);

  /*
   * Full screen is requested, not required. It needs a user gesture and is refused outright in
   * some contexts, and a deck that fills the window is still a usable deck — so a refusal must
   * not take the whole feature down with it.
   */
  try {
    overlay.requestFullscreen?.().catch(() => {});
  } catch (error) {
    // Refused; the overlay still covers the window.
  }

  return slides.length;
};

export const close = () => {
  if (!overlay || overlay.hidden) {
    return;
  }
  document.removeEventListener('keydown', onKey, true);
  overlay.hidden = true;
  stage.textContent = '';
  slides = [];

  try {
    if (document.fullscreenElement) {
      document.exitFullscreen?.().catch(() => {});
    }
  } catch (error) {
    // Nothing to leave.
  }

  onExit?.();
};

export const initPresent = () => {
  overlay = document.querySelector('#present');
  stage = document.querySelector('#present-stage');
  counter = document.querySelector('#present-counter');

  if (!overlay) {
    return;
  }

  overlay.querySelector('#present-next')?.addEventListener('click', () => go(1));
  overlay.querySelector('#present-prev')?.addEventListener('click', () => go(-1));
  overlay.querySelector('#present-close')?.addEventListener('click', close);
};
