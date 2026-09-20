# New printings widget — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development`
> (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `newPrintings`, a tenth home-page widget kind that lists reverse-chronological
reprints — grouped by release day — of cards the reader's watched decks already hold, with a
per-row popover of which decks hold that card.

**Architecture:** One new read command answers the feed (two statements over one `WHERE`, never a
join that multiplies a printing by the decks holding it); one new write command moves the *seen*
cursor. The command is registered on both targets — desktop's `invoke_handler` **and** the web
route table — and `home.rs` is untouched, because `kind` is a free `String` there and `config` an
opaque `Value`. The widget body borrows `ActivityWidget`'s day grouping and `PriceMoversWidget`'s
two rules: one read whatever the box, and a separate sentence per empty situation.

**Tech Stack:** Rust (rusqlite, tauri command), TypeScript 6 / React 19, TanStack Query, Tailwind,
Vitest, Storybook.

**Spec:** [`docs/superpowers/specs/2026-09-20-new-printings-widget-design.md`](../specs/2026-09-20-new-printings-widget-design.md),
with artboards in [`new-printings-widget/`](../specs/new-printings-widget/). Issue
[#462](https://github.com/Msgaihede/mtg-grimoire/issues/462).

---

## Where the spec and the source disagree

The brief is that *a spec that contradicts the source is the spec being wrong*. Eight places were
checked against the tree at `e897fd27`. **Six are the spec being wrong and the plan follows the
source; two are the spec being right and I verified it.**

| # | Spec says | Source says | Plan follows |
| --- | --- | --- | --- |
| 1 | §10: `src-tauri/src/lib.rs` — register the command | `lib.rs` only declares modules (`pub mod …`). Registration is `desktop.rs`'s `invoke_handler`, lines ~600–612 | `desktop.rs` |
| 2 | §10 names no web file | `src-tauri/src/web/route.rs` carries `COMMANDS` (an allow-list), a match arm per command, **and** a `COMMANDS.len()` assertion currently pinned at `172`. A command missing here is dead on the web and Android targets — `price_movers` and `set_completion` are both in it | Route both commands, bump the count by `awk` |
| 3 | §10 names no Storybook file | `.storybook/fake/db.ts` carries a `readHandlers` entry per read command; without one the stories render an error, not a widget | Add a `new_printings` handler |
| 4 | §10 names no mirror file | `src/lib/ipc.test.ts` compares a **named list** of Rust structs field-for-field (`["PriceMover", priceHistoryRs, "PriceMover"]`) plus hand-written `declares` cases pinning command and argument names. A struct on neither table can drift silently | Add three struct rows and two `declares` cases |
| 5 | §2 SQL: `FROM corpus.cards p` | The corpus is `ATTACH`ed and every query in the crate names `cards` **unqualified** (`set_completion.rs:97` is `JOIN cards c ON c.id = o.card_id`). Only `ingest.rs` and one test qualify, and both are DDL | Unqualified `cards` |
| 6 | §4: thumb `34 × 46`, row **54px** | The artboard's thumb is a **hand-drawn placeholder** (`width: 34px; height: 46px` inline). The real `CardArt` is `w-full` with `aspectRatio: 5 / 7` (`lib/images.ts`'s `CARD_ASPECT`), so 34px wide is **47.6px** tall and the row would be 56 | **33px wide → 46.2px tall**, row stays **54**. See below |
| 7 | §8: the size matrix | **Verified, every cell.** See below | Keep §8 |
| 8 | Brief names `src/features/home/CLAUDE.md` | **The file does not exist.** This folder's binding rules are `src/CLAUDE.md` plus the module docs on `widgets.ts`, `fit.ts`, `keys.ts`, `widgetProps.ts` and `WidgetParts.tsx`, which are unusually complete | Read those; do not create a folder `CLAUDE.md` as part of this branch |

### On #6 — why 33px and not 56px

The row is `46 + 2×3 padding + 2×1 border = 54`, and **54 is the number the whole of §8 was
computed against**. Two ways to keep the arithmetic honest:

* **33px wide → 46.2px tall** (5:7). The drawn 46 survives, `ROW_PX` stays 54, §8 survives, and the
  cost is one pixel of width the artboard drew. The 0.2px of drift per row is exactly the case
  `fit.ts`'s module doc already permits — *"an estimate a few pixels out costs a scrollbar rather
  than a sentence"*.
* 34px wide → `ROW_PX = 56`, and every count in §8 needs recomputing against a fixture nobody has.

**Take the first.** `WidgetRow`'s own art slot is `w-[34px]`, but this body is not drawing a
`WidgetRow` (see Task 6), so nothing is made inconsistent by the choice.

### On #7 — §8 reproduces, with one column qualified

Recomputed from `fit.ts` verbatim (`spanPx(n, 104) = 116n − 12`; `listColumns =
max(1, round(widthPx / 240))`; `bodyHeightPx = heightPx − 2·CARD_BORDER_PX − titleRowPx(h) −
bodyPadPx(h, false)`, which is `heightPx − 52` for every `h ≥ 2` at comfortable density):

| Footprint | §8 px | computed | §8 cols | computed | body px |
| --- | --- | --- | --- | --- | --- |
| 2 × 2 | 220 × 220 | 220 × 220 ✓ | 1 | 1 ✓ | 168 |
| 2 × 3 | 220 × 336 | 220 × 336 ✓ | 1 | 1 ✓ | 284 |
| 3 × 2 | 336 × 220 | 336 × 220 ✓ | 1 | 1 ✓ | 168 |
| 3 × 3 | 336 × 336 | 336 × 336 ✓ | 1 | 1 ✓ | 284 |
| 4 × 3 | 452 × 336 | 452 × 336 ✓ | 2 | 2 ✓ | 284 |
| 6 × 4 | 684 × 452 | 684 × 452 ✓ | 3 | 3 ✓ | 400 |
| 8 × 3 | 916 × 336 | 916 × 336 ✓ | 4 | 4 ✓ | 284 |
| 2 × 6 | 220 × 684 | 220 × 684 ✓ | 1 | 1 ✓ | 632 |
| 3 × 8 | 336 × 916 | 336 × 916 ✓ | 1 | 1 ✓ | 864 |
| 4 × 12 | 452 × 1380 | 452 × 1380 ✓ | 2 | 2 ✓ | 1328 |
| 2 × 12 | 220 × 1380 | 220 × 1380 ✓ | 1 | 1 ✓ | 1328 |
| 6 × 12 | 684 × 1380 | 684 × 1380 ✓ | 3 | 3 ✓ | 1328 |

Every pixel and every column reproduces, and `bodyHeightPx` at 12 cells is **1 328**, which is the
figure §8's closing paragraph quotes. **So §8's geometry is sound and stands.**

**Its `Printings` column is fixture-bound and must not be asserted as an invariant.** Those counts
were taken over the artboards' sample (45 printings over 18 release days, 25 inside 90 days), and a
day header costs 16px over a 6px gap with 8px between groups — so how many rows fit depends on how
the days happen to clump. Worked: a 2 × 2 has `floor((168 − 22 + 6) / (54 + 6)) = 2`, which matches
§8. A 2 × 3 has `floor((284 − 22 + 6) / 60) = 4` for **one** group, and §8 says 3 — the difference
is a second day header, i.e. the fixture. **Task 9's tests assert the fitting function over a
fixture they state, plus §11's checkable case (2 × 2 draws exactly two rows), and never the table.**

---

## Three decisions, settled

Two were flagged in spec §12; the third was found by checking the spec against the schema.
**All three were answered on 2026-09-20 and are recorded here as settled** — where an answer
supersedes the spec, this plan is the authority and Task 10 carries the change into
`home-page.md`.

### Decision 1 — §3: `WidgetToggle.dflt`, for two off-by-default switches — ANSWERED

**Answered 2026-09-20: add `dflt?: boolean` as specified, with `toggleOnOf` beside it.**
Confirmed least invasive by reading every site:

* `toggleOn` (`widgetSettings.ts:~56`) is `stored(widget)[key] !== false` — **one reader**.
* `WidgetSettingsPanel.tsx` writes `onConfig({ [key]: on ? false : undefined })` — **one writer**.
* Five kinds declare toggles: `collectionValue`/`wishlistValue` (`figures`), `decks` (`art`),
  `folders` (`captions`), `activity` (`times`), `setCompletion` (`bars`), `recentCards` (`names`).
  **Every one of them omits `dflt`.**

With `dflt = true` as the parameter default, `toggleOn` for an absent `dflt` is
`typeof v === "boolean" ? v : true` where it was `v !== false`. **These differ on exactly one input:
a stored `true`.** Old code answered `true`; new code answers `true`. They agree. For a stored
non-boolean (`"yes"`, `1`, `null`) old answered `true` and new answers `true`. They agree
everywhere. The panel's writer becomes `next === dflt ? undefined : next`, which for `dflt = true`
is `next === true ? undefined : false` — byte-identical to today's `on ? false : undefined` at the
one call site (`next` is `!on`). **So no existing toggle moves, and `widgetSettings.test.ts` gains
a case rather than changing one.**

The alternative — spelling the keys negatively (`hideBasics`) — was rejected in the spec and the
reason holds: the panel would read *Hide basic lands ☑*, a double negative at the one place the
design is being plain.

There is one thing the spec does **not** say and the implementer must not miss: `toggleOn`'s

**call sites in widget bodies must pass the default too**, because the function cannot see the
registry. Task 1 adds `toggleOnOf(widget, key)` beside it, which looks the `dflt` up off the kind's
meta — the same shape `pickOf` already has for picks. Without it the body would hard-code `false`
in a second place and the two could drift.

### Decision 2 — §2: languages are a **widget setting**, not a hard filter — ANSWERED

**Answered 2026-09-20: neither of the spec's two options. A `Languages` pick, so a reader who
wants every language can have it, English only is the default, and English + Japanese is
expressible.** This supersedes §2's `⚠ lang = 'en'` block and §12's item 2.

The problem §2 states is real and unchanged: `cards.id` is one printing **in one language**, so an
unfiltered feed answers a ten-language set as ten rows of one reprint. What changes is who decides.
§2 offered a constant; the answer is a control, with the constant as its default.

```ts
{
  key: "langs",
  label: "Languages",
  options: [
    { id: "en", label: "English" },        // the default — `options[0]`, so no `dflt` needed
    { id: "all", label: "Every language" },
    { id: "chosen", label: "Chosen…" },
  ],
}
```

`Chosen…` opens a language checklist in `extraSettings`, beside the deck one — the same seam, and
**`PrintingsFilterBar` is the precedent**: the all-printings dialog already offers exactly this
list, English first, drawing each row's accessible name from `languageName`. The vocabulary is
`src/lib/languages.ts`'s, which already names all **19** codes that appear across the corpus
(measured over the 2026-08-18 bulk, 2 644 of 116 712 rows non-English) — so this task mints no
language table of its own.

**The default still satisfies the issue.** A reader who changes nothing gets `en`, which is one row
per reprint. `Every language` is a deliberate opt-in to a longer list, and one reprint appearing
once per language there is the reader's own request rather than the bug §2 was guarding against.

**Three rules follow, and each is written at its site:**

1. **One field on the wire.** `langs: string[]`, where **empty means every language**. TypeScript
   resolves the mode into a concrete list — `en` → `["en"]`, `all` → `[]`, `chosen` → the stored
   ids **narrowed against `languages.ts`'s table**, which is the vocabulary check a hand-editable
   `config` needs. A mode string *and* a list would be two fields that can disagree.
2. **`Chosen…` with nothing ticked reads as English, and does not get a sentence.** This parts from
   `DecksWidget`, which says *no decks pinned yet* rather than falling back — and the difference is
   what the empty set means. An empty deck set is a real statement (*compare against nothing*); an
   empty language set would mean *show no printings at all*, which is never what anyone meant by
   unticking the last box.
3. **The row carries the language whenever the resolved set is not exactly English.** Without it,
   `Every language` draws ten rows reading `Sol Ring · SLD · 3 decks` and the list looks broken
   rather than complete. So `NewPrinting` gains a `lang` field and the caption gains a
   `languageName`-titled code — at **every** tier, including the 2-cell tile, because this is the
   one thing that tells two rows apart rather than a detail a small card can drop.

**Rust bounds the list defensively**, since it arrives from a `config` a reader can hand-edit: an
entry that is not `^[a-z]{2,4}$` is dropped and the list is capped at 24 (19 codes exist). If that
leaves it empty, it is every language — the same rule as an empty list, stated once, never a
silent fallback to English, which would be this build making a claim the caller did not.

### Decision 3 — §3: `scope` has three options and only two can mean anything — ANSWERED

**Found while checking the spec against the schema, so it is not on the brief's list — but it is
the same kind of question and it blocks Task 2.**

**Answered 2026-09-20: drop `pinned`. Two options — `All decks` and `Chosen…`.** This
supersedes §3's three-option `scope` pick.

Spec §3 gives `scope` three options and then says, of the third, that `Chosen…` opens a deck
checklist — *"the seam `WidgetSettingsPanel` already has for exactly this (it is what `Pinned` uses
on the Decks widget)"*. That sentence is the defect: on `DecksWidget`, **`Pinned` *is* the
checklist**. So the spec is proposing `Pinned` and `Chosen…` side by side on one card, where they
are the same mechanism under two words.

