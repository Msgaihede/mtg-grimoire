# The Life tracker

Life totals, commander damage and counters for a game of Magic played at a real table — on a
phone or tablet lying on the table, read from every side, or a window everyone reads from one
side. **The light app's alone** (Android and the web, both faces); the desktop app has no Life view.
Designed on the *Life Tracker — Light App* canvas, 2026-11-19 to 2026-11-20; the binding rules are
[`apps/light/CLAUDE.md`](../../apps/light/CLAUDE.md) §9.

## 1. Where things live

| Path | Holds |
| --- | --- |
| `packages/ui/features/life/types.ts` | The vocabulary both faces and the board agree on: `LifeSetup`, the six `LIFE_FORMATS` presets, `TURN_TIMERS`, `Seating` and `resolveSeating`, `DEFAULT_SETUP` (Commander's preset) |
| `packages/ui/features/life/setup/` | The setup: `LifeSetupScreen.tsx` (the form, both faces), `setupStore.ts` (the kept setup), `layoutPreview.ts` (the Layout pictures' seat plan), `useWindowShape.ts` |
| `packages/ui/features/life/board/`, `game/` | The board and the game: `LifeBoard` (fills its parent, measures itself, owns its menu, its Back steps and "End this game?"), the game state and its save (`game/savedGame.ts`) |
| `packages/ui/features/life/LifePage.tsx` | The desktop face's page (≥ 1024px), lazy in `App.tsx` |
| `packages/ui/features/life/BoardFrame.tsx` | The box a board fills, a focus landing pad — shared by both pages (a file of its own because the desktop page reads the caption's `TitleBar`, which the phone's import fence refuses) |
| `apps/light/phone/pages/LifePage.tsx` | The phone face's page (< 1024px), `PhoneApp.tsx`'s `case "life"` |
| `packages/ui/lib/core/hostImmersive.ts` | `setImmersive(on)` — immersive: the bars away, the rotation held, the screen kept on, where the hosts differ (§5) |
| `apps/light/src-tauri/gen/android/app/src/main/java/com/mtggrimoire/app/MainActivity.kt` | The Android host's `ImmersiveBridge` (§5) |

## 2. The view, and the edition that draws it

`life` is a `ViewId`, a `NAV` row (label **Life**, lucide `HeartPulse`) after Trade, and a member of
`LIGHT_VIEWS`, so the light app's desktop rail draws it before Settings and the phone's tab bar ends
on it. `/life` is a place (`routes.ts` reads it through `isLightView`; no id under it — a game is
page state, not a place), and the desktop face's `useDesktopPlace` carries it both ways.

**The full edition does not draw it.** `FULL_EDITION.views` is `null`, "every destination `NAV`
holds" — so `lib/edition.ts` names `LIGHT_ONLY_VIEWS` (`["life"]`) and `editionHas` answers false
for them when `views` is `null`. Every reader of the full edition's views goes through it:
`AppShell`'s rail and its chord guard, `useReaches`, Settings' opening-view picker
(`StartViewPanel`, which asks `FULL_EDITION` by name), and `useStartView`'s `isStartView`, which
reads a stored `"life"` as no view at all. `App.tsx` draws the Life arm only where the edition has
it. The generated home widgets' `openView` list (`features/home/generated/catalog.ts`) does not
name it. A new list of views must ask `editionHas`, not walk `NAV`.

**No chord.** `Ctrl+1…9` is bound by index against `AppShell`'s `CHORD_NAV`; a digit for Life,
after Trade, would have pushed Playtesting and Settings one along — so `UNCHORDED` leaves it out by
name, beside Shared and Draft & Packs, and `nav.test.ts` pins Trade on `Ctrl+7`, Playtesting on
`Ctrl+8` and Settings on `Ctrl+9`. `shortcuts.ts` holds `life: []`: the tracker binds no keys.

**The phone's seventh tab.** At 360px wide seven tabs are 51.4px each (60 at six), over the 44px
floor; a longer label (Collection) is cut short on its one line. In the ≥ 600px rail a phone on its
side at 360px tall has 310px under the header (48 and the 2px mana line): seven rows of 44.3. The
rail's 8px of top padding went with the seventh tab — at 302px the rows would have been 43.1 — and
the rail scrolls rather than clips in a window shorter still. Arithmetic from the classes, not
measured in a window.

## 3. The setup

The approved design's form, without its mock chrome — the faces draw that (the phone's `Shell`
header and tab bar; the desktop's rail, under a `PageBar` titled *Life*). Top to bottom:

- **Format** — a press opening the six presets (`Dialog`), each with *N life · N players*. A
  preset fills players, life and commander damage and sets the layout to A; seating, the timer and
  *Commander damage lowers life* are the reader's and stay. The line under it says what the preset
  starts at, or *Changed from X's defaults.* with **Reset to defaults** once players, life or
  commander damage differ from it.
- **Players** 1–6 and **Starting life** 20/25/30/40 — the shared `JoinedChoices` at 44px — and a
  Custom field: digits only, at most seven (`LifeSetup.life` is 1 to 9,999,999); a total changes
  only on a number above 0, and the field shows a kept total that is not one of the four.
- **Seating** — *Around the table* / *Facing one way*: one row with its caption beside it below
  600px (the phone upright, the tab bar's breakpoint), a section with a hint line from 600px. Until
  the reader picks, it shows what `resolveSeating` would give a board as wide as the window: round
  the table below 1024px, facing one way from it.
- **Layout** — A and B picture cards of the seats in the window's shape (`layoutPreview.ts`, the
  design's `seatSpec`/`seatsFor`, kept apart from the board's `game/seating.ts` on purpose), or one
  fixed card for two players and for facing one way.
- **Turn timer** — a press opening Off, 30 seconds, 1/2/3/5/10 minutes.
- **Commander damage**, and **Commander damage lowers life** while it is on — `controls.ts`'
  `SWITCH`, the app's one switch look, not the design's knob.
- Pinned under the scrolling form: **Continue game** (with its players and turn) when
  `peekSavedGame()` has one, and the gold **Start game**. Start game over a saved game asks
  *Start a new game? The game in progress is lost.*; only *Start new game* calls `clearSavedGame()`.

The pickers and the question are the shared `Dialog` — on the phone face a Back step a finger can
drag down, from 640px a centred dialog — mounted beside the form, never inside it.

**Kept on the device, never synced.** The setup is written to `localStorage`
`grimoire.life.setup.v1` as it changes, every access in `try`/`catch`, and read back field by
field (`parseSetup`): a field that does not hold takes the default, the rest survive. The game is
the board's own key, `grimoire.life.game.v1`.

## 4. The board on each face

**Phone face.** Start game or Continue game swaps the setup for `BoardFrame`, `fixed inset-0` at
`LAYER.stage` — over the header and the tab bar, which take no rung, and under every dialog
(`overlay`), menu (`popup`) and toast (`toast`) — padded by the four `env(safe-area-inset-*)`
insets. **Back is the board's**: its `useBackClaim` steps are answered by this face's
`DialogHost` with entries in `sheetHistory.ts`, pushed at the address the reader is on, so Android's
gesture (the WebView's `goBack()`) or a browser's button lands on the board's "End this game?" and
the router sees the same place either side of it. Confirming calls `onLeave` (the save already
cleared) and the setup comes back with the caret on Start game. A page left any other way — a card
link, a crossing to the desktop face — keeps the game saved.

**Desktop face.** The same frame, `fixed` below the caption (`top-0` in the light edition, which has
none) at `LAYER.stage`, as Playtesting's board is — so the board is the window's width, which is
what seating is resolved against. This face lends no Back step, so the board's claims are nothing
here and **browser Back just leaves the view**; the setup's Continue game brings the game back.

**Commander damage faces the player counting it** (issue #1715). A swipe up a panel (or its shield
chip) opens that seat's commander damage, and every other panel then shows what its commander has
dealt them — numbers that player reads and presses, so `game/seating.ts`' `facingSeat` turns every
other panel to the counted seat's turn: upright to them, − on their left and + on their right,
whatever edge of the table its own player sits at. Only the turn changes; the boxes and the menu
button stay put, and Back to life totals turns every panel back to its own player. The calculator a
hold opens on one of those panels faces the counted seat too (`plan.seats[edit.seat]`). A panel
turned a half keeps its shape and its layout. One turned a **quarter** (a B table's head, foot and
long sides, and the three- and five-player A tables' foot against their sides) is the other way
round, too narrow for its number between − and +: `LifeHalves`' `under` puts them at its foot, each
in the middle of its half, and `placeNumber`'s `under` gives the number the panel's width short of
`HUB_SIDE_KEEP` at either side — on such a panel the menu button can sit on a side edge, which
`hubRoom` does not answer for. Facing one way changes nothing: every panel is upright already.

### Motion and touch (2026-11-25)

The light app's "feel like an iPhone app" pass ([light-app.md](light-app.md) §7.10), carried onto
the board. Everything here is the shared feature's, so both faces have it; the timings are
`motion.ts`'s and nothing on the board writes a number of its own.

- **The board rises into place and sinks away** (`BoardFrame`, the `dialog` preset): each face's
  page holds it in a presence, so the setup is already drawn beneath it as it goes, and the frame
  is `aria-hidden` and takes no press on its way out.
- **A hold is seen being counted**: the panel's body sinks to `holdSqueeze`'s scale over the hold's
  own 500ms (`HOLD_MS`), so the calculator opens from a panel already pressed in; let go early and it
  springs back (`SPRING.press`).
- **A commander swipe moves the panel with the finger** — once the move is more along "up" (in the
  panel's own frame) than across, the body follows it, rubber-banded (`pulled`: at most 28px), and
  springs home on the let-go whatever the let-go decides. The rules that decide are unchanged
  (`SWIPE_PX`, `SWIPE_MS`, `swipeable` in `LifeBoard`).
- **The panels turn**: facing the counted seat is a CSS tween of the turned frame on the `slow`
  tier, the short way round — `nearestTurn` keeps the angle unwrapped, so 180° to −90° is a quarter
  turn and the transform may read −270° where the seating says 90°.
- **The total pops** to `NUMBER_POP` and springs back each time it moves — a tap counted where it
  was made, from across the table. Scale only.
- **The calculator and the game menu rise out of the board's scrim** (`popup` over `scrim`), each
  in a presence of its own; the calculator scales from a 0-size box at the board's centre so its
  own turn and centring are untouched.
- **The setup's one-of-many choices** (Players, Seating, Starting life) slide one marker between
  segments (`JoinedChoices`' `slide`, `SPRING.marker`).
- Under reduced motion the squeeze, the pop, the follow and the turn are gone; the fades stay.

## 5. Immersive: the bars, the rotation and the screen

The owner asked (2026-11-20) that the tracker fill an Android phone's screen properly; a reader
asked (issue #1716) that the board stop turning under the players and that the screen stop
dimming and locking between turns. All three are one call: the phone page calls
`setImmersive(true)` **inside** the Start/Continue press, and `setImmersive(false)` when the board
goes, when the page unmounts and on `pagehide`. The desktop face never asks.

**The rotation held is the one the board came up in**, exactly — upside down included, so a phone
flat on the table, which the accelerometer reads badly, never flips. Not portrait: the setup is not
held, and its Layout pictures are drawn in the window's shape (`useWindowShape`), so a reader who
wants the board on its side turns the phone on the setup and presses Start there.

`hostImmersive.ts` takes the first road that is there — feature detection of an object, not a
platform probe (`phone/fence.test.ts`):

1. **A host bridge**, `window.grimoireImmersive.setImmersive(on)`. The Android host's WebView (wry
   0.55.1) answers the Fullscreen API by hiding the custom view the moment it is shown, so a
   `requestFullscreen()` there changes nothing. `MainActivity.onWebViewCreate` — which wry calls
   before its first `loadUrl`, where it adds its own `ipc` interface — adds `ImmersiveBridge` as
   `grimoireImmersive`: exactly one `@JavascriptInterface` method, which hops to the UI thread
   (`runOnUiThread`; the WebView calls an interface on a thread of its own) and, through
   `WindowCompat.getInsetsController(window, window.decorView)`, hides the system bars with
   `BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE` or shows them. The content view's insets listener reads
   the bars' *visible* insets (`getInsets`), so hidden bars pad nothing and the cutout is still
   respected. In the same hop it sets the activity's `requestedOrientation` to
   `SCREEN_ORIENTATION_LOCKED` (the rotation it is in) and adds `FLAG_KEEP_SCREEN_ON` to the window,
   and off puts back `SCREEN_ORIENTATION_UNSPECIFIED` — the manifest declares no
   `screenOrientation` — and clears the flag. The activity's `configChanges` already take
   `orientation|screenSize`, so neither recreates it. A release build minifies, so
   `proguard-rules.pro` keeps the method and its annotation. `host.test.ts` holds the name, the one
   method, the UI-thread hop, both halves of the rotation and the flag, the manifest's silence on
   `screenOrientation`, and the keep rule.
2. **The browser's own APIs** — the web app in a phone's browser — each where it is there, each
   refusal swallowed; the board is drawn either way:
   - **The Fullscreen API**, while `document.fullscreenEnabled`:
     `documentElement.requestFullscreen({ navigationUI: "hide" })`, and `exitFullscreen()` when off
     and something is full screen. A browser grants it only during a press, hence the call in the
     handler.
   - **The Screen Orientation API**: `screen.orientation.lock(screen.orientation.type)`, asked once
     the full-screen request has been answered, granted or not — Chrome holds a rotation only for a
     page that is full screen or an installed app, and lets it go by itself when full screen ends —
     and `unlock()` when off. A lock granted after the board has gone is let go at once.
   - **The Screen Wake Lock API**: `navigator.wakeLock.request("screen")`, released when off. A
     browser lets go of the lock whenever the page is hidden, so a `visibilitychange` listener,
     there only while immersive, asks again each time the page is shown; never a second ask while
     one is unanswered, and a lock handed over after the board has gone is released at once. It
     needs no press, and iPhone Safari, which has no full screen for a page, has it.

## 6. Not verified

- **The Kotlin has not been compiled here** (no Android SDK in the sessions that wrote it); CI's
  `android` job builds the APK. The bridge has not been seen on a phone — the bars, the rotation
  held or the screen kept on — nor has the Back confirmation through Android's gesture.
- Android 16 ignores an app's requested rotation on a screen 600dp wide and up for apps that target
  it (this one targets 36), so on a large tablet the board still turns; on a phone it is held.
- The web road has not been driven in a phone's browser: full screen, the rotation lock or the wake
  lock. The suites (`hostImmersive.test.ts`) stand each API in for itself.
- The tab bar's seven-tab figures are arithmetic from the classes (§2), not a measurement.
- The board's motion and touch (§4) were driven in headless Chromium at 390 × 844 under touch
  emulation: a 300ms hold read `scale(0.96)` on the panel's body, a 72px swipe along Player 1's "up"
  `translateY(-15.4px)` in its frame, and the far side turned to −270° (90°). Not on a phone, whose
  touch timing a held press depends on.
- Commander damage facing the counted seat (§4) was seen in headless Chromium over the fake
  (`mobile:dev`) at 390×844, 844×390 and 800×1280, three to six players, A and B; not on a
  phone.
