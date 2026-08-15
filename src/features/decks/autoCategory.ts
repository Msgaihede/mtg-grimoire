/**
 * Where a card goes when the reader did not say.
 *
 * The add path takes a category id; the quick-add and the drag-from-anywhere paths often
 * have none, and this is the rule that supplies one. It reads exactly two things, in this
 * order: whether the front face is a **land**, and what the card **does** — Scryfall's Oracle
 * Tags, the functional vocabulary Tagger's editors curate by hand. The **type line is the
 * fallback underneath**, and it is what this rule read exclusively until the tag data existed.
 *
 * **Function beats type because a decklist is written by function.** Nobody builds a deck
 * with a column called "Instant"; they build one with Removal, Ramp, Draw and a mana base.
 * The type line puts Swords to Plowshares, Beast Within and Counterspell under three
 * different headings and Sol Ring under a fourth, which is the answer nobody wanted.
 *
 * **A tag is a fact, not a heuristic, and that is the whole reason this is allowed.** The
 * earlier version of this comment refused to read anything but the type line, on the grounds
 * that the alternative "files Swords to Plowshares under Removal for some cards and not
 * others" — and about a regex over oracle text it was exactly right. Oracle Tags are
 * different in kind: hand-curated, the same slug on every card that does the thing, so the
 * answer stays one a reader can predict from the card in their hand.
 *
 * **The slugs arrive already expanded to their ancestors.** This module neither fetches them
 * nor walks the hierarchy nor knows one exists — a card tagged `burn-creature` reaches here
 * carrying `removal` too, pre-expanded and deduped by the caller, in no meaningful order.
 *
 * **An empty or absent slug list falls straight through to the type line, and that path is
 * load-bearing rather than defensive.** It is what the app does before the tag dataset has
 * ever been downloaded — and if the download never succeeds, which is a supported way to run
 * this app. The old behaviour is the floor, not an error case.
 *
 * The Categories dialog's "File cards by what they do" button is this one rule pressed once
 * over a whole deck — the label names the rule rather than the mechanism, and it changed with
 * this rule (it read "Auto-categorise from card types" while the type line was the whole of
 * it). The v8
 * migration deliberately does **not** run it (`schema.rs`: it would be a second copy of this
 * rule, in SQL, to keep in step) — every legacy `main` row lands in one category called
 * "Main deck" and the reader splits it when they choose to.
 */
import type { DeckCard } from "@/lib/ipc";

/**
 * The stored answer meaning **this rule decides** — `DeckRow.defaultCategoryId` when the reader
 * has picked no pile, and the one value in the settings dialog's "Add cards to" select that is
 * not a category.
 *
 * `0`, because `deck_categories.id` is an `INTEGER PRIMARY KEY` and `dnd.ts`'s `isCategoryId`
 * refuses anything but a positive safe integer, so no real category can ever collide with it.
 * Rust spells the same number `deck::AUTO_CATEGORY`, and the two are one vocabulary on purpose:
 * a sentinel that meant "unset" on one side of the IPC and "auto" on the other is exactly how
 * the editor once filed every quick add on a fresh deck into the seeded **Commander** pile —
 * `0` was "nothing picked yet" and a clamp replaced it with `categories[0]`. Giving the sentinel
 * a meaning instead of a replacement was the whole of the fix.
 *
 * **It lives here rather than beside a control, and that is newer than most of the prose about
 * it.** It was `DeckSearchPanel`'s export while the deck editor's toolbar drew the select; the
 * choice is a deck setting now, so the constant belongs with the rule it names rather than with
 * whichever surface happens to draw it.
 */
export const AUTO_CATEGORY = 0;

/**
 * What a select calls {@link AUTO_CATEGORY}. Named for what it reads rather than for what it
 * does — "Auto" alone would not say *how*, and the how is the whole predictability of it.
 *
 * It read `Auto (by card type)` while the type line was the whole of the rule, and that was
 * still on screen after the rule changed — **found by driving the shipped window on 2026-08-14,
 * not by the suite**, which pinned the string in four places and so agreed with itself. The
 * wording matches the Categories dialog's button ("File cards by what they do") on purpose: they
 * are the same rule, and a reader who meets it twice under two names has to work out that it is
 * one rule.
 */
export const AUTO_CATEGORY_LABEL = "Auto (by what it does)";

