/**
 * Scryfall tags: oracle and art tags, their feeds' progress, lookup and resolution, and the reader's muted tags. Not deck labels and not deck tags — `docs/agent/DOMAIN_VOCABULARY.md`.
 *
 * **One domain of `../ipc.ts`, split out on 2026-10-11 (issue #557).** Nothing outside
 * `packages/ui/lib/ipc*` imports this file: every page, hook, story and test goes through
 * `@/lib/ipc`, which re-exports these types and spreads `tagCommands` into `ipc`. That is what keeps
 * `vi.mock("@/lib/ipc", …)` the one seam a suite replaces — a component that imported a wrapper
 * from here would go around every mock in the repository. ESLint refuses the import, and
 * `ipc.test.ts` reads this file with its siblings, so the struct-parity and argument-name fences
 * cover it as they covered the single file.
 */
import { core } from "@/lib/core";
import { invoke, type Unlisten } from "./invoke";

/**
 * A card's Oracle tags, keyed by the **oracle** id — Scryfall Tagger's answer to "what does
 * this card *do*", which is what `autoCategoryFor` files a deck add by.
 *
 * `slugs` carries the card's own tags **and every ancestor of them**, already expanded by
 * `oracle_tags::ancestor_closures` and sorted. That expansion is the fact; picking which of
 * them names a pile is the conclusion, and it stays in `features/decks/autoCategory.ts`. Rust
 * knows nothing about "Removal" or the order the piles are tried in, deliberately.
 *
 * **An empty `slugs` is an answer, not a miss**, and the two are indistinguishable on purpose:
 * an untagged card, a card id that is not in `cards`, and a printing whose `oracle_id` is NULL
 * all come back empty, because the rule's response to all three is the same — fall back to the
 * type line. Nothing about categorising a card may fail an add.
 */
export interface CardTags {
  oracleId: string;
  slugs: string[];
}

/**
 * The same answer keyed by a **printing** id (`cards.id`), for the callers that hold one.
 *
 * Almost every categorising call site does: a drag payload, `useDeck.addCard` and
 * `import_resolve`'s rows all name a printing. A separate DTO rather than reusing
 * {@link CardTags} because a printing id in a field called `oracleId` would be a lie, and this
 * mirror is the one place that lie would never be caught.
 */
export interface PrintingTags {
  cardId: string;
  slugs: string[];
}

/**
 * One tag taxonomy's own freshness — its `*_tag_meta` row, plus the shape of a database that
 * has never fetched the file.
 *
 * **Every field is nullable and `null` means "never ingested"**, which is a real state and not
 * an error: each taxonomy is a separate bulk dataset with its own weekly refresh, and the app
 * works without either — an untagged deck add simply files by card type, and a Tags page with
 * no art taxonomy says it has nothing yet.
 *
 * `checkedAt` and `ingestedAt` are separate because a 304 moves only the former. Collapsing
 * them would make an up-to-date taxonomy read as due on every launch and cost one API call per
 * start.
 *
 * **One interface for both datasets because Rust has one struct for both** — `tags::TagStatus`,
 * which `tags/oracle.rs` and `tags/art.rs` each re-export under their own name. Two hand-copied
 * mirrors of one struct is the drift this whole file is written to avoid, and it would be a
 * drift nothing could catch: the two shapes would stay compatible for as long as they were
 * identical and part in silence the day one gained a field.
 */
export interface TagStatus {
  /** Scryfall's own stamp for the file these rows came from. */
  updatedAt: string | null;
  /** Unix **seconds**. `null` = the taxonomy has never been ingested. */
  ingestedAt: number | null;
  /** Unix **seconds**. Moves on a 304; `ingestedAt` does not. */
  checkedAt: number | null;
  tagCount: number | null;
  taggingCount: number | null;
  stale: boolean;
  /** A refresh **of this dataset** is in flight right now. The two taxonomies are separate
   *  files on separate schedules, so either may be refreshing while the other is. */
  refreshing: boolean;
}

/** `tags::oracle::OracleTagStatus` — what a card *does*. {@link TagStatus} under the name the
 *  command answering it carries. */
export type OracleTagStatus = TagStatus;

