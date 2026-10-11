import { COMBO_TAG } from "@/features/decks/DeckBracket";
import { plural } from "@/lib/counts";
import type { CardCombo, CardCombosPage, ComboPiece, ComboStatus } from "@/lib/ipc";

/**
 * Every combo that names one card, as a surface reads them — the page size and the pager, the
 * sentences each state that is not a list says, and the words a combo is summed up in. **The pure
 * half of `CombosDialog`**, split out so the phone face's card sheet asks the same question in the
 * same pages and says the same sentences without reaching the desktop's store through that
 * dialog.
 *
 * **The page size is shared for a reason that is not tidiness.** Both faces read
 * `cardCombosKey(oracleId, null, null, false)` through `useInfiniteQuery`, and an infinite query's
 * cache entry is its *pages*: a second reader paging the same key at a different size would hand
 * the first one pages it never asked for, and {@link nextComboOffset} would compute the next
 * offset over a list whose shape it did not choose.
 *
 * How a combo is *drawn* is each surface's own — the dialog is a rail and a pane at 62rem, the
 * sheet a column of disclosures at 360px.
 */

/**
 * Combos per request.
 *
 * **The list is paged because the corpus says it has to be.** Measured on the real corpus
 * 2026-09-08: 107 016 combos over 7 330 distinct cards, and the distribution is not remotely
 * flat — Ashnod's Altar is in **6 044** of them and 114 cards are in more than 500. A dialog that
 * asked for "this card's combos" would therefore be asking for six thousand rows, for the one
 * card a reader is most likely to open it on.
 *
 * **50 rather than 25, and the number moved because the argument it stood on is gone**
 * (2026-09-20). It was 25 on the grounds that "a combo row is a wall of art, so a page here is
 * nearer a screen of reading than a screen of tiles" — true of the accordion, where a row carried
 * two to five card pictures. A rail row is one line of type and no picture, so that paragraph
 * describes a surface that no longer exists, and a number left standing on a false reason is
 * worse than a wrong number.
 *
 * **What decides it now is that the reader no longer presses anything to get the next page.** The
 * rail fetches when its sentinel comes into view, so a page's job is to be comfortably more than
 * one screenful of rows — a page that ran out inside the scroller would have the observer firing
 * again before the first one had finished landing.
 *
 * **Measured in the shipped window 2026-09-20** (`pnpm tauri dev`, a debug build, 1920×1080,
 * against a copy of the real pair): a row is **59px**, so fifty of them are **2 987px** of scroller
 * against a **605px** rail — **4.9 screens** of headroom. Driven on Ashnod's Altar, five
 * scroll-to-the-foot passes paged **50 → 100 → 150 → 200 → 250 → 300** with the scroller growing
 * 2 987 → 17 799, one page per pass and never more, which is the gate holding.
 *
 * **Paging is still not a way to *find* anything, which is the other half of that 6 044 and why
 * the box above the chips exists.** Fifty at a time with no search is 121 scrolls to reach the end
 * of one card's list, and a reader who wants the combo with Krark-Clan Ironworks in it has no way
 * to ask for it. The search narrows in SQL, like the chips, for the chips' reason: a term applied
 * to the page in hand would be searching 0.8 % of the list and calling the answer *no match*.
 */
export const COMBOS_PAGE_SIZE = 50;

/**
 * What an empty answer means when the feed has never been ingested.
 *
 * **This sentence is the whole reason a surface reads `ipc.combosStatus` at all**, and it
 * is `OracleTagsDialog`'s split one feed over: `combos_for_card` cannot tell a card with no combos
 * from a database with no combo table, because both are zero rows, and the two answers are not
 * close. One is a fact about the reader's card; the other is a fact about the reader's database.
 *
 * A never-ingested table is a **supported state** rather than a failure — it is where every
 * install is before its first launch fetch lands, where a machine that cannot reach Spellbook
 * stays, and where `combos_clear` puts one back on purpose. The last clause is
 * `DeckBracket`'s, in this surface's own words: the feed is fetched at launch, there is no button
 * for it anywhere in the app, so the honest instruction is that nothing needs a press.
 */
export const COMBOS_NEVER_FETCHED = "Combo data is still downloading. Check back shortly.";

/** An empty answer from a feed that *is* here: Spellbook lists no combo naming this card. The
 *  other half of {@link COMBOS_NEVER_FETCHED}'s split, and the claim that needs the status row. */
export const COMBOS_NONE = "No known combos for this card.";

/**
 * A printing with no oracle card behind it.
 *
 * `CardDetail.oracleId` is nullable and a handful of rows really are null, so this is a state
 * rather than a defect — and it is the one case where the dialog asks nothing at all. There is no
 * question to put: `combos_for_card` matches on oracle id, so a null id has nothing to look up and
 * a call would only be this component asking the backend to confirm that zero is zero.
 */
