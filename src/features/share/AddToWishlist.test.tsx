/**
 * The want list — the one write in `src/features/share/`.
 *
 * What is being tested is a *destination* decision and a *count*, not a form: the rows are
 * already picked when this dialog opens, the folder is one the reader already has, and the
 * whole reason the dialog exists rather than being a single button is that a wish the reader
 * already made must not be added a second time in silence.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const wishlistAdd = vi.hoisted(() => vi.fn());
const wishlistFolderList = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { wishlistAdd, wishlistFolderList },
}));

import type { WishlistFolder } from "@/lib/ipc";
import type { ShareCard } from "@/lib/shareSnapshot";
import { AddToWishlist } from "./AddToWishlist";
import { EMPTY_INDEX, wishGrainKey, type OwnedIndex } from "./useOwnedIndex";

const card = (over: Partial<ShareCard> = {}): ShareCard => ({
  id: "bolt",
  n: "Lightning Bolt",
  s: "lea",
  cn: "161",
  f: "nonfoil",
  q: 1,
  fo: null,
  ...over,
});

const folder = (id: number, name: string, parentId: number | null = null): WishlistFolder => ({
  id,
  parentId,
  name,
  sortOrder: id,
});

/**
 * An index holding one wish for `cardId`.
 *
 * **Two maps, because the dialog asks two different questions of them.** `wanted` is card-level
 * and answers *do I want this at all* — the figure under the tile. `wishes` is the **row**, keyed
 * on `wishlist_add`'s real fold grain, and is the only thing that entitles the word *raises*.
 * `at: null` therefore means "the reader wants this card, but not as a line this press could fold
 * onto" — a wish in another drawer, or in another finish — which is the ordinary case and the one
 * a card-level count would get wrong.
 */
const wanting = (
  cardId: string,
  quantity: number,
  at: { finish?: string | null; folderId?: number | null } | null = null,
): OwnedIndex => ({
  owned: new Map(),
  wanted: new Map([[cardId, quantity]]),
  wantedByName: new Map(),
  wishes:
    at === null
      ? new Map()
      : new Map([[wishGrainKey(cardId, at.finish ?? null, at.folderId ?? null), quantity]]),
});

function mount(
  props: Partial<Parameters<typeof AddToWishlist>[0]> = {},
): { onAdded: ReturnType<typeof vi.fn>; onClose: ReturnType<typeof vi.fn> } {
  const onAdded = vi.fn();
  const onClose = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AddToWishlist
        open
        cards={[card()]}
        index={EMPTY_INDEX}
        onClose={onClose}
        onAdded={onAdded}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { onAdded, onClose };
}

/** The one press this dialog exists for, whatever the count on it reads. */
const addButton = () => screen.getByRole("button", { name: /^Add \d+ card/ });

beforeEach(() => {
  vi.clearAllMocks();
  wishlistFolderList.mockResolvedValue([folder(1, "Trade targets"), folder(2, "Someday")]);
  wishlistAdd.mockResolvedValue({ id: 1, quantity: 1, removed: false });
});

