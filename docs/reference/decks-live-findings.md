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
- **To read a 210px card at a legible size, clone the column rather than zoom the page.**
  `document.documentElement.style.zoom` reflows the editor and carries the stack out of the
  viewport; `cdp.mjs size` is fixed at `deviceScaleFactor: 1` and cannot magnify. What works is
  cloning the column into a `position: fixed` element with its own `zoom` — inline styles and
  `data-*` attributes come with the clone, so an open card stays open in it. Remove it before
  any further probe: it is a second copy of every `[data-stack-column]` and `[data-stack-open]`
  in the document, and it will double every count taken after it.
- **"A positioned element paints above a static sibling" is false for flex items, and only the
  window could say so.** The redesign's quantity tag has to cover the Game Changer banner tucked
  10px under its slanted tail. The first implementation did it without a z-index — tag
  `position: relative`, banner `position: static` — on that rule. Measured 2026-08-13 with
  `document.elementFromPoint` inside the overlap: the answer was **the banner**, with the tag
  computing `position: relative` and the banner `position: static`. Flex items paint as inline
  blocks in *order-modified document order*, so a later sibling wins whatever its position. The
  fix is `LAYER.overlappingMark`, which works for the same reason the trick did not: on a flex
  item a z-index other than `auto` creates a stacking context whatever its position. Re-probed
  at three depths — 5px and 8px into the overlap answer the tag, and 3px answers the banner,
  which is correct because the tag's `clip-path` has already receded there. **jsdom paints
  nothing and a class assertion cannot see any of this**; the suite was green throughout.
- **Driven 2026-08-13 after the `CardStack.dc.html` redesign, on a 10-row Commander deck**
  seeded through `deck_import_resolve`/`deck_import_commit` over `window.__TAURI_INTERNALS__`:
  the quantity tag, the Game Changer banner, `RULE BREAK`, the data line and the stepper column
  all draw, `[data-stack-open]` counted exactly **1** across a hover, and the printed card faces
  paint over the app-drawn frame. **The pixel geometry was not re-measured** — no margin, top or
  list height was read back — so the superseded note at the top of this file still stands. Two
  defects it did find, both now fixed: the stepper was 28px with a 6px radius against the
  canvas's 24px and 8px, and the `Move…` select — which the canvas does not draw at all — sat
  beside the stepper and covered about three-fifths of the width of a 210px card face.
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
- **Console over the whole pass: clean.** 377 recorded lines, no JavaScript error, no React
  warning, no unhandled rejection. Everything else was `502` from `mtgimg://` — see the
  unverified note below.

**Three bugs found, all open** (none fixed in this pass):

1. **The editor's title row collapses the deck name to 18px and overflows into the format
   select, at the app's own default window.** The row is `flex min-w-0 flex-1` holding the name
   input (`shrink: 1`) beside two `shrink-0` children — the variant tabs (102px; the same two
   buttons, which read `Theory | Live` since the move-on-enable change) and the
   "N cards differ" button (107px) — which together already exceed the container, so the input
   absorbs the entire deficit. Measured: name width **18px at 1100, 1200 and 1280**, and the
   container overflowing by **202px / 102px / 22px** respectively; `overflow` is `visible`, so at
   1280 the button's last **9.9px** is painted over by, and hit-tests to, `select[aria-label=
"Deck format"]`. Fine at 1360 (76px) and above, and fine at 1024 (459px) where the toolbar
   wraps — so the broken band is roughly **1060–1350px and the shipped 1280×800 sits inside it**.
   Only bites when `theory_enabled` is on, which is why nothing caught it.
2. **A custom deck cover never appears in the gallery.** `DecksPage`'s `Cover` takes only
   `cardId` and builds `cardImageUrl(cardId, 0, "art")`; it has no `custom` arm, never reads
   `deck.coverKind` and never forms the `/cover/<deckId>` URL that `DeckSettingsDialog` uses. So
   a deck with `cover_kind = 'custom'` and a real file on disk renders **"No cover"** on the tile
   — the one place the picture exists to be seen — while the settings dialog you chose it in
   shows it correctly. Confirmed after a full reload, with the route itself proven working.
3. **Table view starves the card name.** Seven fixed columns take **696px of 963px**, leaving the
   two `fr` columns 147px between them: **Card name gets 84px** (`minmax(0,2fr)`) and Type 63px,
   truncating names to ~10 characters, while the empty Tags column holds 112px and Owned 64px.

**Unverified, and not by choice:**

- **Card art could not be rendered at all.** `cards.scryfall.io` was unreachable from this
  machine (a bare HTTPS HEAD times out; `api.scryfall.com` answers), so every fetch failed and
  `data/images` was never created. What this _does_ prove is that the `mtgimg://` handler is
  registered and routing — the failures were the app's own **502**, its documented "failed
  fetch", not a browser-level protocol error — and the `/cover/` route needs no network and was
  verified end to end. But **no card image has been seen decoding in this build.**
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
  `preventDefault()` + blur — right in the settings dialog, where blur *is* the write — so
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
  opens a native window CDP cannot reach. So at create, *path → shown filename → upload after the
  INSERT* is covered by tests and the **click → path** step is not — and neither is the refused
  upload's "Open deck" state, which needs that same picker to reach.

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
- **Two arrangements were measured before the third was kept.** A band that *shrinks* (`min-h-0`
  + `overflow-y-auto`) held the deck at 384 and took **92px** for **229px** of charts — a
  scrollbar over a chart nobody can read. A band that is `shrink-0` inside an `overflow-y-auto`
  editor draws whole: the column wants **847px** in the **710px** a 1280×800 window leaves, so
  the deck holds 384, the band its full 230, and the last **138px** is one scroll away. At
  1920×1080 the editor overflows by **0** and the deck takes the surplus (**612px**). All four
  views agree to the pixel (Stacks, Table, Text, Grid: desk 384, band 230, band top 688,
  `body.scrollWidth` 1265 — no horizontal scroll at any of them).
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
