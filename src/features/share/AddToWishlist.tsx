/**
 * Build a want list out of somebody else's binder — spec decision 8, and **the one write in
 * `src/features/share/`**.
 *
 * ## What it writes, and what it deliberately does not
 *
 * It writes `wishlist_entries`, through `ipc.wishlistAdd`, into a folder the reader **already
 * has**. There is no new table, no new synced column and no schema rung: a want list is the
 * wishlist this app has always had, reached from a new place. In particular there is no binding
 * between a wishlist folder and a share — the issue asked for one and spec §8 defers it, with
 * the cost of adding it later written down there. So this dialog offers the cabinet as it
 * stands and cannot mint a folder: a folder-creating control here would be a second cabinet
 * surface with no cabinet around it, and it would be the first half of the binding the spec
 * says not to build.
 *
 * **Nothing it does touches the binder on screen.** That collection belongs to somebody else and
 * is a fetched document besides — `readOnly.test.ts` is the fence, and this component is the one
 * entry on its allowed-write list. The reader's own two lists are the only rows that move.
 *
 * ## Why a dialog rather than one button on the selection bar
 *
 * Two questions have to be answered before the press means anything, and neither of them can be
 * answered from a wall of card faces:
 *
 * 1. **Where.** A wishlist with a cabinet has a root *and* folders, and `WishInput.folderId`
 *    treats the root as a destination rather than as an omission. A button that filed everything
 *    at the root would be a decision made silently on the reader's behalf.
 * 2. **What is already there.** `wishlist_add` folds onto the wishlist's grain, so adding a card
 *    the reader already wants raises the count rather than doing nothing. That is the right
 *    behaviour and the wrong surprise: this dialog says which of the picked cards are already on
 *    the list, per row and once in a sentence, so a second add is a decision instead of an
 *    accident.
 *
 * ## ⚠️ Two different questions about "already", and the sentence answers the harder one
 *
 * *Do I want this card* and *will this press raise a line I already have* are **not** the same
 * question, and a dialog that answered the first while promising the second would be wrong in the
 * ordinary case. `wishlist_add`'s fold key is four terms — oracle id, printing, preferred finish,
 * **folder** — so a wish sitting in `Ordered` is a brand-new line when the reader files this one
 * at the root, a nonfoil wish is a new line beside a picked foil, and a printing-*less* wish (what
 * most of a wishlist is) can never be folded onto by the pinned wish this dialog writes.
 *
 * So the per-row figure is the card-level one — it agrees with the *You want N* under the tile
 * behind this dialog, which is the number the reader has just been looking at — and the
 * **sentence is computed on the real grain and recomputed when the destination changes**. That is
 * `OwnedIndex.wishes`' whole reason for existing.
 */
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Dialog } from "@/components/Dialog";
import { useWishlistFolderList } from "@/features/wishlist/useWishlistFolders";
import { BUTTON } from "@/features/settings/controls";
import { buildFolderTree, flattenFolders } from "@/lib/folderTree";
import { isFinish, type Finish } from "@/lib/finish";
import { FOCUS } from "@/lib/focus";
import { ipc, ipcError } from "@/lib/ipc";
import type { ShareCard } from "@/lib/shareSnapshot";
import { cn } from "@/lib/utils";
import { crossReference, wishGrainKey, type OwnedIndex } from "./useOwnedIndex";

/**
 * The depth of a nested folder in the destination list, as characters.
 *
 * A native `<option>` renders no markup at all, so an indent class has nowhere to live — two
 * **figure spaces** per level, which is `SharedPage`'s drawer picker's own answer to the same
 * problem one control over.
 */
const STEP = "  ";

/** One card the reader wants, after the picked copies have been folded onto it. */
interface Want {
  /** The row this want was folded from — its name, set and number are what the list draws. */
  card: ShareCard;
  /** `foil` or `etched`, and `null` for a nonfoil copy. See {@link fold}. */
  finish: Finish | null;
  /** Copies of it already on the reader's own wishlist. `0` draws nothing at all. */
  already: number;
}

/**
 * The picked copies, folded to one want each.
 *
 * **Keyed on printing *and* finish, because those are the two things a wish is pinned by.** Two
 * rows of the publisher's binder can be the same printing in two of their drawers — a real
 * shape, and two rows there is one card here. Two rows that differ by *finish* are two wishes,
 * because a wish for the foil is not filled by the nonfoil.
 *
 * `nonfoil` folds to `null` rather than travelling as a preference: it is this app's rule
 * everywhere that an ordinary copy goes unmarked, and here it is the difference between "no
 * preference" — which is what most of a wishlist means — and a preference for the plain version
 * that the reader never expressed.
 */
