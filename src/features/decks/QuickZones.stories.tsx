import { useEffect, useRef, useState } from "react";
import { dndManager } from "@/lib/dndManager";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import type { DeckCategory } from "@/lib/ipc";
import { cardDraggable, type DeckWrite, type DragPayload } from "./dnd";
import { QUICK_ZONE_ATTR, QuickCategoryDialog, QuickZoneBar, QuickZones } from "./QuickZones";

/**
 * The deck a card is being thrown into: the two fixed zones the bar reads, plus a pile of the
 * reader's own so the list is not all seeds.
 */
const CATEGORIES: DeckCategory[] = (
  [
    { id: 1, name: "Main deck", kind: "main" },
    { id: 2, name: "Sideboard", kind: "side" },
    { id: 3, name: "Maybeboard", kind: "maybe" },
    { id: 4, name: "Removal", kind: "main" },
  ] as const
).map((over) => ({
  deckId: 1,
  origin: "user" as const,
  isActive: over.kind !== "maybe",
  sortOrder: over.id,
  cardCount: 0,
  totalPrice: null,
  cardCountAllVariants: 0,
  ...over,
}));

/** A printing off a wall — the search panel's tile, or a row on any of the four card surfaces
 *  outside the editor. Every zone adds it. */
const FROM_A_WALL: DragPayload = {
  kind: "search-card",
  cardId: "c-bolt",
  name: "Lightning Bolt",
  typeLine: "Instant",
};

/** A card already in the deck, picked up off the desk. Every zone *moves* it — and `Auto` cannot
 *  take it at all, because a deck-card payload carries no type line to file by. */
const FROM_THE_DECK: DragPayload = {
  kind: "deck-card",
  finish: null,
  cardId: "c-bolt",
  name: "Lightning Bolt",
  fromCategoryId: 1,
};

const meta = {
  title: "Decks/QuickZones",
  component: QuickZoneBar,
  tags: ["autodocs"],
  args: {
    categories: CATEGORIES,
    payload: FROM_A_WALL,
    onDrop: () => {},
    onNewCategory: () => {},
  },
  decorators: [
    // The bar is `inset-x-0` inside the editor's page scroller, so it is as wide as the deck.
    // A box near that width is what keeps the four boxes reading as a row rather than as four
    // stacked buttons.
    (Story) => (
      <div className="w-[52rem]">
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "The four destinations a card can be thrown at without aiming, drawn across the top " +
          "of the deck for the length of a drag and at no other time. **The remove tray's " +
          "twin**: that tray is `sticky bottom-0` while a card is in the air and this is " +
          "`sticky top-0`, so the two ends of the window are the two things a drag can mean " +
          "without hunting for a column — file it at the top, take it out at the bottom. It " +
          "costs no layout in either state (`h-0 -mb-3` around an absolutely positioned bar), " +
          "because an affordance that pushed every pile down on `dragstart` would move the " +
          "deck at the exact moment the reader was aiming at it. `aria-hidden` like the tray: " +
          "this is chrome for a gesture only a pointer can make, and all four have a click " +
          "path a caret can reach. `QuickZoneBar` is what these stories render — the exported " +
          "`QuickZones` adds the drag monitor and the sticky box, and a story cannot hold a " +
          "drag open past the end of a `play`.",
      },
    },
  },
} satisfies Meta<typeof QuickZoneBar>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * A card arriving from a wall: every zone can take it, and every zone says `+`.
 *
 * `Auto` is the one that names no destination — the pile is decided per card by what the card
 * *does*, which is why it wears a wand rather than the shared glyph.
 */
export const AddingFromAWall: Story = {};

/**
 * A card already in the deck, and the same four boxes mean something else.
 *
 * The glyph is `→` rather than `+`, because none of these is an add — the reference this was
 * drawn from puts a `+` on every zone, which is right for one drag and a lie during the other.
 *
 * **All four are live, `Auto` included** (changed 2026-08-15). It used to grey here, on the
 * argument that a `deck-card` payload carries no type line and so the filing rule had nothing to
 * read — true about the payload and the wrong place to conclude it from, because the editor is
 * holding the row. `Auto` now re-files the card by what it does: the same rule an add goes
 * through, run a second time on a card that is already in the deck.
 */
export const MovingADeckCard: Story = {
  args: { payload: FROM_THE_DECK },
  play: async ({ canvasElement }) => {
    const zone = (label: string) =>
      canvasElement.querySelector<HTMLElement>(`[${QUICK_ZONE_ATTR}="${label}"]`);
    // All four live: `Auto` re-files a card the deck already holds (2026-08-15), where it used
    // to grey and refuse.
    for (const label of ["Auto", "New category", "Maybeboard", "Sideboard"]) {
      await expect(zone(label)).not.toHaveClass("opacity-40");
    }
  },
};