/**
 * One entry in the functional list: the category name, and the slugs that mean it.
 *
 * `anchors` are **anchor** slugs rather than the whole of Tagger's vocabulary for the idea —
 * the caller expands every tag to its ancestors before this rule sees it, so naming the
 * parent here catches every child of it, present and future. `removal` alone stands for the
 * dozen `removal-*` leaves; a new leaf added under it next month needs no edit here.
 */
export interface OracleCategoryRule {
  readonly name: string;
  readonly anchors: readonly string[];
}

/**
 * The thirteen functional buckets, **in match order** — the first one whose anchors appear
 * among the card's slugs wins.
 *
 * **The order is the whole of the rule, because nearly every card matches more than one
 * entry.** This is a priority list, not a partition: Path to Exile is tagged `removal`,
 * `ramp` *and* `tutor`; Smothering Tithe is `ramp`, `tax`, `hate` and
 * `repeatable-token-generator`. Reordering these lines re-files hundreds of cards, which is
 * why the order is stated once, here, and read by nothing but {@link autoCategoryFor}.
 *
 * Two positions look wrong and are not:
 *
 * * **Recursion sits above Draw on purpose.** Scryfall's `regrowth` tag has *two* parents —
 *   `recursion` and `card-advantage` — so Eternal Witness and Regrowth itself arrive matching
 *   both. Recursion first is what puts them in the pile a deck builder expects; Draw first
 *   would empty the Recursion column of its two most famous cards.
 * * **Burn is last, and tiny (106 cards), on purpose.** Almost every burn spell is also
 *   tagged `removal` — `burn-creature`'s parents are `removal-burn` and `removal-creature` —
 *   so Removal takes them first and **Lightning Bolt is Removal, not Burn**. That is correct:
 *   what is left here is the burn that points at a player, which is the only burn a deck
 *   builder counts separately.
 *
 * `Removal` leads because it is the largest functional group in the game and the one a
 * mis-file is most visible in; `Ramp` follows it because a mana rock that also draws (Solemn
 * Simulacrum, tagged `ramp`, `card-advantage` and `tutor`) is a ramp card to everybody.
 *
 * **Land is not on this list**, and that is not an omission — see {@link autoCategoryFor}.
 */
export const ORACLE_CATEGORIES: readonly OracleCategoryRule[] = [
  { name: "Removal", anchors: ["removal", "counterspell"] },
  { name: "Ramp", anchors: ["ramp", "mana-producer", "adds-multiple-mana"] },
  { name: "Recursion", anchors: ["recursion"] },
  { name: "Draw", anchors: ["card-advantage", "force-draw"] },
  { name: "Tutor", anchors: ["tutor"] },
  { name: "Protection", anchors: ["protection", "damage-prevention", "ward"] },
  {
    name: "Anthem",
    anchors: ["anthem", "keyword-anthem", "power-boost-to-all", "toughness-boost-to-all"],
  },
  {
    name: "Stax",
    anchors: ["tax", "group-slug", "hate", "pillowfort", "mass-land-denial", "stasis"],
  },
  { name: "Tokens", anchors: ["repeatable-token-generator"] },
  { name: "Sacrifice", anchors: ["sacrifice-outlet", "sacrifice-self"] },
  { name: "Lifegain", anchors: ["lifegain"] },
  { name: "Mill", anchors: ["mill"] },
  { name: "Burn", anchors: ["burn"] },
];

/**
 * The thirteen names alone, in the same priority order — **derived, never typed out a second
 * time**, for the same reason {@link AUTO_CATEGORY_DISPLAY_ORDER} is.
 *
 * The reading order and the matching order agree about all thirteen of these, unlike the
 * type buckets, which disagree about Land.
 */
export const ORACLE_CATEGORY_NAMES: readonly string[] = ORACLE_CATEGORIES.map((rule) => rule.name);

