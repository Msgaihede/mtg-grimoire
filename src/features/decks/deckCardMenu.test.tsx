import { describe, expect, it, vi } from "vitest";
import type {
  MenuAction,
  MenuItem,
  MenuRadio,
  MenuSubmenu,
} from "@/components/menu/types";
import type { CardMenuDeps } from "@/features/card/cardMenu";
import type { DeckCard, DeckCategory, DeckTag } from "@/lib/ipc";
import { MARKETPLACES } from "@/lib/marketplace";
import { buildDeckCardMenu, deckCardTagRows, type DeckCardMenuDeps } from "./deckCardMenu";
import { card, spec } from "./validation/fixtures";

/** The shared builder's own dependencies, stubbed — this file is about the deck's extras,
 *  and `cardMenu.test.tsx` owns the rows above the rule. */
const CARD_DEPS: CardMenuDeps = {
  marketplace: MARKETPLACES.tcgplayer,
  addToCollection: vi.fn(),
  addToWishlist: vi.fn(),
  openAllPrintings: vi.fn(),
  DeckTargetSubmenu: () => null,
};

function category(
  id: number,
  name: string,
  kind: DeckCategory["kind"],
  sortOrder: number,
  over: Partial<DeckCategory> = {},
): DeckCategory {
  return {
    id,
    deckId: 4,
    name,
    kind,
    isActive: true,
    origin: "user",
    sortOrder,
    cardCount: 0,
    totalPrice: null,
    cardCountAllVariants: 0,
    ...over,
  };
}

/**
 * The deck's piles **in the reader's own `sortOrder`**, which is deliberately not the alphabet
 * — that is what makes the order assertion below discriminate at all.
 *
 * `Recursion` is `origin: "auto"` and holds nothing, so `drawsWhenEmpty` keeps it off the desk
 * entirely. It is the one pile a drag cannot reach and the whole reason this menu exists.
 */
const CATEGORIES: DeckCategory[] = [
  category(3, "Commander", "commander", 0),
  category(1, "Main deck", "main", 1),
  category(7, "Recursion", "main", 2, { origin: "auto" }),
  category(2, "Sideboard", "side", 3),
  category(4, "Companion", "companion", 4),
];

const CATEGORY_ORDER = ["Commander", "Main deck", "Recursion", "Sideboard", "Companion"];

const TAGS: DeckTag[] = [
  { id: 8, deckId: 4, name: "Budget swap", color: "moss", cardCount: 2 },
  { id: 9, deckId: 4, name: "Cut candidate", color: "ember", cardCount: 1 },
];

function bolt(over: Partial<DeckCard> = {}): DeckCard {
  return card({ name: "Lightning Bolt", quantity: 1, ...over });
}

function deps(over: Partial<DeckCardMenuDeps> = {}): DeckCardMenuDeps {
  return {
    card: CARD_DEPS,
    categories: CATEGORIES,
    cards: [],
    spec: spec("modern"),
    setFinish: vi.fn(),
    moveTo: vi.fn(),
    setTag: vi.fn(),
    tags: TAGS,
    newTag: vi.fn(),
    remove: vi.fn(),
    ...over,
  };
}

const labels = (items: MenuItem[]) =>
  items.filter((i) => i.kind !== "separator").map((i) => i.label);

function find(items: MenuItem[], label: string | RegExp): MenuItem {
  const match = items.find(
    (i) =>
      i.kind !== "separator" &&
      (typeof label === "string" ? i.label === label : label.test(i.label)),
  );
  if (!match) throw new Error(`no row called ${String(label)} in [${labels(items).join(", ")}]`);
  return match;
}

const has = (items: MenuItem[], label: string | RegExp) =>
  items.some(
    (i) =>
      i.kind !== "separator" &&
      (typeof label === "string" ? i.label === label : label.test(i.label)),
  );

