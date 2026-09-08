import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { TOOLTIP_OPEN_MS, TOOLTIP_PANEL_ID } from "@/components/tooltip/TooltipProvider";
import { DEFAULT_SECTION_ZOOMS } from "@/lib/cardZoom";
import { ipc } from "@/lib/ipc";
import { useAppStore } from "@/lib/store";
import { DecksPage } from "./DecksPage";

/**
 * `.storybook/fake/seeds.ts:462`'s `ORPHAN_DECK_CARD_ID`, spelled out because the seed keeps its
 * three orphan ids module-private.
 *
 * It is deliberately outside the fixture — an orphan is a row whose printing left the database,
 * and the only way to be one is to name an id `cards` has no row for. `world.test.ts` asserts all
 * three are absent, so a future corpus refresh that happened to mint this id fails a test rather
 * than quietly healing the seed under this story.
 */
const ORPHAN_CARD_ID = "0c62f9b1-4a7d-4e83-8f15-2b90d4c6e737";

/**
 * The gallery, with deck 1's cover pointed at a printing the card database does not hold.
 *
 * **Staged through the command rather than through the UI, because there is no UI path to it** —
 * and that is a fact about the app rather than a shortcut. The settings dialog's art picker is
 * the only control that writes one, and `coverChoices` (`DeckSettingsDialog.tsx`) drops every
 * row whose `needsReview` is non-null, so a cover only
 * *becomes* orphaned later, when a sync takes its printing away. `deck_update` validates no cover
 * (`db.ts:2019` is a bare `coalesce`, matching `deck::update_deck`), and `coverArtist` is a
 * lookup on the way out (`db.ts:855`, mirroring the real `LEFT JOIN cards c ON c.id =
 * d.cover_card_id` at `deck.rs:235`) — so a stale id answers a null artist exactly as it does in
 * the shipped app.
 *
 * `useQuery` rather than an effect with a `setState`, and the gallery is held back until it has
 * landed: `DeckEditor.stories.tsx`'s `EmptyDeck` stages the same way, for the same reasons — it
 * runs once, it is cached in the story's own client, and `staleTime: Infinity` keeps a window
 * refocus in the Storybook browser from writing again.
 */
function OrphanedCover() {
  const staged = useQuery({
    queryKey: ["story", "orphan-cover"],
    queryFn: () => ipc.deckUpdate(1, { coverCardId: ORPHAN_CARD_ID }),
    staleTime: Infinity,
  });
  return staged.isSuccess ? <DecksPage /> : null;
}

