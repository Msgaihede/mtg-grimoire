import { useState, type ReactNode } from "react";
import type { Decorator, Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import type {
  DeckCard,
  DeckCategory,
  DeckDetail,
  DeckRow,
  DeckTag,
  DeckVariant,
  TagColor,
  TagSuggestion,
} from "@/lib/ipc";
import { registerCommands } from "../../../.storybook/fake/core";
import { deckCard, deckCategory, printing } from "../../../.storybook/fake/fixtures";
import { CategoriesPanel } from "./CategoriesPanel";

/**
 * # A backend this file brings with it
 *
 * **`.storybook/fake/db.ts` answers none of the eleven commands this panel lives on** —
 * `deck_category_*`, `deck_tag_*` and `deck_tag_suggestions` are schema v8's, and teaching the
 * shared fake about them is a later task on this plan. Without them every story here would draw
 * one sentence — *No fake handler registered for command "deck_category_list"* — which
 * catalogues nothing and plays nothing.
 *
 * So this file registers a small world of its own through `registerCommands`, which exists for
 * exactly this ("a story adds a command or overrides one without restating the rest") and is
 * the only entry point into the fake that does not mean editing it. **When the shared fake
 * learns these commands, delete {@link withMeta} and the two builders under it** — a
 * `registerCommands` merge *overrides*, so this shim would otherwise go on answering in front
 * of the real one and quietly outlive the reason it was written.
 *
 * Two mechanics make it safe on a docs page, where every story is mounted at once:
 *
 * * The registration is a `useState` **initializer**, so it runs exactly once, during this
 *   story's first render — the render in which `preview.tsx`'s `installWorld` has just pointed
 *   the fake at this story's own scope. A later render could see whichever story committed
 *   last, so nothing is registered on one.
 * * Every story gets its **own rows**, built fresh by that initializer. Two stories on one page
 *   therefore rename, reorder and delete independently, which is what a docs page of eight
 *   stories has to survive.
 *
 * `deck_get` is answered here too, and only because one control needs it: "Auto-categorise from
 * card types" reads **type lines**, so `useDeckMeta` is handed cards rather than ids.
 */

/* ------------------------------------------------------------------ the fixtures ------- */

/** The four `schema::PREDEFINED_CATEGORIES` — `deckCategory`'s own table, so a story's
 *  Commander is the same row the deck editor's stories draw. */
function predefined(): DeckCategory[] {
  return [
    deckCategory("commander"),
    deckCategory("side"),
    deckCategory("companion"),
    deckCategory("maybe"),
  ];
}

/** A pile the reader made. `kind: "main"` is the whole of what makes it theirs to rename,
 *  reorder and delete. */
function made(
  id: number,
  name: string,
  over: Partial<DeckCategory> = {},
): DeckCategory {
  return {
    id,
    deckId: 1,
    name,
    kind: "main",
    isActive: true,
    sortOrder: id,
    cardCount: 0,
    totalPriceUsd: null,
    ...over,
  };
}

/** The pile schema v8's migration files every legacy `main` row into — an ordinary user
 *  category, and the one "Auto-categorise" is allowed to empty. */
const MAIN_DECK = 20;

/**
 * Eight printings in "Main deck", which is where a plain add goes.
 *
 * They are the cards the auto-categoriser has something to say about: two creatures, an
 * instant, a sorcery, an artifact, an enchantment and two lands — so pressing the button in a
 * story really does file them, through the real `autoCategoryFor` over real type lines.
 */
function loose(): DeckCard[] {
  const filed = { categoryId: MAIN_DECK, categoryName: "Main deck", categoryActive: true } as const;
  return [
    deckCard(printing("lea", "161"), filed), // Instant
    deckCard(printing("mh2", "138"), filed), // Creature
    deckCard(printing("isd", "51"), filed), // Creature
    deckCard(printing("lea", "288"), { ...filed, quantity: 4 }), // Land
    deckCard(printing("mh2", "267"), filed),
    deckCard(printing("nph", "57"), filed),
  ];
}

const TAGS: DeckTag[] = [
  { id: 30, deckId: 1, name: "Cut candidate", color: "ember", cardCount: 3 },
  { id: 31, deckId: 1, name: "Needs a land", color: "moss", cardCount: 1 },
  { id: 32, deckId: 1, name: "Playtest", color: "azure", cardCount: 0 },
];

/** Most-used first, from every deck — the palette is a property of the app's history rather
 *  than of the deck that happens to be open. */
const SUGGESTIONS: TagSuggestion[] = [
  { name: "Cut candidate", color: "ember" },
  { name: "Budget swap", color: "moss" },
  { name: "Combo piece", color: "gold" },
  { name: "Sideboard plan", color: "slate" },
];

/* ------------------------------------------------------------------- the backend ------- */

/** The deck row `deck_get` answers with. Nothing on this panel reads a field of it — the one
 *  thing the drawer wants out of `deck_get` is `cards`, for the auto-categoriser. */
const DECK_ROW: DeckRow = {
  id: 1,
  name: "Serah's Legendary Toolbox",
  formatKey: "commander",
  formatName: "Commander",
  description: null,
  coverCardId: null,
  coverKind: "card_art",
  coverArtist: null,
  isBuilt: false,
  archived: false,
  cardCount: 0,
  updatedAt: 0,
  folderId: null,
  notes: null,
  theoryEnabled: false,
};

interface MetaWorld {
  categories: DeckCategory[];
  tags: DeckTag[];
  suggestions: TagSuggestion[];
  cards: DeckCard[];
}

/**
 * One story's rows, **copied**.
 *
 * Every array above and every `parameters.meta` below is a module-level literal, and these
 * handlers write into what they are given: a rename is `tag.name = name`. Sharing one array
 * between two stories therefore lets a `play` in the first change what the second renders —
 * measured while writing this file, where renaming a tag in one story made its name disappear
 * from another story's suggestion list. A story's world is its own, or it is nobody's.
 *
 * The `sortOrder`s are written out rather than left to `deckCategory`'s defaults, which run
 * 0–4 and would collide with the reader's own piles — two rows at the same `sortOrder` are
 * ordered by id, which is an order nobody chose and a position no assertion can predict.
 */
function makeWorld(over: Partial<MetaWorld> = {}): MetaWorld {
  const categories = over.categories ?? [
    deckCategory("commander", { sortOrder: 0 }),
    made(MAIN_DECK, "Main deck", { sortOrder: 1 }),
    made(21, "Ramp", { sortOrder: 2, cardCount: 11, totalPriceUsd: 46.25 }),
    made(22, "Removal", { sortOrder: 3, cardCount: 8, totalPriceUsd: 19.4 }),
    deckCategory("side", { sortOrder: 4 }),
    deckCategory("companion", { sortOrder: 5 }),
    deckCategory("maybe", { sortOrder: 6 }),
  ];
  return {
    categories: categories.map((c) => ({ ...c })),
    tags: (over.tags ?? TAGS).map((t) => ({ ...t })),
    suggestions: [...(over.suggestions ?? SUGGESTIONS)],
    cards: (over.cards ?? loose()).map((c) => ({ ...c })),
  };
}

/** Sorted the way `deck_category_list` answers: `sortOrder`, then id. */
function ordered(world: MetaWorld): DeckCategory[] {
  return [...world.categories].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
}

function found<T extends { id: number }>(rows: T[], id: number, what: string): T {
  const row = rows.find((r) => r.id === id);
  if (!row) throw new Error(`That ${what} is not in this deck any more.`);
  return row;
}

/**
 * The eleven commands, over `world`'s own rows.
 *
 * Refusals are modelled where a reader can reach one: a duplicate name (the grain is
 * `(deckId, name)`) and a rename or delete of a predefined pile. The panel offers no control
 * for the second, and it is here anyway — a fake that answers a refused command with success
 * teaches the next reader that the command allows it.
 */
function handlers(world: MetaWorld) {
  /** A pile holding fixture cards is counted from them, so an auto-file or a delete-and-move
   *  shows up in the numbers; one holding none keeps whatever the fixture declared, which is
   *  how "Ramp" reads 11 cards without eleven rows being written out. */
  const counts = (category: DeckCategory): DeckCategory => {
    const held = world.cards.filter((c) => c.categoryId === category.id);
    return held.length === 0
      ? category
      : { ...category, cardCount: held.reduce((n, c) => n + c.quantity, 0) };
  };
  const predefinedIds = new Set(predefined().map((c) => c.id));
  const refusePredefined = (id: number, verb: string) => {
    if (predefinedIds.has(id)) throw new Error(`A predefined category cannot be ${verb}.`);
  };

  return {
    deck_get: ({ id, variant }: { id: number; variant: DeckVariant }): DeckDetail => ({
      deck: { ...DECK_ROW, id, cardCount: world.cards.length },
      cards: world.cards.filter((c) => c.variant === variant),
      categories: ordered(world).map(counts),
      tags: world.tags,
    }),

    deck_category_list: (): DeckCategory[] => ordered(world).map(counts),

    deck_category_create: ({ name }: { name: string }): DeckCategory => {
      if (world.categories.some((c) => c.name === name)) {
        throw new Error(`This deck already has a category called “${name}”.`);
      }
      const category = made(Math.max(0, ...world.categories.map((c) => c.id)) + 1, name, {
        sortOrder: Math.max(0, ...world.categories.map((c) => c.sortOrder)) + 1,
      });
      world.categories.push(category);
      return category;
    },

    deck_category_rename: ({ id, name }: { id: number; name: string }): DeckCategory => {
      refusePredefined(id, "renamed");
      const category = found(world.categories, id, "category");
      category.name = name;
      return category;
    },

    deck_category_set_active: ({
      id,
      isActive,
    }: {
      id: number;
      isActive: boolean;
    }): DeckCategory => {
      const category = found(world.categories, id, "category");
      category.isActive = isActive;
      return category;
    },

    deck_category_reorder: ({ ids }: { ids: number[] }): DeckCategory[] => {
      // `sortOrder` from position, and an id that is not this deck's is skipped rather than
      // failing the reorder — the command's own rule.
      ids.forEach((id, at) => {
        const category = world.categories.find((c) => c.id === id);
        if (category) category.sortOrder = at;
      });
      return ordered(world).map(counts);
    },

    deck_category_delete: ({
      id,
      moveToCategoryId,
    }: {
      id: number;
      moveToCategoryId: number | null;
    }): void => {
      refusePredefined(id, "deleted");
      found(world.categories, id, "category");
      if (moveToCategoryId === null) {
        world.cards = world.cards.filter((c) => c.categoryId !== id);
      } else {
        const to = found(world.categories, moveToCategoryId, "category");
        for (const card of world.cards) {
          if (card.categoryId === id) {
            card.categoryId = to.id;
            card.categoryName = to.name;
            card.categoryActive = to.isActive;
          }
        }
      }
      world.categories = world.categories.filter((c) => c.id !== id);
    },

    deck_move_card: ({
      cardId,
      fromCategoryId,
      toCategoryId,
    }: {
      cardId: string;
      fromCategoryId: number;
      toCategoryId: number;
    }): void => {
      const to = found(world.categories, toCategoryId, "category");
      for (const card of world.cards) {
        if (card.cardId === cardId && card.categoryId === fromCategoryId) {
          card.categoryId = to.id;
          card.categoryName = to.name;
          card.categoryActive = to.isActive;
        }
      }
    },

    deck_tag_list: (): DeckTag[] => [...world.tags].sort((a, b) => a.name.localeCompare(b.name)),

    deck_tag_create: ({ name, color }: { name: string; color: TagColor }): DeckTag => {
      if (world.tags.some((t) => t.name === name)) {
        throw new Error(`This deck already has a tag called “${name}”.`);
      }
      const tag: DeckTag = {
        id: Math.max(0, ...world.tags.map((t) => t.id)) + 1,
        deckId: 1,
        name,
        color,
        cardCount: 0,
      };
      world.tags.push(tag);
      return tag;
    },

    deck_tag_update: ({
      id,
      name,
      color,
    }: {
      id: number;
      name: string;
      color: TagColor;
    }): DeckTag => {
      const tag = found(world.tags, id, "tag");
      tag.name = name;
      tag.color = color;
      return tag;
    },

    /** Untags its cards rather than deleting them — `deck_cards.tag_id` is
     *  `ON DELETE SET NULL`, which is the half of the sentence the confirm dialog says. */
    deck_tag_delete: ({ id }: { id: number }): void => {
      found(world.tags, id, "tag");
      world.tags = world.tags.filter((t) => t.id !== id);
      for (const card of world.cards) {
        if (card.tagId === id) {
          card.tagId = null;
          card.tagName = null;
          card.tagColor = null;
        }
      }
    },

    deck_tag_suggestions: (): TagSuggestion[] => world.suggestions,
  };
}

/** Install one story's rows into that story's own fake scope. See the header for the two
 *  mechanics that make this safe on a docs page — and for when to delete it. */
function Meta({ world, children }: { world: Partial<MetaWorld>; children: ReactNode }) {
  useState(() => {
    registerCommands(handlers(makeWorld(world)));
    return null;
  });
  return <>{children}</>;
}

const withMeta: Decorator = (Story, context) => (
  <Meta world={(context.parameters.meta ?? {}) as Partial<MetaWorld>}>
    <Story />
  </Meta>
);

/* --------------------------------------------------------------------- the meta ------- */

/**
 * The drawer is `position: fixed`, so it covers whatever it is rendered into — including the
 * docs page. Every story is therefore boxed: a `relative` frame with its own height, which is
 * what a docs page needs in order to show ten of these at once and still scroll.
 */
const meta = {
  title: "Decks/CategoriesPanel",
  component: CategoriesPanel,
  args: { deckId: 1, variant: "live", open: true, onDismiss: fn(), onClose: fn() },
  decorators: [
    withMeta,
    (Story) => (
      <div className="relative h-[42rem] overflow-hidden border border-border bg-surface">
        <Story />
      </div>
    ),
  ],
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof CategoriesPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A deck a few evenings into being built: two piles the reader made, the four every deck
 *  starts with, and three labels. */
export const Default: Story = {};

/**
 * A deck on the day it was made — nothing but the four predefined piles and the one the
 * migration files a plain add into, no tags at all, and four names offered from other decks.
 *
 * The empty state is the one that has to invite: "No tags yet." over a field, and the
 * suggestions right under it.
 */
export const FirstOpen: Story = {
  parameters: {
    meta: {
      categories: [
        deckCategory("commander", { sortOrder: 0 }),
        made(MAIN_DECK, "Main deck", { sortOrder: 1 }),
        deckCategory("side", { sortOrder: 2 }),
        deckCategory("companion", { sortOrder: 3 }),
        deckCategory("maybe", { sortOrder: 4 }),
      ],
      tags: [],
      cards: [],
    },
  },
};

/** Closed. The contract is `null` — no drawer, no scrim, and not one query fired. */
export const Closed: Story = {
  args: { open: false },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector("[role=dialog]")).toBeNull();
  },
};

