# Scanner Page Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the desktop Scanner view and the light app's phone Scanner page to the approved
canvas: a progress bar and corner buttons over the picture, a dock of primary controls, a tray of
continuous cards in scan order, tier confetti, and a phone layout with the folder/Add row on top,
the picture in the middle, a tray peek and sheet, and a landscape arrangement.

**Architecture:** Every rule stays where it is (`useScanLoop`, `useTray*`, `usePointAndShoot`,
`useScannerPrefs`, the reducers in `reader/tray.ts`). What changes is presentation: new shared
pieces in `packages/ui/features/scanner/reader/` (ScanHud, PictureNotes, TierConfetti, AddedToast
props, words), the desktop page and its dock and tray, and the phone page and its tray pieces.

**Tech Stack:** React 19, TypeScript, Tailwind v4 (`@container`, `landscape:`), motion/react,
Vitest + Testing Library, Storybook.

**Spec:** `docs/superpowers/specs/2026-10-24-scanner-redesign-design.md` (read it first; the canvas
is linked there).

## Global Constraints

- Read `packages/ui/CLAUDE.md` and `apps/light/CLAUDE.md` before touching their areas. Imports cross
  packages by name (`@grimoire/ui/…`); `@/` only inside `packages/ui`.
- Colours only from tokens (`bg-bg`, `bg-surface`, `border-border`, `text-dim`, `text-accent`,
  `text-ok`, `--color-mana-*`); dim text is `text-dim`, never `text-muted`.
- No runtime `<style>`; no `AnimatePresence mode="popLayout"`, no `animateView()` (CSP).
  Confetti draws on a `<canvas>`.
- Phone controls take the 44 px floor; refusals on the phone are words or accessible names, never
  a tooltip.
- Hints are `useTooltip()` spreads, selects are `Dropdown`, never a native `<select>`.
- Card pictures through `CardImage` / `cardImageUrl`, never a raw `<img>` of a card URL.
- **Tests: do not run the suite after each edit** (repo rule). Write/update the task's tests, run
  only the task's own test files once at the end of the task
  (`pnpm exec vitest run <files>`), and leave `pnpm verify` to the final task.