const meta = {
  title: "Decks/Gallery",
  component: DecksPage,
  tags: ["autodocs"],
  decorators: [
    // The page is `h-full`, so it needs a parent with a height or the wall has none. 1032px is
    // exactly the content column at the 1280×800 window `tauri.conf.json:16-17` opens: 1280 less
    // the sidebar's `w-52` (208px) and less `main`'s `p-5` on both sides (40px), from
    // `AppShell.tsx:92` and `AppShell.tsx:144`. The height is chosen rather than derived — the
    // ribbon above it is not a fixed number of pixels.
    (Story) => (
      <div className="h-[640px] w-[1032px]">
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "The decks, filed. The folder tree on the left, and on the right the one drawer the " +
          "reader is standing in — its sub-folders as dashed cards, then its decks as the art " +
          "they were built around. No colour anywhere that is not a card's own: a deck is " +
          "picked by looking at it.\n\n" +
          "**The folder half is real here now.** The fake answers all five `deck_folder_*` " +
          "commands and `deck_set_folder`, and `seeds.ts` carries two root folders and a child " +
          "— so the tree, the folder cards and the counts are all driven rather than described. " +
          "{@link Folders} is the story about the shape; {@link FoldersUnavailable} is the one " +
          "about a refused read, which now needs the `deckMeta` fault rather than a missing " +
          "handler.\n\n" +
          "**A failed read is a `status`; a refused write is an `alert`.** The wall's " +
          "“Reading your decks…” line and the tree's refusal are the first kind, the " +
          "“Could not change your decks” banner the second — which is what keeps " +
          "{@link Busy}'s assertion unambiguous.\n\n" +
          "Driven end to end by `.storybook/fake/`. **Four seeded decks, and the wall shows " +
          'three** — measured 2026-08-11 over `readHandlers(seed("starter")).deck_list()`, ' +
          "which answers them in this order: `Modern Goodstuff` (Modern, 60 cards, cover art " +
          "by Simon Dominic), `Rhystic Testbed` (Commander, 5, no cover art), `Kenrith " +
          "Two-Drops` (Commander, 100, Kieran Yanner) and `Old School 93/94` (Old School, 22, " +
          "Christopher Rush), the last one **archived**. `deck::list_decks` sorts archived " +
          "last, then most recently touched first, so that order is the wall's. The Testbed is " +
          "filed under `Constructed › Commander`, so the wall the reader opens on is the other " +
          "three: **a wall is the drawer you are standing in**, not an inventory.\n\n" +
          "**A tile's count is not the deck's row count.** `cardCount` is summed over " +
          "`SIZE_KINDS` — `main`, `commander` **and `maybe`**, in categories that are switched " +
          "on (`.storybook/fake/db.ts:1137`, mirroring `DeckRow.cardCount` and " +
          "`validation/engine.ts:75`) — so the Modern deck's 15 " +
          "sideboard cards are in the editor and not in the " +
          "caption, while the 2 in its Maybeboard are left out **only because that pile is " +
          "switched off**. That is the branch's governing ruling and it is easy to misread: an " +
          "*active* category of kind `maybe` counts toward size exactly like `main`. The " +
          "switch is the whole of “counts toward nothing”. The number under a tile is the number " +
          "the format's size rule is about, which is the same definition the editor's " +
          "headline figure and the validation chip share.\n\n" +
          "**Archiving is the reversible thing and deleting is not.** The trash control asks " +
          "first, names what would go with the deck, and offers archiving in the same breath " +
          "({@link DeleteAsksFirst}); the archive control is a toggle whose other face is " +
          "Restore ({@link Archived}). `deck_delete` really deletes, by cascade.\n\n" +
          "**The wall is narrowed and ordered from a row of its own under the heading** " +
          "(2026-09-07) — a name box, a chip per format on the wall, the `Archived` disclosure " +
          "and a `Sort decks` pair. {@link Ordered} and {@link Narrowed} are those two halves. " +
          "The **sort** is remembered in `app_meta` across restarts and the **filter** " +
          "deliberately is not: a gallery that opened already narrowed, with no memory of having " +
          "asked for it, looks like a gallery that has lost decks. Nothing in the row touches " +
          "the tree, the folder cards or the sidebar's counts — a filter narrows the wall you " +
          "are looking at, and a tree that lost its branches would take away the way out.\n\n" +
          "**The illustrator is on the picture rather than under the tile**, also 2026-09-07. " +
          "Scryfall's guideline (on `docs/api`, *not* `docs/api/images`, which carries no artist " +
          "rule at all any more) asks that the artist be identifiable in the same interface as " +
          "an `art` crop — which is satisfied by the name being reachable, not by a permanent " +
          "line, so it moved onto the crop as a tooltip and the tile lost a row of chrome. " +
          "`DeckCoverPicker`'s `CoverPreview` keeps its visible credit: one large crop with " +
          "nothing else on screen is a different question.\n\n" +
          "**A cover with no artist is not drawn, and it has no UI path** — which is why " +
          "{@link NoCoverArtist} stages it through `deck_update` instead. The rule runs the " +
          "other way round from the credit and is unchanged by the move: if the illustrator " +
          "cannot be named, the crop cannot be shown. Reaching that needs a deck whose " +
          "`coverCardId` names a printing `cards` does not hold. Measured 2026-08-10: **0 of " +
          "the 43** rows of `.storybook/fake/cards.ts` has a null `artist`, no seed points a " +
          "cover at a missing id, and the one control that *sets* a cover offers no orphaned " +
          "row (`coverChoices` in `DeckSettingsDialog.tsx` drops every card whose " +
          "`needsReview` is non-null). " +
          "So a cover is never orphaned at the moment it is chosen; it becomes orphaned when a " +
          "sync takes its printing away, and it heals on the next one that brings it back. " +
          "A deck with **no cover at all** is the other, separate state, and it is every new " +
          "deck — {@link NewDeck} is that one.",
      },
    },
  },
} satisfies Meta<typeof DecksPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Two decks on the wall and a third filed away.
 *
 * The live decks are a **list**, not a group — `ul aria-label="Your decks"` — and that is the one
 * place this wall parts from the search's (`CardGrid`'s `role="group"`): these tiles are
 * countable, and a list says how many there are on the way in.
 *
 * The archived deck is not drawn. It is behind a disclosure carrying its count, because filed
 * decks are *kept*, not shown — {@link Archived} opens it.
 */
