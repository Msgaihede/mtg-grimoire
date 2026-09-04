import { describe, expect, it } from "vitest";
import { LAYER } from "./layers";

/**
 * Every source file in the app, as text. The stylesheet is in the sweep for the reason
 * `tokens.test.ts` gives: Tailwind's scanner reads prose as eagerly as code, so a class
 * named in a comment is a class the build emits a rule for.
 */
const SOURCES = import.meta.glob<string>("/src/**/*.{ts,tsx,css}", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** Any Tailwind z-index utility, with or without a variant prefix in front of it. */
const Z_CLASS = /\bz-(?:\d+|auto|\[[^\]]*\])\b/g;

const numberOf = (cls: string): number => Number(/z-(\d+)/.exec(cls)![1]);

describe("the layer scale", () => {
  /**
   * The bug this scale exists for: the set picker and the tables' sticky headers were both
   * `z-20` in the root stacking context, and equal z-indexes are resolved by document
   * order — where every header comes after the filter bar it was drawn over.
   */
  it("puts a popup above a sticky header, and a lifted row below one", () => {
    // Below everything: it orders two marks inside one card's own strip and nothing else.
    expect(numberOf(LAYER.overlappingMark)).toBeLessThan(numberOf(LAYER.raised));
    expect(numberOf(LAYER.raised)).toBeLessThan(numberOf(LAYER.header));
    expect(numberOf(LAYER.header)).toBeLessThan(numberOf(LAYER.popup));
    expect(numberOf(LAYER.popup)).toBeLessThan(numberOf(LAYER.dragTray));
    expect(numberOf(LAYER.dragTray)).toBeLessThan(numberOf(LAYER.overlay));
    // A dialog opened over another dialog is above the one it covers. Both are `fixed inset-0`
    // siblings in the root stacking context, so this number is the only thing ordering them —
    // at one rung they would fall back to document order, which is the bug `layers.ts` opens with.
    expect(numberOf(LAYER.overlay)).toBeLessThan(numberOf(LAYER.overlayStacked));
    // A tooltip is shown over the deck editor's dialogs, so it outranks the scrim they draw —
    // and it has to clear the *highest* dialog rung, not just the base one, because a control
    // inside a nested overlay has as much to explain as one anywhere else. It stays under `gate`
    // because `SyncProgress`'s full-window takeover must still cover a hint describing a control
    // the reader can no longer see.
    expect(numberOf(LAYER.overlayStacked)).toBeLessThan(numberOf(LAYER.tooltip));
    expect(numberOf(LAYER.tooltip)).toBeLessThan(numberOf(LAYER.gate));
    // And the window's own caption is above every one of them. `decorations: false` makes that
    // row the only way to move, minimize or close the app, so a surface covering it does not
    // obscure a control — it takes the window away. Both full-window surfaces did exactly that
    // until 2026-08-22, the gate for the length of a first sync and the scrim for every modal.
    expect(numberOf(LAYER.gate)).toBeLessThan(numberOf(LAYER.caption));
  });

  /**
   * The row lift is spelled as a `:has` variant, and Tailwind's scanner reads whole class
   * names out of source text — so a variant assembled by interpolation emits no rule at
   * all. It has to be written out, which is why it is its own entry.
   */
  it("spells the row lift out whole, at the raised layer", () => {
    expect(LAYER.raisedWhenPopupOpen).toBe(`has-[[aria-expanded=true]]:${LAYER.raised}`);
  });

  /**
   * The deck stack's lift used to be two variant entries of its own, one for `hover:` and one
   * for `focus-within:`. It is state now — `CardStack` knows which card is open and applies
   * the plain class — so the pair is gone and this is what says so: a variant entry that
   * nothing spells is a rule Tailwind still emits and a reader still has to account for.
   */
  it("keeps no variant spelling for the stack lift, which is state now", () => {
    expect(Object.keys(LAYER)).not.toContain("raisedOnHover");
    expect(Object.keys(LAYER)).not.toContain("raisedOnFocus");
  });

  /**
   * A scale nothing is obliged to use is a comment. Written as a sweep rather than as a
   * review rule because the failure it prevents — an inline `z-20` losing to a header by
   * document order — is invisible in every test that does not paint.
   */
  it("is the only place in src/ that names a z-index", () => {
    // A glob that stops matching returns `{}`, and a sweep over nothing finds nothing.
    expect(Object.keys(SOURCES).length).toBeGreaterThan(20);

    const offenders: string[] = [];
    for (const [path, source] of Object.entries(SOURCES)) {
      if (path.endsWith("/src/lib/layers.ts")) continue;
      // Tests name classes to assert on them, and asserting on one is not shipping it.
      if (path.includes(".test.")) continue;
      for (const match of source.matchAll(Z_CLASS)) {
        offenders.push(`${path}: ${match[0]}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
