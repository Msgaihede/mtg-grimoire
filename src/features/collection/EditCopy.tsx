/**
 * Correcting one copy the reader already owns — its **grade** and what they **paid**.
 *
 * **This is `ipc.collectionUpdate`'s first caller.** The command and `collection::update_entry`
 * behind it have existed since the v1 rung and have been exercised by `ipc.test.ts` and by
 * nothing else, so until now a copy recorded wrong was a copy the reader had to delete and add
 * again — losing the row's tags, notes and acquisition story to fix a two-letter grade.
 *
 * **Two fields and no more, deliberately.** Quantity is the table's own stepper and the wall's,
 * where it is one press rather than a form; filing is `Move to`, which is a folder picker and not
 * a text box; and the acquisition columns (`acquired_at`, `acquisition_source`, `serial_number`,
 * the four flags, the slab) have no surface asking for them yet and would turn a two-line
 * question into a data-entry screen. What is here is what issue #361 asked for.
 *
 * # A price can be corrected and never removed, and the dialog says so
 *
 * `EntryPatch` is `coalesce(?n, column)` for every column it can write
 * (`collection.rs`'s `PATCH_SQL`), so an absent field means *leave it* and **there is no value
 * that means make it null** — a bound NULL reads as unchanged. That is a property of the whole
 * struct rather than of this column, and `DeckPatch`'s doc argues the same thing one table over:
 * un-clearing through a patch would need a double-`Option` across the struct, which is a change
 * to make once and deliberately rather than as a side effect of building a form.
 *
 * So the box is seeded with the recorded price and emptying it writes nothing — and **the reader
 * is told that where they can see it**, on the line under the field, whenever there is a price
 * for the sentence to be about. The rejected alternative was a field that opens blank: it makes
 * "empty means leave it" true by construction, and it does so by hiding the very number the
 * reader opened this dialog to check. A control that silently does nothing is the failure worth
 * avoiding; a control that says what it cannot do is not one.
 *
 * # What it does not do
 *
 * **No optimistic write.** The row this edits can *fold* — eight of the patch's fields are grain
 * columns, so a played copy corrected to Near Mint lands on the Near Mint row already there and
 * `EntryChange.id` names a row the caller never passed in (`update_entry`'s own doc). There is no
 * honest local rewrite of a list when the answer may be "those two rows are one row now", so the
 * list is re-read instead.
 */
import { useId, useState, type ReactElement } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Dialog } from "@/components/Dialog";
import { Dropdown } from "@/components/Dropdown/Dropdown";
import type { DropdownOption } from "@/components/Dropdown/types";
import { CONDITIONS, CONDITION_LABEL, type Condition } from "@/lib/conditions";
import { FINISH_LABEL, isFinish } from "@/lib/finish";
import { FOCUS } from "@/lib/focus";
import { ipc, ipcError, type EntryPatch } from "@/lib/ipc";
import type { Currency } from "@/lib/marketplace";
import { formatPrice, parsePurchasePrice } from "@/lib/prices";
import { cn } from "@/lib/utils";

/**
 * The one `collection_entries` row this dialog is about, as much of it as the question needs.
 *
 * **A narrow record rather than the `CollectionRow` the host is holding**, which is
 * `AddToCollection`'s `AddTarget` precedent and has the same two payoffs: a story or a test can
 * write one out in eight lines, and the fields this form may read are the fields it is given —
 * so it cannot quietly start editing an acquisition column by finding one in scope.
 */
export interface EditCopyTarget {
  entryId: number;
  /** For the line that says which copy — the printing's name, or the host's fallback for an
   *  orphan whose printing has left `cards`. */
  cardName: string;
  setCode: string;
  collectorNumber: string;
  /** `collection_entries.finish`, raw. TEXT with a CHECK rather than an enum this side knows,
   *  so it is narrowed for the label and drawn as itself when it is a word this build cannot
   *  name — the same guard `CollectionPage`'s own adapters use. */
  finish: string;
  /** `collection_entries.condition`, raw, for the same reason. */
  condition: string;
  purchasePrice: number | null;
  /** `"USD"` / `"EUR"` as the column spells it, or `null` for a price recorded before anything
   *  asked which money it was. */
  purchaseCurrency: string | null;
  /** The drawer it sits in, or `null` for the root — drawn as {@link ROOT_LABEL}. */
  folderName: string | null;
}

