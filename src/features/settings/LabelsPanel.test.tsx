/**
 * The reader's labels, managed from Settings with no deck open.
 *
 * **Every assertion here is about an argument on the wire or a word on the screen, and no
 * assertion reads a colour back out of the DOM.** jsdom resolves no stylesheet, so a computed
 * colour is either the literal `var(…)` or the inline style this file just set — neither of which
 * says anything about what the reader sees. What this panel is responsible for is the *triple* it
 * sends (`deckId`, `name`, `color`) and the two facts its delete confirmation says out loud, so
 * those are what is pinned.
 *
 * `sent` records each command as the boundary sees it — the name and one object — because the two
 * things most worth failing on are shaped like arguments: a `deckId` that is not `null`, and a
 * rename that quietly recoloured the label on its way past.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  render,
  screen,
  waitFor,
  waitForElementToBeRemoved,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GlobalLabel, LabelColor } from "@/lib/ipc";

const { deckLabelAll, deckLabelCreate, deckLabelUpdate, deckLabelDelete, sent } = vi.hoisted(
  () => {
    const sent: [string, Record<string, unknown>][] = [];
    return {
      sent,
      deckLabelAll: vi.fn(),
      deckLabelCreate: vi.fn((deckId: number | null, name: string, color: LabelColor) => {
        sent.push(["deck_label_create", { deckId, name, color }]);
        return Promise.resolve({ id: 99, name, color, cardCount: 0, deckCount: 0 });
      }),
      deckLabelUpdate: vi.fn(
        (deckId: number | null, id: number, name: string, color: LabelColor) => {
          sent.push(["deck_label_update", { deckId, id, name, color }]);
          return Promise.resolve({ id, name, color, cardCount: 0, deckCount: 0 });
        },
      ),
      deckLabelDelete: vi.fn((deckId: number | null, id: number) => {
        sent.push(["deck_label_delete", { deckId, id }]);
        return Promise.resolve(undefined);
      }),
    };
  },
);

// The whole `ipc` object, because these four commands are what this panel *is*. `importOriginal`
// keeps `ipcError`, which the panel's one status line renders a refusal through.
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { deckLabelAll, deckLabelCreate, deckLabelUpdate, deckLabelDelete },
}));

import { LabelsPanel } from "./LabelsPanel";

/**
 * Every label the reader owns.
 *
 * `Cut candidate` is worn in three decks, which is what makes it the row the delete confirmation
 * is written about; `Playtest` is worn by nothing at all, which is the row `deck_label_list` can
 * never answer and this panel therefore has to.
 */
const EVERY_LABEL: GlobalLabel[] = [
  { id: 10, name: "Cut candidate", color: "#d3202a", cardCount: 8, deckCount: 3 },
  { id: 12, name: "Budget swap", color: "#00733e", cardCount: 5, deckCount: 1 },
  { id: 11, name: "Playtest", color: "#0e68ab", cardCount: 0, deckCount: 0 },
];

function draw() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return render(<LabelsPanel />, { wrapper: Wrapper });
}

/** The row for one label, by the name printed in it. */
function row(name: string): HTMLElement {
  const li = screen.getByText(name).closest("li");
  if (!li) throw new Error(`No row for ${name}`);
  return li;
}

/**
 * The panel, once its one read has **answered** — which is not the same as once it has rendered.
 * The region exists on the first frame, so awaiting it would hand every test below a panel that
 * is still drawing `Reading your labels…` and no rows at all.
 */
async function drawn() {
  draw();
  const region = await screen.findByRole("region", { name: "Labels" });
  await waitForElementToBeRemoved(() => screen.queryByText("Reading your labels…"));
  return region;
}

beforeEach(() => {
  sent.length = 0;
  vi.clearAllMocks();
  deckLabelAll.mockResolvedValue(EVERY_LABEL);
});

