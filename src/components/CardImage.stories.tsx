import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { FOCUS } from "@/lib/focus";
import { cardImageUrl } from "@/lib/images";
import { cn } from "@/lib/utils";
import { printing } from "../../.storybook/fake/fixtures";
import { CardImage } from "./CardImage";

const BOLT = printing("lea", "161");
const LOTUS = printing("lea", "232");

/**
 * Half the `grid` variant's 488 x 680 (`.storybook/fake/images.ts`'s `SIZE`, copied from
 * `Variant::dimensions` in `src-tauri/src/images.rs`), so the picture is downscaled by exactly
 * two and never resampled onto a fractional box. Both attributes are given rather than width
 * alone: an `<img>` that has not decoded anything is 0px tall with only a width, and the two
 * frames in `SwapCard` have to hold their place across a swap for the swap to show anything.
 */
const W = 244;
const H = 340;

const meta = {
  title: "Primitives/CardImage",
  component: CardImage,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component:
          "One card image, keyed on its own `src` so a frame can never paint the wrong " +
          "card. Every card frame in this app belongs to a *slot* rather than to a card, so " +
          "React hands the same element a different printing and a bare `<img>` would keep " +
          "the previous card's art under the new card's name for the length of the fetch. " +
          '**Most call sites pass `alt=""`**: the deck views\' card art, the two cover ' +
          "pickers, `DecksPage`'s tile and `TheoryDiffDialog`'s rows. Only two name the " +
          "card — `CardArt`'s frame, which is what every wall of tiles draws through, and " +
          "`CardModalArt`'s open card. Which is why `alt` is required rather than " +
          "optional — “decorative” has to be a decision someone made rather than a prop " +
          "someone forgot.",
      },
    },
  },
} satisfies Meta<typeof CardImage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The search wall's frame at half size. Nothing special is happening, which is the point:
 *  this component is a bare `<img>` plus one `key`, and it draws like one. */
export const Loaded: Story = {
  args: { src: cardImageUrl(BOLT.id, 0, "grid"), alt: BOLT.name, width: W, height: H },
};

/**
 * The two frames, side by side, handed the same `src` on every render.
 *
 * A named component rather than hooks inside `render`, following `QuantityStepper.stories.tsx`:
 * `eslint-plugin-storybook` switches `react-hooks/rules-of-hooks` off inside a story file
 * (verified with `eslint --print-config`, the rule reads `[0]` there), so the inline form would
 * lint clean — this is the shape the repo has already proven under both Storybook and the
 * `src/stories.test.tsx` runner.
 */
function SwapDemo() {
  const [swaps, setSwaps] = useState(0);
  const card = swaps % 2 === 0 ? BOLT : LOTUS;
  const src = cardImageUrl(card.id, 0, "grid");

  return (
    <div className="flex flex-col items-start gap-4">
      <div className="flex flex-wrap gap-4">
        <figure data-testid="keyed" className="flex flex-col gap-2">
          <CardImage
            src={src}
            alt={card.name}
            width={W}
            height={H}
            className="rounded-lg bg-surface"
          />
          <figcaption className="max-w-[244px] text-xs">
            <span className="block font-mono text-sm text-text">{card.name}</span>
            <span className="text-dim">
              <code>CardImage</code> — keyed on its own <code>src</code>
            </span>
          </figcaption>
        </figure>

        <figure data-testid="bare" className="flex flex-col gap-2">
          {/* Deliberately not `CardImage`: this is the thing the component exists to stop
              being written, kept here so the difference is one screenshot rather than a
              memory of the previous one. Story-local — no component source is changed. */}
          <img src={src} alt={card.name} width={W} height={H} className="rounded-lg bg-surface" />
          <figcaption className="max-w-[244px] text-xs">
            <span className="block font-mono text-sm text-text">{card.name}</span>
            <span className="text-dim">
              bare <code>&lt;img&gt;</code> — repaints in place
            </span>
          </figcaption>
        </figure>
      </div>

      <button
        type="button"
        onClick={() => setSwaps((n) => n + 1)}
        className={cn(
          "rounded-md border border-border px-3 py-1 text-sm text-dim hover:text-text",
          FOCUS,
        )}
      >
        Swap card
      </button>
    </div>
  );
}