function fold(cards: readonly ShareCard[], index: OwnedIndex): Want[] {
  const wants = new Map<string, Want>();
  for (const card of cards) {
    const finish = isFinish(card.f) && card.f !== "nonfoil" ? card.f : null;
    // The map **is** the fold — a second row of the same printing and finish overwrites an
    // identical entry, so there is nothing to guard against and a `has` check here would be a
    // line no test could fail.
    wants.set(`${card.id}|${finish ?? ""}`, {
      card,
      finish,
      already: crossReference(card, index).want,
    });
  }
  return [...wants.values()];
}

/** `2 cards` / `1 card`. Written once, because the count appears four times in this dialog. */
function cards(n: number): string {
  return `${n} ${n === 1 ? "card" : "cards"}`;
}

/**
 * What the press will do to the reader's list, in at most two short sentences.
 *
 * **Both halves are about the destination and both move when it changes**, which is the whole
 * point: `folds` is how many of the picked cards already have a line at *this* folder, finish and
 * printing — the four-term grain `wishlist_add` really folds on — and `elsewhere` is the rest of
 * what the reader wants, which will land as new lines rather than raising anything.
 *
 * **Empty when there is nothing true to say, which is also what an unfinished sweep looks like.**
 * The index is `EMPTY_INDEX` until both of `useOwnedIndex`'s passes land, and against it every
 * card answers *wanted 0* — so a dialog that drew a figure anyway would draw a confident zero for
 * a card the reader has four wishes for. Saying nothing is the honest answer to both, and the host
 * gates the tick on `figuresReady` besides.
 */
function alreadyLines(folds: number, already: number, destination: string): string[] {
  const lines: string[] = [];
  if (folds > 0) {
    lines.push(
      `${folds} of these already ${folds === 1 ? "has" : "have"} a line in ${destination} — ` +
        `adding raises ${folds === 1 ? "it" : "those"}.`,
    );
  }
  const elsewhere = already - folds;
  if (elsewhere > 0) {
    lines.push(
      `${elsewhere} ${elsewhere === 1 ? "is" : "are"} on your wishlist under a different folder ` +
        `or finish, so ${elsewhere === 1 ? "it gets a line" : "they get lines"} of ` +
        `${elsewhere === 1 ? "its" : "their"} own.`,
    );
  }
  return lines;
}

