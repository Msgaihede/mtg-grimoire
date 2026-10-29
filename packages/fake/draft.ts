/**
 * The fake's Draft & Packs commands (`docs/superpowers/specs/2026-10-29-draft-and-packs-design.md`):
 * a booster set built from the cards this world already seeds, a draft played against bots that
 * take the first card they are passed, the draft deck a pool becomes, and a lobby that is never
 * there.
 *
 * **Enough for a story to click through, and no more.** The real draft is phase.rs's
 * `draft-core` with its bots' heuristics (`crates/grimoire-play/src/draft/`), and the real booster
 * data is MTGJSON's set file; neither is reproduced here. What *is* kept is every shape the page
 * reads — a `BoosterSet` with a `play` and a `collector` product and sealed products that hold
 * boosters (one directly, one through another), a `DraftView` that passes packs left and right
 * and ends in `deckbuilding` (two cards a pick in a Commander draft), a Winston draft's shared
 * stack and three piles against a bot that always takes the first pile, and a draft deck that is
 * a **virtual** `limited` deck with a `Deck` pile and a `Pool` pile on the unsaved list (a Casual
 * one with a `Commander` pile too, for a Commander draft).
 *
 * **State per world, in a `WeakMap` keyed by the `FakeDb`**, the bulk-undo tickets' arrangement:
 * a story's `installWorld` makes a fresh `FakeDb`, so a draft never outlives its story and no
 * field is added to the world's own table.
 *
 * **Lobbies refuse** (`LOBBIES_OFF`), `lobby_winston` with them, — the fake has no relay and no second app to meet in one —
 * except the two reads a page makes on arrival, which answer *no lobby*. A game's lobby (the
 * Playtesting page's, issue #1419) is the same lobby, so its three commands — `lobby_deck`,
 * `lobby_game_start`, `lobby_act` — are here and refuse alike: the game itself is phase.rs's,
 * which the fake has none of either (`parity.test.ts`' `playtest_*`).
 */
import type {
  BasicLand,
  BoosterCard,
  BoosterSet,
  BoosterSheet,
  DeckInput,
  DeckRow,
  DeckVariant,
  DraftCard,
  DraftSaved,
  DraftSetup,
  DraftView,
  EntryChange,
  LobbyState,
  PlaytestStep,
  SealedProduct,
  WinstonView,
} from "@grimoire/ui/lib/ipc";
import type { FakeCard } from "./cards";
import type { FakeDb } from "./db";

/** The sentence every lobby write refuses with. */
export const LOBBIES_OFF = "Lobbies need the desktop app.";
/** `draft_*` naming a draft that is not the one in hand — the host's own refusal, in words. */
export const DRAFT_REPLACED = "That draft has been replaced by another one.";
/** A pick of a card the reader's pack does not hold. */
export const NOT_IN_PACK = "That card is not in your pack.";
/** A pick once every pack is empty. */
export const DRAFT_OVER = "The draft is over — build your deck from the pool.";
/** `draft_resume` with nothing left off. */
export const NOTHING_SAVED = "There is no draft to resume.";
/** A pick of the wrong number of cards — a Commander draft takes two. */
export const WRONG_COUNT = (n: number) => `Pick ${n === 1 ? "one card" : `${n} cards`}.`;
/** `draft_winston` in a draft that is not a Winston draft. */
export const NOT_WINSTON = "This draft has no Winston table.";
/** `draft_pick` in a Winston draft. */
export const WINSTON_NO_PICK = "A Winston draft takes or declines a pile.";
/** `draft_winston` out of turn, or on a pile the turn is not looking at. */
export const NOT_YOUR_PILE = "That pile is not the one in front of you.";
/** Declining the last pile with the stack empty — nothing is left to take blind. */
export const STACK_EMPTY = "The stack is empty — take this pile.";

/** Milliseconds: when every fake booster file was "fetched", and every draft last moved. Fixed,
 *  so a story's *Draft in progress* line reads the same on every run. */
const FAKE_NOW_MS = 1_786_266_000_000;

