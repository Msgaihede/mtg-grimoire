# Card images on the web target — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`)
> syntax for tracking.

**Goal:** Make the search wall draw card art in a browser. Today it draws nothing at all.

**The decision this is built on**, taken by Markus on 2026-08-29 after the first framing of the
question turned out to rest on a false premise: **carry the image URI on the list DTO now, and
route a command later.** The alternatives — routing `card_image_uri`, or porting `card.rs`
wholesale first — are recorded with their costs in the conversation and summarised below.

**Spec:** [cross-platform](../specs/2026-08-27-cross-platform-design.md) §5.1 and §6.3;
[pwa-shell.md](../../reference/pwa-shell.md)'s "The image route has no caller yet".

---

## Why images are broken on web, precisely

Two independent reasons, and **shipping a wasm core fixes neither**. This was the question that
had to be answered before the shape could be chosen, and getting it wrong is what made the first
framing of this task wrong.

1. **`mtgimg://` is a Tauri custom protocol.** `cardImageUrl` (`src/lib/images.ts:79`) returns
   `mtgimg://localhost/<variant>/<id>/<face>` — or `http://mtgimg.localhost/...` on Windows and
   Android. A protocol handler is registered natively with the webview; **wasm cannot register a
   URL scheme with a browser.** The URL has to change on web whatever the core can do.
2. **The modules that would answer are not in the wasm build.** `card` and `images` are both
   `#[cfg(not(target_family = "wasm"))]` (`src-tauri/src/lib.rs:50`, `:73`), so
   **`card_image_uri` does not exist there** and neither does the byte cache. And
   `src-tauri/src/web/route.rs`'s `COMMANDS` is `["sync_status", "search_cards", "list_sets",
   "facet_cards"]` — four of the app's 152, its own doc calling it *"a first slice and not the
   whole surface."*

**The half that is already built and waiting.** `vite.sw.config.ts:50` defaults
`__IMAGE_ORIGIN__` to `https://cards.scryfall.io` and `src/pwa/sw.ts:98` routes on it, so PR 5's
256 MB LRU cache is correct and has simply had nothing to intercept. **This plan gives it a
caller and adds no caching of its own.**

## What is in scope, and the one line that decides it

**Only `CardSummary`.** `search_cards` is the one card-bearing command routed on web, so the
search wall is the one wall that can work today. The collection's, the wishlist's and the deck
editor's walls do not function in a browser at all — adding the field to their DTOs would widen
three payloads on desktop and change nothing anywhere.

**Deliberately out:** the card pane, `PrintingPreview` and the cover pickers. They reach a card
outside a list and need `card.rs` commands that are gated out of the wasm build; they are the
"command later" half and belong with whatever ports that module.

---

## Three traps, each found by reading the shipped code and each able to ship a silent bug

**Read these before writing anything. Two of them produce wrong pictures rather than missing
ones, which is the worse failure.**

### 1. The face precedence is face-first, not top-level-first

`images::resolve` (`src-tauri/src/images.rs:284`) is:

```rust
if let Some(uri) = face.or_else(|| (key.face == 0).then_some(top).flatten()) {
```

where `face` is `json_extract(face_image_uris, '$[' || ?3 || '].' || ?2)` and `top` is
`json_extract(image_uris, '$.' || ?2)`. **The face wins and the top-level is the fallback**, and
its comment says why: *"a transform's back exists only on the face, and a `meld` card's
top-level image is its front and nothing else."*

So face 0's expression is `COALESCE(face_image_uris[0].<variant>, image_uris.<variant>)` — **in
that order**. Reversing it draws the wrong picture for meld cards rather than no picture, and
nothing on screen says so.

### 2. `is_fetchable` is part of the rule, not a detail

`resolve` filters the URI through `is_fetchable` before answering, because *"a URI this cache
cannot version — or one from a host that does not serve card art — is Scryfall saying 'no image'
in a shape that looks like a picture."* A `soon.jpg` placeholder is the case. **A DTO that skips
this hands the browser a URL that 200s with something that is not the card.**

### 3. `images.rs` does not compile for wasm, so `search.rs` cannot call it

`search.rs`, `card_row.rs` and `filters.rs` are ungated and compile for wasm; `images.rs` is
`#[cfg(not(target_family = "wasm"))]`. **So the resolution rule cannot simply be called from the
search query, and it must not be copy-pasted either** — a second implementation of a precedence
rule is exactly the drift this repo's golden-fence rule exists to prevent.

**The move is to lift the pure part out**, not to duplicate it: the SQL expression, the
face/top precedence and `is_fetchable` are pure over a `Connection` and a `&str`. They go in a
module that compiles everywhere, and `images.rs` keeps the caching, the placeholders and the
protocol handler — which are the genuinely desktop-only half.

---

## Task 1: Lift the image-URI resolution rule somewhere wasm can reach it

**Files:** `src-tauri/src/images.rs` (move out of), a module that compiles for wasm (into),
`src-tauri/src/lib.rs` (module map).

- [ ] **Step 1** — Identify the smallest pure slice: the `json_extract` pair, the face/top
      precedence, and `is_fetchable`. Everything about the cache directory, the placeholders and
      the Tauri protocol stays where it is.
- [ ] **Step 2** — Move it to an ungated module. **Do not add `#[cfg]` to the new home** — the
      point is that both targets compile it. `web/route.rs`'s own header explains the reasoning
      for the sibling case: *"a module gated to `wasm32-unknown-unknown` is invisible to
      `cargo test`."*
