import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { cardDraggable } from "@/features/decks/dnd";
import { SettingsPage } from "@/features/settings/SettingsPage";
import { useAppStore, type ViewId } from "@/lib/store";
import { useUpdate } from "@/lib/useUpdate";
import { emitFake } from "../../.storybook/fake/event";
import { printing } from "../../.storybook/fake/fixtures";
import { AppShell, DROP_OVER, DROP_RING } from "./AppShell";

/**
 * What the app puts inside the shell, reduced to a label.
 *
 * `App.tsx:15`'s `ActiveView` picks one of five real views out of the store, and four of them
 * are another file's to story — `SearchPage`, `CollectionPage` and `WishlistPage` have their
 * own. What this file is about is the frame: the sidebar, the ribbon, the banner, the overlay
 * and the two entries a card can be dropped on. A dashed box says which view *would* be here
 * without pulling three connected pages into a story about their container.
 *
 * **Settings is the one exception, and it is not an inconsistency.** That view is the *other*
 * half of the thing this shell owns: `App.tsx` calls `useUpdate` once and hands the result to
 * both `AppShell` (for the ribbon's button) and `SettingsPage` (for the panel), because two
 * calls would be two `update:progress` listeners racing to describe one download. A stand-in
 * there would hide the only arrangement in the app where one hook feeds two surfaces — so
 * {@link Shell} mirrors `App.tsx` exactly and lets the real page be the child.
 */
function ViewStandIn({ view }: { view: ViewId }) {
  return (
    <div className="grid h-full place-items-center rounded-lg border border-dashed border-border text-sm text-dim">
      the {view} view
    </div>
  );
}

/**
 * The shell, with the store put where a story wants it.
 *
 * **The two writes are in this order because the first one undoes the second.**
 * `setActiveView` clears `openDeckId` (`store.ts:115`) — leaving the Decks view closes the
 * editor, and a deck left open through a trip to Settings would be waiting behind the sidebar
 * with the gallery it was opened from nowhere in sight. So a story that opened a deck and then
 * chose a view would get no deck, which is the whole subject of
 * {@link DecksDropTargetInert}.
 *
 * Written through the store's own actions rather than one `setState`, for the same reason: the
 * clearing rule is the thing being demonstrated, and a story that reached past it could stage a
 * combination the app cannot produce.
 *
 * **Written during render and not from an effect**, which is `preview.tsx`'s own choice for
 * `installWorld` and the same reasoning: an effect runs after the first paint, so the shell
 * would render the Search view for one frame before every story on this page. `useState`'s lazy
 * initializer rather than `useMemo`, because that is the hook that means "once, on mount" —
 * `react-hooks/void-use-memo` refuses a `useMemo` with nothing to cache, and it is right to. The
 * meta keys its render on the pair below, so changing either in Controls remounts and this runs
 * again rather than writing to the store under a live subscriber.
 *
 * **One `useUpdate`, passed to two places**, which is `App.tsx:58`'s arrangement copied rather
 * than approximated. `AppShell` takes it as a prop now, and so does `SettingsPage`; the hook
 * registers the app's single `update:progress` listener and polls `update_status`, so a second
 * call would be a second subscription describing the same download. Everything the ribbon's
 * gold button says — whether it appears, which of its two labels it wears — is derived from
 * this one value against the seeded world.
 */
function Shell({
  view,
  deckId = null,
  children,
}: {
  view: ViewId;
  /** A deck open in the editor. Only ever meaningful with `view: "decks"`. */
  deckId?: number | null;
  children?: ReactNode;
}) {
  useState(() => {
    const store = useAppStore.getState();
    store.setActiveView(view);
    if (deckId !== null) store.setOpenDeckId(deckId);
  });
  const update = useUpdate();
  // **The store, not the `view` arg**, which is `App.tsx:16`'s own choice: `ActiveView`
  // subscribes, so the body follows every way the view can change — a sidebar entry, and the
  // ribbon's update button. Pinned to the arg instead, a story that pressed either would show
  // the frame renaming itself over a body that had not moved, which is a bug this component
  // does not have.
  const activeView = useAppStore((s) => s.activeView);
  return (
    <AppShell update={update}>
      {children ??
        (activeView === "settings" ? (
          <SettingsPage update={update} />
        ) : (
          <ViewStandIn view={activeView} />
        ))}
    </AppShell>
  );
}

