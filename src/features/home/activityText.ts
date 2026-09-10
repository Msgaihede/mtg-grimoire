/**
 * The home page's activity feed, in words.
 *
 * `activity` records **what happened** — a scope, a kind, a card, a JSON payload of facts and a
 * signed copy delta — and this file is the only thing in the app that reads that payload. The
 * split is the one `deck_audit` already made and is stated on that table: a sentence is domain
 * logic, and a log meant to survive being useful cannot have the wording baked into its rows.
 * Rewording a line here rewrites every line of history that was ever recorded; storing sentences
 * would have made that a migration, and a second language impossible.
 *
 * **Nothing here throws.** A payload is a string the backend wrote and this build may be older or
 * newer than the one that wrote it, so every field is read defensively and a sentence degrades to
 * its shortest honest form rather than taking the page down. That is `auditText.ts`'s stance and
 * these are `auditText.ts`'s helpers, copied deliberately: `facts()`, `text()`, `numberField()`
 * and `line()` are that file's, spelled again here because a home page must not import a deck
 * module's privates — and the one thing that is **not** copied is the day grouping, which is
 * imported, for the reason on {@link localDay}.
 *
 * **The feed is two tables read as one, and this file is the join.** A `deck`-scoped row came out
 * of `deck_audit` and is handed straight to {@link auditSentence}, so a deck line reads
 * identically here and in the deck history dialog — two spellings of one sentence disagree the
 * first time either changes. Only `collection` and `wishlist` rows get sentences written here.
 */
import { auditSentence, localDay, longDay } from "@/features/decks/auditText";
import { count, plural } from "@/lib/counts";
import { finishLabel } from "@/lib/finish";
import type { ActivityEntry, DeckAuditEntry, DeckAuditKind, DeckVariant } from "@/lib/ipc";

/** One line of the feed: the sentence, and the quieter half under it. */
export interface ActivityLine {
  text: string;
  /** `null` when there is nothing more to say — most quantity changes, every folder write. */
  detail: string | null;
}

/** One day of the feed: its lines, and the roll-up its sticky header prints. */
export interface ActivityDay {
  /** The **local** calendar day, `YYYY-MM-DD`. A key, not a label. */
  key: string;
  /** What the header reads — "Today", "Yesterday", or the day written out. */
  label: string;
  /** Copies gained that day: the sum of the positive {@link ActivityEntry.delta}s. */
  added: number;
  /** Copies lost that day, as a **magnitude** — the header draws the sign itself, so a day that
   *  lost six copies carries `6` and reads `−6`. */
  removed: number;
  /** The day's entries in the order they arrived, each with its sentence already drawn. */
  lines: { entry: ActivityEntry; line: ActivityLine }[];
}

/* -------------------------------------------------------------------------------------------- *
 * The defensive readers. Every one of these is `auditText.ts`'s, and the doc on each says what
 * it is for rather than repeating that file — read them there for the failures behind them.
 * -------------------------------------------------------------------------------------------- */

/** The payload, or an empty object. Not `JSON.parse` on its own: the column is
 *  `CHECK (json_valid(payload))`, which admits `[]` and `"a string"` as readily as `{}`. */