/**
 * The collection's own word for the root, which is what a `null` folder is — `PickCopies` spells
 * the same constant one file over and for its reason: the top level is a place with a name the
 * reader already knows from the breadcrumb, not the absence of one.
 */
const ROOT_LABEL = "Collection";

/**
 * The same answer with **three** arms rather than two, which is what an edit form needs and a
 * quick-add does not.
 *
 * {@link parsePurchasePrice} answers `number | undefined`, and that is exactly right where it
 * lives: the add popup has no stored price to leave alone, so a blank box and a word are one
 * instruction — *send no price*. Here they are opposite instructions. Blank means **leave the
 * recorded price as it is**, which is the only thing a `coalesce` patch can do with an empty box;
 * unreadable means **the reader meant something and this form cannot tell what**, which has to
 * stop the write rather than quietly become the blank case. Folding the two together is how Save
 * comes to write nothing over a box with `12,50,-` in it, and that is the one behaviour this file
 * exists to refuse.
 *
 * So this wrapper survived the de-duplication that took the parser itself to `lib/prices.ts`
 * (where it sits beside `formatPrice`, whose output it has to be able to read back): it is the
 * extra arm, not a second parser.
 */
export type PriceDraft =
  | { kind: "blank" }
  | { kind: "number"; value: number }
  | { kind: "unreadable" };

export function readPrice(draft: string): PriceDraft {
  if (draft.trim() === "") return { kind: "blank" };
  const value = parsePurchasePrice(draft);
  return value === undefined ? { kind: "unreadable" } : { kind: "number", value };
}

/** A recorded price in a box: the bare number, because the currency is beside the field.
 *  `PriceRange.draftOf`'s rule, and `null` is an empty box rather than a `0`. */
function draftOf(value: number | null): string {
  return value === null ? "" : String(value);
}

/**
 * A stored grade this build can name, or `null`.
 *
 * **A loop rather than a cast**, `CollectionPage`'s `conditionLabel` verbatim and for its reason:
 * `collection_entries.condition` is TEXT with a CHECK, so a row written by an older build or by
 * an import can carry a word this build has never heard of, and `lib/conditions.ts` publishes no
 * guard for its column the way `lib/finish.ts` does for its own.
 */
function knownCondition(raw: string): Condition | null {
  for (const condition of CONDITIONS) if (condition === raw) return condition;
  return null;
}

/**
 * Which money the recorded price is in.
 *
 * **The row's own, never the marketplace's** — `src/CLAUDE.md` states both halves and the second
 * is what governs here: "the collection's stored `purchase_price` never converts and never moves
 * with this setting: it is what was paid". A reader who switches to Cardmarket has not repaid
 * anything in euros.
 *
 * The marketplace's currency is the fallback for a row that carries **no** currency at all, which
 * is a price recorded before anything asked, and for a row about to record its first — there the
 * setting is the only evidence of which money the reader is thinking in, and it is the same
 * answer `AddToCollection` writes for a brand-new copy.
 */
function currencyOf(raw: string | null, fallback: Currency): Currency {
  const lower = raw?.toLowerCase();
  return lower === "usd" || lower === "eur" ? lower : fallback;
}

/**
 * The copy's face — the printing, the finish and the drawer, joined with the app's `·`.
 *
 * **The folder is in it, and that is the point rather than decoration.** Two rows of one printing
 * in one finish are told apart by their grade and their drawer, and the grade is the thing being
 * changed — so without the folder a reader with a Near Mint copy in two binders cannot tell which
 * one this dialog is about. `PickCopies.copyFace` reaches the same conclusion from the other end.
 */
function copyFace(target: EditCopyTarget): string {
  const finish = isFinish(target.finish) ? FINISH_LABEL[target.finish] : target.finish;
  return [
    `${target.setCode.toUpperCase()} ${target.collectorNumber}`,
    finish,
    target.folderName ?? ROOT_LABEL,
  ].join(" · ");
}

