import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { DESCRIPTION_HEADING, DeckDescriptionPanel } from "./DeckDescriptionPanel";

/**
 * The deck's description, as the first band in the editor's notes row (issue #912).
 *
 * ⚠️ **Not a note.** It is `decks.description`, written in Deck settings and drawn here
 * read-only. The editor mounts nothing for a blank one, so there is no empty story.
 */
const meta = {
  title: "Decks/DeckDescriptionPanel",
  component: DeckDescriptionPanel,
  tags: ["autodocs"],
  args: {
    description: "Sixty legal cards and no plan. The shell every Modern story is cut from.",
  },
  decorators: [
    (Story) => (
      <div className="w-[28rem] max-w-full p-4">
        <Story />
      </div>
    ),
  ],
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "The deck's own description, in a band beside the notes and the to-do lists — three " +
          "columns on a wide editor, two or one on a narrower one.\n\n" +
          "**Open on arrival**: it is drawn only when the deck has a description, so it shows " +
          "it. **Nothing at all for a blank one** — the row keeps two tracks. The disclosure is " +
          "editor state; nothing is written to the deck.",
      },
    },
  },
} satisfies Meta<typeof DeckDescriptionPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Open on arrival, and one press shuts it. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const disclosure = canvas.getByRole("button", { name: DESCRIPTION_HEADING });
    await expect(disclosure).toHaveAttribute("aria-expanded", "true");
    await expect(canvas.getByText(/Sixty legal cards/)).toBeVisible();

    await userEvent.click(disclosure);
    await expect(disclosure).toHaveAttribute("aria-expanded", "false");
    await expect(canvas.queryByText(/Sixty legal cards/)).toBeNull();
  },
};

/** A primer pasted in: the reader's line breaks are kept, and nothing is clamped. */
export const Long: Story = {
  args: {
    description: [
      "Turn one: a one-drop, or a fetch and a Bolt.",
      "Turn two: Lava Spike or Rift Bolt, whichever is in hand.",
      "",
      "Against control, hold the Skewers until the shields come down. Against creatures, the " +
        "burn goes at blockers first and at the face only once the board is clear.",
    ].join("\n"),
  },
};
