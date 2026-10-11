import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { RANK } from "@grimoire/ui/lib/activity";
import { NoCards } from "./NoCards";

/**
 * What a phone card search says over an empty answer. Three sentences, picked by whether the
 * database is empty and whether the card sync is running — a search that missed, a first run
 * downloading, and an empty database with nothing coming.
 */
const meta = {
  title: "Phone/NoCards",
  component: NoCards,
  tags: ["autodocs"],
  args: { empty: false, sync: null, error: null },
  decorators: [
    (Story) => (
      <div className="w-[360px] max-w-full bg-bg">
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "Drawn by the phone's `SearchResults` where the wall would be. *No cards match.* only " +
          "when there are cards to have missed: over an empty database it says what a first run " +
          "is doing, in the desktop ribbon's words, or that there is no card data yet.",
      },
    },
  },
} satisfies Meta<typeof NoCards>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A search that answered nothing over a full database. */
export const NoMatch: Story = {
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("No cards match.")).toBeInTheDocument();
  },
};

/** A first run, part way through the download: the phase announced, the count beside it. */
export const FirstRunDownloading: Story = {
  args: {
    empty: true,
    sync: {
      key: "sync",
      rank: RANK.sync,
      label: "Downloading card data",
      detail: "31 / 77 MB",
      value: 0.4,
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("status")).toHaveTextContent("Downloading card data");
    await expect(canvas.getByText("31 / 77 MB")).toBeInTheDocument();
    await expect(canvas.queryByText("No cards match.")).toBeNull();
  },
};

/** An empty database and nothing running — *Not now* on a metered link, say. */
export const NoCardData: Story = {
  args: { empty: true },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText(/No card data yet/)).toBeInTheDocument();
  },
};

/** …and after a first download that failed, with its reason. */
export const FirstRunFailed: Story = {
  args: { empty: true, error: "Couldn't reach Scryfall: connection timed out" },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText("Couldn't reach Scryfall: connection timed out"),
    ).toBeInTheDocument();
  },
};
