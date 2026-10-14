/**
 * A shared deck inside the app (issue #1032) — the deck editor's own views, read-only.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import golden from "../../../../apps/desktop/src-tauri/src/share/__golden__/deck.json?raw";
import { TooltipProvider } from "@/components/tooltip/TooltipProvider";
import { parseSnapshot, shareDeckOf } from "@/lib/shareSnapshot";
import { SharedDeck } from "./SharedDeck";
import { sharedDeckRows } from "./sharedDeckRows";

const snapshot = () => parseSnapshot(golden);

function mount() {
  const s = snapshot();
  return render(
    <TooltipProvider>
      <SharedDeck
        snapshot={s}
        deck={shareDeckOf(s)!}
        owner="Giradeli"
        title={s.title}
        stamp={null}
        refreshing={false}
        onRefresh={() => {}}
        onClose={() => {}}
      />
    </TooltipProvider>,
  );
}

describe("sharedDeckRows", () => {
  it("files every card under its pile, with the facts the wire carried and nothing invented", () => {
    const s = snapshot();
    const { cards, categories } = sharedDeckRows(s, shareDeckOf(s)!);
    expect(categories.map((c) => [c.name, c.kind, c.isActive])).toEqual([
      ["Commander", "commander", true],
      ["Burn", "main", true],
    ]);
    const bolt = cards.find((c) => c.name === "Lightning Bolt")!;
    expect(bolt).toMatchObject({
      categoryName: "Burn",
      typeLine: "Instant",
      manaCost: "{R}",
      cmc: 1,
      finish: null,
      unitPrice: 0.34,
      // Not on the wire, so the editor's "not known" — never a guess.
      labelId: null,
      ownedQuantity: 0,
      legalities: null,
    });
  });

  it("draws a card filed under no pile it knows in a pile of its own", () => {
    const s = snapshot();
    s.cards[1] = { ...s.cards[1], fo: "pile-elsewhere" };
    const { cards, categories } = sharedDeckRows(s, shareDeckOf(s)!);
    expect(categories.map((c) => c.name)).toEqual(["Commander", "Burn", "Other"]);
    expect(cards[1].categoryName).toBe("Other");
  });
});

describe("SharedDeck", () => {
  it("opens on the editor's stacks, and offers the editor's three other views", async () => {
    const user = userEvent.setup();
    mount();
    expect(
      screen.getByRole("heading", { name: /Giradeli’s Krenko's Goblins/ }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Commander deck · 2 cards/)).toBeInTheDocument();
    expect(screen.getAllByText("Lightning Bolt").length).toBeGreaterThan(0);

    for (const view of ["Table", "Text", "Grid"]) {
      await user.click(screen.getByRole("button", { name: /^View/ }));
      await user.click(screen.getByRole("option", { name: view }));
      expect(screen.getAllByText("Lightning Bolt").length).toBeGreaterThan(0);
    }
  });

  it("draws no control that writes — no stepper, no menu, no drag handle", () => {
    mount();
    for (const name of [/increase/i, /decrease/i, /remove/i, /more actions/i]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
  });
});