/** `tags::art::ArtTagStatus` — what an illustration *depicts*. The same shape again, and the
 *  larger of the two files: ~12.5 MB gzipped against the oracle taxonomy's ~5.85 MB. */
export type ArtTagStatus = TagStatus;

/** `tags::PHASES` — the five a taxonomy refresh emits, against `SyncPhase`'s eight. */
export type TagPhase = "checking" | "downloading" | "ingesting" | "done" | "error";

/** {@link TagPhase} under the name callers spelled before the art taxonomy existed. Both
 *  datasets emit the same five, because they are one `PHASES` in the crate. */
export type OracleTagPhase = TagPhase;

/**
 * Payload of a taxonomy's progress event — `tags::TagProgress`.
 *
 * A progress event of its own rather than a ninth `SyncPhase`, following `marketplace:progress`'
 * precedent for the same reason: the card sync's phase list is a closed union mirrored by hand
 * on this page, and a dataset with its own schedule has no business widening it.
 *
 * **Each taxonomy has its own channel** — `oracle-tags:progress` and `art-tags:progress`. One
 * shared line would have the two fighting over it, since either may refresh while the other is.
 */
export interface TagProgressEvent {
  phase: TagPhase;
  done: number;
  total: number;
}

/** Payload of `oracle-tags:progress`. */
export type OracleTagProgressEvent = TagProgressEvent;

/** Payload of `art-tags:progress`. */
export type ArtTagProgressEvent = TagProgressEvent;

/**
 * Which taxonomy a tag came from — `tags::query`'s `namespace`, as a hit carries it.
 *
 * **Never `"both"`.** That is an *input*: `tagSearch` and `tagChildren` accept it and mean
 * "ask each of them", and a hit always came from exactly one. The two are separate files with
 * separate id spaces that share plenty of slugs — `dog` is in both and they mean different
 * things by it — so a stored mute names one namespace and a breadcrumb that lost this field
 * would climb the wrong tree.
 */
export type TagNamespace = "art" | "oracle";

/**
 * How strong an art match has to be — `filters::CardFilters::art_weight_floor`.
 *
 * `"strong"` drops the closure rows Scryfall called `weak`, which their docs define as "the
 * subject is a minor detail or background element". **It is a floor and not a narrowing to
 * strong matches**: the predicate is `weight <> 'weak'`, so `median` — 462 008 of 475 163 art
 * taggings, measured 2026-08-20 — is admitted. Any control built on this must say it excludes
 * background detail; "strong matches only" would be a promise the query does not keep.
 *
 * Anything else, this union's `"any"` included, is no floor at all: an unrecognised value fails
 * **open**, showing more rather than hiding cards nobody would report missing.
 *
 * **The art side only, and the include side only.** `oracle_tag_cards` carries no `weight`
 * column at all — oracle taggings are 99.7 % `median` — and "not a dog" means not a dog at all,
 * so a floor on an *exclude* would let weak dogs back into a result the reader asked to have
 * none in.
 */
export type ArtWeightFloor = "any" | "strong";

/**
 * One taxonomy's tag chips: the tags a row must carry, and the tags it must not.
 *
 * **`include` INTERSECTS.** A themed deck asks for dogs AND snow, so each included slug is its
 * own `EXISTS` rather than one `slug IN (…)` — which is the union, and would answer a superset
 * that looks plausible. `exclude` is the same subquery under `NOT EXISTS`, and the two lists AND
 * with each other and with every other filter.
 *
 * Both lists are `#[serde(default)]` on the Rust side, so naming one omits the other, and an
 * absent `artTags`/`oracleTags` adds no SQL at all. Blanks are dropped and the rest sorted and
 * deduplicated (`filters::picked_tags`), so an empty list means "no filter" and never "match
 * nothing".
 *
 * **Both taxonomies are matched through their pre-flattened closure**, so a query for a parent
 * tag answers the cards tagged only with its children — `dog` is directly tagged on 137
 * illustrations and reaches 439, and `removal` has *zero* direct taggings while answering 6 686
 * cards (both measured 2026-08-20).
 */
export interface TagTerms {
  include?: string[];
  exclude?: string[];
}

/**
 * A tag named from somewhere else — enough to draw a breadcrumb and to ask about it again.
 * `tags::query::TagRef`.
 */
