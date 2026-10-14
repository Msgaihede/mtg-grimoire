import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { AddCardDialog, CHOOSE_A_PRINTING } from "./AddCardDialog";

/**
 * *Add a card*: a card the camera will not read, searched for by name and put in the scan tray
 * by hand (issue #978). The tray's **Add card…** opens it on both Scanner surfaces, and the page
 * pauses the scanner while it is open.
 *
 * The same two questions *Send scan…* asks — the exact printing, and its finish — over the
 * workbench's fake: the four Lightning Bolts of its corpus come back as four tiles. A printing
 * sold one way has its finish chosen for the reader; so does the Defaults popover's fixed finish
 * where the printing comes in it.
 *
 * **Each docs story has a frame of its own**: a dialog covers the window it is in.
 */
const meta = {
  title: "Scanner/Reader/Add card dialog",
  component: AddCardDialog,
  tags: ["autodocs"],
  args: {
    open: true,
    finishPref: "detect",
    onAdd: fn(),
    onDismiss: fn(),
    onClose: fn(),
  },
  parameters: {
    docs: { story: { inline: false, height: "820px" } },
  },
} satisfies Meta<typeof AddCardDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As it opens: an empty box, nothing chosen, Add out of reach with its reason beside it. */
export const Open: Story = {
  play: async ({ canvasElement }) => {
    const dialog = await within(canvasElement).findByRole("dialog", { name: "Add a card" });
    await expect(within(dialog).getByText(CHOOSE_A_PRINTING)).toBeInTheDocument();
    await expect(within(dialog).getByRole("button", { name: "Add to tray" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  },
};

/** A search, a printing sold more than one way, and the finish still to answer. */
export const PrintingChosen: Story = {
  play: async ({ canvasElement }) => {
    const dialog = await within(canvasElement).findByRole("dialog", { name: "Add a card" });
    await userEvent.type(
      within(dialog).getByRole("searchbox", { name: "Which card do you want to add?" }),
      "lightning bolt",
    );
    const printings = await within(dialog).findByRole(
      "radiogroup",
      { name: "Printings" },
      { timeout: 5000 },
    );
    const [first] = within(printings).getAllByRole("radio");
    await userEvent.click(first);
    await expect(first).toHaveAttribute("aria-checked", "true");
  },
};

/** Under a fixed Foil default: the finish comes chosen wherever the printing has it. */
export const FoilDefault: Story = {
  args: { finishPref: "foil" },
  play: PrintingChosen.play,
};
