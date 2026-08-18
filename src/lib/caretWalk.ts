/**
 * A note saying **this selection was walked to, so the caret is already where it belongs**.
 *
 * `CardDetailPane`'s body is keyed on the open card and focuses itself as it mounts — "focus
 * moves in when it opens, and Escape hands it back to whatever opened it", which is the right
 * contract for a card a reader *pressed*. The arrow keys make the same store write for a
 * different reason: the reader is walking a wall, a deck's piles or the printings modal's own
 * list of deck cards, and the caret has to stay on the thing being walked or the second press
 * has nothing to move. Without this note it does not: the pane takes the caret on press one and
 * every later press lands on the pane, so the walk is exactly one card long.
 *
 * **Measured in the shipped window 2026-08-18** (`npm run tauri dev`, a debug build, 1280×800,
 * against a real synced corpus), on all three surfaces before this existed. On the search wall
 * one ArrowRight left `document.activeElement` as the pane's `<aside aria-label="Card details">`
 * with no `[data-grid-index]` ancestor at all; in the deck editor one ArrowRight out of the
 * Commander pile did the same; and in the printings modal one ArrowRight stepped the wall
 * correctly — the heading moved to the next deck card and both chevrons re-labelled — while the
 * caret left an `aria-modal` dialog for the view behind its own scrim, which is the same defect
 * and a worse one, because `trapTab` cannot get it back.
 *
 * **A module-level note rather than store state, for {@link handover}'s reason one file over**: a
 * note between two mounts of one component is not application state, and this one never outlives
 * the commit it was written in. It is stamped with the card it is about so that a note nobody
 * consumed — a walk that was clamped and wrote nothing, a press that landed on the card already
 * open — is *discarded* by the next pane rather than read by it, which is the failure the stamp
 * exists to prevent: a stale note would silently rob a deliberate press of the caret it is owed.
 *
 * **It is in `lib` rather than beside the pane** because it has one reader and three writers, and
 * the three are in three different features (`search`'s wall, `decks`' stacks, `card`'s printings
 * modal). `lib` sits underneath all of them, so the note costs a wall nothing but this file.
 */
let walkedTo: string | null = null;

/**
 * Say that the selection about to be written was reached with the arrow keys or a chevron.
 *
 * Call it **immediately before** the store write, never after: the write is what re-keys the
 * pane, and the pane's mount effect runs inside that same commit.
 */
export function walkingToCard(cardId: string): void {
  walkedTo = cardId;
}

/**
 * Whether the card now opening was walked to.
 *
 * **Idempotent for the card it is about, and that is the whole design of it rather than a
 * detail.** The obvious spelling — read the note, clear it unconditionally, "consumed or
 * discarded, never left lying" — is what {@link handover} does one file over and it is wrong
 * here, because the reader is a **mount effect** and `main.tsx` wraps this app in
 * `React.StrictMode`: React invokes a mount effect **twice** in development. The first call
 * consumed the note and skipped the focus; the second found nothing and took the caret anyway,
 * so the walk was still one card long and the fix looked like a fix. `handover` survives the
 * same treatment only because its second call is a no-op over state the first one already
 * wrote — this one's second call had a decision left to make.
 *
 * **It would have worked in a shipped build and failed only under `tauri dev`**, which is the
 * asymmetry worth naming: StrictMode's double invocation is development-only, so a release
 * binary would have passed a test this could not. Measured in the running window 2026-08-18,
 * before and after.
 *
 * So: the same card answers the same way however many times it is asked, and any **other** card
 * discards the note — a deliberate press on a second card is what clears the first one's.
 *
 * The one case this leaves is benign and stated rather than hidden: walk to a card, close the
 * pane, then press that same card open deliberately, and the pane will not take the caret. It
 * stays on the tile that was pressed, which is where the reader is looking.
 */
export function consumeWalkNote(cardId: string): boolean {
  if (walkedTo === cardId) return true;
  walkedTo = null;
  return false;
}
