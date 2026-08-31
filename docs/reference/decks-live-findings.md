# Deck builder, driven in the shipped window

Moved out of the root `CLAUDE.md` verbatim, so nothing measured was lost. Every figure keeps the date and the build it was taken on.

The whole rebuild had been proven by tests and by Storybook, and **neither runs in the window
that ships**. This is what a CDP pass over the real WebView2 added, and the three bugs it found
are all things no suite could have seen.

> **Every stack pixel figure below belongs to a geometry the 2026-08-13 `CardStack.dc.html`
> redesign replaced, and none of it has been re-driven.** The data line moved out of the picture
> and became the card's foot, so a card is **319px** rather than 295, the collapsed margin is
> **−285px** rather than −261, the push-down is **293px** rather than 269, and
> `stackHeight(n)` is `34n + 293` rather than `34n + 269`. The _findings_ all survive — what was
> measured is that the margin trick pushes cards out of a box whose height does not change, that
> exactly one card moves per step, and that the open card paints behind its unmoved successors —
> and only the numbers are stale. A live number belongs to a geometry; the arithmetic that
> replaces these is pinned by `CardStack.test.tsx`.

- **The stack's push-down is real**: hovering a card moved its `margin-bottom` −278px → **8px**
  and pushed every later card down by exactly **286px**, while the list's height stayed **490px**
  across the whole gesture. `stackHeight` matched the formula for every stack on screen.
  **Every number in that sentence is superseded by the 2026-08-12 geometry** (−261 → 8, a 269px
  push-down) and the _finding_ is not: what was measured is that the margin trick pushes cards
  out of a box whose height does not change, and that is unchanged. Nobody has re-driven it.
  **Hovering a _middle_ card means pointing at its title bar** — the cards overlap, so at any y
  the topmost card is the last one whose top is above it, and `hover`'s default approach (from
  directly above the element) lands on the _first_ card of the stack and lifts that instead. Aim
  at `li > button > span:first-child` — **which the whole-card rewrite moved**: a card is one
  `<span>` holding the image now, so the strip to aim at is the card's own top ~34px rather than a
  first-child band. Approach sideways with `--from`.
- **Re-driven 2026-08-12 on a 7-card stack, after both the whole-card rewrite and the
  flip-through rebuild** — `stackHeight(7)` = `34·6 + 303` = **507px**, matched exactly and
  **unchanged through every gesture below**; cards measured 295px with every collapsed margin
  −261px, and tops at rest advanced by exactly 34px. Then, all in the shipped window:
  **opening from all-closed pushes every later card down 269px** (375 → 644); but **stepping
  from one open card to the next moves exactly one card** — card 3 travelled 467 → 198 while
  cards 0–2 _and_ cards 4–6 held their pixel positions to the unit, and the next strip stayed
  put at 502. **`[data-stack-open]` counted exactly 1 at every sample**, including
  mid-transition, so switching never shows a closed frame. **A 384px continuous sweep down the
  whole stack landed on the card it aimed at** — the defect the rebuild existed to fix. And
  leaving the stack still read an `8px` margin on the open card at arrival, collapsing to all
  `-261px` only after the rest: the close delay, visible.
  **The pre-merge run of this same pass measured 524px and 269→286px and is superseded** — it
  was driven against the 312px card, before main's geometry landed. A live number belongs to a
  geometry, and merging one branch into another can invalidate a measurement without touching
  the code that took it.
- **Paint order, measured 2026-08-12 after the z-index fix** — `document.elementFromPoint` at a
  point both the open card and its successors cover (y=541, card 2 open): **mid-tween the
  painted card is 6** and **settled it is 2**, with every card reading `z-index: auto` in both
  samples and the list reading `10`. So the open card is correctly _behind_ the cards that have
  not moved yet, and becomes visible only because they move away. **Before the fix the same
  probe answered `2` in both** — the open card took `LAYER.raised` on its first frame and jumped
  in front of the stack while the stack caught up around it. This is the shape of live check a
  paint-order bug needs: jsdom lays nothing out and paints nothing, so the whole suite was green
  on it, and a class assertion is all a test can ever hold.
- **Do not aim `hover` at the card's `<li>` — aim at its marks strip.** `cdp.mjs hover` targets
  an element's box **centre**, and a card is 319px tall in a stack that advances 34px, so the
  centre of card 2 is painted over by card 7. The strip to aim at is the marks strip — since the
  2026-08-13 redesign an `absolute top-0 left-0 right-[5px]` span, **27px** tall inside the 34px
  reveal; tag it per card and approach sideways with `--from`. This is the same trap as the old
  `span:first-child` note, two rewrites later, and it gets worse as the card gets taller — which
  it just did.
- **`data-stack-open` exists so a probe can _count_ open cards.** The CSS lift was observable
  from neither a test nor `cdp.mjs` — `userEvent.hover` never engaged `:hover`, and nothing in
  the DOM said which card was up. Count activations, never whether one happened.
- **`element.focus()` over CDP opens nothing, and it is not a bug in the component.** The window
  is in the background while it is being driven, so `document.hasFocus()` is **false** and
  Chromium sets `activeElement` without dispatching `focus` — `CardStack`'s `onFocus` never
  runs and `[data-stack-open]` stays at 0. Measured 2026-08-13: `hasFocus()` returned `false`
  while the button's `aria-label` read back correctly from the same eval, which is exactly how
  this looks like a broken keyboard path. Drive the **pointer** instead —
  `li.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))` then wait past the 70ms
  dwell — or `cdp.mjs hover --probe`, which is what the numbers above were taken with. Testing
  the caret path live needs the window actually focused.
- **To read a 210px card at a legible size, clone the pile rather than zoom the page.**
  `document.documentElement.style.zoom` reflows the editor and carries the stack out of the
  viewport; `cdp.mjs size` is fixed at `deviceScaleFactor: 1` and cannot magnify. What works is
  cloning the pile into a `position: fixed` element with its own `zoom` — inline styles and
  `data-*` attributes come with the clone, so an open card stays open in it. Remove it before
  any further probe: it is a second copy of every `[data-deck-stack]` and `[data-stack-open]`
  in the document, and it will double every count taken after it. (**The selector changed on
  2026-08-14**: `[data-stack-column]` was a box `packColumns` produced, and `StackView` stopped
  packing — `[data-deck-stack]` is one pile in the flow, and there is no wrapper box left, so a
  clone of it is a clone of the `<section>` itself.)
- **"A positioned element paints above a static sibling" is false for flex items, and only the
  window could say so.** The redesign's quantity tag has to cover the Game Changer banner tucked
  10px under its slanted tail. The first implementation did it without a z-index — tag
  `position: relative`, banner `position: static` — on that rule. Measured 2026-08-13 with
  `document.elementFromPoint` inside the overlap: the answer was **the banner**, with the tag
  computing `position: relative` and the banner `position: static`. Flex items paint as inline
  blocks in _order-modified document order_, so a later sibling wins whatever its position. The
  fix is `LAYER.overlappingMark`, which works for the same reason the trick did not: on a flex
  item a z-index other than `auto` creates a stacking context whatever its position. Re-probed
  at three depths — 5px and 8px into the overlap answer the tag, and 3px answers the banner,
  which is correct because the tag's `clip-path` has already receded there. **jsdom paints
  nothing and a class assertion cannot see any of this**; the suite was green throughout.
- **Driven 2026-08-13 after the `CardStack.dc.html` redesign, on a 10-row Commander deck**
  seeded through `import_resolve`/`deck_import_commit` over `window.__TAURI_INTERNALS__`:
  the quantity tag, the Game Changer banner, `RULE BREAK`, the data line and the stepper column
  all draw, `[data-stack-open]` counted exactly **1** across a hover, and the printed card faces
  paint over the app-drawn frame. **The pixel geometry was not re-measured** — no margin, top or
  list height was read back — so the superseded note at the top of this file still stands. Two
  defects it did find, both now fixed: the stepper was 28px with a 6px radius against the
  canvas's 24px and 8px, and the `Move…` select — which the canvas does not draw at all — sat
  beside the stepper and covered about three-fifths of the width of a 210px card face. **That
  second one is moot as of 2026-08-14**: the select was removed from every view rather than
  narrowed further, so the card's control column agrees with the canvas by having nothing in it
  the canvas does not draw. A replacement control is expected, and this measurement is what it
  has to clear.
- **Reduced motion holds**: `transitionProperty` is `none` on the view buttons under
  `prefers-reduced-motion: reduce`, while `transitionDuration` still reads `0.15s`
  — the exact false failure [live-ui-verification.md](live-ui-verification.md) warns about, reproduced here on purpose.
  **The stack card is no longer part of that claim**: its lift is `motion`-driven, so there is
  no CSS transition to probe, and its opt-out is the `useReducedMotion()` described in [motion.md](motion.md), under
  Motion. That hook reads its value **once at mount**, so `media prefers-reduced-motion reduce`
  emulated _after_ the component mounted proves nothing about it — the surface has to be
  remounted under the override, which is a live check nobody has run.
- **Both drags work with a real Chromium drag**, carrying pdnd's `application/vnd.pdnd`: a card
  from one category to another (the target lit `border-accent` mid-flight; "Vampiric Tutor" moved
  Main deck 10→9, Ramp 6→7 and survived the re-read) and a **deck tile onto a sidebar folder**
  (folder 0→1, tile left "All decks"). **What that does not prove**: `Input.setInterceptDrags`
  bypasses the OS drag loop entirely, so this is evidence about the app's own handlers and _not_
  about WRY's OLE drop target. `"dragDropEnabled": false` remains the load-bearing fact, it is
  embedded at **compile time**, and this exe was built from it.
- **A category move is delete + insert, not an update** — the `deck_cards` row id changes. Worth
  knowing before writing anything that holds one across a move (and it is why restoring a moved
  row by id after a live pass silently does nothing).
- **The allocator's triggers behave exactly as documented.** Seeding `collection_entries`
  directly left the deck reading "66 of 66 missing" with `deck_allocations` empty; the first
  category write rebuilt it (11 rows) and the shortage marks vanished from precisely the owned
  cards. A card in an **inactive** category shows no shortage mark at all, because nothing was
  claimed for it.
  **This finding is history as of schema v25** and is kept because it is what the pass measured on
  the day. There is no allocator and no trigger list: owned/missing is `sum(quantity)` over the
  deck's own `collection_folders` group, current at every read, so seeding `collection_entries`
  directly now leaves the deck reading "66 of 66 missing" **and going on saying so** until the
  copies are filed into that group. The inactive-category half of the finding still holds and is
  now `attribute_owned`'s doing rather than the allocator's.
- **Console over the whole pass: clean.** 377 recorded lines, no JavaScript error, no React
  warning, no unhandled rejection. Everything else was `502` from `mtgimg://` — see the
  unverified note below.

**Three bugs found, none fixed in this pass. Two are still open; the second is closed and its
row is struck rather than deleted** — see it for the two separate closures it turned out to
have had, because "somebody fixed it and nobody struck the row" and "we deleted the feature"
are resolutions a later reader has to be able to tell apart:

1. **The editor's title row collapses the deck name to 18px and overflows into the format
   select, at the app's own default window.** The row is `flex min-w-0 flex-1` holding the name
   input (`shrink: 1`) beside two `shrink-0` children — the variant tabs (102px; the same two
   buttons, which read `Theory | Live` since the move-on-enable change) and the
   "N cards differ" button (107px, and the `Compare` button since 2026-08-20) — which together
   already exceed the container, so the input
   absorbs the entire deficit. Measured: name width **18px at 1100, 1200 and 1280**, and the
   container overflowing by **202px / 102px / 22px** respectively; `overflow` is `visible`, so at
   1280 the button's last **9.9px** is painted over by, and hit-tests to, `select[aria-label=
