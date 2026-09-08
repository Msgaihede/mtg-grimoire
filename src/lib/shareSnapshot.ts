/**
 * The share snapshot format, read.
 *
 * One format, **three** implementations — `src-tauri/src/share/snapshot.rs` writes it, and both
 * readers (the web viewer and the in-app one) come through here. That is one implementation more
 * than the plain-text mirror has, which is why `src-tauri/src/share/__golden__/snapshot.json` is
 * committed and both suites assert against it: drift is a red build rather than a viewer that
 * quietly disagrees with the publisher.
 *
 * **This module imports nothing, and that is a requirement rather than a coincidence.** No
 * `ipc`, no `core`, no store, no React. The web viewer that consumes it is a page with no Tauri
 * boundary anywhere in it, and a single import here would drag one into a bundle that must not
 * have one.
 *
 * ---
 *
 * ## ⚠️ `fields` advertising a column does NOT promise every card has it
 *
 * This is the one thing a viewer built on this module has to know, and getting it wrong is
 * silent: `fields` says **which question the publisher answered**, never that every card has an
 * answer. A viewer that reasons "`fields` contains `condition`, therefore every card has `c`"
 * reads `undefined` as a value and renders it. Three absences are ordinary, not edge cases, and
 * the writer emits every one of them deliberately:
 *
 * 1. **An ungraded copy carries no `c` at all.** `NONE` is schema v35's *not set* — an app
 *    sentinel rather than a grade — and putting it on the wire would ship a value every reader
 *    of this format would then have to know how to decode. So a snapshot can carry
 *    `fields: ["condition"]` and a card with no `c`.
 * 2. **An unquoted finish carries no `p`.** The marketplace answers nothing for a printing it
 *    does not list — a foil copy of a card priced only in `usd` is the common case — and a `0`
 *    would be this app claiming a shop offered the card for nothing.
 * 3. **A folder whose parent is not itself in the snapshot carries `parent: null`.** A folder
 *    shared out of the middle of the owner's cabinet is the root of the tree it publishes, so
 *    no edge ever points at a drawer nobody shared. A tree walk may assume every non-null
 *    `parent` resolves *within* `folders`; it may not assume a null one means "top of the
 *    owner's collection".
 *
 * Both viewers render a missing `c` or `p` as an em dash. `fields` is still on the wire and
 * still load-bearing: a binder whose cards all happen to be NM is indistinguishable from one
 * published without condition at all, unless the snapshot says which question it answered.
 */

/**
 * The format version, `v` on the wire — `share::snapshot::SNAPSHOT_VERSION` on the Rust side.
 *
 * The two are a matched pair with no fence between them beyond the golden file both suites
 * read, which is exactly what the golden is for.
 */
export const SNAPSHOT_VERSION = 1;

/**
 * What a whole-collection share is titled; a folder share takes the folder's own name.
 *
 * `share::snapshot::WHOLE_COLLECTION_TITLE`'s value. Nothing here needs it to *parse* — `title`
 * is a string whatever it holds — but a viewer that wants to tell the two kinds of share apart
 * has one place to read it from rather than a literal of its own.
 */
export const WHOLE_COLLECTION_TITLE = "Collection";

/**
 * A snapshot published by a build newer than this one.
 *
 * **Named rather than rendered half-way.** The alternative is a viewer drawing whatever keys it
 * recognises out of a document it does not understand, which looks like a collection with cards
 * missing — the failure a reader cannot diagnose and would report as data loss.
 */
export const SNAPSHOT_TOO_NEW =
  "This shared collection was published by a newer version of MTG Grimoire. Update to open it.";

/**
 * The body did not parse at all.
 *
 * `JSON.parse`'s own `SyntaxError` names a character offset and nothing a reader can act on, so
 * it is replaced rather than passed through — carried as `cause` for the console.
 */
export const SNAPSHOT_UNREADABLE =
  "This shared collection could not be read. It may have been published incompletely.";

/** The body parsed and is not a snapshot: not an object, or missing one of the two arrays. */
export const SNAPSHOT_NOT_A_SNAPSHOT = "That link did not return a shared collection.";

/** One copy of one printing, as it travels. **Short keys** — this repeats once per card. */
export interface ShareCard {
  /** Scryfall id — the card's identity. Stands in for `n` when the printing left the corpus. */
  id: string;
  /** Name. */
  n: string;
  /** Set code. */
  s: string;
  /** Collector number — TEXT, because Scryfall's are (`157`, `157a`, `★12`). */
  cn: string;
  /** `nonfoil` | `foil` | `etched`. */
  f: string;
  /** Quantity. */
  q: number;
  /** The uid of the folder this copy sits in, or `null` for the share's root. */
  fo: string | null;
  /** Front-face image URL. Absent for a printing that has left the publisher's corpus. */
  img?: string;
  /** Condition. Absent when the copy is ungraded — see the module header, absence 1. */
  c?: string;
  /** Language. */
  l?: string;
  /** Price in `currency`. Absent when the marketplace does not quote this finish — absence 2. */
  p?: number;
}

/** One folder. The set of these is the tree the viewer draws the cards into. */
export interface ShareFolder {
  uid: string;
  name: string;
  /** The parent's uid **within this snapshot**, and `null` for anything else — absence 3. */
  parent: string | null;
}

export interface ShareSnapshot {
  /** The format version. See [`SNAPSHOT_VERSION`]. */
  v: number;
  /** The share id — the last path segment of the link. */
  id: string;
  /** The folder's name, or [`WHOLE_COLLECTION_TITLE`] for a whole-collection share. */
  title: string;
  /** What the owner typed. Never derived from Patreon. */
  owner: string;
  /** Seconds. What the page renders as "as of …". */
  updatedAt: number;
  /** Which feed the prices came from. */
  marketplace: string;
  /** Which currency those prices are in. */
  currency: string;
  /**
   * Which optional columns this snapshot answers — some of `condition`, `lang`, `value`.
   *
   * ⚠️ **Not a promise that every card carries them.** See the module header.
   */
  fields: string[];
  folders: ShareFolder[];
  cards: ShareCard[];
}

/**
 * Read a snapshot body, or throw a sentence a viewer can put on the screen.
 *
 * **Four refusals and no fifth**, deliberately: unparseable, not an object, published by a newer
 * build, and missing either array. Everything past that is trusted, because a per-field
 * validator here would be a fourth implementation of the format — one that could disagree with
 * the writer and with both viewers, and would have to be kept in step with all three. What the
 * golden file fences is the shape; what this function fences is the four ways a body can be
 * something other than a snapshot at all.
 *
 * **The version check is one-sided.** A snapshot from an *older* build parses: refusing anything
 * but the current number would expire every published share the day the format grows a field,
 * and the absences the module header lists are exactly what an older document looks like.
 */
export function parseSnapshot(text: string): ShareSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(SNAPSHOT_UNREADABLE, { cause: e });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(SNAPSHOT_NOT_A_SNAPSHOT);
  }
  const snapshot = parsed as Partial<ShareSnapshot>;
  // Asked before the arrays: a document this build cannot read must say so by name, rather than
  // reporting whichever key it happened to check first as missing.
  if (typeof snapshot.v === "number" && snapshot.v > SNAPSHOT_VERSION) {
    throw new Error(SNAPSHOT_TOO_NEW);
  }
  if (!Array.isArray(snapshot.folders) || !Array.isArray(snapshot.cards)) {
    throw new Error(SNAPSHOT_NOT_A_SNAPSHOT);
  }
  return snapshot as ShareSnapshot;
}
