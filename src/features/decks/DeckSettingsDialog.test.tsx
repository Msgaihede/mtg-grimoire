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
  DeckRow,
  FormatSpec,
} from "@/lib/ipc";
import { cardImageUrl } from "@/lib/images";
import { card, spec } from "./validation/fixtures";

const deckGet = vi.hoisted(() => vi.fn());
const deckUpdate = vi.hoisted(() => vi.fn());
const deckSetFolder = vi.hoisted(() => vi.fn());
const deckSetCoverImage = vi.hoisted(() => vi.fn());
const deckFolderList = vi.hoisted(() => vi.fn());
const formatSpecs = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { deckGet, deckUpdate, deckSetFolder, deckSetCoverImage, deckFolderList, formatSpecs },
}));

/**
 * The system file picker.
 *
 * Mocked because there is no OS dialog in jsdom — the real `open` reaches `invoke`, which needs
 * `window.__TAURI_INTERNALS__` and would throw the same way in every test, telling us nothing
 * about which of the three answers a picker really gives (a path, a cancel, a failure) this
 * dialog handles. All three are exercised below.
 */
const pickFile = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: pickFile }));

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
  isBuilt: false,
  archived: false,
  cardCount: 60,
  updatedAt: 1_800_000_000,
  folderId: null,
  notes: "Sideboard plan lives in the Maybeboard.",
  theoryEnabled: false,
  lastVariant: "live",
  lastGroupBy: "category",
  lastSortBy: "alphabetical",
  separateXGroup: false,
  defaultCategoryId: 0,
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
  return { deck: { ...BURN, ...deck }, cards, categories: CATEGORIES, tags: [] };
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
  deckGet.mockResolvedValue(detail());
  deckUpdate.mockImplementation((_id: number, patch: Record<string, unknown>) =>
    Promise.resolve({ ...BURN, ...patch }),
  );
  deckSetFolder.mockResolvedValue(BURN);
  deckSetCoverImage.mockResolvedValue({ ...BURN, coverKind: "custom" });
  deckFolderList.mockResolvedValue(FOLDERS);
  formatSpecs.mockResolvedValue(SPECS);
  pickFile.mockResolvedValue("C:\\pics\\dragon.png");
});

