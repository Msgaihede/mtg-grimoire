/**
 * Commander Spellbook combos: the feed, a deck's combos and a card's, and their counts.
 *
 * **One domain of `../ipc.ts`, split out on 2026-10-11 (issue #557).** Nothing outside
 * `packages/ui/lib/ipc*` imports this file: every page, hook, story and test goes through
 * `@/lib/ipc`, which re-exports these types and spreads `comboCommands` into `ipc`. That is what keeps
 * `vi.mock("@/lib/ipc", …)` the one seam a suite replaces — a component that imported a wrapper
 * from here would go around every mock in the repository. ESLint refuses the import, and
 * `ipc.test.ts` reads this file with its siblings, so the struct-parity and argument-name fences
 * cover it as they covered the single file.
 */
import { core } from "@/lib/core";
import { invoke, type Unlisten } from "./invoke";

/**
 * Which bracket a two-card infinite combo belongs to, as **Commander Spellbook's own editors
 * classified it** — `BracketTagEnum` in their schema, carried through the ingest unchanged and
 * stored in `combos.bracket_tag`.
 *
 * Seven letters, with Spellbook's own wording for each and the bracket floor it implies here:
 *
 * * `E` — **Exhibition**, "for any deck". Raises nothing.
 * * `C` — **Core**, "for unoptimized decks in bracket 2+". Floor 2.
 * * `O` — **Oddball**, "probably 2 or 3, but hard to classify". Floor 2.
 * * `P` — **Powerful**, "for strong decks in bracket 3+". Floor 3.
 * * `S` — **Spicy**, "probably 3 or 4, but hard to classify". Floor 3.
 * * `R` — **Ruthless**, "for competitive decks at brackets 4+". Floor 4.
 * * `B` — **Banned**, "not legal in Commander". Raises nothing, because it is a *legality*
 *   finding and the validation engine already reports it from the banned list.
 *
 * **That letter is why this app never has to decide what "an intentional early-game two-card
 * infinite combo" is.** Wizards' bracket table restricts combos in exactly those words, which no
 * card list answers and no oracle-text grep can be written for — it is a fact about an
 * *interaction* rather than about a card. Spellbook's editors have already made the judgement
 * per combo; the ingest carries their letter through and the estimator turns it into a floor.
 *
 * A closed union, like {@link ErrorSource}: an eighth letter arriving from Rust is a type error
 * here rather than a combo that silently raises nothing.
 */
export type ComboBracketTag = "R" | "S" | "P" | "O" | "C" | "E" | "B";

/**
 * One combo a deck contains — every named card of it is in the deck, and this is what the
 * bracket advisory lists.
 *
 * "Contains" is the whole of what the match query answers, and it is deliberately narrow: the
 * cards are all there, in the piles TypeScript chose to count (see {@link ipc.combosForCards}).
 * Nothing here checks that they can be *cast* together, that the colours line up, or that a piece
 * the feed marks `must_be_commander` really is this deck's commander — that column is stored by
 * the ingest and surfaced on no field of this shape, so nothing reads it.
 */
export interface DeckCombo {
  /** Commander Spellbook's variant id, e.g. `"1957-4050-7918--204"`. Stable, and the key the
   *  ingest stores rows under. */
  id: string;
  /** Which bracket this combo is for — {@link ComboBracketTag}, and the whole of what it
   *  contributes to the estimate. */
  bracketTag: ComboBracketTag;
  /**
   * The combo's card names, in the order the feed listed them — display only. The deck holds
   * every one of them, matched by **oracle** id rather than by this string, so a name here is
   * what to print beside the combo and never what to look a card up by.
   */
  cards: string[];
  /**
   * How many *templates* the combo also asks for — Spellbook's `requires[]`, which are
   * descriptions ("a creature with flying") rather than cards and resolve to no card id at all.
   *
   * **`0` is a combo the deck definitely has.** Above zero is one whose named cards are all
   * present and whose remaining requirement this app cannot check, so it is shown as *possible*
   * and kept out of the bracket arithmetic entirely — a combo that might not be there may not
   * raise a floor, and hiding it would be worse still, since the reader can look at their own
   * deck and answer the question this app cannot.
   */
  templateCount: number;
  /** What the combo does — Spellbook's feature names, one per line (`"Infinite lifegain"`).
   *  Joined at the ingest rather than sent as an array, because nothing here does anything to
   *  them but print them. */
  produces: string;
  /** How many decks Spellbook has seen it in, or `null` where the feed gives no figure. A
   *  sort key and a rough "how well known is this", nothing more. */
  popularity: number | null;
}

