//! Finding a **tag**, rather than finding a card that holds one.
//!
//! The card side of the taxonomy is [`crate::filters`]' business. This module answers the two
//! questions the Tags page itself asks — *"which tags are called something like this?"* and
//! *"what is underneath this one?"* — over both taxonomies at once, and it is the only place
//! in the crate that ranks one tag above another.
//!
//! # Substring matching is a deliberate departure from Scryfall
//!
//! Verified live 2026-08-20: `otag:remov` returns a 404, and `*` is **stripped as
//! punctuation rather than expanded** — `otag:*spot*` returns nothing while
//! `otag:"spot removal"` returns 4,907. So Scryfall offers no type-ahead over these tags and
//! there is nothing to borrow: a reader who types `dog` and is told "no such tag" until they
//! spell `dogs-of-war` exactly is not using a search box. [`tag_search`] therefore matches on
//! a substring and *ranks* the exact hit first, which is the same answer plus the ones a
//! prefix search would have thrown away.
//!
//! # Two rules that a wrong implementation would satisfy silently
//!
//! * **Count over the closure, never over the direct taggings.** The bulk file stores direct
//!   taggings only, and a category tag has none of its own: `dog` is directly tagged on 137
//!   illustrations and reaches **439**; `removal` has **zero** direct taggings and answers
//!   6,686 cards (both measured 2026-08-20). A count over `art_taggings` would report
//!   `dog: 137` and `removal: 0` — numbers that look like data, not like a bug.
//! * **The needle is normalised by [`super::normalize`], the same function the ingest wrote
//!   `slug_norm` with.** A second copy here that drifted would leave both halves
//!   self-consistent and the search matching nothing, and no test in either half would fail.
//!   That is why the import is from the engine and why this module never spells the rule out
//!   again. **There are three writers of that column, not two** — the ingest, and
//!   `schema::backfill_oracle_slug_norm`, which repairs what v20's `ALTER TABLE … ADD COLUMN`
//!   left as `''`. Anything that ever writes `slug_norm` calls that one function.
//!
//! # A blank `slug_norm` is a search that answers nothing, and it shipped once
//!
//! [Issue #180](https://github.com/Msgaihede/mtg-grimoire/issues/180). v20 added the column with
//! `DEFAULT ''` — `ALTER TABLE` cannot add a `NOT NULL` column without one — and argued the
//! value was never read, because a refresh drops and rebuilds the taxonomy wholesale. It is read
//! *here*, by the only statement in this module's search path, and the next refresh is up to
//! `super::oracle::REFRESH_INTERVAL_SECS` away. So every database that held oracle tags before
//! that step answered `[]` to every oracle needle for up to a week, while the art taxonomy —
//! created empty by the same step, so ingested in full at the first launch — worked beside it,
//! and [`run_tag_children`] went on listing the very tags the box could not find, because it
//! reads `slug`. The v22 rung is the repair. The general shape is worth carrying: **a column
//! only an ingest writes is unset on every existing database until that ingest runs**, and a
//! fresh worktree is the one place that can never show it.
//!
//! # Muting hides a tag; it never hides a card
//!
//! Scryfall asks downstream apps for a way to switch an individual tag off, because Tagger is
//! crowdsourced. Both commands here honour `muted_tags`, so a muted tag is absent from the
//! search results, from the rail, from a parent's `childCount` and from anyone's `parents`
//! list. It is **not** a card filter: [`TagHit::card_count`] still reports the muted tag's
//! full reach where it is visible at all, and nothing in [`crate::filters`] consults this
//! table. Hiding a card because one of its tags was muted would be a silent loss of results.
//!
//! The join is on the tag's **`id`**, never its slug — Scryfall's docs say "Do not treat tag
//! slugs or labels as permanent identifiers", and a mute keyed on a slug un-mutes itself the
//! week the tag is renamed, which is exactly the week it mattered.

use super::{normalize, Dataset};
#[cfg(not(target_family = "wasm"))]
use crate::sync::AppState;
use rusqlite::{params_from_iter, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
#[cfg(not(target_family = "wasm"))]
use std::sync::Arc;

/// One tag, as the Tags page draws it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TagHit {
    pub slug: String,
    /// Scryfall's stable uuid. The frontend needs it to mute the tag — see the module note on
    /// why a mute is never keyed on the slug.
    pub id: String,
    pub label: String,
    /// `"art"` or `"oracle"`. Never `"both"`: that is an input, and a hit always came from one
    /// taxonomy.
    pub namespace: String,
    pub description: Option<String>,
    /// How many subjects the tag reaches **through the closure** — illustrations for the art
    /// taxonomy, oracle ids for the oracle one. See the module note: the direct taggings are
    /// the wrong number and look right.
    pub card_count: i64,
    /// Direct children that are not muted, so a disclosure triangle drawn from this never
    /// opens onto nothing.
    pub child_count: i64,
    /// Every parent, not the first one — **43 % of art tags have more than one** (4 970 of
    /// 11 531, measured 2026-08-20), so a tag reached through one branch of the rail routinely
    /// sits under another as well, and a single-parent breadcrumb would be wrong for two tags
    /// in five.
    pub parents: Vec<TagRef>,
}

/// A tag named from somewhere else — enough to draw a breadcrumb and to ask about it again.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TagRef {
    pub slug: String,
    pub label: String,
    pub namespace: String,
}

/// A [`TagHit`] with the match quality that ordered it, which the frontend never sees.
///
/// `0` exact, `1` prefix, `2` substring. It leaves the SQL as a column because the band is
/// what `LIMIT` has to be applied *after*, and a per-namespace statement cannot see the other
/// namespace's bands.
struct Scored {
    band: i64,
    hit: TagHit,
}

/// The taxonomies a caller may name, **art first**.
///
/// Art leads because that is what the page is for: the reader is building a deck around a
/// motif and types `dog` meaning the picture. The oracle taxonomy rides along.
fn namespaces_for(namespace: &str) -> Result<Vec<(&'static str, &'static Dataset)>, String> {
    let art = ("art", &crate::tags::art::ART);
    let oracle = ("oracle", &crate::tags::oracle::ORACLE);
    match namespace {
        "art" => Ok(vec![art]),
        "oracle" => Ok(vec![oracle]),
        "both" => Ok(vec![art, oracle]),
        // An unknown namespace is an error rather than an empty list: a typo'd namespace and a
        // taxonomy that has never been fetched would otherwise be the same answer, and only
        // one of them is a bug.
        other => Err(format!("unknown tag namespace: {other}")),
    }
}

