import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DeckCard, DeckNote } from "@/lib/ipc";
import { card } from "./validation/fixtures";
import { NOTE_STRIP_ATTR } from "./NoteCard";

const deckNotes = vi.hoisted(() => vi.fn());
const deckNoteCreate = vi.hoisted(() => vi.fn());
const deckNoteUpdate = vi.hoisted(() => vi.fn());
const deckNoteDelete = vi.hoisted(() => vi.fn());
const deckNoteAttach = vi.hoisted(() => vi.fn());
const deckNoteDetach = vi.hoisted(() => vi.fn());
// The fake sits under `ipc.ts` in the workbench; here it replaces the object, because these six
// commands are what the band *is* — every assertion below is about the argument one of them was
// handed. `importOriginal` keeps `ipcError`, which the refusal line renders through.
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: {
    deckNotes,
    deckNoteCreate,
    deckNoteUpdate,
    deckNoteDelete,
    deckNoteAttach,
    deckNoteDetach,
  },
}));

/**
 * The lazy editor, stood in for by a plain textarea.
 *
 * **Mocked rather than mounted**, and not to save time: Tiptap is a real ProseMirror instance
 * over a DOM jsdom lays nothing out in, and what this file is about is the band around it — that
 * a body typed in the dialog reaches the right write with the right *other* column, and that
 * pressing Edit is the only thing that reaches this module at all. `NoteEditor.test.tsx` owns the
 * editor's own round trip and `NoteEditorDialog.test.tsx` the dialog's.
 *
 * **The module is `NoteEditorDialog.tsx`'s now, not this band's** — the `lazy()` call moved there
 * with the redesign — and the mock is unchanged by that, because the two files are in one
 * directory and `./NoteEditor` resolves to one module id either way.
 *
 * It keeps the real component's three props, so a signature change here fails at the type level
 * rather than by silently rendering nothing.
 */
vi.mock("./NoteEditor", () => ({
  default: ({
    value,
    onChange,
    ariaLabel,
  }: {
    value: string;
    onChange: (markdown: string) => void;
    ariaLabel: string;
  }) => <textarea aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)} />,
}));

import { DeckNotesPanel, NOTES_HEADING, type DeckNoteRequest } from "./DeckNotesPanel";

/* --------------------------------------------------------------------- fixtures ------- */