/** Lightning Bolt's Alpha printing — a card that is really in the seeded database, so the wish
 *  a drop writes is a wish for a printing the wishlist can resolve. */
const BOLT = printing("lea", "161");

/**
 * A card that can be picked up, registered exactly the way the app's four card surfaces
 * register one.
 *
 * `cardDraggable` with a `{ kind: "card" }` payload is what the search tiles, the collection
 * table's rows, the pinned wishes and the card pane's printings rows all use, so a drag started
 * here crosses the same `readDragData` boundary a real one does.
 */
function CardSource() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    return cardDraggable({
      element,
      payload: () => ({
        kind: "card",
        cardId: BOLT.id,
        name: BOLT.name,
        // What files the card when the Decks entry takes it: there is no column on a nav item
        // to have pointed at, so `autoCategoryFor` reads this (`dnd.ts`).
        typeLine: BOLT.typeLine,
      }),
    });
  }, []);
  return (
    <div
      ref={ref}
      className="inline-block cursor-grab rounded-md border border-border bg-surface px-3 py-2 text-sm"
    >
      {BOLT.name}
    </div>
  );
}

/* ------------------------------------------------------------------- a real drag ------- */

/**
 * The platform's drag clipboard, in the only shape this app's drags need.
 *
 * **`src/test-drag.ts` is the same thing and cannot be imported here.** That module registers an
 * `afterEach` from `vitest` at import time and pulls in `@testing-library/react`, so importing
 * it would put a test runner into the Storybook browser bundle and throw outside Vitest. What is
 * copied is the minimum: the app's own payload never travels in this object — it lives in
 * pragmatic-drag-and-drop's store, keyed off the draggable's `getInitialData` — so only the
 * methods the library itself calls need to exist.
 *
 * This works in jsdom *and* in a real browser for the same reason it works in the suite: the
 * library hit-tests with `event.target` and `Element.closest`, never with `elementFromPoint`,
 * and listens for the platform's own drag events on `document` and `window`. A synthetic
 * `MouseEvent` with a `dataTransfer` bolted on is what the platform's drag event really is.
 *
 * What it still does not reach — and what a live pass therefore owes — is the platform's own
 * drag preview, the pointer-driven hit-testing that decides which element a `dragover` lands on,
 * and auto-scrolling, all three of which measure rectangles.
 */
class StoryDataTransfer {
  private store = new Map<string, string>();
  effectAllowed = "uninitialized";
  dropEffect = "none";
  get types(): string[] {
    return [...this.store.keys()];
  }
  setData(format: string, data: string): void {
    this.store.set(format, data);
  }
  getData(format: string): string {
    return this.store.get(format) ?? "";
  }
  clearData(): void {
    this.store.clear();
  }
  setDragImage(): void {}
  items = { add: () => {} };
}

function send(target: Element, type: string, dataTransfer: StoryDataTransfer): void {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 8, clientY: 8 });
  // Not a `MouseEvent` field, and read-only where it does exist.
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  target.dispatchEvent(event);
}

/**
 * One frame, so the library's `requestAnimationFrame`-scheduled `onDragStart` has landed before
 * the next assertion reads the DOM — it batches that with the drag preview.
 *
 * **Necessary and not sufficient, and every assertion that reads a drag's result must therefore
 * go through `waitFor`.** The library schedules its drop-target change on a frame; React's
 * commit of the state that change sets is a *second* hop, and {@link send} dispatches outside
 * `act`, so nothing forces the two into one tick. Under a loaded suite they routinely are not:
 * measured 2026-08-09, the bare `toHaveClass(DROP_OVER)` that used to follow `over()` failed
 * **5 of 10** runs of this file alone, and passed **10 of 10** wrapped.
 */
const frame = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });

/**
 * Pick a card up. **Every drag started here must be finished, and a `finally` is what finishes
 * it** — the library keeps one global "a drag is active" flag, and a story that walked away
 * holding a card leaves the next one unable to pick one up. That is not a hypothetical: it is
 * the second half of the flake this file used to have. A failed assertion mid-drag threw past
 * the `cancel` below, and `DecksDropTargetInert` — the next story on the page — then failed on
 * a ring that never lit, which is how **one** broken assertion reported **two** failures
 * (measured 2026-08-09: 5 of 10 runs red, every one of them `2 failed`, never `1`).
 *
 * So every `play` here holds its drag inside `try { … } finally { await held.cancel(); }`.
 * {@link cancel} is idempotent by construction — the library binds its `dragend` handling for
 * the life of one drag and unbinds on the first one — so the stories that end in a real
 * {@link drop} pay a no-op for the same guarantee.
 */
