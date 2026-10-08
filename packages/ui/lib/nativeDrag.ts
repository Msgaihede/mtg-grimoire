/**
 * Refuse every native HTML5 drag the page itself would start, bar one that begins in a text field.
 *
 * **This app has no native drag source, and has not since the dnd-kit migration.** Every drag a
 * reader makes — a card into a pile, a deck into a folder, a pile past its neighbours — is
 * `@dnd-kit/dom`'s pointer gesture (`lib/dndManager.ts`), and `CardImage` sets
 * `draggable={false}` on every picture. So the only native drags left are ones nobody asked for:
 * a **text selection** pressed and pulled, a link, a stray image. Issue #473 is the first of those
 * reaching the reader, and it cost them the whole window.
 *
 * **What the reader did** (reproduced over CDP, debug build, 2026-09-19): a press on a pile heading
 * that was not a card drag started a text selection instead, dragged across the desk it covered
 * ~4 200 characters of headings, prices and card frames — the report's own screenshot. A second
 * press *inside* that selection then began a native drag of it: `dragstart`, and Chromium's
 * `pointercancel` straight after, which is the page handing the pointer to the operating system's
 * drag loop. Nothing in the page accepts that drag, because nothing in the page is an HTML5 drop
 * target. The reader's report is what follows — no input anywhere, and no way to close a window
 * whose caption is drawn by the page. **That last step is the report's and not a measurement**:
 * input injected over CDP never enters WebView2's OS drag loop (the drag ends on the injected
 * release, and IPC answered in 2–4 ms throughout a seven-second hold), so the harness reaches every
 * step up to the loop and cannot reach the loop. What it can show is that this refusal means the
 * loop is never entered: a cancelled `dragstart` is the one point at which Chromium starts no
 * operating-system drag at all.
 *
 * **Why dnd-kit did not already stop it.** `PointerSensor` does refuse a native `dragstart`, but
 * only for the length of a press on one of *its* draggables. A heading, a price line, the gap
 * between two piles and an empty pile's sentence are not draggables, so a selection pulled from any
 * of them met no refusal at all. A press on a card inside the same selection was refused, and
 * started the card's own drag — which is why the report reads as intermittent.
 *
 * **One refusal for the window rather than one per surface.** The deck editor is also made
 * unselectable (`DeckEditor`'s root), which takes the selection away where the report found it —
 * but the search wall, the collection and the wishlist are the same shape of page, and Ctrl+A makes
 * a selection on any of them. A guard at `dragstart` holds wherever the selection came from.
 *
 * **The text-field exemption is the one native drag this app has a use for.** Pulling selected
 * text within a field is how a reader moves it, and the note editor (ProseMirror) keeps drag
 * state of its own that a refusal it cannot see would leave dangling. It is matched by attribute,
 * never by `isContentEditable`, which jsdom does not implement — a check the suite cannot run is a
 * check the suite cannot hold.
 *
 * **Capture phase on the window**, so the refusal is in before any handler on the way down can act
 * on a drag that is not going to happen. A file dragged *in* from the desktop fires no
 * `dragstart` in this page at all, so nothing here reaches an import.
 *
 * Returns the uninstaller, in `installKeyboardModality`'s shape and for its reason: a test drives
 * a jsdom window explicitly, and `main.tsx` installs it once for the life of the page.
 */
export function installNativeDragGuard(win: Window = window): () => void {
  const onDragStart = (event: DragEvent) => {
    if (startsInTextField(event.target)) return;
    event.preventDefault();
  };
  win.addEventListener("dragstart", onDragStart, { capture: true });
  return () => win.removeEventListener("dragstart", onDragStart, { capture: true });
}

/** A field whose own text a reader can pick up and move. */
const TEXT_FIELD = 'input, textarea, [contenteditable]:not([contenteditable="false"])';

/**
 * Whether a drag began inside a text field. A selection drag can start on a **text node**, which
 * has no `closest`, so its parent element answers for it.
 */
function startsInTextField(target: EventTarget | null): boolean {
  const element =
    target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  return element?.closest(TEXT_FIELD) != null;
}
