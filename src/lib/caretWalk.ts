/**
 * A note saying **the caret is already where it belongs, so the card pane must not take it**.
 *
 * `CardDetailPane`'s body is keyed on the open card and focuses itself as it mounts — "focus
 * moves in when it opens, and Escape hands it back to whatever opened it". That is the right
 * contract for a card opened from somewhere the reader is **passing through**: a validation row,
 * a menu item, a link. It is the wrong one for a surface the reader is **standing in and working
 * out of**, where the card they just selected is the thing their next keypress is about — the
 * deck's piles and the two card walls, all three of which move that selection with the arrow
 * keys.
 *
 * Two gestures write it, and they are the same fact rather than two features:
 *
 * * **An arrow press or a chevron**, which selects the next card. Without the note the pane takes
 *   the caret on press one and every later press lands on the pane, so a walk is exactly one card
 *   long.
 * * **A press on the card itself**, which is how a reader starts. Without the note, clicking a
 *   card and then pressing an arrow does nothing at all — the caret was never on the card to
 *   begin with. This is the case a walk driven from a *programmatically* focused card cannot
 *   reach, and it is therefore the one a live pass can miss while proving the arrows work.
 *
 * **Measured in the shipped window** (`npm run tauri dev`, a debug build, 1280×800, against a
 * real synced corpus). 2026-08-18, before this existed: one ArrowRight on the search wall left
 * `document.activeElement` as the pane's `<aside aria-label="Card details">` with no
 * `[data-grid-index]` ancestor; the deck's piles did the same; and in the printings modal the
 * caret left an `aria-modal` dialog for the view behind its own scrim, where `trapTab` could not
 * get it back. 2026-08-19, with the note but before the press wrote one: a real click on a deck
 * card put the caret on that same `<aside>`, and ArrowRight and ArrowDown then moved nothing.
 *
 * **A module-level note rather than store state, for `handover`'s reason in `CardDetailPane`**: a
 * note between two mounts of one component is not application state, and this one never outlives
 * the commit it was written in. It is stamped with the card it is about so that a note nobody
 * consumed — a walk that was clamped and wrote nothing, a press on the card already open — is
 * *discarded* by the next pane rather than read by it, which is the failure the stamp exists to
 * prevent: a stale note would silently rob a deliberate open of the caret it is owed.
 *
 * **It is in `lib` rather than beside the pane** because it has one reader and several writers in
 * three different features (`search`'s wall, `decks`' stacks, `card`'s printings modal). `lib`
 * sits underneath all of them, so the note costs a wall nothing but this file.
 */
let caretHeldFor: string | null = null;

/**
 * Say that the caret is already on the control this selection is about, so the pane should leave
 * it alone.
 *
 * Call it **immediately before** the store write, never after: the write is what re-keys the
 * pane, and the pane's mount effect runs inside that same commit.
 *
 * **Whether a surface calls this is a statement about the surface, not about the gesture.** The
 * deck's stack view calls it for every selection it makes, press and arrow alike, because a deck
 * is worked out of. A card wall calls it only where the walk is armed (`CardGrid`'s `arrowNav`),
 * which is the same test: a wall the arrows do not move is one the reader is passing through, and
 * the printings modal's own wall — where a press *is* a swap and the modal closes — must go on
 * handing the caret to whatever it opens.
 */
export function keepCaretForCard(cardId: string): void {
  caretHeldFor = cardId;
}

/**
 * Whether the card now opening already has the caret somewhere it belongs.
 *
 * **Idempotent for the card it is about, and that is the whole design of it rather than a
 * detail.** The obvious spelling — read the note, clear it unconditionally, "consumed or
 * discarded, never left lying" — is what `handover` does in `CardDetailPane` and it is wrong
 * here, because the reader is a **mount effect** and `main.tsx` wraps this app in
 * `React.StrictMode`: React invokes a mount effect **twice** in development. The first call
 * consumed the note and skipped the focus; the second found nothing and took the caret anyway, so
 * the walk was still one card long and the fix looked like a fix. `handover` survives the same
 * treatment only because its second call is a no-op over state the first one already wrote —
 * this one's second call had a decision left to make.
 *
 * **It would have worked in a shipped build and failed only under `tauri dev`**, which is the
 * asymmetry worth naming: StrictMode's double invocation is development-only, so a release binary
 * would have passed a test this could not. Measured in the running window 2026-08-18, before and
 * after.
 *
 * So: the same card answers the same way however many times it is asked, and any **other** card
 * discards the note — a deliberate open of a second card is what clears the first one's.
 */
export function consumeCaretNote(cardId: string): boolean {
  if (caretHeldFor === cardId) return true;
  caretHeldFor = null;
  return false;
}