Two facts settle it:

* **There is no `decks.pinned` column.** Checked against `schema.rs` — the `decks` table carries
  `archived`, `virtual_only`, `created_at`, `updated_at` and no pin. Pinning in this app is a
  *widget's* `config.deckIds`, which `DecksWidget.pinnedDeckIds` reads.
* **The only other reading is cross-widget config**, i.e. *the decks the Decks widget has pinned*.
  Nothing in this app reads another widget's config, and it breaks immediately on a page with two
  `decks` widgets — which `home-page.md` §3 explicitly allows (*"A kind may appear more than once
  — the `id` identifies a widget"*). There would be no answer to *which* widget's pins.

So `pinned` can only be a second spelling of `chosen`. Two options, `chosen` carries the ids, and
the Rust `scope` is a two-arm match with everything unknown reading as `all`. §3's "reuses
`DecksWidget`'s vocabulary" still holds for the two words that survive.

**If the answer is keep three**, the third has to be given a meaning first, and the only one
available is the cross-widget read — which I would push back on rather than build.

---

## Global Constraints

Copied from the brief and from the files that bind this area.

* **`home.rs` gains nothing.** No enum, no allow-list, no `kind` check. Task 4 adds the test that
  proves it.
* **`DEFAULT_LAYOUT` is not touched** — neither copy (`home.rs` **or** `widgets.ts`). The widget
  arrives from the catalogue. A tenth kind displacing a shipped one would rearrange the page of
  every reader who never asked for it.
* **Every widget in `src/features/home/widgets/` ships a `.stories.tsx` and a `.test.tsx`.** This
  one does too.
* **A new per-widget setting goes in `config`, never in a field beside it** (`home.rs` module doc).
* **No `@container` anywhere on this page, and no z-index that is not from `LAYER`** (`fit.ts`
  module doc).
* **Never interpolate a computed value into a Tailwind class** — Tailwind scans source text and
  emits no rule. Column counts, gaps and row heights are inline styles.
* **`npm run verify` green before the PR.** It does **not** run `cargo fmt --check` or
  `cargo clippy`; CI does. Run both by hand.
* **Never run two verifies at once** — concurrent runs fake ~18 Rust schema failures.
* Conventional commits: `feat:` / `fix:` / `chore:` / `test:`. Commit after each task.
* Sizes, tiers and row counts come from `fit.ts`'s arithmetic, never from a second copy of it.

---

## File structure

| File | Responsibility | Task |
| --- | --- | --- |
| `src/features/home/widgets.ts` | `WidgetToggle.dflt`; `"newPrintings"` on `WidgetKind`; the meta row | 1, 5 |
| `src/features/home/widgetSettings.ts` | `toggleOn`'s `dflt` parameter; new `toggleOnOf` | 1 |
| `src/features/home/WidgetSettingsPanel.tsx` | the writer becomes `next === dflt ? undefined : next` | 1 |
| `src-tauri/src/new_printings.rs` | **new** — the two statements, the clamps, the seen cursor; then the two command wrappers | 2, 4 |
| `src-tauri/src/lib.rs` | `pub mod new_printings;` | 2 |
| `src-tauri/src/desktop.rs` | both commands in `invoke_handler` | 4 |
| `src-tauri/src/web/route.rs` | both in `COMMANDS`, two match arms, the count | 4 |
| `src-tauri/src/home.rs` | **the test only** — no production change | 3 |
| `src/lib/ipc.ts` | three interfaces, `ipc.newPrintings`, `ipc.markNewPrintingsSeen` | 5 |
| `src/lib/ipc.test.ts` | three mirror rows, two `declares` cases | 5 |
| `src/features/home/keys.ts` | `newPrintingsKey`, `NEW_PRINTINGS_ROOT` | 5 |
| `src/lib/languages.ts` | **read only** — `languageName` and its 19 codes are the language vocabulary | 6, 7 |
| `src/features/home/HomePage.tsx` | one `case` in each of the two switches | 7 |
| `src/features/home/HomePage.test.tsx` | a tenth body mock; the "nine" prose | 7 |
| `src/features/home/widgets/NewPrintingsWidget.tsx` | the body, the day groups, the rules, the popover, `NewPrintingsWidgetSettings` | 6, 7 |
| `src/features/home/widgets/NewPrintingsWidget.stories.tsx` | the workbench | 8 |
| `.storybook/fake/db.ts` | the `new_printings` read handler | 8 |
| `src/features/home/widgets/NewPrintingsWidget.test.tsx` | §11's cases | 9 |
| `docs/reference/home-page.md` | §12, the tenth kind; §3's table and heading; the `dflt` change | 10 |

---

## Task 0: Branch hygiene

**Files:** none.

- [ ] **Step 1: Confirm the worktree is on the right branch and current**

```bash
git -C "D:/Code/mtg-grimoire/.claude/worktrees/new-printings-widget-2e821b" status -sb
```

Expected: `## claude/new-printings-widget-2e821b`, clean but for the copied spec. A worktree's base
is a stale `main` — if `origin/main` has moved, merge it in (never rebase).

- [ ] **Step 2: Commit the spec and its artboards**

They exist only as untracked files in the main checkout and would die with it.

```bash
git add docs/superpowers/specs/2026-09-20-new-printings-widget-design.md docs/superpowers/specs/new-printings-widget docs/superpowers/plans/2026-09-20-new-printings-widget.md && git commit -m "docs: the new printings widget design, its artboards and the plan"
```

- [ ] **Step 3: Re-read the three settled decisions above.** Each supersedes part of the spec,
and the spec is the document an implementer is most likely to reach for.

---

## Task 1: `WidgetToggle.dflt` — an off-by-default switch

Decision 1. **Nothing in this task mentions `newPrintings`** — it is a registry capability, it
stands on its own, and a reviewer can accept or reject it without reading another task.

**Files:**
- Modify: `src/features/home/widgets.ts` (the `WidgetToggle` interface)
- Modify: `src/features/home/widgetSettings.ts` (`toggleOn`, new `toggleOnOf`)
- Modify: `src/features/home/WidgetSettingsPanel.tsx` (the switch writer)
- Test: `src/features/home/widgetSettings.test.ts`, `src/features/home/WidgetSettingsPanel.test.tsx`

**Interfaces:**
- Produces: `WidgetToggle { key: string; label: string; dflt?: boolean }`;
  `toggleOn(widget: HomeWidget, key: string, dflt?: boolean): boolean`;
  `toggleOnOf(widget: HomeWidget, key: string): boolean`.

- [ ] **Step 1: Write the failing tests**

Append to `src/features/home/widgetSettings.test.ts`:

```ts
describe("toggleOn with a default", () => {
  /** The rule the current code is an instance of: *the default stores nothing*. With no `dflt`
   *  the answer is on, which is every shipped toggle and must not move. */
  it("is unchanged when no default is named", () => {
    expect(toggleOn(widget("decks"), "art")).toBe(true);
    expect(toggleOn(widget("decks", { art: false }), "art")).toBe(false);
    expect(toggleOn(widget("decks", { art: true }), "art")).toBe(true);
    // Anything that is not a boolean is the default — a hand-edited row, a newer build's word.
    expect(toggleOn(widget("decks", { art: "yes" }), "art")).toBe(true);
  });

  it("reads absent as off when the default is off", () => {
    expect(toggleOn(widget("newPrintings"), "basics", false)).toBe(false);
    expect(toggleOn(widget("newPrintings", { basics: true }), "basics", false)).toBe(true);
    expect(toggleOn(widget("newPrintings", { basics: false }), "basics", false)).toBe(false);
    expect(toggleOn(widget("newPrintings", { basics: 1 }), "basics", false)).toBe(false);
  });

  /** `toggleOnOf` is to a toggle what `pickOf` is to a pick: it finds the row, so a body never
   *  restates a default the registry already carries. A key the kind declares no toggle for is
   *  `true` — the shape a body with a stale key had before `dflt` existed. */
  it("reads the default off the kind's registry row", () => {
    expect(toggleOnOf(widget("decks"), "art")).toBe(true);
    expect(toggleOnOf(widget("decks"), "aKeyThisKindHasNoToggleFor")).toBe(true);
  });
});
```

**The helper is `widget(kind, config?)`** — `widgetSettings.test.ts:18`, which builds a
`HomeWidget` from a kind string and a config. The two `newPrintings` cases above are written
against Task 5's registry row, so **move them into Task 5's step** if Task 1 is being reviewed on
its own; a `decks`-only version of the same assertion (`toggleOn(widget("decks"), "art", false)`)
proves the parameter without depending on a kind that does not exist yet.

Append to `src/features/home/WidgetSettingsPanel.test.tsx`:

```ts
it("stores nothing when a switch is put back to its default, either way round", async () => {
  const onConfig = vi.fn();
  // A kind whose toggle defaults ON: turning it off stores `false`, turning it back on removes it.
  render(<WidgetSettingsPanel widget={deckWidget({ art: false })} onConfig={onConfig} />);
  await userEvent.click(screen.getByRole("checkbox", { name: "Cover art" }));
  expect(onConfig).toHaveBeenCalledWith({ art: undefined });
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
npm run test:run -- src/features/home/widgetSettings.test.ts src/features/home/WidgetSettingsPanel.test.tsx
```

Expected: FAIL — `toggleOnOf is not a function`, and the three-argument `toggleOn` cases fail
because the third argument is ignored.

- [ ] **Step 3: Widen the interface**

In `src/features/home/widgets.ts`, replace the `WidgetToggle` interface and its doc:

```ts
/**
 * An on/off setting, stored as `config[key]`. **The default is stored as absence, whichever way
 * round the default runs** — a reader who has changed nothing stores nothing, so an upgrade that
 * moves a default moves it for them too.
 *
 * `dflt` is `true` when absent, which is every toggle shipped before this field existed: a reader
 * who has changed nothing sees the widget's whole face, which is the one the catalogue showed
 * them. A kind names `dflt: false` where the *off* state is the honest starting point —
 * `newPrintings`' virtual decks and basic lands, which the issue requires excluded by default and
 * which would read as a double negative if spelled `hideBasics`.
 */
export interface WidgetToggle {
  key: string;
  label: string;
  dflt?: boolean;
}
```

- [ ] **Step 4: Teach the reader the default**

In `src/features/home/widgetSettings.ts`, replace `toggleOn` and add `toggleOnOf` beside it:

```ts
/**
 * Is this switch on?
 *
 * **Only a stored boolean is an answer**; anything else — absent, a hand-edited word, a value a
 * newer build wrote — is `dflt`. The rule this states is *the default stores nothing*, of which
 * the old `!== false` was the one instance where the default was on.
 *
 * The caller passes the default because this function cannot see the registry. Bodies should call
 * {@link toggleOnOf}, which looks it up; this signature is for a caller holding the row already.
 */
export function toggleOn(widget: HomeWidget, key: string, dflt = true): boolean {
  const value = stored(widget)[key];
  return typeof value === "boolean" ? value : dflt;
}

/** A switch's value by key, with the kind's own default applied — {@link pickOf}'s shape for
 *  toggles, so a body never writes down a default the registry already carries. A key the kind
 *  declares no toggle for is on, which is what a body with a stale key saw before `dflt` existed. */
export function toggleOnOf(widget: HomeWidget, key: string): boolean {
  if (!isWidgetKind(widget.kind)) return toggleOn(widget, key);
  const toggle = widgetMeta(widget.kind).toggles.find((entry) => entry.key === key);
  return toggleOn(widget, key, toggle?.dflt);
}
```

- [ ] **Step 5: Teach the writer the default**

In `src/features/home/WidgetSettingsPanel.tsx`, inside the `Show` group's `map`:

```tsx
{meta.toggles.map((toggle) => {
  const dflt = toggle.dflt ?? true;
  const on = toggleOn(widget, toggle.key, dflt);
  return (
    <label key={toggle.key} className="flex items-center justify-between gap-2 py-px">
      <span className={cn("text-[0.8125rem]", on ? "text-text" : "text-dim")}>{toggle.label}</span>
      <input
        type="checkbox"
        checked={on}
        // **The default is stored as absence, whichever way round it runs** — see the module doc.
        onChange={() => onConfig({ [toggle.key]: !on === dflt ? undefined : !on })}
        className={cn("size-3.5 accent-accent", FOCUS)}
      />
    </label>
  );
})}
```

Update the module doc's paragraph on the two absences to say *the default* rather than *a switch
that is on*.

- [ ] **Step 6: Run them and watch them pass**

```bash
npm run test:run -- src/features/home/widgetSettings.test.ts src/features/home/WidgetSettingsPanel.test.tsx src/features/home/widgets.test.ts
```

Expected: PASS, and **every pre-existing case in all three still passes** — that is the claim this
task is making, so a red one here is the task being wrong, not the test.

- [ ] **Step 7: Commit**

```bash
git add src/features/home/widgets.ts src/features/home/widgetSettings.ts src/features/home/WidgetSettingsPanel.tsx src/features/home/widgetSettings.test.ts src/features/home/WidgetSettingsPanel.test.tsx && git commit -m "feat(home): let a widget toggle default to off"
```

---

## Task 2: The Rust read — the two statements

The query and nothing else. No command, no registration; those are Task 4, so a reviewer can reject
the SQL without rejecting the wiring.

**Files:**
- Create: `src-tauri/src/new_printings.rs`
- Modify: `src-tauri/src/lib.rs` (one `pub mod` line, alphabetical)
- Test: inline `#[cfg(test)]` module in `new_printings.rs`

**Interfaces:**
- Produces:

```rust
pub struct NewPrintingDeck { pub deck_id: i64, pub name: String, pub quantity: i64,
                             pub variant: String, pub virtual_only: bool }
pub struct NewPrinting { pub printing_id: String, pub oracle_id: String, pub name: String,
                         pub set_code: String, pub set_name: Option<String>,
                         pub collector_number: String, pub released_at: String,
                         pub rarity: Option<String>, pub promo_types: Option<String>,
                         pub finishes: Option<String>, pub lang: String,
                         pub decks: Vec<NewPrintingDeck> }
pub struct NewPrintings { pub printings: Vec<NewPrinting>, pub decks_watched: i64,
                          pub since: String, pub oldest: Option<String>,
                          pub seen_at: Option<i64> }
pub struct Ask { pub scope: String, pub deck_ids: Vec<i64>, pub days: i64,
                 pub langs: Vec<String>, pub include_virtual: bool, pub include_theory: bool,
                 pub include_basics: bool, pub limit: Option<i64> }
pub fn feed(conn: &Connection, ask: &Ask) -> Result<NewPrintings, String>;
pub fn mark_seen(conn: &Connection, at: i64) -> Result<(), String>;
pub const K_NEW_PRINTINGS_SEEN: &str = "new_printings_seen";
pub const NEW_PRINTINGS_READ: i64 = 100;
```

- [ ] **Step 1: Declare the module**

Add to `src-tauri/src/lib.rs`, in alphabetical order among the existing `pub mod` lines (between
`nav` and `paths`):

```rust
pub mod new_printings;
```

**An undeclared module makes every `cargo test` run vacuous** — 100 tests once looked green for
four waves because of exactly this. Do it first, not last.

- [ ] **Step 2: Write the failing tests**

Create `src-tauri/src/new_printings.rs` with only the test module and enough of a skeleton to
compile against. The five cases are spec §11's, plus the two the spec's own SQL implies.

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::tests::corpus_pair; // the real pair: `cards` in the attached corpus

    /// Every ask the tests vary from — 90 days, all decks, the issue's three defaults.
    fn ask() -> Ask {
        Ask { scope: "all".into(), deck_ids: vec![], days: 90, langs: vec!["en".into()],
              include_virtual: false, include_theory: true, include_basics: false, limit: None }
    }

    /// One printing in the corpus. `released_at` is `days_ago` days before today, so a window is
    /// testable without a clock injected into the query.
    fn printing(c: &Connection, id: &str, oracle: &str, name: &str, set: &str,
                days_ago: i64, lang: &str, type_line: &str) { /* INSERT INTO cards (…) */ }

    /// One deck holding one printing.
    fn deck(c: &Connection, id: i64, name: &str, virtual_only: bool) { /* INSERT INTO decks */ }
    fn holds(c: &Connection, deck_id: i64, card_id: &str, qty: i64, variant: &str) { /* deck_cards */ }

    /// **The requirement the whole two-statement shape exists for.** A single join to `deck_cards`
    /// would answer this printing twice and then need distinct-ing back down, which is how the
    /// issue's "each printing appears only once" gets quietly broken.
    #[test]
    fn a_printing_two_decks_hold_appears_once_with_two_decks() {
        let (c, _g) = corpus_pair();
        printing(&c, "old", "o1", "Sol Ring", "LEA", 900, "en", "Artifact");
        printing(&c, "new", "o1", "Sol Ring", "SLD", 10, "en", "Artifact");
        deck(&c, 1, "Atraxa", false);
        deck(&c, 2, "Edgar", false);
        holds(&c, 1, "old", 1, "live");
        holds(&c, 2, "old", 1, "live");
        let out = feed(&c, &ask()).unwrap();
        assert_eq!(out.printings.len(), 1, "one row for one printing");
        assert_eq!(out.printings[0].printing_id, "new");
        assert_eq!(out.printings[0].decks.len(), 2);
        assert_eq!(out.decks_watched, 2);
    }

    /// The quantity is summed across a deck's categories, so a deck holding a card in both a live
    /// and a theory category is **one** entry with the total rather than two entries.
    #[test]
    fn a_decks_quantity_sums_across_its_categories() {
        let (c, _g) = corpus_pair();
        printing(&c, "old", "o1", "Sol Ring", "LEA", 900, "en", "Artifact");
        printing(&c, "new", "o1", "Sol Ring", "SLD", 10, "en", "Artifact");
        deck(&c, 1, "Atraxa", false);
        holds(&c, 1, "old", 2, "live");
        holds(&c, 1, "old", 3, "theory");
        let out = feed(&c, &ask()).unwrap();
        assert_eq!(out.printings[0].decks.len(), 1);
        assert_eq!(out.printings[0].decks[0].quantity, 5);
    }

    #[test]
    fn a_basic_land_is_dropped_unless_asked_for() {
        let (c, _g) = corpus_pair();
        printing(&c, "old", "o1", "Forest", "LEA", 900, "en", "Basic Land — Forest");
        printing(&c, "new", "o1", "Forest", "SLD", 10, "en", "Basic Land — Forest");
        deck(&c, 1, "Atraxa", false);
        holds(&c, 1, "old", 1, "live");
        assert!(feed(&c, &ask()).unwrap().printings.is_empty());
        let out = feed(&c, &Ask { include_basics: true, ..ask() }).unwrap();
        assert_eq!(out.printings.len(), 1);
    }

    #[test]
    fn a_virtual_deck_contributes_nothing_by_default() {
        let (c, _g) = corpus_pair();
        printing(&c, "old", "o1", "Sol Ring", "LEA", 900, "en", "Artifact");
        printing(&c, "new", "o1", "Sol Ring", "SLD", 10, "en", "Artifact");
        deck(&c, 1, "Ideas", true);
        holds(&c, 1, "old", 1, "live");
        let out = feed(&c, &ask()).unwrap();
        assert!(out.printings.is_empty());
        // **And `decks_watched` is zero too** — the count is what the scope resolved to, which is
        // what lets the page say *no decks are being watched* rather than *nothing was reprinted*.
        assert_eq!(out.decks_watched, 0);
        let out = feed(&c, &Ask { include_virtual: true, ..ask() }).unwrap();
        assert_eq!(out.printings.len(), 1);
        assert_eq!(out.decks_watched, 1);
    }

    #[test]
    fn a_theory_row_contributes_only_when_asked_for() {
        let (c, _g) = corpus_pair();
        printing(&c, "old", "o1", "Sol Ring", "LEA", 900, "en", "Artifact");
        printing(&c, "new", "o1", "Sol Ring", "SLD", 10, "en", "Artifact");
        deck(&c, 1, "Atraxa", false);
        holds(&c, 1, "old", 1, "theory");
        assert!(feed(&c, &Ask { include_theory: false, ..ask() }).unwrap().printings.is_empty());
        assert_eq!(feed(&c, &ask()).unwrap().printings.len(), 1);
    }

    /// **Decision 2, and the whole of it.** `cards.id` is one printing *in one language*, so
    /// the language set is what decides whether a second language is a second row — and each of
    /// the three modes the page offers is a real answer here.
    #[test]
    fn the_language_set_decides_whether_a_second_language_is_a_second_row() {
        let (c, _g) = corpus_pair();
        printing(&c, "old", "o1", "Sol Ring", "LEA", 900, "en", "Artifact");
        printing(&c, "new-en", "o1", "Sol Ring", "SLD", 10, "en", "Artifact");
        printing(&c, "new-ja", "o1", "Sol Ring", "SLD", 10, "ja", "Artifact");
        printing(&c, "new-de", "o1", "Sol Ring", "SLD", 10, "de", "Artifact");
        deck(&c, 1, "Atraxa", false);
        holds(&c, 1, "old", 1, "live");

        // English — the default, and the issue's deduplication requirement.
        let out = feed(&c, &ask()).unwrap();
        assert_eq!(out.printings.len(), 1);
        assert_eq!(out.printings[0].printing_id, "new-en");
        assert_eq!(out.printings[0].lang, "en", "the row says which language it is");

        // Every language — an **empty** list, and three rows is what the reader asked for.
        let every = feed(&c, &Ask { langs: vec![], ..ask() }).unwrap();
        assert_eq!(every.printings.len(), 3);

        // Chosen — English and Japanese, and not German.
        let two = feed(&c, &Ask { langs: vec!["en".into(), "ja".into()], ..ask() }).unwrap();
        assert_eq!(two.printings.len(), 2);
        assert!(!two.printings.iter().any(|p| p.lang == "de"));
    }

    /// The list arrives from a `config` a reader can hand-edit, so it is bounded here as well as
    /// narrowed in TypeScript. **A list emptied by the narrowing is every language**, which is the
    /// same rule as an empty list — never a silent fallback to English, which would be this build
    /// making a claim the caller did not.
    #[test]
    fn a_hand_edited_language_list_is_bounded() {
        let (c, _g) = corpus_pair();
        printing(&c, "old", "o1", "Sol Ring", "LEA", 900, "en", "Artifact");
        printing(&c, "new-en", "o1", "Sol Ring", "SLD", 10, "en", "Artifact");
        printing(&c, "new-ja", "o1", "Sol Ring", "SLD", 10, "ja", "Artifact");
        deck(&c, 1, "Atraxa", false);
        holds(&c, 1, "old", 1, "live");
        // A SQL fragment, an empty string, a 40-character word and a capitalised code are all
        // dropped — the codes in the corpus are lowercase.
        let junk = vec!["en' OR 1=1 --".into(), String::new(), "x".repeat(40), "EN".into()];
        assert_eq!(feed(&c, &Ask { langs: junk, ..ask() }).unwrap().printings.len(), 2,
                   "every entry was dropped, so every language");
    }

    /// A printing with no release date cannot be placed in a day group, so the `WHERE` drops it
    /// rather than the body inventing an *Undated* bucket. `released_at` is therefore never null
    /// on the wire.
    #[test]
    fn an_undated_printing_is_dropped_rather_than_bucketed() {
        let (c, _g) = corpus_pair();
        printing(&c, "old", "o1", "Sol Ring", "LEA", 900, "en", "Artifact");
        c.execute("INSERT INTO cards (id, oracle_id, name, set_code, collector_number, lang, \
                   layout, released_at, is_paper, type_line, raw) \
                   VALUES ('undated','o1','Sol Ring','SLD','1','en','normal',NULL,1,'Artifact','{}')",
                  []).unwrap();
        deck(&c, 1, "Atraxa", false);
        holds(&c, 1, "old", 1, "live");
        assert!(feed(&c, &ask()).unwrap().printings.is_empty());
    }

    /// The window is the caller's, inside `1..=365`, so a hand-edited `config` cannot ask for the
    /// whole corpus — and a negative is not "no limit", which is the trap `deck_audit`'s clamp
    /// exists for and which SQLite reads as *unlimited*.
    #[test]
    fn the_window_and_the_limit_are_clamped() {
        let (c, _g) = corpus_pair();
        assert_eq!(feed(&c, &Ask { days: 99_999, ..ask() }).unwrap().since,
                   feed(&c, &Ask { days: 365, ..ask() }).unwrap().since);
        assert_eq!(feed(&c, &Ask { days: -5, ..ask() }).unwrap().since,
                   feed(&c, &Ask { days: 1, ..ask() }).unwrap().since);
        assert_eq!(feed(&c, &Ask { limit: Some(-1), ..ask() }).unwrap().printings.len(), 0);
    }

    /// The scope, and the one thing `chosen` must not do: read `deck_ids` under any other word.
    #[test]
    fn chosen_reads_the_ids_and_the_other_scopes_ignore_them() {
        let (c, _g) = corpus_pair();
        printing(&c, "old", "o1", "Sol Ring", "LEA", 900, "en", "Artifact");
        printing(&c, "new", "o1", "Sol Ring", "SLD", 10, "en", "Artifact");
        deck(&c, 1, "Atraxa", false);
        deck(&c, 2, "Edgar", false);
        holds(&c, 1, "old", 1, "live");
        holds(&c, 2, "old", 1, "live");
        let chosen = Ask { scope: "chosen".into(), deck_ids: vec![2], ..ask() };
        assert_eq!(feed(&c, &chosen).unwrap().decks_watched, 1);
        let all = Ask { deck_ids: vec![2], ..ask() };
        assert_eq!(feed(&c, &all).unwrap().decks_watched, 2, "`all` ignores the ids");
        // An empty `chosen` is a real answer and never *every deck*.
        let none = Ask { scope: "chosen".into(), deck_ids: vec![], ..ask() };
        assert_eq!(feed(&c, &none).unwrap().decks_watched, 0);
    }

    /// The cursor is `app_meta`'s, for `recent_cards`' reason: `config` round-trips through older
    /// builds, and a cursor an older build rewrites is a cursor that lies.
    #[test]
    fn the_seen_cursor_round_trips_and_a_junk_row_reads_as_never() {
        let (c, _g) = corpus_pair();
        assert_eq!(feed(&c, &ask()).unwrap().seen_at, None);
        mark_seen(&c, 1_700_000_000).unwrap();
        assert_eq!(feed(&c, &ask()).unwrap().seen_at, Some(1_700_000_000));
        crate::app_meta::set_app_meta(&c, K_NEW_PRINTINGS_SEEN, "not a number").unwrap();
        assert_eq!(feed(&c, &ask()).unwrap().seen_at, None);
    }
}
```

Before writing: **read `src-tauri/src/recent_cards.rs`'s test module for the real `corpus_pair`
helper name and signature** — it is the one that gives a connection with `cards` in an attached
corpus beside the user tables. Use whatever that file uses; do not invent a helper. Read
`set_completion.rs`'s tests for how a `decks`/`deck_cards` row is seeded.

- [ ] **Step 3: Run them and watch them fail**

```bash
cargo test -p mtg-grimoire new_printings 2>&1 | tail -40
```

Run from `src-tauri/`. Expected: compile errors, then FAIL. **A test binary that says
`0 tests` means the module is not declared** — go back to Step 1.

- [ ] **Step 4: Write the implementation**

`src-tauri/src/new_printings.rs`, above the test module. The load-bearing parts in full:

```rust
//! Reprints of cards the reader's watched decks already hold, newest first, grouped by release
//! day by the page that draws them.
//!
//! **Two statements over one `WHERE`, which is [`crate::card::list_printings`]' shape and is here
//! for a sharper reason.** The page is one statement and the decks holding each of its printings
//! is a second. A single join to `deck_cards` would multiply a printing by the decks holding it
//! and then need distinct-ing back down, which is how the issue's *each printing appears only
//! once* requirement gets quietly broken — and the count beside it would be wrong in the same
//! breath.
//!
//! **No schema change.** Every column this reads already exists: `cards.released_at`,
//! `cards.oracle_id` (narrowed by `idx_cards_oracle`), `cards.is_paper`, `cards.lang`,
//! `cards.type_line`, `deck_cards.{card_id,deck_id,quantity,variant}` and `decks.virtual_only`.
//! `cards` is named unqualified because the corpus is `ATTACH`ed — every query in this crate
//! names it that way.
//!
//! **The language set is the reader's, and it is the one argument here that decides how many
//! rows a reprint is.** `cards.id` is one printing *in one language*, so a set that ships in ten
//! languages is ten rows of one reprint — which is noise for a reader who wanted a feed and
//! exactly right for one who collects in two languages. So [`Ask::langs`] is an allow-list:
//! **empty is every language**, and the page's default sends `["en"]`, which is one row per
//! reprint. [`list_printings`] filters language not at all, because a printings *list* is supposed
//! to show them; the difference is that a list is a reader choosing which cardboard they own and
//! a feed is a reader asking what is new.
//!
//! The list is **bounded here as well as narrowed in TypeScript**, because it arrives from a
//! `config` a reader can hand-edit: an entry that is not two to four lowercase letters is dropped
//! and the list is capped at [`MAX_LANGS`]. A list the narrowing empties is every language — the
//! same rule as an empty list, never a fallback to English, which would be this module making a
//! claim the caller did not.
//!
//! **`released_at` is nullable in the corpus and is not on the wire.** A printing with no date
//! cannot be placed in a day group, so the `WHERE` drops it rather than the body inventing an
//! *Undated* bucket.
//!
//! **The cursor is `app_meta`'s**, [`crate::recent_cards`]' shape exactly and for its reason:
//! `config` round-trips through older builds, and a cursor an older build rewrites is a cursor
//! that lies. An unreadable row reads as *never seen*, which draws every dot — the honest
//! failure, where reading it as *now* would silently hide the whole point of the mark.

