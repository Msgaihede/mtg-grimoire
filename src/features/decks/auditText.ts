/**
 * The deck's history, in words.
 *
 * `deck_audit` records **what happened** — a kind, a card, a JSON payload of facts and a
 * signed copy delta — and this file is the only thing in the app that reads that payload.
 * The split is deliberate and is stated on the table itself: a sentence is domain logic, and
 * a log meant to survive being useful cannot have the wording baked into its rows. Rewording
 * a line here rewrites every line of history that was ever recorded; storing sentences would
 * have made that a migration, and a second language impossible.
 *
 * **Nothing here throws.** A payload is a string the backend wrote and this build may be
 * older or newer than the one that wrote it, so every field is read defensively and a
 * sentence degrades to its shortest honest form rather than taking the dialog down.
 */
import { plural } from "@/lib/counts";
import type { DeckAuditEntry, DeckAuditKind } from "@/lib/ipc";

/** One line of `DeckHistoryDialog`: the sentence, and the quieter half under it. */
export interface AuditLine {
  text: string;
  /** `null` when there is nothing more to say — most reorders and most deck-field edits. */
  detail: string | null;
}

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

/** A payload field as a display string, or `null` — a number is as readable as a string
 *  here, and the backend is free to record either. */
function text(value: unknown): string | null {
  if (typeof value === "string") return value.length > 0 ? value : null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/** A payload field read as a number, `0` when the row does not carry one — one of the
 *  defensive readers above, and never a claim that the field was there. */
function numberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * A payload field read as a flag.
 *
 * The `deck` kind's `from`/`to` are documented as strings, and a boolean field serialises as
 * a JSON boolean — so both spellings arrive in practice and both are answered here rather
 * than in a branch per caller.
 */
function flag(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value === "true" || value === "1" || value === "yes";
  return false;
}

/** A payload field read as a nested object — the shape an `import` row uses to keep its own
 *  counts together — or `null` when there is none. */
function nested(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Joined with the app's own separator, skipping the halves that are not there. */
const line = (...parts: (string | null)[]): string | null => {
  const kept = parts.filter((part): part is string => part !== null && part.length > 0);
  return kept.length === 0 ? null : kept.join(" · ");
};

/** What a card-shaped entry calls its card. A row can outlive the name of its printing only
 *  if the backend failed to denormalize one, which is a history line worth still showing. */
const cardName = (entry: DeckAuditEntry) => entry.cardName ?? "a card";

/**
 * One history entry as a person reads it.
 *
 * `others` is the rest of the day's entries, and it exists for exactly one pair of rows: an
 * undo and a redo, whose payload names the change they reversed rather than describing one of
 * their own. Absent — every caller that has no list to hand — those two degrade to "Undid a
 * change", which is true and is what an entry whose subject has scrolled out of the drawer
 * gets anyway.
 */
export function auditSentence(
  entry: DeckAuditEntry,
  others: readonly DeckAuditEntry[] = [],
): AuditLine {
  const p = facts(entry.payload);
  const name = cardName(entry);

  // Read before the `deck` branch, because that switch is keyed on `field` and these two are
  // the only fields whose sentence is about **another row**.
  const reversal = reversalLine(entry, p, others);
  if (reversal !== null) return reversal;

  // An import is the one `add` that names no card: it is a hundred of them. The payload
  // carries the counts because the table records facts and this file words them — which is
  // what lets the sentence change without a migration. Read **before** the per-card branches,
  // because those would call it "Added a card".
  const imported = nested(p.import);
  if (imported !== null) {
    const line = importLine(entry.kind, imported);
    if (line !== null) return line;
  }

  switch (entry.kind) {
    case "add": {
      const quantity = numberField(p.quantity);
      return {
        text: quantity > 1 ? `Added ${quantity} × ${name}` : `Added ${name}`,
        detail: line(text(p.category) && `to ${text(p.category)}`),
      };
    }
    case "remove": {
      // **A pile cleared wears this kind and names no card**, exactly as an import's replace row
      // does one branch up — so `action` is what tells it from a card being taken out. Without
      // this arm `deck_category_clear`'s row renders as "Removed 7 × a card": a sentence about a
      // card the row has not got, and one that reads as a bug in the history rather than in the
      // renderer. The word is `deck.rs`'s `clear_category`; copy it, never re-derive it.
      if (text(p.action) === "clear") {
        return {
          text: `Cleared ${plural(numberField(p.cards), "card")} from ${text(p.category) ?? "a category"}`,
          detail: null,
        };
      }
      const quantity = numberField(p.quantity);
      return {
        text: quantity > 1 ? `Removed ${quantity} × ${name}` : `Removed ${name}`,
        detail: line(text(p.category) && `from ${text(p.category)}`, text(p.reason)),
      };
    }
    case "quantity": {
      const from = text(p.from);
      const to = text(p.to);
      return {
        text:
          from !== null && to !== null
            ? `Changed ${name} from ${from} to ${to}`
            : `Changed ${name}`,
        detail: line(text(p.category) && `in ${text(p.category)}`),
      };
    }
    case "move": {
      const from = text(p.from);
      const to = text(p.to);
      return {
        text: `Moved ${name}`,
        detail: from && to ? `${from} → ${to}` : line(to && `to ${to}`),
      };
    }
    case "swap": {
      // Set codes are stored lowercase, as `cards.set_code` holds them. Upper-casing is the
      // renderer's job — a set code is printed on a card in capitals, and this app writes it
      // that way everywhere it shows one.
      const from = text(p.fromSet)?.toUpperCase() ?? null;
      const to = text(p.toSet)?.toUpperCase() ?? null;
      return {
        text: `Swapped printing of ${name}`,
        // The fold is the half that must be said: two rows became one, and a list that
        // silently loses a line reads like a bug.
        detail: line(
          from && to ? `${from} → ${to}` : to,
          flag(p.folded) ? "folded into one row" : null,
        ),
      };
    }
    // Two different events wear this one kind, and `action` is what tells them apart: a
    // change to the **label itself** (created, renamed, recoloured, deleted) carries one and
    // names no card, while putting a label **on a card** carries none. Reading only the
    // second would render "deleted the Cut candidate tag" as "Tagged a card" — a sentence
    // about a card the row does not have.
    case "tag":
      return text(p.action) !== null || entry.cardId === null ? tagLine(p) : cardTagLine(p, name);
    case "category":
      return categoryLine(p);
    case "folder":
      return folderLine(p);
    case "deck":
      return deckLine(p);
    // A kind this build has never heard of, written by a newer one. The dialog still lists
    // it, with a date and a delta, which is more useful than a hole in the history.
    default:
      return { text: "Changed the deck", detail: null };
  }
}

/**
 * An undo or a redo, worded around the change it reversed.
 *
 * **These are `deck` rows and not a tenth audit kind**, which is the backend's decision and
 * worth knowing here: `deck_audit.kind` carries a CHECK, SQLite cannot alter one, and a tenth
 * word would rebuild every reader's whole deck history for a spelling. `deck_import_commit`
 * reached the same conclusion first and reused `add`/`remove` with a keyed payload.
 *
 * `null` for every other row, so the `deck` switch below sees exactly what it always did.
 *
 * **The nested sentence is the whole point.** "Changed the deck" is what the `default` arm
 * would answer, and it is true of every deck edit — a reader looking at their own history
 * wants "Undid: Removed 2 × Lightning Bolt". `of` is the id, resolved against the rows the
 * drawer already has rather than by a second query, and **the recursion is one level deep by
 * construction**: an undo's own row records no step, so nothing can name one.
 */
function reversalLine(
  entry: DeckAuditEntry,
  p: Record<string, unknown>,
  others: readonly DeckAuditEntry[],
): AuditLine | null {
  if (entry.kind !== "deck") return null;
  const field = text(p.field);
  if (field !== "undo" && field !== "redo") return null;
  const verb = field === "undo" ? "Undid" : "Redid";
  const of = typeof p.of === "number" ? p.of : null;
  const target = of === null ? undefined : others.find((row) => row.id === of);
  if (target === undefined) return { text: `${verb} a change`, detail: null };
  const line = auditSentence(target);
  return { text: `${verb}: ${line.text}`, detail: line.detail };
}

/**
 * The one or two rows an import writes.
 *
 * A `replace` writes both — a `remove` for what it cleared, then the `add` — and a `merge`
 * writes only the second. **The add row says nothing about the mode, and that is deliberate**:
 * a replace that found nothing to clear writes no `remove` row at all, and by then it has done
 * exactly what a merge into an empty list would have done. Naming the mode there would be a
 * distinction the deck itself cannot show.
 *
 * `lines` is recorded and deliberately not printed. It counts *items* — the lines that
 * resolved to a printing — so a reader would take it for the length of the file they pasted,
 * and a reader counts cards anyway.
 *
 * `null` for any other kind, so a row a newer build wrote with an `import` payload on a kind
 * this one has no sentence for falls through to its own branch instead of being claimed here.
 */
function importLine(kind: DeckAuditKind, p: Record<string, unknown>): AuditLine | null {
  switch (kind) {
    // Copies, not rows — the quantities the variant held, summed before the delete.
    case "remove":
      return {
        text: `Cleared ${plural(numberField(p.cleared), "card")} before importing`,
        detail: null,
      };
    case "add": {
      const cards = plural(numberField(p.cards), "card");
      const categories = plural(numberField(p.categories), "category", "categories");
      return { text: `Imported ${cards} into ${categories}`, detail: null };
    }
    default:
      return null;
  }
}

/** A label put on a card, taken off it, or swapped for another one. */
function cardTagLine(p: Record<string, unknown>, name: string): AuditLine {
  const tag = text(p.tag);
  const previous = text(p.previous);
  if (tag === null) return { text: `Untagged ${name}`, detail: previous && `was ${previous}` };
  return { text: `Tagged ${name}`, detail: previous ? `${previous} → ${tag}` : tag };
}

/**
 * What happened to a tag itself — the label, not a card wearing it.
 *
 * The name is read from either spelling the backend might use, because this half of the
 * contract arrived after the payload table was written and a renderer that insisted on one
 * key would render half of them as "a tag".
 */
function tagLine(p: Record<string, unknown>): AuditLine {
  const name = text(p.tag) ?? text(p.name) ?? "a tag";
  const previous = text(p.previous) ?? text(p.previousName);
  const cards = numberField(p.cards);
  const moved = (suffix: string) => (cards > 0 ? `${plural(cards, "card")} ${suffix}` : null);

  switch (text(p.action)) {
    case "create":
      return { text: `Created tag ${name}`, detail: null };
    case "rename":
      return {
        text: previous ? `Renamed tag ${previous} to ${name}` : `Renamed a tag to ${name}`,
        detail: moved("carry it"),
      };
    case "recolour":
    case "recolor":
      return { text: `Recoloured tag ${name}`, detail: text(p.color) };
    case "delete":
      // Deleting a tag untags its cards rather than deleting them, which is the half of this
      // sentence a reader would otherwise have to go and check.
      return { text: `Deleted tag ${name}`, detail: moved("untagged") };
    default:
      return { text: `Changed tag ${name}`, detail: null };
  }
}

/**
 * Where the deck is filed.
 *
 * **`folder` is nullable and null is the root**, which is a place rather than an absence — a
 * deck at the top level is not a deck with no folder, it is a deck in the one folder that has
 * no name. Saying "out of its folder" read as a removal.
 *
 * It switches on `action` like its two neighbours rather than answering every row with the
 * move sentence, so a row this build has never seen does not claim a move it cannot know
 * happened.
 */
function folderLine(p: Record<string, unknown>): AuditLine {
  const folder = text(p.folder);
  switch (text(p.action)) {
    case "move":
      return {
        text: folder ? `Moved the deck to ${folder}` : "Moved the deck to the top level",
        detail: null,
      };
    default:
      return { text: "Changed the deck's folder", detail: null };
  }
}

/** The six things that can happen to a category. Each is a different sentence, so each is
 *  a branch — a shared template would read as machine output. */
function categoryLine(p: Record<string, unknown>): AuditLine {
  const name = text(p.name) ?? "a category";
  const cards = numberField(p.cards);
  const moved = (suffix: string) => (cards > 0 ? `${plural(cards, "card")} ${suffix}` : null);

  switch (text(p.action)) {
    case "create":
      return { text: `Created category ${name}`, detail: moved("moved into it") };
    case "rename": {
      const previous = text(p.previousName);
      return {
        text: previous
          ? `Renamed category ${previous} to ${name}`
          : `Renamed a category to ${name}`,
        detail: moved("moved with it"),
      };
    }
    case "delete":
      return { text: `Deleted category ${name}`, detail: moved("moved out of it") };
    case "activate":
      return { text: `Activated ${name}`, detail: moved("now counted") };
    case "deactivate":
      return { text: `Deactivated ${name}`, detail: moved("no longer counted") };
    case "reorder":
      return { text: "Reordered the categories", detail: null };
    default:
      return { text: `Changed category ${name}`, detail: null };
  }
}

/** The deck's own fields. `cover` and `notes` say only that they changed: a cover is an id
 *  nobody can read and a note is a paragraph nobody wants in a one-line history. */
function deckLine(p: Record<string, unknown>): AuditLine {
  const from = text(p.from);
  const to = text(p.to);
  const was = from && `was ${from}`;

  switch (text(p.field)) {
    case "name":
      return { text: to ? `Renamed the deck to ${to}` : "Renamed the deck", detail: was };
    case "format":
      return { text: to ? `Changed the format to ${to}` : "Changed the format", detail: was };
    case "cover":
      // `"custom"` is the literal the backend writes for an uploaded image; anything else is
      // a card id, which is not a thing to print at a reader.
      return {
        text: to === "custom" ? "Set a custom deck cover" : "Set the deck cover",
        detail: null,
      };
    case "notes":
      return { text: "Edited the deck notes", detail: null };
    case "description":
      return { text: "Edited the deck description", detail: null };
    case "built":
      return {
        text: flag(p.to) ? "Marked the deck built" : "Marked the deck not built",
        detail: null,
      };
    case "theory": {
      // **Two different rows wear `field: "theory"`**, and `copied` is the discriminator: the
      // copy row carries it and has no `from`/`to` at all, while the toggle carries `to` and
      // no `copied`. Reading only the toggle answers a copy as `flag(undefined)` — "Turned
      // the theory list off" — which is a sentence about the opposite of what happened.
      if ("copied" in p) {
        const copied = numberField(p.copied);
        return {
          text: "Copied the live deck into theory",
          detail: copied > 0 ? plural(copied, "card") : null,
        };
      }
      return {
        text: flag(p.to) ? "Turned the theory list on" : "Turned the theory list off",
        detail: null,
      };
    }
    case "archived":
      // Filed away, never deleted — `DeckPatch.archived`'s own words, which is why neither
      // half of this says "removed".
      return {
        text: flag(p.to) ? "Filed the deck away" : "Took the deck out of the archive",
        detail: null,
      };
    // `decks.separate_x_group` (schema v13). **The one multi-word field name in this switch** —
    // every other arm is a single lowercase word, so this is the first place the backend's
    // `field(…)` spelling could drift from ours without anything going red: the `default` arm
    // below answers an unrecognised field with a sentence that is true of every deck edit, so a
    // typo here reads as a bland history line rather than a failure. The word is `deck.rs`'s.
    //
    // It says *how the deck is read*, not what is in it, so neither half claims a card moved:
    // nothing was added, removed or refiled by this press.
    case "xGroup":
      return {
        text: flag(p.to)
          ? "Split the X spells into their own group"
          : "Folded the X spells back into their mana values",
        detail: null,
      };
    // `decks.default_category_id` (schema v16), and the **second** multi-word field name in
    // this switch — the paragraph above applies to it word for word, and the word is
    // `deck.rs`'s.
    //
    // **The payload carries names, not ids**, which is the whole reason this arm can print
    // anything: a bare `12` is a number no reader can resolve once the pile has been renamed or
    // deleted, so `record_deck_edit` resolves it at the moment it is true — `record_filed`'s
    // rule for the folder path, and this is the only other column that points at a row with a
    // name of its own. `null` on either side is `AUTO_CATEGORY`, and the sentence for it names
    // the rule rather than a pile, because under Auto there is no one pile: it is per card.
    case "defaultCategory":
      return {
        text: to ? `New cards now go to ${to}` : "New cards now go by what the card does",
        detail: was,
      };
    // A field this build has never heard of, written by a newer one — or by an older one,
    // since a database outlives the app that wrote it. A plain line with a date and a delta
    // beats a blank one, and beats a throw by a good deal more.
    default:
      return { text: "Changed the deck", detail: null };
  }
}

/** One day of history: its rows, and the roll-up its sticky header prints. */
export interface AuditDay {
  /** The **local** calendar day, `YYYY-MM-DD`. A key, not a label. */
  date: string;
  /** What the header reads — "Today", "Yesterday", or the day written out. */
  label: string;
  /** The day's summed {@link DeckAuditEntry.delta}: signed copies, `+7 / −6`. */
  delta: number;
  entries: DeckAuditEntry[];
}

/**
 * The local calendar day of a unix-second stamp.
 *
 * Built by hand rather than by slicing `toISOString()`, which is **UTC** — a change made at
 * 23:30 local would file itself under tomorrow for half the world, and the dialog would show
 * a "Today" section containing nothing that happened today.
 */
function localDay(at: number): string {
  const d = new Date(at * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "Saturday, August 9" — with the year when it is not this one, because a bare weekday and
 *  month is a date the reader would place in the wrong twelvemonth. */
function longDay(at: number, thisYear: number): string {
  const d = new Date(at * 1000);
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    ...(d.getFullYear() === thisYear ? {} : { year: "numeric" }),
  }).format(d);
}

/**
 * A deck's history as `DeckHistoryDialog` draws it: day sections, newest first.
 *
 * Grouped by **local** calendar day, because "today" is a thing that happens where the
 * reader is. Inside a day the entries keep the order they arrived in — `deck_audit_list`
 * answers `ORDER BY at DESC` and a re-sort here would be a second opinion about a question
 * the backend already answered.
 */
export function auditDays(entries: readonly DeckAuditEntry[]): AuditDay[] {
  const days = new Map<string, AuditDay>();
  const now = new Date();
  const today = localDay(Math.floor(now.getTime() / 1000));
  const yesterday = localDay(Math.floor(now.getTime() / 1000) - 86_400);

  for (const entry of entries) {
    const date = localDay(entry.at);
    const day = days.get(date);
    if (day) {
      day.entries.push(entry);
      day.delta += entry.delta;
    } else {
      days.set(date, {
        date,
        label:
          date === today
            ? "Today"
            : date === yesterday
              ? "Yesterday"
              : longDay(entry.at, now.getFullYear()),
        delta: entry.delta,
        entries: [entry],
      });
    }
  }

  // The map is in first-seen order, which is whatever order the caller was handed. The
  // sections are dated, so they are sorted by date rather than trusted to arrive sorted.
  return [...days.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}