/**
 * **Only what changed**, which is the whole of how a `coalesce` patch is meant to be used: a field
 * the reader did not touch is left out, so the column keeps whatever another window, an import or
 * the sync last wrote into it.
 *
 * Four clauses, and each is a refusal as much as a write:
 *
 * * a grade equal to the row's own is not sent, so pressing Save without touching the picker
 *   cannot re-stamp `updated_at` and cannot fold the row onto a neighbour;
 * * a grade this build cannot name is not sent either — it is only ever the seed of an
 *   unrecognised stored word, and handing it back would ask the backend to accept a value its own
 *   CHECK refuses;
 * * a **blank** price box sends nothing at all, because there is no way to say "make it null"
 *   ({@link EditCopy}'s own doc), and an **unreadable** one sends nothing either — the form
 *   refuses that at the button instead, so it is never quietly dropped here;
 * * the currency rides along **only where the row has none**. Sending the row's own value back
 *   would be a write that changes nothing, and sending the *marketplace's* over a price already
 *   recorded in another currency would re-denominate what the reader paid — the one thing
 *   `src/CLAUDE.md` says a stored purchase price may never do.
 *
 * A plain function over its four arguments rather than state or a memo, which is what lets the
 * rule be checked without a DOM: an empty object *is* "nothing to save", and that is the same
 * fact the Save button greys on.
 */
export function editPatch(
  target: EditCopyTarget,
  condition: string,
  price: PriceDraft,
  paidIn: Currency,
): EntryPatch {
  const patch: EntryPatch = {};
  const grade = knownCondition(condition);
  if (grade !== null && grade !== target.condition) patch.condition = grade;
  if (price.kind === "number" && price.value !== target.purchasePrice) {
    patch.purchasePrice = price.value;
    if (target.purchaseCurrency === null) patch.purchaseCurrency = paidIn.toUpperCase();
  }
  return patch;
}

/** The way out, `PickCopies`' constant verbatim: declining is not a thing a busy database can
 *  refuse, so this button has no out-of-reach state to draw. */
const CANCEL = cn(
  "rounded-md border border-border px-3 py-1 text-xs text-dim",
  "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
  FOCUS,
);

/**
 * The affirmative, in the app's own outlined-accent shape.
 *
 * **`aria-disabled` and a guard, never the attribute** (`src/CLAUDE.md`): this greys and un-greys
 * as the reader types, and a `disabled` button leaves the tab order — so a reader who emptied the
 * price box would find the caret thrown out of the panel by their own keystroke. The hover fill
 * goes with it, because a control that lights up under the pointer and then does nothing is worse
 * than one that is plainly out of reach.
 */
const SAVE = cn(
  "rounded-md border border-accent px-3 py-1 text-xs text-accent",
  "transition-colors duration-150 hover:bg-accent hover:text-accent-foreground",
  "motion-reduce:transition-none",
  "aria-disabled:opacity-50 aria-disabled:hover:bg-transparent aria-disabled:hover:text-accent",
  FOCUS,
);

/** The field boxes, at the deck editor's one chrome height so the select and the text box are
 *  the same object drawn twice. */
const FIELD = cn(
  "h-9 w-full rounded-md border border-border bg-bg px-2.5 text-sm text-text",
  "placeholder:text-dim",
  FOCUS,
);

/**
 * The dialog: `Dialog`, the app's own, with the form mounted only while it is open.
 *
 * **A centred modal rather than an anchored panel**, which is `src/CLAUDE.md`'s rule for a
 * surface that is *consulted* — and here, as for `PickCopies` beside it, it is also the only
 * shape available: the row that opens this is a context-menu item, and the menu's panel has
 * already closed by the time its handler runs, so there is no element left to anchor to.
 *
 * **`target === null` is closed**, so the host holds one piece of state rather than a flag beside
 * a payload that can disagree with it. What that costs is the fade: `Dialog` keeps the panel
 * mounted for the length of its exit tween while `children` render only while open, so the
 * closing frame shows the heading over an empty body. Every dialog in this app does — the
 * heading is static for exactly that reason, and the copy's own name is the body's first line.
 */
export function EditCopy({
  target,
  currency,
  onDismiss,
  onClose,
}: {
  /** The copy being edited, or `null` — which is what "closed" means here. */
  target: EditCopyTarget | null;
  /** The selected marketplace's currency, for a row that records its first price. Never used to
   *  re-denominate a price the row already carries — see {@link currencyOf}. */
  currency: Currency;
  /** Escape and the ✕: hand the caret back, then close. */
  onDismiss: () => void;
  /** The scrim, and a successful save: close without moving focus. */
  onClose: () => void;
}): ReactElement {
  return (
    <Dialog
      open={target !== null}
      title="Edit copy"
      closeLabel="Close the copy editor"
      // Two fields and two buttons. Narrower than the copy picker's `w-[30rem]`, which has a
      // scrolling list in it; wider than the quick-add popup's `w-64`, which is anchored to a
      // row and has to fit beside one.
      size="w-[26rem]"
      onDismiss={onDismiss}
      onClose={onClose}
    >
      {target !== null && (
        // Keyed on the copy, because every answer below is seeded **mount-only**: a host that
        // swapped one row for another under an open dialog would otherwise draw the first row's
        // grade over the second row's card. `PickCopies`' host keys for the same reason.
        <EditCopyForm
          key={target.entryId}
          target={target}
          currency={currency}
          onDone={onClose}
        />
      )}
    </Dialog>
  );
}