export interface TagRef {
  slug: string;
  label: string;
  namespace: TagNamespace;
}

/**
 * One tag a reader named in a card search box — `tags::query::TagLookup`, the ask half of
 * {@link ipc.tagResolve}.
 *
 * `queryLanguage.ts`'s token minus what is the *box's* business: where the term sat in the string,
 * and whether it was negated. Resolution answers "is there such a tag"; which of
 * {@link TagTerms}' two lists the slug lands in is decided in TypeScript, because that is a
 * conclusion rather than a fact.
 */
export interface TagLookup {
  /** **Never `"both"`**, unlike {@link ipc.tagSearch}'s: a typed `o:` names one taxonomy, and
   *  answering across both would let `otag:dog` filter by the picture. */
  namespace: TagNamespace;
  /** What the reader typed after the keyword. Normalised by Rust, never here — two copies of
   *  that rule would leave both halves self-consistent and the search matching nothing. */
  value: string;
}

/**
 * One tag, as the Tags page draws it — `tags::query::TagHit`.
 *
 * Answered by both {@link ipc.tagSearch} and {@link ipc.tagChildren}, and a muted tag is absent
 * from both, from `childCount` and from anyone's `parents`. Muting hides a *tag*; it never hides
 * a card, and nothing in the card filters consults the mute table.
 */
export interface TagHit {
  slug: string;
  /**
   * Scryfall's stable uuid, and **the only thing a mute may be keyed on** — their docs say "do
   * not treat tag slugs or labels as permanent identifiers". A mute keyed on a slug un-mutes
   * itself the week the tag is renamed, which is exactly the week it mattered.
   *
   * **`""` is a real value**: `oracle_tags.id` was added by an `ALTER TABLE` that could not add
   * a `NOT NULL` column without a default, so every row that predates a refresh by a build new
   * enough to write ids still carries the empty string. Such a tag is *unmutable* — {@link
   * ipc.tagMute} refuses it in words — and the next refresh repairs it. That refusal is
   * deliberate: one stored mute with a blank id would otherwise equal every one of those rows
   * and take the whole taxonomy off the page with nothing logged.
   */
  id: string;
  label: string;
  /** Never `"both"` — see {@link TagNamespace}. */
  namespace: TagNamespace;
  description: string | null;
  /**
   * How many subjects the tag reaches **through the closure** — illustrations for the art
   * taxonomy, oracle ids for the oracle one, and in neither case a count of *printings*.
   *
   * The direct taggings are the wrong number and they look right: a category tag has none of
   * its own, so counting them would report `dog: 137` where the closure reaches 439, and
   * `removal: 0` where it answers 6 686.
   */
  cardCount: number;
  /** Direct children that are not muted, so a disclosure triangle drawn from this never opens
   *  onto nothing. */
  childCount: number;
  /**
   * Every parent, not the first one — **43 % of art tags have more than one** (4 970 of 11 531,
   * measured 2026-08-20), so a tag reached through one branch of the rail routinely sits under
   * another as well and a single-parent breadcrumb would be wrong for two tags in five.
   */
  parents: TagRef[];
}

/**
 * One muted tag, as Settings lists it — `tags::muted::MutedTag`.
 *
 * Every field is stored rather than joined, which is the point of the table: a taxonomy that has
 * been rebuilt since — or never fetched on this machine at all — must still be able to show the
 * reader what they hid and offer to give it back.
 */
export interface MutedTag {
  /** The two taxonomies are separate files with separate id spaces, so one uuid appearing in
   *  both is two mutes. */
  namespace: TagNamespace;
  /** Scryfall's stable uuid — the key, with the namespace. */
  tagId: string;
  /** The slug as it read when the mute was made. Display only, and possibly stale by design. */
  slug: string;
  /** Unix **seconds**. */
  mutedAt: number;
}

