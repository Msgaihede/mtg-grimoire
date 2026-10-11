/**
 * The Home page: its layout and widgets, recent cards, set completion, price movers and history, the value history, sticky notes, new printings, deck completion and upcoming sets.
 *
 * **One domain of `../ipc.ts`, split out on 2026-10-11 (issue #557).** Nothing outside
 * `packages/ui/lib/ipc*` imports this file: every page, hook, story and test goes through
 * `@/lib/ipc`, which re-exports these types and spreads `homeCommands` into `ipc`. That is what keeps
 * `vi.mock("@/lib/ipc", …)` the one seam a suite replaces — a component that imported a wrapper
 * from here would go around every mock in the repository. ESLint refuses the import, and
 * `ipc.test.ts` reads this file with its siblings, so the struct-parity and argument-name fences
 * cover it as they covered the single file.
 */
import type { Finish } from "../finish";
import type { MarketplaceId } from "../marketplace";
import { invoke } from "./invoke";

/**
 * One tile on the home page — **a document the backend stores and does not understand**.
 *
 * `kind` is a `string` and `config` is `unknown` on purpose, and it is the strongest version of
 * {@link ipc.deckSort}'s split rather than an exception to it: the widget vocabulary is
 * TypeScript's, it appears in no Rust file, and the union that narrows it is a **different type**
 * — `WidgetKind` in `packages/ui/features/home/widgets.ts`. Naming the kinds here as a union would make a
 * layout a *newer* build wrote unparseable by an older one, and a portable app that a reader runs
 * two versions of is exactly where that happens. Rust validates that both words are non-empty and
 * nothing else; this side draws what it knows and carries the rest through untouched.
 */
export interface HomeWidget {
  /** Stable across a move — the key a drag moves and the row a `config` belongs to. */
  id: string;
  /** Which tile this is. See above: **not** `WidgetKind`, deliberately. */
  kind: string;
  /**
   * Where the tile sits on the page's square-cell grid, in cells from the top-left corner, and how
   * many cells it covers — layout document **version 2**. Rust bounds each by value and knows
   * nothing about how many columns a window has: `layout.ts`'s `normalise` is what brings a
   * document inside the grid it is about to be drawn on.
   *
   * A version-1 document carries none of the four, and Rust answers `0` for each; `parseLayout`
   * reads `w === 0` as "never placed" and lays the widget out from {@link span}.
   */
  x: number;
  y: number;
  w: number;
  h: number;
  /**
   * The version-1 width — `1` a column, `2` the whole row. **Written on every version-2 document
   * and read by nothing in this build except the upgrade from version 1.** It is there for an
   * *older* build: that one's `home.rs` requires the field, so a document without it would read as
   * the default layout there, and the reader's next Customize in the old build would overwrite
   * this build's page. With it, the old build draws the widgets in a row and refuses to save a
   * version it does not write — the round trip this document has always promised.
   */
  span?: number;
  /** Whatever that kind of tile remembers — a dimension, a title, a density, a row count.
   *  `unknown` rather than a union of every widget's shape for `kind`'s reason: a build that
   *  cannot read a config must still write it back the way it found it. */
  config: unknown;
}

/**
 * The whole home page, as one `app_meta` row — the **eleventh** stored setting and the second that
 * carries a struct, after {@link DeckFolderPane}.
 *
 * A document rather than a row per tile for that struct's reason, arrived at from the other end: a
 * reorder changes every widget's place at once, so one write is the only shape that cannot half
 * land. `markcolors.rs`'s four rules govern it — reading can never fail, writing validates, **a
 * write preserves what this build does not understand**, and no migration, because `app_meta` is
 * schema v6's table.
 *
 * **An empty `widgets` is a layout, not a missing row.** A reader who removed every tile has said
 * something, and handing them the default back on the next launch would be the app arguing with
 * them; only a row that is *absent* or unparseable falls back to the six the crate seeds.
 */
export interface HomeLayout {
  /** `2` since the cell grid. Rust **refuses** a write carrying anything else rather than
   *  downgrading it, so a document from a future build survives an older one untouched. */
  version: number;
  widgets: HomeWidget[];
}

/**
 * One card the reader opened recently — `recent_cards.rs`'s `RecentCard`.
 *
 * The ids are this device's memory, one `app_meta` row, and the name and set are joined off the
 * corpus at read time: a printing the corpus no longer holds is skipped rather than drawn as a
 * frame with nothing in it.
 */
