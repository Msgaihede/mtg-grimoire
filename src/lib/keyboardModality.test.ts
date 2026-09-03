import { afterEach, describe, expect, it } from "vitest";
import { compile } from "tailwindcss";
/**
 * The two stylesheets this file compiles, read through Vite rather than `node:fs` — this project
 * has no `@types/node` on purpose, which is `tokens.test.ts`'s note and the reason `?raw` is the
 * house style for a test that asserts against a file's text.
 *
 * `tailwindcss/index.css` is self-contained (one `@tailwind utilities` and no `@import` of its
 * own), so handing it back from `loadStylesheet` is the whole of the resolver this needs.
 */
import twEntry from "tailwindcss/index.css?raw";
import appCss from "@/index.css?raw";
import { installKeyboardModality, KEYBOARD_MODALITY_ATTR } from "./keyboardModality";

/** Every source file in the app, as text, for the sweep at the foot of this file. */
const SOURCES = import.meta.glob<string>("/src/**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
});

let uninstall: (() => void) | null = null;

afterEach(() => {
  uninstall?.();
  uninstall = null;
  document.documentElement.removeAttribute(KEYBOARD_MODALITY_ATTR);
  document.body.innerHTML = "";
});

/** Install against this test's window and remember the teardown. */
function install(): void {
  uninstall = installKeyboardModality(window);
}

/** A real tab stop and a real landing pad, the two shapes the rule has to tell apart. */
function fixture(): { button: HTMLButtonElement; pane: HTMLDivElement } {
  const button = document.createElement("button");
  const pane = document.createElement("div");
  pane.tabIndex = -1;
  document.body.append(button, pane);
  return { button, pane };
}

/** A key the reader pressed, dispatched where a real one lands: on whatever has focus. */
function press(key: string): void {
  (document.activeElement ?? document.body).dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true }),
  );
}

/**
 * A pointer press. `Event` rather than `PointerEvent` on purpose — jsdom's support for the
 * latter has moved between majors, and nothing in the module under test reads a property of
 * this event. The type is the entire signal.
 */
function pointerDown(on: Element): void {
  on.dispatchEvent(new Event("pointerdown", { bubbles: true }));
}

/** Is the app currently claiming the caret arrived by keyboard? */
function armed(): boolean {
  return document.documentElement.hasAttribute(KEYBOARD_MODALITY_ATTR);
}

describe("keyboard modality", () => {
  it("claims nothing before the reader has done anything", () => {
    install();
    expect(armed()).toBe(false);
  });

  /**
   * **The reported bug, as a test.** Chromium's `:focus-visible` flips to `true` here — measured
   * on 2026-09-03, and the four steps are in the module's own header — which is how pressing `w`
   * put a gold outline around an entire modal that the reader had opened with the mouse.
   *
   * Nothing about the caret changed: it is on the same element, put there the same way. The only
   * event was a key that this app does not bind and that moved no focus.
   */
  it("stays quiet when a key moves no focus", () => {
    install();
    const { button } = fixture();
    pointerDown(button);
    button.focus();
    expect(armed()).toBe(false);

    press("w");
    press(" ");
    press("s");
    press("2");

    expect(armed()).toBe(false);
  });

  it("marks a caret that a key moved", () => {
    install();
    const { button } = fixture();
    press("Tab");
    button.focus();
    expect(armed()).toBe(true);
  });

  /**
   * The arrow keys walk a wall of cards, a menu's rows and a table's, and every one of those
   * targets has to keep the outline it has always had — a roving caret nobody can see is the
   * WCAG 2.4.7 failure `src/lib/focus.ts` warns about.
   */
  it("marks a caret the arrow keys walked onto", () => {
    install();
    const { button, pane } = fixture();
    pointerDown(button);
    button.focus();
    expect(armed()).toBe(false);

    press("ArrowDown");
    pane.focus();

    expect(armed()).toBe(true);
  });

  /**
   * No key allowlist, and this is what buys it: `F1` and `Shift+F10` open a layer that focuses
   * something, and neither would be on a hand-written list of "navigation keys". The rule asks
   * what focus *did*, so a shortcut added later is covered without an entry.
   */
  it("marks a caret any shortcut moved, with no key named anywhere", () => {
    install();
    const { pane } = fixture();
    press("F1");
    pane.focus();
    expect(armed()).toBe(true);
  });

  it("leaves a mouse-opened layer unmarked when it focuses its own panel", () => {
    install();
    const { button, pane } = fixture();
    pointerDown(button);
    button.focus();
    // What every dialog in this app does on open: put the caret somewhere rather than drop it
    // on `<body>`. The reader got here with the mouse, so it must draw nothing.
    pane.focus();
    expect(armed()).toBe(false);
  });

  /** Once a keyboard reader is on a control, an unrelated keystroke must not take the mark away. */
  it("keeps the mark while the caret sits still", () => {
    install();
    const { button } = fixture();
    press("Tab");
    button.focus();
    expect(armed()).toBe(true);

    press("w");
    press("Escape");

    expect(armed()).toBe(true);
  });

  /**
   * The press that moves no focus, from the other side. A reader who Tabs to a button and then
   * clicks *that same* button fires no `focusin` at all, so the `focusin` rule alone would leave
   * the outline sitting there under a pointer gesture. Chromium drops its own ring on that press.
   */
  it("drops the mark on a pointer press that moves no focus", () => {
    install();
    const { button } = fixture();
    press("Tab");
    button.focus();
    expect(armed()).toBe(true);

    pointerDown(button);

    expect(armed()).toBe(false);
  });

  it("drops the mark when focus next moves for a reason that is not a key", () => {
    install();
    const { button, pane } = fixture();
    press("Tab");
    button.focus();
    expect(armed()).toBe(true);

    pointerDown(document.body);
    pane.focus();

    expect(armed()).toBe(false);
  });

  it("stops tracking once uninstalled", () => {
    install();
    const { button } = fixture();
    uninstall?.();
    uninstall = null;

    press("Tab");
    button.focus();

    expect(armed()).toBe(false);
  });
});

