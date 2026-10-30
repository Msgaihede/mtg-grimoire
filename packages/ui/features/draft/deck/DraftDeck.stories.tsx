import { useQuery } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { CardDetailModal } from "@/features/card/CardDetailModal";
import { DeckEditor } from "@/features/decks/DeckEditor";
import { ipc } from "@/lib/ipc";

/**
 * A drafted pool in the deck editor's draft mode (spec §5): the deck is made the way the Build
 * panel makes it — `draft_deck_create` with a pool of the fake corpus — and opened in the real
 * `DeckEditor`, which finds it on the unsaved draft list and draws the draft bar in place of the
 * card search dock and Quick Add.
 */
function DraftDeck({ commander }: { commander: boolean }) {
  const made = useQuery({
    queryKey: ["story", "draft-deck", commander],
    queryFn: async () => {
      const sets = await ipc.packsBoosterSets();
      const booster = await ipc.packsBoosterSet(sets[0].code, false);
      const pool = booster.cards.slice(0, commander ? 60 : 45).map((c) => c.cardId);
      return ipc.draftDeckCreate(commander ? "Commander Draft" : "Quick Draft", pool, commander);
    },
    staleTime: Infinity,
  });
  return (
    <div className="flex h-full min-h-0">
      <div className="min-w-0 flex-1">
        {made.data && <DeckEditor key={made.data.id} deckId={made.data.id} />}
      </div>
      <CardDetailModal />
    </div>
  );
}

const meta = {
  title: "Draft/Draft deck",
  component: DraftDeck,
  args: { commander: false },
  decorators: [
    (Story) => (
      <div className="h-[860px] w-[1280px] bg-bg p-5">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DraftDeck>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A Limited draft deck: the pool in its Pool pile, the draft bar, and no search dock. */
export const Limited: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("region", { name: "Draft deck" }, { timeout: 5000 }),
    ).toBeVisible();
    await expect(canvas.queryByRole("button", { name: "Import cards" })).not.toBeInTheDocument();
  },
};

/** A Commander draft's deck: a Casual deck with a Commander pile, and the bar's 60-card check. */
export const Commander: Story = {
  args: { commander: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("region", { name: "Draft deck" }, { timeout: 5000 }),
    ).toBeVisible();
  },
};
