import { draftProduct, openBooster } from "@/features/draft/booster/open";
import type { Rng } from "@/features/draft/booster/rng";
import { parseDecklist } from "@/features/transfer/import/parse";
import type {
  BoosterProduct,
  BoosterSet,
  DraftSeatSetup,
  ImportResolveLine,
  ImportResolveRow,
  LobbyPeer,
  PlaytestDifficulty,
} from "@/lib/ipc";

/**
 * The table a draft is dealt to, and the boosters on it — the page's half of a draft
 * (`docs/superpowers/specs/2026-10-29-draft-and-packs-design.md` §3–§4: **the page makes the
 * boosters** and hands Rust printing ids).
 *
 * Pure, and seeded through `rng`, so a suite can say exactly which packs a setup deals.
 */

/** Every table a draft is dealt to has eight seats: the reader, and people or bots in the rest. */
export const TABLE_SEATS = 8;

/** The least a deck built from a drafted pool must hold — Limited's 40. */
export const MIN_DECK_SIZE = 40;

/** Boosters a draft opens per seat, and the sealed pool's six. */
export const DRAFT_PACKS = 3;
export const SEALED_PACKS = 6;

/** The bots' skill, in the Playtesting setup's words and order (`PlaytestSetup`'s `DIFFICULTIES`,
 *  spelled again here so the Draft chunk does not import the Playtesting one to read five words). */
export const DIFFICULTIES: readonly { id: PlaytestDifficulty; label: string }[] = [
  { id: "veryEasy", label: "Very easy" },
  { id: "easy", label: "Easy" },
  { id: "medium", label: "Medium" },
  { id: "hard", label: "Hard" },
  { id: "veryHard", label: "Very hard" },
];

export const DEFAULT_DIFFICULTY: PlaytestDifficulty = "medium";

export function difficultyLabel(id: PlaytestDifficulty): string {
  return DIFFICULTIES.find((d) => d.id === id)?.label ?? id;
}

/** A fresh name for a draft — the page's `draft: u64`, as Playtesting's `game` is a number. */
export function freshDraftName(): number {
  return Date.now();
}

/** The reader at seat 0 and bots in the rest: `You`, `Bot 1` … `Bot 7`. */
export function soloSeats(count: number = TABLE_SEATS): DraftSeatSetup[] {
  return Array.from({ length: count }, (_, seat) =>
    seat === 0
      ? { name: "You", bot: false, peer: null }
      : { name: `Bot ${seat}`, bot: true, peer: null },
  );
}

/**
 * A pod's table: the host, each guest who is in the room now, and bots in the seats left over.
 * A guest who dropped before the start gets no seat — the host cannot pass a pack to someone who
 * is not there, and a bot takes the place.
 */
export function podSeats(
  hostName: string,
  peers: readonly LobbyPeer[],
  count: number = TABLE_SEATS,
): DraftSeatSetup[] {
  const people: DraftSeatSetup[] = [
    { name: hostName, bot: false, peer: null },
    ...peers.filter((p) => p.online).map((p) => ({ name: p.name, bot: false, peer: p.peer })),
  ].slice(0, count);
  let bot = 0;
  while (people.length < count) {
    bot += 1;
    people.push({ name: `Bot ${bot}`, bot: true, peer: null });
  }
  return people;
}

/** "Reality Fracture · Lorwyn Eclipsed · The Hobbit" — each set once, in the order first opened. */
export function setsLabel(names: readonly string[]): string {
  return [...new Set(names)].join(" · ");
}

/**
 * One booster per seat per round, from each round's set's draft product. `rounds[r]` is the set
 * round `r` opens; the answer is `[seat][round]` → printing ids, in the order each was opened.
 *
 * Throws a sentence when a set has nothing to draft from (MTGJSON lists no play or draft booster).
 */