use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;

/// The `app_meta` key. The table is the application's, deliberately not `sync_meta` — a mark
/// about what *this screen* has shown is this device's, like every stored preference here.
pub const K_NEW_PRINTINGS_SEEN: &str = "new_printings_seen";

/// How many printings one read asks for — the command's own clamp, and the ceiling the page's
/// `NEW_PRINTINGS_READ` matches. **The box cuts this to whole rows**; a read sized to the rows
/// that fit would re-issue on every drag of the resize corner and paint *pending* over a list
/// that was already right. `RecentCardsWidget` and `PriceMoversWidget` both say this at their
/// own sites.
pub const NEW_PRINTINGS_READ: i64 = 100;

/// The longest window the feed will answer, in days. A hand-edited `config` cannot ask for the
/// whole corpus, and the registry offers 30, 90 and 365.
const MAX_DAYS: i64 = 365;

/// How many language codes an allow-list may carry. `src/lib/languages.ts` names **19**, which is
/// every code across the 116 712 rows of the 2026-08-18 bulk, so 24 clears the corpus with room
/// and refuses a list that could only be a bug.
const MAX_LANGS: usize = 24;

/// Is this a language code at all? The corpus's are two to four lowercase letters (`en`, `zhs`,
/// `grc`). A shape check rather than a membership test against the known 19: a language Scryfall
/// adds next set is the reader's own data arriving early, and refusing it here would need this
/// file edited before a feed could show it.
fn is_lang_code(code: &str) -> bool {
    (2..=4).contains(&code.len()) && code.bytes().all(|b| b.is_ascii_lowercase())
}