/**
 * The eight **type** buckets, **in match order** — first one whose word appears on the front
 * face wins, and the order is the whole of the rule for a card with two types.
 *
 * These are the fallback now rather than the primary rule: a card with no tags reaches them,
 * and so does a card whose tags say nothing this app has a column for. Every word of what
 * follows is still true of that path.
 *
 * `Land` leads because a land is a land before it is anything else. **Dryad Arbor** is the
 * case that makes this non-obvious and the reason this comment names it: its type line is
 * `Land Creature — Forest Dryad`, and a list that checked `Creature` first would file it in
 * the creature column, where no decklist has ever put it. Every artifact land is the same
 * card. `Creature` comes next for the reason from the other side — an Artifact Creature is a
 * creature to everyone who has ever built a deck. A Legendary Creature that is *the
 * commander* was placed explicitly and never reaches here.
 *
 * **This is the matching order and only the matching order.** What a reader sees is
 * {@link AUTO_CATEGORY_DISPLAY_ORDER}, which is this list with Land moved to the end — the
 * two genuinely want opposite answers about Land, and folding them back into one constant
 * breaks whichever job loses.
 */
export const AUTO_CATEGORIES = [
  "Land",
  "Creature",
  "Artifact",
  "Enchantment",
  "Planeswalker",
  "Battle",
  "Instant",
  "Sorcery",
] as const;

export type AutoCategory = (typeof AUTO_CATEGORIES)[number];

/**
 * Every bucket **in reading order** — the thirteen functions in the order the rule tries
 * them, then the seven type fallbacks, then Land, as it is in every decklist ever written
 * down, because the lands are where the counting ends.
 *
 * This is what a reader sees: `grouping.ts` orders its `type` groups by it and `sorting.ts`
 * sorts by it, so a "group by type" and a "sort by type" cannot disagree.
 *
 * **Derived, never typed out a second time.** Two hand-written lists are two lists to keep in
 * step, and the day they drift the symptom is a Sorcery heading between two Instants. The two
 * transformations are stated here and nowhere else: take {@link ORACLE_CATEGORY_NAMES}
 * unchanged — a function's priority and its place on screen want the same order — then take
 * {@link AUTO_CATEGORIES} and move Land to the end.
 *
 * The type half differs from its matching order **only** about Land, and that is not an
 * oversight in either of them. The matching order has to check Land first or Dryad Arbor
 * (`Land Creature — Forest Dryad`) is filed as a creature; the reading order has to draw it
 * last or the decklist starts with its mana base. **Land stays last here whatever else grows
 * above it.** One constant cannot be both, which is why "tidying" these back together is the
 * change to refuse.
 *
 * {@link UNCATEGORIZED} is deliberately **absent**: it earns its place at the foot by being
 * unknown to {@link autoCategoryDisplayOrder}, not by being written into the end of a list.
 */
export const AUTO_CATEGORY_DISPLAY_ORDER: readonly string[] = [
  ...ORACLE_CATEGORY_NAMES,
  ...AUTO_CATEGORIES.filter((bucket) => bucket !== "Land"),
  "Land",
];

/**
 * Where a card with no type line and no tags goes — an orphan whose printing has left
 * `cards`, or a layout this list has no word for (a Dungeon, a Plane, an Attraction).
 *
 * **A pile like any other, and that is the point of it having a name.** It is answered by the
 * same rule that answers `Removal`, so `category_for_name` finds-or-creates it, it arrives
 * `origin: 'auto'`, and it goes off the desk with its last card. Nothing branches on it being
 * this particular word — see `useDeck.refileCard`, which used to and no longer does.
 *
 * **Never `""`.** The backend's find-or-create matches on `schema::DECK_CATEGORY_GRAIN`,
 * which is `(deck_id, name)`, so an empty name would be a real category — one with no
 * heading, which the reader can neither see, rename, nor switch back on.
 *
 * **Spelled with a `z`, against the file's own prose, and deliberately** (2026-08-16). This is
 * a name a reader sees on their desk and types into a rename box, not a word in a comment, and
 * it is the one Markus asked for. `schema.rs`'s v15 backfill still lists the **`s`** spelling
 * and must keep it: that step is a frozen record of what this rule could answer on the day it
 * ran, and a machine that has already run v15 never runs it again. Measured before the change —
 * **0** categories in the live database matched `%ategori%`, so nothing had to be migrated and
 * no deck can end up holding one of each.
 */
export const UNCATEGORIZED = "Uncategorized";

/**
 * The four names `schema::PREDEFINED_CATEGORIES` seeds with every deck, mirrored here for
 * the guard below and for nothing else.
 *
 * `main` has no predefined name: a deck may own any number of `main` categories and the seed
 * names none. ("Main deck" is what the v8 *migration* calls the pile it files legacy rows
 * into — a perfectly ordinary user category, and deliberately not on this list.)
 */