/** The deck writes a draft deck is made with — `writeHandlers`' own, handed in by `allHandlers`
 *  so this module imports no value from `db.ts` (which imports this one). */
export interface DraftDeckWrites {
  deck_create: (args: { deck: DeckInput }) => DeckRow;
  deck_add_card: (args: {
    deckId: number;
    cardId: string;
    categoryId: number | null;
    categoryName: string | null;
    variant: DeckVariant;
    quantity: number;
  }) => EntryChange;
  deck_delete: (args: { id: number }) => void;
}

/* ------------------------------------------------------------------ the world's draft state */

interface DraftState {
  /** The page's name for the draft; a call naming another is refused. */
  name: number;
  setup: DraftSetup;
  round: number;
  pick: number;
  packSize: number;
  /** The pack each seat holds now. */
  packs: DraftCard[][];
  pools: DraftCard[][];
  done: boolean;
  /** A Winston draft's table; `null` for every other. */
  winston: WinstonState | null;
}

/** The shared stack, its three piles, whose turn and which pile it is looking at. */
interface WinstonState {
  main: DraftCard[];
  piles: DraftCard[][];
  turn: number;
  active: number;
}

/** A Winston table's piles (draft-core's `SharedStackPiles { pile_count: 3 }`). */
const WINSTON_PILES = 3;

interface DraftWorld {
  draft: DraftState | null;
  /** `app_meta` `draft_decks`: the decks a draft made and the reader has not saved. */
  draftDecks: number[];
}

const WORLDS = new WeakMap<FakeDb, DraftWorld>();

function worldOf(db: FakeDb): DraftWorld {
  let world = WORLDS.get(db);
  if (world === undefined) {
    world = { draft: null, draftDecks: [] };
    WORLDS.set(db, world);
  }
  return world;
}

/* ------------------------------------------------------------------ cards */

/** The corpus's own printings a booster may hold: no tokens, no basics, no helper cards. */
function boosterCards(db: FakeDb): FakeCard[] {
  return db.cards.filter(
    (c) =>
      c.setType !== "token" &&
      c.setType !== "memorabilia" &&
      !/\bToken\b/.test(c.typeLine ?? "") &&
      !/\bBasic\b/.test(c.typeLine ?? ""),
  );
}

function boosterCard(c: FakeCard): BoosterCard {
  return {
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
  };
}

function draftCard(db: FakeDb, cardId: string, seat: number, round: number, n: number): DraftCard {
  const c = db.cards.find((card) => card.id === cardId);
  return {
    instanceId: `${cardId}#${seat}.${round}.${n}`,
    cardId,
    name: c?.name ?? "Unknown card",
    setCode: c?.setCode ?? "",
    collectorNumber: c?.collectorNumber ?? "",
    rarity: c?.rarity ?? "common",
    colors: (c?.colors ?? "").split("").filter((l) => l.trim() !== ""),
    cmc: Math.round(c?.cmc ?? 0),
    typeLine: c?.typeLine ?? "",
  };
}

/* ------------------------------------------------------------------ boosters */

function sheet(
  name: string,
  cards: readonly FakeCard[],
  opts: { foil?: boolean; weight?: (c: FakeCard) => number } = {},
): BoosterSheet {
  const weight = opts.weight ?? (() => 1);
  const sheetCards = cards.map((c) => ({ cardId: c.id, weight: weight(c) }));
  return {
    name,
    foil: opts.foil === true,
    fixed: false,
    allowDuplicates: false,
    balanceColors: false,
    totalWeight: sheetCards.reduce((n, c) => n + c.weight, 0),
    cards: sheetCards,
  };
}

/**
 * `packs_booster_set` — one set's boosters, built from **every** booster-worthy card the world
 * seeds rather than from the set's own: the fake corpus holds a handful of printings per set, and
 * a sheet of three cannot fill a pack of seven commons. The products name the set asked for; the
 * cards keep their own set codes, which MTGJSON's sheets do too (`sourceSetCodes`).
 */