describe("buildDeckCardMenu", () => {
  /** The deck's rows are an *addition*: a card in a deck is still a card, so everything every
   *  other card surface offers is here and in the same order. */
  it("keeps the card menu's own rows in front of the deck's", () => {
    const items = buildDeckCardMenu(bolt(), deps());
    expect(labels(items).slice(0, 5)).toEqual([
      "Copy card name",
      "Copy card image",
      "Open on",
      "View all printings",
      "Add to",
    ]);
    expect(labels(items).slice(5)).toEqual([
      "Move to",
      "Set as companion",
      // The finish row sits with the zone rows rather than with `Move to`: those say what this
      // card *is* in the deck, and so does this. `Move to` is filing.
      "Set as foil",
      "Tag card",
      "Remove card",
    ]);
  });

  /**
   * **The finish row, and the three shapes that question has** — `collectionItem`'s rule one
   * file over, for its reason: a choice with one answer is not a choice.
   */
  describe("the finish row", () => {
    const BOTH = '["nonfoil","foil"]';

    /**
     * By **id**, not by label — `find` matches labels, and `Set as commander` and `Set as
     * companion` are two rows above this one that a `/^Set as/` regex swallows. The id is the
     * one thing the row keeps through all three of its shapes.
     */
    const finishRow = (items: MenuItem[]): Exclude<MenuItem, { kind: "separator" }> => {
      const row = items.find(
        (i): i is Exclude<MenuItem, { kind: "separator" }> =>
          i.kind !== "separator" && i.id === "finish",
      );
      if (!row) throw new Error(`no finish row in [${labels(items).join(", ")}]`);
      return row;
    };

    it("toggles in one press on a printing sold in two finishes", () => {
      const setFinish = vi.fn();
      const card = bolt({ finishes: BOTH, finish: null });
      const row = finishRow(buildDeckCardMenu(card, deps({ setFinish })));

      expect(row.label).toBe("Set as foil");
      expect(row.kind).toBe("action");
      if (row.kind === "action") row.onSelect();
      expect(setFinish).toHaveBeenCalledWith(card, "foil");
    });

    it("names the way back when the row is already foil", () => {
      const setFinish = vi.fn();
      const card = bolt({ finishes: BOTH, finish: "foil" });
      const row = finishRow(buildDeckCardMenu(card, deps({ setFinish })));

      // `regular`, not `nonfoil`: "set as nonfoil" is not a thing anybody says.
      expect(row.label).toBe("Set as regular");
      if (row.kind === "action") row.onSelect();
      expect(setFinish).toHaveBeenCalledWith(card, null);
    });

    it("offers a submenu of the printing's own finishes when it is sold in three", () => {
      const card = bolt({ finishes: '["nonfoil","foil","etched"]', finish: "foil" });
      const row = finishRow(buildDeckCardMenu(card, deps()));

      expect(row.kind).toBe("submenu");
      if (row.kind !== "submenu") return;
      // Scryfall's order — plain, then the premium treatments — and deliberately not
      // `sortOptions`': the order *is* the information here.
      expect(labels(row.items)).toEqual(["Regular", "Foil", "Etched"]);
      // The finish it already is, drawn and greyed rather than dropped, so the list keeps its
      // length and its positions.
      expect(row.items.map((i) => i.kind === "action" && i.disabled === true)).toEqual([
        false,
        true,
        false,
      ]);
    });

    /**
     * **Greyed, and silent.** This menu's own precedent (`zoneItem`) rather than
     * `cardMenu.tsx`'s greyed-with-a-reason: a menu row is sized by its widest content, so a
     * sentence on a row that greys on a large minority of cards would set the width of every
     * row in the panel.
     */
    it("greys on a printing sold in one finish, and says nothing", () => {
      const row = finishRow(buildDeckCardMenu(bolt({ finishes: '["nonfoil"]' }), deps()));

      expect(row.kind === "action" && row.disabled).toBe(true);
      expect(row.kind === "action" && row.reason).toBeUndefined();
    });

    /** A printing whose `finishes` column is empty or unreadable is *unknown*, not a choice to
     *  offer — the same floor `finishChoices` gives the collection picker. */
    it("greys on a printing whose finish list is missing", () => {
      const row = finishRow(buildDeckCardMenu(bolt({ finishes: null }), deps()));
      expect(row.kind === "action" && row.disabled).toBe(true);
    });

    /** The row stays **present** when it is greyed, so its position never moves — `View all
     *  printings`' rule, for its reason. */
    it("keeps its place in the list when it is greyed", () => {
      const at = (finishes: string | null) =>
        buildDeckCardMenu(bolt({ finishes }), deps()).findIndex(
          (i) => i.kind !== "separator" && i.id === "finish",
        );

      expect(at('["nonfoil"]')).toBe(at(BOTH));
      expect(at('["nonfoil","foil","etched"]')).toBe(at(BOTH));
    });
  });

  /**
   * **`Remove card` sits below a rule of its own**, and the rule is the point: everything above
   * it says where this card goes or what it is called, and this one takes the cardboard out. A
   * row that removes a card must not sit flush against the row that renames its label.
   *
   * `labels` strips separators, so nothing else in this file can see one being dropped.
   */
  it("puts a rule between the card's filing rows and the row that removes it", () => {
    const items = buildDeckCardMenu(bolt(), deps());
    const shape = items.map((item) => (item.kind === "separator" ? `—${item.id}` : item.id));

    expect(shape.slice(-2)).toEqual(["—sep-remove", "remove-card"]);
  });

  /**
   * One press, no confirmation — where the *pile's* `Clear stack…` has one. The asymmetry is
   * deliberate: one card is one add to put back and the reader can see which one it was, and a
   * pile is a column they would have to rebuild.
   */
  it("removes the card that was right-clicked, with nothing to confirm", () => {
    const remove = vi.fn();
    const row = bolt({ categoryId: 1 });

    (find(buildDeckCardMenu(row, deps({ remove })), "Remove card") as MenuAction).onSelect();

    expect(remove).toHaveBeenCalledWith(row);
  });

  /**
   * **Built from the deck's `categories`, never from the drawn groups**, which is the whole
   * point of the row: `Recursion` is an emptied `auto` pile, so no heading is drawn for it and
   * a drag cannot reach it at all. This is the replacement for the `Move…` select removed on
   * 2026-08-14, not a duplicate of the drag.
   */
  it("lists every category of the deck, including one with no heading on screen", () => {
    const move = find(buildDeckCardMenu(bolt(), deps()), "Move to") as MenuSubmenu;
    expect(labels(move.items)).toContain("Recursion");
  });

  /**
   * **Deck categories are a documented exemption from `sortOptions`** — an order the reader
   * arranged themselves — so the alphabet must not touch this list. Sorted, it would read
   * Commander, Companion, Main deck, Recursion, Sideboard.
   */
  it("keeps the reader's own category order rather than sorting it", () => {
    const move = find(buildDeckCardMenu(bolt(), deps()), "Move to") as MenuSubmenu;
    expect(labels(move.items)).toEqual(CATEGORY_ORDER);
    expect(labels(move.items)).not.toEqual([...CATEGORY_ORDER].sort());
  });

  /** The pile the card is already in is drawn and greyed rather than dropped: "every category"
   *  is what makes the list findable, and a press that wrote a move from a pile to itself
   *  would be a write that means nothing. */
  it("greys the pile the card is already in, with the reason", () => {
    const items = buildDeckCardMenu(bolt({ categoryId: 1 }), deps());
    const move = find(items, "Move to") as MenuSubmenu;
    const here = find(move.items, "Main deck") as MenuAction;
    expect(here.disabled).toBe(true);
    expect(here.reason).toMatch(/already/i);
  });

  it("moves the card into the pile that was pressed", () => {
    const moveTo = vi.fn();
    const row = bolt({ categoryId: 1 });
    const move = find(buildDeckCardMenu(row, deps({ moveTo })), "Move to") as MenuSubmenu;
    (find(move.items, "Recursion") as MenuAction).onSelect();
    expect(moveTo).toHaveBeenCalledWith(row, 7);
  });

  it("offers no commander row in a format with no command zone", () => {
    expect(has(buildDeckCardMenu(bolt(), deps()), /commander/i)).toBe(false);
  });

  /**
   * The test underneath is `commanderIneligibility`'s own — the rule the validation panel judges
   * a built deck by and the importer offers candidates by. A looser one here would offer a card
   * the panel then refuses.
   *
   * **No `reason`, and that is the assertion worth having** (2026-08-17): the rule's sentences
   * are written for the validation panel, and drawing one here set the width of every row in the
   * menu. The row greys; the words live where there is room for them.
   */
  it("greys the commander row for an ineligible card, wordlessly", () => {
    const items = buildDeckCardMenu(bolt(), deps({ spec: spec("commander") }));
    const row = find(items, "Set as commander") as MenuAction;
    expect(row.disabled).toBe(true);
    expect(row.reason).toBeUndefined();
  });

  it("offers the commander row live for an eligible card, and sends it to the command zone", () => {
    const moveTo = vi.fn();
    const atraxa = card({
      name: "Atraxa, Praetors' Voice",
      typeLine: "Legendary Creature — Phyrexian Angel Horror",
      power: "4",
      toughness: "4",
      quantity: 1,
    });
    const items = buildDeckCardMenu(atraxa, deps({ spec: spec("commander"), moveTo }));
    const row = find(items, "Set as commander") as MenuAction;
    expect(row.disabled).toBeUndefined();
    row.onSelect();
    expect(moveTo).toHaveBeenCalledWith(atraxa, 3);
  });

  /** Gladiator is the one seeded format with no sideboard, so it has no slot a companion could
   *  sit in — the row is absent rather than greyed, exactly as the category menu drops the two
   *  rows the backend would refuse. */
  it("offers no companion row where the format has no sideboard", () => {
    const items = buildDeckCardMenu(bolt(), deps({ spec: spec("gladiator") }));
    expect(has(items, /companion/i)).toBe(false);
  });

  it("greys the companion row for a card with no companion ability, wordlessly", () => {
    const row = find(buildDeckCardMenu(bolt(), deps()), "Set as companion") as MenuAction;
    expect(row.disabled).toBe(true);
    expect(row.reason).toBeUndefined();
  });

  it("offers the companion row for a real companion whose condition the deck meets", () => {
    const moveTo = vi.fn();
    const jegantha = card({
      name: "Jegantha, the Wellspring",
      typeLine: "Legendary Creature — Elemental Elk",
      manaCost: "{R}{G}",
      quantity: 1,
    });
    const items = buildDeckCardMenu(
      jegantha,
      deps({ cards: [bolt(), jegantha], moveTo, spec: spec("commander") }),
    );
    const row = find(items, "Set as companion") as MenuAction;
    expect(row.disabled).toBeUndefined();
    row.onSelect();
    expect(moveTo).toHaveBeenCalledWith(jegantha, 4);
  });

  /**
   * The reigning commander gets a greyed row rather than a live one — the write would be a move
   * from a category to itself, which is the same nothing `Move to`'s own pile is greyed for.
   * Worth its own case because the test is *not* `commanderIneligibility`'s: the card in the
   * command zone is by definition an eligible one, so an eligibility test alone would offer it.
   *
   * `ALREADY_HERE` is still what greys it and is no longer drawn on it — a zone row words
   * nothing, whichever of the two refusals it met. `Move to`'s own pile still draws that string.
   */
  it("greys the zone row on the card that is already in it", () => {
    const atraxa = card({
      name: "Atraxa, Praetors' Voice",
      categoryKind: "commander",
      typeLine: "Legendary Creature — Phyrexian Angel Horror",
      power: "4",
      toughness: "4",
      quantity: 1,
    });
    // `fixtures.ts` files a `commander` card under its own category id, which is this deck's.
    const items = buildDeckCardMenu(atraxa, deps({ spec: spec("commander") }));
    const row = find(items, "Set as commander") as MenuAction;
    expect(row.disabled).toBe(true);
    expect(row.reason).toBeUndefined();
  });

  /** A deck whose seeded zone has been lost cannot be written to, so nothing offers it: an
   *  item that exists only to be refused is worse than one that is not there. */
  it("draws no commander row when the deck has no command zone to move into", () => {
    const items = buildDeckCardMenu(
      bolt(),
      deps({ spec: spec("commander"), categories: CATEGORIES.filter((c) => c.kind !== "commander") }),
    );
    expect(has(items, "Set as commander")).toBe(false);
  });

  /**
   * **`submenu`, not `lazy` — and that is a fact about the rows rather than a preference.**
   *
   * The kind was `lazy` for one reason: a `MenuItem[]` cannot carry a text input, and "New tag…"
   * was one until 2026-08-20. It is a row now, so nothing in this submenu mounts, queries or
   * holds state — the labels come from `deps.tags`, which the editor already holds from
   * `deck_get`. A `lazy` here would be a component mounted to draw four radios.
   */
  it("builds the tag rows as a plain submenu, with nothing to mount", () => {
    const row = find(buildDeckCardMenu(bolt(), deps()), "Tag card") as MenuSubmenu;
    expect(row.kind).toBe("submenu");
    expect(labels(row.items)).toEqual(["None", "Budget swap", "Cut candidate", "New tag…"]);
  });

  /**
   * The row that opens `NewTagDialog`, and the whole of what it does: hand the card up.
   *
   * **It must not write.** The field this replaced created the label and attached it, and the
   * attach belonged to an observer the panel took with it when it closed — so a create still in
   * flight at a dismissal lost its second half silently. The surface owns both halves now, and
   * a row that reached for either would be that bug coming back.
   */
  it("hands the card to the surface when New tag… is pressed", () => {
    const target = bolt();
    const wired = deps();
    const row = find(buildDeckCardMenu(target, wired), "Tag card") as MenuSubmenu;
    const item = find(row.items, "New tag…") as MenuAction;

    item.onSelect();

    expect(wired.newTag).toHaveBeenCalledWith(target);
    expect(wired.setTag).not.toHaveBeenCalled();
  });
});

