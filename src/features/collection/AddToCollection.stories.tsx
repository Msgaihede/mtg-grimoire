import { useCallback, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { CardDetailPane } from "@/features/card/CardDetailPane";
import { parseFinishes } from "@/lib/finish";
import { CARDS } from "../../../.storybook/fake/cards";
import { AddToCollectionButton, type AddTarget } from "./AddToCollection";

/**
 * One fixture printing as the quick-add's target, built exactly as its busiest call site builds
 * one — `CardDetailPane.tsx:832-839`, the printings row: the **row's** id, set code, collector
 * number and finishes, with the card's name and oracle id.
 *
 * Derived rather than hand-written, and that is the difference between two of the stories below
 * being claims and being tautologies. {@link FoilOnlyPrinting}'s whole subject is that the popup
 * offers what the *printing* exists in; a literal `finishes: ["foil"]` would prove only that the
 * component renders the array it was handed. It throws at module load if the corpus is
 * regenerated without the row.
 *
 * Not exported, and duplicated from `CardDetailPane.stories.tsx` on purpose: every non-default
 * export of a CSF file is indexed as a **story**, so a story file cannot own shared helpers.
 */
function target(setCode: string, collectorNumber: string): AddTarget {
  const row = CARDS.find((c) => c.setCode === setCode && c.collectorNumber === collectorNumber);
  if (!row) throw new Error(`No fixture printing for ${setCode} ${collectorNumber}`);
  return {
    cardId: row.id,
    name: row.name,
    setCode: row.setCode,
    collectorNumber: row.collectorNumber,
    oracleId: row.oracleId,
    finishes: parseFinishes(row.finishes),
  };
}

/**
 * The card pane, with a real close — the outer dismissible layer
 * {@link EscapeClosesThePopupNotThePane} presses Escape *inside*.
 *
 * `onClose` genuinely unmounts it. A host that ignored the callback would make "the pane stayed
 * open" true by construction, which is the one thing that story must not be.
 *
 * Alpha Lightning Bolt because it has the corpus's longest printings list — four rows, so the
 * quick-add pressed is one of four identical-looking controls and has to be addressed by the
 * printing in its accessible name.
 */
function PaneWithQuickAdds() {
  const [open, setOpen] = useState(true);
  // Stable, because it is the pane's `onDismiss` and therefore a dependency of the `keydown`
  // listener behind it.
  const close = useCallback(() => setOpen(false), []);
  if (!open) return <p className="text-sm text-dim">The pane closed.</p>;
  return <CardDetailPane cardId={target("lea", "161").cardId} onClose={close} />;
}

const meta = {
  title: "Collection/QuickAdd",
  component: AddToCollectionButton,
  tags: ["autodocs"],
  args: { target: target("2x2", "117") },
  decorators: [
    // Sized for both shapes this file renders: the popup is `w-64` (256px) and anchored — not
    // portalled, because the shipped CSP is `style-src 'self'` and every overlay primitive in
    // reach injects a runtime `<style>` — so it needs an ancestor with room beside and below
    // its trigger. 416px is the card pane's own 384px (`CardDetailPane.tsx:347`) plus a margin,
    // which is what {@link EscapeClosesThePopupNotThePane} puts in the same frame.
    //
    // `justify-end` and `items-start` because that is where this control lives on three of its
    // four surfaces: the right-hand end of a row, at the top of it.
    (Story) => (
      <div className="flex h-[560px] w-[416px] items-start justify-end">
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          'The "+" that records a card, and the popup behind it — **one component for all three ' +
          "surfaces** (printings row, art tile, table row), in its own words " +
          "(`AddToCollection.tsx:48-55`), because the decision is the same one every time: which " +
          "list, which finish, what condition, how many.\n\n" +
          "Invisible until its row or tile is hovered or holds the caret — a wall of art is not " +
          "a wall of plus signs — and **always in the tab order**, because “visible on hover” is " +
          "not a state a keyboard has. That is the *caller's* half: `REVEAL_ON_HOVER` is a class " +
          "the surface passes in (`CardDetailPane.tsx:831`), so every story below draws the " +
          "trigger plainly except {@link EscapeClosesThePopupNotThePane}, which renders the real " +
          "printings rows.\n\n" +
          "**The trigger is named for the card, the printing and the destination** — `Add " +
          "Lightning Bolt (2X2 117) to collection` — never “Add”. Forty of these in a printings " +
          "list are forty different cards, and the destination is whatever the popup was last " +
          "set to: `mode` lives on the trigger and outlives a close (`AddToCollection.tsx:76-78`), " +
          "which is the right answer for a reader working down a list adding wishes.\n\n" +
          "**It offers exactly the finishes the printing exists in and nothing else** " +
          "(`AddToCollection.tsx:294-308`). The backend takes any finish for any card, so this " +
          "row is the guard — and it matters because a finish is what a price is looked up by: " +
          "a nonfoil entry for a foil-only printing prices through a `usd` key its blob does " +
          "not have. {@link FoilOnlyPrinting} is the corpus's one foil-only row.\n\n" +
          "**It is a dismissible layer, and the protocol is a handshake rather than a z-index.** " +
          "It listens on `window` in the **capture** phase and consumes the press " +
          "(`AddToCollection.tsx:188`); the card pane underneath listens in the bubble phase and " +
          "returns early on `defaultPrevented`. Capture is the load-bearing half — two `window` " +
          "listeners for one event run in *registration* order and the pane was mounted first " +
          "(`useDismissOnEscape.ts:12-51`). Escape hands the caret back to the trigger; an " +
          "outside click deliberately does not. {@link EscapeClosesThePopupNotThePane} and " +
          "{@link ClickingAwayClosesIt} are those two, and `App.test.tsx` owns the full-stack " +
          "version over the *set filter* rather than this popup.\n\n" +
          "**One state has no story: the wishlist's “Any printing” refusal.** The control is " +
          "disabled when `target.oracleId` is null (`AddToCollection.tsx:353`) — disabled rather " +
          "than hidden, because a choice that silently disappears is one the reader has no " +
          "reason to believe exists — but that is a fence around a nullable column and not a " +
          "card anyone can find. `AddToCollection.tsx:346-352` records the live figure (0 of " +
          "116,590 rows on 2026-08-05, all 81 reversible printings included, because `card_row` " +
          "falls back to `card_faces[0]`), and the fixture agrees: **0 of its 43 rows** carry " +
          "`oracleId: null`, measured 2026-08-10 over `.storybook/fake/cards.ts`. Storying it " +
          "would need a target invented for the purpose, which would say the state exists. " +
          "{@link WishlistMode} shows the pair enabled.",
      },
    },
  },
} satisfies Meta<typeof AddToCollectionButton>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The control at rest: one 24px square, and an accessible name that is a whole sentence.
 *
 * `aria-haspopup="dialog"` with `aria-expanded="false"` — so a screen reader knows there is
 * something behind it and that it is shut, which is the information a "+" glyph carries for
 * everyone else. The name says the card, the printing **and** where pressing it would put a
 * copy; "Add" alone would be the same word on forty different controls.
 */
