import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CardDetail, CardFace } from "@/lib/ipc";
import { MARKETPLACES } from "@/lib/marketplace";
import { CardModalArt } from "./CardModalArt";

/**
 * A card sold in both finishes, and the base every fixture below overrides.
 *
 * Priced at TCGplayer, which is what `finishPrices` always means — the triple arrives already
 * quoted at whichever marketplace `card_detail` was called with, so a fixture that put a
 * Cardmarket number here would be describing a state the backend cannot produce.
 */
const BOLT: CardDetail = {
  id: "p1",
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
  oracleText: "Deal 3 damage.",
  illustrationId: "art-a",
  artist: "Christopher Rush",
  releasedAt: "1993-08-05",
  legalities: '{"modern":"legal"}',
  finishPrices: { nonfoil: 620, foil: null, etched: null },
  finishes: '["nonfoil","foil"]',
  promoTypes: null,
  imageStatus: "highres_scan",
  faces: [],
};

const card = (over: Partial<CardDetail>): CardDetail => ({ ...BOLT, ...over });

const face = (over: Partial<CardFace>): CardFace => ({
  name: "",
  typeLine: null,
  oracleText: null,
  manaCost: null,
  artist: null,
  ...over,
});

/** Everything the column needs that is not the card. Overridden per test. */
const rest = {
  face: 0,
  onFlip: vi.fn(),
  marketplace: MARKETPLACES.tcgplayer,
  deckRow: null,
  onToggleFoil: vi.fn(),
};

describe("CardModalArt", () => {
  it("prices every finish the printing has, not just nonfoil and foil", () => {
    // **The one assertion this component exists to keep true.** The mockup draws exactly two
    // cells, `Nonfoil` and `Foil`; spec §4 refuses that reading, because `finishes` says how
    // shiny a copy is and `promoTypes` says which shiny (issue #160). A printing sold only as
    // etched — 892 of them are, and `soleFinish`'s own doc counts them — would price as an em
    // dash under the mockup while the app is holding a real number for it.
    render(
      <CardModalArt
        card={card({
          finishes: '["etched"]',
          finishPrices: { nonfoil: null, foil: null, etched: 12.5 },
        })}
        {...rest}
      />,
    );

    expect(screen.getByText("Etched")).toBeInTheDocument();
    expect(screen.getByText("$12.50")).toBeInTheDocument();
    // Anchored, so it cannot be satisfied by a cell that says "Nonfoil" as part of something
    // else — and so a hardcoded pair fails here rather than passing on the first two words.
    expect(screen.queryByText(/^nonfoil$/i)).not.toBeInTheDocument();
  });

  it("names the treatment where the copy has one, and only on the copy that has it", () => {
    // The other half of issue #160. A Surge Foil printing's shiny cell reads `Surge Foil`,
    // while its **plain** cell still reads `Nonfoil` — `finishTreatments` withholds a foil word
    // from a nonfoil copy, and a cell that read "Surge Foil" over the plain price would be
    // naming cardboard the reader is not being quoted for.
    render(
      <CardModalArt
        card={card({
          promoTypes: '["surgefoil"]',
          finishes: '["nonfoil","foil"]',
          finishPrices: { nonfoil: 3, foil: null, etched: null },
        })}
        {...rest}
      />,
    );

    expect(screen.getByText("Surge Foil")).toBeInTheDocument();
    expect(screen.getByText("Nonfoil")).toBeInTheDocument();
    // An unpriced finish is an em dash and never `$0.00`, and never the other finish's number:
    // the holes are real and differ per marketplace, so filling one would invent a quote.
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("says how old the prices are and whose they are", () => {
    // Spec §5: a price is never shown without saying how old it is — and, now that there is
    // more than one answer, whose. `pricesAsOf` also picks the right clock: the card-data sync
    // for the blob-backed pair, the last feed refresh for the two this app downloads.
    render(<CardModalArt card={card({})} {...rest} />);

    expect(screen.getByText(/tcgplayer prices as of the last card-data sync/i)).toBeInTheDocument();
  });

  it("says `Set as` behind a deck row and `View as` without one", () => {
    // The split already at `CardDetailPane.tsx:1300`, and the words are load-bearing rather
    // than a nicety: outside a deck the toggle changes a **picture**, and a control labelled
    // "Set as foil" there would read as editing something stored.
    const { unmount } = render(<CardModalArt card={card({})} {...rest} />);
    expect(screen.getByRole("button", { name: "View as foil" })).toBeInTheDocument();
    unmount();

    render(<CardModalArt card={card({})} {...rest} deckRow={{ finish: null }} />);
    expect(screen.getByRole("button", { name: "Set as foil" })).toBeInTheDocument();
  });

  it("offers a flip only for a card with two physical sides", () => {
    // `faceCount` and not `faces.length`: `split`, `adventure` and `flip` all carry two faces
    // printed on one side of one piece of cardboard, so offering to turn one over shows a card
    // back. The adventure below has two faces and one side.
    const twoFaces = [face({ name: "Delver of Secrets" }), face({ name: "Insectile Aberration" })];

    const { unmount } = render(
      <CardModalArt card={card({ layout: "transform", faces: twoFaces })} {...rest} />,
    );
    expect(screen.getByRole("button", { name: "Flip card" })).toBeInTheDocument();
    unmount();

    render(<CardModalArt card={card({ layout: "adventure", faces: twoFaces })} {...rest} />);
    expect(screen.queryByRole("button", { name: "Flip card" })).not.toBeInTheDocument();
  });
});
