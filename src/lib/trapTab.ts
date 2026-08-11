/**
 * Keep Tab inside an overlay panel.
 *
 * The one thing `aria-modal` promises that no attribute can deliver: the app behind an overlay
 * really is still in the tab order, so without this a few presses of Tab walk the caret out
 * into a view the reader cannot see and cannot get back from. **A surface that claims
 * `aria-modal="true"` installs this, and one that stops installing it drops the claim** — the
 * attribute is a promise about both hands, and half of it is a lie told to assistive tech only.
 *
 * Written out rather than pulled from a focus-trap library for the reason every overlay
 * decision in this app gives: the shipped CSP is `style-src 'self'`, and the packages that do
 * this reliably also want a portal and a runtime `<style>`.
 *
 * One copy, because there were two with two different focusable-element lists — and only one
 * of them filtered `disabled`, which is the difference a reader meets: a disabled control at
 * the end of the list swallows the wrap, so Shift+Tab from the first stop goes nowhere at all.
 */

/**
 * What counts as a stop on the way round.
 *
 * `[tabindex="-1"]` is excluded by the selector rather than by a filter, so the **panel
 * itself** never appears in its own cycle — which is what lets the caret sitting on the panel
 * count as *before* the first stop, where the opening effect leaves it.
 */
const FOCUSABLE = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

/**
 * Cycle Tab and Shift+Tab within `e.currentTarget`.
 *
 * Register it on the panel itself (`onKeyDown={trapTab}`) — the panel is read off
 * `e.currentTarget` rather than out of a ref, which is not only tidier: the handler is
 * registered *on* the panel, so the two can never disagree, and a ref read during render is
 * exactly what `react-hooks/refs` refuses.
 *
 * The focusable list is read **on each press**, never captured: controls disable themselves as
 * they are used (a diff row's Wishlist button, a delete confirm mid-write), and a list captured
 * once would send the caret to a control the browser now skips.
 */
export function trapTab(e: React.KeyboardEvent<HTMLElement>): void {
  if (e.key !== "Tab") return;
  const panel = e.currentTarget;
  const stops = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => !el.hasAttribute("disabled") && el.getAttribute("aria-hidden") !== "true",
  );
  // Nothing to cycle between — a deck that is loading or gone, an empty diff where the ✕ may be
  // the only control and may itself be disabled. The press is still ours, or it would carry the
  // caret out of a layer that claims to be modal.
  if (stops.length === 0) {
    e.preventDefault();
    panel.focus({ preventScroll: true });
    return;
  }
  const first = stops[0];
  const last = stops[stops.length - 1];
  // `document.activeElement`, not `e.target`: the caret may be on the panel itself, which is
  // `tabIndex={-1}` and therefore at neither end of the list.
  const at = document.activeElement;
  if (e.shiftKey && (at === first || at === panel)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && at === last) {
    e.preventDefault();
    first.focus();
  }
}
