# Component split & merge — 2026-08-16

Fourteen refactors, chosen from a 19-agent audit of `src/` in which every candidate was attacked
by a skeptic before it reached this page. **36 of 45 proposals survived; the 9 that did not are
recorded at the foot of this file so nobody re-proposes them.**

Two of the fourteen are **defect fixes** rather than refactors — they fell out of comparing the
collection table with the wishlist table, which is the whole argument for the merge that follows
them.

**The bar every item here cleared:** line count is not evidence. `CardDetailPane.tsx` (1 578),
`DeckStats.tsx` (1 091), `CardStack.tsx` (1 044), `ContextMenu.tsx` (794) and `CardGrid.tsx` (745)
were each examined and **cleared** — they are 50–66% comment, already decomposed, or held in one
piece by a written rule. The "Leave alone" table at the foot says which and why.

## How to execute this

Waves, not themes. **A wave is a set of tasks whose file sets are disjoint**, because two agents
editing one file in one tree clobber each other. Within a wave, dispatch every task at once.
Between waves, run `npm run verify` and commit.

- **Tests run once per wave, after fan-in** — never inside a task. A task's slice compiles against
  a tree its siblings are still changing.
- Each task states the files it **owns**. An agent that needs to edit a file it does not own stops
  and reports instead.
- Commit per task where the files allow it; the commit message is the task's title.
- Wave 1 is the whole of Theme A and is **one agent on purpose** — those five moves touch ~60 files
  between them with one-line edits, and no two of them have disjoint file sets.

---

## Wave 0 — the two defects

Ship these first and separately. They must not wait on the merges that would have prevented them.

### 0.1 — Fix the collection price cell's zero-copy guard `fix:`

**Owns:** `src/features/collection/CollectionTable.tsx`, `src/features/collection/CollectionPage.test.tsx`

- [ ] `CollectionTable.tsx:197` guards on `unit !== null && row.quantity !== 1`. The wishlist guards
      on `> 1`. Quantity 0 is **reachable** — the stepper is `min={0}` at `:157`, and `:214-218`
      exists solely to offer a delete button on a zero row — so a zero-copy row renders a `$0.00`
      total with `$105.18 ea` beneath it.
- [ ] `WishlistPage.tsx:720-724` records this exact shape as fixed and **"Seen live."** Take its answer.
- [ ] Write the `quantity: 0` case **first**, beside `CollectionPage.test.tsx:732-756`, which today
      covers only `quantity: 3` and a null unit price.

### 0.2 — Key the gallery cover tile on `deck.updatedAt` `fix:`

**Owns:** `src/features/decks/DecksPage.tsx`, `src/features/decks/DecksPage.test.tsx`

- [ ] `deckCoverUrl` is `/cover/<deckId>` with no cache-buster, and `images.ts:65-69` forbids adding
      one: *"a caller that must force a re-decode changes the element's React `key`, not the URL."*
- [ ] `DeckCoverPicker.tsx:409` does exactly that with `customCoverKey`. `DecksPage`'s `Cover`
      (`1565-1603`) passes **no key** — while `DecksPage.tsx:1082-1089` mounts the very settings
      dialog that uploads. So the gallery wall behind the dialog keeps painting the previous bytes.
- [ ] **There is no `imageKey` prop** — `CardImage`'s surface is `src` + `alt` + `ImgHTMLAttributes`
      minus those two (`CardImage.tsx:39-53`), and it keys itself on the URL alone (`:36`). Use
      **React's own `key`** on the `<CardImage>` element, as `DeckCoverPicker.tsx:409` does.
- [ ] **Key the custom arm only:** `key={deck.coverKind === "custom" ? deck.updatedAt : undefined}`.
      `updated_at` moves on every write to the deck (`deck.rs:1394`), and a remounted `<img>` paints
      nothing until the new bytes decode — so an unconditional key blanks an already-decoded card
      crop on a rename.
- [ ] Needs its own test asserting element **identity**; ideally a live pass.
- [ ] Known limit: `decks.updated_at` is whole seconds, so two uploads inside one second do not
      re-key. The settings dialog's preview already has this limit.

---

## Wave 1 — Theme A, the vocabulary with no home (one agent)

Eleven class recipes and helpers are defined between 2 and 12 times each, in `features/` folders
that own none of them. Every task is a pure specifier move; one of them deletes a live import cycle.