"Deck format"]`. Fine at 1360 (76px) and above, and fine at 1024 (459px) where the toolbar
   wraps — so the broken band is roughly **1060–1350px and the shipped 1280×800 sits inside it**.
   Only bites when `theory_enabled` is on, which is why nothing caught it.
2. ~~**A custom deck cover never appears in the gallery.**~~ **Closed, and the honest account is
   that it was closed twice.** It was *repaired* at some point after this pass — `DeckTile`'s
   `coverUrl` grew the `coverKind === "custom"` arm the finding asked for, `DecksPage.test.tsx`
   pinned it, and **nobody came back to strike this row**, so it sat here reading as open against
   code that no longer had the defect. It was struck on 2026-08-31, when custom deck covers were
   deleted and there stopped being a picture for a tile to fail to draw — which is a second,
   stronger closure of a bug that was already fixed, not the fix itself.
   **Both halves are the record here**: a finding list that is not re-read against the code is a
   finding list that lies in the safe direction, and the deletion is what made re-reading it
   unavoidable. The original text, kept in full because it is the evidence the removal was argued
   from: `DecksPage`'s `Cover` took only `cardId` and built `cardImageUrl(cardId, 0, "art")`; it had no
   `custom` arm, never read `deck.coverKind` and never formed the `/cover/<deckId>` URL that
   `DeckSettingsDialog` used. So a deck with `cover_kind = 'custom'` and a real file on disk
   rendered **"No cover"** on the tile — the one place the picture existed to be seen — while the
   settings dialog you chose it in showed it correctly. Confirmed after a full reload, with the
   route itself proven working.

   **What made the feature worth removing — after it had been repaired — is that the broken
   tile's behaviour was already the behaviour every other device had.** The file lived beside one
   database and only its absolute path synced, so a phone or a second desktop had nothing to draw
   and fell back to the card art, which is exactly what this gallery had been doing by accident.
   Repairing the tile made one device disagree with the rest of the group; deleting the feature
   made them agree. Custom covers are gone; a cover
   is `decks.cover_card_id` and the tile's one arm is the whole feature. A deck that had a
   picture and no cover card now shows the **no-cover placeholder**, which is a state the gallery
   already supported. `DecksPage.test.tsx` keeps a `coverKind: "custom"` row on purpose — it is
   what an un-upgraded peer can still push over sync — and asserts the tile draws card art for
   it rather than branching.
3. **Table view starves the card name.** Seven fixed columns take **696px of 963px**, leaving the
   two `fr` columns 147px between them: **Card name gets 84px** (`minmax(0,2fr)`) and Type 63px,
   truncating names to ~10 characters, while the empty Tags column holds 112px and Owned 64px.

**Unverified, and not by choice:**

- **Card art could not be rendered at all.** `cards.scryfall.io` was unreachable from this
  machine (a bare HTTPS HEAD times out; `api.scryfall.com` answers), so every fetch failed and
  `data/images` was never created. What this _does_ prove is that the `mtgimg://` handler is
  registered and routing — the failures were the app's own **502**, its documented "failed
  fetch", not a browser-level protocol error — and the `/cover/` route needed no network and was
  verified end to end. But **no card image has been seen decoding in this build.**
  ⚠️ **That second proof is no longer available.** `/cover/` was deleted on 2026-08-31 with the
  custom cover, and every route the protocol has left goes to `cards.scryfall.io` — so on a
  machine where that host is unreachable there is now *nothing* on `mtgimg://` that can be
  driven end to end, and the handler's registration has to be inferred from the shape of the
  failure alone. Probe the MTU (below) before concluding anything about the handler.
  **Diagnosed 2026-08-11, and it is not the app: a path-MTU black hole.** The host is _not_
  unreachable — DNS answers (OVH, `57.130.33.1`/`15.204.104.240`, not Cloudflare like the API
  host) and the TCP connect completes in **51 ms**. The TLS handshake is what never finishes:
  `ping -f -l 1472` to it gets no reply where `-l 1440` does, so the path carries ~1 468 bytes
  and swallows the ICMP that would say so, and the server's certificate flight — a full-size
  segment — vanishes. curl, Node and reqwest all stall identically at the same point, after
  ALPN and before ServerHello. **The tell is which half of the app breaks**: card _data_ syncs
  fine because `api.scryfall.com` rides a different path, while every picture hangs. Before
  suspecting the image cache, probe the MTU. Nothing in this repo can fix it; lowering the
  interface MTU (or clamping MSS) can.
- **The system file picker was not driven.** `dialog:allow-open` opens a native window that CDP
  cannot reach, so `deck_set_cover_image` was exercised by invoking the command directly with a
  path. The encode → write → serve → render half is measured; **the picker → path half is not.**
  **Moot since 2026-08-31**: the command is gone and a cover is picked from a grid of cards
  inside the page, which CDP drives like any other control. `import_read_file` is the remaining
  `dialog:allow-open` caller and inherits the gap whole —
  [decks-storage.md](decks-storage.md) is where that now stands.
- **The whole-card frame (2026-08-12) has never been seen painted.** Its geometry is pinned by
  `CardStack.test.tsx` — the derivation, the two Tailwind literals and the no-reflow property —
  and its _pixels_ are unproven for the reason directly above: no card image has decoded in this
  build on this machine. What a live pass would still have to answer is whether the printed name
  is legible in a 34px reveal at 210px card width, and whether the quantity chip over the printed
  mana cost reads as a badge rather than as damage.
- **Linux remains entirely unrun**, as everywhere else in this repo.

## The create dialog carrying every deck setting — 2026-08-14, `npm run tauri dev` (debug)

Driven over CDP against the live corpus (**116,703 cards**, data from 2026-08-13). Everything
below is a measurement of that window, not of the suite.

- **The whole deck is born in one write, and every field survives the round trip.** Name, format
  (`modern`, changed from the default), description, notes, theory **on**, and a cover picked from
  the search all went in through a single `deck_create`; reopening `Deck settings` on the created
  deck read **all six back**, and the cover kept its credit. That is the plan's whole claim,
  measured end to end rather than argued from the struct.
- **The cover search reaches the real corpus.** `Shivan Dragon` answered **64 matches, 50 shown**
  ("a narrower word reaches the rest"), the grid's heading switched from "Pick art from cards in
  this deck" to "Pick art from any card", and picking a tile drew the `art` crop in the preview
  under **"Art by Melissa A. Benson"** — the credit fetched by `card_detail`, because
  `CardSummary` carries no artist and there is no `DeckRow` yet to read one from. Before that
  fetch existed the preview read **"No cover"** after a pick, which is what a live pass is for:
  every test in the suite passed over it.
- **Enter in the Name field creates the deck**, and this is the one behaviour the shared form
  took away and had to be given back. `DeckSettingsForm`'s name field spends Enter on
  `preventDefault()` + blur — right in the settings dialog, where blur _is_ the write — so
  adopting it silently cost the create dialog its fast path. With `onSubmit` wired, one `press
Enter` created the deck and opened the editor. The two textareas keep their newline and the
  cover search box refuses Enter outright, so exactly one field in the panel submits.
- **The refactor did not cost the settings dialog its commit-on-blur.** A rename typed into the
  reopened dialog and committed with Enter reached the database and re-rendered the editor
  behind it, with no `role="alert"` raised.