function facts(payload: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(payload);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** A payload field as a display string, or `null` — a number is as readable as a string here,
 *  and the backend is free to record either. */
function text(value: unknown): string | null {
  if (typeof value === "string") return value.length > 0 ? value : null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/** A payload field read as a number, `0` when the row does not carry one — never a claim that
 *  the field was there. */
function numberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** A payload field read as a list of display strings. Members it cannot print are dropped rather
 *  than guessed at, so `["condition", 7, null]` is two fields and not three. */
function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(text).filter((part): part is string => part !== null);
}

/** Joined with the app's own separator, skipping the halves that are not there. */
function line(...parts: (string | null)[]): string | null {
  const kept = parts.filter((part): part is string => part !== null && part.length > 0);
  return kept.length === 0 ? null : kept.join(" · ");
}

/**
 * `1 card`, `1,196 cards` — {@link plural}'s agreement with {@link count}'s separators.
 *
 * It exists because this file holds exactly the callers `plural`'s own doc sends away: every
 * caller of that function counts cards, piles or folders **in one deck** and none of them reaches
 * four figures, where an import and a whole-collection clear routinely do. The agreement stays
 * `plural`'s — the word is taken from it rather than re-derived — and only the number is written
 * this file's way. `plural` always writes the count first, so the occurrence replaced is always
 * the number and never a digit inside the noun.
 */
function counted(n: number, one: string, many = `${one}s`): string {
  return plural(n, one, many).replace(`${n}`, count(n));
}

/** What a card-shaped entry calls its card. A row can outlive the name of its printing only if
 *  the backend failed to denormalize one, which is a feed line worth still showing. */
function cardName(entry: ActivityEntry): string {
  return entry.cardName ?? "a card";
}

/* -------------------------------------------------------------------------------------------- *
 * The two cabinets.
 * -------------------------------------------------------------------------------------------- */

/**
 * The words one cabinet answers to.
 *
 * A table rather than a branch per sentence, because the collection's and the wishlist's lines
 * are the same eight acts said about two different places — and because the reader has already
 * met all three of these words: `root` is what the breadcrumb prints at the top level
 * (`CollectionBreadcrumb`'s and `WishlistBreadcrumb`'s own `ROOT`), and the other two are the
 * phrasing the pages and the card menu already use.
 */
interface Cabinet {
  /** The folder that has no name. `null` in a payload is **the root**, which is a place rather
   *  than an absence — the rule `auditText.ts`'s `folderLine` states for a deck's folder. */
  root: string;
  /** The cabinet in prose, with its possessive: `your collection`. */
  place: string;
  /** What a folder in it is called. The wishlist's says so, because a feed mixes both and
   *  `Created folder Staples` would name a drawer the reader would go and look for in the wrong
   *  cabinet. */
  folderNoun: string;
}

const COLLECTION: Cabinet = {
  root: "Collection",
  place: "your collection",
  folderNoun: "folder",
};

const WISHLIST: Cabinet = {
  root: "Wishlist",
  place: "your wishlist",
  folderNoun: "wishlist folder",
};

/* -------------------------------------------------------------------------------------------- *
 * The shared halves of a sentence.
 * -------------------------------------------------------------------------------------------- */

/**
 * `to Binder A`, or nothing.
 *
 * **A `null` folder draws no clause at all**, which is the one place this file departs from
 * `folderLine`'s "null is the root, and the root is a place". A move has to name both of its ends
 * or the arrow is broken; an add and a remove do not, and the root is where a copy sits unless
 * somebody filed it, so `to Collection` would spend the line's quietest half saying nothing.
 */
function folderClause(preposition: string, value: unknown): string | null {
  const named = text(value);
  return named === null ? null : `${preposition} ${named}`;
}

/**
 * `Foil`, `Etched`, or nothing.
 *
 * **`nonfoil` draws nothing**, which is `finish.ts`'s own rule: it is the finish a copy is assumed
 * to be, and the mark for it is the absence of a mark everywhere else in the app. An unrecognised
 * value is printed as stored, because `collection_entries.finish` is TEXT with a CHECK rather than
 * an enum this side knows about, and a row is still what the reader's own data says.
 */
function finishClause(value: unknown): string | null {
  const raw = text(value);
  if (raw === null || raw === "nonfoil") return null;
  return finishLabel(raw);
}

/**
 * A payload's own column name as a reader's word: `purchasePrice` → `purchase price`.
 *
 * A transformation rather than a table, deliberately. The fields an edit can name grow with every
 * column `collection_entries` and `wishlist_entries` gain, and a table would answer a word it had
 * never heard of with nothing at all — a detail that quietly loses half of what changed. Splitting
 * on case and on separators is total over every spelling either side uses, and a word that needs
 * no splitting comes back as itself.
 *
 * `toLowerCase` and never `toLocaleLowerCase`: the latter turns `I` into `ı` on a Turkish
 * desktop, which is `deckFilter`'s pinned-locale rule reached from the other end.
 */
function fieldWord(raw: string): string {
  return raw
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase();
}

/** The fields an edit touched, in the app's own separator. Nothing at all where the row named
 *  none — a detail about something the payload did not say. */
function fieldsClause(value: unknown): string | null {
  return line(...strings(value).map(fieldWord));
}

/**
 * One end of a move: the folder it names, the cabinet's root where it names `null`, and `null`
 * where the payload does not carry the key at all.
 *
 * **The two absences are different and the distinction is load-bearing.** A payload that says
 * `"from": null` is saying the copies came out of the root, which is a place; a payload with no
 * `from` key is an older build's row or a truncated one, and reading that as the root would draw
 * `Collection → Binder A` for a move that may have come from anywhere.
 */
function moveEnd(p: Record<string, unknown>, key: string, cabinet: Cabinet): string | null {
  const named = text(p[key]);
  if (named !== null) return named;
  return key in p ? cabinet.root : null;
}

/** `Binder A → Recently removed`, degrading to `to Recently removed` and then to nothing —
 *  `auditText.ts`'s `move` arm, with {@link moveEnd}'s root rule at each end. */
function moveClause(p: Record<string, unknown>, cabinet: Cabinet): string | null {
  const from = moveEnd(p, "from", cabinet);
  const to = moveEnd(p, "to", cabinet);
  if (from !== null && to !== null) return `${from} → ${to}`;
  return line(to === null ? null : `to ${to}`);
}

/**
 * What happened to a folder itself, rather than to a card in one.
 *
 * It switches on `action` like `auditText.ts`'s two neighbouring branches rather than answering
 * every row with the create sentence, so a row this build has never seen does not claim an act it
 * cannot know happened. A row that names no folder says so — `Created a folder` — rather than
 * printing a placeholder where a name goes.
 */
function folderLine(p: Record<string, unknown>, cabinet: Cabinet): ActivityLine {
  const noun = cabinet.folderNoun;
  const named = text(p.name);
  const it = named === null ? `a ${noun}` : `${noun} ${named}`;
  // Either spelling: the payload table says `from`, and `auditText.ts`'s own label rows say
  // `previous`. A renderer that insisted on one would word half of them as an unnamed rename.
  const previous = text(p.from) ?? text(p.previous);

  switch (text(p.action)) {
    case "create":
      return { text: `Created ${it}`, detail: null };
    case "rename":
      if (named === null) return { text: `Renamed a ${noun}`, detail: null };
      return {
        text:
          previous === null
            ? `Renamed a ${noun} to ${named}`
            : `Renamed ${noun} ${previous} to ${named}`,
        detail: null,
      };
    case "delete":
      return { text: `Deleted ${it}`, detail: null };
    default:
      return { text: `Changed ${it}`, detail: null };
  }
}

/**
 * The one row an import writes, whatever it wrote inside.
 *
 * A bulk press records **one** row carrying its count, which is the spec's second rule: five
 * thousand lines is a feed nobody can read and a table that grows by a megabyte a session.
 *
 * `rows` is the collection or wishlist **lines** the import wrote or folded into, which is a
 * different unit from the copies in the sentence — forty copies over thirty-seven lines is one
 * press said two ways, and a reader who wants to go and find them counts lines. It is drawn only
 * above zero: `numberField` reads an absent key as `0`, and "across 0 rows" beside "Imported 40
 * cards" is arithmetic that cannot be true. That is `auditText.ts`'s `labelsCreated` rule.
 */
function importLine(p: Record<string, unknown>, cabinet: Cabinet): ActivityLine {
  const rows = numberField(p.rows);
  return {
    text: `Imported ${counted(numberField(p.cards), "card")} into ${cabinet.place}`,
    detail: rows > 0 ? `across ${counted(rows, "row")}` : null,
  };
}

/**
 * The one row a **bulk add** writes — *send this deck's missing cards to my wishlist*, and
 * anything later shaped like it.
 *
 * {@link importLine}'s rule read from the other end. That one words a file the reader chose; this
 * words a run of ordinary adds the app made on their behalf, and **the kind stored is `add`
 * rather than `import`** — a reader who pressed a deck's shopping-list button did not import
 * anything, and a feed telling them they had would be describing a press nobody made. The count
 * is what makes it one line; the kind stays what actually happened.
 *
 * `cards` is the copies and `rows` the wishlist lines they landed on — {@link importLine}'s pair
 * and its units, so forty copies over twelve wishes is one press said two ways. `rows` is drawn
 * only above zero, that function's `labelsCreated` rule, and the folder clause is the single
 * add's own: one drawer for the whole run, named once.
 */
function bulkAddLine(p: Record<string, unknown>, cabinet: Cabinet): ActivityLine {
  const rows = numberField(p.rows);
  return {
    text: `Added ${counted(numberField(p.cards), "card")} to ${cabinet.place}`,
    detail: line(rows > 0 ? `across ${counted(rows, "row")}` : null, folderClause("in", p.folder)),
  };
}

/** The one row a clear writes — `reset::clear_collection` and `clear_wishlist`, which are the
 *  other half of the bulk rule above. */
function clearLine(p: Record<string, unknown>, cabinet: Cabinet): ActivityLine {
  return {
    text: `Cleared ${counted(numberField(p.cards), "card")} from ${cabinet.place}`,
    detail: null,
  };
}

/**
 * The copies a card-shaped row moved, as a count.
 *
 * Read off `delta` rather than out of the payload, which is where this file and `auditText.ts`
 * differ: `deck_audit`'s add and remove rows carry a `quantity` of their own, and an `activity`
 * row's payload does not — the signed column **is** the count, and reading it twice would be two
 * numbers to keep in step.
 */
function copies(entry: ActivityEntry): number {
  return Math.abs(entry.delta);
}

/* -------------------------------------------------------------------------------------------- *
 * The two scopes' sentences.
 * -------------------------------------------------------------------------------------------- */

/** The eight things that can happen to the reader's collection. */
function collectionLine(entry: ActivityEntry): ActivityLine {
  const p = facts(entry.payload);
  const name = cardName(entry);

  switch (entry.kind) {
    case "add": {
      const n = copies(entry);
      return {
        text: n > 1 ? `Added ${count(n)} × ${name}` : `Added ${name}`,
        detail: line(folderClause("to", p.folder), finishClause(p.finish)),
      };
    }
    case "quantity": {
      const from = text(p.from);
      const to = text(p.to);
      return {
        text:
          from !== null && to !== null ? `Changed ${name} from ${from} to ${to}` : `Changed ${name}`,
        detail: null,
      };
    }
    case "remove": {
      const n = copies(entry);
      return {
        text: n > 1 ? `Removed ${count(n)} × ${name}` : `Removed ${name}`,
        detail: folderClause("from", p.folder),
      };
    }
    case "edit":
      return { text: `Edited ${name}`, detail: fieldsClause(p.fields) };
    case "move":
      return { text: `Moved ${name}`, detail: moveClause(p, COLLECTION) };
    case "folder":
      return folderLine(p, COLLECTION);
    case "import":
      return importLine(p, COLLECTION);
    case "clear":
      return clearLine(p, COLLECTION);
    // A kind this build has never heard of, written by a newer one — or by an older one, since a
    // database outlives the app that wrote it. The feed still lists it, with a date and a delta,
    // which is more useful than a hole in the day.
    default:
      return { text: `Changed ${COLLECTION.place}`, detail: null };
  }
}

/**
 * The same eight acts, said about the wishlist.
 *
 * **Every one of them names the wishlist in the sentence rather than in the detail**, and that is
 * the whole reason these are sixteen sentences and not eight with a scope chip beside them: a
 * feed interleaves both cabinets and a deck's history besides, so `Removed Lightning Bolt` in a
 * list where the line above it says the same thing about a binder is a line a reader has to look
 * up. The phrasing is the app's own — *Add to wishlist*, *Remove … from your wishlist* and
 * *Edit … on your wishlist* are all strings already on screen elsewhere.
 *
 * **The `add` arm words two things and is the only one that does**: a card, and a *run* of cards
 * — {@link bulkAddLine}. That is not a seventeenth act, it is the same act at a different grain,
 * which is why it shares the kind rather than taking one of its own; the sixteen are still eight
 * kinds said about two cabinets, and the test that walks them drives every row with a card name.
 */
function wishlistLine(entry: ActivityEntry): ActivityLine {
  const p = facts(entry.payload);
  const name = cardName(entry);
  const place = WISHLIST.place;

  switch (entry.kind) {
    case "add": {
      // **A row that names no card and carries a card count is a run**, not a card —
      // {@link bulkAddLine}. The two absences are different and the payload is the whole of what
      // tells them apart: a single add whose printing has left `cards` carries no `cards` key at
      // all, so it falls straight through to {@link cardName}'s `a card` below rather than being
      // worded as a bulk press of nothing.
      if (entry.cardName === null && numberField(p.cards) > 0) return bulkAddLine(p, WISHLIST);
      const n = copies(entry);
      return {
        text: n > 1 ? `Added ${count(n)} × ${name} to ${place}` : `Added ${name} to ${place}`,
        // `in` rather than `to`, because the sentence has already spent that preposition on the
        // cabinet and `… to your wishlist · to Staples` reads as two destinations.
        detail: line(folderClause("in", p.folder), finishClause(p.finish)),
      };
    }
    case "quantity": {
      const from = text(p.from);
      const to = text(p.to);
      return {
        text:
          from !== null && to !== null
            ? `Changed ${name} on ${place} from ${from} to ${to}`
            : `Changed ${name} on ${place}`,
        detail: null,
      };
    }
    case "remove": {
      const n = copies(entry);
      return {
        text:
          n > 1 ? `Removed ${count(n)} × ${name} from ${place}` : `Removed ${name} from ${place}`,
        detail: folderClause("in", p.folder),
      };
    }
    case "edit":
      return { text: `Edited ${name} on ${place}`, detail: fieldsClause(p.fields) };
    case "move":
      return { text: `Moved ${name} on ${place}`, detail: moveClause(p, WISHLIST) };
    case "folder":
      return folderLine(p, WISHLIST);
    case "import":
      return importLine(p, WISHLIST);
    case "clear":
      return clearLine(p, WISHLIST);
    default:
      return { text: `Changed ${place}`, detail: null };
  }
}

/**
 * The variant a delegated deck row is handed, and it is deliberately a word no build has ever
 * stored.
 *
 * `deck_audit.variant` is a **fact** for the `remove` kind — `clearedFrom` names the list a
 * whole-list clear emptied from it — and `activity_recent`'s union does not carry the column, so
 * this side has no honest answer. Of the three available, only this one is true: `live` would
 * word a plan's clear as *the actual list* and `theory` the reverse, while a variant `auditText`
 * has never heard of falls back to *the deck*, which stays true of a whole-list clear whichever
 * list it was. Every other arm of that switch reads the payload and never this field.
 */
const NO_VARIANT = "unknown" as DeckVariant;

/**
 * A feed row as the deck history's own renderer wants it.
 *
 * `kind` is cast because `activity_recent` answers a `string` — Rust stores strings and this side
 * owns the vocabulary — and {@link auditSentence}'s switch is total over unknowns, so a kind a
 * newer build wrote reaches its `default` arm rather than a parse error. `deckId` cannot be null
 * on a `deck`-scoped row by construction; `0` is the shortest honest answer for a row that
 * somehow carries none, and nothing in the sentence reads it.
 */
function asAuditEntry(entry: ActivityEntry): DeckAuditEntry {
  return {
    id: entry.id,
    deckId: entry.deckId ?? 0,
    at: entry.at,
    variant: NO_VARIANT,
    kind: entry.kind as DeckAuditKind,
    cardId: entry.cardId,
    cardName: entry.cardName,
    payload: entry.payload,
    delta: entry.delta,
  };
}

/**
 * One feed entry as a person reads it.
 *
 * **A `deck` row is not worded here.** It is handed to {@link auditSentence} whole, so the line a
 * reader meets on the home page is character for character the line the deck history dialog draws
 * for the same row. An undo or a redo degrades to *"Undid a change"*, which is what that function
 * answers every caller with no day's rows to resolve `of` against — and this signature
 * deliberately has none, because a feed line has to be drawable on its own.
 *
 * **A scope this build has never heard of names no cabinet.** Wording it as a collection row
 * would be a claim about where the change was made; the shortest honest form is the card, or
 * nothing at all.
 */
export function activityLine(entry: ActivityEntry): ActivityLine {
  switch (entry.scope) {
    case "deck":
      return auditSentence(asAuditEntry(entry));
    case "wishlist":
      return wishlistLine(entry);
    case "collection":
      return collectionLine(entry);
    default:
      return {
        text: entry.cardName === null ? "Something changed" : `Changed ${entry.cardName}`,
        detail: null,
      };
  }
}

/**
 * The feed as the activity widget draws it: day sections, newest first.
 *
 * Grouped by **local** calendar day through `auditText.ts`'s own {@link localDay}, and labelled
 * through its {@link longDay} — **never re-derived here**. Slicing a day off `toISOString()` is
 * UTC, so a change made at 23:30 files itself under tomorrow for half the world and a "Today"
 * section contains nothing that happened today. This repo has already shipped that once, which is
 * why the two helpers were exported rather than copied: one calendar day, one spelling.
 *
 * Inside a day the entries keep the order they arrived in — `activity_recent` answers
 * `ORDER BY at DESC, id DESC` and a re-sort here would be a second opinion about a question the
 * backend already answered. The **sections** are sorted, because a `Map` is in first-seen order
 * and that is whatever order the caller was handed.
 */
export function activityDays(entries: readonly ActivityEntry[]): ActivityDay[] {
  const days = new Map<string, ActivityDay>();
  const now = new Date();
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const today = localDay(nowSeconds);
  const yesterday = localDay(nowSeconds - 86_400);

  for (const entry of entries) {
    const key = localDay(entry.at);
    let day = days.get(key);
    if (day === undefined) {
      day = {
        key,
        label:
          key === today
            ? "Today"
            : key === yesterday
              ? "Yesterday"
              : longDay(entry.at, now.getFullYear()),
        added: 0,
        removed: 0,
        lines: [],
      };
      days.set(key, day);
    }
    day.lines.push({ entry, line: activityLine(entry) });
    // Two counters rather than one signed sum, because the header prints both: a day that gained
    // seven copies and lost six is `+7 / −6` and not `+1`.
    if (entry.delta > 0) day.added += entry.delta;
    else if (entry.delta < 0) day.removed -= entry.delta;
  }

  return [...days.values()].sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
}
