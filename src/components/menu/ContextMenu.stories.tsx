import { useEffect, useRef, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { ContextMenuProvider } from "./ContextMenuProvider";
import { useContextMenu } from "./useContextMenu";
import type { MenuItem, MenuPosition } from "./types";
import {
  CardToDeckProvider,
  DeckTargetSubmenu,
  buildCardMenu,
  type CardMenuDeps,
  type CardMenuTarget,
} from "@/features/card/cardMenu";
import { buildCategoryMenu, type CategoryMenuDeps } from "@/features/decks/categoryMenu";
import { buildDeckCardMenu, type DeckCardMenuDeps } from "@/features/decks/deckCardMenu";
import { buildDeckMenu, type DeckMenuDeps } from "@/features/decks/deckMenu";
import { buildFolderMenu, type FolderMenuDeps } from "@/features/decks/folderMenu";
import { SPECS } from "@/features/decks/validation/fixtures";
import type { DeckCard, DeckCategory, DeckFolder, DeckRow, DeckTag } from "@/lib/ipc";
import { MARKETPLACES } from "@/lib/marketplace";
import { deckCard, deckCategory, printing } from "../../../.storybook/fake/fixtures";

/**
 * How long a `waitFor` will wait for the panel's first frame.
 *
 * `ContextMenu` is a `motion.div` carrying the `popup` preset, so its first painted frame is its
 * `initial` and `toBeVisible` walks the ancestors — nothing inside the panel is visible until the
 * next frame lands. `findBy*` does not cover it: that waits for an element to **exist**, never to
 * become visible. `Decks/Dialog shell` measured the same thing first and carries the long form,
 * including why the number is seconds rather than milliseconds under a hundred-odd parallel jsdom
 * files. **Not exported** — CSF indexes every named export of a story file as a story.
 */
const FRAME_WAIT = 5_000;

/** Where every story opens its menu, clear of the surface it is opened from. A module constant
 *  so its identity holds across renders: {@link MenuSurface}'s effect depends on it. */
const AT: MenuPosition = { x: 260, y: 40 };

/** What a story's builder reports instead of writing: one string per press, so a play can say
 *  which row it took without any of these menus reaching a real mutation. */
type Act = (what: string) => void;

interface StageProps {
  /**
   * The menu, built **once** — a thunk rather than an array, exactly as `useContextMenu`'s
   * `menu(build)` takes one: the surfaces this serves draw hundreds of rows, and the item list is
   * built when a reader right-clicks rather than on every render.
   */
  build: (act: Act) => MenuItem[];
  /** The thing being right-clicked, as a word. */
  label: string;
  /** Every row's press, as a spy — so a play asserts what a press *asked for* rather than
   *  reaching into a mutation this workbench deliberately does not mount. */
  act: Act;
  at?: MenuPosition;
}

/**
 * The surface a menu is opened from, with the menu already open.
 *
 * **Opened from an effect rather than from a `play`, and that is what makes this a catalogue.**
 * A story whose menu only appears once its play has run draws an empty box on the docs page,
 * where plays do not autorun — and the subject here *is* the open panel. The surface still
 * carries the real `onContextMenu` and `onKeyDown` handlers, so a reader can close the menu and
 * right-click (or Shift+F10) their way back into it, which is the interaction being catalogued.
 *
 * The items are built in a lazy `useState` initializer, so the identity the effect depends on
 * holds still: a fresh array per render would reopen the menu on every commit, and reopening is
 * what resets the expanded path.
 */
function MenuSurface({ build, label, act, at = AT }: StageProps) {
  const { openMenu, menu, menuKey } = useContextMenu();
  const [items] = useState(() => build(act));
  const opener = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    openMenu(items, at, opener.current);
  }, [openMenu, items, at]);

  return (
    <button
      ref={opener}
      type="button"
      onContextMenu={menu(() => items)}
      onKeyDown={menuKey(() => items)}
      className="rounded-md border border-border bg-surface px-3 py-2 text-sm text-text"
    >
      {label}
    </button>
  );
}

/**
 * The two providers, in the order `App.tsx` mounts them — and the order is the whole point.
 *
 * `ContextMenuProvider` draws its panel as a **sibling** of its children, so "inside the shell"
 * and "inside the menu" are two different places: a `CardToDeckProvider` around the *views* is
 * around none of the menu's rows, and `useAddCardToDeck` then throws the moment a reader expands
 * **Add to → Deck**. That mistake shipped once. It is wrapped here on every story rather than
 * only on the one that expands that row, because the failure is a render-time throw and the
 * ordering is the thing worth showing.
 *
 * **The other half of that pair does not throw.** `useContextMenu()` outside a
 * `ContextMenuProvider` is a deliberate no-op — every surface that offers a right-click calls it
 * and every one is also a story — so a story that forgot the provider would render a surface
 * whose right-click does nothing at all, silently, and look entirely correct. Nothing here can
 * tell you that; the wrap is the rule.
 */
function Stage(props: StageProps) {
  return (
    <CardToDeckProvider>
      <ContextMenuProvider>
        <div className="p-6">
          <MenuSurface {...props} />
        </div>
      </ContextMenuProvider>
    </CardToDeckProvider>
  );
}

/* ---------------------------------------------------------------------- the fixtures ---- */

