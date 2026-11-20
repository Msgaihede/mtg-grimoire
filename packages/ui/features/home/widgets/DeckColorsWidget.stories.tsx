import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import type {
  DeckCommanderIdentity,
  DeckFolder,
  DeckPipCosts,
  DeckRow,
  HomeWidget,
} from "@/lib/ipc";
import { makeFit, spanPx } from "../fit";
import { deckCommanderIdentitiesKey, deckFoldersKey, deckListKey, deckPipCostsKey } from "../keys";
import { patchConfig } from "../layout";
import { WidgetCard } from "../WidgetCard";
import type { WidgetBodyProps } from "../widgetProps";
import { widgetDensity } from "../widgetSettings";
import { COMBO_ROW_ATTR, DeckColorsWidget, DeckColorsWidgetSettings } from "./DeckColorsWidget";

/** The grid's target cell, so a footprint here is drawn at the size an ordinary window draws it. */
const CELL = 104;

/** A `deckColors` entry at a footprint. */
const colorsAt = (w: number, h: number, config: unknown = null): HomeWidget => ({
  id: "deckColors",
  kind: "deckColors",
  x: 0,
  y: 0,
  w,
  h,
  config,
});

/** A deck, typed against the mirror. */
function deck(over: Partial<DeckRow> & { id: number; name: string }): DeckRow {
  return {
    formatKey: "commander",
    formatName: "Commander",
    gameKey: "any",
    description: null,
    coverCardId: null,
    coverKind: "card_art",
    coverArtist: null,
    archived: false,
    cardCount: 100,
    updatedAt: 1_800_000_000,
    folderId: 1,
    notesOpen: false,
    theoryEnabled: false,
    virtualOnly: false,
    theoryMarkExact: true,
    theoryMarkName: true,
    theoryMarkUnplanned: true,
    theoryCardCount: 0,
    managedWishlist: "off",
    managedWishlistTokens: false,
    lastVariant: "live",
    lastGroupBy: "category",
    lastSortBy: "alphabetical",
    separateXGroup: false,
    defaultCategoryId: 0,
    bracket: 0,
    tags: [],
    tokensOpen: false,
    tokenMode: "managed",
    tokenRailIndex: -1,
    statsOpen: true,
    curveCreatures: false,
    todosOpen: false,
    syncUid: null,
    draft: false,
    ...over,
  };
}

/** Covers the fake's corpus can draw (`packages/fake/cards.ts`), with their illustrators. */
const BRUNA = { coverCardId: "27907985-b5f6-4098-ab43-15a0c2bf94d5", coverArtist: "Clint Cearley" };
const KENRITH = {
  coverCardId: "56c1227e-bea7-47cb-bbec-389a3d585af5",
  coverArtist: "Kieran Yanner",
};
const TYMNA = {
  coverCardId: "87eff269-c8d7-479e-ade4-383b8622e70d",
  coverArtist: "Yoshitaka Amano",
};
const THRASIOS = {
  coverCardId: "5f13417d-3fe1-4357-b826-cb48dd111247",
  coverArtist: "Square Enix",
};
const RAGAVAN = {
  coverCardId: "a9738cda-adb1-47fb-9f4c-ecd930228c4d",
  coverArtist: "Simon Dominic",
};
const AVACYN = { coverCardId: "ba149706-cd17-4da6-8403-ccfe2d6cb437", coverArtist: "Jason Chan" };

/**
 * A reader's colour sheet — the shape of the spreadsheet this widget was asked to replace: a
 * dozen Commander decks across a dozen identities, two with tags and most with a declared bracket,
 * filed in `Commander` and its `Bracket 4` subfolder, plus a Modern deck at the root (filed by its
 * cards, having no commander), an old deck in `Retired`, and a deck with nothing in it yet.
 */
