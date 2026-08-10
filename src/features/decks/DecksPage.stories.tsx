import { useQuery } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { ipc } from "@/lib/ipc";
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
 * and that is a fact about the app rather than a shortcut. "Set as cover" is the only control
 * that writes one and it is withheld from an orphaned row (`ZoneColumn.tsx:793`), so a cover only
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
          "The decks, as a wall of the art they were built around. No summary strip, no filter " +
          "row, and no colour that is not a card's own: a deck is picked by looking at it.\n\n" +
          "Driven end to end by `.storybook/fake/`. **The three seeded decks are the three " +
          'states a gallery has** — measured 2026-08-10 over `readHandlers(seed("starter")).' +
          "deck_list()`, which answers them in this order: `Modern Goodstuff` (Modern, 60 " +
          "cards, cover art by Simon Dominic), `Kenrith Two-Drops` (Commander, 100, Kieran " +
          "Yanner) and `Old School 93/94` (Old School, 22, Christopher Rush), the last one " +
          "**archived**. `deck::list_decks` sorts archived last, then most recently touched " +
          "first, so that order is the wall's.\n\n" +
          "**A tile's count is not the deck's row count.** `cardCount` is summed over " +
          "`SIZE_ZONES` — main plus commander (`db.ts:837-838`, mirroring `DeckRow.cardCount`) " +
          "— so the Modern deck's 15 sideboard cards and its 2-card scratchpad are in the " +
          "editor and not in the caption. The number under a tile is the number the format's " +
          "size rule is about, which is the same definition the editor's headline figure and " +
          "the validation chip share.\n\n" +
          "**Archiving is the reversible thing and deleting is not.** The trash control asks " +
          "first, names what would go with the deck, and offers archiving in the same breath " +
          "({@link DeleteAsksFirst}); the archive control is a toggle whose other face is " +
          "Restore ({@link Archived}). `deck_delete` really deletes, by cascade.\n\n" +
          "**A cover with no artist is not drawn, and it has no UI path** — which is why " +
          "{@link NoCoverArtist} stages it through `deck_update` instead. The tile draws no " +
          "credit line at all when `coverArtist` is null (`DecksPage.tsx:345-349`) — never the " +
          'word "null", never a placeholder — and reaching that needs a deck whose ' +
          "`coverCardId` names a printing `cards` does not hold. Measured 2026-08-10: **0 of " +
          "the 43** rows of `.storybook/fake/cards.ts` has a null `artist`, no seed points a " +
          "cover at a missing id, and the one control that *sets* a cover is withheld from an " +
          "orphaned row (`ZoneColumn.tsx:793` gates “Set as cover” on `needsReview === null`). " +
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
    // count — 60 for a deck holding 77 cards over 18 rows, because a sideboard and a scratchpad
    // are not what "a 60-card deck" means.
    await expect(within(wall).getByText(/Modern ·/)).toHaveTextContent("Modern · 60 cards");
    // Scryfall's image policy, per tile and only where there is a name to credit.
    await expect(canvas.getByText("Art by Simon Dominic")).toBeInTheDocument();

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
 */
export const Archived: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Archived 1" }));

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
    // Archiving is not a refusal and says nothing: the tile moving is the whole report.
    await expect(canvas.queryByRole("alert")).toBeNull();
  },
};