export const Closed: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole("button", {
      name: "Add Lightning Bolt (2X2 117) to collection",
    });
    await expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(canvas.queryByRole("dialog")).toBeNull();
  },
};

/**
 * Pressed — and the caret moves **into** the popup.
 *
 * That hand-over is the whole reason this story has a `play`: it is what makes the popup's own
 * controls the next thing Tab reaches, it is what gives focus somewhere to *leave* from (the
 * root's `onBlur` is what closes on an outside click, without a second window listener that
 * could fight the Escape handshake), and it is what Escape has to hand back
 * (`AddToCollection.tsx:178-180`).
 *
 * It is deliberately **not** `aria-modal`: the list behind it stays live, and a dialog that
 * claims the page is inert while it demonstrably is not is worse than no dialog at all.
 *
 * Four answers, all pre-filled with the commonest one: the collection, the printing's first
 * finish, Near mint, one copy. Nothing here is a required field.
 */
export const Open: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole("button", {
      name: "Add Lightning Bolt (2X2 117) to collection",
    });
    await userEvent.click(trigger);

    const popup = canvas.getByRole("dialog", { name: "Add Lightning Bolt" });
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(popup).not.toHaveAttribute("aria-modal");
    await expect(popup).toHaveFocus();

    await expect(within(popup).getByRole("button", { name: "Collection" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(within(popup).getByRole("button", { name: "Nonfoil" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(within(popup).getByLabelText("Condition")).toHaveValue("NM");
    await expect(
      within(popup).getByRole("spinbutton", { name: "Quantity of Lightning Bolt" }),
    ).toHaveValue(1);
  },
};

/**
 * A printing that exists in all three finishes — so all three are offered, and no more.
 *
 * `nonfoil | foil | etched` is an **enum**, never a boolean: etched is a third thing, and
 * flattening it into `foil: true` is the single commonest way an importer loses data. The chips
 * are their own labels and start on the first finish the printing lists, which is the order
 * Scryfall publishes them in.
 *
 * Strixhaven's Japanese Lightning Bolt is the corpus's one three-finish row — measured
 * 2026-08-10 over `.storybook/fake/cards.ts`, which gives it `["nonfoil","foil","etched"]` and a
 * price under each of `usd`, `usd_foil` and `usd_etched`. `Card/DetailPane`'s `AllFinishes`
 * shows the three prices those keys answer.
 */
export const AllThreeFinishes: Story = {
  args: { target: target("sta", "105") },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: "Add Lightning Bolt (STA 105) to collection" }),
    );

    const finishes = canvas.getByRole("group", { name: "Finish" });
    await expect(
      within(finishes)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Nonfoil", "Foil", "Etched"]);
    // The first the printing lists, not a hardcoded default.
    await expect(within(finishes).getByRole("button", { name: "Nonfoil" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  },
};

/**
 * A printing that exists **only in foil** — so nonfoil is not on offer at all.
 *
 * This is the row the guard exists for. A finish is what a price is looked up by (`usd` /
 * `usd_foil` / `usd_etched`, no fallback), so a nonfoil entry recorded against a foil-only
 * printing would price through a key its blob does not have — and it would be a claim about a
 * piece of cardboard that was never printed. The backend takes any finish for any card; this row
 * of chips is the only thing that stops it (`AddToCollection.tsx:294-308`).
 *
 * The corpus's one foil-only row is Sol Ring `sld 913`, and it is the sharp end of the same
 * point: measured 2026-08-10, **all six of its price keys are null** — `usd`, `usd_foil`,
 * `usd_etched`, `eur`, `eur_foil`, `tix` — so even the finish it *does* exist in is unpriced.
 * The popup asks for a finish, not for a price, and records the copy either way.
 *
 * The fallback below the guard is worth knowing about and is not this state: an **empty**
 * `finishes` means "unknown", and nonfoil is offered (`AddToCollection.tsx:167`). No fixture row
 * is empty, so that branch has no story.
 */
export const FoilOnlyPrinting: Story = {
  args: { target: target("sld", "913") },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: "Add Sol Ring (SLD 913) to collection" }),
    );

    const finishes = canvas.getByRole("group", { name: "Finish" });
    await expect(
      within(finishes)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Foil"]);
    // One chip, and it is already the answer — there is nothing else to choose.
    await expect(within(finishes).getByRole("button", { name: "Foil" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  },
};

/**
 * The five grades, spelled out — and the sentence that says what was recorded.
 *
 * A select rather than chips, and the one control in the popup whose name is written beside it:
 * a select shows its value, so it needs a label, while the chip rows are their own. The grades
 * are the NA scale (`conditions.ts:12-22`) in sentence case, which is the app's voice
 * everywhere.
 *
 * The report is **numbered by the add it belongs to** — a live region whose text does not change
 * announces nothing, and two identical copies is the commonest second add there is, so the node
 * is re-keyed rather than rewritten with itself. It names the destination, because the popup has
 * two.
 *
 * The popup stays open behind it with every answer still in it: recording the same card twice is
 * one interaction.
 */
export const Conditions: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: "Add Lightning Bolt (2X2 117) to collection" }),
    );

    const popup = canvas.getByRole("dialog", { name: "Add Lightning Bolt" });
    const condition = within(popup).getByLabelText("Condition");
    await expect(
      within(condition)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Near mint", "Lightly played", "Moderately played", "Heavily played", "Damaged"]);

    await userEvent.selectOptions(condition, "HP");
    await userEvent.click(
      within(popup).getByRole("button", { name: "Increase Quantity of Lightning Bolt" }),
    );
    await userEvent.click(within(popup).getByRole("button", { name: "Add to collection" }));

    await waitFor(async () => {
      await expect(within(popup).getByRole("status")).toHaveTextContent(
        "Added 2 × Lightning Bolt to your collection.",
      );
    });
    // Still open, still holding the answers — and no refusal.
    await expect(condition).toHaveValue("HP");
    await expect(
      within(popup).getByRole("spinbutton", { name: "Quantity of Lightning Bolt" }),
    ).toHaveValue(2);
    await expect(within(popup).queryByRole("alert")).toBeNull();
  },
};