- **The panel fits the smallest window the app allows.** 880×651 at **1024×700**
  (`tauri.conf.json`'s `minWidth`/`minHeight`), both axes inside the viewport, no page scroll and
  no inner scroller engaged; 880×724 at 1280×800, centred at `left: 200`. **CDP's
  `setDeviceMetricsOverride` goes below the OS minimum and the panel does clip there** — at an
  820px viewport it stays 880 wide and overflows — so do not read that as a bug the app can
  reach. It is the settings dialog's own pre-existing `w-[55rem] max-w-full`, unchanged by this
  work, and 1024 is the floor that matters.
- **Console clean** across the pass: vite's two connect lines, React's DevTools notice, and one
  WebView2 `intervention` about lazily-loaded images — which is the cover grid's `loading="lazy"`
  doing its job on a plain scroller, where the repo's rule says it belongs.
- **The file picker half is still undriven**, for the reason recorded above: `dialog:allow-open`
  opens a native window CDP cannot reach. So at create, _path → shown filename → upload after the
  INSERT_ is covered by tests and the **click → path** step is not — and neither is the refused
  upload's "Open deck" state, which needs that same picker to reach.
  **Both of those states stopped existing on 2026-08-31.** The create dialog had to hold an
  upload back until the INSERT answered an id, because `deck_set_cover_image` needed a deck to
  attach a file to; a `coverCardId` is just a column on `DeckInput`, so the create is one write
  with nothing deferred and nothing to refuse. What the pass above measured of that flow — a
  cover picked from the search, surviving the round trip and keeping its credit — is the half
  that survived and is still the whole of it.

## The stats band, driven 2026-08-14

`npm run tauri dev`, a **debug** build, against the real 116 703-card corpus and a saved
11-copy commander deck. The stats moved out of the collapsible aside on the desk row into a
static band at the foot of the editor, and the toggle went with it. **Every number below is
why the layout is shaped the way it is, and none of them could have come from the suite —
jsdom measures every element at zero.**

- **The band beside the deck cost the deck everything.** Drawn full width under the deck with
  no other change, the desk row measured **246px** at 1280×800 against the band's **230px**:
  the commander was cut through the middle of its art, every stack column grew a scrollbar of
  its own, and the docked search panel's results **spilled out from under its own box** (its
  card grid painted ~70px below the row's bottom edge). A stack group holding one card is
  **384px** — 6px of column padding, a 43px group heading, the 319px card, `stackHeight`'s 8px
  tail and 6px more padding — so the floor is one whole card, `min-h-96`, and it is a
  measurement rather than a taste.
- **Two arrangements were measured before the third was kept.** A band that _shrinks_ (`min-h-0`
  - `overflow-y-auto`) held the deck at 384 and took **92px** for **229px** of charts — a
    scrollbar over a chart nobody can read. A band that is `shrink-0` inside an `overflow-y-auto`
    editor draws whole: the column wants **847px** in the **710px** a 1280×800 window leaves, so
    the deck holds 384, the band its full 230, and the last **138px** is one scroll away. At
    1920×1080 the editor overflows by **0** and the deck takes the surplus (**612px**). All four
    views agree to the pixel (Stacks, Table, Text, Grid: desk 384, band 230, band top 688,
    `body.scrollWidth` 1265 — no horizontal scroll at any of them).
    **Every "the window leaves" figure in this bullet was taken against a 48px ribbon and is 8px
    large for the current build**: the shell was enlarged on 2026-08-14 and the ribbon is 56px, so
    the 1280×800 editor is **702px**, the 1920×1080 surplus **604px** and the band top **680**.
    The numbers that measure the column's own contents — 847, 384, 230, 92/229 — did not move,
    and neither did anything horizontal: the sidebar stayed 208px precisely so the `DECK_FLOOR`
    bullet below would keep holding.
- **`DECK_FLOOR` had to drop 208 → 192, and the pass is the only thing that could have found
  it.** A page scroller is a second scrollbar, and the row pays for it: at 1280 with a card pane
  docked the desk measured **602** against the **617** in `DECK_FLOOR`'s own table, leaving the
  deck **202** — so a 208 floor railed the docked panel at the app's default window size, which
  is the exact failure the earlier drop from 224 to 208 existed to prevent. `scrollbar-width:
thin` was measured as an alternative and is not one: **10px instead of 15**, desk **607**, deck
  **207**, one pixel short. At 192 the panel draws at its full **384px** there; at 1024 with the
  pane docked the desk is **346** and the panel is correctly still a rail (`aria-disabled`).
- **The remove tray did not move, which is the reason the band sits below the price strip.**
  Probed mid-drag with `cdp.mjs drag --cancel --probe`: the tray spans **647 → 676**, and 647 is
  the desk row's own bottom to the pixel, with the band beginning at **688**. A band between the
  two would have put four charts between a card in the air and the one drop that takes it out of
  the deck.
- The console recorder caught **29** entries and the only four errors were mid-edit HMR states of
  this pass's own work (a constant referenced before it was renamed); nothing after the layout
  settled.

## The quick zones — 2026-08-15, `npm run tauri dev` (debug), 1280×800 unless stated

The bar of four drop targets across the top of the editor (`QuickZones.tsx`), driven end to end
against a real deck of 14 cards. Every claim its doc comment makes about layout is here, because
jsdom has no layout engine and every one of them is a claim about a box.

- **It costs no layout, and that is the whole of the `h-0 -mb-3` arrangement.** With a card in the
  air the editor's header row was at **78** and the first card at **341.5** — _exactly_ the
  coordinates they held with nothing being dragged. The sticky wrapper measured `height` **0**,
  `margin-bottom` **−12px**, `position: sticky`, `z-index` **40**.
- **It is pinned to the scrollport, not to the content.** With the editor scrolled to **500** the
  header row had travelled to **−422** while the bar held at **78–136**.
- **It clears the deck at both window sizes.** The bar is **58px** tall. At 1280×800 it spans
  **49–107** against a desk row beginning at **262** — **155px** of clearance; at 1920×1080,
  **49–107** against **172**, so **65px**. The difference is the header row, which wraps to two
  lines at 1280 and does not at 1920, and the tighter figure is still the whole bar clear of every
  pile.

  > **Superseded twice — the bar is 92px since 2026-08-18.** It went 58 → 74 in _"The quick zones,
  > drawn to be found"_ and 74 → 92 in _"The quick zones become the ribbon"_, both below, the
  > second so that it is exactly the height of the ribbon it lands on. The clearances become
  > **121px** at 1280×800 and **29px** at 1920×1080. Everything else in this section still holds:
  > the wrapper is `h-0`, so the desk row did not move and only the gap under the bar was spent.
- **It is the editor's width, minus the scrollbar.** Bar left **228** = the editor's left; bar
  right **1230** against the editor's **1245**, the 15px being the page scroller's own bar, which
  `inset-x-0` correctly excludes. Zones measured **240px** each at 1280, **400** at 1920 and
  **176** at 1024, with no label truncated at any of them.
- **The tray and the bar are drawn together and do not meet.** During one deck-card drag the bar
  sat at **78–136** and the remove tray at **751** in a **780**-tall window, both computing
  `z-index: 40`, with the deck between them.
- **`Auto` really is refused for a card already in the deck.** Dragging a deck card, `Auto`
  carried `opacity-40` and the other three did not; dragging a tile out of the docked panel, none
  did. The glyphs changed with the drag as intended — `lucide-plus` on the two fixed zones for an
  add, `lucide-wand-sparkles` on `Auto`, `lucide-folder-plus` on `New category`.
- **The writes land.** A panel tile dropped on `Auto` took the deck 14 → 15 cards and created a
  **`Recursion`** pile — the Oracle-tag rule running over a real taxonomy, not the type-line
  fallback. A tile dropped on `New category` opened the dialog with the caret **in the field**,
  its scrim at `z-index` **45** and `Create` `aria-disabled="true"` on the empty name; naming the
  pile made it and filed the card into it (15 → 16). Re-running it with the name `Sideboard` left
  the dialog open, the name in the field, the card unfiled at 16, and the alert reading _"Could
  not make that category — This deck already has a category with that name."_

### One thing this pass found that is not the quick zones'

**The deck editor overflows horizontally by a constant 66px, with nothing being dragged.**
`section.scrollWidth` **812** against `clientWidth` **746** at 1024×768, and **1708** against
**1642** at 1920×1080 — the same 66 at both, so it is not a narrow-window failure but a control
that hangs past the row at every size. The overflowing element is a toolbar `<select>` (right
edge **1040** in a 1009px viewport). That is precisely the failure `src/CLAUDE.md`'s wrapping
rule exists to prevent and the 1024px floor forbids, and it is **older than this branch** — the
measurement above was taken with `[data-quick-zone]` counting **0**. Written down here rather
than fixed here.

Its one consequence for the bar was fixed: a scroller that scrolls on two axes needs a sticky
element pinned on two, or the bar rides the content sideways. Measured before the fix at 1024,
with the drag's own auto-scroller having run right — bar left **162** against the editor's
**228**; after `left-0`, with `scrollLeft` still **66**, bar left **228**.

> **Closed 2026-08-16, by somebody else's branch.** Re-measured on `main` at d5fed47 (the merge
> of #89, "stop the editor's `sr-only` labels opening a window scrollbar"): the editor's
> `scrollWidth` and `clientWidth` are both **1017**, so the overhang is **0**, and the document
> agrees on both axes (`scrollWidth` 1280 = `clientWidth`, `scrollHeight` 800 = `clientHeight`).
> **The `left-0` on the quick zones stays** — it is a fence around a property of the scroller
> (`overflow-y-auto` computes `overflow-x` to `auto`, so the box can scroll on two axes whenever
> anything overflows it), not around the one control that happened to be overflowing it.

## `Auto` re-filing a card the deck already holds — 2026-08-16, `npm run tauri dev` (debug), 1280×800

Driven on `main` at d5fed47, against the same 14-card deck. The write path is new on both sides —
`move_card`'s name arm in Rust, `useDeck.refileCard` in TypeScript — and the two halves that no
suite can reach are the gesture and the provenance.

- **The zone is live for a deck card, which is the whole change.** Holding a card off the desk,
  `Auto` carried **no** `opacity-40` and lit up on hover; it greyed for exactly this drag before.
  The other three drew `lucide-move-right`, so the bar knew it was a move.
- **A re-file files by what the card does, and creates the pile.** _Accumulate Wisdom_ — type line
  `Instant`, sitting in a pile called `Instant` — left it for a **new `Draw` pile**: `Instant`
  went 4 cards → 3, `Draw` arrived holding 1, and the deck stayed **14 cards**, so it was a move
  and not an add. The tags were read live, against a real taxonomy; the type line would have
  answered `Instant` and left it where it was.
- **The caret follows it**, which is what the command's new return value is for:
  `document.activeElement` was the group element of the pile that had just been made
  (`data-deck-group="33"`). Nothing in TypeScript knew that id until Rust answered with it.
- **Pressing again is answered, not written.** The same card dragged onto `Auto` a second time
  produced the sentence _“Accumulate Wisdom” is already filed under Draw._ in a `role="status"`,
  with the card count (**14**) and the group count (**8**) unchanged.
- **The invented pile is `origin: 'auto'`, and this is the observation the Rust route was chosen
  for.** Dragging that one card out of `Draw` and onto `Sideboard` took the `Draw` heading off the
  desk with it — `[data-deck-group="33"]` gone, seven groups again. Resolving the name in
  TypeScript would have made the pile through `deck_category_create`, which writes `'user'`, and
  `drawsWhenEmpty` would have kept drawing an empty column nobody asked for.
- **The bar's layout claims still hold under all of it** (re-measured on this build, from an
  unscrolled baseline): the wrapper computes `position: sticky`, `z-index: 40`, `height: 0`,
  `margin-bottom: -12px`, `left: 0px`; with a card in the air the header row, the desk row and the
  first card sat at **78**, **243** and **293.5** — the same three coordinates they held with
  nothing being dragged. The bar spans **78–136** and the desk row begins at **243**, so **107px**
  of clearance.

**What this pass did not reach**: the _unplaceable_ answer, where `autoCategoryFor` returns the
fallback pile. It needs an orphaned row or a layout the rule has no word for, and this deck has
neither. `useDeck.test.ts` covers it, and the sibling branch — "already filed" — was driven here,
so what is unproven is the second arm of one `if` rather than the path to it.

> **Superseded 2026-08-16 — that arm no longer stays put.** A card the rule cannot place is filed
> into `Uncategorized` like any other answer, so the branch this paragraph called unproven has
> been replaced rather than driven. What is unproven now is narrower and of the same kind: that
> the fallback pile is _created_ by a re-file, which is the ordinary name arm the pass already
> drove for `Draw`. See the corpus counts below for how rare reaching it is at all.

### How often the fallback is actually reached — counted 2026-08-16, not estimated

Against the live corpus, **116,703 printings**, mirroring `autoCategoryFor` exactly (the eight
type buckets, and the thirteen functional anchors joined through `oracle_tag_cards`):

|                                                             | Printings                                       |
| ----------------------------------------------------------- | ----------------------------------------------- |
| No type line at all, in `cards`                             | **0**                                           |
| Front type line matching no bucket                          | 4,141                                           |
| …of those, rescued by a functional tag before the type step | 613                                             |
| **…so genuinely answering the fallback**                    | **3,528** (3.0%), across 60 distinct type lines |

**91.7% of that is art series** — `Card // Card` (2,712), `Card` (521) and one
`Card // Token Creature — Elemental`: objects with no game type, so there is no type to fall back
to and the fallback pile is the only honest home. The rest is a long tail that is not deckbuilt
either (Token 38, Emblem ~35, Stickers 17, Dungeon 1) or belongs to a supplementary format
(Vanguard 45, Scheme 40, Plane ~70, Conspiracy 23, Phenomenon 21).

**Seven of them are a real mis-filing and are still open**: `Summon Dragon`, `Summon — Specter`,
`Summon Licid` — Portal-era wording for what modern cards call `Creature` — plus Unhinged's
`Eaturecray — Igpay`, which is pig latin for the same word. They are castable creatures and the
rule files them by the fallback. Fixing that is a mapping, not a new bucket, and nobody has done
it.

## The four decklist formats, end to end — 2026-08-16, `npm run tauri dev` (debug), 1280×800

Driven against the **live corpus of 116 712 cards, Scryfall data of 2026-08-15**, through the real
`import_resolve` / `deck_import_commit` rather than a stub. The three fixtures are the reader's
own exports of one deck, held verbatim in `src/features/transfer/import/fixtures.ts`; two decks were
created for this pass and deleted afterwards.

### Import: all three lists resolved, and nothing was lost

| Fixture | lines | copies | issues | resolve | matched | unmatched | `hintMissed` | inactive items | piles |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `ARCHIDEKT_SECTIONED` | 105 | 117 | 0 | **83 ms** | **105** | 0 | 0 | 17 | 14 |
| `ARCHIDEKT_FLAT` | 88 | 100 | 0 | **64 ms** | **88** | 0 | 0 | 0 | 12 |
| `EMPTY_HINT_LIST` | 88 | 100 | 0 | **196 ms** | **88** | 0 | **33** | 0 | 6 |

- **Every printing hint in a real Archidekt export names a real printing.** 105 of 105 resolved
  with **zero** `hintMissed`, `(plst) IMA-18`, `(pbro) 12p` and `(plst) 2XM-332` included — the
  three shapes most likely to be a typo and none of them was.
- **The 33 `hintMissed` rows are exactly the 33 empty `()` lines**, which is the cost this design
  accepted in writing before it was measured. All 88 still matched: a collector number with no set
  cannot narrow, so the name arms answer and the reader is told the printing was not honoured.
- **`EMPTY_HINT_LIST` is 3× the cost of the other two (196 ms against 64)** and is the only one
  that writes **front faces only** — `Branchloft Pathway`, never `Branchloft Pathway //
  Boulderloft Pathway`. Both facts have the same cause: with no set code every line falls past
  `BY_SET_AND_NUMBER` to the name arms, and the split names fall past `BY_NAME` to
  `BY_FRONT_FACE`. It is the arm sequence being paid for, working as designed.
- **The six piles `EMPTY_HINT_LIST` lands in are `autoCategoryFor`'s**, because that list carries
  no categories at all — the floor this feature stands on, unchanged.

### The commit, and the number the whole design exists for

`deck_import_commit` of the sectioned list: **246 ms**, `added: 117`, `categoriesCreated: 12` (the
14 piles less the two the deck seeds), `commander: fromFile` — the `[Commander{top}]` bracket
reached the command zone.

`deck_get` immediately after:

- **`cardCount` is 100**, over **105 rows** and **117 copies**, with 100 counted. A 100-card
  commander deck imports as 100. The gallery tile reads `Commander · 100 cards`.
- **`(New) Maybeboard` is `is_active = 0` and `origin = 'auto'`** — the pile the import created,
  switched off by `ImportItem.inactive`. `Maybeboard` beside it is `origin = 'user'` and was
  already off, untouched.
- **`Flash Enabler`, `Counters` and `Stax` survived** as ordinary `auto` piles. Those three are
  the proof: no `autoCategoryFor` bucket answers any of them, so they can only have come from the
  file.