/**
 * One named card a combo asks for, and whether the reader holds it — a row of the card-side
 * read, {@link CardCombosPage}.
 *
 * **{@link DeckCombo} carries `cards: string[]` for the same idea and that is not an oversight
 * on either side.** The deck advisory has already established that every named card is in the
 * deck, so a name is the whole of what it has left to print. This read establishes nothing of
 * the sort: it answers every combo that *names* the open card, most of which the reader owns no
 * other piece of, so each piece has to say what it is, what it looks like and whether it is in
 * the binder. Widening the deck's shape to this one would put six fields and a picture URL on
 * every combo of every deck in the gallery to draw a list of names.
 */
export interface ComboPiece {
  /**
   * The piece's **oracle** id — what a combo is really about, and the id everything in this feed
   * is matched by ({@link ipc.combosForCards} states the same rule from the deck's end).
   *
   * All four Lightning Bolts are one piece here, which is why `owned` below can be a sum across
   * printings without anything having to decide which printing was meant.
   */
  oracleId: string;
  /**
   * The card's name **as the feed spells it**, and the one field that survives a card this
   * database has never heard of.
   *
   * Spellbook's corpus and the reader's `cards` table are two downloads on two schedules, so a
   * combo can name a card a stale corpus does not carry — a new set's card in a combo published
   * the week it was spoiled. That piece has `cardId: null`, no picture and `owned: 0`, and this
   * string is the whole of what the row can draw. **Never look a card up by it**: the name is
   * for the eye and the oracle id is the address.
   */
  name: string;
  /** How many copies the combo asks for. `1` for almost every piece; above one is a combo that
   *  really does want two of a card, and drawing it as `1` would be a lie about what to buy. */
  quantity: number;
  /**
   * The combo wants this piece **in the command zone**, not merely in the ninety-nine —
   * Spellbook's `must_be_commander`.
   *
   * The ingest has stored this column since the feed first landed and no shape carried it until
   * now; {@link DeckCombo}'s own doc says so, and this is the field that ends that sentence.
   * **It is display only.** Nothing here checks that the piece really is the reader's commander,
   * because this read has no deck in front of it at all — it answers about a card.
   */
  mustBeCommander: boolean;
  /**
   * A printing to address the piece by — the default one — or `null` when the corpus has never
   * synced the card.
   *
   * This is what a press opens and what a picture is fetched for, so `null` is the row that can
   * be read and not clicked. It is a *printing* id where {@link ComboPiece.oracleId} is the
   * card, and the two must not be swapped: a printing id in an oracle position matches nothing
   * and produces an empty answer rather than an error.
   */
  cardId: string | null;
  /**
   * How many copies of this card the reader owns, **across every printing and every finish** —
   * the sum the oracle key above makes possible.
   *
   * **`0` is an answer and not a blank.** A combo listing three pieces the reader owns none of
   * is exactly what this read exists to show, so a row rendering `0` as an em dash would hide
   * the ordinary case. It is also what `ownedOnly` filters on, and the filter is applied in SQL
   * — see {@link CardCombosQuery.ownedOnly} for why that matters to the caller.
   */
  owned: number;
}

/**
 * One combo that **names** the open card — the card-side read, and the opposite question to
 * {@link ipc.combosForCards}.
 *
 * That one asks *which of these combos does a pile of cards fully contain*; this one asks *what
 * is this card part of*, and makes no claim whatever about the other pieces. A reader looking at
 * Thassa's Oracle wants the second question answered, and the first would answer `[]` for every
 * card they own two thirds of a combo for.
 *
 * **So every field the deck advisory did not need is here**, because the deck's list is read
 * beside the deck itself and this one is read beside a single card with nothing around it: the
 * steps, the prerequisites, the mana, and one {@link ComboPiece} per named card.
 */
