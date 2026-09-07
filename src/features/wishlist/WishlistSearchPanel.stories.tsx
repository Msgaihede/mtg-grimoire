import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { TOOLTIP_OPEN_MS } from "@/components/tooltip/TooltipProvider";
import { buildFolderTree } from "@/lib/folderTree";
import { WishlistSearchPanel } from "./WishlistSearchPanel";
import { useWishlistFolders } from "./useWishlistFolders";

/**
 * The panel, with the one thing the page owns and hands down: **which drawer the reader is
 * standing in.**
 *
 * The cabinet itself comes off `useWishlistFolders`, mounted here rather than hand-copied, for
 * `DeckSearchPanel.stories.tsx`'s reason one page over: a story that wrote its own folder list
 * would be asserting against ids the fake's database does not have, and the tree is
 * `buildFolderTree(folders, [])` — the page's own call, with **no members**, because a picker is a
 * list of destinations rather than a picture of what is in them.
 *
 * `folderId` is an arg because it is the whole subject: it is `useWishlist`'s own `useState`, a
 * live fact about the page, and every story below is a statement about what a press does with it.
 */
function Panel({
  folderId,
  roomy = true,
  maxWidth,
}: {
  folderId: number | null;
  roomy?: boolean;
  maxWidth?: number;
}) {
  const folders = useWishlistFolders();
  const nodes = buildFolderTree(folders.folders, []);
  const names = new Map(folders.folders.map((f) => [f.id, f.name]));
  return (
    <WishlistSearchPanel
      folderId={folderId}
      folderNodes={nodes}
      // The page's own `folderNameOf`: `Wishlist` at the root, which is a real destination rather
      // than "no folder", and `null` for a folder this list no longer carries.
      folderName={(id) => (id === null ? "Wishlist" : (names.get(id) ?? null))}
      roomy={roomy}
      maxWidth={maxWidth}
    />
  );
}

/**
 * The panel's disclosure — **a pattern, because its name says what pressing it does** and
 * therefore changes with the state: `Collapse card search` open, `Expand card search` railed. The
 * `$` anchor keeps it off the drag handle's `Resize card search`.
 */
const PANEL_TOGGLE = /card search$/;

/**
 * The card every play below presses the `+` on, and **why a play has to name one at all.**
 *
 * A wall of art draws one quick-add per tile, so `/^Add .+ to Wishlist$/` is a question with as
 * many honest answers as there are tiles — the corpus's default browse is 37 of them. Naming the
 * card is what makes the query about one press; `getAllBy…[0]` would instead pin whichever
 * printing the corpus happens to sort first and would follow a fixture change in silence.
 *
 * `Ancient Tomb` is the row `Decks/SearchPanel`'s own `Docked` play reaches for, so the two docked
 * panels are asserted against one card. The set and number are left open — the assertion is about
 * the *destination* the button names, and `TMP 315` is a fact about the fixture rather than about
 * this panel.
 */
const CARD = "Ancient Tomb";

/** That card's quick-add, by the destination it promises. One tile, one button, no ambiguity. */
const plusFor = (destination: string) =>
  new RegExp(`^Add ${CARD} \\(.+\\) to ${destination}$`);