### The header, re-measured with six buttons

The 825px figure recorded on 2026-08-14 was five buttons on a different deck; `Export deck` is a
sixth. Measured on this deck:

- The actions block is **919 × 36**, on **one line**, inside a header row of **1017**.
- `Export deck` is **88 × 36**.
- The header row is **92px over two lines** (`distinctTops: 4`). **It wrapped before this branch
  and still does**; what changed is that the second line is 919 rather than ~831, still short of
  1017. **`document.documentElement.scrollWidth === clientWidth`**: no horizontal overflow, which
  is the one thing the 1024px floor forbids.

### The export dialog, and the round trip

Six radios in `EXPORT_FORMATS` order — `Plain text · MTGO · Arena · Moxfield · Archidekt · CSV`.

- **Plain** keeps `1 Serah Farron // Crystallized Serah` whole and draws **no** omission line.
- **Arena** writes **100 copies** under `Commander` / `Deck` with the set uppercased, and draws
  **"17 cards in switched-off piles are not written in this format."** 100 + 17 = 117.
- **Archidekt** writes all **14** headings, **117** copies, **17** `{noDeck}` lines, `1x` counts
  and a **lowercase** set code: `1x Akroma's Will (lcc) 125 [Maybeboard{noDeck}]`.
- **The round trip is exact.** That Archidekt text pasted into a second deck parsed to **105 lines
  / 117 copies / 0 issues / 0 unmatched**, chose its commander `fromFile`, created **12**
  categories, and read **`cardCount` 100 over 105 rows** with both maybeboards off — every number
  identical to the original import. `decklists.test.ts` pins the same trip as a fixed point; this
  is that claim made against the real corpus and the real database.

## Switching Live and Theory took the app down — 2026-08-16, `npm run tauri dev` (debug), 1280×800

Driven from `d0bd45b` on a real deck with a plan (6 live rows, 1 theory row), reported by the
reader as "it doesn't always happen, but switching back and forth a few times in a row will
usually cause it". It is the first crash in this file, and it is the one shape of defect the
suite structurally could not see: **there is no error boundary anywhere in this app**, so a throw
in a render is the whole window going blank, and jsdom never assembled the state that throws.

- **Reproduced in three presses.** Alternating the two tabs at **40 ms** intervals killed the tree
  on the fourth click; the same loop at **120 ms** survived 16 presses, and hand-paced clicks
  through `cdp.mjs` (~500 ms apart) survived 12. `document.getElementById('root').childElementCount`
  is the cheap tell — **0** where a living app reads 1.
- **The console named it exactly**: `Uncaught Error: Too many re-renders. React limits the number
  of renders to prevent an infinite loop.`, followed by React's own
  _"An error occurred in the `<DeckEditor>` component. Consider adding an error boundary…"_.
- **The cause is two cached snapshots of one row.** Each list is its own query key, so `deck_get`
  is cached per variant and each answer carries its own copy of the deck row — including
  `lastVariant`. `rememberView` writes that column **without invalidating**, so the two copies
  drift, and a `["decks"]` invalidation re-reads them over **two** round trips: a
  `deck_set_view_state` committing between the two leaves one snapshot on each side.
  `ipc.deckGet` patched in the running window caught the drift directly — a **`live`** read
  answering `lastVariant: "theory"` while the `set` for `live` was still in flight, the two reads
  issued in the same millisecond with the write between them.
- **The restore then chased itself.** `DeckEditor`'s render-phase restore was honoured once per
  stored *triple* — a marker built from `row.lastVariant` — and the variant decides which
  snapshot `row` is. Two snapshots naming each other's tab is `setVariant` → different row →
  `setVariant` back, forever.
- **Proved by forcing it.** With `ipc.deckGet` patched to answer `lastVariant: "theory"` for the
  `live` read and `"live"` for the `theory` read, merely **opening** the deck took the window
  down — no press at all. That is the state `DeckEditor.test.tsx`'s "survives two cached rows that
  name each other's tab" feeds in, and it fails on the old code with the same React error.
- **After the fix** (the restore keyed on the deck and the theory switch, never on a stored
  value): the forced crossed pair opens alive and settles on Theory in one move; **320 presses at
  35 ms** across eight bursts, plus 16 real Chromium clicks, left `root` at 1, the pressed tab
  `aria-pressed="true"` every time, and **zero** console errors.

## The quick zones, drawn to be found — 2026-08-17, **not the shipped window**

The reader's report was that the bar of four drop targets is easy to miss. The change is four
utility tokens on one box (`QuickZones.tsx`'s `QuickZone`), and it is entirely a question of
value and size — which is the one class of question the harness below can answer honestly and
the one the app lock was not free for.

**Method, stated because it is not this page's usual one.** A `file://` page linking the **built**
`dist/assets/index-*.css` — the real compiled sheet, so every colour and every arbitrary value is
the shipped one — rendering the bar twice, once with each set of class strings, shot by headless
Edge at `--force-device-scale-factor=1`. What makes the numbers worth keeping rather than merely
plausible: **the harness reproduced the old bar at 58px, which is the figure the 2026-08-15 CDP
pass above measured in the real window, to the pixel.** What it cannot answer is anything about
app state or about the bar's position over a real deck — the clearances below are arithmetic off
that height, not a second measurement, and they are exact only because the wrapper is `h-0` and
the desk row therefore does not move.

| | before | after |
| --- | --- | --- |
| zone box | **40px** | **56px** (`h-10` → `h-14`) |
| label | 12px, weight 400, `oklch(0.65 0.01 90)` (`text-dim`) | **14px, weight 500, `oklch(0.93 0.005 90)`** (`text-sm font-medium text-text`) |
| outline | 1px dashed `oklch(0.3 0.01 270)` (`border-border`) | **2px dashed `oklch(0.65 0.01 90)`** (`border-dim`) |
| glyph | 14px (`size-3.5`) | **20px** (`size-5`) |
| fill | `oklch(0.16 0.01 270)` (`bg-bg`) | unchanged |
| whole bar | **58px** | **74px** (and **92px** since 2026-08-18 — see the section at the foot of this file) |

- **The zone width does not move**, and that is worth stating because it is what keeps the
  2026-08-15 widths (240 at 1280, 400 at 1920, 176 at 1024, no label truncated at any of them)
  standing: the boxes are `flex-1` in a bar of the editor's own width, and neither the count nor
  the `gap-2` between them changed. Measured **243.8px** each in the harness's 1017px bar, which
  is the editor's content width at 1280×800 on `main` since the horizontal overhang closed.
- **The clearance the growth spends is 16px**, off the gap between the bar and the desk row and
  off nothing else: **155 → 139** at 1280×800, **65 → 49** at 1920×1080. Both still clear every
  pile, and 49 is the figure a fifth zone or a taller box would be spending. **A taller bar is
  exactly what 2026-08-18 spent it on: 29px now**, re-measured rather than derived.
- **What was wrong was four defensible decisions taken together.** The label was `text-dim`, the
  second-dimmest colour in the palette; the outline was `border-border`, four hundredths of a
  lightness step off the `bg-bg` it enclosed; the box was 40px; and all of it had to be found
  **during a drag**, which is the one moment a reader is looking at the card under their pointer
  rather than at the chrome. Each token is defensible against a resting surface. This surface does
  not rest — it exists for about two seconds — and a control that appears for two seconds cannot
  also be quiet.
- **The outline is now the colour the label used to be**, which inverts the hierarchy deliberately:
  the box is found first and read second, which is the order a drop target is used in. Dashed
  rather than solid at 2px, still, because a dashed edge is what says *let go here* rather than
  *press me*.
- **No gold was spent.** `DROP_RING`/`DROP_OVER` and `border-accent` remain the only accent on this
  bar, so the hover state still has something to say that the resting state does not — the whole
  change sits in the neutral half of the palette. Photographed in the same frame: the `over` zone
  reads as distinctly *the* target beside three neutral siblings, and `opacity-40` still reads
  unambiguously as a refused pile at the larger size.
- **Not driven in the shipped window.** The layout claims this section leans on — zero height,
  `sticky top-0`, the bar over the header row rather than over a pile — are the 2026-08-15 pass's
  and are untouched by a change to one box's own tokens. What a live pass would add is the
  clearance re-measured rather than derived.

## 2026-08-17 — a deck card names a finish (schema v19)

Driven in the shipped window (`npm run tauri dev`, a **debug** build, against the real synced
corpus copied out of the main checkout — 116k cards, real prices, real decks). CDP over
`scripts/cdp.mjs`. Two defects found, neither of which any test in the repo could have caught,
and both fixed in the same pass.

### What it confirmed

- **A pile really does hold both.** `Abandon Attachments` (TLA 205) in the deck's `Instant` pile
  as **`2 copies, foil`** beside **`1 copy`** regular — two rows, one printing, one category.
  Reached the way a reader would: `Set as foil` on the menu, a quick add for a second copy, then
  `Move to → Instant`.
- **The price follows the finish, on one screen.** The foil row drew **`Foil $0.71`** and the
  regular row **`$0.29`** — the same printing, two figures, from real TCGplayer data. This is the
  claim `deck_card_price_expr` exists for and the one a fixture cannot make.
- **Copy limits sum across the split.** With 2 foil + 1 regular the rule break read
  *"max 1 copy of Abandon Attachments; you have **3**"* — `engine.ts` counts by name and never saw
  the grain change, which is the rule this branch most needed not to have broken.
- **The fold, and undo splitting it back.** The pane's `Set as foil` on the regular row folded it
  into the foil row: 15 rows → **14**, `3 copies, foil`, and the button flipped to `Set as
  regular` in the same frame. One `Ctrl+Z` put it back to 15 rows, `1 regular` + `2 foil` —
  **both restored at the finish they had**, which is what `deck_undo::CardRow.finish` buys and
  what the finish-blind `Cell` scope makes possible.
- **The label is context-dependent and correct.** `Set as foil` in the editor's pane, on a card
  the deck holds. The menu row is live on a two-finish printing and greys silently on a one-finish
  one.
- **The printing's own statement survives.** `Serah Farron // Crystallized Serah` — a foil-only
  printing in a deck predating v19 — already read `foil` in its accessible name with `finish`
  NULL, which is `playedFinish`'s fallback arm working on real data.

### Defect 1 — two rows of one printing shared one slot

`deckCardSlot` was `${categoryId}:${cardId}` and did not grow the finish, so **both rows carried
the identical `data-deck-card`**: `20:74ca45a4-97ab-4255-9129-884e8b42b984`, twice, in one pile.

That is the string the pane hands focus back through after a swap (`deckControlFor`) and the one
every view compares against `selectedSlot` — so the pane opening on either row marks **both**, and
a post-swap hand-back lands on whichever comes first in the DOM.

**Nothing in the repo could have failed on it.** Every fixture with two rows of one printing puts
them in two *different* piles, where the category id already separates them. Fixed by adding the
finish to the slot, and `views.test.tsx` now builds the one-pile case explicitly.

### Defect 2 — the history called a finish change a printing swap

The undo button read **"Undo — Swapped printing of Abandon Attachments"** after a press that
changed no printing at all.

`deck_set_card_finish` records the `swap` audit kind on purpose — `AUDIT_KINDS` is
CHECK-constrained and both writes are the same act — and it writes `fromFinish`/`toFinish` where a
printing swap writes `fromSet`/`toSet`. `auditText.ts` was never taught the second payload, so it
read every `swap` row with the first one's sentence. True of the kind, false of the row.

It now says **"Made Abandon Attachments foil"** with `regular → foil` beside it, and the fold note
is unchanged. The payload is the discriminator, which is the pattern this file already uses for
the `deck` kind's `field`.

**The general lesson, since it is the second time this exact shape has cost something here:** a
reused audit kind is a reused *sentence* until somebody writes the second one. The kind list stays
short for a good reason; the renderer is where the cost lands.

## The quick zones become the ribbon — 2026-08-18, `npm run tauri dev` (debug), 1280×800

Driven in the shipped window against the real synced corpus copied out of the main checkout, on a
14-card Commander deck. Every figure below is a `cdp.mjs drag … --probe` reading taken **while a
card was in the air**, which is the only state this bar exists in.

The reader's report was that the bar does not look like it replaces the row it lands on. It does
not, and the number says why: **the bar and the deck's name/settings ribbon both start at y=78,
and the ribbon is 92px against the bar's 74.** The last **18px** of the ribbon's second line
stayed showing under a box plainly meant to stand in for it.

### The ribbon is 92px only while it wraps, and where that boundary sits

| window width | ribbon height |
| --- | --- |
| 1280 · 1400 · 1500 | **92px** (two lines) |
| 1600 · 1700 · 1800 · 1920 · 2560 | **48px** (one line) |

92 is `py-1.5` either side of two 36px lines with `gap-y-2` between them (6 + 36 + 8 + 36 + 6);
48 is the same padding around one. The app shipped **1280×800** when this was measured and
registers no window-state plugin, so every first run was in the wrapping half of that table.
**Since 2026-08-20 the opening size is decided per monitor** (`src-tauri/src/window.rs`):
**1920×1080** where the work area holds it, **1280×720** where it does not — which is every
1080p desk, because Windows takes its taskbar out of that 1080. So a 1080p reader is still in
the wrapping half at the same 1280 width; a larger desk is now in the one-line half.

### What changed

| | before | after |
| --- | --- | --- |
| whole bar | **74px** | **92px** (`h-[5.75rem]`) |
| zone box | 56px (`h-14`) | **74px** — no height of its own; the bar's, less `py-2` and the border |
| gap between boxes | `gap-2` (8px) | **`gap-3`** (12px) |
| padding outside the outermost boxes | `p-2` (8px) | **`px-4`** (16px), `py-2` unchanged |
| zone width | `flex-1`, unbounded | **`flex-1 max-w-[300px]`**, and the bar `justify-center` |

- **It lands on the ribbon exactly at 1280×800**: bar top **78**, bottom **170**, against a ribbon
  of 78→170. Boxes **74 × 236.8**, all four labels unclipped (`scrollWidth === clientWidth` on
  every one).
- **The 300px cap binds only on a wide window.** At 1280 each box is 236.8px, inside the cap and
  unchanged by it. Maximised at 2560 the four measure **300px each at x=759, 1071, 1383, 1695** —
  centred to the pixel in a 2297px bar (group centre 1377, bar centre 1376.5). Four boxes spanning
  a 2560px window read as a banner rather than as four things to choose between, and a drop target
  twice the width of its label is not twice as easy to hit: the pointer is already inside it.
- **The height does not follow the ribbon back down at ≥1600, and that is the decision rather than
  an oversight.** Matching it there would leave the boxes **30px** — shorter than the 40px the
  2026-08-17 pass replaced for being easy to miss, on a surface that exists for two seconds. So
  the bar keeps 92 and on a wide window covers the one-line ribbon plus most of the toolbar row
  beneath it, which is not a row a hand mid-drag can use. It already overhung that row at 74px
  (by 14px, now 32).
- **No pile is covered at either size.** The wrapper is still `h-0`, so the desk row does not move
  and the clearance arithmetic is exact rather than a second estimate: **139 → 121px** at 1280×800
  and **47 → 29px** at 1920×1080 (the 1920 desk row measured at y=199 on this deck, against the
  49px the 2026-08-17 note derived from a different one).

### Two traps this pass paid for

- **The window resized under the pass, and nothing on screen said so.** Two screenshots minutes
  apart came out 1280×800 and 2560×1369: the window had been maximised between them, so a "before"
  frame shot for comparison was at a different viewport and a different ribbon state — the two
  frames answer different questions and neither says which. `innerWidth` belongs in the same
  `--probe` as every rect, and `IsZoomed` on the window handle is the cheap tell afterwards.
- **A bar that only exists during a drag can still be photographed.** `--probe` cannot take a
  screenshot, and the drag ends when the `cdp.mjs` process exits. Cloning the bar inside the probe
  — `cloneNode(true)` positioned `fixed` at the rect it was measured at — leaves real pixels of
  the real element in the page for a `shot` afterwards, and setting the clone's own
  `style.height`/`gap`/`padding` back to the old values photographs before and after from one
  build. The clone must be removed afterwards; it is not React's and nothing else will.

## The general import/export feature, driven end to end — 2026-08-20, `npm run tauri dev` (debug), this worktree

Task 15's live pass, against a fresh sync in this worktree (116,700 cards, its own
`target/debug/data/mtg.db` — separate from the main checkout's, which held 0 collection rows and 0
wishes throughout, untouched). Every row this pass created in the collection, the wishlist and the
gallery was removed afterwards and the removal confirmed by a direct `node:sqlite` read (`0` each)
before the app was shut down. The full write-up, with every field name and grain, is
[import-export.md](import-export.md); this entry is the pass log.

