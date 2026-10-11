/**
 * Decklist import and file transfer: resolving a pasted or picked list, committing it to a deck, and the native file dialogs the desktop answers.
 *
 * **One domain of `../ipc.ts`, split out on 2026-10-11 (issue #557).** Nothing outside
 * `packages/ui/lib/ipc*` imports this file: every page, hook, story and test goes through
 * `@/lib/ipc`, which re-exports these types and spreads `transferCommands` into `ipc`. That is what keeps
 * `vi.mock("@/lib/ipc", …)` the one seam a suite replaces — a component that imported a wrapper
 * from here would go around every mock in the repository. ESLint refuses the import, and
 * `ipc.test.ts` reads this file with its siblings, so the struct-parity and argument-name fences
 * cover it as they covered the single file.
 */
import type { ImportFile } from "./collection";
import type { DeckFinish, DeckVariant } from "./decks";
import { invoke } from "./invoke";

/**
 * One line of a parsed decklist, on its way to be turned into a printing.
 *
 * **The quantity is deliberately not here.** {@link ipc.importResolve} answers *which
 * printing a name means* — the one question this side cannot answer, because it is a question
 * about 116 k rows of card data — and how many copies the line asked for is this side's
 * arithmetic all the way to {@link ImportItem}. Both hints are optional because most decklist
 * formats carry neither.
 *
 * A blank hint costs nothing: the backend trims and reads `""` or `"   "` as *absent*, which is
 * what a trailing tab in a pasted export leaves behind and would otherwise turn every line of
 * that paste into a missed hint.
 */
export interface ImportResolveLine {
  /** As the line wrote it. Case and diacritics are both survivable — the backend folds a name
   *  that no exact rule matched — and so is a double-faced card written as its front face only,
   *  which is the commonest way a decklist writes one. */
  name: string;
  /** The set code in any case: the backend lower-cases it, because 0 of the corpus's 116 695
   *  rows carry a set code in any other case while a parser that upper-cases `(MH2)` is the
   *  ordinary source of one. */
  setCode: string | null;
  /** Only ever *narrows* a set — a collector number is not unique across sets — so one arriving
   *  with no `setCode` beside it is reported as a missed hint without being tried at all. */
  collectorNumber: string | null;
  /**
   * The language the line said its copy is in, as a Scryfall code (`ja`, `de`, `zhs`) — issue
   * #555. **A preference and never a filter**: a printing in that language outranks every other
   * where the corpus holds one, and a line still resolves when it holds none (which is most of
   * the time — Scryfall's default bulk data carries a non-English printing only where there is
   * no English one). Absent or `null` is today's order. `@/lib/languages`' `languageCode` is
   * what turns a file's `Japanese` into `ja`.
   */
  lang?: string | null;
}

/**
 * The printing a decklist line resolved to, and every fact the preview and the validation engine
 * need about it.
 *
 * **The card fields are {@link DeckCard}'s less its money, deliberately**, so an imported card
 * and a card already in a deck are described by the same *judgeable* facts: a preview that
 * judged legality on a narrower set of columns than the editor would show a legal deck the
 * editor then refuses. Four differences, named here so a reader diffing the two does not have to
 * guess which are drift — `finishes` is absent (it says which finishes a printing is *sold* in,
 * which is what the editor's foil marking reads; a line's own finish rides on
 * {@link ImportItem.finish} instead, off the file's `*F*` marker), **`unitPriceUsd`/`unitPriceEur`
 * are both absent**,
 * {@link ImportMatch.gameChanger} is a plain boolean where `DeckCard`'s is nullable, and
 * `ownedQuantity`/`printingCount` are the import's own.
 *
 * **No price rides here on purpose.** This interface carried `unitPriceUsd` alone while
 * `DeckCard` still did too; the marketplace work gave `DeckCard` its euro twin and left this one
 * a currency behind, which is the drift "the card fields are `DeckCard`'s" was written to
 * prevent. It is removed rather than paired up because nothing reads it — swept 2026-08-12,
 * every `unitPriceUsd` on an `ImportMatch` was a fixture writing `null` — and because a lone
 * dollar figure is now wrong by rule: money is drawn with `formatPrice(value, currency)` off
 * `useMarketplace()`, so a DTO carrying one currency can only be used incorrectly. A field that
 * does not exist cannot drift; a preview that one day prices a line adds the pair.
 */
