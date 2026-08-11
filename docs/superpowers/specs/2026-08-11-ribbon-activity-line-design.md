# The ribbon says what it is doing

**Date:** 2026-08-11
**Status:** approved, not yet implemented
**Branch:** `feat/ribbon-activity-line`

The mana line under the ribbon is the app's only progress bar, and while it fills the
ribbon says nothing about why. The bar knows — `ManaLine` is handed
`{value, label}` and puts the label in its `aria-label`, so a screen reader is told
"Importing cards" and a pair of eyes is told nothing. The visible line in that row goes on
reading `116,568 cards · data from 2026-08-03` for the entire ninety seconds, which is the
one sentence in the window that is *least* about what is happening.

This puts the sentence on screen, and does it through a small registry so that the ribbon
describes **whatever long job is running**, not specifically a sync.

---

## 1. The registry

New module, `src/lib/activity.ts`. One job, described the same way whoever pushes it:

```ts
export interface Activity {
  /** One job per key — re-registering the same key replaces it. */
  key: string;
  /** Lower wins when two jobs run at once. */
  rank: number;
  /** The sentence: "Downloading card data". */
  label: string;
  /** The unit the job is counting: "45 / 77 MB", "83,000 cards", "62%". */
  detail: string | null;
  /** 0–1, or `null` for a phase with no denominator. */
  value: number | null;
}
```

`{value, label}` is exactly today's `ManaLineSync`, so `Activity` **extends** that type and
`ManaLine` needs no change of any kind — the top activity is passed to it as-is.

Ranks are a small frozen record rather than magic numbers at the call sites:

| rank | key               | who                                    |
| ---- | ----------------- | -------------------------------------- |
| `0`  | `sync`            | the Scryfall sync                      |
| `10` | `update-download` | downloading a new version of the app   |

Gaps of ten, so a job that belongs between two existing ones does not renumber them.

### Where the state lives

A **vanilla zustand store created inside an `ActivityProvider`**, not a module global.

Two reasons, both load-bearing. Selector subscriptions mean an ingest's progress events
re-render the status line and the mana line and nothing else — a `useState` in a common
parent would re-render every view under it fifty-odd times per sync. And a store owned by a
provider is the one shape Storybook's per-story world can isolate: CLAUDE.md already records
`useAppStore` as *the* global that cannot be made per-story from `.storybook/`, and this
should not become the second.

The provider sits at the top of `AppShell`, which is above both of today's writers **and**
above `children` — so a future import started from Settings registers a job with no
rewiring. `AppShell` therefore splits: the exported component renders the provider around an
inner one that does everything it does today.

### The two hooks

```ts
useRegisterActivity(job: Activity | null): void   // declarative
useTopActivity(): Activity | null                 // lowest rank, ties by insertion order
```

Registration is **declarative, never imperative**. A `begin()`/`end()` pair is a leak
waiting to happen — an early return, a thrown error, an unmount mid-job, and the ribbon
claims forever that something is running. Passing the job (or `null`) on every render and
letting one effect reconcile it means a job cannot outlive the component that describes it:
the effect's cleanup drops it by key.

Ties break by insertion order, so the answer is deterministic and testable rather than
dependent on which of two hooks happened to run its effect first.

## 2. The two adapters that exist today

**`syncActivity(progress, busy)`** is today's `manaLineSync`, moved out of `src/lib/mana.ts`
and given a `detail`. It was always a lodger there — a module about Magic's colour pie that
imports `PHASE_LABEL` — and moving it puts the fold next to the type it produces.

`busy` keeps deciding whether anything is running, not the presence of an event. That rule
is not new and its reasons have not changed: a run inside the 24 h check window emits
nothing at all, and Tauri drops the events emitted before the webview started listening.
`done` and `error` stay indeterminate rather than full or empty, because their event can
outlive the run by a poll interval.

The `detail` is the phase's own unit:

| phase        | detail        | why                                                     |
| ------------ | ------------- | ------------------------------------------------------- |
| `checking`   | none          | no denominator, and it is over in under a second        |
| `downloading`| `45 / 77 MB`  | bytes, the same formatter the first-run overlay uses    |
| `ingesting`  | `83,000 cards`| rows so far; see below                                  |
| `reclaiming` | `62%`         | the one phase whose fraction is exactly true            |
| `sets`       | none          | no denominator                                          |
| `compacting` | none          | `VACUUM` reports no progress of any kind                |

The ingest prints no denominator on purpose: its total is `INGEST_TOTAL_ESTIMATE`, a
constant, and `83,000 / 117,000 cards` would read as a count of a file nobody has counted.
The bar still fills from that estimate, as it does today — an approximate fraction is a fair
thing for a 2px rule to imply and an unfair thing for a number to state.

**`updateActivity(update)`** reads the `Update` object `AppShell` is already handed, and
produces `Downloading update 0.3.0 · 12 / 40 MB`. It registers only while a download is in
flight — an update *check* is a sub-second call with nothing to report, and a staged build
waiting to install is not a job that is running.