const DECKS: DeckRow[] = [
  deck({ id: 1, name: "Bruna, the Fading Light", bracket: 3, ...BRUNA }),
  deck({ id: 2, name: "Orvar, the All-Form", bracket: 3, tags: ["No GC"], ...THRASIOS }),
  deck({ id: 3, name: "Xu-Ifit, Osteoharmonist", bracket: 3, ...TYMNA }),
  deck({ id: 4, name: "High Perfect Morcant", bracket: 4, folderId: 2 }),
  deck({ id: 5, name: "Alania, Divergent Storm", bracket: 3, tags: ["No GC"], ...RAGAVAN }),
  deck({ id: 6, name: "Selenia, the Cursed Heart", bracket: 3 }),
  deck({ id: 7, name: "Ozai, the Phoenix King", bracket: 3 }),
  deck({ id: 8, name: "Serah Farron", bracket: 3, tags: ["No GC"], ...AVACYN }),
  deck({ id: 9, name: "Y'shtola, Night's Blessed", bracket: 2, tags: ["Thematic Precon+"] }),
  deck({ id: 10, name: "Fire Lord Azula", bracket: 4, folderId: 2 }),
  deck({ id: 11, name: "Lightning, Long Commando", bracket: 3 }),
  deck({
    id: 12,
    name: "Jace, Multiverse Architect",
    bracket: 2,
    tags: ["Thematic Precon+"],
    ...KENRITH,
  }),
  deck({ id: 13, name: "Bruna Tokens", bracket: 2 }),
  deck({
    id: 14,
    name: "Mono Red Prowess",
    formatKey: "modern",
    formatName: "Modern",
    folderId: null,
  }),
  deck({ id: 15, name: "Old Atraxa", bracket: 4, folderId: 3 }),
  deck({ id: 16, name: "New brew", folderId: null }),
];

const IDENTITY: Record<number, string> = {
  1: "W",
  2: "U",
  3: "B",
  4: "BG",
  5: "UR",
  6: "WB",
  7: "BR",
  8: "WG",
  9: "WUB",
  10: "UBR",
  11: "WBR",
  12: "WUBR",
  13: "W",
  15: "WUBG",
};
const IDENTITIES: DeckCommanderIdentity[] = Object.entries(IDENTITY).map(([id, letters]) => ({
  deckId: Number(id),
  identity: letters,
  theoryIdentity: null,
}));
const PIPS: DeckPipCosts[] = [
  {
    deckId: 14,
    costs: [
      { cost: "{R}", copies: 20 },
      { cost: "{1}{R}", copies: 12 },
    ],
    theoryCosts: [],
  },
];
const FOLDERS: DeckFolder[] = [
  { id: 1, parentId: null, name: "Commander", sortOrder: 0 },
  { id: 2, parentId: 1, name: "Bracket 4", sortOrder: 0 },
  { id: 3, parentId: null, name: "Retired", sortOrder: 1 },
];

/**
 * A client of the story's own, its four reads already answered.
 *
 * **Why not the fake's world:** every Commander deck the seeds hold is led by Kenrith, so the
 * world's sheet is one WUBRG row, and the corpus has commanders for only four identities — a
 * sheet across a dozen colours cannot be built through the commands. The answers are typed against
 * the mirror all the same, and `StarterWorld` below draws the real reads through the fake. Its own
 * client, so nothing here leaks into the story mounted beside it on a docs page.
 */
function Seeded({ children }: { children: ReactNode }) {
  const [client] = useState(() => {
    const qc = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity, retry: false } },
    });
    qc.setQueryData(deckListKey, DECKS);
    qc.setQueryData(deckPipCostsKey, PIPS);
    qc.setQueryData(deckCommanderIdentitiesKey, IDENTITIES);
    qc.setQueryData(deckFoldersKey, FOLDERS);
    return qc;
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/**
 * The body inside the card the page draws it in, at its footprint's pixel size, with the folder
 * whitelist the page hands this kind as its `extraSettings`. The config is held here and patched
 * the way the page patches it, so a drag, a Ctrl+arrow or a settings press changes the card.
 */
