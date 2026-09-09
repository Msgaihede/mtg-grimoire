import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UserEvent } from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openDropdown } from "@/test-dropdown";
import type { WishlistFolder } from "@/lib/ipc";

const wishlistFolderList = vi.hoisted(() => vi.fn());
const wishlistFolderCreate = vi.hoisted(() => vi.fn());
const wishlistFolderSummary = vi.hoisted(() => vi.fn());
// The panel mounts `useWishlistFolders()`, which reads `useMarketplace()` — the real hook here
// rather than a fake, so its own two queries need answers. Neither is ever asserted on; they only
// have to resolve so nothing sits on a rejected query for the life of a test.
const getMarketplace = vi.hoisted(() => vi.fn());
const marketplaceFeedStatus = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: {
    wishlistFolderList,
    wishlistFolderCreate,
    wishlistFolderSummary,
    getMarketplace,
    marketplaceFeedStatus,
  },
}));

import { useWishDestinationName, WishDestination } from "./WishDestination";

/**
 * The control's own accessible name, which is a whole sentence — the trigger's *content* is the
 * destination, so without one it would announce a folder name and nothing about what the folder
 * is for.
 */
const LABEL = "Wishlist folder to send to";

/**
 * A cabinet with **two drawers named `Someday` under different parents**, which is the fixture the
 * whole path rule exists for: a picker that drew bare names would list that word twice with
 * nothing telling a reader — or a `getByRole` — which is which.
 */
const ORDERED: WishlistFolder = { id: 1, parentId: null, name: "Ordered", sortOrder: 0 };
const DRAFT_NIGHT: WishlistFolder = { id: 2, parentId: 1, name: "Draft night", sortOrder: 0 };
const ORDERED_SOMEDAY: WishlistFolder = { id: 3, parentId: 1, name: "Someday", sortOrder: 1 };
const EXPENSIVE: WishlistFolder = { id: 4, parentId: null, name: "Expensive", sortOrder: 1 };
const EXPENSIVE_SOMEDAY: WishlistFolder = { id: 5, parentId: 4, name: "Someday", sortOrder: 0 };

/**
 * The flat rows, **deliberately not in the order the tree draws them**.
 *
 * An order assertion needs a fixture that disagrees, or it stays green over an implementation that
 * simply prints the rows it was handed: seeded this way, `folders.map(f => f.name)` answers
 * `Someday, Ordered, Expensive, Someday, Draft night` — five bare names in the wrong order — and
 * cannot pass as the tree's own depth-first walk by accident.
 */
const CABINET = [EXPENSIVE_SOMEDAY, ORDERED, EXPENSIVE, ORDERED_SOMEDAY, DRAFT_NIGHT];

/** What the cabinet above reads as, top to bottom, when the control is open. */
const ROWS = [
  "Wishlist",
  "Ordered",
  "Ordered / Draft night",
  "Ordered / Someday",
  "Expensive",
  "Expensive / Someday",
  "New folder…",
];

/** The folder a `New folder…` press makes in the tests below — filed in `Ordered`, so its path is
 *  two levels deep and a create that dropped the parent draws a different one. */
const PRERELEASE: WishlistFolder = { id: 6, parentId: 1, name: "Prerelease", sortOrder: 2 };

let client: QueryClient;

function Wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/**
 * The control as a call site holds it: `folderId` is the call site's own state, so a press has to
 * travel out through `onChange` and back in as a prop for anything on screen to move.
 *
 * `onPick` is the spy beside that, rather than in place of it — a test that only spied would never
 * see the trigger redraw, and a harness that only held state would never see what the caller was
 * told.
 */
function Harness({
  initial = null,
  onPick = () => {},
}: {
  initial?: number | null;
  onPick?: (folderId: number | null) => void;
}) {
  const [folderId, setFolderId] = useState<number | null>(initial);
  return (
    <WishDestination
      folderId={folderId}
      onChange={(next) => {
        setFolderId(next);
        onPick(next);
      }}
      label={LABEL}
    />
  );
}

function renderControl(
  props: { initial?: number | null; onPick?: (id: number | null) => void } = {},
) {
  return render(
    <Wrapper>
      <Harness {...props} />
    </Wrapper>,
  );
}

/** Open the control and wait for the cabinet to have arrived in it. */
async function openCabinet(user: UserEvent): Promise<void> {
  await openDropdown(user, LABEL);
  await screen.findByRole("option", { name: "Ordered" });
}

