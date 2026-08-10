import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fireEvent, within } from "storybook/test";
import { RarityGem } from "@/components/RarityGem";
import type { FakeCard } from "../../../.storybook/fake/cards";
import { printing } from "../../../.storybook/fake/fixtures";
import { PREVIEW_FRAME_ATTR, PrintingPreview } from "./PrintingPreview";

/** Four printings of Lightning Bolt and one of Delver, which is what the pane's printings list
 *  looks like: one oracle card, several pieces of cardboard. */
const BOLTS = [
  printing("lea", "161"),
  printing("2x2", "117"),
  printing("sld", "1638"),
  printing("sta", "105"),
];
const DELVER = printing("isd", "51");

/**
 * The card pane, reduced to the two things this preview needs from one.
 *
 * A **stand-in**, not `CardDetailPane` — that component fetches a card and its printings and is
 * Task 11's to story. What is copied verbatim is the pair that is load-bearing:
 * `PREVIEW_FRAME_ATTR` (`data-preview-frame`), which is how the picture finds the box it is
 * positioned in and clipped by, and `relative`, which is what makes those absolute coordinates
 * the pane's own. One mark for both jobs, because they are one box.
 *
 * The rows are plain `<li>`s here rather than the pane's printing rows, and they carry no dwell
 * handlers: `usePrintingDwell` is the hook that decides *when* a picture appears and it takes no
 * props a story could set. These stories are about the picture, which takes a printing and an
 * anchor and draws one.
 *
 * The anchor is captured with a callback ref, so the first render passes `null` — which is a real
 * state and the one {@link NoAnchor} is about — and the second passes the row.
 */
function PaneStandIn({
  printingId,
  anchorIndex,
  rows = BOLTS,
}: {
  printingId: string | null;
  /** Which row the picture hangs off. Counted from the top of the list. */
  anchorIndex: number;
  rows?: FakeCard[];
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <div
      {...{ [PREVIEW_FRAME_ATTR]: "" }}
      className="relative h-[26rem] w-[22rem] overflow-y-auto rounded-lg border border-border bg-surface p-4"
    >
      <p className="pb-2 font-mono text-xs text-dim">Printings</p>
      <ul className="space-y-1">
        {rows.map((card, i) => (
          <li
            key={card.id}
            ref={i === anchorIndex ? setAnchor : undefined}
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-bg/40"
          >
            <RarityGem rarity={card.rarity} />
            <span className="min-w-0 flex-1 truncate">{card.setName}</span>
            <span className="shrink-0 font-mono text-xs text-dim">
              {card.setCode.toUpperCase()} · {card.collectorNumber}
            </span>
          </li>
        ))}
      </ul>
      <PrintingPreview printingId={printingId} anchor={anchor} />
    </div>
  );
}

const meta = {
  title: "Card/PrintingPreview",
  component: PrintingPreview,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component:
          "One printing's art, floating over the list it was asked for from — the `display` " +
          "variant (672×936), at a frame keeping that variant's own ratio rather than the 5:7 " +
          "the app's card frames use. A box holding exactly one variant should be that " +
          "variant's shape, so the art is not cropped by even a pixel.\n\n" +
          "Positioned **in the pane rather than portalled**, like every other layer in this " +
          "app: the shipped CSP is `style-src 'self'` and the overlay primitives in reach " +
          "inject a runtime `<style>` the moment they open. Which means it is *inside* the " +
          "pane's scroller and clipped by it, so it flips above the row when there is no room " +
          "below — the same `shouldFlipUp` arithmetic the deck editor's row menus are placed " +
          "by, and the same reason `previewBox` is exported and unit-tested: **nothing about " +
          "the placement can be seen in jsdom, where every rectangle is zero.**\n\n" +
          "It is `aria-hidden` and `pointer-events-none`. Redundant art — the row underneath " +
          "already names the printing, and this is drawn from that row's own id — and a layer " +
          "that took the pointer would make the rows it covers unhoverable, so the list would " +
          "flicker under a perfectly still hand.\n\n" +
          "**When** it appears is `usePrintingDwell`'s, not this component's: one timer for a " +
          "whole list, a quarter second of rest, and a refusal to start at all while a popup " +
          "is open in the pane. A hook has no stories; `PrintingPreview.test.tsx` drives it " +
          "through the real pane.",
      },
    },
  },
} satisfies Meta<typeof PrintingPreview>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The ordinary case: a picture beside the row that asked for it.
 *
 * **Its size and position are zero here and real in a browser.** `previewBox` fits the picture to
 * `max(room above, room below)` off `getBoundingClientRect`, and jsdom answers 0 for every edge —
 * so under Vitest this is a 0×0 frame in the corner, and in Storybook it is up to 240px wide,
 * right-aligned to its row so the rarity, set and collector number of the rows underneath stay
 * legible down its left edge. The arithmetic itself has fixtures in `PrintingPreview.test.tsx`,
 * including the 1024×768 floor case where a picture that did not shrink was cut off by 15px.
 *
 * The `play` pins what jsdom *can* see, which is the whole of this component's accessibility
 * contract: one image, no accessible name, and a frame that announces nothing.
 */
export const OnARow: Story = {
  args: { printingId: BOLTS[1].id, anchor: null },
  parameters: { controls: { disable: true } },
  render: (args) => <PaneStandIn printingId={args.printingId} anchorIndex={1} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Not `getByRole("img")`: an `<img alt="">` maps to `presentation`, so a screen reader
    // walking the pane never stops on it and never announces "image". There is no `img` role
    // here to find, which is the contract rather than an omission.
    await expect(canvas.queryByRole("img")).toBeNull();
    const images = canvasElement.querySelectorAll("img");
    await expect(images).toHaveLength(1);
    await expect(images[0].closest("[aria-hidden]")).toHaveAttribute("aria-hidden", "true");
    // Never `src`: under Vitest `@/lib/images` is deliberately **unmocked** (see
    // `src/stories.test.tsx`), so `cardImageUrl` is the real one and answers an `mtgimg://` URL
    // that means nothing outside the Tauri window. Presence is the claim; the picture is
    // Task 17's.
    await expect(images[0]).toHaveAttribute("alt", "");
  },
};

