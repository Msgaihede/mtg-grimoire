import { createElement } from "react";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NAV } from "@/components/nav";

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
});