/** The printing every card story is opened on — `2x2 117`, the uncommon Lightning Bolt, chosen
 *  because its `finishes` is `["nonfoil","foil"]`: two finishes is what turns **Add to →
 *  Collection** from a row that adds silently into a submenu that asks. */
const BOLT = printing("2x2", "117");

/** The ramp spell {@link RAMP_CARD} is built from, hoisted beside {@link BOLT} so the guard below
 *  can see both. */
const RAMP_CARD_PRINTING = printing("c21", "263");

/**
 * The two fixture lookups, pinned to the cards this file's `label`s and assertions were written
 * for.
 *
 * `printing()` throws for a row the corpus does not have; it cannot tell you that the row it found
 * is a different card from the one you meant. That gap is not hypothetical — `lea 288` reads as
 * Sol Ring and is **Island** — and here it would surface as `NoStoredImage` failing to find a
 * button named "Lightning Bolt", which says nothing about the cause. Checked at module load, where
 * the message does.
 */
if (BOLT.name !== "Lightning Bolt" || RAMP_CARD_PRINTING.name !== "Sol Ring") {
  throw new Error(
    `ContextMenu.stories: the fixture printings are ${BOLT.name} and ` +
      `${RAMP_CARD_PRINTING.name}; this file's labels are written for Lightning Bolt and Sol Ring.`,
  );
}

const CARD_TARGET: CardMenuTarget = {
  cardId: BOLT.id,
  name: BOLT.name,
  setCode: BOLT.setCode,
  collectorNumber: BOLT.collectorNumber,
  oracleId: BOLT.oracleId,
  finishes: BOLT.finishes,
  typeLine: BOLT.typeLine,
};

/** The same card with no oracle card behind it — `CardSummary.oracleId` is nullable, which is a
 *  fence around the type rather than a card anyone can find (0 of 116 590 live rows). It is the
 *  one thing that greys **View all printings**, and it exists to be read. */
const ORPHANED_TARGET: CardMenuTarget = { ...CARD_TARGET, oracleId: null };

/**
 * Everything the card menu needs that is not the card.
 *
 * No `printingsDeck` and no `printingsOracleId`, which is what a plain card surface hands over:
 * these rows are not rows of an open deck and this is not a list of one card's printings, so
 * "View all printings" opens the modal over whatever is on screen with no slot to write to.
 * `DeckTargetSubmenu` is passed **as itself**, with no glue, which is how every surface passes it:
 * the picker reaches the app's one `useCardToDeck` through the context {@link Stage} mounts rather
 * than through a callback threaded from here.
 */
function cardDeps(act: Act): CardMenuDeps {
  return {
    marketplace: MARKETPLACES.cardmarket,
    addToCollection: (target, finish) => act(`collection:${target.cardId}:${finish}`),
    addToWishlist: (target) => act(`wishlist:${target.cardId}`),
    openAllPrintings: (t) => act(`printings:${t.oracleId}`),
    DeckTargetSubmenu,
  };
}

/** The command zone, and a pile the reader made and dragged to the end of their own order. Named
 *  rather than reached by index, because two stories are *about* which of the two they are. */
const COMMANDER_ZONE: DeckCategory = deckCategory("commander");
/**
 * **`cardCount` is spelled out because `Clear stack…` reads it**, and it is the count of the
 * variant on screen — the reverse of what the delete confirmation quotes. A pile at zero draws a
 * greyed row, which is {@link EmptyPileCannotBeCleared}'s subject; this one holds cards, so the
 * row is live here.
 */
const RAMP_PILE: DeckCategory = {
  ...deckCategory("main"),
  id: 10,
  name: "Ramp",
  sortOrder: 5,
  cardCount: 7,
  cardCountAllVariants: 7,
};

/**
 * The deck's piles **in the reader's own order**, which is the array `DeckEditor` holds and never
 * the groups a view drew.
 *
 * `Move to` is built from this, and that is what lets it reach a pile with no heading on the desk.
 * There is no `sortOptions` call anywhere near it: deck categories are a documented exemption from
 * the app's option-list rule — an order the reader arranged themselves — and Ramp sitting last is
 * the reader having put it there.
 */
const CATEGORIES: DeckCategory[] = [
  COMMANDER_ZONE,
  deckCategory("main"),
  deckCategory("side"),
  deckCategory("companion"),
  RAMP_PILE,
];

const TAGS: DeckTag[] = [
  { id: 1, deckId: 1, name: "Wincon", color: "gold", cardCount: 3 },
  { id: 2, deckId: 1, name: "Cut candidate", color: "ember", cardCount: 1 },
];

/** A Bolt filed in the deck's main pile, wearing no label — so the tag radios open on **None**
 *  checked, which is the state every card starts in. */
const DECK_CARD: DeckCard = deckCard(BOLT, { categoryKind: "main" });

/**
 * One card in {@link RAMP_PILE}, so that pile's export is a pile with something in it — the menu
 * filters the deck's rows by category id, which is the half worth showing.
 *
 * Sol Ring is `c21 263`. **`lea 288` is Island** and is what this said first: a two-mana rock and a
 * basic land are one `printing()` lookup apart, and nothing about a wrong one is visible from the
 * call — which is why {@link BOLT} and {@link RAMP_CARD_PRINTING} are pinned by name above.
 */