/**
 * The two markers, side by side on one screen.
 *
 * `RULE` is not "predefined and undeletable" — the Maybeboard is predefined and carries
 * `INACTIVE` instead, and this deck's Sideboard has been switched off and carries **both**.
 * `GroupHeader` decides it; this panel only draws it.
 */
export const RuleAndInactive: Story = {
  parameters: {
    meta: {
      categories: [
        deckCategory("commander", { sortOrder: 0 }),
        made(MAIN_DECK, "Main deck", { sortOrder: 1, cardCount: 63, totalPriceUsd: 212.4 }),
        deckCategory("side", { sortOrder: 2, isActive: false }),
        deckCategory("companion", { sortOrder: 3 }),
        deckCategory("maybe", { sortOrder: 4 }),
      ],
      cards: [],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const sideboard = (await canvas.findByText("Sideboard")).closest("li");
    await expect(within(sideboard as HTMLElement).getByText("RULE")).toBeInTheDocument();
    await expect(within(sideboard as HTMLElement).getByText("INACTIVE")).toBeInTheDocument();

    const maybe = (await canvas.findByText("Maybeboard")).closest("li");
    await expect(within(maybe as HTMLElement).queryByText("RULE")).toBeNull();
    await expect(within(maybe as HTMLElement).getByText("INACTIVE")).toBeInTheDocument();
  },
};

/**
 * A predefined pile can be switched off and cannot be renamed or deleted — the Commander
 * included, which is the half that reads wrong until you have seen it. There is no format
 * branch behind any of this.
 */
export const PredefinedIsSwitchableOnly: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const commander = (await canvas.findByText("Commander")).closest("li") as HTMLElement;

    await expect(within(commander).queryByRole("button", { name: "Rename" })).toBeNull();
    await expect(within(commander).queryByRole("button", { name: "Delete" })).toBeNull();

    await userEvent.click(within(commander).getByRole("button", { name: /^Active/ }));
    await waitFor(async () => {
      await expect(within(commander).getByText("INACTIVE")).toBeInTheDocument();
    });
  },
};

