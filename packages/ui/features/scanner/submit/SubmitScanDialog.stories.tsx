import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fireEvent, fn, userEvent, waitFor, within } from "storybook/test";
import { FAKE_SCAN_ID, SCAN_INBOX_FULL } from "@grimoire/fake/db";
import { RUN_PICTURES, RUNS } from "./fixtures";
import { SubmitScanDialog } from "./SubmitScanDialog";
import { CHOOSE_ITS_FINISH, CHOOSE_THE_CARD, disclosure, SEARCH_PROMPT } from "./submitText";

/**
 * *Send this scan*: the last couple of seconds the scanner was shown when a reader pressed
 * **Send scan…**, and the two answers that go with them — the exact printing, and its finish.
 *
 * **A scan is a run of pictures, never one.** The scanner decides over a run, so what is sent is
 * every frame it was given — up to twenty — each beside what it answered. The dialog rests on
 * the last of them, which is the card the reader's answer names; a slider reaches every one,
 * and *Play* walks them once from first to last. There is no way to send fewer: all of them,
 * or Cancel.
 *
 * Both Scanner surfaces mount this one dialog, the desktop page's and the phone's. It is drawn
 * here over the workbench's fake: the search is the fake's `search_cards`, so the four Lightning
 * Bolts of its corpus come back as four tiles — sold one, two, one and three ways, which is every
 * shape the finish group takes — and Send is answered by the fake's `scanner_submit`.
 *
 * **Nothing is chosen for the reader** except a finish the printing leaves no choice about. The
 * scanner's own guess opens the search and selects nothing: a scan is sent because the scanner
 * got it wrong or could not say, so its answer is the one label that cannot be trusted here.
 *
 * The pictures in these stories are six drawn JPEGs of a card sliding into place, under a
 * kilobyte each (`fixtures.ts`), not photographs.
 *
 * **Each docs story has a frame of its own**: a dialog covers the window it is in.
 */
const meta = {
  title: "Scanner/Reader/Send scan dialog",
  component: SubmitScanDialog,
  tags: ["autodocs"],
  args: {
    run: RUNS.wrongPrinting,
    onDismiss: fn(),
    onClose: fn(),
  },
  parameters: { docs: { story: { inline: false, height: "820px" } } },
} satisfies Meta<typeof SubmitScanDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

const PICTURES = RUN_PICTURES.length;
const address = (n: number) => `data:image/jpeg;base64,${RUN_PICTURES[n - 1]}`;

/** The dialog and its printings, once the search the prefill started has answered. */
async function opened(canvasElement: HTMLElement) {
  const dialog = await within(canvasElement).findByRole("dialog", { name: "Send this scan" });
  const printings = await within(dialog).findByRole(
    "radiogroup",
    { name: "Printings" },
    { timeout: 5000 },
  );
  return { dialog, printings };
}

/** The picture of the run that is showing — by its name, since a printing's tile is one too. */
const picture = (dialog: HTMLElement) =>
  within(dialog).getByRole("img", { name: /^Picture \d+ of \d+ that will be sent$/ });

/**
 * As it opens: the last picture of the run, the search already holding the card the scanner
 * named, every printing of it — and nothing chosen. Send is on the page and out of reach, with
 * its reason in words beside it, under a sentence that says how many pictures will go.
 */
export const Open: Story = {
  play: async ({ canvasElement }) => {
    const { dialog, printings } = await opened(canvasElement);
    await expect(picture(dialog)).toHaveAttribute("src", address(PICTURES));
    await expect(
      within(dialog).getByText(`Picture ${PICTURES} of ${PICTURES} · the moment you pressed`),
    ).toBeInTheDocument();
    await expect(within(dialog).getByText(disclosure(PICTURES))).toBeInTheDocument();
    await expect(within(dialog).getByRole("searchbox")).toHaveValue("Lightning Bolt");

    // More than one, rather than a count: the corpus is generated. What the story is about is
    // that printings are not folded together, and that none of them arrives chosen.
    const tiles = within(printings).getAllByRole("radio");
    await expect(tiles.length).toBeGreaterThan(1);
    await expect(within(printings).queryAllByRole("radio", { checked: true })).toHaveLength(0);
    await expect(
      within(printings).getByRole("radio", { name: "Lightning Bolt — STA 105" }),
    ).toBeInTheDocument();

    const send = within(dialog).getByRole("button", { name: "Send scan" });
    await expect(send).toHaveAttribute("aria-disabled", "true");
    await expect(send).toHaveAccessibleDescription(CHOOSE_THE_CARD);
  },
};

/**
 * Looking through the run: the slider stops on every picture, and the line under it says which
 * one and how long before the press it was taken. *Play* is there for a reader who wants to
 * watch the card come in — one pass, first picture to last — and is not offered at all to one
 * who has asked their system for less motion, for whom the slider is the whole of it.
 */