export interface RecentCard {
  cardId: string;
  name: string;
  setCode: string;
  /** Unix seconds of the most recent open. */
  viewedAt: number;
}

/**
 * How much of one set the reader owns — `set_completion.rs`'s `SetCompletion`.
 *
 * `owned` counts **distinct collector numbers** the collection holds any copy of, in any finish
 * or language, inside `1..=size`. `size` is Scryfall's `printed_size` and is `null` for a set the
 * corpus has no printed size for — a corpus that has not synced since the column arrived, or a
 * set Scryfall publishes none for — in which case `owned` counts every collector number held.
 * Only sets holding at least one owned card are answered.
 */
export interface SetCompletion {
  setCode: string;
  name: string;
  /** `YYYY-MM-DD`, or `null` where Scryfall published none. */
  releasedAt: string | null;
  owned: number;
  size: number | null;
}

/** Which baseline {@link ipc.priceMovers} measures against. `all` is the oldest snapshot kept. */
export type PriceMoverWindow = "7d" | "30d" | "all";

/** Which way a mover went. `both` ranks gainers and losers together by the size of the move. */
export type PriceMoverDirection = "both" | "up" | "down";

/**
 * What a Price movers widget is narrowed to (issue #906) — `price_history.rs`'s `PriceMoverScope`.
 * Sent in place of *every owned printing*; absent is that question.
 *
 * Every id is **direct**: the widget expands a chosen folder into the folders inside it before it
 * asks, as the Wishlist savings widget does. `0` is a cabinet's root — the copies or wishes filed
 * in no folder. `cards` are printing ids, owned or not, each measured in every finish it is priced
 * in. All three are `#[serde(default)]` on the Rust side, so a misspelt key here is not a refusal:
 * it is an empty list, which `ipc.test.ts` reads the struct to rule out.
 */
export interface PriceMoverScope {
  collectionFolders: number[];
  wishlistFolders: number[];
  cards: string[];
}

/** One owned printing whose price moved — `price_history.rs`'s `PriceMover`. */
export interface PriceMover {
  cardId: string;
  name: string;
  setCode: string;
  /** `null` for a printing whose set left the corpus. */
  setName: string | null;
  finish: Finish;
  /** Today's price at the asked marketplace, through `sorting::price_expr`. */
  now: number;
  /** The price in the baseline snapshot. */
  then: number;
  /** `now - then`, signed. Never `0` — a printing that did not move is not a mover. */
  delta: number;
}

/**
 * The movers, and what they were measured against — `price_history.rs`'s `PriceMovers`.
 *
 * `since` is the Unix seconds of the baseline snapshot actually used, `null` when there is no
 * snapshot old enough to compare against at all. `days` is how many distinct days of snapshots
 * this marketplace holds, which is what lets the widget tell *nothing moved* from *there is no
 * history yet* — two sentences a reader must never confuse.
 */
export interface PriceMovers {
  movers: PriceMover[];
  since: number | null;
  days: number;
}

/** One day of one printing's price — `price_history.rs`'s `PricePoint`. */
export interface PricePoint {
  /** Unix seconds of that day's UTC midnight — the day the snapshot was taken, not its instant. */
  day: number;
  price: number;
}

/**
 * One printing's price over time at one marketplace — `price_history.rs`'s `PriceHistory`.
 *
 * **`points` stops before today**, oldest first and one per day: today's figure is `now`, read
 * live through `sorting::price_expr` — the same number {@link PriceMover}'s `now` is — so the
 * popup's latest figure is the price the widget row showed rather than a snapshot that can lag it
 * by a feed. `now` is `null` when this marketplace has no price for the printing today, which
 * is an answer and never a reason to reach for another marketplace's. `today` is the database's
 * own `unixepoch(date('now'))`, so the page places the last point without a clock of its own —
 * one clock for the whole answer, and a test that can pin it.
 */
export interface PriceHistory {
  points: PricePoint[];
  now: number | null;
  today: number;
}

/**
 * How {@link ipc.collectionValueHistory} cuts the collection's value — `value_history.rs`'s
 * `split` word. `total` is one line and no buckets; the other three put every copy in exactly one
 * bucket, so a point's bucket values always sum to its total.
 *
 * A word the crate does not know is **refused**, in `value_history::NOT_A_SPLIT`'s words — not
 * read as `total`. Where `price_movers` degrades an unknown window to the default, a graph drawn
 * under a heading that says *by colour* over a single total line would be the chart lying about
 * its own subject.
 */