function note(over: Partial<DeckNote> & { id: number }): DeckNote {
  return {
    deckId: 4,
    title: "",
    body: "",
    sortOrder: over.id,
    cards: [],
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

/** A deck with nothing in it, as one identity — the editor hands the band its cards as a prop,
 *  and a fresh `[]` per render would rebuild the picker's memo on every keystroke. */
const NO_CARDS: DeckCard[] = [];

/** The key the band's own read sits under — how "another window deleted it" is spelled below. */
const NOTES_KEY = ["decks", "notes", 4];

function renderBand(
  props: { open?: boolean; cards?: DeckCard[]; request?: DeckNoteRequest | null } = {},
) {
  const onToggle = vi.fn();
  const onRequestHandled = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  type Over = { request?: DeckNoteRequest | null; open?: boolean };
  const band = (over: Over = {}) => (
    <QueryClientProvider client={client}>
      <DeckNotesPanel
        deckId={4}
        // Handed in, never read again — see `DeckNotesPanelProps.cards`. **This test client has
        // no `staleTime`, which is exactly the condition that made a second `useDeck` here a
        // second `deck_get`**, so the prop is what keeps this file about the band.
        cards={props.cards ?? NO_CARDS}
        open={over.open ?? props.open ?? true}
        onToggle={onToggle}
        request={"request" in over ? (over.request ?? null) : (props.request ?? null)}
        onRequestHandled={onRequestHandled}
      />
    </QueryClientProvider>
  );
  const view = render(band());
  return {
    ...view,
    onToggle,
    onRequestHandled,
    client,
    /**
     * Re-render the band **under the same query client** — what a host does when it parks a
     * second request, clears the first, or writes `decks.notes_open` and hands the answer back.
     *
     * `view.rerender` replaces the *root*, so a bare `<DeckNotesPanel …/>` here would drop the
     * provider and every hook in the tree would throw "No QueryClient set".
     */
    update: (over: Over) => view.rerender(band(over)),
  };
}

/** The band's own region, which every assertion below is scoped to. */
async function band(): Promise<HTMLElement> {
  return await screen.findByRole("region", { name: NOTES_HEADING });
}

/** Write a note into the dialog that is open, and save it. The stand-in editor is a textarea, so
 *  the "markdown" that crosses `onSave` is the text itself — which is what lets a write assertion
 *  below name a body rather than a serialisation. */
async function writeAndSave(heading: string, body: string, verb: string) {
  const surface = await screen.findByLabelText(`Body of ${heading}`);
  await userEvent.clear(surface);
  await userEvent.type(surface, body);
  await userEvent.click(screen.getByRole("button", { name: verb }));
}

beforeEach(() => {
  vi.clearAllMocks();
  deckNotes.mockResolvedValue([]);
  deckNoteCreate.mockResolvedValue(note({ id: 9 }));
  deckNoteUpdate.mockResolvedValue(note({ id: 1 }));
  deckNoteDelete.mockResolvedValue(undefined);
  deckNoteAttach.mockResolvedValue(note({ id: 1 }));
  deckNoteDetach.mockResolvedValue(note({ id: 1 }));
});

/* ----------------------------------------------------------------------- the band ------ */

describe("the Notes band", () => {
  /**
   * The read runs on every open, shut band or not, because the header's count *is* the reason to
   * open the area — `DeckTokensPanel`'s call, and the same argument: a header that could only say
   * "press to find out" is a control asking the reader to guess.
   */
  it("counts the deck's notes in the header while the band is shut, and mounts nothing else", async () => {
    deckNotes.mockResolvedValue([note({ id: 1, title: "Mana base" }), note({ id: 2, title: "Plan" })]);
    renderBand({ open: false });

    const region = await band();
    expect(await within(region).findByText("2 notes")).toBeInTheDocument();
    expect(deckNotes).toHaveBeenCalledWith(4);

    // Nothing of the grid is in the tree while it is shut — no card, and therefore no editor.
    expect(within(region).queryByRole("listitem")).toBeNull();
    expect(within(region).queryByRole("button", { name: "Edit Mana base" })).toBeNull();

    // **The one act is in the header, so it is offered shut as well as open** — which is the half
    // of the add row's deletion that a reader would otherwise have lost: that row lived inside the
    // collapsible region and a shut band offered nothing at all.
    expect(within(region).getByRole("button", { name: "New note" })).toBeInTheDocument();
  });

  /**
   * **The departure from the Tokens & emblems band, and the one this file exists to pin.** That
   * band draws its heading as plain type on a deck that makes nothing, because a control that
   * spends the whole deck refusing teaches a reader to stop looking at it. Here there is always
   * something under the heading — on an empty deck, the sentence that says what the band is for
   * and points at the control that fills it — so a heading that could not be opened would be the
   * one state this screen must not have.
   */
  it("keeps the disclosure a control on a deck with no notes at all", async () => {
    const { onToggle } = renderBand({ open: false });

    const disclosure = await screen.findByRole("button", { name: NOTES_HEADING });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(disclosure).toHaveAttribute("aria-controls");

    await userEvent.click(disclosure);
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  /** The region `aria-controls` names is always in the tree — empty while shut, never absent —
   *  so the id always resolves. That is the one thing neither attribute complains about when it
   *  stops being true. */
  it("keeps the region it controls in the tree while the band is shut", async () => {
    renderBand({ open: false });
    const disclosure = await screen.findByRole("button", { name: NOTES_HEADING });
    const id = disclosure.getAttribute("aria-controls");
    expect(id).not.toBeNull();
    expect(document.getElementById(id as string)).not.toBeNull();
  });

  /**
   * **A press opens a question, and nothing is written until it is answered** — which is the
   * whole of what replaced the add row. That row wrote a note on submit with a title and nothing
   * else in it; this one writes nothing at all until there is a body to write.
   */
  it("opens a dialog on New note, and writes nothing until Save", async () => {
    renderBand();

    const region = await band();
    await userEvent.click(within(region).getByRole("button", { name: "New note" }));

    expect(await screen.findByRole("dialog", { name: "New note" })).toBeInTheDocument();
    expect(deckNoteCreate).not.toHaveBeenCalled();
  });

  /**
   * **`title: ""` on every note this band writes**, and the body is the whole of the create.
   * `noteTitle()` answers the first line, which is what it already did for a blank title — so a
   * note is named by what the reader wrote rather than by a field they had to fill in first.
   */
  it("writes the body and no title at all when the dialog is saved", async () => {
    renderBand();

    const region = await band();
    await userEvent.click(within(region).getByRole("button", { name: "New note" }));
    await writeAndSave("New note", "Fourteen sources.", "Save note");

    expect(deckNoteCreate).toHaveBeenCalledWith(4, "", "Fourteen sources.", []);
    // And the dialog is gone: the create is the reader's whole answer to the question it asked.
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("points an empty deck at the control that makes one", async () => {
    renderBand();

    const region = await band();
    expect(await within(region).findByText(/No notes on this deck yet/)).toBeInTheDocument();
    // The add field this replaced is gone, not hidden.
    expect(screen.queryByPlaceholderText("New note title…")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("New note title")).not.toBeInTheDocument();
  });

  /**
   * Issue #447's central requirement: *"notes should always appear in the notes list, even when
   * they are attached to a card."* The attachments hang off the note, so this is true by
   * construction — and it is written down because it is the property the whole schema was chosen
   * for.
   *
   * **The `N cards` chip is gone with the row**: a card draws the crops themselves and counts only
   * what is left over, so what says "this note names four" is a strip of pictures and a `+1 more`.
   * What that strip is made of is `NoteCard.test.tsx`'s; what is asserted here is the band's own
   * half — both notes in the grid, and the strip on the one that names cards and not on the one
   * that names none. `NOTE_STRIP_ATTR` is what makes that second half sayable at all: the strip
   * has no role and no text, so without a handle *"draws no strip"* and *"draws an empty strip"*
   * are the same assertion.
   */
  it("lists a note that names four cards beside one that names none", async () => {
    deckNotes.mockResolvedValue([
      note({
        id: 1,
        title: "The one-drops",
        cards: [
          { oracleId: "o-bolt", name: "Lightning Bolt", cardId: "c-bolt" },
          { oracleId: "o-goblin", name: "Goblin Guide", cardId: "c-goblin" },
          { oracleId: "o-monastery", name: "Monastery Swiftspear", cardId: "c-monastery" },
          { oracleId: "o-eidolon", name: "Eidolon of the Great Revel", cardId: "c-eidolon" },
        ],
      }),
      note({ id: 2, title: "Sleeve these" }),
    ]);
    renderBand();

    const region = await band();
    expect(await within(region).findByText("2 notes")).toBeInTheDocument();
    expect(
      within(region).getByRole("button", { name: "Edit The one-drops" }),
    ).toBeInTheDocument();
    expect(
      within(region).getByRole("button", { name: "Edit Sleeve these" }),
    ).toBeInTheDocument();

    // The strip is the count: pictures rather than a chip, and only the note that names cards
    // draws one at all.
    const [named, unnamed] = within(region).getAllByRole("listitem");
    expect(named.querySelector(`[${NOTE_STRIP_ATTR}]`)).not.toBeNull();
    expect(unnamed.querySelector(`[${NOTE_STRIP_ATTR}]`)).toBeNull();
    expect(
      within(region).getByRole("button", { name: /more cards? in The one-drops$/ }),
    ).toBeInTheDocument();
    // Neither chip survives: `0 cards` on the commonest card in the band would be the same
    // nothing said over and over, and `4 cards` beside four pictures would be the same fact twice.
    expect(within(region).queryByText("0 cards")).toBeNull();
    expect(within(region).queryByText("4 cards")).toBeNull();
  });

  /**
   * **Three flags kept exclusive by an `only()` helper became one value that cannot be two.**
   * The band used to hold `editing`, `confirming` and `picking` as three `number | null`s, so
   * "never two at once" was a rule everybody had to remember to call; it is the union's shape now
   * and nothing here can open a second layer without closing the first.
   */
  it("opens one panel at a time, because there is only one to open", async () => {
    deckNotes.mockResolvedValue([note({ id: 1, title: "Mana base", body: "Fourteen." })]);
    renderBand();

    const region = await band();
    await userEvent.click(
      await within(region).findByRole("button", { name: "Cards on Mana base" }),
    );

    expect(await screen.findByRole("dialog", { name: "Mana base" })).toBeInTheDocument();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });

  /**
   * ⚠️ **A dialog can outlive the note it was opened on.**
   *
   * A panel holds the note **object** rather than its id, which is what lets a dialog read the
   * title, the body and the card list without a second lookup — and it is exactly what makes a
   * note deleted somewhere else a dialog drawing a row nothing answers for. Another window on the
   * same collection is that somewhere else (`docs/reference/multi-window.md`), so the band
   * re-finds its note in the read at draw time and shuts the dialog when it has gone.
   *
   * Written into the cache rather than driven through a refetch, because what is being simulated
   * is the *read changing under the dialog* and not the press that changed it.
   */
  it("shuts a dialog whose note another window deleted", async () => {
    deckNotes.mockResolvedValue([note({ id: 1, title: "Mana base", body: "Fourteen." })]);
    const { client } = renderBand();

    const region = await band();
    await userEvent.click(
      await within(region).findByRole("button", { name: "Cards on Mana base" }),
    );
    expect(await screen.findByRole("dialog", { name: "Mana base" })).toBeInTheDocument();

    act(() => client.setQueryData(NOTES_KEY, []));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  /**
   * **A hard break survives, and the only thing that makes it survive is a class.**
   *
   * The `Inline` union has no break member, so `parseNoteBody` hands a hard break back as a
   * `"\n"` inside a text run. Under the default `white-space: normal` every one of them collapses
   * to a space and a note the reader laid out in short lines comes back as one paragraph — with
   * nothing anywhere going red, because the characters are all still in the DOM. jsdom collapses
   * nothing either, so what is asserted is the declaration rather than the layout: the whitespace
   * class on the box the runs inherit it from.
   *
   * ⚠️ **It stayed here when the body moved to `NoteCard`, because it did not land there.**
   * `NoteCard.test.tsx` took the blank-title and the render-rather-than-print claims and this one
   * was listed with them; `noteMarkdown.test.ts` pins the *parser*'s half — that the run carries a
   * newline — and nothing else in the suite asks whether anything draws it. Delete this only once
   * some file does.
   */
  it("keeps the newline a hard break leaves in a text run", async () => {
    // **Two trailing spaces**, which is CommonMark's hard break and one of the two spellings
    // `noteMarkdown.ts` reads. A lone newline is a *soft* wrap and joins with a space, which is
    // the parser being right and a fixture written that way asserting nothing.
    deckNotes.mockResolvedValue([
      note({ id: 1, title: "Mana base", body: "Fourteen sources  \nfifteen wanted" }),
    ]);
    renderBand();

    const region = await band();
    const run = await within(region).findByText(/Fourteen sources/);
    expect(run.textContent).toContain("\n");
    // `white-space` inherits, so the declaration is on the block the runs sit in rather than on
    // each of them — the assertion climbs to whichever ancestor carries it.
    expect(run.closest(".whitespace-pre-line")).not.toBeNull();
  });
});

/* ------------------------------------------------------------------- the writes -------- */

describe("editing a note", () => {
  /**
   * ⚠️ **The note's existing title goes back unchanged, and this is the fence for it.**
   *
   * `deck_note_update` takes both columns and has no patch shape a caller can half-fill usefully,
   * and the labels dialog one file over is where this app learned what happens otherwise: two
   * controls each sending the other's field back is how a rename quietly undoes a recolour. The
   * dialog edits the body only and knows nothing about a title, so the band is the only place
   * this can be got right and the only place it can be seen.
   *
   * The fixture's title is a **stored** one on purpose. Every note written through the dialog
   * carries `title: ""`, so a band that sent the draft's own idea of a title back would pass
   * against every note it had made itself and lose the title of exactly the notes the card menu
   * wrote.
   */
  it("sends the note's own title back with the body it edited", async () => {
    deckNotes.mockResolvedValue([note({ id: 1, title: "Mana base", body: "Fourteen." })]);
    renderBand();

    const region = await band();
    await userEvent.click(
      await within(region).findByRole("button", { name: "Edit Mana base" }),
    );
    // The editor is reached through `React.lazy`, so it arrives a tick later than the press.
    await writeAndSave("Mana base", "Fifteen.", "Save");

    expect(deckNoteUpdate).toHaveBeenCalledWith(4, 1, { title: "Mana base", body: "Fifteen." });
  });

  /**
   * A destructive press asks first, and the question says how far it reaches. The cards cascade
   * away with the note; the *cards themselves* do not, and that is the half a reader can only be
   * told before the press.
   *
   * **The question is a `Dialog` now** — the band is a masonry, and a box unfolding inside one
   * card would reflow every card after it at the moment the reader was reading the question. The
   * caret still comes into the *question* rather than onto a button in it, which the shell does by
   * focusing its own panel; `useDestructiveFocus` and `useConfirmFocus` went with the row.
   */
  it("asks before deleting, and says what the delete does not reach", async () => {
    deckNotes.mockResolvedValue([
      note({
        id: 1,
        title: "Mana base",
        cards: [{ oracleId: "o-bolt", name: "Lightning Bolt", cardId: "c-bolt" }],
      }),
    ]);
    renderBand();

    const region = await band();
    await userEvent.click(
      await within(region).findByRole("button", { name: "Delete Mana base" }),
    );
    expect(deckNoteDelete).not.toHaveBeenCalled();

    // The heading *is* the question, so the panel's own accessible name carries it — curly quotes
    // and all, which is what a reader sees and therefore what this asserts.
    const question = await screen.findByRole("dialog", { name: "Delete “Mana base”?" });
    expect(question).toHaveTextContent("The cards themselves stay in the deck.");
    await waitFor(() => expect(question).toHaveFocus());

    await userEvent.click(within(question).getByRole("button", { name: "Delete note" }));
    expect(deckNoteDelete).toHaveBeenCalledWith(4, 1);
  });

  /** Declining writes nothing and takes the question away — the other half of asking first. */
  it("writes nothing when the reader keeps the note", async () => {
    deckNotes.mockResolvedValue([note({ id: 1, title: "Mana base" })]);
    renderBand();

    const region = await band();
    await userEvent.click(
      await within(region).findByRole("button", { name: "Delete Mana base" }),
    );
    const question = await screen.findByRole("dialog", { name: "Delete “Mana base”?" });
    await userEvent.click(within(question).getByRole("button", { name: "Keep it" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(deckNoteDelete).not.toHaveBeenCalled();
  });

  /**
   * **The invalidation is two segments and not three, and this is the fence for it.**
   *
   * The band's own read is keyed by deck; the card modal's `Notes` row reads across *every* deck
   * under `["decks", "notes", "card", oracleId]`, which a key naming a deck id does not
   * prefix-match. Narrowed to this hook's own key the write would land, the band would refresh,
   * and the modal would go on answering from cache for `query.ts`'s 30 s — a reader writes a note
   * about Lightning Bolt, opens Lightning Bolt, and is told something else. Neither surface can
   * see that alone, which is why the assertion is here rather than in either of them.
   */
  it("reaches the card modal's cross-deck read as well as its own", async () => {
    const { client } = renderBand();
    const cardKey = ["decks", "notes", "card", "o-bolt"];
    client.setQueryData(cardKey, []);

    const region = await band();
    await userEvent.click(within(region).getByRole("button", { name: "New note" }));
    await writeAndSave("New note", "Mana base", "Save note");

    await waitFor(() => expect(client.getQueryState(cardKey)?.isInvalidated).toBe(true));
  });
});

/* -------------------------------------------------------------------- the picker ------- */

describe("naming cards in a note", () => {
  // What the picker *does* with a card list is `NoteCardsDialog.test.tsx`'s, and how that list is
  // built out of the deck's rows is `deckNotes.test.ts`' — the dedupe, the fold, the printing race
  // and the bucketing all moved there with `attachableCards`. What is left here, and what neither
  // of those files can see, is the wiring: that the deck's own cards reach the dialog at all, and
  // that a tick and an untick reach the two commands with this note's id.

  it("hands the deck's own cards to the picker, and a tick reaches the write", async () => {
    deckNotes.mockResolvedValue([
      note({
        id: 1,
        title: "Burn plan",
        cards: [{ oracleId: "o-bolt", name: "Lightning Bolt", cardId: "c-bolt" }],
      }),
    ]);
    renderBand({
      cards: [
        card({ name: "Lightning Bolt", oracleId: "o-bolt" }),
        card({ name: "Goblin Guide", oracleId: "o-goblin" }),
      ],
    });

    const region = await band();
    await userEvent.click(
      await within(region).findByRole("button", { name: "Cards on Burn plan" }),
    );

    const picker = await screen.findByRole("dialog", { name: "Burn plan" });
    await userEvent.click(
      within(picker).getByRole("checkbox", { name: "Name Goblin Guide in Burn plan" }),
    );
    expect(deckNoteAttach).toHaveBeenCalledWith(4, 1, "o-goblin");

    await userEvent.click(
      within(picker).getByRole("checkbox", { name: "Name Lightning Bolt in Burn plan" }),
    );
    expect(deckNoteDetach).toHaveBeenCalledWith(4, 1, "o-bolt");
  });
});

/* ------------------------------------------------------------------ the refusals ------- */

describe("a refused read", () => {
  /**
   * An empty list and a failed query look identical and mean opposite things. The sentence is
   * drawn **outside** the collapsible region for the half of that a suite can see: a read refused
   * while the band is shut still owes the reader an answer.
   */
  it("says the read failed rather than captioning the deck as having no notes", async () => {
    deckNotes.mockRejectedValue("database is locked");
    renderBand({ open: false });

    const region = await band();
    expect(await within(region).findByRole("alert")).toHaveTextContent("database is locked");
    expect(within(region).queryByText(/^\d+ notes?$/)).toBeNull();
  });

  it("does not caption an open band as empty while the read is refused", async () => {
    deckNotes.mockRejectedValue("database is locked");
    renderBand();

    const region = await band();
    await within(region).findByRole("alert");
    expect(within(region).queryByText(/^No notes on this deck yet/)).toBeNull();
    expect(within(region).queryByText(/^Reading this deck/)).toBeNull();
  });

  it("says a refused write in the same one line", async () => {
    deckNotes.mockResolvedValue([]);
    deckNoteCreate.mockRejectedValue("the deck is gone");
    renderBand();

    const region = await band();
    await userEvent.click(within(region).getByRole("button", { name: "New note" }));
    await writeAndSave("New note", "Mana base", "Save note");

    expect(await within(region).findByRole("alert")).toHaveTextContent("the deck is gone");
  });
});

/* --------------------------------------------------------- the card menu's two rows ---- */

/**
 * **What the card menu asks the band for** (issue #447).
 *
 * The rows themselves are `deckCardMenu.tsx`'s and the wiring that reaches them is
 * `DeckEditor.test.tsx`'s; what is left — and what nothing else can see — is the band's own end of
 * the contract: that a request is taken **once**, that `add` and `open` do two different things,
 * and that the host is handed the request back so it can clear it.
 *
 * ⚠️ **The witness that a request was taken is the dialog, not a write** (2026-09-20). An `add`
 * used to create its note on the press, so `deckNoteCreate` was both the behaviour under test and
 * the proof that the effect had run; the create is the dialog's **Save** now, so three of the
 * tests below moved onto `onRequestHandled` and the editor itself. A `deckNoteCreate` assertion
 * left in one of them would not have failed loudly — it would have hung a `waitFor` out to its
 * timeout on a call that is never going to come.
 */
describe("a note act asked for from the card menu", () => {
  const BOLT: DeckNoteRequest = {
    kind: "add",
    card: { oracleId: "o-bolt", name: "Lightning Bolt" },
  };

  /**
   * **The editor opens and the note does not exist yet, which is the whole of what moved**
   * (2026-09-20).
   *
   * The request used to write its note on the press — titled with the card, naming it in the same
   * transaction — because it was the one note in the feature born *before* its body, and a blank
   * one reads `Untitled note`. The redesign put the body behind a dialog, and a dialog a reader
   * dismisses would have left exactly that empty untitled note in the band every time, with no
   * recourse but to find it and delete it. So the press asks the question and Save answers it.
   */
  it("opens the editor on an add request and writes nothing yet", async () => {
    renderBand({ request: BOLT });

    expect(await screen.findByRole("dialog", { name: "New note" })).toBeInTheDocument();
    // The subtitle is a fact about what the dialog was opened to *do* rather than about anything
    // typed into it — the attach has not happened and will ride in the create.
    expect(screen.getByText("This note will name Lightning Bolt")).toBeInTheDocument();
    expect(deckNoteCreate).not.toHaveBeenCalled();
  });

  /**
   * **The card still rides in the create, in the same transaction it always did**, so the note
   * turns up under that card's own `Notes ▸` submenu with no attach step to lose. Only *when*
   * moved: one round trip later, on the invalidate after Save.
   *
   * `title: ""` like every other note this band writes. The title the old path invented was the
   * price of a note born before its body, and nothing here is born before its body any more.
   */
  it("names the card in the create the Save makes", async () => {
    renderBand({ request: BOLT });

    await writeAndSave("New note", "Four is too many", "Save note");

    expect(deckNoteCreate).toHaveBeenCalledWith(4, "", "Four is too many", ["o-bolt"]);
  });

  /**
   * **A cancelled dialog leaves nothing behind, which is the whole of why the create moved.** An
   * empty untitled note in the band is a row the reader has to notice, recognise as theirs and
   * delete — and the press that made it was a press they changed their mind about.
   */
  it("leaves nothing behind when the reader backs out of one", async () => {
    renderBand({ request: BOLT });

    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    // `waitFor`, because the panel outlives `open` by the length of its fade — every other
    // "the dialog is gone" assertion in this file waits for the same reason.
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(deckNoteCreate).not.toHaveBeenCalled();
  });

  /**
   * **Opens the band, and only where it is shut.**
   *
   * A note a reader was sent to write is one they cannot write behind a shut disclosure. The
   * second half is what stops the request being a press the reader did not make: an already-open
   * band writes `decks.notes_open` for nothing, and every one of those is a row in the deck's
   * history.
   *
   * ⚠️ The open band's half waits on **`onRequestHandled`** rather than on the create it used to
   * wait on — see the block's own note. Something has to be waited for, or the assertion below it
   * passes on the render before the effect has run at all.
   */
  it("opens the band when it is shut, and leaves an open one alone", async () => {
    const shut = renderBand({ open: false, request: BOLT });
    await waitFor(() => expect(shut.onToggle).toHaveBeenCalledWith(true));
    shut.unmount();

    const already = renderBand({ open: true, request: BOLT });
    await waitFor(() => expect(already.onRequestHandled).toHaveBeenCalled());
    expect(already.onToggle).not.toHaveBeenCalled();
  });

  /**
   * ⚠️ **The failure this whole shape exists to prevent, and it is smaller than it was.**
   *
   * The band's effect names `open` among its dependencies and its own first act is to change
   * `open`, so it re-runs at least once for every request it honours — and `React.StrictMode`
   * runs a mount effect twice again on top of that. It was *one press, two notes* while the create
   * ran from here; what a missing ref costs now is a second `decks.notes_open` write against a
   * band that is already opening — a row in the deck's history for nothing — and a second
   * `onRequestHandled` for one press.
   *
   * **`onRequestHandled`'s count is what tells the two apart**, and it is the only thing that
   * does: a re-run reopens the same panel with the same card, so the dialog looks identical
   * either way. Re-rendering with the **same object** is the cheapest way to state the hazard.
   */
  it("takes one request once, even as the band opens under it", async () => {
    // Shut, so honouring the request is what opens it — which is the whole hazard: `open` is a
    // dependency of the effect *and* the first thing the effect changes, so a host that answers
    // the toggle re-runs it with the request still standing.
    const view = renderBand({ open: false, request: BOLT });
    await waitFor(() => expect(view.onToggle).toHaveBeenCalledWith(true));

    view.update({ open: true, request: BOLT });
    view.update({ open: true, request: BOLT });

    expect(await screen.findByRole("dialog", { name: "New note" })).toBeInTheDocument();
    expect(view.onRequestHandled).toHaveBeenCalledTimes(1);
  });

  /**
   * A second press is a second note, and the host's fresh object is what says so — the reason
   * **both** guards compare identity rather than an oracle id: the effect's ref, and the band's
   * own `seeded` adjustment.
   *
   * ⚠️ **Renamed on 2026-09-20 from "takes a second request as a second note".** Nothing here
   * writes a note — the reader backs out of the first editor and the second press has to reopen
   * one — so the old name asserted in words what the test no longer does. The cancel is also what
   * makes this the *reachable* shape: the dialog is `aria-modal` over a `fixed inset-0` scrim, so
   * a second right-click cannot be made while the first editor is up.
   */
  it("takes a second request as a second editor, even for the same card", async () => {
    const view = renderBand({ request: BOLT });
    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    // Cleared by the host, then asked again with a **fresh object for the same card** — the round
    // trip a real press makes. Two right-clicks on one card mean two notes, so a guard comparing
    // `oracleId` would answer the second press with nothing at all and the reader would meet a
    // menu row that had stopped working.
    view.update({ request: null });
    view.update({
      request: { kind: "add", card: { oracleId: "o-bolt", name: "Lightning Bolt" } },
    });

    expect(await screen.findByRole("dialog", { name: "New note" })).toBeInTheDocument();
    expect(view.onRequestHandled).toHaveBeenCalledTimes(2);
  });

  /**
   * **`open` brings the note to the reader and stops there.**
   *
   * Reading is the point, so no editor — an `open` that mounted one would put a card the reader
   * wanted to *look* at behind 141.5 kB of ProseMirror and shut whatever dialog they already had
   * open. The caret is the "into view" half: focusing an element scrolls it into view in a
   * browser, and it is the half jsdom can actually see.
   */
  it("brings a note into view without opening its editor", async () => {
    deckNotes.mockResolvedValue([note({ id: 5, title: "Mana base" })]);
    const view = renderBand({ request: { kind: "open", noteId: 5 } });

    const region = await band();
    // The card and not its title: a note's own words are spelled a fourth time inside each of its
    // three actions' `sr-only` twins (`Edit Mana base`), so a text query finds four nodes and the
    // one it is about is a `<span>` inside the card rather than the card.
    const row = await within(region).findByRole("listitem");
    await waitFor(() => expect(document.activeElement).toBe(row));

    expect(screen.queryByLabelText("Body of Mana base")).toBeNull();
    expect(deckNoteCreate).not.toHaveBeenCalled();
    expect(view.onRequestHandled).toHaveBeenCalledTimes(1);
  });

  /** Nothing is asked for and nothing happens — the resting state, and the one every existing
   *  caller of this band is in. */
  it("does nothing at all without a request", async () => {
    deckNotes.mockResolvedValue([note({ id: 5, title: "Mana base" })]);
    const view = renderBand();

    await within(await band()).findByRole("listitem");
    expect(deckNoteCreate).not.toHaveBeenCalled();
    expect(view.onToggle).not.toHaveBeenCalled();
    expect(view.onRequestHandled).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------- the bundle -------- */

/**
 * Every module of the app, as text.
 *
 * `tokens.test.ts` and `layers.test.ts` sweep the same way and for the same class of defect: one
 * that is invisible to every build in the repository.
 */
const SOURCES = import.meta.glob<string>("/src/**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
});

/**
 * An `import … from "…/NoteEditor"` — the static kind, in any of its spellings. A
 * `lazy(() => import("./NoteEditor"))` is an expression and matches none of them.
 *
 * **`m` and deliberately not `g`.** A global regular expression carries `lastIndex` between
 * calls, so a `.test()` inside a filter answers about wherever the previous file left off — and
 * the sweep would silently pass over half the tree.
 */
const STATIC_NOTE_EDITOR_IMPORT = /^\s*(?:import|export)\b[^\n]*?from\s*["'][^"']*\/NoteEditor["']/m;

describe("the editor's 141.5 kB", () => {
  /**
   * **The one fence for the lazy boundary, and nothing else in either build can see it.**
   * `@tiptap/react` + `@tiptap/starter-kit` + `@tiptap/markdown` measured **141.5 kB gzip**
   * against the app's own 481.45 kB (`esbuild --bundle --minify`, React external, `gzip -9`,
   * 2026-09-10). A single static import anywhere on a path the main chunk reaches puts all of it
   * back — and the app still builds, still passes, and still runs. The only tell is the bundle
   * size, which nobody reads on a green build.
   *
   * `NoteEditor`'s own file and its test are the two places that are *supposed* to name it.
   * **The one `lazy()` call is `NoteEditorDialog.tsx`'s** since the redesign moved the editor
   * behind a dialog; this sweep does not care which file holds it, only that nobody reaches it
   * statically.
   */
  it("is reached by nothing but a dynamic import", () => {
    // A glob that stops matching returns `{}`, and a sweep over nothing finds nothing.
    expect(Object.keys(SOURCES).length).toBeGreaterThan(20);

    const offenders = Object.entries(SOURCES)
      .filter(([path]) => !path.includes("/NoteEditor.") && !path.includes(".test."))
      .filter(([, source]) => STATIC_NOTE_EDITOR_IMPORT.test(source))
      .map(([path]) => path);

    expect(offenders).toEqual([]);
  });
});
