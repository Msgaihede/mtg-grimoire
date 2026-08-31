import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CircleCheck } from "lucide-react";
import type { JSX } from "react";
import { ipc, ipcError, type ReviewRow, type ReviewTable } from "@/lib/ipc";
import { RELAY_KEY, REVIEW_KEY } from "@/lib/query";
import { cn } from "@/lib/utils";
import { BUTTON } from "./controls";
import { PanelAlert, SettingsSection } from "./panelChrome";

/**
 * What each table is called on screen, and the order the groups are drawn in.
 *
 * **Named for what the reader keeps in it, never for how it is stored** — `ErrorLogPanel`'s
 * `SOURCE_LABEL` rule one panel down. A person has a collection, decks and a wishlist; nobody
 * has a `collection_entries`.
 *
 * The order is `sync_engine::commands::REVIEWABLE`'s, character for character, and that is
 * worth more than it looks: the backend returns its rows in that order, so a group's rows
 * arrive contiguous and this list is the only thing deciding which group comes first. Cards
 * before folders, because a card is the thing a reader came here about and a folder is where
 * it sits.
 */
/**
 * **Total over `ReviewTable`, which is what makes a seventh table a red build.** A `Record` of a
 * closed union is `ErrorSource`/`SOURCE_LABEL`'s shape one panel over, and it is the only fence
 * available on this side: a list of tuples would compile perfectly happily with five of six.
 *
 * Declaration order is drawing order — `Object.keys` on string keys answers insertion order --
 * so the one literal carries both facts and they cannot come apart.
 */
const TABLE_LABEL: Record<ReviewTable, string> = {
  collection_entries: "The collection",
  deck_cards: "Decks",
  wishlist_entries: "The wishlist",
  collection_folders: "Collection folders",
  deck_folders: "Deck folders",
  wishlist_folders: "Wishlist folders",
};

const TABLE_ORDER = Object.keys(TABLE_LABEL) as ReviewTable[];

/**
 * What a table this build has no name for is filed under.
 *
 * **A seventh table is drift rather than a crash**, and it is drift that would otherwise be
 * invisible: the backend's own `no_table_with_the_column_is_missing_from_the_list` catches a
 * table the *crate* forgot, and nothing on this side catches one the crate remembered and this
 * list did not. A row under this heading is still readable and still clearable — it just says,
 * in the one place a reader will never look, that these two lists have parted company.
 */
const UNNAMED_TABLE = "Elsewhere";

/**
 * The rows, in the order they are drawn, gathered under one heading per table.
 *
 * Pure and exported because the grouping *is* the panel: a heading with no rows under it, or a
 * row that quietly failed to reach a heading, are both states no screenshot would catch.
 */
export function groupByTable(
  rows: readonly ReviewRow[],
): { table: string; label: string; rows: ReviewRow[] }[] {
  const known = new Set<string>(TABLE_ORDER);
  const groups: { table: string; label: string; rows: ReviewRow[] }[] = TABLE_ORDER.map(
    (table) => ({
      table,
      label: TABLE_LABEL[table],
      rows: rows.filter((r) => r.table === table),
    }),
  );
  const strays = rows.filter((r) => !known.has(r.table));
  if (strays.length > 0) {
    groups.push({ table: "", label: UNNAMED_TABLE, rows: strays });
  }
  return groups.filter((g) => g.rows.length > 0);
}

/**
 * One row asking to be looked at.
 *
 * **The sentence is drawn exactly as it arrived, and that is the whole rule of this panel.**
 * Rust wrote it — `apply.rs` for the two outcomes §7.4 surfaces, `reconcile.rs` for the
 * printings that left Scryfall — and it says what happened rather than naming a fault, so
 * there is nothing here for the page to shorten, reword or turn into an icon. It wraps and the
 * row grows; it is never clipped and never gets a `title` a pointer has to find.
 *
 * The name comes first because it is what a reader scans for, and the press sits on that line
 * rather than beside the sentence: the sentence is the row's content and a button beside it
 * would make the two compete for the same width.
 */
function Row({
  row,
  onClear,
  pending,
}: {
  row: ReviewRow;
  onClear: () => void;
  pending: boolean;
}): JSX.Element {
  return (
    <li className="space-y-1 border-t border-border py-3 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        {/* `min-w-0` so a long card name gives way rather than the button — a flex item cannot
            shrink below its own min-content unless it is told it may. */}
        <p className="min-w-0 flex-1 text-sm">{row.title}</p>
        <button
          type="button"
          onClick={onClear}
          disabled={pending}
          aria-label={`Looks fine, ${row.title}`}
          className={cn(BUTTON, "h-7 border-border px-2 text-xs hover:bg-bg")}
        >
          <Check aria-hidden="true" className="size-3.5" />
          Looks fine
        </button>
      </div>
      <p className="text-sm text-dim">{row.sentence}</p>
    </li>
  );
}