**Owns: the whole tree.** Do these five in the order given, one commit each.

### 1.1 — `DROP_RING`/`DROP_OVER` → `src/lib/dropMarks.ts` `refactor:`

- [ ] `AppShell.tsx:21 → cardMenu.tsx:41 → FolderTree.tsx:17 → AppShell` is one of exactly **two**
      import cycles in `src/`, and these two string constants are its only cause.
- [ ] New `src/lib/dropMarks.ts`, ~35 lines, **zero imports**. Update the specifier in seven feature
      files plus `AppShell.test.tsx:71` and `AppShell.stories.tsx:10`.
- [ ] Re-point the prose at `cardControl.tsx:187,628` and `features/decks/CLAUDE.md:1285,1400,1408`
      **in the same commit** — a prose-only edit routes to neither CI job.
- [ ] The cycle survives today only because `buildFolderTree` is a hoisted `function` declaration
      (`FolderTree.tsx:97`). Nothing is broken; this is prevention plus a real graph edge deleted.

### 1.2 — `FOCUS`/`FOCUS_INSET` → `src/lib/focus.ts` `refactor:`

- [ ] **22 modules import these two strings and nothing else** from `cardControl.tsx` — dialogs,
      forms, selects, the folder tree — dragging `@atlaskit/pragmatic-drag-and-drop`, `./dnd` and
      `QuantityStepper` into their module graph to learn how to draw an outline.
- [ ] `formFields.ts:10-16` and `features/decks/CLAUDE.md:229-231` already state the rule against
      exactly this, without ever applying it to `FOCUS`.
- [ ] New `src/lib/focus.ts` (~12 code lines + the WCAG 2.4.7 doc). Delete `cardControl.tsx:56-98`
      and `QuantityStepper.tsx:7-25`. **`FOCUS_INSET` is defined four times, not two** — absorb
      `SortableHeader.tsx:8` and `VirtualTable.tsx:22` as well, plus 11 inline spellings.
- [ ] **Leave `FilterChips.tsx:155`** — its `outline-offset-[5px]` is a documented variant.
- [ ] All 15 spellings are byte-identical today, so this is deduplication, not unification.
- [ ] 24 files change specifier. The shipped bundle gains nothing (no code splitting in `src/`);
      the win is vitest module-load, the layering rule, and killing `QuantityStepper.tsx:22-23`'s
      apology copy.

### 1.3 — `src/lib/counts.ts` — one `plural`, one thousands separator `refactor:`

- [ ] Four `plural` definitions with **three incompatible signatures**: `FolderTree.tsx:42`,
      `auditText.ts:73`, `DeckHistoryDialog.tsx:123`, `ClearCategory.tsx:37`.
- [ ] `const n = v => v.toLocaleString("en-US")` written character-for-character twice
      (`CollectionSummary.tsx:45`, `DeckStats.tsx:606`) and inline seven more times.
- [ ] `ImportDeckDialog.tsx:20` imports `plural` **from `../FolderTree`**, then carries
      `categoryCount` (`:54-56`) as a private workaround for the "categorys" case that
      `auditText.ts`'s default argument already solves.
- [ ] New `src/lib/counts.ts`: `count(n)` and `plural(n, one, many = one + "s")`. Delete four
      definitions. Drop `FolderTree`'s export — `ImportDeckDialog` is its only consumer. **This is
      what removes the reach-in that task 2.4 would otherwise have to re-point.**
- [ ] **`SearchPage.tsx:311-314` keeps its own ternary** — its condition is `total === 1 && !capped`,
      because `5,000+ card` must never print.
- [ ] **Convert `auditText.ts` last**: `auditText.test.ts` pins exact sentences, including a
      deliberately wrong-but-plausible word for `xGroup`.

### 1.4 — `src/lib/relativeTime.ts` — one relative-time formatter `refactor:`

- [ ] `formatWhen` (`ErrorLogPanel.tsx:57`), `formatChecked` (`useUpdate.ts:31`) and `agoText`
      (`MarketplacePanel.tsx:58`) all render on the **one** Settings page. Two use `Math.floor` and
      one uses `Math.round` (`useUpdate.ts:36,38,40`); two take `now` in **milliseconds** and the
      third takes **seconds**, with no type distinguishing them.
- [ ] New `src/lib/relativeTime.ts` exporting `ago(unixSeconds, nowMs)` on **`floor`** —
      `MarketplacePanel.tsx:52` already argues for "the coarsest unit that is still true".
