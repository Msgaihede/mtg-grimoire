# The keyboard shortcut map

`src/lib/shortcuts.ts` and `src/components/KeyMap.tsx`, shipped 2026-09-03. The design is
[2026-09-03-keyboard-shortcut-map-design.md](../superpowers/specs/2026-09-03-keyboard-shortcut-map-design.md);
this page is the record of what shipped, with the reason at each site and the live pass that
settled the one claim jsdom cannot. Every figure keeps the date and the build it was taken on.

The short version: **a chord is written down in `src/lib/shortcuts.ts` and nowhere else**, because
the panel that lists a chord and the handler that fires on it read the same object. A `Keyboard`
button in the caption row — and `F1` — opens a popover listing what is live **on the page the
reader is actually on**.

## Why one object and not two

A shortcut is otherwise two facts: a comparison buried in a `keydown` handler, and a sentence
somewhere describing it. Those drift, and they drift *silently* — this repo's own rule is that a
prose-only edit routes to neither CI job, so a documented chord whose handler moved goes wrong with
nothing red. The whole of what the catalogue buys is one sentence:

> **The map cannot advertise a keyboard chord that nothing binds, because the binding matches
> against the same object the panel draws.**

That is a *fence*, not a convention, and it is worth being precise about which rows stand behind
it. Of the nine entries in `SHORTCUTS`:

| Rows | Fenced how |
| --- | --- |
| `switchView`, `keyMap` (`AppShell`); `undo`, `redo`, `remove` (`DeckEditor`) | **Fenced.** The handler calls `matchesShortcut` against the entry. Rename the id and `shortcut()` throws at import; change a chord and the binding changes with it. |
| `dismiss` (`Escape`), `contextMenu` (`Shift+F10`, `Menu`) | **Prose.** The bindings live in `useDismissOnEscape` and `menu/useContextMenu`, and neither reads the catalogue. |
| `zoom` (`Ctrl+wheel`), `select` (`Ctrl`/`Shift`-click) | **Unmatchable by construction.** A pointer chord carries no `key`, so `matchesChord` answers `false` from its shape rather than from a guard a caller could forget. `useCardZoomGesture` and `multiSelect.ts` keep their own logic; the fence there is only that the label sits next to the code it describes. |

**The two prose rows are a ruling, not an oversight.** Threading a shared matcher through
`e.key === "Escape"` is more machinery than the fence buys, and both are platform conventions that
will not change. The cost is stated rather than hidden, and it was paid on the day the catalogue
shipped: `useContextMenu.ts:159` accepts `e.key === "ContextMenu"` — the keyboard's own menu key —
as well as `Shift+F10`, and the `contextMenu` row listed only the second, so the panel under-stated
what was bound. That is the harmless direction, and it is still the direction a fence would have
caught rather than a reviewer. The row carries both chords since 2026-09-03 and the panel draws
`Shift` `F10` **or** `Menu`, universal spelling first because not every keyboard has the dedicated
key; `Menu` is the cap because `ContextMenu` is the DOM's name for it and nobody's word for the
thing under their thumb. Nothing stops the pair drifting again — that is what *prose* means here —
so a change to `menuKey` is a change to this row.

## `matchesChord` is exact in both directions

Three rules, each with a failure behind it:

- **`ctrl: true` matches `ctrlKey` *or* `metaKey`.** Not hedging about macOS — it is the rule
  `multiSelect.ts:61` already states and tests, and a second, stricter spelling of it here is the
  drift this module exists to stop.
- **Every modifier the chord does not name must be absent.** `{ key: "z", ctrl: true }` matches
  neither `Ctrl+Alt+Z` nor `Ctrl+Shift+Z`. Without it one press would fire undo *and* redo, which
  is the bug the hand-rolled `key === "z" && !e.shiftKey` comparisons were written to avoid.
  Exactness is what lets the catalogue stop writing those by hand.
- **A single-character key compares case-insensitively.** `e.key` is `"Z"` while Shift is held, so
  a case-sensitive test makes every shifted letter chord dead. Longer names (`F1`, `Delete`,
  `ArrowLeft`) compare verbatim — they are already canonical, and folding them would let
  `"delete"` through as a chord nobody wrote.

### The two chords that narrowed away

Exactness is a *narrowing*, and two presses that used to work no longer do. Both were accepted
deliberately on 2026-09-03; the reviewer re-derived the old-vs-new truth table for all three deck
editor handlers independently and found these two differences and no others — undo is identical for
every input, and nothing widened.