export interface CardCombo {
  /** Commander Spellbook's variant id, e.g. `"1957-4050-7918--204"` — {@link DeckCombo.id}, the
   *  same string and the same rows. */
  id: string;
  /**
   * Which bracket the combo is for — {@link ComboBracketTag}.
   *
   * **A closed union, and this is that argument's second reader.** An eighth letter arriving
   * from Spellbook is a Rust-side *skip* (the ingest drops the combo) rather than an
   * `undefined` reaching a total label map on this side, which is what a widened union would
   * cost: every map over the seven letters would have to grow a "some letter we do not know"
   * arm, on a screen whose whole job is to say what a combo is for. See {@link ComboBracketTag}.
   */
  bracketTag: ComboBracketTag;
  /**
   * How many **named cards** the combo asks for — the length of {@link CardCombo.pieces}, sent
   * rather than derived because it is also the filter key and the bucket key.
   *
   * A reader narrowing to two-card combos is asking about this number, and
   * {@link CardCombosPage.byCardCount} is a census of it over the **searched** set — the set
   * {@link CardCombosQuery.search} leaves standing, before this filter and `ownedOnly` are
   * applied. Neither of which the page in hand could answer, because the page is a slice.
   */
  cardCount: number;
  /**
   * How many *templates* the combo also asks for — Spellbook's `requires[]`, descriptions
   * ("a creature with flying") that resolve to no card id at all. `0` is a combo whose every
   * requirement is a named card.
   *
   * {@link DeckCombo.templateCount}'s rule is a *deck* rule — above zero keeps the combo out of
   * the bracket arithmetic, because a combo that might not be there may not raise a floor — and
   * it does not follow here. Nothing on this screen is estimating anything; a template is one
   * more thing the combo needs, said in words, and the honest drawing is to say so.
   */
  templateCount: number;
  /** The combo's colour identity as the feed publishes it — WUBRG letters, `""` for colourless.
   *  A string rather than an array because nothing here does anything to it but draw pips. */
  identity: string;
  /** What the combo does — Spellbook's feature names, one per line (`"Infinite lifegain"`).
   *  {@link DeckCombo.produces}, joined at the ingest for its reason: nothing on either side
   *  does anything to them but print them. */
  produces: string;
  /** The numbered steps, `"\n"`-separated — how the combo is actually executed. `""` when the
   *  feed carries none, which is a real state for a combo whose editors have not written one up
   *  yet, and not a reason to hide the row. */
  description: string;
  /** Set-up the combo assumes and Spellbook considers trivial ("all permanents are untapped").
   *  `""` when there are none. */
  easyPrerequisites: string;
  /** Set-up the combo assumes and Spellbook considers worth stating ("Frodo is your commander").
   *  `""` when there are none. This is the pair's *interesting* half and the one worth drawing
   *  first where only one fits. */
  notablePrerequisites: string;
  /** What it costs to go off, in mana symbols (`"{6}"`). `""` when the feed names no cost, which
   *  is not the same as free — it is the feed saying nothing. */
  manaNeeded: string;
  /** How many decks Spellbook has seen it in, or `null` where the feed gives no figure —
   *  {@link DeckCombo.popularity}, and the sort this list arrives in. */
  popularity: number | null;
  /**
   * Every named card of the combo, **in the feed's order** — including the card being read
   * about, which is deliberately not filtered out: a combo is a list of pieces and one of them
   * being the open card is a fact about where it sits in the list, not a row to delete.
   *
   * The order is the feed's because Spellbook's editors write the steps against it, so
   * resorting the pieces (by owned, by name) would leave {@link CardCombo.description}
   * referring to a sequence the reader is no longer looking at.
   */
  pieces: ComboPiece[];
}

/**
 * How many combos name this card at each combo size — one bar of the size census.
 *
 * **Computed over the *searched* set**, so the numbers hold still while the reader picks a size
 * or turns the owned box on, and move the moment they type. A text search changes the *subject*
 * — "only combos with Thassa in them" — and a size is a **facet** of whatever subject is in
 * force; see {@link CardCombosPage.byCardCount} for the whole argument.
 */