const RAMP_CARD: DeckCard = deckCard(RAMP_CARD_PRINTING, {
  categoryId: RAMP_PILE.id,
  categoryName: RAMP_PILE.name,
});

/**
 * The deck's own additions to the card menu.
 *
 * `spec` is `SPECS.commander`, and it is what puts both zone rows on screen at all:
 * `requiresCommander` draws **Set as commander** and `allowsCompanion` draws **Set as companion**,
 * so neither appears in a Modern deck. The eligibility test underneath them is `validation/`'s
 * own, which is why a card this menu greys is a card the validation panel would also refuse.
 */
function deckCardDeps(act: Act): DeckCardMenuDeps {
  return {
    card: cardDeps(act),
    categories: CATEGORIES,
    cards: [DECK_CARD],
    spec: SPECS.commander,
    moveTo: (card, categoryId) => act(`move:${card.cardId}:${categoryId}`),
    setTag: (card, tagId) => act(`tag:${card.cardId}:${tagId ?? "none"}`),
    setFinish: (card, to) => act(`finish:${card.cardId}:${to ?? "regular"}`),
    tags: TAGS,
    createTag: (card, name) => act(`new-tag:${card.cardId}:${name}`),
    // The stepper's zero by another road — there is no `remove` mutation in this app, because
    // zero is what removes a deck row. No confirmation, unlike a **pile's** `Clear stack…`: one
    // card is one add to put back.
    remove: (card) => act(`remove:${card.cardId}`),
  };
}

/** One deck of the gallery, filed in `Constructed › Commander` — folder 2 of the fake's seeded
 *  three, so its **Move to** really has a folder to mark `Here now`. */
const DECK: DeckRow = {
  gameKey: "any",
  id: 2,
  name: "Kenrith Two-Drops",
  formatKey: "commander",
  formatName: "Commander",
  description: "Every permanent in the 99 costs two or less.",
  coverCardId: BOLT.id,
  coverKind: "card_art",
  coverArtist: BOLT.artist,
  isBuilt: true,
  archived: false,
  cardCount: 100,
  updatedAt: 1_786_266_000,
  folderId: 2,
  notes: null,
  theoryEnabled: false,
  lastVariant: "live",
  lastGroupBy: "category",
  lastSortBy: "alphabetical",
  separateXGroup: false,
  defaultCategoryId: 0,
};

/** The folder that deck is in — a child of `Constructed`, which is what makes its own **Move to**
 *  able to show both fences at once: itself, and what it holds. */
const FOLDER: DeckFolder = { id: 2, parentId: 1, name: "Commander", sortOrder: 0 };

function deckDeps(act: Act): DeckMenuDeps {
  return {
    setOpenDeckId: (id) => act(`open:${id}`),
    startRename: (deck) => act(`rename:${deck.id}`),
    openSettings: (id) => act(`settings:${id}`),
    moveToFolder: (id, folderId) => act(`file:${id}:${folderId ?? "root"}`),
    duplicate: (id) => act(`duplicate:${id}`),
    // The confirmation, never the delete: `DeckMenuDeps` carries no `remove` at all, so this
    // menu structurally cannot reach the irreversible write.
    askDelete: (deck) => act(`ask-delete:${deck.id}`),
  };
}

function folderDeps(act: Act): FolderMenuDeps {
  return {
    newDeck: (id) => act(`new-deck-in:${id}`),
    newSubfolder: (id) => act(`new-subfolder-of:${id}`),
    startRename: (id) => act(`rename-folder:${id}`),
    moveFolder: (id, parentId) => act(`move-folder:${id}:${parentId ?? "root"}`),
    askDelete: (folder) => act(`ask-delete-folder:${folder.id}`),
  };
}

function categoryDeps(act: Act): CategoryMenuDeps {
  return {
    // **Unfiltered** — the deck's own rows rather than what a toolbar filter left. Exporting
    // "Ramp" means the pile, not the one of it a search box happens to be showing.
    cards: [DECK_CARD, RAMP_CARD],
    startRename: (category) => act(`rename-pile:${category.id}`),
    openImport: (request) => act(`import-into:${request.forcedCategoryName}`),
    openExport: (request) => act(`export:${request.subject}:${request.cards.length}`),
    setActive: (category, isActive) => act(`active:${category.id}:${String(isActive)}`),
    // Both destructions are a **question**, never the write — `CategoryMenuDeps` carries neither
    // mutation, so this menu is structurally incapable of emptying or deleting a pile on its own.
    askClear: (category) => act(`ask-clear-pile:${category.id}`),
    askDelete: (category) => act(`ask-delete-pile:${category.id}`),
  };
}

/* ------------------------------------------------------------------------- the meta ----- */

/**
 * The app's one context menu — a panel at the pointer, and whatever cascade the reader opens out
 * of it.
 *
 * **A menu is data.** Every surface builds a `MenuItem[]` and this panel draws it, which is what
 * keeps a right-click's rows the same shape wherever one is opened and what lets the keyboard
 * model — roving caret, submenu open and close, one Escape per level — be written once against
 * the array rather than once per surface. So the stories below are the **four builders** this
 * branch shipped, drawn by the one panel: the card menu every card surface draws, the deck
 * editor's additions to it, the gallery's deck and folder menus, and a pile's.
 *
 * **Nothing here reaches the backend while a menu is merely open**, and two stories exist to show
 * the shape that guarantees it. `Add to → Deck` and both `Move to` rows are `lazy` submenus: their
 * bodies are components mounted by the *expand*, so a right-click on a tile in a wall of forty
 * fires neither the deck list nor the folder list. Expanding one here really does read the fake.
 *
 * **Its own frame per docs story.** The panel is `fixed` at `LAYER.popup` — mounted at the app
 * root as a sibling of `AppShell`, because a `z-index` competes only inside its own stacking
 * context and every card surface here draws transformed rows — so rendered inline it would be
 * laid out against the docs page's viewport rather than its own block, and every story on the
 * page would draw on top of the last. `inline: false` gives each one an iframe to be `fixed`
 * inside.
 */
