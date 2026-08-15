import { useEffect, useRef, useState } from "react";
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
 * **`Auto` is greyed**, and structurally so: a `deck-card` payload carries no type line, so
 * there is nothing for the filing rule to read. Re-filing a card the deck already holds is the
 * Categories dialog's bulk action, not this.
 */
export const MovingADeckCard: Story = {
  args: { payload: FROM_THE_DECK },
  play: async ({ canvasElement }) => {
    const zone = (label: string) =>
      canvasElement.querySelector<HTMLElement>(`[${QUICK_ZONE_ATTR}="${label}"]`);
    await expect(zone("Auto")).toHaveClass("opacity-40");
    await expect(zone("Sideboard")).not.toHaveClass("opacity-40");
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
 * The platform's drag clipboard, in the only shape this app's drags need.
 *
 * **`src/test-drag.ts` is the same thing and cannot be imported here** — it registers an
 * `afterEach` from `vitest` at import time and pulls in `@testing-library/react`, so importing
 * it would put a test runner into the Storybook browser bundle. `AppShell.stories.tsx` carries
 * the same copy for the same reason, and its header has the long version of why a synthetic
 * `MouseEvent` with a `dataTransfer` bolted on is what the platform's drag event really is.
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
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  target.dispatchEvent(event);
}

/** One frame, so the library's `requestAnimationFrame`-scheduled `onDragStart` has landed.
 *  Necessary and not sufficient — every assertion about a drag's result goes through
 *  `waitFor`, which is `AppShell.stories.tsx`'s measured lesson. */
const frame = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });

/** Pick a card up. **Every drag started here must be finished** — the library keeps one global
 *  "a drag is active" flag, and a story that walked away holding a card leaves the next one
 *  unable to pick one up. Hence the `finally` in every play below. */
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
    cancel: async () => {
      send(source, "dragend", data);
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
        onDrop={(write: DeckWrite) => setWrote(JSON.stringify(write))}
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
 * editor that puts the caret in a field**, against `DeckDialog`'s own rule, because it is a
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
