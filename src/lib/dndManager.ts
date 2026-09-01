import { Accessibility, DragDropManager, Draggable, Droppable, PointerSensor } from "@dnd-kit/dom";
import { NOT_A_DRAG } from "@/features/decks/dnd";
import { installCardCountPreview } from "@/lib/dragPreview";

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
 * **The sensors are configured once, here, because both decisions are app-wide.** The press
 * exclusion is `features/decks/dnd.ts`'s capture-phase `mousedown` guard said once to the library
 * instead of once per draggable, and the absent `KeyboardSensor` is the other half; both are
 * argued at the `sensors` list below.
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
   * nothing regresses. A future pass that wants spoken drag feedback should write it against
   * this app's own markup rather than turn this back on.
   */
  plugins: (defaults) => defaults.filter((plugin) => plugin !== Accessibility),
  /**
   * **The pointer, and nothing else. `KeyboardSensor` is deliberately not in this list, and it
   * was until the card payload moved.**
   *
   * That sensor binds a bubble-phase `keydown` to `source.handle ?? source.element` and answers
   * `Space` and `Enter` by starting a drag — `handleStart` calls `preventDefault()` **and**
   * `stopImmediatePropagation()`, so nothing else in the window hears the press. Its default
   * `preventActivation` is `event.target !== target`, which keeps it off a press that landed on a
   * *child*; what it cannot help with is a draggable that is **itself** a control the reader
   * presses Enter on. Until 3b that was only a folder card and a tree row, neither of which is
   * focusable; from the moment `composedDraggable` became a dnd-kit `Draggable` it is **every
   * card in the app** — a deck row in the table, a line in the text view, a search tile, a
   * collection row, a wish. `views.test.tsx`'s "opens the card on Enter with a menu wired beside
   * it" went red on two views at once, which is Enter no longer opening a card.
   *
   * **Removing it restores exact parity rather than giving something up.** Every drag in this app
   * was a native HTML5 drag until 3a, and a native drag is a pointer gesture — Chromium starts
   * none from the keyboard — so there has never been a keyboard drag here to lose. What the app
   * *has* is a click path beside every drag (a card's `Move to`, the toolbar's quick add, a
   * folder's `⋯` menu), which is the affordance a caret actually uses.
   *
   * A keyboard drag worth having needs instructions, announcements and a way out, which is
   * `Accessibility`'s subject above and 3c's to settle — written against this app's own markup
   * rather than turned back on here. `dndManager.test.ts` holds the fence.
   */
  sensors: [
    /**
     * **The sensor is configured once, here, because the exclusion is an app-wide rule.**
     * `PointerSensor`'s own default `preventActivation` refuses a press that lands on an
     * `input, select, textarea, button, a[href]` or `[contenteditable]` — nearly this app's rule,
     * and wrong in the one place it matters: a card's own name **is** a button (it is the
     * keyboard's way into the card), and a search tile's art is a button covering nearly all of
     * it, so the library's default would make both undraggable. {@link NOT_A_DRAG} is the app's
     * answer to the same question and has been since the stepper bug of 2026-08-05 — a control
     * marks itself.
     */
    PointerSensor.configure({
      preventActivation: (event) => {
        const { target } = event;
        return target instanceof Element && target.closest(NOT_A_DRAG) !== null;
      },
    }),
  ],
});

