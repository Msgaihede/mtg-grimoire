import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { GrimoireMark } from "./GrimoireMark";

const meta = {
  title: "Primitives/GrimoireMark",
  component: GrimoireMark,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component:
          "The app's own mark: a clasped grimoire with a spell diamond burning through the " +
          "cover. Drawn inline rather than loaded, for `FinishMark`'s and `GameChangerMark`'s " +
          "reason — an `<img>` is a second request, a decode the first paint waits for, and a " +
          "picture that cannot take a colour.\n\n" +
          "**It takes a pixel size, not a variant flag, and that is the whole design.** Below " +
          "24px the master artwork's fine detail is drawn at less than a third of a pixel — the " +
          "logo package's own number (`logos/README.md`: “below about 24 px the casting circle " +
          "and the clasp rivets fill in”) — so the component picks the simplified drawing for " +
          "the caller. A *rendered* size is the thing that decides, and a caller is the last " +
          "place that knows it; a mark dropped into a 34px caption row with the wrong variant " +
          "is a bug nobody can see in a test and nobody thinks to look for in the window.\n\n" +
          "**The two variants are one drawing.** Same 64 unit grid, same order, same " +
          "coordinates; the small one drops the groups that fall under a third of a pixel — the " +
          "dashed casting circle and its inner ring, the seven runes, the page block, the " +
          "diamond's facets, the clasp's rivets and gem — and thickens what is left by 1.4, so " +
          "the outline that survives is a hairline on purpose rather than by accident. What it " +
          "keeps is the silhouette anyone recognises at 20px: a closed book, a gold diamond, a " +
          "clasp reaching off the right edge, a ribbon below.\n\n" +
          "**Colour is `currentColor` and the fills are `--color-surface`**, which is what lets " +
          "one file give two pictures: over `bg-surface` the boards fill with the ground they " +
          "sit on and the mark is pure line art, while over `bg-bg` they fill one step above it " +
          "and the book reads as a faint raised plate. No branch in the component, no second " +
          "file, and a token that moves takes the mark with it.\n\n" +
          "**Hidden from assistive technology unless `label` says otherwise**, which inverts " +
          "`GameChangerMark`'s rule on purpose: this is the app's name, and every surface that " +
          "draws it already sets that name in type two millimetres away.",
      },
    },
  },
} satisfies Meta<typeof GrimoireMark>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The window caption's mark, and the one size in the app small enough to need the simplified
 * drawing: `size={20}` in a 34px row, which is under the 24px floor and deliberately so.
 *
 * Gold, beside a wordmark the caption sets dim — the mark is a picture rather than a word, so
 * the app's "gold means you can act on this" rule, which is about type and controls, leaves it
 * alone. Nothing about an emblem invites a press.
 */
export const TitleBarSize: Story = { args: { size: 20, className: "text-accent" } };

/**
 * The first run's, at `size={64}` — the first thing anyone ever sees of this app, and the one
 * place the mark is meant to be seen whole. Every group the small variant drops resolves here:
 * the dashed casting circle, the runes struck around it, the page block inset into the cover,
 * the clasp's two rivets and its gem, and the gradient burning through the diamond.
 */
export const FirstRun: Story = { args: { size: 64, className: "text-accent" } };

/**
 * Larger than anything the app draws, and that is what the workbench is for: the artwork is
 * resolution-independent — one 64 unit grid, re-rendered rather than redrawn — so this is where
 * the *drawing* gets checked rather than the lockup it sits in.
 */
export const Large: Story = { args: { size: 128, className: "text-accent" } };

/**
 * One pixel of box apart, and two different drawings.
 *
 * The floor is a `<` rather than a `<=`, so 24 is the first size that gets the full mark. Drawn
 * at their true sizes because that is the honest picture of how little separates them — and of
 * how little of the fine detail was ever going to survive at 23.
 */
export const EitherSideOfTheFloor: Story = {
  // Inert, and required: `StoryObj<typeof meta>` demands the component's required props even
  // from a story whose `render` names its own children.
  args: { size: 24 },
  parameters: { controls: { disable: true } },
  render: () => (
    <div className="flex items-end gap-6 text-accent">
      <GrimoireMark size={23} />
      <GrimoireMark size={24} />
    </div>
  ),
};

