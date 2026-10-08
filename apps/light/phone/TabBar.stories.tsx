import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { TabBar } from "./TabBar";

/**
 * The phone face's five destinations, at a phone's width.
 *
 * **Each tab is a real link**, so a press in the canvas would move the workbench's own frame to
 * `/decks`. The decorator swallows it in the capture phase: the router takes only a click nothing
 * has already handled (`linkTo`), and a prevented one is the browser's to drop. A story is one
 * window, and its URL is the workbench's rather than the app's.
 */
const meta = {
  title: "Phone/TabBar",
  component: TabBar,
  tags: ["autodocs"],
  args: { view: "search" },
  decorators: [
    (Story) => (
      <div className="w-[360px] max-w-full bg-bg" onClickCapture={(e) => e.preventDefault()}>
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "The bottom bar of the phone face. Its words and glyphs are the desktop rail's, read " +
          "out of `NAV`; Settings is not a tab but the top bar's control. The lit tab is the one " +
          "the URL names, said to a screen reader as `aria-current`. It pads by the bottom " +
          "safe-area inset, which is zero everywhere but under a phone's home indicator.",
      },
    },
  },
} satisfies Meta<typeof TabBar>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Where a cold start lands. */
export const OnSearch: Story = {
  play: async ({ canvasElement }) => {
    const bar = within(canvasElement).getByRole("navigation", { name: "Views" });
    await expect(
      within(bar)
        .getAllByRole("link")
        .map((tab) => tab.textContent),
    ).toEqual(["Search", "Decks", "Collection", "Wishlist", "Scanner"]);
    await expect(within(bar).getByRole("link", { name: "Search" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  },
};

/** Another tab lit — and every tab is a link with a real address. */
export const OnDecks: Story = {
  args: { view: "decks" },
  play: async ({ canvasElement }) => {
    const bar = within(canvasElement).getByRole("navigation", { name: "Views" });
    await expect(within(bar).getByRole("link", { name: "Decks" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(within(bar).getByRole("link", { name: "Wishlist" })).toHaveAttribute(
      "href",
      "/wishlist",
    );
  },
};

/** Settings is the top bar's: on it, no tab is lit. */
export const OnSettings: Story = {
  args: { view: "settings" },
};