export const Gallery: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const wall = await canvas.findByRole("list", { name: "Your decks" });
    await expect(within(wall).getByText("Modern Goodstuff")).toBeInTheDocument();
    await expect(within(wall).getByText("Kenrith Two-Drops")).toBeInTheDocument();
    // The caption is the format's *display name* off the seeded `format_specs` row, then the
    // count — 60 for a deck holding 77 cards over 20 rows, because a sideboard and a scratchpad
    // are not what "a 60-card deck" means. (The row count said 18 from 2026-08-11 until it was
    // re-counted on 2026-09-08; it was already wrong before then, which is what a figure nothing
    // asserts costs. The 77 and the 60 are unchanged and are the ones this play pins.)
    await expect(within(wall).getByText(/Modern ·/)).toHaveTextContent("Modern · 60 cards");

    // **Scryfall's image policy, per tile — and since 2026-09-07 it is on the picture rather
    // than under it.** An `art` crop has no printed frame, so the illustrator has to be
    // identifiable in the same interface; the guideline is satisfied by the name being *reachable*
    // rather than by a permanent line, so it moved onto the crop it belongs to and the tile lost
    // a row of chrome. Both halves are the claim: no line anywhere on the wall, and the name a
    // hover away on the picture.
    await expect(canvas.queryByText(/^Art by/)).toBeNull();
    const cover = within(wall).getByText("Modern Goodstuff").closest("li")!.querySelector("img")!;
    await userEvent.hover(cover);
    // The real delay, waited out — `TOOLTIP_OPEN_MS` is a schedule rather than a transition, so
    // `MotionConfig` does not turn it down and there is nothing to flush. `CardArt.stories.tsx`
    // drives its chip's tooltip the same way.
    await new Promise((resolve) => setTimeout(resolve, TOOLTIP_OPEN_MS + 50));
    await expect(canvasElement.ownerDocument.getElementById(TOOLTIP_PANEL_ID)).toHaveTextContent(
      "Art by Simon Dominic",
    );

    // The row under the heading, which is where a reader narrows and orders this wall. Named so
    // that neither control can be confused with the deck editor's own `Filter this deck` and
    // `Sort` — see `DecksPage.tsx`'s comments at both sites.
    await expect(canvas.getByLabelText("Filter decks by name")).toHaveValue("");
    await expect(canvas.getByRole("button", { name: "Sort decks" })).toHaveTextContent(
      "Last updated",
    );

    // Filed away, and therefore not on the wall at all — the disclosure is shut and its rows are
    // not merely hidden, they are unmounted.
    await expect(within(wall).queryByText("Old School 93/94")).toBeNull();
    await expect(canvas.getByRole("button", { name: "Archived 1" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    // The credit line is the whole page's, not a tile's, and it is unconditional: the credit
    // belongs to the interface that shows card images, whether or not a deck has picked one.
    await expect(
      canvas.getByText("Card images © Wizards of the Coast · Data © Scryfall"),
    ).toBeInTheDocument();
  },
};

/**
 * The filed decks, and the control that files one.
 *
 * **Archived sorts last and is never deleted.** The same icon control is Archive on a live deck
 * and Restore on a filed one, named for what pressing it would do, so the deck the reader put
 * away is one press from coming back. `Old School 93/94` is the seeded archived deck and it is
 * under the 60-card minimum on purpose (`seeds.ts:377-380`) — a deck somebody stopped working
 * on is the cheapest place to keep that branch reachable.
 *
 * Its caption reads 22 cards, and pressing Archive on a live deck moves it here in front of the
 * reader rather than making it vanish: the disclosure stays open around the arrival.
 *
 * **The trigger moved into the filter row on 2026-09-07 and is still the same disclosure.** It is
 * a chip among the format chips now — carrying `aria-expanded` rather than `aria-pressed`,
 * because "the wall below is open" and "this filter is on" are two different sentences — and the
 * wall it reveals did not move at all.
 */
export const Archived: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const chip = await canvas.findByRole("button", { name: "Archived 1" });
    await expect(chip).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(chip);
    await expect(chip).toHaveAttribute("aria-expanded", "true");

    const filed = canvas.getByRole("list", { name: "Archived decks" });
    await expect(within(filed).getByText("Old School 93/94")).toBeInTheDocument();
    await expect(within(filed).getByText(/Old School ·/)).toHaveTextContent(
      "Old School · 22 cards",
    );
    // Restore, not Archive: one control, named for the deck it is on and for what it would do.
    await expect(
      within(filed).getByRole("button", { name: "Restore Old School 93/94" }),
    ).toBeInTheDocument();

    // Filing a live deck. The write goes through `deck_update`'s `archived` flag — the same
    // command a rename uses — so nothing is destroyed and the tile simply moves.
    await userEvent.click(canvas.getByRole("button", { name: "Archive Modern Goodstuff" }));

    await waitFor(async () => {
      await expect(canvas.getByRole("button", { name: "Archived 2" })).toBeInTheDocument();
    });
    await expect(
      within(canvas.getByRole("list", { name: "Archived decks" })).getByText("Modern Goodstuff"),
    ).toBeInTheDocument();
    await expect(
      within(canvas.getByRole("list", { name: "Your decks" })).queryByText("Modern Goodstuff"),
    ).toBeNull();
    // Archiving is not a refusal and says nothing: the tile moving is the whole report. Still
    // the *only* alert question worth asking with the tree reporting a refused folder list
    // beside it, because that one is a failed **read** and is a `status` — see the note above.
    await expect(canvas.queryByRole("alert")).toBeNull();
  },
};

/**
 * The order the wall is in, and the two controls that decide it.
 *
 * **`Sort decks`, never a bare `Sort`.** The deck editor's toolbar already owns a `Sort` — that
 * one orders the cards *in* a deck, this one orders the decks — and two controls with one name
 * cannot be addressed unambiguously by a screen reader, by voice, or by a `getByRole` that starts
 * throwing "found multiple". `FilterBar`'s `Sort results` made the same call for the same reason.
 *
 * **The rows are alphabetical by the words on them** (`src/lib/options.ts`): Bracket, Cards,
 * Colors, Format, Last updated, Name. `DECK_SORT_OPTIONS` is written in an order that explains
 * the sorts instead, and this is where the display decision is made.
 *
 * **The direction is one arrow turned over, never a second glyph swapped in.** A different element
 * in the same slot unmounts and remounts, so the indicator teleports — and the whole of what the
 * press means is that the order reversed. Picking a *key* also sets the direction, to whatever
 * that key reads naturally (`NATURAL_DESC`): dates and counts from the top, names and formats and
 * colours and brackets forwards. So `Name` opens at A, and this story presses the arrow to get to
 * Z rather than finding itself there.
 *
 * The order is remembered in `app_meta` across restarts — the filter beside it deliberately is
 * not — which is one round trip through the fake's `set_deck_sort` and nothing this story can see
 * without a reload.
 */
