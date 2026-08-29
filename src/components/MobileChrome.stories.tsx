import { useEffect, useRef, useState, type ReactElement } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Heart, Menu, Search, Settings, Tags, X, type LucideIcon } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { Ribbon } from "@/components/Ribbon";
import { CabinetFiling, Cards } from "@/components/icons";
import { columnsFor, sideGutterFor } from "@/features/search/CardGrid";
import { DROP_RING } from "@/lib/dropMarks";
import type { SyncStatus } from "@/lib/ipc";
import { LAYER } from "@/lib/layers";
import { PRESS } from "@/lib/motion";
import { useAppStore, type ViewId } from "@/lib/store";
import { NAV_COLLAPSED_KEY } from "@/lib/useNavCollapsed";
import { statusLine } from "@/lib/useSync";
import { useUpdate } from "@/lib/useUpdate";
import { cn } from "@/lib/utils";
import { PHONE_HEIGHT_PX, PHONE_PX } from "@/lib/viewports";

/* ------------------------------------------------------------------ the phone frame ------ */

// Declared here rather than shared, and the numbers rather than the box are what is shared.
// A Tailwind class cannot be built by interpolation — it would emit no rule at all — so the
// width is an inline style, which is how this repo already spells a computed length.
// `shrink-0` because the docs canvas is a flex container: without it a narrow canvas shrinks
// the frame and the story becomes a picture of a width nobody asked for.
const phone = (Story: () => ReactElement) => (
  <div
    className="flex shrink-0 overflow-hidden"
    style={{ width: PHONE_PX, height: PHONE_HEIGHT_PX }}
  >
    <Story />
  </div>
);

/* ---------------------------------------------------------------- the app's own words ---- */

/**
 * One `sync_status` answer, so the ribbon's line is the app's own `statusLine` output rather
 * than a sentence this file typed.
 *
 * `Ribbon.stories.tsx` keeps an identical helper for the identical reason and neither file can
 * import the other's — every non-default export of a CSF file is indexed as a story. The numbers
 * are that file's, deliberately: the two ribbons on the workbench should be reporting the same
 * database, and the only thing this round changes is how much room the sentence gets.
 */
const STATUS: SyncStatus = {
  cardCount: 116_590,
  lastCheckAt: "1786266000",
  bulkUpdatedAt: "2026-08-08T21:16:00.000Z",
  lastError: null,
  lastIngestSkipped: 0,
  dataDir: "D:\\MTG Grimoire\\data",
  syncing: false,
  imageStoreFailures: 0,
};

/** The idle line, computed once so no two frames on this page can disagree about it. */
const IDLE_LINE = statusLine(STATUS);

/**
 * The six destinations — **a copy of `AppShell.tsx`'s `NAV`, and the copy is one of this
 * round's findings rather than a shortcut.**
 *
 * `NAV` is a module-private `const` in `AppShell.tsx`, and its own comment says why it is one
 * list: *"the label is also the ribbon's `<h1>` … so there is one word per view rather than two
 * that can drift."* Every option below that draws the six entries anywhere but the shipped rail
 * has to reach that list, and today it cannot — so R2 and R3 each begin by paying for a second
 * copy of the exact thing that comment exists to prevent. The fix is one `export` keyword and it
 * belongs to 9b; what this file must not do is pretend the cost is not there.
 *
 * The **icons** are not part of the cost: `Search`, `Tags`, `Heart` and `Settings` are lucide's
 * and `Cards`/`CabinetFiling` are `components/icons.ts`'s, all importable. It is the pairing of
 * id, word and glyph that is private.
 */
const NAV_COPY: { id: ViewId; label: string; Icon: LucideIcon }[] = [
  { id: "search", label: "Search", Icon: Search },
  { id: "tags", label: "Tagger", Icon: Tags },
  { id: "decks", label: "Decks", Icon: Cards },
  { id: "collection", label: "Collection", Icon: CabinetFiling },
  { id: "wishlist", label: "Wishlist", Icon: Heart },
  { id: "settings", label: "Settings", Icon: Settings },
];

/** The two entries `useSidebarDrops` will take a card on. `SidebarTargetId`'s members, and the
 *  only reason a moved rail is a drag question at all. */