export interface ImportMatch {
  cardId: string;
  /** **The whole printed name**, so a double-faced card resolved from its front face comes back
   *  as `"A // B"` — what `deck_cards.name` denormalizes and what the reader is shown. A
   *  preview that echoed the line's own name would hide the one case worth checking. */
  name: string;
  setCode: string;
  collectorNumber: string;
  lang: string;
  oracleId: string | null;
  manaCost: string | null;
  cmc: number | null;
  typeLine: string | null;
  oracleText: string | null;
  /** Concatenated letters — `"WU"`, not `["W","U"]`, and not JSON. {@link DeckCard.colors}. */
  colors: string | null;
  /** The same letter form, precomputed by Scryfall — DFC backs, adventures, colour indicators
   *  and basic land types already folded in. {@link DeckCard.colorIdentity}. */
  colorIdentity: string | null;
  /** JSON: **this printing's** blob, not the oracle card's, which is what makes `oldschool`
   *  come out right with no special case. {@link DeckCard.legalities}. */
  legalities: string | null;
  /** Printed power **as text** — `"*"`, `"1+*"` and a printed `"0"` all ship in real data. Both
   *  `null` means *unknown*, never "no P/T box", and CR 903.3 turns on that difference. */
  power: string | null;
  toughness: string | null;
  layout: string | null;
  rarity: string | null;
  /** JSON: the `card_faces` array verbatim. {@link DeckCard.faces}. */
  faces: string | null;
  /**
   * On Wizards' Game Changer list.
   *
   * **A plain boolean where {@link DeckCard.gameChanger} is `boolean | null`**, and the
   * difference is real rather than a mirror slip: `cards.game_changer` is nullable and a NULL
   * means *not on the list*, so the backend flattens it here rather than handing this side a
   * third state to fence. A resolved line always names a card that exists, which is the state
   * `DeckCard`'s `null` is reserved for.
   *
   * One of **three** fields in this file with this name, and the split is two-to-one:
   * {@link CardSummary.gameChanger} is flattened for the same reason this one is — a search row
   * is a card that is there — and `DeckCard`'s is the only nullable one.
   */
  gameChanger: boolean;
  /** Printed at uncommon on **any** printing of this oracle card — what makes a Pauper Commander
   *  commander eligible. Computed; the `paupercommander` legality key answers the 99. */
  everUncommon: boolean;
  /**
   * Every copy of **this printing** the collection holds, finish-blind — and the reason this
   * printing won: a printing you own beats a newer one you do not, then the newest wins, then
   * the id (which is what makes the same list pasted twice build the same deck).
   *
   * The same question {@link CardSummary.ownedQuantity} answers, asked per decklist line rather
   * than per search row. Not {@link DeckCard.ownedQuantity}, which is a deck's *claim* — nothing
   * has been allocated at resolve time, and nothing will be until
   * {@link ipc.deckImportCommit} runs.
   */
  ownedQuantity: number;
  /**
   * **How many rows the rule that matched this line found** — not how many printings the card
   * has, which is a different number and one nothing computes.
   *
   * It is per *matching arm*, and the backend has **six**, so this field means six things:
   * through a set-and-collector-number hint it is how many printings that pair named (1, in a
   * corpus with no duplicates); through a set-scoped name, that name's printings **within that
   * set**, and through a set-scoped front face, that set's printings whose front face is the
   * name; through a bare name, that name's paper printings corpus-wide, and through a bare
   * front face, the paper printings whose front face is the name; through the fold arm, how many
   * candidates survived the fold comparison.
   *
   * So "how many printings is the reader choosing between" is only what it means on a line that
   * carried **no hint** — which is most of a pasted list, and the only case an affordance built
   * on this number may claim to be about the card. Even there it counts *paper* printings of
   * that exact name, so it is not what Scryfall would list. On a hinted line it describes the
   * hint. Stated this narrowly on purpose: a true per-name count would cost a second query per
   * line, and the arms are one indexed lookup each precisely because they do not do that.
   */
  printingCount: number;
}

/**
 * One resolved line. `matched` is `null` for a name no printing bears — **not an error**: the
 * preview quotes it and the import proceeds without it.
 *
 * `hintMissed` says the line carried a `(SET) 123` this app has no printing for, and that the
 * name rule answered instead. Both can be true at once: a missed hint whose name also matched
 * nothing comes back `matched: null, hintMissed: true`.
 */
export interface ImportResolveRow {
  /** **The caller's index**, not a row number — the list that was sent is the only thing that
   *  knows what line 34 said. The two are the same today, and a filter between them would make
   *  them differ silently, which is why it rides along rather than being inferred. */
  index: number;
  matched: ImportMatch | null;
  /** *Some part of what the reader wrote about the printing was not used.* So a collector number
   *  that named nothing sets it even when the set and name then answer, and a collector number
   *  with no set beside it sets it without being tried. Never a reason to lose the card. */
  hintMissed: boolean;
}