/**
 * The other list — and the **trigger renames itself**, because the destination is half of what
 * pressing it again would do.
 *
 * `mode` lives on the trigger rather than in the popup (`AddToCollection.tsx:76-78`): a control
 * reading "…to collection" over an open wishlist form is wrong about itself, and the choice
 * outlives a close so a reader working down a printings list adding wishes is not asked again on
 * every row.
 *
 * The form changes with it. Condition goes — a wish is for a card you do not have, so there is
 * no card to grade — and **"This printing" / "Any printing"** takes its place, because a
 * shopping list outlives the printing it was made from: an any-printing wish is keyed on the
 * oracle card and carries its own name.
 *
 * Both are enabled here, which is the live state of every card in the database; the component
 * doc above says why the disabled arm has no story.
 */
export const WishlistMode: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: "Add Lightning Bolt (2X2 117) to collection" }),
    );

    const popup = canvas.getByRole("dialog", { name: "Add Lightning Bolt" });
    await userEvent.click(within(popup).getByRole("button", { name: "Wishlist" }));

    // The trigger now says where a press would go.
    await expect(
      canvas.getByRole("button", { name: "Add Lightning Bolt (2X2 117) to wishlist" }),
    ).toBeInTheDocument();
    // No grade to record on a card nobody owns yet.
    await expect(within(popup).queryByLabelText("Condition")).toBeNull();

    const which = within(popup).getByRole("group", { name: "Which printing" });
    await expect(within(which).getByRole("button", { name: "This printing" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(within(which).getByRole("button", { name: "Any printing" })).toBeEnabled();

    await userEvent.click(within(popup).getByRole("button", { name: "Add to wishlist" }));
    await waitFor(async () => {
      await expect(within(popup).getByRole("status")).toHaveTextContent(
        "Added 1 × Lightning Bolt to your wishlist.",
      );
    });
  },
};

/**
 * A write the database refused, **said inside the popup and naming the list it was for**.
 *
 * `db.ts:1467`'s `BUSY` is `collection::BUSY` verbatim, raised at the top of every write handler
 * and by no read handler. The sentence is a `role="alert"` of its own and the success region is
 * cleared beside it (`AddToCollection.tsx:404-413`), so the last success is never read back as
 * though it were this one.
 *
 * **The popup stays open with every answer still in it**, which is the design: trying again is
 * one interaction, and a form that closed on a failure would make the reader re-enter a finish, a
 * grade and a count to find out whether the sync had finished.
 */
export const Busy: Story = {
  parameters: { fake: { fault: "busy" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: "Add Lightning Bolt (2X2 117) to collection" }),
    );

    const popup = canvas.getByRole("dialog", { name: "Add Lightning Bolt" });
    await userEvent.click(
      within(popup).getByRole("button", { name: "Increase Quantity of Lightning Bolt" }),
    );
    await userEvent.click(within(popup).getByRole("button", { name: "Add to collection" }));

    const alert = await within(popup).findByRole("alert");
    await expect(alert).toHaveTextContent(
      "Could not add to your collection — The card database is busy finishing a sync. " +
        "Try that again in a moment.",
    );
    // Nothing claimed to have been added, and the two copies the reader asked for are still
    // asked for.
    await expect(within(popup).getByRole("status")).toBeEmptyDOMElement();
    await expect(
      within(popup).getByRole("spinbutton", { name: "Quantity of Lightning Bolt" }),
    ).toHaveValue(2);
  },
};