/**
 * **The one thing a workbench can show that a test cannot**: the two drawings at the same
 * rendered size, where what the floor drops is visible rather than described.
 *
 * The left mark is the simplified one — `size={20}`, so the component picks it — blown up to
 * 96px with a class. That override is the story's instrument and **not** a pattern for a call
 * site: the component takes a *rendered* size precisely so that nobody has to hold the box and
 * the drawing in their head at once, and a `size` that disagrees with the box on screen is the
 * bug this component exists to make impossible.
 *
 * At 96px the left one looks bare. At 20px, where it actually ships, the groups it is missing
 * are the ones that would have filled in — which is the argument the picture is here to make.
 */
export const WhatTheFloorDrops: Story = {
  args: { size: 20 },
  parameters: { controls: { disable: true } },
  render: () => (
    <div className="flex items-end gap-8 text-accent">
      <GrimoireMark size={20} className="size-24" />
      <GrimoireMark size={96} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    // Which side is which is the whole claim, and at 96px the two are similar enough that a
    // reader could take them the wrong way round. `<circle>` is the tell: the casting circle,
    // its inner ring and the clasp's two rivets are the only ones on the mark.
    //
    // Selected by `width` rather than by a bare `svg`, because `preview.tsx` wraps every story
    // in the tooltip and context-menu providers and a tag selector would count whatever chrome
    // they mount beside the story.
    //
    // **Not by `viewBox`, which is the obvious choice and matches nothing here.** A play runs
    // under jsdom in `stories.test.tsx` as well as in a browser, and jsdom's selector engine
    // lowercases an attribute name in a selector while the parsed attribute keeps its camel
    // case — so `svg[viewBox="0 0 64 64"]` returns an **empty list** rather than raising, which
    // reads exactly like a mark that was never drawn. It cost this file two red plays. `width`
    // is all lower case and survives both engines, and here it is the better claim anyway: it
    // is the number that decides which variant is drawn.
    const simplified = canvasElement.querySelector('svg[width="20"]');
    const full = canvasElement.querySelector('svg[width="96"]');
    await expect(simplified?.querySelectorAll("circle")).toHaveLength(0);
    await expect(full?.querySelectorAll("circle").length).toBeGreaterThan(0);
  },
};

/**
 * The colour contract: every stroke is `currentColor`, so the mark takes the colour of whatever
 * it is put inside and the component holds no palette of its own.
 *
 * Neither mark here carries a class — the colour comes from the parent, which is the shape a
 * caller gets for free when it drops the mark into a row of type that is already coloured. Gold
 * is the ribbon's and the first run's; dim is what it would wear beside a wordmark that is
 * already the loudest thing in its row.
 */
export const TakesItsColourFromTheParent: Story = {
  args: { size: 64 },
  parameters: { controls: { disable: true } },
  render: () => (
    <div className="flex items-center gap-8">
      <div className="text-accent">
        <GrimoireMark size={64} />
      </div>
      <div className="text-dim">
        <GrimoireMark size={64} />
      </div>
    </div>
  ),
};

/**
 * Two marks, one name.
 *
 * Hidden is the default because every surface that draws this sets the app's name in type beside
 * it — the caption's wordmark, the first run's heading — and a mark that named itself there
 * would announce the product name twice in a row. `label` is the exception, for a surface that
 * draws the mark **instead of** the words.
 *
 * Nothing about that is visible on a canvas, which is why the `play` counts the tree rather than
 * leaving a reader to look at two identical pictures.
 */
export const HiddenAndNamed: Story = {
  args: { size: 64 },
  parameters: { controls: { disable: true } },
  render: () => (
    <div className="flex items-center gap-8 text-accent">
      <GrimoireMark size={64} />
      <GrimoireMark size={64} label="MTG Grimoire" />
    </div>
  ),
  play: async ({ canvasElement }) => {
    // `width` rather than `viewBox` — see `WhatTheFloorDrops`, where the camel-cased attribute
    // silently matched nothing under jsdom.
    const marks = canvasElement.querySelectorAll('svg[width="64"]');
    await expect(marks).toHaveLength(2);

    // Two identical pictures, one graphic: the default is hidden outright, and only the second
    // is in the tree at all — under the app's name and not under "svg" or a file name.
    await expect(marks[0]).toHaveAttribute("aria-hidden", "true");
    const named = within(canvasElement).getAllByRole("img", { name: "MTG Grimoire" });
    await expect(named).toHaveLength(1);
  },
};
