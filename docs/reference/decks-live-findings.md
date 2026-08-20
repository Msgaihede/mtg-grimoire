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
  seeded through `deck_import_resolve`/`deck_import_commit` over `window.__TAURI_INTERNALS__`:
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
- **Console over the whole pass: clean.** 377 recorded lines, no JavaScript error, no React
  warning, no unhandled rejection. Everything else was `502` from `mtgimg://` — see the
  unverified note below.

**Three bugs found, all open** (none fixed in this pass):

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
`deck_import_resolve` / `deck_import_commit` rather than a stub. The three fixtures are the reader's
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
48 is the same padding around one. The app ships **1280×800** and registers no window-state
plugin, so every first run is in the wrapping half of that table.

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