export type ValueSplit = "total" | "type" | "color" | "set";

/**
 * One line of the Collection value graph — `value_history.rs`'s `ValueBucket`.
 *
 * `key` is the crate's word and the three splits spell it three ways, none of them this side's to
 * reword. **`type`** is lowercase — `creature` … `land`, or `other` — and its precedence is
 * `features/decks/deckBuckets.ts`'s `typeBucket` exactly, on the front face, so a reader meets one
 * answer to "what type is this card" on the deck editor and on the home page. **`color`** is
 * `collection_breakdown`'s own vocabulary: `W` `U` `B` `R` `G` as the stored uppercase letter,
 * beside the two lowercase words `c` and `multi`. **`set`** is the set code, or `other` for a
 * printing that has left the corpus and for every set past the crate's cap.
 *
 * `name` is the set's name for `set` and `null` everywhere else — for the other three splits, for
 * `other`, and for a set the corpus no longer knows the name of. It is not a label: the words a
 * reader sees are TypeScript's, and `null` here is a fact about the database.
 */
export interface ValueBucket {
  key: string;
  name: string | null;
}

/**
 * One point of the Collection value graph — `value_history.rs`'s `ValuePoint`.
 *
 * **`moved` is the price-only part of the step from the previous point, and the rest is the
 * reader's own doing.** For every printing held at both points it is `copies_before ×
 * (price_now − price_before)`, so `total − previous.total − moved` is what was added or taken
 * away in that step — a figure this side derives rather than the crate sending a second number
 * that could come to disagree with the first two. `null` on the first point, where there is no
 * step: **`null` and never `0`**, because *no step* and *a step in which no price moved* are two
 * different sentences on the readout.
 */
export interface ValuePoint {
  /** Unix seconds of the period's UTC midnight. A weekly period answers its **latest** day. */
  day: number;
  /** Σ copies × price over the period's priced rows. Never an em dash: an unpriced copy adds 0. */
  total: number;
  /** One value per {@link ValueHistory.buckets}, in the same order; empty for `total`. */
  values: number[];
  /** The price-only part of `total − previous.total` — see above. */
  moved: number | null;
  /**
   * True on the last point only: **today**, computed live from `collection_entries` at today's
   * price the way `collection_summary` computes the collection's value — so the graph's last point
   * is exactly the figure the Collection value widget prints beside it.
   */
  live: boolean;
}

/**
 * The collection's value over time at one marketplace — `value_history.rs`'s `ValueHistory`.
 *
 * **`points` is every kept snapshot period before today plus a live point for today**, oldest
 * first: one point a day inside `price_history::DAILY_DAYS` and one per seven-day bucket beyond
 * it, the table's own thinning applied again at read time so a printing sold mid-week cannot make
 * a point of its own. **Only rows written from user schema v50 on are read** — `price_snapshots`
 * learned how many copies it was pricing at that rung, and a row from before it has a price and
 * no holding — so a database upgraded today answers the live point alone, which is the widget's
 * *the line starts tomorrow* state rather than a line drawn out of NULLs. **An empty collection
 * answers no points at all**, not a live point at zero.
 *
 * `buckets` is empty for `total`. For `color` it is fixed `W U B R G c multi` order, holding only
 * the buckets that are non-zero somewhere; for `type` and `set` it is today's value descending with
 * `other` last and **at most eight named buckets** — which to fold further, and into what words, is
 * the widget's. `today` is the database's own `unixepoch(date('now'))`, {@link PriceHistory}'s
 * device, so the page places the range without a clock of its own.
 */
export interface ValueHistory {
  buckets: ValueBucket[];
  points: ValuePoint[];
  today: number;
}

/**
 * One of the reader's own sticky notes — `sticky_notes.rs`'s `StickyNoteRow` (user schema v46).
 *
 * **It hangs off nothing**, which is what separates it from {@link DeckNote}: no deck, no card,
 * no scope. The home page's `stickyNotes` widget is its only reader.
 *
 * Two fields carry no vocabulary on this side of the wire and both are deliberate. `title` may be
 * empty, and what a note is *called* is computed at render rather than stored — a stored
 * derivation would go stale the moment the body was edited and no writer could notice. `color` is
 * one of five words the page knows, and the column carries **no CHECK**: the table is synced, so a
 * build that adds a sixth colour must be able to emit rows this build can still draw.
 * `features/home/stickyNotes.ts`'s `noteColor` reads an unknown word as `slate`.
 *
 * `body` is CommonMark in the dialect `features/decks/noteMarkdown.ts` pins — never HTML and never
 * ProseMirror JSON, which is what keeps a renderer out of the crate.
 */