export function fakeBoosterSet(db: FakeDb, setCode: string): BoosterSet {
  const code = setCode.trim().toLowerCase();
  if (code === "") throw new Error("Pick a set first.");
  const pool = boosterCards(db);
  const commons = pool.filter((c) => c.rarity === "common");
  const uncommons = pool.filter((c) => c.rarity === "uncommon");
  const rares = pool.filter((c) => c.rarity === "rare" || c.rarity === "mythic");
  // Mythics are half as likely as a rare on the rare sheet — the printed ratio, near enough.
  const rareWeight = (c: FakeCard) => (c.rarity === "mythic" ? 1 : 2);
  const named = db.cards.find((c) => c.setCode === code)?.setName ?? code.toUpperCase();
  const play = {
    key: "play",
    name: `${named} Play Booster`,
    totalWeight: 1,
    variants: [
      {
        weight: 1,
        slots: [
          { sheet: "common", count: 7 },
          { sheet: "uncommon", count: 3 },
          { sheet: "rareMythic", count: 1 },
          { sheet: "foil", count: 1 },
        ],
      },
    ],
    sheets: [
      sheet("common", commons),
      sheet("uncommon", uncommons),
      sheet("rareMythic", rares, { weight: rareWeight }),
      sheet("foil", pool, { foil: true }),
    ],
  };
  // Two variants, so a story's expected value is weighted rather than one sum.
  const collector = {
    key: "collector",
    name: `${named} Collector Booster`,
    totalWeight: 4,
    variants: [
      {
        weight: 3,
        slots: [
          { sheet: "commonFoil", count: 4 },
          { sheet: "uncommonFoil", count: 3 },
          { sheet: "rareMythicFoil", count: 1 },
        ],
      },
      {
        weight: 1,
        slots: [
          { sheet: "commonFoil", count: 3 },
          { sheet: "uncommonFoil", count: 3 },
          { sheet: "rareMythicFoil", count: 2 },
        ],
      },
    ],
    sheets: [
      sheet("commonFoil", commons, { foil: true }),
      sheet("uncommonFoil", uncommons, { foil: true }),
      sheet("rareMythicFoil", rares, { foil: true, weight: rareWeight }),
    ],
  };
  const boxId = `fake-play-box-${code}`;
  const sealed: SealedProduct[] = [
    {
      uuid: boxId,
      name: `${named} Play Booster Box`,
      category: "booster_box",
      subtype: "play",
      packs: [{ set: code, product: "play", count: 30 }],
      sealed: [],
      cards: [],
    },
    // Boosters held through another sealed product, so `openSealed`'s recursion has a case.
    {
      uuid: `fake-play-case-${code}`,
      name: `${named} Play Booster Case`,
      category: "booster_case",
      subtype: "play",
      packs: [],
      sealed: [{ uuid: boxId, set: code, count: 6 }],
      cards: [],
    },
  ];
  return {
    code,
    name: named,
    releaseDate: db.cards.find((c) => c.setCode === code) === undefined ? null : "2026-01-01",
    products: [play, collector],
    sealed,
    cards: pool.map(boosterCard),
    fetchedAt: FAKE_NOW_MS,
  };
}

/* ------------------------------------------------------------------ the draft */

function rounds(state: DraftState): number {
  return state.setup.packs[0]?.length ?? 0;
}

function openRound(db: FakeDb, state: DraftState, round: number): void {
  state.round = round;
  state.pick = 0;
  state.packs = state.setup.packs.map((byRound, seat) =>
    (byRound[round] ?? []).map((id, n) => draftCard(db, id, seat, round, n)),
  );
  state.packSize = state.packs[0]?.length ?? 0;
}

function passLeft(round: number): boolean {
  return round % 2 === 0;
}

/**
 * The view as a host sends it: **fresh arrays every time**. The engine answers JSON, so a page
 * never holds the engine's own lists; handing back `state.pools[0]` itself would let the next pick
 * grow an array the page has memoised on, and the pool would read "7 cards" over empty columns.
 */