const meta = {
  title: "Menu/Context menu",
  component: Stage,
  tags: ["autodocs"],
  args: { act: fn(), label: "Lightning Bolt" },
  parameters: {
    layout: "fullscreen",
    docs: { story: { inline: false, height: "420px" } },
  },
} satisfies Meta<typeof Stage>;

export default meta;
type Story = StoryObj<typeof meta>;

/* ------------------------------------------------------------------- the card menu ------ */

/**
 * The menu every card surface draws — the two search views, the two collection views, the
 * wishlist, the four deck editor views, the docked panel, the card pane and the printings list.
 *
 * **Five rows and two rules** — seven items, since a separator is a `MenuItem` too. The two copies
 * come first because they are what a right-click is most often for; **Open on** and **View all
 * printings** sit together under one rule because both answer "show me more of this card", one
 * outside the app and one in it; and **Add to** sits under the second, because it is the row that
 * writes something.
 */
export const Card: Story = {
  args: { build: (act) => buildCardMenu(CARD_TARGET, cardDeps(act)) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const panel = await canvas.findByRole("menu");

    // The panel's arrival, waited out once — everything under it is in the same tick. See
    // {@link FRAME_WAIT}.
    await waitFor(async () => await expect(panel).toBeVisible(), { timeout: FRAME_WAIT });

    await expect(canvas.getByRole("menuitem", { name: "Copy card name" })).toBeVisible();
    await expect(canvas.getByRole("menuitem", { name: "Copy card image" })).toBeVisible();
    await expect(canvas.getByRole("menuitem", { name: "View all printings" })).toBeVisible();

    // The two submenu rows say so in ARIA rather than only with a chevron — the chevron is
    // `aria-hidden`, so this attribute is the whole of what a screen reader is told.
    for (const name of ["Open on", "Add to"]) {
      const row = canvas.getByRole("menuitem", { name });
      await expect(row).toHaveAttribute("aria-haspopup", "menu");
      await expect(row).toHaveAttribute("aria-expanded", "false");
    }

    // The caret starts on the panel itself, so Escape has something to hand back and the first
    // ArrowDown is not swallowed by an element outside the menu. Asserted with the keyboard
    // rather than after a click: `user.click` focuses what it is handed.
    await expect(panel).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    await expect(canvas.getByRole("menuitem", { name: "Copy card name" })).toHaveFocus();
  },
};

/**
 * **Open on**, expanded — the one submenu whose second row changes name with a setting.
 *
 * Scryfall first and then the selected marketplace, and the pair is deliberately **not**
 * alphabetical: the app's option-list rule orders lists a reader *searches*, and this is a
 * two-row ladder. Sorting it would put Card Kingdom above Scryfall and Cardmarket below it, so
 * the row a reader has learnt the position of would move when they changed marketplace. Exactly
 * one marketplace, because a menu offering all five would be a marketplace picker, and Settings
 * already is one.
 */
export const SubmenuExpanded: Story = {
  args: { build: (act) => buildCardMenu(CARD_TARGET, cardDeps(act)) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const row = await canvas.findByRole("menuitem", { name: "Open on" });
    await waitFor(async () => await expect(row).toBeVisible(), { timeout: FRAME_WAIT });

    await userEvent.click(row);
    await expect(row).toHaveAttribute("aria-expanded", "true");

    // A real nested `role="menu"`, one depth down — not an indented list whose hierarchy only a
    // sighted reader can see.
    const panels = await canvas.findAllByRole("menu");
    await expect(panels).toHaveLength(2);
    await waitFor(
      async () => await expect(canvas.getByRole("menuitem", { name: "Scryfall" })).toBeVisible(),
      { timeout: FRAME_WAIT },
    );
    // The marketplace's own label, off `MARKETPLACES.cardmarket` — the point being that this row
    // is a setting rather than a fixed name.
    await expect(canvas.getByRole("menuitem", { name: "Cardmarket" })).toBeVisible();

    const rows = within(panels[1]).getAllByRole("menuitem");
    await expect(rows.map((r) => r.textContent)).toEqual(["Scryfall", "Cardmarket"]);
  },
};

/**
 * **Add to → Deck**, the row this whole `lazy` kind exists for.
 *
 * `useDecks()` and `useDeckFolders()` are two queries and a right-click must fire neither, so the
 * picker is a component mounted by the expand. It is mounted here against the fake's seeded
 * gallery: three decks and three folders, with the folders first at every level in the reader's
 * own `sortOrder` and the decks under them alphabetised.
 *
 * **This is the story that needs both providers**, in `App.tsx`'s order — see {@link Stage}.
 * `useAddCardToDeck` throws without the outer one, which is deliberate: a deck add that quietly
 * never lands is the failure that shape exists to prevent.
 */
