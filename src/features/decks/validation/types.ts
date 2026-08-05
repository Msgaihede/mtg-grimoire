/**
 * What the validation engine is and what it answers.
 *
 * Spec §3's boundary lives here: Rust supplies **facts** (Task 5's deck read — legalities,
 * colour identity, oracle text, P/T, `everUncommon`, `gameChanger`), TypeScript draws every
 * **conclusion**. Nothing in this folder invokes, awaits, or renders; it takes a deck's
 * cards and a `FormatSpec` and returns sentences. That is what makes the plan's heaviest
 * rules the plan's fastest tests.
 */
import type { DeckCard } from "@/lib/ipc";

/**
 * One finding.
 *
 * `error` breaks the format's rules; `warning` is a fact worth a look (an orphaned row, a
 * legality this app cannot read). **Nothing here ever blocks a save** — a deck is the
 * user's, and an illegal one is a deck they are still working on.
 */
export interface ValidationIssue {
  severity: "error" | "warning";
  /**
   * Stable machine handle, so the panel can group by it and a test can name one without
   * matching prose: `"deck-size"` | `"sideboard-size"` | `"copy-limit"` | `"singleton"` |
   * `"restricted"` | `"banned"` | `"not-legal"` | `"unknown-legality"` | `"orphan"` |
   * `"mana-value"`, and — from Tasks 9 and 10 — `"commander-*"`, `"companion-*"`,
   * `"color-identity"`.
   */
  code: string;
  /** The whole story in one sentence, card names and numbers included. */
  message: string;
  /**
   * The rows the sentence is about, for the panel's click-to-highlight — `deck_cards.card_id`
   * values, not row ids, because that is what addresses a card in the editor.
   *
   * Absent on the issues that are about the deck rather than about a card (its size, its
   * sideboard's size): highlighting sixty rows says nothing the sentence did not.
   */
  cardIds?: string[];
}

/**
 * The facts the engine reads — {@link DeckCard} under the name this module means by it.
 *
 * Every card fact on it is nullable, because the read is a LEFT JOIN: a row whose printing
 * left the card database is still in the deck, and the engine says so rather than dropping
 * it. Two fields are **not** JSON and must never be handed to `JSON.parse`: `colors` and
 * `colorIdentity` are concatenated letters (`"WU"`). `legalities` and `faces` are.
 */
export type CardFacts = DeckCard;