export const Ordered: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const wall = await canvas.findByRole("list", { name: "Your decks" });
    /** The wall as drawn, tile by tile. Read off `data-deck-id` because a tile's *accessible*
     *  name now begins with its colour bar's label. */
    const order = () =>
      [...wall.querySelectorAll("[data-deck-id]")].map((el) => el.textContent ?? "");

    // The default is `updated:desc`, which is the order `deck_list` already answers in — so a
    // gallery nobody has pressed anything on is the gallery a reader already knows.
    await expect(order()[0]).toContain("Modern Goodstuff");

    await userEvent.click(canvas.getByRole("button", { name: "Sort decks" }));
    await userEvent.click(canvas.getByRole("option", { name: "Name" }));

    await waitFor(async () => {
      await expect(order()[0]).toContain("Kenrith Two-Drops");
    });

    await userEvent.click(
      canvas.getByRole("button", { name: "Sort direction: ascending — press for descending" }),
    );

    await waitFor(async () => {
      await expect(order()[0]).toContain("Modern Goodstuff");
    });
    // The button names the press rather than the state alone, so its name is the other half of
    // what the turned arrow says.
    await expect(
      canvas.getByRole("button", { name: "Sort direction: descending — press for ascending" }),
    ).toBeInTheDocument();
  },
};

/**
 * The wall, narrowed — by a name, and by a format.
 *
 * **The tree, the folder cards and the sidebar's counts are not narrowed with it**, and that is
 * the rule rather than an omission: a filter narrows the wall you are looking at, and a tree that
 * lost its branches would take away the way out of it. The heading says both numbers — `1 of 2
 * decks` — so the whole is what reassures a reader that the other deck is still there and the
 * share is what says the wall is short because they asked.
 *
 * **An empty selection of format chips is every deck, not none.** That is the one thing about a
 * chip row that has to be got right; the bug shape is an `includes` with no empty check in front
 * of it, which empties the wall the moment the row appears and reads as the gallery having lost
 * every deck at once.
 *
 * **A wall emptied by a filter says so.** The page has three other empty states and every one of
 * them is a sentence about a *drawer* — told one of those, a reader would go looking for decks
 * that are exactly where they left them.
 */
export const Narrowed: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const wall = await canvas.findByRole("list", { name: "Your decks" });
    const box = canvas.getByLabelText("Filter decks by name");

    await userEvent.type(box, "kenrith");

    await waitFor(async () => {
      await expect(within(wall).queryByText("Modern Goodstuff")).toBeNull();
    });
    await expect(within(wall).getByText("Kenrith Two-Drops")).toBeInTheDocument();
    await expect(canvas.getByText(/1 of 2 decks/)).toBeInTheDocument();
    // The way out is untouched: every drawer is still on the wall and the tree still counts
    // every deck the reader has.
    await expect(
      within(wall).getByRole("button", { name: "Constructed folder, 1 deck" }),
    ).toBeVisible();
    await expect(
      within(canvas.getByRole("navigation", { name: "Folders" })).getByRole("button", {
        name: "All decks, 3 decks",
      }),
    ).toBeVisible();

    // Nothing matches, and the wall says which of the four empty states it is in.
    await userEvent.clear(box);
    await userEvent.type(box, "zzz");
    await expect(await canvas.findByText("No decks match this filter")).toBeInTheDocument();

    // The other control, and the same wall. The chip is named for the format and for how many
    // decks it holds, which is what tells a reader whether pressing it is worth doing.
    await userEvent.clear(box);
    await userEvent.click(canvas.getByRole("button", { name: "Commander format, 1 deck" }));

    await waitFor(async () => {
      await expect(within(wall).queryByText("Modern Goodstuff")).toBeNull();
    });
    await expect(within(wall).getByText("Kenrith Two-Drops")).toBeInTheDocument();

    await userEvent.click(canvas.getByRole("button", { name: "Commander format, 1 deck" }));

    await waitFor(async () => {
      await expect(within(wall).getByText("Modern Goodstuff")).toBeInTheDocument();
    });
  },
};

/**
 * The one question this view asks before doing something it cannot undo.
 *
 * `deck_delete` really deletes the deck and every row in it, by cascade — and a deck is minutes
 * of work, so the destructive control asks once, in words, naming what would go with it and
 * offering the reversible thing instead. The count in the question is the tile's own, from one
 * derivation of the plural, so the caption and the question can never disagree about whether it
 * is "card" or "cards".
 *
 * **The destination is asserted, not just the loss.** A card is in a deck because its collection
 * row sits in that deck's group, so the copies are refiled into `Recently removed` rather than
 * destroyed — and the sentence says so unconditionally, with no checkbox, because where they
 * land is a fact about the write and not a choice.
 *
 * The panel is anchored to the tile rather than portalled — the shipped CSP is `style-src 'self'`
 * and every overlay primitive in reach injects a runtime `<style>` the moment it opens — and it
 * is deliberately not `aria-modal`: the gallery behind it stays live.
 *
 * Cancel is a control *in* the layer, so it hands the caret back to the trash icon that asked.
 * That hand-back is invisible in a screenshot and is the reason this story has a `play`.
 */
