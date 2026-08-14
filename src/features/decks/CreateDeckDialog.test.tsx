import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactElement } from "react";
import type { DeckRow, FormatSpec } from "@/lib/ipc";
import { spec } from "./validation/fixtures";

const deckCreate = vi.hoisted(() => vi.fn());
const formatSpecs = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { deckCreate, formatSpecs },
}));

import { CreateDeckDialog } from "./CreateDeckDialog";
import { useDecks } from "./useDecks";

/** `format_specs` **as Rust answers it** — in `sort_order`, and out of alphabetical order on
 *  purpose, so the test below is about the picker's sort rather than about the mock. The one
 *  row a picker must not offer is in it too: Future Standard is a format you can test a card
 *  against and cannot build for. */
const PICKER: FormatSpec[] = [
  { ...spec("modern"), key: "standard", displayName: "Standard", sortOrder: 1 },
  {
    ...spec("modern"),
    key: "future",
    displayName: "Future Standard",
    enabledInPicker: false,
    sortOrder: 2,
  },
  spec("modern"),
  spec("casual"),
];

const MADE: DeckRow = {
  id: 9,
  name: "Sunday burn",
  formatKey: "modern",
  formatName: "Modern",
  description: null,
  notes: null,
  coverCardId: null,
  coverKind: "card_art",
  coverArtist: null,
  cardCount: 0,
  isBuilt: false,
  archived: false,
  folderId: null,
  theoryEnabled: false,
  updatedAt: 1786266000,
};

const onCreated = vi.fn();
const onDismiss = vi.fn();
const onClose = vi.fn();

/**
 * The dialog with its `create` mutation, exactly as the gallery mounts it: `useDecks()` up
 * here, the mutation handed down.
 *
 * A real mutation and not a hand-shaped stand-in, because two of the claims below are about
 * what the mutation *does* — a refusal that has to survive the press, and a name field that
 * has to survive the refusal. A stub would make both of those tautologies.
 *
 * The trigger is real too. Escape's contract is "hands the caret back to whatever opened
 * this", and there is nothing to hand it back to without a button that is still on screen.
 */
function Harness({ startOpen = true }: { startOpen?: boolean }) {
  const { create } = useDecks();
  const [open, setOpen] = useState(startOpen);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)} data-testid="trigger">
        New deck
      </button>
      <CreateDeckDialog
        create={create}
        open={open}
        onCreated={(deck) => {
          onCreated(deck);
          setOpen(false);
        }}
        onDismiss={() => {
          onDismiss();
          screen.getByTestId("trigger").focus();
          setOpen(false);
        }}
        // The gallery's own `close`: the layer goes and the caret is left where the reader put
        // it — no `focus()` call anywhere in here, which is the half the assertions below check.
        onClose={() => {
          onClose();
          setOpen(false);
        }}
      />
    </div>
  );
}

