# Draft & Packs

A desktop page with a rail row of its own (no chord — `keyboard-shortcuts.md` says why), built
2026-10-29 at the owner's request: draft a pool from boosters or a cube list against phase.rs's
draft bots or with people in a pod, build it into a deck in the deck editor without the collection
or the card search, save or export the deck; and open a booster or a box of any set and product,
and compare it with what that product is worth on average (botbox.dev's idea). The binding rules
are in [`packages/ui/features/draft/CLAUDE.md`](../../packages/ui/features/draft/CLAUDE.md) and
[`crates/grimoire-play/CLAUDE.md`](../../crates/grimoire-play/CLAUDE.md); the design is
[the spec](../superpowers/specs/2026-10-29-draft-and-packs-design.md). This page holds the reasons
and the figures.

## Contents

- [Booster data: MTGJSON](#booster-data-mtgjson)
- [One collation, and the math in TypeScript](#one-collation-and-the-math-in-typescript)
- [The draft: phase.rs's draft-core](#the-draft-phasers-draft-core)
- [The draft deck](#the-draft-deck)
- [Pods and lobby codes](#pods-and-lobby-codes)
- [What is not there yet](#what-is-not-there-yet)

## Booster data: MTGJSON

**MTGJSON's per-set file is the only public source that describes boosters as print sheets and
weights**, every product of a set (play, draft, set, collector, jumpstart, box topper, prerelease…)
and the sealed products that hold them (boxes, cases, bundles). Scryfall describes printings, not
products. phase.rs reads the same files for its own draft pools (`draft-core`'s `extraction.rs`,
which keeps the draftable product alone); this app keeps every product, because the Packs page
opens any of them.

- `https://mtgjson.com/api/v5/{CODE}.json.gz`, measured 2026-10-29: `HOB.json.gz` is 646 KB, 2.7 MB
  of JSON. A sheet names cards by MTGJSON `uuid`; the set's `cards[]` and `tokens[]` map each to a
  Scryfall id. A sheet may name another set's cards (`sourceSetCodes` — HOB's box topper is HOC's),
  so those files are fetched too.
- Parsed and joined to the corpus in `crates/grimoire-core/src/boosters.rs`; fetched and cached by
  the desktop host (`packs/`) under the data dir, `boosters/{CODE}.json.gz`, for 7 days.
- **Optional by construction**: nothing is asked until a reader picks a set on the Packs page or for
  a draft's pack. A failure is a sentence on that page and a Retry.
- Checked against the real HOB + HOC files: 4 products (box topper, collector, play, prerelease),
  21 sealed products kept (kits and welcome decks with no booster dropped), 423 distinct cards.

What the parse drops, and why: a sheet card whose `uuid` maps to no Scryfall id (its weight leaves
the sheet), a product left with no sheet, a variant naming a dropped sheet, a sealed product that
holds no booster directly or through what it holds (worked out to a fixed point, so master case →
case → box → pack holds whatever order the file lists them in), and `variable` contents.

## One collation, and the math in TypeScript

`features/draft/booster/open.ts` opens a booster for both halves of the page: a variant by weight;
each slot draws `count` cards from its sheet by weight, without replacement unless the sheet allows
duplicates; a `fixed` sheet gives every card `weight` times; `balanceColors` draws one card of each
colour first when the slot holds five or more. A drafted booster is therefore collated exactly as an
opened one.

The figures (`value.ts`) are conclusions, so they are TypeScript's: Rust answers the sheets and the
weights, `printing_prices` answers the prices at the reader's marketplace, and the page computes

- **expected value** — per sheet the weighted mean price, × the slot's count, summed per variant and
  weighted by the variant; a colour-balanced slot counts its one card of each colour from that
  colour's cards, as it is opened. Found on the story's own figures (2026-10-29): without it the
  theory read $676 against a simulated $1,076, the fake's only red common being a $620 Lightning
  Bolt;
- **standard deviation** — per variant `Σ count · Var(sheet)` plus the variance of the variant means
  (draws with replacement: an approximation the simulation corrects);
- **the simulation** — 10 000 boosters opened with a fixed seed (the figures do not move between
  presses), sorted; the median, the opened pack's percentile (mid-rank), the chance to beat a price
  the reader types, and a histogram (equal bins to the 99th percentile, the tail folded into the
  last);
- a sealed product's figures as the sum of its boosters'.

A card opened from a foil sheet is priced foil, else nonfoil, else etched; an unpriced card counts 0
and is drawn with an em dash. A card MTGJSON knows and this corpus does not (`inCorpus: false`) has
no image and no price, and is never dealt into a draft.

## The draft: phase.rs's draft-core

`crates/grimoire-play/src/draft/` runs one draft over `draft-core`, from phase.rs's repository at
the same `rev` as the engine and the AI (the three move together). **The page deals the boosters**
and hands them over as printing ids; a `PackSource` of this crate's hands draft-core exactly those.
A card's instance id is `"{cardId}#{seat}.{round}.{index}"`, so a guest's app finds the printing in
its own corpus.

**The bots are phase.rs's, ported.** Its pick-and-pass bot lives in `draft-wasm`, a `cdylib` that
cannot be linked, so `bots.rs` carries the same strategies — Very Easy random, Easy by rarity,
Medium and Hard `phase_ai::draft_eval` quality plus colour and curve, Very Hard stricter on colour —
over a `CardDatabase` of the draft's own cards. Their dice are seeded from the setup's seed, the
cards picked so far and the seat, with nothing stored, so a restored draft picks exactly as the
original would have.

| Mode | draft-core | Seats it allows |
| --- | --- | --- |
| Quick (sets, you + 7 bots) | `Quick`, set source | 2–8 |
| Cube (a pasted list, you + bots) | `Quick`, cube source | 1–255 |
| Sealed (six boosters into your pool) | `Sealed` | exactly 6 boosters; a lone seat is padded with a hidden bot that opens six empty ones |
| Pod (people from a lobby, bots in the empty seats) | `Premier` with bot seats | 2–8 |

A refused pick changes nothing (the session is cloned and put back on any error). A solo draft is
saved after each change (`app_meta` `draft_session`) and can be resumed; a pod cannot.

## The draft deck

A finished pool becomes a **virtual** Limited deck (`draft_deck::create`): nothing is allocated and
nothing reaches the collection, which is the owner's rule. It has a **Deck** pile (main, the
default, drawn while empty) and the deck's own Sideboard renamed **Pool** (one `side` pile per list
is all `idx_deck_categories_kind` allows), holding the whole pool.

Until the reader saves it, its id is on `app_meta` `draft_decks` (never synced), and the editor is in
**draft mode**: no card search dock (neither the corpus search nor the Collection tab), no Quick Add,
no import, no `Add to ▸ Collection/Wishlist`, and `DraftDeckBar` in their place — basics from a
printing of the draft's sets, **Save deck** (off the list: a deck like any other), **Export** (the
editor's own dialog) and **Discard** (deleted; refused for a deck not on the list, so a stale page
cannot delete a saved one).

## Pods and lobby codes

The host's app runs the draft; each guest's app receives its own seat's view and sends its picks.
The relay's `Lobby` Durable Object (`infrastructure/relay/src/lobby.ts`) routes frames between one
host and up to seven guests and knows nothing of a draft. **Creating a lobby is a supporter's**: the
host sends the relay's access token, which the relay mints only for an active or grace membership.
**Joining needs only the code** (six characters of `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`). A lobby lives
six hours. The frames and close codes are the spec's §6; the relay's README has the routes and what
is stored (the roster, for the lobby's life).

The webview reaches no host but its own (the desktop CSP), so the socket is the host's: a task per
lobby in `apps/desktop/src-tauri/src/draft/lobby.rs` that applies a guest's pick to the draft and
sends every seat its view, and tells the page through `lobby:state` and `draft:view`.

## What is not there yet

- Commander Draft and Winston Draft (draft-core has both; neither is offered).
- Playing the drafted deck against the bots' decks; the deck can be goldfished or playtested
  against a deck of the reader's from the editor as any deck can.
- A sealed product's own price: the Packs page asks the reader what they paid.
- A pod's draft is not resumable after the host's app closes.
- The relay's refusal of a guest with 4003/4004 (accept, then close) has run under the test fake and
  not yet under workerd.
