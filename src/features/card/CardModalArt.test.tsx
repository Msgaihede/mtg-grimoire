import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { CardDetail, CardFace, MeldRelation } from "@/lib/ipc";
import { MARKETPLACES } from "@/lib/marketplace";
import { pricesAsOf } from "@/lib/prices";
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

const relation = (over: Partial<MeldRelation>): MeldRelation => ({
  id: "r1",
  name: "Brisela, Voice of Nightmares",
  component: "meld_result",
  artist: "Clint Cearley",
  ...over,
});

/** Everything the column needs that is not the card. Overridden per test. */
const rest = {
  face: 0,
  onFlip: vi.fn(),
  marketplace: MARKETPLACES.tcgplayer,
  deckRow: null,
  // Nobody named a finish — the state a card opened from a search wall, from Tags or from a
  // printings row is in.
  openedAs: null,
  onToggleFoil: vi.fn(),
  // `[]` is the answer for every card that is not a meld, which is 116 518 of 116 590 rows.
  meld: { relations: [], melded: null, onMeld: vi.fn(), onOpen: vi.fn() },
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

  it("leaves the as-of sentence to the host, so one panel says it once", () => {
    // **Spec §5 has not been weakened; it has moved.** A price is never shown without saying how
    // old it is — and, now that there is more than one answer, whose — but the sentence is a
    // footnote of the whole panel now rather than a caption under these cells, drawn by
    // `CardDetailModal` beside the Scryfall credit. `CardDetailModal.test.tsx`'s "dates the
    // prices it draws, in the footer beside the credit" is the positive half of this pair and is
    // where the wording and the clock are pinned.
    //
    // The assertion here is the *negative* half and is worth its own test: a column that started
    // drawing it again would put two copies of one sentence in one panel, which is the thing this
    // file's own doc comment argues against, and nothing else in the suite would notice.
    // Through `pricesAsOf` rather than the sentence typed out, so this pins the function rather
    // than a copy of its words.
    render(<CardModalArt card={card({})} {...rest} />);

    expect(screen.queryByText(pricesAsOf(MARKETPLACES.tcgplayer))).not.toBeInTheDocument();
    // Not vacuous: the cells the sentence used to sit under are still here, so this is a column
    // that prices a card and does not date it, rather than one that drew nothing at all.
    expect(screen.getByText("$620.00")).toBeInTheDocument();
  });

  it("says `Set as` behind a deck row and `View as` without one", () => {
    // The split the docked pane already drew before this file inherited it, and the words are
    // load-bearing rather
    // than a nicety: outside a deck the toggle changes a **picture**, and a control labelled
    // "Set as foil" there would read as editing something stored.
    const { unmount } = render(<CardModalArt card={card({})} {...rest} />);
    expect(screen.getByRole("button", { name: "View as foil" })).toBeInTheDocument();
    unmount();

    render(<CardModalArt card={card({})} {...rest} deckRow={{ finish: null }} />);
    expect(screen.getByRole("button", { name: "Set as foil" })).toBeInTheDocument();
  });

  it("says `No foil` on a printing with none, rather than dropping the control", () => {
    // **Issue #167.** A row that simply loses a button cannot be told from an app that forgot to
    // draw one — the reader's question is "is there a foil of this?" and a missing control is
    // silence rather than an answer. Asserted three ways, because a control that merely *looks*
    // dead is worse than one that is honestly out of reach:
    //
    // - the accessible name is the visible wording, so the fact reaches a reader hearing the
    //   modal as well as one looking at it;
    // - it is really `disabled`, so it takes neither a press nor a tab stop;
    // - and it carries no `aria-pressed`, because a greyed *toggle* would be a control claiming
    //   a state on a printing that has none to be in.
    render(
      <CardModalArt
        card={card({
          finishes: '["nonfoil"]',
          finishPrices: { nonfoil: 620, foil: null, etched: null },
        })}
        {...rest}
      />,
    );

    const stated = screen.getByRole("button", { name: "No foil" });
    expect(stated).toBeDisabled();
    expect(stated).not.toHaveAttribute("aria-pressed");
    expect(screen.queryByRole("button", { name: /^view as/i })).not.toBeInTheDocument();
  });

  it("says nothing about foil where the printing *is* the foil, or where nothing is known", () => {
    // **The `soleFinish` trap, and the reason `noFoil` is not `foilable === null` read
    // backwards.** `foilViewFinish` answers `null` for a foil-only printing too — 12 366 of them
    // exist — because there is nothing to switch *to*, and `soleFinish` is already drawing "this
    // cardboard is foil" over the art. `No foil` under that sheen would be the two halves of the
    // component contradicting each other about one piece of cardboard.
    const { unmount } = render(
      <CardModalArt
        card={card({
          finishes: '["foil"]',
          finishPrices: { nonfoil: null, foil: 9, etched: null },
        })}
        {...rest}
      />,
    );
    expect(screen.queryByRole("button", { name: "No foil" })).not.toBeInTheDocument();
    unmount();

    // Neither is an unparseable or absent `finishes` column: knowing nothing about a printing's
    // finishes is a different claim from knowing it has no foil, and the price grid draws no
    // cells for it either.
    render(<CardModalArt card={card({ finishes: null })} {...rest} />);
    expect(screen.queryByRole("button", { name: "No foil" })).not.toBeInTheDocument();
  });

  it("drops the statement while a meld view is up, like the toggle beside it", () => {
    // The meld gate and the finish gate are two conditions about two different things and must
    // stay two: this one is about **this printing's cardboard**, and while the frame holds a
    // counterpart's photograph nothing in this row may read as a caption for it. A nonfoil-only
    // meld half would otherwise state "No foil" over a picture of another card entirely.
    const brisela = relation({});
    render(
      <CardModalArt
        card={card({ layout: "meld", name: "Bruna, the Fading Light", finishes: '["nonfoil"]' })}
        {...rest}
        meld={{ relations: [brisela], melded: brisela, onMeld: vi.fn(), onOpen: vi.fn() }}
      />,
    );

    expect(screen.queryByRole("button", { name: "No foil" })).not.toBeInTheDocument();
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

  it("opens on the shiny copy when the surface that opened the card named one", () => {
    // **The foil seed, and the whole of what it is for.** A collection tile that *is* a foil, and
    // the deck editor's search panel, write `paneFinish`; the host reads it and hands it over,
    // because this file reads no store. Without the prop a reader who pressed their foil copy was
    // shown the plain photograph of it — the regression this closes.
    //
    // The toggle is pressed *and* its words have already flipped: the visible label is the
    // accessible name here, so a seeded toggle that still said "View as foil" would be a control
    // offering to do the thing it had already done.
    render(<CardModalArt card={card({})} {...rest} openedAs="foil" />);

    const toggle = screen.getByRole("button", { name: "View as nonfoil" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
  });

  it("seeds nothing from a plain copy, which is not the same as nobody knowing", () => {
    // `nonfoil` is a real answer and a *different* one from `null`: a surface saying "the copy
    // they pressed is the plain one". Both seed nothing, which is right — regular is the finish a
    // card is assumed to be — and asserting it keeps the seed a two-value test rather than a
    // truthiness one, which `"nonfoil"` would silently pass.
    render(<CardModalArt card={card({})} {...rest} openedAs="nonfoil" />);

    expect(screen.getByRole("button", { name: "View as foil" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("offers a quarter turn for a split card, and none for an upright one", async () => {
    // `orientation.ts`'s second axis, and the one `faceCount` says nothing about: a classic split
    // prints both halves with their titles reading down the left edge, so the whole card is
    // turned clockwise to read either one. `data-card-turn` is the handle — jsdom has no layout
    // engine and no opinion about a `transform`, so the only thing a suite can assert is that the
    // component decided on an angle.
    const halves = [
      face({ name: "Assault" }),
      face({ name: "Battery", oracleText: "Create a 3/3 green Elephant creature token." }),
    ];
    const { unmount } = render(
      <CardModalArt card={card({ layout: "split", faces: halves })} {...rest} />,
    );

    expect(document.querySelector("[data-card-turn]")).toHaveAttribute("data-card-turn", "0");
    const turn = screen.getByRole("button", { name: "Turn to read" });
    expect(turn).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(turn);
    expect(document.querySelector("[data-card-turn]")).toHaveAttribute("data-card-turn", "90");
    expect(screen.getByRole("button", { name: "Turn back" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    unmount();

    // Every other layout is already upright — a `transform` has a second *side* and is served by
    // the flip control, and turning it would rotate a face that is the right way up.
    render(<CardModalArt card={card({})} {...rest} />);
    expect(screen.queryByRole("button", { name: /^turn/i })).not.toBeInTheDocument();
  });

  it("turns an Aftermath split the other way, and a flip card the whole way", async () => {
    // Two answers `cardTurn` gives that the plain split does not, and both are visible only
    // through the angle. Aftermath prints its top half upright and its bottom half reading
    // bottom-to-top up the right edge, so that half is reached counter-clockwise — told from the
    // second face's rules text, which is the one place in the app licensed to branch on that.
    const aftermath = [
      face({ name: "Dusk" }),
      face({ name: "Dawn", oracleText: "Aftermath (Cast this spell only from your graveyard.)" }),
    ];
    const { unmount } = render(
      <CardModalArt card={card({ layout: "split", faces: aftermath })} {...rest} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Turn to read" }));
    expect(document.querySelector("[data-card-turn]")).toHaveAttribute("data-card-turn", "-90");
    unmount();

    // **The layout the control exists for.** `faceCount` answers `1` for `flip`, so there is no
    // flip control, and with no turn the second half stays upside down forever — the only card in
    // the app a reader cannot read at all. The label names the half it brings up, because a
    // `flip` card's two halves have two different names and a reader wants Tok-Tok.
    const halves = [face({ name: "Akki Lavarunner" }), face({ name: "Tok-Tok, Volcano Born" })];
    render(<CardModalArt card={card({ layout: "flip", faces: halves })} {...rest} />);
    expect(screen.queryByRole("button", { name: "Flip card" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Turn to Tok-Tok, Volcano Born" }));
    expect(document.querySelector("[data-card-turn]")).toHaveAttribute("data-card-turn", "180");
    expect(screen.getByRole("button", { name: "Turn to Akki Lavarunner" })).toBeInTheDocument();
  });

  it("gives a meld half both verbs, and shows the counterpart's picture in place of its own", async () => {
    // The two acts are genuinely different: **Meld** puts the melded card's picture in this
    // frame, on a panel still about the card the reader opened, and **Open** makes it the open
    // card. Collapsing them into one control would take the comparison away.
    const onMeld = vi.fn();
    const onOpen = vi.fn();
    const brisela = relation({});
    // **Bruna's real answer, measured on 2026-08-21**: `[Brisela (meld_result), Gisela
    // (meld_part)]`. The sibling half is in the list and must draw nothing — from Bruna the
    // reader wants Brisela, not Gisela — and it is only there that `meldPartsOf`'s guard does any
    // work. A fixture holding the result alone passes against a naive `component === "meld_part"`
    // filter, which is what this line stops.
    const gisela = relation({ id: "g", name: "Gisela, the Broken Blade", component: "meld_part" });
    const relations = [brisela, gisela];
    const { rerender } = render(
      <CardModalArt
        card={card({ layout: "meld", name: "Bruna, the Fading Light" })}
        {...rest}
        meld={{ relations, melded: null, onMeld, onOpen }}
      />,
    );

    expect(screen.queryByRole("button", { name: /^meld part —/i })).not.toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: "Meld — Brisela, Voice of Nightmares" }),
    );
    expect(onMeld).toHaveBeenCalledWith(brisela);

    await userEvent.click(screen.getByRole("button", { name: "Open melded card" }));
    expect(onOpen).toHaveBeenCalledWith("r1");

    // With the view up the frame is a picture of *that* card — the alt text is what a screen
    // reader announces and what shows if the fetch fails, and both readers want the card in the
    // frame. The foil toggle goes with it: the sheen is a statement about this printing's
    // cardboard, and the picture is another card's.
    rerender(
      <CardModalArt
        card={card({ layout: "meld", name: "Bruna, the Fading Light" })}
        {...rest}
        meld={{ relations, melded: brisela, onMeld, onOpen }}
      />,
    );
    const art = screen.getByAltText("Brisela, Voice of Nightmares");
    // The **counterpart's** picture and not the open card's: a different printing, so a different
    // id, and always its only side. Asserted on the URL as well as the alt text, because the two
    // are separate branches and an alt that followed the meld over a picture that did not would
    // be a screen reader announcing a card nobody can see.
    expect(art).toHaveAttribute("src", expect.stringContaining("/display/r1/0"));
    expect(screen.queryByRole("button", { name: /^view as/i })).not.toBeInTheDocument();
  });

  it("offers a melded card its halves, and never a half its sibling", () => {
    // `orientation.ts`'s asymmetry, which is the reason `meldPartsOf` and `meldResultOf` are two
    // functions: the same `meld_part` component means "your sibling" from one end and "your
    // halves" from the other, told apart only by whether a `meld_result` is present. From Bruna
    // the reader wants Brisela, not Gisela — so the half above draws no `Meld part` row, and the
    // melded card below draws two and no `Meld —` toggle.
    render(
      <CardModalArt
        card={card({ layout: "meld", name: "Brisela, Voice of Nightmares" })}
        {...rest}
        meld={{
          ...rest.meld,
          relations: [
            relation({ id: "b", name: "Bruna, the Fading Light", component: "meld_part" }),
            relation({ id: "g", name: "Gisela, the Broken Blade", component: "meld_part" }),
          ],
        }}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Meld part — Bruna, the Fading Light" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Meld part — Gisela, the Broken Blade" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^meld —/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open melded card" })).not.toBeInTheDocument();
  });
});
