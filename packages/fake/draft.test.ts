/**
 * The fake's Draft & Packs commands — enough of each for a story to click through: a booster set
 * whose products hold sheets of the world's own cards, a draft that passes packs and ends in
 * deckbuilding, a draft deck that is a virtual Limited deck with a Deck and a Pool pile on the
 * unsaved list, and lobbies that refuse.
 */
import { describe, expect, it } from "vitest";
import type { DraftSetup } from "@grimoire/ui/lib/ipc";
import { allHandlers, makeDb, writeHandlers } from "./db";
import {
  createDraftDeck,
  DRAFT_REPLACED,
  LOBBIES_OFF,
  NOT_IN_PACK,
  NOT_YOUR_PILE,
  WINSTON_NO_PICK,
  WRONG_COUNT,
} from "./draft";

function world() {
  const db = makeDb();
  return { db, h: allHandlers(db) };
}

/** A two-seat, two-round draft of three-card packs, from the world's own printings. */
function setup(db: ReturnType<typeof makeDb>, mode: DraftSetup["mode"] = "quick"): DraftSetup {
  const ids = db.cards.slice(0, 12).map((c) => c.id);
  return {
    mode,
    difficulty: "medium",
    seed: 1,
    label: "Fake · Fake",
    seats: [
      { name: "You", bot: false, peer: null },
      { name: "Bot 1", bot: true, peer: null },
    ],
    packs: [
      [ids.slice(0, 3), ids.slice(3, 6)],
      [ids.slice(6, 9), ids.slice(9, 12)],
    ],
    packSets: ["", ""],
    minDeckSize: mode === "commander" ? 60 : 40,
    podFormat: "booster",
  };
}

describe("packs_booster_set", () => {
  it("answers a play and a collector product, and sealed products that hold boosters", () => {
    const { h } = world();
    const set = h.packs_booster_set({ setCode: "LEA", refresh: false });
    expect(set.code).toBe("lea");
    expect(set.products.map((p) => p.key)).toEqual(["play", "collector"]);
    for (const product of set.products) {
      for (const sheet of product.sheets) {
        expect(sheet.cards.length).toBeGreaterThan(0);
        expect(sheet.totalWeight).toBe(sheet.cards.reduce((n, c) => n + c.weight, 0));
      }
      for (const variant of product.variants) {
        for (const slot of variant.slots) {
          expect(product.sheets.map((s) => s.name)).toContain(slot.sheet);
        }
      }
    }
    const box = set.sealed.find((s) => s.category === "booster_box");
    expect(box?.packs).toEqual([{ set: "lea", product: "play", count: 30 }]);
    const caseOf = set.sealed.find((s) => s.category === "booster_case");
    expect(caseOf?.sealed[0]?.uuid).toBe(box?.uuid);
    // Every card a sheet names is in the set's card list.
    const known = new Set(set.cards.map((c) => c.cardId));
    for (const p of set.products)
      for (const s of p.sheets)
        for (const c of s.cards) {
          expect(known.has(c.cardId)).toBe(true);
        }
  });
});

describe("the draft", () => {
  it("passes packs round the table until every pack is empty, then builds", () => {
    const { db, h } = world();
    let view = h.draft_start({ setup: setup(db), draft: 1 });
    expect(view.status).toBe("drafting");
    expect(view.pack).toHaveLength(3);
    expect(view.packCount).toBe(2);

    for (let n = 0; n < 6; n++) {
      view = h.draft_pick({ draft: 1, cardInstanceIds: [view.pack[0].instanceId] });
    }
    expect(view.status).toBe("deckbuilding");
    expect(view.pack).toEqual([]);
    expect(view.pool).toHaveLength(6);
    expect(view.seats.map((s) => s.poolCount)).toEqual([6, 6]);
    expect(h.draft_saved()).toMatchObject({ status: "deckbuilding", label: "Fake · Fake" });
  });

  it("answers fresh arrays, so a later pick never grows a view the page holds", () => {
    const { db, h } = world();
    const first = h.draft_start({ setup: setup(db), draft: 1 });
    const pool = first.pool;
    const next = h.draft_pick({ draft: 1, cardInstanceIds: [first.pack[0].instanceId] });
    expect(pool).toEqual([]);
    expect(next.pool).toHaveLength(1);
    expect(next.pool).not.toBe(pool);
  });

  it("refuses a card not in the pack and a replaced draft's name", () => {
    const { db, h } = world();
    h.draft_start({ setup: setup(db), draft: 1 });
    expect(() => h.draft_pick({ draft: 1, cardInstanceIds: ["nope"] })).toThrow(NOT_IN_PACK);
    h.draft_start({ setup: setup(db), draft: 2 });
    expect(() => h.draft_auto_pick({ draft: 1 })).toThrow(DRAFT_REPLACED);
    expect(h.draft_view({ draft: 1 })).toBeNull();
    expect(h.draft_auto_pick({ draft: 2 }).pool).toHaveLength(1);
  });

  it("deals a sealed pool straight into deckbuilding", () => {
    const { db, h } = world();
    const view = h.draft_start({ setup: setup(db, "sealed"), draft: 1 });
    expect(view.status).toBe("deckbuilding");
    expect(view.pool).toHaveLength(6);
  });

  it("takes two cards a pick in a Commander draft, the bots two as well", () => {
    const { db, h } = world();
    let view = h.draft_start({ setup: setup(db, "commander"), draft: 1 });
    expect(view).toMatchObject({ picksPerStep: 2, commanders: 1, stack: null, minDeckSize: 60 });
    expect(() => h.draft_pick({ draft: 1, cardInstanceIds: [view.pack[0].instanceId] })).toThrow(
      WRONG_COUNT(2),
    );
    view = h.draft_pick({
      draft: 1,
      cardInstanceIds: view.pack.slice(0, 2).map((c) => c.instanceId),
    });
    expect(view.pool).toHaveLength(2);
    expect(view.seats.map((s) => s.poolCount)).toEqual([2, 2]);
    // One card left in the pack: the pick takes what there is.
    expect(view.pack).toHaveLength(1);
    view = h.draft_auto_pick({ draft: 1 });
    expect(view.pool).toHaveLength(3);
    expect(view.packNumber).toBe(1);
  });

  it("plays a Winston draft: take, decline, and a bot that takes the first pile", () => {
    const { db, h } = world();
    let view = h.draft_start({ setup: setup(db, "winston"), draft: 1 });
    expect(view.stack).toMatchObject({ mainCount: 9, turnSeat: 0, yourTurn: true, activePile: 0 });
    expect(view.stack?.piles.map((p) => p.count)).toEqual([1, 1, 1]);
    expect(view.stack?.piles[0].cards).toHaveLength(1);
    expect(view.stack?.piles[1].cards).toEqual([]);
    expect(() => h.draft_pick({ draft: 1, cardInstanceIds: ["x"] })).toThrow(WINSTON_NO_PICK);
    expect(() => h.draft_winston({ draft: 1, pile: 1, take: true })).toThrow(NOT_YOUR_PILE);

    // Decline pile 1: it grows by the stack's top card and pile 2 is looked at.
    view = h.draft_winston({ draft: 1, pile: 0, take: false });
    expect(view.stack).toMatchObject({ mainCount: 8, activePile: 1, yourTurn: true });
    expect(view.stack?.piles.map((p) => p.count)).toEqual([2, 1, 1]);

    // Take pile 2: it is refilled, and the bot takes pile 1 (both its cards) before the answer.
    view = h.draft_winston({ draft: 1, pile: 1, take: true });
    expect(view.pool).toHaveLength(1);
    expect(view.seats[1].poolCount).toBe(2);
    expect(view.stack).toMatchObject({ turnSeat: 0, yourTurn: true, activePile: 0, mainCount: 6 });

    while (view.status === "drafting") view = h.draft_auto_pick({ draft: 1 });
    expect(view.stack?.activePile).toBeNull();
    expect(view.pool.length + view.seats[1].poolCount).toBe(12);
  });

  it("puts a draft away with draft_end", () => {
    const { db, h } = world();
    h.draft_start({ setup: setup(db), draft: 1 });
    h.draft_end({ draft: 1 });
    expect(h.draft_saved()).toBeNull();
  });
});

