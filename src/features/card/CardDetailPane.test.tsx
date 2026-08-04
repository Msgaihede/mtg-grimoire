import { useState } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CardDetail, CardFace, Printing, PrintingsResponse } from "@/lib/ipc";

const detail: CardDetail = {
  id: "p1",
  oracleId: "o1",
  name: "Delver of Secrets // Insectile Aberration",
  setCode: "isd",
  setName: "Innistrad",
  collectorNumber: "51",
  rarity: "common",
  layout: "transform",
  lang: "en",
  manaCost: "{U}",
  cmc: 1,
  typeLine: "Creature — Human Wizard",
  oracleText: "At the beginning of your upkeep…",
  illustrationId: "art-a",
  artist: "Nils Hamm",
  releasedAt: "2011-09-30",
  legalities: '{"modern":"legal","standard":"not_legal"}',
  prices:
    '{"usd":"0.50","usd_foil":"3.00","usd_etched":null,"eur":null,"eur_foil":null,"tix":null}',
  finishes: '["nonfoil","foil"]',
  imageStatus: "highres_scan",
  faces: [
    {
      name: "Delver of Secrets",
      typeLine: "Creature — Human Wizard",
      oracleText: "…",
      manaCost: "{U}",
      artist: "Nils Hamm",
    },
    {
      name: "Insectile Aberration",
      typeLine: "Creature — Human Insect",
      oracleText: "Flying",
      manaCost: null,
      artist: "Nils Hamm",
    },
  ],
};

const printing = (over: Partial<Printing> = {}): Printing => ({
  id: "p1",
  setCode: "isd",
  setName: "Innistrad",
  collectorNumber: "51",
  releasedAt: "2011-09-30",
  rarity: "common",
  illustrationId: "art-a",
  artist: "Nils Hamm",
  lang: "en",
  finishes: '["nonfoil","foil"]',
  prices:
    '{"usd":"0.50","usd_foil":"3.00","usd_etched":null,"eur":null,"eur_foil":null,"tix":null}',
  promo: false,
  fullArt: false,
  frameEffects: null,
  borderColor: "black",
  layout: "transform",
  ...over,
});

/** What `card_printings` answers: a capped page plus the size of the list it came from. */
const page = (items: Printing[], total = items.length): PrintingsResponse => ({ items, total });

const printings = [printing()];

const cardDetail = vi.fn();
const cardPrintings = vi.fn();
vi.mock("@/lib/ipc", async (original) => ({
  ...(await original<typeof import("@/lib/ipc")>()),
  ipc: {
    cardDetail: (id: string) => cardDetail(id),
    cardPrintings: (o: string) => cardPrintings(o),
  },
}));
import { CardDetailPane } from "./CardDetailPane";

function wrap(cardId: string, onClose = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CardDetailPane cardId={cardId} onClose={onClose} />
    </QueryClientProvider>,
  );
}

/** The card as it arrives, with the given fields replaced. */
const card = (over: Partial<CardDetail>): CardDetail => ({ ...detail, ...over });

const face = (over: Partial<CardFace>): CardFace => ({
  name: "",
  typeLine: null,
  oracleText: null,
  manaCost: null,
  artist: null,
  ...over,
});

beforeEach(() => {
  cardDetail.mockReset();
  cardPrintings.mockReset();
});

