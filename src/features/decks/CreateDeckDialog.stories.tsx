import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { registerCommands } from "../../../.storybook/fake/core";
import { FOCUS } from "@/lib/focus";
import type { DeckRow } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { openDropdown } from "@/test-dropdown";
import { CreateDeckDialog } from "./CreateDeckDialog";
import { useDecks } from "./useDecks";
import { useNewDeckFormat } from "./useNewDeckFormat";

/**
 * The dialog with the two things the gallery owns and hands down: the `create` mutation, and
 * the trigger the caret is handed back to.
 *
 * **`create` is `useDecks().create`, mounted here rather than inside the dialog** — the shape
 * `DecksPage` uses, and for the reason the prop's own doc gives: the gallery calls
 * `create.reset()` on the way in, and this dialog is the only place a refused create can be
 * read. A second mutation of the dialog's own would be a second answer, and the one on screen
 * would be the one that never fired.
 *
 * The trigger is real because Escape's contract is "hand the caret back to whatever opened
 * this", and there is nothing to hand it back to without a button still on screen.
 */
function Dialog({
  onCreated,
  onDismiss,
  noFormats = false,
}: {
  onCreated: (deck: DeckRow) => void;
  onDismiss: () => void;
  /** Answer `format_specs_list` with nothing, which is the one launch where the seeded table
   *  has not arrived by the time the dialog opens. */
  noFormats?: boolean;
}) {
  // **During render and not in an effect**, for `preview.tsx`'s reason one floor down: an
  // effect runs after the first paint, and by then `useFormatSpecs` has already asked. The
  // world this merges into is this story's own — the decorator's own memo activated it
  // immediately before this render — and running **once** is what keeps it that way, because a
  // *re-render* on a docs page happens with whichever story's scope was activated last.
  //
  // `useState`'s lazy initializer rather than `useMemo`, which `react-hooks/void-use-memo`
  // refuses for a callback with no value: a memo caches a computation, and this is a
  // once-per-mount effect that has to land before the first read.
  useState(() => {
    if (noFormats) registerCommands({ format_specs_list: () => [] });
    return noFormats;
  });

  const { create } = useDecks();
  /**
   * The format the draft starts on, resolved by the **host** — which is what the gallery does,
   * and why the prop is required rather than defaulted inside the dialog. The call is
   * `useNewDeckFormat()` rather than a literal on purpose: a hard-coded string would draw the
   * same select while proving nothing about the wiring the app actually runs.
   *
   * **On this page it resolves to `casual` in every story, which is not the app's answer, and
   * the reason is this host's own shape.** `open` starts `true`, so `Panel` mounts on the very
   * first render — and on that render the story's cold `QueryClient` has answered neither
   * `format_specs_list` nor `deck_last_format`. `newDeckFormat` therefore sees an empty picker
   * and no memory and lands on its **third arm**, `DEFAULT_FORMAT`; the draft is a lazy
   * `useState` initializer, so it runs once and the two answers arriving a beat later change
   * nothing. Every play on this page opens on Casual.
   *
   * **That is the third arm working, not a defect to patch out.** An empty picker is precisely
   * the state both dialogs already draw a single `Casual` option for, and the arm exists so the
   * *value* falls back with the options rather than holding a key the select cannot offer. The
   * mount-on-first-render shape is also what the rest of this file's plays are built on, so
   * what gets corrected here is the prose and not the story. `noFormats` still changes
   * something real: it keeps the picker empty **after** the read lands, so the select goes on
   * offering one row — which is the pairing **NoFormats** below asserts, against the other
   * stories' full list with `casual` merely selected in it.
   *
   * **The remembered/Commander path is exercised in `DecksPage.stories.tsx`'s `NewDeck`**,
   * which is the only place it can be: there the gallery mounts first and the dialog opens on a
   * press, so both reads have landed before any draft is seeded. That order of events is the
   * whole reason `DecksPage` is what mounts the hook.
   */
  const defaultFormatKey = useNewDeckFormat();
  const [open, setOpen] = useState(true);

  return (
    <div className="grid min-h-[30rem] place-items-start">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        className={cn(
          "inline-flex h-9 items-center rounded-md border border-accent px-3 text-sm text-accent",
          FOCUS,
        )}
      >
        New deck
      </button>
      <CreateDeckDialog
        create={create}
        defaultFormatKey={defaultFormatKey}
        open={open}
        onCreated={(deck) => {
          onCreated(deck);
          setOpen(false);
        }}
        onDismiss={() => {
          onDismiss();
          setOpen(false);
        }}
        // The scrim's way out, which moves no focus — the gallery's `close`.
        onClose={() => setOpen(false)}
      />
    </div>
  );
}