- [ ] The three named functions stay exported where they are and delegate. `formatChecked` keeps its
      null arm and its `>7 days → ISO` arm.
- [ ] **Not behaviour-neutral** at half-unit boundaries. `useUpdate.test.ts:57-88` pins the strings —
      update them and say so in the commit message.

### 1.5 — `PRESS` into `src/lib/motion.ts`, `BUTTON` into `features/settings/controls.ts` `refactor:`

- [ ] The twelve-utility press recipe (`transition-[color,background-color,…] active:scale-[0.97]`)
      is spelled out at **twelve** sites and its explanatory paragraph pasted at **eight**.
      `UpdatePanel.tsx:8-11` says its `BUTTON` is *"the same string `ErrorLogPanel` carries, down to
      the character"*.
- [ ] The trap it guards: **Tailwind v4's `scale-*` writes the `scale` longhand, not `transform`**,
      so omitting it from the transition list makes the press snap. Twelve authors have remembered
      so far.
- [ ] `PRESS` and `PRESS_SOFT` (MarketplacePanel's documented `scale-[0.99]`) go in
      `src/lib/motion.ts` — `src/CLAUDE.md` already designates it as where timings live.
      `features/settings/controls.ts` takes the byte-identical `BUTTON` pair.
- [ ] `FILTER_CONTROL` (`FilterChips.tsx:46-50`) also carries `h-9 rounded-md border text-sm`, so it
      becomes a **composition**, not a re-point.
- [ ] **The claimed four-way drift is not drift** — 6 `disabled:` spellings are on controls that use
      the attribute, 3 `aria-disabled:` on controls that grey as the reader types, 3 absentees never
      grey. Nothing is wrong today; do not "fix" any of the twelve.
- [ ] Read each of the twelve call sites for a later `transition-*`/`active:scale-*` that
      tailwind-merge would let win.

**Gate:** `npm run verify`, then commit. Wave 2 cannot start before this lands.

---

## Wave 2 — the splits and the small merges (six agents, disjoint files)

### 2.1 — DeckEditor: four cuts `refactor:`

**Owns:** `src/features/decks/DeckEditor.tsx`, `src/features/decks/DeckEditor.test.tsx`,
`src/features/card/CardMenuRefusal.tsx`, and the two new files below.

`DeckEditor` is a single function from line 735 to EOF — ~2 600 lines, 14 `useState`, 75 hook
calls in the file, a 4 289-line test. All four cuts are at seams already drawn.

- [ ] **(a) `useRecentAdds` → `src/features/decks/useRecentAdds.ts`** (~95 lines). `DeckEditor.tsx:624-707`
      is already a complete, named, self-contained hook in the wrong file: four consumers (`830`,
      `1583`, `2332`, `3011`), zero references to anything else in the body. Take `NOTHING_LANDED`,
      `type Timer`, `interface RecentAdds`, `useRecentAdds`. **`LANDED_MS` stays imported from
      `./cardControl`** — it is paired with the `--animate-card-landed` stylesheet duration.
      **`NOTHING_LANDED` stays a single module-level constant** or the four views' memos see a fresh
      empty `Map` every render.
- [ ] **(b) `DeckNameField` → `src/features/decks/DeckNameField.tsx`** (~110 lines).
      `nameDraft`/`draftRef`/`typeName`/`dropDraft`/`commitName` are read at exactly one place —
      the `<input>` at `2451-2496`. `QuickAdd.tsx`/`QuickAdd.test.tsx` is this identical extraction
      already made in this folder.
      - **It must return the bare `<input>`.** `DeckEditor.test.tsx:666` walks
        `name.parentElement` and `identity.parentElement.lastElementChild`; a wrapper `<div>`
        silently re-points both assertions.
      - `NAME_FLOOR` (`376-395`) travels as the field's own constant, **written out whole** —
        Tailwind scans source text, and `:666` asserts the literal `min-w-40`.
      - `commitName` must go on reading **`draftRef.current`**, not `nameDraft`. `:834` is the only
        test that catches the double-write.
      - The Escape branch (`:2480`) stays on the input in the **target** phase (`src/CLAUDE.md:93-99`).
      - Tests `808/819/834/845` move to a new `DeckNameField.test.tsx`; `1755` (the ladder) stays.
- [ ] **(c) `RemoveTray` → `src/features/decks/RemoveTray.tsx`** (~150 lines). `dragging` (`815`),
      `overTray` (`818`) and `trayRef` (`877`) are read at exactly one place in the 2 609-line body:
      the price strip and tray at `3037-3081`. The only other lines mentioning them are their own two
      effects (`2051-2064`, `2069-2088`). The single inbound dependency, `applyDrop`, is already a
      stable `useCallback` (`1691`).
      - Its twin `QuickZones.tsx` (465 lines + a 330-line test + 349-line stories) already made this
        exact extraction and **wrote the argument down at `QuickZones.tsx:36-46`**: a component with
        its own monitor re-renders **itself** instead of the editor, four views, `DeckStats`,
        `ValidationPanel` and `DeckSearchPanel`.
      - **Take the permanent `pricesAsOf(marketplace)` line with it** — a spec §5 obligation, nothing
        to do with a drag. Name the file for the strip.
      - **It must remain a direct child of the editor's `flex flex-col gap-3` column**: the tray's
        `-top-3` *is* that column's `gap-3`, and `DeckEditor.test.tsx:1423` asserts document order
        via `compareDocumentPosition`.
      - **Not behaviour-neutral** — the editor stops re-rendering on deck-card `dragstart`/`drop`.
        jsdom cannot show a mid-drag re-render dropping a `draggable` registration. Flag it for the
        live pass.
- [ ] **(d) Fold the card-menu refusal onto `CardMenuRefusal`.** Five surfaces mount
      `useCardMenuDeps`; four render `<CardMenuRefusal>` (`CardDetailPane.tsx:383`,
      `CollectionPage.tsx:451`, `SearchPage.tsx:437`, `WishlistPage.tsx:424`). `DeckEditor.tsx:2907-2928`
      hand-draws it — the `<p>` class string is **byte-identical**; the only token that differs is
      `shrink-0` on the wrapper.
      - `CardMenuRefusal.tsx:4-10` states the one-component rule and `:16-19` names DeckEditor's
        neighbour banner explicitly. There is **no stated opt-out** at the DeckEditor site — the
        comment at `2907-2916` explains what the banner is for, never why it is not the component.
      - Give `CardMenuRefusal` an optional `className` merged as `cn("overflow-hidden", className)`
        (44 → ~47 lines). `2907-2928` (22 lines) becomes
        `<CardMenuRefusal error={menuFailure} className="shrink-0" />`.
      - **Do not hoist `shrink-0` into the shared component.** That is a layout hypothesis nobody has
        measured, and this repo's standard is a figure from the shipped window.
      - **Do not touch the five other destructive banners** (`WishlistPage.tsx:412`,
        `CollectionPage.tsx:439`, `DeckEditor.tsx:2875`, `DecksPage.tsx:733`, `SearchPage.tsx:412`) —
        each is that page's own refused-write banner, and `CardMenuRefusal.tsx:16-19` argues why.
      - `DeckEditor.test.tsx` has **no** assertion on this banner (its two `alert` assertions, `1744`
        and `3747`, are on the other one).

### 2.2 — DecksPage: lift `DeckTile` and `FolderCard` `refactor:`

**Owns:** `src/features/decks/DecksPage.tsx`, `src/features/decks/DecksPage.test.tsx`, and the two
new files.

`DecksPage`'s body is 910 lines with **50** mechanically-counted hook calls (bar: ~12), and five
components with real behaviour are unexported.

- [ ] `src/features/decks/DeckTile.tsx` (~510 lines): `DeckTile` (`1267-1545` — drag registration,
      context menu, F2, four icon controls, rename field, move popup, delete confirm), `Cover`,
      `coverUrl`, `deckBadge`/`DeckBadge` (**exported with zero importers anywhere in `src/`**),
      `DeleteConfirm`, `ICON_BUTTON`.
- [ ] `src/features/decks/FolderCard.tsx` (~135 lines): `FolderCard`, `MemberArt`, `decksUnder`,
      `FOLDER_ARTS`.
- [ ] Export the `Panel` type. Nothing else needs to cross.
- [ ] **Do NOT extract `useGalleryPanels`.** `setPanel` is called at five sites outside
      open/dismiss/close (`422, 457, 519, 601, 857`) and `openerRef.current` at five more — the hook
      would return nine things, a state bag across two files.
- [ ] **Do NOT extract `ArchivedDecks`.** Line `1015` already conditionally unmounts on
      `archivedHere.length > 0`, so moving `showArchived` down loses it every time the reader visits a
      folder with no archived decks. `DecksPage.test.tsx:450` would not catch it.
- [ ] **Menu handlers stay on the tile's own `<button>`** (`1344-1390`). `src/CLAUDE.md`: *"do not
      tidy a menu handler onto a shared row component."*
- [ ] Task 0.2 edits this same file — land 0.2 first, or fold 0.2's one-liner into this task.

### 2.3 — WishlistPage: give it CollectionPage's file layout `refactor:`

**Owns:** `src/features/wishlist/**`, plus five stale citations listed below.

- [ ] `WishlistFilterBar` (`455-558`) and `WishlistTable` (`773-876`) are unexported while their
      collection twins each have their own test and story file — `CollectionTable.stories.tsx` builds
      rows by hand with **no IPC mock at all**, where every wishlist assertion mocks
      `ipc.wishlistList` and drives the page.
- [ ] The file has already started to rot from its size: an **orphaned duplicate docblock** at
      `560-565`, plus four stale external line citations.
- [ ] `wish.ts` (~40: `printingOf`, `wishLabel`, `missingOf`) + `WishlistFilterBar.tsx` (~120,
      already takes `{wishlist}`) + `WishlistTable.tsx` (~430, carrying `REVIEW_HEIGHT`,
      `DraggableRow`, `columnsFor` module-private) + `WishlistPage.tsx` (~340).
- [ ] Nothing in `src/` imports a Wishlist internal (verified).
- [ ] **Do not tidy the table's deliberate refusal of `VirtualTable`'s `onActivate`** — documented at
      `836-841`: *"it is all-or-nothing there, and here it is per row."* Every any-printing wish
      would become a clickable row that opens nothing.
- [ ] Re-point five stale citations in the same commit: `VirtualTable.stories.tsx:20`,
      `WishlistPage.stories.tsx:39/93/269`, `CollectionFilterBar.stories.tsx:18`.

### 2.4 — FolderTree: split into four modules `refactor:`

**Owns:** `src/features/decks/FolderTree.tsx`, `src/features/decks/FolderTree.test.tsx`,
`src/features/card/cardMenu.tsx`, `src/features/decks/folderMenu.tsx`, and the three new files.

- [ ] `FolderTree.test.tsx` (175 lines) **renders no component at all** — it imports six pure
      functions and cross-tests them against `dnd.ts` — while `cardMenu.tsx:41`, `folderMenu.tsx:24`
      and `ImportDeckDialog.tsx:20` each reach into a 919-line **component** module for
      `buildFolderTree`, `folderDescendants` and a three-line `plural`. (Wave 1.3 already removed the
      `plural` reach-in.)
- [ ] `folderTree.ts` (~120, **no React import**): `indent`, `FolderNode`, `Filed`, `order`,
      `buildFolderTree`, `flattenFolders`, `folderDescendants`. **`indent()` must land here** — used
      at `654`, `761`, `864`.
- [ ] `deckDrag.ts` (~130): `DECK_MARK` … `useDeckDropTarget` (`175-305`), the declared sibling of
      `dnd.ts`.
- [ ] `MoveToFolder.tsx` (~110). **It imports `folderTree.ts`, never `FolderTree.tsx`**, or the
      `folderMenu` cycle returns.
- [ ] `FolderTree.tsx` (~440, unchanged). `FolderTree` itself has **zero** hook calls.

### 2.5 — Settings: `panelChrome.tsx` `refactor:`

**Owns:** `src/features/settings/**`

- [ ] The `<section aria-labelledby>` / `<h2 id>` / card-box triple is **character-identical** at
      `UpdatePanel.tsx:69-76`, `ErrorLogPanel.tsx:113-118`, `MarketplacePanel.tsx:278-283`. The
      hand-written id pairing is what `ErrorLogPanel.test.tsx:34` and `MarketplacePanel.test.tsx:44`
      query by — a mismatch there silently loses the region name and nothing type-checks it.
- [ ] New `src/features/settings/panelChrome.tsx`: `SettingsSection({id,title,children})`,
      `PANEL_BUTTON`, `PanelAlert({tone})`.
- [ ] **Stays out:** `SettingsPage.tsx:40-47`'s "Not here yet" (`space-y-2`, `text-dim`, no card box
      — a placeholder, not a panel); `Ribbon.tsx`'s button (deliberately one size up per
      `src/CLAUDE.md`); `MarketplacePanel`'s `ROW`.