### The export dialog, clamped, every field on, CSV — the check left unmeasured at Task 9

`src-tauri/tauri.conf.json` enforces `minWidth: 1024, minHeight: 700`, so 1024×700 is the real
worst case a reader can produce rather than an arbitrary "short" number. At that size, on the
collection surface, CSV, all **22** optional field checkboxes on, and **17** real collection rows
(imported for this pass, enough that the `<pre>`'s own `scrollHeight` read 785px against a 593px
body budget — genuinely too tall to fit):

- Panel: `top 24, bottom 676` — clamped inside the 700px window.
- **Copy**: `top 619, bottom 655` — on screen, reachable.
- **Save as…**: `top 619, bottom 655` — on screen, reachable.
- The `<pre>` absorbed its own overflow in its own `overflow-auto` box (a visible scrollbar in the
  screenshot taken during the pass); the outer body's `scrollHeight` stayed equal to its
  `clientHeight` (593 = 593), so the footer never had to move at all.

**The panel does not stay clamped below the app's own floor, and that is the reason the floor
matters rather than an open bug.** Pushing the CDP-emulated viewport to 1024×380 — well under the
enforced 700px minimum, a size Windows will never let a reader's window reach — reproduced the
un-clamped failure: the dialog's outer `<div role="dialog">` computes `overflow: visible`, so a
flex column taller than the window pushes its own footer buttons out past the panel's box rather
than being clipped by it. Recorded here because the mechanism is real and worth knowing about, not
because a reader can reach it.

### CSV round trip, condition included

`dialog:allow-save`/`dialog:allow-open` are native windows this harness cannot drive — the same
limit this file's other entries already note for a file picker — so this checked the **text**
round trip the file system would carry byte for byte, rather than the picker gesture itself.
Pasted `Quantity,Name,Set,Collector number,Finish,Condition` naming a nonfoil Lightning Bolt at
**LP** and a foil Sol Ring at **NM** into the collection's Import dialog; the table read back
`Nonfoil · LP (Lightly played)` and `Foil · NM (Near mint)`; exporting the same two rows to CSV
read back `2,Lightning Bolt,2x2,117,,LP` and `1,Sol Ring,c21,263,foil,NM` — the condition survived
on both rows, at both finishes, exactly.

### A plain-text list into the wishlist

`1 Lightning Bolt` / `1 Sol Ring` / `1 Counterspell`, no set or collector number on any line,
committed. `wishlist_entries` read directly (`node:sqlite`) showed `card_id: null`,
`set_code: null`, `collector_number: null` and a populated `oracle_id` on all three; the table's
own Printing column agreed, reading "Any printing" for all three.

### New-deck import navigation — no regression test anywhere, so this pass is the only proof

From the gallery's "Import deck" button, a 4-card paste, a typed name, Import. The ribbon's own
`h1` still read "Decks" — it names the section rather than "gallery vs. editor" and does not move
for this — but the page itself carried `Export deck` (a control that exists only inside the deck
editor), the typed deck name, and the 4 cards correctly filed under Ramp and Removal: the reader
was left inside the deck that was just created, not looking at its new tile in the gallery.

## The arrow keys walk one card at a time (#178)

Driven in the shipped window **2026-08-21** (`npm run tauri dev`, a **debug** build, 1920×1080,
against a copy of the real corpus), on a 14-card Commander deck laid out as six piles —
`Commander(1) · Instant(3) · Artifact(4) · Creature(4)` in the flow, then `Test(1)` and one railed
pile. The caret was put on a card by a **real pointer click**, which is the entry point
[frontend-design.md](frontend-design.md) records a pass having missed once.

- **A pile boundary is not a stop, and the step that proves it is the one *inside* a pile.**
  ArrowRight from the head of the Artifact pile landed on its **second** card, where the old
  two-axis walk would have jumped to the next pile. Crossing out of a pile was checked separately:
  the last card of Instant → the first of Artifact.
- **Thirteen presses walk a fourteen-card deck exactly once.** From the command zone's only card,
  thirteen ArrowRights visited every one of the 14 slots in DOM order — no card twice, none
  skipped, all four pile boundaries crossed, the railed pile included. **Five more presses moved
  nothing**: the clamp, not a wrap.
- **A pile is entered at its near edge.** ArrowLeft off the head of the `Test` pile landed on the
  **last** card of Creature rather than its first — the property that makes one press and then the
  other the card you started on.
- **Up and down are the page's, which is the half jsdom cannot see.** With the caret on a card,
  five ArrowDowns moved the deck editor's scroller **0 → 200px** (40px a press, Chromium's line
  scroll) and three ArrowUps took it **200 → 80**, with `document.activeElement` on the same card
  throughout. No branch, no `preventDefault`, so the key keeps the meaning the browser gives it.
- **The ring and the pane follow the caret.** Exactly **one** `[data-deck-card-selected]` in the
  DOM at the end of the walk, on the focused card, with the card pane showing that card's name.
- **`scrollIntoView({block:"nearest"})` had nothing to do and did nothing.** The card the walk
  ended on sat at 386–679 inside a scrollport of 112–1060 and `scrollTop` was still **0** — worth
  recording because "the desk did not move" and "the walk did not follow" look identical from a
  screenshot.

### The grip, which now answers two keys instead of four

- **ArrowDown and ArrowUp on a category grip reorder nothing.** The four grip labels read
  `Move Instant, 1 of 4 · Move Artifact, 2 of 4 · Move Creature, 3 of 4 · Move Test, 4 of 4`
  before and after both presses, with no `role="alert"` banner and the caret still on the grip —
  so the view's own walk did not quietly take the press either.
- **The tooltip says what the control now does**: hovering a grip for 900ms read
  `Drag to reorder, or press the left and right arrow keys`.

Left as the suite's: that ArrowLeft/ArrowRight on a grip still reorder. Driving it live means two
`deck_category_reorder` writes against the reader's own deck, and the branch was not touched —
`views.test.tsx` and `DeckEditor.test.tsx` both cover it, including the ids the second one sends.

## The card pane as an overlay, and the remembered search column — 2026-08-22, `npm run tauri dev` (debug), 1280×800

Issue #183, both halves, driven against a copy of the main checkout's database (14-card Commander
deck, 116 700-card corpus, a sync running throughout — which is the *contended* read connection
and matters to the last section).

### No reflow, which is the whole claim

The desk row is **1017px** at 1280×800 (a 1032px content box less the editor's own 15px
scrollbar), and it splits **617 + 16 + 384**. Every figure below was taken in that window.

| state | deck column | search panel | pane | `data-pane-over` |
| --- | --- | --- | --- | --- |
| no card open | 617 | 384 @ x 861 | — | `search` |
| card from a deck pile | **617** | 384 @ x 861 | 384 @ x **861** | `search` |
| card from the search column | **617** | 384 @ x 861 | 384 @ x **461** | `deck` |
| card from a deck pile, column railed | **965** | 36 @ x 1209 | 384 @ x **861** | `search` |

- **The deck column does not move.** 617 with a card open and 617 without, against the **202** the
  docked pane used to leave it (the table on `DECK_FLOOR`, taken when the pane was a shell
  column). The railed row is the same claim at the other end: 965 either way.
