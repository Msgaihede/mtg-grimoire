import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DeckCard, DeckNote } from "@/lib/ipc";
import { card } from "./validation/fixtures";

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
 * both drafts are sent as one write, and that pressing Edit is the only thing that reaches this
 * module at all. `NoteEditor.test.tsx` owns the editor's own round trip.
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

import { DeckNotesPanel, NOTES_HEADING, attachableCards } from "./DeckNotesPanel";

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

function renderBand(props: { open?: boolean; cards?: DeckCard[] } = {}) {
  const onToggle = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <DeckNotesPanel
        deckId={4}
        // Handed in, never read again — see `DeckNotesPanelProps.cards`. **This test client has
        // no `staleTime`, which is exactly the condition that made a second `useDeck` here a
        // second `deck_get`**, so the prop is what keeps this file about the band.
        cards={props.cards ?? NO_CARDS}
        open={props.open ?? true}
        onToggle={onToggle}
      />
    </QueryClientProvider>,
  );
  return { ...view, onToggle, client };
}

/** The band's own region, which every assertion below is scoped to. */
async function band(): Promise<HTMLElement> {
  return await screen.findByRole("region", { name: NOTES_HEADING });
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

    // Nothing of the list is in the tree while it is shut — no row, no add field, no editor.
    expect(within(region).queryByLabelText("New note title")).toBeNull();
    expect(within(region).queryByRole("button", { name: "Edit Mana base" })).toBeNull();
  });

  /**
   * **The departure from the Tokens & emblems band, and the one this file exists to pin.** That
   * band draws its heading as plain type on a deck that makes nothing, because a control that
   * spends the whole deck refusing teaches a reader to stop looking at it. Here the empty band is
   * exactly where the reader has something to do — the way to write a first note is *inside* it —
   * so a heading that could not be opened would be the one state this screen must not have.
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

  /** Add-first is `LabelsDialog`'s ordering: the field a reader with no notes needs is above the
   *  list they do not have yet, not under it. */
  it("puts the add field before the list, and sends a new note with a title and nothing else", async () => {
    deckNotes.mockResolvedValue([note({ id: 1, title: "Mana base" })]);
    renderBand();

    const region = await band();
    const field = await within(region).findByLabelText("New note title");
    // **The row is found by a control's *role* and not by its text**, because the title is in the
    // row four times over — the visible line, and the `sr-only` half of each of the three
    // actions' names. A `getByText` here reports "found multiple elements" rather than anything
    // about the order this test is asking about.
    const row = await within(region).findByRole("button", { name: "Edit Mana base" });
    // `Node.DOCUMENT_POSITION_FOLLOWING` — the row comes after the field, which is the whole of
    // what "add first" means and the only part of it a suite can see.
    expect(field.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await userEvent.type(field, "  Sideboard plan  ");
    await userEvent.click(within(region).getByRole("button", { name: "Add note" }));
    // Trimmed, and with an empty body and no cards: the add row is one field, and everything else
    // about a note is filled in afterwards. That is what keeps the lazy editor off this path.
    expect(deckNoteCreate).toHaveBeenCalledWith(4, "Sideboard plan", "", []);
  });

  it("refuses to send a note with nothing but spaces in its title", async () => {
    renderBand();
    const region = await band();
    const field = await within(region).findByLabelText("New note title");

    const add = within(region).getByRole("button", { name: "Add note" });
    expect(add).toBeDisabled();
    await userEvent.type(field, "   ");
    expect(add).toBeDisabled();
    expect(deckNoteCreate).not.toHaveBeenCalled();
  });

  /**
   * Issue #447's central requirement: *"notes should always appear in the notes list, even when
   * they are attached to a card."* The attachments hang off the note, so this is true by
   * construction — and it is written down because it is the property the whole schema was chosen
   * for.
   */
  it("lists a note that names four cards beside one that names none", async () => {
    deckNotes.mockResolvedValue([
      note({
        id: 1,
        title: "The one-drops",
        cards: [
          { oracleId: "o-bolt", name: "Lightning Bolt" },
          { oracleId: "o-goblin", name: "Goblin Guide" },
          { oracleId: "o-monastery", name: "Monastery Swiftspear" },
          { oracleId: "o-eidolon", name: "Eidolon of the Great Revel" },
        ],
      }),
      note({ id: 2, title: "Sleeve these" }),
    ]);
    renderBand();

    const region = await band();
    expect(await within(region).findByText("2 notes")).toBeInTheDocument();
    expect(within(region).getByText("4 cards")).toBeInTheDocument();
    expect(
      within(region).getByRole("button", { name: "Edit Sleeve these" }),
    ).toBeInTheDocument();
    // No chip on the note that names nothing — `0 cards` on the commonest row in the band would
    // be the same nothing said over and over.
    expect(within(region).queryByText("0 cards")).toBeNull();
  });

  /**
   * A blank title is legal and reads as the body's first line, computed at render and never
   * stored — and it reaches the reader who cannot see the row, because every control on it folds
   * the title into its own name.
   */
  it("names a blank-titled note by its body's first line, in its controls too", async () => {
    // A **blank line** and not a single one: a lone newline is a soft wrap inside one paragraph,
    // so `noteToPlainText` joins it and the "first line" would be the whole paragraph. That is
    // markdown being markdown, and a fixture written the other way asserts the wrong thing.
    deckNotes.mockResolvedValue([
      note({ id: 1, body: "Ask Supreme about the Bolt count\n\nlater" }),
    ]);
    renderBand();

    const region = await band();
    // The computed name, whole — a CSS `gap` is not a word separator, so the parts are never
    // asserted separately.
    expect(
      await within(region).findByRole("button", { name: "Edit Ask Supreme about the Bolt count" }),
    ).toBeInTheDocument();
  });

  /** The body is drawn as blocks, so the source characters never reach the screen. */
  it("renders the body rather than printing it", async () => {
    deckNotes.mockResolvedValue([
      note({ id: 1, title: "Mana base", body: "Fourteen is **one short**." }),
    ]);
    renderBand();

    const region = await band();
    expect(await within(region).findByText("one short")).toBeInTheDocument();
    expect(within(region).queryByText(/\*\*one short\*\*/)).toBeNull();
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
   * **Both fields in one write.** `deck_note_update` has no patch shape a caller can half-fill
   * usefully — the title control and the body control are one form — and the labels dialog's
   * lesson is what this is guarding: two controls each sending the other's field back is how a
   * rename quietly undoes a recolour.
   */
  it("sends the title and the body together", async () => {
    deckNotes.mockResolvedValue([note({ id: 1, title: "Mana base", body: "Fourteen." })]);
    renderBand();

    const region = await band();
    await userEvent.click(
      await within(region).findByRole("button", { name: "Edit Mana base" }),
    );

    // The editor is reached through `React.lazy`, so it arrives a tick later than the press.
    const body = await within(region).findByLabelText("Body of Mana base");
    await userEvent.clear(body);
    await userEvent.type(body, "Fifteen.");

    const title = within(region).getByLabelText("Title of Mana base");
    await userEvent.clear(title);
    await userEvent.type(title, "Lands");

    await userEvent.click(within(region).getByRole("button", { name: "Save" }));
    expect(deckNoteUpdate).toHaveBeenCalledWith(4, 1, { title: "Lands", body: "Fifteen." });
  });

  it("writes nothing when the reader backs out", async () => {
    deckNotes.mockResolvedValue([note({ id: 1, title: "Mana base", body: "Fourteen." })]);
    renderBand();

    const region = await band();
    await userEvent.click(
      await within(region).findByRole("button", { name: "Edit Mana base" }),
    );
    await within(region).findByLabelText("Body of Mana base");
    await userEvent.click(within(region).getByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(within(region).queryByLabelText("Body of Mana base")).toBeNull(),
    );
    expect(deckNoteUpdate).not.toHaveBeenCalled();
  });

  /**
   * A destructive press asks first, and the question says how far it reaches. The cards cascade
   * away with the note; the *cards themselves* do not, and that is the half a reader can only be
   * told before the press.
   */
  it("asks before deleting, and says what the delete does not reach", async () => {
    deckNotes.mockResolvedValue([
      note({ id: 1, title: "Mana base", cards: [{ oracleId: "o-bolt", name: "Lightning Bolt" }] }),
    ]);
    renderBand();

    const region = await band();
    await userEvent.click(
      await within(region).findByRole("button", { name: "Delete Mana base" }),
    );
    expect(deckNoteDelete).not.toHaveBeenCalled();

    const question = await within(region).findByRole("group", { name: "Delete Mana base" });
    expect(question).toHaveTextContent("The cards themselves stay in the deck.");
    // The caret comes into the question rather than onto a button in it: the reader has not
    // decided yet, and a stray Enter must not decide for them.
    expect(question).toHaveFocus();

    await userEvent.click(within(question).getByRole("button", { name: "Delete note" }));
    expect(deckNoteDelete).toHaveBeenCalledWith(4, 1);
  });

  it("hands the caret back to the control that opened a confirmation the reader declined", async () => {
    deckNotes.mockResolvedValue([note({ id: 1, title: "Mana base" })]);
    renderBand();

    const region = await band();
    const trigger = await within(region).findByRole("button", { name: "Delete Mana base" });
    await userEvent.click(trigger);
    await userEvent.click(within(region).getByRole("button", { name: "Keep it" }));

    await waitFor(() =>
      expect(within(region).getByRole("button", { name: "Delete Mana base" })).toHaveFocus(),
    );
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
    const field = await within(region).findByLabelText("New note title");
    await userEvent.type(field, "Mana base");
    await userEvent.click(within(region).getByRole("button", { name: "Add note" }));

    await waitFor(() => expect(client.getQueryState(cardKey)?.isInvalidated).toBe(true));
  });
});

/* -------------------------------------------------------------------- the picker ------- */

describe("naming cards in a note", () => {
  /**
   * **One entry per oracle id, and a printing with none is dropped.** A note names a card and not
   * a printing — one note naming Lightning Bolt names it once, however many copies, printings or
   * finishes the deck holds — and an orphan row has no id to attach, so offering it would be a
   * press that could only be refused.
   */
  it("dedupes the deck's cards by oracle id and drops the ones with none", () => {
    const cards: DeckCard[] = [
      card({ name: "Lightning Bolt", oracleId: "o-bolt" }),
      card({ name: "Lightning Bolt", oracleId: "o-bolt" }),
      card({ name: "Ancestral Recall", oracleId: "o-recall" }),
      card({ name: "Ghost", oracleId: null }),
    ];
    expect(attachableCards(cards)).toEqual([
      { oracleId: "o-recall", name: "Ancestral Recall" },
      { oracleId: "o-bolt", name: "Lightning Bolt" },
    ]);
  });

  it("offers the deck's own cards, minus the ones the note already names", async () => {
    deckNotes.mockResolvedValue([
      note({ id: 1, title: "Burn plan", cards: [{ oracleId: "o-bolt", name: "Lightning Bolt" }] }),
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

    expect(
      await within(region).findByRole("button", { name: "Name Goblin Guide in Burn plan" }),
    ).toBeInTheDocument();
    expect(
      within(region).queryByRole("button", { name: "Name Lightning Bolt in Burn plan" }),
    ).toBeNull();

    await userEvent.click(
      within(region).getByRole("button", { name: "Name Goblin Guide in Burn plan" }),
    );
    expect(deckNoteAttach).toHaveBeenCalledWith(4, 1, "o-goblin");
  });

  it("takes a card off a note without taking the note anywhere", async () => {
    deckNotes.mockResolvedValue([
      note({ id: 1, title: "Burn plan", cards: [{ oracleId: "o-bolt", name: "Lightning Bolt" }] }),
    ]);
    renderBand({ cards: [card({ name: "Lightning Bolt", oracleId: "o-bolt" })] });

    const region = await band();
    await userEvent.click(
      await within(region).findByRole("button", { name: "Cards on Burn plan" }),
    );
    await userEvent.click(
      await within(region).findByRole("button", {
        name: "Detach Lightning Bolt from Burn plan",
      }),
    );
    expect(deckNoteDetach).toHaveBeenCalledWith(4, 1, "o-bolt");
    // Still in the list, which is the requirement rather than a consequence — asked of the row's
    // own control, since the title is in this row several times over and a text query would only
    // report that.
    expect(within(region).getByRole("button", { name: "Edit Burn plan" })).toBeInTheDocument();
    expect(within(region).getByText("1 note")).toBeInTheDocument();
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
    const field = await within(region).findByLabelText("New note title");
    await userEvent.type(field, "Mana base");
    await userEvent.click(within(region).getByRole("button", { name: "Add note" }));

    expect(await within(region).findByRole("alert")).toHaveTextContent("the deck is gone");
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
