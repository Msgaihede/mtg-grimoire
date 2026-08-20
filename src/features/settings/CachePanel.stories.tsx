import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { CachePanel } from "./CachePanel";
import type { LocalCache } from "./useDataReset";

function cache(over: Partial<LocalCache> = {}): LocalCache {
  return {
    clear: { run: fn(), pending: false },
    status: null,
    ...over,
  };
}

const meta = {
  title: "Settings/CachePanel",
  component: CachePanel,
  tags: ["autodocs"],
  args: { cache: cache() },
  decorators: [
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
          "The one button on the Settings page that deletes something and destroys nothing.\n\n" +
          "It sweeps `data/images/` — the picture cache, measured at 5,540 files and 330 MB on " +
          "the dev machine — and `data/tmp/`, where the three bulk downloads land. Both are " +
          "fetched again on demand with no user action, which is the whole definition this " +
          "button works to: `Cache::get` already treats a row whose file is gone as a miss.\n\n" +
          "**What it deliberately leaves alone** is as much of the design as what it takes. " +
          "`data/covers/` holds the pictures a reader *chose* for their decks — safe to delete " +
          "in the sense that the deck falls back to card art, and not safe in the sense that " +
          "only they can pick it again. The price and Oracle Tag tables stay too: those " +
          "re-download on a **button** rather than on demand, so emptying them would leave " +
          "every price an em dash until someone noticed.\n\n" +
          "So the confirmation asks for no typed word — see `ConfirmDialog`'s " +
          "`typeToConfirm`, and the short version is that a word typed on every dialog is a " +
          "word nobody reads, which is what would make it useless on the three below.",
      },
    },
  },
} satisfies Meta<typeof CachePanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The panel as it is found. The promise on its face is what separates it from the danger zone. */
export const Resting: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/are not touched/)).toBeInTheDocument();
  },
};

/**
 * The plain confirmation, and the absence is the story: no field, and the destructive button
 * is armed from the first frame.
 */
export const Confirming: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const page = within(document.body);

    await userEvent.click(canvas.getByRole("button", { name: "Clear cache" }));
    const dialog = await page.findByRole("dialog");

    await expect(within(dialog).queryByRole("textbox")).not.toBeInTheDocument();
    const confirm = within(dialog).getByRole("button", { name: "Clear cache" });
    await expect(confirm).toBeEnabled();

    await userEvent.click(confirm);
    await expect(args.cache.clear.run).toHaveBeenCalled();
  },
};

/** What it freed, at the size a real library's cache actually reaches. */
export const Freed: Story = {
  args: {
    cache: cache({ status: { tone: "plain", text: "Freed 330 MB across 5,540 files." } }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("alert")).toHaveTextContent("Freed 330 MB across 5,540 files.");
  },
};

/**
 * A file another thread had open, which on Windows cannot be unlinked.
 *
 * Its own sentence rather than a parenthesis: the first says what happened, the second says
 * what did not. Pressing again a moment later usually takes it.
 */
export const SomeFilesWereInUse: Story = {
  args: {
    cache: cache({
      status: {
        tone: "plain",
        text: "Freed 314 MB across 5,537 files. 3 files were in use and stayed.",
      },
    }),
  },
};

/**
 * The one refusal this command has, and the reason it is fenced at all: `data/tmp/` is where
 * the corpus download puts 77 MB that the ingest then reads back, so a sweep landing between
 * the two would fail a 90-second job the reader is watching a progress bar for.
 */
export const RefusedMidSync: Story = {
  args: {
    cache: cache({
      status: {
        tone: "problem",
        text: "a card update is running — clear the cache once it has finished",
      },
    }),
  },
};

/** The sweep in flight. 5,540 files is a walk, not an instant. */
export const Working: Story = {
  args: { cache: cache({ clear: { run: fn(), pending: true } }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: "Clear cache" })).toBeDisabled();
  },
};