/**
 * What an import does to the variant it lands in.
 *
 * `merge` folds onto the deck-card grain — the same printing in the same category becomes one
 * row with the sum, so a list naming a card on two lines lands as one row. `replace` clears
 * that variant's **cards** first and leaves its **categories**: a category is the reader's
 * filing, not the list's, and a replace that swept them would delete piles somebody named,
 * reordered and switched off to import a file that mentions none of that.
 *
 * It clears **one variant**. Replacing the plan never touches what is sleeved up, and the other
 * way round — the reason `variant` is part of the grain at all.
 *
 * Spelled out here rather than derived from anything: the backend validates against its own
 * list and quotes it back in the refusal, so a third mode is a Rust change first.
 */
export type ImportMode = "merge" | "replace";

/**
 * One line of a decklist after this side has decided everything a *deck* decision is.
 *
 * The first three fields are the three answers the backend cannot compute for itself: which
 * printing (resolved by {@link ipc.importResolve}, and perhaps overridden in the preview),
 * how many, and which pile.
 */
export interface ImportItem {
  cardId: string;
  /** Copies, and it must be **positive**. Zero is refused rather than read as a removal — and it
   *  is refused for the whole import, because one line that cannot land rolls the transaction
   *  back. */
  quantity: number;
  /**
   * The line's `*F*` / `*E*` marker, as {@link DeckFinish} — `null` where it carried neither.
   *
   * Part of the grain, so a list naming the same printing foil on one line and plain on another
   * lands as **two rows** rather than one summed. `parse.ts` reads the marker, `plan.ts` carries
   * it here, and nothing in between makes a decision about it: a finish is a fact about the
   * line, not a filing decision.
   *
   * **Optional, exactly as {@link ImportItem.inactive} is and for its reason.** Rust takes it
   * `#[serde(default)]`, and an absent field means the regular copy — which is what an import
   * has always made. It is the same call `useDeck.addCard`'s optional `finish` makes and the
   * opposite of the one `Slot` makes: this creates a row, where a default is the honest answer,
   * rather than addressing one, where a default steps the wrong card.
   */
  finish?: DeckFinish;
  /**
   * **A name, not an id**, which is the one place this command's shape differs from
   * {@link ipc.deckAddCard}'s id arm and the difference is deliberate: an imported list names
   * sections the deck may not have yet, and the word itself is `autoCategoryFor`'s to compute,
   * because which pile a Sol Ring belongs in is domain logic.
   *
   * Found-or-created, matched **by name alone**, so a `Sideboard` section lands on the deck's
   * seeded `side` category rather than making a second pile with the same word on it. Trimmed
   * before it is keyed, so `Ramp` and `  Ramp  ` are one pile and count as one creation.
   */
  categoryName: string;
  /**
   * The file said this pile counts toward nothing — Archidekt's `{noDeck}`, which is this app's
   * `is_active = 0`.
   *
   * **Applied only to a pile the import creates.** A name the reader already has keeps whatever
   * they set; an import must not reach into filing somebody did by hand.
   *
   * Optional because absent has always meant "an ordinary, counted pile" and the backend reads it
   * that way (`#[serde(default)]`) — so every caller written before Archidekt's maybeboard existed
   * is unchanged, the Storybook fake's literals included.
   */
  inactive?: boolean;
  /**
   * The label to put on this card — Archidekt's `^Keeper,#4aab08^`, name half.
   *
   * **A name, not an id**, for {@link ImportItem.categoryName}'s reason exactly: an imported list
   * names labels the app may not have yet. Found-or-created by `schema::label_name_key`, which is
   * `deck_labels.name_key`'s own grain — so `keeper` and `Keeper` are one row and the reader's
   * capitals win, because the row that is already there is not renamed.
   *
   * **Absent is "say nothing about this card's label"**, and that is load-bearing rather than an
   * encoding detail. It is what an unticked label sends, and it is what makes a `merge` onto a
   * card the reader already labelled by hand keep their label: the write is
   * `label_id = coalesce(deck_cards.label_id, excluded.label_id)`, so a row that has one keeps it
   * and a row that has none takes the file's.
   */
  labelName?: string;
  /**
   * That label's colour, `#rrggbb`. Ignored unless the import has to **make** the row.
   *
   * A name the app already knows keeps the colour the reader gave it — {@link ImportItem.inactive}'s
   * rule over a different table, and for the same reason: an import must not reach into a
   * decision somebody made by hand. `deck_labels.color` has held hex rather than a palette token
   * since 2026-08-20 (`features/decks/labelColors.ts`), which is what lets Archidekt's own colour
   * be stored verbatim instead of snapped to a palette of six.
   *
   * Required by the backend whenever {@link ImportItem.labelName} is present, since
   * `deck_labels.color` is `NOT NULL` and `valid_color` refuses a blank. `toImportItems` sends
   * the two together or neither.
   */
  labelColor?: string;
}

