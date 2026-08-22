/**
 * The four writes an import makes, and the one rule that only lives here.
 *
 * Three of them are `ipc.ts`'s import commands wrapped in a mutation apiece. The fourth,
 * {@link useImport}'s `importIntoNewDeck`, is two commands with a rollback between them and
 * is the whole reason this file exists rather than a `useMutation` at the call site.
 *
 * **It is the shell's hook and the deck destinations', both** — `resolve` and `readFile` belong
 * to the source step, which every destination shares, and `commit`/`importIntoNewDeck` belong to
 * the two that write a deck. A `useMutation` with no key is one observer per caller and shares
 * nothing, so two components calling this hook is two independent sets of mutation state rather
 * than a leak between them — which is what lets the preview's refusal die with the preview.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ipc,
  type DeckGame,
  type DeckRow,
  type DeckVariant,
  type ImportItem,
  type ImportMode,
  type ImportOutcome,
  type ImportResolveLine,
  type ImportResolveRow,
  type PrintingTags,
} from "@/lib/ipc";
import { useDeckWriteRoots } from "@/lib/useDeckDrivenCollection";
import { DEFAULT_VARIANT } from "@/features/decks/useDeck";

/** What a commit into a deck that already exists needs — the four arguments of the command,
 *  because every one of them is a decision the dialog made and none can be defaulted here. */
export interface CommitImport {
  deckId: number;
  variant: DeckVariant;
  mode: ImportMode;
  items: ImportItem[];
}

/** A list becoming a deck of its own: the deck-level answers `deck_create` takes, and the
 *  list. */
export interface ImportAsNewDeck {
  name: string;
  formatKey: string;
  /** Which platform the new deck is for. Optional, and absent is `"any"` in Rust — so this
   *  hook's contract did not change for a caller that has not grown the control. */
  gameKey?: DeckGame;
  items: ImportItem[];
}

/**
 * Everything the planner needs about a pasted list, from the one press that asked for it.
 *
 * **Two reads and one answer, deliberately.** `buildImportPlan` files every line by
 * `autoCategoryFor`, which reads a card's Oracle tags before its type line — so a preview drawn
 * from `rows` alone would show the piles the app filed *last* month and the commit would send
 * different ones. Handing both back together means the preview step is reached once, with
 * everything it needs, and there is no window in which a type-line tally is on screen waiting
 * for a taxonomy answer to redraw it.
 */
export interface ResolvedList {
  rows: ImportResolveRow[];
  /** One entry per **distinct** matched card id — the command drops blanks and duplicates, so
   *  this can be shorter than the list, and `buildImportPlan` matches it back by `cardId`.
   *  Empty is a complete answer: it plans the same import, filed by type line. */
  tags: PrintingTags[];
}

/**
 * What the resolved printings do, in **one** read for the whole list.
 *
 * **One call, never one per line.** `import_resolve` answers 105 names in a single
 * command precisely so an import costs one round trip; a tag read per line would put ~100
 * `invoke`s back where that trip saved them. The ids are deduplicated first — the backend drops
 * duplicates anyway, and a list with six Forests has no business sending six of them.
 *
 * **A refused tag read is not a refused import**, which is the whole reason this is a function
 * with a `catch` rather than a second `await` in the mutation. The taxonomy is a separate
 * dataset with its own weekly refresh and a supported state of never having been downloaded;
 * every line still lands, in the type-line pile the app filed it in before Oracle tags existed.
 * Losing a 105-line paste to a taxonomy fetch would be the worst trade this dialog could make.
 */
async function tagsFor(rows: readonly ImportResolveRow[]): Promise<PrintingTags[]> {
  const cardIds = [
    ...new Set(rows.flatMap((row) => (row.matched === null ? [] : [row.matched.cardId]))),
  ];
  // Nothing resolved — a list of typos, or the opening sync. There is nothing to ask about.
  if (cardIds.length === 0) return [];
  try {
    return await ipc.oracleTagsForPrintings(cardIds);
  } catch {
    return [];
  }
}

