import { createElement } from "react";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NAV } from "@/components/nav";
import { shortcut } from "@/lib/shortcuts";

describe("the navigation census", () => {
  it("names every view exactly once", () => {
    const ids = NAV.map((e) => e.id);
    expect(ids).toEqual(["search", "tags", "decks", "collection", "wishlist", "settings"]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  /**
   * The label is also the ribbon's `<h1>`, so a second list of words is a second thing to keep
   * in step — which is the whole reason this module exists rather than the bar copying six
   * strings out of the rail.
   *
   * **The glyph is checked by drawing it, not by its `typeof`.** Under `lucide-react` 1.x a
   * `LucideIcon` is a `forwardRef` **object** — `$$typeof: Symbol(react.forward_ref)`, keys
   * `["$$typeof", "render"]` — for lucide's own icons and for `icons.ts`'s `createLucideIcon`
   * copies alike, so `toBeTypeOf("function")` fails on all six. And the weaker `"object"` that
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
   * Every destination is reachable from the keyboard — the one thing about this list that lives
   * in another module.
   *
   * `Ctrl+1…6` is bound **by index**: `AppShell` walks `switchView`'s chords and activates
   * `NAV[i]`. So the two lists are one binding written down twice, and nothing in the program
   * holds them together — `shortcuts.ts` deliberately does not import this module, because the
   * catalogue is pure data over a plain event and a runtime edge from it to a file of React
   * components is the wrong direction. A *test* importing both is the fence that costs nothing
   * at runtime.
   *
   * **Growth is the direction that goes silent, which is why the fence is here rather than in
   * `shortcuts.test.ts`.** A seventh entry added to the array above with no seventh chord is
   * simply unreachable, while the panel goes on saying "Jump to a section" over a range that no
   * longer covers the rail — and the catalogue's own tests would all still pass, because they
   * pin `Ctrl+1` through `Ctrl+6` literally and have never heard of this list. The other two
   * directions are already answered: a shrink is caught by `AppShell`'s `i >= NAV.length` floor,
   * and a reorder remapping the digits is the design working as intended.
   *
   * A length rather than a literal six, because the literal is `shortcuts.test.ts`' job and
   * stating it twice would make a legitimate seventh view two edits away from green instead of
   * one. The pair is what pins it: that file says the chords are `Ctrl+1…6`, this one says there
   * are as many of them as there are places to go.
   */
  it("has a chord for every destination", () => {
    expect(shortcut("global", "switchView").chords).toHaveLength(NAV.length);
  });
});