function wrap(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

/**
 * The panel, and — through it — the scrim.
 *
 * **Everything inside a `motion` element needs this rather than a bare `get`.** A `motion`
 * element's first painted frame carries its `initial`, so `toBeVisible` is false for the whole
 * of a newly opened overlay until the next frame, `MotionGlobalConfig.skipAnimations` and all.
 */
const panel = () => screen.findByRole("dialog", { name: "New deck" });

beforeEach(() => {
  deckCreate.mockReset().mockResolvedValue(MADE);
  formatSpecs.mockReset().mockResolvedValue(PICKER);
  onCreated.mockReset();
  onDismiss.mockReset();
  onClose.mockReset();
});

describe("the create deck dialog", () => {
  /** Two questions and no more, and the caret starts in the field the reader has to fill. */
  it("opens with the caret in the name field", async () => {
    wrap(<Harness />);

    const name = await screen.findByLabelText("Name");
    await waitFor(() => expect(name).toHaveFocus());
    await waitFor(() => expect(name).toBeVisible());
  });

  it("creates the deck the reader described", async () => {
    wrap(<Harness />);

    await userEvent.type(await screen.findByLabelText("Name"), "Sunday burn");
    await userEvent.selectOptions(screen.getByLabelText("Format"), "modern");
    await userEvent.click(screen.getByRole("button", { name: "Create deck" }));

    // The **trimmed** name, which is what `valid_name` would have stored anyway — sent that way
    // so the deck is named what the reader can see they typed.
    await waitFor(() =>
      expect(deckCreate).toHaveBeenCalledWith({ name: "Sunday burn", formatKey: "modern" }),
    );
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(MADE));
  });

  /**
   * A name of nothing but spaces is not a name, and the guard is in two places on purpose: the
   * button is disabled on the same test the submit handler checks, so neither the pointer nor
   * an Enter in the field can write one.
   */
  it("refuses to submit an empty or whitespace name", async () => {
    wrap(<Harness />);

    const name = await screen.findByLabelText("Name");
    const submit = screen.getByRole("button", { name: "Create deck" });
    expect(submit).toBeDisabled();

    await userEvent.type(name, "   ");
    expect(submit).toBeDisabled();
    // The keyboard's way in, which no `disabled` attribute covers.
    await userEvent.keyboard("{Enter}");
    expect(deckCreate).not.toHaveBeenCalled();

    await userEvent.type(name, "Burn");
    await waitFor(() => expect(submit).toBeEnabled());
  });

  /**
   * **This dialog is the only place a refused create can be read.** `writeFailure` covers the
   * writes a *tile* makes, not this one, and the gallery calls `create.reset()` on the way in —
   * so a refusal that closed the dialog would leave no deck and no sentence saying why.
   */
  it("shows the refusal and keeps what was typed", async () => {
    deckCreate.mockRejectedValue("The card database is busy finishing a sync.");
    wrap(<Harness />);

    await userEvent.type(await screen.findByLabelText("Name"), "Sunday burn");
    await userEvent.click(screen.getByRole("button", { name: "Create deck" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not create the deck — The card database is busy finishing a sync.",
    );
    // Still open, still holding the name: the reader presses again rather than retyping.
    expect(screen.getByLabelText("Name")).toHaveValue("Sunday burn");
    expect(onDismiss).not.toHaveBeenCalled();
  });

  /** Escape closes one layer per press, and hands the caret back to whatever opened it. */
  it("closes on Escape and hands focus back to the trigger", async () => {
    wrap(<Harness />);
    await panel();

    await userEvent.keyboard("{Escape}");

    expect(onDismiss).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByLabelText("Name")).not.toBeInTheDocument());
    expect(screen.getByTestId("trigger")).toHaveFocus();
  });

  /**
   * `onMouseDown` rather than `onClick`, and the target compared with the current target:
   * a click fires on the nearest common ancestor of press and release, so a drag that starts
   * in the name field and ends past the panel's edge is a "click" on the scrim — and the
   * dialog would vanish under a reader who was selecting the word they had just typed.
   *
   * **The scrim calls `onClose`, never `onDismiss`.** Escape is the reader saying "put me
   * back"; a press outside is the reader already being somewhere else, so nothing moves the
   * caret. This dialog used to hand it back either way, which is the rule the rest of the app's
   * layers follow inverted.
   */
  it("closes on a press on the scrim and not on a press inside the panel", async () => {
    wrap(<Harness />);
    const dialog = await panel();

    fireEvent.mouseDown(dialog);
    fireEvent.mouseDown(within(dialog).getByLabelText("Name"));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.mouseDown(dialog.parentElement as HTMLElement);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByLabelText("Name")).not.toBeInTheDocument());
    // The caret stayed where the reader left it rather than jumping back to the trigger.
    expect(screen.getByTestId("trigger")).not.toHaveFocus();
  });

  /**
   * The half of `aria-modal` no attribute can deliver: the app behind an overlay really is
   * still in the tab order, so without {@link trapTab} a few presses walk the caret out into a
   * gallery the reader cannot see and cannot get back from.
   */
  it("keeps Tab inside the dialog", async () => {
    wrap(<Harness />);
    await panel();

    // With the name filled, every one of the four controls is live — a `disabled` submit is
    // filtered out of the cycle, which would make this test pass over a shorter loop.
    await userEvent.type(await screen.findByLabelText("Name"), "Burn");

    await userEvent.tab();
    expect(screen.getByLabelText("Format")).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Create deck" })).toHaveFocus();
    // The wrap, which is the whole claim: past the last stop is the first, never the trigger.
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Create deck" })).toHaveFocus();
  });

  /**
   * The seeded table is read once per session and is normally already in hand by the time this
   * opens. On the one launch where it is not, the select still has to *say* something — and
   * what it says is what it would create.
   */
  it("offers Casual when the format list has not arrived", async () => {
    formatSpecs.mockReturnValue(new Promise(() => {}));
    wrap(<Harness />);

    const format = await screen.findByLabelText("Format");
    expect(format).toBeDisabled();
    expect(format).toHaveValue("casual");
    expect(within(format).getAllByRole("option").map((o) => o.textContent)).toEqual(["Casual"]);
  });

  /**
   * **Alphabetically, and not in the seed's `sort_order`.** That ranking is a fact about
   * `format_specs` — Standard first because Standard is the newest pool, not because a reader
   * looking for Modern would ever start there; they look under M. The mock answers
   * Standard → Future Standard → Modern → Casual, so the whole sequence below is the picker's
   * doing, and asserting the sequence rather than one position is what makes a row appended to
   * the seed unable to land in the wrong place quietly.
   *
   * `enabled_in_picker` still decides membership: Future Standard is a format you can test a
   * card against and cannot build for, so it is absent rather than sorted.
   */
  it("offers the seeded formats alphabetically, without the one that is switched off", async () => {
    wrap(<Harness />);

    const format = await screen.findByLabelText("Format");
    await waitFor(() =>
      expect(within(format).getAllByRole("option").map((o) => o.textContent)).toEqual([
        "Casual",
        "Modern",
        "Standard",
      ]),
    );
  });

  /** A closed dialog is not a hidden one: it draws nothing and reads nothing. */
  it("draws nothing while it is closed", () => {
    const { container } = wrap(<Harness startOpen={false} />);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(container).not.toBeEmptyDOMElement();
    expect(formatSpecs).not.toHaveBeenCalled();
  });
});
