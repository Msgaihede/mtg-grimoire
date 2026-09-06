/**
 * The app's own answer to "is this reader navigating by keyboard?", because the browser's is
 * wrong in a way that is impossible to style around.
 *
 * ## What `:focus-visible` actually means
 *
 * It reads as "focused, and the reader got here by keyboard". It is not that. Chromium's
 * heuristic is **modality-based, not navigation-based**: any `keydown` arms it, and from that
 * moment whatever already holds focus matches — *the focus never has to move*. Measured in
 * Chromium on 2026-09-03 against a two-element page, one `<button>` and one `tabIndex={-1}`
 * `<div>`:
 *
 * | step | action | `:focus-visible` |
 * | --- | --- | --- |
 * | A | mouse click on the button | `false` |
 * | B | programmatic `.focus()` on the `tabIndex={-1}` div | `false` |
 * | C | **press `w`** — focus never moved | **`true`** |
 * | D | mouse click again | `false` |
 *
 * Step C is the whole bug. A reader clicks a card, the dialog opens and focuses its panel, they
 * press any key at all — `w`, `s`, space, a digit — and a gold outline appears around the entire
 * modal. Nothing moved and nothing is waiting for their keyboard. It is not the outline that is
 * wrong, it is the claim the outline is making.
 *
 * ## The rule this module draws instead
 *
 * **Focus is keyboard-driven when it *moved* and the reader's most recent input was a key.**
 * That is the sentence `:focus-visible` should have been, and it is decided at exactly one
 * moment — `focusin`, when focus actually changes — rather than continuously off a flag any
 * keystroke can flip.
 *
 * The consequences fall out of that one line rather than out of a list:
 *
 * - Pressing `w`, space or a digit moves no focus, so it fires no `focusin` and changes nothing.
 *   Whatever the reader clicked stays unmarked. This is the reported bug.
 * - Tab and Shift+Tab move focus, so they mark it. So do the arrow keys, which is why walking a
 *   wall of cards or a menu keeps the outline it has always had.
 * - **Every shortcut that moves focus is covered without being listed.** `Shift+F10` opening a
 *   context menu onto its first row, `F1` opening the key map onto a button, anything added
 *   later — none of them need an entry here, because the rule asks what focus did rather than
 *   which key was pressed. A key allowlist would have to be maintained against every one of
 *   them, and the first one forgotten is a reader arrow-keying through a menu with no visible
 *   caret: a WCAG 2.4.7 failure, which is the failure mode worth engineering against.
 * - It needs no timer and no frame budget. An earlier draft of this module opened a "steering
 *   window" on `keydown` and closed it a frame later, so that a focus React committed after its
 *   passive effects still counted. That window is a number that has to be right, and this rule
 *   does not have one: the modality simply persists until the reader's next input, so a focus
 *   that lands ten frames after the keypress is still keyboard-driven.
 *
 * ## Where the answer goes
 *
 * Onto `<html>` as {@link KEYBOARD_MODALITY_ATTR}, because CSS has to be able to see it, and the
 * root is the only element every focusable node is a descendant of. `src/index.css` redefines
 * Tailwind's own `focus-visible` variant to require it, so **every `focus-visible:` utility in
 * the app is gated by this attribute with no call site changing at all** — including ones
 * written after today. That indirection is the point: a rule enforced in one place cannot be
 * forgotten at the four hundredth.
 *
 * Listeners are on `window` in the **capture** phase so that a handler calling
 * `stopPropagation()` — the menus and the dialog trap both do — cannot make the app forget which
 * device the reader is using. They are passive: this module observes and never intervenes.
 */

/**
 * The mark on `<html>` that says the caret arrived by keyboard.
 *
 * Exported because three places have to agree on the spelling and only one of them is TypeScript:
 * `src/index.css` names it in the variant that gates every focus outline, and the tests name it
 * when they assert the app is telling the truth about the reader's last input.
 */
export const KEYBOARD_MODALITY_ATTR = "data-kbd";

/** What the reader last used to drive the page. */
type Modality = "key" | "pointer";

/**
 * Watch a window's input and keep {@link KEYBOARD_MODALITY_ATTR} on its document's root in step
 * with it.
 *
 * Returns the uninstaller. Calling it twice is harmless; the attribute is left as it stands,
 * because a teardown that also cleared it would blank the outline out from under a reader whose
 * caret has not moved.
 *
 * @param win The window to observe. Defaulted rather than assumed so a test can drive a jsdom
 *   window explicitly and Storybook can install against its preview frame.
 */
export function installKeyboardModality(win: Window = window): () => void {
  const root = win.document.documentElement;

  // **`pointer`, not `key`, before the reader has done anything.** A page can focus something as
  // it mounts — the card pane does, the dialogs do — and that first `focusin` must not be read as
  // a keyboard arrival on the strength of nothing having happened yet.
  let modality: Modality = "pointer";

  const onKeyDown = () => {
    modality = "key";
    // Deliberately no attribute write here. A key that moves no focus is the entire reported
    // bug, and this is the line that would reintroduce it.
  };

  const onPointerDown = () => {
    modality = "pointer";
    // **Cleared here as well as at `focusin`, for the press that moves no focus.** A reader who
    // Tabs to a button and then clicks that same already-focused button fires no `focusin` at
    // all, so without this line the outline would sit there through a pointer gesture. Chromium
    // drops its own ring on that press and so does this.
    root.removeAttribute(KEYBOARD_MODALITY_ATTR);
  };

  // The one decision. Everything above only records what the reader last touched.
  const onFocusIn = () => {
    if (modality === "key") root.setAttribute(KEYBOARD_MODALITY_ATTR, "");
    else root.removeAttribute(KEYBOARD_MODALITY_ATTR);
  };

  win.addEventListener("keydown", onKeyDown, { capture: true, passive: true });
  win.addEventListener("pointerdown", onPointerDown, { capture: true, passive: true });
  win.addEventListener("focusin", onFocusIn, { capture: true, passive: true });

  return () => {
    win.removeEventListener("keydown", onKeyDown, { capture: true });
    win.removeEventListener("pointerdown", onPointerDown, { capture: true });
    win.removeEventListener("focusin", onFocusIn, { capture: true });
  };
}
