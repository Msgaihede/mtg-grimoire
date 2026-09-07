/**
 * Condition grades, and the strings the rest of the world writes them as.
 *
 * The app stores one of five NA-scale grades — **or the sentinel that says nobody stated one**
 * — and **keeps the original string** beside whichever it landed on, because the normalisation
 * is lossy: EU `GD` and NA `MP` arrive as the same grade, and the user's own file is then the
 * only place the difference still exists.
 *
 * Beside `finish.ts` rather than under `features/collection/`: it is pure vocabulary with
 * no view attached, and its only non-test caller is `lib/ipc.ts`, which types the wire with
 * {@link Condition}.
 */

/**
 * Every value `collection_entries.condition` can hold, in the order a picker draws them.
 *
 * **Not alphabetical, and the exemption is the kind whose order _is_ the information**
 * (`src/CLAUDE.md`'s `sortOptions` rule). The five grades are a scale, best to worst, and the
 * order every listing these cards were bought from prints it in; sorted by label a picker would
 * open on "Damaged" and read Damaged / Heavily played / Lightly played / Moderately played /
 * Near mint, which is not a scale in either direction.
 *
 * **`NONE` leads a scale it is not a member of, and that is the second half of the same
 * argument.** It is not a grade, it is the absence of one, so it has no place *inside* the run
 * from Near mint to Damaged — and the only two seats outside that run are the front and the
 * back. It takes the front because it is the **default**: every write that says nothing lands on
 * it ({@link MENU_CONDITION}), a picker opens on its own first row, and a default a reader has
 * to scroll past five grades to find is a default in name only.
 *
 * **The database orders it the other way and the two are not in conflict.** `COLLECTION_SORTS`'
 * condition `CASE` runs `NM 0 … DMG 4, NONE 5`, because a sorted column is the scale being read
 * *as* a scale and the ungraded pile belongs at the end of it rather than in front of the Near
 * Mints. One list, two orders, neither derived from the other: this one is a picker's, that one
 * is a sort's.
 */
export const CONDITIONS = ["NONE", "NM", "LP", "MP", "HP", "DMG"] as const;
export type Condition = (typeof CONDITIONS)[number];

/**
 * The value a row wears when nobody has said what state the copy is in.
 *
 * **A sentinel string rather than a NULL, and the reason is `idx_collection_grain`.**
 * `condition` is that UNIQUE index's third term, and SQLite counts two NULLs as distinct in a
 * unique index — so a nullable column would make every ungraded add a brand-new row instead of
 * folding onto the one already there, and a reader pressing `+` four times would end with four
 * rows of one copy. A sentinel folds like any other value and costs the fold, the reconcile and
 * the sync no special case at all.
 *
 * **Spelled apart from {@link MENU_CONDITION} although the two are the same four letters
 * today.** This one is *the absence of a grade*; that one is *what a menu chooses to write*.
 * They agree because the app decided a menu should say nothing, which is a decision that could
 * be made differently tomorrow without this constant moving an inch —
 * `src-tauri/src/collection.rs` keeps `CONDITION_NOT_SET` and `DEFAULT_CONDITION` apart for
 * exactly the same reason, and this is the name to import when the sentinel is what is meant.
 */
export const CONDITION_NOT_SET: Condition = "NONE";

/**
 * The condition a **menu** add records, on either of the two menus that record one.
 *
 * Nothing at all, always, and stated in the app rather than left to the backend's default so that
 * the one decision a menu **declines** to make on the reader's behalf is visible at the place it
 * is declined. A collection row's identity still includes its condition, so something still has
 * to be written; what schema v35 changed is that the something can now mean *nobody said*, and a
 * menu press is a gesture that states no grade — so what it records is that, and not a guess at
 * what the reader would have picked had they been asked.
 *
 * **It was `NM` until then, and the old argument was a good one for a scale with no such
 * value**: a fast path has to choose, so choose the grade an unmarked card is assumed to be, and
 * leave the careful answer to the popup that is still there for a played copy. What it cost is
 * the thing that made this constant worth changing — a binder of `NM` rows the reader never
 * looked at, sitting beside the ones they graded by hand and indistinguishable from them, with
 * the app's own guess wearing the best grade on the scale. Guessing is the part that is gone;
 * {@link CONDITION_NOT_SET} is the same string under the name that says which of the two ideas
 * this one is about.
 *
 * **It lived on `useCardMenuDeps.ts` until 2026-09-03, beside the card menu's own collection add,
 * and moved here when the deck card menu's quick add became the second caller.** The move is not
 * tidying: `useCardMenuDeps` imports `DEFAULT_VARIANT` from `useDeck`, so `useDeck` importing this
 * constant back closed a two-module cycle. That particular cycle was harmless — both reads sit
 * inside function bodies, so nothing is `undefined` at module-evaluation time — but it is harmless
 * by a property of the *call sites* rather than of the modules, which is a thing a later edit
 * silently takes away. A constant shared by two features is vocabulary, and vocabulary lives here.
 */
export const MENU_CONDITION: Condition = CONDITION_NOT_SET;