describe("adding picked rows from somebody else's binder", () => {
  it("adds the ticked rows to an existing wishlist folder", async () => {
    const user = userEvent.setup();
    const { onAdded, onClose } = mount({
      cards: [card(), card({ id: "sol", n: "Sol Ring", s: "c21", cn: "263" })],
    });

    await screen.findByRole("option", { name: "Trade targets" });
    await user.selectOptions(screen.getByLabelText("Add them to"), "1");
    await user.click(addButton());

    await waitFor(() => expect(wishlistAdd).toHaveBeenCalledTimes(2));
    // One wish per picked copy, pinned to the printing that is in *their* binder — the snapshot
    // carries no oracle id, so an any-printing wish is not expressible from here at all.
    expect(wishlistAdd).toHaveBeenCalledWith({ cardId: "bolt", quantity: 1, folderId: 1 });
    expect(wishlistAdd).toHaveBeenCalledWith({ cardId: "sol", quantity: 1, folderId: 1 });
    // The report names the destination the reader chose, and the host closes the dialog.
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith("Added 2 cards to Trade targets."));
    expect(onClose).toHaveBeenCalled();
  });

  it("offers only folders that already exist, and does not create one", async () => {
    mount();

    await screen.findByRole("option", { name: "Trade targets" });
    const destination = screen.getByLabelText("Add them to");
    // The root plus the two folders the reader has, and nothing else — no *New folder* row, no
    // name box, and no button that would mint one. Spec decision 8 files into a folder the
    // reader already has, and building the other half here would be a second folder-creating
    // surface with no cabinet around it.
    expect(
      within(destination)
        .getAllByRole("option")
        .map((o) => o.textContent?.trim()),
    ).toEqual(["Your wishlist", "Trade targets", "Someday"]);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /new folder/i })).toBeNull();
  });

  it("counts what the reader already wants so a second add is not silent", async () => {
    mount({
      cards: [card(), card({ id: "sol", n: "Sol Ring", s: "c21", cn: "263" })],
      // Wanted, and wanted **at the root** — which is where this dialog opens, so the press
      // really does fold onto the line that is already there.
      index: wanting("bolt", 2, { folderId: null }),
    });

    // The card that is already on the list says so on its own row…
    expect(
      within(screen.getByRole("listitem", { name: /^Lightning Bolt/ })).getByText(
        "Already wanted: 2",
      ),
    ).toBeInTheDocument();
    // …and the one that is not says nothing, rather than "Already wanted: 0".
    expect(
      within(screen.getByRole("listitem", { name: /^Sol Ring/ })).queryByText(/Already wanted/),
    ).toBeNull();
    // And the dialog says out loud what the press will do, naming the destination it will do it
    // to — the one number in this dialog that is entitled to the word *raises*.
    expect(
      screen.getByText(
        "1 of these already has a line in your wishlist — adding raises it.",
      ),
    ).toBeInTheDocument();
  });

  /**
   * ⚠️ **The sentence is about the *destination*, and it has to move when the destination does.**
   *
   * `wishlist_add` folds on four terms and `folder_id` is one of them, so a wish sitting at the
   * root is a **brand-new line** the moment the reader files this one in `Trade targets`. A
   * dialog that counted card-level wants would print "adding raises it" over a press that was
   * about to make a second row — the one number it exists to get right, wrong, and wrong without
   * moving when the reader changed their mind.
   */
  it("stops promising a fold when the reader picks a different folder", async () => {
    const user = userEvent.setup();
    mount({ cards: [card()], index: wanting("bolt", 2, { folderId: null }) });

    await screen.findByRole("option", { name: "Trade targets" });
    expect(screen.getByText(/adding raises it\./)).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Add them to"), "1");

    expect(screen.queryByText(/adding raises/)).toBeNull();
    expect(
      screen.getByText(
        "1 is on your wishlist under a different folder or finish, so it gets a line of its own.",
      ),
    ).toBeInTheDocument();
    // The row's own figure does **not** move, and that is the other half of the distinction: it
    // says what the reader wants, which is true wherever they file this one.
    expect(
      within(screen.getByRole("listitem", { name: /^Lightning Bolt/ })).getByText(
        "Already wanted: 2",
      ),
    ).toBeInTheDocument();
  });

  /** The same divergence on the grain's third term: a wish for the nonfoil is not the wish a
   *  picked foil copy writes, however loudly the card-level count agrees. */
  it("does not promise a fold onto a wish in another finish", async () => {
    mount({
      cards: [card({ f: "foil" })],
      index: wanting("bolt", 1, { finish: null, folderId: null }),
    });

    expect(screen.queryByText(/adding raises/)).toBeNull();
    expect(screen.getByText(/gets a line of its own/)).toBeInTheDocument();
  });

  it("draws no figure at all for a card the reader wants none of", async () => {
    // ⚠️ **`Already wanted: 0` is the shape this is fencing against**, and it matters most in the
    // state that produces it for a second reason: `EMPTY_INDEX` is what an unfinished — or
    // refused — sweep leaves behind, and every card answers *wanted 0* against it. A row drawn
    // with a zero there would be a confident lie about a card the reader may own four of. Saying
    // nothing is the honest answer to both, and `SharedPage` gates the tick on `figuresReady`
    // besides, which is where that half is tested.
    mount({ cards: [card()], index: EMPTY_INDEX });

    await screen.findByRole("option", { name: "Trade targets" });
    expect(screen.queryByText(/Already wanted/)).toBeNull();
    expect(screen.queryByText(/adding raises/)).toBeNull();
    expect(screen.queryByText(/on your wishlist under a different folder/)).toBeNull();
  });

  it("files at the root when the reader picks no folder", async () => {
    const user = userEvent.setup();
    mount();

    await screen.findByRole("option", { name: "Trade targets" });
    await user.click(addButton());

    await waitFor(() => expect(wishlistAdd).toHaveBeenCalledTimes(1));
    // `null` and never an absent key: this dialog has a cabinet on screen and *the root* is a
    // destination the reader chose, which is what `WishInput.folderId`'s two absences mean.
    expect(wishlistAdd).toHaveBeenCalledWith({ cardId: "bolt", quantity: 1, folderId: null });
  });

  it("carries a foil copy's finish and leaves a nonfoil one unmarked", async () => {
    const user = userEvent.setup();
    mount({
      cards: [card({ id: "foilbolt", f: "foil" }), card({ id: "plain", n: "Shock" })],
    });

    await screen.findByRole("option", { name: "Trade targets" });
    await user.click(addButton());

    await waitFor(() => expect(wishlistAdd).toHaveBeenCalledTimes(2));
    // A wish *for the foil* is a different wish and is not filled by the nonfoil, so the finish
    // travels. `nonfoil` goes unmarked — this app's rule everywhere, and here it is the
    // difference between no preference and a preference the reader never expressed.
    expect(wishlistAdd).toHaveBeenCalledWith({
      cardId: "foilbolt",
      quantity: 1,
      folderId: null,
      preferredFinish: "foil",
    });
    expect(wishlistAdd).toHaveBeenCalledWith({ cardId: "plain", quantity: 1, folderId: null });
  });

  it("reports how many landed when the backend refuses part way", async () => {
    const user = userEvent.setup();
    wishlistAdd
      .mockResolvedValueOnce({ id: 1, quantity: 1, removed: false })
      .mockRejectedValueOnce("The card database is busy finishing a sync.");
    const { onAdded, onClose } = mount({
      cards: [card(), card({ id: "sol", n: "Sol Ring", s: "c21", cn: "263" })],
    });

    await screen.findByRole("option", { name: "Trade targets" });
    await user.click(addButton());

    // The refusal names what got through, because the reader's list really did move.
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /Added 1 of 2 cards\. The card database is busy/,
    );
    // Nothing is reported as done and the dialog stays open: the reader has a list in front of
    // them that is now half added, and closing over it would hide which half.
    expect(onAdded).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  /**
   * ⚠️ **The other half of the fold key, and the half no other test here reaches.** The tests
   * above use one printing per finish or two printings at one finish, so a key of `card.id`
   * alone passes every one of them — and would fold a foil and a nonfoil copy of one printing
   * into a single wish, which is the wish the reader did not ask for and the one the foil
   * cannot fill.
   */
  it("keeps two finishes of one printing as two wishes", async () => {
    const user = userEvent.setup();
    mount({ cards: [card({ f: "nonfoil" }), card({ f: "foil" })] });

    await screen.findByRole("option", { name: "Trade targets" });
    expect(addButton()).toHaveAccessibleName("Add 2 cards");
    await user.click(addButton());

    await waitFor(() => expect(wishlistAdd).toHaveBeenCalledTimes(2));
    expect(wishlistAdd).toHaveBeenCalledWith({ cardId: "bolt", quantity: 1, folderId: null });
    expect(wishlistAdd).toHaveBeenCalledWith({
      cardId: "bolt",
      quantity: 1,
      folderId: null,
      preferredFinish: "foil",
    });
  });

  it("folds two picked copies of one printing and finish into a single wish", async () => {
    const user = userEvent.setup();
    mount({
      // The same printing in two of the publisher's drawers is two rows of their binder and one
      // card on a want list.
      cards: [card({ fo: "drawer-a" }), card({ fo: "drawer-b" })],
    });

    await screen.findByRole("option", { name: "Trade targets" });
    await user.click(addButton());

    await waitFor(() => expect(wishlistAdd).toHaveBeenCalledTimes(1));
    expect(addButton()).toHaveAccessibleName("Add 1 card");
  });
});
