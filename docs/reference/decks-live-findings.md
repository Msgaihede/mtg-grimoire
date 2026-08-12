# Deck builder, driven in the shipped window

Moved out of the root `CLAUDE.md` verbatim, so nothing measured was lost. Every figure keeps the date and the build it was taken on.

The whole rebuild had been proven by tests and by Storybook, and **neither runs in the window
that ships**. This is what a CDP pass over the real WebView2 added, and the three bugs it found
are all things no suite could have seen.

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
- **Reduced motion holds**: `transitionProperty` is `none` on the stack card and on the view
  buttons under `prefers-reduced-motion: reduce`, while `transitionDuration` still reads `0.15s`
  — the exact false failure [live-ui-verification.md](live-ui-verification.md) warns about,
  reproduced here on purpose.
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
   input (`shrink: 1`) beside two `shrink-0` children — the Live/Theory group (102px) and the
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