/**
 * **The story that exists because the test suite structurally cannot see this.**
 *
 * Setting an `<img>`'s `src` resets `complete` and `naturalWidth` while the browser goes on
 * painting the last decoded frame, so `naturalWidth === 0` is true in the healthy case and in
 * the broken one alike. What separates them is what is on the screen — so this draws both at
 * once, handed the same `src` on every render, under captions that flip the instant the data
 * does. Press **Swap card**: the keyed frame goes empty and fills with the new card, and the
 * bare one holds Lightning Bolt's art under Black Lotus's name until the fetch lands.
 *
 * **Switch the Art toolbar to Live first, or there is nothing to see.** Synthetic art is a
 * `data:` URI (`.storybook/fake/images.ts`), and a data URI needs no network round trip — the
 * stale window is too short to catch. Live art is a real fetch off `cards.scryfall.io`.
 *
 * The `play` below pins the DOM half of the claim, which *is* checkable without eyes: after
 * the swap the keyed `<img>` is a different element and the bare one is the same element
 * wearing a new `alt`. It cannot pin the visible half. **Only a human can confirm that one**,
 * and nobody has: this session has no browser, and the visual pass is Task 17's.
 */
export const SwapCard: Story = {
  // Inert, and they have to be there: `StoryObj<typeof meta>` requires the component's own
  // required props, and this story's `render` draws two frames it names itself. Controls are
  // switched off rather than left offering two knobs that move nothing.
  args: { src: "", alt: "" },
  parameters: { controls: { disable: true } },
  render: () => <SwapDemo />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const imageIn = (testId: string) => canvas.getByTestId(testId).querySelector("img");

    const keyedBefore = imageIn("keyed");
    const bareBefore = imageIn("bare");
    await expect(keyedBefore).toHaveAttribute("alt", BOLT.name);
    await expect(bareBefore).toHaveAttribute("alt", BOLT.name);

    await userEvent.click(canvas.getByRole("button", { name: "Swap card" }));

    // The whole contract, in two lines: a new card is a new element, so nothing of the old
    // card's pixels can survive the swap — and the element that is *not* keyed survives it,
    // which is exactly the frame that would still be painting Lightning Bolt.
    await expect(imageIn("keyed")).not.toBe(keyedBefore);
    await expect(imageIn("bare")).toBe(bareBefore);

    // Both captions have already flipped. That is the point: the data is right in both
    // frames, and only one of the two pictures is.
    await expect(imageIn("keyed")).toHaveAttribute("alt", LOTUS.name);
    await expect(imageIn("bare")).toHaveAttribute("alt", LOTUS.name);
  },
};

/**
 * A `src` nothing serves, which is the only thing a reader gets when a fetch fails: the `alt`.
 *
 * Hand-written rather than `cardImageUrl`'s output, and it has to be — under the fake,
 * `cardImageUrl` answers an id that is in no fixture row with a synthetic placeholder reading
 * "Unknown card" (`.storybook/fake/images.ts`, the `synthetic(card, …)` fall-through), so
 * there is no card id that produces a failure. `mtgimg://localhost/…` is what `imageOrigin`
 * returns off Windows, and nothing outside the Tauri window registers that scheme — so in a
 * Storybook page there is nothing on the other end of it.
 *
 * `CardImage` draws no fallback of its own, deliberately — the surfaces that draw card art
 * disagree about what a missing picture should look like and each supplies its own
 * (`CardModalArt`, for one, swaps in a panel reading "No image yet"). This story is the raw
 * component, so what shows is whatever the browser draws for a broken image, plus the `alt`.
 */
export const FailedLoad: Story = {
  args: {
    src: "mtgimg://localhost/grid/00000000-0000-0000-0000-000000000000/0",
    alt: "Ancestral Recall",
    width: W,
    height: H,
  },
};

/**
 * `alt=""` for a frame whose caption already names the card — a decision, not an omission, and
 * the shape three of the five call sites use.
 *
 * The `art` crop rather than the full card, because that is what two of those three draw:
 * `DecksPage`'s cover tile and the deck grid view's tile are both art crops beside a name
 * the reader can already read.
 *
 * An empty `alt` takes the image out of the accessibility tree entirely rather than giving it
 * an empty name, which is invisible in a screenshot and is what the `play` checks.
 *
 * **Width only, unlike the stories above.** `art` is 626 x 457, and half of 457 is not a whole
 * pixel — declaring a height here would mean either a fractional attribute or a crop stretched
 * by a fraction of a percent, and stretching a card image is the one thing Scryfall's usage
 * rules forbid outright. Nothing swaps in this story, so a reserved height buys nothing.
 */
export const Decorative: Story = {
  args: { src: cardImageUrl(BOLT.id, 0, "art"), alt: "", width: 313 },
  play: async ({ canvasElement }) => {
    // Not `getByRole("img")` with an empty name — there is no `img` role here to find. An
    // `<img alt="">` maps to `presentation`, so a screen reader walking the page never stops
    // on it and never announces "image".
    await expect(within(canvasElement).queryByRole("img")).toBeNull();
    await expect(canvasElement.querySelector("img")).toHaveAttribute("alt", "");
  },
};