/**
 * **One Escape closes the popup and leaves the card behind it open.**
 *
 * The pane and the popup both listen for the key on `window`, so neither can see the other and
 * no z-index can order them. What separates them is the phase: the popup listens in **capture**
 * and consumes the press, the pane listens in the bubble phase and returns early on
 * `defaultPrevented`. Capture is not a detail — two `window` listeners for one event run in
 * *registration* order, and the pane has been mounted since before the popup inside it existed,
 * so in the bubble phase it would act first, read `defaultPrevented` as false, and close the card
 * *and* the popup on one press with two focus hand-backs racing for the caret
 * (`useDismissOnEscape.ts:12-50`).
 *
 * The caret going back to the trigger is the second half and is invisible in a screenshot: an
 * element that unmounts holding focus drops it to `<body>`, and the next Tab restarts from the
 * top of the app. It is handed over from `onDismiss`, *before* React flushes the close, while the
 * popup is still mounted (`AddToCollection.tsx:85-88`).
 *
 * The pane host really unmounts on `onClose`, so "the pane stayed open" is a measurement rather
 * than a property of the story. `App.test.tsx` owns the full-stack version of this over the
 * search view's **set filter**; this one is about the layer the quick-add opens.
 */
export const EscapeClosesThePopupNotThePane: Story = {
  render: () => <PaneWithQuickAdds />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const pane = await canvas.findByRole("complementary", { name: "Card details" });
    // One of four identical-looking controls in the printings list, addressed by the printing
    // its accessible name carries.
    const trigger = await within(pane).findByRole("button", {
      name: "Add Lightning Bolt (2X2 117) to collection",
    });
    await userEvent.click(trigger);
    await expect(within(pane).getByRole("dialog", { name: "Add Lightning Bolt" })).toHaveFocus();

    await userEvent.keyboard("{Escape}");

    await expect(canvas.queryByRole("dialog", { name: "Add Lightning Bolt" })).toBeNull();
    await expect(canvas.getByRole("complementary", { name: "Card details" })).toBeInTheDocument();
    await expect(trigger).toHaveFocus();
    await expect(canvas.queryByText("The pane closed.")).toBeNull();
  },
};

