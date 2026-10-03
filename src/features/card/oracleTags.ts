import type { QueryKey } from "@tanstack/react-query";
import type { OracleTagStatus } from "@/lib/ipc";

/**
 * One card's **Oracle tags** — what it *does* — as a surface reads them: the two query keys, the
 * three sentences an answer that is not a list of slugs gets, and the rule that picks between
 * them. **The pure half of `OracleTagsDialog`**, split out so the phone face's card sheet asks
 * under the same keys and says the same sentences without reaching the desktop's store through
 * that dialog.
 *
 * Nothing here is about Art tags. Those are what an illustration *shows*, they are another
 * dataset with a status of its own, and no surface that reads one card answers them.
 */

/**
 * The tag read, keyed on the **oracle** id — which is what the plan asks for and what the data
 * actually is.
 *
 * Oracle tags are a fact about a *card*, not about a piece of cardboard: all four Lightning Bolts
 * carry one set of slugs between them. A key carrying the printing id would therefore fetch the
 * same answer once per printing and miss the cache every time a reader stepped between two
 * printings of the card they are already reading about.
 */
export function oracleTagsKey(oracleId: string): QueryKey {
  return ["tags", "oracle", "card", oracleId];
}

/** The taxonomy's own freshness — one small table, no network call, safe before the first
 *  refresh has ever run. See {@link ORACLE_TAGS_NEVER_FETCHED} for what a reader needs it for. */
export const ORACLE_TAG_STATUS_KEY: QueryKey = ["tags", "oracle", "status"];

/**
 * What an empty answer means when the taxonomy has never been ingested.
 *
 * **This sentence is the whole reason a surface reads `ipc.oracleTagsStatus` at all.**
 * `oracle_tags_for_cards` is documented to make "no tags" and "no such card" the *same* answer —
 * an untagged card, an unknown oracle id and a database with no taxonomy in it all come back
 * with an empty slug list, on purpose, because every categorising caller's response to all three
 * is to fall back to the type line. That is the right contract for a caller filing a deck add
 * and the wrong one for a panel that has to say a sentence: an empty list on its own cannot tell
 * a reader *which* of the three they are looking at, and the two answers are not close. So the
 * status row is what decides between this and {@link ORACLE_TAGS_UNTAGGED}, and neither claim is
 * made without it.
 *
 * A never-fetched taxonomy is a **supported state**, not a failure — it is what every install is
 * on its first launch and what a machine that cannot reach Scryfall stays in permanently. The
 * second sentence is the Tags page's, word for word: there is no button for this anywhere in the
 * app, so the honest instruction is that nothing needs a press.
 */
export const ORACLE_TAGS_NEVER_FETCHED = "Tag data is still downloading. Check back shortly.";

/** An empty answer from a taxonomy that *is* here: Tagger's editors have not tagged this card.
 *  The other half of {@link ORACLE_TAGS_NEVER_FETCHED}'s split, and the claim that needs the
 *  status row. */
export const ORACLE_TAGS_UNTAGGED = "No oracle tags for this card.";

/**
 * A printing with no oracle card behind it.
 *
 * `CardDetail.oracleId` is nullable and a handful of rows really are null, so this is a state
 * rather than a defect — and it is the one case where nothing is asked at all. There is no
 * question to put: the read is keyed on an oracle id, so a null id has nothing to look up and a
 * call would only be a surface asking the backend to confirm that `[]` is `[]`.
 */
export const ORACLE_TAGS_NO_ORACLE_CARD = "Oracle tags aren't available for this printing.";

/**
 * Where the tags came from — the app's rule that data with an age says its age, in the voice
 * `pricesAsOf` set.
 *
 * **It does not say "as of the last card-data sync".** That clause is `pricesAsOf`'s and is true
 * of Scryfall's *prices*, which arrive inside the card corpus; the two Tagger files are separate
 * bulk downloads on a refresh interval of their own (`tags::oracle::REFRESH_INTERVAL_SECS`, a
 * week), so a card sync that finished this morning says nothing whatever about how old these
 * slugs are. Blurring the two is the thing the root `CLAUDE.md` asks in bold not to do, and a
 * caption that names the wrong clock is worse than one that names none.
 */
export const ORACLE_TAGS_AS_OF = "Tags from Scryfall Tagger.";

/**
 * The slugs for one oracle card out of `oracle_tags_for_cards`' answer.
 *
 * **Matched back by id, never by position.** One id in means one entry out, so an index would
 * work today — but the command's contract is that blanks and duplicates are dropped, so
 * `result[0]` is a habit that is correct until the first caller sends two ids and then is
 * silently wrong. The rule is cheaper to keep than to remember.
 */
export function slugsFor(
  rows: readonly { oracleId: string; slugs: string[] }[] | undefined,
  oracleId: string | null,
): string[] {
  if (oracleId === null) return [];
  return rows?.find((row) => row.oracleId === oracleId)?.slugs ?? [];
}

/**
 * Which of the two sentences an **empty** answer gets.
 *
 * An unanswered status reads as never-fetched rather than as untagged, and that is the safe way
 * round: `oracle_tags_status` is documented as unable to fail, so that arm is all but unreachable
 * — and of the two claims, "the file has not been downloaded" is the one that stays true of a
 * database nobody can read the status of.
 */
export function emptyTagsSentence(status: OracleTagStatus | undefined): string {
  return (status?.ingestedAt ?? null) === null ? ORACLE_TAGS_NEVER_FETCHED : ORACLE_TAGS_UNTAGGED;
}