export const AddToDeck: Story = {
  args: { build: (act) => buildCardMenu(CARD_TARGET, cardDeps(act)) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const addTo = await canvas.findByRole("menuitem", { name: "Add to" });
    await waitFor(async () => await expect(addTo).toBeVisible(), { timeout: FRAME_WAIT });

    await userEvent.click(addTo);
    // Two finishes on this printing, so Collection asks rather than adding silently.
    const collection = await canvas.findByRole("menuitem", { name: "Collection" });
    await expect(collection).toHaveAttribute("aria-haspopup", "menu");
    await expect(canvas.getByRole("menuitem", { name: "Wishlist" })).toBeInTheDocument();

    await userEvent.click(await canvas.findByRole("menuitem", { name: "Deck" }));
    // The gallery, read through the fake — a folder is a submenu and a deck without a theory
    // list is a plain row.
    await waitFor(
      async () =>
        await expect(canvas.getByRole("menuitem", { name: "Constructed" })).toBeInTheDocument(),
      { timeout: FRAME_WAIT },
    );
    await expect(canvas.getByRole("menuitem", { name: "Modern Goodstuff" })).toBeInTheDocument();
  },
};

/**
 * **View all printings**, greyed, with the reason beside it.
 *
 * `CardSummary.oracleId` is nullable, and `null` means exactly one thing: this printing has left
 * the card database. The row is **drawn and disabled with a reason** rather than hidden or
 * crashed on — `aria-disabled` and never the `disabled` attribute, because a `disabled` button
 * leaves the tab order and stops being announced, and this row's whole job is to say why the
 * thing the reader came for is not on offer.
 */
export const GreyedPrintings: Story = {
  args: {
    label: "Lightning Bolt (orphaned)",
    build: (act) => buildCardMenu(ORPHANED_TARGET, cardDeps(act)),
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const row = await canvas.findByRole("menuitem", { name: /View all printings/ });
    await waitFor(async () => await expect(row).toBeVisible(), { timeout: FRAME_WAIT });

    await expect(row).toHaveAttribute("aria-disabled", "true");
    await expect(row).not.toHaveAttribute("disabled");
    await expect(
      within(row).getByText("this printing has left the card database"),
    ).toBeInTheDocument();

    // **Read, and never landed on** — `menuRowsIn` filters on exactly that attribute, so the
    // caret walks past it. Driven from the *end* of the panel rather than the start, because that
    // is where the greyed row is: the selectable rows are Copy card name, Copy card image, Open on
    // and Add to, and "View all printings" sits in the DOM **between** the last two. So ArrowUp
    // from the panel takes the last row, and a second ArrowUp has to step over the greyed one to
    // reach "Open on". An ArrowDown from the top lands on row 1 of 5 and would prove nothing.
    await userEvent.keyboard("{ArrowUp}");
    await expect(canvas.getByRole("menuitem", { name: "Add to" })).toHaveFocus();
    await userEvent.keyboard("{ArrowUp}");
    await expect(canvas.getByRole("menuitem", { name: "Open on" })).toHaveFocus();
    await expect(row).not.toHaveFocus();

    await userEvent.click(row);
    await expect(args.act).not.toHaveBeenCalled();
  },
};

/**
 * A card with no stored image, and the press that honestly copies nothing.
 *
 * `imageUrisMissing` is a corpus whose `cards.image_uris` is NULL throughout, so `card_image_uri`
 * answers `null` for every printing at every size. `cardMenu.tsx` copies nothing rather than
 * falling back: a clipboard left holding the **previous** card's URL because this one had no
 * picture is worse than a press that did nothing.
 *
 * **There is deliberately nothing on screen to say so**, which is what this story is for. Every
 * write a card menu starts is begun by a panel that is already closing, so there is no menu left
 * for a sentence and no observer left to report one; the two adds report through the page's own
 * `CardMenuRefusal` banner, and a clipboard write that copied nothing is not a refusal to report.
 */