export const COMBOS_NO_ORACLE_CARD = "Combos aren't available for this printing.";

/**
 * The **fourth** empty, and it must never borrow one of the three above.
 *
 * A filter that leaves nothing is a statement about the filter, not about the card or the
 * database — and the chips are still on screen above it. It is drawn only where `total > 0`,
 * which is what keeps it from ever standing in for {@link COMBOS_NEVER_FETCHED}: a database with no rows
 * has no chips to have narrowed with.
 *
 * **A search that matches nothing is this sentence and not a fifth one.** The box is a filter like
 * the chips are — it narrows the same list, it is undone the same way, and it sits in the same row
 * of controls above this line — so a term that leaves nothing has left the reader in exactly the
 * state a chip does. `total` is over the unfiltered set and the search does not move it, which is
 * what keeps this branch reachable with a term in the box: the empty answer is `matching`.
 */
export const COMBOS_NO_MATCH = "No combo matches that filter.";

/**
 * Where the combos came from and how old they are — the app's rule that data with an age says its
 * age, in the voice `pricesAsOf` set and `OracleTagsDialog`'s `AS_OF` repeated one feed over.
 *
 * **It does not say "as of the last card-data sync".** Commander Spellbook's `variants.json.gz` is
 * a separate bulk download on a refresh interval of its own (`combos::REFRESH_INTERVAL_SECS`, a
 * week, against a file Spellbook rebuilds through the day) — so a card sync that finished this
 * morning says nothing whatever about how old these rows are. Blurring the two is the thing the
 * root `CLAUDE.md` asks in bold not to do, and a caption that names the wrong clock is worse than
 * one that names none.
 */
export const COMBOS_AS_OF = "Data from Commander Spellbook.";

/** Where one combo lives on the web — Spellbook's own permalink, keyed on the variant id the feed
 *  publishes. Built here rather than in `lib/externalLinks.ts` because this dialog is its only
 *  caller; a second one is the moment it moves next to the three that live there. */
export function spellbookComboUrl(id: string): string {
  return `https://commanderspellbook.com/combo/${encodeURIComponent(id)}/`;
}

/**
 * The offset for the page after these, or `undefined` when there is nothing left.
 *
 * `useCollection`'s `nextOffset` in this page's own shape — `CardCombosPage` counts `matching`
 * rather than `total`, because the count a pager has to walk is the count **after** the two
 * filters and not the census the chips are drawn from. The short-page rule is that one's, for its
 * reason: a page shorter than asked for ends the list whatever the count says, so a refresh
 * landing between two requests cannot leave this fetching the same empty page for ever.
 */
export function nextComboOffset(pages: readonly CardCombosPage[]): number | undefined {
  const last = pages[pages.length - 1];
  if (!last || last.combos.length === 0) return undefined;
  const seen = pages.reduce((n, page) => n + page.combos.length, 0);
  return seen >= last.matching ? undefined : seen;
}

/**
 * The brackets a combo is legal in, as a range: `2–5`, `4–5`, `1–5`.
 *
 * The rail's 42px box, and the reason it is a *range* rather than five pips at rail scale: every
 * answer `comboBrackets` can give is a contiguous run up to 5, because it is a floor read
 * as a set, so the first and the last say the whole of it in four characters.
 *
 * **An empty list is `B` and says so in words.** It is not "brackets none" — a banned combo is a
 * legality finding, which is a different kind of statement from a power floor, and the box would
 * otherwise draw an en dash with nothing either side of it.
 */
export function bracketRange(brackets: readonly number[]): string {
  if (brackets.length === 0) return "Not legal";
  return `${brackets[0]}–${brackets[brackets.length - 1]}`;
}

/**
 * The same answer as a sentence — what the pips and the range box are, said once and in words.
 *
 * **The pips are a colour-and-number pair and may not be the only statement of the brackets**, and
 * the range box is a five-character abbreviation of one. So both carry this string: the pane's
 * group as its `aria-label`, the rail row inside {@link comboRowLabel}. `1` is spelled out with
 * the rest rather than collapsed to "any deck", because the sentence has to be readable against
 * the five numbers drawn beside it.
 *
 * `and` before the last rather than a bare comma list: this is read aloud, and "2, 3, 4, 5" is a
 * sequence of numbers where "2, 3, 4 and 5" is a set.
 */
export function bracketSentence(brackets: readonly number[]): string {
  if (brackets.length === 0) return "Not legal in Commander";
  const list =
    brackets.length === 1
      ? `${brackets[0]}`
      : `${brackets.slice(0, -1).join(", ")} and ${brackets[brackets.length - 1]}`;
  return `Legal in ${brackets.length === 1 ? "bracket" : "brackets"} ${list}`;
}