export const LookingThroughThePictures: Story = {
  play: async ({ canvasElement }) => {
    const { dialog } = await opened(canvasElement);
    const slider = within(dialog).getByRole("slider", { name: "Picture" });
    await expect(slider).toHaveValue(String(PICTURES));

    await fireEvent.change(slider, { target: { value: "1" } });
    await expect(picture(dialog)).toHaveAttribute("src", address(1));
    await expect(slider).toHaveAttribute("aria-valuetext", `Picture 1 of ${PICTURES}`);
    await expect(
      within(dialog).getByText(`Picture 1 of ${PICTURES} · 0.6 s before you pressed`),
    ).toBeInTheDocument();

    await fireEvent.change(slider, { target: { value: "4" } });
    await expect(picture(dialog)).toHaveAttribute("src", address(4));
    // Looking is not answering: nothing about the card or the finish has moved.
    await expect(
      within(dialog).getByRole("button", { name: "Send scan" }),
    ).toHaveAccessibleDescription(CHOOSE_THE_CARD);
    // (Play is not asserted here: a workbench opened under reduced motion draws none.)
  },
};

/**
 * A printing sold three ways is chosen, and the finish is asked for; then one sold a single way,
 * whose finish is selected for the reader — the only thing this dialog ever chooses for them.
 */
export const ChoosingTheFinish: Story = {
  play: async ({ canvasElement }) => {
    const { dialog, printings } = await opened(canvasElement);
    const send = within(dialog).getByRole("button", { name: "Send scan" });
    const finishes = within(dialog).getByRole("radiogroup", { name: "Finish" });

    await userEvent.click(within(printings).getByRole("radio", { name: "Lightning Bolt — STA 105" }));
    await expect(within(dialog).getByText("Chosen: Lightning Bolt · STA 105")).toBeInTheDocument();
    await expect(within(finishes).getAllByRole("radio")).toHaveLength(3);
    await expect(within(finishes).queryAllByRole("radio", { checked: true })).toHaveLength(0);
    await expect(send).toHaveAccessibleDescription(CHOOSE_ITS_FINISH);

    // Alpha was printed one way, so there is nothing to ask.
    await userEvent.click(within(printings).getByRole("radio", { name: "Lightning Bolt — LEA 161" }));
    await expect(within(finishes).getByRole("radio", { name: "Nonfoil" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(send).not.toHaveAttribute("aria-disabled");
  },
};

/**
 * Both answers given and Send pressed: the form gives way to the thanks, with the reference the
 * inbox answered with. Nothing kept says who sent it, so that reference is the only way a reader
 * can ever point at these pictures again — which is what the last line tells them.
 */
export const Sent: Story = {
  play: async ({ args, canvasElement }) => {
    const { dialog, printings } = await opened(canvasElement);
    await userEvent.click(within(printings).getByRole("radio", { name: "Lightning Bolt — STA 105" }));
    await userEvent.click(
      within(within(dialog).getByRole("radiogroup", { name: "Finish" })).getByRole("radio", {
        name: "Foil",
      }),
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Send scan" }));

    await expect(await within(dialog).findByText("Sent — thank you.")).toBeInTheDocument();
    await expect(within(dialog).getByText(FAKE_SCAN_ID)).toBeInTheDocument();
    const done = within(dialog).getByRole("button", { name: "Done" });
    await waitFor(() => expect(done).toHaveFocus());
    await userEvent.click(done);
    await expect(args.onDismiss).toHaveBeenCalled();
  },
};

/**
 * The inbox turning a scan away because it is full until its maker has read what it holds —
 * the refusal a reader is most likely to meet. It is said in place, in the engine's own
 * sentence; the dialog stays open with both answers as they were, and Send can be pressed again.
 */
export const InboxFull: Story = {
  parameters: { fake: { fault: "scanInboxFull" } },
  play: async ({ canvasElement }) => {
    const { dialog, printings } = await opened(canvasElement);
    await userEvent.click(within(printings).getByRole("radio", { name: "Lightning Bolt — LEA 161" }));
    const send = within(dialog).getByRole("button", { name: "Send scan" });
    await userEvent.click(send);

    await expect(await within(dialog).findByRole("alert")).toHaveTextContent(SCAN_INBOX_FULL);
    // Still the form, with the answers in it: nothing was sent, so there is nothing to thank for.
    await expect(within(dialog).queryByText("Sent — thank you.")).toBeNull();
    await expect(
      within(printings).getByRole("radio", { name: "Lightning Bolt — LEA 161" }),
    ).toHaveAttribute("aria-checked", "true");
    await expect(send).not.toHaveAttribute("aria-disabled");
  },
};

/**
 * Pressed with no card named — the scanner found none in any of the pictures. The box opens
 * empty, asks the backend nothing, and says what typing will get; a scan the scanner could not
 * name at all is as much worth sending as one it named wrongly.
 */
export const NothingNamed: Story = {
  args: { run: RUNS.nothingNamed },
  play: async ({ canvasElement }) => {
    const dialog = await within(canvasElement).findByRole("dialog", { name: "Send this scan" });
    await expect(picture(dialog)).toHaveAttribute("src", address(PICTURES));
    await expect(within(dialog).getByRole("searchbox")).toHaveValue("");
    await expect(within(dialog).getByText(SEARCH_PROMPT)).toBeInTheDocument();
    await expect(within(dialog).queryByRole("radiogroup", { name: "Printings" })).toBeNull();
    await expect(within(dialog).getByRole("button", { name: "Send scan" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  },
};
