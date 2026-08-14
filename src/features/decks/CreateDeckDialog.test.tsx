import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactElement } from "react";
import type { CardDetail, CardSummary, DeckFolder, DeckRow, FormatSpec } from "@/lib/ipc";
import { cardImageUrl } from "@/lib/images";
import { spec } from "./validation/fixtures";

const deckCreate = vi.hoisted(() => vi.fn());
const deckSetCoverImage = vi.hoisted(() => vi.fn());
const deckFolderList = vi.hoisted(() => vi.fn());
const formatSpecs = vi.hoisted(() => vi.fn());
const searchCards = vi.hoisted(() => vi.fn());
/** The one card read this dialog makes: a picked cover's illustrator, which no `DeckRow`
 *  exists yet to carry. See the "credits the illustrator" test. */
const cardDetail = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { deckCreate, deckSetCoverImage, deckFolderList, formatSpecs, searchCards, cardDetail },
}));

/**
 * The system file picker.
 *
 * Mocked because there is no OS dialog in jsdom — the real `open` reaches `invoke`, which needs
 * `window.__TAURI_INTERNALS__` and would throw the same way for every answer. Which is also why
 * the upload arm can only be driven from here: a story cannot produce a path, so the two states
 * that follow one (the picture saved, and the picture refused over a deck that now exists) are
 * unit tests rather than stories.
 */
const pickFile = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: pickFile }));

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

/** Two folders, one nested, so the select offers a path rather than a bare name. */
const FOLDERS: DeckFolder[] = [
  { id: 1, parentId: null, name: "Commander", sortOrder: 0 },
  { id: 2, parentId: 1, name: "Legends", sortOrder: 0 },
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
  lastVariant: "live",
  lastGroupBy: "category",
  lastSortBy: "alphabetical",
  separateXGroup: false,
  updatedAt: 1786266000,
};

/** The same deck as the *upload* answers with: the cover write returns the deck as the gallery
 *  would now read it, `coverKind` already `custom`. */
const PICTURED: DeckRow = { ...MADE, coverKind: "custom", updatedAt: 1786266100 };

/** One search result — the cover picker's grid reads a name and an id and nothing else. */
function found(name: string): CardSummary {
  return {
    id: `s-${name}`,
    name,
    setCode: "mh2",
    setName: "Modern Horizons 2",
    collectorNumber: "12",
    rarity: "rare",
    typeLine: "Creature — Dragon",
    manaCost: "{4}{R}{R}",
    price: 1.5,
    layout: "normal",
    oracleId: `o-${name}`,
    finishes: `["nonfoil"]`,
    ownedQuantity: 0,
    wishlisted: false,
    printings: 1,
    priceLow: 1.5,
    priceHigh: 1.5,
    gameChanger: false,
  };
}

/**
 * `card_detail`'s answer, cut to the one field this dialog reads.
 *
 * `artist` is the whole of it — its own doc says it is "required by Scryfall's image policy
 * wherever art is shown" — and the rest is here because the mirror says the command answers a
 * whole printing. The prices are ignored on purpose: nothing on this panel draws money, which
 * is why the query carries no marketplace in its key.
 */
function detail(id: string, artist: string | null): CardDetail {
  return {
    id,
    oracleId: `o-${id}`,
    name: "Shivan Dragon",
    setCode: "mh2",
    setName: "Modern Horizons 2",
    collectorNumber: "12",
    rarity: "rare",
    layout: "normal",
    lang: "en",
    manaCost: "{4}{R}{R}",
    cmc: 6,
    typeLine: "Creature — Dragon",
    oracleText: "Flying",
    illustrationId: `i-${id}`,
    artist,
    releasedAt: "2021-06-18",
    legalities: null,
    finishPrices: { nonfoil: null, foil: null, etched: null },
    finishes: `["nonfoil"]`,
    imageStatus: "highres_scan",
    faces: [],
  };
}

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

const submitButton = () => screen.getByRole("button", { name: "Create deck" });

/**
 * The cover preview's own frame, found by the caption above it.
 *
 * Scoped rather than swept out of `container`, and the reason is the point of the whole art
 * credit: **the grid tiles draw the same `art` crop uncredited**, following the documented
 * exception on `ChoiceTile`, so a `querySelector` over the panel finds the picked card's
 * picture whether the preview drew one or not — and the claim being made here is only ever
 * about the preview.
 */
const preview = () => screen.getByText("Deck picture").nextElementSibling as HTMLElement;