const DROPPABLE: ReadonlySet<ViewId> = new Set<ViewId>(["decks", "wishlist"]);

/* ------------------------------------------------------------------- the wall it leaves -- */

/**
 * The view, reduced to the one thing this round is spending: **the box the next round gets.**
 *
 * Every option below moves chrome, and the only honest way to compare three arrangements of
 * chrome is by what is left over. So the stand-in measures its own content box and runs it
 * through `CardGrid`'s **own** `columnsFor` and `sideGutterFor` — the exported functions, not a
 * transcription of their arithmetic — and prints the answer. Round 2 argues from these numbers,
 * and a number a story computed live cannot be the one that rotted.
 *
 * `ResizeObserver` rather than one `getBoundingClientRect` at mount: the docs page lays a frame
 * out after the story commits, and a single read at mount catches the box before the fonts land.
 * Under `stories.test.tsx` the observer is `test-setup.ts`'s no-op stub and never fires, so the
 * unmeasured branch below is what jsdom renders — which is correct rather than a compromise,
 * because jsdom has no layout engine and any number it printed would be a fiction.
 */
function Wall({ note }: { note: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    // Measured only from the callback, never synchronously in the effect body — the observer
    // fires once on `observe()` in a real browser, so there is nothing to gain by reading twice
    // and `react-hooks/set-state-in-effect` refuses the synchronous call outright.
    const observer = new ResizeObserver(() => {
      setBox({ w: element.clientWidth, h: element.clientHeight });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className="flex h-full flex-col justify-between rounded-lg border border-dashed border-border p-3 text-xs text-dim"
    >
      <p className="font-mono tabular-nums">
        {box ? `${box.w} × ${box.h}` : "unmeasured — jsdom has no layout"}
      </p>
      <div className="space-y-1">
        {box && (
          <p className="font-mono tabular-nums">
            {`columnsFor ${columnsFor(box.w)} @170 · gutter ${Math.round(sideGutterFor(box.w))}px`}
            <br />
            {`columnsFor ${columnsFor(box.w, 160)} @160`}
          </p>
        )}
        <p className="leading-snug">{note}</p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------------ R1 ------- */

/**
 * **R1 — the rail holds, the ribbon sheds.** The shipped app, at 390, with the rail forced to
 * the 68px it already knows how to be.
 *
 * This story is the whole of R1's argument: it mounts the real `AppShell`, so the rail, its six
 * `NavItem`s, their drop targets, `useNavCollapsed`, `useNavLabels` and the real `Ribbon` are
 * every one of them the shipped code and not a drawing of it. Nothing here is a mock-up.
 *
 * **The collapsed state is seeded into the query cache rather than into the fake's rows**, which
 * is `AppShell.stories.tsx`'s arrangement and the same limitation: a story may ask its world for
 * a `seed` and a `fault` and nothing else, and "the rail is collapsed" is neither. `staleTime:
 * Infinity` means a value already in the cache is the answer and no `nav_collapsed` call is made.
 *
 * **`collection` rather than `search`, and the choice is a measurement.** `Collection` is the
 * longest of the six titles — 125.75px at 20px Cinzel, against `Decks`'s 63.39 — so it is the one
 * that shows what the row actually does to a name. Opening on `Search` would have drawn a ribbon
 * that looked fine.
 *
 * **What this frame does *not* show is R1's other half.** "The ribbon sheds" means the status
 * line leaves the row, and `RibbonProps` has no member for it: `statusLine: string | null` can be
 * emptied — which is a real shed, and a good one, because the `role="status"` stays mounted and
 * goes `sr-only` rather than unmounting — but there is no `onStatusPress`, no slot and no
 * children, so the *press* that would bring it back cannot be expressed. `AppShell` computes that
 * prop from its own `sync_status` poll, so a story mounting the shell cannot even pass the empty
 * one. The shed is a prop 9b has to add; the write-up says so.
 */
function R1() {
  const client = useQueryClient();
  useState(() => {
    useAppStore.getState().setActiveView("collection");
    client.setQueryData(NAV_COLLAPSED_KEY, true);
  });
  const update = useUpdate();
  return (
    <AppShell update={update}>
      <Wall note="The rail is 68 of the window's 390, and main's p-5 takes 40 more." />
    </AppShell>
  );
}

/* ------------------------------------------------------------------------------ R2 ------- */

/**
 * **R2 — a bottom tab bar.** The six destinations move into the thumb zone; the rail is gone.
 *
 * **The mana line stays at the top, and the bar gets a plain hairline.** This is the one real
 * design decision in the option and it is a decision to spend nothing: the app now has chrome on
 * two edges, and the templated answer — a second 2px gradient under the tab bar, so the frame is
 * "bracketed" — draws the signature twice. `Ribbon`'s own comment is the argument: the line is
 * what marks *the app's edge rather than the content's*, and a mark that appears at both edges
 * marks neither. So the bar carries `border-t border-border`, which is this app's ordinary word
 * for an edge, and the 2px rule keeps its single job.
 *
 * **Six tabs at 390 is 65px each, measured rather than hoped.** Headless Edge over the built
 * stylesheet, 2026-08-29: each tab draws 65 × 52 and every one of the six labels fits inside it
 * at `text-xs` — `Collection`, the longest, is 54.98px, with ten of slack. 65 × 52 clears
 * `--target-min` (44) in both directions. The bar is 53px tall including its hairline, before
 * `--safe-b`, which is `0px` on every desktop and on this page.
 *
 * **`dragging` draws the two entries a card can land on**, using the shipped `DROP_RING` rather
 * than a colour typed here. No story on this page drags anything — the round forbids `play`
 * functions — so this is a control, not a demonstration: flip it to see whether a six-across bar
 * can still say *which two of us will take this* while a card is in the air. What it cannot show
 * is that the drop works, and the write-up does not claim it.
 */
function R2({ dragging }: { dragging: boolean }) {
  // The write comes **before** the two reads, which is `AppShell.stories.tsx`'s order and not a
  // style: zustand notifies its subscribers synchronously, so a selector that has already
  // subscribed when the initializer runs is a store written during another component's render.
  useState(() => useAppStore.getState().setActiveView("collection"));
  const activeView = useAppStore((s) => s.activeView);
  const setActiveView = useAppStore((s) => s.setActiveView);
  const title = NAV_COPY.find((n) => n.id === activeView)?.label ?? "";

  return (
    // `h-full` rather than `h-dvh`: this column is drawn by the story, so it is as tall as the
    // phone frame it was handed. `AppShell`'s own root is `h-dvh` and R1 shows what that costs.
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-bg text-text">
      <Ribbon
        title={title}
        statusLine={IDLE_LINE}
        dataDir={STATUS.dataDir}
        busy={false}
        upToDate={false}
        hasError={false}
        onRefresh={() => {}}
        activity={null}
        activityVisible={false}
      />
      {/* `AppShell.tsx`'s own class string for `main`, copied rather than approximated — this is
          the app's only scroller and its `p-5` is 40px of a 390px window, which is a number both
          this round and Round 2 argue from. A story that drew its own padding would be comparing
          three options against a fourth thing. */}
      <main className="relative min-h-0 flex-1 overflow-auto p-5">
        <Wall note="No rail: the wall is the window less main's p-5. The bar spends 53px of height instead." />
      </main>
      <nav
        aria-label="Views"
        className="flex shrink-0 border-t border-border bg-surface"
        // `--safe-b` rather than a number, and this is the one edge in the app that has ever
        // needed it: a bar anchored to the window's bottom sits under the home indicator without
        // it. `0px` everywhere `viewport-fit=cover` has not resolved, so this costs nothing here.
        style={{ paddingBottom: "var(--safe-b)" }}
      >
        {NAV_COPY.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setActiveView(id)}
            aria-current={id === activeView ? "page" : undefined}
            className={cn(
              "flex min-w-0 flex-1 flex-col items-center justify-center gap-1 py-2",
              PRESS,
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent",
              id === activeView ? "text-accent" : "text-dim",
              dragging && DROPPABLE.has(id) && DROP_RING,
            )}
            // The floor Task 3 set, read as the custom property rather than as `44px` typed
            // again. Measured at 65 × 52 here, so it is a fence rather than the thing deciding
            // the size.
            style={{ minWidth: "var(--target-min)", minHeight: "var(--target-min)" }}
          >
            <Icon className="size-5 shrink-0" aria-hidden="true" />
            <span className="w-full truncate text-center text-xs leading-none">{label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

/* ------------------------------------------------------------------------------ R3 ------- */

/**
 * **R3 — a drawer behind the ribbon.** The rail becomes an off-canvas sheet; the wall gets
 * everything.
 *
 * **The trigger is drawn beside the ribbon rather than inside it, and that is the option's
 * price made visible.** `RibbonProps` has ten members and not one of them is a slot, a child or
 * an `onOpenNav`; the row is `<h1>` then an `ml-auto` group and nothing may be put in front of
 * it. So this frame puts a 44px button in a flex row to the ribbon's left — which is the only
 * arrangement the shipped component permits, and it **insets the mana line by 44px**. Look at
 * where the 2px rule starts. A signature that stops 44px short of the window's edge is no longer
 * marking the app's edge; the constraint this round was handed says a signature that *grows*
 * with its frame is a border, and this is the same sentence read from the other end. R3 is
 * therefore not a layout that can be built out of what exists — it needs a `Ribbon` prop, and
 * the prop is cheap. What is not cheap is the arithmetic below.
 *
 * **The title has nowhere to go.** At the full 390 the `<h1>` already gets 78px of the 125.75 it
 * needs for `Collection` — measured, headless Edge over the built stylesheet, 2026-08-29 — and a
 * 44px trigger plus a gap takes most of what is left. Cinzel may not go below 18px, so the title
 * does not shrink to fit: it stays or it goes.
 *
 * **The sheet is `absolute`, not `fixed`.** A `fixed` scrim inside a boxed story covers the docs
 * iframe rather than the phone frame, so the whole option would be a picture of the wrong box —
 * which is also the reason the root here is `relative`. In the app it would be a `Dialog`, and
 * `src/CLAUDE.md`'s rule is what makes that a real question: a *consulted* surface is a modal and
 * a surface *worked out of* earns a place in the layout. Navigation is neither — it is where the
 * reader is standing — so R3 has to argue that case rather than inherit it. `LAYER.overlay` is
 * the rung `Dialog` uses, taken from `layers.ts` rather than typed as a number.
 *
 * **There is no motion preset for this.** `motion.ts` had `drawerRight` and it was deleted on
 * 2026-08-14 when the editor's two drawers became centred modals; the four tiers that remain are
 * `instant`/`fast`/`base`/`slow`, and a sheet that *travels* belongs on one of the top three. So
 * the sheet here is static: an animation invented in a story is a timing nobody decided.
 */
function R3({ open }: { open: boolean }) {
  // Written before it is read — see `R2`.
  useState(() => useAppStore.getState().setActiveView("collection"));
  const activeView = useAppStore((s) => s.activeView);
  const setActiveView = useAppStore((s) => s.setActiveView);
  const [shown, setShown] = useState(open);
  const title = NAV_COPY.find((n) => n.id === activeView)?.label ?? "";

  return (
    <div className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-bg text-text">
      <div className="flex shrink-0 items-stretch bg-surface">
        <button
          type="button"
          onClick={() => setShown(true)}
          aria-label="Open navigation"
          aria-expanded={shown}
          className={cn(
            "flex shrink-0 items-center justify-center text-dim",
            PRESS,
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent",
          )}
          style={{ width: "var(--target-min)" }}
        >
          <Menu className="size-5" aria-hidden="true" />
        </button>
        <div className="min-w-0 flex-1">
          <Ribbon
            title={title}
            statusLine={IDLE_LINE}
            dataDir={STATUS.dataDir}
            busy={false}
            upToDate={false}
            hasError={false}
            onRefresh={() => {}}
            activity={null}
            activityVisible={false}
          />
        </div>
      </div>

      <main className="relative min-h-0 flex-1 overflow-auto p-5">
        <Wall note="The most wall of the three, and every trip to another view is a tap and a wait." />
      </main>

      {shown && (
        <>
          {/* Two elements, as `Dialog` draws them: the scrim takes the press that closes, the
              sheet sits on top of it. Both `absolute` — see the component comment. */}
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => setShown(false)}
            className={cn("absolute inset-0 bg-bg/75", LAYER.overlay)}
          />
          <div
            className={cn(
              "absolute inset-y-0 left-0 flex w-52 flex-col gap-1.5 border-r border-border bg-surface p-3",
              LAYER.overlay,
            )}
          >
            {/* `w-52` is the shipped rail's own width, so the sheet is the rail lifted out of
                the layout rather than a new column with a new measurement. It is 208 of 390 —
                53% of the window — which is what an open drawer costs while it is open. */}
            <div className="flex items-center justify-between pb-1">
              <span className="px-3 text-xs text-dim">Views</span>
              <button
                type="button"
                onClick={() => setShown(false)}
                aria-label="Close navigation"
                className={cn(
                  "flex items-center justify-center rounded-md text-dim",
                  PRESS,
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                )}
                style={{ width: "var(--target-min)", height: "var(--target-min)" }}
              >
                <X className="size-5" aria-hidden="true" />
              </button>
            </div>
            {NAV_COPY.map(({ id, label, Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => {
                  setActiveView(id);
                  setShown(false);
                }}
                aria-current={id === activeView ? "page" : undefined}
                className={cn(
                  "flex items-center gap-3 rounded-md px-3 text-base",
                  PRESS,
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                  id === activeView ? "bg-bg text-accent" : "text-text",
                )}
                // The shipped entry is 44px tall and `--target-min` is 44px: the rail already
                // meets the floor Task 3 wrote down, which is the one thing about it that a
                // phone does not change.
                style={{ minHeight: "var(--target-min)" }}
              >
                <Icon className="size-5 shrink-0" aria-hidden="true" />
                {label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/* --------------------------------------------------------------------------- the round --- */

/** Which of the three arrangements the frame draws. */
type OptionId = "R1" | "R2" | "R3";

function MobileChrome({
  option,
  dragging = false,
  drawerOpen = true,
}: {
  option: OptionId;
  /** R2 only: draw the two entries a card can land on as they would be mid-drag. */
  dragging?: boolean;
  /** R3 only: the sheet is out. */
  drawerOpen?: boolean;
}) {
  if (option === "R1") return <R1 />;
  if (option === "R2") return <R2 dragging={dragging} />;
  return <R3 open={drawerOpen} />;
}

const meta = {
  title: "Mobile/Chrome",
  component: MobileChrome,
  tags: ["autodocs"],
  args: { option: "R1", dragging: false, drawerOpen: true },
  // All three write `activeView` in a lazy initializer, so changing an arg has to remount rather
  // than write to a store that is already being observed — `AppShell.stories.tsx`'s rule, for
  // the same singleton.
  render: (args) => <MobileChrome key={`${args.option}:${args.drawerOpen}`} {...args} />,
  decorators: [phone],
  parameters: {
    docs: {
      /**
       * **Each option gets its own frame, and `useAppStore` is why.**
       *
       * All three stories write `activeView` during render, and the store is a module singleton
       * `.storybook/` cannot make per-story (`.storybook/CLAUDE.md`). Inline, an autodocs page
       * mounts every story at once and the last to render owns the store for all of them — three
       * options under three headings, all showing one.
       *
       * **The height is a guess, and it is the one thing on this page nobody has checked.** The
       * Storybook lock belongs to the controller of this round, so no build of this page has been
       * opened. 884 is the frame's 844 plus the 40 of docs chrome `AppShell.stories.tsx` measured
       * for its own 800px box; if the frame reads short, this is the number to move.
       *
       * **`AppShell`'s root is `h-dvh`, which in a boxed story is the *iframe*'s height and not
       * the box's** — so R1's shell is as tall as this parameter says and the 844px frame clips
       * whatever hangs below, the rail's Collapse control first. R2 and R3 are drawn by this file
       * and use `h-full`, so they end exactly at 844. The three frames are still the same 390 ×
       * 844 window; what differs is whether the option's own root knows it.
       */
      story: { inline: false, height: "884px" },
      description: {
        component:
          "**Round 1 of the phone design round: the ribbon and the rail.** Three arrangements " +
          "of the app's chrome at 390 × 844, built on the real components, to be deleted once " +
          "the decision is taken — the wireframes in " +
          "`docs/superpowers/specs/2026-08-28-mobile-layout-options.md` are what survives.\n\n" +
          "**`TitleBar` is absent from all three, and that is the platform rather than an " +
          "omission.** Parity §5 gives the frame to the browser and to Android, so on a phone " +
          "the chrome is the ribbon and the rail and the caption's 34px comes back.\n\n" +
          "**Every number in these frames was measured, not estimated.** Headless Edge over " +
          "`dist/assets/index-HbsLLTR6.css` on 2026-08-29, with Cinzel and Geist really " +
          "loaded: the ribbon block is 58px (a 56px row and the 2px mana line); `Refresh data` " +
          "draws **150.91 × 42**; and at the full 390 the `<h1>` gets **78px** of the **125.75** " +
          "`Collection` needs while the status line gets **89** of **243.95**. With R1's rail " +
          "there it is 62 and 37. **No option puts that sentence on this row**, which is the " +
          "finding the round turns on rather than a detail of one of them.\n\n" +
          "**What no story here can prove.** There are no `play` functions, so nothing drags: " +
          "the rail is a drop target from every view (`useSidebarDrops`) and each option's " +
          "answer to *where does that drop go* is argued in the write-up and drawn nowhere. " +
          "And a green Storybook says nothing about the shipped window — these are 390px boxes " +
          "in a desktop browser, with no coarse pointer, no URL bar and `--safe-b` at `0px`.",
      },
    },
  },
} satisfies Meta<typeof MobileChrome>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * **R1 — the rail holds, the ribbon sheds.** The shipped app at 390, with the collapsed rail
 * forced rather than merely defaulted to.
 *
 * The cheapest of the three by a wide margin, and this frame is the proof: it is the real
 * `AppShell`, so `useNavCollapsed`, `useNavLabels`, `useSidebarDrops` and every `NavItem` are
 * untouched. The rail's entries are already 44px tall and already meet `--target-min`.
 *
 * What it costs is 68 of 390 on every screen — the wall measures **282px**, where the other two
 * measure 350 — and it puts navigation in the top-left, which is the corner a thumb reaches
 * last. The number that decides whether that matters belongs to Round 2 and the frame prints it:
 * `columnsFor` floors at one column at 170px either way, but at a 160px tile 350 gives two and
 * 282 gives one. **The rail is worth a column.**
 */
export const RailHolds: Story = { args: { option: "R1" } };

/**
 * **R2 — a bottom tab bar.** The six destinations in the thumb zone, the rail gone, the ribbon
 * one title row.
 *
 * Buys the wall its full 350px and spends 53px of height on the bar — a trade of 68 horizontal
 * for 53 vertical, which on a wall of 5:7 cards is not the even swap it sounds like. Six tabs at
 * 65 × 52 hold every label at 12px with ten pixels of slack, so the bar is legible at six entries
 * rather than merely possible.
 *
 * `useSidebarDrops` is the hook that survives this move and `NavItem` is the component that does
 * not: the drop *policy* is exported and reusable, the drawing of an entry is private to
 * `AppShell.tsx`. Flip `dragging` in the controls to see the shipped `DROP_RING` on the two
 * entries that would take a card.
 */
export const BottomTabBar: Story = { args: { option: "R2", dragging: false } };

/**
 * **R3 — a drawer behind the ribbon.** The most room for card art, and the most taps.
 *
 * Drawn with the sheet **out**, over a wall that is visibly the full 350 behind it, because both
 * halves of the option have to be judged at once: what it gives the art, and what it takes from
 * every trip between views. Closed, this frame is R2 without the bar — 350 × 746, the largest
 * wall any option here offers.
 *
 * Two things to look at. The 2px mana line **starts 44px in**, because `RibbonProps` has no slot
 * for a trigger and the story could only put one beside the row; that inset is the option asking
 * for a prop. And the open sheet is `w-52` — the rail's own 208px, **53% of the window** — which
 * is the honest width for it, since a narrower sheet would be a new measurement invented for one
 * surface.
 */
export const DrawerBehindRibbon: Story = { args: { option: "R3", drawerOpen: true } };
