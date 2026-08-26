import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";
import { GAME_CHANGER_LABEL } from "@/components/GameChangerMark";
import { MARKETPLACES } from "@/lib/marketplace";
import {
  deckGroups,
  deckTheoryMatches,
  deckViolations,
} from "../../../../.storybook/fake/fixtures";
import { THEORY_MATCH_ATTR } from "../CardMarks";
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
 * what you want the moment before you cut something. A tile is the search wall's tile — the same
 * `CardArt` frame, the same corner marks — so a reader looking at the docked search column and
 * the deck laid out beside it is looking at one object rather than two.
 */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The Commander and the Sideboard; a category the reader named has no rules role.
    expect(canvas.getAllByText("RULE")).toHaveLength(2);
    expect(canvas.getByText("INACTIVE")).toBeInTheDocument();
    // The two marks, in the two corners they never share.
    expect(canvas.getByText("RULE BREAK")).toBeInTheDocument();
    // **The crown, not `GC`** (changed 2026-08-16). This wall draws whole card faces and has the
    // room for the glyph, so it says the fact the way `CardArt` says it everywhere else — which
    // is what the deck editor's own search column beside it has always drawn. `GameChangerBadge`'s
    // two letters are still the table's and the text columns', where there is no art to lay a
    // chip on. `hidden: true` because the whole overlay is `aria-hidden`; the words are in the
    // button's own label.
    const crowned = canvas.getByRole("button", { name: /^Lightning Bolt/ });
    expect(
      within(crowned).getByRole("img", { name: GAME_CHANGER_LABEL, hidden: true }),
    ).toBeInTheDocument();
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
 * are not.
 *
 * This is the whole point of the mark: a live list is what the reader has actually sleeved up, and
 * the one thing it cannot say about itself is which of its cards are the deck they designed and
 * which are the proxies and stand-ins waiting to be replaced. The tick says it, in the corner
 * opposite the `RULE BREAK` mark — see `CardMarks.tsx` for why those two are never allowed to
 * share one.
 *
 * **Two of the four marks are counts rather than ticks**, which is issue #212 and is why this
 * story is worth looking at rather than merely running: the fixture's plan asks for twice the
 * Island the deck holds and half the Boros Charm, so `-2` and `+1` are drawn in the same box, the
 * same azure and the same corner as the tick the other two wear. The tick is the card that
 * matches; a number is the card that does not.
 *
 * `theoryMatches` is `undefined` in every other story in this file, which is what a deck with the
 * theory list switched off looks like and what the **Theory** tab itself looks like: no plan to
 * compare against, so no marks.
 */
export const TheoryMatches: Story = {
  args: { theoryMatches: deckTheoryMatches() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Four marked cards, and **two of the four are numbers rather than ticks** (issue #212): the
    // fixture asks for twice the Island the deck holds and half the Boros Charm, so this is the
    // one place both of the mark's drawings are seen side by side. The mark is `aria-hidden` and
    // carries no `title` — it is bound `describes: false`, so `THEORY_MATCH_ATTR` is
    // `CardMarks.tsx`'s own handle for finding it after the fact, and a tick's element has no
    // text at all (it is an `<svg>`). The words are read off the button instead.
    const marks = [...canvasElement.querySelectorAll(`[${THEORY_MATCH_ATTR}]`)];
    expect(marks).toHaveLength(4);
    expect(marks.map((mark) => mark.textContent).sort()).toEqual(["", "", "+1", "-2"]);

    // The card carrying both marks: in the plan **and** breaking a rule. The two facts are in
    // one sentence because a button's `aria-label` replaces everything inside it.
    const both = canvas.getByRole("button", { name: /^Island/ });
    expect(both).toHaveAccessibleName(expect.stringContaining("in the theory list"));
    expect(both).toHaveAccessibleName(expect.stringContaining("rule break:"));

    // And a card the plan does not ask for says neither.
    expect(canvas.getByRole("button", { name: /^Dismember/ })).toHaveAccessibleName(
      expect.not.stringContaining("theory"),
    );
  },
};