/**
 * What an import did, in the three numbers the "Imported 117 cards" report is written from.
 *
 * `added` and `removed` are **copies, not rows** — a reader counts cards — and `added` is what
 * the list asked for rather than what the deck landed on, so a merge that folded 3 onto an
 * existing 2 reports 3 and the row now holds 5.
 */
export interface ImportOutcome {
  added: number;
  /** Copies cleared before the list went in. Always `0` on a `merge`; `0` on a `replace` over an
   *  empty variant too, which is also when no `remove` row is written to the history. */
  removed: number;
  /** The piles the import had to make — the part of the outcome a reader could not have
   *  predicted from the file. A section name their deck already had costs nothing. */
  categoriesCreated: number;
  /**
   * The labels the import had to make — {@link ImportOutcome.categoriesCreated}'s question over
   * `deck_labels`, and a number the reader is owed for a sharper reason than that one: a label is
   * **app-wide**, so an import that invents three of them has changed a list every other deck of
   * theirs reads from.
   *
   * A name they already had costs nothing and is not counted, which is the same sentence the
   * picker on the import step prints before the press.
   */
  labelsCreated: number;
}

/** The transfer commands — spread into `ipc` by `../ipc.ts`, which is the only reader of this object. */
export const transferCommands = {
  /**
   * Every name in a decklist, resolved to a printing this app has. **Read-only**, and one call
   * for the whole list rather than one per line — ~100 names is six prepared statements and a
   * few hundred index lookups (11.6 ms for a 105-line commander list, measured over the live
   * corpus), where a call per line would be a hundred IPC hops for the same work.
   *
   * **A name no printing bears is a row, never a rejection**: 99 good lines must not be lost to
   * one bad one, so `matched: null` is the ordinary answer for a typo and the preview quotes it.
   * The rows come back in the order the lines went out and carry
   * {@link ImportResolveRow.index} besides.
   */
  importResolve: (lines: ImportResolveLine[]) =>
    invoke<ImportResolveRow[]>("import_resolve", { lines }),
  /**
   * A whole decklist into one deck: one transaction, one allocation, one or two history rows.
   *
   * **This command exists for the allocator.** Looping {@link ipc.deckAddCard} would be correct
   * in every other respect and would rebuild the deck's claims once per line — a hundred
   * delete-and-rebuild passes for one import. Here it runs once, at the end, over the finished
   * deck.
   *
   * All-or-nothing: a line naming a printing the card database has not got refuses the import
   * and leaves the deck — including the one a `replace` was about to clear — exactly as it was,
   * with no history row and no half-made category behind it. An empty `items` is refused in
   * words, and a `replace` most of all: it would clear the deck and put nothing back.
   *
   * The history it writes is **one row per effect, never one per card** — an import of 117 cards
   * would otherwise bury every other event of that day in the drawer.
   */
  deckImportCommit: (deckId: number, variant: DeckVariant, mode: ImportMode, items: ImportItem[]) =>
    invoke<ImportOutcome>("deck_import_commit", { deckId, variant, mode, items }),
  /**
   * Let the reader choose a decklist file, and answer its text — or `null` for Cancel, which is
   * not a failure.
   *
   * **Takes no path, and that is the contract** (issue #545). Rust opens the OS dialog, modal to
   * the calling window, and reads what it answered, so the path never reaches this side and
   * nothing here can name one. It used to be `import_read_file(path)`, taking the path the
   * plugin's `open()` answered — which any script in the page could call with any path at all.
   * The webview is granted no `dialog:` and no `fs:` permission.
   *
   * **Two failures, and the rejection says which**: the file picker could not be opened, or the
   * file would not read (missing, refused, over 8 MB). Frame it with words true of both.
   *
   * **Never refused for its bytes** (issue #555): valid UTF-8 is read as such, a UTF-16
   * byte-order mark is honoured, and anything else is decoded as Windows-1252 — Excel's CSV on a
   * Western European Windows — rather than lossily, which used to turn every `é` in a cp1252 file
   * into `U+FFFD`. {@link ImportFile.encoding} says which, so the dialog can say so. Parsing the
   * text is this side's, exactly as it is for a paste.
   */
  importPickFile: () => invoke<ImportFile | null>("import_pick_file"),

  /**
   * Ask the reader where to save `contents` — the OS save dialog, opened with `fileName` — and
   * write it there. Resolves `true` when a file was written and `false` for Cancel, which is not
   * a failure.
   *
   * **`fileName` is a suggestion and never a place** (issue #545): Rust keeps only its last
   * component, opens the dialog itself and writes at the path it answered, so no path crosses
   * IPC in either direction. It used to be `export_write_file(path, contents)` — a write
   * anywhere, for any script in the page. The rejection is either the save dialog's or the
   * disk's, and says which.
   */
  exportSaveFile: (fileName: string, contents: string) =>
    invoke<boolean>("export_save_file", { fileName, contents }),
};