export interface ComboCountBucket {
  /** The combo size — {@link CardCombo.cardCount}, and the value to pass back as
   *  {@link CardCombosQuery.cardCount} to narrow to it. */
  cards: number;
  /** How many combos of that size name this card. Never `0`: a size nothing matches has no
   *  bucket at all, which is what makes the list drawable as it stands. */
  combos: number;
}

/**
 * One page of the combos that name a card, plus the three totals a caption needs.
 *
 * **Three counts rather than one, because the page cannot answer any of them.** `combos` below
 * is a slice — up to `limit` rows — so a caption counting it would say "20 combos" for a card
 * with six hundred, and a filter chip counting it would say the same thing twice.
 *
 * **The three are taken over three different sets, and that is the shape rather than an
 * inconsistency** (2026-09-08, when {@link CardCombosQuery.search} landed). A text search is the
 * reader changing **the subject** — *only combos with Thassa in them* — where the size chips and
 * the owned toggle are **facets of that subject**. A facet's count has to predict what pressing
 * it yields, so `byCardCount` and `ownedTotal` are censuses of the **searched** set: otherwise
 * every chip is a lie the moment somebody types, offering a size the searched list does not
 * contain and an owned count drawn from combos the search has already excluded. `total` stays the
 * card's own census, because it answers a question the search does not change — *how many combos
 * is this card in* — and it is what the heading is about and what `ownedTotal` used to be a share
 * of. Nothing about `matching` moved: it was always the whole filter stack, and the stack grew a
 * rung.
 *
 * The shape did not change with any of that. **`total` and `matching` mean exactly what they
 * meant and `byCardCount` and `ownedTotal` do not**, which is the drift a type cannot catch — a
 * caller that goes on treating `ownedTotal` as a share of `total` compiles, draws a number that
 * is never out of range, and is quietly wrong in one direction: the searched set is a *subset* of
 * `total`, so the fraction can only ever read **too low**, and it reads lowest exactly when the
 * search has done the most work. A ratio that overflowed would at least be visible.
 */
export interface CardCombosPage {
  /**
   * Combos naming this card with **no filter applied at all** — including no search. The number
   * the screen's heading is about.
   *
   * **It is no longer the denominator {@link CardCombosPage.ownedTotal} is a share of**, which
   * this line said until the search landed: that count is over the searched set now, so
   * `ownedTotal / total` is a fraction of two different questions. It cannot go out of range —
   * the searched set is a subset of this one — which is precisely what makes it a bad way to be
   * wrong: it simply reads low, and lowest on the searches that narrowed the most.
   */
  total: number;
  /** Combos matching after **every** filter — {@link CardCombosQuery.search},
   *  {@link CardCombosQuery.cardCount} *and* `ownedOnly`. This is what the pager pages through,
   *  so it is the one to compare `offset` against and never {@link CardCombosPage.total}. */
  matching: number;
  /**
   * How many of the **searched** combos the reader owns **every piece** of — the `ownedOnly`
   * filter's own count, answered whether or not that filter is on, so the checkbox can say what
   * pressing it would leave.
   *
   * **A share of the searched set and not of {@link CardCombosPage.total}** — changed with the
   * search box, and it is the toggle's own promise: a checkbox saying *42* over a searched list
   * of nine would be predicting something the press cannot produce. With no search term the two
   * sets are the same one, which is why an unsearched screen reads exactly as it did before.
   */
  ownedTotal: number;
  /**
   * The size census — one {@link ComboCountBucket} per combo size that matches at all, ascending
   * by `cards`.
   *
   * **Over the searched set, and over nothing narrower.** A census recomputed under the *whole*
   * filter stack would zero every bucket but the selected one the moment a reader picked a size,
   * leaving them no way back and no way to see that the card has forty three-card combos as well:
   * it is a menu of what is available, not a description of what is shown. The search is the one
   * narrowing that belongs in it, because it is not a facet of the same question but a different
   * question to take facets of — a chip reading *2 (12)* under a search that leaves no two-card
   * combo at all is a control that answers `[]`.
   */
  byCardCount: ComboCountBucket[];
  /** This page — at most {@link CardCombosQuery.limit} rows, starting at
   *  {@link CardCombosQuery.offset}, in the order the backend sorts them. */
  combos: CardCombo[];
}