export interface StickyNote {
  id: number;
  /** May be empty. See the note above: the drawn heading is derived, never this field alone. */
  title: string;
  body: string;
  color: string;
  pinned: boolean;
  /** The reader's own arrangement, renumbered by {@link ipc.stickyNoteReorder}. */
  sortOrder: number;
  /** Unix seconds. Neither timestamp is synced — two answers to "when" is one too many. */
  createdAt: number;
  updatedAt: number;
}

/**
 * What {@link ipc.stickyNoteUpdate} changes — **absent means leave it**, and `""` really empties.
 *
 * Rust's `coalesce(?n, col)` is the whole of that rule, so an omitted key and a key set to
 * `undefined` are the same thing on the wire and neither can blank a field by accident.
 */
export interface StickyNotePatch {
  title?: string;
  body?: string;
  color?: string;
  pinned?: boolean;
}

/**
 * One deck holding the card a {@link NewPrinting} is a reprint of — `new_printings.rs`'s
 * `NewPrintingDeck`.
 *
 * `quantity` is summed across the deck's categories, so a deck holding the card in both a live
 * and a theory pile is **one** entry with the total rather than two entries that look like two
 * decks. `variant` is then the *lower* of the two words it was folded from — `live` wins over
 * `theory`, because a deck that has sleeved the card up is holding it whatever else it plans.
 */
export interface NewPrintingDeck {
  deckId: number;
  name: string;
  quantity: number;
  variant: "live" | "theory";
  virtualOnly: boolean;
}

/**
 * One reprinted printing and the decks that hold the card — `new_printings.rs`'s `NewPrinting`.
 *
 * **`releasedAt` is never null here**, unlike `Printing.releasedAt` one command over: a printing
 * with no date cannot be placed in a day group, so the query drops it rather than the page
 * inventing an *Undated* bucket.
 */
export interface NewPrinting {
  printingId: string;
  oracleId: string;
  name: string;
  setCode: string;
  setName: string | null;
  collectorNumber: string;
  /** `YYYY-MM-DD`. Never null — see above. */
  releasedAt: string;
  rarity: string | null;
  /** JSON, verbatim — read with `packages/ui/lib/treatment.ts`, as on {@link Printing}. */
  promoTypes: string | null;
  finishes: string | null;
  /**
   * Which language this printing is — `cards.lang`.
   *
   * **On the wire because a row has to be able to say it.** A reader who asks for every language
   * gets one row per language of a reprint, which is what they asked for — and without this those
   * rows are identical on screen and the list reads as duplicated rather than complete.
   */
  lang: string;
  decks: readonly NewPrintingDeck[];
}

/**
 * The feed, and the four facts that travel beside it — `new_printings.rs`'s `NewPrintings`.
 *
 * **An empty list means one of three different things and a count of zero cannot tell them
 * apart**: no deck is watched, nothing was reprinted inside this window, or the window is
 * shorter than the card data goes back. `decksWatched`, `since` and `oldest` are what let the
 * page pick its sentence — `PriceMovers`' `days`/`since` device, one widget over.
 */
export interface NewPrintings {
  printings: readonly NewPrinting[];
  /** How many decks the scope resolved to. **`0` is a real answer** with a sentence of its own. */
  decksWatched: number;
  /** The window's far edge, `YYYY-MM-DD`. */
  since: string;
  /** The oldest printing actually in the answer, or `null` when there are none. */
  oldest: string | null;
  /**
   * When this device last saw a non-empty feed, in Unix seconds — `app_meta.new_printings_seen`,
   * and deliberately **not** a `config` key: a config round-trips through older builds, and a
   * cursor an older build rewrites is a cursor that lies. `null` is *never*, which marks every
   * row as unseen.
   */
  seenAt: number | null;
}

