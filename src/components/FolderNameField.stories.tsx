import type { ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Folder } from "lucide-react";
import { expect, fn, userEvent } from "storybook/test";
import { FOCUS } from "@/lib/focus";
import { cn } from "@/lib/utils";
import { FolderNameField } from "./FolderNameField";

/**
 * The wall both pages draw, at its real track — `minmax(180px,1fr)` with a `gap-2`. It is what
 * decides the field's width, and therefore the one thing worth seeing here that a centred canvas
 * would hide: a folder name is typed in a 180px-ish box with the ✓ and the ✕ already occupying
 * its top-right corner, so `pr-[4.125rem]` is the whole of what keeps a long name from running
 * underneath them.
 */
function Wall({ children }: { children: ReactNode }) {
  return (
    <div className="max-w-2xl bg-bg p-4">
      <ul
        aria-label="Folders"
        className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-2"
      >
        {children}
      </ul>
    </div>
  );
}

/**
 * **The host tile, and `relative` on it is not decoration.**
 *
 * The field's ✓ / ✕ pair is `absolute right-1 top-1`, and a `<form>` with no positioning of its
 * own establishes no containing block — deliberately, so the pair lands in the same corner on a
 * naming tile and on a renaming card, whose boxes are different heights. What that costs is that
 * the **host** has to be the positioned ancestor: drop `relative` here and the pair resolves
 * against whatever box up the tree happens to be positioned, which in a real page is the scroller
 * or the viewport, and the two answers land nowhere near the folder they answer for.
 *
 * `NewFolderCard` and both folder cards each carry it for exactly this reason. A story wrapper
 * that forgets it draws a component that looks broken and is not.
 */
function Slot({ children }: { children: ReactNode }) {
  return <li className="relative">{children}</li>;
}

/**
 * A folder card's footprint as a static stand-in — the class list copied from
 * `WishFolderCard`/`CollectionFolderCard`, minus the tooltip provider, the drop target and the
 * `ipc` round trip a real card would drag into a story about a form. It is here for one
 * comparison: a **rename** keeps the dash, because the thing being renamed is still a container,
 * and that only reads against a card that is not being renamed.
 *
 * **`NewFolderCard.stories.tsx` carries the other copy.** A CSF file cannot export a helper —
 * every non-default export is indexed as a story — so the two are kept in step by hand.
 */
function FolderTile({ name, face }: { name: string; face: string }) {
  return (
    <li className="relative rounded-xl">
      <button
        type="button"
        className={cn(
          "block w-full rounded-xl border border-dashed border-border p-2.5 pr-9 text-left",
          "transition-colors duration-150 hover:border-accent motion-reduce:transition-none",
          FOCUS,
        )}
      >
        <span className="flex items-center gap-2">
          <Folder className="size-3.5 flex-none text-dim" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-sm">{name}</span>
        </span>
        <span className="mt-1 block truncate text-xs tabular-nums text-dim">{face}</span>
      </button>
    </li>
  );
}

/** The figures line a rename keeps under the field, drawn exactly as the folder cards draw it. */
function Figures({ children }: { children: ReactNode }) {
  return <span className="mt-1 block truncate text-xs tabular-nums text-dim">{children}</span>;
}

const meta = {
  title: "Primitives/FolderNameField",
  component: FolderNameField,
  tags: ["autodocs"],
  args: {
    mode: "create",
    label: "New folder name",
    submitLabel: "Create folder",
    pending: false,
    onSubmit: fn(),
    onCancel: fn(),
  },
  parameters: {
    docs: {
      description: {
        component:
          "The one field that names a folder, drawn **as the tile itself** rather than in a strip " +
          "above the wall. Both the Collection and the Wishlist use it, for both jobs.\n\n" +
          "**What it replaced was a panel, and the panel's problem was that it was somewhere " +
          "else.** Both pages opened a bordered strip under the breadcrumb — a box with its own " +
          "edge, an input, `Create folder` and `Cancel` spelled out in words, and a line reading " +
          "*in Collection* to say which level the strip was about. Every one of those pieces " +
          "existed to re-establish a context the reader could already see. The tile says it by " +
          "being the tile: a name is typed on the line the folder's name will occupy, at the same " +
          "track and the same 62px footprint, and ✓ / ✕ take the corner a folder card already " +
          "gives its `⋯`.\n\n" +
          "**Two shapes, and the border is what tells them apart.** `create` is **solid**, " +
          "because the tile is still a control — a thing you press standing among things you " +
          "open, holding no folder yet. `rename` is **dashed**, because the thing being renamed " +
          "is already a container, and its figures line stays under the field so a reader " +
          "renaming *Trade binder* can still see it is the drawer holding 240 cards. Both wear " +
          "`border-accent` while the field is open, which is the whole of what says *this tile is " +
          "live*.\n\n" +
          "Enter is the `<form>`'s own implicit submission; the ✓ is its submit button, disabled " +
          "for a blank or whitespace-only name; blur off the whole form discards. **Escape is " +
          "deliberately not handled here** — the field is one arm of the page's `Panel`, so the " +
          "page's `\"inner\"` rung already closes it.\n\n" +
          "**Every story below wraps the field in a `relative` `<li>`, and that is load-bearing " +
          "rather than tidy**: the corner pair is `absolute` and the `<form>` establishes no " +
          "containing block of its own, so an unpositioned host sends the ✓ and the ✕ to whatever " +
          "ancestor happens to be positioned.",
      },
    },
  },
} satisfies Meta<typeof FolderNameField>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * **The create shape, first in the wall.** Solid-bordered against two dashed cards, at the same
 * track and the same floor — so pressing `New folder` swaps a control for a field and moves
 * nothing else on the page.
 *
 * The play walks the guard the tick exists for: blank is refused, a typed name wakes it up, and
 * what reaches the caller is **trimmed**. Class assertions rather than measurements, because this
 * file's plays also run under jsdom (`src/stories.test.tsx`), which lays nothing out.
 */