export const NoStoredImage: Story = {
  args: { build: (act) => buildCardMenu(CARD_TARGET, cardDeps(act)) },
  parameters: { fake: { fault: "imageUrisMissing" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const row = await canvas.findByRole("menuitem", { name: "Copy card image" });
    await waitFor(async () => await expect(row).toBeVisible(), { timeout: FRAME_WAIT });

    await userEvent.click(row);
    // Choosing a row closes the whole menu and hands the caret back to the opener, before the
    // work starts — that ordering is `ctx.run`'s, and it is the whole reason the write cannot
    // report into the panel.
    await waitFor(async () => await expect(canvas.queryByRole("menu")).toBeNull());
    await expect(canvas.getByRole("button", { name: "Lightning Bolt" })).toHaveFocus();
    await expect(canvas.queryByRole("alert")).toBeNull();
  },
};

/* -------------------------------------------------------- the deck editor's additions -- */

/**
 * The same menu **inside the deck editor**, with the four rows that only mean something about a
 * card that is in a deck — and the greyed commander this branch's spec names.
 *
 * Lightning Bolt is not a legendary creature, so `commanderIneligibility` refuses it and the row
 * greys. The presence test is the *format's* (`requiresCommander`), so neither zone row appears
 * in Modern at all; the eligibility test is `validation/`'s, so a card this menu offers is a card
 * the validation panel will accept. A looser rule here would offer a card the panel then refuses,
 * which is the one thing the deck surface must never do.
 *
 * **What this story is for now is the row's _width_** (2026-08-17). Both zone rows drew the
 * rule's own sentence beside the label until then — "not a legendary creature", "this card has no
 * companion ability" — and a menu row is as wide as its widest content, so those two sentences
 * set the width of the whole panel and the card menu read as unusably wide. The rule is
 * unchanged and only the drawing of it is gone: the refusal is still computed, still greys the
 * row, and is still written at full length in the validation panel, where there is room to read
 * it. This frame is where a sentence creeping back in is visible.
 */
export const GreyedCommander: Story = {
  args: { build: (act) => buildDeckCardMenu(DECK_CARD, deckCardDeps(act)) },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const row = await canvas.findByRole("menuitem", { name: /Set as commander/ });
    await waitFor(async () => await expect(row).toBeVisible(), { timeout: FRAME_WAIT });

    await expect(row).toHaveAttribute("aria-disabled", "true");
    await expect(row).not.toHaveAttribute("disabled");
    // The label and nothing else. The row's accessible name *is* its text, so this is also what
    // says the greying costs a screen reader no words it was getting from somewhere else.
    await expect(row.textContent?.trim()).toBe("Set as commander");

    await userEvent.click(row);
    await expect(args.act).not.toHaveBeenCalled();

    // Its neighbour is greyed on a rule of its own — the commander rule is about what the card
    // is, the companion rule about an ability it does not print — and says just as little.
    const companion = canvas.getByRole("menuitem", { name: /Set as companion/ });
    await expect(companion).toHaveAttribute("aria-disabled", "true");
    await expect(companion.textContent?.trim()).toBe("Set as companion");
  },
};

/**
 * **Move to**, over every pile the deck has — including the one the card is already in.
 *
 * Built from `DeckEditor`'s own `categories` array and never from the groups a view drew, which
 * is what lets it reach a pile with **no heading on the desk**: an `auto` pile that has gone empty
 * draws nothing, so it is not a drop target and a drag cannot reach it. There is no `sortOptions`
 * call here — deck categories are a documented exemption from the app's option-list rule, being
 * an order the reader arranged themselves.
 *
 * The card's own pile is greyed rather than dropped: "every category" is what makes the list
 * findable by position, and a row writing a move from a pile to itself would mean nothing.
 */
export const MoveToPile: Story = {
  args: { build: (act) => buildDeckCardMenu(DECK_CARD, deckCardDeps(act)) },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const row = await canvas.findByRole("menuitem", { name: "Move to" });
    await waitFor(async () => await expect(row).toBeVisible(), { timeout: FRAME_WAIT });

    await userEvent.click(row);
    const here = await canvas.findByRole("menuitem", { name: /Main deck/ });
    await expect(here).toHaveAttribute("aria-disabled", "true");
    await expect(within(here).getByText("already here")).toBeInTheDocument();

    // The reader's order and not an alphabet — read off the submenu's own panel rather than the
    // whole cascade, which is what `panelOf` keeps apart in the caret's walk too.
    const panels = await canvas.findAllByRole("menu");
    const rows = within(panels[1]).getAllByRole("menuitem");
    await expect(rows.map((r) => r.textContent?.trim())).toEqual([
      "Commander",
      "Main deckalready here",
      "Sideboard",
      "Companion",
      "Ramp",
    ]);

    await userEvent.click(canvas.getByRole("menuitem", { name: "Ramp" }));
    await expect(args.act).toHaveBeenCalledWith(`move:${DECK_CARD.cardId}:${RAMP_PILE.id}`);
  },
};

/**
 * **Tag card**, expanded — the deck's labels as a radio group, and a field for a new one.
 *
 * **Radios, and None first, because a deck card wears at most one tag**: `setTag` takes
 * `tagId: number | null` and `deck_cards.tag_id` is a single column, so a checkbox list would be a
 * control promising something the model cannot store. The rows are `menuitemradio`, which is what
 * makes the exclusivity announced rather than merely drawn.
 *
 * It is `lazy` rather than `submenu` for the **field**: the rows themselves are free — the editor
 * already holds `deck.tags` from `deck_get` — but a `MenuItem[]` cannot carry a text input, and
 * "New tag…" is inline by design. A panel holding a field is also the one place the cascade's
 * arrows, Home and End are yielded, so typing works and editing does.
 */
export const TagRadios: Story = {
  args: { build: (act) => buildDeckCardMenu(DECK_CARD, deckCardDeps(act)) },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const row = await canvas.findByRole("menuitem", { name: "Tag card" });
    await waitFor(async () => await expect(row).toBeVisible(), { timeout: FRAME_WAIT });

    await userEvent.click(row);
    const none = await canvas.findByRole("menuitemradio", { name: "None" });
    // Untagged is a checked state rather than the absence of one, which is what "at most one"
    // means when the answer is allowed to be nothing.
    await expect(none).toHaveAttribute("aria-checked", "true");

    const wincon = canvas.getByRole("menuitemradio", { name: "Wincon" });
    await expect(wincon).toHaveAttribute("aria-checked", "false");
    await expect(canvas.getByRole("menuitemradio", { name: "Cut candidate" })).toBeInTheDocument();

    // The field the whole `lazy` kind is here for.
    await expect(canvas.getByRole("textbox", { name: "New tag" })).toBeInTheDocument();

    await userEvent.click(wincon);
    await expect(args.act).toHaveBeenCalledWith(`tag:${DECK_CARD.cardId}:1`);
  },
};