export function AddToWishlist({
  open,
  cards: picked,
  index,
  onClose,
  onAdded,
}: {
  open: boolean;
  /** Every copy the reader ticked, in the order the wall drew them. Folded here, not by the
   *  host — see {@link fold}. */
  cards: readonly ShareCard[];
  /** The reader's own lists — the card-level counts for each row's figure, and
   *  {@link OwnedIndex.wishes} for the sentence's fold. `EMPTY_INDEX` is a legitimate argument
   *  and draws neither. */
  index: OwnedIndex;
  onClose: () => void;
  /** Every card landed. The sentence names the count and the destination; the host draws it and
   *  clears its picks. */
  onAdded: (report: string) => void;
}) {
  const [destination, setDestination] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const { folders } = useWishlistFolderList();
  const client = useQueryClient();

  const wants = useMemo(() => fold(picked, index), [picked, index]);
  /** Cards the reader wants **somewhere**, which is what each row's own figure says. */
  const already = wants.filter((w) => w.already > 0).length;

  /** The cabinet top to bottom, which is the order the tree is drawn in — never the flat rows'
   *  own order, which says nothing about depth. No members are passed: this list is a set of
   *  destinations and a count beside each one would be a second question. */
  const tree = useMemo(() => flattenFolders(buildFolderTree(folders, [])), [folders]);
  const folderId = destination === "" ? null : Number(destination);
  const named = tree.find((node) => node.folder.id === folderId)?.folder.name ?? "your wishlist";

  /**
   * How many of the picked cards already have a line **at the destination on screen** — the real
   * four-term fold, and the only figure here that entitles the word *raises*.
   *
   * Recomputed from `folderId`, so changing the select changes the sentence. That is the visible
   * half of the distinction this dialog's header sets out: the same two cards can fold in
   * `Ordered` and make two new lines at the root, and a number that did not move when the reader
   * changed their mind would be the wrong answer written confidently.
   */
  const folds = wants.filter(
    (w) => (index.wishes.get(wishGrainKey(w.card.id, w.finish, folderId)) ?? 0) > 0,
  ).length;
  const lines = alreadyLines(folds, already, named);

  const submit = async () => {
    setAdding(true);
    setRefusal(null);
    let added = 0;
    try {
      // **One at a time, and the count is kept as it goes.** `wishlist_add` takes the write
      // connection, so a wall of parallel calls would queue on it anyway — and a refusal part
      // way through is a real state (a busy database, a folder another surface deleted) that
      // the reader has to be told the shape of. A `Promise.all` would report the first failure
      // and know nothing about how many of the others had landed.
      for (const want of wants) {
        await ipc.wishlistAdd({
          cardId: want.card.id,
          quantity: 1,
          folderId,
          // Spread rather than passed, so a nonfoil copy sends a payload with no such key
          // rather than one carrying an explicit `undefined` — `AddToCollection`'s rule for
          // the same field.
          ...(want.finish !== null && { preferredFinish: want.finish }),
        });
        added += 1;
      }
    } catch (e) {
      // Names what got through, because the reader's list really did move that far and the
      // press is not repeatable without double-adding the half that landed.
      setRefusal(`Added ${added} of ${cards(wants.length)}. ${ipcError(e)}`);
      return;
    } finally {
      setAdding(false);
      // On the refusal as well as on the success, and for the reason the count above exists: a
      // partial add is rows written, and every figure drawn off the wishlist — this view's own
      // cross-reference included, which is filed under `["wishlist", "sharedIndex"]` — is stale
      // until it is re-read. The search's `wishlisted` badge is the other reader.
      if (added > 0) {
        void client.invalidateQueries({ queryKey: ["wishlist"] });
        void client.invalidateQueries({ queryKey: ["cards", "search"] });
      }
    }
    onAdded(`Added ${cards(added)} to ${named}.`);
    onClose();
  };

  return (
    <Dialog
      open={open}
      title="Add to your wishlist"
      subtitle="One copy of each, on your own list. Their binder does not change."
      closeLabel="Close add to your wishlist"
      size="w-[34rem]"
      onDismiss={onClose}
      onClose={onClose}
    >
      <ul
        role="list"
        aria-label="Cards to add"
        className="min-h-0 flex-1 divide-y divide-border overflow-y-auto px-5"
      >
        {wants.map((want) => (
          <li
            key={`${want.card.id}|${want.finish ?? ""}`}
            // The row's own name, so the figure beside a card can be asked for by that card.
            aria-label={`${want.card.n}${want.finish === null ? "" : `, ${want.finish}`}`}
            className="flex items-baseline gap-3 py-2"
          >
            <span className="min-w-0 flex-1 truncate text-sm">{want.card.n}</span>
            {want.finish !== null && (
              <span className="shrink-0 font-mono text-[0.6875rem] uppercase text-dim">
                {want.finish}
              </span>
            )}
            <span className="shrink-0 font-mono text-[0.6875rem] uppercase text-dim">
              {want.card.s} {want.card.cn}
            </span>
            {/* The one loud thing in the list, and the reason the list is here at all: the rows
                that are about to be added to twice. Drawn only where there is a figure — an
                `Already wanted: 0` on every other row would be the confident zero the whole
                cross-reference exists to keep off the screen. */}
            {want.already > 0 && (
              <span className="shrink-0 font-mono text-[0.6875rem] text-accent">
                Already wanted: {want.already}
              </span>
            )}
          </li>
        ))}
      </ul>

      <div className="flex flex-col gap-4 border-t border-border p-5">
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="want-folder" className="text-sm text-dim">
            Add them to
          </label>
          {/* A native `<select>`, and every `value` matches an option by construction: a
              controlled select whose value matches nothing does not draw blank, it silently
              reports the first row. `""` is the root and is always there. */}
          <select
            id="want-folder"
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
            className={cn(
              "h-9 min-w-0 flex-1 rounded-md border border-border bg-surface px-2 text-sm",
              "text-text",
              FOCUS,
            )}
          >
            <option value="">Your wishlist</option>
            {tree.map((node) => (
              <option key={node.folder.id} value={String(node.folder.id)}>
                {`${STEP.repeat(node.depth)}${node.folder.name}`}
              </option>
            ))}
          </select>
        </div>

        {lines.length > 0 && (
          <p className="text-sm text-dim">
            {/* Two sentences in one paragraph rather than two blocks: they are one answer to one
                question, and a second `<p>` under a four-row list would read as a second warning. */}
            {lines.join(" ")}
          </p>
        )}

        {refusal !== null && (
          // `alert` rather than `status`: this region is mounted only when there is something to
          // say, and announcing on insertion is what the role is for.
          <p role="alert" className="text-sm text-destructive">
            {refusal}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={cn(BUTTON, "border-border")}>
            Cancel
          </button>
          <button
            type="button"
            // `aria-disabled`, never the attribute: a `disabled` button leaves the tab order.
            aria-disabled={adding || wants.length === 0}
            onClick={() => {
              if (adding || wants.length === 0) return;
              void submit();
            }}
            className={cn(
              BUTTON,
              "border-accent/50 text-accent",
              (adding || wants.length === 0) && "opacity-50",
            )}
          >
            {adding ? "Adding…" : `Add ${cards(wants.length)}`}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