/// The window, clamped. **A zero or a negative is a caller bug rather than a request for an empty
/// window**, and is answered with one day — the narrowest honest answer. Never passed through:
/// a negative `LIMIT` is SQLite's *no limit at all*, which is the trap `deck_audit`'s clamp
/// exists for, and the same shape of mistake one field over.
fn window_days(days: i64) -> i64 {
    days.clamp(1, MAX_DAYS)
}

/// The page size, clamped into `1..=NEW_PRINTINGS_READ`. `None` is the full read.
fn page_size(limit: Option<i64>) -> i64 {
    match limit {
        Some(n) if n > 0 => n.min(NEW_PRINTINGS_READ),
        Some(_) => 0,
        None => NEW_PRINTINGS_READ,
    }
}
```

The two statements. **Write the scope predicate with bound parameters and never by formatting an
id list into the SQL** — `deck_ids` comes off a hand-editable `config`:

```rust
pub fn feed(conn: &Connection, ask: &Ask) -> Result<NewPrintings, String> {
    let days = window_days(ask.days);
    let since: String = conn
        .query_row("SELECT date('now', ?1)", [format!("-{days} days")], |r| r.get(0))
        .map_err(|e| e.to_string())?;

    // `chosen` with no ids is a real answer and never *every deck*: the reader chose a set and it
    // is empty. `rarray` is not registered in this crate, so the ids go in as a JSON array read
    // through `json_each` — one bound parameter, no formatting into SQL.
    let ids_json = serde_json::to_string(&ask.deck_ids).map_err(|e| e.to_string())?;
    // **Empty is every language**, at both ends — see the module doc. The narrowing can empty a
    // list the caller filled, and that is the same answer rather than a different one.
    let langs: Vec<&str> = ask.langs.iter().map(String::as_str)
        .filter(|code| is_lang_code(code)).take(MAX_LANGS).collect();
    let langs_json = serde_json::to_string(&langs).map_err(|e| e.to_string())?;
    let scope_predicate = match ask.scope.as_str() {
        // **Two scopes, not three** — see Decision 3. `decks` has no `pinned` column; a pinned set
        // is a *widget's* `deckIds`, so `chosen` is the only id-carrying scope there can be and
        // the page never sends another word. An unknown one is `all`, which is `pickOf`'s rule
        // restated where a hand-edited row can reach.
        "chosen" => "d.id IN (SELECT value FROM json_each(?2))",
        _ => "1",
    };
    // … `watched` and `held` as CTEs, then:
    //   SELECT p.id, p.oracle_id, p.name, p.set_code, p.set_name, p.collector_number,
    //          p.released_at, p.rarity, p.promo_types, p.finishes, p.lang
    //   FROM cards p JOIN held h ON h.oracle_id = p.oracle_id
    //   WHERE p.is_paper = 1
    //     AND (:every_language OR p.lang IN (SELECT value FROM json_each(?n)))
    //     AND p.released_at IS NOT NULL AND p.released_at >= :since
    //   ORDER BY p.released_at DESC, p.set_code ASC, p.collector_number ASC, p.id ASC
    //   LIMIT :limit
    //
    // Statement 2, over the oracle ids of the page:
    //   SELECT c.oracle_id, w.id, w.name, w.virtual_only, dc.variant, SUM(dc.quantity)
    //   FROM deck_cards dc JOIN watched w ON w.id = dc.deck_id JOIN cards c ON c.id = dc.card_id
    //   WHERE c.oracle_id IN (SELECT value FROM json_each(?n)) AND (:include_theory OR dc.variant = 'live')
    //   GROUP BY c.oracle_id, w.id, dc.variant
    //   ORDER BY w.name ASC, w.id ASC
}
```

`decks_watched` is `SELECT count(*) FROM watched`, taken over the same predicate as the page for
`PrintingsResponse::total`'s reason: a count over a wider `WHERE` than the page is exactly the lie
the count was added to prevent. `oldest` is `printings.last().map(|p| p.released_at.clone())`.

`mark_seen` is `crate::app_meta::set_app_meta(conn, K_NEW_PRINTINGS_SEEN, &at.to_string())`, and
the read is `get_app_meta(…).and_then(|s| s.parse::<i64>().ok())` — a junk row is `None`.

Serialize every struct `#[serde(rename_all = "camelCase")]`.

