import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";
import { GAME_CHANGER_LABEL } from "@/components/GameChangerMark";
import { MARKETPLACES } from "@/lib/marketplace";
import {
  deckCard,
  deckCategory,
  deckGroups,
  deckTheoryMatches,
  deckViolations,
  printing,
} from "../../../../.storybook/fake/fixtures";
import { THEORY_MATCH_ATTR, THEORY_MATCH_NAME_LABEL } from "../CardMarks";
import { buildGroups } from "../grouping";
import { theoryMatchPlan, type TheoryMarkSwitches, type TheoryPlan } from "../theoryMatch";
import { GridView } from "./GridView";

const meta = {
  title: "Decks/Views/GridView",
  component: GridView,
  tags: ["autodocs"],
  args: {
    groups: deckGroups(),
    // The default, and what every dollar figure in this file is a claim about. The setting
    // itself is `Settings/MarketplacePanel`; what a view owes it is one currency for the whole
    // screen, so a heading and the cards under it cannot name two.
    marketplace: MARKETPLACES.tcgplayer,
    violations: deckViolations(),
    onSelect: fn(),
  },
  decorators: [
    (Story) => (
      <div className="flex h-[36rem]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof GridView>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The stack's opposite: every card drawn, none of them covering another.
 *
 * A stack is for reading *down* a category; this is for seeing a whole deck at once — which is
 * what you want the moment before you cut something. A tile is the **stacked card's** face —
 * `DeckCardFace`, the same printed frame under the picture and the same marks over it — so a
 * reader who presses `Stacks | Grid` is looking at one deck drawn two ways rather than at two
 * decks.
 */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The Commander and the Sideboard; a category the reader named has no rules role.
    expect(canvas.getAllByText("RULE")).toHaveLength(2);
    expect(canvas.getByText("INACTIVE")).toBeInTheDocument();
    // The two marks, in the two corners they never share.
    expect(canvas.getByText("RULE BREAK")).toBeInTheDocument();
    // **The game changer is a crown printed on the copy count, and it is the same mark the
    // stacked card draws.** Three arrangements are retired rather than one: `CardArt`'s corner
    // chip, which this wall drew from 2026-08-16 until the two card-face views became one card;
    // the stack's spelled-out `Game Changer` ribbon; and the fork between them that stood for one
    // morning. The fork was measured — the ribbon is ~130px whatever the card is, so on a 165px
    // tile a 28px tag, that ribbon and a 28px tick came to 163px of marks and the face's
    // `overflow-hidden` clipped the plan's tick (shipped window, 2026-09-08) — and folding the
    // crown into the tag costs 14px instead, which is what took the width argument away entirely.
    // So the strip is two marks on both views: the crowned tag at one end, the tick at the other.
    //
    // The crown is `aria-hidden` inside an `aria-hidden` tag and binds its sentence through
    // `useTooltip()` rather than a `title`, so neither `getByRole` nor `getByTitle` reaches it —
    // the glyph's own class is the handle, exactly as in `GameChangerMark.test.tsx`.
    const crowned = canvas.getByRole("button", { name: /^Lightning Bolt/ });
    const crowns = crowned.querySelectorAll(".lucide-crown");
    expect(crowns).toHaveLength(1);
    // Printed *on* the count rather than beside it: the crown's parent is the tag, and the tag's
    // own text is the number. A crown that had drifted back out into the strip as a sibling would
    // pass a bare "there is a crown" and fail this.
    const tag = crowns[0].parentElement as HTMLElement;
    expect(tag).toHaveAttribute("aria-hidden", "true");
    expect(tag.textContent).toBe("1");
    // Neither the ribbon nor `components/GameChangerMark`, whose crown names itself as a
    // `role="img"` — that mark is the search side's, and a self-naming glyph inside a tag the
    // reader colours would be the one mark in the strip ignoring what it stands on.
    expect(within(crowned).queryByText("Game Changer")).not.toBeInTheDocument();
    expect(
      within(crowned).queryByRole("img", { name: GAME_CHANGER_LABEL }),
    ).not.toBeInTheDocument();
    // The words themselves are the button's, which is what a screen reader gets either way.
    expect(crowned).toHaveAccessibleName(expect.stringContaining("game changer"));
  },
};

/** Grouped by type — the wall a reader scans before deciding the creature count is wrong. */
export const ByType: Story = { args: { groups: deckGroups("type", "type") } };

/** No findings at all: a legal deck draws no red anywhere, which is what makes the red mean
 *  something on the deck that is not. */
export const NothingWrong: Story = { args: { violations: undefined } };

/**
 * The **Live** list of a deck that keeps a plan, where four of the ten cards are the plan and six
 * are not — and since 2026-09-08 **all ten wear a mark**.
 *
 * This is the whole point of the mark: a live list is what the reader has actually sleeved up, and
 * the one thing it cannot say about itself is which of its cards are the deck they designed and
 * which are the proxies and stand-ins waiting to be replaced. The tick says it, in the corner
 * opposite the `RULE BREAK` mark — see `CardMarks.tsx` for why those two are never allowed to
 * share one.
 *
 * **Two of the four planned marks are counts rather than ticks**, which is issue #212 and is why
 * this story is worth looking at rather than merely running: the fixture's plan asks for twice the
 * Island the deck holds and half the Boros Charm, so `+2` and `-1` are drawn in the same box, the
 * same azure and the same corner as the tick the other two wear. The number is the *action* the
 * plan is asking for — two Islands to add, one Boros Charm to cut. The tick is the card that
 * matches; a number is the card that does not.
 *
 * **The other six wear the red X**, the third tier's mark: the plan does not ask for that card at
 * all. It is a glyph and never a number, because there is no arithmetic to do on a card the plan
 * has no row for — nothing to add and nothing to cut, only *not this one*. A wall is where that
 * reads: three chips in three colours over ten tiles, rather than four chips and six blank
 * corners a reader has to interpret.
 *
 * `theoryPlan` is `undefined` in every other story in this file, which is what a deck with the
 * theory list switched off looks like and what the **Theory** tab itself looks like: no plan to
 * compare against, so no marks at all — which is a different picture from ten X's.
 */
export const TheoryMatches: Story = {
  args: { theoryPlan: deckTheoryMatches() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Every card on the wall is marked, and six of the ten wear the third tier's X. The mark is
    // `aria-hidden` and carries no `title` — it is bound `describes: false`, so
    // `THEORY_MATCH_ATTR` is `CardMarks.tsx`'s own handle for finding it after the fact, and both
    // the tick and the X have no text at all (each is an `<svg>`). The words are read off the
    // button instead.
    const marks = [...canvasElement.querySelectorAll(`[${THEORY_MATCH_ATTR}]`)];
    expect(marks).toHaveLength(10);

    const unplanned = [...canvasElement.querySelectorAll(`[${THEORY_MATCH_ATTR}="unplanned"]`)];
    expect(unplanned).toHaveLength(6);
    // An X and never a count: a card the plan has no row for has no difference to state.
    for (const mark of unplanned) {
      expect(mark.textContent).toBe("");
      expect(mark.querySelector("svg")).not.toBeNull();
    }

    // The four that *are* the plan, read on their own — **two of them are numbers rather than
    // ticks** (issue #212): the fixture asks for twice the Island the deck holds and half the
    // Boros Charm, so this is the one place both of the mark's drawings are seen side by side.
    // Scoped past the X's, whose six empty strings would otherwise drown the pair.
    const planned = [
      ...canvasElement.querySelectorAll(
        `[${THEORY_MATCH_ATTR}]:not([${THEORY_MATCH_ATTR}="unplanned"])`,
      ),
    ];
    expect(planned.map((mark) => mark.textContent).sort()).toEqual(["", "", "+2", "-1"]);

    // The card carrying both marks: in the plan **and** breaking a rule. The two facts are in
    // one sentence because a button's `aria-label` replaces everything inside it.
    const both = canvas.getByRole("button", { name: /^Island/ });
    expect(both).toHaveAccessibleName(expect.stringContaining("in the theory list"));
    expect(both).toHaveAccessibleName(expect.stringContaining("rule break:"));

    // And a card the plan does not ask for says so, in words — it is a *statement* now rather
    // than a silence. The negatives are what keep it the third tier's sentence and not a planned
    // one: green's own words are the prefix of blue's, and neither of them is this.
    const missing = canvas.getByRole("button", { name: /^Dismember/ });
    expect(missing).toHaveAccessibleName(expect.stringContaining("not in the theory list"));
    expect(missing).toHaveAccessibleName(expect.not.stringContaining("in the theory list ·"));
    expect(missing).toHaveAccessibleName(expect.not.stringContaining("to add"));
    expect(missing).toHaveAccessibleName(expect.not.stringContaining("to remove"));
  },
};

/* ------------------------------------------------- the two tiers, on one wall ---------- */

/**
 * The five rows the two stories below are about — a deck whose live list holds **two printings
 * of one planned card**, which is the shape {@link deckGroups} cannot have.
 *
 * That fixture is four planned cards in four printings, so every mark on it is `exact` and the
 * loose tier is invisible there. The whole of what blue means is *another printing of a card the
 * plan names*, and a wall with no such row can only show it by accident. So this deck is built
 * for the comparison and nothing else:
 *
 * | Row | What the plan says | The mark |
 * | --- | --- | --- |
 * | Lightning Bolt (`lea 161`) | 4 of **this** printing, 2 sleeved | `exact`, `+2` |
 * | Lightning Bolt (`2x2 117`) | the plan names the card, not this printing | `name`, tick |
 * | Sol Ring (`c21 263`) | 1 of this printing, 1 sleeved | `exact`, tick |
 * | Swords to Plowshares (`msc 143`) | 4 of `ema 32`, none of them sleeved | `name`, `+3` |
 * | Dismember (`nph 57`) | nothing at all | `unplanned`, X |
 *
 * **Both drawings in both colours, and a control wearing the third mark**, which is the one
 * arrangement that shows what each half of the mark carries: the two ticks differ only in colour,
 * the two numbers differ in colour *and* in grain — `+2` is about a printing and `+3` is about a
 * card — and the fifth row is what stops "every tile is marked" reading as a pass. Since
 * 2026-09-08 every tile really is marked, so the claim the control makes is about **which** mark:
 * a fifth tile drawing green or blue is the failure it catches, and a red X on the one row the
 * plan never named is the pass.
 *
 * The two Bolts are also the case the name grain exists for. Four copies of the card are sleeved
 * against four planned, so the loose tier reads `0`: the reader has the Bolts they asked for and
 * two of them are the wrong art. Green is what says which two.
 *
 * **The printings are named rather than the cards**, which is {@link deckTheoryMatches}' rule:
 * `CARDS` is generated and may be regenerated against a newer sync, so a hardcoded name would go
 * on reading as true while pointing at whatever printing that slot had become.
 */
function tierGroups() {
  return buildGroups(
    [
      deckCard(printing("lea", "161"), { quantity: 2, ownedQuantity: 2 }),
      deckCard(printing("2x2", "117"), { quantity: 2, ownedQuantity: 2 }),
      deckCard(printing("c21", "263"), { ownedQuantity: 1 }),
      deckCard(printing("msc", "143"), { ownedQuantity: 1 }),
      deckCard(printing("nph", "57"), { ownedQuantity: 1 }),
    ],
    [deckCategory("main")],
    "category",
    "alphabetical",
  );
}

/**
 * The plan behind {@link tierGroups}, with the deck's own three mark switches passed in.
 *
 * Built through `theoryMatchPlan` over the same rows the view is handed, for
 * {@link deckTheoryMatches}' reason: the numbers a story draws are then the ones the shipped
 * arithmetic produces rather than four typed here. The slot keys are spelled the way
 * `deck_theory.rs` spells them — `` `${cardId}|${finish ?? ""}` `` — rather than through
 * `theorySlot`, so the fixture cannot agree with the lookup by sharing its bug. `deckCard` builds
 * every row with `finish: null`, so these are the regular copies.
 *
 * **`ema 32` is a slot with no live row of its own**, which is what makes the fourth line of the
 * table above reachable: the plan names a Swords printing the reader has not got, and the copy
 * they *have* got is a different one. An exact tier alone would say nothing about that card at
 * all — no live row carries its key — which is the hole the second tier was added to fill.
 */
function tierPlan(marks: TheoryMarkSwitches): TheoryPlan {
  const slots = [
    { card: printing("lea", "161"), quantity: 4 },
    { card: printing("c21", "263"), quantity: 1 },
    { card: printing("ema", "32"), quantity: 4 },
  ].map((slot) => ({ key: `${slot.card.id}|`, nameKey: slot.card.name, quantity: slot.quantity }));
  return theoryMatchPlan(
    slots,
    tierGroups().flatMap((group) => group.cards),
    marks,
  ) as TheoryPlan;
}

/**
 * **Both tiers on one wall** — the printing the plan named in one colour, another printing of a
 * planned card in the other.
 *
 * This is the story the second tier was added for, and it is the only surface where the pair can
 * be judged: a mark is a small chip on card art, so whether two fills are far enough apart is a
 * question about a *wall* of them rather than about either one. `CardMarks.tsx` has the four
 * separations that keep either from reading as the rule break's red — the corner, the colour, the
 * shape and the card's own edge — and says out loud that the colour is the one of the four a
 * reader can defeat, in Settings → Appearance.
 *
 * **The two numbers are at different grains, and that is deliberate**, which this wall is also
 * the place to see: `+2` on the green Bolt is about that *printing* (two sleeved of four planned)
 * while `+3` on the blue Swords is about the *card* (one sleeved of four planned). The tier
 * decides the colour and the number together — `theoryMatch.ts` carries the reasoning, and the
 * reader chose this over one name-grain number on both tiers having been shown the case it costs
 * the most in.
 */
export const BothTiers: Story = {
  args: {
    groups: tierGroups(),
    theoryPlan: tierPlan({ exact: true, name: true, unplanned: true }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const drawn = (tier: string) =>
      [...canvasElement.querySelectorAll(`[${THEORY_MATCH_ATTR}="${tier}"]`)]
        .map((mark) => mark.textContent)
        .sort();

    // Two of each, and **the tier is read off the attribute rather than off a colour**: the fill
    // is a custom property now, jsdom resolves no stylesheet, and a reader who has picked their
    // own green in Settings has moved the very value an assertion would be pinning. A tick's
    // element has no text at all — it is an `<svg>` — so `""` is the tick and a string is a count.
    expect(drawn("exact")).toEqual(["", "+2"]);
    expect(drawn("name")).toEqual(["", "+3"]);
    // And the fifth row, in the third tier: an X, which is an `<svg>` and so reads as `""` here
    // too. It is the only one of the three marks that can never carry a number — there is no
    // difference to state about a card the plan has no row for.
    expect(drawn("unplanned")).toEqual([""]);

    // The clause blue adds, which is the whole of what a reader who cannot see the colour gets.
    // The mark is `aria-hidden` and bound `describes: false`, so the words are on the button.
    expect(canvas.getByRole("button", { name: /^Swords to Plowshares/ })).toHaveAccessibleName(
      expect.stringContaining(THEORY_MATCH_NAME_LABEL.toLowerCase()),
    );
    // Green's sentence is the *prefix* of blue's, so "in the theory list" cannot tell the two
    // apart — what says this row is the printing the plan named is the absence of the rest.
    expect(canvas.getByRole("button", { name: /^Sol Ring/ })).toHaveAccessibleName(
      expect.not.stringContaining("a different printing"),
    );

    // The control: a card the plan does not ask for wears the third mark and says so. The
    // negatives are what keep it *this* sentence — green's words are the prefix of blue's, and
    // neither of them is "not in the theory list", which carries no count either way.
    const missing = canvas.getByRole("button", { name: /^Dismember/ });
    expect(missing).toHaveAccessibleName(expect.stringContaining("not in the theory list"));
    expect(missing).toHaveAccessibleName(expect.not.stringContaining("in the theory list ·"));
    expect(missing).toHaveAccessibleName(expect.not.stringContaining("to add"));
    expect(missing).toHaveAccessibleName(expect.not.stringContaining("to remove"));
  },
};

/**
 * The same deck with the deck's **exact** switch off — and the point is that nothing goes blank.
 *
 * A row the plan names the exact printing of is re-resolved one tier down rather than silenced:
 * an exact match *is* a name match, so the fact survives the switch and what the switch turns off
 * is the finer statement. Both Bolts and the Sol Ring draw blue here, with blue's own
 * **name-grain** number — the green `+2` about a printing is gone, and the card-grain tick in its
 * place is the honest reading for a reader who has four Bolts and has stopped caring which art.
 *
 * This is the switch for somebody playing proxies on purpose, and it is per **deck**
 * (`DeckSettingsForm`'s two `MarkSwitch` rows) where the colours are per device — the switch is
 * about one deck and the colour is about this screen.
 */
export const ExactMarkOff: Story = {
  args: {
    groups: tierGroups(),
    theoryPlan: tierPlan({ exact: false, name: true, unplanned: true }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // **The same four planned rows are marked**, which is the assertion this story exists for: a
    // switch that silenced them instead would leave three tiles bare and make the wall unreadable
    // rather than less precise. The fifth mark is the X on the row that was never in the plan —
    // the `exact` switch moves which *tier* a planned card is drawn at and nothing else, so it
    // cannot move a row across that line in either direction.
    expect(canvasElement.querySelectorAll(`[${THEORY_MATCH_ATTR}]`)).toHaveLength(5);
    expect(canvasElement.querySelectorAll(`[${THEORY_MATCH_ATTR}="exact"]`)).toHaveLength(0);
    expect(canvasElement.querySelectorAll(`[${THEORY_MATCH_ATTR}="unplanned"]`)).toHaveLength(1);
    expect(
      [...canvasElement.querySelectorAll(`[${THEORY_MATCH_ATTR}="name"]`)]
        .map((mark) => mark.textContent)
        .sort(),
    ).toEqual(["", "", "", "+3"]);

    // The card that was green with a `+2` on it now says blue's sentence with no count at all —
    // the number followed the tier, because the two are one statement. Both halves of the count
    // clause are named, because `theoryMatchLabel` has one phrasing per sign and an assertion
    // that checked only the one this row used to draw would go vacuous the moment it flipped.
    const bolt = canvas.getAllByRole("button", { name: /^Lightning Bolt/ });
    for (const tile of bolt) {
      expect(tile).toHaveAccessibleName(
        expect.stringContaining(THEORY_MATCH_NAME_LABEL.toLowerCase()),
      );
      expect(tile).toHaveAccessibleName(expect.not.stringContaining("to add"));
      expect(tile).toHaveAccessibleName(expect.not.stringContaining("to remove"));
    }

    // And the row that was never in the plan is still not in it: the fallback widens which
    // *tier* a planned card is drawn at, never which cards are planned. It says so in the third
    // tier's own words, and in neither of the other two — green's sentence is the prefix of
    // blue's, and this one carries no count at all.
    const missing = canvas.getByRole("button", { name: /^Dismember/ });
    expect(missing).toHaveAccessibleName(expect.stringContaining("not in the theory list"));
    expect(missing).toHaveAccessibleName(expect.not.stringContaining("in the theory list ·"));
    expect(missing).toHaveAccessibleName(expect.not.stringContaining("to add"));
    expect(missing).toHaveAccessibleName(expect.not.stringContaining("to remove"));
  },
};