export const CreatingAFolder: Story = {
  render: (args) => (
    <Wall>
      <Slot>
        <FolderNameField {...args} />
      </Slot>
      <FolderTile name="Trade binder" face="240 cards · $1,304.00" />
      <FolderTile name="Standard staples" face="18 cards · $92.40" />
    </Wall>
  ),
  play: async ({ canvas, args }) => {
    const tick = canvas.getByRole("button", { name: "Create folder" });
    // A folder with no name is not a folder, and one called "   " draws as an empty tile a reader
    // cannot tell from a broken one.
    await expect(tick).toBeDisabled();

    await userEvent.type(canvas.getByRole("textbox", { name: "New folder name" }), "  Sideboard  ");
    await expect(tick).toBeEnabled();

    await userEvent.click(tick);
    await expect(args.onSubmit).toHaveBeenCalledWith("Sideboard");
  },
};

/**
 * **The rename shape, on a card that is already a drawer.** The dash stays — the app's word for
 * *container* does not stop applying because the name is being edited — and only its colour moves
 * to `border-accent`. The figures line stays under the field, which is how a reader checks they
 * have the right folder before they replace its name.
 *
 * On the canvas the field opens with the existing name **selected**: the commonest rename replaces
 * the word rather than edits inside it.
 */
export const RenamingAFolder: Story = {
  args: {
    mode: "rename",
    label: "Rename Trade binder",
    initial: "Trade binder",
    submitLabel: "Rename folder",
    footer: <Figures>240 cards · $1,304.00</Figures>,
  },
  render: (args) => (
    <Wall>
      <Slot>
        <FolderNameField {...args} />
      </Slot>
      <FolderTile name="Standard staples" face="18 cards · $92.40" />
    </Wall>
  ),
  play: async ({ canvas }) => {
    const box = canvas.getByRole("textbox", { name: "Rename Trade binder" }).closest("div");
    // Still a container, so still dashed — and lit, so the reader can see which card is live.
    await expect(box?.classList.contains("border-dashed")).toBe(true);
    await expect(box?.classList.contains("border-accent")).toBe(true);
    // The drawer goes on saying what is in it.
    await expect(canvas.getByText("240 cards · $1,304.00")).toBeInTheDocument();
  },
};

/**
 * **The write is in flight, and `pending` does two things.** The visible one is the greyed tick.
 * The one worth knowing about is that it also **suspends the blur discard**: a control that
 * disables itself on the press is blurred by the browser with no `relatedTarget` at all, which the
 * discard would otherwise read as the reader looking away — and would answer by cancelling the
 * write it had just started.
 */
export const WhileTheWriteIsInFlight: Story = {
  args: {
    mode: "rename",
    label: "Rename Trade binder",
    initial: "Trade binder",
    submitLabel: "Rename folder",
    pending: true,
    footer: <Figures>240 cards · $1,304.00</Figures>,
  },
  render: (args) => (
    <Wall>
      <Slot>
        <FolderNameField {...args} />
      </Slot>
      <FolderTile name="Standard staples" face="18 cards · $92.40" />
    </Wall>
  ),
  play: async ({ canvas }) => {
    // Greyed with a perfectly good name in the box, so it is `pending` doing it and not the
    // blank-name guard.
    await expect(canvas.getByRole("button", { name: "Rename folder" })).toBeDisabled();
    await expect(canvas.getByRole("textbox", { name: "Rename Trade binder" })).toHaveValue(
      "Trade binder",
    );
  },
};
