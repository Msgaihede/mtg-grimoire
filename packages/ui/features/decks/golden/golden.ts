/**
 * Writing the deck goldens — the files under `../__golden__/` that hold the Rust port of this
 * feature's rules and arithmetic (`crates/grimoire-core/src/deck_rules/`, `deck_stats/`) to the
 * TypeScript, which is the behaviour of record.
 *
 * Each `*.golden.test.ts` beside this file builds named cases with the validation suites' own
 * fixture builders (`../validation/fixtures.ts`), runs the TypeScript over them and holds the
 * committed golden to the answers with `toMatchFileSnapshot` — so `pnpm exec vitest run -u <suite>`
 * rewrites a golden, and a TypeScript change that moves an answer is a red suite until it is
 * regenerated **and ported**. The Rust suites read the same files (`crate::deck_golden`) and must
 * answer the same. A golden is never edited by hand: a Rust answer that disagrees is the Rust's
 * bug.
 *
 * **A card is written as the fields that differ from {@link BASE}** — `card()`'s default — so a
 * case reads as what makes it that case and the files stay small. `id` is always written: row ids
 * are what `validateForMarks` files a mark under.
 */
import type { DeckCard, FormatSpec } from "@/lib/ipc";
import { card, resetRowIds } from "../validation/fixtures";

/** `card()`'s default with row id 0 — the card every golden card overrides. */
export const BASE: DeckCard = (() => {
  resetRowIds();
  const base = { ...card(), id: 0 };
  resetRowIds();
  return base;
})();

/** A card as the fields that differ from {@link BASE}, `id` always among them. */
export function overrides(row: DeckCard): Partial<DeckCard> {
  const base = BASE as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = { id: row.id };
  for (const [key, value] of Object.entries(row)) {
    if (key === "id") continue;
    if (JSON.stringify(value) !== JSON.stringify(base[key])) out[key] = value;
  }
  return out as Partial<DeckCard>;
}

/** One case: a unique name, its cards, and whatever inputs and answers its suite defines. */
export interface GoldenCase {
  name: string;
  cards: readonly DeckCard[];
  [field: string]: unknown;
}

/**
 * A golden file's whole text: `{ about, base, specs?, cases }`, two-space JSON, one trailing
 * newline. Case names must be unique — the Rust suite names a failure by them.
 */
export function goldenText(
  about: string,
  cases: readonly GoldenCase[],
  specs?: Readonly<Record<string, FormatSpec>>,
): string {
  const names = new Set<string>();
  for (const { name } of cases) {
    if (names.has(name)) throw new Error(`two golden cases are named ${JSON.stringify(name)}`);
    names.add(name);
  }
  const file = {
    about,
    base: BASE,
    ...(specs ? { specs } : {}),
    cases: cases.map((c) => ({ ...c, cards: c.cards.map(overrides) })),
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}