/**
 * Clicking away closes it too — **and deliberately does not hand the caret back**.
 *
 * The asymmetry is the point. Escape is a request to leave a layer, so the reader is put back
 * where they were; a click elsewhere means they are *already* somewhere else, and moving their
 * caret back to the "+" they walked away from would be the interface overruling them.
 *
 * It is done with the root's `onBlur` rather than a window listener, so there is nothing here
 * that could fight the Escape handshake — and the boundary is the whole control rather than the
 * popup, because on `relatedTarget` being the trigger itself (a second click, or Escape's
 * hand-back) closing here would race the toggle and leave the popup open forever
 * (`AddToCollection.tsx:105-110`).
 */
export const ClickingAwayClosesIt: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole("button", {
      name: "Add Lightning Bolt (2X2 117) to collection",
    });
    await userEvent.click(trigger);
    await expect(canvas.getByRole("dialog", { name: "Add Lightning Bolt" })).toHaveFocus();

    // The frame around the control, which is not focusable — so the caret lands nowhere in
    // particular, which is exactly the state this asserts about.
    await userEvent.click(canvasElement);

    await waitFor(async () => {
      await expect(canvas.queryByRole("dialog", { name: "Add Lightning Bolt" })).toBeNull();
    });
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(trigger).not.toHaveFocus();
  },
};
