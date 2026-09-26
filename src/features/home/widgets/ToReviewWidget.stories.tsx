import type { Meta, StoryObj } from "@storybook/react-vite";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { expect, fn, within } from "storybook/test";
import { TRAY_ROWS } from "@/features/scanner/fixtures";
import { ipc, type HomeWidget } from "@/lib/ipc";
import { makeFit, spanPx } from "../fit";
import { WidgetCard } from "../WidgetCard";
import { widgetDensity } from "../widgetSettings";
import { EMPTY, ToReviewWidget } from "./ToReviewWidget";

/** The grid's target cell. Not exported, for CSF. */
const CELL = 104;

/** How long a play waits for five reads and a staged write to land. Not exported, for CSF. */
const LANDED = { timeout: 5_000 };

/** A `toReview` widget at a footprint, with a config. */
function review(w: number, h: number, config: unknown = null): HomeWidget {
  return { id: "toReview", kind: "toReview", x: 0, y: 0, w, h, config };
}

/** The body inside the real card. `web` is the one prop the page never passes — see the story
 *  that sets it. */
function Framed({
  widget,
  still = false,
  web,
}: {
  widget: HomeWidget;
  still?: boolean;
  web?: boolean;
}) {
  const widthPx = spanPx(widget.w, CELL);
  const heightPx = spanPx(widget.h, CELL);
  const fit = makeFit({ w: widget.w, h: widget.h, widthPx, heightPx, density: widgetDensity(widget) });
  const onConfig = fn();
  return (
    <div className="p-2">
      <div style={{ width: widthPx, height: heightPx }}>
        <WidgetCard
          widget={widget}
          fit={fit}
          editing={false}
          still={still}
          onConfig={onConfig}
          onRemove={fn()}
        >
          <ToReviewWidget
            widget={widget}
            fit={fit}
            editing={false}
            still={still}
            onConfig={onConfig}
            web={web}
          />
        </WidgetCard>
      </div>
    </div>
  );
}

/**
 * The two rows no seed carries, **written through the commands** — `DecksPage.stories.tsx`'s
 * `OrphanedCover` idiom, and `FakeDb.scannerTray`'s own doc says a story that wants tray rows writes
 * them. The scanner fixture's four rows, one still waiting on a printing; and deck 2 deleted, which
 * files the one copy in its group into `Recently removed` — the fake's `deck_delete` does exactly
 * what the crate does. `useQuery` so it runs once per story client, and the card is held back until
 * both writes have landed.
 */
function Staged({ children }: { children: ReactNode }) {
  const staged = useQuery({
    queryKey: ["story", "to-review"],
    queryFn: async () => {
      await ipc.setScannerTray(TRAY_ROWS);
      await ipc.deckDelete(2);
      return true;
    },
    staleTime: Infinity,
  });
  return staged.isSuccess ? <>{children}</> : null;
}

const meta = {
  title: "Home/ToReviewWidget",
  component: Framed,
  tags: ["autodocs"],
  args: {
    // The kind's default footprint and no config — `Recently removed` on.
    widget: review(2, 3),
  },
  parameters: {
    docs: {
      description: {
        component:
          "What is waiting on the reader, **one row per place** and each row opening that place: " +
          "the scanner's tray, flagged binder entries, flagged wishes, flagged deck cards, and the " +
          "copies held in `Recently removed`. A row is drawn only when its count is above zero, " +
          "always in that order.\n\n" +
          "A press is a view change and, where the page does not open in the right state by " +
          "itself, a one-shot hand-off after it — the binder and the wishlist open filtered to " +
          "Needs review, the deck cards open Settings with the Needs review panel in view.\n\n" +
          "**The browser build** has no scanner, so there is no tray row, and no Needs review list " +
          "to open, so the deck cards row is drawn without a press.",
      },
    },
  },
} satisfies Meta<typeof Framed>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Every row at once: `needsReview` flags one binder entry, one wish and one deck card, and the
 * staged writes add the tray and a copy in `Recently removed`. The tray is the scanner fixture's
 * four rows and **six copies**, one row still waiting on a printing — so the row reads the copies
 * and the cards to pick exactly as the Scanner's own tray heads them.
 */
export const EverythingWaiting: Story = {
  args: { widget: review(3, 4) },
  parameters: { fake: { seed: "needsReview" } },
  render: (args) => (
    <Staged>
      <Framed {...args} />
    </Staged>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "To review" }, LANDED));
    await expect(
      await card.findByRole("button", { name: "Scanned cards · 1 card to pick · 6" }, LANDED),
    ).toBeInTheDocument();
    await expect(
      card.getByRole("button", { name: "Binder entries · Flagged for review · 1" }),
    ).toBeInTheDocument();
    await expect(
      card.getByRole("button", { name: "Wishes · Flagged for review · 1" }),
    ).toBeInTheDocument();
    await expect(
      card.getByRole("button", { name: "Deck cards · Flagged for review · 1" }),
    ).toBeInTheDocument();
    await expect(card.getByRole("button", { name: "Recently removed · 1 copy" })).toBeInTheDocument();
  },
};

/** The two-cell tile: each count moved under its name, and each press named by what it draws. */
export const Tile: Story = {
  args: { widget: review(2, 2) },
  parameters: { fake: { seed: "needsReview" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "To review" }, LANDED));
    await expect(await card.findAllByText("1 flagged", {}, LANDED)).toHaveLength(3);
    await expect(card.getByRole("button", { name: "Binder entries · 1 flagged" })).toBeInTheDocument();
  },
};

/**
 * **The browser build's face**, with the same rows staged: no scanner row even with a tray full of
 * cards, and the deck cards drawn without a press. `web` is passed because `isWebTarget()` is a
 * build-time define this workbench folds to the desktop answer — the page never passes it.
 */
export const BrowserBuild: Story = {
  args: { widget: review(3, 4), web: true },
  parameters: { fake: { seed: "needsReview" } },
  render: (args) => (
    <Staged>
      <Framed {...args} />
    </Staged>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "To review" }, LANDED));
    await expect(
      await card.findByRole("button", { name: /^Binder entries · / }, LANDED),
    ).toBeInTheDocument();
    await expect(card.queryByText("Scanned cards")).not.toBeInTheDocument();
    await expect(card.getByText("Deck cards")).toBeInTheDocument();
    await expect(card.queryByRole("button", { name: /^Deck cards/ })).not.toBeInTheDocument();
  },
};

/** The reader switched `Recently removed` off: the holding area is not a problem to them. */
export const RecentlyRemovedOff: Story = {
  args: { widget: review(2, 3, { removed: false }) },
  render: (args) => (
    <Staged>
      <Framed {...args} />
    </Staged>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "To review" }, LANDED));
    await expect(
      await card.findByRole("button", { name: /^Scanned cards · / }, LANDED),
    ).toBeInTheDocument();
    await expect(card.queryByText("Recently removed")).not.toBeInTheDocument();
  },
};

/** `starter`: nothing flagged, an empty tray, an empty holding area. */
export const NothingWaiting: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(EMPTY, {}, LANDED)).toBeInTheDocument();
  },
};

/** A catalogue preview: the rows as pictures, nothing to press. */
export const Still: Story = {
  args: { still: true },
  parameters: { fake: { seed: "needsReview" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "To review" }, LANDED));
    await expect(await card.findByText("Binder entries", {}, LANDED)).toBeInTheDocument();
    await expect(card.queryByRole("button", { name: /^Binder entries/ })).toBeNull();
  },
};
