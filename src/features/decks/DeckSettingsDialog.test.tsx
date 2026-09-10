import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import type {
  DeckCard,
  DeckCategory,
  DeckDetail,
  DeckFolder,
  DeckPullRow,
  DeckRow,
  FormatSpec,
} from "@/lib/ipc";
import { cardImageUrl } from "@/lib/images";
import { isWebTarget } from "@/pwa/target";
import { openDropdown, pickOption } from "@/test-dropdown";
import { card, spec } from "./validation/fixtures";

/** Which build the cover frame thinks it is in. `isWebTarget()` reads `__CORE__`, a build-time
 *  constant vitest fixes at `"tauri"`, so the web answer cannot be arranged any other way — see
 *  `src/pwa/target.ts`. Desktop unless a case says otherwise. */
vi.mock("@/pwa/target", () => ({ isWebTarget: vi.fn(() => false) }));

const deckGet = vi.hoisted(() => vi.fn());
const deckUpdate = vi.hoisted(() => vi.fn());
const deckSetFolder = vi.hoisted(() => vi.fn());
const deckFolderList = vi.hoisted(() => vi.fn());
const formatSpecs = vi.hoisted(() => vi.fn());
const deckClear = vi.hoisted(() => vi.fn());
const deckPullPlan = vi.hoisted(() => vi.fn());
const deckPullFromCollection = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: {
    deckGet,
    deckUpdate,
    deckSetFolder,
    deckFolderList,
    formatSpecs,
    deckClear,
    deckPullPlan,
    deckPullFromCollection,
  },
}));

import { DeckSettingsDialog } from "./DeckSettingsDialog";

/** A deck with a cover whose artist is known, which is the only kind that is drawn at all. */
const BURN: DeckRow = {
  gameKey: "any",
  id: 4,
  name: "Burn",
  formatKey: "modern",
  formatName: "Modern",
  description: "Twenty damage, quickly.",
  coverCardId: "c-Lightning Bolt",
  coverKind: "card_art",
  coverArtist: "Christopher Rush",
  archived: false,
  cardCount: 60,
  updatedAt: 1_800_000_000,
  folderId: null,
  notesOpen: false,
  theoryEnabled: false,
  virtualOnly: false,
  theoryMarkExact: true,
  theoryMarkName: true,
  theoryMarkUnplanned: true,
  lastVariant: "live",
  lastGroupBy: "category",
  lastSortBy: "alphabetical",
  separateXGroup: false,
  tokensOpen: false,
  statsOpen: true,
  defaultCategoryId: 0,
  bracket: 0,
};

const SPECS: FormatSpec[] = [spec("modern"), spec("commander"), spec("casual")];

const FOLDERS: DeckFolder[] = [
  { id: 1, parentId: null, name: "Commander", sortOrder: 0 },
  { id: 2, parentId: 1, name: "Legends", sortOrder: 0 },
];

/**
 * The deck's piles, in `sortOrder` — what the "Add cards to" select is built from.
 *
 * Two of them, which is the least that can show the order is the deck's rather than the
 * alphabet's: `Sideboard` before `Combo pieces`.
 */
const CATEGORIES: DeckCategory[] = [
  { id: 11, name: "Sideboard" },
  { id: 12, name: "Combo pieces" },
].map((c, i) => ({
  deckId: 4,
  kind: "main" as const,
  origin: "user" as const,
  isActive: true,
  sortOrder: i,
  cardCount: 0,
  totalPrice: null,
  cardCountAllVariants: 0,
  ...c,
}));

/** The deck the dialog reads, with whatever this test needs changed about it. */
function detail(deck: Partial<DeckRow> = {}, cards: DeckCard[] = []): DeckDetail {
  return { deck: { ...BURN, ...deck }, cards, categories: CATEGORIES, labels: [] };
}

/**
 * A deck with a plan, whose two lists hold **different** numbers of cards.
 *
 * That difference is the whole point of the fixture. `cardCount` is the copies in the variant
 * that was asked for — the dialog reads `live` — and `cardCountAllVariants` is both lists
 * together, so live is `4 + 3 = 7` and the plan is `(10 + 5) − 7 = 8`. With the two equal, a
 * confirmation handed the wrong one of them draws exactly the same sentence as one handed the
 * right one, and every case below would pass against a host that had them the wrong way round.
 */
function withPlan(): DeckDetail {
  return {
    ...detail({ theoryEnabled: true }),
    categories: [
      { ...CATEGORIES[0], cardCount: 4, cardCountAllVariants: 10 },
      { ...CATEGORIES[1], cardCount: 3, cardCountAllVariants: 5 },
    ],
  };
}

/**
 * One row of the pull plan: a printing this deck is short of, with a loose copy that could fill
 * it.
 *
 * **The whole plan is one row deep on purpose.** This host draws none of the plan's contents —
 * `PullFromCollectionDialog` does, and its own suite is where a row's sources, its shortfall and
 * its picker are pinned. What is on trial here is a *count*: whether there is anything to import
 * at all, which is the only thing about the plan this file's button reads.
 */
function pullRow(over: Partial<DeckPullRow> = {}): DeckPullRow {
  return {
    cardId: "c-Lightning Bolt",
    name: "Lightning Bolt",
    setCode: "2x2",
    collectorNumber: "117",
    finish: null,
    short: 3,
    categories: ["Sideboard"],
    imageUris: null,
    candidates: [
      {
        entryId: 11,
        quantity: 3,
        folderId: null,
        folderName: null,
        folderKind: null,
        condition: "NM",
        lang: "en",
        altered: false,
        signed: false,
        proxy: false,
        misprint: false,
        grading: null,
        serialNumber: null,
      },
    ],
    ...over,
  };
}