const meta = {
  title: "Decks/Create deck dialog",
  component: Dialog,
  tags: ["autodocs"],
  args: { onCreated: fn(), onDismiss: fn(), noFormats: false },
  parameters: {
    // **Its own frame per docs story**, the same parameter `DeckSettingsDialog` carries and for
    // the same reason: the scrim is `fixed inset-0`, so rendered inline every story on this page
    // would cover the whole page rather than its own block, and the last one mounted would be
    // the only one anybody could read. `inline: false` gives each story an iframe, which is the
    // viewport the fixed positioning is then relative to.
    docs: {
      story: { inline: false, height: "640px" },
      description: {
        component:
          "The whole deck, described before it exists.\n\n" +
          "**It used to ask two questions** — name and format — and everything else a deck " +
          "carries was reachable only from the settings dialog, so the app's one *creating* " +
          "act produced a deck the reader then had to go and configure. It hosts one " +
          "`DeckSettingsForm` now, in the same 55rem two-column panel, and one `deck_create` " +
          "writes every answer at once: create-then-patch-then-file would be three " +
          "transactions and a half-made deck to unwind by hand when the second one fails.\n\n" +
          "Driven end to end by `.storybook/fake/`: `deck_create`, `format_specs_list`, " +
          "`deck_folder_list`, `search_cards` and `card_detail` all really answer, so " +
          "**Default** writes a configured deck, **A cover from the search** credits the art " +
          "it picked, and **Refused** shows what a busy database says about it.\n\n" +
          "**Two states are unit tests rather than stories, and the reason is the file " +
          "picker.** `open()` from `@tauri-apps/plugin-dialog` reaches Tauri's `invoke`, and " +
          "outside the app window there is nothing behind it — so no story can produce a path, " +
          "and neither the upload that follows a create nor the state after it is refused (the " +
          "deck exists, the line says so, and the control becomes **Open deck**) can be " +
          "reached from here. Both are in `CreateDeckDialog.test.tsx`.",
      },
    },
  },
} satisfies Meta<typeof Dialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The dialog as it opens: the caret in the field the reader has to fill, every other question a
 * deck carries beside it, and the seeded formats behind the select — **alphabetically**, which
 * is not the `sort_order` the fake answers in. A picker sorts by the words on screen
 * (`src/lib/options.ts`); the table's own ranking is a fact about `format_specs` and no help to
 * a reader looking for Modern under M.
 *
 * The play fills five of them and writes a real deck through the fake's `deck_create` — one
 * call, carrying the lot. The folder id is the seed's own (`FILED_DECK_FOLDER` in
 * `.storybook/fake/seeds.ts`) rather than read off a live control: a dropdown's trigger carries
 * no `value` the way a `<select>`'s did, so the claim moved from "whatever the control holds" to
 * "the id the fixture names that path".
 */
export const Default: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.type(await canvas.findByLabelText("Name"), "Sunday burn");
    await openDropdown(userEvent.setup(), "Format");
    await userEvent.click(await canvas.findByRole("option", { name: "Modern" }));
    await userEvent.type(canvas.getByLabelText("Description"), "Twenty damage, quickly.");
    await userEvent.click(canvas.getByRole("switch", { name: /Theory deck/ }));

    await openDropdown(userEvent.setup(), "Folder");
    await userEvent.click(await canvas.findByRole("option", { name: "Constructed › Commander" }));

    await userEvent.click(canvas.getByRole("button", { name: "Create deck" }));

    await waitFor(async () => {
      await expect(args.onCreated).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Sunday burn",
          formatKey: "modern",
          description: "Twenty damage, quickly.",
          folderId: 2,
          // Set at create, and it seeds nothing: a deck being born has no live cards to copy
          // into the plan, unlike the patch's off → on transition.
          theoryEnabled: true,
        }),
      );
    });
  },
};

