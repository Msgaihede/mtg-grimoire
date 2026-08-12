/**
 * The four writes an import makes, and the one rule that only lives here.
 *
 * Three of them are `ipc.ts`'s import commands wrapped in a mutation apiece. The fourth,
 * {@link useDeckImport}'s `importIntoNewDeck`, is two commands with a rollback between them and
 * is the whole reason this file exists rather than a `useMutation` at the call site.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ipc,
  type DeckRow,
  type DeckVariant,
  type ImportItem,
  type ImportMode,
  type ImportOutcome,
  type ImportResolveLine,
} from "@/lib/ipc";
import { DEFAULT_VARIANT } from "../useDeck";

/** What a commit into a deck that already exists needs — the four arguments of the command,
 *  because every one of them is a decision the dialog made and none can be defaulted here. */
export interface CommitImport {
  deckId: number;
  variant: DeckVariant;
  mode: ImportMode;
  items: ImportItem[];
}

/** A list becoming a deck of its own: the two fields `deck_create` takes, and the list. */
export interface ImportAsNewDeck {
  name: string;
  formatKey: string;
  items: ImportItem[];
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
 * `resolve` and `readFile` take no key at all: neither writes anything.
 */
export function useDeckImport() {
  const queryClient = useQueryClient();
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ["decks"] });
  const writes = { onSuccess: invalidate, onError: invalidate };

  /**
   * Every name in the parsed list, in one call, answered with a printing or with nothing.
   *
   * Read-only, so it is a mutation rather than a query for the one reason a write is: it is
   * fired by a press. A query keyed on the pasted text would cache an answer per keystroke.
   */
  const resolve = useMutation({
    mutationFn: (lines: ImportResolveLine[]) => ipc.deckImportResolve(lines),
  });

  const commit = useMutation({
    mutationFn: ({ deckId, variant, mode, items }: CommitImport) =>
      ipc.deckImportCommit(deckId, variant, mode, items),
    ...writes,
  });

  /** The picker answers a path and Rust opens the file — which is the whole of why
   *  `dialog:allow-open` is enough and no `fs:` permission exists anywhere in this app. */
  const readFile = useMutation({ mutationFn: (path: string) => ipc.deckImportReadFile(path) });

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
      items,
    }: ImportAsNewDeck): Promise<{ deck: DeckRow; outcome: ImportOutcome }> => {
      const deck = await ipc.deckCreate({ name, formatKey });
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
export type DeckImport = ReturnType<typeof useDeckImport>;