/**
 * Which comparison the Deck completion widget asks for — `deck_completion.rs`'s `Compare`, sent as
 * the word. **Anything Rust does not recognise reads as `collection`**, `Marketplace`'s forgiving
 * shape, so a word a newer build wrote measures the default rather than refusing.
 *
 * * `collection` — every deck that is not virtual, its **actual** (live) list against the copies
 *   the collection files in that deck's own group: the editor's `Actual` tab, owned for owned.
 * * `theory` — every deck that keeps a plan, virtual ones included, its **actual** list against
 *   its **theory** list: how much of the plan is already sleeved, in the exact printing and finish.
 *   `theory_diff`'s arithmetic, so the missing copies are the Compare dialog's own lines.
 */
export type DeckCompletionCompare = "collection" | "theory";

/**
 * How far one deck is along — `deck_completion.rs`'s `DeckCompletion`, one row per deck the
 * {@link DeckCompletionCompare} asked about (archived ones included; which decks to draw is the
 * widget's decision).
 *
 * **Counted exactly as the deck editor counts**, which is the whole point of the read: a widget
 * saying "4 missing" about a deck that opens saying "6 missing" is a bug report. Every active pile
 * counts — sideboard and companion included, unlike {@link DeckValue}'s narrower pile — and a copy
 * matches on exact printing and finish.
 */
export interface DeckCompletion {
  deckId: number;
  /** Which list the figure is a fraction *of* — `live` under `collection`, measured against the
   *  deck's own group, and `theory` under `theory`, measured against the actual list. */
  list: "live" | "theory";
  /** Copies the measured list asks for, over every active pile. */
  wanted: number;
  /** Of those, copies the pool covers — the group's copies, or the actual list's. Never more than
   *  `wanted`. */
  owned: number;
  /** `wanted − owned`. Never negative. */
  missing: number;
  /**
   * What the missing copies cost at the marketplace asked for. **`null` when nothing counted in
   * the list is priced there** — `DeckStats`' `missingPrice` rule — so a complete deck whose cards
   * are priced answers `0`, and `null` always draws an em dash rather than `$0.00`. A deck whose
   * only missing copies are unpriced also answers `0`, beside a non-zero
   * {@link DeckCompletion.unpricedMissing}.
   */
  missingCost: number | null;
  /** Missing **copies** this marketplace has no price for — counted beside the cost, never summed
   *  into it as zero. */
  unpricedMissing: number;
}

/** One set with printings still to come — `upcoming_sets.rs`'s `UpcomingSet`. */
export interface UpcomingSet {
  code: string;
  /** `cards.set_name`, or the code where no card in the window carries one. */
  name: string;
  /** The set's **earliest** card date in the window, `YYYY-MM-DD` — cards of one set can carry
   *  different dates. */
  releasedAt: string;
  /** The number the search draws for the set's chip on `Any card` — its paper printings, **one per
   *  card** (`search.rs`' `COLLAPSE_KEY`), whatever their date — so a showcase, a borderless or a
   *  second language of one card is not a second card, and a row agrees with the page it opens. */
  previewed: number;
  /** Distinct oracle cards in it that the reader's non-virtual decks hold, live or theory, basic
   *  lands left out — `new_printings`' defaults. */
  inDecks: number;
}

/**
 * The upcoming sets, and the day they were counted from — `upcoming_sets.rs`'s `UpcomingSets`.
 *
 * **Read over `cards`, not `sets`**, because the crate drops token, promo, memorabilia and
 * minigame sets from `sets`. Tokens, emblems, art
 * cards and front cards are never counted, and **a set any of whose paper cards has already
 * released is not coming soon at all** — The List and its kind gain future-dated printings, and a
 * card date alone would announce a set from 2020.
 */
export interface UpcomingSets {
  /** SQLite's `date('now')`, UTC — the day *in N days* is counted from, so the page carries no
   *  clock of its own. */
  today: string;
  /** Soonest first, then by code. */
  sets: UpcomingSet[];
}