export const DeleteAsksFirst: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const trash = await canvas.findByRole("button", { name: "Delete Modern Goodstuff" });
    await userEvent.click(trash);

    const dialog = canvas.getByRole("dialog", { name: "Delete Modern Goodstuff" });
    await expect(dialog).not.toHaveAttribute("aria-modal");
    await expect(dialog).toHaveTextContent("Delete “Modern Goodstuff”?");
    await expect(dialog).toHaveTextContent(
      "Its 60 cards move to Recently removed. Archiving keeps the deck instead.",
    );
    // Neither button is focused: the reader has not decided yet, and a stray Enter should not
    // decide for them. The panel itself holds the caret so Escape has something to hand back.
    await expect(dialog).toHaveFocus();

    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await expect(canvas.queryByRole("dialog", { name: "Delete Modern Goodstuff" })).toBeNull();
    await expect(trash).toHaveFocus();
    // Nothing was deleted, and the wall still holds all three decks' worth of tiles and rows.
    await expect(canvas.getByText("Modern Goodstuff")).toBeInTheDocument();
  },
};

/**
 * A cover whose printing has left the card database — **so no illustrator is named, and the art
 * is not drawn either.**
 *
 * Scryfall's image policy is the whole of it: an `art` crop carries no printed frame, so the
 * illustrator must be credited wherever one is *shown* — which means a cover this app cannot name
 * an artist for cannot be shown at all. Not a picture with the credit line quietly missing; no
 * picture. `DeckRow.coverArtist`'s doc is where that ruling lives, and `CoverPreview` has always
 * behaved this way.
 *
 * **So an orphaned cover and an absent one are one state, on purpose**, and they get the same
 * word: "No cover". That is a deliberate loss of a distinction rather than an oversight — the two
 * differ only in *why* there is nothing to draw, and neither is something the reader can act on
 * differently. {@link NewDeck} is the same frame reached the other way.
 *
 * **It heals on the next sync that brings the printing back** — `coverArtist` is a lookup at read
 * time (the `LEFT JOIN cards c ON c.id = d.cover_card_id` in `deck.rs`'s `DECK_SELECT`), not a
 * stored column, so nothing has to notice.
 *
 * Told **per tile**, which is the claim: Kenrith Two-Drops keeps its art and its credit in the
 * same wall on the same render. The `needsReview` seed because that is where the orphan id lives,
 * and it is the honest world for this state: the sync that took the printing away is the same
 * sync that flagged the deck row naming it.
 */
export const NoCoverArtist: Story = {
  parameters: { fake: { seed: "needsReview" } },
  render: () => <OrphanedCover />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const wall = await canvas.findByRole("list", { name: "Your decks" });

    // **Addressed by the name in the tile, not by the button's accessible name.** A tile with
    // pips draws `DeckColorBar` *inside* its button, and the bar is a `role="img"` whose label is
    // the deck's colours — so the computed name is `White, Red Modern Goodstuff …` and a `^`
    // anchor on the deck's name matches nothing. That is the tile's own decision and the right
    // one; it simply means a wall of real decks is walked by its text.
    const orphaned = within(wall).getByText("Modern Goodstuff").closest("li");
    await expect(orphaned).not.toBeNull();
    const tile = within(orphaned as HTMLElement);
    // No credit line — there is none on any tile since 2026-09-07 — and no credit *anywhere* for
    // this one, because there is no picture to hang one on. The two are one condition on one
    // field, which is the whole point of the case below it.
    await expect(tile.queryByText(/^Art by/)).toBeNull();
    // **And the art is not drawn either, so the frame says "No cover".** An orphaned cover and
    // an absent one are deliberately one state: an `art` crop carries no printed frame, so the
    // illustrator must be credited wherever one is shown — and a cover this app cannot name an
    // artist for therefore cannot be shown at all. `DeckRow.coverArtist`'s own doc is the
    // ruling ("a cover with no artist is **not drawn**"); this tile is what it looks like.
    await expect(tile.getByText("No cover")).toBeInTheDocument();

    // The neighbour, unaffected, on the same render: the rule is a fact about one cover. Its crop
    // is drawn and its painter is on it — which is the assertion that would go red if the policy
    // had been "fixed" by hiding every picture rather than by moving the credit.
    const kept = within(wall).getByText("Kenrith Two-Drops").closest("li") as HTMLElement;
    const art = kept.querySelector("img");
    await expect(art).not.toBeNull();
    await userEvent.hover(art!);
    await new Promise((resolve) => setTimeout(resolve, TOOLTIP_OPEN_MS + 50));
    await expect(canvasElement.ownerDocument.getElementById(TOOLTIP_PANEL_ID)).toHaveTextContent(
      "Art by Kieran Yanner",
    );
    // And still no line of text on either tile: the whole row of chrome is gone from the wall.
    // **Scoped to the wall, not to the canvas**, because the hover above left a tooltip open and
    // that panel's own text begins `Art by` — a canvas-wide query here asserts the credit is
    // nowhere while the credit is on screen two lines up, which is the assertion contradicting
    // the one before it.
    await expect(within(wall).queryByText(/^Art by/)).toBeNull();
  },
};

