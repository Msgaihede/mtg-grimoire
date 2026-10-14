/**
 * `ShelfHeading`'s `badge` slot (issue #980): the page's mark — the folder rules badge — drawn
 * after the lock glyph and before the figures, and nothing at all without one.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Shelf } from "@/lib/shelves";
import { ShelfHeading } from "./ShelfHeading";

const LOCKED_BINDER: Shelf = {
  id: 3,
  name: "Trade binder",
  kind: "folder",
  group: "own",
  pathIds: [3],
  path: ["Trade binder"],
  depth: 0,
  indent: 0,
  lead: [],
  leadIds: [],
  headless: false,
  collapsed: false,
  locked: true,
};

const follows = (a: Node, b: Node) =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

describe("ShelfHeading badge", () => {
  it("draws the badge after the lock and before the figures", () => {
    render(
      <ShelfHeading
        shelf={LOCKED_BINDER}
        stat="42 cards"
        peek={[]}
        onToggle={vi.fn()}
        onOpen={vi.fn()}
        badge={<span role="img" aria-label="Rules mark" />}
      />,
    );

    const lock = screen.getByRole("img", { name: "Locked" });
    const badge = screen.getByRole("img", { name: "Rules mark" });
    const stat = screen.getByText("42 cards");
    expect(follows(lock, badge)).toBe(true);
    expect(follows(badge, stat)).toBe(true);
  });

  it("draws nothing for an absent badge", () => {
    render(
      <ShelfHeading
        shelf={{ ...LOCKED_BINDER, locked: false }}
        stat="42 cards"
        peek={[]}
        onToggle={vi.fn()}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.queryByRole("img")).toBeNull();
  });
});