- [ ] **The trap:** `tokens.test.ts:81` sweeps source *text* for `transition-` and demands a
      `motion-reduce` opt-out within a character window — **comments included**. The merged doc
      comment must *describe* the transition and never name the utilities
      (`FilterChips.tsx:36-38` records this dodge).
- [ ] Wave 1.4 and 1.5 both touch these files — this task runs after that gate, which is why it is
      in wave 2.

### 2.6 — `CONFIRM_*` recipes for the three inline confirmations `refactor:`

**Owns:** `src/features/decks/metaRows.tsx`, `ClearCategory.tsx`, `CategoriesDialog.tsx`,
`TagsDialog.tsx` and their tests.

- [ ] The `role="group"` box, the mount-focus effect and the cancel button are **byte-identical** at
      `ClearCategory.tsx:71-73/81-88/117-127`, `CategoriesDialog.tsx:605-607/629-636/706-716` and
      `TagsDialog.tsx:332-334/347-354/377-387`. The focus effect is the fix from commit `10761c1`,
      which this repo has already got wrong twice (`metaRows.tsx:108-121` records the independent
      repeat in FolderTree).
- [ ] **Take the recipe form, not the component form.** `CONFIRM_BOX` / `CONFIRM_DESTRUCTIVE` /
      `CONFIRM_CANCEL` in `metaRows.tsx` — this folder's established answer (`META_FIELD`,
      `META_SUBMIT`, `RowAction`). Zero props, zero state lifted, no exposure to
      `CategoriesDialog.test.tsx:743` / `TagsDialog.test.tsx:302`.
