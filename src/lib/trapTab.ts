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
 * The panel's real Tab stops — `FOCUSABLE`'s matches, minus the disabled and `aria-hidden` ones,
 * and **one per named radio-button group rather than one per `<input>`**.
 *
 * A native `<input type="radio">` group is a single Tab stop: the browser lands on whichever
 * member is `checked` (the first, if none is), and Tab never visits the others at all — they
 * move by the arrow keys instead. `querySelectorAll` cannot know that, so a naive list counts
 * every radio in a destination-choice or a mode fieldset as its own stop. That is silently wrong
 * exactly when the *unreachable* member ends up as `first`/`last`: forward Tab from the group's
 * real (checked) stop never lands there, so `at === last` never fires and the wrap this file
 * exists for never runs — a Tab press then walks the caret straight out of a layer claiming
 * `aria-modal="true"`. Found by `DeckEditor.test.tsx`'s "keeps Tab inside Import cards" the day
 * the import dialog's destination radios landed beside a disabled Preview button, which is the
 * shape that exposes it: nothing else the panel could focus follows the group.
 */
function tabStops(panel: HTMLElement): HTMLElement[] {
  const all = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => !el.hasAttribute("disabled") && el.getAttribute("aria-hidden") !== "true",
  );
  // One representative per radio group: whichever member is checked, or — if none is — the
  // first one this panel carries. Built as its own pass because the answer for an unchecked
  // group depends on which member turns up *first* in document order, not on the one being
  // looked at right now.
  const radioStop = new Map<string, HTMLInputElement>();
  for (const el of all) {
    // `el.name !== ""` here is *not* load-bearing — the filter below already sends an unnamed
    // radio through its own `el.name === ""` branch before it would ever consult this map, so
    // this guard only stops an unnamed radio from occupying key `""` in a map nothing reads it
    // back from by that key. Removable, unlike its twin below.
    if (el instanceof HTMLInputElement && el.type === "radio" && el.name !== "") {
      if (radioStop.get(el.name) === undefined || el.checked) radioStop.set(el.name, el);
    }
  }
  return all.filter((el) => {
    // `el.name === ""` here **is** load-bearing. Drop it and an unnamed radio falls through to
    // `radioStop.get("") === el` — which is always `false`, since the loop above never adds a
    // `""` key to the map — silently removing every unnamed radio from the tab order instead of
    // keeping it as its own stop.
    if (!(el instanceof HTMLInputElement) || el.type !== "radio" || el.name === "") return true;
    return radioStop.get(el.name) === el;
  });
}

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
  const stops = tabStops(panel);
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