/**
 * A cover chosen before the deck exists.
 *
 * **The search arm is the one that works here.** "Pick art from cards in this deck" has nothing
 * to offer at create — that is what the empty grid says — so the box above it offers every
 * printing in the database instead, uncollapsed, because different printings are different art
 * and collapsing them would hide exactly the choice being made.
 *
 * The picked id travels in the `deck_create` itself: `coverKind` is not settable at create and
 * keeps its `card_art` default, which is the kind a picked card *is*.
 *
 * **The preview draws it, credit and all — and the credit is a round trip.** An `art` crop has
 * no printed frame, so Scryfall's image policy credits the illustrator wherever one is shown,
 * and the preview refuses to draw a crop it cannot credit. Every other surface reads that name
 * off `DeckRow.coverArtist`; there is no `DeckRow` here yet and `CardSummary` carries no
 * `artist`, so this host asks `card_detail` for the one field it needs. The tile's
 * `aria-pressed` is the immediate feedback and the picture follows with its credit — never the
 * credit first, and never an uncredited crop.
 */
export const ACoverFromTheSearch: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.type(await canvas.findByLabelText("Name"), "Bolt tribal");
    await expect(canvas.getByText(/Nothing to pick from yet/)).toBeVisible();

    // 300 ms of debounce before a keystroke becomes a query, which is why the wait is generous.
    await userEvent.type(canvas.getByLabelText("Search every card"), "Lightning Bolt");
    const results = await canvas.findByRole(
      "list",
      { name: "Pick art from any card" },
      { timeout: 5000 },
    );
    const tile = within(results).getAllByRole("button", { name: "Lightning Bolt" })[0];
    await userEvent.click(tile);
    await expect(tile).toHaveAttribute("aria-pressed", "true");

    // The illustrator, whoever the fake's corpus gives this printing — the claim is that a line
    // appears at all, because before the fetch there was none and the preview stayed empty.
    await expect(await canvas.findByText(/^Art by /)).toBeVisible();

    await userEvent.click(canvas.getByRole("button", { name: "Create deck" }));

    await waitFor(async () => {
      await expect(args.onCreated).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Bolt tribal", coverCardId: expect.any(String) }),
      );
    });
  },
};

/**
 * A write the database refuses, in the app's own words.
 *
 * **The dialog is the only place this sentence can land** — `writeFailure` covers the writes a
 * *tile* makes and not this one — so the surface has to outlive the press, and every answer
 * typed into it has to outlive the refusal. Both are what this story shows.
 */
export const Refused: Story = {
  parameters: { fake: { fault: "busy" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.type(await canvas.findByLabelText("Name"), "Sunday burn");
    await userEvent.type(canvas.getByLabelText("Notes"), "Bring the burn.");
    await userEvent.click(canvas.getByRole("button", { name: "Create deck" }));

    await waitFor(async () => {
      await expect(await canvas.findByRole("alert")).toHaveTextContent("Could not create the deck");
    });
    // Still holding them, so the reader presses again rather than retyping.
    await expect(canvas.getByLabelText("Name")).toHaveValue("Sunday burn");
    await expect(canvas.getByLabelText("Notes")).toHaveValue("Bring the burn.");
  },
};

/**
 * The one launch where `format_specs` has not answered yet.
 *
 * The trigger still has to *say* something, and what it says is what it would create: Casual,
 * which is `decks.format_key`'s own DDL default. **The words come from this host, not from the
 * form** — `DeckSettingsValue` carries a format *key* and no display name, so a form handed an
 * empty list can do no better than label the option with the key, and the control would read
 * `casual`. So the empty list is never passed: a one-row fallback goes down instead, and the
 * dropdown stays live because a list of one is still a list.
 */
export const NoFormats: Story = {
  args: { noFormats: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    const format = await canvas.findByRole("button", { name: "Format" });
    await expect(format).toHaveTextContent("Casual");
    await expect(format).toBeEnabled();

    await openDropdown(userEvent.setup(), "Format");
    await expect(canvas.getAllByRole("option")).toHaveLength(1);
    await expect(canvas.getByRole("option")).toHaveTextContent("Casual");
  },
};