describe("the draft deck", () => {
  it("is a virtual Limited deck with an empty Deck pile and a Pool, on the unsaved list", () => {
    const { db, h } = world();
    const ids = [db.cards[0].id, db.cards[0].id, db.cards[1].id];
    const row = h.draft_deck_create({ name: "Quick Draft", cardIds: ids });
    expect(row).toMatchObject({ name: "Quick Draft", formatKey: "limited", virtualOnly: true });
    expect(h.draft_deck_ids()).toEqual([row.id]);

    const detail = h.deck_get({ id: row.id, variant: "live" });
    expect(detail?.categories.map((c) => [c.name, c.kind])).toEqual([
      ["Deck", "main"],
      ["Pool", "side"],
    ]);
    const pool = detail?.categories.find((c) => c.name === "Pool");
    expect(detail?.cards.every((c) => c.categoryId === pool?.id)).toBe(true);
    expect(detail?.cards.reduce((n, c) => n + c.quantity, 0)).toBe(3);
  });

  it("is a Casual deck with a Commander pile for a Commander draft", () => {
    const { db, h } = world();
    const row = h.draft_deck_create({
      name: "Commander Draft",
      cardIds: [db.cards[0].id],
      commander: true,
    });
    expect(row).toMatchObject({ formatKey: "casual", virtualOnly: true });
    const detail = h.deck_get({ id: row.id, variant: "live" });
    expect(detail?.categories.map((c) => [c.name, c.kind])).toEqual([
      ["Deck", "main"],
      ["Pool", "side"],
      ["Commander", "commander"],
    ]);
  });

  it("leaves the list on a keep, and is deleted on a discard", () => {
    const { db, h } = world();
    const kept = h.draft_deck_create({ name: "Kept", cardIds: [db.cards[0].id] });
    const gone = createDraftDeck(db, writeHandlers(db), "Gone", [db.cards[1].id]);
    h.draft_deck_keep({ deckId: kept.id });
    expect(h.draft_deck_ids()).toEqual([gone.id]);
    h.draft_deck_discard({ deckId: gone.id });
    expect(h.draft_deck_ids()).toEqual([]);
    expect(db.decks.some((d) => d.id === gone.id)).toBe(false);
    expect(db.decks.some((d) => d.id === kept.id)).toBe(true);
  });

  it("answers the basics the corpus holds", () => {
    const { h } = world();
    const lands = h.draft_basic_lands({ setCodes: ["lea"] });
    expect(lands.map((l) => l.color)).toEqual(expect.arrayContaining(["U"]));
    expect(lands.find((l) => l.color === "U")?.name).toBe("Island");
  });
});

describe("lobbies", () => {
  it("answer no lobby, and refuse every write but a leave", () => {
    const { h } = world();
    expect(h.lobby_state()).toBeNull();
    expect(() => h.lobby_create()).toThrow(LOBBIES_OFF);
    expect(() => h.lobby_join()).toThrow(LOBBIES_OFF);
    expect(() => h.lobby_winston()).toThrow(LOBBIES_OFF);
    expect(h.lobby_leave()).toBeUndefined();
  });
});