/** The tags commands — spread into `ipc` by `../ipc.ts`, which is the only reader of this object. */
export const tagCommands = {
  /**
   * The Oracle tags for a set of **printings** — the read every categorising call site makes.
   *
   * **Match the answers back by `cardId`, never by position.** Blank ids and duplicates are
   * dropped, so the answer is one entry per *distinct* id and `result.length` can be shorter
   * than what was asked. Reading `result[i]` against `input[i]` works right up until a caller
   * sends the same card twice — which a decklist with two printings of one card does.
   *
   * One statement per 500 ids, so a whole import asks once. An unknown id answers `slugs: []`
   * rather than being absent, because {@link CardTags} makes "no tags" and "no such card" the
   * same answer on purpose.
   */
  oracleTagsForPrintings: (cardIds: string[]) =>
    invoke<PrintingTags[]>("oracle_tags_for_printings", { cardIds }),
  /**
   * The same read keyed by oracle id, for a caller holding one — `DeckCard.oracleId`, a
   * wishlist row. Same contract, same match-by-id rule.
   */
  oracleTagsForCards: (oracleIds: string[]) =>
    invoke<CardTags[]>("oracle_tags_for_cards", { oracleIds }),
  /**
   * The taxonomy's freshness. Reads one small table, makes no network call, and **is safe
   * before the first refresh has ever run** — a database with no meta row answers every field
   * `null` with `stale: true` rather than rejecting, so no caller needs a guard.
   *
   * **Nothing in `ipc` starts a refresh, and that absence is not a gap.** The launch fetches the
   * taxonomy uninvited (`tags::oracle::refresh_if_due`) and no page ever asked for it again, so
   * the `oracleTagsRefresh` wrapper that stood beside this — and its art twin — was called only
   * from tests and one story, and was removed on 2026-09-27. The
   * `oracle_tags_refresh` command itself stays registered, and a failed fetch still leaves the
   * previous taxonomy in place, the type-line fallback always available.
   */
  oracleTagsStatus: () => invoke<OracleTagStatus>("oracle_tags_status"),
  /**
   * The taxonomy being fetched, phase by phase — beside `sync:progress`, `marketplace:progress`
   * and `update:progress`.
   *
   * **Subscribe once**, like all three: every extra call is another `listen` registration for
   * the life of the app. Tauri drops events emitted before the webview registered its listener
   * and the startup refresh can begin before this window has one, so
   * {@link ipc.oracleTagsStatus} is the reliable half of the pair.
   */
  onOracleTagProgress: (cb: (e: OracleTagProgressEvent) => void): Unlisten =>
    core.listen<OracleTagProgressEvent>("oracle-tags:progress", cb),
  /**
   * The **art** taxonomy's freshness — {@link ipc.oracleTagsStatus} one dataset over, and safe
   * before the first refresh for the same reason: a database with no meta row answers every
   * field `null` with `stale: true` rather than rejecting.
   *
   * A never-ingested art taxonomy is not a failure. It is what every install is on its first
   * launch and what a machine that cannot reach Scryfall stays in, and the honest answer to it
   * is a Tags page that says it has nothing yet.
   */
  artTagsStatus: () => invoke<ArtTagStatus>("art_tags_status"),
  /**
   * The art taxonomy being fetched, phase by phase — a channel of its own beside
   * `oracle-tags:progress`, because either taxonomy may be refreshing while the other is.
   *
   * **Subscribe once**, like every other listener here. Tauri drops events emitted before the
   * webview registered a listener and the startup refresh can begin before this window has one,
   * so {@link ipc.artTagsStatus} is the reliable half of the pair.
   */
  onArtTagProgress: (cb: (e: ArtTagProgressEvent) => void): Unlisten =>
    core.listen<ArtTagProgressEvent>("art-tags:progress", cb),
  /**
   * Type-ahead over the tag taxonomies — the Tags page's search box.
   *
   * `namespace` is `"art"`, `"oracle"` or `"both"`, and **`"both"` puts art first on an equal
   * rank**: the page's job is an art theme, so a reader who types `dog` means the illustrations
   * and the oracle tag of the same name is the secondary reading.
   *
   * **Substring, not prefix, and that is a deliberate departure from Scryfall** — verified live
   * 2026-08-20, `otag:remov` 404s and `otag:*spot*` answers nothing, so there is nothing to
   * borrow and a reader told "no such tag" until they spell `dogs-of-war` exactly is not using a
   * search box. The exact hit is ranked first, then the prefix hits, then the rest.
   *
   * **An empty or all-punctuation `text` matches every tag rather than none**, so an untouched
   * box answers the tags with the widest reach. `limit` caps the *merged* answer.
   */
  tagSearch: (text: string, namespace: TagNamespace | "both", limit: number) =>
    invoke<TagHit[]>("tag_search", { text, namespace, limit }),
  /**
   * One level of the tag tree: the children of `slug`, or the **roots** when it is `null`.
   *
   * Unlimited, deliberately — this draws one level of a tree (3 219 art roots, measured
   * 2026-08-20) and an arbitrary cut would silently lose branches.
   *
   * A tag with several parents is listed under every one of them, which is the honest reading of
   * a graph rather than a tree; its {@link TagHit.parents} name the rest so the rail can say so.
   * **A muted tag takes its subtree off the rail with it** — its children are not roots and no
   * other path reaches them unless they have a second parent. That is recoverable by unmuting,
   * and the children stay findable through {@link ipc.tagSearch}.
   */
  tagChildren: (namespace: TagNamespace | "both", slug: string | null) =>
    invoke<TagHit[]>("tag_children", { namespace, slug }),
  /**
   * Turn tag names typed into a card search box into the slugs {@link SearchRequest.artTags} and
   * {@link SearchRequest.oracleTags} match on — `queryLanguage.ts`'s tokens, resolved.
   *
   * **One answer per ask, in the order asked, `null` where there is no such tag.** The misses
   * ride along rather than being filtered out, because the box has to be able to name the token
   * it could not find and a shortened list cannot say which one is missing.
   *
   * **Exact, where {@link ipc.tagSearch} is a substring, and the difference is the job.** That
   * one is a type-ahead and should find `removal` from `remov`; this one builds a *filter*, and
   * a substring here would resolve one token to many tags that would have to be ORed — while
   * every tag filter in this app intersects, so `atag:dragon` would silently also answer
   * `dragonborn`. Separators and case are still noise (`otag:"spot removal"`,
   * `otag:spot-removal` and `otag:SPOT-REMOVAL` are one tag, verified live 2026-08-20), because
   * Rust matches through `slug_norm`.
   *
   * **A muted tag still resolves.** Muting hides a tag from the search box and the rail; it is
   * documented never to hide a *card*, and nothing in the card filters consults that table. A
   * reader who spells a tag out has named it rather than browsed onto it.
   *
   * A blank or all-punctuation value answers `null` and never a tag — see the Rust for why that
   * is a guard rather than an accident.
   */
  tagResolve: (asks: readonly TagLookup[]) => invoke<(TagRef | null)[]>("tag_resolve", { asks }),
  /**
   * Stop offering a tag anywhere — Scryfall asks downstream apps for this in as many words,
   * because Tagger is crowdsourced and they cannot guarantee the data is free from abuse.
   *
   * **Keyed on {@link TagHit.id}, never on the slug**, and a blank id is refused in words rather
   * than stored: one row with an empty `tagId` would equal every un-refreshed `oracle_tags` row
   * and take the whole taxonomy off the page silently. `slug` rides along so Settings can name
   * the tag later without joining a taxonomy that may since have been rebuilt or emptied.
   *
   * Idempotent by `(namespace, tagId)`: muting an already-muted tag refreshes the stored slug and
   * the timestamp, which is what makes a rename harmless.
   */
  tagMute: (namespace: TagNamespace, tagId: string, slug: string) =>
    invoke<void>("tag_mute", { namespace, tagId, slug }),
  /** Offer a tag again. A tag that was never muted is **not** an error — the row is gone either
   *  way, and a Settings list that raced a second window is not worth shouting about. Unlike
   *  {@link ipc.tagMute} this accepts a blank `tagId`, because a row with one is unreachable by
   *  any tag it was meant to name and junk to delete is all it can ever be. */
  tagUnmute: (namespace: TagNamespace, tagId: string) =>
    invoke<void>("tag_unmute", { namespace, tagId }),
  /** Everything the reader has hidden, for the Settings list that gives it back — by taxonomy,
   *  then by the stored slug, because this list exists to be searched by eye. */
  tagsMuted: () => invoke<MutedTag[]>("tags_muted"),
};