/**
 * The six arguments {@link ipc.combosForCard} takes, bundled.
 *
 * **Not a mirror of anything.** `combos_for_card` declares six flat parameters, so this object
 * exists on this side alone — it is what the wrapper spreads and what a query key is built from,
 * so the call site and `cardCombosKey` cannot disagree about what was asked. The header's list
 * of mirrored structs deliberately does not name it, and `ipc.test.ts`'s field-parity table
 * cannot either: there is no Rust struct to compare it with.
 *
 * **The fields are declared in the command's own parameter order** — `oracleId`, `search`,
 * `cardCount`, `ownedOnly`, `limit`, `offset` — and `cardCombosKey` takes its first four in the
 * same order for the same reason: three files describe one call, and an order that agrees is the
 * cheapest way for a reader to check they are all talking about the same thing.
 */
export interface CardCombosQuery {
  /** Which card — the **oracle** id, never a printing id. {@link ComboPiece.oracleId}'s rule,
   *  and the reason `cardCombosKey` keys on it: a combo is a fact about a card, so stepping
   *  between two printings of it must not miss the cache. */
  oracleId: string;
  /**
   * A case-insensitive substring matched against **any piece's name** in the combo — the
   * asked-about card's own included — or `null` for no search.
   *
   * `Option<String>` on the Rust side, and **`null` and `""` are the same request**: the empty
   * string is what a cleared search box produces, and a backend that treated it as a substring
   * would match everything anyway. That equivalence is why this field travels verbatim — the
   * wrapper below sends whatever it is handed, and `""` is folded into `null` by `cardCombosKey`
   * in `lib/query.ts`, where the difference is the only thing it can cost: two cache entries for
   * one question. **Do not fold it a second time in the wrapper** — that would be the same rule
   * written twice, and both copies would look right. A *caller* normalising further is a
   * different matter and is allowed: `CombosDialog` trims, which decides what gets sent rather
   * than what gets filed, and it does so before the key is built.
   *
   * It matches **names and nothing else** — not the steps, not the produced results, not the
   * prerequisites. A reader narrowing 6 044 combos is naming a card they want in them, and a
   * search that also hit `description` would answer with combos that merely *mention* a word.
   *
   * **It narrows in SQL, before the page is cut**, like the two filters below, and it moves two
   * of the answer's counts with it — {@link CardCombosPage.byCardCount} and
   * {@link CardCombosPage.ownedTotal} are censuses of the set this leaves standing. See
   * {@link CardCombosPage} for why the facets follow the subject.
   */
  search: string | null;
  /**
   * An exact combo size, or `null` for every size — the value comes from a
   * {@link ComboCountBucket}, so it is always a size that matched something *when the census was
   * taken*. **Since the census is over the searched set, a size held across a change to
   * `search` can name a bucket that no longer exists**, and the answer is an empty page rather
   * than an error; whether the reader keeps the chip or loses it is the surface's decision, not
   * this shape's.
   *
   * `Option<i64>` on the Rust side, and `null` is how `None` is spelled on the wire: the key
   * has to travel even when there is no filter, because Tauri fills parameters by name and an
   * absent one is a rejection rather than a default. `ipc.test.ts` pins exactly that, for this
   * field and for {@link CardCombosQuery.search} beside it.
   */
  cardCount: number | null;
  /**
   * Only combos the reader owns every piece of.
   *
   * **Narrowed in SQL, before the page is cut** — which is what makes it a filter and not
   * something a caller could do to the rows it already has. See `cardCombosKey` in
   * `lib/query.ts` for what a client-side version of this would show a reader.
   *
   * Its own count, {@link CardCombosPage.ownedTotal}, is taken over the searched set — so the
   * number the checkbox advertises is what pressing it would leave *given what is on screen*.
   */
  ownedOnly: boolean;
  /** Page size. */
  limit: number;
  /** Rows to skip — compared against {@link CardCombosPage.matching}, never `total`. */
  offset: number;
}