/* ------------------------------------------------------------------ the gallery -------- */

/**
 * A deck in the gallery — four rows the tile already does, and two that had no inline affordance
 * at all.
 *
 * Rename had none: renaming a deck meant opening the editor and typing into its settings dialog,
 * a round trip for one word. **Deck settings…** opens that dialog *over the gallery*, on the deck
 * that was right-clicked, without opening the editor at all.
 *
 * **Delete keeps the confirmation the tile asks, and the type is what enforces it**:
 * `DeckMenuDeps` carries no `remove`, so this menu structurally cannot reach the irreversible
 * write. A menu opens by accident; it must not be one press from deleting an evening's work.
 */
export const Deck: Story = {
  args: { label: "Kenrith Two-Drops", build: (act) => buildDeckMenu(DECK, deckDeps(act)) },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const open = await canvas.findByRole("menuitem", { name: "Open deck" });
    await waitFor(async () => await expect(open).toBeVisible(), { timeout: FRAME_WAIT });

    for (const name of ["Rename…", "Deck settings…", "Duplicate", "Delete…"]) {
      await expect(canvas.getByRole("menuitem", { name })).toBeVisible();
    }
    // `Move to` is `lazy`, so the folder list has not been read yet.
    await expect(canvas.getByRole("menuitem", { name: "Move to" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );

    await userEvent.click(canvas.getByRole("menuitem", { name: "Delete…" }));
    // The confirmation, and never the delete.
    await expect(args.act).toHaveBeenCalledWith(`ask-delete:${DECK.id}`);
  },
};

/**
 * **Move to**, read from the fake — the one destination list both gallery menus draw.
 *
 * Nesting is said in words rather than by indent, because a `MenuItem` carries no depth and a flat
 * list of bare names would show two "Legends" with nothing to tell them apart: `Constructed ›
 * Commander`, the same spelling the settings dialog's Folder select uses. That also fixes the
 * order — alphabetical by the whole rendered path, through the app's one collator.
 *
 * The folder the deck is already in is offered and **inert**, marked `Here now`: moving something
 * to where it already is writes nothing and bumps `updated_at`.
 */
export const MoveDeckToFolder: Story = {
  args: { label: "Kenrith Two-Drops", build: (act) => buildDeckMenu(DECK, deckDeps(act)) },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const row = await canvas.findByRole("menuitem", { name: "Move to" });
    await waitFor(async () => await expect(row).toBeVisible(), { timeout: FRAME_WAIT });

    await userEvent.click(row);
    // `null` is a destination with a meaning: `DeckPatch` writes every column with
    // `coalesce(?n, column)`, so this list is the only way back to the root.
    const root = await canvas.findByRole("menuitem", { name: /All decks/ });
    await expect(root).toBeInTheDocument();

    const here = await canvas.findByRole("menuitem", { name: /Constructed › Commander/ });
    await expect(here).toHaveAttribute("aria-disabled", "true");
    await expect(within(here).getByText("Here now")).toBeInTheDocument();

    await userEvent.click(root);
    await expect(args.act).toHaveBeenCalledWith(`file:${DECK.id}:root`);
  },
};

/**
 * A folder row — the five things the tree's own buttons already do, on the row itself.
 *
 * The tree is 208px wide and has no room for a second control, and the wall's heading row only
 * ever speaks for the folder the reader is standing in; the menu is where all five reach the row
 * they are about. **New deck here** is the one that makes a promise the host has to keep: it opens
 * the create dialog with this folder already chosen, so a host that merely opened the dialog would
 * make the item a lie.
 */
export const Folder: Story = {
  args: { label: "Commander", build: (act) => buildFolderMenu(FOLDER, folderDeps(act)) },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const first = await canvas.findByRole("menuitem", { name: "New deck here" });
    await waitFor(async () => await expect(first).toBeVisible(), { timeout: FRAME_WAIT });

    for (const name of ["New subfolder…", "Rename…", "Move to", "Delete…"]) {
      await expect(canvas.getByRole("menuitem", { name })).toBeVisible();
    }

    await userEvent.click(canvas.getByRole("menuitem", { name: "Move to" }));
    // A folder may not go inside itself, and the fence is drawn here rather than left to the
    // backend's refusal: `deck_folders.parent_id` cascades onto itself, so a cycle is a graph
    // SQLite would walk forever the day the folder is deleted.
    const itself = await canvas.findByRole("menuitem", { name: /Constructed › Commander/ });
    await expect(itself).toHaveAttribute("aria-disabled", "true");
    await expect(within(itself).getByText("Cannot go inside itself")).toBeInTheDocument();

    await userEvent.click(canvas.getByRole("menuitem", { name: /Ideas/ }));
    await expect(args.act).toHaveBeenCalledWith(`move-folder:${FOLDER.id}:3`);
  },
};

/* ------------------------------------------------------------------ a pile's menu ------ */