/**
 * The pieces that are *not* the card this dialog is about.
 *
 * **What a rail row is for is the other cards**, and the asked-about card is already the dialog's
 * subtitle — repeating it on every one of six thousand rows costs the width the names need. It is
 * matched on the **oracle** id and never on position: `CardCombo.pieces` is in the feed's order so
 * that Spellbook's steps read against it, and the open card is wherever the editors put it.
 *
 * **A combo whose only named card is this one keeps its name**, which is not a hypothetical: the
 * corpus holds seven one-card combos. A row with an empty headline would be a row that draws
 * nothing at all, so the fallback is every piece — which for those rows is the card itself.
 */
export function otherPieces(combo: CardCombo, oracleId: string | null): ComboPiece[] {
  const others = combo.pieces.filter((piece) => piece.oracleId !== oracleId);
  return others.length > 0 ? others : combo.pieces;
}

/** How many of a combo's pieces the reader is short of — a piece counts as missing when they hold
 *  fewer copies than it asks for, which is {@link ownedNote}'s own test one level up. */
export function missingCount(combo: CardCombo): number {
  return combo.pieces.filter((piece) => piece.owned < piece.quantity).length;
}

/** The rail's ownership half, in the words the sentence is asserted by. `Missing 1` rather than
 *  `1 missing`, so the two states start with different words and a scan down the rail can tell
 *  them apart at the left edge of the phrase. */
export function ownedSummary(missing: number): string {
  return missing === 0 ? "You own every piece" : `Missing ${missing}`;
}

/**
 * What one rail row is called, built rather than left to fall out of the layout.
 *
 * **A `gap` is not a word separator to the accessible-name computation.** Left to compute itself
 * from its children this button would read `2–5Rings of Brighthearth2 cardsMissing 1` — the range
 * box, the names, the size and the ownership mark run together, because the accname spec
 * concatenates text nodes and the *spaces* on this row are flex gaps. This repo has been bitten by
 * exactly that with a label and its count computing as `Missing2`.
 *
 * **It replaces `comboLabel`, which named a disclosure, and it says a different thing.** That one
 * ended `— S Spicy`: the letter led, because the letter was what the row drew. Nothing draws a
 * letter any more, so nothing here says one — the row shows a bracket *range* and the name of the
 * classification, and this is those two in words plus the size and the ownership.
 *
 * **Every visible string on the row is in here verbatim**, which is WCAG 2.5.3 rather than
 * tidiness: an accessible name that paraphrased `Missing 1` as "one piece missing" would be a
 * control a reader cannot address by what is written on it. The one exception is the range box,
 * whose `2–5` is expanded by {@link bracketSentence} — that is the box's whole reason for having a
 * sentence at all.
 */
export function comboRowLabel(
  combo: CardCombo,
  names: string,
  brackets: readonly number[],
): string {
  const tag = COMBO_TAG[combo.bracketTag];
  const parts = [
    `${names} — ${tag.name}`,
    bracketSentence(brackets),
    plural(combo.cardCount, "card"),
    ownedSummary(missingCount(combo)),
  ];
  return `${parts.join(". ")}.`;
}

/**
 * What the reader has of one piece, in words.
 *
 * `0` is an answer rather than a gap, and it is the answer this surface is most often about. The
 * partial case is spelled out because "Owned" over one copy of a combo that wants two would be
 * wrong in the direction that costs the reader a game.
 */
export function ownedNote(owned: number, quantity: number): string {
  if (owned === 0) return "Not owned";
  if (owned >= quantity) return "Owned";
  return `${owned} of ${quantity} owned`;
}

/**
 * A `'\n'`-joined feed field, as lines.
 *
 * Blank entries are dropped rather than drawn: a trailing newline is a wire artefact and an empty
 * `<li>` is a bullet with nothing beside it. An all-blank field therefore comes back `[]`, which
 * is what `CombosDialog`'s `Section` tests — so "the field was empty" and "the field was three newlines" draw
 * the same nothing.
 */
export function splitLines(source: string): string[] {
  return source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/**
 * Which of the two sentences an answer with **no combos at all** gets — `total === 0`, over every
 * combo that names the card and before any filter.
 *
 * An unanswered status reads as never-fetched rather than as "no combos", and that is the safe way
 * round: `combos_status` reads one small table and makes no network call, so that arm is all but
 * unreachable — and of the two claims, "the file has not been downloaded" is the one that stays
 * true of a database nobody can read the status of.
 */
export function emptyCombosSentence(status: ComboStatus | undefined): string {
  return (status?.fetchedAt ?? null) === null ? COMBOS_NEVER_FETCHED : COMBOS_NONE;
}

/** A refused read, in the backend's words — the one state that is neither a list nor an empty. */
export function combosReadFailed(error: string): string {
  return `Couldn't read the combos — ${error}.`;
}