/**
 * The one question this view asks before doing something it cannot undo.
 *
 * `deck_delete` really deletes — the deck, its cards and its claims, by cascade (`db.ts:2026-2032`)
 * — and a deck is minutes of work, so the destructive control asks once, in words, naming what
 * would go with it and offering the reversible thing instead. The count in the question is the
 * tile's own, from one derivation of the plural, so the caption and the question can never
 * disagree about whether it is "card" or "cards".
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
      "Its 60 cards go with it. Archiving keeps the deck instead.",
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
 * A cover whose printing has left the card database — **so no illustrator is named, and none is
 * invented.**
 *
 * Scryfall's image policy is why the line is conditional rather than a slot that says something:
 * an art crop carries no printed frame, so the illustrator is credited wherever one is *shown*,
 * and a credit the app cannot substantiate is worse than no credit. The tile draws its art, its
 * name and its caption exactly as its neighbour does; the one line that would have said who
 * painted it is simply not there. **It heals on the next sync that brings the printing back** —
 * `coverArtist` is a lookup at read time (`db.ts:855`, the `LEFT JOIN cards c ON c.id =
 * d.cover_card_id` at `deck.rs:235`), not a stored column, so nothing has to notice.
 *
 * Told **per tile**, which is the claim: Kenrith Two-Drops keeps its credit in the same wall on
 * the same render. And distinct from {@link NewDeck}: this deck *has* a cover, so the frame does
 * not say "No cover" — "the deck has not picked one" and "the art is not there" are two different
 * things to do something about, and `Cover` tells them apart in as many words.
 *
 * The `needsReview` seed because that is where the orphan id lives, and it is the honest world for
 * this state: the sync that took the printing away is the same sync that flagged the deck row
 * naming it.
 */
export const NoCoverArtist: Story = {
  parameters: { fake: { seed: "needsReview" } },
  render: () => <OrphanedCover />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const wall = await canvas.findByRole("list", { name: "Your decks" });

    const orphaned = within(wall)
      .getByRole("button", { name: /^Modern Goodstuff/ })
      .closest("li");
    await expect(orphaned).not.toBeNull();
    const tile = within(orphaned as HTMLElement);
    // No credit, and no claim that there is nothing to credit: the line is absent, not blank.
    await expect(tile.queryByText(/^Art by/)).toBeNull();
    // And it is not the empty-cover state — this deck chose a face, the face just is not there.
    await expect(tile.queryByText("No cover")).toBeNull();

    // The neighbour, unaffected, on the same render: the rule is a fact about one cover.
    const kept = within(wall)
      .getByRole("button", { name: /^Kenrith Two-Drops/ })
      .closest("li");
    await expect(within(kept as HTMLElement).getByText("Art by Kieran Yanner")).toBeInTheDocument();
    await expect(canvas.getAllByText(/^Art by/)).toHaveLength(1);
  },
};

/**
 * A gallery before there is a deck.
 *
 * "A deck is a list you build for a format. Start one and the app checks it as you go…" — a
 * statement about what a deck *is*, next to the one control that makes one, rather than the word
 * "empty". `seed: "empty"` is the seed with no decks; it also has no cards, which is why this is
 * the honest first-run gallery rather than a filtered one.
 */
export const Empty: Story = {
  parameters: { fake: { seed: "empty" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText(/A deck is a list you build for a format\./),
    ).toBeInTheDocument();
    await expect(canvas.queryByRole("list", { name: "Your decks" })).toBeNull();
    await expect(canvas.getByRole("button", { name: "New deck" })).toBeEnabled();
  },
};

/**
 * Making one — and the tile a deck has before it has chosen a face.
 *
 * Two questions and no more: what it is called, and what it is for. The format list is the
 * seeded `format_specs` table read in its own `sort_order` and filtered to `enabled_in_picker`,
 * which the fake serves from `validation/fixtures.ts`'s `SPECS` — **12 rows**, measured
 * 2026-08-10 over `format_specs_list()`, against the 25 the real migration seeds. The select
 * starts on Casual, which is `decks.format_key`'s own DDL default: a deck that has not been
 * given a format yet should not be a deck full of complaints.
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
    await expect(within(form).getByLabelText("Format")).toHaveValue("casual");

    await userEvent.type(name, "Sunday Cube");
    await userEvent.click(within(form).getByRole("button", { name: "Create deck" }));

    await waitFor(async () => {
      await expect(canvas.getByText("Sunday Cube")).toBeInTheDocument();
    });
    // A deck with no cover and nothing in it, said in both places rather than left blank.
    await expect(canvas.getByText("No cover")).toBeInTheDocument();
    await expect(canvas.getByText(/^Casual ·/)).toHaveTextContent("Casual · 0 cards");
    // **No credit line**, because there is no artist to credit. Two on the wall, not three: the
    // archived deck's tile is behind a shut disclosure and is not mounted at all.
    await expect(canvas.getAllByText(/^Art by /)).toHaveLength(2);
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