- [ ] The component form was rejected: 9 props, two inline mutations hoisted, and it swallows only
      half of a two-ended caret protocol — focus-*back* lives on the row (`metaRows.tsx:65-67`), so a
      shell can own focus-*in* only.
- [ ] **Do NOT merge the three components themselves.** `ClearCategory.tsx:8-14` argues why a clear is
      not a delete, and `features/decks/CLAUDE.md:265-267` warns that swapping `cardCount` for
      `cardCountAllVariants` *"mis-states a destructive press"*.

**Gate:** `npm run verify`, then commit.

---

## Wave 3 — the dialog shell conversion (serial, one commit each)

`src/CLAUDE.md` names `ImportDeckDialog`, `TheoryDiffDialog` and `CreateDeckDialog` as *"the three
to move onto"* `DeckDialog`, and states the cost of not doing it: **a change to modality here is an
edit to four files until they are converted.** This family is the only one in the audit that has
**measurably drifted**.

All three edit `DeckDialog.tsx`. **They cannot run in parallel.** One commit each, in this order.

### 3.1 — `CreateDeckDialog` onto the shell `refactor:`

- [ ] The cheapest rung and effectively a pure delete of ~100 lines: its scrim string is **already
      byte-identical** to the shell's (`:464` vs `DeckDialog.tsx:181`), and its panel differs only by
      a width class the shell takes as a prop — `DeckSettingsDialog.tsx:81` already passes
      `"w-[55rem]"`.
