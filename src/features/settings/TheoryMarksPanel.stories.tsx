import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { MARK_COLOR_DEFAULTS } from "@/lib/useMarkColors";
import { TheoryMarksPanel } from "./TheoryMarksPanel";

/** The exact wording of a row's two controls, so a story names a mark the way the panel does
 *  rather than by a colour the reader is free to change. `TheoryMarksPanel`'s `MarkRow.noun`. */
const SWATCH = (noun: string) => `Change the ${noun}'s colour`;
const RESET = (noun: string) => `Reset the ${noun} to its default colour`;

/** The swatch a row is currently on, which is the one thing on this panel that is drawn in the
 *  colour itself: the two previews beside it paint from `var(--color-theory-*)`, and jsdom
 *  resolves no stylesheet, so a `toHaveStyle` on either would be an assertion about nothing. */
const swatchOf = (trigger: HTMLElement) => trigger.querySelector("span");

const meta = {
  title: "Settings/TheoryMarksPanel",
  component: TheoryMarksPanel,
  tags: ["autodocs"],
  decorators: [
    // The settings column's own width — `max-w-2xl` inside the 1280×800 window — because the
    // layout risk here is a heading, two previews and two controls sharing one line, which is
    // where the row wraps if it is going to.
    (Story) => (
      <div className="max-w-2xl p-2">
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "The two colours the theory marks are drawn in.\n\n" +
          "A deck that keeps a plan marks its **live** list against it in two tiers: one colour " +
          "where the card is the printing the plan named, another where it is the same card in " +
          "a printing the plan did not name. `CardMarks.tsx` sets out the four separations that " +
          "keep either from reading as the app's *there is a problem here* mark — the corner, " +
          "the colour, the shape and the card's own edge — and says out loud that **the colour " +
          "is the one of the four a reader can defeat**. This panel is where they defeat it.\n\n" +
          "**Green and azure are also the pair a red-green or a blue-yellow confusion has the " +
          "hardest time telling apart**, and no palette this app ships is the right answer for " +
          "every pair of eyes. The marks' own words carry the distinction for anybody reading " +
          "them another way; this is for the reader who can see them and wants them further " +
          "apart than we chose.\n\n" +
          "**Reset clears the row rather than writing today's hex.** A reader who has never " +
          "chosen and one who has just reset have to end in the same state, and they only do if " +
          "the entry is deleted — a default written into the database would freeze today's " +
          "palette into it. So `Reset` is `aria-disabled` until something has been picked, and " +
          "it is the only thing on this panel that says whether anything is customised at all.\n\n" +
          "**This panel reaches the backend itself**, so every story here is a **seeded world** " +
          "rather than an argument: picking a colour really calls `set_mark_color`, and a world " +
          "carrying the `busy` fault really refuses it. Nothing is seeded into `app_meta` — a " +
          "colour in these stories is a press the story made, which is `muted_tags`' rule one " +
          "user row over and for its reason: this panel is where a colour is chosen, so a " +
          "seeded one would be a story about a state nobody arrived at.",
      },
    },
  },
} satisfies Meta<typeof TheoryMarksPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The panel as it comes: both marks on the colours `index.css` gives them, and nothing to put
 * back.
 *
 * **Two previews per row and not one**, which is what this story is for looking at: the number
 * *replaces* the tick on a card the plan asks a different count of, so a preview of the tick
 * alone would be a preview of half of what the colour reaches. They sit on the app's own
 * background rather than on the panel's card, because that is the tone they are really drawn
 * against — these marks live on card art, and a fill judged against a pale surface is judged
 * against a surface it never meets.
 *
 * The paragraph above the list **names neither colour**, which is the one thing the prose here
 * has to get right: the reader may already have replaced both, and a panel that opened by calling
 * one of them green would be describing the screen it is sitting on wrongly.
 */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Each row names its own controls, which is `HiddenTagsPanel`'s rule: two buttons reading
    // "Reset" are two buttons a screen reader cannot choose between.
    for (const noun of ["matching-printing mark", "different-printing mark"]) {
      const swatch = canvas.getByRole("button", { name: SWATCH(noun) });
      // Shut, and saying so — the picker is a draft that opening seeds and closing throws away.
      await expect(swatch).toHaveAttribute("aria-expanded", "false");
      // `aria-disabled` and never the attribute: a `disabled` button leaves the tab order, and a
      // reader tabbing this panel would find the two marks' controls unevenly spaced for a
      // reason nothing announces. The guard is on the handler, where it has to be.
      await expect(canvas.getByRole("button", { name: RESET(noun) })).toHaveAttribute(
        "aria-disabled",
        "true",
      );
    }

    await expect(swatchOf(canvas.getByRole("button", { name: SWATCH("matching-printing mark") })))
      .toHaveStyle({ backgroundColor: MARK_COLOR_DEFAULTS.theoryExact });
    await expect(swatchOf(canvas.getByRole("button", { name: SWATCH("different-printing mark") })))
      .toHaveStyle({ backgroundColor: MARK_COLOR_DEFAULTS.theoryName });

    // The sentence a reader with two devices cannot do without: these colours are an `app_meta`
    // row, and `app_meta` is not one of the twelve tables sync carries.
    await expect(canvas.getByText(/kept only on this device/)).toBeInTheDocument();
    await expect(canvas.queryByRole("alert")).not.toBeInTheDocument();
  },
};

