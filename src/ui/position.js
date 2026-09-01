/*
 * Placing a floating thing under the control that opened it.
 *
 * Lifted out of `src/ui/formatToolbar.js` when the export menu (T66) needed the same
 * behaviour. Two menus with two copies of this would drift, and the drift would show up as a
 * menu hanging off the edge of a phone — which is precisely what the clamping below prevents.
 */

/** Keeps a floating element this far from every viewport edge. */
const VIEWPORT_GAP = 8;

/**
 * Centres `floating` under `target`, `gap` pixels below it.
 *
 * Two corrections matter more than the centring:
 *
 * - **Horizontal clamp.** A menu centred under a button near the right-hand edge overflows the
 *   window; at 375px almost every toolbar button is near an edge.
 * - **Vertical flip.** When there is no room below, it goes above instead of being cut off by
 *   the bottom of the window.
 *
 * The element must already be visible when this runs — the measurement reads its rendered
 * size, and a `hidden` element measures zero.
 */
export const positionBelow = (floating, target, gap) => {
  const targetRect = target.getBoundingClientRect();
  const floatingRect = floating.getBoundingClientRect();
  let left = targetRect.left + targetRect.width / 2 - floatingRect.width / 2;
  left = Math.max(VIEWPORT_GAP, Math.min(left, window.innerWidth - floatingRect.width - VIEWPORT_GAP));
  let top = targetRect.bottom + gap;
  if (top + floatingRect.height > window.innerHeight - VIEWPORT_GAP) {
    top = Math.max(VIEWPORT_GAP, targetRect.top - floatingRect.height - gap);
  }
  floating.style.left = `${Math.round(left)}px`;
  floating.style.top = `${Math.round(top)}px`;
};