describe("deckCardTagRows", () => {
  /** A deck card wears **at most one** tag — `setTag` takes `tagId: number | null` — so these
   *  are radios and "None" is the row that takes the label off. */
  it("offers None first and ticks the tag the card is wearing", () => {
    const rows = deckCardTagRows(bolt({ tagId: 8, tagName: "Budget swap" }), TAGS, vi.fn());
    expect(labels(rows)).toEqual(["None", "Budget swap", "Cut candidate"]);
    expect(rows.every((r) => r.kind === "radio")).toBe(true);
    expect((find(rows, "None") as MenuRadio).checked).toBe(false);
    expect((find(rows, "Budget swap") as MenuRadio).checked).toBe(true);
    expect((find(rows, "Cut candidate") as MenuRadio).checked).toBe(false);
  });

  it("ticks None for a card wearing no tag", () => {
    const rows = deckCardTagRows(bolt(), TAGS, vi.fn());
    expect((find(rows, "None") as MenuRadio).checked).toBe(true);
  });

  /**
   * **The app's collator, not SQLite's BINARY collation.**
   *
   * `deck_meta.rs`'s `ORDER BY t.name` is a `TEXT` column with no `COLLATE NOCASE`, so the list
   * arrives in byte order: every capitalised label sorts above every lower-case one, and a
   * reader looking for "budget" under B finds it at the bottom. Ordering is a *display* decision
   * and lives in TS — `sortOptions`' `Intl.Collator("en", { sensitivity: "base" })`, which is
   * what every other option list in this app is drawn through — so Rust's `ORDER BY` is not the
   * bug and is not what changed.
   *
   * "None" stays pinned in front: it is the row that takes a label *off*, not one of the labels.
   */
  it("draws the labels through the app's collator rather than in the order they arrived", () => {
    const arrived: DeckTag[] = [
      { id: 1, deckId: 4, name: "Cut", color: "ember", cardCount: 0 },
      { id: 2, deckId: 4, name: "budget", color: "moss", cardCount: 0 },
      { id: 3, deckId: 4, name: "Ramp", color: "gold", cardCount: 0 },
    ];

    expect(labels(deckCardTagRows(bolt(), arrived, vi.fn()))).toEqual([
      "None",
      "budget",
      "Cut",
      "Ramp",
    ]);
  });

  it("takes the label off with null and puts one on by id", () => {
    const setTag = vi.fn();
    const row = bolt({ tagId: 8 });
    const rows = deckCardTagRows(row, TAGS, setTag);
    (find(rows, "None") as MenuRadio).onSelect();
    expect(setTag).toHaveBeenCalledWith(row, null);
    (find(rows, "Cut candidate") as MenuRadio).onSelect();
    expect(setTag).toHaveBeenLastCalledWith(row, 9);
  });
});