/**
 * The tree, filed and standing at the root.
 *
 * Two roots and a child, and a deck in one of them: `Constructed › Commander` holds the fourth
 * seeded deck, `Ideas` holds nothing at all. The empty one is not an oversight — a folder starts
 * empty, and a tree that only ever drew folders with decks in them would never show the state a
 * reader meets the moment they make one.
 *
 * **The wall is the drawer the reader is standing in, not everything they own.** Standing at the
 * root, `Rhystic Testbed` is not on it — it is inside `Constructed`, which is on it as a dashed
 * card with its member count. The count in the tree's own root row is the other number, and the
 * two disagreeing is the whole point of having both.
 */
export const Folders: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const tree = await canvas.findByRole("navigation", { name: "Folders" });

    // Every deck the reader has, counted once, whichever drawer it is in.
    await expect(within(tree).getByRole("button", { name: "All decks, 3 decks" })).toBeVisible();
    await expect(within(tree).getByRole("button", { name: /^Constructed/ })).toBeVisible();
    await expect(within(tree).getByRole("button", { name: /^Ideas/ })).toBeVisible();

    const wall = await canvas.findByRole("list", { name: "Your decks" });
    // The two unfiled decks, and the folder standing in for the filed one.
    await expect(within(wall).getByText("Modern Goodstuff")).toBeInTheDocument();
    await expect(within(wall).getByText("Kenrith Two-Drops")).toBeInTheDocument();
    await expect(within(wall).queryByText("Rhystic Testbed")).toBeNull();
    await expect(
      within(wall).getByRole("button", { name: "Constructed folder, 1 deck" }),
    ).toBeVisible();
    // An empty folder says so rather than drawing a blank strip.
    await expect(within(wall).getByText("Empty")).toBeInTheDocument();
  },
};

/**
 * **A deck made in the drawer the reader is standing in**
 * ([#332](https://github.com/Msgaihede/mtg-grimoire/issues/332)).
 *
 * `Ideas` is the seed's empty root folder, which is the whole point of opening this one: a reader
 * standing in an empty drawer, pressing the control drawn under that drawer's own name, over a
 * wall showing that drawer's decks. Until 2026-09-01 the deck was made at the **top level** and
 * the reader had to move it afterwards — the button promising nothing about where, on the
 * argument that only the folder row's "New deck here" promised anything. That is true about the
 * words and wrong about the act.
 *
 * **A default, not a destination**, which is why the Folder select is asserted rather than
 * assumed away: it opens on `Ideas` and still offers every other drawer, so a reader browsing
 * one folder and building for another is one press from saying so. {@link NewDeck} is the same
 * dialog opened at the root, where the drawer *is* the top level.
 */
export const NewDeckInFolder: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const tree = await canvas.findByRole("navigation", { name: "Folders" });
    await userEvent.click(within(tree).getByRole("button", { name: /^Ideas/ }));
    await expect(canvas.getByRole("heading", { name: "Ideas" })).toBeInTheDocument();
    // An empty drawer says so, which is the state this story is standing in.
    await expect(canvas.getByText(/^Nothing is filed in Ideas yet/)).toBeInTheDocument();

    await userEvent.click(canvas.getByRole("button", { name: "New deck" }));
    const form = canvas.getByRole("dialog", { name: "New deck" });
    // `waitFor` for {@link NewDeck}'s reason — the folder list is a read, so the select cannot
    // name a drawer before it lands, and `toHaveTextContent` does not retry on its own.
    await waitFor(async () => {
      await expect(within(form).getByRole("button", { name: "Folder" })).toHaveTextContent(
        "Ideas",
      );
    });

    await userEvent.type(within(form).getByLabelText("Name"), "Sunday Cube");
    await userEvent.click(within(form).getByRole("button", { name: "Create deck" }));

    // The other end of the default, and the half a select cannot show: the deck the write
    // answered with is filed **here**, so it is on the wall the reader was already looking at
    // rather than at the root behind them — and the drawer has stopped saying it is empty.
    await waitFor(async () => {
      await expect(canvas.getByText("Sunday Cube")).toBeInTheDocument();
    });
    await expect(canvas.queryByText(/^Nothing is filed in Ideas yet/)).toBeNull();
  },
};

/**
 * The folder list refused — **and every deck still on the wall.**
 *
 * The state worth pinning: a deck whose `folderId` names a folder this screen does not have is
 * drawn at the **top level**, the same rule the tree uses for a folder whose parent is missing.
 * Towards the root, never towards nothing — hiding a tile because its drawer did not load is the
 * one failure a filing cabinet must not have, and there is nowhere else the tile could be shown.
 * So the filed deck surfaces here, beside the two that were never filed.
 *
 * The tree says what went wrong in its own corner and the wall goes on working. Both halves are
 * the claim: the sentence, and the three live decks still countable beside it.
 */