- [ ] **Step 5: Run them and watch them pass**

```bash
cargo test -p mtg-grimoire new_printings 2>&1 | tail -40
```

Expected: PASS, 11 tests. **Confirm the count** — a filter that matches nothing exits 0.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/new_printings.rs src-tauri/src/lib.rs && git commit -m "feat(home): read the new printings of cards watched decks hold"
```

---

## Task 3: The `home.rs` proof — a kind must not reach Rust's vocabulary

The brief's first constraint, as a test. Its own task because it is a claim about the *previous*
task rather than a step in it, and because it must go red if anyone ever adds a `kind` check.

**Files:**
- Modify: `src-tauri/src/home.rs` — **tests only, no production change**

- [ ] **Step 1: Write the test**

In `home.rs`'s `mod tests`, beside `a_kind_this_build_has_never_heard_of_survives_a_round_trip`:

```rust
/// **The tenth kind reaches this module not at all**, which is the promise §1 of
/// `docs/reference/home-page.md` makes and the reason `kind` is a free `String` here.
///
/// `newPrintings` is a kind *this* build draws, and the point is that nothing in this file can
/// tell it from one it has never heard of: a layout holding it, with a `config` carrying keys
/// this module has no name for, round-trips byte for byte. The sibling test above makes the
/// same claim for a kind from the future; this one makes it for a kind from the present, so a
/// `match` arm or an allow-list added here goes red whichever side it is added on.
#[test]
fn the_new_printings_kind_reaches_no_vocabulary_in_this_module() {
    let c = conn();
    let sent = layout(vec![HomeWidget {
        id: "np1".into(),
        kind: "newPrintings".into(),
        x: 2,
        y: 4,
        w: 4,
        h: 12,
        span: Some(2),
        config: serde_json::json!({
            "scope": "chosen", "deckIds": [3, 7], "window": 365,
            "virtual": true, "basics": true, "theory": false,
            "somethingThisBuildHasNoNameFor": { "a": 1 }
        }),
    }]);
    store(&c, &sent).unwrap();
    let back = stored(&c);
    assert_eq!(back, sent, "the whole document, config and all");
    assert_eq!(back.widgets[0].config["deckIds"][1], 7);
    assert_eq!(back.widgets[0].config["somethingThisBuildHasNoNameFor"]["a"], 1);
}

/// **`DEFAULT_LAYOUT` is not touched by a tenth kind**, which is the other half of the same
/// promise: a widget that displaced a shipped one would rearrange the page of every reader who
/// never asked for it. The catalogue is where this kind arrives from.
#[test]
fn the_default_layout_holds_no_new_printings_widget() {
    assert_eq!(DEFAULT_WIDGET_COUNT, 8);
    assert!(
        !DEFAULT_LAYOUT.iter().any(|(_, kind, ..)| *kind == "newPrintings"),
        "the tenth kind arrives from the catalogue, never from the seed"
    );
}
```

Check the tuple shape of `DEFAULT_LAYOUT` (`[(&str, &str, u32, u32, u32, u32); 8]`) before writing
the destructure — the `kind` is the second member.

- [ ] **Step 2: Run them**

```bash
cargo test -p mtg-grimoire home:: 2>&1 | tail -20
```

Expected: PASS immediately. **These tests are written to pass on the first run** — they assert that
Task 2 changed nothing here, so a red one means something reached `home.rs` that should not have.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/home.rs && git commit -m "test(home): pin that a tenth widget kind reaches no Rust vocabulary"
```

---

## Task 4: Both commands, on both targets

**Files:**
- Modify: `src-tauri/src/new_printings.rs` (the two `#[tauri::command]` wrappers)
- Modify: `src-tauri/src/desktop.rs` (`invoke_handler`)
- Modify: `src-tauri/src/web/route.rs` (`COMMANDS`, two arms, the count)

**Interfaces:**
- Consumes: `new_printings::{feed, mark_seen, Ask, NewPrintings}` from Task 2.
- Produces: commands `new_printings` and `mark_new_printings_seen`.

- [ ] **Step 1: Write the failing route tests**

In `web/route.rs`'s `mod tests`:

```rust
/// **The new printings feed and its cursor, both routed.** A browser that could read the feed and
/// not move the cursor would draw a widget whose gold dots never go out; one that could read
/// neither would draw the tenth widget as an error on two of the three targets. Neither is a
/// download wearing a command's name — the read is one `SELECT` over the collection and the
/// corpus with no clock beyond SQLite's `date('now')`, and the write takes its clock from the
/// caller for `record_recent_card`'s reason (`SystemTime::now()` panics on this target).
#[test]
fn the_new_printings_pair_is_routed() {
    assert!(COMMANDS.contains(&"new_printings"));
    assert!(COMMANDS.contains(&"mark_new_printings_seen"));
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cargo test -p mtg-grimoire the_new_printings_pair_is_routed 2>&1 | tail -20
```

Expected: FAIL.

- [ ] **Step 3: The two wrappers**

Append to `src-tauri/src/new_printings.rs`. Copy `price_history::price_movers`' shape exactly —
including `#[cfg(not(target_family = "wasm"))]` and the blocking-pool / `lock_db_read` idiom
whichever that file uses:

```rust
/// The feed, for the home page's tenth widget. Read-only connection.
///
/// **Every argument is the widget's `config` narrowed on the way out of TypeScript**, and every
/// one is narrowed again here: `days` into `1..=MAX_DAYS`, `limit` into `1..=NEW_PRINTINGS_READ`,
/// an unknown `scope` into `all`, and `langs` to codes of the right shape, capped at
/// [`MAX_LANGS`]. A hand-edited row cannot ask for the whole corpus.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn new_printings(
    state: tauri::State<'_, Arc<AppState>>,
    scope: String,
    deck_ids: Vec<i64>,
    days: i64,
    langs: Vec<String>,
    include_virtual: bool,
    include_theory: bool,
    include_basics: bool,
    limit: Option<i64>,
) -> Result<NewPrintings, String> { /* … */ }

/// Move the *seen* cursor to `at`. The clock is the **caller's**, never `SystemTime::now()`,
/// which panics on the wasm target — `recent_cards::record`'s rule, one command over.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn mark_new_printings_seen(
    state: tauri::State<'_, Arc<AppState>>,
    at: i64,
) -> Result<(), String> { /* … */ }
```

Note the Tauri argument-name convention: `deck_ids` in Rust is `deckIds` on the wire. Check how
`price_movers` and `record_recent_card` spell multi-word arguments in `ipc.ts` and follow it
exactly — `ipc.test.ts`'s `declares` cases pin this and will catch a mismatch.

- [ ] **Step 4: Register on desktop**

In `src-tauri/src/desktop.rs`'s `invoke_handler` list, beside `price_history::price_movers`:

```rust
            new_printings::new_printings,
            new_printings::mark_new_printings_seen,
```

and add `new_printings` to that file's `use crate::{…}` module list, keeping it alphabetical.

- [ ] **Step 5: Route on the web target**

In `web/route.rs`, after the `"set_completion", "price_movers",` pair in `COMMANDS`:

```rust
    // **The New printings widget's read and its cursor.** Both are connection-only: the read is
    // two `SELECT`s over `deck_cards` and the corpus whose only clock is SQLite's `date('now')`,
    // and the write takes `at` from the caller for `record_recent_card`'s reason. A browser that
    // could read the feed and not move the cursor would draw a widget whose gold dots never go
    // out.
    "new_printings",
    "mark_new_printings_seen",
```

and two match arms beside `"price_movers"`, reading each argument with `field`/`optional` exactly
as that arm does (`limit` is `optional`, the rest are `field` — including `langs`, because an
**absent** language list and an **empty** one mean different things on the way in and only the
empty one is a legal answer).

- [ ] **Step 6: Re-count `COMMANDS.len()` — do not add two**

The comment above that assertion asks for a count rather than an addition, and says why: two
branches each adding to a shared number were both right on their own branch and wrong in the merge.

```bash
awk '/^pub const COMMANDS/,/^\];/' src-tauri/src/web/route.rs | grep -c '^\s*"'
```

Set the literal to whatever that prints (expected 174), and add a line to the comment block saying
what this branch routed and that the number is `awk`'s answer over the merged array.

- [ ] **Step 7: Run the Rust suite**

```bash
cargo test -p mtg-grimoire 2>&1 | tail -30
```

Expected: PASS, including `every_command_has_an_arm` and the count assertion.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/new_printings.rs src-tauri/src/desktop.rs src-tauri/src/web/route.rs && git commit -m "feat(home): route the new printings feed on desktop and web"
```

---

## Task 5: The wire — `ipc.ts`, its mirror, the registry row and the key

**Files:**
- Modify: `src/lib/ipc.ts`, `src/lib/ipc.test.ts`
- Modify: `src/features/home/keys.ts`, `src/features/home/widgets.ts`
- Test: `src/features/home/keys.test.tsx`, `src/features/home/widgets.test.ts`

**Interfaces:**
- Produces: `NewPrintingDeck`, `NewPrinting`, `NewPrintings`, `ipc.newPrintings(...)`,
  `ipc.markNewPrintingsSeen(at)`, `newPrintingsKey(...)`, `NEW_PRINTINGS_ROOT`,
  `"newPrintings"` on `WidgetKind`.

- [ ] **Step 1: Write the failing tests**

`src/lib/ipc.test.ts` — three rows on the mirror table beside `["PriceMovers", priceHistoryRs,
"PriceMovers"]`, with `newPrintingsRs` imported as `?raw` the way that file imports its siblings:

```ts
    // `NewPrinting` and `NewPrintingDeck` nested inside `NewPrintings` from `new_printings.rs` —
    // three rows for one command, `PriceMovers`' precedent. The nesting is exactly why: a renamed
    // `quantity` on the deck entry never reaches the outer struct's fields, and a widget that
    // draws `×NaN` in a popover is a bug nothing in either build could see.
    ["NewPrintingDeck", newPrintingsRs, "NewPrintingDeck"],
    ["NewPrinting", newPrintingsRs, "NewPrinting"],
    ["NewPrintings", newPrintingsRs, "NewPrintings"],
```

and two `declares` cases beside `price_movers`':

```ts
  it("names the new printings command and its arguments", async () => {
    await ipc.newPrintings("all", [], 90, ["en"], false, true, false, 100);
    expect(invoke).toHaveBeenCalledWith("new_printings", {
      scope: "all", deckIds: [], days: 90, langs: ["en"],
      includeVirtual: false, includeTheory: true, includeBasics: false, limit: 100,
    });
    for (const param of ["scope", "deck_ids", "days", "langs", "include_virtual",
                         "include_theory", "include_basics", "limit"]) {
      declares(newPrintingsRs, "new_printings", param);
    }
  });

  it("names the seen-cursor command and its argument", async () => {
    await ipc.markNewPrintingsSeen(1_700_000_000);
    expect(invoke).toHaveBeenCalledWith("mark_new_printings_seen", { at: 1_700_000_000 });
    declares(newPrintingsRs, "mark_new_printings_seen", "at");
  });