/**
 * One mark recoloured, and the state that follows from it — a press rather than a seed.
 *
 * The reader opens the loose tier's picker, takes one of the app's own six, and presses Done.
 * **Done is the write**: `input[type=color]` fires continuously while the OS dialog is being
 * dragged, so the open picker's colour is a draft held beside "which row is open" as one piece of
 * state, and a row that wrote on every change would send one `set_mark_color` per pixel of
 * travel. Closing throws the draft away, which is why opening *is* the reset.
 *
 * **Only the row that was touched changes.** The other mark keeps the stylesheet's colour and its
 * Reset stays unavailable, which is the whole of what makes that button readable: it is the one
 * control on the panel that says whether the reader has customised anything.
 *
 * **Ember is deliberately the colour picked**, and it is the app's own destructive red. Nothing
 * stops a reader choosing it, and this panel is not the place to stop them: the mark's other three
 * separations from the `RULE BREAK` mark — the corner, the shape and the card's own edge — are
 * structural and hold whatever is picked here, which is exactly why `CardMarks.tsx` insists on
 * four of them rather than one. A story that only ever picked a tasteful colour would be a story
 * about a screen nobody can get into trouble on.
 */
export const Customised: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole("button", { name: SWATCH("different-printing mark") });

    await userEvent.click(trigger);
    await expect(trigger).toHaveAttribute("aria-expanded", "true");

    // **The picker names what it is colouring in the reader's words.** Its own default is
    // "Label colour", and a label is not a mark — the two are different objects in this app and
    // the vocabulary rule is that they never trade places. Left at the default, a screen-reader
    // user recolouring one of these would hear "Label colour" twice with nothing telling the two
    // rows apart.
    const picker = canvas.getByRole("group", { name: "Different printing colour" });
    await userEvent.click(within(picker).getByRole("button", { name: "Ember" }));
    await userEvent.click(within(picker).getByRole("button", { name: "Done" }));

    // The picker is shut and the colour is committed — the swatch is both the trigger and the
    // answer to "what is it set to now", which is why this row has no separate readout.
    await waitFor(async () => {
      await expect(trigger).toHaveAttribute("aria-expanded", "false");
    });
    await expect(swatchOf(trigger)).toHaveStyle({ backgroundColor: "#d3202a" });

    // There is something to put back now, and only on this row.
    await expect(
      canvas.getByRole("button", { name: RESET("different-printing mark") }),
    ).not.toHaveAttribute("aria-disabled");
    await expect(
      canvas.getByRole("button", { name: RESET("matching-printing mark") }),
    ).toHaveAttribute("aria-disabled", "true");
    await expect(
      swatchOf(canvas.getByRole("button", { name: SWATCH("matching-printing mark") })),
    ).toHaveStyle({ backgroundColor: MARK_COLOR_DEFAULTS.theoryExact });

    await expect(canvas.queryByRole("alert")).not.toBeInTheDocument();
  },
};

/**
 * The write refused — **and this is the one hook in the app whose refusal is surfaced at all**.
 *
 * `set_mark_color` answers `BUSY` while a sync holds the write connection, exactly as
 * `set_nav_collapsed` and `set_list_view` do. Those two swallow it, because the reader cannot see
 * what was lost until the next launch and taking the fold back would cost them more than the
 * silence does. Here they are standing in front of a swatch watching it move, so the panel says
 * the write did not land.
 *
 * **The colour they picked stays on screen for the session**, which is the other half of that
 * trade: the cache is written optimistically before the command is sent and nothing puts it back.
 * So the red line is the only thing separating *refused* from *saved* — take it away and this
 * story and {@link Customised} are the same screen.
 */
export const RefusedWrite: Story = {
  parameters: { fake: { fault: "busy" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole("button", { name: SWATCH("matching-printing mark") });

    await userEvent.click(trigger);
    const picker = canvas.getByRole("group", { name: "Matching printing colour" });
    await userEvent.click(within(picker).getByRole("button", { name: "Moss" }));
    await userEvent.click(within(picker).getByRole("button", { name: "Done" }));

    // The refusal, in the app's own words rather than a sentence this panel invented — a Rust
    // command's error is a bare string and `useMarkColors` passes it through.
    await waitFor(async () => {
      await expect(canvas.getByRole("alert")).toHaveTextContent(/busy finishing a sync/);
    });

    // And the swatch is still on the colour they chose. Taking it back *and* explaining why
    // would be the rail's silent trade with the compensation removed.
    await expect(swatchOf(trigger)).toHaveStyle({ backgroundColor: "#00733e" });
  },
};
