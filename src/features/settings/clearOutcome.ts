/**
 * What a clear did, in a sentence.
 *
 * **A module rather than four lines inside the panels, because these are conclusions and Rust
 * only supplies the facts.** `reset.rs` answers counts — entries, folders, files, bytes — and
 * every one of the decisions below is about English rather than about data: whether
 * a second clause is worth printing at all when its number is zero, which unit 329 682 302 bytes
 * belongs in, and what "nothing happened" should say instead of "cleared 0 things". That is the
 * boundary this repo draws, and it is also what makes these testable without a render.
 *
 * The pattern in all four: **a clear that changed nothing says so plainly**, and never reports
 * a row of zeroes. A reader who presses Clear collection on an empty collection has not made a
 * mistake worth a number.
 */
import { count } from "@/lib/counts";
import type { CacheCleared, CollectionCleared, DecksCleared } from "@/lib/ipc";

/**
 * A count and the unit it agrees with, with thousands separators.
 *
 * `@/lib/counts`' `plural` writes the number plainly and says so at its own site: *"every caller
 * counts cards, lines, piles or folders in a deck, and none of them reaches four figures. A
 * caller that does wants `${count(n)} ${…}` and its own thought about it."* A collection is
 * exactly that caller — the measured library on this machine is five figures — so this is that
 * instruction followed rather than a fifth `plural`.
 */
function counted(n: number, one: string, many = `${one}s`): string {
  return `${count(n)} ${n === 1 ? one : many}`;
}

/** Where each unit takes over. Below a thousand of the smaller one, the smaller one wins. */
const KB = 1_000;
const MB = 1_000_000;
const GB = 1_000_000_000;

/**
 * Bytes as a size a person reads: `948 KB`, `314 MB`, `1.4 GB`.
 *
 * **Decimal units, matching the rest of the app.** `activity.ts`' `megabytes` divides by
 * 1 000 000 for the sync's progress line, and two size formats on one screen disagreeing by 5 %
 * is the kind of drift nothing goes red about. This is not that function generalised: that one
 * prints a *pair* against a moving bar and is deliberately whole-megabyte, where this prints one
 * settled number that may be under a megabyte or over a gigabyte.
 *
 * One decimal place above a gigabyte and none below it. `1.4 GB` carries information; `314.2 MB`
 * is a digit nobody acts on, and this sentence is read once.
 */
export function fileSize(bytes: number): string {
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  if (bytes >= MB) return `${Math.round(bytes / MB)} MB`;
  if (bytes >= KB) return `${Math.round(bytes / KB)} KB`;
  return counted(bytes, "byte");
}

/**
 * What emptying the collection did.
 *
 * **One number, and there is no second clause to print.** There used to be one — a count of the
 * deck reservations the cascade took with the collection — and it went when the claim ledger
 * did: a card is in a deck because its collection row sits in that deck's group, so clearing
 * the collection empties the decks themselves rather than releasing a claim against them.
 */
export function collectionOutcome(r: CollectionCleared): string {
  if (r.entries === 0) return "The collection was already empty.";
  return `Cleared ${counted(r.entries, "collection entry", "collection entries")}.`;
}

export function wishlistOutcome(entries: number): string {
  return entries === 0
    ? "The wishlist was already empty."
    : `Cleared ${counted(entries, "wishlist entry", "wishlist entries")}.`;
}

/**
 * What emptying the decks did — up to two numbers, and only the ones that happened.
 *
 * **Folders are named even at zero decks**, which is the one asymmetry here: a reader can hold
 * an empty folder tree with no decks in it, and pressing this button is how it goes. So "no
 * decks" is not automatically "nothing happened".
 *
 * There was a third and smallest claim, `cover image` — files beside the database rather than
 * rows, and only on a deck the reader had given a picture to. Custom covers went on 2026-08-31,
 * `DecksCleared` lost the field with them, and a clear is a `DELETE` over rows and nothing else.
 */
export function decksOutcome(r: DecksCleared): string {
  const parts: string[] = [];
  if (r.decks > 0) parts.push(counted(r.decks, "deck"));
  if (r.folders > 0) parts.push(counted(r.folders, "folder"));
  if (parts.length === 0) return "There were no decks or folders to clear.";
  return `Cleared ${list(parts)}.`;
}

/**
 * What the cache sweep freed.
 *
 * **`failed` gets its own sentence rather than a parenthesis**, because it is a different kind
 * of fact: the first sentence is what happened, the second is what did not and why it might
 * not have. A file Windows will not unlink is one another thread has open — the app's own image
 * fetch, most often — and pressing the button again a moment later takes it.
 *
 * The rows are not reported. They are `image_cache` bookkeeping for the files in the first
 * number, and a reader who is told "5,540 files and 5,540 rows" has been told one thing twice.
 */
export function cacheOutcome(r: CacheCleared): string {
  const swept =
    r.files === 0
      ? "There was nothing cached to clear."
      : `Freed ${fileSize(r.bytes)} across ${counted(r.files, "file")}.`;
  return r.failed === 0
    ? swept
    : `${swept} ${counted(r.failed, "file")} ${r.failed === 1 ? "was" : "were"} in use and stayed.`;
}

/** `a`, `a and b`, `a, b and c`. Serial comma omitted, as the rest of this app's prose does. */
function list(parts: readonly string[]): string {
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}