- Commit only your own files (`git add <paths>`, never `-A`), Conventional Commits, ending with the
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` line.
- Words are the spec's "Words" section, verbatim.

## Review Focus

1. A tray with zero priced rows: "Worth" is not drawn (no "$0.00"); a row with a null price adds
   nothing and counts as unpriced.
2. A waiting card with more printings than the grid has columns: its span is capped at the column
   count, never an implicit column or a sideways scroll.
3. Point & shoot on the phone when the hold is lost (pointer cancel, blur, the page hidden, a sheet
   opening): the shot stops; Send/Reset never appear under point & shoot.
4. Reduced motion: no confetti canvas mounts at all; the popup still shows, sound unchanged.
5. A landing that needs input (a printing to pick, an unknown finish): no confetti, price not gold.

---

### Task 1: Shared words, price tier and tray figures

**Files:**
- Modify: `packages/ui/features/scanner/reader/readerText.ts`, `readerText.test.ts`
- Modify: `packages/ui/features/scanner/sounds/scanSounds.ts`, `scanSounds.test.ts`
- Modify: `packages/ui/features/scanner/reader/tray.ts`, `tray.test.ts`
- Modify: `packages/ui/features/scanner/reader/trayPrice.ts`, `trayPrice.test.ts`
- Create: `packages/ui/features/scanner/reader/useLandedTier.ts`, `useLandedTier.test.tsx`

**Interfaces — Produces:**
- `readerText.ts`: `START = "Start"`, `STOP = "Stop"`, `SCAN_CARD = "Scan card"`,
  `CANCEL_SCAN = "Cancel scan"`, `CONTINUOUS = "Continuous"`,
  `STOPPED_TITLE = "Scanning stopped"`, `STOPPED_NOTE = "Press Start to begin. The camera stays on."`,
  `HOLD_TITLE = "Hold the picture to scan"`, `HOLD_NOTE = "Scanning pauses the moment you let go."`,
  `SCANNING_CHIP = "Scanning"`. `SCANNING_STOPPED` and `SHOT_READY_HOLD` are deleted (fix their
  importers in later tasks); `POINT_AND_SHOOT_HOLD_HINT` becomes
  `"Hold the picture to read. The scanner pauses the moment you let go, so moving between cards reads nothing."`.
- `scanSounds.ts`: `priceTier(price: number | null, sounds: ScanSounds): PriceTier | null` — the
  highest floor reached, `null` below `tier1` or unpriced; `soundForPrice` re-expressed through it.
- `tray.ts`: `needYouLabel(n: number): string` → `"1 needs you"`, `"2 need you"`.
- `trayPrice.ts`: `trayWorth(rows: readonly ScannerTrayRow[], priceOf: (row) => number | null | undefined): { total: number; priced: number; unpriced: number }`
  — `total` sums `price × quantity` of rows whose price is a number; `unpriced` counts copies whose
  price is `null`; `undefined` (not read yet) counts in neither.
- `useLandedTier(card: LandedCard | null, at?: MarketplaceId): PriceTier | null` — the same query
  `useLandedPrice` reads (no extra fetch) plus `useScanSoundSettings()`; `null` while unanswered,
  for a landing that `landingNeedsInput`, or below `tier1`; else `priceTier(span.high, sounds)`.

- [ ] **Step 1: Tests** — `priceTier(0.99, DEFAULT_SCAN_SOUNDS) === null`, `priceTier(1, …) === "tier1"`,
  `priceTier(1700.99, …) === "jackpot"`, `priceTier(null, …) === null`; `needYouLabel(1) === "1 needs you"`,
  `needYouLabel(3) === "3 need you"`; `trayWorth` over rows priced 42.19×1, 39.86×3, null×1,
  undefined×1 → `{ total: 161.77 (to the cent), priced: 4, unpriced: 1 }`; `useLandedTier` returns
  `"tier2"` for a $19.90 landing, `null` for a `pick` landing and for a $0.50 one. Keep the
  existing `soundForPrice` tests green.
- [ ] **Step 2: Implement** the exports above.
- [ ] **Step 3: Run** `pnpm exec vitest run packages/ui/features/scanner/reader/readerText.test.ts packages/ui/features/scanner/sounds/scanSounds.test.ts packages/ui/features/scanner/reader/tray.test.ts packages/ui/features/scanner/reader/trayPrice.test.ts packages/ui/features/scanner/reader/useLandedTier.test.tsx` — PASS.
- [ ] **Step 4: Commit** `feat(scanner): words, price tier and tray worth for the redesign`.

### Task 2: Picture parts — ScanHud, PictureNotes, AddedToast

**Files:**
- Create: `packages/ui/features/scanner/reader/ScanHud.tsx`, `ScanHud.test.tsx`, `ScanHud.stories.tsx`
- Create: `packages/ui/features/scanner/reader/PictureNotes.tsx`, `PictureNotes.test.tsx`
- Modify: `packages/ui/features/scanner/reader/AddedToast.tsx`, `AddedToast.test.tsx`, `AddedToast.stories.tsx`

**Interfaces — Consumes:** Task 1 words; `matchStrip`, `StripState` (readerText).
**Produces:**
- `ScanHud({ strip, live, variant, onReset?, onSend?, note? }: { strip: StripState; live: boolean; variant: "labelled" | "icon"; onReset?: () => void; onSend?: (opener: HTMLElement) => void; note?: string | null })`
  rendered inside the camera box (`absolute inset-0 pointer-events-none`, its buttons
  `pointer-events-auto`, `z-10` so they sit above a hold surface):
  - `role="progressbar"` `aria-label="Match progress"` 4 px along the top edge, width `strip.fill`,
    `bg-accent` when `strip.committed` else `bg-dim`; drawn only when `live`.
  - An always-mounted visually hidden `role="status"` `aria-label="Scanner status"` whose text is
    the strip's word, name, printing and sentence (empty when not `live`).
  - Top-right buttons: Reset evidence (`RotateCcw`) when `onReset`, Send scan… (`Send`, words from
    `submitText`'s `SEND_SCAN`) when `onSend`. `labelled`: 38 px pills with icon + words, `rounded-full`,
    `bg-bg/80 border-border`. `icon`: 44 px round, `aria-label` the words.
  - A note chip top-left under the bar (`role="alert"` region always mounted, words come and go):
    `strip.tone === "error" ? strip.sentence : note`.
- `PictureNotes.tsx`: `StoppedVeil()` (dim veil, `role="status"`, `STOPPED_TITLE` in the heading
  face + `STOPPED_NOTE`), `ShotReadyPill()` (top-centre pill, `Crosshair` icon, `SHOT_READY_CLICK`),
  `HoldPrompt({ compact?: boolean })` (bottom: hand icon `Hand`, `HOLD_TITLE`, `HOLD_NOTE`),
  `HeldChip()` (top-centre gold chip, dot + `SCANNING_CHIP`).
- `AddedToast` gains `tier?: PriceTier | null` (price `text-accent font-semibold` when non-null,
  else `text-text`) and `compact?: boolean` (one line: 26×36 thumbnail, the tick badge, name
  `font-heading text-[15px] truncate`, printing `font-mono text-xs text-dim`, price). Full form:
  thumbnail 44 px wide (was 76), name `text-lg` (18 px). Everything else (kinds, hold, flash ring,
  `aria-hidden`) unchanged.

- [ ] **Step 1: Tests** — ScanHud: bar absent when `live={false}`; `aria-valuenow` 100 for a committed
  strip; Reset/Send drawn only when their handlers are given; `variant="icon"` buttons named
  "Reset evidence" / "Send scan…" by `aria-label`; the note shows `strip.sentence` for an error tone.
  PictureNotes: each renders its words. AddedToast: `data-landed-price` has `text-accent` with
  `tier="tier1"` and not with `tier={null}`; `compact` renders one line (no label line).
- [ ] **Step 2: Implement.** Stories: `Scanner/Reader/ScanHud` (Labelled, Icon, Committed, Error)
  and AddedToast `Gold price`, `Compact`.
- [ ] **Step 3: Run** the three test files — PASS.
- [ ] **Step 4: Commit** `feat(scanner): progress bar, corner presses and picture notes`.

### Task 3: Tier confetti

**Files:**
- Create: `packages/ui/features/scanner/reader/confetti.ts`, `confetti.test.ts`
- Create: `packages/ui/features/scanner/reader/TierConfetti.tsx`, `TierConfetti.test.tsx`, `TierConfetti.stories.tsx`

**Interfaces — Consumes:** `PriceTier` (scanSounds). **Produces:**
- `CONFETTI: Record<PriceTier, { burst: number; rain: number; spread: number; reach: [number, number]; fall: [number, number]; duration: [number, number]; size: number; streamers: number; colors: readonly ConfettiColor[]; flash: boolean; glow: boolean }>`
  with the canvas's values (tuned for a 600 px tall picture, scaled by `height / 600`):
  tier1 26 / 0 / 62° / 70–165 / 80–140 / 1100–1450 ms / 6 / 0 / accent, mana-w;
  tier2 58 / 0 / 76° / 120–275 / 140–240 / 1300–1850 / 7 / 0.15 / accent, mana-w, text;
  tier3 112 / 0 / 88° / 170–410 / 200–340 / 1600–2350 / 8 / 0.25 / accent, mana-w, mana-u, mana-r, mana-g, mana-b, flash;
  jackpot 176 (every third piece a second wave at 320–460 ms) / 120 rain (fall 300–660 scaled,
  1900–3300 ms, delay 120–1900 ms, sway ±70) / 102° / 230–560 / 260–470 / 2000–3000 / 10 / 0.3 /
  accent, mana-w, mana-u, mana-r, mana-g, mana-b, text, flash + glow.
  `type ConfettiColor = "accent" | "text" | "mana-w" | "mana-u" | "mana-b" | "mana-r" | "mana-g"`.
- `confettiPieces(tier, box: { width: number; height: number; originX: number; originY: number }, seed: number): ConfettiPiece[]`
  (seeded, deterministic). `pieceAt(piece, ms): { x: number; y: number; rotation: number; opacity: number; scaleY: number } | null`
  — `null` before its delay and after its duration; burst: out to `reach` along its angle in the
  first 34 % (ease-out), then falling by `fall` (ease-in), fading over the last 14 %.
- `TierConfetti({ burst, originBottom = 64 }: { burst: { stamp: string; tier: PriceTier } | null; originBottom?: number })`
  — `absolute inset-0 pointer-events-none`, `aria-hidden`, a `<canvas>` sized to its box (DPR
  aware), plays once per new `stamp` on `requestAnimationFrame`, stops when every piece is done;
  colours resolved from `getComputedStyle(document.documentElement)` (`--color-accent`, …);
  **renders `null` when `useReducedMotion()` is true**. Flash: a radial gold gradient at the origin
  fading over 900 ms (1400 ms jackpot); glow: an inset gold edge pulsing over 2200 ms.

- [ ] **Step 1: Tests** — `confettiPieces("tier1", …)` length 26, every colour in tier1's list, no
  `rain` pieces; `jackpot` length 296 with 120 `rain`; same seed → same pieces; `pieceAt` is
  `null` at `delay - 1` and at `delay + duration + 1`; a burst piece's y at 34 % is above its origin.
  TierConfetti: renders no canvas under reduced motion (mock `useReducedMotion`), a canvas otherwise.
- [ ] **Step 2: Implement.** Story `Scanner/Reader/TierConfetti` with a Replay per tier over a
  dark 640×600 box.
- [ ] **Step 3: Run** the two test files — PASS.
- [ ] **Step 4: Commit** `feat(scanner): confetti by price tier over the camera`.

### Task 4: Desktop page, header and dock

**Files:**
- Modify: `packages/ui/features/scanner/ScannerPage.tsx`, `ScannerPage.test.tsx`, `ScannerPage.stories.tsx`
- Rename: `packages/ui/features/scanner/reader/ScanBar.tsx` → `ScanDock.tsx` (and its test and stories)

**Interfaces — Consumes:** Tasks 1–3; Task 5's `TrayPanel` props `condition`, `onCondition`.
**Produces:** `ScanDock(props: ScanDockProps)` with `scanning, onScanning, pointAndShoot,
onPointAndShoot, shooting, onShoot, filters, onFilters, filterError, filtersDisabled, finish,
onFinish, cameras, cameraId, onCamera` (the old ScanBar's minus condition, developer, history,
lead). Row 1: gold primary (`START`/`STOP` with `Play`/`Square`, or `SCAN_CARD`/`CANCEL_SCAN`
with `Crosshair`/`X`, cancel as a gold outline), a `role="group" aria-label="How scanning runs"`
pair of `aria-pressed` buttons `CONTINUOUS` / `POINT_AND_SHOOT`, then the Filters popover at the
far end. Row 2: `Finish` (an `AnchoredPopup` holding the finish list and its caption, trigger
"Finish: <label>") and `Camera` (the existing CameraBody) triggers.

- Page: header row = `PageTitle` + (no destination) `History` + `Developer` switch; `PageRule`.
  Main row: camera column `flex: 0 1 40rem; min-width: 22rem` (`@min-[150rem]/scan` basis 52.5rem)
  holding the picture (`flex-1`) and the dock; the tray `flex-1 min-w-[24rem]`; the developer panels
  column as today when on.
- Picture: video, `Overlay`, `ScanHud variant="labelled"` (strip = `matchStrip(reading ? verdict : null, lastAdded)`,
  `live={reading}`, `note` = the loop's error / refused reset / submit error), `StoppedVeil` when
  continuous and stopped, `ShotReadyPill` when point & shoot and not shooting, `AddedToast` with
  `tier={useLandedTier(...)}`, `TierConfetti burst={tier ? { stamp, tier } : null}` (only while `armed`),
  the camera / unavailable alerts as today. MatchStrip is no longer mounted.
- Condition moves to the tray: pass `condition={prefs.condition}` and
  `onCondition={(condition) => update({ condition })}` to `TrayPanel`.
- Update the existing tests for the new names (`Start`, `Stop`, the "How scanning runs" group, the
  Finish/Camera triggers, History/Developer in the header, the absent Defaults popover) and add:
  stopped veil shown before Start and gone after; point & shoot shows `SHOT_READY_CLICK` and the
  primary reads "Scan card"; Reset/Send buttons labelled with words.

- [ ] **Step 1: Update/add the tests above.**
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Run** `pnpm exec vitest run packages/ui/features/scanner/ScannerPage.test.tsx packages/ui/features/scanner/reader/ScanDock.test.tsx` — PASS (after Task 5 lands, or with its props in place).
- [ ] **Step 4: Commit** `feat(scanner): desktop page header, dock and picture`.

### Task 5: Desktop tray

**Files:**
- Modify: `packages/ui/features/scanner/reader/TrayPanel.tsx`, `TrayPanel.test.tsx`, `TrayPanel.stories.tsx`

**Interfaces — Consumes:** Task 1 (`needYouLabel`, `trayWorth`). **Produces:** `TrayPanelProps`
gains `condition: Condition; onCondition: (condition: Condition) => void`.

- Header: title + count; `Worth <formatPrice(total)>` when `priced > 0`; when deciding, a gold
  outlined button `needYouLabel(waiting)` (ArrowDown) whose `aria-label` is
  `` `${needYouLabel(n)}: ${NEXT_DECISION_LABEL}` `` and which runs today's walk; `Add card…`;
  `LayoutToggle`; a `⋯` button (`aria-label="Tray actions"`, `AnchoredPopup` menu) holding
  Create deck… (when `onCreateDeck`), Archive (when shown) and Clear all…, each with today's
  `aria-disabled` + tooltip refusal. Drop the separate "N cards to pick" text.
- Grid tile (`TrayTile`): one bordered card (`rounded-lg border border-border bg-bg overflow-hidden`):
  the picture (hover/focus: remove ✕ top-right, "More printings…" over its foot, as today) → a chin
  (`border-t`, padding 5 px) with the finish `Dropdown size="sm"` (flex-1) and `QuantityStepper
  size="sm"` → the name (truncate), `SET NUMBER` and the unit price (`border-t`). The newest
  tile's flash ring stays. The gold `Unknown` finish fits a 149 px tile without truncation.
- `WaitingTile`: `grid-column: span min(choices + 1, columns)` where `columns` comes from a
  `ResizeObserver` reading the list's `gridTemplateColumns` track count; cells: `ChoiceCard` per
  choice at full card size, then a dashed, card-sized "More printings…" button
  (`onMorePrintings(row)`; omitted, and the span one less, when `row.oracleId === null`).
- Footer: `FolderPicker` captioned "File into", a `Dropdown` "Condition" over `CONDITIONS`
  (`CONDITION_LABEL`), then Add as a filled gold button (`bg-accent text-accent-fg`), its
  label/refusal tooltip as today. No Create deck in the footer.
- The grid scroller keeps its `overflow-y-auto`; header and footer outside it.
- Tests: Worth hidden with no priced rows and shown as `Worth $161.77` for Task 1's rows; the
  need-you button walks to the first decision; the ⋯ menu lists the three actions; condition change
  calls `onCondition`; a waiting tile with 3 printings in a 2-column grid spans 2 (mock the
  observer); each tile's chin holds a finish control and a stepper.

- [ ] **Step 1: Update/add the tests above.**
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Run** `pnpm exec vitest run packages/ui/features/scanner/reader/TrayPanel.test.tsx` — PASS.
- [ ] **Step 4: Commit** `feat(scanner): tray of continuous cards, worth and actions menu`.

### Task 6: Phone tray pieces

**Files:**
- Rename: `apps/light/phone/scanner/TrayFooter.tsx` → `TrayBar.tsx` (and its test)
- Create: `apps/light/phone/scanner/TrayPeek.tsx`, `TrayPeek.test.tsx`
- Create: `apps/light/phone/scanner/TraySheet.tsx`, `TraySheet.test.tsx`
- Modify: `apps/light/phone/scanner/Tray.tsx`, `Tray.test.tsx` (only as the sheet needs)

**Interfaces — Consumes:** Task 1. **Produces:**
- `TrayBar` = today's `TrayFooter` props plus `condition: Condition`, minus nothing; drawn at the
  top: the folder press (name + condition under it) and `Add <ready>` (accessible name the full
  `addLabel(...)` sentence); no refusal line; the `⋯` actions move out (see below). Exports
  `destinationName`, `ROOT_LABEL`, `UNREAD_FOLDER`, `ARCHIVING` unchanged.
- `TrayActionsSheet({ open, onClose, onDismiss, rows, archiving, onCreateDeck, onClearAll, onArchive?, onHistory? })`
  — today's footer `⋯` sheet, its own component in `TrayBar.tsx` or a sibling file.
- `TrayPeek({ rows, flashKey, onOpen }: { rows: readonly ScannerTrayRow[]; flashKey: string | null; onOpen: (opener: HTMLElement) => void })`
  — header button "Scanned cards N" + gold chip `needYouLabel(n)` + chevron, then an
  `overflow-x-auto` strip of the newest rows (58×81 `CardImage` thumbs; a waiting row as a dashed
  "Pick" tile; an unknown finish as a dashed outline with "Finish?"; quantity as a `CountTag`).
- `TraySheet({ open, onClose, onDismiss, title?, rows, onRows, flashKey, marketplace?, onAddCard, onActions, bar: ReactNode })`
  — an `ActionSheet`/`Dialog` (Back-step aware like the page's other sheets): header (title + count,
  `Worth …` and `N unpriced`, + Add card, ⋯ → `onActions`, close), then `bar` (the page's TrayBar),
  then "N cards need you" + Next (the walk), then the `Tray` list, scrolling.
- Tests: TrayBar has no refusal line and Add's name is the full sentence; TrayPeek lists newest
  first and shows the need-you chip; TraySheet renders the bar slot and the list and scrolls.

- [ ] **Step 1: Tests above.**
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Run** the four test files — PASS.
- [ ] **Step 4: Commit** `feat(light): phone tray bar, peek and sheet`.

### Task 7: Phone page, upright and on its side

**Files:**
- Modify: `apps/light/phone/pages/ScannerPage.tsx`, `ScannerPage.test.tsx`, `ScannerPage.stories.tsx`
- Modify: `apps/light/phone/scanner/ScanControls.tsx`, `CameraBox.tsx`, `OptionsSheet.tsx` (+ tests)
- Create: `apps/light/phone/scanner/HoldSurface.tsx`, `HoldSurface.test.tsx`
- Delete: `apps/light/phone/scanner/MatchLine.tsx`, `MatchLine.test.tsx`

**Interfaces — Consumes:** Tasks 1–3, Task 6. **Produces:**
- `ScanControls({ pointAndShoot, onPointAndShoot, onFilters, onOptions })` — the segmented
  `CONTINUOUS | POINT_AND_SHOOT` group (44 px, `aria-pressed`) and two 44 px icon buttons
  (`Filters`, `Scanner options`). Start/Stop leaves it.
- `HoldSurface({ shooting, onHold, onTap })` — today's `HoldToScan` behaviour (pointer capture,
  cancel, blur, Space hold, `detail === 0` tap) as a full-cover transparent button over the picture,
  `aria-label="Hold to scan"`, `aria-pressed={shooting}`.
- `OptionsSheet` loses its trigger page (point & shoot is on the page now) and gains
  `startPage?: "filters"` to open on the filters page.
- `CameraBox` becomes `flex-1 min-h-0` (the picture fills what the page leaves) and takes
  `children` for everything laid over it; its own `note` chip goes (ScanHud's note replaces it).
- Page, upright: `TrayBar` (+ `ReceiptBar` under it), `ScanControls`, `CameraBox` holding
  `ScanHud variant="icon"` (Reset/Send only `!pointAndShoot && scanning`, Send by today's
  `sendable` rule), `StoppedVeil` / `HoldPrompt` / `HeldChip`, `HoldSurface` under point & shoot,
  `AddedToast` (`tier`), `TierConfetti`; then the gold `START`/`STOP` (continuous only, icons kept);
  then `TrayPeek` opening `TraySheet`. The page fits the screen without scrolling.
- Page, on its side (`landscape:` variant): two columns — left: controls, picture, Start/Stop;
  right (22 rem): `TrayBar`, the tray header (count, need-you, ⋯), the `Tray` list scrolling; no
  peek; `AddedToast compact`. Replace today's `min-[720px]` arrangement with this.
- Tests: Start/Stop below the picture; Filters opens the options sheet on its filters page; under
  point & shoot no Reset/Send and the hold prompt shows; holding (pointerdown on "Hold to scan")
  shows the "Scanning" chip and releasing hides it; the peek opens the sheet; landscape renders the
  list without the peek (mock `matchMedia('(orientation: landscape)')` or render both and assert
  the classes).

- [ ] **Step 1: Update/add the tests above** (the page's 1,900-line suite: update names; delete
  MatchLine's tests with it).
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Run** the page's, controls', options sheet's and hold surface's test files — PASS.
- [ ] **Step 4: Commit** `feat(light): phone scanner page, picture-first, on its side`.

### Task 8: Clean-up and documentation

**Files:**
- Delete: `packages/ui/features/scanner/reader/MatchStrip.tsx`, `MatchStrip.test.tsx`,
  `MatchStrip.stories.tsx` (after grep proves no importer).
- Modify: `apps/light/CLAUDE.md` §7 (the Scanner page bullets: the new arrangement, the hold on the
  picture, the landscape rule replacing the 720 px rule, MatchLine gone), `packages/ui/CLAUDE.md`
  only if a rule there names a removed component, `docs/reference/card-scanner.md` reader section.

- [ ] **Step 1:** `git grep -n "MatchStrip\|MatchLine\|SCANNING_STOPPED\|SHOT_READY_HOLD\|ScanBar\b"` — no hits outside the deleted files.
- [ ] **Step 2:** Delete and update docs.
- [ ] **Step 3: Commit** `docs(scanner): describe the redesigned scanner pages`.

### Task 9: Verify, look, ship

- [ ] **Step 1:** `pnpm verify` — green (lint, `cargo fmt --check`, clippy, Vitest, cargo test).
- [ ] **Step 2:** Storybook (`running-the-app` skill, lock): `Scanner/Page` and `Phone/Scanner`
  stories at 1440×900, 2560×1440, 390×844 and 844×390 — compare with the canvas.
- [ ] **Step 3:** Push, open the PR, bind it, arm Auto-fix and auto-merge.
