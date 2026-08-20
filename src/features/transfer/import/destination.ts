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
  /**
   * The line under the dialog's heading while **this** destination is the chosen one.
   *
   * **It has to belong to the destination rather than to the host, because the header is drawn
   * on both steps and the destination radios are only on the first.** A host prop cannot vary
   * with the choice, so a reader who picked "a new deck" and pressed Preview would read
   * `Into Burn · Live` over a step that is making a different deck entirely. That is not a
   * hypothetical for long: the shell draws radios the moment a host passes two.
   *
   * Optional, and absent falls back to `ImportDialogProps.subtitle` — which is what a
   * destination with nothing of its own to say (the new deck: there is no deck yet to name)
   * leaves to the surface that opened the dialog.
   *
   * A **component**, for the same reason `Preview` is: the deck's line is its *name*, which
   * comes from a `deck_get`, and a dialog nobody has opened must not make that read.
   */
  Subtitle?: () => JSX.Element;
  Preview: (props: DestinationPreviewProps) => JSX.Element;
}

/**
 * What every preview is handed, and the whole of it.
 *
 * **A destination that needs more than this closes over it at the call site** rather than
 * widening this interface — the deck's own identity is the example, and `destinations/deckInto.ts`
 * is where that wrapper is written. Threading a deck id through here would put a fact three of
 * the four destinations have no use for into the shell that must not know which one it is
 * holding.
 */
export interface DestinationPreviewProps {
  list: ParsedList;
  resolved: readonly ImportResolveRow[];
  /** One read for the whole list, made by the shell. Empty is a complete answer — the
   *  taxonomy has a supported state of never having been downloaded. */
  tags: readonly PrintingTags[];
  /** Close, reporting what landed. */
  onDone: (message: string) => void;
  /**
   * Back to the paste step, keeping the text.
   *
   * **This unmounts the preview, so nothing a destination holds survives it** — the mode, the
   * condition default, the name typed for a new deck, a commander picked. That is the rule
   * rather than an accident: the alternative is the shell holding state it must not know the
   * shape of, which is the coupling this seam exists to remove. Anything that has to outlive a
   * Back belongs to the *paste* and therefore to the shell, or is re-derived from `list` on the
   * way back in — the new deck's name re-seeds from `list.suggestedName` exactly that way.
   * Pinned by `ImportDialog.test.tsx`'s "keeps the pasted text across Back and discards the
   * destination's own options".
   */
  onBack: () => void;
}

/** One mode's word and the sentence under it. */
export interface ImportModeOption {
  key: string;
  label: string;
  hint: string;
}
