import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CardDetail } from "@/lib/ipc";
import type { PaneDeckContext } from "@/lib/store";
import { CardModalControls } from "./CardModalControls";
import type { CardModalScope } from "./cardModalScope";

/**
 * Six required fields, not four — `variant` is `"live" | "theory"` and `finish` is required
 * too (`ipc.ts`'s `DeckVariant` / `DeckFinish`). An earlier draft of the plan gave a
 * four-field row with `variant: "main"`, which does not compile.
 */
const deckRow: PaneDeckContext = {
  deckId: 1,
  categoryId: 2,
  categoryName: "Burn spells",
  cardId: "c1",
  variant: "live",
  finish: null,
};

const deckScope: CardModalScope = {
  surface: "deck",
  deck: deckRow,
  quantity: "deck",
  deckControls: true,
};

const searchScope: CardModalScope = {
  surface: "search",
  deck: null,
  quantity: null,
  deckControls: false,
};

const card = {
  id: "c1",
  oracleId: "o1",
  name: "Lightning Bolt",
  setCode: "lea",
  setName: "Limited Edition Alpha",
  collectorNumber: "161",
  rarity: "common",
  layout: "normal",
  lang: "en",
  manaCost: "{R}",
  cmc: 1,
  typeLine: "Instant",
  oracleText: "Lightning Bolt deals 3 damage to any target.",
  illustrationId: null,
  artist: "Christopher Rush",
  releasedAt: "1993-08-05",
  legalities: null,
  finishPrices: { nonfoil: null, foil: null, etched: null },
  finishes: null,
  promoTypes: null,
  imageStatus: null,
  faces: [],
} satisfies CardDetail;

function renderControls(props: Partial<Parameters<typeof CardModalControls>[0]> = {}) {
  return render(
    <CardModalControls
      card={card}
      scope={searchScope}
      printingCount={4}
      onViewAllPrintings={vi.fn()}
      {...props}
    />,
  );
}

describe("CardModalControls", () => {
  it("draws the deck controls only for a card opened out of a deck", () => {
    // Spec §7: `Deck category` and `Tag` are the deck editor's column of that table and
    // nothing else's. `scope.deckControls` gates the pair together, so neither can arrive
    // on a surface the other did not.
    renderControls({
      scope: deckScope,
      categories: [{ value: "2", label: "Burn spells" }],
      tags: [{ value: "7", label: "Cut candidate" }],
    });

    expect(screen.getByRole("button", { name: /deck category/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /tag/i })).toBeInTheDocument();
  });

  it("draws no stepper and no deck controls on the search page", () => {
    // The search wall is the corpus rather than a holding, so there is no count on it to
    // step — `scope.quantity` is null and the control is absent rather than disabled. A
    // greyed stepper would be a claim that this surface keeps a number, which it does not.
    renderControls({ scope: searchScope });

    expect(screen.queryByRole("button", { name: /deck category/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
  });

  it.each([
    ["deck", deckScope, "In deck"],
    ["collection", { ...searchScope, surface: "collection", quantity: "owned" }, "Owned"],
    ["wishlist", { ...searchScope, surface: "wishlist", quantity: "wished" }, "Wished"],
  ] as const)("labels the %s stepper %s", (_surface, scope, word) => {
    // One control, three names — the stepper edits a different count on each surface and the
    // word beside it is the only thing on screen that says which.
    renderControls({ scope, quantity: 2 });

    expect(screen.getByText(word)).toBeInTheDocument();
    expect(screen.getByRole("spinbutton")).toHaveValue(2);
  });

  it("offers the printings modal with the count in its name", () => {
    const onViewAllPrintings = vi.fn();
    renderControls({ printingCount: 4, onViewAllPrintings });

    // The count is *in* the accessible name rather than beside it: a label and its count in
    // two spans separated by a CSS `gap` compute to "View all printings4", because a gap is
    // not a word separator. One text node is what keeps the name readable.
    fireEvent.click(screen.getByRole("button", { name: "View all printings (4)" }));
    expect(onViewAllPrintings).toHaveBeenCalledOnce();
  });

  it("names the printing picker after the printing the card is, not after the card", () => {
    // The trigger says which printing is open, so a reader who came in on a Beta copy is not
    // told "Lightning Bolt" by a control whose whole job is to say *which* Lightning Bolt.
    renderControls({
      printings: [
        { value: "c1", label: "Limited Edition Alpha", hint: "LEA" },
        { value: "c2", label: "Limited Edition Beta", hint: "LEB" },
      ],
    });

    expect(screen.getByRole("button", { name: "Printing" })).toHaveTextContent(
      "Limited Edition Alpha",
    );
  });
});