const meta = {
  title: "Wishlist/SearchPanel",
  component: Panel,
  tags: ["autodocs"],
  args: { folderId: null, roomy: true },
  render: (args) => <Panel key={`${String(args.folderId)}:${String(args.roomy)}`} {...args} />,
  decorators: [
    // The panel is a flex column with `min-h-0`, so it needs a parent with a height or its wall has
    // none — and a flex row, because that is the row it shares with the wishlist. 384px is the
    // panel's own opening width; the 36px beside it is what its rail collapses to, so both states
    // fit the same box.
    (Story) => (
      <div className="flex h-[640px] w-[420px] justify-end">
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "The path by which a card a reader wants gets onto the shopping list **from the page " +
          "that shows the list** — and the sentence it closes is the wishlist's own empty state, " +
          "which used to read *“Add cards from search with the + on any row or tile”* and sent " +
          "the reader to another route to do it.\n\n" +
          "**Not a second search.** It is `useCardSearch` + `FilterBar` + `CardGrid` — the search " +
          "view's own parts — in a draggable column, through the shared `CardSearchPanel` " +
          "(the chrome) and `CardSearchBody` (the wall). The collection's sidebar is the same " +
          "two components with three strings changed; what is this panel's own is the " +
          "**destination**.\n\n" +
          "**The destination is the page, not a choice** (spec §2.2). `AddToCollectionButton` " +
          "carries a Collection / Wishlist switch on the search page, where a reader genuinely " +
          "is choosing between two lists; here the page has already answered, so `lockMode` " +
          "pins it and the chips are not drawn — a switch that could flip lists mid-form would " +
          "need two folder defaults and a picker that swapped trees under the reader's hand.\n\n" +
          "**And it files into the drawer on screen.** Every `+` in the app filed at the root " +
          "until 2026-09-07, because this button had never been given a folder — so a reader " +
          "filing a binder left it, searched, filed at the root, came back and moved what they " +
          "had just filed. The button's name states the destination before the press " +
          "(`Add Lightning Bolt (LEA 161) to Ordered`), which is `DeckSearchPanel`'s own rule " +
          "(`Add Ancient Tomb to Land`) applied, and the popup's Folder row is how one card goes " +
          "somewhere else without leaving the drawer.\n\n" +
          "**No tab strip**, where the deck's panel has two. `Collection` there searches the " +
          "cards you already have, because a deck is built out of them; on a wishlist that is a " +
          "list the reader is not filling. Being the `All cards` tab and nothing else also gives " +
          "back the 141px the strip costs at the panel's 206px floor.\n\n" +
          "Driven end to end by `.storybook/fake/`: the wall is `search_cards` over the seeded " +
          "corpus, the folders are `starterWishFolders`, and the `+` writes through " +
          "`wishlist_add`.\n\n" +
          "**A fixture of the page, not a dismissible layer.** It registers no Escape rung, so a " +
          "press in here falls past it to the page's own floor, which walks one folder up. The " +
          "way to put it away — and to get it back — is the disclosure it names itself by " +
          "({@link Railed}), and it remembers which way it was left across restarts " +
          "(`app_meta.search_open`).\n\n" +
          "**No drag story here.** Every tile is a drag source carrying two marks — `dnd.ts`'s, " +
          "so it still reaches a deck category, and `searchCardDrag.ts`'s, which is what a folder " +
          "card reads — but Storybook runs in an ordinary browser with no WRY OLE drop target, " +
          'while the shipped window depends on `"dragDropEnabled": false`. A green drag here ' +
          "would prove nothing about the real app; that is the live pass's.",
      },
    },
  },
} satisfies Meta<typeof Panel>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The column at rest, at the root — **the state every reader arrives at**, since the wishlist opens
 * on its cabinet and nobody is standing in a drawer yet.
 *
 * The destination is therefore the list's own name rather than "no folder", which is the whole of
 * `folderId: null` being a real place: the breadcrumb calls the top level `Wishlist` and so does
 * the button.
 *
 * The wall's tile floor is 150px rather than the standard 170, which is what makes this column two
 * tiles wide instead of one — `CardSearchBody`'s `TILE_BASE` carries the measurement.
 */
export const WithSearch: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const panel = canvas.getByRole("region", { name: "Add cards to your wishlist" });
    // **Railed at rest** — a database nobody has expressed a preference in rails this column
    // (`DEFAULT_SEARCH_OPEN`), because the page already draws a `FilterBar` of its own and below
    // 544px the panel is an overlay rather than a rail. Measured at seven widths in the shipped
    // window on 2026-09-07. So the play presses the way a first-time reader does.
    await userEvent.click(within(panel).getByRole("button", { name: PANEL_TOGGLE }));
    await expect(
      await within(panel).findByRole("button", { name: PANEL_TOGGLE }),
    ).toHaveAttribute("aria-expanded", "true");

    // The `+` on a tile names the card, the printing **and** where pressing it would file — the
    // one part of the press a screenshot cannot show. Asked of one card, because a wall draws one
    // of these per tile — see {@link CARD}.
    const add = await within(panel).findByRole("button", { name: plusFor("Wishlist") });
    await userEvent.click(add);

    // Locked to the wishlist: the Collection / Wishlist chips are not drawn at all, and the form's
    // own button says which list it writes to.
    await expect(canvas.queryByRole("group", { name: "Add to" })).toBeNull();
    await expect(
      await canvas.findByRole("button", { name: "Add to wishlist" }),
    ).toBeInTheDocument();
    // And the Folder row is the way one card goes somewhere else without leaving this drawer.
    await expect(
      canvas.getByRole("button", { name: /^Change folder for / }),
    ).toBeInTheDocument();
  },
};

/**
 * Standing in a drawer — the case the whole feature exists for.
 *
 * `Ordered` is `starterWishFolders`' first folder. Nothing about the wall changes; what changes is
 * the sentence on every `+`, which is the point: the reader can read where the card is going
 * before they press, from the tile they are looking at.
 */