- [ ] **Step 3** — Have `images::resolve` call the lifted function so there is **one**
      implementation. Its existing tests (`a_card_with_no_image_uris_column_is_none` and the
      neighbours in `card.rs:1655+`, plus whatever covers `resolve`) must pass unchanged; if one
      needs editing, that is a signal the slice was cut in the wrong place.
- [ ] **Step 4 — mutation** — break the precedence (swap `face` and `top`) and confirm a test goes
      red naming meld or a transform. **If nothing fails, the precedence is untested and that is
      the finding** — write the test before going on, because Task 2 depends on this rule being
      fenced.
- [ ] **Step 5** — `cargo test`, then `cargo fmt` and `cargo clippy` (neither is in
      `npm run verify`, and both run in CI). Commit.

## Task 2: `CardSummary` carries the front face's image URIs

**Files:** `src-tauri/src/search.rs`, `src/lib/ipc.ts`, `src/lib/ipc.test.ts`.

**The shape, decided here and open to being overruled at review:** a map of variant → URL for
**face 0 only**, `None` when the card has no fetchable image.

```rust
/// The front face's image URLs, by the app's own variant names, resolved by the same
/// precedence `images::resolve` applies: the face's own entry first, the top-level
/// `image_uris` as the fallback, and a non-fetchable URI treated as no image at all.
///
/// **Face 0 only, and that is the scope rather than an omission.** The walls draw the front;
/// the flip control lives in the card pane, which is not routed on web.
pub image_uris: Option<BTreeMap<String, String>>,
```

- [ ] **Step 1** — Write the failing test first: a Rust test that a search row for a known
      single-faced printing carries a `display` URL, one for a transform card that the URL is the
      **face's** and not the top-level's, and one that a `soon.jpg` printing carries `None`.
- [ ] **Step 2** — Implement in the search query, reusing Task 1's function. **Do not add a join
      per row if a `json_extract` on the row already in hand will do** — `search.rs` already
      selects from `cards`.
- [ ] **Step 3** — Mirror it in `src/lib/ipc.ts`'s `CardSummary` as
      `imageUris?: Partial<Record<ImageVariant, string>> | null`, and add the field-name pin to
      `ipc.test.ts`. **`ipc.ts` is a hand-written mirror that nothing type-checks against the
      crate**, so the pin is the only fence.
- [ ] **Step 4 — measure the payload.** Report the JSON size of one search page before and after.
      If it is more than a few percent, say so and stop — carrying one variant rather than four is
      the fallback, and it is a cheaper change than undoing this later.
- [ ] **Step 5 — mutation** — remove the field from the Rust struct and confirm the `ipc.test.ts`
      pin goes red. Commit.

## Task 3: `images.ts` grows a web branch, and the wall passes the URL down

**Files:** `src/lib/images.ts`, `src/lib/images.test.ts`, `src/components/CardArt.tsx`,
`src/components/CardImage.tsx`, `src/features/search/CardGrid.tsx`.

- [ ] **Step 1** — Write the failing tests: on the Tauri build `cardImageUrl` still answers
      `mtgimg://`; on the web build a supplied URI is used verbatim; a missing URI is `null` and
      draws the no-art frame rather than a broken image.
- [ ] **Step 2** — Give `CardArt` an optional explicit image URL that overrides the computed one.
      **Only two shipped `<CardArt>` call sites exist** — `CardGrid.tsx:1365` and
      `GridView.tsx:381` — so this is small. `CardImage` has nine.
- [ ] **Step 3** — `GridCard` gains an optional `imageUris`; `CardGrid` passes the right variant
      through to `CardArt`. **`WALL_CARD_VARIANT` is `display`** and the reason is in that
      constant's doc comment — do not pick a different one here without answering it.
- [ ] **Step 4** — Keep the platform branch in **one** place. `images.ts`'s header already says
      the platform rule is two lines and pinned by a test; do not spread a second `__CORE__` check
      into a component.
- [ ] **Step 5 — mutation** — force the web branch on and confirm a Tauri-side test goes red.
      Commit.

## Task 4: Prove it in a browser, which is the only thing that can

- [ ] **Step 1** — `npm run verify`, serially. Never pipe it to `tail` — you get the pipe's exit
      code and a failing run reads green.
- [ ] **Step 2** — Build and serve the web target, open the search wall, and confirm **card art
      actually paints**. jsdom has no network and no service worker; a green suite says nothing
      here. Record the build, the date and what was on screen.
- [ ] **Step 3** — Confirm in DevTools that the requests go to `cards.scryfall.io` **and that the
      service worker's image route intercepts them** — that route has never had a caller, so this
      is its first exercise and the first chance to find out it does not work.
- [ ] **Step 4** — Update [pwa-shell.md](../../reference/pwa-shell.md)'s "The image route has no
      caller yet" — it now has one — and record what the cache did on a second load.

---

## Self-Review

**What this does not do.** The card pane, `PrintingPreview` and both cover pickers still draw
nothing on web, because they need `card.rs`, which is gated out of the wasm build. That is the
"command later" half of the decision and it is deliberately not smuggled in here.

**Where this could still be wrong.** The payload shape is the one call made without asking: four
URLs per row rather than one. Task 2 Step 4 measures it precisely so the decision can be revisited
cheaply, and carrying a single variant is the named fallback. If the measurement is bad, take the
fallback rather than defending the shape.

**The mutation steps are the point.** Three of them, and Task 1's is the one that matters most —
if the face precedence turns out to be untested, every later task is building on an unfenced rule,
and the bug it ships is a *wrong* picture rather than a missing one.