async function pickUp(source: Element) {
  const data = new StoryDataTransfer();
  send(source, "mousedown", data);
  send(source, "dragstart", data);
  await frame();
  return {
    over: async (target: Element) => {
      send(target, "dragenter", data);
      send(target, "dragover", data);
      await frame();
    },
    drop: async (target: Element) => {
      send(target, "drop", data);
      send(source, "dragend", data);
      await frame();
    },
    /** How a real drag ends when the reader presses Escape or lets go over nothing. */
    cancel: async () => {
      send(source, "dragend", data);
      await frame();
    },
  };
}

const meta = {
  title: "Chrome/AppShell",
  component: Shell,
  tags: ["autodocs"],
  args: { view: "search" },
  render: (args) => <Shell key={`${args.view}:${args.deckId}`} {...args} />,
  decorators: [
    // The shell is `h-screen`, and in a docs page that is the *docs* page's screen. A fixed box
    // gives each story its own window; 1280×800 is what `tauri.conf.json:16-17` opens.
    (Story) => (
      <div className="h-[800px] w-[1280px] overflow-hidden">
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      /**
       * **Each story on this page gets its own frame**, which is the one thing that gives it its
       * own `useAppStore`.
       *
       * Every story in this file writes `activeView` (and `openDeckId`) during render, and the
       * store is a module singleton that `.storybook/` cannot make per-story: zustand's `create`
       * does not expose the initializer it was given, and the store's actions close over that one
       * store's `set`, so a second instance of it would take an edit to `src/lib/store.ts`.
       * Inline, an autodocs page mounts every story at once and the last one to render would own
       * the store for all of them — every story below showing the same view, the same card, the
       * same layout, and reading as a component that ignores its arguments.
       *
       * The fake **backend** needs none of this — a world is per story in-process now
       * (`.storybook/fake/scope.ts`), and 43 of the 51 story files still render inline. This is
       * the four that touch the one global left over.
       *
       * The height is the frame's, not a minimum: `inline: false` makes `height` the iframe's
       * actual height (`@storybook/addon-docs`'s `StoryBlockParameters`), so it is this file's
       * own decorator box plus room for the chrome around it.
       */
      story: { inline: false, height: "840px" },
      description: {
        component:
          "The window: sidebar, ribbon, and whatever view the store points at. It owns the " +
          "sync status because everything that needs it lives here — the ribbon's summary " +
          "line, its Refresh button and mana line, the first-run overlay and the error banner " +
          "— and one poll for the whole app is the point of the arrangement.\n\n" +
          "**This is the one component in the chrome that a seeded world really drives.** " +
          "`Ribbon` and `SyncProgress` take everything as props; this polls `sync_status`, " +
          "registers the app's single `sync:progress` listener, and reads and writes the " +
          "collection through the sidebar's drop targets. So the stories below choose a `seed` " +
          "and a `fault` rather than arguments.\n\n" +
          "**It owns the update the same way it owns the sync**, one step removed: `App.tsx` " +
          "calls `useUpdate` and hands the answer both to this shell — which draws the ribbon's " +
          "gold button from it — and to `SettingsPage`, which draws the panel. One hook, " +
          "because two would be two `update:progress` listeners describing one download. The " +
          "wrapper below copies that arrangement, so `updateAvailable` is a world rather than " +
          "an argument here.\n\n" +
          "**Two things the fake world cannot show, and they are the same thing twice: work in " +
          "flight.** `sync_status` answers `syncing: false` always and `sync_run` resolves at " +
          "once; `update_status` answers `busy: false` always and `update_download` is " +
          "synchronous. So neither the mana line's fill, nor the first-run progress bar, nor " +
          "the update's download bar can be reached from here. All three are storied where they " +
          "are arguments — `Chrome/Ribbon`, `Chrome/SyncProgress`, `Primitives/ManaLine` and " +
          "`Settings/UpdatePanel`.\n\n" +
          "The children are a dashed stand-in on every story but Settings, which is the one " +
          "view that is *about* something the shell holds. `App.tsx` puts one of five real " +
          "views there and the other four have story files of their own; what this page is " +
          "about is the frame around them.",
      },
    },
  },
} satisfies Meta<typeof Shell>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The view the app opens on.
 *
 * The active entry is marked three ways and only one of them is colour: gold text, a `bg-bg`
 * surface, and a 2px gold hairline down its left edge. It is a hairline rather than a filled
 * pill because the sidebar is chrome, and chrome does not get to be the loudest thing on a
 * screen that is about to be full of card art.
 *
 * `aria-current="page"` is the fourth mark and the only one a screen reader has.
 */
