/**
 * Where an import is going, as a thing the dialog can hold four of without knowing which.
 *
 * The shell is one file: the pasted text, the file picker, the one `import_resolve` call, the
 * step machine and the dismissal rungs. Everything past that — which pile, which grain, which
 * modes, which button — belongs to whatever the cards are going into, and this is the seam
 * between the two.
 */
import type { JSX } from "react";
import type { ImportResolveRow, PrintingTags } from "@/lib/ipc";
import type { ParsedList } from "./parse";

/**
 * A destination is **UI**, not domain logic.
 *
 * The planners stay plain exported functions — `buildImportPlan` for a deck,
 * `planCollectionImport`, `planWishlistImport` — fully typed and unit-tested on their own.
 * What a destination owns is the second step of the dialog: its options state, its preview, its
 * mode radios and its Import button.
 *
 * **Deliberately not generic**, and that is not laziness. An `ImportDestination<TItem, TOptions>`
 * cannot be held in one array by a shell that does not know which it has — parameter positions
 * are contravariant, so nothing widens to `ImportDestination<unknown, unknown>` — and every
 * escape from that (a union to narrow, a cast, a `usePrepared` hook whose identity changes when
 * the reader switches destination and breaks the rules of hooks) is worse than letting each
 * destination render its own step. Four short bodies over `Tally`, `ProblemList`, `ModeRadios`
 * and `CommitBar` cost less than one leaked type parameter.
 */
export interface ImportDestination {
  key: "deck" | "newDeck" | "collection" | "wishlist";
  /** The destination radio's word: `Import into <label>`. */
  label: string;
  Preview: (props: DestinationPreviewProps) => JSX.Element;
}

/**
 * What every preview is handed, and the whole of it.
 *
 * **A destination that needs more than this closes over it at the call site** rather than
 * widening this interface — the deck's own identity is the example, and `DeckPreview`'s
 * `deckDestination` is where that wrapper is written. Threading a deck id through here would put
 * a fact three of the four destinations have no use for into the shell that must not know which
 * one it is holding.
 */
export interface DestinationPreviewProps {
  list: ParsedList;
  resolved: readonly ImportResolveRow[];
  /** One read for the whole list, made by the shell. Empty is a complete answer — the
   *  taxonomy has a supported state of never having been downloaded. */
  tags: readonly PrintingTags[];
  /** Close, reporting what landed. */
  onDone: (message: string) => void;
  /** Back to the paste step, keeping the text. */
  onBack: () => void;
}

/** One mode's word and the sentence under it. */
export interface ImportModeOption {
  key: string;
  label: string;
  hint: string;
}