/**
 * The combo table's own freshness — `combo_meta`, plus the shape of a database that has never
 * fetched the file.
 *
 * The **fourth** optional bulk feed, after the two price feeds and the two tagger datasets — and
 * optional the way the *tagger* pair is rather than the way the price feeds are: a launch fetches
 * it uninvited and keeps it current, a failed fetch leaves the previous rows standing, and a
 * database that never got it works, on three bracket signals instead of four. **That changed on
 * 2026-09-08**, and the sentence it replaces is worth carrying because so much prose was written
 * on it: until then nothing downloaded until a reader pressed Refresh in a Settings panel, which
 * made "never fetched" the state every install *stayed* in rather than one it passes through.
 * The panel is gone and so is the wait. It is not Scryfall — Commander
 * Spellbook's `variants.json.gz`, 27.5 MB compressed, measured 2026-08-27 — so it takes no share
 * of the Scryfall rate-limit budget and has no place in the 429 penalty state.
 */
export interface ComboStatus {
  /** Rows in `combos` — combos kept, which is the published, Commander-legal subset. `0` before
   *  the first ingest. */
  combos: number;
  /**
   * **Distinct cards** across every kept combo — `count(DISTINCT oracle_id)` over `combo_cards`,
   * not that table's row count.
   *
   * A card that appears in three combos is one card here, which is what makes the figure
   * legible beside {@link ComboStatus.combos}: "105 478 combos, naming 7 310 cards between
   * them" is a sentence about the corpus, where a slot count would just be a bigger number with
   * no meaning of its own. Counted from the table rather than read off `combo_meta`, because a
   * watermark can outlive the rows it describes.
   */
  cards: number;
  /** The feed's own `timestamp`, as it published it (`"2026-08-27T03:12:44Z"`). `null` before the
   *  first ingest. The file rotates continuously, so this is the honest as-of line — not
   *  {@link ComboStatus.fetchedAt}, which is when *this app* asked. */
  stamp: string | null;
  /**
   * Unix **seconds** when the rows last changed, and **`null` on a database that has never
   * ingested the file**.
   *
   * That distinction is the whole reason this is nullable rather than `0`: never ingested is a
   * **supported state**, not a failure. It is what an install is until its first launch fetch
   * lands, what a machine that cannot reach Spellbook stays in, and what
   * {@link ipc.combosClear} puts a database back into on purpose — and what it costs is one
   * signal: the bracket estimate then reads three (Game Changers, mass land denial, extra turns)
   * instead of four. Nothing about it may empty a deck's advisory or fail a check.
   *
   * It is the pair {@link TagStatus} already draws, for its reason: a 304 moves
   * {@link ComboStatus.checkedAt} and not this, so collapsing the two would make an up-to-date
   * table read as due on every launch and cost a request per start.
   */
  fetchedAt: number | null;
  /** Unix **seconds** when the feed was last *asked*, whatever the answer. Moves on a 304;
   *  `fetchedAt` does not. `null` before the first check. */
  checkedAt: number | null;
  /**
   * Older than the backend's weekly refresh interval, **or never fetched at all**.
   *
   * Computed there and read rather than re-derived, {@link MarketplaceFeedStatus.stale}'s rule:
   * one definition of how long the table stays believable, and a second copy of the arithmetic on
   * this side would be a second place for it to drift.
   */
  stale: boolean;
}

/** The five phases a combo refresh emits — {@link TagPhase}'s list, because the shape of the job
 *  is the same one: ask, download, ingest, and two ways to stop. */
export type ComboPhase = "checking" | "downloading" | "ingesting" | "done" | "error";

/**
 * Payload of the `combos:progress` event.
 *
 * A channel of its own rather than a phase bolted onto something else, following
 * `marketplace:progress` and the two tag channels for their reason: {@link SyncPhase} is a closed
 * union with a *total* label map behind it, and a dataset with its own schedule has no business
 * widening it.
 *
 * **Not a complete account of a refresh**, like every other progress event here: Tauri drops
 * events emitted before the webview registered its listener, so a refresh that began before this
 * window mounted a listener is invisible on this channel. {@link ipc.combosStatus} is the
 * reliable half of the pair.
 *
 * `done`/`total` are read **against the phase and never across it** — bytes while downloading,
 * variants while ingesting — so a bar that carried one scale from `downloading` into `ingesting`
 * would jump. Two counts of two different things, on one pair of fields, exactly as
 * {@link FeedProgressEvent} and {@link TagProgressEvent} already carry.
 */