/**
 * Resolve, commit, read a file — and make a deck out of a list.
 *
 * **`["decks"]`, the whole root, from every write and on refusal as well as on success** —
 * `useDeck`'s and `useDecks`' rule, kept here for their reasons. A commit runs `allocate_deck`
 * inside its own transaction, so every `ownedQuantity` in every open deck may have moved; a
 * create adds a tile; and a refusal is either a busy database or a deck another surface has
 * already deleted, the second of which must not leave a screen painting a deck that is gone.
 * The root is a prefix of `["decks", "list"]` and of every `["decks", "detail", id, variant]`,
 * so one key covers the gallery and the editor both.
 *
 * **And, while the collection is derived, everything else the reader owns** —
 * {@link useDeckWriteRoots} is the list and the gate, and `["decks"]` stays in both arms so the
 * paragraph above holds unchanged in either mode. This is the largest single write in the app:
 * `deck_import_commit` takes a whole pasted decklist in one command, so three hundred lines is
 * three hundred cards arriving in the collection at once. Every one of them would otherwise land
 * unannounced — `src/lib/query.ts` sets `staleTime: 30_000`, so the collection page and the
 * search wall are *fresh* caches that mounting does not refetch, and nothing but an invalidation
 * tells them. The Rust side routes this command deliberately; this is the half that was missing.
 *
 * `resolve` and `readFile` take no key at all: neither writes anything.
 */
export function useImport() {
  const queryClient = useQueryClient();
  const writeRoots = useDeckWriteRoots();
  const invalidate = () => {
    for (const queryKey of writeRoots) void queryClient.invalidateQueries({ queryKey });
  };
  const writes = { onSuccess: invalidate, onError: invalidate };

  /**
   * Every name in the parsed list, in one call, answered with a printing or with nothing — and
   * then what those printings **do**, in one more.
   *
   * Read-only, so it is a mutation rather than a query for the one reason a write is: it is
   * fired by a press. A query keyed on the pasted text would cache an answer per keystroke.
   *
   * **Two commands and one mutation, so the preview cannot draw half an answer.** The dialog
   * crosses to its second step in this mutation's `onSuccess`; both facts are in the data by
   * then, so the tally the reader reads is the tally Import sends. A tag read fetched
   * separately, after the step had rendered, would put the type-line numbers on screen and then
   * change them under the reader — and this dialog has already shipped one bug where the
   * preview and the commit disagreed. It costs nothing: {@link tagsFor} cannot fail the press.
   */
  const resolve = useMutation({
    mutationFn: async (lines: ImportResolveLine[]): Promise<ResolvedList> => {
      const rows = await ipc.importResolve(lines);
      return { rows, tags: await tagsFor(rows) };
    },
  });

  const commit = useMutation({
    mutationFn: ({ deckId, variant, mode, items }: CommitImport) =>
      ipc.deckImportCommit(deckId, variant, mode, items),
    ...writes,
  });

  /** The picker answers a path and Rust opens the file — which is the whole of why
   *  `dialog:allow-open` is enough and no `fs:` permission exists anywhere in this app. */
  const readFile = useMutation({ mutationFn: (path: string) => ipc.importReadFile(path) });

  /**
   * A decklist as a deck of its own: `deck_create`, then the same commit, then the deck.
   *
   * **A refused import must not leave a deck behind.** The reader asked for "this list as a
   * deck"; half of that is not a smaller version of it, it is a mess in their gallery — and the
   * dialog is still open holding the text they pasted, so the retry is one press. So the create
   * is rolled back by hand, because the two commands are two transactions and nothing else can
   * roll them back together.
   *
   * **The commit's refusal is what the caller hears**, never the delete's. The delete is
   * clean-up: if it fails too, the reader is owed the sentence explaining why their import did
   * not land, not a second one about the tidying up afterwards — and the deck they can see in
   * the gallery is one they can remove themselves. Its own failure is swallowed for exactly
   * that reason and for no other.
   *
   * `live` and `merge` are the only sensible pair into a deck made one line ago: there is
   * nothing to merge with and nothing to replace, and `merge` is the mode that cannot clear
   * anything if that ever stops being true.
   */
  const importIntoNewDeck = useMutation({
    mutationFn: async ({
      name,
      formatKey,
      gameKey,
      items,
    }: ImportAsNewDeck): Promise<{ deck: DeckRow; outcome: ImportOutcome }> => {
      const deck = await ipc.deckCreate({ name, formatKey, gameKey });
      try {
        const outcome = await ipc.deckImportCommit(deck.id, DEFAULT_VARIANT, "merge", items);
        return { deck, outcome };
      } catch (refusal) {
        try {
          await ipc.deckDelete(deck.id);
        } catch {
          // See above: the import's refusal is the news, and this one would bury it.
        }
        throw refusal;
      }
    },
    ...writes,
  });

  return { resolve, commit, readFile, importIntoNewDeck };
}

/** The whole of what the import dialog consumes, named so the surface and the hook agree. */
export type ImportWrites = ReturnType<typeof useImport>;
