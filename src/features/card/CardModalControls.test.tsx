import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_LABEL_COLOR } from "@/features/decks/labelColors";
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
    // Spec §7: `Deck category` and `Label` are the deck editor's column of that table and
    // nothing else's. `scope.deckControls` gates the pair together, so neither can arrive
    // on a surface the other did not.
    //
    // `Label` is the deck card's own coloured mark (`DeckCard.labelId`, `deck_labels`) and
    // never a Scryfall tag — the root `CLAUDE.md` reserves that word for the two tagger
    // taxonomies and the collection's free-text column.
    renderControls({
      scope: deckScope,
      categories: [{ value: "2", label: "Burn spells" }],
      labels: [{ value: "7", label: "Cut candidate" }],
    });

    expect(screen.getByRole("button", { name: /deck category/i })).toBeInTheDocument();
    // Named exactly, not `/label/i`: the picker's own name is the one visible word, and a
    // loose pattern would just as happily match a control that grew the word later.
    expect(screen.getByRole("button", { name: "Label" })).toBeInTheDocument();
  });

  it("draws no stepper and no deck controls on the search page", () => {
    // The search wall is the corpus rather than a holding, so there is no count on it to
    // step — `scope.quantity` is null and the control is absent rather than disabled. A
    // greyed stepper would be a claim that this surface keeps a number, which it does not.
    renderControls({ scope: searchScope });

    expect(screen.queryByRole("button", { name: /deck category/i })).not.toBeInTheDocument();
    // The other half of the pair `scope.deckControls` gates — asserted here so the claim the
    // test above makes about the two arriving together is checked from both ends.
    expect(screen.queryByRole("button", { name: "Label" })).not.toBeInTheDocument();
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

  /**
   * The create row is **the last row at every query**, and that is the property under test rather
   * than its presence on an empty box.
   *
   * The alternative shape — reveal it only when the typed text matches nothing — reads as clever
   * and behaves as a surprise: the control vanishes as the reader types, and a reader who wants a
   * *second* pile called something close to one they have (`Removal`, `Removal — sweepers`) can
   * never reach it, because their text matches. It also means `<Dropdown>`'s own uncontrolled
   * filter would have eaten the row on exactly the query that needs it, which is why this file
   * controls the search box instead.
   */
  it("keeps a Create row at the end of the list whatever has been typed", async () => {
    renderControls({
      scope: deckScope,
      categories: [
        { value: "2", label: "Burn spells" },
        { value: "3", label: "Lands" },
      ],
      onCreateCategory: vi.fn(),
    });

    await userEvent.click(screen.getByRole("button", { name: /deck category/i }));
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Burn spells",
      "Lands",
      "Create new…",
    ]);

    // A query that matches a row: the row is still last, not replaced by it.
    await userEvent.type(screen.getByRole("combobox"), "Burn");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Burn spells",
      "Create “Burn”…",
    ]);

    // …and a query that matches nothing, which is the case a "reveal on no match" row would have
    // been the only one to answer — and the case an uncontrolled filter would have eaten.
    await userEvent.clear(screen.getByRole("combobox"));
    await userEvent.type(screen.getByRole("combobox"), "Ramp");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Create “Ramp”…"]);
  });

  it("draws no create row where the host wired no create", async () => {
    // Every handler here is optional with an inert default, and an unwired one is *absent* rather
    // than drawn and dead — a `Create new…` a reader can press and watch do nothing is worse than
    // a picker that only picks.
    renderControls({ scope: deckScope, labels: [{ value: "7", label: "Cut candidate" }] });

    await userEvent.click(screen.getByRole("button", { name: "Label" }));
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Cut candidate"]);
  });

  it("makes a label with the palette's default colour, and carries the typed name into the field", async () => {
    // The colour is not optional: `deck_labels.color` is NOT NULL and `deck_label_create` refuses
    // a name with no colour rather than inventing one, so the form always has an answer — and it
    // is `labelColors.ts`', never a hex written in this feature.
    const onCreateLabel = vi.fn();
    renderControls({ scope: deckScope, labels: [], onCreateLabel });

    await userEvent.click(screen.getByRole("button", { name: "Label" }));
    await userEvent.type(screen.getByRole("combobox"), "Cut candidate");
    await userEvent.click(screen.getByRole("option", { name: /^create/i }));

    const field = await screen.findByLabelText("New label");
    expect(field).toHaveValue("Cut candidate");
    // The caret is in it: the reader pressed a row that says the next thing they do is type.
    expect(field).toHaveFocus();

    await userEvent.click(screen.getByRole("button", { name: /^Create/ }));
    expect(onCreateLabel).toHaveBeenCalledWith("Cut candidate", DEFAULT_LABEL_COLOR.hex);
    // The form closes behind the press, which is `AddLabelDialog`'s bargain: the write is the
    // host's and outlives this row.
    await waitFor(() => expect(screen.queryByLabelText("New label")).not.toBeInTheDocument());
  });

  it("points a name that already exists at the row holding it, rather than making a second", async () => {
    // A courtesy rather than the fence — the `UNIQUE INDEX` on `deck_labels.name_key` is that,
    // and two windows racing one name is what an index is for. What this buys is that a reader
    // who types a name they already have is handed *that row* instead of a round trip and a
    // refusal. `labelNameKey` is the comparison, so `cut candidate` is `Cut candidate`.
    const onCreateCategory = vi.fn();
    const onPickCategory = vi.fn();
    renderControls({
      scope: deckScope,
      categories: [{ value: "2", label: "Burn spells" }],
      onCreateCategory,
      onPickCategory,
    });

    await userEvent.click(screen.getByRole("button", { name: /deck category/i }));
    await userEvent.type(screen.getByRole("combobox"), "Ramp");
    await userEvent.click(screen.getByRole("option", { name: /^create/i }));

    await userEvent.clear(await screen.findByLabelText("New category"));
    await userEvent.type(screen.getByLabelText("New category"), "  burn SPELLS ");

    // The button says what the press will now do, in one text node — a label and a name in two
    // spans separated by a `gap` compute to one run-on word.
    await userEvent.click(screen.getByRole("button", { name: "Use “Burn spells”" }));
    expect(onPickCategory).toHaveBeenCalledWith(2);
    expect(onCreateCategory).not.toHaveBeenCalled();
  });
});
