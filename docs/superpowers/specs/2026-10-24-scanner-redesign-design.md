# Scanner page redesign — design

**Status:** approved by the owner on the design canvas "Scanner redesign"
(<https://claude.ai/artifact/SnLHDJducmakXbyJcnDgEy>), 2026-10-24.
**Covers:** the desktop Scanner view (and the light app's desktop face, which draws it) and the
light app's phone Scanner page, upright and on its side.

The scanner has one recogniser now (Neural; Fast and Exact went 2026-10-24), so there is no mode
switch anywhere. The redesign is about three things: the tray, the camera picture, and the few
controls a reader uses while feeding cards.

## Desktop (and light web from 1024 px)

**Page header.** The page title ("Scanner") on the left; on the right **History** and a
**Developer** switch (the switch the scan bar carries today). Over a trade (the Trade page's scan
dialog, `destination`) neither is drawn, as today.

**Camera column**, about 40 rem wide (52.5 rem from a 150 rem view), the tray taking the rest:

- The **picture** fills the column's height.
- Over the picture, top edge: the **match progress bar only** — a 4 px bar along the top edge
  (gold once committed). The match strip's words, pill and card name are gone from view; the
  Added popup names the card. A visually hidden live region still announces the strip's state.
- Top-right of the picture: **Reset evidence** and **Send scan…** as round 38 px buttons with
  their icon *and* words. Send scan… keeps all its rules (a run, the Scanner view itself, a
  supporter's device).
- An error the scanner has to say (a recogniser that is not loaded, a refused frame or reset, a
  Send scan… pressed too soon) is a small chip at the top-left under the bar.
- **Stopped** (continuous, not scanning): the picture dims behind a centred "Scanning stopped" and
  "Press Start to begin. The camera stays on."
- **Point & shoot between shots**: a pill at the top centre, "Point at a card, then press Scan
  card."
- **Added popup** (`AddedToast`): card thumbnail, "Added to scanned cards", the name in the heading
  face, then printing · finish · price. The price is **bold gold from the first price tier up**
  (the sound ladder's `tier1`, $1 by default); below it, plain.
- **Confetti** on landing, by the same price tier as the sound (Settings → Scanner's ladder):
  from behind the Added popup; more pieces and colours the higher the tier; the jackpot adds rain
  from the top of the picture and a gold flash and edge glow. **Only over the picture.** None under
  reduced motion (the popup and the sound stay).

**Dock** under the picture:

- Row 1: the gold primary — **Start** / **Stop** (play / stop icons kept), or under point & shoot
  **Scan card** / **Cancel scan** (Cancel drawn as a gold outline) — then a segmented
  **Continuous | Point & shoot** (the stored `pointAndShoot` pref; either way it lands stopped),
  then **Filters** (the existing popover) at the far end.
- Row 2: **Finish** (menu: Detect, Nonfoil, Foil, Etched — "New cards land as", with the existing
  caption) and **Camera** (the existing camera list) as buttons with their own menus.

**Tray**, the rest of the width:

- Header: "Scanned cards" and the copy count; **"Worth $X"** (new: the sum of each priced row's
  unit price × quantity at the tray's marketplace); when cards wait on the reader, a gold
  **"N need you"** button that walks to the next one (today's *Next card needing a decision*);
  **Add card…**; the grid/list toggle; a **⋯ Tray actions** menu holding Create deck…, Archive and
  Clear all… (their refusals unchanged).
- **Cards stay in scan order.** A card waiting on a printing keeps its place and spans as many
  columns as it has printings plus one "More printings…" cell (a dashed, card-sized outline with
  the words inside), each printing at full card size; never wider than the grid. An unknown finish
  is the gold "Unknown" in that card's finish control.
- Each card is **one continuous bordered card**: the picture, then a **chin** with the finish
  dropdown and the quantity stepper (always visible), then the name, set · number and price.
  Remove (✕) and "More printings…" stay on hover/focus over the picture.
- The grid scrolls; the header and footer stay put.
- Footer: **File into** (folder) and **Condition** (moved here from the Defaults popover: it is
  read at Add), then **Add N to collection** as a filled gold button. No refusal line under it
  (the tooltip stays).

## Phone (light app, under 1024 px)

**Upright**, top to bottom, the page fitting the screen without scrolling:

1. The **folder and Add** row (today's footer, moved to the top): the folder button names the
   folder and, under it, the condition; **Add 16** beside it (its full sentence as its accessible
   name). No refusal line.
2. Controls: **Continuous | Point & shoot** (segmented), then **Filters** (opens the options sheet
   on its filters page) and **Options** as 44 px icon buttons. Point & shoot leaves the options
   sheet.
3. The **picture**, filling the middle. Over it: the progress bar along the top edge; in
   continuous while scanning, **Reset evidence** and **Send scan…** as round 44 px icon buttons
   top-right; under point & shoot **neither** (lifting the finger already ends the read).
   Stopped: the same dimmed "Scanning stopped" sentence. The same Added popup as desktop. The
   same confetti.
4. **Start** / **Stop** (continuous only), gold, full width, with its icon.
5. **The tray peek**: "Scanned cards N", a gold "N need you" chip, a chevron; a sideways-scrolling
   strip of the newest cards (a waiting card as a dashed "Pick" tile, an unknown finish as a dashed
   outline with "Finish?"). Pressing it opens the **tray sheet**: header (title, count, worth and
   how many are unpriced, Add card, ⋯ Tray actions, close), the folder and Add row, "N cards need
   you · Next", and the full list in scan order, each question on its own row; the list scrolls.

**Point & shoot on the phone is a hold of the picture itself**: a finger held on the picture reads,
lifting it pauses (today's *Scan* hold, moved onto the picture). Before a hold the picture says
"Hold the picture to scan" / "Scanning pauses the moment you let go."; while held a gold
**"Scanning"** chip sits at the top centre. Space holds it from a keyboard; Enter or an assistive
tech's activation reads one card, as today.

**On its side** (landscape, any phone width): two columns — the scanner on the left (controls,
picture, Start/Stop), the tray on the right (folder and Add, the header with "N need you" and ⋯,
then the full scrolling list; no peek). The Added popup shrinks to one line (thumbnail, tick, name,
printing, price).

## Words

- Start / Stop; Scan card / Cancel scan; Continuous / Point & shoot.
- "Scanning stopped" + "Press Start to begin. The camera stays on."
- "Point at a card, then press Scan card." (desktop between shots)
- "Hold the picture to scan" + "Scanning pauses the moment you let go." (phone)
- "N need you" (one: "1 needs you"); "Worth $X"; "File into"; "Condition".