/**
 * **A source that brings its own sensors may not erase the configuration above** — issue #331,
 * and it took the whole app's drag-and-drop with it.
 *
 * `Draggable`'s registration effect resolves a source's sensors as
 * `this.sensors?.map(descriptor) ?? [...manager.sensors]`, and the two halves of that are not
 * symmetrical. The manager's own list arrives as **instances**, which the effect binds with
 * `bind(source, undefined)` — a `bind(source, options = this.options)` default parameter, so the
 * source inherits what the instance was configured with. A per-source list arrives as
 * **descriptors**, and the effect registers one with `manager.registry.register(entry.plugin)` —
 * the constructor alone, the entry's options dropped on the floor. `PluginRegistry.register` then
 * reads an omitted `options` as an instruction to *write* them:
 * `if (existing.options !== options) existing.options = options`.
 *
 * So the first source in the window to declare `sensors` of its own sets this manager's one
 * `PointerSensor` instance's `options` to `undefined` — permanently, because nothing ever writes
 * them back. Every source registered **after** that binds with `options = this.options`, which is
 * now nothing, and falls back to the library's own `preventActivation`: the rule the block above
 * exists to replace, which refuses any press whose target sits inside an interactive element.
 * **In this app a card's art is a button**, so what a reader saw was a tile that could still be
 * dragged by its caption and not by its picture, on every card surface at once, until a reload —
 * reported as "drag and drop is broken when dragging on an image".
 *
 * The trigger is the category grip (`features/decks/categoryDrag.ts`), the one source here that
 * has to carry a `sensors` list, so **opening a deck editor once** was enough to break the search
 * wall, the collection, the wishlist and the deck gallery behind it.
 *
 * The fence is the narrowest statement of what the library plainly meant — its own doc comment on
 * `register` says an already-registered plugin's "options will be updated", and a caller that
 * passes none has nothing to update with. So an omitted `options` keeps what the instance has
 * instead of clearing it; a caller that passes some still replaces them. The per-source list goes
 * on binding with its own options, because the effect passes those to `bind` directly and never
 * through the registry.
 *
 * **Patched here rather than worked around at the one call site**, because the call site is not
 * doing anything wrong: a `sensors` list is the library's documented way to say what a press
 * costs on a source with a handle. A rule that said "never declare sensors" would be a landmine
 * with no fence, and the failure it guards is silent — nothing throws, nothing logs, and the
 * gesture merely stops starting. `dndManager.test.ts` drives the press that proves it.
 */
{
  /**
   * The registry as this patch has to hold it. `register` is generic over the plugin constructor
   * and `get` returns that constructor's own instance type, so a wrapper that passes one's result
   * to the other cannot be written in those generics — the compiler has no way to know the two
   * mention the same plugin. The shape below is the whole of what this touches, and it is
   * deliberately the narrowest reach past the library's types rather than an `any`.
   */
  const sensors = dndManager.registry.sensors as unknown as {
    register: (plugin: object, options?: unknown) => unknown;
    get: (plugin: object) => { options?: unknown } | undefined;
  };
  const register = sensors.register.bind(sensors);
  sensors.register = (plugin, options) => register(plugin, options ?? sensors.get(plugin)?.options);
}

/**
 * The mark that says a drag is up, on `<html>` — and the fence for the two rules `index.css`
 * copies out of `Cursor` and `PreventSelection`.
 *
 * **Why those two rules need a fence at all.** Both are bare `* { … !important }`, which the
 * library can afford because it *registers and unregisters them around one gesture*. Copied into
 * a stylesheet that is always loaded they would put a closed hand and an unselectable page over
 * the whole app forever, so the copy carries an ancestor condition the library's does not — and
 * this attribute is what makes that condition true for exactly as long as the library's own rules
 * would have been up.
 *
 * **Why an attribute and not `:root:has([data-dnd-dragging])`, which needs no JavaScript at all.**
 * That was the first spelling and it cost a shipped test. jsdom resolves style by matching every
 * loaded rule against every element, and a rule whose *subject* is `*` and whose ancestor part
 * contains `:has()` makes each of those matches a scan of the whole document — O(n²) over the
 * page. Measured 2026-08-28 on a 400-element tree with a DOM mutation between reads, which is
 * what a `userEvent` gesture produces: **4.1s with this attribute, 18.6s with the `:has()`**. In
 * the suite that showed up as `DeckEditor.stories.tsx > SwapFolds`, a play that touches no drag
 * at all, going from **3.5s to just over the 15s `testTimeout`** — a whole-suite tax collected by
 * one selector. An unrelated `:has()` rule costs nothing (measured: 436ms against 447ms), because
 * its subject fails before the `:has()` is ever evaluated; it is the broad subject that is
 * expensive, not the pseudo-class. `dndManager.test.ts` holds that fence.
 *
 * A real browser has none of this problem — Chromium keeps an invalidation set for `:has()` — so
 * the reason this is an attribute is jsdom, and jsdom is where this app's UI is proved.
 */
export const DRAGGING_ATTRIBUTE = "data-dragging";

/**
 * Set for the length of a drag, and **module scope on purpose**: the manager above is a singleton
 * with no teardown, so its mark is one subscription for the life of the window rather than
 * something a component owns and could forget.
 *
 * `dragstart` and `dragend` rather than the operation's own `status`, which is what the library's
 * `StyleInjector` reads: that signal is reachable only through `@dnd-kit/state`, a transitive
 * dependency this app does not declare. The difference is the drop animation — the library keeps
 * its rules up while the preview flies home and this mark comes off when the reader lets go. That
 * is a cursor returning to normal a couple of hundred milliseconds earlier, on a pointer that is
 * no longer holding anything, and it is the right side to err on.
 */