function Framed({ widget: initial, editing, still, onConfig }: WidgetBodyProps) {
  const [widget, setWidget] = useState(initial);
  const fit = makeFit({
    w: widget.w,
    h: widget.h,
    widthPx: spanPx(widget.w, CELL),
    heightPx: spanPx(widget.h, CELL),
    density: widgetDensity(widget),
  });
  const patch = (fields: Record<string, unknown>) => {
    onConfig(fields);
    setWidget(
      (current) => patchConfig({ version: 2, widgets: [current] }, current.id, fields).widgets[0],
    );
  };
  return (
    <div style={{ width: fit.widthPx, height: fit.heightPx }}>
      <WidgetCard
        widget={widget}
        fit={fit}
        editing={editing}
        still={still}
        onConfig={patch}
        onRemove={fn()}
        extraSettings={<DeckColorsWidgetSettings widget={widget} onConfig={patch} />}
      >
        <DeckColorsWidget
          widget={widget}
          fit={fit}
          editing={editing}
          still={still}
          onConfig={patch}
        />
      </WidgetCard>
    </div>
  );
}

const DEFAULT_WIDGET = colorsAt(4, 4);

const meta = {
  title: "Home/DeckColorsWidget",
  component: DeckColorsWidget,
  tags: ["autodocs"],
  args: {
    widget: DEFAULT_WIDGET,
    fit: makeFit({
      w: 4,
      h: 4,
      widthPx: spanPx(4, CELL),
      heightPx: spanPx(4, CELL),
      density: "comfortable",
    }),
    editing: false,
    still: false,
    onConfig: fn(),
  },
  render: (args) => (
    <Seeded>
      <Framed {...args} />
    </Seeded>
  ),
  parameters: {
    docs: {
      description: {
        component:
          "Every color combination in Magic — the five mono colors and colorless, ten pairs, ten " +
          "triples, five four-color combinations and WUBRG — with the reader's decks in each, " +
          "and the empty ones drawn empty: a colour-coverage sheet kept for the reader.\n\n" +
          "A Commander deck is filed by its **command zone's color identity**; a deck with no " +
          "commander by the colors its cards' mana costs ask for (the gallery's color bar, `{C}` " +
          "left out). A chip shows the deck's name or cover, its **declared** bracket and its " +
          "tags, and opens the deck. Decks inside a combination are arranged by dragging one onto " +
          "another, or with Ctrl+← / Ctrl+→. Settings: name or cover art, all decks or the first " +
          "with `+N`, alphabetical or color-pie order, and a **folder whitelist** with or without " +
          "subfolders.",
      },
    },
  },
} satisfies Meta<typeof DeckColorsWidget>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The catalogue's footprint: four by four, nothing configured. */
export const Sheet: Story = {
  play: async ({ canvasElement }) => {
    await waitFor(() =>
      expect(canvasElement.querySelectorAll(`[${COMBO_ROW_ATTR}]`)).toHaveLength(32),
    );
    const canvas = within(canvasElement);
    await expect(canvas.getByText("14 of 32 colors · 15 decks")).toBeInTheDocument();
  },
};

/** Covers instead of names — the art crop where the deck has one, its name on the felt where not. */
export const CoverArt: Story = {
  args: { widget: colorsAt(4, 5, { face: "art" }) },
};

/** One deck a color, and `+N` for the rest. */
export const FirstOnly: Story = {
  args: { widget: colorsAt(4, 4, { limit: "first" }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const more = await canvas.findByRole("button", { name: "Show 1 more deck in Mono White" });
    await userEvent.click(more);
    await expect(more).toHaveAttribute("aria-expanded", "true");
  },
};

/** The whole sheet at once on an eight-cell card — the sections in balanced columns. */
export const Wide: Story = {
  args: { widget: colorsAt(8, 5, { sort: "pie" }) },
};

/** A two-cell tile: the symbols are the name. */
export const Tile: Story = {
  args: { widget: colorsAt(2, 4) },
};

/** Only the combinations with a deck. */
export const CoveredOnly: Story = {
  args: { widget: colorsAt(4, 4, { empty: false }) },
};

/** Counting only `Commander` and what is under it — the Modern deck at the root and the retired
 *  one drop out. Open the settings to change the whitelist. */
export const ChosenFolders: Story = {
  args: { widget: colorsAt(4, 4, { scope: "chosen", folderIds: [1] }) },
};

/** The fake's own world through the real reads: two Kenrith decks, so one WUBRG row. */
export const StarterWorld: Story = {
  render: (args) => <Framed {...args} />,
};
