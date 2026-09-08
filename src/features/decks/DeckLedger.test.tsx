import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  TOOLTIP_OPEN_MS,
  TOOLTIP_PANEL_ID,
  TooltipProvider,
} from "@/components/tooltip/TooltipProvider";
import type { DeckCard } from "@/lib/ipc";
import { MARKETPLACES } from "@/lib/marketplace";
import { pricesAsOf } from "@/lib/prices";
import { card } from "./validation/fixtures";
import { DeckLedger } from "./DeckLedger";

/**
 * Hover a tooltip anchor open and hand back its panel — a term's hint describes an already-named
 * pair (the label and the value beside it), so it binds `describes: true` (the default) and the
 * panel carries `role="tooltip"`.
 */
async function openTooltip(anchor: Element): Promise<HTMLElement> {
  fireEvent.pointerEnter(anchor);
  return await screen.findByRole("tooltip", {}, { timeout: TOOLTIP_OPEN_MS + 1000 });
}

/** An `{X}` spell, for the one figure the deck's split flag must not reach. */
function xSpell(name: string, overrides: Partial<DeckCard> = {}): DeckCard {
  return card({ name, typeLine: "Sorcery", manaCost: "{X}{B}{B}{B}", cmc: 3, ...overrides });
}

describe("DeckLedger", () => {
  const ledger = (cards: DeckCard[], props: Partial<Parameters<typeof DeckLedger>[0]> = {}) =>
    render(
      <TooltipProvider>
        <DeckLedger
          cards={cards}
          marketplace={MARKETPLACES.tcgplayer}
          formatName="Commander"
          gameChangers={0}
          // **The spotlight's three props default to off and to nothing**, so every case above
          // that is about a *figure* says nothing about the chip. `spotlight` is the latch alone
          // — never the editor's `latched || hovered` — and the two callbacks are no-ops rather
          // than spies here: a test that asserts on a gesture passes its own `vi.fn()` through
          // `props`, which is what keeps the assertion beside the press that earns it.
          spotlight={false}
          onSpotlightToggle={() => {}}
          onSpotlightHover={() => {}}
          tight={false}
          // The ordinary deck, which is what every case above the virtual block is a claim
          // about — so the `Owned` term goes on being asserted exactly as it was before the prop
          // existed. The `false` arm is passed explicitly, and only there.
          tracksCollection
          check={null}
          bracket={null}
          {...props}
        />
      </TooltipProvider>,
    );

  /** The pair a term is: the label, and the number it names. */
  const term = (label: string) =>
    screen.getByText(label, { selector: "dt" }).closest("div") as HTMLElement;

  /**
   * The headline figure is the number the format check beside it is talking about — the engine's
   * own `SIZE_KINDS`. The sideboard and the companion are counted by the price, the shortfall and
   * every chart, and named in the tooltip — in the reader's own words for those piles — rather
   * than folded in: "Cards 9" over a button reading "you have 5" is two numbers for one question.
   */
  it("heads the line with the cards a format's size rule counts", async () => {
    ledger([
      card({ name: "Bolt", quantity: 4 }),
      card({ name: "Kenrith", categoryKind: "commander", quantity: 1 }),
      card({ name: "Pyroblast", categoryKind: "side", quantity: 3 }),
      card({ name: "Lurrus", categoryKind: "companion", quantity: 1 }),
      card({ name: "Ghost", categoryKind: "maybe", quantity: 9 }),
    ]);

    // 5 sized, and the +4 is everything switched on that the size rule does not count.
    expect(term("Cards").querySelector("dd")?.textContent).toBe("5+4");
    expect(await openTooltip(term("Cards"))).toHaveTextContent(
      "plus 3 sideboard + 1 companion it does not",
    );
  });

  it("draws no spare count for a deck that is only a main deck", () => {
    ledger([card({ name: "Bolt", quantity: 4 })]);

    expect(term("Cards").querySelector("dd")?.textContent).toBe("4");
  });

  /**
   * The one figure the deck's `separateXGroup` must leave alone, and here it cannot reach at all:
   * the ledger calls `deckStats` without the flag, because the flag moves cards between *curve
   * buckets* and this line draws no curve. `(3 x 4 + 1 x 4) / 8 = 2.00` with X at zero
   * (CR 202.3b), whichever bar those spells would be drawn in.
   */
  it("averages mana value over nonlands, with X at zero", () => {
    ledger([xSpell("Awakening", { quantity: 4 }), card({ name: "Bolt", cmc: 1, quantity: 4 })]);

    expect(term("Avg. mana")).toHaveTextContent("2.00");
  });

  /** An average of no numbers is not zero — a deck of nothing but lands has none to give. */
  it("shows an em dash rather than a zero average for a deck of nothing but lands", () => {
    ledger([
      card({ name: "Island", typeLine: "Basic Land — Island", cmc: 0, quantity: 20 }),
    ]);

    expect(within(term("Avg. mana")).getByText("—")).toBeInTheDocument();
  });

  /** Spec §5: a price never appears without saying how old it is — and, now that a reader can
   *  pick, whose it is. The row has no room to write it, so it is the term's tooltip. */
  it("says how old the deck's price is, and whose", async () => {
    ledger([card({ name: "Bolt", unitPrice: 4.5, quantity: 2 })]);

    expect(term("Price")).toHaveTextContent("$9.00");
    expect(await openTooltip(term("Price"))).toHaveTextContent(pricesAsOf(MARKETPLACES.tcgplayer));
  });

  /**
   * The figure and its as-of sentence move together with the marketplace. A figure still quoting
   * dollars beside a euro sentence would be the one failure a reader cannot detect from the
   * number alone.
   */
  it("draws the selected marketplace's currency and its own as-of sentence", async () => {
    // The row as a Cardmarket read answers it: €3.00 a copy, where TCGplayer's read of the same
    // card answers $4.50. A switch changes the rows, not which field a figure reads.
    ledger([card({ name: "Bolt", unitPrice: 3, quantity: 2 })], {
      marketplace: MARKETPLACES.cardmarket,
    });

    expect(term("Price")).toHaveTextContent("€6.00");
    expect(screen.queryByText("$9.00")).not.toBeInTheDocument();
    expect(await openTooltip(term("Price"))).toHaveTextContent(pricesAsOf(MARKETPLACES.cardmarket));
  });

  /**
   * An etched printing has no euro price at all, so on Cardmarket the figure is an em dash with
   * the copies counted in the tooltip — never the dollar figure re-badged.
   */
  it("shows an em dash and counts the unpriced copies for a deck with no euro prices", async () => {
    ledger([card({ name: "Etched Bomb", unitPrice: null, quantity: 2 })], {
      marketplace: MARKETPLACES.cardmarket,
    });

    expect(within(term("Price")).getByText("—")).toBeInTheDocument();
    expect(await openTooltip(term("Price"))).toHaveTextContent("2 unpriced");
  });

  /** What the deck secured from the collection, and what it could not. */
  it("counts what the deck owns and what it is short of", () => {
    ledger([card({ name: "Bolt", quantity: 4, ownedQuantity: 1 })]);

    expect(term("Owned")).toHaveTextContent("1");
    expect(screen.getByText("3 missing")).toBeInTheDocument();
  });

  it("says nothing about a shortfall for a deck it holds every copy of", () => {
    ledger([card({ name: "Bolt", quantity: 4, ownedQuantity: 4 })]);

    expect(screen.queryByText(/missing/)).not.toBeInTheDocument();
  });

  /**
   * The narrow column shortens the shortfall to a sign, and the words stay for a screen reader:
   * `−3` is only legible beside the number it is short of, which is exactly what a reader hearing
   * this line one term at a time does not have.
   */
  it("shortens the shortfall to a sign when the column is tight, keeping the words", () => {
    ledger([card({ name: "Bolt", quantity: 4, ownedQuantity: 1 })], { tight: true });

    expect(screen.getByText("−3")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("3 missing")).toHaveClass("sr-only");
  });

  /**
   * **The ruleset every number is judged against, because the header's format select is gone.**
   * Changing it is a Deck settings trip now; saying which one it is has to stay on screen, or the
   * check beside these figures is a count with no scope.
   */
  it("names the format the deck is judged by", () => {
    ledger([card({ name: "Bolt" })]);

    expect(term("Format")).toHaveTextContent("Commander");
  });

  /** It is the first thing to go when the column is narrow: the check button's own accessible
   *  name still carries the ruleset at every width. */
  it("drops the format term when the column is tight", () => {
    ledger([card({ name: "Bolt" })], { tight: true });

    expect(screen.queryByText("Format")).not.toBeInTheDocument();
  });

  /**
   * Beside the check rather than inside it: the check counts what is *wrong* and this counts what
   * is *powerful*. A game changer is legal by definition, so folding the number into a button that
   * reads "4 issues" would invent four problems.
   */
  it("counts the game changers", () => {
    ledger([card({ name: "Bolt" })], { gameChangers: 2 });

    expect(screen.getByText("2 game changers")).toBeInTheDocument();
  });

  it("counts one game changer in the singular", () => {
    ledger([card({ name: "Bolt" })], { gameChangers: 1 });

    expect(screen.getByText("1 game changer")).toBeInTheDocument();
  });

  /** A chip reading `0 game changers` is a control saying there is something to look at. */
  it("draws no game-changer chip at all for a deck that plays none", () => {
    ledger([card({ name: "Bolt" })]);

    expect(screen.queryByText(/game changer/)).not.toBeInTheDocument();
  });

  /** Abbreviated on a narrow column, with the words kept for a screen reader. */
  it("abbreviates the game-changer count when the column is tight", () => {
    ledger([card({ name: "Bolt" })], { gameChangers: 6, tight: true });

    expect(screen.getByText("6 GC")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("6 game changers")).toHaveClass("sr-only");
  });

  /**
   * ## The game-changer spotlight (2026-09-08)
   *
   * The count became a **press**: hovering it, or the caret landing on it, fades every card in
   * the deck that is not a game changer to a quarter, and a click latches that so the reader can
   * take their hand off the mouse. The chip decides none of it — it reports two gestures and is
   * handed one boolean back — so everything below is about the *reporting* and about what the
   * boolean is allowed to mean.
   *
   * **None of these tests can see the fade, and none of them pretends to.** jsdom applies no
   * stylesheet, so `opacity: 0.25` is unreachable from here in principle rather than for want of
   * a query: the rule lives in `src/index.css`, keyed on an attribute the *editor* stamps
   * (`DeckEditor.test.tsx` covers that half) and a class the four views stamp
   * (`views/views.test.tsx` covers that one). What is checkable here is the control: its role,
   * its name, its pressed state, which gesture reaches which callback, and that its two
   * appearances are drawn differently at all. The pixels are the live pass's.
   */

  /**
   * It is a `button` with `aria-pressed`, which is the whole of how a toggle says what it is —
   * and the name carries the **action**, because the visible text is a readout: a chip reading
   * `6 game changers` and nothing else is a control nobody can tell is a control.
   *
   * The name opens with the drawn words so they stay a prefix of it (WCAG 2.5.3), and what
   * follows names the state a press would move *to* rather than the one the chip is in —
   * `aria-pressed` is already saying where it stands, and a toggle's label is a verb.
   */
  it("draws the game-changer count as a toggle that says it can be pressed", () => {
    ledger([card({ name: "Bolt" })], { gameChangers: 6 });

    expect(
      screen.getByRole("button", { name: "6 game changers — press to spotlight them in the deck" }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  /** …and the other way once it is latched, so the name is never a description of the state the
   *  reader is already in. */
  it("names the press by the state it would move to, once it is latched", () => {
    ledger([card({ name: "Bolt" })], { gameChangers: 6, spotlight: true });

    expect(
      screen.getByRole("button", {
        name: "6 game changers — press to stop spotlighting them in the deck",
      }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  /**
   * **`aria-pressed` is the latch and never the hover**, which is the reason the editor hands
   * this chip `gcLatched` rather than the `gcLatched || gcHovered` the deck is drawn under.
   *
   * A pointer resting on a control is not a state the control is *in* — the chip paints that for
   * itself with a `hover:` variant — so a chip that said `aria-pressed="true"` because a mouse
   * had wandered over it would tell a screen reader a press had happened that had not.
   */
  it("leaves aria-pressed alone while the pointer is merely resting on the chip", async () => {
    const onSpotlightHover = vi.fn();
    ledger([card({ name: "Bolt" })], { gameChangers: 6, onSpotlightHover });
    const chip = screen.getByRole("button", { name: /game changers/ });

    await userEvent.hover(chip);

    expect(onSpotlightHover).toHaveBeenCalledWith(true);
    expect(chip).toHaveAttribute("aria-pressed", "false");
    expect(chip.getAttribute("aria-label")).toContain("press to spotlight");
  });

  /** The press is reported and nothing is decided: the chip is controlled, so its own state does
   *  not move until the editor hands a new `spotlight` back down. */
  it("reports a press without latching anything itself", async () => {
    const onSpotlightToggle = vi.fn();
    ledger([card({ name: "Bolt" })], { gameChangers: 6, onSpotlightToggle });
    const chip = screen.getByRole("button", { name: /game changers/ });

    await userEvent.click(chip);

    expect(onSpotlightToggle).toHaveBeenCalledTimes(1);
    expect(chip).toHaveAttribute("aria-pressed", "false");
  });

  /** The pointer arriving and the pointer leaving, in that order and with the right boolean —
   *  one callback, so the editor never has to work out which of two verbs it was handed. */
  it("reports the pointer arriving on the chip and leaving it", async () => {
    const onSpotlightHover = vi.fn();
    ledger([card({ name: "Bolt" })], { gameChangers: 6, onSpotlightHover });

    const chip = screen.getByRole("button", { name: /game changers/ });
    await userEvent.hover(chip);
    await userEvent.unhover(chip);

    expect(onSpotlightHover.mock.calls).toEqual([[true], [false]]);
  });

  /**
   * **The caret arms it exactly as the pointer does, and that is not a courtesy** — a reveal only
   * a mouse could reach would put the whole affordance out of a keyboard reader's hands.
   *
   * Driven with `Tab` rather than `chip.focus()`: a programmatic focus is a caret nobody has, and
   * it would pass over a chip that had been given `tabIndex={-1}` or drawn as a `div`. The second
   * Tab is what proves the *blur* half — it lands on the bracket control slotted in beside the
   * chip, which is where a real reader's next press would go.
   */
  it("arms and disarms on the caret, reached the way a keyboard reader reaches it", async () => {
    const user = userEvent.setup();
    const onSpotlightHover = vi.fn();
    ledger([card({ name: "Bolt" })], {
      gameChangers: 6,
      onSpotlightHover,
      bracket: <button type="button">Bracket ~4</button>,
    });

    await user.tab();
    expect(screen.getByRole("button", { name: /game changers/ })).toHaveFocus();
    expect(onSpotlightHover.mock.calls).toEqual([[true]]);

    await user.tab();
    expect(screen.getByRole("button", { name: "Bracket ~4" })).toHaveFocus();
    expect(onSpotlightHover.mock.calls).toEqual([[true], [false]]);
  });

  /**
   * **One Tab has to do two things, and this chip is the one control on the row where they
   * collide.** The caret landing on it arms the spotlight *and* opens the hint; the caret leaving
   * puts both away.
   *
   * That is a regression test rather than a completeness one. `useTooltip`'s binding is four
   * handlers and two of them are `onFocus`/`onBlur`, so a `{...tip(…)}` spread followed by the
   * chip's own `onFocus` does not merge them — the later prop **replaces** the earlier one,
   * silently, and what goes is the half of the tooltip only a keyboard reader ever sees. It
   * shipped that way: the spotlight armed, the panel never opened, nothing went red, and the
   * pointer path stayed correct throughout because `onPointerEnter` and `onMouseEnter` are two
   * different props. The chip chains the two now, and this is what fails if a later edit spreads
   * over one of them again.
   *
   * **Driven with `Tab` for the reason the test above it is**, and here it is load-bearing twice:
   * `TooltipProvider.focus` refuses an anchor that does not match `:focus-visible`, and jsdom
   * implements a real modality — a pointer event anywhere in the window turns it off until a
   * keypress restores it — so a programmatic `focus()` after any of the hover cases above would
   * prove nothing about the path a reader takes.
   *
   * `document.getElementById` rather than `getByRole("tooltip")`: the binding is
   * `describes: false`, so the panel carries no role at all — the accessible name already says
   * this sentence, and a wired `aria-describedby` would have a screen reader announce it twice.
   */
  it("opens the chip's own hint on the caret, and puts it away again", async () => {
    const user = userEvent.setup();
    ledger([card({ name: "Bolt" })], {
      gameChangers: 6,
      bracket: <button type="button">Bracket ~4</button>,
    });

    await user.tab();
    const chip = screen.getByRole("button", { name: /game changers/ });
    expect(chip).toHaveFocus();
    expect(document.getElementById(TOOLTIP_PANEL_ID)).toHaveTextContent(
      "6 game changers — press to spotlight them in the deck",
    );
    // The panel is drawn for the eye alone: the name above already carries the sentence.
    expect(chip).not.toHaveAttribute("aria-describedby");

    await user.tab();

    // `waitFor` rather than a bare read: the panel leaves through `AnimatePresence`, so its
    // removal is a commit or two after the blur even with the suite's animations skipped.
    await waitFor(() => expect(document.getElementById(TOOLTIP_PANEL_ID)).toBeNull());
  });

  /**
   * The two states are drawn differently, which is the most this suite can say about the look:
   * the crown appears — the same mark the cards it is lighting up wear — and the edge takes the
   * gold, which is the signal that outlives the pointer.
   *
   * **Not a claim about colour or opacity.** jsdom applies no stylesheet, so `text-pie-gold` is
   * a class here and nothing more; whether the chip is actually gold and whether the deck
   * actually fades are the live pass's to see. `classList.contains` rather than `toHaveClass`
   * for the off arm, because that arm carries `hover:text-pie-gold` and the question being asked
   * is about tokens rather than about the string.
   */
  it("takes the crown and the gold edge only while it is latched", () => {
    const off = ledger([card({ name: "Bolt" })], { gameChangers: 6 }).container.querySelector(
      "button",
    )!;
    const latched = ledger([card({ name: "Bolt" })], {
      gameChangers: 6,
      spotlight: true,
    }).container.querySelector("button")!;

    expect(off.querySelector("svg")).toBeNull();
    expect(latched.querySelector("svg")).not.toBeNull();
    expect(off.classList.contains("border-pie-gold")).toBe(false);
    expect(latched.classList.contains("border-pie-gold")).toBe(true);
  });

  /**
   * **A latch on a deck with nothing to spotlight still draws no chip**, which is the fence on
   * the state outliving its own control.
   *
   * The editor gates the *derivation* rather than clearing the latch, so `spotlight` can arrive
   * here `true` for a deck whose last game changer has just been stepped to zero. What must
   * never happen is a chip reading `0 game changers` — a control that says there is something to
   * look at and does nothing when pressed.
   */
  it("draws nothing at all for a deck with no game changers, latched or not", () => {
    ledger([card({ name: "Bolt" })], { gameChangers: 0, spotlight: true });

    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText(/game changer/)).not.toBeInTheDocument();
  });

  /**
   * The narrow arm deletes the word from the **drawing** and never from the name: an `aria-label`
   * replaces an element's contents for naming, so the `sr-only` twin beside `6 GC` is announced
   * to nobody and the whole sentence — count and action — has to be in the label at both widths.
   *
   * The press is driven here too, because `tight` is a second render path through the same
   * button and a control that stopped reporting at 761px would be a control the narrow window
   * simply does not have.
   */
  it("keeps the whole name and the press at the tight width", async () => {
    const onSpotlightToggle = vi.fn();
    ledger([card({ name: "Bolt" })], { gameChangers: 6, tight: true, onSpotlightToggle });

    const chip = screen.getByRole("button", {
      name: "6 game changers — press to spotlight them in the deck",
    });
    expect(screen.getByText("6 GC")).toHaveAttribute("aria-hidden", "true");

    await userEvent.click(chip);

    expect(onSpotlightToggle).toHaveBeenCalledTimes(1);
  });

  /**
   * The three controls at the right end are the caller's, in the order the design draws them:
   * what is wrong, what is powerful, and the bracket the two add up to.
   */
  it("slots the check and the bracket around the game-changer count", () => {
    ledger([card({ name: "Bolt" })], {
      gameChangers: 2,
      check: <button type="button">2 issues</button>,
      bracket: <button type="button">Bracket ~4</button>,
    });

    const wanted = ["2 issues", "2 game changers", "Bracket ~4"];
    const drawn = [...document.querySelectorAll("dl button, dl span")]
      .map((el) => el.textContent ?? "")
      .filter((text) => wanted.includes(text));
    expect(drawn).toEqual(wanted);
  });

  /** A `<dl>` whose children are all `div`s is a valid description list; the design's `span`
   *  separators are not, which is why the hairlines are `div`s and `aria-hidden`. */
  it("keeps every child of the list a div", () => {
    const { container } = ledger([card({ name: "Bolt" })]);
    const list = container.querySelector("dl")!;

    expect([...list.children].every((child) => child.tagName === "DIV")).toBe(true);
  });

  /**
   * **A Virtual deck (issue #401): the `Owned` figure goes, and the hairline in front of it goes
   * with it.**
   *
   * Counted as `<dt>`s below — six on a regular deck and five here — which is the five *figures*
   * plus the `Format` term, the one pair on this line that is not a figure and is drawn as one.
   *
   * The rows are the ones the `Owned` cases above use — short of three of four — so the term
   * would draw `1` and a red `3 missing` if the condition were missed. Which is the same fixture
   * read two ways, and deliberately: the two blocks are the two arms of one prop.
   */
  describe("a deck that does not track a collection", () => {
    const virtual = (props: Partial<Parameters<typeof DeckLedger>[0]> = {}) =>
      ledger([card({ name: "Bolt", quantity: 4, ownedQuantity: 1 })], {
        tracksCollection: false,
        ...props,
      });

    it("draws no Owned term and says nothing about a shortfall", () => {
      virtual();

      expect(screen.queryByText("Owned", { selector: "dt" })).not.toBeInTheDocument();
      expect(screen.queryByText(/missing/)).not.toBeInTheDocument();
    });

    /** The tight column's shortfall is a *second* element with a second sentence, so it needs a
     *  claim of its own: the `sr-only` twin is exactly the kind of thing a visual check misses. */
    it("draws neither half of the tight shortfall either", () => {
      virtual({ tight: true });

      expect(screen.queryByText("−3")).not.toBeInTheDocument();
      expect(screen.queryByText("3 missing")).not.toBeInTheDocument();
    });

    /**
     * **The hairline in front of it goes too, and nothing else moves.**
     *
     * Every term on this line is preceded by its own `Rule`, so dropping the last term without
     * its rule leaves a divider between Price and the controls pinned right — punctuation with
     * nothing after it. Counted rather than eyeballed, and **against the regular deck's own
     * count in the same test**: a bare "four hairlines" would be satisfied by an arrangement
     * that had dropped one from somewhere else entirely. `aria-hidden` is what tells a hairline
     * from a term, since both are `div` children of the `<dl>`.
     */
    it("drops the hairline that stood in front of the Owned term", () => {
      const shape = (root: ParentNode) => ({
        rules: root.querySelectorAll("dl > div[aria-hidden]").length,
        terms: root.querySelectorAll("dl > div > dt").length,
      });

      expect(shape(virtual().container)).toEqual({ rules: 4, terms: 5 });

      cleanup();
      const regular = ledger([card({ name: "Bolt", quantity: 4, ownedQuantity: 1 })]);
      expect(shape(regular.container)).toEqual({ rules: 5, terms: 6 });
    });

    /** Everything that is a fact about the *list* rather than about a binder stays — including
     *  the controls pinned right, which the missing term sits directly in front of. */
    it("keeps the other four terms and the controls beside them", () => {
      virtual({
        gameChangers: 2,
        check: <button type="button">2 issues</button>,
        bracket: <button type="button">Bracket ~4</button>,
      });

      for (const label of ["Format", "Cards", "Lands", "Avg. mana", "Price"]) {
        expect(screen.getByText(label, { selector: "dt" })).toBeInTheDocument();
      }
      expect(screen.getByText("2 issues")).toBeInTheDocument();
      expect(screen.getByText("2 game changers")).toBeInTheDocument();
      expect(screen.getByText("Bracket ~4")).toBeInTheDocument();
    });

    /** The `<dl>` is still a valid description list with a term taken out of it — a fragment
     *  renders no element, so the children are still all `div`s. */
    it("keeps every child of the list a div", () => {
      const { container } = virtual();
      const list = container.querySelector("dl")!;

      expect([...list.children].every((child) => child.tagName === "DIV")).toBe(true);
    });
  });
});