/** Open the control and press `New folder…`, leaving the panel up. */
async function openNewFolder(user: UserEvent): Promise<HTMLElement> {
  await openCabinet(user);
  await user.click(screen.getByRole("option", { name: "New folder…" }));
  return await screen.findByRole("textbox", { name: "Name" });
}

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  wishlistFolderList.mockReset().mockResolvedValue(CABINET);
  wishlistFolderCreate.mockReset().mockResolvedValue(PRERELEASE);
  wishlistFolderSummary.mockReset().mockResolvedValue([]);
  // `DEFAULT_MARKETPLACE`, so a test that does not care about the marketplace settles with no
  // observable change from that hook's own initial guess.
  getMarketplace.mockReset().mockResolvedValue("tcgplayer");
  marketplaceFeedStatus.mockReset().mockResolvedValue([]);
});

describe("WishDestination", () => {
  /**
   * The root is a **destination** rather than the absence of one, so `null` has to draw a row's
   * worth of words. Anchored, because `Dropdown` falls back to an em dash for a value that matches
   * nothing in its list — which would say the control has no destination at all.
   */
  it("opens on the root, which reads Wishlist", () => {
    renderControl();
    expect(screen.getByRole("button", { name: LABEL })).toHaveTextContent(/^Wishlist$/);
  });

  /**
   * The whole list in the order it is drawn: the root first wearing the word `cardMenu.tsx`
   * already uses, every folder by its full path in the tree's own depth-first order, and
   * `New folder…` last.
   *
   * One assertion rather than seven, because the claim is about the *list* — a row in the wrong
   * place is as wrong as a row that is missing, and {@link CABINET} is seeded in an order that
   * disagrees with this one.
   */
  it("lists the root, every folder by full path, and New folder…", async () => {
    const user = userEvent.setup();
    renderControl();
    await openCabinet(user);

    expect(screen.getAllByRole("option").map((row) => row.textContent)).toEqual(ROWS);
  });

  /**
   * The reason the rows are paths at all. Two drawers named `Someday` under different parents are
   * one row printed twice unless something disambiguates them, and a `DropdownOption` is a flat
   * row with one `label` — there is no indent for a reader to read.
   *
   * The third assertion is the one that can go red on a half-fix: a build that prefixed only
   * *some* rows would still satisfy the first two.
   */
  it("tells two folders sharing a name under different parents apart", async () => {
    const user = userEvent.setup();
    renderControl();
    await openCabinet(user);

    expect(screen.getByRole("option", { name: "Ordered / Someday" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Expensive / Someday" })).toBeInTheDocument();
    expect(screen.queryAllByRole("option", { name: "Someday" })).toHaveLength(0);
  });

  it("hands the picked folder's id to onChange", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    renderControl({ onPick });
    await openCabinet(user);

    await user.click(screen.getByRole("option", { name: "Expensive / Someday" }));

    expect(onPick).toHaveBeenCalledWith(EXPENSIVE_SOMEDAY.id);
    expect(screen.getByRole("button", { name: LABEL })).toHaveTextContent(/^Expensive \/ Someday$/);
  });

  /** `null` and not `"root"`: the caller's prop is a folder id or the root, and the sentinel this
   *  control speaks to `Dropdown` in must not leak out of it. */
  it("hands null to onChange when the root is picked", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    renderControl({ initial: ORDERED.id, onPick });
    await openCabinet(user);

    await user.click(screen.getByRole("option", { name: "Wishlist" }));

    expect(onPick).toHaveBeenCalledWith(null);
    expect(screen.getByRole("button", { name: LABEL })).toHaveTextContent(/^Wishlist$/);
  });

  /**
   * An id naming a folder this list does not carry — one another surface deleted between the two
   * reads — reads as the root, which is `buildFolderTree`'s own rule for a child whose parent is
   * missing, `EditWish`'s rule for the folder line on a wish, and what
   * {@link useWishDestinationName} answers. **Three readings of one id that must not disagree**,
   * or a dialog would name one destination in its picker and another in the sentence it prints
   * afterwards.
   */
  it("reads an id that names no folder as the root", async () => {
    const user = userEvent.setup();
    renderControl({ initial: 4_242 });
    await openCabinet(user);

    expect(screen.getByRole("button", { name: LABEL })).toHaveTextContent(/^Wishlist$/);
    expect(screen.getByRole("option", { name: "Wishlist" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  /**
   * **The departure from `cardMenu.tsx`, and the whole of why it is one.** There, with no folders
   * the offer collapses to a single action; here, making a folder without leaving the dialog *is*
   * the feature, so a control that hid itself until a folder existed could never be used to make
   * the first one.
   */
  it("offers New folder… even with an empty cabinet", async () => {
    const user = userEvent.setup();
    wishlistFolderList.mockResolvedValue([]);
    renderControl();
    await openDropdown(user, LABEL);
    await waitFor(() => expect(wishlistFolderList).toHaveBeenCalled());

    expect(screen.getAllByRole("option").map((row) => row.textContent)).toEqual([
      "Wishlist",
      "New folder…",
    ]);
  });

  it("puts the caret on the name field when the panel opens", async () => {
    const user = userEvent.setup();
    renderControl();

    // Asserted **before** anything is typed: `user.type` focuses whatever it is handed, so a test
    // that typed first would repair the very thing it is checking. `MoveToFolder` focuses its own
    // root on mount and cannot be told not to, so this is also the fence on the effect ordering
    // that lets the field win — nothing about it is visible in the markup.
    expect(await openNewFolder(user)).toHaveFocus();
  });

  /**
   * The press the whole feature is for: a name, a parent, and the folder becomes the destination
   * without the reader leaving the dialog.
   *
   * Three separate claims, and each fails on a different slip. The `toHaveBeenCalledWith` is what
   * catches a create that dropped the picked parent and filed at the root; `onPick` is what
   * catches a create that made the folder and did not file into it; and the trigger's text is what
   * catches the beat where the new folder is real but the list query has not caught up — the mock
   * deliberately goes on answering the old cabinet, so the path can only come from the folder the
   * write itself handed back.
   */
  it("creates at the picked parent and files there", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    renderControl({ onPick });
    await openNewFolder(user);

    await user.keyboard("Prerelease");
    await user.click(screen.getByRole("button", { name: "Ordered" }));

    // The caret comes back to the name, which is a fence rather than a nicety: `MoveToFolder`
    // draws `currentId` inert, so the row just pressed is `disabled` on the next render — and a
    // browser blurs an element it disables under the caret, which reaches this control's
    // outside-press guard as a `focusout` with a null `relatedTarget` and would close the panel on
    // the press that chose the parent. jsdom does not blur on disable, so what can be asserted
    // here is where the caret went, not the failure it prevents.
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "Create folder" }));

    await waitFor(() =>
      expect(wishlistFolderCreate).toHaveBeenCalledWith(ORDERED.id, "Prerelease"),
    );
    expect(onPick).toHaveBeenCalledWith(PRERELEASE.id);
    expect(screen.getByRole("button", { name: LABEL })).toHaveTextContent(
      /^Ordered \/ Prerelease$/,
    );
    expect(screen.queryByRole("textbox", { name: "Name" })).not.toBeInTheDocument();
  });

  /** A name is trimmed on the way out, so a trailing space makes `Prerelease` rather than a folder
   *  whose stored name disagrees with what is drawn beside it. */
  it("hands over the trimmed name", async () => {
    const user = userEvent.setup();
    renderControl();
    await openNewFolder(user);

    await user.keyboard("  Prerelease  {Enter}");

    await waitFor(() => expect(wishlistFolderCreate).toHaveBeenCalledWith(null, "Prerelease"));
  });

  /**
   * Whitespace is not a name — `wishlist_folders::valid_name` trims and refuses the empty
   * remainder at the far end, and this control refuses it before the round trip.
   *
   * **Three claims, and the third is the one that is not obvious.** The tick is greyed with
   * nothing and with spaces; Enter writes nothing; and the submit *handler* refuses too. That last
   * one needs its own event, and the reason is a jsdom finding worth writing down: implicit
   * submission is `keypress`'s `dispatchUIEvent(submitButton, 'click')` in user-event, and jsdom's
   * `HTMLButtonElement._activationBehavior` is guarded by `!isDisabled(this)` — so with the tick
   * greyed, Enter never reaches the form at all. The Enter assertion above is therefore a true
   * claim satisfied by the *first* guard, and the handler's own would sit unexercised behind it
   * (and would open silently the day somebody swaps `disabled` for `aria-disabled`). Submitting
   * the form directly is what states it. `FolderNameField.test.tsx` makes the same assertion under
   * a comment saying implicit submission does not ask the tick's permission; in jsdom it does.
   */
  it("refuses an empty or whitespace-only name and writes nothing", async () => {
    const user = userEvent.setup();
    renderControl();
    await openNewFolder(user);

    const tick = screen.getByRole("button", { name: "Create folder" });
    expect(tick).toBeDisabled();

    await user.keyboard("   ");
    expect(tick).toBeDisabled();

    await user.keyboard("{Enter}");
    expect(wishlistFolderCreate).not.toHaveBeenCalled();

    // Reached through the field rather than by role: what is being pinned is the handler, and
    // `closest` cannot be wrong about which element carries it.
    const form = screen.getByRole("textbox", { name: "Name" }).closest("form");
    expect(form, "the panel is a real <form>, which is what makes Enter submit it").not.toBeNull();
    fireEvent.submit(form as HTMLFormElement);
    expect(wishlistFolderCreate).not.toHaveBeenCalled();

    // And the panel is still up holding what was typed, rather than having quietly closed on a
    // press that did nothing.
    expect(screen.getByRole("textbox", { name: "Name" })).toBeInTheDocument();
  });

  /**
   * A refusal is reported in words and the destination is left exactly as it was: a press that
   * failed must not look like a press that worked.
   */
  it("reports a refused create and leaves the destination alone", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    wishlistFolderCreate.mockRejectedValue("The card database is busy finishing a sync.");
    renderControl({ onPick });
    await openNewFolder(user);

    await user.keyboard("Prerelease{Enter}");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not make the folder — The card database is busy finishing a sync.",
    );
    expect(onPick).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: LABEL })).toHaveTextContent(/^Wishlist$/);
    // The panel stays open holding the name, so the reader can press again rather than retype.
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Prerelease");
  });

  /**
   * A press on the panel's own words is not a press outside it.
   *
   * Pressing a non-focusable element moves the caret to the nearest focusable **ancestor**, and
   * without a landing pad inside the panel that is `<body>` — which reaches the control's
   * outside-press guard as a `focusout` with a null `relatedTarget`. The caption would dismiss the
   * panel mid-decision. `user-event` walks to the nearest focusable ancestor exactly as a browser
   * does, so this one *can* go red here, unlike the disable-blur above it.
   */
  it("survives a press on its own caption", async () => {
    const user = userEvent.setup();
    renderControl();
    await openNewFolder(user);

    await user.click(screen.getByText(/^Inside /));

    expect(screen.getByRole("textbox", { name: "Name" })).toBeInTheDocument();
  });

  /**
   * One rung for one decision. `Dropdown` drops its own `"inner"` registration on the press that
   * opens this panel, so the panel's is the only one on the stack — and the caret goes back to the
   * trigger, which is what every dismissible layer in this app promises. An element that
   * disappears with focus on it drops the caret to `<body>`, and the next Tab restarts from the
   * top of the app.
   */
  it("closes the panel on Escape and hands the caret back to the trigger", async () => {
    const user = userEvent.setup();
    renderControl();
    await openNewFolder(user);

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("textbox", { name: "Name" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: LABEL })).toHaveFocus();
  });
});