/** Sentence case, as every other label in the app is. */
export const CONDITION_LABEL: Record<Condition, string> = {
  // Not a grade, and the label says so in the reader's words rather than in the column's: the
  // row is there to be *chosen*, so "Not set" has to read as an answer and not as a placeholder.
  NONE: "Not set",
  NM: "Near mint",
  LP: "Lightly played",
  MP: "Moderately played",
  HP: "Heavily played",
  DMG: "Damaged",
};

/**
 * Every spelling this app recognises, lower-cased.
 *
 * **Three of them name no grade at all** and come from no vendor's scale: `none`, `unset` and
 * `not set` answer {@link CONDITION_NOT_SET}, so a file that spells the absence out loud lands
 * where one that left the cell empty lands. They are here for the file that writes the word —
 * a blank cell never reaches this map, because `parse.ts` drops an empty cell before it becomes
 * an `extra` — and they answer `matched: true`, since a reader who wrote *not set* said
 * something this app understood rather than a grade it could not read.
 *
 * The rest is the research doc's synonym table. **Four** entries are the EU scale's, and they are
 * here only because those spellings never come from anywhere else — Cardmarket grades a card
 * `M/NM/EX/GD/LP/PL/PO`, which is one grade longer than the NA scale, so the bottom half
 * does not line up one-for-one:
 *
 * | Cardmarket | here  | why |
 * |------------|-------|-----|
 * | `EX`       | `LP`  | Excellent is the NA scale's Lightly Played |
 * | `GD`       | `MP`  | Good is the NA scale's Moderately Played |
 * | `PL`       | `HP`  | Played sits at NA Heavily Played, not at NA Played |
 * | `PO`       | `DMG` | Poor is the bottom grade; the NA scale's bottom is Damaged |
 *
 * Two traps live in that table and both are deliberate:
 *
 * * A bare **`LP` is not remapped**. It is the NA scale's own grade, and Cardmarket's
 *   LP-means-Played is a property of the *file*, so it belongs to the importer that knows
 *   which file it is reading (Plan 5) rather than to a function that only sees two letters.
 * * **`PL` and `played` part company.** `PL` is Cardmarket's abbreviation and lands on `HP`;
 *   the whole word `Played` is Moxfield's, whose scale runs Mint / Near Mint / Good (Lightly
 *   Played) / Played / Heavily Played / Damaged, so it lands on `MP`. Two spellings of what
 *   looks like one word, from two vendors who mean different cards by it.
 *
 * A `Map`, not a `Record`, and here that is not a nicety. The keys are cells from somebody
 * else's CSV — this is the importer's seam — and an object lookup answers for every member
 * of `Object.prototype`: `constructor` comes back as the `Object` function, `__proto__` as
 * the prototype itself, and both look *recognised*, so they would slip past the very
 * warning row that exists to catch a condition the app does not know. (Only the
 * all-lowercase members reach it, because the lookup lower-cases first — which is an
 * accident protecting `toString`, not a design.)
 */
const SYNONYMS = new Map<string, Condition>([
  ["none", "NONE"],
  ["unset", "NONE"],
  ["not set", "NONE"],
  ["mint", "NM"],
  ["m", "NM"],
  ["mt", "NM"],
  ["near mint", "NM"],
  ["nm", "NM"],
  ["nm-mint", "NM"],
  ["sp", "LP"],
  ["slightly played", "LP"],
  ["excellent", "LP"],
  ["ex", "LP"],
  ["lightly played", "LP"],
  ["lp", "LP"],
  ["good (lightly played)", "LP"],
  ["moderately played", "MP"],
  ["mp", "MP"],
  ["played", "MP"],
  ["good", "MP"],
  ["gd", "MP"],
  ["heavily played", "HP"],
  ["hp", "HP"],
  ["pl", "HP"],
  ["damaged", "DMG"],
  ["dmg", "DMG"],
  ["dm", "DMG"],
  ["d", "DMG"],
  ["poor", "DMG"],
  ["po", "DMG"],
]);

/**
 * One incoming condition string, as a grade plus what it said.
 *
 * `matched: false` is not an error — it is what an import preview shows as a warning row
 * (spec §7: "unknown conditions" are one of the three things a preview flags). The fallback is
 * {@link CONDITION_NOT_SET}, for silence and for a spelling this app cannot read alike: a file
 * it could not read told it nothing about the card, and there is now a value that says exactly
 * that.
 *
 * **The reporting survives the reason that used to require it.** While the fallback was `NM` a
 * miss had to be *reported* rather than quietly accepted because the app's guess was the best
 * grade on the scale, so every unreadable cell erred in the owner's favour. The new fallback
 * claims nothing and errs nowhere — and the warning row stays anyway, because a grade the reader
 * wrote down and this app threw away is a fact they should be told about whatever replaced it.
 * The row is now about the *reading*, not about the guess.
 */
export function normalizeCondition(raw: string | null | undefined): {
  condition: Condition;
  original: string | null;
  matched: boolean;
} {
  const original = raw?.trim() ?? null;
  if (!original) return { condition: CONDITION_NOT_SET, original: null, matched: true };
  const found = SYNONYMS.get(original.toLowerCase());
  return { condition: found ?? CONDITION_NOT_SET, original, matched: found !== undefined };
}