- **Both anchors are exact to the pixel.** Over the search column, the pane's box *is* the
  panel's — 861 → 1245 against 861 → 1245. Over the deck, its right edge is 845, which is the
  deck column's right edge (228 + 617) and therefore one 16px gap clear of the panel at 861.
- **"Regardless of its size" is real**: with the column railed to 36px the pane is still 384 wide
  and still anchored to the desk's right edge, overhanging the rail onto the deck.
- **No horizontal overflow in any state** — the editor's `scrollWidth` equalled its `clientWidth`
  (1017) at every sample, which is the failure a wrongly clamped overlay would produce and the one
  the 1024px floor forbids outright.
- **The pane is clamped by the space on its side, not by its own 384.** At **1024×800** with the
  pane over the deck, the deck column is 361 and the pane is drawn **361** wide. Without the cap it
  would overflow the inline-start edge, which is *not* scrollable — the missing 23px of card could
  not have been reached by any gesture.

### The defect this pass existed to find

**The search column drew itself open for 43 frames — about 700ms — before snapping to its rail,
on every deck opened after a launch.** Sampled per `requestAnimationFrame` on a database whose
stored answer was *shut*: `-1` (not drawn) × 15, **384 × 43**, then 36 for the rest. The deck
beside it re-packed 965 → 617 → 965 on the way past.

- **It is not a slow read.** Asked on its own in the same window, `deck_search_open` answered in
  **20.7ms** cold and **5.4ms** warm. It is slow *there* because the panel mounts only once
  `deck_get` has answered, so its read queues behind the deck's on the read connection — and
  behind the sync, on the launch where this is most likely to be a reader's first deck.
- **Amplifying it is what made it legible.** Patching `ipc.deckSearchOpen` in the running page to
  resolve after 800ms turned the 43 frames into **105**, which is the same bug at a speed a person
  can watch. The technique is the one `repro-races-by-patching-ipc-live` describes.
- **The fix is to stop asking at the moment the answer is needed.** `usePrefetchDeckSearchOpen`
  is mounted in `AppShell` beside `useCardZoomPersistence`, so the read starts at launch while the
  reader is still on the Search view. Re-driven on a cold launch: `-1` × 43 then **36 for every
  remaining frame** — the column is never drawn at the wrong width at all.
- **Nothing in either suite could have seen this.** jsdom has no layout engine, so the width does
  not exist there; and a mocked `deckSearchOpen` resolves on the microtask queue, so the pending
  frame a real IPC round trip leaves is not produced either.

### The persistence, end to end

- Collapsing the column wrote `app_meta.deck_search_open = '0'` (read back with a read-only
  `node:sqlite` connection while the app held the database).
- **Killed the app and relaunched it**: the editor opened on the 36px rail, `aria-expanded`
  `false`, and no `<input>` mounted anywhere in the panel — so a shut column really does cost no
  `search_cards`.
- Reopening it wrote `'1'` back.

### One thing worth knowing that is not a bug

**With a card open from a deck pile, the search column is underneath the pane and cannot be
clicked.** That is the design — the pane covers what the reader was not looking at — but it means
a CDP pass that opens a deck card and then reaches for a search tile is aiming at the pane. Close
the card first.

## Multi-select (#214) — 2026-08-24, `npm run tauri dev` (debug), 1920×1080, a copy of the real db

Driven against the `Azula` deck — 122 rows across 13 piles — and the search wall over the real
116 700-card corpus. Everything below is a reading from the shipped window, not a test.

### What worked