dndManager.monitor.addEventListener("dragstart", () => {
  document.documentElement.setAttribute(DRAGGING_ATTRIBUTE, "");
});
dndManager.monitor.addEventListener("dragend", () => {
  document.documentElement.removeAttribute(DRAGGING_ATTRIBUTE);
});

/**
 * What a source would carry, read as its drag begins — the record, not the reader.
 *
 * **`beforedragstart` and not the press or the registration, and the timing is a measured bug in
 * both other spellings.** A record is a callback because a row renumbered, renamed or re-filed
 * since it mounted has to travel as it is now; but a card wall's record is
 * `dragData(payload(), rest())`, and `rest` goes through `useCardSelection.dragsAll`, which
 * **throws the picked set away** when the drag starts outside it. Asked at registration, a
 * re-render of the wall cleared the reader's selection; asked at every `pointerdown`, a plain
 * click on an unpicked tile cleared it before the click that was meant to extend it — measured in
 * `CardGrid.test.tsx`, where a Ctrl-click after a plain one came back holding one card instead of
 * two. `@atlaskit/pragmatic-drag-and-drop` asked for the record at `dragstart` and nowhere else,
 * and this is that timing kept.
 *
 * **One listener for the whole window rather than one per source.** A wall draws hundreds of
 * tiles, and a monitor subscription each would be hundreds of callbacks run on every drag to find
 * the one that matters. The `WeakMap` is keyed on the entity and holds no source alive past its
 * own `destroy()`; the returned function is what a caller's teardown runs.
 *
 * It lives here rather than in `lib/dndTarget.ts` because a module-level `dndManager.monitor`
 * subscription has to be in the module that *makes* the manager: `dndManager` imports
 * `features/decks/dnd.ts` for `NOT_A_DRAG`, which imports `dndTarget.ts`, so at the moment that
 * file's body runs this module is still half-evaluated and `dndManager` is `undefined`.
 */
const payloads = new WeakMap<object, () => Record<string, unknown>>();

export function carryAtDragStart(
  source: object,
  read: () => Record<string, unknown>,
): () => void {
  payloads.set(source, read);
  return () => {
    payloads.delete(source);
  };
}

dndManager.monitor.addEventListener("beforedragstart", ({ operation }) => {
  const { source } = operation;
  const read = source ? payloads.get(source) : undefined;
  // `snapshot()` hands the *live* entity through rather than a copy of its record, so setting it
  // here is what every later reader — `accept`, `dragstart`, the drop — sees.
  if (source && read) source.data = read();
});

/**
 * The multi-card count chip, armed for the life of the window.
 *
 * Here rather than in `dragPreview.ts`'s own module scope because that module must not import
 * this one — it takes the manager as an argument precisely so the dependency runs one way and a
 * test can install a chip against a manager of its own.
 */
installCardCountPreview(dndManager);

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

/**
 * Register an entity **now**, rather than on the microtask dnd-kit would have used.
 *
 * **This is a leak fix, and only the running window could have found it.** `Entity`'s
 * constructor ends with `if (manager && register) queueMicrotask(this.register)`, while
 * `destroy()` unregisters synchronously — so an entity constructed and destroyed **in the same
 * tick** unregisters first and is then registered by the microtask, with nothing left holding a
 * reference to undo it. It stays in the manager's registry for the life of the page.
 *
 * `React.StrictMode` does exactly that, on every mount, in development: it runs an effect,
 * cleans it up, and runs it again. Measured in the shipped dev window 2026-08-27 — four folders
 * on screen, **eleven** droppables registered, every visible row carrying two. And a second
 * registration is not harmless here, because the surviving orphan is the one from the *first*
 * effect run, whose monitor listeners were cleaned up: collision detection picked the orphan as
 * `operation.target`, the live hook compared it against its own droppable, saw a different
 * object and returned. **The mark came up, the row rang, and the drop silently did nothing.**
 *
 * Nothing in the suite could see it: `render` and `renderHook` do not wrap in `StrictMode`, so
 * every test mounts each effect exactly once and every registration is the live one.
 *
 * It lives here rather than in `folderDrag.ts`, where it was written, because four more modules
 * need it — a second copy is a second place for the leak to come back.
 *
 * `register: false` at the call sites is the other half — without it the constructor still
 * queues its own registration and this would merely add a second.
 */
export function registerNow(entity: Draggable | Droppable): void {
  entity.register();
}
