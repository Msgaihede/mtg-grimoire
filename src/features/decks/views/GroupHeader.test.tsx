import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TooltipProvider, TOOLTIP_OPEN_MS } from "@/components/tooltip/TooltipProvider";
import type { CategoryKind } from "@/lib/ipc";
import { MARKETPLACES } from "@/lib/marketplace";
import { pricesAsOf } from "@/lib/prices";
import { tokenCountWords } from "../CountPill";
import type { CardGroup } from "../grouping";
import { GroupHeader, MARKER_WORDS } from "./GroupHeader";

function group(over: Partial<CardGroup> = {}): CardGroup {
  return {
    key: "cat-1",
    name: "Ramp",
    kind: "main",
    categoryId: 1,
    isActive: true,
    isPredefined: false,
    // `isAuto` decides whether an *empty* pile is drawn at all (`drawsWhenEmpty`) and nothing
    // about how a drawn one looks: there is no third marker for it, and there should not be —
    // who made the pile is not a fact about the cards under it. It is `false` here for the same
    // reason `isPredefined` is: the fixture is a pile the reader made.
    isAuto: false,
    cards: [],
    count: 0,
    totalPrice: null,
    ...over,
  };
}

/** A pile the reader made, priced, drawn in one of the three layouts. */
function renderHeader({
  layout,
  ...over
}: Partial<CardGroup> & { layout?: "spread" | "tight" | "stacked" } = {}) {
  return render(
    <GroupHeader
      group={group({ totalPrice: 4.97, ...over })}
      marketplace={MARKETPLACES.tcgplayer}
      layout={layout}
    />,
  );
}

const RULE = MARKER_WORDS.rule;
const OFF = MARKER_WORDS.inactive;

/**
 * Which marks a heading wears, read by the words a screen reader hears — the chips draw a glyph
 * and no visible word since 2026-09-26, so the `sr-only` span is the one text a mark has.
 */
const markers = () => [RULE, OFF].filter((words) => screen.queryByText(words) !== null);

/** The chip a mark's words live in — the element the tooltip is bound on. */
const chip = (words: string) => screen.getByText(words).parentElement!;

/**
 * The two marks answer **different questions** and a pile can carry both. The rule mark is about
 * the ruleset; the switched-off mark is about the switch. The wrong reading — "the rule mark
 * means predefined and undeletable" — is plausible, would put the mark on the Maybeboard, and is
 * what this suite exists to catch.
 */
