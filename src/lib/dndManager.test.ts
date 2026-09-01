import { afterEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { PointerActivationConstraints, PointerSensor } from "@dnd-kit/dom";
import css from "@/index.css?raw";
import { folderDraggable } from "@/lib/folderDrag";
import { dndManager, DRAGGING_ATTRIBUTE } from "@/lib/dndManager";
import { dndDraggable } from "@/lib/dndTarget";
import { boxed, startPointerDrag } from "@/test-drag";
/**
 * The manifest as text, read through Vite rather than through `node:fs` — this project has
 * no `@types/node` on purpose, and `src/lib/tokens.test.ts` reaches two levels up to
 * `.storybook/preview.tsx?raw` the same way. A static import, which is what Vite's ambient
 * `*?raw` declaration types; a dynamic one would be typed `any`.
 */
import manifest from "../../package.json?raw";

/**
 * **The fence around the block at the foot of `src/index.css`.**
 *
 * `@dnd-kit/dom` styles a drag from a `<style>` element its `StyleInjector` builds at runtime and
 * prepends to `<head>`. The shipped `style-src 'self'` refuses an inline stylesheet, the injector
 * is a `CorePlugin` and cannot be unregistered, and the failure is silent and **only in a
 * packaged build** — `devCsp` carries `'unsafe-inline'`, Vite and Storybook serve no policy at
 * all, and jsdom enforces none. So the rules are copied into the app's own bundled stylesheet,
 * which `'self'` allows, and `dndManager.ts` and `index.css` carry the reasoning.
 *
 * A copy is only as good as what keeps it in step. **This does not assert that `index.css`
 * contains a string somebody typed here** — that would go green against a library that had moved
 * on, which is the whole failure being guarded. It runs a **real drag through the app's own
 * manager**, in the one environment where nothing is blocked, captures the stylesheets the
 * library actually injected, and fails unless every selector and every declaration in them is
 * also in `index.css`. An upgrade that renames an attribute, adds a rule or changes a custom
 * property is a red build here rather than a drag preview that stops following the pointer in the
 * exe alone.
 */

/**
 * The one place this copy departs from the library, and it is a fence rather than a change.
 *
 * `Cursor` and `PreventSelection` register bare `*` rules — which the library can afford because
 * it adds and removes them around a single drag. Copied verbatim into a stylesheet that is always
 * loaded, a grabbing cursor on `*` would put a closed hand over the whole app forever. The
 * declarations are untouched; only the ancestor is added, and `dndManager.ts` sets that mark for
 * exactly as long as the library's own rules would have been up.
 */
const DRAG_SCOPE = `html[${DRAGGING_ATTRIBUTE}]`;

/** The library's selector, as this file expects to find it spelled in `index.css`. */
function asCopied(selector: string): string {
  return selector === "*" ? `${DRAG_SCOPE} *` : selector;
}

/** Nested rules are keyed by their whole path, so `@layer` and CSS nesting cannot be flattened
 *  away into a match that ignores where a rule actually sits. */
const NEST = " > ";

type Rules = Map<string, Set<string>>;

/**
 * Whitespace, comma spacing and quote style are the three ways two spellings of one rule differ
 * without disagreeing about anything. The library ships its rules already collapsed onto one
 * line; `index.css` is indented for a reader.
 */
function tidy(text: string): string {
  return text
    .replace(/"/g, "'")
    .replace(/\s+/g, " ")
    .replace(/\s*,\s*/g, ",")
    .trim();
}

/**
 * Every `selector -> declarations` pair in a stylesheet, nesting included.
 *
 * Hand-rolled rather than read off `style.sheet`: jsdom's CSSOM predates `@layer`, CSS nesting
 * and `:is()`, and drops what it cannot parse — silently, which would make this whole file a
 * green test over an empty capture.
 */
function parse(source: string): Rules {
  const rules: Rules = new Map();
  walk(source.replace(/\/\*[\s\S]*?\*\//g, ""), []);
  return rules;

  function walk(text: string, path: readonly string[]): void {
    let buffer = "";
    for (let i = 0; i < text.length; i++) {
      const character = text[i];
      if (character === "{") {
        const end = closing(text, i);
        walk(text.slice(i + 1, end), [...path, tidy(buffer)]);
        buffer = "";
        i = end;
      } else if (character === ";") {
        record(path, buffer);
        buffer = "";
      } else {
        buffer += character;
      }
    }
    // A last declaration is allowed to go without its semicolon.
    record(path, buffer);
  }

  function record(path: readonly string[], declaration: string): void {
    // A statement at the top level is an `@import` or an `@layer` order, not a declaration.
    if (path.length === 0 || tidy(declaration) === "") return;
    const key = path.join(NEST);
    let declarations = rules.get(key);
    if (!declarations) {
      declarations = new Set();
      rules.set(key, declarations);
    }
    declarations.add(tidy(declaration));
  }

  function closing(text: string, open: number): number {
    let depth = 0;
    for (let i = open; i < text.length; i++) {
      if (text[i] === "{") depth += 1;
      else if (text[i] === "}") {
        depth -= 1;
        if (depth === 0) return i;
      }
    }
    return text.length;
  }
}

/**
 * Whether a selector puts `:has()` in an *ancestor* position — the shape whose cost is paid once
 * per element in the document rather than once per match. See the test that uses it for the
 * measurement and for what it broke.
 */
function scansTheDocumentPerElement(selector: string): boolean {
  const at = selector.indexOf(":has(");
  if (at < 0) return false;
  let depth = 0;
  let i = selector.indexOf("(", at);
  for (; i < selector.length; i++) {
    if (selector[i] === "(") depth += 1;
    else if (selector[i] === ")") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  // A combinator after the `:has()` means something to its right is the subject, and that is what
  // every element in the document gets tested against.
  return /[\s>+~]/.test(selector.slice(i + 1));
}

const undo: (() => void)[] = [];

afterEach(() => {
  for (const stop of undo.splice(0).reverse()) stop();
});

/**
 * Hold a real drag open and read back what `StyleInjector` put in `<head>` while it was up.
 *
 * The sheets are gone by the time the drag ends — the injector reference-counts them and removes
 * the element at zero — so the capture has to happen mid-gesture. Diffed against what was in
 * `<head>` beforehand, so nothing another part of the environment mounted is mistaken for the
 * library's.
 */
async function injectedDuringADrag(): Promise<string[]> {
  const element = boxed(document.createElement("div"), 0);
  element.textContent = "a folder";
  document.body.append(element);
  const stop = folderDraggable({
    element,
    folder: () => ({ folderId: 4, name: "Standard", parentId: null, scope: "deck" }),
  });
  undo.push(() => {
    stop();
    element.remove();
  });

  const before = new Set(document.head.querySelectorAll("style"));
  const held = await startPointerDrag(element);
  expect(held.started, "the probe drag never started, so nothing was injected").toBe(true);
  const sheets = [...document.head.querySelectorAll("style")]
    .filter((style) => !before.has(style))
    .map((style) => style.textContent ?? "");
  await held.cancel();
  return sheets;
}

describe("the dnd-kit rules copied into index.css", () => {
  it("carries every selector and declaration the library injects during a drag", async () => {
    const sheets = await injectedDuringADrag();
    const library = parse(sheets.join("\n"));
    const ours = parse(css);

    // Four ways this goes vacuously green, each pinned: a drag that injected nothing, a capture
    // the parser could not read, a library that stopped shipping its `*` rules (which is what the
    // scope above exists for), and a stylesheet import that came back empty.
    expect(sheets.length, "no stylesheet was injected").toBeGreaterThanOrEqual(3);
    expect(library.size, "the capture parsed to almost nothing").toBeGreaterThanOrEqual(8);
    expect([...library.keys()], "the library no longer registers a bare `*` rule").toContain("*");
    expect(css.length, "index.css came back empty").toBeGreaterThan(1000);

    const missing: string[] = [];
    for (const [selector, declarations] of library) {
      const copied = asCopied(selector);
      const mine = ours.get(copied);
      if (!mine) {
        missing.push(`${copied} — the whole rule is absent from index.css`);
        continue;
      }
      for (const declaration of declarations) {
        if (!mine.has(declaration)) missing.push(`${copied} { ${declaration} }`);
      }
    }

    expect(missing, "dnd-kit rules that index.css does not carry").toEqual([]);
  });

  /**
   * The half a containment check cannot see. `Cursor`'s and `PreventSelection`'s rules are the
   * two the library only ever has up for the length of a gesture, and a future fix that satisfied
   * the assertion above by pasting the library's bare `*` in verbatim would pass it — and put a
   * closed hand and an unselectable page over the entire app, permanently.
   */
  it("never copies a bare `*` rule in unscoped", async () => {
    const library = parse((await injectedDuringADrag()).join("\n"));
    const globals = library.get("*");
    expect(globals, "the library's `*` rules were not captured").toBeDefined();

    const ours = parse(css);
    expect([...ours.keys()], "a bare `*` rule reached index.css").not.toContain("*");
    for (const declaration of globals ?? []) {
      expect(
        [...(ours.get(`${DRAG_SCOPE} *`) ?? [])],
        `${declaration} is not fenced behind a drag`,
      ).toContain(declaration);
    }
  });

  /**
   * **The fence is two halves and this is the half CSS cannot state.** The rules above hang off
   * `html[data-dragging]`, and a mark nothing ever sets is a stylesheet that silently does
   * nothing — the grabbing cursor and the selection guard would be gone from the shipped app with
   * every assertion in this file still green. So the wiring is asserted through a real drag
   * rather than by reading `dndManager.ts`.
   */
  it("marks the document for the length of a drag, and unmarks it after", async () => {
    const element = boxed(document.createElement("div"), 0);
    document.body.append(element);
    const stop = folderDraggable({
      element,
      folder: () => ({ folderId: 7, name: "Modern", parentId: null, scope: "deck" }),
    });
    undo.push(() => {
      stop();
      element.remove();
    });

    expect(document.documentElement.hasAttribute(DRAGGING_ATTRIBUTE)).toBe(false);
    const held = await startPointerDrag(element);
    expect(held.started, "the probe drag never started").toBe(true);
    expect(
      document.documentElement.hasAttribute(DRAGGING_ATTRIBUTE),
      "nothing marked the document, so the copied `*` rules can never match",
    ).toBe(true);
    await held.cancel();
    expect(
      document.documentElement.hasAttribute(DRAGGING_ATTRIBUTE),
      "the mark outlived the drag, so the whole app keeps a grabbing cursor",
    ).toBe(false);
  });

  /**
   * **The shape of selector that cost a shipped test, fenced so it cannot come back.**
   *
   * The first spelling of the fence above was `:root:has([data-dnd-dragging]) *`, which is
   * correct CSS, free in a browser, and quadratic in jsdom: style resolution matches every loaded
   * rule against every element, and a rule whose *subject* is broad and whose ancestor part holds
   * `:has()` makes each of those matches a scan of the whole document. Measured 2026-08-28 over a
   * 400-element tree with a DOM mutation between reads — what a `userEvent` gesture produces —
   * **4.1s with an attribute ancestor against 18.6s with the `:has()`**. What it broke was
   * `DeckEditor.stories.tsx > SwapFolds`, a play that drags nothing: 3.5s to just over the 15s
   * `testTimeout`, i.e. the whole suite taxed by one selector in one stylesheet.
   *
   * **It is the broad subject that is expensive, not `:has()`.** An unrelated
   * `.thing:has(.other)` measured 436ms against a 447ms baseline, because its subject fails
   * before the `:has()` is ever evaluated — so this fence refuses one shape rather than the
   * pseudo-class, and a `has-[…]` utility on a real class is unaffected.
   */
  it("authors no selector that makes every style read scan the document", () => {
    // The rule itself, checked against the two spellings that made it and one that is fine —
    // without which a predicate that had stopped detecting anything would pass over every file.
    expect(scansTheDocumentPerElement(":root:has([data-dnd-dragging]) *")).toBe(true);
    expect(scansTheDocumentPerElement(":root:has([data-dnd-dragging]) > div")).toBe(true);
    expect(scansTheDocumentPerElement(`${DRAG_SCOPE} *`)).toBe(false);
    expect(scansTheDocumentPerElement(".card:has(img)")).toBe(false);

    const offenders = [...parse(css).keys()].filter(scansTheDocumentPerElement);
    expect(offenders, "index.css selectors that scan the document for every element").toEqual([]);
  });

  /**
   * **Measured 2026-08-28, and the reason the layer is declared at the top of the file rather
   * than where its rules are written.** A cascade layer takes its order from where it is first
   * named, and the library's sheet is *prepended* to `<head>` so that its own `@layer dnd-kit`
   * sorts before every other layer in the document and therefore loses to them. Ours has to do
   * the same, and the block itself sits at the foot of the file — after Tailwind's `@import`,
   * which is where `theme`, `base`, `components` and `utilities` are named. Built both ways
   * against tailwindcss 4.3.x: with the statement, `dist/assets/index-*.css` orders the layers
   * `properties, dnd-kit, theme, base, components, utilities`; without it, `dnd-kit` lands
   * **last** — the highest priority in the sheet — and its resets then beat the utility classes
   * the dragged clone is drawn with, which is the preview being broken in a second way by the fix
   * for the first.
   */
  it("names its cascade layer before Tailwind's", () => {
    const statement = css.indexOf("@layer dnd-kit;");
    const tailwind = css.indexOf('@import "tailwindcss"');
    expect(statement, "no `@layer dnd-kit;` statement in index.css").toBeGreaterThanOrEqual(0);
    expect(tailwind).toBeGreaterThanOrEqual(0);
    expect(statement).toBeLessThan(tailwind);
  });
});

/**
 * **A draggable that is also a control keeps its own keys**, which is the whole of why this
 * manager carries no `KeyboardSensor`.
 *
 * That sensor binds a bubble-phase `keydown` to the source element and answers Space or Enter by
 * starting a drag, with `preventDefault()` and `stopImmediatePropagation()` — so a press on a
 * deck row, a search tile or a collection row would never reach the handler that opens the card.
 * Its default `preventActivation` only excuses a press that landed on a *child*.
 *
 * Driven with `user.keyboard` on a genuinely focused element rather than a synthetic
 * `dispatchEvent`, which collapses the capture ladder into registration order and would report a
 * pass it had not earned.
 */
describe("the manager's sensors", () => {
  it("leaves Enter and Space to a draggable that is also a control", async () => {
    const pressed = vi.fn();
    const element = boxed(document.createElement("button"), 0);
    element.textContent = "Sol Ring";
    document.body.append(element);
    const stop = folderDraggable({
      element,
      folder: () => ({ folderId: 1, name: "Reds", parentId: null, scope: "deck" }),
    });
    // **On an ancestor, and after the registration** — which is where React's own handlers are.
    // React 19 delegates every keydown handler to the root container, so the sensor's
    // stopImmediatePropagation on the element does not merely reorder two listeners: it stops
    // the press reaching the app at all. A listener on the element registered first would go on
    // firing and prove nothing.
    const listener = (event: Event) => pressed((event as KeyboardEvent).key);
    document.body.addEventListener("keydown", listener);

    element.focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard(" ");

    expect(pressed.mock.calls).toEqual([["Enter"], [" "]]);
    expect(dndManager.dragOperation.status.idle).toBe(true);

    document.body.removeEventListener("keydown", listener);
    stop();
    element.remove();
  });

  /**
   * **Issue #331 — "drag and drop is broken when dragging on an image", and it was the whole app.**
   *
   * `Draggable`'s effect resolves a source's sensors as
   * `this.sensors?.map(descriptor) ?? [...manager.sensors]`, and for a **descriptor** it calls
   * `manager.registry.register(entry.plugin)` — the plugin alone, with the entry's options
   * dropped. `PluginRegistry.register` reads an omitted `options` as an instruction to *write*
   * them: `if (existing.options !== options) existing.options = options`. So the first source in
   * the window that declares a `sensors` list of its own sets this manager's one `PointerSensor`
   * instance's options to `undefined`, permanently — and every source that registers afterwards
   * binds with `options = this.options`, which is now nothing, and falls back to the library's
   * own `preventActivation`. That default refuses any press whose target sits inside an
   * interactive element, and in this app **a card's art is a button**: a tile could still be
   * dragged by its caption and not by its picture, on every card surface at once, until a reload.
   *
   * The one source that declares its own sensors is the category grip
   * (`features/decks/categoryDrag.ts`), so opening a deck editor once was enough to break the
   * search wall, the collection, the wishlist and the deck gallery behind it.
   *
   * This is the gesture rather than the shape of `options`: press a tile **on its art** after a
   * handle-bearing source has registered, and the drag has to start.
   */
  it("keeps its own press rule when a source registers sensors of its own", async () => {
    // The category grip: a handle-bearing source, which is the only kind in this app that has to
    // carry a `sensors` list — a declared handle switches dnd-kit's activation constraints off,
    // so the 5px distance has to be put back by hand.
    const heading = boxed(document.createElement("div"), 100);
    const grip = boxed(document.createElement("button"), 100);
    heading.append(grip);
    document.body.append(heading);
    const stopGrip = dndDraggable({
      element: heading,
      handle: grip,
      data: () => ({ categoryId: 1 }),
      sensors: [
        PointerSensor.configure({
          activationConstraints: [new PointerActivationConstraints.Distance({ value: 5 })],
        }),
      ],
    });

    // A card tile, registered after it — the search wall a reader comes back to. The source is
    // the tile and the art inside it is a `<button>`, which is this app's shape everywhere.
    const tile = boxed(document.createElement("div"), 0);
    const art = boxed(document.createElement("button"), 0);
    tile.append(art);
    document.body.append(tile);
    const stopTile = dndDraggable({ element: tile, data: () => ({ cardId: "sol-ring" }) });

    const held = await startPointerDrag(tile, { pressOn: art });
    expect(held.started).toBe(true);

    await held.cancel();
    stopTile();
    stopGrip();
    tile.remove();
    heading.remove();
  });
});


/**
 * Every source file in the app and in the workbench, as text. `?raw` through Vite rather than
 * `node:fs`, for the reason given at the `manifest` import above; `src/lib/tokens.test.ts` runs
 * the same sweep over the same glob.
 *
 * **Both roots, because the removed library had call sites in both.** Four story files each
 * carried a copy of a `DataTransfer` shim until 3b, and `.storybook/` is outside a `/src/**`
 * glob — so a sweep scoped to the app alone would have gone green over a workbench that had
 * put the library back.
 */
const SOURCES = {
  ...import.meta.glob<string>("/src/**/*.{ts,tsx}", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
  ...import.meta.glob<string>("/.storybook/**/*.{ts,tsx}", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
};

/**
 * **The banned thing is the import, not the name.** Files all over this app still mention
 * `@atlas` + `kit/pragmatic-drag-and-drop` in a doc comment, and every one of those mentions is
 * the record of why something is the way it is — why `DropIndicator` draws its own line rather
 * than taking the hitbox package, why `folderDrag.ts`'s edge arithmetic is hand-rolled, why
 * `dnd.ts` says that a second registration on one element used to replace the first and no longer
 * does. A sweep that matched the bare name would make this project's memory of its own reasons a
 * thing that fails the build. `src/lib/tokens.test.ts` learned that once already, when a class
 * named in prose failed the token sweep.
 */
const PRAGMATIC_IMPORT = /(?:from|import)\s*\(?\s*["']@atlaskit\//;

/**
 * The banned name, assembled from two pieces.
 *
 * Spelled whole it would appear in this file as `from "@atlas` + `kit/` — which is exactly what
 * {@link PRAGMATIC_IMPORT} matches, so the sweep below would report **itself** as an offender and
 * the fence would be red on a tree with nothing wrong with it. `tokens.test.ts` splits its own
 * banned class for the same shape of reason.
 */
const ATLAS = `@atlas${"kit"}`;

describe("the drag library is the only drag library", () => {
  it("imports nothing from @atlaskit anywhere in src", () => {
    const offenders = Object.entries(SOURCES)
      .filter(([, source]) => PRAGMATIC_IMPORT.test(source))
      .map(([path]) => path);
    expect(offenders, "files importing the removed drag library").toEqual([]);
  });

  /**
   * The half a source sweep cannot see: a dependency can be back in the manifest with nothing
   * importing it yet, which is how it comes back — one `npm install` that looked harmless.
   */
  it("declares no @atlaskit dependency", () => {
    expect(manifest).not.toMatch(new RegExp(`"${ATLAS}/`));
  });

  /**
   * The sweep proving it can see anything at all. Without this, a glob that silently matched no
   * files — a moved test, a changed pattern — would pass both tests above forever.
   */
  it("is reading real source", () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(100);
    expect(Object.keys(SOURCES).some((path) => path.startsWith("/.storybook/"))).toBe(true);
    expect(
      PRAGMATIC_IMPORT.test(
        `import { draggable } from "${ATLAS}/pragmatic-drag-and-drop/element/adapter";`,
      ),
    ).toBe(true);
    expect(
      PRAGMATIC_IMPORT.test(` * \`${ATLAS}/pragmatic-drag-and-drop\` keeps one drop target per element.`),
    ).toBe(false);
  });
});