function viewOf(state: DraftState): DraftView {
  const { setup } = state;
  return {
    mode: setup.mode,
    status: state.done ? "deckbuilding" : "drafting",
    label: setup.label,
    seat: 0,
    packNumber: state.round,
    packCount: rounds(state),
    pickNumber: state.pick,
    packSize: state.packSize,
    passLeft: passLeft(state.round),
    pack: state.done ? [] : [...(state.packs[0] ?? [])],
    waiting: false,
    pool: [...(state.pools[0] ?? [])],
    seats: setup.seats.map((s, i) => ({
      name: s.name,
      bot: s.bot,
      connected: true,
      picked: false,
      poolCount: state.pools[i]?.length ?? 0,
    })),
    packSets: [...setup.packSets],
    minDeckSize: setup.minDeckSize,
    podFormat: setup.podFormat ?? "booster",
    picksPerStep: picksPerStep(setup),
    commanders: isCommander(setup) ? 1 : 0,
    stack: state.winston === null ? null : winstonView(state, state.winston),
  };
}

function isCommander(setup: DraftSetup): boolean {
  return setup.mode === "commander" || (setup.mode === "pod" && setup.podFormat === "commander");
}

function isWinston(setup: DraftSetup): boolean {
  return setup.mode === "winston" || (setup.mode === "pod" && setup.podFormat === "winston");
}

function picksPerStep(setup: DraftSetup): number {
  return isCommander(setup) ? 2 : 1;
}

function winstonView(state: DraftState, w: WinstonState): WinstonView {
  const yourTurn = !state.done && w.turn === 0;
  return {
    mainCount: w.main.length,
    piles: w.piles.map((pile, i) => ({
      count: pile.length,
      cards: yourTurn && i === w.active ? [...pile] : [],
      active: !state.done && i === w.active,
    })),
    turnSeat: w.turn,
    yourTurn,
    activePile: state.done ? null : w.active,
  };
}

/**
 * Seat 0 takes `ids` (one card, or two in a Commander draft), every other seat takes as many from
 * the front of what it holds (the fake's bots, and the fake's people in a pod), and the packs move
 * on — left in rounds 1 and 3, right in round 2. An
 * empty table opens the next round, or ends the draft.
 */
function pickAll(db: FakeDb, state: DraftState, ids: readonly string[]): void {
  if (state.done) throw new Error(DRAFT_OVER);
  if (state.winston !== null) throw new Error(WINSTON_NO_PICK);
  const mine = state.packs[0] ?? [];
  if (ids.length === 0 || ids.some((id) => !mine.some((c) => c.instanceId === id))) {
    throw new Error(NOT_IN_PACK);
  }
  const need = Math.min(picksPerStep(state.setup), mine.length);
  if (new Set(ids).size !== need) throw new Error(WRONG_COUNT(need));
  const seats = state.packs.length;
  for (let seat = 0; seat < seats; seat++) {
    const pack = state.packs[seat];
    const taken =
      seat === 0 ? pack.filter((c) => ids.includes(c.instanceId)) : pack.slice(0, ids.length);
    state.pools[seat].push(...taken);
    state.packs[seat] = pack.filter((c) => !taken.includes(c));
  }
  const passed: DraftCard[][] = state.packs.map(() => []);
  for (let seat = 0; seat < seats; seat++) {
    const to = passLeft(state.round) ? (seat + 1) % seats : (seat - 1 + seats) % seats;
    passed[to] = state.packs[seat];
  }
  state.packs = passed;
  state.pick += 1;
  if (state.packs.every((p) => p.length === 0)) {
    if (state.round + 1 < rounds(state)) openRound(db, state, state.round + 1);
    else state.done = true;
  }
}