/**
 * What is inside the panel: the copy's name, its grade, what was paid, and one write.
 *
 * Mounted and unmounted with the dialog, which is what resets every answer here between two
 * openings — `Dialog`'s own contract, and the reason none of this state is lifted.
 */
function EditCopyForm({
  target,
  currency,
  onDone,
}: {
  target: EditCopyTarget;
  currency: Currency;
  /** Both exits: a successful save and a press on Cancel. Neither moves the caret — the menu
   *  row that opened this dialog closed on the press that raised it, so there is nothing left
   *  to hand focus back to. */
  onDone: () => void;
}): ReactElement {
  const id = useId();
  const queryClient = useQueryClient();

  /**
   * Seeded from the row, **mount-only**, in a plain initial value.
   *
   * No effect re-seeding from the prop: an effect cannot tell "the row arrived" from "the reader
   * has already changed the grade", so it would land on top of an answer they had given. The
   * `key` on this component is what makes a genuinely different row a genuinely new form —
   * `CreateDeckDialog`'s rule, and `PickCopies`' one file over.
   */
  const [condition, setCondition] = useState(target.condition);
  /**
   * The price as a **draft string** rather than as a number.
   *
   * `1.`, `1.5` and `1.50` are three drafts of one number and a box re-rendered from the parsed
   * value deletes the character just typed — `PriceRange` says this in full, and it is the whole
   * reason both of this app's money fields are `type="text"` with `inputMode="decimal"` rather
   * than `type="number"`, whose spinners and locale-dependent decimal handling are a worse fit
   * for money anyway.
   */
  const [priceDraft, setPriceDraft] = useState(() => draftOf(target.purchasePrice));

  const price = readPrice(priceDraft);
  const paidIn = currencyOf(target.purchaseCurrency, currency);

  const patch = editPatch(target, condition, price, paidIn);
  const changed = Object.keys(patch).length > 0;
  /** Greyed while there is nothing to write, and while the price box holds something this form
   *  cannot read — the second is the important half: saving over `12,50,-` and quietly dropping
   *  it would be the silent no-op this dialog exists to refuse. */
  const blocked = !changed || price.kind === "unreadable";

  const save = useMutation({
    mutationFn: () => ipc.collectionUpdate(target.entryId, patch),
    onSuccess: () => {
      /**
       * **`["collection"]` whole, and nothing else.**
       *
       * The whole key rather than `CollectionPage`'s narrower `settle()` set, which deliberately
       * leaves the *list* alone because a stepper press has already rewritten the one number it
       * moved. Nothing of the sort is true here: eight of the patch's fields are grain columns,
       * so an edit can fold this row onto another one and the answer names an id the caller never
       * passed in. A list that has lost a row cannot be repaired from a patch, so it is re-read.
       *
       * And nothing else, because nothing else draws either field. `["cards", "search"]` is
       * `ownedQuantity` and `wishlisted` — both counts of *copies*, and no copy moved.
       * `["wishlist"]` is the same arithmetic one table over. `["decks"]` is what a deck's group
       * physically holds, which is a folder and a quantity: this dialog edits neither. A grade and
       * a price are on no badge and in no deck's sums.
       */
      void queryClient.invalidateQueries({ queryKey: ["collection"] });
      // Closed without moving the caret: the menu row that opened this is long gone, so there is
      // nothing to hand focus back to and `Dialog`'s own restore has nothing to do.
      onDone();
    },
  });

  /**
   * **Deliberately not alphabetical**, `AddToCollection`'s exemption and `lib/options.ts`'s rule:
   * `CONDITIONS` is a grade scale in the order every listing these cards were bought from prints
   * it, and sorting by label would read Damaged / Heavily played / Lightly played / Moderately
   * played / Near mint, which is not a scale in either direction.
   */
  const conditionOptions: readonly DropdownOption[] = CONDITIONS.map((c) => ({
    value: c,
    label: CONDITION_LABEL[c],
  }));

  /**
   * What the trigger says when the stored grade is a word this build cannot name.
   *
   * `Dropdown` draws this whenever `value` matches no option, and the alternative is the trap a
   * controlled picker sets by default: with no placeholder it would draw the **first** option,
   * which since this PR is "Not set" — a picker claiming the row is ungraded when it is stored as
   * something else, and a Save that then writes nothing because the value has not changed. Under
   * the column's own CHECK no such row exists; the guard is around the type, which is `string`.
   */
  const unnamedGrade = knownCondition(condition) === null ? condition : undefined;

  /**
   * The line under the price box, or `null`.
   *
   * Two sentences and never both: what the box cannot read, or what emptying it will not do. The
   * second is drawn **only where there is a price to be about** — a row with none has nothing to
   * clear, and a pre-emptive warning about a state that cannot arise is noise.
   */
  const priceNote =
    price.kind === "unreadable"
      ? "That is not a price — try 12.50."
      : target.purchasePrice === null
        ? null
        : `Emptying this box leaves ${formatPrice(target.purchasePrice, paidIn)} recorded. ` +
          "A price can be corrected here, never removed.";

  return (
    <div className="space-y-4 p-1">
      {/* Which copy — the card, then the three facts that tell it from its siblings. The name is
          emphasised and the rest is dim, `PickCopies`' arrangement, because the printing is what
          a reader checks first and the drawer is what they check when two look alike. */}
      <p className="text-sm leading-snug">
        <span className="font-medium">{target.cardName}</span>{" "}
        <span className="text-dim">{copyFace(target)}</span>
      </p>

      <div className="space-y-1">
        {/* A select shows its value, so its name is written beside it — `AddToCollection`'s rule
            for the same control. */}
        <label
          id={`${id}-condition-label`}
          htmlFor={`${id}-condition`}
          className="block text-xs text-dim"
        >
          Condition
        </label>
        <Dropdown
          id={`${id}-condition`}
          labelledBy={`${id}-condition-label`}
          value={condition}
          placeholder={unnamedGrade}
          onChange={setCondition}
          options={conditionOptions}
          fill
        />
      </div>

      <div className="space-y-1">
        <label htmlFor={`${id}-price`} className="block text-xs text-dim">
          Purchase price
        </label>
        {/* The currency beside the box rather than inside the label, because it is a fact about
            the number and not about the field: it is the row's own where the row has one, and the
            marketplace's only for a copy recording its first price. `aria-hidden` with the same
            word in the field's own name, so it is said once to a screen reader and drawn once for
            the eye — `CountTag`'s arrangement. */}
        <div className="flex items-center gap-2">
          <input
            id={`${id}-price`}
            type="text"
            inputMode="decimal"
            value={priceDraft}
            onChange={(e) => setPriceDraft(e.target.value)}
            // Enter saves, which is what a two-field form owes a keyboard — and it is bound on
            // the field rather than by making this a `<form>`: the picker above answers Enter of
            // its own inside a listbox, and a submit handler would turn taking a grade into a
            // write nobody asked for.
            onKeyDown={(e) => {
              if (e.key !== "Enter" || blocked || save.isPending) return;
              e.preventDefault();
              save.mutate();
            }}
            aria-label={`Purchase price in ${paidIn.toUpperCase()}`}
            aria-invalid={price.kind === "unreadable" || undefined}
            aria-describedby={priceNote === null ? undefined : `${id}-price-note`}
            className={FIELD}
          />
          <span aria-hidden="true" className="shrink-0 font-mono text-xs text-dim">
            {paidIn.toUpperCase()}
          </span>
        </div>
        {priceNote !== null && (
          <p id={`${id}-price-note`} className="text-[0.7rem] leading-relaxed text-dim">
            {priceNote}
          </p>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          aria-disabled={blocked || save.isPending}
          // The guard the paint would otherwise be lying about: an `aria-disabled` control still
          // delivers its press.
          onClick={() => {
            if (blocked || save.isPending) return;
            save.mutate();
          }}
          className={SAVE}
        >
          {save.isPending ? "Saving…" : "Save"}
        </button>
        <button type="button" onClick={onDone} className={CANCEL}>
          Cancel
        </button>
      </div>

      {save.isError && (
        // The dialog stays open behind this, with both answers still in it: a refused edit is one
        // the reader can try again, and `GONE` — the row deleted in another window — is the one
        // they need to read before the surface goes away.
        <p role="alert" className="text-xs text-destructive">
          Could not save this copy — {ipcError(save.error)}
        </p>
      )}
    </div>
  );
}