/**
 * A pile the reader made — the heading over a column of cards, right-clicked.
 *
 * Two of the five rows are things the Categories dialog already does, and the menu is where they
 * stop being a round trip through a panel listing every pile in the deck to change one. **Export
 * cards…** is this app's first export of any kind, over one pile: `ExportDialog` takes its cards
 * as an argument and fetches nothing, which is precisely what lets a category hand it a subset of
 * the deck. **Import cards…** opens the importer *aimed at this pile*, so every line of the paste
 * lands here whatever the filer would have said.
 */
export const Category: Story = {
  args: {
    label: "Ramp",
    build: (act) => buildCategoryMenu(RAMP_PILE, categoryDeps(act)),
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const rename = await canvas.findByRole("menuitem", { name: "Rename…" });
    await waitFor(async () => await expect(rename).toBeVisible(), { timeout: FRAME_WAIT });

    for (const name of [
      "Import cards…",
      "Export cards…",
      "Deactivate",
      "Clear stack…",
      "Delete…",
    ]) {
      await expect(canvas.getByRole("menuitem", { name })).toBeVisible();
    }

    // The row says the value it is moving **to**, not that it is a toggle — a menu built a moment
    // before a change must not write the opposite of what it says.
    // One card of the two, because the menu filters the deck's rows by this pile's id.
    await userEvent.click(canvas.getByRole("menuitem", { name: "Export cards…" }));
    await expect(args.act).toHaveBeenCalledWith(`export:${RAMP_PILE.name}:1`);
  },
};

/**
 * The Commander zone, where two rows are **absent rather than greyed** — and it is the backend
 * that decides which two.
 *
 * `rename_category` and `delete_category` both refuse a category whose `kind` is not `main`, and
 * an item that exists only to be refused is worse than one that is not there. **The switch is not
 * one of them**: `set_category_active` takes every kind, the command zone included, and switching
 * the Maybeboard back on is the single most likely thing anybody wants from its menu.
 */
export const PredefinedZone: Story = {
  args: {
    label: "Commander",
    build: (act) => buildCategoryMenu({ ...COMMANDER_ZONE, cardCount: 1 }, categoryDeps(act)),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const importRow = await canvas.findByRole("menuitem", { name: "Import cards…" });
    await waitFor(async () => await expect(importRow).toBeVisible(), { timeout: FRAME_WAIT });

    await expect(canvas.queryByRole("menuitem", { name: "Rename…" })).toBeNull();
    await expect(canvas.queryByRole("menuitem", { name: "Delete…" })).toBeNull();
    // Present, because deactivating the command zone is a legal (if unwise) thing to do and the
    // validation panel reports the missing commander, which is the honest cost.
    await expect(canvas.getByRole("menuitem", { name: "Deactivate" })).toBeVisible();
    // And the clear is present too, which is the row that shows the absences above are the
    // *backend's* answer rather than a rule about predefined zones: nothing refuses a clear, so
    // nothing takes it away. Emptying the Sideboard between two rounds is the obvious case.
    await expect(canvas.getByRole("menuitem", { name: "Clear stack…" })).toBeVisible();
  },
};

/**
 * A pile with nothing in the list on screen: **the clear stays and greys**, where the two rows
 * above are dropped.
 *
 * The difference is what the greying means. `Rename…` and `Delete…` are absent because
 * `deck_meta.rs` refuses them on a `kind` that is not `main`, and an item existing only to be
 * refused is worse than one that is not there. This row would simply write nothing — so it keeps
 * its position, which is what lets a reader who has cleared this pile before find it where they
 * left it, and carries `aria-disabled` rather than `disabled` so it stays readable and stays in
 * the tab order.
 *
 * The count consulted is `cardCount`, **the variant on screen** — never `cardCountAllVariants`,
 * which is what the delete confirmation quotes. This pile holds three copies in the theory list
 * and none here, and a clear cannot reach them.
 */
export const EmptyPileCannotBeCleared: Story = {
  args: {
    label: "Ramp",
    build: (act) =>
      buildCategoryMenu(
        { ...RAMP_PILE, cardCount: 0, cardCountAllVariants: 3 },
        categoryDeps(act),
      ),
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const row = await canvas.findByRole("menuitem", { name: /Clear stack…/ });
    await waitFor(async () => await expect(row).toBeVisible(), { timeout: FRAME_WAIT });

    await expect(row).toHaveAttribute("aria-disabled", "true");
    await expect(within(row).getByText("already empty")).toBeInTheDocument();

    await userEvent.click(row);
    await expect(args.act).not.toHaveBeenCalled();
  },
};

/**
 * **Clearing a pile asks first, and the menu cannot reach the write.**
 *
 * `CategoryMenuDeps` carries an `askClear` and no clear mutation — the fence `Delete…` has, and
 * the fence `buildDeckMenu` puts around a deck. The card menu's own `Remove card` deliberately
 * has no such question: one card is one add to put back, and a pile is a column to rebuild.
 */
export const ClearingAPileAsksFirst: Story = {
  args: {
    label: "Ramp",
    build: (act) => buildCategoryMenu(RAMP_PILE, categoryDeps(act)),
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const row = await canvas.findByRole("menuitem", { name: "Clear stack…" });
    await waitFor(async () => await expect(row).toBeVisible(), { timeout: FRAME_WAIT });

    await userEvent.click(row);

    await expect(args.act).toHaveBeenCalledWith(`ask-clear-pile:${RAMP_PILE.id}`);
  },
};