/**
 * Compile the app's own variant declarations against the real Tailwind and read the selectors
 * back.
 *
 * **Because the failure this guards against is silent.** `src/index.css` says it twice and it is
 * the whole reason this suite compiles anything: a `@custom-variant` Tailwind cannot parse emits
 * *nothing*, with no warning, and `tsc` and every other test still pass. For an override of a
 * variant Tailwind already ships the silence is worse — the built-in simply stays, so every
 * `focus-visible:` utility in the app quietly goes back to the browser heuristic and the bug
 * returns looking exactly like the fix.
 *
 * Compiled from the declarations lifted out of `src/index.css` rather than from copies written
 * here, so a test that passes is a statement about the stylesheet that ships.
 */
async function selectorFor(utility: string, variants: string): Promise<string> {
  const compiler = await compile(`@import "tailwindcss";\n${variants}\n`, {
    base: "/",
    loadStylesheet: (id: string) => {
      if (id !== "tailwindcss") throw new Error(`unexpected stylesheet import: ${id}`);
      return Promise.resolve({ path: "/tailwindcss/index.css", base: "/tailwindcss", content: twEntry });
    },
    loadModule: () => Promise.reject(new Error("no JS modules expected")),
  });
  const built = compiler.build([utility]);
  const escaped = utility.replace(/([:.[\]&])/g, "\\$1");
  const line = built.split("\n").find((l) => l.includes(escaped.split("\\:")[0]) && l.includes("{"));
  return line?.trim() ?? "";
}

/** The `@custom-variant` lines as the shipped stylesheet actually writes them. */
const VARIANTS = appCss
  .split("\n")
  .filter((l) => l.startsWith("@custom-variant"))
  .join("\n");

describe("the focus gate is really compiled", () => {
  it("declares both variants in the stylesheet", () => {
    expect(VARIANTS).toMatch(/@custom-variant focus-visible \(/);
    expect(VARIANTS).toMatch(/@custom-variant focus-thumb \(/);
  });

  it("makes every focus-visible: utility require the keyboard attribute", async () => {
    const selector = await selectorFor("focus-visible:outline-2", VARIANTS);
    expect(selector).toContain(KEYBOARD_MODALITY_ATTR);
    expect(selector).toContain(":focus-visible");
  });

  it("gates the range thumb, whose ring is on a pseudo-element the variant cannot reach", async () => {
    const selector = await selectorFor("focus-thumb:outline-2", VARIANTS);
    expect(selector).toContain(KEYBOARD_MODALITY_ATTR);
    expect(selector).toContain("::-webkit-slider-thumb");
  });

  /** The control: an override this broad must not have leaked into unrelated variants. */
  it("leaves other variants alone", async () => {
    const selector = await selectorFor("hover:underline", VARIANTS);
    expect(selector).not.toContain(KEYBOARD_MODALITY_ATTR);
  });

  /**
   * The user agent's own `:focus-visible { outline: auto }` runs off the browser heuristic and
   * nothing Tailwind does can gate it — so without this rule the fix would read as a *recolour*:
   * the gold outline replaced by the platform's blue one, on the same keystroke.
   */
  it("suppresses the browser's own ring while the reader is not on the keyboard", () => {
    expect(appCss).toMatch(/html:not\(\[data-kbd\]\) :focus-visible[\s\S]{0,140}outline: none/);
  });

  /**
   * The one way a call site can still dodge the gate: spelling `:focus-visible` inside an
   * *arbitrary* variant, which Tailwind never rewrites because it is a string the component
   * wrote rather than a variant Tailwind owns. `PriceRange` did exactly that and is why
   * `focus-thumb` exists; a second one would be a control that goes on drawing its ring for a
   * keystroke that moved nothing, with every other outline in the app correctly quiet.
   */
  it("has no component spelling :focus-visible inside an arbitrary variant", () => {
    const offenders = Object.entries(SOURCES)
      .filter(([path]) => !path.endsWith("keyboardModality.test.ts"))
      .filter(([, text]) => /\[[^\]]*&[^\]]*:focus-visible[^\]]*\]:/.test(text))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});