/**
 * The pile a card is already in cannot take it again — dropping a card back where it came from
 * would touch the deck, reallocate and bump `updated_at` to leave the list exactly as it was.
 * The greying is how the bar says so before the reader lets go.
 */
export const AlreadyInThatPile: Story = {
  args: { payload: { ...FROM_THE_DECK, fromCategoryId: 2 } },
  play: async ({ canvasElement }) => {
    const zone = (label: string) =>
      canvasElement.querySelector<HTMLElement>(`[${QUICK_ZONE_ATTR}="${label}"]`);
    await expect(zone("Sideboard")).toHaveClass("opacity-40");
    await expect(zone("Maybeboard")).not.toHaveClass("opacity-40");
  },
};

/**
 * A deck whose fixed zones are named something else.
 *
 * The bar labels a zone with the **pile's own name**, never the fixed word. The four seeded
 * categories cannot be renamed today, so the two agree — but a heading on the desk and a drop
 * target above it reading differently would be two names for one pile, so the name is read from
 * the row rather than written out here.
 */
export const RenamedFixedZones: Story = {
  args: {
    categories: [
      ...CATEGORIES.filter((c) => c.kind !== "side"),
      { ...CATEGORIES[1], name: "On the bench" },
    ],
  },
};

/* ---------------------------------------------------------------- a real drag ------- */

/**
 * A pointer drag, driven from a story.
 *
 * **`src/test-drag.ts` is the same thing and cannot be imported here.** That module registers an
 * `afterEach` from `vitest` at import time and pulls in `@testing-library/react`, so importing it
 * would put a test runner into the Storybook browser bundle and throw outside Vitest. So this is a
 * copy, and it is deliberately the smallest one that drives `@dnd-kit/dom`: a press, two moves
 * past the 5px activation distance, and a release.
 *
 * **Two things it has to do that a browser does for free**, and both are jsdom's doing rather than
 * the library's. jsdom lays nothing out, so an element with no box is given one — only when it has
 * none, so in a real Storybook window every rectangle is the window's own. And dnd-kit recomputes
 * collisions from a reactive effect its `Feedback` plugin drives through WAAPI, which jsdom does
 * not have, so the droppables' shapes and the collision pass are forced by hand after every move.
 *
 * **Every drag started here must be finished, and a `finally` is what finishes it.** The manager
 * has one drag operation and `handlePointerDown` returns early unless it is idle, so a story that
 * walked away holding a card leaves the next one unable to pick anything up. That is not
 * hypothetical: it is the second half of the flake this file used to have, where one broken
 * assertion mid-drag reported as two failures. {@link pickUp}'s `cancel` is Escape at the body and
 * is inert when nothing is in flight, so a story that ends in a real `drop` pays a no-op for the
 * same guarantee.
 */
const frame = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });

/** Somewhere for the next unmeasured element to be. Stacked, so no two ever overlap. */
let unmeasured = 0;

/** Where an element is — and, under jsdom, where it is going to pretend to be. */
function centreOf(element: Element): { x: number; y: number } {
  const box = element.getBoundingClientRect();
  if (box.width > 0 || box.height > 0)
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  const top = (unmeasured += 120);
  element.getBoundingClientRect = () =>
    ({
      x: 0,
      y: top,
      top,
      left: 0,
      right: 200,
      bottom: top + 60,
      width: 200,
      height: 60,
      toJSON: () => ({}),
    }) as DOMRect;
  return { x: 100, y: top + 30 };
}

function firePointer(type: string, at: { x: number; y: number }, target: EventTarget): void {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: at.x,
      clientY: at.y,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      button: 0,
      buttons: type === "pointerup" ? 0 : 1,
    }),
  );
}

/** The collision pass jsdom cannot schedule, plus the measurement it cannot take — **twice**,
 *  because the operation's target follows the collisions one hop behind: the observer's reaction
 *  disables it, calls `setDropTarget`, and re-enables on a promise. */
async function settle(): Promise<void> {
  for (let pass = 0; pass < 2; pass++) {
    await frame();
    for (const droppable of dndManager.registry.droppables) droppable.refreshShape();
    dndManager.collisionObserver.forceUpdate();
    await frame();
  }
}

/** Move the pointer. **Twice per step**, because the operation's own position lags one
 *  `pointermove` behind: the sensor records the coordinates and hands the move to its scheduler. */
async function pointerTo(at: { x: number; y: number }): Promise<void> {
  for (let i = 0; i < 2; i++) {
    firePointer("pointermove", at, document);
    await frame();
  }
  await settle();
}