- [ ] `<DeckDialog open title="New deck" closeLabel="Close" width="w-[55rem]">{<CreateDeckBody/>}</DeckDialog>`.
      Delete `:203-218`, `:453-516`, `:612-614` and five chrome imports.
- [ ] The name-field focus (`:370-372`) survives on the shell's documented carve-out
      (`DeckDialog.tsx:166-170` skips its own `panel.focus()` when the body holds the caret) —
      `QuickZones.tsx:364-405` is the shipped precedent.
- [ ] **Two `useId`s, not one:** the shell owns `${id}-title`; the body keeps `${id}-name` (`:371`)
      and `idPrefix` (`:565,567`).
- [ ] **Not behaviour-neutral:** the ✕ takes the shell's `p-1`/`duration-150` in place of
      `size-7`/`--duration-fast`, and the `<h2>` loses `min-w-0 flex-1`.

### 3.2 — `ImportDeckDialog` onto the shell `refactor:`

- [ ] The measured drift: scrim at `bg-bg/75 grid place-items-center p-4 sm:p-6` against the shell's
      `bg-bg/70 flex items-center justify-center p-4` — **two darknesses over one editor**; the ✕ at
      two geometries and two speeds (`duration-150` vs `--duration-fast`, 120ms per `index.css:294`);
      panels at `max-h-full` / `max-h-[85%]` / `max-h-[80%]`.