describe("LabelsPanel", () => {
  it("lists every label the reader owns, worn and unworn alike", async () => {
    await drawn();

    for (const label of EVERY_LABEL) {
      expect(screen.getByText(label.name)).toBeInTheDocument();
    }
    // The read takes no deck, which is the whole reason this panel can exist outside one.
    expect(deckLabelAll).toHaveBeenCalledWith();
  });

  /**
   * **The reach, per row, before anything is pressed.** A label is app-wide, so how far it goes
   * is the one thing about it a Settings reader cannot see — there is no deck on screen to read
   * it off. `Playtest` says `unused` rather than `0 in 0 decks`, which is a sentence about
   * nothing.
   */
  it("says how far each label reaches", async () => {
    await drawn();

    expect(within(row("Cut candidate")).getByText("8 in 3 decks")).toBeInTheDocument();
    expect(within(row("Budget swap")).getByText("5 in 1 deck")).toBeInTheDocument();
    expect(within(row("Playtest")).getByText("unused")).toBeInTheDocument();
  });

  /**
   * **`deckId: null`, and that is the assertion.** Settings has no deck open, so there is no deck
   * to name — and naming one would attribute an edit that reaches every deck to whichever deck
   * happened to be last.
   */
  it("adds a label with no deck", async () => {
    await drawn();

    await userEvent.type(screen.getByRole("textbox", { name: /new label/i }), "Sideboard plan");
    await userEvent.click(screen.getByRole("button", { name: /add label/i }));

    await waitFor(() =>
      expect(sent).toContainEqual([
        "deck_label_create",
        { deckId: null, name: "Sideboard plan", color: "#d9b95c" },
      ]),
    );
  });

  /**
   * The courtesy `labelNames.ts` exists for: a reader who types a name that already exists has
   * found the label they wanted rather than made a mistake, and the row is on the same screen.
   */
  it("will not offer to make a second label of a name one already holds", async () => {
    await drawn();

    await userEvent.type(screen.getByRole("textbox", { name: /new label/i }), "cut candidate");

    expect(screen.getByRole("button", { name: /add label/i })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(/already exists/i);
  });

  /**
   * **How far a delete reaches, said before it goes.** `GlobalLabel.deckCount` is what makes the
   * sentence sayable, and this panel — unlike the deck editor's dialog — is not standing inside
   * any one of those decks.
   */
  it("names the decks a delete reaches before deleting", async () => {
    await drawn();

    await userEvent.click(within(row("Cut candidate")).getByRole("button", { name: "Delete" }));

    const question = screen.getByRole("group", { name: "Delete Cut candidate" });
    expect(within(question).getByText(/3 decks/)).toBeInTheDocument();
  });

  /**
   * **The second fact, and it is the one no other label surface has to say.** A deckless write
   * records no `deck_audit` row and no `deck_undo` step, so Ctrl+Z in a deck finds nothing —
   * which a reader would otherwise discover by pressing it. The deck editor's own dialog still
   * records everything, so this sentence belongs here and nowhere else.
   */
  it("says a delete made from here cannot be undone", async () => {
    await drawn();

    await userEvent.click(within(row("Cut candidate")).getByRole("button", { name: "Delete" }));

    const question = screen.getByRole("group", { name: "Delete Cut candidate" });
    expect(within(question).getByText(/cannot be undone/i)).toBeInTheDocument();
    expect(within(question).getByText(/Ctrl\+Z/)).toBeInTheDocument();
  });

  it("deletes with no deck once the question is answered", async () => {
    await drawn();

    await userEvent.click(within(row("Cut candidate")).getByRole("button", { name: "Delete" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete label" }));

    await waitFor(() =>
      expect(sent).toContainEqual(["deck_label_delete", { deckId: null, id: 10 }]),
    );
  });

  it("keeps the label when the question is declined, and writes nothing", async () => {
    await drawn();

    await userEvent.click(within(row("Cut candidate")).getByRole("button", { name: "Delete" }));
    await userEvent.click(screen.getByRole("button", { name: "Keep it" }));

    expect(screen.queryByRole("group", { name: "Delete Cut candidate" })).not.toBeInTheDocument();
    expect(sent).toEqual([]);
  });

  /**
   * `deck_label_update` renames **and** recolours in one command with no patch shape, so each
   * half has to send the other back unchanged — a rename that quietly reset the colour, or a
   * recolour that reset the name, is a write nothing on screen would report.
   */
  it("recolours without renaming and renames without recolouring", async () => {
    await drawn();

    const cut = row("Cut candidate");
    await userEvent.click(
      within(cut).getByRole("button", { name: "Change colour of Cut candidate" }),
    );
    await userEvent.click(within(cut).getByRole("button", { name: "Azure" }));
    await userEvent.click(within(cut).getByRole("button", { name: "Done" }));

    await waitFor(() =>
      expect(sent).toContainEqual([
        "deck_label_update",
        { deckId: null, id: 10, name: "Cut candidate", color: "#0e68ab" },
      ]),
    );

    await userEvent.click(within(cut).getByRole("button", { name: "Rename" }));
    const field = within(cut).getByRole("textbox", { name: "Rename Cut candidate" });
    await userEvent.clear(field);
    await userEvent.type(field, "Shortlist");
    await userEvent.click(within(cut).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(sent).toContainEqual([
        "deck_label_update",
        { deckId: null, id: 10, name: "Shortlist", color: "#d3202a" },
      ]),
    );
  });

  /** `RenameField`'s own rule, checked at this panel's site: the caret starts in the field the
   *  reader opened, because the trigger it came from has just been disabled. */
  it("puts the caret in the rename field", async () => {
    await drawn();

    const cut = row("Cut candidate");
    await userEvent.click(within(cut).getByRole("button", { name: "Rename" }));

    expect(within(cut).getByRole("textbox", { name: "Rename Cut candidate" })).toHaveFocus();
  });

  /** An empty list is the state a reader who has never made a label is in, and it is who this
   *  screen is hardest for. */
  it("says what a label is when there are none", async () => {
    deckLabelAll.mockResolvedValue([]);
    await drawn();

    expect(await screen.findByText(/labels are yours/i)).toBeInTheDocument();
    // The way to make one is above the sentence, not behind it.
    expect(screen.getByRole("textbox", { name: /new label/i })).toBeInTheDocument();
  });

  /**
   * A refused read is not an empty list, and the two must not draw the same screen — "you have no
   * labels" over a list nothing has successfully read is the one sentence this panel must never
   * print.
   */
  it("reports a refused read rather than calling it an empty list", async () => {
    deckLabelAll.mockRejectedValue(new Error("database is locked"));
    await drawn();

    expect(await screen.findByRole("alert")).toHaveTextContent(/database is locked/i);
    expect(screen.queryByText(/labels are yours/i)).not.toBeInTheDocument();
  });

  it("reports a refused write on the panel's own line", async () => {
    deckLabelCreate.mockRejectedValueOnce(new Error("that name is taken"));
    await drawn();

    await userEvent.type(screen.getByRole("textbox", { name: /new label/i }), "Sideboard plan");
    await userEvent.click(screen.getByRole("button", { name: /add label/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/that name is taken/i);
  });
});