export interface ComboProgress {
  phase: ComboPhase;
  done: number;
  total: number;
}

/** The combos commands — spread into `ipc` by `../ipc.ts`, which is the only reader of this object. */
export const comboCommands = {
  /**
   * The combo table's freshness. Reads one small table, makes no network call, and **is safe
   * before the first refresh has ever run** — a database with no `combo_meta` row answers zero
   * counts and `null` stamps with `stale: true` rather than rejecting, so no caller needs a
   * guard.
   *
   * Read it before drawing "this deck has no combos": a never-ingested table and a deck with
   * nothing in it are the same empty {@link ipc.combosForCards} answer, and only this call tells
   * them apart. See {@link ComboStatus.fetchedAt}.
   */
  combosStatus: () => invoke<ComboStatus>("combos_status"),
  /**
   * Fetch Commander Spellbook's combo feed if it is due, and answer the table's state
   * afterwards. `force` skips the weekly throttle, **not** the ETag check — a forced refresh of
   * an unchanged file still costs one request and no ingest, exactly as the Tagger refreshes
   * (`oracle_tags_refresh`, `art_tags_refresh`) do one dataset over.
   *
   * 27.5 MB compressed and 640 MB of JSON behind it (measured 2026-08-27), streamed rather than
   * held, so it reports through the same `Activity` mechanism every other long job uses.
   *
   * **It does not answer `collection::BUSY` under a running sync**, and the asymmetry with the
   * writes above it is deliberate rather than an oversight: a refresh opens on the *read*
   * connection and only its ingest takes the write one, one 2 000-combo batch at a time,
   * standing aside between them. So a sync delays this rather than refusing it — which is what
   * a 640 MB download wants, since a refusal would throw the whole fetch away over a lock it
   * would have got a second later.
   *
   * **A failed fetch leaves the previous rows standing** and writes the reason to `error_log` —
   * the rule every feed here follows. A rejection is never a reason to stop drawing a bracket:
   * the estimate reads the three signals it has and says so.
   */
  combosRefresh: (force: boolean) => invoke<ComboStatus>("combos_refresh", { force }),
  /**
   * Throw the combo table away — every row of `combos` and `combo_cards`, and the `combo_meta`
   * watermark behind them. It answers the {@link ComboStatus} a database that has never ingested
   * the feed already gives: two zeros, three `null`s and `stale: true`.
   *
   * **A debugging affordance, and not something the ordinary reader needs.** The list arrives on
   * its own at launch and refreshes itself on the week, so there is no ordinary press this
   * stands behind — what it is for is putting a machine back in the never-fetched state, which
   * is a state worth being able to look at and one no reader can otherwise produce.
   *
   * **The caller is expected to follow it with `combosRefresh(true)`**, and the two really do
   * fetch the body rather than earning a 304 — which is the half worth stating here, because
   * nothing about this call makes it true. The stored ETag describes a *file* and not the state
   * of this database, so `combos::conditional_etag` replays it **only when there are rows behind
   * it**: a cleared table sends no `If-None-Match` and gets 27.5 MB. Without that rule the pair
   * would empty the tables, be told nothing had changed, and leave a database that no amount of
   * refreshing could ever fill again.
   *
   * **It makes no network call at all**, which is the whole difference from
   * {@link ipc.combosRefresh} above it: that one opens on the read connection and only its
   * ingest takes the write one, so a sync delays it, where this is a write from its first
   * statement to its last.
   */
  combosClear: () => invoke<ComboStatus>("combos_clear"),
  /**
   * Which combos a set of cards fully contains — the deck bracket advisory's one read.
   *
   * **It takes card ids rather than a deck id, and that is the Rust/TS boundary drawn where this
   * repo draws it.** Which of a deck's piles count toward a combo is a *domain* question — active
   * categories only, the sideboard and the companion beside the deck rather than in it, `live`
   * against `theory` — and those rules already live in TypeScript, in `features/decks`. So this
   * side decides which cards are in play and Rust answers a fact about them: it resolves the ids
   * to oracle ids and returns the combos whose every named card is present. Rust supplies facts;
   * TypeScript draws the conclusion, and a `combos_for_deck` would have moved the pile rules into
   * SQL where a second copy of them would drift.
   *
   * Matching is by **oracle** id, so any printing of a combo piece counts and duplicate ids cost
   * nothing. Combos with {@link DeckCombo.templateCount} above zero come back too — they are the
   * *possible* ones, and separating them is the caller's job, not a filter to apply here.
   *
   * Safe on a database that has never ingested the feed: the answer is `[]`, which is also what
   * a deck with no combos in it answers. {@link ipc.combosStatus} is what tells those apart.
   */
  combosForCards: (cardIds: string[]) => invoke<DeckCombo[]>("combos_for_cards", { cardIds }),
  /**
   * Every combo that **names** one card — the card surface's combo list, and the opposite
   * question to {@link ipc.combosForCards} directly above.
   *
   * **A second command rather than a widening of that one, and the two answer different
   * questions about the same table.** `combos_for_cards` asks which combos a pile of printings
   * fully *contains*: it is the deck advisory's read, it is narrow on purpose, and a reader
   * holding one piece of a combo gets nothing from it. This one asks what a single card is part
   * of and claims nothing about the rest of the pieces — most of what it answers is combos the
   * reader owns no other card of, which is exactly what makes it worth drawing. Folding them
   * together would mean one shape carrying `pieces` and their pictures for every combo of every
   * deck in the gallery, to draw a list of names.
   *
   * Keyed on the **oracle** id, which is `oracleTagsKey`'s argument arriving at the same place:
   * a combo is a fact about a card rather than about a piece of cardboard, so all four Lightning
   * Bolts have one answer, and a printing-keyed read would fetch it again every time the reader
   * stepped between printings of the card they are already reading about.
   *
   * The six arguments are named one by one rather than spread from {@link CardCombosQuery},
   * because this is the one place the wire names are written down: a field added to that
   * interface for this side's own use — a sort the backend does not have, say — would otherwise
   * travel to a command that never declared it.
   *
   * **All three narrowings happen in SQL before the page is cut**, so a filtered answer is a
   * different question rather than a subset of the unfiltered one — see `cardCombosKey` in
   * `lib/query.ts`, which is why all three are in the key.
   *
   * **`search` is forwarded exactly as given, `""` included.** It is the same request as `null`
   * by the command's contract, and folding one into the other here would be the second place
   * that rule was written down — `cardCombosKey` is the first and only one, because the cache is
   * where the difference between `""` and `null` can actually cost something. What this wrapper
   * owes is that the key *travels*: `search: null` is sent as an explicit `null`, never dropped,
   * for `cardCount`'s reason one field over — Tauri fills parameters by name and an absent one is
   * a rejection rather than a default. `ipc.test.ts` asserts the key set rather than the object,
   * because `toHaveBeenCalledWith` cannot tell an absent key from one holding `undefined`.
   *
   * Safe on a database that has never ingested the feed: the answer is an empty page with three
   * zeros, which is also what a card in no combo answers, and {@link ipc.combosStatus} is what
   * tells those two apart.
   */
  combosForCard: (q: CardCombosQuery) =>
    invoke<CardCombosPage>("combos_for_card", {
      oracleId: q.oracleId,
      search: q.search,
      cardCount: q.cardCount,
      ownedOnly: q.ownedOnly,
      limit: q.limit,
      offset: q.offset,
    }),
  /**
   * The combo feed being fetched, phase by phase — a channel of its own beside `sync:progress`,
   * `marketplace:progress`, `update:progress` and the two tag channels.
   *
   * **Subscribe once**, like every other listener here: each call is another `listen`
   * registration for the life of the app. Tauri drops events emitted before the webview
   * registered a listener, so {@link ipc.combosStatus} is the reliable half of the pair.
   */
  onCombosProgress: (cb: (e: ComboProgress) => void): Unlisten =>
    core.listen<ComboProgress>("combos:progress", cb),
};
