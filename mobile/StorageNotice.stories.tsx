import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { CLEARED_LINES, CLEARED_TITLE } from "@/lib/core/web/storage";
import { StorageNoticeCard } from "./StorageNotice";

/**
 * The notice that the host's storage was cleared under the app, drawn from an answer.
 *
 * **The words are the web host's own** — `storage.ts` in `src/lib/core/web/`, the one host that
 * can be in this state — and the card draws whatever it is handed. `StorageNotice`, which
 * `LightApp` mounts, is this card behind a question only that host answers; over the Storybook
 * fake the question is refused and nothing is drawn, so the story stands on the card.
 *
 * **Boxed, and the box is a containing block.** The card is `fixed` to the top of the window
 * because that is where it is read over either face; on a docs page of several stories it would
 * pin itself to the page. A transformed ancestor is the containing block for a `fixed`
 * descendant, so each story keeps its notice inside its own phone-sized frame.
 */
const meta = {
  title: "Light/StorageNotice",
  component: StorageNoticeCard,
  tags: ["autodocs"],
  args: {
    notice: { at: Date.UTC(2026, 9, 4, 12), title: CLEARED_TITLE, lines: [...CLEARED_LINES] },
    onDismiss: fn(),
  },
  decorators: [
    (Story, { parameters }) => (
      <div
        className="h-[30rem] max-w-full overflow-hidden bg-bg"
        style={{
          width: (parameters.frameWidth as number | undefined) ?? 360,
          transform: "translateZ(0)",
        }}
      >
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "Shown once when a browser has cleared what the app had stored: what happened, what " +
          "is being rebuilt by itself (the card data) and what is not coming back from this " +
          "browser alone (a collection, a wishlist and decks kept only there) — and, for a " +
          "browser that may have been paired, that its old entry still holds a place in its " +
          "group and where to remove it. Not a modal — a " +
          "card at the top of the window, announced as it arrives, with one button to put it " +
          "away. It is drawn on the first-run screen's own layer and after it in the document, " +
          "so it is read over the download it explains.",
      },
    },
  },
} satisfies Meta<typeof StorageNoticeCard>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A narrow phone: the card spans the frame, less its gutters. */
export const Phone: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const alert = canvas.getByRole("alert");
    await expect(alert).toHaveTextContent("Your browser cleared MTG Grimoire's saved data");
    await expect(alert).toHaveTextContent("The card data downloads again by itself.");
    await expect(alert).toHaveTextContent(/collection, wishlist and decks/);
    // The paragraph for a browser that was one of the reader's paired devices: an *if*, because
    // the page cannot know, and where the old device's entry is removed.
    await expect(alert).toHaveTextContent(/If this browser was paired with your other devices/);
    await expect(alert).toHaveTextContent(/Remove the old entry in Settings, under Sync/);
    await expect(canvas.getByRole("region")).toHaveAccessibleName(
      "Your browser cleared MTG Grimoire's saved data",
    );

    await userEvent.click(canvas.getByRole("button", { name: "Got it" }));
    await expect(args.onDismiss).toHaveBeenCalledOnce();
  },
};

/** Past the desktop floor, where it is read over the first-run screen: capped, and centred. */
export const Wide: Story = {
  parameters: { frameWidth: 1024 },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("button", { name: "Got it" })).toBeVisible();
  },
};