/// `true` where the tag under `alias` has not been muted, with the namespace bound at
/// `ns_param`.
///
/// **`{alias}.id <> ''` prevents one mute from hiding an entire taxonomy, silently.**
/// `oracle_tags.id` is `NOT NULL DEFAULT ''` — the v20 rung adds it with `ALTER TABLE`, which
/// cannot add a `NOT NULL` column without a default — so every `oracle_tags` row that predates
/// a refresh by a build new enough to write ids still carries `''`. Without this clause, one
/// `muted_tags` row whose `tag_id` happened to be empty would equal every one of those rows,
/// and the whole oracle taxonomy would disappear from the search box and the rail with no
/// error raised, nothing in `error_log`, and a page that simply looks like it has no data.
/// With it, a tag whose id was never written is *unmutable* — visible, wrong in a way the
/// reader can see and report, and repaired by the next refresh.
fn not_muted(alias: &str, ns_param: &str) -> String {
    format!(
        "NOT EXISTS (SELECT 1 FROM muted_tags m
                      WHERE m.namespace = {ns_param} AND m.tag_id = {alias}.id AND {alias}.id <> '')"
    )
}

/// The seven columns both commands answer with, for one taxonomy.
///
/// **Only names are interpolated** — every one of them a `&'static str` from
/// [`Dataset`], which is a `const` in this crate. The band expression is built by the two
/// callers out of literals and bound-parameter names for the same reason. Values are bound.
///
/// **`card_count` is correlated and `child_count` is grouped, and the difference is which
/// index exists.** Both closures are `WITHOUT ROWID` on `(subject_id, slug)` and both parents
/// tables on `(child_slug, parent_slug)`, so neither the count-by-slug nor the count-by-parent
/// has a path of its own — until `schema::TAG_INDEXES_SQL`'s `idx_{family}_..._slug`, which
/// covers the closure and nothing else. So the closure count is a per-row index range scan and
/// the parent count is one grouped pass over ~18 500 edges.
///
/// Measured 2026-08-20, release build, in-memory database at that day's file size (11 531 art
/// tags, 951 499 closure rows, 3 219 roots, ~18 500 parent edges):
///
/// | shape | `tag_search "dog"` (11 531 candidates) | `tag_search "tag-500-"` (11) | `tag_children` roots |
/// | --- | --- | --- | --- |
/// | grouped, no index | 271 ms | 271 ms | 281 ms |
/// | grouped, indexed | 61 ms | 52 ms | 60 ms |
/// | **correlated, indexed** | **49 ms** | **7.7 ms** | **26 ms** |
/// | correlated, no index | **531 s** | 475 ms | — |
///
/// Three things that row of numbers is the only record of:
///
/// * **The grouped form's cost is flat.** SQLite materialises the whole grouped subquery before
///   the `WHERE` narrows anything, so a needle answering 11 tags cost the same as one answering
///   11 531 — 271 ms either way. The correlated form only counts what it is about to sort, which
///   is why the narrow needle collapses to 7.7 ms.
/// * **This module and that index ship together and must never be separated.** Deleting
///   `idx_art_tag_illustrations_slug` does not make the search 4× slower, it makes it **531
///   seconds** — 11 531 candidates × a 951 499-row scan each. That is a hang, not a slowdown,
///   and it would arrive as "the app freezes when I type in the tag box" rather than as anything
///   pointing here. `the_tag_indexes_survive_an_art_tag_swap` and its oracle twin are the fence.
/// * **A two-phase shape** — match the tags first, then count only those slugs — was measured
///   and loses where it matters. It still scans the closure and adds an up-to-11 531-hole `IN`
///   on top. **Those figures are from an earlier run on a loaded machine and do not belong in
///   the table above**, so read them only against each other: in that one run it was 741 ms and
///   858 ms on the two wide needles where the grouped form was 567 ms and 423 ms (1.3× and 2.0×
///   slower), and 143 ms against 393 ms on the narrow one — it *wins* there, because it counts
///   11 slugs instead of all of them. The correlated form with the index beats it on both ends
///   (49 ms and 7.7 ms), so the narrow-needle win buys nothing. It looks like the obvious
///   simplification and is not one.
fn hit_select(ds: &Dataset, band: &str) -> String {
    let tags = ds.tags_table;
    let closure = ds.closure_table;
    let parents = ds.parents_table;
    let child_visible = not_muted("ct", ":ns");
    format!(
        "SELECT t.slug, t.id, t.label, t.description,
                (SELECT count(*) FROM {closure} c WHERE c.slug = t.slug) AS card_count,
                COALESCE(kids.n, 0)  AS child_count,
                {band}               AS band
           FROM {tags} t
           LEFT JOIN (SELECT p.parent_slug AS slug, count(*) AS n
                        FROM {parents} p
                        JOIN {tags} ct ON ct.slug = p.child_slug
                       WHERE {child_visible}
                       GROUP BY p.parent_slug) kids
                  ON kids.slug = t.slug"
    )
}

/// The whole search statement for one taxonomy, needle bound at `:needle` / `:prefix` /
/// `:contains`, namespace at `:ns`, cap at `:limit`.
///
/// **A function rather than a `format!` inside [`run_tag_search`], so a test can pin the
/// statement the command actually runs.** The test below named for the closure index reads this
/// statement's `EXPLAIN QUERY PLAN`; a copy of the SQL in the test file would have gone on
/// passing while the real one regressed.
fn search_sql(ds: &Dataset) -> String {
    // `LIKE :prefix` and `LIKE :contains` need no `ESCAPE`: the needle is [`normalize`]d, so
    // only `[a-z0-9]` reaches them and no LIKE metacharacter can survive.
    let select = hit_select(
        ds,
        "CASE WHEN t.slug_norm = :needle THEN 0
              WHEN t.slug_norm LIKE :prefix THEN 1
              ELSE 2 END",
    );
    let visible = not_muted("t", ":ns");
    format!(
        "{select}
          WHERE t.slug_norm LIKE :contains AND {visible}
          ORDER BY band, card_count DESC, t.label, t.slug
          LIMIT :limit"
    )
}