/** The reorder a keyboard can do. The handle's own name carries the position, because looking
 *  at the list is the only other way to know where a row landed. */
export const ReorderedFromTheKeyboard: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const handle = await canvas.findByRole("button", { name: "Move Ramp, 3 of 7" });
    handle.focus();
    await userEvent.keyboard("{ArrowUp}");

    await waitFor(async () => {
      await expect(canvas.getByRole("button", { name: "Move Ramp, 2 of 7" })).toBeInTheDocument();
    });
  },
};

/**
 * The one destructive control on the drawer, open on its safe answer.
 *
 * `deck_category_delete` takes `moveToCategoryId`, and `null` is the half that takes the cards
 * with the category by cascade — so the dialog defaults to a move, spells the outcome out in a
 * sentence, and changes the confirm button's own words with the answer.
 */
export const DeletingACategory: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const ramp = (await canvas.findByText("Ramp")).closest("li") as HTMLElement;
    await userEvent.click(within(ramp).getByRole("button", { name: "Delete" }));

    const dialog = await canvas.findByRole("group", { name: "Delete Ramp" });
    await expect(within(dialog).getByText(/Nothing is lost/)).toBeInTheDocument();
    await expect(
      within(dialog).getByRole("button", { name: "Move 11 cards and delete" }),
    ).toBeInTheDocument();
  },
};