export function dealSetPacks(rounds: readonly BoosterSet[], seats: number, rng: Rng): string[][][] {
  const products = rounds.map((set) => {
    const product = draftProduct(set);
    if (product === null) throw new Error(`${set.name} has no booster to draft from.`);
    const colors = new Map(set.cards.map((c) => [c.cardId, c.colors]));
    return {
      product: playable(product, set),
      colorsOf: (cardId: string) => colors.get(cardId) ?? null,
    };
  });
  const packs: string[][][] = Array.from({ length: seats }, () => []);
  // Round by round, seat by seat — the order a table opens them in, so one seed always deals one
  // table whatever the seat count.
  for (const { product, colorsOf } of products) {
    for (let seat = 0; seat < seats; seat += 1) {
      packs[seat].push(openBooster(product, rng, colorsOf).map((c) => c.cardId));
    }
  }
  return packs;
}

/**
 * `product` without the cards this corpus lacks (`inCorpus: false`). The draft is played on the
 * corpus's facts — the engine refuses a printing it cannot read — so a card MTGJSON knows and this
 * corpus does not yet is left off its sheet, and its weight with it, rather than failing the deal.
 */
export function playable(product: BoosterProduct, set: BoosterSet): BoosterProduct {
  const unknown = new Set(set.cards.filter((c) => !c.inCorpus).map((c) => c.cardId));
  if (unknown.size === 0) return product;
  const sheets = product.sheets.map((sheet) => {
    const cards = sheet.cards.filter((c) => !unknown.has(c.cardId));
    return cards.length === sheet.cards.length
      ? sheet
      : { ...sheet, cards, totalWeight: cards.reduce((sum, c) => sum + c.weight, 0) };
  });
  return { ...product, sheets };
}

/** Fisher–Yates over a copy, on `rng`. */
export function shuffled<T>(items: readonly T[], rng: Rng): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export interface CubeShape {
  seats: number;
  packs: number;
  packSize: number;
}

/**
 * A cube's boosters: the list shuffled, then `packs × seats` boosters of `packSize` dealt off the
 * top — round by round, seat by seat. Throws a sentence when the list is too short to deal.
 */
export function dealCube(cards: readonly string[], shape: CubeShape, rng: Rng): string[][][] {
  const need = shape.seats * shape.packs * shape.packSize;
  if (cards.length < need) {
    throw new Error(
      `A cube of ${shape.seats} seats × ${shape.packs} packs × ${shape.packSize} cards needs ${need} cards; the list has ${cards.length}.`,
    );
  }
  const deck = shuffled(cards, rng);
  const packs: string[][][] = Array.from({ length: shape.seats }, () => []);
  let next = 0;
  for (let round = 0; round < shape.packs; round += 1) {
    for (let seat = 0; seat < shape.seats; seat += 1) {
      packs[seat].push(deck.slice(next, next + shape.packSize));
      next += shape.packSize;
    }
  }
  return packs;
}

/** A cube list read: the lines to resolve (with their counts), and the lines nothing could read. */
export interface CubeList {
  lines: { quantity: number; resolve: ImportResolveLine }[];
  unreadable: string[];
}

/**
 * Read a pasted cube — `1 Lightning Bolt` per line, `(SET) 123` hints allowed — with the
 * importer's own parser (`features/transfer/import/parse.ts`), so a list pasted from Moxfield,
 * Arena or a CubeCobra export reads here exactly as it does in Import. A bare `Lightning Bolt`
 * with no count reads as one, which is how most cube lists are written.
 */
export function readCubeList(text: string): CubeList {
  const parsed = parseDecklist(text);
  return {
    lines: parsed.lines.map((line) => ({
      quantity: line.quantity,
      resolve: {
        name: line.name,
        setCode: line.setCode,
        collectorNumber: line.collectorNumber,
        lang: null,
      },
    })),
    unreadable: parsed.issues.map((issue) => issue.raw.trim()).filter((raw) => raw !== ""),
  };
}

/** The resolver's answer joined back to the list: every copy as a printing id, and the names
 *  nothing matched (each once). */
export function cubeCards(
  list: CubeList,
  rows: readonly ImportResolveRow[],
): { cardIds: string[]; unresolved: string[] } {
  const cardIds: string[] = [];
  const unresolved: string[] = [];
  for (const row of rows) {
    const line = list.lines[row.index];
    if (line === undefined) continue;
    if (row.matched === null) {
      if (!unresolved.includes(line.resolve.name)) unresolved.push(line.resolve.name);
      continue;
    }
    for (let n = 0; n < line.quantity; n += 1) cardIds.push(row.matched.cardId);
  }
  return { cardIds, unresolved };
}
