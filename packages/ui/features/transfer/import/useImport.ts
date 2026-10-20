/**
 * The five writes an import makes, and the one rule that only lives here.
 *
 * Three of them are `ipc.ts`'s import commands wrapped in a mutation apiece. The fourth,
 * {@link useImport}'s `importIntoNewDeck`, is two commands with a rollback between them and
 * is the whole reason this file exists rather than a `useMutation` at the call site. The fifth,
 * `importBinders` (issue #873), is a ManaBox export split by binder — a sequence of the other
 * writes, one folder or deck at a time.
 *
 * **It is the shell's hook and the deck destinations', both** — `resolve` and `readFile` belong
 * to the source step, which every destination shares, and `commit`/`importIntoNewDeck` belong to
 * the two that write a deck. A `useMutation` with no key is one observer per caller and shares
 * nothing, so two components calling this hook is two independent sets of mutation state rather
 * than a leak between them — which is what lets the preview's refusal die with the preview.
 */
import { useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query";
import {
  ipc,
  ipcError,
  type CollectionFolder,
  type CollectionImportItem,
  type DeckGame,
  type DeckRow,
  type DeckVariant,
  type ImportCommitOutcome,
  type ImportItem,
  type ImportMode,
  type ImportOutcome,
  type ImportResolveLine,
  type ImportResolveRow,
  type PrintingTags,
} from "@/lib/ipc";
import { OWNED_WRITE_KEYS } from "@/lib/query";
import { DEFAULT_VARIANT } from "@/features/decks/deckQuery";
import { UNSPECIFIED_FORMAT } from "@/features/decks/FormatSelect";
import { chooseDecklist } from "../files";
import { binderGroupKey, type BinderGroup } from "./destinations/binders";

/**
 * The reader saying they have physically built this deck — the same lines a second time, at the
 * collection's own grain.
 *
 * **Not the deck's items adapted across, and the two lists are never derived from one another.**
 * A deck item is `(cardId, category, finish)`; a collection item is the eleven-column grain,
 * carrying the condition, the four flags, a serial number, a grading blob and the whole
 * acquisition story a CSV can put on a row. `planCollectionImport` is pure and already reads all
 * of it out of the same `resolved` rows, so the preview calls it a second time and hands the
 * answer here. Widening `ImportItem` to carry a condition would put a collection fact in the
 * deck's write and give the two grains one shape they cannot both be right about.
 *
 * **Absent is the import this app has always made** — `deck_cards` and nothing else — so every
 * caller written before the box existed is unchanged by construction, and an empty array is the
 * same statement as an unticked box.
 */
export type OwnedCopies = CollectionImportItem[];

/** What a commit into a deck that already exists needs — the four arguments of the command,
 *  because every one of them is a decision the dialog made and none can be defaulted here, plus
 *  the optional second write. */
export interface CommitImport {
  deckId: number;
  variant: DeckVariant;
  mode: ImportMode;
  items: ImportItem[];
  /** See {@link OwnedCopies}. Absent is the plain decklist import. */
  collectionItems?: OwnedCopies;
  /**
   * Whether the destination deck keeps no cardboard — `DeckRow.virtualOnly`.
   *
   * **Not a fifth argument of the command**: the backend reads the column itself and needs no
   * telling. It is here because it rides `variables` into `invalidate`, which is the one
   * decision on this hook that a virtual deck changes — a `replace` on its live list releases
   * no copy, so the collection roots must not be fired. Optional, because the callers that
   * cannot be virtual (`importIntoNewDeck`, which commits into a deck one statement old) mean
   * `false` by saying nothing.
   */
  virtual?: boolean;
}

/** A list becoming a deck of its own: the deck-level answers `deck_create` takes, and the
 *  list. */
export interface ImportAsNewDeck {
  name: string;
  formatKey: string;
  /** Which platform the new deck is for. Optional, and absent is `"any"` in Rust — so this
   *  hook's contract did not change for a caller that has not grown the control. */
  gameKey?: DeckGame;
  /** The folder the deck is filed in. Optional, and absent is the top level — `deck_create` is an
   *  INSERT, so an absent folder means exactly that. */
  folderId?: number;
  items: ImportItem[];
  /** See {@link OwnedCopies}. Absent is the plain decklist import. */
  collectionItems?: OwnedCopies;
}

/**
 * What one press did — both halves of it, because one press can now make two writes.
 *
 * **`ownRefusal` is a string on a *resolved* mutation, which is deliberate and is the whole of
 * the ordering argument.** The deck's commit runs first and its refusal is thrown, exactly as it
 * always was. The collection's runs second, and by the time it can fail the list is already in
 * the deck — so throwing there would put *"Could not import the list"* over a list that landed,
 * and invite a second press that merges the whole thing again. The refusal rides back beside the
 * outcome instead, and the preview says both things in one sentence.
 */
export interface DeckImportResult {
  outcome: ImportOutcome;
  /** What the collection write did, or `null` when the box was unticked **or** when it was
   *  refused — the two are told apart by {@link ownRefusal}, never by this being zero. */
  owned: ImportCommitOutcome | null;
  /** The collection half's refusal, already through `ipcError`. `null` when it landed or was
   *  never asked for. */
  ownRefusal: string | null;
}

/**
 * `collection_alloc::NO_DECK_GROUP`, reached from this side.
 *
 * Every deck has a group — schema v25 made one for every deck that existed and `deck_create`
 * makes one for every deck since — so this is a database that has been edited by hand. The
 * sentence is the crate's rather than a second one written here: one mistake, one wording, and
 * the reader who meets it from a drag meets it from an import too.
 */
export const NO_DECK_GROUP = "That deck has no folder to hold its cards.";

/**
 * **Which folder a deck's copies are filed into — the deck's own group.**
 *
 * `collection_folder_list` is unfiltered by kind precisely so a caller can find one: a `deck`
 * folder carries the deck it stands for in `deckId`, and the pair is CHECKed in the schema, so
 * `kind === "deck" && deckId === id` names exactly one row or none.
 *
 * **Read at press time rather than held in a query**, and that is the load-bearing half. A
 * `useQuery` on the folder list would be `undefined` while it loads and stale after another
 * surface makes a folder, and either way the fallback would be the root — which is precisely the
 * bug this whole change is fixing, reinstated as a race. It also has to work for
 * {@link useImport}'s `importIntoNewDeck`, where the deck did not exist a statement ago and no
 * query could have been keyed on it.
 *
 * A deck with no group **refuses** rather than quietly filing at the root: the reader ticked a
 * box that says these copies belong to this deck, and the root is a different statement.
 */
async function deckGroupId(deckId: number): Promise<number> {
  const folders = await ipc.collectionFolderList();
  const group = folders.find((f) => f.kind === "deck" && f.deckId === deckId);
  if (group === undefined) throw new Error(NO_DECK_GROUP);
  return group.id;
}

/**
 * The collection half of a press, and the whole of what makes it safe to make second.
 *
 * A refusal is **caught** rather than thrown, for {@link DeckImportResult}'s reason. `add` and
 * never `set`: the reader is saying they own these copies *as well as* whatever else is in the
 * box, not that this file is the whole of what they own — `set` over a 40-line paste would
 * rewrite the quantity of every printing it names.
 *
 * **Into the deck's own group, never the root.** That was an explicit product decision, taken
 * over the alternative of filing them at the top level: the reader is answering "I have
 * physically built *this deck*", so the decklist and the group agree the moment the dialog
 * closes and no other deck can claim the copies. Filed at the root the deck went on reading
 * *missing* on every line they had just said they own — which is what shipped for one PR, and
 * why {@link deckGroupId} refuses rather than falling back.
 *
 * **A plain collection import still files at the root** and is untouched by this: it never comes
 * through here, and `ipc.collectionImportCommit`'s third argument defaults to `null`.
 *
 * The lookup is inside the `try` for the same reason the write is: by the time it runs the deck
 * list has landed, so a busy database owes the reader a second sentence rather than a thrown
 * import.
 *
 * An absent or empty list makes no call at all. A command asked to write nothing is a round trip
 * that can only answer that it wrote nothing.
 */
async function ownCopies(
  items: OwnedCopies | undefined,
  deckId: number,
): Promise<Pick<DeckImportResult, "owned" | "ownRefusal">> {
  if (items === undefined || items.length === 0) return { owned: null, ownRefusal: null };
  try {
    const folderId = await deckGroupId(deckId);
    return { owned: await ipc.collectionImportCommit(items, "add", folderId), ownRefusal: null };
  } catch (refusal) {
    return { owned: null, ownRefusal: ipcError(refusal) };
  }
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
 * `useDeck`'s and `useDecks`' rule, kept here for their reasons. A commit adds and removes rows
 * in **this** deck, and `ownedQuantity` is a pool handed out across them — the deck's own group on
 * the Actual list, the wider `Availability::ForDeck` pool on the plan since 2026-09-09 (issue
 * #435) — so every row of it re-attributes; a create adds a tile; and a refusal is either a busy database or a
 * deck another surface has already deleted, the second of which must not leave a screen painting
 * a deck that is gone. The root is a prefix of `["decks", "list"]` and of every
 * `["decks", "detail", id, variant]`, so one key covers the gallery and the editor both.
 *
 * **And it is only that root for an import that _adds_**, because such a deck write is not a
 * collection write: a merge writes `deck_cards` and nothing else, and the copies that back those
 * rows are filed into the deck's group by `collection_to_deck` — a separate gesture the reader
 * makes on purpose. So `CollectionRow`'s counts and `CardSummary`'s owned count cannot have
 * moved, and firing the collection, wishlist and search roots there would be three refetches per
 * import that can only ever answer what is already on screen. **No other deck moves either**: a
 * group is one deck's, so an import can no longer take copies off a deck the reader is not
 * looking at. A `replace` on a **theory** list is the same statement one variant over — a plan
 * has never held a copy, so clearing it releases none.
 *
 * **A `replace` on the `live` variant is the press that argument does not cover, and it used to
 * be filed under it** (issue #336). That press deletes every `deck_cards` row of the list, and
 * `release_live_copies` — the Rust half of #336 — files the copies behind them into
 * `Recently removed` rather than stranding them in the deck's own group. So rows really do move
 * across the collection boundary without the box being ticked: the Collection page's placement,
 * the search wall's owned badges and the wishlist's owned progress each answer a question this
 * press has just changed the answer to, and `packages/ui/lib/query.ts` caches 30 s — which makes a
 * missing root a **wrong** screen for half a minute rather than a slow one. **No count fence**:
 * whether the live list held anything is not something this hook knows without another read, and
 * a refetch that answers what is already on screen is far cheaper than a stale collection.
 *
 * **A press carrying {@link OwnedCopies} fires {@link OWNED_WRITE_KEYS}, and so does that one** —
 * the same union rather than a set of its own, because they are the same claim about which roots
 * a `collection_entries` write moves. Both are decided off the mutation's own `variables` rather
 * than off a flag on the hook, because every press is the same mutation and only the press knows
 * which it was.
 *
 * **`importIntoNewDeck` is deliberately not widened.** It commits `"merge"` into a deck that did
 * not exist a statement ago, so there is nothing in it to clear and nothing to release — and it
 * pins that pair in its own body rather than taking it from a caller.
 *
 * `resolve` and `readFile` take no key at all: neither writes anything.
 */
export function useImport() {
  const queryClient = useQueryClient();
  /** The union when the press asked for copies **or** released some, `["decks"]` when it did
   *  neither — see the hook's doc. Fired on refusal as well as on success, on both arms and for
   *  the reason the deck root already was: a refused write can still be a database another
   *  surface has changed, and the deck half can have landed under a collection half that did
   *  not. */
  const invalidate = (
    collectionItems: OwnedCopies | undefined,
    /** What the press would have cleared. Omitted by `importIntoNewDeck` **on purpose** rather
     *  than by accident: it pins `"merge"` into a deck one statement old, so there is nothing
     *  for it to release and no reading of its variables that could say otherwise. */
    clearing?: { mode: ImportMode; variant: DeckVariant; virtual?: boolean },
  ) => {
    const wroteCopies = collectionItems !== undefined && collectionItems.length > 0;
    // Issue #336: this pair *is* a `collection_entries` write, whatever the box said.
    //
    // **`virtual` is the third way to release nothing, and it is not a variant.** A virtual deck
    // has no collection group, so `release_live_copies` walks an empty set and this press moves
    // no `collection_entries` row — but its rows are `live` rows, so the variant beside it says
    // the opposite. Absent means `false` for the callers that predate the field and for
    // `importIntoNewDeck`, which is right in both: a deck one statement old and a deck that
    // tracks its collection are both decks this test should not exempt.
    const releasedCopies =
      clearing?.mode === "replace" && clearing.variant === "live" && clearing.virtual !== true;
    const keys = wroteCopies || releasedCopies ? OWNED_WRITE_KEYS : [["decks"] as QueryKey];
    for (const queryKey of keys) void queryClient.invalidateQueries({ queryKey });
  };

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

  /**
   * The list into the deck that is open — and, when the reader said they own it, the copies
   * into their collection.
   *
   * **Two commands and two transactions, deck first, and the order is the whole of what the
   * reader is protected by.** A collection write that landed under a deck write that then failed
   * would leave copies claimed for a list that is not there — a state nothing on screen explains
   * and no command undoes. The other way round is exactly the import the box unticked makes,
   * which is what this app has shipped since the importer existed; so `deck_import_commit` goes
   * first, its refusal is thrown and stops the press before anything is owned, and the
   * collection's refusal comes back in {@link DeckImportResult.ownRefusal} instead.
   *
   * There is no rollback here and none is possible: `deck_import_commit` has no inverse — a
   * `replace` back would clear whatever was in the variant before the paste — which is the one
   * way this differs from {@link useImport}'s `importIntoNewDeck`, where `deck_delete` really
   * does undo `deck_create`.
   */
  const commit = useMutation({
    mutationFn: async ({
      deckId,
      variant,
      mode,
      items,
      collectionItems,
    }: CommitImport): Promise<DeckImportResult> => {
      const outcome = await ipc.deckImportCommit(deckId, variant, mode, items);
      return { outcome, ...(await ownCopies(collectionItems, deckId)) };
    },
    // The whole variables object as the second argument, because this is the one arm whose
    // `mode`/`variant` pair can itself be a collection write — see {@link invalidate}.
    onSuccess: (_result, variables) => invalidate(variables.collectionItems, variables),
    onError: (_refusal, variables) => invalidate(variables.collectionItems, variables),
  });

  /**
   * The reader's choice of decklist file, as text — `null` for a cancelled picker.
   *
   * Rust opens the dialog *and* the file, so no path ever reaches this side and the page needs
   * neither a `dialog:` nor an `fs:` permission (issue #545) — `transfer/files.ts` has the rest. A
   * *mutation*, because the dialog being up and the file being read are one wait the button has
   * to be disabled for.
   */
  const readFile = useMutation({
    mutationFn: () => chooseDecklist(),
  });

  /**
   * A decklist as a deck of its own: `deck_create`, then the same commit, then the deck —
   * {@link createDeckFromList}, whose doc carries the rollback and why it is there.
   *
   * **The collection half runs after the rollback window closes, and the rollback deliberately
   * does not cover it.** A refused `deck_import_commit` deletes the deck and never reaches the
   * copies, so a reader whose import bounced owns nothing new. A refused
   * `collection_import_commit` leaves the deck standing, because the deck is what they asked for
   * and deleting it over the *second* statement would throw away the first.
   */
  const importIntoNewDeck = useMutation({
    mutationFn: async (args: ImportAsNewDeck): Promise<DeckImportResult & { deck: DeckRow }> => {
      const { deck, outcome } = await createDeckFromList(args);
      // After the rollback window on purpose, and not merely because {@link ownCopies} swallows
      // its own refusal: the rollback's whole scope is the deck that was made one statement ago,
      // and a `catch` that reached this call would be a delete of a landed deck over a second
      // statement about the reader's box.
      return { deck, outcome, ...(await ownCopies(args.collectionItems, deck.id)) };
    },
    onSuccess: (_result, variables) => invalidate(variables.collectionItems),
    onError: (_refusal, variables) => invalidate(variables.collectionItems),
  });

  /**
   * A ManaBox export, binder by binder (issue #873) — {@link importBinderGroups}, with the whole
   * owned union fired afterwards whichever way it went: every group is a `collection_entries`
   * write, the deck groups are `["decks"]` writes too, and a press that stopped part-way has
   * still changed whatever landed before it stopped.
   */
  const importBinders = useMutation({
    mutationFn: ({ groups, progress }: BinderImportPress) => importBinderGroups(groups, progress),
    onSettled: () => {
      for (const queryKey of OWNED_WRITE_KEYS) void queryClient.invalidateQueries({ queryKey });
    },
  });

  return { resolve, commit, readFile, importIntoNewDeck, importBinders };
}

/**
 * `deck_create`, then the list into it — and the deck deleted again if the list is refused.
 *
 * {@link useImport}'s `importIntoNewDeck` and {@link importBinderGroups} both make a deck out of
 * a list, and both owe the reader the same promise: a refused import leaves no deck behind.
 *
 * **A refused import must not leave a deck behind.** The reader asked for "this list as a deck";
 * half of that is not a smaller version of it, it is a mess in their gallery — and the dialog is
 * still open holding the text they pasted, so the retry is one press. So the create is rolled
 * back by hand, because the two commands are two transactions and nothing else can roll them
 * back together.
 *
 * **The commit's refusal is what the caller hears**, never the delete's. The delete is clean-up:
 * if it fails too, the reader is owed the sentence explaining why their import did not land, not
 * a second one about the tidying up afterwards — and the deck they can see in the gallery is one
 * they can remove themselves. Its own failure is swallowed for exactly that reason and for no
 * other.
 *
 * `live` and `merge` are the only sensible pair into a deck made one line ago: there is nothing to
 * merge with and nothing to replace, and `merge` is the mode that cannot clear anything if that
 * ever stops being true.
 *
 * The copies ({@link ImportAsNewDeck.collectionItems}) are **not** written here: what a refusal
 * of that second write means differs between the two callers, so each makes it itself.
 */
async function createDeckFromList({
  name,
  formatKey,
  gameKey,
  folderId,
  items,
}: ImportAsNewDeck): Promise<{ deck: DeckRow; outcome: ImportOutcome }> {
  const deck = await ipc.deckCreate({ name, formatKey, gameKey, folderId });
  try {
    return { deck, outcome: await ipc.deckImportCommit(deck.id, DEFAULT_VARIANT, "merge", items) };
  } catch (refusal) {
    try {
      await ipc.deckDelete(deck.id);
    } catch {
      // See above: the import's refusal is the news, and this one would bury it.
    }
    throw refusal;
  }
}

/** What a binder import wrote, for the dialog's closing sentence. */
export interface BinderImportResult {
  /** Folders filed into, the ones it had to make included. The root is not a folder. */
  folders: number;
  /** Of {@link folders}, how many did not exist before the press. */
  foldersCreated: number;
  /** The decks it made, in the file's order. */
  decks: DeckRow[];
  /** Copies written, over every group. */
  copies: number;
}

/**
 * The folder a binder's copies are filed into: a **top-level folder of the reader's own** whose
 * name matches, or a new one made at the top level.
 *
 * **Matched case-insensitively and trimmed**, because the issue's rule is "a folder with that
 * name" and `Bulk` against `bulk` is the same drawer to the person who named both. **Top level
 * only**: a folder nested three deep that happens to share a binder's name is somewhere the
 * reader filed on purpose, and ManaBox's binders are flat — so a match is looked for exactly
 * where a new one would be made. **`user` folders only**: a deck's group is named after its deck,
 * and filing a binder into it would put copies in a deck that does not play them — the very
 * placement `set_entry_folder` refuses.
 *
 * `folders` is the press's own census and is extended as folders are made, so two groups naming
 * one folder (`Bulk`, `bulk`) find the one the first of them created rather than making two.
 */
async function folderFor(
  name: string,
  folders: CollectionFolder[],
): Promise<{ id: number; created: boolean }> {
  const key = name.trim().toLocaleLowerCase();
  const found = folders.find(
    (f) => f.kind === "user" && f.parentId === null && f.name.trim().toLocaleLowerCase() === key,
  );
  if (found !== undefined) return { id: found.id, created: false };
  const made = await ipc.collectionFolderCreate(null, name.trim());
  folders.push(made);
  return { id: made.id, created: true };
}

/** One press of a sorted import: the plan's groups, and the step's {@link BinderImportProgress}. */
export interface BinderImportPress {
  groups: readonly BinderGroup[];
  progress: BinderImportProgress;
}

/**
 * What the presses of one sorted import have written so far (issue #1173) — held by the step
 * across presses, so that pressing Import again after a refusal **finishes the file rather than
 * starting it over**. Without it a retry `add`ed every group that had already landed a second
 * time, doubling those copies, and made a second deck out of every `deck` binder.
 *
 * Keyed on {@link binderGroupKey}, never on the group objects: the plan is memoised on the step's
 * defaults and is rebuilt whenever one changes, and a group that landed has landed whatever its
 * rows say now. The single-folder press guards its retry the same way (`CollectionPreviewBody`'s
 * `made` ref), for the one folder it can make.
 */
export interface BinderImportProgress {
  /** Groups whose every write landed — skipped by a later press. */
  landed: Set<string>;
  /**
   * Decks made for a group whose *copies* were then refused. The deck stands (see
   * {@link importBinderGroups}), so a later press files the copies into it rather than making a
   * second one beside it.
   */
  decks: Map<string, DeckRow>;
  /**
   * The folder each folder group was filed into, and whether the press made it — so a folder
   * made by a press whose commit was refused is still counted as new when a later one lands it.
   */
  folders: Map<string, { id: number; created: boolean }>;
  /** Every press's writes added together: what the closing sentence and the toast count. */
  result: BinderImportResult;
}

/** A ledger with nothing written — one per sorted import, kept by the step across its presses. */
export function binderImportProgress(): BinderImportProgress {
  return {
    landed: new Set(),
    decks: new Map(),
    folders: new Map(),
    result: { folders: 0, foldersCreated: 0, decks: [], copies: 0 },
  };
}

/**
 * Every group of a {@link planBinderImport} plan, written in the file's order: a folder group's
 * copies into its folder (or the root), a deck group as a new {@link UNSPECIFIED_FORMAT} deck with
 * its copies filed into the deck's own group.
 *
 * **One group is one or two transactions, and the press is a sequence of them** — not the one
 * transaction a single-destination import is. That is deliberate rather than a gap: each write is
 * the command the single-destination import already makes (`collection_import_commit` into a
 * folder, `importIntoNewDeck`'s pair), so the rules that guard them — the folder fence, the deck
 * rollback, the merge on the eleven-term grain — are the ones that have already shipped, rather
 * than a new command re-stating all of them across N folders and M decks.
 *
 * **What that costs is a press that can stop part-way, and it stops loudly.** The first refusal
 * ends the press — a database that refused one write is not one to keep writing into — and is
 * thrown with the groups that had already landed named in the same sentence, so the reader knows
 * which drawers to look in before they press Import again. A deck whose list was refused leaves
 * no deck behind ({@link createDeckFromList}); a deck whose *copies* were refused stays, because
 * the list landed and is the deck they asked for, and the sentence says so.
 *
 * **And pressing again picks up where it stopped** (issue #1173): every write is recorded in
 * `progress` as it lands, so a later press with the same ledger skips the groups that landed and
 * files a stopped deck's copies into the deck it already made. The counts it returns and throws
 * are the whole import's, every press together.
 *
 * Always `add`, never `set`: a `set` is collection-wide — it counts every folder's copies toward
 * the file's number — so run once per binder it would have each group rewrite the others'.
 */
export async function importBinderGroups(
  groups: readonly BinderGroup[],
  progress: BinderImportProgress = binderImportProgress(),
): Promise<BinderImportResult> {
  const { result } = progress;
  const labelOf = (group: BinderGroup) =>
    group.name === null ? "cards with no binder" : `“${group.name}”`;
  const keyOf = (group: BinderGroup) => binderGroupKey(group.name, group.target);
  const pending = groups.filter((group) => !progress.landed.has(keyOf(group)));
  // One read for the whole press, extended by {@link folderFor} as it makes folders — and only
  // when a folder group is still to be filed, so a retry of a deck alone reads nothing.
  const folders = pending.some(
    (g) => g.target === "folder" && g.name !== null && !progress.folders.has(keyOf(g)),
  )
    ? await ipc.collectionFolderList()
    : [];
  for (const group of pending) {
    const key = keyOf(group);
    try {
      if (group.target === "deck") {
        let deck = progress.decks.get(key);
        if (deck === undefined) {
          ({ deck } = await createDeckFromList({
            name: group.name ?? "",
            formatKey: UNSPECIFIED_FORMAT,
            items: group.deckItems,
          }));
          progress.decks.set(key, deck);
        }
        try {
          const folderId = await deckGroupId(deck.id);
          await ipc.collectionImportCommit(group.collectionItems, "add", folderId);
        } catch (refusal) {
          throw new Error(
            `the deck ${labelOf(group)} was made, but its cards couldn't be added to your ` +
              `collection — ${ipcError(refusal)}`,
            { cause: refusal },
          );
        }
        result.decks.push(deck);
      } else if (group.name === null) {
        await ipc.collectionImportCommit(group.collectionItems, "add", null);
      } else {
        let folder = progress.folders.get(key);
        if (folder === undefined) {
          folder = await folderFor(group.name, folders);
          progress.folders.set(key, folder);
        }
        await ipc.collectionImportCommit(group.collectionItems, "add", folder.id);
        result.folders += 1;
        if (folder.created) result.foldersCreated += 1;
      }
    } catch (refusal) {
      const landed = groups.filter((g) => progress.landed.has(keyOf(g))).map(labelOf);
      const already = landed.length === 0 ? "" : ` Already imported: ${landed.join(", ")}.`;
      throw new BinderImportStopped(
        `Stopped at ${labelOf(group)}: ${ipcError(refusal)}.${already}`,
        result.copies,
        groups.reduce((sum, g) => sum + g.totalCards, 0),
        refusal,
      );
    }
    result.copies += group.totalCards;
    progress.landed.add(key);
  }
  return result;
}

/**
 * {@link importBinderGroups}' refusal: its sentence, and how far the press got — so the toast can
 * say a press that stopped part-way as "Imported 40 of 120 cards" (a warning) and one that landed
 * nothing as a refusal, which is the owner's rule for a batch that partly failed.
 */
export class BinderImportStopped extends Error {
  /** Copies that landed, in the groups before the one that was refused. */
  readonly copies: number;
  /** Copies the whole press would have written. */
  readonly total: number;

  constructor(message: string, copies: number, total: number, cause: unknown) {
    super(message, { cause });
    this.name = "BinderImportStopped";
    this.copies = copies;
    this.total = total;
  }
}

/** The whole of what the import dialog consumes, named so the surface and the hook agree. */
export type ImportWrites = ReturnType<typeof useImport>;