/** The same dialog after the reader has chosen the other outcome: red, and saying so. */
export const DeletingACategoryAndItsCards: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const ramp = (await canvas.findByText("Ramp")).closest("li") as HTMLElement;
    await userEvent.click(within(ramp).getByRole("button", { name: "Delete" }));

    const dialog = await canvas.findByRole("group", { name: "Delete Ramp" });
    await userEvent.selectOptions(within(dialog).getByLabelText("Its 11 cards"), "delete");
    await expect(within(dialog).getByText(/This cannot be undone/)).toBeInTheDocument();
    await expect(
      within(dialog).getByRole("button", { name: "Delete “Ramp”" }),
    ).toBeInTheDocument();
  },
};

/**
 * "Auto-categorise from card types", pressed — the real `autoCategoryFor` over real type lines,
 * through the real orchestration in `useDeckMeta`.
 *
 * Six loose cards become a Creature pile, an Instant pile, a Land pile and the rest; the
 * categories the reader made are left exactly as they were, which is the rule that keeps this
 * button from being a way to lose an evening's filing.
 */
export const AutoCategorised: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("Ramp");
    await userEvent.click(
      canvas.getByRole("button", { name: "Auto-categorise from card types" }),
    );

    await waitFor(async () => {
      await expect(canvas.getByText("Creature")).toBeInTheDocument();
    });
    await expect(canvas.getByText("Ramp")).toBeInTheDocument();
  },
};

