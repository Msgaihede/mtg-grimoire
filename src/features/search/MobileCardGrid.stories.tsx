import { useEffect, useRef, useState, type ReactElement } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { CardArt } from "@/components/CardArt";
import { FinishMark } from "@/components/FinishMark";
import { OwnedBadge } from "@/components/OwnedBadge";
import { RarityGem } from "@/components/RarityGem";
import { scaled } from "@/lib/cardZoom";
import type { Finish } from "@/lib/finish";
import { FOCUS } from "@/lib/focus";
import { useAppStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { PHONE_HEIGHT_PX, PHONE_PX } from "@/lib/viewports";
import { CARDS, type FakeCard } from "../../../.storybook/fake/cards";
import { printing } from "../../../.storybook/fake/fixtures";
import { CardGrid, columnsFor, type GridCard } from "./CardGrid";

/**
 * Three answers to one failure, drawn at 390×844.
 *
 * The wall is `CardGrid`, `TILE_BASE_WIDTH` is 170 and `main` is `p-5`, so a phone window leaves
 * a **324px** wall (see {@link WALL_AT_390}) — narrow enough that `columnsFor` floors at one
 * column and `sideGutterFor` puts **77px of empty margin on each side of a single card**. Half
 * the screen is table felt. That is what this round exists to answer, and nothing below is a
 * decision: they are three drawings for Markus to choose between.
 *
 * These are design options, not tests. `src/stories.test.tsx` renders each one and goes red if it
 * throws, which proves it renders and nothing else.
 */
type StoryCard = GridCard;

const gridCard = (c: FakeCard): StoryCard => ({
  id: c.id,
  name: c.name,
  setCode: c.setCode,
  collectorNumber: c.collectorNumber,
  rarity: c.rarity,
});

/** Every fixture printing, in the order `.storybook/fake/cards.ts` lists them. */
const ALL: StoryCard[] = CARDS.map(gridCard);

/**
 * G1's tile, and the number is chosen rather than inherited.
 *
 * **The wall is 324px, not the 350 the plan's arithmetic used, and the difference is a whole
 * column.** 390 less `main`'s `p-5` (40) is the wall's *outer* box, 350; the `ResizeObserver` is
 * on `rowsRef`, inside the scroller's own 1px border and its `p-3`, so what it measures is
 * 350 − 2 − 24 = **324**, less whatever a vertical scrollbar takes. A phone's overlay scrollbar
 * takes nothing; the desktop Chromium these stories are *viewed* in takes 15–17, so the frames
 * below report about **307** and under-draw the phone by half a gap.
 *
 * `columnsFor(324, 160)` is **1** — the plan's ~160 does not reach two columns on the box the
 * component measures, and neither does 156 once a desktop scrollbar is on the frame. 144 is the
 * largest round width that draws two columns at both ends of that range, and it is picked over
 * 148 for a reason that is a design decision rather than a safety margin: at 144 the leftover is
 * 24px, so the gutter either side is **12 — exactly `GAP`**. The margins and the space between
 * the cards become one measurement, and the wall reads as a 12px grid rather than as two cards
 * with something left over. At 148 the gutter is 8 and the wall has two rhythms in it.
 */
const PHONE_TILE_WIDTH = 144;

/** `CardGrid`'s gap between tiles. It does not export the constant, so this mirrors it. */
const GAP = 12;

/** The three fixtures the badge has something to say about — `SearchPage` draws it on every
 *  tile and the badge guards itself, so the rest of the wall draws no corner at all. */
const OWNED: Record<string, number> = { [printing("lea", "161").id]: 3, [printing("2x2", "117").id]: 1 };
const WISHED = new Set([printing("2x2", "117").id, printing("sta", "105").id]);

/** Two foils, so the top-right chip is on the wall to judge at a smaller tile. Named printings
 *  rather than a rule over `finishes`, which would mark 61 % of the corpus. */
const FOIL = new Set([printing("2x2", "117").id, printing("sta", "105").id]);

/**
 * Held at module scope, all four of them: `CardGrid` re-registers a tile's drag and re-runs a
 * callback ref whose identity changed, so a fresh arrow per render would tear the registration
 * down on every scrolled row. None of these stories drags, and the habit is the component's rule
 * rather than these stories' need.
 */
const tileOwned = (card: StoryCard) => (
  <OwnedBadge owned={OWNED[card.id] ?? 0} wishlisted={WISHED.has(card.id)} />
);
const tileFinish = (card: StoryCard): Finish | null => (FOIL.has(card.id) ? "foil" : null);
const GAME_CHANGER_IDS = new Set(CARDS.filter((c) => c.gameChanger).map((c) => c.id));
const tileGameChanger = (card: StoryCard) => GAME_CHANGER_IDS.has(card.id);

/**
 * The phone, and the window chrome inside it.
 *
 * Declared here rather than shared, and the numbers rather than the box are what is shared.
 * A Tailwind class cannot be built by interpolation — it would emit no rule at all — so the
 * width is an inline style, which is how this repo already spells a computed length.
 * `shrink-0` because the docs canvas is a flex container: without it a narrow canvas shrinks
 * the frame and the story becomes a picture of a width nobody asked for.
 *
 * The inner box is the one thing added to the shape the plan gives, and it is load-bearing:
 * it stands in for `AppShell`'s `<main className="… p-5">` and `SearchPage`'s own
 * `flex min-h-0 flex-1 flex-col` column. Without it the wall is 390 wide instead of 350 and
 * every column count below is a column too generous. The ribbon and the rail are deliberately
 * absent — they are Task 5's round, and the wall is drawn against the whole window until that
 * one is settled. What R1's 68px rail would cost is in the write-up, not guessed at here.
 */
const phone = (Story: () => ReactElement) => (
  <div
    className="flex shrink-0 overflow-hidden"
    style={{ width: PHONE_PX, height: PHONE_HEIGHT_PX }}
  >
    <div className="flex min-h-0 flex-1 flex-col p-5">
      <Story />
    </div>
  </div>
);

const meta = {
  title: "Mobile/Card grid",
  component: CardGrid<StoryCard>,
  tags: ["autodocs"],
  args: {
    rows: ALL,
    listKey: "mobile",
    // The search wall, so a ctrl+wheel in the canvas steps `cardZoom.search` and leaves the
    // other seven sections alone. Required and never defaulted — see `CardGrid`'s own prop.
    zoomSection: "search",
    onSelect: fn(),
    onNeedNextPage: fn(),
    badge: tileOwned,
    finish: tileFinish,
    gameChanger: tileGameChanger,
  },
  decorators: [phone],
  parameters: {
    docs: {
      description: {
        component:
          "**Three options for the wall of card faces on a phone, at 390×844.** Read the round " +
          "up in the mobile-layout options spec; this page is the picture that goes with it.\n\n" +
          "The failure being answered: `TILE_BASE_WIDTH` is 170, `main` is `p-5`, and what " +
          "`CardGrid`'s `ResizeObserver` measures inside a 390px window is **324px** — its own " +
          "1px border and 12px padding come off the 350 that `p-5` leaves. `columnsFor(324, 170)` " +
          "is **1** and `sideGutterFor(324, 170)` is **77px each side**, so a phone draws one " +
          "card per row with half the screen as margin.\n\n" +
          "**Every option also has to say what steps `cardZoom` on a phone.** The ctrl+wheel " +
          "gesture has exactly one caller (`lib/useCardZoomGesture.ts`) and a touchscreen pinch " +
          "produces no wheel event at all, so the sixteen-stop ladder is frozen at whatever the " +
          "last session left. The write-up costs an answer per option; \"nothing\" is one of them.\n\n" +
          "Viewed on a desktop, Chromium draws a classic 15–17px scrollbar the phone will not, " +
          "so the frames below report a wall of about 307 rather than 324. Switch the **Art** " +
          "toolbar to Live for real Scryfall images.",
      },
    },
  },
} satisfies Meta<typeof CardGrid<StoryCard>>;

export default meta;
type Story = StoryObj<typeof meta>;
type WallProps = Parameters<typeof CardGrid<StoryCard>>[0];

/**
 * **G1 — a phone tile width.** One prop, and it is the prop the component already has.
 *
 * `baseTileWidth` defaults to `TILE_BASE_WIDTH` and the deck editor's docked panel already passes
 * 150 through it, so this option adds no code to `CardGrid` at all: it is the second caller of an
 * existing seam. At 144 on a 324px wall that is **two columns, 144px drawn, 12px of gutter either
 * side** — the gutter equal to the gap, so the margins and the space between the cards are one
 * measurement.
 *
 * What it costs is card: a 144px face against 170 is 15 % narrower, and the tile is 226px tall
 * against 262. What it does **not** cost is the chin — `--mark-scale` is `cardScaleVars(zoom)`,
 * the reader's *zoom*, and it knows nothing about `baseTileWidth`. So the chin stays 28px tall
 * with 10px type whatever this number is, and the plan's "6 % shrink on the chin's type" is not
 * a thing this prop can do. A narrower tile makes the chin proportionally **taller**, not
 * smaller: 10.7 % of the tile's height at 170, 12.4 % at 144.
 *
 * The zoom, on a phone: **nothing steps it, and that is the answer.** The ladder still works
 * where a wheel exists, and 144 is a size a reader does not have to correct. Two stops are
 * reachable downward without leaving two columns (90 % draws 130 at 26px gutters, 80 % draws 115
 * at 41) and one step up leaves it — 110 % is 158, which is one column and an 83px margin. A
 * ladder whose useful range on this wall is four stops is an argument for getting the default
 * right rather than for building a gesture.
 */
export const G1PhoneTile: Story = {
  args: { baseTileWidth: PHONE_TILE_WIDTH },
};

/**
 * The wall's own width, measured, so the stretch is computed against the box `CardGrid` measures.
 *
 * **This wrapper is the finding, not a convenience.** G2 cannot be expressed through any prop
 * `CardGrid` has: `tileWidthFor` returns `min(asked, wall)` and there is no seam that says "share
 * the leftover out". So the arithmetic has to be done from outside and fed back in through
 * `baseTileWidth`, which means a second `ResizeObserver` over the same element — and the story
 * has to mirror the module's unexported `GAP` to do it. Shipping G2 means putting this back where
 * it was before 2026-08-14, inside `tileWidthFor`.
 *
 * It observes **the scroller** rather than this box, and that is not interchangeable: the scroller
 * carries the 12px padding and the 1px border, so its own outer width is a wall answer 26px too
 * generous, and its *content* box is exactly what `rowsRef` reports. There is no feedback loop of
 * the kind `sideGutterFor`'s doc warns about, because nothing here puts padding on a box anybody
 * measures — the width read is the scroller's content box and the number written back is a tile
 * width.
 *
 * The zoom is read rather than assumed, so a ctrl+wheel in the Storybook canvas really does walk
 * the ladder and the step function this option re-opens can be *seen* rather than argued about.
 * `CardGrid` re-applies `scaled(base, zoom)`, so the base handed over is the drawn width divided
 * back out by it.
 *
 * Under Vitest `ResizeObserver` is a no-op stub and `clientWidth` is 0, so `wall` stays 0 and the
 * floor is drawn — jsdom lays nothing out and the column count was never a claim it could settle.
 */
function StretchedWall({ args }: { args: WallProps }) {
  const host = useRef<HTMLDivElement>(null);
  const [wall, setWall] = useState(0);
  const zoom = useAppStore((s) => s.cardZoom.search);

  useEffect(() => {
    const scroller = host.current?.querySelector<HTMLElement>('[role="group"]');
    if (!scroller) return;
    const observer = new ResizeObserver(([entry]) => setWall(entry.contentRect.width));
    observer.observe(scroller);
    // The observer fires on `observe` in a browser and never under the test stub; this is what
    // the first frame gets either way. `clientWidth` excludes the scrollbar, the 24 is the
    // scroller's `p-3`, and jsdom's 0 lands harmlessly below the guard below.
    setWall(scroller.clientWidth - 24);
    return () => observer.disconnect();
  }, []);

  const floor = scaled(PHONE_TILE_WIDTH, zoom);
  const columns = wall > 0 ? columnsFor(wall, floor) : 1;
  const drawn = wall > 0 ? Math.floor((wall - (columns - 1) * GAP) / columns) : floor;

  return (
    <div ref={host} className="flex min-h-0 flex-1 flex-col">
      <CardGrid {...args} baseTileWidth={drawn / zoom} />
    </div>
  );
}

/**
 * **G2 — the gutter is the bug, not the tile.** The tiles share the leftover out and the wall
 * reaches both edges.
 *
 * At 324 with a 144px floor that is **two columns at 156px drawn and no gutter at all**: 12px
 * more card per tile than G1 and 24px of margin gone. It is G1 *plus* flush — the floor
 * underneath it has to be a phone number either way, because a 170px floor on a 324px wall is
 * one column drawn at 324, which is the failure with the margin painted over rather than fixed.
 *
 * **This is a settled decision being re-opened.** Stretch-to-fill was `CardGrid`'s behaviour
 * until `f4c4326` on 2026-08-14, and it was removed because it made the drawn width a function of
 * the **column count** — a step function of the zoom. Measured on the deck editor's 330px column,
 * the ten-stop ladder of the day collapsed to three distinct widths (102, 102, 159, 159, 159,
 * 331 ×5): seven gestures in a row that moved nothing.
 *
 * **On a 324px wall it is worse, not better.** The same sum against today's sixteen stops and a
 * 144px floor gives **four** distinct widths — 72, 100, 156, then 324 for every stop from 110 %
 * up — so twelve of sixteen stops draw what the stop before them drew. The re-opening therefore
 * rests entirely on the sub-question: on a touchscreen **nothing steps the ladder**, so there is
 * no gesture for a step function to spoil, and the wall is drawn at one width forever. That is a
 * real argument and it has a price attached — G2 and any future phone zoom control are mutually
 * exclusive, and the day somebody adds a pinch handler this measurement comes back. Ctrl+wheel in
 * this canvas walks it now, which is the honest way to look at it.
 *
 * The zoom, on a phone: **nothing steps it, and this option needs that to stay true.**
 */
export const G2StretchToFill: Story = {
  render: (args) => <StretchedWall args={args} />,
};

/**
 * One row of G3 — the tile turned on its side.
 *
 * **The structure is the shipped tile's, transposed rather than reinvented.** The art is the
 * `<button>`, so its accessible name is the card and nothing else; the text beside it is a
 * sibling with a click of its own, which is exactly what `CardGrid`'s two corner marks already
 * are and for the same reason — a wall of forty buttons called "Lightning Bolt LEA · 161 Foil" is
 * what folding the caption into the name produces. One tab stop per row, the whole row tappable.
 *
 * **`CardChin`'s vocabulary, not `CardChin`.** The component is a bar with a height, a rise and
 * three of its own edges, built to fuse to the bottom of a card; laid beside one it is a bar
 * fused to nothing. What moves across is the line it draws — the rarity gem, `SET · number` in
 * the mono face at 10px `text-dim`, the finish mark — and the plate the row sits on is that bar's
 * own material (`bg-surface`, `border-border`), grown to hold the card instead of hanging under
 * it. The chin becomes the row.
 *
 * `--mark-scale` is deliberately not set: it is the reader's *zoom* rather than a size ratio, and
 * a row is drawn at the size the three tables draw these marks, which is what the `, 1` fallback
 * already gives. That is also the cost — the foil chip and the crown are laid on a 96px face at
 * the size they are laid on a 170px one. The deck's Grid view already accepts this at 150.
 *
 * `hoverZoom` is not passed. It answers "which tile is the pointer over", which is a question a
 * finger does not ask.
 */
function CardRow({
  card,
  onSelect,
}: {
  card: StoryCard;
  onSelect: (id: string, card: StoryCard) => void;
}) {
  const open = () => onSelect(card.id, card);
  const finish = tileFinish(card);
  return (
    // `scroll-m-1.5` for `CardGrid`'s reason: `scrollIntoView({ block: "nearest" })` parks a row
    // flush against the scrollport's padding box and `FOCUS` paints 4px proud of the border box,
    // so without the margin half a focus indicator is clipped. 6px is `DROP_MARK_ROOM`'s number,
    // written the same way in both places so the two cannot drift.
    <li className="flex scroll-m-1.5 items-center gap-3 rounded-lg border border-border bg-surface p-2">
      <button type="button" onClick={open} className={cn("w-24 shrink-0 rounded-lg", FOCUS)}>
        <CardArt
          cardId={card.id}
          name={card.name}
          finish={finish}
          gameChanger={tileGameChanger(card)}
        />
      </button>
      {/* The tile's corner marks' arrangement: a sibling of the button, with the same click and
          no tab stop of its own, so the row opens the card wherever a thumb lands on it and the
          button's name stays the card's. */}
      <span onClick={open} className="flex min-w-0 flex-1 flex-col justify-center gap-1.5">
        <span className="line-clamp-2 text-sm leading-snug text-text">{card.name}</span>
        <span className="flex items-center gap-1.5 font-mono text-[10px] text-dim">
          <RarityGem rarity={card.rarity} />
          <span className="min-w-0 flex-1 truncate">
            {card.setCode.toUpperCase()} · {card.collectorNumber}
          </span>
          {finish && <FinishMark finish={finish} />}
          {/* At the end of the line rather than on a third one: `OwnedBadge` is `inline-flex
              shrink-0` and guards itself, so a row with nothing owned and nothing wished draws
              no gap at all — which is most of a browse. */}
          {tileOwned(card)}
        </span>
      </span>
    </li>
  );
}

/**
 * **G3 — one column, art beside data.** The tile becomes a row and the wall becomes a list.
 *
 * A 96px face is 134px of art, and a row is 150px tall against G1's 226 — but there is one card
 * in it rather than two, so the same 804px of wall shows **five rows against eight tiles**. A
 * phone reads a list better than a wall; it does not fit more cards on one.
 *
 * **It strands `CardGrid` outright**, which is what makes it the biggest of the three. Nothing
 * below is the component: not the virtualiser (this list is 43 fixtures and a browse is ~117 k
 * printings, so shipping it means a second virtualised list or a row mode inside `CardGrid`), not
 * `columnsFor`/`tileWidthFor`/`sideGutterFor` — a one-column list has no column arithmetic — and
 * not `arrowNav`. `gridNav`'s `nextGridIndex` takes a column count and answers left/right/up/down;
 * at one column left and right mean nothing and the walk is a `<ul>`'s. `GRID_INDEX_ATTR`, the
 * pending-caret effect and the reflow retry are all about a grid that re-flows when the 384px
 * pane opens, and on a phone that pane is an overlay over the whole window.
 *
 * What it reuses is the card: `CardArt` draws the frame, the retry, the no-art fallback and the
 * top-right chip, and the row's own line is `CardChin`'s vocabulary — see {@link CardRow}.
 *
 * The zoom, on a phone: **nothing steps it, and here nothing needs to.** A row's height is the
 * art's 96px, and 96 is a decision about a list rather than a size a reader would want to steer;
 * `cardZoom.search` is read by nothing in this option, so the frozen ladder costs it nothing at
 * all. That is the one place G3 is cheaper than the other two.
 */
export const G3RowList: Story = {
  render: (args) => (
    <div
      role="group"
      aria-label="Search results"
      className="min-h-0 flex-1 overflow-auto rounded-md border border-border p-3"
    >
      <ul className="flex flex-col gap-3">
        {args.rows.map((card) => (
          <CardRow key={card.id} card={card} onSelect={args.onSelect} />
        ))}
      </ul>
    </div>
  ),
};