- [ ] `DeckDialog` grows `title: ReactNode`, `ariaLabel?: string`, `subtitle?: ReactNode`.
- [ ] **Settle `max-h` and the ✕ transition as explicit decisions**, or the prop list grows to five.
- [ ] **"Closed is nothing mounted"** (`DeckDialog.tsx:60-66`) — the body must tolerate remounting per
      open. The Escape rung registers on the **flag**, not the mount, and `useDismissOnEscape` keeps a
      capture-phase stack where only the top token acts.

### 3.3 — `TheoryDiffDialog` onto the shell `refactor:` — **last**

- [ ] Its heading is `Theory <span aria-hidden>→</span><span class="sr-only">to</span> Live`, which is
      why `title` had to become `ReactNode` in 3.2.
- [ ] **The named break:** `DeckEditor.test.tsx:2295-2333` — row `:2304` addresses the overlay as
      `"Theory to Live difference"`, the `aria-label`. That Tab sweep is the only thing holding the
      copies to the shell's behaviour; run it after each of 3.1/3.2/3.3.
- [ ] **Acceptance is the live measurement in `features/decks/CLAUDE.md`, not a green suite**: one
      Escape closes the dialog and leaves the card pane open; 22 Tabs all land inside.
- [ ] Update `src/CLAUDE.md`'s named list of three dialogs in the final commit — the conversion is
      then done and that paragraph is wrong.

---

## After the last wave

- [ ] `npm run verify`
- [ ] **`cargo fmt`** is not run by `verify` and is the only red you can get with both suites green.
- [ ] **A live CDP pass** is owed by three items and cannot be substituted with a suite run:
      **2.1(c)** the remove tray's mid-drag re-render (drive it with a card in the air), **3.1–3.3**
      the Escape/Tab sweep above, and — if 1.5 changed any of the twelve press sites — verify `scale`
      in the **built** CSS, not in source.

---

## Rejected — do not re-propose