/**
 * **The chrome is `Dialog`'s now, and the cases below that touch it are here on purpose.**
 * The shell's own contract — closed mounts nothing, Escape, the scrim press, the modal role, the
 * ✕'s label — is pinned once in `Dialog.test.tsx`, against a body that is only a body. What
 * is left here is what only this host can say: that it wires `onDismiss` and `onClose` through,
 * that a closed dialog costs no `deck_get`, and that the trap holds over the **real** form, whose
 * selects, switch, textareas and occasionally disabled controls are the list `trapTab` reads on
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
    await screen.findByRole("option", { name: "Commander › Legends" });

    await userEvent.selectOptions(screen.getByLabelText("Folder"), "");

    await waitFor(() => expect(deckSetFolder).toHaveBeenCalledWith(4, null));
    expect(deckUpdate).not.toHaveBeenCalled();
  });

  /** The other direction, through the same command: one control, one rule about it. */
  it("files a deck into a folder with deckSetFolder, never a patch", async () => {
    open();
    await loaded();
    await screen.findByRole("option", { name: "Commander › Legends" });

    await userEvent.selectOptions(screen.getByLabelText("Folder"), "2");

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

    const select = await screen.findByLabelText("Add cards to");
    await userEvent.selectOptions(select, "12");
    await waitFor(() => expect(deckUpdate).toHaveBeenCalledWith(4, { defaultCategoryId: 12 }));

    await userEvent.selectOptions(select, "0");
    await waitFor(() => expect(deckUpdate).toHaveBeenLastCalledWith(4, { defaultCategoryId: 0 }));
    expect(deckSetFolder).not.toHaveBeenCalled();
  });

  /** The list is the deck's own `categories`, in the deck's own order — never sorted here, and
   *  never the drawn groups. `Auto` is pinned above them and is not a pile. */
  it("offers Auto and then the deck's piles in the deck's order", async () => {
    open();
    await loaded();

    const select = (await screen.findByLabelText("Add cards to")) as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual([
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

  /** A folder list that could not be read leaves a select that can only mislead, so it says
   *  what happened and stops offering the move. */
  it("reports a folder list it could not read, and disables the move", async () => {
    deckFolderList.mockRejectedValue("Database is busy.");
    open();
    await loaded();

    expect(await screen.findByText(/Could not read the folders/)).toBeInTheDocument();
    expect(screen.getByLabelText("Folder")).toBeDisabled();
  });

  /**
   * Two commands set a cover and picking the wrong one is silent: a card's art is a patch, and
   * a patch is what puts `coverKind` back to `card_art`.
   */
  it("sets card art with deckUpdate, never with deckSetCoverImage", async () => {
    deckGet.mockResolvedValue(
      detail({}, [card({ name: "Shivan Dragon" }), card({ name: "Lightning Bolt" })]),
    );
    open();
    await loaded();

    await userEvent.click(await screen.findByRole("button", { name: "Shivan Dragon" }));

    await waitFor(() =>
      expect(deckUpdate).toHaveBeenCalledWith(4, { coverCardId: "c-Shivan Dragon" }),
    );
    expect(deckSetCoverImage).not.toHaveBeenCalled();
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

  /** The other half of the pair: a file goes through the command that re-encodes it, and the
   *  picker's answer travels as the backend wants it — a path it reads, unchanged, not bytes
   *  and not a `file://` URL. */
  it("uploads the picked path with deckSetCoverImage, never with deckUpdate", async () => {
    open();
    await loaded();

    await userEvent.click(screen.getByRole("button", { name: "Upload an image…" }));

    await waitFor(() => expect(deckSetCoverImage).toHaveBeenCalledWith(4, "C:\\pics\\dragon.png"));
    expect(deckUpdate).not.toHaveBeenCalled();
  });

  /**
   * The picker is asked for one image file, and the extension list is the **backend's decoder
   * list**: `Cargo.toml` builds the `image` crate with png, jpeg, gif, bmp and webp, so a
   * filter wider than that would offer a file the re-encode then refuses.
   */
  it("asks for a single image file", async () => {
    open();
    await loaded();

    await userEvent.click(screen.getByRole("button", { name: "Upload an image…" }));

    expect(pickFile).toHaveBeenCalledWith(
      expect.objectContaining({ multiple: false, directory: false }),
    );
    const { filters } = pickFile.mock.calls[0][0] as {
      filters: { extensions: string[] }[];
    };
    expect(filters[0].extensions).toEqual(["png", "jpg", "jpeg", "gif", "bmp", "webp"]);
  });

  /**
   * **A cancelled picker is not a failure**, and this is the most ordinary way anyone will use
   * the control after changing their mind. `open` answers `null`; nothing is written and no red
   * sentence appears.
   */
  it("says nothing when the picker is cancelled", async () => {
    pickFile.mockResolvedValue(null);
    open();
    await loaded();

    await userEvent.click(screen.getByRole("button", { name: "Upload an image…" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Upload an image…" })).toBeEnabled(),
    );
    expect(deckSetCoverImage).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  /** A picker that could not be opened at all is a different failure from a write the database
   *  refused, and it is reported beside the button that was pressed. */
  it("reports a picker that could not be opened", async () => {
    pickFile.mockRejectedValue("dialog.open not allowed");
    open();
    await loaded();

    await userEvent.click(screen.getByRole("button", { name: "Upload an image…" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not open the file picker — dialog.open not allowed",
    );
    expect(deckSetCoverImage).not.toHaveBeenCalled();
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
   * the scrim, so the text fields commit on the way out too — a notes paragraph thrown away by
   * a click outside would be the one destructive thing on the screen.
   *
   * **The case the extraction could have broken in silence.** `useDeckField` writes on
   * `useIsPresent()` going false, which is a React context `AnimatePresence` provides; `Settings`
   * reaches it only because the shell renders `children` inside its own presence subtree rather
   * than beside it. A shell that mounted the body outside would leave the hook reading the
   * default `true` forever, and this would still pass — off the unmount backstop, a fifth of a
   * second later and racing the editor's teardown. `Dialog.test.tsx`'s presence case is what
   * separates the two; this one is the behaviour that depends on it.
   */
  it("commits a half-typed notes draft when the dialog closes", async () => {
    const { rerender, onDismiss, onClose } = open();
    await loaded();

    await userEvent.type(screen.getByLabelText("Notes"), " Cut Avacyn.");
    expect(deckUpdate).not.toHaveBeenCalled();

    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <DeckSettingsDialog deckId={4} open={false} onDismiss={onDismiss} onClose={onClose} />
      </QueryClientProvider>,
    );

    await waitFor(() =>
      expect(deckUpdate).toHaveBeenCalledWith(4, {
        notes: "Sideboard plan lives in the Maybeboard. Cut Avacyn.",
      }),
    );
  });

  /** The description and the notes are two columns, and a form that wrote one into the other
   *  would be invisible until the gallery tile changed. */
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
   * The switch, and the two sentences it owes the reader — this is the control they decide by,
   * and both halves of what it does are surprising if they are not said.
   *
   * **Turning it on moves the deck into the plan and leaves the live list empty.** It used to
   * copy, and the description used to say so; a description that still promised a copy would be
   * the app telling a reader their sleeved-up deck is safe as they press the thing that empties
   * it. Turning it *off* is still not a delete.
   */
  it("switches the theory list on, and says what it does to the deck in both directions", async () => {
    open();
    await loaded();

    const toggle = screen.getByRole("switch", { name: /Theory deck/ });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText(/keeps every row/)).toBeInTheDocument();
    expect(
      screen.getByText(/makes the deck you have the plan and starts the live list empty/),
    ).toBeInTheDocument();
    // The sentence it must no longer make: nothing is copied any more.
    expect(screen.queryByText(/copies the live deck/)).not.toBeInTheDocument();

    await userEvent.click(toggle);

    await waitFor(() => expect(deckUpdate).toHaveBeenCalledWith(4, { theoryEnabled: true }));
  });

  /** The format select drives the same command, and sends a key rather than a display name. */
  it("re-formats the deck by key", async () => {
    open();
    await loaded();
    // Scoped to the format select: the folder select carries a "Commander" of its own.
    const format = screen.getByLabelText("Format");
    await within(format).findByRole("option", { name: "Commander" });

    await userEvent.selectOptions(format, "commander");

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

    const format = screen.getByLabelText("Format");
    await within(format).findByRole("option", { name: "Commander" });
    expect(
      within(format)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Casual", "Commander", "Modern"]);
  });

  /**
   * A deck on a format the seed no longer offers keeps showing its own — `decks.format_key` is
   * deliberately not a foreign key, so this state exists, and a select that could not show its
   * value would re-format the deck the next time anything else here was saved.
   *
   * **Folded into the alphabet rather than pinned first.** Historic between Commander and
   * Modern is the assertion: the select's own `value` already says which one is current, so
   * putting it first would only cost the reader the place they would look for it.
   */
  it("folds the deck's own format into the list when the seed no longer offers it", async () => {
    deckGet.mockResolvedValue(detail({ formatKey: "historic", formatName: "Historic" }));
    open();
    await loaded();

    const format = screen.getByLabelText("Format");
    await within(format).findByRole("option", { name: "Historic" });
    expect(format).toHaveValue("historic");
    expect(
      within(format)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Casual", "Commander", "Historic", "Modern"]);
  });

  /**
   * The folders, by the path a reader would say — and **`Top level` stays first**, because it
   * is not a folder at all: it is the answer meaning `folder_id IS NULL`, which is the one move
   * `DeckPatch` cannot express. Alphabetising it in among the folders would file it under T.
   */
  it("keeps Top level first and the folders in path order", async () => {
    open();
    await loaded();
    await screen.findByRole("option", { name: "Commander › Legends" });

    const folder = screen.getByLabelText("Folder");
    expect(
      within(folder)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Top level", "Commander", "Commander › Legends"]);
  });

  /** A refused write says so, once, and it is the *newest* write that owns the line — a refused
   *  move must not leave its sentence up while the reader goes on to rename the deck. */
  it("reports a refused write in words", async () => {
    deckSetFolder.mockRejectedValue("Database is busy.");
    open();
    await loaded();
    await screen.findByRole("option", { name: "Commander › Legends" });

    await userEvent.selectOptions(screen.getByLabelText("Folder"), "2");

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
});

/*
 * `coverChoices` and `folderPaths` were tested here and are not any more: the first belongs to
 * `DeckCoverPicker` and the second to `DeckSettingsForm`, so their cases moved to those two
 * files' suites. This dialog is now the host — what it owns is which command each answer writes,
 * which is what every case above is about.
 */