/** A tag renamed and recoloured in one press — `deck_tag_update` has no patch shape, so the
 *  field sends both whichever one the reader touched. */
export const RenamingATag: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const tag = (await canvas.findByText("Cut candidate")).closest("li") as HTMLElement;
    await userEvent.click(within(tag).getByRole("button", { name: "Rename" }));

    const field = await within(tag).findByLabelText("Rename Cut candidate");
    await userEvent.clear(field);
    await userEvent.type(field, "On the block");
    await userEvent.click(within(tag).getByRole("button", { name: "Slate" }));
    await userEvent.click(within(tag).getByRole("button", { name: "Save" }));

    await waitFor(async () => {
      await expect(canvas.getByText("On the block")).toBeInTheDocument();
    });
  },
};

/** A name typed into four other decks, offered in the fifth. Picking one makes a tag of this
 *  deck; a suggestion this deck already has is not an offer, so "Cut candidate" is absent. */
export const TagFromASuggestion: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("Cut candidate");
    await expect(canvas.queryByRole("button", { name: "Add tag Cut candidate" })).toBeNull();

    await userEvent.click(canvas.getByRole("button", { name: "Add tag Budget swap" }));
    await waitFor(async () => {
      await expect(canvas.queryByRole("button", { name: "Add tag Budget swap" })).toBeNull();
    });
  },
};

/** A refusal, in the panel's own words: the grain is `(deckId, name)`, so a second "Ramp" is
 *  not a second pile. */
export const RefusedByName: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("Ramp");
    await userEvent.type(canvas.getByLabelText("New category name"), "Ramp");
    await userEvent.click(canvas.getByRole("button", { name: "Add" }));

    await waitFor(async () => {
      await expect(await canvas.findByRole("alert")).toHaveTextContent(
        "This deck already has a category called “Ramp”.",
      );
    });
  },
};