| Proposal | Why it died |
|---|---|
| Split `CardDetailPane.tsx` (1 578) | Only 1 of 6 bar criteria survived. The split leaves the pane with **two** focus recipes, which `CardDetailPane.tsx:53-61` says the single constant exists to prevent; and the import graph inverts twice (`SwapOffer` built by `Body` but defined in the child). |
| A 20-site `statusLine` banner sweep | A full sweep found **nine structurally distinct shapes**, and at **seven sites there is no wrapper at all** — the animated element *is* the `<p>`, stated as deliberate at `DeckStats.tsx:829-831`. It also miscounted: 20 sites across 15 files, because `AppShell.tsx:268` imports the preset as `statusLineMotion` and escapes a literal grep. |
| Merge the two comboboxes' keyboard core | Of four claimed-shared branches only two are identical (six lines). `ArrowDown` **pages** in `SetCombobox` and **reopens a dismissed list** in `QuickAdd`; `Enter` runs before the empty-options guard in one and last in the other. `src/CLAUDE.md` holds these two up as the app's cautionary tale. **Salvage:** `optionId` is byte-identical at `SetCombobox.tsx:53` and `QuickAdd.tsx:32`, and `components/PopupListbox.tsx:21-22` already exists as their shared home — a one-line pure move. |
| `useDeskLayout` extraction | The central claim was factually wrong: the dock-height `useLayoutEffect` produces **neither** output the hook was to return — its whole output is the side effect `dock.style.height = …`. `DECK_FLOOR` has **33** documentary anchors across `src/` and `docs/`. **Salvage:** export `panelCaps(viewport, deskWidth)` as a pure function *in place*, exactly as `layerMatches` already is at `DeckEditor.tsx:571`. |
| `useShellStatus.ts` out of AppShell | Its 13 hooks share state pervasively (`progress` feeds `useSyncInvalidation` *and* `syncActivity`; `busy` feeds three consumers). The claimed re-render win is false: `children` is a stable element from `App.tsx:114-131`, so React already skips the view tree. |
| `folderDestinations` unification | Its load-bearing defect cannot exist — a folder whose `parentId` names a missing row is forbidden by `schema.rs:884`'s `ON DELETE CASCADE`, asserted at `db.rs:288`, and both values come from the same `useDeckFolders()` call. |
| Merge the two `DraggableRow`s | Proposed unifying on the wishlist's `if (!element || !cardId) return` guard — but `CollectionRow.cardId` is a **non-nullable `string`** (`ipc.ts:633`), so the guard is a no-op for the collection and the change would simply not occur. |
| Extract `CoverFrame` | The code's own merge condition is *"if a third surface ever draws a cover"* (`DecksPage.tsx:1119-1122`) and there are still two. `src/CLAUDE.md:47` already names "the two cover pickers" as a card-frame exception. **Revisit when a third cover surface exists** — and note the signature cannot take `deckId`: `CoverPreview` receives `customCoverUrl` as a prop because `CreateDeckDialog.tsx:543-554` renders it for a deck with no id yet. |
| Table cell factories for collection ↔ wishlist | Deferred, not dead. Only **three of six** columns are shared: the steppers differ deliberately (`min={0}` vs `min={1}`, reasoned at `WishlistPage.tsx:674-679`), Printing is wishlist-only, Set/Finish are collection-only. **Amended 2026-09-01 (issue #284): the steppers no longer differ** — both floor at `0` and both delete there, so one of the three reasons this was deferred for is gone. The other two stand, and the collection's cell has since grown a fence (`quantityBlocked`) the wishlist has no use for, which is a fourth thing a shared factory would have to carry. L-sized. **Tasks 0.1 and 0.2 must not wait on it.** If revisited: three **column factories** (so `TableColumn<T>` stays data), and a third copy of the `Needs review:` prefix nobody proposed absorbing sits at `CollectionPage.tsx:388`. |

## Leave alone — examined and cleared

| File | Lines | Why it stays |
|---|---|---|
| `features/card/CardDetailPane.tsx` | 1 578 | 818 code lines behind 703 of comment; six components already separated. |
| `features/decks/DeckStats.tsx` | 1 091 | 53% comment; one exported pure reducer (118 code lines) plus seven leaf charts with ≤1 hook each, all with their own tests and nine per-chart stories. |
| `features/decks/CardStack.tsx` | 1 044 | 357 code lines under 66% documentation; one exported component (2 hooks), one private sub-component, one private hook whose 7 internal hooks are one machine. |
| `features/decks/DeckSearchPanel.tsx` | 948 | Already three components — `ResizeHandle` (526-648) and `OpenPanel` (650-948) mounted on the press so the query never fires for an unopened panel. Root: 104 code lines. |
| `features/search/useCardSearch.ts` | 873 | 264 code lines under 578 of comment; eight pure exported functions, all unit-tested in a 979-line sibling suite. |
| `components/menu/ContextMenu.tsx` | 794 | 392 lines of comment; its 15 hooks are one cascade machine (`panelRef` read by nine), and `src/CLAUDE.md` names ~10 shipped-failure invariants living inside it. |
| `features/search/CardGrid.tsx` | 745 | 266 code lines; 11 hooks in one chain (ResizeObserver width → columns → tileHeight → `virtualizer.measure`). Already the shared wall for three surfaces. |
| `features/card/cardMenu.tsx` | 720 | 338 code lines, two halves marked by a banner at `:358`, every piece exported and covered. Longest function 85 lines. |
| `features/decks/validation/engine.ts` | 644 | Pure, no React, longest function 65 code lines; its seam is a binding table in `features/decks/CLAUDE.md:13-19`. |
| `features/decks/DeckSettingsForm.tsx` | 565 | 351 code lines, five components, **zero hook calls** — already the merged answer for two hosts. |
| `features/search/SetCombobox.tsx` | 540 | ~18 hooks that all read each other, so the no-shared-state clause fails. |
| `features/decks/views/*` | 382–591 | `GridView` **was** the one criterion-2 violation and was fixed on 2026-08-16. No second instance exists in the cluster. |
| `components/table/VirtualTable.tsx` | 323 | `src/CLAUDE.md`: *"The three tables are one component"* — a binding rule. |
| `components/CountTag.tsx` | 85 | Merging it back is **forbidden** by `src/CLAUDE.md:59`; its second caller was removed on purpose on 2026-08-15. |
| `App.tsx` | 154 | 55 code lines; every provider's position is a documented invariant. |