export const Search: Story = {
  args: { view: "search" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: "Search" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(canvas.getByRole("button", { name: "Collection" })).not.toHaveAttribute(
      "aria-current",
    );
    // The ribbon's `h1` is the view's name, from the same `NAV` table the sidebar is drawn
    // from — one list, so the two can never disagree about what a view is called.
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent("Search");
  },
};

export const Collection: Story = { args: { view: "collection" } };

export const Wishlist: Story = { args: { view: "wishlist" } };

/** The gallery state of the Decks view — no deck open, which is also the state that makes the
 *  sidebar's Decks entry inert for every drag started anywhere else. */
export const Decks: Story = { args: { view: "decks" } };

/**
 * The one story whose child is a **real view**, because Settings is where the other half of
 * `update` comes out.
 *
 * `App.tsx:58` calls `useUpdate` once and gives it to the shell and to this page; {@link Shell}
 * does the same. So what is on screen here is one hook's answer rendered twice — and in the
 * default world that answer is "you are on the latest version", which is why the ribbon is
 * quiet. {@link UpdateAvailable} is the other side of it.
 *
 * The check the panel reports was not made by this window: the fake's `lastCheckAt` is
 * `db.ts`'s `CLOCK_BASE`, the same fixed instant `sync_status` reports, so the line under the
 * version is `formatChecked`'s answer for a check made at a fixed date against a moving clock.
 * Nothing here asserts its wording — the panel's own stories pin that against an offset from
 * `Date.now()`, which is the only way that line is stable.
 */
export const Settings: Story = {
  args: { view: "settings" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The world's `update_latest_seen` is the release of the version it is running, so
    // `available` is derived to null and the panel says so. Nothing was hard-coded to say it:
    // `db.ts`'s `isNewer` compared two strings.
    await expect(await canvas.findByText(/You’re on the latest version\./)).toBeInTheDocument();
    // And the ribbon's gold button is the same fact from the other side — absent, so asserted.
    await expect(canvas.queryByRole("button", { name: /^Update to/ })).toBeNull();
  },
};

/**
 * A release published since the last check, as the whole window reports it.
 *
 * **The gold button is the only thing in the ribbon that is not about the card database**, and
 * it is before the status line and Refresh because it is the rarer and more consequential thing
 * on the row. It borrows the accent the mana line two pixels below already owns rather than
 * inventing a colour for one button.
 *
 * Pressing it does not update anything: it opens Settings, where the release notes and the
 * actual controls are (`AppShell.tsx:125` — `onOpenUpdate` is `setActiveView("settings")` and
 * nothing else). That is the claim this story exists for, because it is wiring no other story
 * in the catalogue has: `Chrome/Ribbon` takes `onOpenUpdate` as a prop, and `Settings/Page`
 * never sees the ribbon.
 *
 * The label is `Update to 0.4.0` rather than `0.4.0 available` because the seeded install kind
 * is `portable`, which `pick_asset` finds an asset for — a control says exactly what happens
 * when it is used, and an MSI install would get the other label.
 */