export const PREDEFINED_CATEGORY_NAMES: readonly string[] = [
  "Commander",
  "Sideboard",
  "Companion",
  "Maybeboard",
];

/**
 * Every name {@link autoCategoryFor} can answer with — the thirteen functions, the eight type
 * buckets and the fallback.
 *
 * It exists so the collision guard can be a **sweep** rather than a review note, and it had
 * to grow with the functional list for exactly that guard's sake. The trap it closes:
 * find-or-create matches on `(deck_id, name)` and ignores `kind`, so a rule that ever
 * answered `"Sideboard"` would file a plain add into the sideboard, and one that answered
 * `"Maybeboard"` would file it into a pile that is **inactive** — a card that counts toward
 * no size, no copy limit, no legality check and no allocation, having never left the deck.
 * Nothing on screen would say so. `autoCategory.test.ts` sweeps this list against
 * {@link PREDEFINED_CATEGORY_NAMES} for that reason, and a name added to
 * {@link ORACLE_CATEGORIES} is swept by construction rather than by anyone remembering.
 */
export const AUTO_CATEGORY_NAMES: readonly string[] = [
  ...ORACLE_CATEGORY_NAMES,
  ...AUTO_CATEGORIES,
  UNCATEGORIZED,
];

/**
 * The bucket one card belongs to: **Land, then what it does, then what it is.**
 *
 * The **front** face decides, for both halves that read a type line. `type_line` carries both
 * halves of a double-faced card separated by `//`, and the back of a modal DFC is routinely a
 * land while its front is a spell — a deck's curve is cast from the front, so reading the
 * whole string would file every MDFC spell under Land, and the pin below would do it first
 * and hardest.
 *
 * **Land is pinned by type, before a single tag is consulted, and that is measured rather
 * than tidy.** 52% of lands carry a functional tag: Prismatic Vista is tagged `tutor` (it
 * searches), Savai Triome `card-advantage` (it cycles). Consulting tags first scatters a
 * deck's mana base across a dozen columns — a Tutor heading holding four fetchlands, a Draw
 * heading holding the Triomes — and a mana base is the one pile every decklist draws whole.
 * Dryad Arbor (`Land Creature — Forest Dryad`) lands here for the older reason as well.
 *
 * Then {@link ORACLE_CATEGORIES}, first match wins. Then {@link AUTO_CATEGORIES}, which is
 * the whole of the answer for a card carrying no slugs — see this module's header for why
 * that path is the floor rather than a failure.
 *
 * The slug list is optional and nullable because both mean the same thing here and the DTO
 * is a LEFT JOIN: **not knowing what a card does is not an error**, it is the fallback.
 */
export function autoCategoryFor(
  card: Pick<DeckCard, "typeLine"> & { oracleTags?: readonly string[] | null },
): string {
  const front = (card.typeLine ?? "").split("//")[0];
  if (front.includes("Land")) return "Land";

  const slugs = new Set(card.oracleTags ?? []);
  if (slugs.size > 0) {
    const byFunction = ORACLE_CATEGORIES.find((rule) =>
      rule.anchors.some((anchor) => slugs.has(anchor)),
    );
    if (byFunction) return byFunction.name;
  }

  return AUTO_CATEGORIES.find((bucket) => front.includes(bucket)) ?? UNCATEGORIZED;
}

/**
 * Where a bucket sorts **on screen** — {@link AUTO_CATEGORY_DISPLAY_ORDER}, with the fallback
 * last.
 *
 * One function so the sort and the grouping share an order as well as a vocabulary.
 * {@link UNCATEGORIZED}, and any name this list has never heard of, sorts with the unknowns
 * at the foot rather than at the head, which is where an unknown belongs.
 *
 * There is deliberately **no** exported "matching order" equivalent: the match order is
 * `autoCategoryFor`'s alone and nothing else has any business reading it.
 */
export function autoCategoryDisplayOrder(name: string): number {
  const at = AUTO_CATEGORY_DISPLAY_ORDER.indexOf(name);
  return at < 0 ? AUTO_CATEGORY_DISPLAY_ORDER.length : at;
}
