import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { CARDS, type FakeCard } from "@grimoire/fake/cards";
import { ipc, type BoosterCard, type BoosterSet, type BoosterSheet } from "@/lib/ipc";
import { boosterSetKey } from "../sets";
import { PackOpener } from "./PackOpener";

const PAPER = CARDS.filter((c) => c.isPaper);

function sheet(name: string, cards: readonly FakeCard[], over: Partial<BoosterSheet> = {}) {
  return {
    name,
    foil: false,
    fixed: false,
    allowDuplicates: false,
    balanceColors: false,
    totalWeight: cards.length,
    cards: cards.map((c) => ({ cardId: c.id, weight: c.rarity === "mythic" ? 1 : 2 })),
    ...over,
  } satisfies BoosterSheet;
}

/**
 * One set's booster data, made of the fake corpus — every story set gets the same sheets, all
 * fifty-odd printings across sets, the way a box topper names another set's cards.
 *
 * **The fake answers no `packs_booster_set`** (MTGJSON's file is the desktop host's to fetch; the
 * fake's handler is another change's), so the story seeds each set's cache entry before the page
 * asks: `useBoosterSet` keeps an answer for good (`staleTime: Infinity`), so the page never asks
 * the fake. Prices are the fake's own `printing_prices`.
 */
function boosterSetOf(code: string, name: string): BoosterSet {
  const commons = PAPER.filter((c) => c.rarity === "common");
  const uncommons = PAPER.filter((c) => c.rarity === "uncommon");
  const rares = PAPER.filter((c) => c.rarity === "rare" || c.rarity === "mythic");
  const facts: BoosterCard[] = PAPER.map((c) => ({
    cardId: c.id,
    name: c.name,
    setCode: c.setCode,
    collectorNumber: c.collectorNumber,
    rarity: c.rarity,
    typeLine: c.typeLine,
    manaCost: c.manaCost,
    cmc: c.cmc,
    colors: c.colors,
    inCorpus: true,
  }));
  const sheets = [
    sheet("common", commons, { balanceColors: true }),
    sheet("uncommon", uncommons),
    sheet("rareMythic", rares),
    sheet("foil", PAPER, { foil: true }),
  ];
  return {
    code,
    name,
    releaseDate: null,
    products: [
      {
        key: "play",
        name: `${name} Play Booster`,
        totalWeight: 4,
        variants: [
          {
            weight: 3,
            slots: [
              { sheet: "common", count: 6 },
              { sheet: "uncommon", count: 3 },
              { sheet: "rareMythic", count: 1 },
            ],
          },
          {
            weight: 1,
            slots: [
              { sheet: "common", count: 5 },
              { sheet: "uncommon", count: 3 },
              { sheet: "rareMythic", count: 1 },
              { sheet: "foil", count: 1 },
            ],
          },
        ],
        sheets,
      },
    ],
    sealed: [
      {
        uuid: `${code}-box`,
        name: `${name} Play Booster Box`,
        category: "booster_box",
        subtype: "play",
        packs: [{ set: code, product: "play", count: 6 }],
        sealed: [],
        cards: [],
      },
    ],
    cards: facts,
    fetchedAt: Date.UTC(2026, 9, 29),
  };
}

function WithBoosterData() {
  const client = useQueryClient();
  const staged = useQuery({
    queryKey: ["story", "booster-data"],
    queryFn: async () => {
      for (const set of await ipc.listSets()) {
        client.setQueryData(boosterSetKey(set.code), boosterSetOf(set.code, set.name));
      }
      return true;
    },
    staleTime: Infinity,
  });
  return staged.isSuccess ? <PackOpener onBack={() => {}} /> : null;
}

const meta = {
  title: "Draft/Open Packs",
  component: PackOpener,
  tags: ["autodocs"],
  args: { onBack: () => {} },
  render: () => <WithBoosterData />,
  decorators: [
    (Story) => (
      <div className="h-[760px] w-[1032px] bg-bg pl-6">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PackOpener>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The first step: every set the corpus has, as tiles. */
export const ChooseSet: Story = {};

/** A set picked and a booster opened: the cards by price, and the product's figures beside. */
export const Opened: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const wall = await canvas.findByRole("list", { name: "Sets to open" });
    await userEvent.click(within(wall).getAllByRole("button")[0]);
    await userEvent.click(await canvas.findByRole("button", { name: "Open" }));
    const opened = await canvas.findByRole("list", { name: "Opened cards" });
    await expect(within(opened).getAllByRole("listitem")).toHaveLength(10);
    await expect(await canvas.findByRole("complementary", { name: "Figures" })).toBeVisible();
  },
};
