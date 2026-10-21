import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { ipc, type DeckSupport } from "@/lib/ipc";
import { PlaytestingPage } from "./PlaytestingPage";
import { supportKey } from "./support";

/**
 * What the rules engine says of every seeded deck, put in the story's cache before the lobby asks.
 *
 * **The fake answers no `playtest_support`, on purpose** (`packages/fake/parity.test.ts`: what the
 * engine plays of a deck is Rust's to say, from phase's parser), so without this every mark on
 * the page would be the "could not be checked" one. The first deck is played in part — one card,
 * three copies — and every other deck whole, which is the pair of marks the lobby draws. The
 * defaults make the seeded answers final, so the lobby never asks the fake and is refused.
 */
function WithEngineAnswers() {
  const client = useQueryClient();
  const staged = useQuery({
    queryKey: ["story", "playtest-support"],
    queryFn: async () => {
      client.setQueryDefaults(["decks", "playtestSupport"], { staleTime: Infinity, retry: false });
      const decks = await ipc.deckList();
      decks.forEach((deck, i) => {
        const support: DeckSupport =
          i === 0
            ? {
                cards: deck.cardCount,
                unsupported: [
                  {
                    cardId: "story-partial",
                    name: "Moonlit Bard",
                    quantity: 3,
                    commander: false,
                    gaps: ["Trigger:Whenever the moon is full"],
                  },
                ],
              }
            : { cards: deck.cardCount, unsupported: [] };
        for (const variant of ["theory", "live"] as const) {
          client.setQueryData(supportKey({ deckId: deck.id, variant }), support);
        }
      });
      return true;
    },
    staleTime: Infinity,
  });
  return staged.isSuccess ? <PlaytestingPage /> : null;
}

const meta = {
  title: "Playtesting/Lobby",
  component: PlaytestingPage,
  tags: ["autodocs"],
  render: () => <WithEngineAnswers />,
  decorators: [
    // The Decks gallery story's content column — 1032px is what the 1280×800 window leaves the
    // page — and tall enough for four seats, which is the lobby's tallest panel.
    (Story) => (
      <div className="h-[720px] w-[1032px] bg-bg">
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "The Playtesting lobby: the reader's decks on the left, drawn and walked exactly as " +
          "the Decks page draws them but only ever **picked** — no menus, drags, renames or " +
          "Create — and the table on the right: the gamemode, a seat for every player, the " +
          "AI's skill and Start.\n\n" +
          "One seat is always the one being picked for (ringed, and named over the wall); a " +
          "deck pressed on the wall sits there and the next empty seat is up. A deck that keeps " +
          "a plan seats with the editor's Theory | Actual switch. What the rules engine plays " +
          "of a deck is a mark — ✓, or ⚠ with how many cards it plays only in part, which " +
          "opens the cards under the seat.",
      },
    },
  },
} satisfies Meta<typeof PlaytestingPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A duel, with both decks seated from the wall in turn — and Start lit once they are. */
export const Duel: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const start = await canvas.findByRole("button", { name: "Start game" });
    await expect(start).toHaveAttribute("aria-disabled", "true");
    await expect(canvas.getByRole("button", { name: /^You:/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await userEvent.click(canvas.getByRole("button", { name: /^Kenrith Two-Drops/ }));
    await expect(canvas.getByRole("button", { name: /^Opponent:/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await userEvent.click(canvas.getByRole("button", { name: /^Modern Goodstuff/ }));
    await expect(canvas.getByRole("button", { name: "Opponent: Modern Goodstuff" })).toBeVisible();
    await expect(start).toHaveAttribute("aria-disabled", "false");
  },
};

/** Three opponents, each seat filled in turn round the table. */
export const FourPlayer: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const modes = await canvas.findByRole("group", { name: "Gamemode" });
    await userEvent.click(within(modes).getByRole("button", { name: /^Four-player/ }));
    for (const name of ["Kenrith Two-Drops", "Modern Goodstuff", "Kenrith Two-Drops"]) {
      await userEvent.click(canvas.getByRole("button", { name: new RegExp(`^${name}`) }));
    }
    await expect(canvas.getByText("Pick a deck for Opponent 3 to start.")).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: /^Modern Goodstuff/ }));
    await expect(canvas.getByRole("button", { name: "Start game" })).toHaveAttribute(
      "aria-disabled",
      "false",
    );
  },
};

/** Against the goldfish: no opponent to pick and no skill to set — the reader's deck alone. */
export const Goldfish: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const modes = await canvas.findByRole("group", { name: "Gamemode" });
    await userEvent.click(within(modes).getByRole("button", { name: /^Goldfish/ }));
    await expect(canvas.queryByRole("group", { name: "AI skill" })).toBeNull();
    await expect(canvas.getByText("Plays nothing")).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: /^Modern Goodstuff/ }));
    await expect(canvas.getByRole("button", { name: "Start game" })).toHaveAttribute(
      "aria-disabled",
      "false",
    );
  },
};

/** Walking into a folder, as the gallery does: the path over the wall and the way back up on it. */
export const InAFolder: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const wall = await canvas.findByRole("list", { name: "Your decks" });
    const [folder] = within(wall).getAllByRole("button", { name: /folder, [1-9]\d* decks?$/ });
    await userEvent.click(folder);
    await expect(canvas.getByRole("navigation", { name: "Folder path" })).toBeVisible();
    await expect(canvas.getByRole("button", { name: /^Up one level/ })).toBeVisible();
  },
};

/** No decks at all: the lobby says what it needs rather than drawing an empty table. */
export const NoDecks: Story = {
  parameters: { fake: { seed: "empty" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(/needs a deck to play/)).toBeVisible();
  },
};