describe("CardDetailPane", () => {
  it("shows the card, its artist and the required copyright line", async () => {
    cardDetail.mockResolvedValue(detail);
    cardPrintings.mockResolvedValue(page(printings));

    wrap("p1");

    expect(
      await screen.findByText("Delver of Secrets // Insectile Aberration"),
    ).toBeInTheDocument();
    // Scryfall's image policy: the artist and the source have to be identifiable in the
    // same interface that shows the art. Deleting either line is a policy violation, not
    // a style change.
    expect(screen.getByText(/Illustrated by Nils Hamm/)).toBeInTheDocument();
    expect(
      screen.getByText(/Card images © Wizards of the Coast · Data © Scryfall/),
    ).toBeInTheDocument();
  });

  it("flips a double-faced card to the back image", async () => {
    cardDetail.mockResolvedValue(detail);
    cardPrintings.mockResolvedValue(page(printings));

    wrap("p1");
    const flip = await screen.findByRole("button", { name: /flip/i });
    expect(screen.getByAltText(/Delver of Secrets/)).toHaveAttribute(
      "src",
      expect.stringContaining("/display/p1/0"),
    );

    await userEvent.click(flip);

    await waitFor(() =>
      expect(screen.getByAltText(/Insectile Aberration/)).toHaveAttribute(
        "src",
        expect.stringContaining("/display/p1/1"),
      ),
    );
    // The back's rules text comes with it: a flip that changes only the picture leaves the
    // front's abilities sitting under the back's art.
    expect(screen.getByText("Creature — Human Insect")).toBeInTheDocument();
    expect(screen.queryByText("Creature — Human Wizard")).not.toBeInTheDocument();
  });

  it("prices each finish from its own key", async () => {
    cardDetail.mockResolvedValue(detail);
    cardPrintings.mockResolvedValue(page(printings));

    wrap("p1");

    // $0.50 nonfoil and $3.00 foil, never one number for both — `price_usd`'s fallback
    // chain would price this plain copy at its foil rate.
    const [nonfoil, foil] = await screen.findAllByRole("definition");
    expect(nonfoil).toHaveTextContent("$0.50");
    expect(foil).toHaveTextContent("$3.00");
  });

  it("shows a legality chip for modern and none for standard", async () => {
    cardDetail.mockResolvedValue(detail);
    cardPrintings.mockResolvedValue(page(printings));

    wrap("p1");

    expect(await screen.findByText("modern")).toBeInTheDocument();
    expect(screen.queryByText("standard")).not.toBeInTheDocument();
  });

  /**
   * The grid's rarity gem is `aria-hidden` — it is decoration on a tile whose name says
   * everything. This pane is the one place a rarity is *read*, so here it is a word.
   */
  it("says the rarity rather than only tinting a dot with it", async () => {
    cardDetail.mockResolvedValue(detail);
    cardPrintings.mockResolvedValue(page(printings));

    wrap("p1");

    expect(await screen.findByText("common")).toHaveTextContent("Rarity: common");
  });

  /**
   * The backend caps a printings list at 400 rows and sends the full count beside it.
   * Without the caption a Forest reads as a card with 400 printings, and nothing on screen
   * contradicts it.
   */
  it("says what a truncated printings list is a truncation of", async () => {
    cardDetail.mockResolvedValue(detail);
    cardPrintings.mockResolvedValue(page(printings, 862));

    wrap("p1");

    expect(await screen.findByText(/1 of 862 printings/)).toBeInTheDocument();
  });

  /**
   * `list_printings` returns every language — Lightning Bolt's 62 paper printings include
   * three that are not English. An unbadged row claims to be the English printing at that
   * collector number, which is a different card to own.
   */
  it("badges a printing that is not in English", async () => {
    cardDetail.mockResolvedValue(detail);
    cardPrintings.mockResolvedValue(
      page([printing(), printing({ id: "p2", lang: "ja", collectorNumber: "51b" })]),
    );

    wrap("p1");

    expect(await screen.findByText("ja")).toBeInTheDocument();
    // English is the assumption, so saying it on 59 of 62 rows is noise.
    expect(screen.queryByText("en")).not.toBeInTheDocument();
  });

  it("groups printings that share an artwork, and counts both", async () => {
    cardDetail.mockResolvedValue(detail);
    cardPrintings.mockResolvedValue(
      page([
        printing({ id: "a", illustrationId: "art-a", artist: "Christopher Rush" }),
        printing({ id: "b", illustrationId: "art-a", artist: "Christopher Rush" }),
        printing({ id: "c", illustrationId: "art-b", artist: "Rebecca Guay" }),
      ]),
    );

    wrap("p1");

    // Awaited on the caption, not on the section: the section is rendered while the list
    // is still loading, so finding it proves nothing about the rows inside it yet.
    expect(await screen.findByText(/3 printings · 2 artworks/)).toBeInTheDocument();
    const list = within(screen.getByRole("region", { name: /printings/i }));
    const groups = list.getAllByRole("list");
    expect(groups).toHaveLength(2);
    expect(within(groups[0]).getAllByRole("listitem")).toHaveLength(2);
    // The artwork's identity is its illustrator — "Artwork 1 / Artwork 2" would be a
    // number the reader cannot check against anything.
    expect(list.getByText("Christopher Rush")).toBeInTheDocument();
    expect(list.getByText("Rebecca Guay")).toBeInTheDocument();
  });

  /**
   * Escape is a keyboard word, and the pane it dismisses holds the focus. Without the
   * hand-back the caret lands on `<body>` and the next Tab restarts from the top of the
   * app, several hundred cards away from the one the reader was looking at.
   */
  it("closes on Escape and hands focus back to whatever opened it", async () => {
    cardDetail.mockResolvedValue(detail);
    cardPrintings.mockResolvedValue(page(printings));

    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open the card
          </button>
          {open && <CardDetailPane cardId="p1" onClose={() => setOpen(false)} />}
        </>
      );
    }
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <Harness />
      </QueryClientProvider>,
    );

    const opener = screen.getByRole("button", { name: "Open the card" });
    await userEvent.click(opener);

    // Focus moves in, so the pane's own controls are the next thing Tab reaches.
    const pane = await screen.findByRole("complementary", { name: /card details/i });
    expect(pane).toHaveFocus();

    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("closes from the button and hands focus back the same way", async () => {
    cardDetail.mockResolvedValue(detail);
    cardPrintings.mockResolvedValue(page(printings));
    const onClose = vi.fn();

    wrap("p1", onClose);

    await userEvent.click(await screen.findByRole("button", { name: /close card details/i }));

    expect(onClose).toHaveBeenCalled();
  });

  /**
   * A `split`, `adventure` or `flip` card has two faces printed on one side of one piece
   * of cardboard. Offering to flip it shows a card back, and showing only the first face's
   * text hides half the card.
   */
  it("shows both halves of a split card and offers no flip", async () => {
    cardDetail.mockResolvedValue(
      card({
        name: "Fire // Ice",
        layout: "split",
        faces: [
          face({ name: "Fire", typeLine: "Instant", oracleText: "Deals 2 damage divided…" }),
          face({ name: "Ice", typeLine: "Instant", oracleText: "Tap target permanent." }),
        ],
      }),
    );
    cardPrintings.mockResolvedValue(page(printings));

    wrap("p1");

    expect(await screen.findByText("Fire")).toBeInTheDocument();
    expect(screen.getByText("Ice")).toBeInTheDocument();
    expect(screen.getByText("Tap target permanent.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /flip/i })).not.toBeInTheDocument();
  });

  /**
   * Rust keeps a nameless face in its slot rather than dropping it, because the flip
   * control indexes `faces` directly. The control has to survive the face it was kept for.
   */
  it("still flips a card whose back face has no name", async () => {
    cardDetail.mockResolvedValue(
      card({ faces: [face({ name: "Delver of Secrets" }), face({ name: "" })] }),
    );
    cardPrintings.mockResolvedValue(page(printings));

    wrap("p1");

    const flip = await screen.findByRole("button", { name: /flip/i });
    expect(flip).toHaveTextContent("Flip to the other face");

    await userEvent.click(flip);

    // The card's own name is the fallback: an `alt` of "" is an image with no description.
    expect(screen.getByAltText("Delver of Secrets // Insectile Aberration")).toBeInTheDocument();
  });

  it("says so when the id is not in the database rather than showing an empty pane", async () => {
    cardDetail.mockResolvedValue(null);

    wrap("gone");

    expect(await screen.findByText(/not in the card database/i)).toBeInTheDocument();
    // Nothing to ask about: the oracle id is unknown, so no printings request goes out.
    expect(cardPrintings).not.toHaveBeenCalled();
  });

  it("reports a card that could not be read", async () => {
    cardDetail.mockRejectedValue("database is locked");

    wrap("p1");

    expect(await screen.findByRole("alert")).toHaveTextContent(/database is locked/);
  });

  /**
   * The printings list is a second request, and it can fail on its own — a lock, an ingest
   * mid-swap. The card in front of the reader must stay on screen when it does.
   */
  it("keeps the card when only the printings fail", async () => {
    cardDetail.mockResolvedValue(detail);
    cardPrintings.mockRejectedValue("database is locked");

    wrap("p1");

    expect(
      await screen.findByText("Delver of Secrets // Insectile Aberration"),
    ).toBeInTheDocument();
    expect(await screen.findByText(/could not read the other printings/i)).toBeInTheDocument();
  });
});
