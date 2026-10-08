import { createElement } from "react";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NAV } from "@/components/nav";
import { shortcut } from "@/lib/shortcuts";

describe("the navigation census", () => {
  it("names every view exactly once", () => {
    const ids = NAV.map((e) => e.id);
    expect(ids).toEqual([
      // First, because it is the page the app opens on and a reader reads a column downward —
      // a landing page anywhere but the top row is a page the reader is standing on and cannot
      // find. Its arrival is what renumbered every chord below it.
      "home",
      "search",
      "tags",
      "decks",
      "collection",
      "wishlist",
      // Beside the three lists the reader owns, because it is a fourth list of cards — and
      // before Scanner so that Settings stays last. `AppShell` is what hides the row until a
      // share has been opened; this module stays the whole set, which is what lets this
      // assertion be a literal.
      "shared",
      "scanner",
      "trade",
      "playtesting",
      "settings",
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  /**
   * The label is also the ribbon's `<h1>`, so a second list of words is a second thing to keep
   * in step — which is the whole reason this module exists rather than the bar copying nine
   * strings out of the rail.
   *
   * **The glyph is checked by drawing it, not by its `typeof`.** Under `lucide-react` 1.x a
   * `LucideIcon` is a `forwardRef` **object** — `$$typeof: Symbol(react.forward_ref)`, keys
   * `["$$typeof", "render"]` — for lucide's own icons and for `icons.ts`'s `createLucideIcon`
   * copies alike, so `toBeTypeOf("function")` fails on all nine. And the weaker `"object"` that
   * would pass is equally true of the `null` this case exists to catch. Rendering one is the
   * only assertion here that tells a glyph from anything else.
   */
  it("gives every entry a word and a glyph", () => {
    for (const entry of NAV) {
      expect(entry.label.length).toBeGreaterThan(0);
      const { container, unmount } = render(createElement(entry.Icon));
      expect(container.querySelector("svg")).not.toBeNull();
      unmount();
    }
  });

  /**
   * Which destinations a digit reaches — the one thing about this list that lives in another
   * module.
   *
   * `Ctrl+1…9` is bound **by index**: `AppShell` walks `switchView`'s chords and activates
   * `CHORD_NAV[i]`, where `CHORD_NAV` is this list minus `shared`. So the two lists are one
   * binding written down twice, and nothing in the program holds them together —
   * `shortcuts.ts` deliberately does not import this module, because the catalogue is pure data
   * over a plain event and a runtime edge from it to a file of React components is the wrong
   * direction. A *test* importing both is the fence that costs nothing at runtime.
   *
   * ⚠️ **Two destinations go without a chord and the reasons are different, which is why this is
   * no longer a subtraction.** It used to read `NAV.length - 1` against a rail of ten, on the
   * argument that a second exclusion should have to be *written* rather than arrive by
   * arithmetic. It has been written: `shared` goes without because its row is **conditional**,
   * and a digit bound to a row that appears and disappears would mean two things to two readers;
   * `settings` goes without because the **run is nine long and the rail is eleven**, and Home
   * belongs at the top in reading order. The first reason no amount of room would change; the
   * second is arithmetic and would reverse the day a tenth digit existed.
   *
   * **The ninth entry is pinned by name, and that is the fence a renumbering needs.** A
   * merge that quietly restored the old order would put Settings back on `Ctrl+9` with every
   * count in this file still correct — a length can only say *how many* go without, never
   * *which*, and it is the *which* that a reader has in their fingers.
   */
  it("puts nine destinations inside the run of digits, ending at Playtesting", () => {
    const chorded = NAV.filter((n) => n.id !== "shared");
    // The run itself: nine digits, `Ctrl+1` through `Ctrl+9`, as `shortcuts.test.ts` pins
    // literally. Read rather than restated, so the two files cannot disagree about the length.
    const digits = shortcut("global", "switchView").chords.length;
    expect(digits).toBe(9);

    // `Ctrl+1` is Home — the top of the column and the page the app opens on.
    expect(chorded[0].id).toBe("home");
    // …and `Ctrl+9` is Playtesting, which is where the run stops. Written out as the word rather
    // than as `chorded[digits - 1].id`, per the rule that an assertion must not read its own
    // constant.
    expect(chorded[8].id).toBe("playtesting");

    // **Settings is past the end**, which is the half the two lines above cannot say: it is on
    // the rail, it is not in the run, and `Ctrl+9` does not open it.
    expect(chorded.slice(0, digits).map((n) => n.id)).not.toContain("settings");
    expect(NAV.map((n) => n.id)).toContain("settings");

    // And `shared` is left out of `CHORD_NAV` altogether — the other exclusion, for its own
    // reason, and the one that is a filter rather than a run ending.
    expect(NAV.map((n) => n.id)).toContain("shared");
    expect(chorded.map((n) => n.id)).not.toContain("shared");
    expect(chorded).toHaveLength(NAV.length - 1);
  });
});
