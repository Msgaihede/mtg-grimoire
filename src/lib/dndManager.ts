import { Accessibility, DragDropManager, KeyboardSensor, PointerSensor } from "@dnd-kit/dom";
import { NOT_A_DRAG } from "@/features/decks/dnd";

/**
 * The app's one `@dnd-kit/dom` manager, and the reason there is no `DragDropProvider` anywhere.
 *
 * **`@dnd-kit/react`'s hooks are not the only way in, and this app deliberately does not use
 * them.** `@dnd-kit/dom` exports the `DragDropManager`, `Draggable` and `Droppable` classes
 * directly: `new Draggable({ id, element, data }, manager)` registers a plain DOM element and
 * `entity.destroy()` unregisters it, which is exactly the imperative contract
 * `lib/folderDrag.ts` already had — an `(args) => () => void` for a source, an effect cleanup
 * for a target. Going through the hooks would have turned every one of those call sites into a
 * component that owns its element, for no gain: the whole of what a provider supplies is a
 * manager, and a manager is a `new`.
 *
 * **A module singleton rather than a React context, and it is the same decision
 * `@atlaskit/pragmatic-drag-and-drop` already made for this app.** That library keeps one
 * module-level registry and every `draggable()`/`dropTargetForElements()` in the window joins it;
 * nothing passes it around and nothing wraps the tree. A drag is a fact about the *window*, not
 * about a subtree — the sidebar's deck-folder tree is mounted beside the collection page all day,
 * and a payload carried between them is the gesture `FolderScope` exists to refuse. One manager
 * is what makes that refusal a data question rather than a wiring question.
 *
 * **Nothing may call `@dnd-kit/react`'s hooks without a provider, and the reason is quiet.**
 * That package creates its context with a module-level `var defaultManager = new
 * DragDropManager()` as the **default value**, so an unparented `useDraggable` does not throw and
 * does not hand back a null manager — it silently joins a *second* singleton, invisible to
 * everything registered here. A hook used that way would look wired and drag nothing.
 *
 * **The sensor is configured once, here, because the exclusion is an app-wide rule.**
 * `PointerSensor`'s own default `preventActivation` refuses a press that lands on an
 * `input, select, textarea, button, a[href]` or `[contenteditable]` — nearly this app's rule, and
 * wrong in the one place it matters: a card's own name **is** a button (it is the keyboard's way
 * into the card), and a search tile's art is a button covering nearly all of it, so the library's
 * default would make both undraggable. {@link NOT_A_DRAG} is the app's answer to the same
 * question and has been since the stepper bug of 2026-08-05 — a control marks itself. This is the
 * capture-phase `mousedown` guard in `features/decks/dnd.ts` said once to the library instead of
 * once per draggable.
 *
 * **One thing this cannot configure away, and the answer to it is in the stylesheet rather than
 * here.** `StyleInjector` is a `CorePlugin`, cannot be removed from the plugin list, and installs
 * the rules that position the drag preview by building a runtime `<style>` element — which the
 * shipped `style-src 'self'` refuses, silently, and only in a packaged build. So those rules are
 * **copied into `src/index.css`**, where the app's own bundled stylesheet is an origin the policy
 * allows; the library goes on publishing its `--dnd-*` values as inline style *attributes*, which
 * `style-src-attr 'unsafe-inline'` already permits, so nothing about the library changes. The
 * block at the foot of that file carries the whole reasoning, `dndManager.test.ts` is the fence
 * that keeps the copy in step with the library, and
 * [frontend-design.md](../../docs/reference/frontend-design.md) has both live passes.
 */
export const dndManager = new DragDropManager({
  /**
   * **`Accessibility` is dropped, and it is a removal that improves accessibility.**
   *
   * That plugin rewrites the DOM of every element registered as a draggable: `role="button"` on
   * anything that is not already a `<button>` and carries no role, `tabindex="0"` on anything not
   * already focusable, `aria-roledescription="draggable"`, an `aria-describedby` pointing at an
   * instructions element it appends to `<body>`, and `aria-pressed`/`aria-grabbed`/`aria-disabled`
   * kept in step with the drag. Measured on this app's own markup 2026-08-27, the collection's
   * wall of drawers came back as
   * `<li role="button" tabindex="0" aria-roledescription="draggable" aria-grabbed="false" …>`.
   *
   * Three things are wrong with that here, and the first is not a matter of taste. **A folder card
   * is an `<li>` in a `<ul aria-label="Folders">`, and `role="button"` takes the `listitem` role
   * away** — the wall of drawers stops being a list, which is how a screen reader says how many
   * there are and where in them the reader is. `CollectionPage.test.tsx` counts exactly that and
   * is what caught it. **`tabindex="0"` adds a tab stop per card**, on top of the button the card
   * already has inside it, which `src/CLAUDE.md` names as the thing a row must never do. And
   * `aria-grabbed` has been deprecated since ARIA 1.1.
   *
   * What is given up is the plugin's announcements and its screen-reader instructions — which
   * this app has never had, because `@atlaskit/pragmatic-drag-and-drop` ships none either, so
   * nothing regresses. `KeyboardSensor` is a *sensor* and stays: dragging a folder from the
   * keyboard is unaffected. A future pass that wants spoken drag feedback should write it against
   * this app's own markup rather than turn this back on.
   */
  plugins: (defaults) => defaults.filter((plugin) => plugin !== Accessibility),
  sensors: [
    PointerSensor.configure({
      preventActivation: (event) => {
        const { target } = event;
        return target instanceof Element && target.closest(NOT_A_DRAG) !== null;
      },
    }),
    KeyboardSensor,
  ],
});

let nextId = 0;

/**
 * A fresh id for one registration.
 *
 * dnd-kit keys its registry by id, so two entities sharing one would replace each other — the
 * failure `folderDrag.ts` already guards against on the *element* side. Nothing in this app
 * addresses a draggable or a droppable **by** id: a folder's identity travels in the payload,
 * where `readFolderDrag` checks it field by field. So the id is a registry key and nothing else,
 * and a counter is the honest spelling of that.
 */
export function dndId(prefix: string): string {
  nextId += 1;
  return `${prefix}-${nextId}`;
}
