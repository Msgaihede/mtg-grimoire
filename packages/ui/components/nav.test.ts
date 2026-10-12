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
   * ⚠️ **One destination goes without a chord, and the run ends exactly at the rail's end.**
   * `shared` goes without because its row is **conditional**, and a digit bound to a row that
   * appears and disappears would mean two things to two readers. Settings was the second, pushed
   * past `Ctrl+9` when Home arrived; the Tagger row leaving (issue #937, tag search is the search
   * page's sidebar now) gave it back.
   *
   * **The first and ninth entries are pinned by name**, because a length can only say *how many*
   * are reached, never *which* — and it is the *which* a reader has in their fingers.
   */
  it("puts nine destinations inside the run of digits, ending at Settings", () => {
    const chorded = NAV.filter((n) => n.id !== "shared");
    // The run itself: nine digits, `Ctrl+1` through `Ctrl+9`, as `shortcuts.test.ts` pins
    // literally. Read rather than restated, so the two files cannot disagree about the length.
    const digits = shortcut("global", "switchView").chords.length;
    expect(digits).toBe(9);

    // `Ctrl+1` is Home — the top of the column and the page the app opens on.
    expect(chorded[0].id).toBe("home");
    // …and `Ctrl+9` is Settings, the last row. Written out as the word rather than as
    // `chorded[digits - 1].id`, per the rule that an assertion must not read its own constant.
    expect(chorded[8].id).toBe("settings");
    expect(chorded).toHaveLength(digits);

    // And `shared` is left out of `CHORD_NAV` altogether, for its own reason.
    expect(NAV.map((n) => n.id)).toContain("shared");
    expect(chorded.map((n) => n.id)).not.toContain("shared");
    expect(chorded).toHaveLength(NAV.length - 1);
  });
});