describe("useWishDestinationName", () => {
  const wrapper = Wrapper;

  it("answers null at the root", async () => {
    const { result } = renderHook(() => useWishDestinationName(null), { wrapper });
    await waitFor(() => expect(wishlistFolderList).toHaveBeenCalled());
    expect(result.current).toBeNull();
  });

  /**
   * **The folder's own name, never its path.** A call site writes `Sent. 4 wishes updated in
   * ${name}.`, and `…in Ordered / Someday.` is a file path read aloud. The dropdown is what
   * disambiguates two drawers sharing a name, and it has already done so by the time this sentence
   * is written — which is why the folder asked about here is one of the two `Someday`s.
   */
  it("answers the folder's own name, never its path", async () => {
    const { result } = renderHook(() => useWishDestinationName(ORDERED_SOMEDAY.id), { wrapper });
    await waitFor(() => expect(result.current).toBe("Someday"));
  });

  it("answers null for an id that names no folder any more", async () => {
    const { result } = renderHook(() => useWishDestinationName(4_242), { wrapper });
    await waitFor(() => expect(wishlistFolderList).toHaveBeenCalled());
    expect(result.current).toBeNull();
  });

  /**
   * A list that has not answered cannot say which drawer, so it says nothing — and a caller's
   * `name === null ? … : …` falls to the root sentence rather than printing a blank.
   *
   * The query is stood up on a promise that never settles, so this is a statement about the
   * pending state rather than a race that happens to be won today.
   */
  it("answers null while the folder list is still loading", () => {
    wishlistFolderList.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useWishDestinationName(ORDERED.id), { wrapper });
    expect(result.current).toBeNull();
  });
});
