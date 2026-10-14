/**
 * `CardGrid`'s `ruleBreak` slot (issue #980, spec §5): a tile whose card breaks its folder's rules
 * is outlined in destructive red — the tile's ring and the chin's edge — and says why in its art
 * button's description. The gold selection ring wins on a picked tile; the chin keeps the red.
 */
import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { GridCard } from "./CardGrid";

vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: {
    getMarketplace: vi.fn().mockResolvedValue("tcgplayer"),
    marketplaceFeedStatus: vi.fn().mockResolvedValue([]),
  },
}));

import { CardGrid } from "./CardGrid";

const REASON = "Doesn't match its folder's rules";

const card = (id: string, name: string): GridCard => ({
  id,
  name,
  setCode: "lea",
  collectorNumber: "161",
  rarity: "common",
});

const ROWS = [card("bolt", "Lightning Bolt"), card("helix", "Lightning Helix")];
/** Module scope, as the slot asks — only Bolt breaks a rule. */
const boltBreaks = (c: GridCard) => (c.id === "bolt" ? REASON : null);

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 600 });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
});

const tileOf = (name: string) => {
  const art = screen.getByRole("button", { name });
  const root = art.closest<HTMLElement>("[data-grid-index]");
  if (root === null) throw new Error(`no tile for ${name}`);
  return { art, root };
};

/** The chin is the tile root's last child — `CardChin`'s bar, whose border carries the tone. */
const chinOf = (root: HTMLElement) => root.lastElementChild as HTMLElement;

describe("CardGrid ruleBreak", () => {
  it("outlines a breaking tile in red and says why, leaving the others alone", () => {
    render(
      <CardGrid
        rows={ROWS}
        onSelect={vi.fn()}
        onNeedNextPage={vi.fn()}
        listKey="k"
        zoomSection="search"
        ruleBreak={boltBreaks}
      />,
    );

    const bolt = tileOf("Lightning Bolt");
    expect(bolt.root).toHaveClass("ring-2", "ring-destructive");
    expect(bolt.art).toHaveAttribute("aria-description", REASON);
    expect(chinOf(bolt.root)).toHaveClass("border-destructive");

    const helix = tileOf("Lightning Helix");
    expect(helix.root).not.toHaveClass("ring-destructive");
    expect(helix.art).not.toHaveAttribute("aria-description");
    expect(chinOf(helix.root)).toHaveClass("border-border");
  });

  it("lets the gold selection ring win on a picked tile, while the chin stays red", () => {
    render(
      <CardGrid
        rows={ROWS}
        onSelect={vi.fn()}
        onNeedNextPage={vi.fn()}
        listKey="k"
        zoomSection="search"
        selectedId="bolt"
        ruleBreak={boltBreaks}
      />,
    );

    const bolt = tileOf("Lightning Bolt");
    expect(bolt.root).toHaveClass("ring-accent");
    expect(bolt.root).not.toHaveClass("ring-destructive");
    expect(chinOf(bolt.root)).toHaveClass("border-destructive");
    expect(bolt.art).toHaveAttribute("aria-description", REASON);
  });

  it("draws nothing different without the prop", () => {
    const { container } = render(
      <CardGrid
        rows={ROWS}
        onSelect={vi.fn()}
        onNeedNextPage={vi.fn()}
        listKey="k"
        zoomSection="search"
      />,
    );

    expect(container.querySelector(".ring-destructive")).toBeNull();
    expect(container.querySelector(".border-destructive")).toBeNull();
    expect(container.querySelector("[aria-description]")).toBeNull();
  });
});