describe("GroupHeader markers", () => {
  it.each<[CategoryKind, boolean, string[]]>([
    // The three piles a format has an opinion about.
    ["commander", true, [RULE]],
    ["side", true, [RULE]],
    ["companion", true, [RULE]],
    // A category the reader made is theirs, whatever they called it.
    ["main", true, []],
    // The Maybeboard is not a rules role. It is a pile seeded with its switch off, and
    // `SIZE_KINDS` counts an *active* one exactly like a `main` pile — so the switched-off mark
    // is the whole of what is true about it, and a rule mark beside it would claim a role the
    // format has never heard of.
    ["maybe", false, [OFF]],
  ])("marks a %s pile as %s → %s", (kind, isActive, expected) => {
    render(<GroupHeader group={group({ kind, isActive })} marketplace={MARKETPLACES.tcgplayer} />);
    expect(markers()).toEqual(expected);
  });

  /** Both, and both true of it: a reader who switches the Sideboard off has a pile the rules
   *  still name and that still counts toward nothing. */
  it("marks a switched-off Sideboard with both", () => {
    render(
      <GroupHeader
        group={group({ kind: "side", isActive: false })}
        marketplace={MARKETPLACES.tcgplayer}
      />,
    );
    expect(markers()).toEqual([RULE, OFF]);
  });

  /**
   * **A mark is a glyph for the eye and its words for a screen reader, in one chip.** The glyph
   * is `aria-hidden`, so the chip's whole accessible text is its `sr-only` words; the words are
   * one element, never assembled from two. The chip is `relative`, because an `sr-only` span is
   * `position: absolute` and one with no positioned ancestor has stretched this app's document.
   */
  it.each([RULE, OFF])("draws the %s mark as an aria-hidden glyph beside its words", (words) => {
    render(
      <GroupHeader
        group={group({ kind: "side", isActive: false })}
        marketplace={MARKETPLACES.tcgplayer}
      />,
    );
    expect(screen.getByText(words)).toHaveClass("sr-only");
    const box = chip(words);
    expect(box).toHaveClass("relative", "shrink-0", "size-3.5");
    expect(box.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    // No visible word left in the chip: the words are the sr-only span's and nobody else's.
    expect(box).toHaveTextContent(new RegExp(`^${words}$`));
  });

  /** Where something computes a name over the heading — `TableView`'s cell — the marks read
   *  after the name as words of their own, not run into it. */
  it("reads a switched-off Sideboard's marks after its name, word for word", () => {
    render(
      <div role="table">
        <div role="row">
          <span role="cell">
            <GroupHeader
              group={group({
                name: "Sideboard",
                kind: "side",
                isActive: false,
                count: 3,
                totalPrice: 4.97,
              })}
              marketplace={MARKETPLACES.tcgplayer}
            />
          </span>
        </div>
      </div>,
    );
    expect(screen.getByRole("cell")).toHaveAccessibleName(
      `Sideboard ${RULE} ${OFF} 3 cards $4.97`,
    );
  });

  /** A derived heading — "Mana value 3" — is neither a rules role nor a switch. Nothing can
   *  be dropped into it and nothing can be turned off about it. */
  it("marks a derived group with neither", () => {
    render(
      <GroupHeader
        group={group({ kind: null, categoryId: null, name: "Mana value 3" })}
        marketplace={MARKETPLACES.tcgplayer}
      />,
    );
    expect(markers()).toEqual([]);
  });

  it("says what each marker means, rather than leaving two words to be guessed at", async () => {
    render(
      <TooltipProvider>
        <GroupHeader
          group={group({ kind: "commander", isActive: false })}
          marketplace={MARKETPLACES.tcgplayer}
        />
      </TooltipProvider>,
    );
    // On the chip itself — the element the binding is spread on — not on the words inside it.
    fireEvent.pointerEnter(chip(RULE));
    const ruleTip = await screen.findByRole("tooltip", {}, { timeout: TOOLTIP_OPEN_MS + 1000 });
    expect(ruleTip).toHaveTextContent("rules read this pile");
    fireEvent.pointerLeave(chip(RULE));

    fireEvent.pointerEnter(chip(OFF));
    const inactiveTip = await screen.findByRole(
      "tooltip",
      {},
      { timeout: TOOLTIP_OPEN_MS + 1000 },
    );
    expect(inactiveTip).toHaveTextContent("Switched off");
  });
});

/**
 * The heading's other half: the pile's total, in the marketplace the reader picked.
 *
 * This is the one component all four deck views draw their headings with, so it is the single
 * place a currency mistake would reach every one of them at once.
 */
describe("GroupHeader price", () => {
  it("draws the total in the selected marketplace's currency", () => {
    const { rerender } = render(
      <GroupHeader group={group({ totalPrice: 4.97 })} marketplace={MARKETPLACES.tcgplayer} />,
    );
    expect(screen.getByText("$4.97")).toBeInTheDocument();

    rerender(
      <GroupHeader group={group({ totalPrice: 4.97 })} marketplace={MARKETPLACES.cardmarket} />,
    );
    expect(screen.getByText("€4.97")).toBeInTheDocument();
    expect(screen.queryByText("$4.97")).not.toBeInTheDocument();
  });

  /** Spec §5, with the marketplace's name in it: five in the picker means "as of the last
   *  sync" alone would leave the reader guessing whose prices these are. */
  it("names the marketplace in the as-of sentence", async () => {
    render(
      <TooltipProvider>
        <GroupHeader group={group({ totalPrice: 1 })} marketplace={MARKETPLACES.cardmarket} />
      </TooltipProvider>,
    );
    fireEvent.pointerEnter(screen.getByText("€1.00"));
    const tooltip = await screen.findByRole("tooltip", {}, { timeout: TOOLTIP_OPEN_MS + 1000 });
    expect(tooltip).toHaveTextContent(pricesAsOf(MARKETPLACES.cardmarket));
  });

  /** A pile nothing in it is priced quotes no number at all — `€0.00` is a price nobody
   *  offered, and on Cardmarket an etched pile is exactly this case. */
  it("is an em dash for a pile with no price in this currency", () => {
    render(
      <GroupHeader group={group({ totalPrice: null })} marketplace={MARKETPLACES.cardmarket} />,
    );
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});

/**
 * The figures: a count pill and the price, on the name's own row in every layout (token stacks
 * spec §3.1).
 *
 * **jsdom lays nothing out, so these assert the classes that make the row wrap rather than where
 * anything lands.** At 0.5× a stack column is ~117px and a switched-off Sideboard carries a grip,
 * both mark chips, the pill and a price — the row has to put the figures under the name there
 * rather than hang them out of the column, and only a live pass can see which it does.
 */
describe("GroupHeader figures", () => {
  it("states the count as a pill whose words a screen reader hears", () => {
    renderHeader({ count: 4 });
    expect(screen.getByText("4 cards")).toHaveClass("sr-only");
    expect(screen.queryByText(/^4 cards$/, { selector: ":not(.sr-only)" })).toBeNull();
  });

  it("draws the stacked heading as one wrapping row, name first and figures after", () => {
    const { container } = renderHeader({ layout: "stacked" });
    const root = container.firstElementChild as HTMLElement;
    expect(root).toHaveClass("flex-wrap");
    expect(root).not.toHaveClass("flex-col");
    const name = screen.getByText("Ramp");
    expect(name).toHaveClass("min-w-0", "truncate");
    const price = screen.getByText("$4.97");
    expect(price.parentElement).toHaveClass("shrink-0");
  });

  /** One row in all three layouts, the pill before the price in one block that cannot shrink —
   *  and no `·` between them, because the pill's own edge is the separator now. */
  it.each(["spread", "tight", "stacked"] as const)(
    "draws the %s heading as one wrapping row with the pill before the price",
    (layout) => {
      const { container } = renderHeader({ layout, count: 3 });
      const root = container.firstElementChild as HTMLElement;
      expect(root).toHaveClass("flex", "flex-wrap");
      expect(root).not.toHaveClass("flex-col");

      const price = screen.getByText("$4.97");
      const figures = price.parentElement!;
      expect(figures).toHaveClass("shrink-0");
      expect(figures.parentElement).toBe(root);
      const pill = within(figures).getByText("3 cards").parentElement!;
      expect(pill.compareDocumentPosition(price)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
      expect(screen.queryByText("·")).toBeNull();
    },
  );

  /**
   * **The stacked name block's floor is what decides whether the row wraps at all**, so it is
   * pinned. A row breaks lines on each item's basis clamped by its min-width: `flex-1` beside
   * `min-w-0` counts as zero wide, so the figures never wrap and the name is squeezed to nothing —
   * measured in Chromium at a 0.5× column's 97px header, `Ramp` drew 0px wide and a switched-off
   * Sideboard's marker (the word `INACTIVE`, then) landed on its own pill. `min-w-16` makes it
   * count as 4rem, so the row
   * stays one line while that much name fits beside the figures and wraps them only below it.
   * `flex-auto` is pinned absent because it wraps on the *whole* name, which gives up the one row
   * at 1× for any long name. The name itself stays `min-w-0 truncate`, so it gives way first.
   */
  it("floors the stacked name block at 4rem, so the row stays one line until it cannot", () => {
    renderHeader({ layout: "stacked" });
    const name = screen.getByText("Ramp");
    const block = name.parentElement!;
    expect(block).toHaveClass("min-w-16", "flex-1");
    expect(block).not.toHaveClass("min-w-0");
    expect(block).not.toHaveClass("flex-auto");
    expect(name).toHaveClass("min-w-0", "truncate");
  });

  /** `spread` keeps a bare `flex-1`: it never wraps, and its figures hold the far edge while the
   *  name truncates. `tight` grows neither way, so its figures sit right after the name. */
  it.each([
    ["spread", ["min-w-0", "flex-1"], ["min-w-16"]],
    ["tight", ["min-w-0"], ["min-w-16", "flex-1"]],
  ] as const)("leaves the %s name block unfloored", (layout, has, lacks) => {
    renderHeader({ layout });
    const block = screen.getByText("Ramp").parentElement!;
    expect(block).toHaveClass(...has);
    for (const cls of lacks) expect(block).not.toHaveClass(cls);
  });

  /**
   * The phrase the heading makes where something computes a name over it — `TableView` draws it
   * inside a `role="cell"`. Asserted whole, because the parts are exactly what a broken name
   * still passes: the pill's words and the price in two adjacent elements compute to
   * `3 cards$4.97` unless something between them survives as a space.
   */
  it("reads as one phrase, the count and the price apart", () => {
    render(
      <div role="table">
        <div role="row">
          <span role="cell">
            <GroupHeader
              group={group({ count: 3, totalPrice: 4.97 })}
              marketplace={MARKETPLACES.tcgplayer}
            />
          </span>
        </div>
      </div>,
    );
    expect(screen.getByRole("cell")).toHaveAccessibleName("Ramp 3 cards $4.97");
  });

  /** The token pile's heading is a `GroupHeading` — five fields, no `CardGroup` faked around
   *  them — and says its count in its own words. */
  it("takes the caller's words for the token pile", () => {
    render(
      <GroupHeader
        group={{ name: "Tokens & Emblems", count: 5, totalPrice: null, isActive: true, kind: null }}
        marketplace={MARKETPLACES.tcgplayer}
        words={tokenCountWords}
      />,
    );
    expect(screen.getByText("5 tokens and emblems")).toHaveClass("sr-only");
    expect(screen.queryByText("5 cards")).toBeNull();
    // Neither mark: the pile is not a rules zone or a switched-off pile, it is not in the deck.
    expect(markers()).toEqual([]);
  });
});
