import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { FeedDownloadDialog } from "./FeedDownloadDialog";

const meta = {
  title: "PWA/FeedDownloadDialog",
  component: FeedDownloadDialog,
  tags: ["autodocs"],
  args: {
    open: true,
    feed: "corpus",
    size: { bytes: 77_972_714, exact: true },
    link: { metered: false, why: null },
    preferred: "download",
    onDownload: fn(),
    onNotNow: fn(),
  },
  decorators: [
    // The dialog is `fixed inset-0`. A transformed ancestor is the containing block for a
    // `fixed` descendant, so `transform-gpu` boxes each story into its own frame — the same
    // trick `Chrome/SyncProgress` uses, for the same reason.
    (Story) => (
      <div className="relative h-[24rem] w-full transform-gpu">
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "Spec §5.3: on web and Android, any feed over 5 MB shows its **measured** size, and " +
          "where the link reports itself metered it says so and defaults to *Not now*.\n\n" +
          "**The number is the feed's own.** Scryfall's `compressed_size` out of the bulk " +
          "descriptor — the same field `scryfall.rs` reads, so the prompt shows what the " +
          "download will report — and a `Content-Length` for the Spellbook combo feed " +
          "(verified live 2026-08-28: 27,558,428).\n\n" +
          "**No browser exposes a metered bit**, so the sentence comes from three stand-ins: " +
          "`saveData` (the reader *chose* less data, the strongest of the three), a `cellular` " +
          "connection type, and a 2G `effectiveType`. Firefox and Safari expose none of them, " +
          "and **absent is not metered** — defaulting two whole browsers to Not now would be " +
          "worse than not asking.\n\n" +
          "Desktop never draws this: the guard around it is a synchronous pass-through when " +
          "`isWebTarget()` is false, so the dialog is never constructed.",
      },
    },
  },
} satisfies Meta<typeof FeedDownloadDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The corpus on a link nothing has anything to say about. 78.0 MB, and Download is armed. */
export const OnAnOrdinaryLink: Story = {
  play: async ({ canvasElement, args }) => {
    const page = within(document.body);
    const dialog = await page.findByRole("dialog");
    await expect(dialog).toHaveTextContent(/the card database/);
    await expect(dialog).toHaveTextContent(/78\.0 MB/);
    await expect(within(dialog).getByRole("button", { name: "Download" })).toHaveFocus();
    await userEvent.click(within(dialog).getByRole("button", { name: "Download" }));
    await expect(args.onDownload).toHaveBeenCalledTimes(1);
    // The decorator's box has to exist for the fixed panel to be laid out in it.
    await expect(canvasElement).toBeInTheDocument();
  },
};

/**
 * Data Saver on. The lean is a **caret**, not a colour: Not now opens focused, so the reader
 * who presses Enter without reading gets the answer their own setting asked for.
 */
export const OnDataSaver: Story = {
  args: {
    link: { metered: true, why: "Data Saver is on." },
    preferred: "not-now",
  },
  play: async ({ args }) => {
    const page = within(document.body);
    const dialog = await page.findByRole("dialog");
    await expect(dialog).toHaveTextContent(/Data Saver is on/);
    await expect(within(dialog).getByRole("button", { name: "Not now" })).toHaveFocus();
    await userEvent.click(within(dialog).getByRole("button", { name: "Not now" }));
    await expect(args.onNotNow).toHaveBeenCalledTimes(1);
    // Not now runs nothing at all: there is no queue and nothing is retried later.
    await expect(args.onDownload).not.toHaveBeenCalled();
  },
};

/**
 * The feed nobody can size, and the reason this state exists at all.
 *
 * Card Kingdom's pricelist answers a HEAD with `text/html` and no `Content-Length`, and the
 * feed is paginated — verified live 2026-08-28. The price research measured 66,787,283 B
 * uncompressed in August; reprinting that here would be a figure the app cannot confirm, so the
 * dialog says what it knows. An unknown size always asks.
 */
export const AFeedNobodyCanSize: Story = {
  args: {
    feed: "card-kingdom",
    size: { bytes: null, exact: false },
    link: { metered: true, why: "You appear to be on mobile data." },
    preferred: "not-now",
  },
  play: async () => {
    const dialog = await within(document.body).findByRole("dialog");
    await expect(dialog).toHaveTextContent(/size is not published/);
    await expect(dialog).toHaveTextContent(/mobile data/);
  },
};

/** Closed is nothing mounted at all — `Dialog`'s own guarantee, and worth asserting. */
export const Closed: Story = {
  args: { open: false },
  play: async () => {
    await expect(within(document.body).queryByRole("dialog")).not.toBeInTheDocument();
  },
};