export const FoldersUnavailable: Story = {
  parameters: { fake: { fault: "deckMeta" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const tree = canvas.getByRole("navigation", { name: "Folders" });
    // **`waitFor`, because the line grows into place.** It is wrapped in an `AnimatePresence`
    // so it does not shove the whole tree down by its own height the moment a read is refused,
    // which means its first painted frame is at `height: 0, opacity: 0` — and `toBeVisible`
    // walks the ancestors. That frame is no longer observable under the suite (`src/test-setup.ts`
    // runs motion's batch inline as of 2026-08-20), so this no longer *needs* the retry; it is
    // kept because the claim it makes is the stronger one either way — a line that never arrived
    // still times out here.
    await waitFor(async () =>
      expect(await within(tree).findByText(/^Could not read your folders/)).toBeVisible(),
    );

    // Every live deck, at the top level, exactly as it would be with no folders at all —
    // including the one that *is* filed, whose drawer this screen cannot see.
    const wall = await canvas.findByRole("list", { name: "Your decks" });
    await expect(within(wall).getByText("Modern Goodstuff")).toBeInTheDocument();
    await expect(within(wall).getByText("Kenrith Two-Drops")).toBeInTheDocument();
    await expect(within(wall).getByText("Rhystic Testbed")).toBeInTheDocument();
    await expect(within(tree).getByRole("button", { name: "All decks, 3 decks" })).toBeVisible();
    // The wall's own refusal line is a different one and is not up: nothing was written.
    await expect(canvas.queryByText(/Could not change your decks/)).toBeNull();
  },
};

/**
 * A gallery before there is a deck.
 *
 * **"No decks", and nothing else.** A placeholder's whole job is to say that the list is empty
 * and that nothing has gone wrong; the control that fixes it is in the heading row above, where
 * it is on every other visit, so the words here are not the affordance. It used to be a
 * paragraph explaining what a deck is and what the app would do with one — an explanation
 * carried by the one screen least able to act on it, and read by every reader exactly once.
 * This gallery's story is its covers, and a gallery with no covers has no story to tell.
 *
 * `seed: "empty"` is the seed with no decks; it also has no cards, which is why this is the
 * honest first-run gallery rather than a filtered one.
 */
export const Empty: Story = {
  parameters: { fake: { seed: "empty" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("No decks")).toBeInTheDocument();
    await expect(canvas.queryByRole("list", { name: "Your decks" })).toBeNull();
    await expect(canvas.getByRole("button", { name: "New deck" })).toBeEnabled();
  },
};

/**
 * Making one — and the tile a deck has before it has chosen a face.
 *
 * Two questions and no more: what it is called, and what it is for. The format list is the
 * seeded `format_specs` table filtered to `enabled_in_picker` and then sorted **alphabetically
 * by display name** — the picker's own order, not the `sort_order` the fake answers in, because
 * a reader looking for Modern looks under M. The fake serves the table from
 * `validation/fixtures.ts`'s `SPECS` — **12 rows**, measured 2026-08-10 over
 * `format_specs_list()`, against the 25 the real migration seeds — so this select reads Brawl,
 * Casual, Commander, Duel Commander, Gladiator, Limited, Modern, Oathbreaker, Old School,
 * Pauper Commander, Tiny Leaders: Reborn, Vintage, and the shipped app's is twice as long.
 *
 * **The select starts on Commander**, and it is the gallery that decides so: `useNewDeckFormat`
 * is mounted here, not in the dialog, and answers the format the reader last *created* a deck in
 * — `FIRST_DECK_FORMAT` where they have created none, which is this world. A seeded deck is not
 * a created one, so `lastDeckFormat` is `null` however many tiles are on the wall. `casual` is
 * still `decks.format_key`'s DDL default and still what a deck given no format is; it is simply
 * not what a dialog *asking* the question should open on.
 *
 * The new tile says **"No cover"** rather than showing a grey rectangle, and it draws no credit
 * line — the two are different facts, and `Cover` tells them apart in as many words: "No cover"
 * is a deck that has not picked one, "No image" is art that did not arrive. This is as close as
 * any story gets to the plan's `NoCoverArtist`; the component-level note above says why the
 * other half is unreachable.
 */
export const NewDeck: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "New deck" }));

    const form = canvas.getByRole("dialog", { name: "New deck" });
    // The caret starts in the field the reader has to fill.
    const name = within(form).getByLabelText("Name");
    await expect(name).toHaveFocus();
    // `waitFor`, because this value now depends on **two** reads having landed —
    // `format_specs_list` for the picker and `deck_last_format` for the memory — and
    // `toHaveTextContent` does not retry on its own. The old `casual` claim was true either way,
    // so it could be asserted flat; this one is only true once both have answered, and under a
    // loaded suite that is not guaranteed to be the microtask after the click. The same claim in
    // `DecksPage.test.tsx` is wrapped for the same reason.
    await waitFor(async () => {
      await expect(within(form).getByRole("button", { name: "Format" })).toHaveTextContent(
        "Commander",
      );
    });

    await userEvent.type(name, "Sunday Cube");
    await userEvent.click(within(form).getByRole("button", { name: "Create deck" }));

    await waitFor(async () => {
      await expect(canvas.getByText("Sunday Cube")).toBeInTheDocument();
    });
    // A deck with no cover and nothing in it, said in both places rather than left blank.
    await expect(canvas.getByText("No cover")).toBeInTheDocument();
    // Made in the format the dialog opened on, untouched by the reader: the caption is the
    // other end of the default, read off the row the write answered with. Scoped to the new
    // tile, because this world already holds a Commander deck and the caption is not unique.
    const made = canvas.getByText("Sunday Cube").closest("li") as HTMLElement;
    // **An empty Commander deck reads `Bracket ~2`, and that is the estimate working rather than
    // a placeholder.** `BASE_FLOOR` is 2 — what a deck that flags nothing honestly reads as — and
    // a deck with no cards flags nothing, so `estimateBracket` answers 2 over an empty list just
    // as it does over a pile of Grizzly Bears. The tile prints it because **the editor's own
    // `DeckBracket` button prints it**: that control is drawn on the same `commanderRule` fence,
    // over the same empty `deck.cards`, and says `Bracket ~2` too. Hiding it here to spare a new
    // deck a number would be the one thing this feature exists not to do — one deck answering the
    // same question two ways on two screens.
    await expect(within(made).getByText(/^Commander ·/)).toHaveTextContent(
      "Commander · Bracket ~2 · 0 cards",
    );
    // **No credit line anywhere on the wall** — not because this deck has no artist, which was
    // the old claim, but because the line itself is gone since 2026-09-07. The illustrator is the
    // crop's tooltip now, and a deck with no cover has no crop to carry one.
    await expect(canvas.queryByText(/^Art by /)).toBeNull();
  },
};

