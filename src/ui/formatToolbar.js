import { positionBelow } from './position.js';

/*
 * Accessible editor formatting toolbar.
 *
 * The DOM is static in index.html so labels and controls exist before this module loads.
 * This initializer owns only interaction: shared formatting actions, source-derived active
 * state, roving focus, the heading menu and the single unclipped tooltip.
 */

const FORMAT_ACTIONS = {
  bold: 'bold',
  italic: 'italic',
  strike: 'strike',
  code: 'code',
  'bullet-list': 'list',
  'ordered-list': 'orderedList',
  'task-list': 'taskList',
  blockquote: 'blockquote',
  'code-block': 'codeBlock',
  table: 'table',
  link: 'link'
};

const ACTIVE_STATE = {
  bold: 'bold',
  italic: 'italic',
  strike: 'strike',
  code: 'code',
  'bullet-list': 'bulletList',
  'ordered-list': 'orderedList',
  'task-list': 'taskList',
  blockquote: 'blockquote',
  'code-block': 'codeBlock'
};

export const initFormatToolbar = ({ editor, formatting, onInsertImage }) => {
  const toolbar = document.getElementById('format-toolbar');
  const rail = toolbar?.querySelector('.format-toolbar__rail');
  const controls = Array.from(toolbar?.querySelectorAll('.format-toolbar__button') || []);
  const headingButton = toolbar?.querySelector('[data-format="heading"]');
  const headingLabel = headingButton?.querySelector('.format-toolbar__heading-label');
  const headingMenu = document.getElementById('format-heading-menu');
  const headingItems = Array.from(headingMenu?.querySelectorAll('[data-heading-level]') || []);
  const tooltip = document.getElementById('format-tooltip');

  if (
    !toolbar ||
    !rail ||
    controls.length === 0 ||
    !headingButton ||
    !headingMenu ||
    headingItems.length === 0 ||
    !tooltip
  ) {
    return () => {};
  }

  let rovingIndex = Math.max(0, controls.findIndex((control) => control.tabIndex === 0));
  let tooltipTarget = null;

  const setRovingIndex = (next, { focus = true } = {}) => {
    rovingIndex = (next + controls.length) % controls.length;
    controls.forEach((control, index) => {
      control.tabIndex = index === rovingIndex ? 0 : -1;
    });
    const control = controls[rovingIndex];
    control.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (focus) control.focus();
  };

  const hideTooltip = () => {
    if (tooltipTarget) tooltipTarget.removeAttribute('aria-describedby');
    tooltipTarget = null;
    delete tooltip.dataset.visible;
  };

  const showTooltip = (control) => {
    hideTooltip();
    tooltipTarget = control;
    tooltip.textContent = control.getAttribute('aria-label') || control.title;
    control.setAttribute('aria-describedby', tooltip.id);
    tooltip.dataset.visible = 'true';
    positionBelow(tooltip, control, 6);
  };

  const closeHeadingMenu = ({ restoreFocus = false } = {}) => {
    if (headingMenu.hidden) return;
    headingMenu.hidden = true;
    headingButton.setAttribute('aria-expanded', 'false');
    if (restoreFocus) headingButton.focus();
  };

  const openHeadingMenu = ({ focus = 'first' } = {}) => {
    hideTooltip();
    headingMenu.hidden = false;
    headingButton.setAttribute('aria-expanded', 'true');
    positionBelow(headingMenu, headingButton, 4);
    if (focus === 'last') {
      headingItems[headingItems.length - 1].focus();
    } else if (focus === 'first') {
      headingItems[0].focus();
    }
  };

  const update = () => {
    const state = formatting.getState();
    for (const control of controls) {
      const stateName = ACTIVE_STATE[control.dataset.format];
      if (stateName) control.setAttribute('aria-pressed', String(!!state[stateName]));
    }

    headingButton.setAttribute('aria-pressed', String(state.heading > 0));
    if (headingLabel) headingLabel.textContent = state.heading ? `H${state.heading}` : '¶';
    headingButton.setAttribute(
      'aria-label',
      state.heading ? `Heading style, Heading ${state.heading}` : 'Heading style, Paragraph'
    );
    headingItems.forEach((item) => {
      const value =
        item.dataset.headingLevel === 'paragraph' ? 0 : Number(item.dataset.headingLevel);
      item.setAttribute('aria-checked', String(value === state.heading));
    });
  };

  const run = (control) => {
    const name = control.dataset.format;
    if (name === 'heading') return;
    if (name === 'image') {
      onInsertImage();
      return;
    }
    const action = formatting[FORMAT_ACTIONS[name]];
    if (action) action();
    update();
  };

  for (const control of controls) {
    control.addEventListener('pointerdown', (event) => {
      if (event.button === 0) event.preventDefault();
    });
    control.addEventListener('click', (event) => {
      rovingIndex = controls.indexOf(control);
      controls.forEach((candidate, index) => {
        candidate.tabIndex = index === rovingIndex ? 0 : -1;
      });
      if (control === headingButton) {
        if (headingMenu.hidden) {
          openHeadingMenu({ focus: event.detail === 0 ? 'first' : false });
        } else {
          closeHeadingMenu({ restoreFocus: event.detail === 0 });
        }
        return;
      }
      closeHeadingMenu();
      run(control);
    });
    control.addEventListener('pointerenter', () => showTooltip(control));
    control.addEventListener('pointerleave', hideTooltip);
    control.addEventListener('focus', () => showTooltip(control));
    control.addEventListener('blur', () => {
      if (tooltipTarget === control) hideTooltip();
    });
  }

  toolbar.addEventListener('keydown', (event) => {
    const index = controls.indexOf(event.target);
    if (index < 0) return;

    if (event.key === 'ArrowRight') {
      event.preventDefault();
      closeHeadingMenu();
      setRovingIndex(index + 1);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      closeHeadingMenu();
      setRovingIndex(index - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      closeHeadingMenu();
      setRovingIndex(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      closeHeadingMenu();
      setRovingIndex(controls.length - 1);
    } else if (event.target === headingButton && event.key === 'ArrowDown') {
      event.preventDefault();
      openHeadingMenu({ focus: 'first' });
    } else if (event.target === headingButton && event.key === 'ArrowUp') {
      event.preventDefault();
      openHeadingMenu({ focus: 'last' });
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeHeadingMenu();
      editor.focus();
    }
  });

  const selectHeading = (item) => {
    const value = item.dataset.headingLevel;
    closeHeadingMenu();
    if (value === 'paragraph') formatting.paragraph();
    else formatting.setHeading(Number(value));
    update();
  };

  headingItems.forEach((item) => {
    item.addEventListener('pointerdown', (event) => {
      if (event.button === 0) event.preventDefault();
    });
    item.addEventListener('click', () => selectHeading(item));
    item.addEventListener('keydown', (event) => {
      const index = headingItems.indexOf(item);
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        headingItems[(index + 1) % headingItems.length].focus();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        headingItems[(index - 1 + headingItems.length) % headingItems.length].focus();
      } else if (event.key === 'Home') {
        event.preventDefault();
        headingItems[0].focus();
      } else if (event.key === 'End') {
        event.preventDefault();
        headingItems[headingItems.length - 1].focus();
      } else if (event.key === 'Escape' || event.key === 'ArrowLeft') {
        event.preventDefault();
        closeHeadingMenu({ restoreFocus: true });
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        closeHeadingMenu({ restoreFocus: true });
        setRovingIndex(rovingIndex + 1);
      }
    });
  });

  document.addEventListener('pointerdown', (event) => {
    if (!headingMenu.hidden && !headingMenu.contains(event.target) && !headingButton.contains(event.target)) {
      closeHeadingMenu();
    }
  });

  window.addEventListener('resize', () => {
    hideTooltip();
    closeHeadingMenu();
  });
  rail.addEventListener('scroll', hideTooltip, { passive: true });

  const cursorSubscription = editor.onDidChangeCursorSelection(update);
  const modelSubscription = editor.onDidChangeModelContent(update);
  update();

  return () => {
    cursorSubscription.dispose();
    modelSubscription.dispose();
    hideTooltip();
    closeHeadingMenu();
  };
};