```

`src/features/home/keys.test.tsx` — the file asserts that keys with one definition resolve to one
value; add the two this task mints in whatever shape that file already uses.

`src/features/home/widgets.test.ts` — the `Record<WidgetKind, …>` fence is a *compile-time* one, so
the runtime case is about the row's contents:

```ts
it("carries the tenth kind, off the catalogue and not the default layout", () => {
  expect(isWidgetKind("newPrintings")).toBe(true);
  expect(WIDGETS.map((w) => w.kind)).toContain("newPrintings");
  // **The default layout is untouched** — a tenth kind that displaced a shipped one would
  // rearrange the page of every reader who never asked for it.
  expect(DEFAULT_LAYOUT.widgets.some((w) => w.kind === "newPrintings")).toBe(false);
  expect(DEFAULT_LAYOUT.widgets).toHaveLength(8);
  const meta = widgetMeta("newPrintings");
  expect(meta.min).toEqual([2, 2]);
  expect(meta.max).toEqual([8, 12]);
  // The two off-by-default switches — the issue's requirement, as the registry states it.
  expect(meta.toggles.find((t) => t.key === "virtual")?.dflt).toBe(false);
  expect(meta.toggles.find((t) => t.key === "basics")?.dflt).toBe(false);
  // Decision 3: two scopes, because a third could only be the second under another name.
  expect(meta.picks.find((p) => p.key === "scope")?.options.map((o) => o.id))
    .toEqual(["all", "chosen"]);
  // Decision 2: English is `options[0]`, so a reader who changes nothing gets one row per reprint.
  expect(pickDefault(meta.picks.find((p) => p.key === "langs")!)).toBe("en");
  // And the one that is on: a theory card is one the reader intends to own, which is precisely
  // the reader who wants to know it was reprinted.
  expect(meta.toggles.find((t) => t.key === "theory")?.dflt).toBeUndefined();
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
npm run test:run -- src/lib/ipc.test.ts src/features/home/widgets.test.ts src/features/home/keys.test.tsx
```

- [ ] **Step 3: The three interfaces and the two calls**

In `src/lib/ipc.ts`, beside `PriceMovers`. **Mirror the Rust field for field** — `vi.fn()` mocks
erase this mirror, so a field that is wrong here fails at runtime and not at `tsc`:

```ts
/** One deck holding the card a {@link NewPrinting} is a reprint of — `new_printings.rs`'s
 *  `NewPrintingDeck`. `quantity` is summed across the deck's categories, so a deck holding the
 *  card in both a live and a theory category is one entry with the total. */
export interface NewPrintingDeck {
  deckId: number;
  name: string;
  quantity: number;
  variant: "live" | "theory";
  virtualOnly: boolean;
}

/** One reprinted printing and the decks that hold the card — `new_printings.rs`'s `NewPrinting`.
 *  `releasedAt` is **never null**: a printing with no date cannot be placed in a day group, so
 *  the query drops it rather than the page inventing a bucket. */
export interface NewPrinting {
  printingId: string;
  oracleId: string;
  name: string;
  setCode: string;
  setName: string | null;
  collectorNumber: string;
  releasedAt: string;
  rarity: string | null;
  promoTypes: string | null;
  finishes: string | null;
  /** Which language this printing is — `cards.lang`. **On the wire because a row must be able to
   *  say it**: a reader asking for every language gets one row per language of a reprint, and
   *  without this they are identical-looking rows that read as a duplicated list. */
  lang: string;
  decks: readonly NewPrintingDeck[];
}

/**
 * The feed, and the three facts that travel beside it — `new_printings.rs`'s `NewPrintings`.
 *
 * **An empty list means one of three different things** and a count of zero cannot tell them
 * apart: no deck is watched, nothing was reprinted in this window, or the window is shorter than
 * the card data goes back. `decksWatched`, `since` and `oldest` are what the page reads to pick
 * its sentence — `PriceMovers.days` and `since` are the same device one widget over.
 */
export interface NewPrintings {
  printings: readonly NewPrinting[];
  decksWatched: number;
  since: string;
  oldest: string | null;
  /** When this device last saw a non-empty feed, as a unix second — `app_meta`, never `config`.
   *  `null` is *never*, which draws every dot. */
  seenAt: number | null;
}
```

and beside `priceMovers` in the `ipc` object:

```ts
  newPrintings: (
    scope: string,
    deckIds: readonly number[],
    days: number,
    /** The languages to answer in. **Empty is every language** — the allow-list's one sentinel,
     *  and the same rule at both ends of the wire. */
    langs: readonly string[],
    includeVirtual: boolean,
    includeTheory: boolean,
    includeBasics: boolean,
    limit: number,
  ) =>
    invoke<NewPrintings>("new_printings", {
      scope, deckIds, days, langs, includeVirtual, includeTheory, includeBasics, limit,
    }),
  /** Move the *seen* cursor. The clock is the caller's — `SystemTime::now()` panics on wasm. */
  markNewPrintingsSeen: (at: number) => invoke<void>("mark_new_printings_seen", { at }),
```

- [ ] **Step 4: The key**

In `src/features/home/keys.ts`, and **read the module doc first** — the root rule is load-bearing:

```ts
/**
 * The root the new printings feed is filed under — the module doc's **third** exception, and it is
 * `recentCardsKey`'s case rather than `activityKey`'s.
 *
 * The answer is about `deck_cards` and the corpus, so `["decks"]` is the root it *looks* like it
 * belongs under — and a deck write genuinely does change it. But the other half of the answer is
 * the corpus, which a deck write says nothing about, and the cursor write below is not a deck
 * write at all: filing it under `["decks"]` would refetch the feed after every card added to any
 * deck while leaving it stale after the sync that actually brings new printings in. A root of its
 * own, invalidated by this widget's own cursor write and refetched on mount and on focus like
 * every other query in this app, is the honest arrangement.
 */
export const NEW_PRINTINGS_ROOT: QueryKey = ["newPrintings"];

/** One feed. **Every segment is part of the question** — the scope and its ids pick the decks, the
 *  window picks the far edge, each switch changes which rows are counted, and the limit cuts the
 *  list — so each one has to be able to re-issue the read. The ids are joined rather than nested
 *  so two arrays with the same members are one cache entry. */
export const newPrintingsKey = (
  scope: string,
  deckIds: readonly number[],
  days: number,
  langs: readonly string[],
  flags: { virtual: boolean; theory: boolean; basics: boolean },
  limit: number,
): QueryKey => [
  "newPrintings",
  "feed",
  scope,
  [...deckIds].sort((a, b) => a - b).join(","),
  days,
  // **The resolved list, not the mode** — the key has to be the question the backend was asked.
  // Sorted and joined so two arrays with the same members are one cache entry, and so `["en","ja"]`
  // and `["ja","en"]` do not cost two reads of one answer.
  [...langs].sort().join(","),
  `${flags.virtual ? "v" : ""}${flags.theory ? "t" : ""}${flags.basics ? "b" : ""}`,
  limit,
];
```

- [ ] **Step 5: The registry row**

In `src/features/home/widgets.ts`: add `| "newPrintings"` to `WidgetKind`, change the union's doc
from *nine kinds* to *ten*, change the "Adding a tenth" sentence to "an eleventh", and add the meta
row **at the end of `WIDGET_META`** (the insertion order is the catalogue's order, and a new kind
belongs last). The row is spec §3 **with Decisions 2 and 3 applied** — two scope options, a third
pick for languages, and `dflt: false` on two toggles:

```ts
  newPrintings: {
    label: "New printings",
    description: "Reprints of cards your decks already hold, newest first.",
    def: [3, 3],
    min: [2, 2],
    max: [8, 12],
    picks: [
      {
        key: "scope",
        label: "Which decks",
        // Two options, not three: there is no `decks.pinned`, and on the Decks widget `Pinned`
        // *is* the checklist — so a third option would be this one under a second name. Decision 3.
        options: [
          { id: "all", label: "All decks" },
          { id: "chosen", label: "Chosen…" },
        ],
      },
      {
        key: "window",
        label: "Window",
        dflt: 90,
        options: [
          { id: 30, label: "30 days" },
          { id: 90, label: "90 days" },
          { id: 365, label: "A year" },
        ],
      },
      {
        // **English is `options[0]` and therefore the default**, which is what keeps one reprint
        // to one row for a reader who changes nothing — `cards.id` is one printing *in one
        // language*. The other two are that reader changing their mind on purpose. Decision 2.
        key: "langs",
        label: "Languages",
        options: [
          { id: "en", label: "English" },
          { id: "all", label: "Every language" },
          { id: "chosen", label: "Chosen…" },
        ],
      },
    ],
    toggles: [
      { key: "virtual", label: "Virtual decks", dflt: false },
      { key: "theory", label: "Theory cards" },
      { key: "basics", label: "Basic lands", dflt: false },
    ],
    chip: "window",
  },
```

- [ ] **Step 6: Run them and watch them pass**

```bash
npm run test:run -- src/lib/ipc.test.ts src/features/home/widgets.test.ts src/features/home/keys.test.tsx && npx tsc --noEmit
```

**`tsc --noEmit` is the authority** — IDE diagnostics are stale mid-write. It should now fail on
`HomePage.tsx`'s two switches, which Task 7 fixes; that is expected and is the `Record<WidgetKind,…>`
fence working.

- [ ] **Step 7: Commit**

```bash
git add src/lib/ipc.ts src/lib/ipc.test.ts src/features/home/keys.ts src/features/home/keys.test.tsx src/features/home/widgets.ts src/features/home/widgets.test.ts && git commit -m "feat(home): the new printings wire, key and registry row"
```

---

## Task 6: The body

**Files:**
- Create: `src/features/home/widgets/NewPrintingsWidget.tsx`

**Interfaces:**
- Consumes: everything from Task 5; `WidgetFit` from `../fit`; `WidgetMessage`, `WidgetFooter`
  from `../WidgetParts`; `pickOf`, `toggleOnOf` from `../widgetSettings`.
  Produces: `NewPrintingsWidget`, `NewPrintingsWidgetSettings`, and — exported for their own
  tests, the shape `ActivityWidget.fitDays` and `PriceMoversWidget.emptySentence` already set —
  `printingDays`, `fitGroups`, `emptySentence`, `defaultWindow`, `resolveLangs`, `languagePhrase`,
  `NEW_PRINTINGS_READ`, `ROW_PX`.

- [ ] **Step 1: Write the module doc and the constants**

```tsx
/**
 * Reprints of cards the reader's watched decks already hold, newest first, in day groups.
 *
 * **A body, not a card.** `WidgetCard` draws the title, the chip, the settings popover and the
 * Customize tray; this draws the groups, the rows, the rules and the footer, cut to the box it
 * was handed.
 *
 * ## The day group is `ActivityWidget`'s, deliberately
 *
 * A dim uppercase date with a rule and a count already means *these things happened together* on
 * this page, and a reprint feed is the same sentence about a different noun. Headers do **not**
 * stick to the top of the scroller, matching that widget: a sticky header needs a background of
 * its own, which would paint a band across Customize's tinted card.
 *
 * **Rows flow into `fit.listColumns` columns *inside* a group and never across one** — the header
 * spans the full width and its rows fill the columns under it. Without that rule a four-column
 * card reads as four unrelated lists.
 *
 * ## Three empty sentences, never one
 *
 * `PriceMoversWidget`'s rule and its reason. An empty list means *no deck is watched*, or
 * *nothing was reprinted in this window*, or *the window is shorter than the card data goes back*
 * — and a count of zero printings cannot tell them apart. `decksWatched`, `since` and `oldest`
 * travel beside the list so the page can pick, and {@link emptySentence} is where it picks.
 *
 * ## One read, whatever the box
 *
 * {@link NEW_PRINTINGS_READ} rows — the command's own clamp — and **the box cuts that to whole
 * rows**. A read sized to the rows that fit would re-issue on every drag of the resize corner and
 * paint *pending* over a list that was already right. The rows below the cut are in the DOM and
 * scrollable; cutting is a painting rule, not a limit.
 *
 * ## The rows this body draws are its own, and that is on purpose
 *
 * `WidgetRow` cannot carry a rarity gem *inside* a caption, a bordered deck-count chip and a 5px
 * unseen dot, and widening it for one kind would put three optional slots on the row every other
 * widget draws. `WidgetParts`' module doc allows exactly this — the activity feed's day sections
 * and the recent cards' film strip are the precedents — so the row is local and says so here.
 *
 * **The caption carries the language code whenever the answer is not English alone.** `Every
language` answers one reprint once per language, which is what that reader asked for — and without
the code those are ten rows reading `Sol Ring · SLD · 3 decks` and the list looks broken rather
than complete. The code is titled with `languageName`, so `PH` says *Phyrexian* on the pointer as
it does everywhere else in this app (issue #161).

**{@link ROW_PX} is 54: a 46px thumb, 3px of padding each side and the row's 1px border.** The
 * thumb is **33px** wide rather than the artboards' 34: `CardArt` is `w-full` at `5 / 7`
 * (`CARD_ASPECT`), so 34px is 47.6px tall and the row would be 56 — and 54 is the number the
 * design's whole size matrix was computed against. The artboard's own thumb was a hand-drawn
 * placeholder at 34 × 46, which is not 5:7 at all.
 *
 * **The classes below spell these numbers out and must stay in step with them**; a row taller than
 * the arithmetic thinks is a card whose last row is clipped.
 *
 * ## The unseen cursor
 *
 * `app_meta.new_printings_seen`, `recent_cards`' shape — **not `config`**, because `config`
 * round-trips through older builds and a cursor an older build rewrites is a cursor that lies.
 *
 * **The cursor is read once per mount and held**, which the design does not say and which is the
 * difference between a mark that works and one that does not: the widget writes the cursor when it
 * renders a non-empty list, so a body that re-read it would watch every gold dot vanish under the
 * reader's eyes a frame after they appeared. The write is fire-once per mount, never while
 * `still` (a catalogue preview publishes nothing), and its failure is silent — a mark is not worth
 * a sentence.
 */

/** How many printings the widget reads — `new_printings`' own clamp. See the module doc. */
export const NEW_PRINTINGS_READ = 100;

/** One row's height. 46px thumb + 3px padding each side + the 1px border. See the module doc. */
export const ROW_PX = 54;
/** The thumb, in pixels. 5:7 makes this 46.2 tall, which is the drawn 46. */
const THUMB_PX = 33;
/** A day header: 16px of type over the body's own row gap. */
const HEADER_PX = 16;
/** The gap between two day groups — the body's `gap-2`. */
const GROUP_GAP_PX = 8;
/** What the footer takes off the body before rows are counted, gap included. */
const FOOTER_PX = 22;
/** A month rule, and the `Seen already` rule: 20px over a 6px gap. */
const RULE_PX = 20;
/** The closing line: 34px over an 8px gap. */
const CLOSING_PX = 34;

/**
 * The language allow-list this widget will send, from the `langs` pick and the stored ids.
 *
 * **Empty is every language** — the one sentinel, and the same rule the command has. Three modes
 * collapse into one list here rather than travelling as a mode *and* a list, which would be two
 * fields that can disagree.
 *
 * **`chosen` with nothing usable reads as English, and gets no sentence.** This parts from
 * `DecksWidget`, which says *no decks pinned yet* rather than falling back, and the difference is
 * what the empty set means: an empty deck set is a real statement (*compare against nothing*),
 * where an empty language set would mean *show no printings at all*, which nobody means by
 * unticking the last box. The ids are narrowed against `languages.ts`'s table on the way — the
 * vocabulary check a hand-editable `config` needs, and `widgetConfig`'s shallow shape check
 * cannot make.
 */
export function resolveLangs(widget: HomeWidget): string[] {
  const mode = pickOf(widget, "langs");
  if (mode === "all") return [];
  if (mode !== "chosen") return ["en"];
  const chosen = widgetConfig(widget, { langIds: [] as string[] }).langIds.filter(
    (code) => typeof code === "string" && isKnownLanguage(code),
  );
  return chosen.length > 0 ? chosen : ["en"];
}

/** What the footer says the languages are: *English*, *every language*, *English and Japanese*,
 *  *4 languages*. Named off `languageName`, so `PH` reads as Phyrexian here exactly as it does in
 *  the card pane — issue #161's answer, reused rather than restated. */
export function languagePhrase(langs: readonly string[]): string { /* … */ }

/** A card this big arrives on *a year* rather than *90 days* — §8's finding, as a one-line
 *  default. At three columns every day group collapses to a single row-line, so a big card on a
 *  short window is mostly empty; the footprint is what knows. Not a second registry mechanism:
 *  the reader's own stored `window` always wins, because `pickOf` answers a stored option first. */
const WIDE_ENOUGH_FOR_A_YEAR = 24;
export function defaultWindow(w: number, h: number): 30 | 90 | 365 {
  return w * h >= WIDE_ENOUGH_FOR_A_YEAR ? 365 : 90;
}
```

- [ ] **Step 2: Write the three pure functions the tests will drive**

`printingDays(printings)` folds the flat list into `{ key, label, longLabel, month, printings }[]`
— the release date is already `YYYY-MM-DD` and already sorted descending, so this is a fold and
never a sort. `fitGroups(days, fit, opts)` is `ActivityWidget.fitDays`' shape: budget the rules
first, then spend a header per group and drop a group with no row left rather than drawing a header
over nothing. `emptySentence(answer, days, decksWatched)` is `PriceMoversWidget.emptySentence`'s
shape, **decksWatched first** — a reader watching no decks must never be told nothing was
reprinted.

```tsx
/** `null` when there is something to draw. **The watched count is read before the list**, for
 *  `PriceMovers`' reason one widget over: a reader watching no decks has an empty list for a
 *  reason that has nothing to do with reprints, and telling them nothing was reprinted is a claim
 *  about a comparison nobody made. */
export function emptySentence(answer: NewPrintings, days: number): string | null {
  if (answer.decksWatched === 0) return NO_DECKS;
  if (answer.printings.length > 0) return null;
  return `Nothing in the ${plural(answer.decksWatched, "deck")} you watch has been reprinted in ` +
    `the last ${plural(days, "day")}. New printings arrive with each card data sync.`;
}
```

- [ ] **Step 3: Write the component**

The order of the four states is `ActivityWidget`'s and its reason holds: **the refusal is read
before the emptiness**, because a failed read has no rows either.

```tsx
export function NewPrintingsWidget({ widget, fit, still }: WidgetBodyProps): ReactElement {
  const scope = scopeOf(pickOf(widget, "scope"));
  const deckIds = chosenDeckIds(widget);
  const picked = pickOf(widget, "window");
  const days = typeof picked === "number" ? picked : defaultWindow(fit.w, fit.h);
  const langs = resolveLangs(widget);
  // **Whether a row must say its language** — anything but English alone, and at every tier. See
  // the module doc: this is what tells two rows apart, not a detail a small card can drop.
  const showLang = !(langs.length === 1 && langs[0] === "en");
  const flags = {
    virtual: toggleOnOf(widget, "virtual"),
    theory: toggleOnOf(widget, "theory"),
    basics: toggleOnOf(widget, "basics"),
  };
  // … useQuery on newPrintingsKey(scope, deckIds, days, langs, flags, NEW_PRINTINGS_READ)
  // … the cursor held at mount, the fire-once write, the four states, the groups
}
```

**Three things in here are easy to get wrong and each has a rule:**

* **No `setState` inside an effect** — the derived-state sync fails lint only at `verify`. The
  cursor is held with a `useRef` seeded on the first non-pending render, not with state.
* **The `window` default must not be written to `config`.** A widget that wrote its own default on
  render is a page that edits itself while being read (`DecksWidget` says this about pins). It is a
  read-time fallback and nothing else — which is also why a reader's stored `30` survives a resize.
* **The popover is why `WidgetCard` does not clip**, and this body must not either.
* **`showLang` is read off the *resolved* list and never off the pick**, so a `chosen` that
  narrowed down to English alone draws no language code — there would be nothing for it to tell
  apart.

The footer at tier ≥ 1 names the window, the watched decks and the languages —
*6 decks watched · 90 days · English · basics hidden*. §4's footer row, with `languagePhrase`
supplying the third part.

- [ ] **Step 4: Typecheck**

```bash
npx tsc --noEmit
```

Expected: clean except `HomePage.tsx`'s two switches (Task 7).

- [ ] **Step 5: Commit**

```bash
git add src/features/home/widgets/NewPrintingsWidget.tsx && git commit -m "feat(home): draw the new printings feed"
```

---

## Task 7: The drill-down, the settings, and the page

**Files:**
- Modify: `src/features/home/widgets/NewPrintingsWidget.tsx` (the popover, `NewPrintingsWidgetSettings`)
- Modify: `src/features/home/HomePage.tsx` (both switches)
- Modify: `src/features/home/HomePage.test.tsx` (a tenth mock, and the "nine" prose)

- [ ] **Step 1: The popover**

`AnchoredPopup` with `align="end"` and `panelClassName="w-[248px]"`, titled `<Card> is in`. Each
line is an 18px rounded cover swatch, the deck name, and `×N` in mono — or a `theory` chip in place
of the count when the holding row is `variant: "theory"`. Each line is a `<button>` that does
`setSelectedCardId(printingId)` then the pair `DecksWidget` already does:

```tsx
  // **`decks` is one view with two states.** `setActiveView` clears `openDeckId` on the way in, so
  // the order matters — `DecksWidget` says the whole of this at its own site.
  const openDeck = (id: number) => {
    setActiveView("decks");
    setOpenDeckId(id);
  };
```

Read `AnchoredPopup.tsx`'s props before using any of them — **never hallucinate a component
property**, which is `src/CLAUDE.md`'s standing rule. `align`, `panelClassName` and `panelLabel`
are confirmed to exist; anything else is not.

- [ ] **Step 2: `NewPrintingsWidgetSettings`**

**Two pickers, each drawn only when its own pick is on `Chosen…`.**

*The decks.* `DecksWidgetSettings`' shape almost exactly: a `MultiDropdown` of every deck, drawn
**only** while the scope is `Chosen…`, with a sentence pointing at the scope row otherwise — a
picker under `All decks` would be a control whose every press changes nothing. Read the scope row's
words off the registry (`scopeWords()`'s trick) so the sentence cannot name a renamed control. The
patch writes `{ deckIds: next, scope: "chosen" }`.

*The languages.* The same shape one pick down, drawn only while `langs` is on `Chosen…`, writing
`{ langIds: next, langs: "chosen" }` — the second key for `DecksWidgetSettings`' reason, so the
choice is stored rather than inferred. The options are `languages.ts`'s 19 codes, **English first
and the rest by name**, which is `PrintingsFilterBar`'s own order; each row's label is the code and
its accessible name is `languageName(code)`, because `PH` is a riddle and *Phyrexian* is not. No
*nothing chosen* sentence here — `resolveLangs` reads an empty set as English, and the module doc
says why that differs from the deck picker.

Both sections need the language vocabulary exported from `languages.ts`. It currently exports
`languageName` and `languageHint` only, so **add a `LANGUAGE_CODES` export** (the `Map`'s keys, in
its declared order, English already first) and an `isKnownLanguage` predicate beside them, with a
line in that module's doc saying the table now has a fourth reader.

- [ ] **Step 3: The page's two switches**

In `HomePage.tsx`, `renderBody`'s switch after `case "priceMovers"`:

```tsx
    case "newPrintings":
      return <NewPrintingsWidget {...props} />;
```

and `renderExtraSettings`' switch after `case "folders"`:

```tsx
    case "newPrintings":
      return <NewPrintingsWidgetSettings widget={widget} onConfig={onConfig} />;
```

with the two imports.

- [ ] **Step 4: The page's test**

`HomePage.test.tsx` mocks every widget body so its assertions do not wait on ten fetches. Add the
tenth mock in the same shape as the nine, and **re-count the prose**: three doc comments say
"nine", and a prose-only edit routes to neither CI job, so nothing goes red when one rots.

- [ ] **Step 5: Run and typecheck**

```bash
npm run test:run -- src/features/home && npx tsc --noEmit
```

Expected: PASS, clean.

- [ ] **Step 6: Commit**

```bash
git add src/features/home && git commit -m "feat(home): open a printing's decks from the new printings feed"
```

---

## Task 8: Stories and the Storybook fake

**Files:**
- Create: `src/features/home/widgets/NewPrintingsWidget.stories.tsx`
- Modify: `.storybook/fake/db.ts` (a `new_printings` read handler, and `mark_new_printings_seen`)

- [ ] **Step 1: The fake's handler**

`.storybook/fake/db.ts`'s `readHandlers` answers a read command per entry; without one the stories
render an error rather than a widget. Derive the feed from the fake's own decks and corpus the way
`price_movers` derives a history from the collection — **never a hand-written literal**, so a story
and the real widget cannot come to disagree about the shape.

**`grep` calls this file binary** (a stray NUL), so `grep`'s "no matches" is a lie here — search it
with `git grep -a` or read it directly.

- [ ] **Step 2: The stories**

`PriceMoversWidget.stories.tsx`'s `Framed` harness verbatim (`CELL = 104`, the real `WidgetCard`
around the real body). Six stories, each with a `play` that asserts what that footprint is *for*:

| Story | Footprint | What its `play` asserts |
| --- | --- | --- |
| `Default` | 3 × 3 | one day header, rows under it, the `90 days` chip absent (tier 1) |
| `Tile` | 2 × 2 | two rows, the deck count in the caption, no chip |
| `Band` | 6 × 4 | three list columns, the set *name* in the caption, the footer, the `A year` chip |
| `Tall` | 4 × 12 | month rules between groups, and the closing line |
| `NoDecks` | 3 × 3 | the *no decks are being watched* sentence and a `Choose decks…` press |
| `NothingReprinted` | 3 × 3 | the *nothing has been reprinted* sentence, and **not** the no-decks one |
| `EveryLanguage` | 4 × 6 | one reprint drawn once **per language**, each row carrying its code, and the footer saying *every language* |

A `docs.description.component` paragraph covering the three empty sentences, the day grouping, the
`Languages` pick (and why the row carries a code once the answer is not English alone) and the
off-by-default switches.

The fake's handler needs **at least one reprint in two languages** in its corpus, or `EveryLanguage`
is a story that cannot fail.

- [ ] **Step 3: Run the story plays**

**Only if no fan-out is running** — `stories.test.tsx` collects the whole tree, and a filter that
matches the file path exits 0 on nothing.

```bash
npm run test:run -- src/features/home/widgets/NewPrintingsWidget.stories.tsx
```

- [ ] **Step 4: Commit**

```bash
git add src/features/home/widgets/NewPrintingsWidget.stories.tsx .storybook/fake/db.ts && git commit -m "test(home): the new printings workbench and its fake"
```

---

## Task 9: The widget's own tests

**Files:**
- Create: `src/features/home/widgets/NewPrintingsWidget.test.tsx`

Spec §11's cases, plus the ones the plan's findings add. **Assert the arithmetic, never §8's
fixture-bound counts** — and state the fixture in the test.

- [ ] **Step 1: Write them**

```tsx
/** §11's checkable case, and the one entry of §8 that is fixture-independent: a 2 × 2 has 168px
 *  of body, so `floor((168 − 22 + 6) / (54 + 6))` is two rows whatever the days do. */
it("draws exactly two rows at 2 × 2, and no chip", async () => { /* … */ });

it("draws the month rules and the closing line at 4 × 12", async () => { /* … */ });

/** **Three sentences, never one.** A reader watching no decks is not a reader whose decks hold
 *  nothing new, and handing them the wrong one sends them to the wrong place. */
it("says no decks are watched, and not that nothing was reprinted", async () => { /* … */ });
it("says nothing was reprinted when decks are watched and the list is empty", async () => { /* … */ });
it("reads the refusal before the emptiness", async () => { /* … */ });

/** The unseen mark's own trap: the widget writes the cursor on a non-empty render, so a body that
 *  re-read it would blank every dot a frame later. */
it("keeps the dots up after writing the seen cursor", async () => { /* … */ });
it("writes no cursor while still", async () => { /* … */ });

/** Decision 2's resolution, which is pure and worth pinning without a render. */
it("resolves the three language modes into one allow-list", () => {
  expect(resolveLangs(widget({ langs: "en" }))).toEqual(["en"]);
  expect(resolveLangs(widget({}))).toEqual(["en"], "English is the default");
  expect(resolveLangs(widget({ langs: "all" }))).toEqual([], "empty is every language");
  expect(resolveLangs(widget({ langs: "chosen", langIds: ["en", "ja"] }))).toEqual(["en", "ja"]);
  // A hand-edited row: unknown codes are dropped, and nothing usable reads as English.
  expect(resolveLangs(widget({ langs: "chosen", langIds: ["zz", 7, null] }))).toEqual(["en"]);
  expect(resolveLangs(widget({ langs: "chosen", langIds: [] }))).toEqual(["en"]);
});

/** **The rule that keeps `Every language` from looking like a duplicated list.** Ten rows reading
 *  `Sol Ring · SLD · 3 decks` is a broken list; the same ten with a language code is a complete
 *  one. Asserted at 2 × 2 as well, because this is the one caption part a tile must not drop. */
it("carries the language code once the answer is not English alone", async () => { /* … */ });
it("draws no language code when the answer is English alone", async () => { /* … */ });

/** §8's finding as a unit test, where it is arithmetic rather than a render. */
it("arrives on a year when the footprint is big, and on ninety days otherwise", () => {
  expect(defaultWindow(6, 4)).toBe(365);
  expect(defaultWindow(3, 3)).toBe(90);
  expect(defaultWindow(4, 12)).toBe(365);
  expect(defaultWindow(2, 12)).toBe(365);
});

/** A group's rows fill the columns **under their own header** and never across one. */
it("keeps a day's rows inside its own group at three columns", async () => { /* … */ });
```

**Three traps this file will meet**, each of which has cost a session before:

* A CSS `gap` breaks the accessible name — a label and its count compute to `Missing2`. The day
  header's count is a separate element for exactly this reason; assert the header's name, not the
  concatenation.
* A `describes: false` tooltip has no role, so probing `[role=tooltip]` finds nothing.
* Store state leaks between tests — reset the app store between cases or the popover's navigation
  assertions become order-dependent.

- [ ] **Step 2: Run them**

```bash
npm run test:run -- src/features/home/widgets/NewPrintingsWidget.test.tsx
```

- [ ] **Step 3: Prove a test can fail**

For each of the three sentence tests, break the branch it covers (swap the `decksWatched === 0`
arm out), re-run, confirm red, put it back. **A green suite proves nothing until the mutation has
been run** — eight ways a suite passes over the defect are on record.

- [ ] **Step 4: Commit**

```bash
git add src/features/home/widgets/NewPrintingsWidget.test.tsx && git commit -m "test(home): pin the new printings widget's sentences and its arithmetic"
```

---

## Task 10: The record

**Files:**
- Modify: `docs/reference/home-page.md`

- [ ] **Step 1: Update what the tenth kind makes stale**

A prose-only edit routes to neither CI job, so nothing goes red when a document rots — these are
re-counted in the same commit that changes one.

* `## 3. The nine widgets` → `## 3. The ten widgets`, with a row for `newPrintings` in the table:
  *reprints of cards your watched decks hold, in day groups* —
  `{ scope: all·chosen, deckIds, window: 30·90·365, langs: en·all·chosen, langIds, virtual, theory, basics }`.
* §3's paragraph on `toggles` — *"(on/off, stored only as `false`)"* → the default is stored as
  absence, whichever way round the default runs, and a kind names `dflt` where it runs the other
  way.
* §1's table and §3's `DEFAULT_LAYOUT` paragraph: confirm both still say eight seeded widgets.
  **They should — that is the point** — and a reader of §12 will check.

- [ ] **Step 2: Write §12**

A new section after §11, in this document's voice — every measurement with the date and the build:

* **The tenth kind, and the one command it cost.** `home.rs` untouched, with
  `the_new_printings_kind_reaches_no_vocabulary_in_this_module` named as the fence.
* **Two statements over one `WHERE`, and what one statement would have cost** — the deduplication
  requirement, broken quietly.
* **Languages are a setting and not a constant** (Decision 2, which supersedes spec §2's `⚠`
  block): the three modes, why *empty is every language* is the one sentinel, why `Chosen…` with
  nothing ticked reads as English where the deck picker says *nothing pinned*, and **why the row
  carries a language code once the answer is not English alone**. Record that `languages.ts` gained
  a fourth reader and two exports.
* **`scope` has two options and not three** (Decision 3): there is no `decks.pinned`, pinning is a
  widget's `config.deckIds`, and a page may hold two `decks` widgets — so *the pinned decks* has no
  referent. Worth recording because the spec says three and a later reader will check.
* **`WidgetToggle.dflt`** — what changed, and the argument that no existing toggle moved: one
  reader, one writer, and the two functions agree on every input.
* **The row is 54px and the thumb is 33 and not 34**, with the arithmetic and the note that the
  artboard's thumb was a placeholder at an aspect no `CardArt` draws.
* **§8's size matrix reproduces from `fit.ts` exactly** (record the table above), **and its
  `Printings` column is fixture-bound** — the tests assert the fitting function, never the table.
* **The `window` default follows the footprint** — `w * h >= 24` arrives on a year — and why that
  is a component default rather than a second registry mechanism.
* **The cursor is read once per mount and held**, and what re-reading it would have cost.
* **The three empty sentences**, and that the watched count is read first.
* Whatever the live pass in Task 11 finds.

- [ ] **Step 3: Commit**

```bash
git add docs/reference/home-page.md && git commit -m "docs(home): record the tenth widget kind"
```

---

## Task 11: Verify, drive the real window, ship

- [ ] **Step 1: `npm run verify`**

```bash
npm run verify
```

**Never pipe it** — `| tail` reports tail's `0` while tests fail. **Never run two at once** —
concurrent runs fake ~18 Rust schema failures. If a long run gets killed, shard vitest.

- [ ] **Step 2: The two `verify` does not run**

```bash
cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings
```

These are the only reds a green `verify` allows, and CI runs both.

- [ ] **Step 3: Drive the real window**

Every UI task in Plans 2–3 found something the suite could not. Take the `app` lock first — only
one app runs across every worktree and the collision is silent, and a dev build launched from
another worktree opens a window in the *running* app showing somebody else's branch.

Add the widget from the catalogue and check, at 2 × 2, 3 × 3, 6 × 4 and 4 × 12: no clipped last
row, no horizontal scroll, the popover opens and is not clipped by the card, a deck press lands in
that deck with the card selected, the gold dots survive the cursor write, and the three empty
sentences each appear for their own reason. `docs/reference/live-ui-verification.md` is the
contract and documents traps that have each cost a session.

- [ ] **Step 4: Record what the pass found in §12, and commit**

- [ ] **Step 5: Ship with `auto-pr`**

Eight to ten agents are shipping at once and every merge into `main` knocks the other PRs to
`BEHIND`, which is what that skill is for. It arms auto-merge and watches for the only two states
GitHub abandons: a real conflict and a red `ci-ok`. **The agent does not press Merge.**

Watch for the schema-rung collision if `main` has moved — renumber before merging, and note that
fixture names collide too. `pr-auto.ps1 open` skips a reused branch after that branch's PR merges,
and `--fill` drops `Closes #462` at two commits, so put it in the body by hand.

---

## Self-review

**Spec coverage.** §1 → Tasks 6, 7. §2 → Tasks 2, 4, 5 (`lang` is Decision 2). §3 → Tasks 1, 5,
and `Chosen…`'s picker is Task 7; its `pinned` option is Decision 3. §4 → Task 6 (row parts by tier), with the 33px finding resolved
above. §5 → Task 6 (the three height-gated rules, the cursor). §6 → Task 7. §7 → Task 6
(`emptySentence`), Task 9. §8 → verified above; the default-window rule is Task 6's
`defaultWindow`. §9 → Task 6's module doc; the scroller is `WidgetCard`'s and needs no change. §10
→ corrected in the findings table and carried into the file structure. §11 → Tasks 2, 3, 5, 9.
§12 → Decisions 1 and 2 answered, 3–5 carried into the registry row, `defaultWindow` and the
`app_meta` cursor.

**The brief's five constraints.** `home.rs` gains nothing → Task 3's two tests. `DEFAULT_LAYOUT`
untouched → Task 3's second test and Task 5's `widgets.test.ts` case. Stories and tests → Tasks 8
and 9. §8 reconciled → the findings table, with the arithmetic run. `verify` green and
`home-page.md` updated → Tasks 10 and 11.

**Placeholders.** Tasks 6, 7 and 8 describe two components and a Storybook fake at the level of
their module docs, their constants, their exported signatures and every rule that is easy to get
wrong, rather than transcribing ~600 lines of JSX. That is deliberate: the layout details are in
five artboards the implementer has, and the parts that are *decisions* — which are the parts a
transcription would bury — are written out in full. Every other task carries its real code.

**Type consistency.** `NewPrintings`/`NewPrinting`/`NewPrintingDeck` are spelled identically in
Tasks 2, 5 and 6. `toggleOn(widget, key, dflt?)` and `toggleOnOf(widget, key)` are consistent
between Tasks 1, 5 and 6. `newPrintingsKey(scope, deckIds, days, flags, limit)` matches its one
call site. `NEW_PRINTINGS_READ` is `100` on both sides. `ROW_PX` is `54` in Tasks 6 and 9 and in
the findings table.

**Nothing is left to the implementer to guess.** The one thing that looked like it would be —
whether `decks.pinned` exists — was checked against `schema.rs` rather than flagged, and the answer
turned a note into Decision 3.