/**
 * A write the database refused.
 *
 * `db.ts:1479`'s `BUSY` is `collection::BUSY` verbatim, raised by `refuseIfBusy` at the top of
 * every write handler and by no read handler — which is why the wall underneath is untouched and
 * still holds every tile.
 *
 * The banner speaks for the **latest** of the three writes a tile makes (update, remove,
 * duplicate), not for whichever is still holding an error: a refused archive used to leave its
 * sentence up while the reader went on to duplicate something successfully, which is an alert
 * about a thing already dealt with. `DecksPage.tsx:161-163` picks by `submittedAt`.
 *
 * The create form's refusal is deliberately **not** here — it is drawn inside the form, beside
 * the button that was pressed, because reopening the form resets the mutation and a refused
 * create would otherwise leave no deck and no sentence saying why.
 */
export const Busy: Story = {
  parameters: { fake: { fault: "busy" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: "Duplicate Modern Goodstuff" }),
    );

    const alert = await canvas.findByRole("alert");
    await expect(alert).toHaveTextContent(
      "Could not change your decks — The card database is busy finishing a sync. " +
        "Try that again in a moment.",
    );
    // Nothing was copied, and nothing else moved.
    await expect(canvas.queryByText("Modern Goodstuff (copy)")).toBeNull();
    await expect(canvas.getByText("Kenrith Two-Drops")).toBeInTheDocument();
  },
};

/**
 * The wall at 150%, which is what a ctrl+wheel over it leaves behind.
 *
 * The gallery is the eighth card section in `lib/cardZoom.ts` and the first whose tiles are decks
 * rather than cards, so what the number sizes here is a 626px art crop and the four lines under
 * it rather than a 5:7 face. **Both halves are the story**: the grid track, which is what turns a
 * zoom into *fewer, larger* tiles rather than into bigger boxes; and the type on a tile, which
 * follows the same number through the two inherited variables `cardScaleVars` sets on each
 * `<li>`. A wall that scaled only its tracks would draw a doubled picture with a 14px name stuck
 * under it.
 *
 * The size is written **during render** rather than in an effect — the lever
 * `CardZoomIndicator.stories.tsx` uses, for its reason: an effect runs after the first paint, so
 * the wall would be shown at 100% for a frame on its way to this. `zoomPulse` and `zoomSection`
 * are left alone, so no badge is on screen: this story is the wall at a size, not the gesture
 * that got it there.
 *
 * **Its own frame, because `useAppStore` is a module singleton.** Every other story on this page
 * renders the same component inline, so a write during render here would be the last writer and
 * would silently resize all of them (`.storybook/CLAUDE.md`).
 */
function ZoomedWall() {
  useState(() => {
    useAppStore.setState({ cardZoom: { ...DEFAULT_SECTION_ZOOMS, deckGallery: 1.5 } });
  });
  return <DecksPage />;
}

export const Zoomed: Story = {
  render: () => <ZoomedWall />,
  parameters: { docs: { story: { inline: false, height: "680px" } } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const wall = await canvas.findByRole("list", { name: "Your decks" });

    // 200 × 1.5 for the track; the gutter takes `atLeast`, which above 1× is the same
    // multiplication — 16 × 1.5.
    await expect(wall).toHaveStyle({
      gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
      gap: "24px",
    });
    // And the tile's own chrome, which is the half a track cannot show: the marks' scale, and the
    // controls' 85% of it.
    const tile = canvas.getByText("Modern Goodstuff").closest("li");
    await expect(tile).toHaveStyle({ "--mark-scale": "1.5", "--control-scale": "1.275" });
  },
};