| Chord | Was | Is |
| --- | --- | --- |
| `Ctrl+Shift+Y` | redid, because the old guard tested `ctrlKey`, `altKey` and the letter but never `shiftKey` | nothing |
| `Shift+Delete` | removed the picked cards, for the same reason | nothing |

**Neither is a convention anyone designed.** They worked as a side effect of a guard that did not
look at Shift, and restoring either means writing it into `SHORTCUTS` — where it becomes a row in
the panel, advertised to every reader as a second way to do the thing. That is worse than losing
it, and `Shift+Delete` is the clearer case: in Explorer it means *permanent, no undo*, which is
exactly the wrong promise for a removal `Ctrl+Z` takes straight back. A reader whose hands know it
presses it and nothing happens; that is the cost, it is one line in `SHORTCUTS.deckEditor` to
reverse, and it is smaller than teaching a wrong meaning.

## The text-field yield lives at the call site

`matchesChord` deliberately does **not** yield inside a text field, because that is a fact about a
*binding* rather than about matching a chord, and the two bindings disagree:

- **`Ctrl+Z` in the deck editor yields**, and that is the whole of what keeps the quick-add box, the
  deck name and the notes usable — they get the browser's own undo, which this app cannot replace
  and must not swallow.
- **`Ctrl+1…6` in `AppShell` does not**, and must not. `Ctrl+1` has no native meaning in a text
  field at all, so yielding would only make view-switching dead exactly where a reader's caret
  usually is — in the quick-add box, in a search field.

So `isTextField` stays at each call site, next to the argument for it. A yield in the matcher would
have been one rule serving two bindings that want opposite answers.

Two orderings around it are worth keeping straight. **The deck editor matches the chord first and
tests the caret second**, which inverts `useContextMenu.ts:119`'s stated precedent. Both are the
same rule — pay for the cheap half first — read against different expensive halves: there the item
list is rebuilt on every press and `isTextField` is the cheap guard, here matching two chords is
arithmetic over an event while `isTextField` is a `closest()` walk up the DOM, paid on every
keystroke typed into the quick-add box for the two presses in a session that are `Ctrl+Z`.

`Ctrl+1…6` carries a different guard instead: `document.querySelector('[aria-modal="true"]')`.
`Dialog.tsx` is the one modal chrome in this app and always sets the attribute, so asking the
document is asking the thing that knows, with nothing to register and nothing to keep in step. **`F1`
passes that guard on purpose** — the map is *more* use with a dialog up, not less.

## Scope: the editor replaces `Decks`, it does not nest under it

```
activeScopes = ["global", openDeckId !== null ? "deckEditor" : activeView]
```

Two fields already in the store and no registration machinery — a scope that registered itself on
mount would be a second source of truth about what is drawn, and the store already answers that
question. `"global"` is first and always present.

