import { afterEach, describe, expect, it } from "vitest";
import css from "@/index.css?raw";
import { folderDraggable } from "@/lib/folderDrag";
import { startPointerDrag } from "@/test-drag";

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
 * declarations are untouched; only the selector is gated on the library's own feedback element
 * existing.
 */
const DRAG_SCOPE = ":root:has([data-dnd-dragging])";

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

/** A rect of its own, because jsdom measures every box as zero and a drag has to travel five
 *  pixels from somewhere. */
function boxed(element: HTMLElement): HTMLElement {
  element.getBoundingClientRect = () =>
    ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 200,
      bottom: 40,
      width: 200,
      height: 40,
      toJSON: () => ({}),
    }) as DOMRect;
  return element;
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
  const element = boxed(document.createElement("div"));
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