async function pickUp(source: Element) {
  const start = centreOf(source);
  let at = start;
  firePointer("pointerdown", start, source);
  await pointerTo({ x: start.x, y: start.y + 8 });
  await pointerTo({ x: start.x, y: start.y + 16 });
  return {
    over: async (target: Element) => {
      at = centreOf(target);
      await pointerTo(at);
    },
    drop: async (target: Element) => {
      at = centreOf(target);
      await pointerTo(at);
      firePointer("pointerup", at, document);
      await frame();
    },
    /** How a real drag ends when the reader presses Escape or lets go over nothing. */
    cancel: async () => {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
      await frame();
    },
  };
}

/** Something to pick up, plus the real {@link QuickZones} — monitor, sticky box and all — and a
 *  line saying what the last drop wrote. */
function Bench({ payload }: { payload: DragPayload }) {
  const ref = useRef<HTMLDivElement>(null);
  const [wrote, setWrote] = useState<string>("nothing yet");
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    return cardDraggable({ element, payload: () => payload });
  }, [payload]);

  return (
    <div className="flex h-64 w-[52rem] flex-col gap-3 overflow-y-auto">
      <QuickZones
        categories={CATEGORIES}
        onDrop={(writes: DeckWrite[]) => setWrote(JSON.stringify(writes.length === 1 ? writes[0] : writes))}
        onNewCategory={(p) => setWrote(`new category for ${p.name}`)}
      />
      <div className="flex flex-col gap-3 pt-16">
        <div
          ref={ref}
          className="inline-block w-max cursor-grab rounded-md border border-border bg-surface px-3 py-2 text-sm"
        >
          {payload.name}
        </div>
        <p className="font-mono text-xs text-dim">{wrote}</p>
      </div>
    </div>
  );
}

/**
 * The whole gesture, over the drag library's own code path: nothing is drawn until a card is
 * picked up, the bar appears, `Auto` takes it, and the bar goes on the drop.
 *
 * What this cannot reach is what `test-drag.ts` records — the platform's drag preview, the
 * pointer-driven hit-testing that decides which element a `dragover` lands on, and
 * auto-scrolling, all three of which measure rectangles. The layout claim (that the bar costs no
 * height, and clears the deck at rest) is a live pass's.
 */
export const AppearsOnADrag: Story = {
  render: () => <Bench payload={FROM_A_WALL} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const zone = (label: string) =>
      canvasElement.querySelector<HTMLElement>(`[${QUICK_ZONE_ATTR}="${label}"]`);

    await expect(zone("Auto")).toBeNull();
    const held = await pickUp(canvas.getByText("Lightning Bolt"));
    try {
      await waitFor(() => expect(zone("Auto")).not.toBeNull());
      await held.over(zone("Auto")!);
      await held.drop(zone("Auto")!);
      await waitFor(() => expect(canvas.getByText(/auto-add/)).toBeInTheDocument());
    } finally {
      await held.cancel();
    }
    await waitFor(() => expect(zone("Auto")).toBeNull());
  },
};

/**
 * The other half of the **New category** zone.
 *
 * A modal rather than a field in the bar, because by the time it is needed the bar is gone — the
 * platform ends the drag on the drop, and a control that appeared where the pointer had just
 * been would be a control the reader is no longer looking at. **It is the one dialog in this
 * editor that puts the caret in a field**, against `Dialog`'s own rule, because it is a
 * question and nothing else.
 */
export const NamingTheNewPile: StoryObj<typeof QuickCategoryDialog> = {
  render: () => (
    <QuickCategoryDialog
      open
      cardName="Lightning Bolt"
      pending={false}
      failure={null}
      onCreate={() => {}}
      onDismiss={() => {}}
      onClose={() => {}}
    />
  ),
  play: async () => {
    const dialog = within(await within(document.body).findByRole("dialog"));
    await waitFor(() => expect(dialog.getByLabelText("New category name")).toHaveFocus());
    await expect(dialog.getByRole("button", { name: "Create" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await userEvent.type(dialog.getByLabelText("New category name"), "Removal");
    await expect(dialog.getByRole("button", { name: "Create" })).toHaveAttribute(
      "aria-disabled",
      "false",
    );
  },
};

/**
 * The one refusal that actually happens: the grain is `(deck_id, name)`, so a name the deck
 * already has comes back refused rather than as a second pile.
 *
 * **Said inside the dialog**, which is not a duplicate of the editor's banner — that banner
 * draws behind this dialog's own `LAYER.overlay` scrim, so this is the only place the sentence
 * can be seen. The name stays in the field to be corrected.
 */
export const TheNameIsTaken: StoryObj<typeof QuickCategoryDialog> = {
  render: () => (
    <QuickCategoryDialog
      open
      cardName="Lightning Bolt"
      pending={false}
      failure="Could not make that category — a category called Removal already exists"
      onCreate={() => {}}
      onDismiss={() => {}}
      onClose={() => {}}
    />
  ),
  play: async () => {
    const dialog = within(await within(document.body).findByRole("dialog"));
    await expect(dialog.getByRole("alert")).toHaveTextContent("already exists");
  },
};