/**
 * The rows the app wants a person to look at — spec §7.4's other half.
 *
 * **`needs_review` holds a sentence rather than a flag, and that is what this panel is built
 * around.** Two devices that changed the same thing are reconciled by the five rules in §7.3,
 * silently and correctly, wherever a rule can decide. Where one cannot, the engine writes down
 * what it did instead of guessing: a row another device deleted while this one was still
 * editing it is *kept*, and a folder move that would have put a folder inside itself lands the
 * folder at the top level. Both are recorded on the row itself, which is why the sentence
 * travels — clearing it here is a captured write, so a row one device has looked at stops
 * asking on the others too.
 *
 * **It is not only sync's.** `reconcile.rs` has been writing into this column since long before
 * a relay existed, for a printing that left Scryfall's database, and those rows are listed here
 * beside the rest — one column, one queue, one press. A reader does not care which subsystem
 * wanted their attention.
 *
 * **An empty queue is the good state and reads like one.** It is where every install starts and
 * where most stay, so the panel says the app has nothing to ask rather than reporting an empty
 * search.
 *
 * **It reaches the backend itself**, where four of its neighbours take their state as a prop —
 * `BackupPanel`'s argument, and `SyncPanel`'s directly above it: nothing else in the window
 * lists these rows.
 */
export function ReviewPanel(): JSX.Element {
  const client = useQueryClient();

  const read = useQuery({ queryKey: REVIEW_KEY, queryFn: () => ipc.syncReviewList() });
  const rows: ReviewRow[] | null = read.data ?? null;

  const clear = useMutation({
    mutationFn: ({ table, uid }: { table: ReviewTable; uid: string }) =>
      ipc.syncReviewClear(table, uid),
    // **The command answers what is left, so there is nothing to refetch.** That is the whole
    // reason it answers a list rather than nothing: a second read would race the write on the
    // one write connection and could only ever arrive at the same rows.
    onSuccess: (left) => {
      client.setQueryData(REVIEW_KEY, left);
      // Two of the Sync panel's figures moved: `reviewCount` is one lower, and `pending` is one
      // *higher*, because clearing a sentence is a write like any other and is captured like
      // any other.
      //
      // **`RELAY_KEY` and deliberately not the `["sync"]` root.** The root matches this
      // panel's own key by prefix, so invalidating it would immediately re-fetch the list the
      // line above has just been handed — throwing away the whole reason the command answers
      // what is left. Correct in the shipped window, where the re-read agrees; a wasted round
      // trip on the one connection either way, and it hid a real bug in this test.
      void client.invalidateQueries({ queryKey: RELAY_KEY });
    },
  });

  const groups = rows === null ? [] : groupByTable(rows);

  return (
    <SettingsSection id="review" title="Needs review">
      <p className="text-sm text-dim">
        When two of your devices change the same thing, the app works out what you meant and
        says nothing. Where it cannot &mdash; a row one device deleted while another was still
        editing it, a folder move that would have put a folder inside itself &mdash; it keeps
        your data and writes down what it did. Those notes are here, in its own words, until you
        say they look fine.
      </p>

      {rows === null ? (
        <p className="text-sm text-dim">
          {read.isError ? "The review queue could not be read." : "Reading the review queue…"}
        </p>
      ) : rows.length === 0 ? (
        // `ErrorLogPanel`'s empty state, and for its reason: this is good news rather than a
        // search that came back with nothing. The tick is the app's gold, which is what every
        // other "the number worth looking at" in this window is drawn in.
        <p className="flex items-center gap-2 text-sm text-dim">
          <CircleCheck aria-hidden="true" className="size-4 text-accent" />
          Nothing needs a look.
        </p>
      ) : (
        // Capped and scrolled at the same height the error log is, for the same reason: a
        // settings page that grows to the length of a bad merge is one nobody reaches the
        // bottom of.
        //
        // **The 6px is `DROP_MARK_ROOM`'s number, and this scroller needs it where the error
        // log's does not.** `overflow-y-auto` clips on *both* axes at the padding box, and every
        // row here ends in a focusable button whose ring is drawn 2px outside its border box —
        // so a flush row loses half its focus indicator, which is a WCAG 2.4.7 failure with
        // nothing in the box tree to name it. The error log's rows hold no control at all. The
        // negative margin puts the content back on the panel's own grid and touches only the
        // horizontal axis, so `space-y-4`'s `margin-top` above is untouched.
        <div className="-mx-1.5 max-h-96 space-y-4 overflow-y-auto p-1.5">
          {groups.map((group) => (
            <div key={group.label} className="space-y-1">
              {/* The display face, one rung below the panel's own heading — and a heading
                  rather than a named `<section>`, which would nest a landmark inside the
                  panel's own for a two-word label. A group's name is the whole of what tells a
                  `Binder` in the collection from a `Binder` that is a deck folder, and both can
                  be in this list at once. */}
              <h3 className="font-heading text-sm leading-none text-dim">{group.label}</h3>
              <ul>
                {group.rows.map((row) => (
                  <Row
                    key={`${row.table}:${row.uid}`}
                    row={row}
                    // **Only the row that was pressed**, not the whole list. One write
                    // connection means the clears are serial anyway, and a list that greyed
                    // out entirely for the length of an `UPDATE` would flash on every press.
                    pending={
                      clear.isPending &&
                      clear.variables?.table === row.table &&
                      clear.variables?.uid === row.uid
                    }
                    onClear={() => clear.mutate({ table: row.table, uid: row.uid })}
                  />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {/* The app's destructive red, `UpdatePanel`'s and `MarketplacePanel`'s tone rather than
          the error log's plain one: a press the reader made did not happen. */}
      <PanelAlert tone="problem">{clear.error ? ipcError(clear.error) : null}</PanelAlert>
    </SettingsSection>
  );
}