`SyncProgress`'s first-run overlay loses its private `detail()` and calls the shared
formatter, so the byte counts on the two surfaces cannot drift apart.

## 3. What the ribbon draws

`Ribbon` stays presentational — it is handed strings that someone else formatted, which is
how `statusLine` already works. Its `sync` prop becomes `activity: Activity | null` (drives
the mana line, instantly, exactly as today), and it gains `activityVisible: boolean`.

One source of truth and one gate, rather than two props carrying the same job at two
different times. `AppShell` computes the gate with a small `useDelayedFlag(active, 400)`:
true after 400 ms of *any* activity being present, false the moment none is. It gates the
slot, not one job — so a sync handing over to an update download changes the sentence
without the slot blinking, and only a genuine gap re-arms the delay. The mana line reacts
instantly because a 2px rule flickering is the app's existing vocabulary for "something
brief happened"; a *sentence* that appears and vanishes inside a second is a thing the
reader tries to read and fails. A Refresh that finds nothing new takes ~1.8 s, of which the
`checking` phase is under one — so the common no-op Refresh shows the bar, then
"Already up to date", and never a half-read sentence in between.

When `activityVisible`, the activity takes the status-line slot:

```
IDLE   MTG │ Search        116,568 cards · data from 2026-08-03   [↻ Refresh data]
BUSY   MTG │ Search        Downloading card data · 45 / 77 MB     [↻ Refresh data]
       MTG │ Search        Importing cards · 83,000 cards         [↻ Refresh data]
       MTG │ Search        Downloading update 0.3.0 · 12 / 40 MB  [↻ Refresh data]
```

The corpus summary comes back the moment nothing is running. It is not lost while hidden —
it is a static fact about a database, and the tooltip that names the data folder stays on
the same element throughout.

### The live region

The slot becomes **one permanently mounted `role="status"` line**, rather than the
conditionally rendered `<p>` it is today. A live region that first appears with its sentence
already inside it announces nothing — this codebase learned that on the sidebar's drop
report and the card pane's swap report, and a status line that is mounted at the moment it
has something to say is exactly that mistake. Empty, it carries `sr-only` so it takes no
space in the flex row.

The result is that a phase change announces: "Downloading card data" → "Importing cards" →
"Reclaiming disk space" → "116,590 cards · data from 2026-08-11". Four polite
announcements across ninety seconds, ending with the answer.

The `detail` goes in a **sibling `aria-hidden` span** in Geist Mono — the direction's third
type role is data, and a byte count that reflows every 200 ms is what it is for. It is
hidden because a live region computes its announcement from accessible text and skips
`aria-hidden` subtrees: inside the region, a number that changes fifty-eight times during an
ingest would be fifty-eight announcements. Nothing is lost — the mana line's `aria-valuenow`
carries the same fraction, and that is the element whose job it is.

## 4. Errors

Nothing new. A failed sync already has two surfaces — the `role="alert"` banner under the
ribbon and the first-run overlay's message — and both are driven by `sync_status.lastError`,
which outlives the event. `syncActivity` treats `error` and `done` exactly as
`manaLineSync` does today — indeterminate, under the generic "Syncing card data", for
however long `busy` is still true — and then the job ends with `busy` and the corpus summary
returns. The ribbon never becomes a third place a failure is reported, and it never leaves a
red word sitting in a status line the reader has no way to dismiss.

## 5. Testing

Unit, in `src/lib/activity.test.ts`:

- rank ordering, and ties broken by insertion order
- re-registering a key replaces rather than duplicates
- unmounting the registering component drops the job
- every `SyncPhase` maps to a label and the right `detail`, including the phases with none
- the update adapter's version string, and that it is silent when no download is running
- `useDelayedFlag` under fake timers: nothing before 400 ms, gone immediately on stop

`Ribbon.test.tsx`: the activity replaces the summary while visible and the summary returns;
the detail is `aria-hidden`; the status line is mounted before it has anything to say.

`AppShell.test.tsx`: a real `sync:progress` event arrives and the sentence reaches the
ribbon — the one test that proves the wiring rather than the pieces.

Storybook: `Ribbon` stories for each phase and for an update download, and `stories.test.tsx`
plays them as it plays the other 195.

Then **a live CDP pass on the shipped window**, against a forced Refresh. CLAUDE.md is blunt
that every UI task in Plans 2–3 found something the suite could not, and this change has two
things a suite is structurally bad at seeing: a 400 ms delay landing at the wrong moment,
and a sentence that overflows a 48px row into the Refresh button at 1024px with the update
button also present.

## 6. Out of scope

- The first-run overlay's copy and layout, which already names its phase.
- The Settings update panel's own progress bar, which stays where it is.
- Any new kind of job. The registry is built so that an import plugs into it; it is not
  pre-populated with one that does not exist.