| Gesture | Reading |
| --- | --- |
| Plain click a deck card | `1` `[data-deck-card-selected]` |
| Ctrl-click a second | `2` marked, `2` `.ring-accent`, both the cards aimed at |
| Shift-click a third | store `cardSelection` = `{ scope: "deck:3", keys: 3 }`, anchor held on the Ctrl-clicked card |
| Drag one picked card onto another pile | all **3** moved, `41 → 39`, one gesture |
| After the drop | `cardSelection` `null`, one ring left (the pane's own card) |
| The drag preview | a chip reading **`3 cards`**, `color: oklch(0.75 0.12 85)` — `--color-accent` exactly |
| Right-click a picked card | `Add 2 cards to · Move 2 cards to · Tag 2 cards · Remove 2 cards`, with `Copy card name`, `Copy card image`, `Open on`, `View all printings`, `Set as commander`, `Set as companion`, `Set as foil` singular |
| `Delete` with 2 picked | `122 → 120` rows, both named cards gone, set stood down |
| `Delete` with the caret in **Deck name** | `118 → 118`, the set of 2 survived |
| Ctrl-click in Stacks / Table / Grid | `2` keys and `2` marked in all three |
| Search wall, Ctrl then Shift | `{ scope: "search", keys: 3 }`, `4` rings — three picked plus the pane's card |
| Drag 3 picked tiles onto the sidebar's **Wishlist** | chip `3 cards`, `Added to wishlist.`, and the wishlist drew **3** tiles |

**The fourth ring is the design and not an off-by-one.** `deckCardMarked` answers
`slot === selectedSlot || isPicked(slot)`, so the card the pane is open on keeps its ring whether
or not it is in the set — which is the ring meaning exactly what it meant before multi-select
existed.

### What the pass found

**The deck card menu's shared half stayed singular.** With two cards picked the menu read
`Move 2 cards to` directly under a singular `Add to` — one menu answering the same question two
ways. `buildDeckCardMenu` was passing `picked` to its own rows and not into `buildCardMenu`'s
deps. Fixed in the same pass and re-read: `Add 2 cards to`. **Nothing in the suite could have
caught it** — the deck-menu tests assert this file's own rows and `cardMenu.test.tsx` builds the
shared menu directly, so neither one ever sees the seam between them.

### The harness trap this cost twenty minutes to

**A stacked deck card cannot be clicked at its centre.** `CardStack` overlaps every card by 285px,
so a collapsed one's only hittable part is its 34px reveal strip — and `cdp.mjs click <css>` aims
at rect centres. A Ctrl-click aimed at one card marked a *third* one, twice, and read exactly like
the chord not reaching the app. Switching the toolbar's view select to `grid` answered it in one
command. Hovering first makes it worse rather than better: the dwell fans a card open and reflows
the pile under the pointer. Written up in
[live-ui-verification.md](live-ui-verification.md) beside the `key` vocabulary.

**And the target has to hit-test.** The first multi-drag reported `outcome: "dropped"` and moved
nothing: the target pile's centre was at `y: -24`, off the top of the window. `elementFromPoint`
at the centre before the drag is the check, and it is the same lesson the category-reorder pass
paid for on 2026-08-17.

### Two things this pass did not cover

**A `deck-panel` set dragged into a category column.** The panel's tiles carry the scope and the
group travels the same way the wall's does, but the gesture was not driven — the sidebar drop was
exercised instead, through the Wishlist entry, because navigating away from a deck clears
`openDeckId` and the Decks entry then refuses in words.

**The count chip at reduced motion, and its position against the pointer.** The chip was caught
with a `MutationObserver` on `document.body` — the container `setCustomNativeDragPreview` appends
for one frame is removed by its own monitor on `dragstart`, so `cdp.mjs drag --probe`, which fires
between `dragOver` and `drop`, is too late to see it. What was read is the text and the colour;
the 12px offset is unmeasured.

## The three-line header, at all four of its widths — 2026-08-24, `npm run tauri dev` (debug), 1920×1080

The 2026-08-24 redesign, driven against the main checkout's real corpus (116 700 cards) on a
100-card Commander deck with a theory list, a sideboard and an inactive Maybeboard. The design's
four artboards are **editor-column** widths, so the pass drove the column rather than the window:
`section[aria-label^="Deck editor"]` was given each width in turn and the header re-measured after
a frame, which is what `deskWidth`'s `ResizeObserver` answers on.

### The arithmetic the breakpoints rest on is exact

The header reads `deskWidth` — the desk row's `clientWidth` — because the desk row and the three
header lines are all full-width children of one flex column. **Measured both ways and they agree
to the pixel**: with the rail collapsed at a 1920 window the column and the desk row both read
**1797**, which is 1920 less the collapsed rail (68), `main`'s `p-5` (40) and the page scrollbar
(15) — **123** exactly. With the rail expanded, one press later, both read **1657**, which is the
same sum with the rail at 208. So the design's artboard numbers and this app's own measurement are
the same number, and `1280 − 208 − 40 − 15 = 1017` is the app's default column without anything
having to be re-derived.

### Every artboard, reproduced

Heights are the three lines' own — 50 / 38 / 49 is one line each, and a wrapped line is visibly
taller. `documentElement.scrollWidth` equalled `clientWidth` (1920) at **every** width: no
horizontal scroll at any of them, which is the one thing the 1024px floor forbids.

| Column | actions | ledger | toolbar | Import/Export | Deck settings | back | `Format` term | check |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1657 | 50 | 38 | 49 | `Import` (78px) | `Deck settings` (119px) | `Decks` (76px) | drawn | `1 issue` |
| 1157 | 50 | 38 | 49 | icon (36px) | `Deck settings` (119px) | `Decks` (76px) | drawn | `1 issue` |
| 1017 | 50 | 38 | 49 | icon (36px) | icon (36px) | `Decks` (76px) | drawn | `1 issue` |
| 761 | 50 | 38 | **97** | icon (36px) | icon (36px) | chevron (36px) | dropped | `1` |

**The ledger holds on one line at the app's own 1017 with the `Format` term on it**, which is the
question the term was added under: `dl.scrollWidth` and `dl.clientWidth` both read 1017 and the
row measured 38px. The whole line read
`Format Commander · Cards 100+3 · Lands 32 · Avg. mana 2.58 · Price $948.94 · Owned 0 / 103
missing` with `1 issue · 6 game changers · Bracket ~4` in the right-hand group at **297px**.

### The toolbar's split, read off the y coordinates

At 761 the toolbar is two lines and they are the right two. Read off `getBoundingClientRect`:

- **y 224** — View (111px), Group by (156px), Sort (138px). The three pickers.
- **y 266** — the break: the zero-height child, **761px** wide, filling the rest of its line.
- **y 272** — Quick add (271px), undo/redo (76px), the filter (390px). The tools.

**The DOM order is untouched**, which is the whole point of doing it with `order`: quick add,
undo/redo, the pickers, the break, the filter — so a caret walks the row in the order it is
written whichever line each control is painted on.

At 1657 the same six sit on one line at y 224, and **the filter measures exactly 400px with its
right edge on the row's right edge (1745 = 1745)** — `flex-1` growing into the leftover up to
`max-w-[25rem]`, then `ml-auto` taking what is left, which is the design's own shape.

### The two anchored layers

- **The bracket**: `Bracket ~4` at 28px tall, name `Bracket 4, an estimate`. Pressing it opened a
  288px `role="dialog"` named `Bracket estimate`, **pinned by its right edge exactly on the
  button's (1745 = 1745)**, which took the caret. It read
  `Bracket ~4 · 6 game changers` over the advisory sentence, and `What this read` disclosed
  `Gifts Ungiven, Mystical Tutor, Fierce Guardianship, Jeska's Will, Rhystic Study, Cyclonic Rift`
  — six game changers off `cards.game_changer`, no mass-land-denial or extra-turns line.
  **Escape closed it and handed the caret back** (`aria-expanded` `false`, focus on the button).
- **The check**: `1 issue` at 28px, name `1 issue · Commander`. Its panel is 320px, right edge on
  the button's (1532 = 1532), reading `Sideboard — Error: Commander decks have no sideboard.` and
  **no bracket anywhere in it**, which is the half of the split worth pinning live.
- **The variant group** read `Theory` (58px) · `Compare` (36px, no text, `aria-label` only) ·
  `Live` (42px) — the Scale glyph between the two lists it weighs. **That group has been rebuilt
  twice since and none of these three numbers still describes it.** On 2026-08-24 the two words
  were swapped to `Live | Compare | Theory`, which was the same three widths in a different order.
  On **2026-08-26** `Compare` moved *out* of the group — a worded button beside it, on the row's
  `gap-2` — the order went back to Theory-first, and `Live` became **`Actual`**: so the group is
  two buttons wide, not three, and the widest of them is a word this pass never measured. Read the
  three figures above as the record of the 2026-08-24 pass; the 2026-08-26 arrangement is measured
  in its own section at the foot of this file.

### The tooltips are bound exactly where the word is not

Hovering the icon-only `Deck settings` at 1017 opened the shared panel with `Deck settings` in it,
8px under the button. At 1657, where the button prints those words, no binding is spread at all.

**One artifact, and it is the price of that conditional.** Resize the column *while* the pointer
is resting on one of these buttons and the open tooltip is orphaned: the re-render removes the
`onPointerLeave` that would have closed it, so the panel stays up until the next hover of anything
that binds one, which re-points it (measured — hovering Undo replaced the text immediately). The
alternative is binding the tooltip at every width, which pays a redundant hint on every hover of a
labelled button for ever; this pays a stale panel only to a reader resizing the window mid-hover,
and it clears itself. Left as it is, deliberately.

### Two traps this pass paid for

- **Port 6006 answered from another worktree while the `storybook` lock read `FREE`.** A Storybook
  from `default-search-filter-order` had been bound since 06:59; `npm run storybook` here then sat
  on an interactive *"Would you like to run on 6007?"* prompt for ever, and the recipe's
  `Get-NetTCPConnection -LocalPort 6006` loop found **their** pid and adopted it into this
  worktree's lock. The tell was a Vite error overlay naming a path in the other worktree. Releasing
  would have killed their server: re-`adopt` the lock onto your own dispatcher pid first, then
  release. The `app` lock's `FREE`-is-not-empty rule applies to this one too.
- **`querySelector` cannot carry a quoted attribute value through the PowerShell hop** into
  `cdp.mjs eval` — `section[aria-label^="Deck editor"]` arrives as
  `section[aria-label^= Deck editor]` and throws. Filter a `querySelectorAll` in JS instead, then
  stamp the element and address it by a bare attribute.

## `Compare` beside the switch, and `Theory | Actual` — 2026-08-26, `npm run tauri dev` (debug), a copy of the real db

Three changes to one row, driven at three widths on deck **Azula** (Commander, 100 cards, theory
on): `Compare` moved out of the variant group, the tabs went back to Theory-first, and `Live`
became **`Actual`**. What a live pass adds to the suite here is entirely geometric — jsdom lays
nothing out, so *where* the button sits and *when* its word goes are claims no test can make.

### The button is a sibling of the group, at the row's own gap

At **1920** (editor column 1657) the actions block is seven children on one line, `scrollWidth`
1920 = `innerWidth`, no page scrollbar:

| Child | Size | x |
| --- | --- | --- |
| `Deck list` (group) | 116 × 38 | 1094 |
| `Compare` | **94 × 36** | **1217** |
| `Import and export` (group) | 159 × 38 | 1319 |
| `Categories` | 103 × 36 | 1486 |
| `Tags` | 70 × 36 | 1597 |
| `History` | 83 × 36 | 1675 |
| `Deck settings` | 119 × 36 | 1766 |

The group ends at 1210 and `Compare` starts at 1217 — **the row's own `gap-2`**, 8px, the same
distance as every other pair on the line, which is the whole of the spacing decision. Inside the
group are exactly two buttons, `Theory` (57px) and `Actual` (56px), and `group.contains(compare)`
is false: it is an action *about* the two lists rather than a third list in a `role="group"` named
`Deck list`.

**`Compare` is 36px tall where the two joined groups are 38, and that is the row as it already
was.** A group's own 1px borders sit outside its `h-9` children, so `Deck list` and
`Import and export` measure 38 at y 118 while every standalone button — `Compare`,
`Categories`, `Tags`, `History`, `Deck settings` — measures 36 at y 119. `Compare` is now
byte-identical in geometry to the four beside it, which is what moving it onto `CONTROL` bought.

### The word goes at `TIGHT_HEADER_PX` and the control does not

At **1120** (column ~857, under the 900 threshold) `Compare` is `textContent` `""` and **36 × 36**
— the bare `Scale` glyph — with the gap still 8px and `scrollWidth` 1120 = `innerWidth`. At 1920
it reads `Compare` at 94px. The tabs are unaffected at both widths, as they should be: the word
that gives way is this button's, exactly as `ACTIONS`' words do.

### It costs the row nothing at the app's own window

At **1280×800** the editor column measured **1017**, the documented figure. The actions block is
**623px on one line** — the header row's own box is 50px tall, which is one 36px line plus the
ribbon's `py-1.5`, so it has not wrapped — leaving 394px for the deck's name field. The word
`Compare` is present at this width, which is the reason the threshold is 900 rather than 1100.

### The rename reaches the dialog behind the button

Pressing `Compare` opened the difference dialog named **`Theory to Actual difference`**, headed
`Theory → Actual`, footed *"Only what Theory wants and Actual does not have. Cards in Actual but
not in Theory are cuts you have already made, so they are not listed."* — which is the half of the
rename worth driving, because a dialog still saying `Live` would be contradicting the button that
opened it. Escape closed it.

Pressing `Theory` flipped `aria-pressed` to `Theory=true` / `Actual=false` and re-read the deck
(the plan's own pile headings replaced the live list's); pressing `Actual` put it back. Nothing
about which tab is pressed or remembered moved with the order — `lastVariant` is still what
decides that.

## The deck a reader parked (#162) — 2026-08-27, `npm run tauri dev` (debug), 1920×1080, a copy of the real db

**What the issue asked for**: editing a deck, ducking over to Collection or Wishlist to check
whether a card is owned or already wished for, and coming back to Decks should land on the deck
rather than on the wall of tiles.

The whole change is two lines of `setActiveView` and a field beside `openDeckId`
(`parkedDeckId` — see its doc), so what a live pass can add over `store.test.ts` and
`App.test.tsx` is that the *editor* is what actually comes back: keyed on the id, re-read from
the backend, drawn with its cards. It is also the one place the escape hatch could have been
lost without anything going red.

The window served this worktree — `fetch('/src/lib/store.ts')` came back with `parkedDeckId` in
it, which is the check worth making in a worktree because another agent's Vite on 1420 renders
their tree into your window and nothing on screen says so.

### Five trips, and what came back

| From the editor on… | Route | Landed on |
| --- | --- | --- |
| `Azula` (100 cards) | Decks → Collection → Decks | the editor, `Deck name` = `Azula`, cards drawn (`Fire Lord Azula` on the desk) |
| `Azula` | Decks (from inside the editor) | **the gallery** — `New deck` back, no `Deck name` field |
| the gallery | Decks → Collection → Decks | the gallery, unchanged — nothing was parked, so nothing was conjured up |
| `Serah` (100 cards) | Decks → Collection → Wishlist → Settings → Decks | the editor, `Deck name` = `Serah` |
| `Serah` | Decks → Search → Decks | the editor, `Deck name` = `Serah` |

The second row is the one worth having driven. Pressing the sidebar's Decks entry while already
inside an editor still closes it, which is what stops the return being a trap: from another view
the entry is now "back to my deck", and pressing it twice is "back to the wall". If the rule had
been written as "arriving at Decks reopens the park" with no `!wasDecks`, this row would have
reopened the deck the press had just closed and the sidebar would have had no way to the gallery
at all.

### It brings back the deck and nothing else

On Collection with `Serah` parked, `document.querySelectorAll('[role=complementary]').length` was
**0** — the docked card pane is not left behind by a park, because `setActiveView` clears
`selectedCardId` on the way out exactly as it always did. `openDeckId` is still `null` off the
Decks view, so the sidebar's Decks drop target is inert on Collection, Wishlist and Search as
documented in [decks-storage.md](decks-storage.md).

### The console

A `cdp.mjs console` recorder was attached across a Collection → Decks → Search → Decks round
trip: **22 lines, no errors**. Every one of them is pragmatic-dnd's `Auto scrolling has been
attached to an element that appears not to be scrollable`, which the deck's droppable columns
emit on every editor mount and which predates this change — a park restore is an editor mount, so
it costs one more batch of them per return and nothing new.

## The folder drag, driven as a gesture — 2026-08-27, `npm run tauri dev` (debug), 1920×1080, a copy of the real db

**The first drag in this app's history that a live pass could actually drive.** HTML5 drag and
drop cannot be started from a synthetic event — Chromium refuses — so every
`@atlaskit/pragmatic-drag-and-drop` drop in this app has been undrivable over CDP, and the live
passes could only ever confirm that the right elements *were* draggable. The folder tree moved to
`@dnd-kit/dom` in this branch, dnd-kit is pointer-based, and `Input.dispatchMouseEvent` produces
pointer events the renderer trusts. `scripts/cdp.mjs pull <css> <dx> <dy>` is the command: a real
`mousePressed` → several `mouseMoved` with the button held → `mouseReleased`, which is exactly the
gesture the sensor is watching for.

Driven against a copy of the main checkout's dev database, on a top level holding one real folder
(`Expensive Decks`) and two made for the pass.

### What was asserted

Four drops, each read back in a **second** `eval` after the release and then again after a full
`location.reload()` — a reorder that only moved React state looks identical to one that reached
SQLite until you reload.

| Gesture | Landing | Result, after reload |
| --- | --- | --- |
| `B` up onto `A`'s top eighth | `before` | top level reordered: `Expensive`, `B`, `A` |
| `B` down onto `A`'s middle | `inside` | `B` nested in `A` — off the top-level wall entirely |
| `B` up onto `Expensive`'s leading edge | `before` | `B` first at the top level, out of `A` |
| `B` down past `A` | `after` | `B` last again |

All four persisted. The console recorder was attached across the last one: **no errors**, and
nothing but Vite's own connect lines and the MCP bridge's.

### The marks, sampled per frame

`pull`'s own `--probe` is read once at the last held frame and once after the release, and that is
one sample too coarse for a mark driven by React state — so the reading below comes from a sampler
armed on the manager's `dragmove` and run inside `requestAnimationFrame`. Carrying `B` up over
`Expensive Decks` (`top 178`, `height 32`, so `before` 178–186, `inside` 186–202, `after`
202–210):

| pointer `y` | line | wash | ring |
| --- | --- | --- | --- |
| 227 → 212 | — | — | yes |
| 207, 202 | `after` | — | yes |
| 197 → 182 | — | yes | yes |

Which is `folderEdge`'s quarters, drawn. Three things it settles that no test could: the ring is
up on an eligible row from the moment the folder leaves the ground, the line names the **end** it
would land beside rather than merely appearing, and the wash and the line are never both on.

**The mark is one render behind the manager's position, and that is the design rather than a
defect.** The last row above reads `y: 182` — inside the `before` band — while the DOM still shows
the `inside` wash from the previous frame. That is exactly why `useFolderDropTarget` measures the
drop from the release event's **own** coordinate instead of from `edge` state, and the comment
saying so predates this pass.

**A landing the page refuses draws nothing, live.** Carrying `B` over `A`'s `before` band while
`B` already sat immediately before `A` sampled `line: null` at `y` 247, 250 and 252 with the row
still ringed — the drop would have reproduced the order already on screen, `canDropFolder` refuses
it, and `edge` is `null`. No line leading to a write that never happens.

### What the pass found: two droppables on every element, and a drop that silently did nothing

**The first three drags did not write anything, and everything about them looked right.** The row
rang, the overlay clone followed the pointer, `dragend` arrived with
`target: "folder-target-12"` — and the order on screen never changed.

`[...dndManager.registry.droppables]` said why: **four folders on screen, eleven droppables**,
every visible row carrying two of them, and the same doubling on the draggables. dnd-kit's
`Entity` constructor ends with `queueMicrotask(this.register)` while `destroy()` unregisters
synchronously, so an entity built and destroyed **in the same tick** unregisters first and is
registered afterwards by the microtask, with nothing left holding a reference to undo it.
`React.StrictMode` — which `main.tsx` wraps the app in — does exactly that on every mount in
development: run the effect, clean it up, run it again.

And the orphan is not harmless, because it is the one from the **first** run, whose monitor
listeners were cleaned up. Collision detection picked it as the operation's target; the live hook
compared it against its own droppable, saw a different object and returned. Every mark was
correct and the drop wrote nothing.

`register: false` at both call sites plus an explicit `entity.register()` fixes it — the
registration is then synchronous and `destroy()` can always undo it. Re-measured on the same
window after the change: **7 droppables and 6 draggables**, one per element, four sidebar rows and
three wall cards. All four drops above were driven after the fix.

**Nothing in the suite could have caught it, and the regression test needed a second correction to
be able to.** Neither `render` nor `renderHook` wraps anything in `StrictMode`, so every test
mounted each effect once and every registration was the live one; `folderDrag.test.ts` now has two
tests that ask for `StrictMode` explicitly. The first draft of them passed against the bug —
counting immediately after the render reads **1** whether the leak is there or not, because the
orphan arrives on a microtask. They wait a macrotask now, and both go red when `register: false`
is removed.

### Two traps for the next live pass from a worktree

- **Vite's watcher ignores every worktree, so HMR is dead there and the dev server serves a stale
  transform.** `vite.config.ts` sets `server.watch.ignored: ["**/src-tauri/**", "**/.claude/**"]`,
  and a worktree lives at `.claude/worktrees/<name>` — so the second pattern matches the whole
  checkout. An edit made mid-pass reaches neither the window nor a `location.reload()`, and a
  cache-busting query string does not help either: `fetch('/src/lib/folderDrag.ts')` still came
  back without the change. Restart `tauri dev` (and clear `node_modules/.vite`) and re-`fetch` the
  module to confirm the new text is being served before trusting a reading. The main checkout does
  not have this problem.
- **`cdp.mjs type` takes no selector.** It joins *all* its arguments into the text, so
  `type "Zeta drag A" "input[aria-label='New folder name']"` created a folder called
  `Zeta drag A input[aria-label='New folder name']`. Focus the field first — `press` does take a
  selector — and give `type` the text alone.

### Still not driven

**The packaged build.** `tauri dev` serves `devCsp`, which carries `style-src 'self'
'unsafe-inline'`; the shipped `csp` does not, and dnd-kit's `StyleInjector` — a `CorePlugin` that
cannot be removed — positions its drag preview from a runtime `<style>` element. So the drag
preview in a `tauri build` copy is unverified and has reason to be broken. That is
[frontend-design.md](frontend-design.md)'s "The shipped CSP blocks a plugin dnd-kit cannot be told
not to load", and it needs a portable exe rather than another dev-server pass.

## Every migrated drag, driven — 2026-08-28, `npm run tauri dev` (debug), 1920x1080, a fresh sync

3a proved one gesture in the shipped window and called it the payoff. This is the rest of them:
the card payload, the category reorder, the deck being filed, the count chip, the remove tray and
the auto-scroller, all on `@dnd-kit/dom` and none of them a native HTML5 drag any more.

**Driven with `cdp.mjs pull`, and `cdp.mjs drag` cannot be used at all now.** That command waits on
`Input.dragIntercepted`, which only fires for a native drag, and there are none left in the app.
`pull` is a real press, real moves and a real release — which is what dnd-kit's `PointerSensor`
listens for.

The window was a **cold first-run sync** (117 603 cards, data from 2026-08-27) rather than a copy
of the real database, and the deck was seeded through the app's own IPC from the page: 22 printings
across two piles the app made itself (`Ramp`, `Removal`).

### The defect this pass exists for: the quick-zone bar stole a drop the pointer never reached

**Measured, then fixed, then re-measured.** A card dragged out of `Ramp` and released at
`(810, 246)` — **51px below** a quick-zone bar occupying `y 121-195`, and squarely inside the
`Removal` pile — opened the **New category** dialog. Nothing moved; the reader's gesture landed on
a surface their pointer was never over.

The mechanism is the two halves of Task 5 meeting. `defaultCollisionDetection` is
`pointerIntersection(args) ?? shapeIntersection(args)`, and the fallback compares the **dragged
element's whole rectangle** against the droppable's. A deck card is 293px tall and the bar is 74px,
so a card released anywhere in the top third of the desk overlaps the bar *by shape* while the
pointer is nowhere near it — and `CollisionPriority.Highest`, which the bar carries so that it can
beat the pile it is drawn over, then makes the shape hit win against a pile the pointer is
genuinely inside.

**The fix is `pointerIntersection` as the zone's own `collisionDetector`**, which is the narrower
statement of what the priority was always for: an overlay produces **no collision at all** unless
the pointer is inside it, and wins outright when it is. `useDndDropTarget` takes one
`overlay: true` rather than a bare priority, so the pair cannot be half-applied; the quick zones
and the remove tray are its only callers. `@dnd-kit/collision` is declared exactly at `0.5.0` for
it, beside `@dnd-kit/dom` and `@dnd-kit/abstract`.

Both directions re-measured after the fix, at the same geometry:

| Release point | Bar | What took it |
| --- | --- | --- |
| `(810, 250)` — 55px below the bar, inside `Removal`; the card's own box overlaps the bar | no zone lit | **`Removal`** — `bg-accent/10` on the section, `Ramp 11 -> 10`, `Removal 10 -> 11` |
| `(810, 132)` — inside the bar | `New category` lit | **`New category`** — the dialog opened, named for the card |
| `(1378, 272)`, before the fix | `Sideboard` lit | `Sideboard` — the shape hit, from a pointer 77px below the bar |

`QuickZones.test.tsx`'s "leaves a drop the pointer never reached to the pile it landed in" is that
geometry in miniature, and it goes red against the priority alone.

**This is the one thing jsdom could not have found.** Every box in the suite is a rectangle a test
wrote, and the plan's own overlap case gave the two targets boxes that made the priority the only
thing that could decide — which is a true test of the priority and blind to the fallback that sits
under it.

### What each gesture did

Every write re-read through a second `deckGet` **and** after a `location.reload()`, so a move that
only changed React state would have shown.

- **A card from one pile to another.** `Ramp 14 -> 13`, `Removal 8 -> 9`; unchanged after a
  reload. The pile under the pointer wore `bg-accent/10` and every other eligible pile wore
  `ring-accent` — including the two rail piles and the command zone — while the pile the card came
  *from* wore neither, which is `canDrop` refusing a move to where the card already is.
- **A multi-card drag.** Three cards picked (the ring drawn on all three, counted as
  `[data-deck-card-selected]`), one of them dragged: `Ramp 10 -> 7`, `Removal 11 -> 14`, and the
  selection cleared by the drop. **The count chip read `3 cards`**, `position: fixed`,
  `z-index: 2147483647`, at `(808, 411)` against a pointer at `(810, 386)`. That is not a 25px
  error: the offset is exactly `+12, +12` from the *previous* pointer position, which is
  `dragOperation.position.current` lagging one move behind — the same lag `test-drag.ts` moves
  twice per step for, confirmed here against a real pointer.
- **The remove tray.** The tray named the card while it was held over it
  (`Remove Lightning Bolt from deck`, a 29px strip at `y 1031-1060` spanning the editor's width),
  and the drop took the card out: 21 rows -> 20.
- **A pile moved past its neighbour by its grip.** Never drivable in this app's history — it was a
  native HTML5 drag, which Chromium will not start from a synthetic event. Pressing the grip and
  carrying the heading onto `Removal` reordered them: `[5, 9, 10, 6, 8]` -> `[5, 10, 9, 6, 8]` in
  the DOM, `Move Removal, 1 of 2` / `Move Ramp, 2 of 2` in the grips' own names, and it survived a
  reload. Only the target pile was armed; the pile being dragged was not.
- **A deck filed into a folder.** The other gesture that has never been drivable. The tile carried
  onto the folder card set `folderId: 1` on the deck row, and the gallery redrew with the deck
  inside `Shelf`.
- **The auto-scroller, which is the question Task 5 left open.** `DeckEditor`'s
  `autoScrollForElements` registration was deleted, on the argument that `AutoScroller` has been in
  the manager's plugin list since 3a. **It does scroll**: with a card held near the bottom edge,
  `AppShell`'s `main` went from `scrollTop 0` to **487** of a 535 maximum. So the behaviour is not
  merely preserved — the scroller the library walks to is the shell's `main`, which is the one
  scroller in this view since 2026-08-24 and the ancestor the deleted registration was reaching for
  through the page.

### Three things only the running window says

- **`data-dnd-source` is on live sources and on nothing else.** The open deck reported 24 of them:
  22 cards and the two flowing piles' heading wrappers. It replaces `draggable="true"`, which a
  dozen selectors in this repo used to read and which **may not be written back** —
  `PointerSensor` stands down for a press on a native draggable, so restoring the attribute would
  leave every selector passing and every drag off.
- **`folderDraggable` sets no such mark.** It is 3a's own function and does not go through
  `dndDraggable`, so a folder card is a drag source with nothing on it to say so. A folder drag was
  driven successfully all the same; this is a gap in the *handle*, not in the gesture.
- **`Feedback` clones the source, so a mid-drag DOM query sees the card twice.** Reading the grips'
  labels during the reorder returned three entries for two piles. Any live probe that counts
  elements during a drag has to expect the clone.

### The trap that cost this pass half an hour, again

**Vite serves a stale transform in a worktree, and a reload does not clear it.** The fix to
`dndTarget.ts` was on disk, `git` agreed, and `fetch('/src/lib/dndTarget.ts')` from the page kept
returning a module whose signature still read `collisionPriority`. Touching the file did not help
and neither did `?t=Date.now()`. The window went on running the old behaviour, which reads exactly
like the fix not working — one measurement was taken that way and had to be thrown out. The cure is
the one already written down one section up: stop `tauri dev`, delete `node_modules/.vite`,
relaunch, and **`fetch` the module and grep the served text before believing any reading.**

### Repeated in a packaged build — `tauri build -- --debug --no-bundle`, same day

`tauri dev` sends **no CSP at all** — Vite serves the page and Tauri is out of the response path —
so the shipped `style-src 'self'` cannot be refuted there. The two gestures that depend on it were
repeated in a portable debug binary served from `tauri.localhost`, with the bundle confirmed fresh
(`assets/index-DF3Z48lv.js` against `ls dist/assets`) after touching `main.rs` to force the relink.

- **The library's own sheets are still refused, and the copy still works.** `head style` counts
  **3** while `document.styleSheets.length` is **1** — `StyleInjector`'s three elements are in the
  DOM with no parsed sheet, exactly as
  [frontend-design.md](frontend-design.md) describes. The drag preview nonetheless computes
  `position: fixed`, `top: 426.5px`, `left: 473px`, `width: 210px`, `z-index: 2147483647` — and
  those are the **same values** as the `--dnd-top` / `--dnd-left` the library writes on that
  element as inline attributes. So the rules copied into `index.css` are the ones reading them.
- **`<html>` carries `data-dragging` through the gesture and not after**, and the quick-zone bar
  drew its four boxes.
- **The count chip draws, which is the new half.** Four cards picked with a Shift-click range, one
  of them dragged: `4 cards`, `position: fixed`, `z-index: 2147483647`, `pointer-events: none`, at
  `(811, 483)` against a pointer at `(810, 466)` — the same `+12, +12`-from-the-previous-move
  offset as in dev. Its colours resolved through `var()` to the app's own tokens rather than to the
  hard-coded fallbacks: `oklch(0.16 0.01 270)` on the felt, `oklch(0.75 0.12 85)` for the text and
  the border. So an element appended straight to `document.body` does inherit the palette, and
  **the chip is the second element to prove the distinction the CSP work rests on** — a `style`
  *attribute* is permitted by `style-src-attr 'unsafe-inline'` while an injected `<style>` element
  is refused by `style-src 'self'`.

**One trap this pass hit, and it is the live equivalent of the suite's `afterEach`.** A `pull`
whose press lands on a card *covered* by another card can leave the manager's drag operation
non-idle, and `handlePointerDown` then returns early for **every later press in that page** — so
the next four gestures reported `data-dragging: false`, no quick-zone bar and no write, which reads
exactly like the packaged build having no drags at all. The console was silent throughout. There is
no `afterEach` in a live window; the cure is `location.reload()`, and the tell is that the very
first gesture after a reload works.