function startDraft(db: FakeDb, setup: DraftSetup, name: number): DraftState {
  if (setup.seats.length === 0) throw new Error("A draft needs at least one seat.");
  if (setup.packs.length !== setup.seats.length) {
    throw new Error("Every seat needs its packs.");
  }
  const state: DraftState = {
    name,
    setup,
    round: 0,
    pick: 0,
    packSize: 0,
    packs: [],
    pools: setup.seats.map(() => []),
    done: false,
    winston: null,
  };
  if (isWinston(setup)) {
    // Every booster into one stack — seat by seat, round by round, unshuffled: the page's deal is
    // already seeded, and a story should see the same piles every run — then a card to each pile.
    const main = setup.packs.flatMap((byRound, seat) =>
      byRound.flatMap((ids, round) => ids.map((id, n) => draftCard(db, id, seat, round, n))),
    );
    const piles = Array.from({ length: WINSTON_PILES }, () => main.splice(0, 1));
    state.packSize = setup.packs[0]?.[0]?.length ?? 0;
    state.winston = { main, piles, turn: 0, active: 0 };
    if (piles.every((p) => p.length === 0)) state.done = true;
  } else if (setup.mode === "sealed") {
    // Sealed: every booster straight into its seat's pool, and nothing to pick.
    state.pools = setup.packs.map((byRound, seat) =>
      byRound.flatMap((ids, round) => ids.map((id, n) => draftCard(db, id, seat, round, n))),
    );
    state.packSize = setup.packs[0]?.[0]?.length ?? 0;
    state.done = true;
  } else {
    openRound(db, state, 0);
  }
  return state;
}

/**
 * One Winston decision by the seat whose turn it is: **take** the pile (into the pool; the pile is
 * refilled with the stack's top card), or **decline** it (the stack's top card joins it, and the
 * next pile is looked at; declining the last takes the stack's top card). A turn that ends hands
 * the table on; the fake's bot then takes the first pile with cards in it, at once.
 */
function winstonDecide(state: DraftState, pile: number, take: boolean): void {
  const w = state.winston;
  if (w === null) throw new Error(NOT_WINSTON);
  if (state.done) throw new Error(DRAFT_OVER);
  if (pile !== w.active) throw new Error(NOT_YOUR_PILE);
  const pool = state.pools[w.turn];
  const refill = () => w.main.splice(0, 1);
  if (take) {
    pool.push(...w.piles[pile]);
    w.piles[pile] = refill();
    endTurn(state, w);
    return;
  }
  const last = pile === w.piles.length - 1;
  if (last && w.main.length === 0) throw new Error(STACK_EMPTY);
  w.piles[pile].push(...refill());
  if (last) {
    pool.push(...refill());
    endTurn(state, w);
  } else {
    w.active = nextPile(w, pile + 1);
  }
}

/** The first pile from `from` on with cards in it, or `from` itself when none has any. */
function nextPile(w: WinstonState, from: number): number {
  for (let i = from; i < w.piles.length; i++) if (w.piles[i].length > 0) return i;
  return Math.min(from, w.piles.length - 1);
}

function endTurn(state: DraftState, w: WinstonState): void {
  if (w.turn === 0) state.pick += 1;
  const seats = state.pools.length;
  w.turn = (w.turn + 1) % seats;
  w.active = nextPile(w, 0);
  if (w.main.length === 0 && w.piles.every((p) => p.length === 0)) {
    state.done = true;
    return;
  }
  // The fake's bots: the first pile with cards, taken — or, with every pile empty, the stack's
  // top card.
  // Every seat but the reader's is the fake's, as `pickAll` treats a pod's people.
  while (!state.done && w.turn !== 0) {
    const first = w.piles.findIndex((p) => p.length > 0);
    if (first === -1) {
      state.pools[w.turn].push(...w.main.splice(0, 1));
      w.turn = (w.turn + 1) % seats;
      w.active = nextPile(w, 0);
    } else {
      state.pools[w.turn].push(...w.piles[first]);
      w.piles[first] = w.main.splice(0, 1);
      w.turn = (w.turn + 1) % seats;
      w.active = nextPile(w, 0);
    }
    if (w.main.length === 0 && w.piles.every((p) => p.length === 0)) state.done = true;
  }
}

function current(db: FakeDb, name: number): DraftState {
  const state = worldOf(db).draft;
  if (state === null || state.name !== name) throw new Error(DRAFT_REPLACED);
  return state;
}

/* ------------------------------------------------------------------ the draft deck */