/** The home commands — spread into `ipc` by `../ipc.ts`, which is the only reader of this object. */
export const homeCommands = {
  /**
   * The home page's tiles, in the order and at the widths the reader left them — see
   * {@link HomeLayout}.
   *
   * The **eleventh** `app_meta` setting and the second that carries a struct. **The read cannot
   * fail**: a missing row, a row this build cannot parse and a row holding something that is not a
   * layout all answer the six-tile default, which is what a reader who has never touched the page
   * sees. An empty widget list is the one thing that is *not* that default — it is a layout, and a
   * reader who cleared the page keeps it cleared.
   */
  homeLayout: () => invoke<HomeLayout>("home_layout"),
  /**
   * Remember the whole page — **the document, not a tile**, so a reorder cannot half land.
   *
   * The write is the half that validates: a `version` that is not `2`, a blank `id` or `kind`, a
   * footprint outside `home.rs`'s bounds, a `span` outside `1..=2` and a document over 64 KiB are
   * each refused in a sentence, and a refusal leaves the stored row exactly as it was. Everything else survives the round trip **including
   * what this build does not understand** — an unknown `kind` and its `config` come back verbatim,
   * which is the whole reason {@link HomeWidget} is typed as loosely as it is.
   *
   * Answers `collection::BUSY` under a running sync like every other write.
   */
  setHomeLayout: (layout: HomeLayout) => invoke<void>("set_home_layout", { layout }),
  /**
   * The cards this device opened most recently, newest first, at most `limit` (clamped `1..=24`).
   * Infallible at the far end: a missing or unreadable row is no cards.
   */
  recentCards: (limit: number) => invoke<RecentCard[]>("recent_cards", { limit }),
  /**
   * Remember that a card was opened. A card already on the list moves to the front rather than
   * appearing twice, and the list is capped at 24. Answers `collection::BUSY` under a running sync,
   * which the caller ignores — a missed entry costs one tile on the home page and nothing else.
   */
  recordRecentCard: (cardId: string) => invoke<void>("record_recent_card", { cardId }),
  /** Every set the collection holds a card from, with how much of it is owned. See
   *  {@link SetCompletion}. */
  setCompletion: () => invoke<SetCompletion[]>("set_completion"),
  /**
   * The owned printings whose price at `marketplace` moved most since the window's baseline
   * snapshot, largest move first, at most `limit` (clamped `1..=100`) — or, given a `scope`, the
   * printings it names (issue #906). See {@link PriceMovers} and {@link PriceMoverScope}.
   *
   * **No `scope` key at all when there is none**, rather than `scope: undefined`: an unscoped read
   * is the exact request every build before the scope sent.
   */
  priceMovers: (
    window: PriceMoverWindow,
    direction: PriceMoverDirection,
    marketplace: MarketplaceId,
    limit: number,
    scope?: PriceMoverScope,
  ) =>
    invoke<PriceMovers>("price_movers", {
      window,
      direction,
      marketplace,
      limit,
      ...(scope === undefined ? {} : { scope }),
    }),
  /**
   * Replace this device's price watch list — the printings the Price movers widgets are narrowed
   * to, which every later price snapshot remembers whether or not they are owned (issue #906).
   * Sent by `useHomeLayout` when the cards its widgets name change; a card added today has history
   * from the next snapshot on (the next launch, card sync or price refresh). More than 500 is
   * refused in words; `BUSY` under a sync, which the caller ignores — the next layout change sends
   * the list again.
   */
  setPriceWatch: (cardIds: string[]) => invoke<void>("set_price_watch", { cardIds }),
  /**
   * One printing's daily price at `marketplace` and `finish`, before today and oldest first,
   * beside today's live figure — the Price movers popup's read. The points are `price_snapshots`'
   * rows, which are taken of **owned, wished-for and watched** printings, so a printing never held,
   * pinned or watched answers no points and may still answer a `now`. See {@link PriceHistory}.
   */
  priceHistory: (cardId: string, finish: Finish, marketplace: MarketplaceId) =>
    invoke<PriceHistory>("price_history", { cardId, finish, marketplace }),
  /**
   * The collection's value over time at `marketplace`, cut by `split` — the Collection value
   * graph's read, and `price_snapshots`' second reader after the movers (user schema v50 is what
   * gave it copies to multiply by). Oldest first, a live point for today last; range and measure
   * are the widget's and are not asked for here. An unknown `split` is refused in words. See
   * {@link ValueHistory}.
   */
  collectionValueHistory: (split: ValueSplit, marketplace: MarketplaceId) =>
    invoke<ValueHistory>("collection_value_history", { split, marketplace }),
  /**
   * Every sticky note, `ORDER BY sort_order, id` — see {@link StickyNote}.
   *
   * **Takes no arguments and cannot fail**: the read is `#[tauri::command(async)]` on a *sync*
   * function whose signature has no `Result`, because it is called while the window draws its
   * first frame and a home page that refuses to draw over a note is a worse answer than a page
   * with no notes on it. A database that has never held one answers an empty list.
   */
  stickyNotes: (): Promise<StickyNote[]> => invoke("sticky_notes"),
  /**
   * Write a new note and answer its id. It lands **last** — `max(sort_order) + 1` — so a reader
   * who has arranged their board keeps that arrangement and finds the new note at the end of it.
   *
   * **The colour is stored as written and validated by nobody**, which is the column's own rule
   * read from this end: a word a newer build sends survives the round trip, and this build draws
   * it as `slate`. Answers `collection::BUSY` under a running sync like every other write.
   */
  stickyNoteCreate: (title: string, body: string, color: string): Promise<number> =>
    invoke("sticky_note_create", { title, body, color }),
  /**
   * Change a note — see {@link StickyNotePatch}, whose absent-means-leave-it rule is the whole of
   * what this sends.
   *
   * **The patch is spread rather than nested**, because `sticky_note_update` declares its four
   * optional columns as four parameters beside `id` rather than taking a struct — so a wrapper
   * that sent `{ id, patch }` would be refused at run time with nothing red in either build.
   * `ipc.test.ts` pins all five names.
   *
   * **And a key the patch omits is simply not sent, where {@link ipc.deckNoteUpdate} spells every
   * key and folds `undefined` to `null`.** That is the same rule met a different way rather than
   * drift: an absent field deserialises into an `Option` as `None`, which is exactly the
   * `coalesce(?n, col)` arm that leaves the column alone — and here there is no `null` to send,
   * because `None` and *leave it* are one word on both sides of this wire.
   */
  stickyNoteUpdate: (id: number, patch: StickyNotePatch): Promise<void> =>
    invoke("sticky_note_update", { id, ...patch }),
  /** Delete one note. Refused in a sentence — `sticky_notes::NOTE_GONE` — if it is already gone. */
  stickyNoteDelete: (id: number): Promise<void> => invoke("sticky_note_delete", { id }),
  /**
   * Renumber the notes in the order given, `0..n`.
   *
   * **An id that is no longer a note is skipped rather than refused**: the page sends what it
   * drew, and a note deleted in another window must not fail the drag the reader just made.
   */
  stickyNoteReorder: (ids: number[]): Promise<void> => invoke("sticky_note_reorder", { ids }),
  /**
   * Reprints of cards the watched decks already hold, newest first — see {@link NewPrintings}.
   *
   * Every argument is the widget's stored `config` narrowed on the way out, and every one is
   * narrowed again in Rust: `days` into `1..=365`, `limit` into `1..=100`, an unknown `scope`
   * into `all`, and `langs` to codes of the right shape. A hand-edited row cannot ask for the
   * whole corpus.
   */
  newPrintings: (
    scope: string,
    deckIds: readonly number[],
    days: number,
    /**
     * The languages to answer in. **An empty list is every language** — the allow-list's one
     * sentinel, and the same rule at both ends of the wire. The default the widget sends is
     * `["en"]`, which is one row per reprint.
     */
    langs: readonly string[],
    includeVirtual: boolean,
    includeTheory: boolean,
    includeBasics: boolean,
    limit: number,
  ) =>
    invoke<NewPrintings>("new_printings", {
      scope,
      deckIds,
      days,
      langs,
      includeVirtual,
      includeTheory,
      includeBasics,
      limit,
    }),
  /** Move the *seen* cursor to `at`, in Unix seconds. **The clock is the caller's.** */
  markNewPrintingsSeen: (at: number) => invoke<void>("mark_new_printings_seen", { at }),
  /**
   * How far every deck is along under `compare`, priced at `marketplace` — see
   * {@link DeckCompletion} and {@link DeckCompletionCompare}. Both belong in the caller's query key.
   */
  deckCompletion: (marketplace: MarketplaceId, compare: DeckCompletionCompare) =>
    invoke<DeckCompletion[]>("deck_completion", { marketplace, compare }),
  /**
   * How many `deck_cards` rows carry a `needs_review` sentence — rows, not copies, and only that
   * one table. Its own read rather than `sync_relay_status`' `reviewCount`, which sums six tables,
   * is desktop-only and takes the write lock. **Takes no arguments**: an argument object sent to a
   * command that declares only the managed state is a deserialisation error, not a type error.
   */
  deckReviewCount: () => invoke<number>("deck_review_count"),
  /**
   * The sets with paper printings released after today and within `days` (clamped `1..=365` in
   * Rust) — see {@link UpcomingSets}.
   */
  upcomingSets: (days: number) => invoke<UpcomingSets>("upcoming_sets", { days }),
};