/// Order a merged answer: match quality, then reach, then art before oracle, then the label.
///
/// **Art wins an equal-rank tie** because the page's primary job is an art theme — a reader
/// who types `dog` wants the illustrations, and the oracle tag of the same name is the
/// secondary reading. The trailing slug is only there so the order is total: two tags with the
/// same label would otherwise come back in whatever order the two statements happened to
/// produce, and a list that reshuffles between identical keystrokes looks broken.
fn rank(s: &Scored) -> (i64, std::cmp::Reverse<i64>, u8, &str, &str) {
    (
        s.band,
        std::cmp::Reverse(s.hit.card_count),
        u8::from(s.hit.namespace != "art"),
        s.hit.label.as_str(),
        s.hit.slug.as_str(),
    )
}

/// Read one statement's rows, in the order SQLite produced them.
fn collect(
    conn: &Connection,
    sql: &str,
    params: &[(&str, &dyn rusqlite::ToSql)],
    namespace: &'static str,
) -> rusqlite::Result<Vec<Scored>> {
    let mut stmt = conn.prepare_cached(sql)?;
    let rows = stmt.query_map(params, |r| {
        Ok(Scored {
            band: r.get(6)?,
            hit: TagHit {
                slug: r.get(0)?,
                id: r.get(1)?,
                label: r.get(2)?,
                namespace: namespace.to_owned(),
                description: r.get(3)?,
                card_count: r.get(4)?,
                child_count: r.get(5)?,
                parents: Vec::new(),
            },
        })
    })?;
    rows.collect()
}

/// Fill in [`TagHit::parents`] for one taxonomy's hits, muted parents left out.
///
/// A second statement over the answered slugs rather than a join in the first: a tag with two
/// parents would otherwise duplicate its row, and de-duplicating in Rust after `LIMIT` has
/// already been applied would silently shorten the answer.
fn attach_parents(
    conn: &Connection,
    namespace: &'static str,
    ds: &Dataset,
    hits: &mut [Scored],
) -> rusqlite::Result<()> {
    if hits.is_empty() {
        return Ok(());
    }
    let tags = ds.tags_table;
    let parents = ds.parents_table;
    // `?1` is the namespace; the slugs start at `?2`. Positional throughout because the
    // number of holes is decided by the chunk.
    let visible = not_muted("t", "?1");
    let mut found: HashMap<String, Vec<TagRef>> = HashMap::new();
    let slugs: Vec<&str> = hits.iter().map(|s| s.hit.slug.as_str()).collect();
    for chunk in slugs.chunks(super::LOOKUP_CHUNK) {
        let holes = (2..2 + chunk.len())
            .map(|i| format!("?{i}"))
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT p.child_slug, t.slug, t.label
               FROM {parents} p
               JOIN {tags} t ON t.slug = p.parent_slug
              WHERE p.child_slug IN ({holes}) AND {visible}
              ORDER BY t.label, t.slug"
        );
        let mut stmt = conn.prepare_cached(&sql)?;
        let mut args: Vec<&str> = Vec::with_capacity(chunk.len() + 1);
        args.push(namespace);
        args.extend_from_slice(chunk);
        let rows = stmt.query_map(params_from_iter(args), |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?;
        for row in rows {
            let (child, slug, label) = row?;
            found.entry(child).or_default().push(TagRef {
                slug,
                label,
                namespace: namespace.to_owned(),
            });
        }
    }
    for h in hits.iter_mut() {
        h.hit.parents = found.remove(&h.hit.slug).unwrap_or_default();
    }
    Ok(())
}

/// The tags whose name contains `text`, best match first.
///
/// `namespace` is `"art"`, `"oracle"` or `"both"`. `limit` caps the **merged** answer: each
/// taxonomy is asked for its own top `limit` and the two are merged and cut again, which is
/// exact rather than approximate — the global top `limit` can hold at most `limit` rows from
/// either side.
///
/// An all-punctuation or empty `text` normalises to nothing, which matches every tag rather
/// than none, so an empty box answers the tags with the widest reach. That is a usable
/// starting page; the alternative, an empty list, would make the box look broken before it
/// had been typed in.
pub fn run_tag_search(
    conn: &Connection,
    text: &str,
    namespace: &str,
    limit: u32,
) -> Result<Vec<TagHit>, String> {
    let needle = normalize(text);
    let prefix = format!("{needle}%");
    let contains = format!("%{needle}%");
    let limit = i64::from(limit);

    let mut scored: Vec<Scored> = Vec::new();
    for (ns, ds) in namespaces_for(namespace)? {
        let mut hits = collect(
            conn,
            &search_sql(ds),
            rusqlite::named_params! {
                ":ns": ns, ":needle": &needle, ":prefix": &prefix,
                ":contains": &contains, ":limit": limit,
            },
            ns,
        )
        .map_err(|e| format!("could not search the {ns} tags: {e}"))?;
        attach_parents(conn, ns, ds, &mut hits)
            .map_err(|e| format!("could not read the {ns} tag parents: {e}"))?;
        scored.append(&mut hits);
    }

    scored.sort_by(|a, b| rank(a).cmp(&rank(b)));
    scored.truncate(limit as usize);
    Ok(scored.into_iter().map(|s| s.hit).collect())
}

/// The tags directly under `slug`, or the roots when there is none.
///
/// A tag with several parents is listed under **every** one of them, which is the honest
/// reading of a graph rather than a tree: `bulldog` really is both a dog and a dog of war, and
/// picking one branch to show it in would hide it from the other. Its `parents` name the rest,
/// so the rail can say so.
///
/// Unlimited, deliberately — the caller is drawing one level of a tree (3 219 art roots,
/// measured 2026-08-20) and an arbitrary cut would silently lose branches.
///
/// `"both"` looks the **same slug** up in each taxonomy, which is right for the roots and is
/// two unrelated questions for a named parent — the two taxonomies share plenty of slugs
/// (`dog` is in both) and mean different things by them. A rail that has descended into one
/// namespace should be asking about that namespace.
///
/// **A muted tag takes its subtree off the rail with it**, since its children are not roots
/// and no other path reaches them unless they have a second parent. That is the cost of muting
/// a category, it is recoverable by unmuting, and the children remain findable through
/// [`run_tag_search`].
pub fn run_tag_children(
    conn: &Connection,
    namespace: &str,
    slug: Option<&str>,
) -> Result<Vec<TagHit>, String> {
    let mut scored: Vec<Scored> = Vec::new();
    for (ns, ds) in namespaces_for(namespace)? {
        let visible = not_muted("t", ":ns");
        // No band to compute: every row here is the same kind of match.
        let select = hit_select(ds, "0");
        let parents = ds.parents_table;
        let (filter, params): (String, Vec<(&str, &dyn rusqlite::ToSql)>) = match &slug {
            Some(parent) => (
                format!("t.slug IN (SELECT child_slug FROM {parents} WHERE parent_slug = :parent)"),
                vec![(":ns", &ns), (":parent", parent)],
            ),
            // A root is a tag with no parent edge at all. `child_slug` is the primary key's
            // first column, so this is a point lookup per tag rather than a scan.
            None => (
                format!("NOT EXISTS (SELECT 1 FROM {parents} p WHERE p.child_slug = t.slug)"),
                vec![(":ns", &ns)],
            ),
        };
        let sql = format!(
            "{select}
              WHERE {filter} AND {visible}
              ORDER BY card_count DESC, t.label, t.slug"
        );
        let mut hits = collect(conn, &sql, &params, ns)
            .map_err(|e| format!("could not read the {ns} tag tree: {e}"))?;
        attach_parents(conn, ns, ds, &mut hits)
            .map_err(|e| format!("could not read the {ns} tag parents: {e}"))?;
        scored.append(&mut hits);
    }

    scored.sort_by(|a, b| rank(a).cmp(&rank(b)));
    Ok(scored.into_iter().map(|s| s.hit).collect())
}

