/**
 * What a deck export is **of** — the subject the dialog is titled with, the cards it writes and the
 * name the save suggests — for the whole deck or for one pile.
 *
 * **Moved out of `DeckEditor.tsx`, unchanged, so the light app's phone face can ask it too.** The
 * editor reaches the app store and the phone face may not import it (`mobile/phone/fence.test.ts`);
 * these three answers reach nothing but the deck's own rows, and two faces exporting one deck must
 * title it, fill it and name its file the same way. `DeckEditor.tsx` re-exports all of it.
 */
import type { DeckCard, DeckCategory } from "@/lib/ipc";
import { fromDeckCard, type TransferCard } from "@/features/transfer/TransferCard";

/** The same trick for the closed export dialog, which is mounted at every render and asked for
 *  a card list whether or not it is drawing one. */
const NO_EXPORT_CARDS: readonly TransferCard[] = [];

/**
 * What the export dialog is titled when the pile it was opened on has gone.
 *
 * Reachable: another surface — the Categories dialog, a second window on the same database —
 * can delete a category while this dialog is open over it, and the editor re-reads the deck
 * without it. The empty card list that follows is honest; `Export ""` as the dialog's accessible
 * name is not, which is the whole reason this string exists rather than a fallback of `""`.
 * **Not the deck's name**, and that is sharper now than when it was written: the header's
 * `Export deck` titles itself with exactly that, so a deleted pile falling back to it would be
 * indistinguishable from a press nobody made.
 */
const DELETED_CATEGORY = "a deleted category";

/**
 * What the export dialog is titled when the **deck** has no name of its own.
 *
 * {@link DELETED_CATEGORY}'s argument applied to the other scope — `Export ""` is not an
 * accessible name — and the state is reachable rather than defensive: the header's name field
 * takes an empty string, and the editor renders with `row` still `null` for the length of the
 * first read.
 */
const UNNAMED_DECK = "this deck";

/**
 * What the save dialog's file name starts as: the deck and the pile.
 *
 * The characters Windows forbids in a file name are taken out rather than replaced — a deck
 * called `Atraxa: Superfriends` should suggest `Atraxa Superfriends - Removal`, not a name with
 * an underscore where nobody typed one. The extension is `ExportDialog`'s, which appends the one
 * belonging to the format chosen there.
 *
 * **An empty half contributes nothing, separator included** — and it is cleaned *before* it is
 * judged empty, which is the order that matters. Joining unconditionally answered `"Atraxa -"`
 * for a pile with no name (the state {@link DELETED_CATEGORY} covers on the title side), and
 * filtering before stripping would answer `"-"` for a deck whose whole name is punctuation this
 * has to remove.
 *
 * Exported for its test, and still exported now that the header has an `Export deck` to open the
 * dialog with: what this answers is only ever *seen* inside the native save picker, which
 * `export_save_file` opens from Rust, outside the page — no test and no CDP pass can read the
 * name in that box. The dialog has a rendered path; this string does not.
 */
export function exportFileName(deck: string, category: string): string {
  const name = [deck, category]
    .map((part) => part.replace(/[\\/:*?"<>|]/g, "").trim())
    .filter((part) => part !== "")
    .join(" - ");
  // A deck with no name, and this dialog rendered closed, both reach here. `save()` is handed a
  // `defaultPath`, and an empty one is a picker with no name in its box.
  return name === "" ? "decklist" : name;
}

/**
 * What is being exported: the whole deck, or one pile.
 *
 * **Three states rather than a nullable id**, counting the `null` {@link exportSubject} takes for
 * a closed dialog: `null` already carries a meaning in the layer's own arm — the whole deck — so
 * reusing it for "nothing is being exported" would be one sentinel answering two questions. Two
 * shapes ask them separately, and each answer is then narrowed by the type rather than by a
 * comment.
 */
export type ExportScope = { kind: "deck" } | { kind: "category"; categoryId: number };

/**
 * The three arguments `ExportDialog` takes, for whatever the `export` layer is aimed at.
 *
 * **Derived from the deck's live list rather than from what a control was holding**, which is why
 * the layer carries an id and not the cards: a deck is re-read after every write, so a snapshot
 * taken when the menu opened would describe the pile as it was. A rename under the open dialog
 * therefore retitles it, and a delete empties it and says so.
 *
 * `cards` is the deck's rows and **not** `shown`: the toolbar's filter narrows what is *drawn*,
 * and exporting "Removal" means the pile rather than the four of it a search box happens to be
 * showing. **The deck scope passes every row of the variant on screen, switched-off piles
 * included** — what a format does with a maybeboard is the *format's* decision, and
 * `format.ts`'s `omittedCount` is what says so in the dialog rather than a filter here.
 *
 * A `null` scope is a **closed** dialog, which is every render but the ones it is up — the
 * subject is `""` there because nothing draws it, and that is the one case that must **not** read
 * {@link DELETED_CATEGORY}: a closed dialog is not a statement about a deleted pile.
 *
 * **The cards are `TransferCard`s, built through `fromDeckCard`** — the row shape `ExportDialog`
 * and `formatExport` speak now, so this function is one of the two places (`categoryMenu.tsx`'s
 * export row is the other) that adapts a deck's own `DeckCard`s on the way out. That trades away
 * the old identity guarantee for the deck scope — the returned array is a fresh one, mapped
 * rather than passed through — but the claim it stood for is untouched: every row of the variant
 * on screen still arrives, switched-off piles included, with nothing filtered out here.
 *
 * Pure, and exported for that reason: see {@link exportFileName}.
 */
export function exportSubject(
  scope: ExportScope | null,
  categories: readonly DeckCategory[],
  cards: readonly DeckCard[],
  deckName: string,
): { subject: string; cards: readonly TransferCard[]; fileName: string } {
  if (scope === null) {
    return { subject: "", cards: NO_EXPORT_CARDS, fileName: exportFileName(deckName, "") };
  }
  if (scope.kind === "deck") {
    return {
      subject: deckName === "" ? UNNAMED_DECK : deckName,
      cards: cards.map(fromDeckCard),
      // The deck's own name and no second half, which `exportFileName` already answers for an
      // empty one: a whole-deck export is the deck, so there is no pile to name after it.
      fileName: exportFileName(deckName, ""),
    };
  }
  const name = categories.find((c) => c.id === scope.categoryId)?.name ?? null;
  return {
    subject: name ?? DELETED_CATEGORY,
    cards: cards.filter((c) => c.categoryId === scope.categoryId).map(fromDeckCard),
    // The **name**, never the subject: a file called `Burn - a deleted category` is a sentence
    // where a name belongs, and the deck's own name is the honest suggestion for a pile that is
    // not there any more.
    fileName: exportFileName(deckName, name ?? ""),
  };
}