function wrap(ui: ReactElement) {
  // No retries: a test that mocks a refusal should see it on the first answer, not after
  // three, and TanStack's default would otherwise stall every failing-write assertion.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

/** The dialog, open, with the two callbacks a caller owns. */
function open(props: Partial<Parameters<typeof DeckSettingsDialog>[0]> = {}) {
  const onDismiss = vi.fn();
  const onClose = vi.fn();
  const view = wrap(
    <DeckSettingsDialog deckId={4} open onDismiss={onDismiss} onClose={onClose} {...props} />,
  );
  return { onDismiss, onClose, ...view };
}

/**
 * The dialog, once the deck it is about has arrived.
 *
 * It waits on a **field** and not on the dialog: the panel is on screen from the first render,
 * carrying "Reading the deck…" and nothing else, so a helper that waited for the dialog would
 * hand every test below an empty frame and fail on the first query.
 */
async function loaded() {
  await screen.findByLabelText("Name");
  return screen.getByRole("dialog", { name: "Deck settings" });
}

beforeEach(() => {
  vi.clearAllMocks();
  // A restore rather than a reset: `clearAllMocks` wipes the implementation a
  // `vi.fn(() => false)` was created with, so without this every case after the first reads
  // `undefined` and the whole file quietly runs on the web branch.
  vi.mocked(isWebTarget).mockReturnValue(false);
  deckGet.mockResolvedValue(detail());
  deckUpdate.mockImplementation((_id: number, patch: Record<string, unknown>) =>
    Promise.resolve({ ...BURN, ...patch }),
  );
  deckSetFolder.mockResolvedValue(BURN);
  deckFolderList.mockResolvedValue(FOLDERS);
  formatSpecs.mockResolvedValue(SPECS);
  // `deck_clear` answers the copies it removed, never a row count — see `ipc.deckClear`.
  deckClear.mockResolvedValue(7);
  // A deck with something to import, since that is the state every control on the section is
  // drawn in; the empty plan is the case a test asks for by name.
  deckPullPlan.mockResolvedValue([pullRow()]);
  deckPullFromCollection.mockResolvedValue({ copies: 3, cards: 1 });
});

/**
 * **The chrome is `Dialog`'s now, and the cases below that touch it are here on purpose.**
 * The shell's own contract — closed mounts nothing, Escape, the scrim press, the modal role, the
 * ✕'s label — is pinned once in `Dialog.test.tsx`, against a body that is only a body. What
 * is left here is what only this host can say: that it wires `onDismiss` and `onClose` through,
 * that a closed dialog costs no `deck_get`, and that the trap holds over the **real** form, whose
 * dropdowns, switch, textareas and occasionally disabled controls are the list `trapTab` reads on
 * every press. Everything else in this file is what it always was: which command each answer
 * writes.
 */
describe("DeckSettingsDialog", () => {
  /** Closed is nothing mounted — not a hidden panel — so a dialog nobody opened asks the
   *  backend for nothing either. `Settings` is passed to the shell as an *element*, and an
   *  element React never puts in the tree is a component that never ran. */
  it("renders nothing and reads nothing while it is closed", () => {
    wrap(<DeckSettingsDialog deckId={4} open={false} onDismiss={vi.fn()} onClose={vi.fn()} />);

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(deckGet).not.toHaveBeenCalled();
  });

  /** The `"inner"` rung: one press, one layer, and the caret hand-back is the caller's. Here it
   *  is the *wiring* that is on trial — that this host hands its `onDismiss` to the shell — since
   *  the rung itself is `Dialog`'s. */
  it("dismisses on Escape", async () => {
    const { onDismiss, onClose } = open();
    await loaded();

    await userEvent.keyboard("{Escape}");

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  /**
   * **The trap, which had no test at all** — `trapTab` could be deleted whole and this file
   * stayed green, while the panel went on claiming `aria-modal="true"`. An untested trap is a
   * promise with no evidence, and the promise is made to assistive tech only: the app behind a
   * scrim is unreachable to a pointer and perfectly reachable to Tab.
   *
   * Both ends, because they fail separately. Forward from the last stop must wrap to the first;
   * backward from the panel (where the open effect leaves the caret) must wrap to the **last**,
   * and that one is the keystroke a reader makes immediately after opening the dialog.
   *
   * **Kept here rather than moved to the shell's suite**, though the trap moved with the chrome:
   * `trapTab` reads the focusable list on every press and filters `disabled`, so what it is worth
   * running against is a real form — a dozen stops, two selects, a switch and a cover grid — and
   * not the one button a shell test can honestly put in a body. Its first line is also the whole
   * of the old "takes the caret when it opens" case, which is why that one is gone from this file
   * and lives in `Dialog.test.tsx` instead.
   */
  it("keeps Tab inside itself, both ways round", async () => {
    open();
    const dialog = await loaded();
    const stops = within(dialog).getAllByRole("button");
    const first = stops[0];
    // The end of the cycle is the last focusable of any kind, not the last button.
    const focusable = dialog.querySelectorAll<HTMLElement>(
      'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    const last = [...focusable].filter((el) => !el.hasAttribute("disabled")).pop() as HTMLElement;

    // Backward from the panel: the wrap a reader meets first.
    await waitFor(() => expect(dialog).toHaveFocus());
    await userEvent.tab({ shift: true });
    expect(last).toHaveFocus();

    // And forward off the end.
    await userEvent.tab();
    expect(first).toHaveFocus();
  });

  /**
   * A press on the scrim closes; a press on the panel does not.
   *
   * The `mouseDown`-with-target-check is the whole mechanism — a `click` handler would close
   * the dialog on a drag that started inside it and ended out here, because the click lands on
   * the two targets' common ancestor. That mechanism is the shell's; what this pins is that the
   * two callbacks arrive at it the right way round, which is the half a shared chrome makes easy
   * to swap by accident.
   */
  it("closes on a press on the scrim and not on one inside the panel", async () => {
    const { onClose, onDismiss } = open();
    const dialog = await loaded();

    fireEvent.mouseDown(dialog);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.mouseDown(dialog.parentElement!);
    expect(onClose).toHaveBeenCalledTimes(1);
    // Closing is not dismissing: the reader who clicked elsewhere is already somewhere else.
    expect(onDismiss).not.toHaveBeenCalled();
  });

  /**
   * **The trap this component is most likely to fall into.** `DeckPatch.folderId` is written
   * `coalesce(?n, folder_id)`, so a `null` there means "leave it alone" — a "move to the top
   * level" written as a patch is a control that reports success and does nothing at all.
   */
  it("files a deck back at the top level with deckSetFolder(null), never a patch", async () => {
    deckGet.mockResolvedValue(detail({ folderId: 2 }));
    open();
    await loaded();

    // Opened before asserting the row exists — `useDeckFolders` is a query the deck's own read
    // does not wait on, so the panel can mount before the list has arrived and `findByRole`
    // (rather than `pickOption`'s synchronous lookup) is what gives it room to.
    await openDropdown(userEvent.setup(), "Folder");
    await userEvent.click(await screen.findByRole("option", { name: "Top level" }));

    await waitFor(() => expect(deckSetFolder).toHaveBeenCalledWith(4, null));
    expect(deckUpdate).not.toHaveBeenCalled();
  });

  /** The other direction, through the same command: one control, one rule about it. */
  it("files a deck into a folder with deckSetFolder, never a patch", async () => {
    open();
    await loaded();

    await openDropdown(userEvent.setup(), "Folder");
    await userEvent.click(await screen.findByRole("option", { name: "Commander › Legends" }));

    await waitFor(() => expect(deckSetFolder).toHaveBeenCalledWith(4, 2));
    expect(deckUpdate).not.toHaveBeenCalled();
  });

  /**
   * The deck editor's old "Add to" select, asked here since 2026-08-15 — and written as an
   * ordinary patch, which is the contrast with the folder rows above.
   *
   * **The two look alike and are not.** `folderId` cannot express "the top level" through
   * `coalesce(?n, folder_id)`, so filing needs `deckSetFolder`. `defaultCategoryId` can express
   * its own cleared state, because that state is a **number** — `AUTO_CATEGORY`, `0` — so it
   * rides `deckUpdate` like the format and the theory switch, and the round trip back to Auto is
   * what pins that this really is one command rather than two.
   */
  it("writes the default category with deckUpdate, Auto included", async () => {
    open();
    await loaded();

    await pickOption(userEvent.setup(), "Add cards to", "Combo pieces");
    await waitFor(() => expect(deckUpdate).toHaveBeenCalledWith(4, { defaultCategoryId: 12 }));

    await pickOption(userEvent.setup(), "Add cards to", "Auto (by what it does)");
    await waitFor(() => expect(deckUpdate).toHaveBeenLastCalledWith(4, { defaultCategoryId: 0 }));
    expect(deckSetFolder).not.toHaveBeenCalled();
  });

  /** The list is the deck's own `categories`, in the deck's own order — never sorted here, and
   *  never the drawn groups. `Auto` is pinned above them and is not a pile. */
  it("offers Auto and then the deck's piles in the deck's order", async () => {
    open();
    await loaded();

    await openDropdown(userEvent.setup(), "Add cards to");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Auto (by what it does)",
      "Sideboard",
      "Combo pieces",
    ]);
  });

  /** The deck's own filing, said in words a reader can check the select against. */
  it("says where the deck is filed, by path", async () => {
    deckGet.mockResolvedValue(detail({ folderId: 2 }));
    open();
    await loaded();

    // The paragraph, not the `<option>` of the same name beside it: what is being checked is
    // that the dialog *states* the filing, which is the half a select cannot say on its own.
    expect(await screen.findByText("Commander › Legends", { selector: "p" })).toBeInTheDocument();
  });

  /** A folder list that could not be read leaves a dropdown that can only mislead, so it says
   *  what happened and stops offering the move. */
  it("reports a folder list it could not read, and disables the move", async () => {
    deckFolderList.mockRejectedValue("Database is busy.");
    open();
    await loaded();

    expect(await screen.findByText(/Could not read the folders/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Folder" })).toBeDisabled();
  });

  /**
   * **A cover is a `deckUpdate` and there is nothing else it could be.**
   *
   * This case used to be one of a pair — "sets card art with deckUpdate, never with
   * deckSetCoverImage" — against a second command that took a *path* and marked the deck
   * `custom`. That command is deleted, so what is worth asserting is no longer *which* of two
   * writes ran but that the picker's press reaches the patch **and reaches nothing else**: this
   * host holds one mutation of its own (`deckSetFolder`), and a press that touched it would be
   * a cover write filing the deck somewhere.
   */
  it("sets the cover with a deckUpdate patch, and writes nothing else", async () => {
    deckGet.mockResolvedValue(
      detail({}, [card({ name: "Shivan Dragon" }), card({ name: "Lightning Bolt" })]),
    );
    open();
    await loaded();

    await userEvent.click(await screen.findByRole("button", { name: "Shivan Dragon" }));

    await waitFor(() =>
      expect(deckUpdate).toHaveBeenCalledWith(4, { coverCardId: "c-Shivan Dragon" }),
    );
    // One write, and the whole of it: no `coverKind` travels with the id (Rust sets it), and
    // the dialog's other command is untouched.
    expect(deckUpdate).toHaveBeenCalledTimes(1);
    expect(deckSetFolder).not.toHaveBeenCalled();
  });

  /** The tile that is already the cover says so, rather than leaving the reader to match the
   *  picture above against eight thumbnails. */
  it("marks the tile that is already the cover", async () => {
    deckGet.mockResolvedValue(
      detail({}, [card({ name: "Lightning Bolt" }), card({ name: "Shivan Dragon" })]),
    );
    open();
    await loaded();

    expect(await screen.findByRole("button", { name: "Lightning Bolt" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Shivan Dragon" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  /**
   * **The upload is gone, and the absence is what this asserts.**
   *
   * Five cases stood here — the path handed to `deck_set_cover_image`, the picker's filter list
   * (the backend's own decoder list: png, jpg, jpeg, gif, bmp, webp), a cancelled picker writing
   * nothing, a picker that could not be opened saying so, and the refusal banner over a refused
   * upload. All five went with the command, the `/cover/<deckId>` route, the encoder and the
   * `data/covers/` directory: the picture never survived a sync, because the path was stored
   * absolute, so every device but the one that uploaded already drew the card art.
   *
   * It is worth a case rather than left to the deleted mock, because the mock's absence is a
   * compile error only where a name is *used* — an `Upload an image…` button coming back with a
   * picker of its own would break nothing else in this file. It also pins the second half of
   * that removal: this suite no longer mocks `@tauri-apps/plugin-dialog` at all, so a press that
   * reached the plugin would fail here loudly rather than being quietly stubbed.
   */
  it("offers no way to set a cover from a file", async () => {
    open();
    await loaded();

    expect(screen.queryByRole("button", { name: /upload/i })).toBeNull();
    expect(screen.queryByText(/re-encoded/i)).toBeNull();
  });

  /**
   * Scryfall's image policy: an `art` crop has no printed frame, so the illustrator is credited
   * wherever one is shown — and a cover this app cannot credit is not drawn at all.
   */
  it("draws a cover it can credit, with the credit", async () => {
    open();
    const dialog = await loaded();

    expect(screen.getByText("Art by Christopher Rush")).toBeInTheDocument();
    expect(
      dialog.querySelector(`img[src="${cardImageUrl("c-Lightning Bolt", 0, "art")}"]`),
    ).not.toBeNull();
  });

  /** An orphaned cover: `cards` has no row for the printing, so there is no artist — and the
   *  frame says "No cover" rather than claiming a failure. It heals on the next sync. */
  it("draws no cover at all when the artist is unknown", async () => {
    deckGet.mockResolvedValue(detail({ coverArtist: null }));
    open();
    const dialog = await loaded();

    expect(screen.getByText("No cover")).toBeInTheDocument();
    expect(screen.queryByText(/Art by/)).toBeNull();
    expect(
      dialog.querySelector(`img[src="${cardImageUrl("c-Lightning Bolt", 0, "art")}"]`),
    ).toBeNull();
  });

  /**
   * **What this host adds to the picker, and the half a picker test cannot reach.**
   *
   * `DeckCoverPicker` takes the URL as a prop and its own suite hands one in — so the picker
   * could be perfectly correct and this dialog still draw nothing, which is the "tested but
   * unwired" failure this repo has shipped before. The wire is `row.imageUris?.art`, off the
   * same `LEFT JOIN cards` the credit comes from, and on the web build it is the only picture a
   * browser can reach: `mtgimg://` is a Tauri custom protocol and wasm cannot register a URL
   * scheme with one.
   */
  it("hands the picker the cover printing's own URL, which is what a browser draws", async () => {
    vi.mocked(isWebTarget).mockReturnValue(true);
    const supplied = "https://cards.scryfall.io/art/front/0/0/bolt.webp?1706230661";
    deckGet.mockResolvedValue(detail({ imageUris: { art: supplied } }));

    open();
    const dialog = await loaded();

    expect(dialog.querySelector(`img[src="${supplied}"]`)).not.toBeNull();
    expect(screen.getByText("Art by Christopher Rush")).toBeInTheDocument();
  });

  /**
   * Enter commits and then blurs, and the blur handler commits again — in the same tick, which
   * is one rename written twice unless the draft ref is cleared where it is read. The unmount
   * commit is a third chance to write it, and it must not take it either.
   */
  it("writes one rename for Enter, and does not write it again on the way out", async () => {
    const { rerender, onDismiss, onClose } = open();
    await loaded();

    const field = screen.getByLabelText("Name");
    await userEvent.clear(field);
    await userEvent.type(field, "Boros Burn{Enter}");

    await waitFor(() => expect(deckUpdate).toHaveBeenCalledWith(4, { name: "Boros Burn" }));
    expect(deckUpdate).toHaveBeenCalledTimes(1);

    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <DeckSettingsDialog deckId={4} open={false} onDismiss={onDismiss} onClose={onClose} />
      </QueryClientProvider>,
    );
    expect(deckUpdate).toHaveBeenCalledTimes(1);
  });

  /** A blank is not a rename: the backend refuses it in words, and a name is not something a
   *  deck can lose by tabbing through the field. */
  it("does not write a blank name", async () => {
    open();
    await loaded();

    const field = screen.getByLabelText("Name");
    await userEvent.clear(field);
    await userEvent.tab();

    expect(deckUpdate).not.toHaveBeenCalled();
  });

  /**
   * Every other control in this dialog has already written by the time the reader reaches for
   * the scrim, so the text fields commit on the way out too — a half-typed paragraph thrown
   * away by a click outside would be the one destructive thing on the screen.
   *
   * **It was the `Notes` textarea on trial here until user schema v43**, which replaced the
   * deck's single `notes` column with the Notes band's many notes. The property was never
   * about that field, so it moved to `Description`, which is the long field this panel still
   * draws — deleting the case outright would have taken the paragraph below with it.
   *
   * **The case the extraction could have broken in silence.** `useDeckField` writes on
   * `useIsPresent()` going false, which is a React context `AnimatePresence` provides; `Settings`
   * reaches it only because the shell renders `children` inside its own presence subtree rather
   * than beside it. A shell that mounted the body outside would leave the hook reading the
   * default `true` forever, and this would still pass — off the unmount backstop, a fifth of a
   * second later and racing the editor's teardown. `Dialog.test.tsx`'s presence case is what
   * separates the two; this one is the behaviour that depends on it.
   */
  it("commits a half-typed draft when the dialog closes", async () => {
    const { rerender, onDismiss, onClose } = open();
    await loaded();

    await userEvent.type(screen.getByLabelText("Description"), " Cut Avacyn.");
    expect(deckUpdate).not.toHaveBeenCalled();

    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <DeckSettingsDialog deckId={4} open={false} onDismiss={onDismiss} onClose={onClose} />
      </QueryClientProvider>,
    );

    await waitFor(() =>
      expect(deckUpdate).toHaveBeenCalledWith(4, {
        description: "Twenty damage, quickly. Cut Avacyn.",
      }),
    );
  });

  /** The description names itself on the way out, so a host that wrote it into some other
   *  column would be invisible until the gallery tile changed. */
  it("writes the description to the description", async () => {
    open();
    await loaded();

    const field = screen.getByLabelText("Description");
    await userEvent.clear(field);
    await userEvent.type(field, "Fast red deck.");
    await userEvent.tab();

    await waitFor(() =>
      expect(deckUpdate).toHaveBeenCalledWith(4, { description: "Fast red deck." }),
    );
  });

  /**
   * The deck's kind, which was a `Theory deck` switch until issue #401 made it a three-way
   * group — and what this host owes it is **one write carrying both columns**.
   *
   * `theory_enabled` and `virtual_only` are two columns spelling one choice, so a relay that
   * sent the field that changed and left the other standing would be the way the impossible
   * `true, true` row gets into the database. The assertion is therefore on the whole patch and
   * not on the field the press moved: `toHaveBeenCalledWith(4, { theoryEnabled: true })` passes
   * against exactly the bug this is here to catch.
   *
   * **And one call, not two.** Two `update`s would be two transactions and two history lines
   * for one press, with a moment in between in which the deck is neither kind — and switching
   * *to* theory pours the live list into the plan, so that moment is one a card write can land
   * in. `toHaveBeenCalledTimes(1)` is the half of this that no patch-shape assertion covers.
   */
  it("writes the deck's kind as one patch carrying both columns", async () => {
    open();
    await loaded();

    const group = screen.getByRole("group", { name: "Deck kind" });
    expect(within(group).getByRole("button", { name: "Regular" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await userEvent.click(within(group).getByRole("button", { name: "Theory + Actual" }));

    await waitFor(() =>
      expect(deckUpdate).toHaveBeenCalledWith(4, { theoryEnabled: true, virtualOnly: false }),
    );
    expect(deckUpdate).toHaveBeenCalledTimes(1);
  });

  /**
   * The third kind, from the same control and through the same one write.
   *
   * The pair is the assertion again and it matters more in this direction: a deck switched to
   * Virtual **from a plan** is the press that has to put `theoryEnabled` back to `false`, and a
   * relay carrying only the column that was pressed would leave it standing — which is the
   * `true, true` row exactly.
   */
  it("writes Virtual as the same pair, clearing the plan in the same patch", async () => {
    deckGet.mockResolvedValue(withPlan());
    open();
    await loaded();

    const group = screen.getByRole("group", { name: "Deck kind" });
    await userEvent.click(within(group).getByRole("button", { name: "Virtual" }));

    await waitFor(() =>
      expect(deckUpdate).toHaveBeenCalledWith(4, { theoryEnabled: false, virtualOnly: true }),
    );
    expect(deckUpdate).toHaveBeenCalledTimes(1);
  });

  /**
   * The three marks, each relayed to its own column.
   *
   * They are three `deck_update` fields rather than one because blue without green is a real
   * answer and so is red alone, so a relay that carried the set — or that sent the wrong member
   * of it — would collapse them into an ordered control the columns are deliberately not.
   */
  it("relays each theory mark on its own", async () => {
    deckGet.mockResolvedValue(withPlan());
    open();
    await loaded();

    await userEvent.click(screen.getByRole("switch", { name: /Different printing/ }));
    await waitFor(() => expect(deckUpdate).toHaveBeenCalledWith(4, { theoryMarkName: false }));

    await userEvent.click(screen.getByRole("switch", { name: /Matching printing/ }));
    await waitFor(() => expect(deckUpdate).toHaveBeenCalledWith(4, { theoryMarkExact: false }));

    // The red tier, whose column this dialog reached through no arm of its own: `update` takes a
    // whole `DeckPatch`, so the field costs one line here and nothing in `useDeck`.
    await userEvent.click(screen.getByRole("switch", { name: /Not in the theory list/ }));
    await waitFor(() => expect(deckUpdate).toHaveBeenCalledWith(4, { theoryMarkUnplanned: false }));
  });

  /** And a deck with no plan is offered none of them, for the reason it is offered no theory
   *  clear: there is no second list for any mark to compare a row against. */
  it("draws no mark switches on a deck with no plan", async () => {
    open();
    await loaded();

    // The kind control itself is there, which is what stops this passing on a panel that
    // failed to draw at all.
    expect(screen.getByRole("group", { name: "Deck kind" })).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: /Matching printing/ })).toBeNull();
    expect(screen.queryByRole("switch", { name: /Different printing/ })).toBeNull();
    expect(screen.queryByRole("switch", { name: /Not in the theory list/ })).toBeNull();
  });

  /** The format dropdown drives the same command, and sends a key rather than a display name. */
  it("re-formats the deck by key", async () => {
    open();
    await loaded();

    // Opened before asserting the row exists — `useFormatSpecs` is a query the deck's own read
    // does not wait on, so the panel can mount before the seed has arrived and `findByRole`
    // (rather than `pickOption`'s synchronous lookup) is what gives it room to.
    await openDropdown(userEvent.setup(), "Format");
    await userEvent.click(await screen.findByRole("option", { name: "Commander" }));

    await waitFor(() => expect(deckUpdate).toHaveBeenCalledWith(4, { formatKey: "commander" }));
  });

  /**
   * **Alphabetically, not in the `sortOrder` the table answers in.** The mock keeps the seed's
   * ranking (Modern 7, Commander 12, Casual 24), so the sequence below is this dialog's own
   * sort — and it has to be the *same* sort the editor's header select does, or one deck has
   * two format pickers that disagree about where Modern is.
   */
  it("offers the formats alphabetically", async () => {
    open();
    await loaded();

    await openDropdown(userEvent.setup(), "Format");
    await screen.findByRole("option", { name: "Commander" });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Casual",
      "Commander",
      "Modern",
    ]);
  });

  /**
   * A deck on a format the seed no longer offers keeps showing its own — `decks.format_key` is
   * deliberately not a foreign key, so this state exists, and a trigger that could not show its
   * value would re-format the deck the next time anything else here was saved.
   *
   * **Folded into the alphabet rather than pinned first.** Historic between Commander and
   * Modern is the assertion: the trigger's own content already says which one is current, so
   * putting it first would only cost the reader the place they would look for it.
   */
  it("folds the deck's own format into the list when the seed no longer offers it", async () => {
    deckGet.mockResolvedValue(detail({ formatKey: "historic", formatName: "Historic" }));
    open();
    await loaded();

    await openDropdown(userEvent.setup(), "Format");
    await screen.findByRole("option", { name: "Historic" });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Casual",
      "Commander",
      "Historic",
      "Modern",
    ]);
    expect(screen.getByRole("button", { name: "Format" })).toHaveTextContent("Historic");
  });

  /**
   * The folders, by the path a reader would say — and **`Top level` stays first**, because it
   * is not a folder at all: it is the answer meaning `folder_id IS NULL`, which is the one move
   * `DeckPatch` cannot express. Alphabetising it in among the folders would file it under T.
   */
  it("keeps Top level first and the folders in path order", async () => {
    open();
    await loaded();

    await openDropdown(userEvent.setup(), "Folder");
    await screen.findByRole("option", { name: "Commander › Legends" });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Top level",
      "Commander",
      "Commander › Legends",
    ]);
  });

  /** A refused write says so, once, and it is the *newest* write that owns the line — a refused
   *  move must not leave its sentence up while the reader goes on to rename the deck. */
  it("reports a refused write in words", async () => {
    deckSetFolder.mockRejectedValue("Database is busy.");
    open();
    await loaded();

    await openDropdown(userEvent.setup(), "Folder");
    await userEvent.click(await screen.findByRole("option", { name: "Commander › Legends" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not save that change — Database is busy.",
    );
  });

  /** A deck another view deleted while this was open. The read succeeded and answered nothing,
   *  which is not the same as a read that failed. */
  it("says so when the deck is gone", async () => {
    deckGet.mockResolvedValue(null);
    open();

    expect(await screen.findByText(/This deck is gone/)).toBeInTheDocument();
  });

  /*
   * **Emptying a list**, the one thing in this dialog that is not a setting.
   *
   * The names are matched on a **pattern** throughout, because a greyed button's name carries
   * the reason it is greyed — `getByRole("button", { name: "Clear actual list…" })` finds nothing
   * on the empty deck and reads exactly like the control never being drawn.
   */

  /** A deck with a plan has two lists, so it offers two presses. */
  it("offers a clear for each of the deck's lists", async () => {
    deckGet.mockResolvedValue(withPlan());
    open();
    await loaded();

    expect(screen.getByRole("button", { name: /Clear actual list/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Clear theory list/ })).toBeInTheDocument();
  });

  /** And a deck with no plan offers **one**. A greyed control for a list the deck has not got
   *  reads as something broken rather than as something absent. */
  it("offers no theory clear on a deck with no plan", async () => {
    open();
    await loaded();

    expect(screen.getByRole("button", { name: /Clear actual list/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Clear theory list/ })).toBeNull();
  });

  /**
   * **The control that takes the plan away is a few rows up this same dialog**, so the deck can
   * stop having a theory list while its clear confirmation is standing — and the two halves of
   * one control disagreed: the trigger was gated on `theoryEnabled` and the open question was
   * not, so the reader was left being asked to clear a list nothing else on the screen admitted
   * to.
   *
   * The deck is re-read rather than the press being what closes it, because it is the **row**
   * the question is reconciled against — a plan taken away on another device and arriving in a
   * refetch has to close it just the same, and driving the control alone would prove only the
   * local path. `asking` is derived at render for this, never reconciled in an effect.
   */
  it("withdraws the theory question when the deck stops keeping a plan", async () => {
    deckGet.mockResolvedValue(withPlan());
    open();
    await loaded();

    await userEvent.click(screen.getByRole("button", { name: /Clear theory list/ }));
    expect(screen.getByRole("group", { name: "Clear the theory list" })).toBeInTheDocument();

    // The plan goes; the rows it held do not, which is what the kind control's own caption
    // promises.
    deckGet.mockResolvedValue({ ...withPlan(), deck: { ...withPlan().deck, theoryEnabled: false } });
    await userEvent.click(
      within(screen.getByRole("group", { name: "Deck kind" })).getByRole("button", {
        name: "Regular",
      }),
    );

    await waitFor(() =>
      expect(screen.queryByRole("group", { name: "Clear the theory list" })).toBeNull(),
    );
    // And the reader is back to the one list the deck now has, not to an empty section.
    expect(screen.getByRole("button", { name: /Clear actual list/ })).toBeInTheDocument();
  });

  /** One question at a time, and it is about the list whose button was pressed — the group's
   *  own name is what says which, since both questions are drawn in the same place. */
  it("opens the question for the list the press was about", async () => {
    deckGet.mockResolvedValue(withPlan());
    open();
    await loaded();

    await userEvent.click(screen.getByRole("button", { name: /Clear theory list/ }));

    expect(screen.getByRole("group", { name: "Clear the theory list" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Clear the actual list" })).toBeNull();
    // The buttons are replaced by the question rather than sitting under it.
    expect(screen.queryByRole("button", { name: /Clear actual list/ })).toBeNull();
  });

  /**
   * **The case this whole section is riskiest in.** The dialog mounts `useDeck(deckId)`, which
   * is the *live* list, and the theory total is a subtraction over the same rows — so the one
   * mistake available here is handing the theory question the live figure, which would quote a
   * destructive press wrong in the only direction that matters.
   *
   * Both questions, in one case, against a fixture whose two lists genuinely differ: a host
   * that passed the same number to both fails on the second half whichever number it picked.
   */
  it("quotes each list's own count, and the other list's as the untouched one", async () => {
    deckGet.mockResolvedValue(withPlan());
    open();
    await loaded();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /Clear actual list/ }));
    const live = screen.getByRole("group", { name: "Clear the actual list" });
    expect(within(live).getByRole("button", { name: "Remove 7 cards" })).toBeInTheDocument();
    expect(within(live).getByText(/8 cards in the other list/)).toBeInTheDocument();

    await user.click(within(live).getByRole("button", { name: "Keep them" }));

    await user.click(screen.getByRole("button", { name: /Clear theory list/ }));
    const theory = screen.getByRole("group", { name: "Clear the theory list" });
    expect(within(theory).getByRole("button", { name: "Remove 8 cards" })).toBeInTheDocument();
    expect(within(theory).getByText(/7 cards in the other list/)).toBeInTheDocument();
  });

  /** The variant is the mutation's **argument**, not the hook's — which is what lets a dialog
   *  reading the live list empty the plan. The question closes once the write lands. */
  it("clears the list the question was about, and closes on success", async () => {
    deckGet.mockResolvedValue(withPlan());
    open();
    await loaded();

    await userEvent.click(screen.getByRole("button", { name: /Clear theory list/ }));
    await userEvent.click(screen.getByRole("button", { name: "Remove 8 cards" }));

    await waitFor(() => expect(deckClear).toHaveBeenCalledWith(4, "theory"));
    expect(deckClear).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.queryByRole("group", { name: /^Clear the/ })).toBeNull(),
    );
  });

  /** A refusal is not an answer, so the question stays up over it — closing would leave the
   *  reader with a banner and nothing to press again. The sentence is the dialog's existing
   *  one, which is what putting the clear in `writeFailure`'s list buys. */
  it("leaves a refused clear's question up, with the banner saying why", async () => {
    deckGet.mockResolvedValue(withPlan());
    deckClear.mockRejectedValue("Database is busy.");
    open();
    await loaded();

    await userEvent.click(screen.getByRole("button", { name: /Clear actual list/ }));
    await userEvent.click(screen.getByRole("button", { name: "Remove 7 cards" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not save that change — Database is busy.",
    );
    expect(screen.getByRole("group", { name: "Clear the actual list" })).toBeInTheDocument();
  });

  /**
   * Declining puts the caret back on the button that asked.
   *
   * The trigger is **not in the tree** on the render the cancel happens in — the question stood
   * where it was — so this can only be done from an effect, and without one the caret is on
   * `<body>` and the reader's next Tab restarts at the top of the document.
   */
  it("hands the caret back to the button that opened a declined question", async () => {
    deckGet.mockResolvedValue(withPlan());
    open();
    await loaded();

    await userEvent.click(screen.getByRole("button", { name: /Clear theory list/ }));
    await userEvent.click(screen.getByRole("button", { name: "Keep them" }));

    expect(screen.queryByRole("group", { name: /^Clear the/ })).toBeNull();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Clear theory list/ })).toHaveFocus(),
    );
  });

  /** Nothing to empty is nothing to press — and the **name** says so, because a greyed control
   *  whose name is the bare label reads as a control that is missing. */
  it("greys the clear for a list with nothing in it, and says so in its name", async () => {
    deckGet.mockResolvedValue(detail({ theoryEnabled: true }));
    open();
    await loaded();

    const live = screen.getByRole("button", { name: /Clear actual list/ });
    expect(live).toBeDisabled();
    expect(live).toHaveAccessibleName("Clear actual list… (already empty)");
    expect(screen.getByRole("button", { name: /Clear theory list/ })).toBeDisabled();
    expect(deckClear).not.toHaveBeenCalled();
  });

  /*
   * ---- Fill this deck from your collection ------------------------------------------------
   *
   * The third entrance to `PullFromCollectionDialog`, and the only one that opens from the
   * gallery. What is on trial in this file is the *entrance*: which query it spends, what its
   * button is called in both states, that the press really opens that dialog and not a copy of
   * it, that the two Escape rungs are ordered, and that the write reaching the backend is the
   * deck's own. Everything the dialog itself draws — the rows, the source pickers, the ticking,
   * the shortfall arithmetic — is pinned in `PullFromCollectionDialog.test.tsx` and is
   * deliberately not re-asserted here.
   */

  /** The plan is the widest read this dialog makes and nothing behind a closed dialog draws a
   *  word of it, so a settings dialog nobody opened must not ask for one. Same claim as the
   *  file's first case, about the query that was added last. */
  it("reads no pull plan while it is closed", () => {
    wrap(<DeckSettingsDialog deckId={4} open={false} onDismiss={vi.fn()} onClose={vi.fn()} />);

    expect(deckPullPlan).not.toHaveBeenCalled();
  });

  /**
   * And no plan for a deck that is not there.
   *
   * The section is drawn inside `{row && …}`, so there is no button to gate; what this pins is
   * the **query** one render earlier. `deck_pull_plan` refuses a missing deck rather than
   * answering `[]` — it is the one read here that parts company with `deck_get` on that — so an
   * ungated hook would spend the widest question on this screen on one that can only be refused.
   */
  it("reads no pull plan for a deck another view deleted", async () => {
    deckGet.mockResolvedValue(null);
    open();

    expect(await screen.findByText(/This deck is gone/)).toBeInTheDocument();
    expect(deckPullPlan).not.toHaveBeenCalled();
  });

  /** Something to import is a live button, and the plan it is gated on is this deck's. */
  it("offers the import when the deck is short of something it owns", async () => {
    open();
    await loaded();

    const button = await screen.findByRole("button", {
      name: "Import missing cards from collection…",
    });
    expect(button).toBeEnabled();
    await waitFor(() => expect(deckPullPlan).toHaveBeenCalledWith(4));
  });

  /**
   * Nothing to import is a greyed button that **says so in its own name** — the rule the two
   * Clear buttons above it already follow, and the reason it is the visible words rather than an
   * `aria-label`: a bare `Import missing cards from collection…` on a dead control reads to a
   * screen reader, and to a test, as a control that is missing rather than one with nothing to do.
   *
   * An empty plan is the ordinary answer here rather than a failure: a pull moves only the exact
   * printing and finish the list names, so a deck reading *12 missing* can legitimately have
   * nothing on the reader's desk that fills a hole.
   */
  it("carries its reason in the name when there is nothing to import", async () => {
    deckPullPlan.mockResolvedValue([]);
    open();
    await loaded();

    const button = await screen.findByRole("button", {
      name: "Import missing cards from collection… (nothing to import)",
    });
    expect(button).toBeDisabled();
  });

  /**
   * **A plan that has not answered is not an empty one**, and this is the case that keeps two of
   * the pull dialog's four states reachable.
   *
   * `deck_pull_plan` is the widest read this dialog makes, so it lands after `deck_get` and the
   * section is on screen while it is still in flight. Greying the button on anything but a plan
   * that has come back empty would make "reading…" a state nobody can see — and, worse, would put
   * a **refused** read behind a dead control, when the whole job of the dialog's `readError` arm
   * is to say in the backend's own words why there is no list. So the button is live and the
   * dialog answers for itself.
   */
  it("stays live while the plan is still being read, and does not claim there is nothing", async () => {
    deckPullPlan.mockReturnValue(new Promise(() => {}));
    open();
    await loaded();

    const button = screen.getByRole("button", { name: "Import missing cards from collection…" });
    expect(button).toBeEnabled();
  });

  /** A refused read is behind the button rather than instead of it, for the same reason: the
   *  sentence the reader needs is the backend's, and the dialog is where it is drawn. */
  it("still opens the dialog when the plan could not be read, so it can say why", async () => {
    deckPullPlan.mockRejectedValue("Database is busy.");
    open();
    await loaded();

    await userEvent.click(
      await screen.findByRole("button", { name: "Import missing cards from collection…" }),
    );

    const pull = await screen.findByRole("dialog", { name: "Pull from collection" });
    expect(await within(pull).findByText("Database is busy.")).toBeInTheDocument();
  });

  /** The press opens the shared dialog over this one — nested, both panels in the tree at once,
   *  which is what the Escape ladder below is about. The pull is deck-wide, so its subtitle is
   *  the whole-plan sentence rather than the per-card one. */
  it("opens the pull dialog over the settings dialog", async () => {
    open();
    await loaded();

    await userEvent.click(
      await screen.findByRole("button", { name: "Import missing cards from collection…" }),
    );

    expect(await screen.findByRole("dialog", { name: "Pull from collection" })).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Deck settings" })).toBeInTheDocument();
    expect(screen.getByText(/Cards this deck is short of that you already own/)).toBeInTheDocument();
  });

  /**
   * **One Escape, one layer** — and this is the case the nested mount had to earn.
   *
   * `useDismissOnEscape` keeps a module-level stack and only the token on top acts, so the pull
   * (mounted last) takes the first press and this dialog takes the second. Driven with
   * `userEvent.keyboard`, never `window.dispatchEvent`: a synthetic window event collapses the
   * capture phase into *registration* order, which would pass against a broken ladder.
   */
  it("closes the pull on the first Escape and the settings on the second", async () => {
    const user = userEvent.setup();
    const { onDismiss } = open();
    await loaded();

    await user.click(
      await screen.findByRole("button", { name: "Import missing cards from collection…" }),
    );
    await screen.findByRole("dialog", { name: "Pull from collection" });

    await user.keyboard("{Escape}");
    expect(onDismiss).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Pull from collection" })).toBeNull(),
    );
    expect(screen.getByRole("dialog", { name: "Deck settings" })).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  /**
   * **The caret comes back on the Escape path too, and that is the path this matters on.**
   *
   * The hand-back below is driven through the ✕, which is a press — and a press has already put
   * the caret somewhere the reader can see. Escape is the keyboard reader's way out, and it is the
   * one where a caret dropped on `<body>` costs them the rest of the dialog: their next Tab
   * restarts at the top of the document rather than on the control they just came back from.
   *
   * It is one callback either way — `PullFromCollectionDialog` folds `Dialog`'s two rungs into a
   * single `onClose` — so this cannot diverge from the ✕ case by construction. It is here because
   * "cannot diverge" is a claim about the file as it stands, and this is the half a reader
   * actually walks.
   */
  it("hands the caret back to the import button when Escape closes the pull", async () => {
    const user = userEvent.setup();
    open();
    await loaded();

    const trigger = await screen.findByRole("button", {
      name: "Import missing cards from collection…",
    });
    await user.click(trigger);
    await screen.findByRole("dialog", { name: "Pull from collection" });

    await user.keyboard("{Escape}");

    await waitFor(() => expect(trigger).toHaveFocus());
  });

  /**
   * The caret's way back, and it is this host's job rather than the dialog's: `Dialog` splits
   * Escape and the ✕ from a press on the scrim, and `PullFromCollectionDialog` hands its host one
   * callback for both because *where the caret lands is the opener's half of the contract*.
   *
   * The trigger is in the tree the whole time — the pull is drawn over this dialog rather than in
   * place of the button — so this needs no effect, which is the one way it differs from the
   * declined-clear hand-back above.
   */
  it("hands the caret back to the import button when the pull closes", async () => {
    const user = userEvent.setup();
    open();
    await loaded();

    await user.click(
      await screen.findByRole("button", { name: "Import missing cards from collection…" }),
    );
    await user.click(await screen.findByRole("button", { name: "Close the pull list" }));

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Import missing cards from collection…" }),
      ).toHaveFocus(),
    );
  });

  /**
   * **The write is the deck's own**, which is the half of this entrance a rendering test cannot
   * see: `useDeck` already mounts `pullFromCollection` here for the clear's sake, so the dialog is
   * handed that mutation rather than a second one spelled in this file — one command, one set of
   * invalidations, whichever of the three entrances the reader used.
   *
   * The row arrives ticked and pre-picked by the backend, so the ordinary act really is one press
   * on the footer; the picks it sends are `PullFromCollectionDialog`'s arithmetic and are pinned
   * there.
   */
  it("pulls through the deck's own write, with the picks the dialog planned", async () => {
    open();
    await loaded();

    await userEvent.click(
      await screen.findByRole("button", { name: "Import missing cards from collection…" }),
    );
    await userEvent.click(await screen.findByRole("button", { name: "Pull 3 copies" }));

    await waitFor(() =>
      expect(deckPullFromCollection).toHaveBeenCalledWith(4, [{ entryId: 11, quantity: 3 }]),
    );
  });

  /*
   * ---- A Virtual deck, which reads no collection at all -------------------------------------
   *
   * Issue #401's third deck kind: a list the reader tracks without owning the cardboard. What
   * this dialog owes it is one absence and one survival — the whole `Fill this deck from your
   * collection` block goes, and `Empty a list` stays, because a deck the reader owns none of
   * still has cards in it.
   *
   * **Absent, not greyed**, which is this file's own standing rule (the `Clear theory list…` arm
   * has made it since it shipped) rather than a new one: a greyed control under a state the
   * reader chose reads as something broken. So every case below is a `queryBy…` that must find
   * nothing, and the `getBy…` beside it is what stops the file passing on a dialog that failed
   * to render at all.
   */

  /**
   * The section, the button and — the half no rendering assertion can see — the query behind it.
   *
   * `deck_pull_plan` **refuses a virtual deck by name**, so a hook left enabled would not answer
   * an empty plan quietly: it would put a real error sentence on this screen, under a heading
   * that has no business being there. That is why the assertion on `deckPullPlan` is here rather
   * than left to the section's absence to imply — the section could be gated and the query left
   * running, and everything visible would look right.
   */
  it("draws nothing collection-shaped on a virtual deck, and asks for no plan", async () => {
    deckGet.mockResolvedValue(detail({ virtualOnly: true }));
    open();
    await loaded();

    expect(screen.queryByText("Fill this deck from your collection")).toBeNull();
    expect(screen.queryByRole("button", { name: /Import missing cards from collection/ })).toBeNull();
    expect(deckPullPlan).not.toHaveBeenCalled();
  });

  /**
   * And the ordinary deck still gets all three, which is what stops the case above passing
   * against a dialog that had simply stopped drawing the section.
   *
   * The same three claims, inverted, over the file's default deck — so a gate accidentally
   * written the wrong way round, or widened to every deck, is two red cases rather than one
   * silently-satisfied `queryBy`.
   */
  it("still draws the collection section on a deck that is not virtual", async () => {
    open();
    await loaded();

    expect(screen.getByText("Fill this deck from your collection")).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: /Import missing cards from collection/ }),
    ).toBeInTheDocument();
    await waitFor(() => expect(deckPullPlan).toHaveBeenCalledWith(4));
  });

  /**
   * Emptying survives, and there is exactly **one** button to do it with.
   *
   * The count is the assertion. A virtual deck's `theoryEnabled` is `false` by construction —
   * the two columns spell one three-way choice — so the theory arm is already gated and no
   * second guard was added for it; `toHaveLength(1)` is what proves that reading rather than
   * asserting it in prose. The name is matched on a **pattern** for this file's standing reason
   * (a greyed button carries its reason in its name) and deliberately stops at `Clear`: the word
   * after it comes from `listName`, which is where a virtual deck's own wording is decided and
   * pinned, and an assertion that re-spelled it here would either duplicate that helper's test
   * or read its constant back at it.
   */
  it("still offers a clear on a virtual deck, and offers exactly one", async () => {
    deckGet.mockResolvedValue({
      ...detail({ virtualOnly: true }),
      categories: [
        { ...CATEGORIES[0], cardCount: 4, cardCountAllVariants: 4 },
        { ...CATEGORIES[1], cardCount: 3, cardCountAllVariants: 3 },
      ],
    });
    open();
    await loaded();

    expect(screen.getByText("Empty a list")).toBeInTheDocument();
    const clears = screen.getAllByRole("button", { name: /^Clear / });
    expect(clears).toHaveLength(1);
    expect(clears[0]).toBeEnabled();
    expect(clears[0]).not.toHaveAccessibleName(/theory/i);
  });
});

/*
 * `coverChoices` and `folderPaths` were tested here and are not any more: the first belongs to
 * `DeckCoverPicker` and the second to `DeckSettingsForm`, so their cases moved to those two
 * files' suites. This dialog is now the host — what it owns is which command each answer writes,
 * which is what every case above is about.
 */