/// One tag a reader named in the search box, and which taxonomy they named it in.
///
/// The parser's token minus everything that is the *box's* business — where it sat in the
/// string, and whether it was negated. Resolution answers "is there such a tag"; the
/// include/exclude split stays in `tagQuery.ts`, because it decides which of
/// [`crate::filters::TagTerms`]' two lists the slug lands in and nothing here needs to know.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagLookup {
    /// `"art"` or `"oracle"`. **Never `"both"`**, unlike [`run_tag_search`]'s: a typed `o:`
    /// names one taxonomy, and answering across both would let `o:dog` return the picture.
    pub namespace: String,
    /// What the reader typed after the keyword — `spot removal`, `spot-removal`,
    /// `SPOT-REMOVAL`. Normalised here rather than by the caller, for the reason the module
    /// note gives: two copies of that rule would leave both halves self-consistent and the
    /// search matching nothing.
    pub value: String,
}

/// How many tags one query may name.
///
/// [`crate::filters::picked_tags`] deliberately has **no** cap and argues why: a chip arrives
/// one press at a time from a rail, so that list cannot grow by accident. This one is built
/// from a string a reader can paste, so the assumption that paragraph rests on does not hold
/// and the cap is the difference. Far above any query anybody types — it exists so a pasted
/// wall of text is a truncated answer rather than 10 000 prepared statements.
const MAX_LOOKUPS: usize = 64;

/// Resolve typed tag names to the canonical slugs the card filters match on.
///
/// One entry per ask, **in the order asked**, `None` where that taxonomy has no such tag.
/// Every caller needs that shape rather than a filtered list: the box has to name the token it
/// could not find, and a list with the misses dropped cannot say which one is missing.
///
/// # Why this exists at all
///
/// [`crate::filters::picked_tags`] matches `slug` exactly and case-sensitively, and its doc
/// says why — a slug arrives there from the tag search's own results rather than from a
/// keyboard. Typed syntax breaks that assumption, and there were two ways to mend it: teach the
/// filter SQL to normalise, or normalise at the edge and go on handing the filter real slugs.
/// This is the second. The filter keeps one meaning of `slug` throughout the crate,
/// [`crate::index::facets`] goes on narrowing by exactly the list the search does with no
/// second copy of a normalisation to drift from it, and the caller learns *which* token was
/// unknown — which SQL that quietly matched nothing could never tell it.
///
/// # Exact, through `slug_norm` — which is Scryfall's own rule
///
/// Verified live 2026-08-20 and recorded in [the art-tags
/// research](../../../docs/superpowers/research/2026-08-20-scryfall-art-tags.md):
/// `otag:"spot removal"`, `otag:spot-removal`, `otag:spotremoval` and `otag:SPOT-REMOVAL` all
/// return exactly the same 4 907 cards, while `otag:remov` 404s and `otag:*spot*` answers
/// nothing. So separators and case are noise, and a partial name is not a tag. That is
/// [`normalize`] exactly, which is why this compares against `slug_norm` — the column the
/// ingest wrote with that same function — and never against `slug`.
///
/// **Substring matching would have been the wrong favour here.** [`run_tag_search`] does it and
/// should: the Tags page is a type-ahead, and a reader who types `dog` and is told "no such
/// tag" until they spell `dogs-of-war` is not using a search box. But a *filter* built from a
/// substring resolves one token to many tags, which would have to be ORed — and every other tag
/// filter in this app intersects, so `a:dragon` would silently also answer `dragonborn`. The
/// box offers the near misses instead, from the command that is built to find them.
///
/// # A muted tag still resolves
///
/// `muted_tags` is absent from this statement, deliberately, and this is the one read in the
/// module that leaves it out. Muting hides a tag from the search box, from the rail and from a
/// parent's `childCount`; the module note above says it is **not** a card filter and that
/// nothing in [`crate::filters`] consults that table. A reader who spells a tag out in the
/// query box has named it rather than browsed onto it, and refusing them the cards would be
/// muting doing the one thing it is documented never to do.
///
/// # A blank needle is `None`, never a query
///
/// `o:` on its own — and `o:"---"`, and every keystroke on the way to a real tag — normalises
/// to `""`. Bound into the statement that would be `slug_norm = ''`, which is **not** "no
/// rows": v20 added the column with `DEFAULT ''` and `schema::backfill_oracle_slug_norm` is
/// what repairs it, so a database between those two rungs has a whole taxonomy sitting at `''`
/// and a half-typed keyword would resolve to an arbitrary one of them. See the module note on
/// [issue #180](https://github.com/Msgaihede/mtg-grimoire/issues/180): that column has been
/// wrong before, and this is the guard that means it cannot be wrong in this direction.
pub fn run_tag_resolve(
    conn: &Connection,
    asks: &[TagLookup],
) -> Result<Vec<Option<TagRef>>, String> {
    let mut out: Vec<Option<TagRef>> = Vec::with_capacity(asks.len());
    for ask in asks.iter().take(MAX_LOOKUPS) {
        // Validated the way every other entry point here validates a namespace, so a typo'd one
        // is an error rather than a tag that does not exist — `namespaces_for` draws exactly
        // that distinction, and for exactly this reason.
        let ds = match ask.namespace.as_str() {
            "art" => &crate::tags::art::ART,
            "oracle" => &crate::tags::oracle::ORACLE,
            other => return Err(format!("unknown tag namespace: {other}")),
        };
        let needle = normalize(&ask.value);
        if needle.is_empty() {
            out.push(None);
            continue;
        }
        let tags = ds.tags_table;
        // `t.slug = :raw` leads the order as a tie-break, and it only ever fires where two tags
        // normalise onto one needle (`spot-removal` and `spot_removal` would). Preferring the
        // spelling the reader actually typed is the only non-arbitrary answer available; the
        // slug behind it makes the order total, so one query cannot answer two different tags
        // on two runs. `idx_{family}_tags_norm` covers the `WHERE`.
        let sql = format!(
            "SELECT t.slug, t.label FROM {tags} t
              WHERE t.slug_norm = :needle
              ORDER BY (t.slug = :raw) DESC, t.slug
              LIMIT 1"
        );
        let mut stmt = conn
            .prepare_cached(&sql)
            .map_err(|e| format!("could not look up the {} tags: {e}", ask.namespace))?;
        let hit = stmt
            .query_row(
                rusqlite::named_params! { ":needle": &needle, ":raw": &ask.value },
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(|e| format!("could not look up the {} tags: {e}", ask.namespace))?;
        out.push(hit.map(|(slug, label)| TagRef {
            slug,
            label,
            namespace: ask.namespace.clone(),
        }));
    }
    // Anything past the cap is answered `None` rather than dropped, so the answer still lines up
    // index-for-index with the asks and the box reports those tokens as unknown instead of
    // silently applying nothing.
    out.resize_with(asks.len(), || None);
    Ok(out)
}

// ---------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------

/// Type-ahead over both tag taxonomies.
///
/// `async` and answered on the blocking pool, like every other read in this crate: a sync
/// command body runs inline on the IPC thread and this takes `db_read`'s mutex.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn tag_search(
    state: tauri::State<'_, Arc<AppState>>,
    text: String,
    namespace: String,
    limit: u32,
) -> Result<Vec<TagHit>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = crate::sync::lock_db_read(&state);
        run_tag_search(&conn, &text, &namespace, limit)
    })
    .await
    .map_err(|e| format!("could not search the tags: {e}"))?
}