/**
 * A double-faced printing, showing its **front** — because that is the only face this component
 * can show.
 *
 * `cardImageUrl(printingId, 0, "display")`: face 0, always, with no flip control and nowhere to
 * put one. That is not a gap. The flip lives in `CardDetailPane` (`CardDetailPane.tsx:406`
 * and `487-501`), on the card the reader has actually opened, and it belongs there: a preview is a
 * quarter-second glance at a row the pointer is resting on, and a control inside it would be a
 * control inside a layer that is `pointer-events-none` and disappears when the pointer moves.
 *
 * Delver of Secrets is the fixture — a `transform` layout whose back, Insectile Aberration, is a
 * different card. Under the **Live** art toolbar it is served its real front image; the fake's
 * `cardImageUrl` refuses to hand a face-1 request a front URL for exactly the reason
 * `images.rs:275-277` gives — that would draw Delver of Secrets on the back of Delver of Secrets.
 */
export const ADoubleFacedPrinting: Story = {
  args: { printingId: DELVER.id, anchor: null },
  parameters: { controls: { disable: true } },
  render: (args) => <PaneStandIn printingId={args.printingId} anchorIndex={0} rows={[DELVER]} />,
};

/**
 * No row is being rested on, which is the state this component is in for almost all of its life.
 *
 * It renders **nothing at all** — not an empty frame — so the pane may mount it unconditionally
 * at the foot of its printings list.
 */
export const NoRowRestedOn: Story = {
  args: { printingId: null, anchor: null },
  parameters: { controls: { disable: true } },
  render: () => <PaneStandIn printingId={null} anchorIndex={1} />,
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelectorAll("img")).toHaveLength(0);
  },
};

/**
 * A printing named with no row to hang it off.
 *
 * The same `null`, reached the other way, and it is a real state rather than a defensive branch:
 * the anchor arrives from a callback ref, so the very first render of any pane has one printing
 * and no element. A picture measured against nothing would be a 0×0 layer nobody can see and
 * Escape would still have to close it.
 *
 * This story renders the component bare — no pane, no list — because that is what the claim is
 * about, and there is nothing to draw.
 */
export const NoAnchor: Story = {
  args: { printingId: BOLTS[0].id, anchor: null },
  play: async ({ canvasElement }) => {
    await expect(canvasElement).toBeEmptyDOMElement();
  },
};

/**
 * After the fetch failed: the frame stays and the picture goes.
 *
 * `useImageRetry` answers an error by handing back `src: null` and scheduling a retry, so the
 * `<img>` is unmounted rather than left on screen holding a URL that has already failed. The
 * frame *is* the placeholder — no spinner, no "no image" panel, no filter — which `Preview`'s
 * own comment says outright, and a preview is on screen for a second at a time.
 *
 * **The retrying state and the spent state are the same DOM**, and that is worth saying because
 * it is the reason there is one story here and not two. The retries are two, on a doubling delay
 * starting at a 30 s floor (`IMAGE_RETRY_FLOOR_MS`), so "spent" is over a minute away and neither
 * this `play` nor a reader is going to wait for it — and when it arrives it looks exactly like
 * this. What `failed` buys elsewhere is a *different sentence* (`CardGrid`'s tile says "No image"
 * against "Retrying…"); this frame has no sentence to change.
 *
 * The error is fired rather than provoked, because nothing here can fail on its own: the fake's
 * `cardImageUrl` answers every id with a synthetic data URI, and a data URI needs no network.
 */
export const AfterAFailedFetch: Story = {
  args: { printingId: BOLTS[1].id, anchor: null },
  parameters: { controls: { disable: true } },
  render: (args) => <PaneStandIn printingId={args.printingId} anchorIndex={1} />,
  play: async ({ canvasElement }) => {
    const image = canvasElement.querySelector("img");
    await expect(image).not.toBeNull();
    // The frame is found through the image, before the image leaves — it is `aria-hidden` and
    // has no role or text of its own, so there is no other handle on it that is not a class.
    const frame = image?.parentElement;
    fireEvent.error(image as HTMLImageElement);
    await expect(canvasElement.querySelectorAll("img")).toHaveLength(0);
    await expect(frame).toBeInTheDocument();
    await expect(frame).toBeEmptyDOMElement();
  },
};

/**
 * The last row in the list, where the picture has to open **upwards**.
 *
 * `previewBox` measures the room above and below the row and puts the picture on whichever side
 * takes it — starting at the row's *bottom* edge going down and ending at its *top* edge coming
 * up, which is the other way round from a menu drawn over its row. When neither side takes it,
 * the picture opens the way it reads and **shrinks** to fit: the size is fitted to
 * `max(above, below)` rather than to the pane, and a version that did not shrink was cut off by
 * 15px at the 1024×768 floor.
 *
 * Nothing about that is visible under Vitest — every rectangle in jsdom is zero — so this story
 * has no `play` and exists to be looked at in a browser. Task 17.
 */
export const NearTheFootOfTheList: Story = {
  args: { printingId: BOLTS[3].id, anchor: null },
  parameters: { controls: { disable: true } },
  render: (args) => <PaneStandIn printingId={args.printingId} anchorIndex={3} />,
};