/**
 * The cover picker's **search** arm, which is the one that works before the deck exists — a deck
 * being made has no cards of its own to offer.
 */
async function pickFromSearch(query: string, name = query) {
  await userEvent.type(screen.getByLabelText("Search every card"), query);
  const results = await screen.findByRole("list", { name: "Pick art from any card" });
  await userEvent.click(within(results).getByRole("button", { name }));
}

beforeEach(() => {
  deckCreate.mockReset().mockResolvedValue(MADE);
  deckSetCoverImage.mockReset().mockResolvedValue(PICTURED);
  deckFolderList.mockReset().mockResolvedValue(FOLDERS);
  formatSpecs.mockReset().mockResolvedValue(PICKER);
  searchCards.mockReset().mockResolvedValue({ items: [], total: 0, totalIsCapped: false });
  cardDetail.mockReset().mockResolvedValue(detail("s-Shivan Dragon", "Donato Giancola"));
  pickFile.mockReset().mockResolvedValue("C:\\pics\\dragon-hoard.png");
  onCreated.mockReset();
  onDismiss.mockReset();
  onClose.mockReset();
});

describe("the create deck dialog", () => {
  /** The whole deck is the question now, and the caret starts in the one field that has to be
   *  answered. */
  it("opens with the caret in the name field", async () => {
    wrap(<Harness />);

    const name = await screen.findByLabelText("Name");
    await waitFor(() => expect(name).toHaveFocus());
    await waitFor(() => expect(name).toBeVisible());
  });

  /**
   * **One `deck_create`, carrying every answer.** Create-then-patch-then-file would be three
   * transactions and a half-made deck to unwind by hand when the second one fails — the trap
   * `deck_import_commit` exists to avoid.
   */
  it("creates the whole deck the reader described, in one write", async () => {
    searchCards.mockResolvedValue({
      items: [found("Shivan Dragon")],
      total: 1,
      totalIsCapped: false,
    });
    wrap(<Harness />);

    await userEvent.type(await screen.findByLabelText("Name"), "Sunday burn");
    await userEvent.selectOptions(screen.getByLabelText("Format"), "modern");
    await userEvent.type(screen.getByLabelText("Description"), "Twenty damage, quickly.");
    await userEvent.type(screen.getByLabelText("Notes"), "Sideboard plan lives in the maybeboard.");
    await userEvent.click(screen.getByRole("switch", { name: /Theory deck/ }));
    await userEvent.selectOptions(screen.getByLabelText("Folder"), "2");

    // The cover comes from the picker's **search** arm, which is the one that works before the
    // deck exists — a deck being made has no cards of its own to offer.
    await userEvent.type(screen.getByLabelText("Search every card"), "dragon");
    const results = await screen.findByRole("list", { name: "Pick art from any card" });
    await userEvent.click(within(results).getByRole("button", { name: "Shivan Dragon" }));

    await userEvent.click(submitButton());

    await waitFor(() =>
      expect(deckCreate).toHaveBeenCalledWith({
        // The **trimmed** name, which is what `valid_name` would have stored anyway — sent that
        // way so the deck is named what the reader can see they typed.
        name: "Sunday burn",
        formatKey: "modern",
        description: "Twenty damage, quickly.",
        notes: "Sideboard plan lives in the maybeboard.",
        coverCardId: "s-Shivan Dragon",
        folderId: 2,
        theoryEnabled: true,
      }),
    );
    expect(deckCreate).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(MADE));
  });

  /**
   * A field the reader left empty is **absent**, never `""`.
   *
   * This is an INSERT, so an absent field is the column's own default — NULL — while an empty
   * string is a description the deck really has and the gallery tile really draws, as a blank
   * line under the name. And an absent `folderId` here genuinely means the top level:
   * `DeckPatch`'s `coalesce` trap, which reads a bound NULL as "leave it", belongs to the patch
   * and not to this call.
   */
  it("sends nothing at all for the fields left empty", async () => {
    wrap(<Harness />);

    await userEvent.type(await screen.findByLabelText("Name"), "  Sunday burn  ");
    await userEvent.click(submitButton());

    await waitFor(() => expect(deckCreate).toHaveBeenCalled());
    const sent = deckCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(sent.name).toBe("Sunday burn");
    expect(sent.description).toBeUndefined();
    expect(sent.notes).toBeUndefined();
    expect(sent.coverCardId).toBeUndefined();
    expect(sent.folderId).toBeUndefined();
    // The wire, and not just the object: `invoke` serialises with JSON, which drops an
    // `undefined` value — so serde sees an absent field rather than a null one.
    expect(JSON.stringify(sent)).toBe(
      JSON.stringify({ name: "Sunday burn", formatKey: "casual", theoryEnabled: false }),
    );
  });

  /**
   * A name of nothing but spaces is not a name, and the guard is in two places on purpose.
   *
   * **`aria-disabled`, never the attribute** — a control that greys as the reader types has to
   * stay in the tab order, and a `disabled` button is one the browser will not focus, so the
   * caret could never come back to it. Which means the press really does arrive: the greying is
   * the half a reader sees and `submit`'s early return is the half that refuses.
   */
  it("refuses to submit an empty or whitespace name", async () => {
    wrap(<Harness />);

    const name = await screen.findByLabelText("Name");
    const submit = submitButton();
    expect(submit).toHaveAttribute("aria-disabled", "true");

    await userEvent.type(name, "   ");
    expect(submit).toHaveAttribute("aria-disabled", "true");
    // The keyboard's way in, which no attribute covers.
    await userEvent.keyboard("{Enter}");
    // And the pointer's, which an `aria-disabled` control genuinely delivers.
    await userEvent.click(submit);
    expect(deckCreate).not.toHaveBeenCalled();

    await userEvent.type(name, "Burn");
    await waitFor(() => expect(submit).not.toHaveAttribute("aria-disabled"));
  });

  /**
   * **Enter in the Name field makes the deck.**
   *
   * The old two-question popup got that for free by being a `<form>`, where Enter in a
   * single-line input is implicit submission. This panel is deliberately not one — implicit
   * submission fires from *every* single-line input in a form, and the cover picker's search
   * box is a second one — so the key is taken field by field instead:
   * `DeckSettingsForm.onSubmit` is the name's, and it is this component's own `submit`, guards
   * and all.
   *
   * The press comes from `user.keyboard` rather than `user.type`, because `user.type` focuses
   * whatever it is handed — a press delivered that way would prove nothing about where the
   * caret was when it landed.
   */
  it("creates the deck on Enter in the name field", async () => {
    wrap(<Harness />);

    await userEvent.type(await screen.findByLabelText("Name"), "Sunday burn");
    await userEvent.keyboard("{Enter}");

    await waitFor(() =>
      expect(deckCreate).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Sunday burn", formatKey: "casual" }),
      ),
    );
    expect(deckCreate).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(MADE));
  });

  /**
   * **And from nowhere else on the panel**, which is the half a `<form>` could not have given.
   *
   * The notes want the newline — a form that made the deck on the reader's first line break
   * would be unusable for the one field it offers six rows of — and the cover search box means
   * "I have finished typing a card name", never "make the deck", which is a real risk at
   * exactly the moment a reader is halfway through one.
   */
  it("does not create the deck on Enter in the notes or in the cover search", async () => {
    wrap(<Harness />);

    await userEvent.type(await screen.findByLabelText("Name"), "Sunday burn");

    const notes = screen.getByLabelText("Notes");
    await userEvent.type(notes, "Bring the burn.{Enter}Cut the sideboard.");
    expect(notes).toHaveValue("Bring the burn.\nCut the sideboard.");

    await userEvent.type(screen.getByLabelText("Search every card"), "drag");
    await userEvent.keyboard("{Enter}");

    expect(deckCreate).not.toHaveBeenCalled();
    // And the field that does ask the question is still one press away.
    await userEvent.type(screen.getByLabelText("Name"), "{Enter}");
    await waitFor(() => expect(deckCreate).toHaveBeenCalledTimes(1));
  });

  /**
   * **A cover picked before the deck exists is previewed, credit and all.**
   *
   * The preview refuses to draw an `art` crop whose illustrator is unknown — a crop has no
   * printed frame, so Scryfall's image policy credits one wherever it is shown, and that is
   * `DeckRow.coverArtist`'s standing ruling. There is no `DeckRow` here to carry the name and
   * `CardSummary` carries no `artist`, so this host asks `card_detail` for the one field it
   * needs. The refusal is untouched; what changed is that the answer can now be found.
   *
   * **And it asks for nothing until something is picked** — the query is a `skipToken` while
   * `coverCardId` is null, so opening the dialog costs no card read at all.
   */
  it("credits a picked cover's illustrator, and reads nothing until one is picked", async () => {
    searchCards.mockResolvedValue({
      items: [found("Shivan Dragon")],
      total: 1,
      totalIsCapped: false,
    });
    wrap(<Harness />);

    await screen.findByLabelText("Name");
    expect(cardDetail).not.toHaveBeenCalled();
    expect(screen.getByText("No cover")).toBeInTheDocument();

    await pickFromSearch("Shivan Dragon");

    expect(await screen.findByText("Art by Donato Giancola")).toBeInTheDocument();
    expect(preview().querySelector("img")).toHaveAttribute(
      "src",
      cardImageUrl("s-Shivan Dragon", 0, "art"),
    );
    // The app-wide default, because the argument is not optional and this read draws no money:
    // `marketplace` decides `finishPrices` and nothing else, and nothing here reads one.
    expect(cardDetail).toHaveBeenCalledWith("s-Shivan Dragon", "tcgplayer");
  });

  /**
   * **The refusal is not weakened by the fetch.** A printing whose illustrator genuinely cannot
   * be found is still drawn as nothing — the same answer an orphaned cover gets in the settings
   * dialog, which is the existing ruling and stays. The tile's `aria-pressed` is what tells the
   * reader the press landed, and it does not wait for a round trip.
   */
  it("draws no cover when the picked card has no illustrator to credit", async () => {
    searchCards.mockResolvedValue({
      items: [found("Shivan Dragon")],
      total: 1,
      totalIsCapped: false,
    });
    cardDetail.mockResolvedValue(detail("s-Shivan Dragon", null));
    wrap(<Harness />);

    await screen.findByLabelText("Name");
    await pickFromSearch("Shivan Dragon");

    expect(screen.getByRole("button", { name: "Shivan Dragon" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await waitFor(() => expect(cardDetail).toHaveBeenCalled());
    expect(screen.getByText("No cover")).toBeInTheDocument();
    expect(screen.queryByText(/Art by/)).toBeNull();
    // The tile beside it still draws the crop — that is `ChoiceTile`'s documented exception —
    // so this is the *preview* refusing, which is the strict half and stays strict.
    expect(preview().querySelector("img")).toBeNull();
  });

  /**
   * **Keyed on the card, so a second pick is a second read.** A credit that survived the change
   * of picture would name the printing before it — which is the one way this could be worse
   * than crediting nobody, because it would be a credit that is wrong rather than absent.
   */
  it("re-reads the illustrator when a second card is picked", async () => {
    searchCards.mockResolvedValue({
      items: [found("Shivan Dragon"), found("Bogardan Hellkite")],
      total: 2,
      totalIsCapped: false,
    });
    cardDetail.mockImplementation((id: string) =>
      Promise.resolve(detail(id, id === "s-Shivan Dragon" ? "Donato Giancola" : "Todd Lockwood")),
    );
    wrap(<Harness />);

    await screen.findByLabelText("Name");
    await pickFromSearch("dragon", "Shivan Dragon");
    expect(await screen.findByText("Art by Donato Giancola")).toBeInTheDocument();

    const results = screen.getByRole("list", { name: "Pick art from any card" });
    await userEvent.click(within(results).getByRole("button", { name: "Bogardan Hellkite" }));

    expect(await screen.findByText("Art by Todd Lockwood")).toBeInTheDocument();
    expect(screen.queryByText("Art by Donato Giancola")).toBeNull();
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
    await userEvent.type(screen.getByLabelText("Notes"), "Bring the burn.");
    await userEvent.click(submitButton());

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not create the deck — The card database is busy finishing a sync.",
    );
    // Still open, still holding every answer: the reader presses again rather than retyping.
    expect(screen.getByLabelText("Name")).toHaveValue("Sunday burn");
    expect(screen.getByLabelText("Notes")).toHaveValue("Bring the burn.");
    expect(onDismiss).not.toHaveBeenCalled();
  });

  /**
   * The upload arm, which **needs a deck id and is therefore always a follow-up**:
   * `deck_set_cover_image` takes a path and a deck id, so a file chosen here can only be applied
   * once the INSERT has answered.
   */
  it("uploads a chosen picture once the deck exists", async () => {
    wrap(<Harness />);

    await userEvent.type(await screen.findByLabelText("Name"), "Sunday burn");
    await userEvent.click(screen.getByRole("button", { name: "Upload an image…" }));
    // Named rather than previewed: there is no `/cover/<deckId>` route yet, and the picker
    // hands back a path rather than bytes. The **basename** of it, both separators.
    expect(await screen.findByText("dragon-hoard.png")).toBeInTheDocument();

    await userEvent.click(submitButton());

    await waitFor(() =>
      expect(deckSetCoverImage).toHaveBeenCalledWith(9, "C:\\pics\\dragon-hoard.png"),
    );
    // The row the *upload* answered with, not the one the create did: `coverKind` is already
    // `custom` on it, and the gallery opens the deck as it now is.
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(PICTURED));
  });

  /**
   * The one non-obvious state in the file: **the deck was made and its picture was not.**
   *
   * A refused picture must neither lose the deck nor make a second one, so the deck is held, the
   * line says what happened, and the control is renamed to what pressing it now does.
   */
  it("keeps the deck when its picture cannot be saved, and offers to open it", async () => {
    deckSetCoverImage.mockRejectedValue("That file is not an image this app can read.");
    wrap(<Harness />);

    await userEvent.type(await screen.findByLabelText("Name"), "Sunday burn");
    await userEvent.click(screen.getByRole("button", { name: "Upload an image…" }));
    await screen.findByText("dragon-hoard.png");
    await userEvent.click(submitButton());

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The deck was made, but its picture could not be saved — " +
        "That file is not an image this app can read.",
    );
    // Nobody has been sent to the deck yet, and the dialog is still up holding it.
    expect(onCreated).not.toHaveBeenCalled();

    const open = await screen.findByRole("button", { name: "Open deck" });
    await userEvent.click(open);

    expect(onCreated).toHaveBeenCalledWith(MADE);
    // The whole claim: one deck, however many times the control is pressed.
    expect(deckCreate).toHaveBeenCalledTimes(1);
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
   * in the notes textarea and ends past the panel's edge is a "click" on the scrim — and the
   * dialog would vanish under a reader who was selecting the words they had just typed.
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
    fireEvent.mouseDown(within(dialog).getByLabelText("Notes"));
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
   *
   * A loop rather than a named sequence, because the panel's stops are the shared settings
   * form's now and a test that listed them would be a copy of that component's markup. Twelve
   * presses is more than the panel has stops, so at least one wrap is in there.
   */
  it("keeps Tab inside the dialog", async () => {
    wrap(<Harness />);
    const dialog = await panel();
    await userEvent.type(await screen.findByLabelText("Name"), "Burn");

    for (let i = 0; i < 12; i += 1) {
      await userEvent.tab();
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    }

    // And the wrap named at both ends. The submit control is the last stop and stays in the
    // cycle whatever the name field holds — it greys with `aria-disabled`, and `trapTab` filters
    // on the attribute, which would have taken a disabled submit out and shortened the loop.
    submitButton().focus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(submitButton()).toHaveFocus();
  });

  /**
   * The seeded table is read once per session and is normally already in hand by the time this
   * opens. On the one launch where it is not, the select still has to *say* something — and
   * what it says is what it would create.
   *
   * **It says `Casual` because this host never passes an empty list**, and that is the change
   * from the dialog's own `<select>`: `DeckSettingsValue` carries only a format *key*, so a form
   * handed nothing can do no better than label the option with the key, and the control would
   * read `casual`. The one-row fallback also leaves the select live where the old one greyed
   * itself — a real `disabled` was right for an empty list and is not right for a list.
   */
  it("offers Casual when the format list has not arrived", async () => {
    formatSpecs.mockReturnValue(new Promise(() => {}));
    wrap(<Harness />);

    const format = await screen.findByLabelText("Format");
    expect(format).toHaveValue("casual");
    expect(
      within(format)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Casual"]);
    expect(format).toBeEnabled();
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
      expect(
        within(format)
          .getAllByRole("option")
          .map((o) => o.textContent),
      ).toEqual(["Casual", "Modern", "Standard"]),
    );
  });

  /** Every folder as the path a reader would say out loud, with the top level pinned above
   *  them — and it is a real answer here rather than a placeholder, because an absent
   *  `folderId` on an INSERT *is* the top level. */
  it("offers the folders as paths, under a pinned top level", async () => {
    wrap(<Harness />);

    const folder = await screen.findByLabelText("Folder");
    await waitFor(() =>
      expect(
        within(folder)
          .getAllByRole("option")
          .map((o) => o.textContent),
      ).toEqual(["Top level", "Commander", "Commander › Legends"]),
    );
  });

  /** A closed dialog is not a hidden one: it draws nothing and reads nothing. */
  it("draws nothing while it is closed", () => {
    const { container } = wrap(<Harness startOpen={false} />);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(container).not.toBeEmptyDOMElement();
    expect(formatSpecs).not.toHaveBeenCalled();
    expect(deckFolderList).not.toHaveBeenCalled();
  });
});