/// One level of the tag tree: the children of `slug`, or the roots when it is absent.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn tag_children(
    state: tauri::State<'_, Arc<AppState>>,
    namespace: String,
    slug: Option<String>,
) -> Result<Vec<TagHit>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = crate::sync::lock_db_read(&state);
        run_tag_children(&conn, &namespace, slug.as_deref())
    })
    .await
    .map_err(|e| format!("could not read the tag tree: {e}"))?
}

/// Turn the tag names typed into a card-search box into the slugs the filters match on.
///
/// One answer per ask, in order, `null` where there is no such tag — see [`run_tag_resolve`]
/// for why the misses ride along rather than being dropped, and for why this is exact where
/// [`tag_search`] is a substring.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn tag_resolve(
    state: tauri::State<'_, Arc<AppState>>,
    asks: Vec<TagLookup>,
) -> Result<Vec<Option<TagRef>>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = crate::sync::lock_db_read(&state);
        run_tag_resolve(&conn, &asks)
    })
    .await
    .map_err(|e| format!("could not resolve the tags: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tags::testing::mem_db;
    use rusqlite::params;

    /// Four art tags and one oracle tag, with a closure that is **internally consistent** —
    /// every count below is the union its parent edges imply, not a number typed in to make an
    /// assertion pass:
    ///
    /// ```text
    /// dog (root, 0 direct taggings)      oracle: dog     (400 oracle ids)
    ///  └─ hound      ill-0..399  (400)   oracle: bulldog  (50 oracle ids)
    ///      └─ bulldog ill-0..4     (5)
    /// dogs-of-war (root) ill-0..9 (10)
    ///      └─ bulldog  (the same tag: 43 % of art tags have more than one parent)
    /// ```
    ///
    /// **`bulldog` exists in both namespaces with the oracle one reaching ten times as far**,
    /// and that asymmetry is load-bearing rather than colour. Every other pair here ties at 400,
    /// so with only those rows the ordering could put the namespace ahead of the reach and
    /// nothing would fail — see `reach_outranks_the_namespace_inside_a_band`.
    ///
    /// So `dog`'s closure is `hound ∪ bulldog` = ill-0..399 = **400** while its own
    /// `art_taggings` rows number **zero**, which is the shape a category tag really has in the
    /// bulk file (`removal`: 0 direct, 6 686 through the closure, measured 2026-08-20).
    fn seeded_tag_db() -> Connection {
        let conn = mem_db().into_inner().unwrap();
        for (slug, id, label) in [
            ("dog", "art-dog", "Dog"),
            ("hound", "art-hound", "Hound"),
            ("dogs-of-war", "art-dogs-of-war", "Dogs of War"),
            ("bulldog", "art-bulldog", "Bulldog"),
        ] {
            conn.execute(
                "INSERT INTO art_tags (slug, id, label, description, slug_norm)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![slug, id, label, format!("About {label}."), normalize(slug)],
            )
            .unwrap();
        }
        for (child, parent) in [
            ("hound", "dog"),
            ("bulldog", "hound"),
            ("bulldog", "dogs-of-war"),
        ] {
            conn.execute(
                "INSERT INTO art_tag_parents (child_slug, parent_slug) VALUES (?1, ?2)",
                params![child, parent],
            )
            .unwrap();
        }
        // Direct taggings: what the bulk file actually carries. `dog` has none.
        for (slug, n) in [("hound", 400), ("bulldog", 5), ("dogs-of-war", 10)] {
            for i in 0..n {
                conn.execute(
                    "INSERT INTO art_taggings (illustration_id, slug, weight) VALUES (?1, ?2, 'median')",
                    params![format!("ill-{i}"), slug],
                )
                .unwrap();
            }
        }
        // The closure, with every ancestor rolled in.
        for (slug, n) in [
            ("hound", 400),
            ("bulldog", 5),
            ("dogs-of-war", 10),
            ("dog", 400),
        ] {
            for i in 0..n {
                conn.execute(
                    "INSERT INTO art_tag_illustrations (illustration_id, slug, weight)
                     VALUES (?1, ?2, 'median')",
                    params![format!("ill-{i}"), slug],
                )
                .unwrap();
            }
        }
        for (slug, id, label, n) in [
            ("dog", "oracle-dog", "Dog", 400),
            ("bulldog", "oracle-bulldog", "Bulldog", 50),
        ] {
            conn.execute(
                "INSERT INTO oracle_tags (slug, id, label, description, slug_norm)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    slug,
                    id,
                    label,
                    format!("Cares about {label}s."),
                    normalize(slug)
                ],
            )
            .unwrap();
            for i in 0..n {
                conn.execute(
                    "INSERT INTO oracle_tag_cards (oracle_id, slug) VALUES (?1, ?2)",
                    params![format!("oid-{slug}-{i}"), slug],
                )
                .unwrap();
            }
        }
        conn
    }

    /// A row written the way Task 6's `tag_mute` will write it.
    fn mute(conn: &Connection, namespace: &str, tag_id: &str, slug: &str) {
        conn.execute(
            "INSERT INTO muted_tags (namespace, tag_id, slug, muted_at) VALUES (?1, ?2, ?3, 0)",
            params![namespace, tag_id, slug],
        )
        .unwrap();
    }

    fn keys(hits: &[TagHit]) -> Vec<(&str, &str)> {
        hits.iter()
            .map(|h| (h.slug.as_str(), h.namespace.as_str()))
            .collect()
    }

    fn slugs(hits: &[TagHit]) -> Vec<&str> {
        hits.iter().map(|h| h.slug.as_str()).collect()
    }

    /// Exact before prefix before substring; within a band, by reach descending; art above
    /// oracle at equal rank, because that is what the page is for.
    #[test]
    fn tag_search_ranks_exact_then_prefix_then_substring() {
        let conn = seeded_tag_db();
        let hits = run_tag_search(&conn, "dog", "both", 10).unwrap();
        assert_eq!(
            keys(&hits),
            vec![
                ("dog", "art"),         // exact, art wins the tie against oracle at 400 each
                ("dog", "oracle"),      // exact
                ("dogs-of-war", "art"), // prefix — ahead of both bulldogs despite reaching 10
                ("bulldog", "oracle"),  // substring, 50
                ("bulldog", "art"),     // substring, 5
            ]
        );
    }

    /// Substring matching is a deliberate departure from Scryfall, whose `otag:remov` returns
    /// 404 and whose `*` is stripped rather than expanded (verified 2026-08-20). A free-text
    /// box that matched only exact slugs would not feel like a search box.
    #[test]
    fn tag_search_matches_substrings_where_scryfall_does_not() {
        let conn = seeded_tag_db();
        assert_eq!(
            slugs(&run_tag_search(&conn, "ulld", "art", 10).unwrap()),
            vec!["bulldog"]
        );
    }

    /// The count is over the CLOSURE, so a category tag with no direct taggings of its own
    /// still reports its reach. In the real file `removal` has zero direct taggings and 6 686
    /// cards; a count over the taggings table would answer `0` and look like data.
    #[test]
    fn tag_search_counts_over_the_closure_not_the_direct_taggings() {
        let conn = seeded_tag_db();
        let direct: i64 = conn
            .query_row(
                "SELECT count(*) FROM art_taggings WHERE slug = 'dog'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(direct, 0, "the fixture must reproduce a bare category tag");

        let hits = run_tag_search(&conn, "dog", "art", 10).unwrap();
        assert_eq!(hits[0].slug, "dog");
        assert_eq!(hits[0].card_count, 400);
    }

    /// **The ingest and the search have to agree, and nothing else would tell us.** `slug_norm`
    /// is written by [`super::normalize`] and the needle is reduced by the same function; two
    /// copies that drifted would each stay self-consistent and the search would simply return
    /// nothing. Each spelling below returned the same card count from `otag:` on 2026-08-20.
    #[test]
    fn tag_search_folds_every_spelling_of_a_name_onto_one_tag() {
        let conn = seeded_tag_db();
        for spelling in [
            "dogs-of-war",
            "dogs of war",
            "DogsOfWar",
            "DOGS_OF_WAR",
            "dogs.of.war",
        ] {
            let hits = run_tag_search(&conn, spelling, "art", 10).unwrap();
            assert_eq!(slugs(&hits), vec!["dogs-of-war"], "{spelling}");
        }
    }

    /// An empty box is a usable starting page rather than a broken one: everything matches, so
    /// the answer is the tags with the widest reach.
    #[test]
    fn an_empty_needle_answers_the_tags_with_the_widest_reach() {
        let conn = seeded_tag_db();
        // `dog` and `hound` both reach 400; the label breaks the tie.
        assert_eq!(
            slugs(&run_tag_search(&conn, "   ", "art", 2).unwrap()),
            vec!["dog", "hound"]
        );
    }

    /// `limit` caps the merged answer. Limiting each namespace and concatenating would return
    /// three rows here, in the wrong order.
    #[test]
    fn the_limit_is_applied_to_the_merged_answer_not_per_namespace() {
        let conn = seeded_tag_db();
        let hits = run_tag_search(&conn, "dog", "both", 2).unwrap();
        assert_eq!(keys(&hits), vec![("dog", "art"), ("dog", "oracle")]);
    }

    /// Muting is per namespace and keyed on the uuid, so the oracle `dog` survives the art
    /// `dog` being switched off.
    #[test]
    fn a_muted_tag_is_gone_from_search_in_its_own_namespace_only() {
        let conn = seeded_tag_db();
        mute(&conn, "art", "art-dog", "dog");
        assert_eq!(
            keys(&run_tag_search(&conn, "dog", "both", 10).unwrap()),
            vec![
                ("dog", "oracle"),
                ("dogs-of-war", "art"),
                ("bulldog", "oracle"),
                ("bulldog", "art"),
            ]
        );
    }

    /// A muted tag leaves the rail and stops being counted as a child — a disclosure triangle
    /// that opens onto nothing is worse than no triangle. **It does not hide a card**: `dog`
    /// still reports all 400 illustrations it reaches through the muted `hound`.
    #[test]
    fn a_muted_tag_leaves_the_rail_without_narrowing_anything() {
        let conn = seeded_tag_db();
        mute(&conn, "art", "art-hound", "hound");
        assert!(run_tag_children(&conn, "art", Some("dog"))
            .unwrap()
            .is_empty());

        let hits = run_tag_search(&conn, "dog", "art", 10).unwrap();
        assert_eq!(hits[0].slug, "dog");
        assert_eq!(hits[0].child_count, 0);
        assert_eq!(hits[0].card_count, 400);
    }

    /// A muted tag is not named as anyone's parent either — a breadcrumb is an offer, and the
    /// reader asked not to be offered this tag.
    #[test]
    fn a_muted_tag_is_not_named_as_a_parent() {
        let conn = seeded_tag_db();
        mute(&conn, "art", "art-dogs-of-war", "dogs-of-war");
        let kids = run_tag_children(&conn, "art", Some("hound")).unwrap();
        assert_eq!(slugs(&kids), vec!["bulldog"]);
        assert_eq!(
            kids[0]
                .parents
                .iter()
                .map(|p| p.slug.as_str())
                .collect::<Vec<_>>(),
            vec!["hound"]
        );
    }

    /// `oracle_tags.id` is `NOT NULL DEFAULT ''`, so a taxonomy ingested before the id was
    /// stored carries empty ids. One `muted_tags` row with an empty `tag_id` must not mute all
    /// of them — that would empty the page with no error anywhere.
    #[test]
    fn an_empty_tag_id_mutes_nothing() {
        let conn = seeded_tag_db();
        conn.execute("UPDATE oracle_tags SET id = ''", []).unwrap();
        mute(&conn, "oracle", "", "");
        assert_eq!(
            slugs(&run_tag_search(&conn, "dog", "oracle", 10).unwrap()),
            vec!["dog", "bulldog"]
        );
    }

    /// No slug means the roots, widest reach first.
    #[test]
    fn tag_children_answers_the_roots_when_no_slug_is_given() {
        let conn = seeded_tag_db();
        let roots = run_tag_children(&conn, "art", None).unwrap();
        assert_eq!(slugs(&roots), vec!["dog", "dogs-of-war"]);
        assert_eq!(roots[0].child_count, 1);
        assert!(roots[0].parents.is_empty());
    }

    /// 43 % of art tags have more than one parent, so a child is listed under each of them and
    /// names the others. Following only the first parent edge is the failure this catches.
    #[test]
    fn tag_children_names_every_parent_of_a_tag_that_has_two() {
        let conn = seeded_tag_db();
        for parent in ["hound", "dogs-of-war"] {
            let kids = run_tag_children(&conn, "art", Some(parent)).unwrap();
            assert_eq!(slugs(&kids), vec!["bulldog"], "{parent}");
            assert_eq!(
                kids[0]
                    .parents
                    .iter()
                    .map(|p| (p.slug.as_str(), p.namespace.as_str()))
                    .collect::<Vec<_>>(),
                vec![("dogs-of-war", "art"), ("hound", "art")],
                "{parent}"
            );
        }
    }

    /// **Inside a band, reach decides before the namespace does.** Both `bulldog`s are exact
    /// matches here, so only the second and third sort keys can separate them — and the oracle
    /// one reaches 50 where the art one reaches 5.
    ///
    /// Swap those two keys and this is the only test that notices, because every other pair in
    /// the fixture ties at 400. Backwards it puts a 5-illustration art tag above a 6 686-card
    /// oracle tag, which on the real corpus is `removal` losing to whatever art tag happens to
    /// share its band. Art still wins a genuine tie — `tag_search_ranks_exact_then_prefix_then_
    /// substring` pins that half at 400 each.
    #[test]
    fn reach_outranks_the_namespace_inside_a_band() {
        let conn = seeded_tag_db();
        assert_eq!(
            keys(&run_tag_search(&conn, "bulldog", "both", 10).unwrap()),
            vec![("bulldog", "oracle"), ("bulldog", "art")]
        );
    }

    /// The search **searches** the closure by slug, rather than scanning it.
    ///
    /// **Every other fence on this index is by name, and a name is not the property.** The
    /// schema tests assert `sqlite_master` holds a row called
    /// `idx_art_tag_illustrations_slug`; an index kept under that name but redefined on other
    /// columns passes every one of them while the planner quietly goes back to scanning. That
    /// is not a slower page — [`hit_select`] counts a tag's reach per row, so it is 531 seconds
    /// against 49 ms (measured 2026-08-20), a window that stops responding on the first
    /// keystroke. So this reads the plan of the statement the command actually runs.
    ///
    /// **Asserting the index is *named* in the plan is not enough, and that is measured too.**
    /// Redefining it as `ON art_tag_illustrations(weight)` — same name, wrong column — makes
    /// SQLite answer `SCAN c USING COVERING INDEX idx_art_tag_illustrations_slug`: the closure
    /// is `WITHOUT ROWID`, so any index over it carries the primary key and is *covering* for
    /// this count whatever it indexes, and the planner will happily scan the smaller b-tree.
    /// The name is right there in the plan while every row is being read. The access method is
    /// the property, so the assertion is on `SEARCH` and on the constrained column.
    #[test]
    fn tag_search_uses_the_closure_index_rather_than_scanning_it() {
        let conn = seeded_tag_db();
        for (ds, index, closure) in [
            (
                &crate::tags::art::ART,
                "idx_art_tag_illustrations_slug",
                "art_tag_illustrations",
            ),
            (
                &crate::tags::oracle::ORACLE,
                "idx_oracle_tag_cards_slug",
                "oracle_tag_cards",
            ),
        ] {
            let steps: Vec<String> = conn
                .prepare(&format!("EXPLAIN QUERY PLAN {}", search_sql(ds)))
                .unwrap()
                .query_map(
                    rusqlite::named_params! {
                        ":ns": "art", ":needle": "dog", ":prefix": "dog%",
                        ":contains": "%dog%", ":limit": 25i64,
                    },
                    |r| r.get::<_, String>(3),
                )
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap();
            let plan = steps.join("\n");
            let step = steps
                .iter()
                .find(|s| s.contains(index))
                .unwrap_or_else(|| panic!("{closure}: {index} is not in the plan:\n{plan}"));
            assert!(
                step.starts_with("SEARCH") && step.contains("(slug=?)"),
                "{closure}: the reach count is not a slug lookup — `{step}`\n{plan}"
            );
        }
    }

    /// A typo'd namespace and a taxonomy nobody has fetched must not be the same answer.
    #[test]
    fn an_unknown_namespace_is_an_error_rather_than_an_empty_list() {
        let conn = seeded_tag_db();
        assert!(run_tag_search(&conn, "dog", "arty", 10).is_err());
        assert!(run_tag_children(&conn, "", None).is_err());
        assert!(run_tag_resolve(&conn, &[ask("arty", "dog")]).is_err());
    }

    fn ask(namespace: &str, value: &str) -> TagLookup {
        TagLookup {
            namespace: namespace.to_owned(),
            value: value.to_owned(),
        }
    }

    /// The answered slugs, `None` spelled `""` so a whole run reads on one line.
    fn resolved(conn: &Connection, asks: &[TagLookup]) -> Vec<String> {
        run_tag_resolve(conn, asks)
            .unwrap()
            .into_iter()
            .map(|r| r.map_or_else(String::new, |t| t.slug))
            .collect()
    }

    /// Scryfall's own rule, verified live 2026-08-20: separators and case are noise, so all
    /// four spellings of one tag are one tag. This is the whole reason the command exists —
    /// `filters::picked_tags` compares `slug` byte for byte, and three of these four would
    /// have matched nothing.
    #[test]
    fn every_spelling_of_a_name_resolves_to_the_one_slug() {
        let conn = seeded_tag_db();
        assert_eq!(
            resolved(
                &conn,
                &[
                    ask("art", "dogs-of-war"),
                    ask("art", "dogs of war"),
                    ask("art", "dogsofwar"),
                    ask("art", "DOGS-OF-WAR"),
                    ask("art", "  Dogs Of War  "),
                ],
            ),
            ["dogs-of-war"; 5],
        );
    }

    /// The two taxonomies are separate files with separate id spaces that share plenty of
    /// slugs, and `dog` is in both. A resolver that answered across both would let `o:dog`
    /// filter by the picture — which is the one mistake this whole feature could make
    /// invisibly, since both answers are a wall of dogs.
    #[test]
    fn a_shared_slug_resolves_inside_the_namespace_it_was_asked_in() {
        let conn = seeded_tag_db();
        let out = run_tag_resolve(&conn, &[ask("art", "dog"), ask("oracle", "dog")]).unwrap();
        let namespaces: Vec<&str> = out
            .iter()
            .map(|r| r.as_ref().unwrap().namespace.as_str())
            .collect();
        assert_eq!(namespaces, ["art", "oracle"]);
    }

    /// A tag that only one taxonomy has is a miss in the other, not a fallback to it.
    #[test]
    fn a_tag_the_other_taxonomy_has_is_still_a_miss() {
        let conn = seeded_tag_db();
        assert_eq!(resolved(&conn, &[ask("oracle", "hound")]), [""]);
    }

    /// Scryfall 404s on a partial name and `run_tag_search` deliberately does not. This is the
    /// filter side, where a substring would resolve one token to many tags and have to OR them
    /// — so `hound` is unreachable from `houn`, and the box offers the near miss instead.
    #[test]
    fn a_partial_name_is_a_miss_rather_than_a_prefix_match() {
        let conn = seeded_tag_db();
        assert_eq!(
            resolved(&conn, &[ask("art", "houn"), ask("art", "ound")]),
            ["", ""],
        );
        // The same needle through the type-ahead does find it — the two are different jobs.
        assert_eq!(
            slugs(&run_tag_search(&conn, "houn", "art", 10).unwrap()),
            ["hound"]
        );
    }

    /// Every miss keeps its place, so the caller can say *which* token it could not find. A
    /// filtered list would be the same length only by accident and could name nothing.
    #[test]
    fn misses_ride_along_in_place_rather_than_being_dropped() {
        let conn = seeded_tag_db();
        assert_eq!(
            resolved(
                &conn,
                &[
                    ask("art", "nonesuch"),
                    ask("art", "hound"),
                    ask("oracle", "nonesuch"),
                ],
            ),
            ["", "hound", ""],
        );
    }

    /// `o:` on its own, and every keystroke on the way to a real tag, normalises to `""`.
    /// Bound into the statement that is `slug_norm = ''` — which on a database between v20 and
    /// v22 matches a **whole taxonomy**, so a half-typed keyword would resolve to an arbitrary
    /// tag. Seeded here the way that rung leaves it, because a fresh worktree cannot show it.
    #[test]
    fn a_blank_needle_resolves_to_nothing_even_against_an_unrepaired_slug_norm() {
        let conn = seeded_tag_db();
        conn.execute("UPDATE oracle_tags SET slug_norm = ''", [])
            .unwrap();
        assert_eq!(
            resolved(
                &conn,
                &[
                    ask("oracle", ""),
                    ask("oracle", "   "),
                    ask("oracle", "---")
                ],
            ),
            ["", "", ""],
        );
    }

    /// Muting hides a *tag* and never a card: nothing in `crate::filters` consults that table,
    /// and a reader who spells a tag out has named it rather than browsed onto it. So this is
    /// the one read in the module that a mute does not narrow — and the type-ahead beside it
    /// still hides the tag, which is what makes the difference deliberate rather than a leak.
    #[test]
    fn a_muted_tag_still_resolves_because_muting_never_hides_a_card() {
        let conn = seeded_tag_db();
        mute(&conn, "art", "art-hound", "hound");
        assert_eq!(resolved(&conn, &[ask("art", "hound")]), ["hound"]);
        assert!(run_tag_search(&conn, "hound", "art", 10)
            .unwrap()
            .is_empty());
    }

    /// Past the cap the answer still lines up index-for-index with the asks, so the box reports
    /// those tokens as unknown rather than silently applying nothing.
    #[test]
    fn asks_past_the_cap_are_answered_none_rather_than_dropped() {
        let conn = seeded_tag_db();
        let asks: Vec<TagLookup> = (0..MAX_LOOKUPS + 3).map(|_| ask("art", "hound")).collect();
        let out = run_tag_resolve(&conn, &asks).unwrap();
        assert_eq!(out.len(), asks.len());
        assert!(out[MAX_LOOKUPS - 1].is_some());
        assert!(out[MAX_LOOKUPS..].iter().all(Option::is_none));
    }

    /// Two tags normalising onto one needle is the only case the tie-break fires in, and the
    /// spelling the reader typed is the only non-arbitrary answer available. Both orders are
    /// asked, so a statement that merely happened to return the right row first would fail.
    #[test]
    fn the_spelling_the_reader_typed_wins_a_collision() {
        let conn = seeded_tag_db();
        for slug in ["spot_removal", "spot-removal"] {
            conn.execute(
                "INSERT INTO art_tags (slug, id, label, description, slug_norm)
                 VALUES (?1, ?2, ?3, '', ?4)",
                params![slug, format!("art-{slug}"), slug, normalize(slug)],
            )
            .unwrap();
        }
        assert_eq!(
            resolved(
                &conn,
                &[ask("art", "spot-removal"), ask("art", "spot_removal")],
            ),
            ["spot-removal", "spot_removal"],
        );
        // A spelling that is neither still resolves, deterministically, to the lower slug.
        assert_eq!(
            resolved(&conn, &[ask("art", "Spot Removal")]),
            ["spot-removal"]
        );
    }
}
