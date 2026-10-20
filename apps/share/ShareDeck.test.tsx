/**
 * A shared deck on the public page (issue #1032), over the deck golden the Rust writer produces.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "@grimoire/ui/components/tooltip/TooltipProvider";
import {
  parseSnapshot,
  shareDeckOf,
  type ShareCard,
  type ShareSnapshot,
} from "@grimoire/ui/lib/shareSnapshot";
import golden from "../desktop/src-tauri/src/share/__golden__/deck.json?raw";
import { deckGroups } from "./ShareDeck";
import { SharePage } from "./SharePage";

const snapshot = () => parseSnapshot(golden);

function mount(s: ShareSnapshot = snapshot()) {
  return render(
    <TooltipProvider>
      <SharePage snapshot={s} />
    </TooltipProvider>,
  );
}

/** The golden with more cards filed into its piles — a land, a sideboard pile, a stray. */
function bigger(): ShareSnapshot {
  const s = snapshot();
  const card = (over: Partial<ShareCard>): ShareCard => ({ ...s.cards[1], ...over });
  s.folders.push({ uid: "pile-2", name: "Sideboard", parent: null });
  s.deck?.piles.push({ uid: "pile-2", kind: "side", active: true });
  s.cards.push(
    card({ n: "Mountain", t: "Basic Land — Mountain", mc: undefined, mv: 0, q: 30 }),
    card({ n: "Shock", fo: "pile-2", q: 2 }),
    card({ n: "Wildfire", t: "Sorcery", mc: "{4}{R}{R}", mv: 6, fo: "pile-elsewhere" }),
  );
  return s;
}

describe("a shared deck on the public page", () => {
  it("draws the deck's piles as stacks by default, commander first", () => {
    mount();
    expect(screen.getByRole("button", { name: "Stacks" })).toHaveAttribute("aria-pressed", "true");
    const piles = screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"));
    expect(piles).toEqual(["Commander", "Burn"]);
    expect(screen.getByText(/Commander deck · 2 cards/)).toBeInTheDocument();
    // Not a binder: no folder rail, no binder search.
    expect(screen.queryByRole("list", { name: "Folders" })).toBeNull();
    expect(screen.queryByRole("searchbox")).toBeNull();
  });

  it("switches to grid, table and text, read-only in every one", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("button", { name: "Table" }));
    const table = screen.getByRole("table");
    expect(within(table).getByText("Lightning Bolt")).toBeInTheDocument();
    expect(within(table).getByText("{R}")).toBeInTheDocument();
    expect(within(table).getByText("Instant")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Text" }));
    expect(screen.getByText("1 Lightning Bolt")).toBeInTheDocument();
    expect(screen.getByText("1 Krenko, Mob Boss")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Grid" }));
    // The piles' pictures, not the ribbon's logo. Not virtualised, like Stacks, so the browser's
    // gate is what bounds the requests (#1154).
    const pictures = screen.getAllByRole("region").flatMap((r) => within(r).getAllByRole("img"));
    expect(pictures.length).toBeGreaterThan(0);
    for (const img of pictures) expect(img).toHaveAttribute("loading", "lazy");

    // Nothing anywhere on the page writes: no steppers, no checkboxes, no text box.
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("spinbutton")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("draws no picture from a host the publisher chose, in stacks or in the grid (issue #1153)", async () => {
    const user = userEvent.setup();
    const s = snapshot();
    s.cards[0].img = "https://tracker.example/?c=0";
    const { container } = mount(s);
    const sources = () => Array.from(container.querySelectorAll("img"), (img) => img.src);

    expect(sources().length).toBeGreaterThan(0);
    expect(sources().every((src) => src.startsWith("https://cards.scryfall.io/"))).toBe(true);
    // Still drawn — as the named frame a card with no picture gets.
    expect(screen.getAllByText(s.cards[0].n).length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "Grid" }));
    expect(sources().length).toBeGreaterThan(0);
    expect(sources().every((src) => src.startsWith("https://cards.scryfall.io/"))).toBe(true);
  });

  it("is still a binder when the snapshot carries no deck half", () => {
    const s = snapshot();
    delete s.deck;
    mount(s);
    expect(screen.getByRole("list", { name: "Folders" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stacks" })).toBeNull();
  });
});

describe("deckGroups", () => {
  it("keeps the deck's piles, beside-the-deck piles last, and draws a stray rather than drop it", () => {
    const s = bigger();
    const groups = deckGroups(s, shareDeckOf(s)!, "pile");
    expect(groups.map((g) => [g.name, g.count])).toEqual([
      ["Commander", 1],
      ["Burn", 31],
      ["Other", 1],
      ["Sideboard", 2],
    ]);
    // Mana value, then name, inside a pile.
    expect(groups[1].rows.map((r) => r.card.n)).toEqual(["Mountain", "Lightning Bolt"]);
  });

  it("buckets the deck by type and by mana value, the commander and the sideboard as themselves", () => {
    const s = bigger();
    const deck = shareDeckOf(s)!;
    expect(deckGroups(s, deck, "type").map((g) => g.name)).toEqual([
      "Commander",
      "Instants",
      "Sorceries",
      "Lands",
      "Sideboard",
    ]);
    expect(deckGroups(s, deck, "manaValue").map((g) => g.name)).toEqual([
      "Commander",
      "Mana value 1",
      "Mana value 6",
      "Lands",
      "Sideboard",
    ]);
  });
});