**The replacement is `App.tsx:44`'s shape, read back**: `openDeckId === null ? <DecksPage /> :
<DeckEditor … />`. The editor is rendered *in place of* the decks page, so a `Decks` section under
an open editor would list chords for a page that is not on screen. `deckEditor` is therefore not a
`ViewId` and never will be.

**A scope with no shortcuts draws nothing — not a heading over a gap.** **All six view scopes are
empty today** — `search`, `tags`, `decks`, `collection`, `wishlist`, `settings` — and `SHORTCUTS`
spells each of them out with an empty array rather than leaving them off the record: making the
emptiness explicit is what stops a scope being forgotten when a view starts binding something.
(**"Five of the six" was written down four times and corrected twice**, which is worth keeping as
the shape of the mistake rather than as a state anything is still in: it counts `decks` as carrying
the editor's chords, and `deckEditor` *replaces* `decks` rather than nesting under it — the
paragraph above. The design and `KeyMap.tsx`'s comment were corrected first, `KeyMap.stories.tsx`
and `KeyMap.test.tsx` on the review pass that found them still saying it. Six, not five, in all
four.) That emptiness is the whole reason `Ctrl+1…6` sits in
`"global"` — it is what gives the panel something true to say on a page that binds nothing.

## `range` is declared, never counted

`switchView` carries six chords and the panel draws `Ctrl` `1` **to** `Ctrl` `6`; `redo` carries two
and the panel draws `Ctrl` `Y` **or** `Ctrl` `Shift` `Z`. Which shape to draw is a `range?: boolean`
on the entry, and the panel reads the flag.

**It was `chords.length > 2` first, and that was right for exactly as long as `switchView` was the
only long entry.** A count cannot tell six steps of one sequence from three genuine alternatives, so
the first shortcut ever written with three spellings would have drawn "`A` **to** `C`" — a promise
about a chord nothing binds, in the one panel whose whole job is to be true. Whether the middle of
a run can be inferred is a fact about the run, so it is the entry's to state and nobody else's.

Both ends are drawn whole (`Ctrl` `1` to `Ctrl` `6`, not `Ctrl` `1` to `6`): collapsing the second
chord's modifiers assumes the run shares them, which is true of the one range that exists today and
is not a fact the component can check. The separator is a **word** in both shapes — an en dash
between two caps is read out as nothing at all by a screen reader, and `1 6` is a different
shortcut from `1 to 6`.

**And the caps are held apart by a text node, not by the `gap` between them** (2026-09-03). A row
of `<kbd>`s separated only by `gap-1` flattens to `Ctrl1toCtrl6` when a text alternative is
computed — the `Missing2` failure this repo already has a rule about, one surface over — so the
word `to` is not enough on its own. A whitespace text node fixes it at no visual cost: a sequence
of child text runs that is *only* white space is not rendered by a flex container and becomes no
flex item (CSS Flexbox §4), so the drawn row does not move. The alternative was an `aria-label` on
the `<dd>`, refused twice over — `<dd>` maps to `definition`, a role browsers do not agree takes an
author's name, and the label would be a second spelling of the caps, free to drift from the ones
drawn. `KeyMap.test.tsx` pins the flattened reading of all three shapes; **jsdom lays nothing out,
so only a browser can confirm the row is unchanged to the pixel.**

## Two presses of the panel's own, each with a guard

Both landed on the review pass, 2026-09-03, and neither is visible in the shipped window without
looking for it.

**`F1` swallows auto-repeat, and `Ctrl+1…6` deliberately does not.** Holding a key fires `keydown`
at the OS repeat rate, so a *toggle* on that press strobes the panel through its own fade for as
long as the finger is down and lands on whichever side the reader let go on. The guard is on the
`F1` branch alone: re-selecting the view you are already on is idempotent, so a guard there would
be a rule with no failure behind it, and one hoisted to the top of the handler would answer the
question for every chord the shell ever binds — including a stepping chord, where repeating *is*
the binding. The press is still `preventDefault`ed on every repeat, so a held `F1` never reaches
the browser either. `userEvent` cannot express auto-repeat at all (every keydown it dispatches
carries `repeat: false`), so that case is the one press in `AppShell.test.tsx` fired by hand.

**Escape hands the caret back when the caret has nowhere to go — never merely when the panel is
open.** That is the whole of the rule, and getting it wrong is possible in both directions. The
panel has two ways in and they leave the caret in two places: a press on the trigger puts it inside
the box, while `F1` opens the panel and moves *nothing*. So a reader typing in the deck editor's
quick-add box who presses `F1` and then Escape was never anywhere but that field, and an
unconditional `focus()` carried them off to the caption row — a layer handing back a caret it never
took. **But `contains(document.activeElement)` alone trades that bug for the one the hand-back
existed to prevent**: nothing in the panel is focusable, so a press on its own text blurs to
`<body>`, `contains` answers `false` for that, and Escape then leaves the caret on `<body>` where
the next Tab restarts from the top of the app. The condition is therefore **inside the box _or_
nowhere** — `document.activeElement` null or `<body>`, which is what a browser leaves behind when
the thing holding the caret stops being focusable. It is `useFolderFieldReturn`'s reading exactly,
met from the other side: that hook restores on the same null-or-`<body>` test because the element
it would hand back to has been replaced. Both halves are pinned and each fails on its own —
reverting to the unconditional `focus()` reddens the `F1` case alone, reverting to the bare
`contains()` reddens the `<body>` case alone (`KeyMap.test.tsx`, both measured 2026-09-03).

## The panel needs no `LAYER` rung

`TitleBar`'s root carries `LAYER.caption` (`z-60`), and **a z-index other than `auto` on a flex
item creates a stacking context whatever its position** — the same sentence of the flexbox spec
`LAYER.overlappingMark` already rests on. So everything drawn in that subtree, a `fixed` descendant
included, paints at the caption's place in the app-wide order: above `gate` (`z-50`) and above
`overlay` (`z-45`) with no number of its own. `src/lib/layers.ts` was not touched, and the panel's
computed `z-index` is `auto`.

This is the one claim in the design that jsdom cannot check — jsdom paints nothing — so it was
driven in the real window. See live-pass item 3 below; it is the proof, not a restatement.

The panel is also **anchored and `fixed` from measured numbers, never portalled**, through the
`usePopupPlacement` + `PopupPanel` pair `Dropdown` already uses. The shipped CSP is
`style-src 'self'` with `style-src-attr 'unsafe-inline'` beside it: a measured inline `style` is
legal and an injected `<style>` element is blank in a packaged build. `align: "end"` so the panel's
right edge tracks the button's, which at `w-96` (384px) against the app's 1024px minimum window
keeps `endFits` true and pins the panel to the corner it grows from.

## The live pass — `tauri dev`, debug build, 2026-09-03

Windows 1920×1080 then 1024×768 (the narrowest the app allows). Driven over `scripts/cdp.mjs` plus
raw CDP where that harness could not reach.

1. **`F1` reaches the page in WebView2 and opens the panel.** This was the design's biggest open
   question and it was a prediction until it was driven: Chrome reserves `F1` for its own help,
   WebView2 has no help page, so it *should* arrive. It does.
2. **`Ctrl+3` → Decks and `Ctrl+5` → Wishlist. `Ctrl+2` under an open `Dialog` did not switch** —
   `activeView` stayed `decks` and the dialog stayed open. The `[aria-modal="true"]` guard works
   live, not just in jsdom.
3. **Paint order, the design's central claim.** With a real `Dialog` open, `elementFromPoint` over
   the panel returned an element *inside the panel*, not the scrim. Then a `fixed inset-0` div was
   injected at `z-50` — `SyncProgress`'s gate rung, and the exact shape of the bug `LAYER.caption`
   was added to fix — and `elementFromPoint` still returned the panel, and still returned the
   caption buttons. The panel's own computed `zIndex` is `auto` and its `position` is `absolute`
   inside the `fixed` frame: it inherits `TitleBar`'s `z-60` stacking context exactly as designed.
   The probe was removed afterwards.
4. **Placement.** At 1920×1080 the panel's right edge is **1782**, which is the button's right edge
   exactly — and 1920 − 138, the three 46px window verbs to its right. Top **37**: the button's
   bottom edge at 33 plus `place.ts`'s `PANEL_GAP` of 4, so the panel clears the 34px caption row
   without a flip. At the 1024×768 minimum the right edge is **886** (1024 − 138, the button again),
   with no overflow on either axis, and `documentElement.scrollWidth` 1024 = `clientWidth` — the app
   does not gain a sideways scroll.
5. **The button is not a drag region.** It carries no `data-tauri-drag-region` and a real CDP click
   opened the panel: Tauri does not swallow the press.
6. **Escape closes and hands the caret back** — `document.activeElement` is the trigger button
   afterwards. **That reading is the click path's, and the hand-back has been conditional since
   the review pass later the same day**: it fires only where the caret is already inside the
   panel's box, which is what a press on the trigger leaves and what `F1` does not. The `F1`-then
   Escape path is pinned in `KeyMap.test.tsx` and has **not** been re-driven in the window.
7. **The scope swap.** On Search the panel drew **one** heading, `Everywhere` — the `search` scope
   binds nothing and drew nothing at all, no empty heading. In the deck editor it drew `Everywhere`
   + `Deck editor` and **no** `Decks` section.
8. **Both chord shapes render correctly**: `Ctrl 1 to Ctrl 6`, and `Ctrl Click or Shift Click`.
9. **The trigger's tooltip is hidden behind the open panel, and that is confirmed harmless.** See
   below.

## Two things for whoever drives this next

**`cdp.mjs` cannot press `F1` or `Ctrl+<digit>`.** Its `key` command knows twelve named keys
(`Escape`, `Enter`, `Tab`, the four arrows, `Home`, `End`, `Delete`, `F10`, `ContextMenu`) and its
`press` command knows two (`Enter`, `Space`). No function key but `F10`, and no digits at all. Both
new bindings therefore need a raw `Input.dispatchKeyEvent` over the CDP session rather than the
harness — `key F10 --shift` works, `key F1` throws `unknown key`. Adding them to `KEYS` is a
one-line change each and was deliberately not made mid-pass;
[live-ui-verification.md](live-ui-verification.md) is the harness contract.

**The trigger's tooltip is invisible while the panel is open, and it is not a stuck ghost.** The
hint is drawn by the app's one tooltip host at `LAYER.tooltip` (`z-46`), which is *outside* the
caption's `z-60` stacking context — and `TitleBar`'s own comment records that this row's hints are
the ones `placeTooltip` always flips **downward** rather than off the top of the window, i.e.
straight into the rectangle the open panel occupies. Measured on 2026-09-03: the hint sits at
(801, 41), inside the open panel's rect, on a host at `z-index: 46`, so the panel covers it; and it
clears when the pointer leaves (0 stale nodes remained). **The ruling is to leave it.** It costs
nothing a reader needs — the open panel *is* the answer the hint points at — and fixing it means a
second prop on `CaptionButton`, whose whole shape is that it has almost none.