/**
 * `draft_deck::create` over the world's own deck writes: a **virtual** `limited` deck named
 * after the draft, its predefined zones taken away for two piles — **Deck** (`main`, the deck's
 * default, empty) and **Pool** (`side`, every drafted card) — and the deck on the unsaved list.
 * With `commander` (a Commander draft's) it is a `casual` deck with a third, empty **Commander**
 * pile.
 * A printing the corpus does not hold is skipped, as the crate skips it.
 *
 * Exported for a story or a test that wants a draft deck already made — *Draft in progress* with
 * a deck under *Continue building*, or the deck editor in its draft mode:
 * `createDraftDeck(db, writeHandlers(db), "Quick Draft", ids)`, the path the command takes.
 */
export function createDraftDeck(
  db: FakeDb,
  writes: DraftDeckWrites,
  name: string,
  cardIds: readonly string[],
  commander = false,
): DeckRow {
  const row = writes.deck_create({
    deck: {
      name: name.trim() === "" ? "Draft" : name,
      formatKey: commander ? "casual" : "limited",
      virtualOnly: true,
    },
  });
  db.deckCategories = db.deckCategories.filter((c) => c.deckId !== row.id);
  const nextCategoryId = () => db.deckCategories.reduce((n, c) => Math.max(n, c.id), 0) + 1;
  const deckPile = {
    id: nextCategoryId(),
    deckId: row.id,
    variant: "live" as const,
    name: "Deck",
    kind: "main" as const,
    isActive: true,
    sortOrder: 0,
    origin: "user" as const,
  };
  db.deckCategories.push(deckPile);
  const poolPile = { ...deckPile, id: nextCategoryId(), name: "Pool", kind: "side" as const };
  poolPile.sortOrder = 1;
  db.deckCategories.push(poolPile);
  if (commander) {
    // A Commander draft's deck: an empty Commander pile, for the reader to move a legend into.
    db.deckCategories.push({
      ...deckPile,
      id: nextCategoryId(),
      name: "Commander",
      kind: "commander" as const,
      sortOrder: 2,
    });
  }
  const deck = db.decks.find((d) => d.id === row.id);
  if (deck !== undefined) deck.defaultCategoryId = deckPile.id;

  const counts = new Map<string, number>();
  for (const id of cardIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  for (const [cardId, quantity] of counts) {
    if (!db.cards.some((c) => c.id === cardId)) continue;
    writes.deck_add_card({
      deckId: row.id,
      cardId,
      categoryId: poolPile.id,
      categoryName: null,
      variant: "live",
      quantity,
    });
  }
  worldOf(db).draftDecks.push(row.id);
  return row;
}

/** `draft_deck::basic_lands` — each of the five basics the corpus holds, in a printing of one of
 *  `setCodes` where there is one. The fake's corpus holds two (an Island and a Forest), so a story
 *  draws the other three greyed — which is a real state: a corpus that lacks a basic. */
function basicLands(db: FakeDb, setCodes: readonly string[]): BasicLand[] {
  const wanted = new Set(setCodes.map((s) => s.toLowerCase()));
  const lands: BasicLand[] = [];
  for (const [color, name] of [
    ["W", "Plains"],
    ["U", "Island"],
    ["B", "Swamp"],
    ["R", "Mountain"],
    ["G", "Forest"],
  ] as const) {
    const printings = db.cards.filter((c) => c.name === name);
    const pick = printings.find((c) => wanted.has(c.setCode)) ?? printings[0];
    if (pick !== undefined) lands.push({ color, name, cardId: pick.id });
  }
  return lands;
}

/* ------------------------------------------------------------------ handlers */

/** Every `packs_*`, `draft_*`, `draft_deck_*` and `lobby_*` command, over one world. */
export function draftHandlers(db: FakeDb, writes: DraftDeckWrites) {
  return {
    packs_booster_set: (args: { setCode: string; refresh: boolean }): BoosterSet =>
      fakeBoosterSet(db, args.setCode),

    draft_start: (args: { setup: DraftSetup; draft: number }): DraftView => {
      const state = startDraft(db, args.setup, args.draft);
      worldOf(db).draft = state;
      return viewOf(state);
    },
    draft_view: (args: { draft: number }): DraftView | null => {
      const state = worldOf(db).draft;
      return state !== null && state.name === args.draft ? viewOf(state) : null;
    },
    draft_pick: (args: { draft: number; cardInstanceIds: string[] }): DraftView => {
      const state = current(db, args.draft);
      pickAll(db, state, args.cardInstanceIds);
      return viewOf(state);
    },
    draft_auto_pick: (args: { draft: number }): DraftView => {
      const state = current(db, args.draft);
      if (state.winston !== null) {
        // The bots' Winston choice for the reader: take the pile in front of them.
        winstonDecide(state, state.winston.active, true);
        return viewOf(state);
      }
      const mine = state.packs[0] ?? [];
      if (state.done || mine.length === 0) throw new Error(DRAFT_OVER);
      const need = Math.min(picksPerStep(state.setup), mine.length);
      pickAll(
        db,
        state,
        mine.slice(0, need).map((c) => c.instanceId),
      );
      return viewOf(state);
    },
    draft_winston: (args: { draft: number; pile: number; take: boolean }): DraftView => {
      const state = current(db, args.draft);
      winstonDecide(state, args.pile, args.take);
      return viewOf(state);
    },
    draft_end: (args: { draft: number }): void => {
      const world = worldOf(db);
      if (world.draft?.name === args.draft) world.draft = null;
    },
    /** A solo draft is kept; a pod is not resumable (spec §4). */
    draft_saved: (): DraftSaved | null => {
      const state = worldOf(db).draft;
      if (state === null || state.setup.mode === "pod") return null;
      return {
        label: state.setup.label,
        mode: state.setup.mode,
        status: state.done ? "deckbuilding" : "drafting",
        packNumber: state.round,
        packCount: rounds(state),
        pickNumber: state.pick,
        updatedAt: FAKE_NOW_MS,
      };
    },
    draft_resume: (args: { draft: number }): DraftView => {
      const state = worldOf(db).draft;
      if (state === null || state.setup.mode === "pod") throw new Error(NOTHING_SAVED);
      state.name = args.draft;
      return viewOf(state);
    },

    draft_deck_create: (args: { name: string; cardIds: string[]; commander?: boolean }): DeckRow =>
      createDraftDeck(db, writes, args.name, args.cardIds, args.commander === true),
    /** Only the decks that still exist — a draft deck deleted from the gallery leaves the list. */
    draft_deck_ids: (): number[] => {
      const world = worldOf(db);
      world.draftDecks = world.draftDecks.filter((id) => db.decks.some((d) => d.id === id));
      return [...world.draftDecks];
    },
    draft_deck_keep: (args: { deckId: number }): void => {
      const world = worldOf(db);
      world.draftDecks = world.draftDecks.filter((id) => id !== args.deckId);
    },
    draft_deck_discard: (args: { deckId: number }): void => {
      const world = worldOf(db);
      if (!world.draftDecks.includes(args.deckId)) {
        throw new Error("That deck is not a draft deck any more.");
      }
      writes.deck_delete({ id: args.deckId });
      world.draftDecks = world.draftDecks.filter((id) => id !== args.deckId);
    },
    draft_basic_lands: (args: { setCodes: string[] }): BasicLand[] => basicLands(db, args.setCodes),

    lobby_create: (): LobbyState => {
      throw new Error(LOBBIES_OFF);
    },
    lobby_join: (): LobbyState => {
      throw new Error(LOBBIES_OFF);
    },
    lobby_state: (): LobbyState | null => null,
    lobby_leave: (): void => {},
    lobby_start: (): DraftView => {
      throw new Error(LOBBIES_OFF);
    },
    lobby_pick: (): void => {
      throw new Error(LOBBIES_OFF);
    },
    lobby_winston: (): void => {
      throw new Error(LOBBIES_OFF);
    },
    lobby_kick: (): void => {
      throw new Error(LOBBIES_OFF);
    },
    lobby_deck: (): string => {
      throw new Error(LOBBIES_OFF);
    },
    lobby_game_start: (): PlaytestStep => {
      throw new Error(LOBBIES_OFF);
    },
    lobby_act: (): void => {
      throw new Error(LOBBIES_OFF);
    },
  };
}