export const UpdateAvailable: Story = {
  args: { view: "search" },
  parameters: { fake: { fault: "updateAvailable" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const button = await canvas.findByRole("button", { name: "Update to 0.4.0" });

    await userEvent.click(button);

    await waitFor(async () => {
      await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent("Settings");
    });
    // The sidebar agrees, which is the half a screen reader gets: one `NAV` table draws both,
    // so a view that moved without its entry moving would be two lists disagreeing.
    await expect(canvas.getByRole("button", { name: "Settings" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    // And the page that opened is the real one, with the release the ribbon was pointing at.
    await expect(await canvas.findByText("0.4.0")).toBeInTheDocument();
  },
};

/**
 * A sync that failed, as the shell reports it: one `role="alert"` band under the ribbon.
 *
 * The sentence comes from `sync_status.lastError`, which is where a failure survives long after
 * its event was dropped — and the ribbon reads the same fact as `hasError` and goes quiet with
 * it rather than drawing a second, cheerful line beside a red one.
 *
 * The banner is the app's **one** alert. `SyncProgress` deliberately renders the same string as
 * plain text, because two live regions saying one thing is one thing said twice.
 */
export const SyncFailed: Story = {
  args: { view: "search" },
  parameters: { fake: { fault: "syncError" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const alert = await canvas.findByRole("alert");
    await expect(alert).toHaveTextContent("rate limited by Scryfall; retry after 30s");
    // The view underneath is untouched: a failed sync is news, not a broken app.
    await expect(canvas.getByRole("button", { name: "Refresh data" })).toBeEnabled();
  },
};

/**
 * An empty database: the first-run overlay takes the whole window, ribbon included.
 *
 * `seed: "empty"` is the only seed whose `cards` table is empty, so `sync_status` answers a
 * `cardCount` of exactly `0` — which is the one value that means "nothing has been synced yet"
 * rather than "the count could not be read".
 *
 * Nothing is running here and nothing has been said, because the fake's `sync_run` is never in
 * flight, so what shows is the recovery branch: the sentence, and the Retry the overlay carries
 * *because* it covers the ribbon's own Refresh button. That is the same screen a run throttled
 * by the 24 h check window produces in the real app, which is storied as `Chrome/SyncProgress`'s
 * `Throttled`.
 */
export const FirstRun: Story = {
  args: { view: "search" },
  parameters: { fake: { seed: "empty" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("dialog")).toHaveTextContent(
      "Setting up your card database",
    );
    // Not `aria-modal`: the app behind is not inert, and claiming otherwise would hide a
    // perfectly reachable window from assistive technology.
    await expect(canvas.getByRole("dialog")).not.toHaveAttribute("aria-modal");
    await expect(canvas.getByRole("button", { name: "Retry download" })).toBeEnabled();
    // The ribbon is still mounted underneath, which is exactly why the overlay needs a Retry of
    // its own: this button is on screen and unreachable.
    await expect(canvas.getByRole("button", { name: "Refresh data" })).toBeInTheDocument();
  },
};

/**
 * The same first run, with a failure arriving as a **live `sync:progress` event**.
 *
 * This is the one story on this page that emits one, and the only place in the chrome where
 * emitting is worth anything: `AppShell` owns the app's single `listen` registration
 * (`useSyncProgress`), and both other components in this tier take the event as a prop. The
 * event outranks `busy` — the status poll is up to a second behind it, and a failure must not
 * sit hidden behind a progress bar for that second — so the overlay's message becomes the
 * event's.
 *
 * `emitFake` reaches the component because `.storybook/main.ts` aliases `@tauri-apps/api/event`
 * to the same module this file imports from, so there is one listener map. Nothing queues in it,
 * which matches the real thing: Tauri drops events emitted before the webview registered its
 * listener, and a run inside the 24 h window emits none at all.
 */
export const FirstRunFailedMidRun: Story = {
  args: { view: "search" },
  parameters: { fake: { seed: "empty" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("dialog");

    emitFake("sync:progress", {
      phase: "error",
      done: 0,
      total: 0,
      message: "no internet connection",
    });

    await waitFor(async () => {
      await expect(canvas.getByText("no internet connection")).toBeInTheDocument();
    });
  },
};

/**
 * A card in the air with a deck open: both drop targets light up, and one of them is washed.
 *
 * Two marks, two questions. The **ring** is 2px of gold around every entry that could take the
 * card, and it stands for as long as the card is in the air — the app's existing vocabulary
 * rather than a new one, and deliberately the same ring as the keyboard's focus mark, because a
 * drop target lighting up and a control being reachable are the same claim made to two different
 * hands. The **wash** is which of the ringed pair is about to take it, drawn from the target's
 * own `onDragEnter` because `:hover` does not update during a drag — the pointer is holding
 * something.
 *
 * The Collection is not a target and never rings: `collection_add` carries a finish, a condition
 * and a language that a drop cannot answer, and a drop that invented "NM nonfoil" would write
 * facts the reader never said.
 */
export const DropTargetsLive: Story = {
  args: { view: "decks", deckId: 1, children: <CardSource /> },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const decks = canvas.getByRole("button", { name: "Decks" });
    const wishlist = canvas.getByRole("button", { name: "Wishlist" });

    const held = await pickUp(canvas.getByText("Lightning Bolt"));
    try {
      await waitFor(async () => {
        await expect(decks).toHaveClass(DROP_RING);
      });
      await expect(wishlist).toHaveClass(DROP_RING);
      await expect(canvas.getByRole("button", { name: "Collection" })).not.toHaveClass(
        "ring-accent",
      );

      await held.over(decks);
      // The positive claim is the one that waits; the negative is read *after* it resolves, on a
      // DOM that has already committed the change. A `not.` inside a `waitFor` would pass on its
      // first attempt against a DOM where nothing had happened yet — which is a green assertion
      // about the past.
      await waitFor(async () => {
        await expect(decks).toHaveClass(DROP_OVER);
      });
      await expect(wishlist).not.toHaveClass(DROP_OVER);

      // Let go over nothing, which is how a cancelled drag ends, and the ring stands down without
      // anything here hearing a keypress. Waiting for a class to *leave* is the one negative that
      // belongs in a `waitFor`: the thing it is waiting on is the removal itself.
      await held.cancel();
      await waitFor(async () => {
        await expect(decks).not.toHaveClass("ring-accent");
      });
    } finally {
      await held.cancel();
    }
  },
};

/**
 * The same drag with **no deck open** — which is every drag started from Search, Collection or
 * Wishlist, because `setActiveView` clears `openDeckId`.
 *
 * So the Decks entry is inert for all of them, and it is reachable at all only from inside the
 * Decks view: the docked search panel, a deck row, the card pane. Wishlist takes a card from
 * anywhere, always — a shopping list needs nothing on screen to be added to.
 *
 * The sentence on the inert entry is a **description, not a tooltip, and the smoke measured
 * which**: a native tooltip needs `:hover`, and Chromium freezes `:hover` at the element a drag
 * started from for the whole drag, so no reader ever sees it. What they get instead is the
 * accname spec's fallback — mid-drag the AX node reads `button "Decks", description "Open a deck
 * to drop cards into it"`. Which makes the `title` below a thing only an assertion can see.
 */
export const DecksDropTargetInert: Story = {
  args: { view: "search", children: <CardSource /> },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const decks = canvas.getByRole("button", { name: "Decks" });

    const held = await pickUp(canvas.getByText("Lightning Bolt"));
    try {
      await waitFor(async () => {
        await expect(canvas.getByRole("button", { name: "Wishlist" })).toHaveClass(DROP_RING);
      });
      await expect(decks).not.toHaveClass("ring-accent");
      await expect(decks).toHaveAttribute("title", "Open a deck to drop cards into it");

      // And it refuses the card as well as declining to advertise for it: `canDrop` asks the same
      // question the ring does, so a drop here writes nothing and says nothing.
      await held.over(decks);
      await held.drop(decks);
      await expect(canvas.queryByText(/Added to/)).toBeNull();
    } finally {
      await held.cancel();
    }
  },
};

/**
 * The drop landing, and the sidebar saying where the card went.
 *
 * The sentence lives in a `role="status"` under the entry, mounted for the life of the sidebar
 * and **empty until there is something to say** — a live region that first appears with its
 * sentence already inside it announces nothing. `sr-only` while empty takes it out of the flow,
 * so the entries below sit where they always do until a card actually lands, and then move for
 * the four seconds the sentence is up.
 *
 * The wish is for the printing that was dragged, pinned, with no finish — the wishlist's own
 * default and the only honest answer a drop has.
 */
export const DroppedOnWishlist: Story = {
  args: { view: "search", children: <CardSource /> },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const wishlist = canvas.getByRole("button", { name: "Wishlist" });

    const held = await pickUp(canvas.getByText("Lightning Bolt"));
    try {
      await held.over(wishlist);
      await held.drop(wishlist);

      await waitFor(async () => {
        await expect(canvas.getByText("Added to wishlist.")).toBeInTheDocument();
      });
    } finally {
      await held.cancel();
    }
  },
};
