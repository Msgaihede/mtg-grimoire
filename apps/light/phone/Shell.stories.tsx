import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, waitFor, within } from "storybook/test";
import { printing } from "@grimoire/fake/fixtures";
import { CardWall, type WallItem } from "./CardWall";
import { wallItem } from "./wallItem";
import { Shell } from "./Shell";

/** A few real printings for the page between the bars — the wall every phone page draws. */
const ITEMS: WallItem[] = [
  printing("lea", "161"),
  printing("lea", "288"),
  printing("mh2", "138"),
  printing("pcy", "45"),
  printing("c21", "263"),
  printing("fut", "153"),
].map((card) => wallItem(card));

/**
 * The phone face's frame, in a phone-sized box.
 *
 * **Boxed rather than drawn at the viewport**, for `StartupScreen`'s reason: the shell is `h-dvh`
 * because it is the window, and a docs page of several should show several phones rather than
 * one canvas each. The box is 360 × 720 — the narrow phone every page is checked at — and the
 * width is a parameter so the 800px check is one story.
 *
 * **Its links do not navigate here.** The tabs and the Settings control are real links, and a
 * press would move the workbench's own frame; the decorator swallows it in the capture phase,
 * which `linkTo` reads as a click already handled. The lit tab is the one the URL names, and the
 * workbench's URL names none of the app's — so it is the start view's, Search, as a cold start's
 * is.
 */
const meta = {
  title: "Phone/Shell",
  component: Shell,
  tags: ["autodocs"],
  args: {
    title: "Search",
    children: <CardWall label="Search results" items={ITEMS} onOpen={fn()} resetKey="shell" />,
  },
  decorators: [
    (Story, { parameters }) => (
      <div
        className="h-[45rem] max-w-full overflow-hidden [&>div]:h-full"
        style={{ width: (parameters.phoneWidth as number | undefined) ?? 360 }}
        onClickCapture={(e) => e.preventDefault()}
      >
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "A title row with the Settings control, the mana line at rest, the page, and the tab " +
          "bar. The page between the bars owns its own scrolling; the frame never scrolls. All " +
          "four safe-area insets are the frame's — the header takes the top, the tab bar the " +
          "bottom, the frame itself the two sides a landscape cutout would sit in.",
      },
    },
  },
} satisfies Meta<typeof Shell>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A narrow phone, on the start view. */
export const Phone: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1, name: "Search" })).toBeInTheDocument();
    await expect(canvas.getByRole("link", { name: "Settings" })).toHaveAttribute(
      "href",
      "/settings",
    );
    await expect(canvas.getByRole("link", { name: "Search" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    // The page is drawn between the bars, and is the wall's to scroll.
    await waitFor(() =>
      expect(
        within(canvas.getByRole("main")).getByRole("button", { name: ITEMS[0].pressLabel }),
      ).toBeInTheDocument(),
    );
  },
};

/** The same frame at 800px, the widest of the two widths every phone page is checked at. */
export const Wide: Story = {
  parameters: { phoneWidth: 800 },
};

/** A long title is cut, never wrapped — the bar is one row high on every page. */
export const LongTitle: Story = {
  args: { title: "Dimir Control — the one with every counterspell in the binder" },
};