export const InAFolder: Story = {
  args: { folderId: 1 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const panel = canvas.getByRole("region", { name: "Add cards to your wishlist" });
    // Railed at rest — see {@link WithSearch}. The body is unmounted rather than hidden, so no
    // tile exists to carry a `+` until this press.
    await userEvent.click(within(panel).getByRole("button", { name: PANEL_TOGGLE }));

    await expect(
      await within(panel).findByRole("button", { name: plusFor("Ordered") }),
    ).toBeInTheDocument();
  },
};

/**
 * The panel dragged to its floor, **206px**, which is the width every control in `FilterBar` has to
 * survive.
 *
 * The failure this story exists for is an **overhang**: a flex item cannot shrink below its own
 * min-content, and this page scrolls inside `AppShell`'s `main` — which computes `overflow-x` to
 * `auto` — so a control that will not fit puts a horizontal scrollbar across the whole app.
 * `ManaValueChips` shipped exactly that once, at 25px, invisible to both suites and to a
 * screenshot.
 *
 * **Storybook is a real browser, so this is the one place the arithmetic is real**: the suite has
 * no layout engine and can only pin classes. The header row, the filter row and the panel itself
 * are each read off the box.
 *
 * `maxWidth` is the page's own cap and is what pins the panel here; in the app it is
 * `min(half the window, what the row can spare over LIST_FLOOR)`.
 */
export const Narrow: Story = {
  args: { maxWidth: 206 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const panel = canvas.getByRole("region", { name: "Add cards to your wishlist" });
    const toggle = within(panel).getByRole("button", { name: PANEL_TOGGLE });

    // Drawn and reachable — the layout is an answer about width, never a control being dropped.
    await expect(toggle).toBeVisible();

    // Railed at rest — see {@link WithSearch} — and this story is about what the *open* panel
    // measures at its floor. The disclosure is the same element across the press, so the row read
    // off it below is the same box either way.
    await userEvent.click(toggle);

    const row = toggle.parentElement!;
    await expect(row.scrollWidth).toBe(row.clientWidth);
    await expect(panel.scrollWidth).toBe(panel.clientWidth);

    // And again once the filter row has drawn its own contents, which is the state this width is
    // most likely to break in.
    const filters = await within(panel).findByRole("button", { name: /^Show filters/ });
    await expect(filters.parentElement!.scrollWidth).toBe(filters.parentElement!.clientWidth);
    await expect(panel.scrollWidth).toBe(panel.clientWidth);
  },
};

/**
 * The column put away — **36px of rail with its heading turned on its side**, and the state a
 * reader who is reading their list rather than adding to it wants.
 *
 * `roomy: false` is the *measured* refusal rather than the press: the page's row cannot hold the
 * list's floor and a 206px column at once, so the disclosure is `aria-disabled` and says why. It
 * is deliberately **not** the `disabled` attribute — a control that cannot do the thing it names
 * has to stay in the tab order, or the caret has nowhere to be put when the room comes back.
 *
 * The reader's own choice is untouched by this: a panel they had opened is *hidden* rather than
 * unmounted, so their typed query and filters are still there when the width returns. A panel
 * nobody has opened is still mounted-as-nothing, which is what keeps this state free — and it is
 * the arm this story is, because `roomy` is an arg and the wrapper is keyed on it.
 *
 * **Below this width the panel is not refused at all**, and that is the door out of the rail: the
 * page hands it `overWidth` and it draws *over* the list. On a phone that is the difference
 * between a sidebar that exists and one that is only ever a greyed chevron.
 */
export const Railed: Story = {
  args: { roomy: false },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const panel = canvas.getByRole("region", { name: "Add cards to your wishlist" });
    const toggle = within(panel).getByRole("button", { name: PANEL_TOGGLE });

    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(toggle).toHaveAttribute("aria-disabled", "true");
    // Reachable, which is the whole point of not using `disabled`.
    await expect(toggle).toBeEnabled();

    // The reason is a hover away — a description of an already-named control, so it is
    // `describes: true` by default and the panel carries `role="tooltip"`.
    await userEvent.hover(toggle);
    await waitFor(
      async () =>
        expect(await canvas.findByRole("tooltip")).toHaveTextContent(
          "Not enough room — close the card details or widen the window",
        ),
      { timeout: TOOLTIP_OPEN_MS + 1000 },
    );
    await userEvent.unhover(toggle);

    // And the press is recorded and does nothing, rather than being swallowed by the browser.
    await userEvent.click(toggle);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
  },
};
