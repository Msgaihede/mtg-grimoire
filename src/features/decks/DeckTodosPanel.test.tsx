import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DeckTodoList } from "@/lib/ipc";

const deckTodoLists = vi.hoisted(() => vi.fn());
const deckTodoListCreate = vi.hoisted(() => vi.fn());
const deckTodoListUpdate = vi.hoisted(() => vi.fn());
const deckTodoListDelete = vi.hoisted(() => vi.fn());
// `importOriginal` keeps `ipcError`, which the refusal line renders through.
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { deckTodoLists, deckTodoListCreate, deckTodoListUpdate, deckTodoListDelete },
}));

/** The lazy editor, as a textarea — the dialog's autosave is `TodoListDialog.test.tsx`'s; the
 *  band only needs to see that the dialog opened, and on which list. */
vi.mock("./NoteEditor", async () => {
  const { useState } = await import("react");
  return {
    default: function NoteEditorStandIn(props: {
      value: string;
      onChange: (markdown: string) => void;
      ariaLabel: string;
    }) {
      const [text, setText] = useState(props.value);
      return (
        <textarea
          aria-label={props.ariaLabel}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            props.onChange(e.target.value);
          }}
        />
      );
    },
  };
});

import { DeckTodosPanel, NEW_LIST_LABEL, NO_LISTS, TODOS_HEADING } from "./DeckTodosPanel";

/* --------------------------------------------------------------------- fixtures ------- */

function list(over: Partial<DeckTodoList> & { id: number }): DeckTodoList {
  return {
    deckId: 4,
    title: "",
    body: "",
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

/** Two open and one done, one of them a sub-to-do, under a heading and beside a paragraph. */
const MANA = list({
  id: 7,
  title: "Mana",
  sortOrder: 1,
  body: "## Lands\n\n- [ ] Cut a land\n  - [x] Check curve\n\nSome notes about **why**.",
});
/** One open, and drawn first although its id is higher — the band orders by `sortOrder`. */
const TOKENS = list({ id: 9, title: "Tokens", sortOrder: 0, body: "- [ ] Revise tokens" });
/** An untitled list, drawn under the placeholder name. */
const UNTITLED = list({ id: 11, title: "  ", sortOrder: 2, body: "- [x] Sleeve the deck" });

const TODOS_CHANGED = "That to-do list changed since it was read. Try again.";

function renderBand(props: { open?: boolean; lists?: DeckTodoList[] } = {}) {
  deckTodoLists.mockResolvedValue(props.lists ?? [MANA, TOKENS, UNTITLED]);
  const onToggle = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const band = (open: boolean) => (
    <QueryClientProvider client={client}>
      <DeckTodosPanel deckId={4} open={open} onToggle={onToggle} />
    </QueryClientProvider>
  );
  const view = render(band(props.open ?? true));
  return { ...view, onToggle, client, setOpen: (open: boolean) => view.rerender(band(open)) };
}

const region = () => screen.findByRole("region", { name: TODOS_HEADING });
/** Every card's `Edit`, in the order they are drawn — the cards' order, read off their names. */
const editButtons = () => screen.getAllByRole("button", { name: /^Edit / });

beforeEach(() => {
  vi.clearAllMocks();
  deckTodoListUpdate.mockResolvedValue(undefined);
  deckTodoListDelete.mockResolvedValue(undefined);
  deckTodoListCreate.mockImplementation((deckId: number, title: string, body: string) =>
    Promise.resolve(list({ id: 20, deckId, title, body, sortOrder: 3 })),
  );
});

/* --------------------------------------------------------------------- the header ----- */

describe("the band's header", () => {
  it("sums every list's to-dos, and draws no card while shut", async () => {
    renderBand({ open: false });
    const band = await region();

    expect(within(band).getByRole("button", { name: TODOS_HEADING })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    // Mana: 1 open, 1 done. Tokens: 1 open. Untitled: 1 done.
    expect(await within(band).findByText("2 open · 2 done")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Edit / })).toBeNull();
  });

  it("draws no count for a deck with no to-do in any list", async () => {
    renderBand({ lists: [list({ id: 3, title: "Empty" })] });
    const band = await region();

    await within(band).findByRole("button", { name: "Edit Empty" });
    expect(within(band).queryByText(/open ·/)).toBeNull();
  });

  it("asks the host to open it when the disclosure is pressed", async () => {
    const { onToggle } = renderBand({ open: false });

    await userEvent.click(within(await region()).getByRole("button", { name: TODOS_HEADING }));

    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it("follows a list changed elsewhere", async () => {
    const { client } = renderBand({ open: false, lists: [TOKENS] });
    const band = await region();
    expect(await within(band).findByText("1 open · 0 done")).toBeInTheDocument();

    act(() =>
      client.setQueryData(["decks", "todos", 4], [{ ...TOKENS, body: "- [x] Revise tokens" }]),
    );

    expect(await within(band).findByText("0 open · 1 done")).toBeInTheDocument();
  });
});

/* --------------------------------------------------------------------- the cards ------ */

describe("the cards", () => {
  it("draws one card per list, in sortOrder, an untitled one as Untitled list", async () => {
    renderBand();
    await screen.findByRole("button", { name: "Edit Tokens" });

    expect(editButtons().map((b) => b.textContent)).toEqual([
      "Edit Tokens",
      "Edit Mana",
      "Edit Untitled list",
    ]);
  });

  it("draws a list's headings, text and to-dos with no editor", async () => {
    renderBand({ lists: [MANA] });
    const band = await region();

    expect(await within(band).findByText("Lands")).toBeInTheDocument();
    expect(within(band).getByText("why")).toBeInTheDocument();
    expect(
      within(band).getByRole("checkbox", { name: 'Mark "Cut a land" done' }),
    ).not.toBeChecked();
    expect(
      within(band).getByRole("checkbox", { name: 'Mark "Check curve" not done' }),
    ).toBeChecked();
    // Reading a list loads no editor.
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("says so in one line when the deck has no list", async () => {
    renderBand({ lists: [] });

    expect(await within(await region()).findByText(NO_LISTS)).toBeInTheDocument();
  });
});

/* --------------------------------------------------------------------- ticking -------- */

describe("a tick", () => {
  it("writes the list's body with the box flipped, against the body the card drew", async () => {
    renderBand({ lists: [MANA] });
    const box = await screen.findByRole("checkbox", { name: 'Mark "Cut a land" done' });

    await userEvent.click(box);

    expect(deckTodoListUpdate).toHaveBeenCalledTimes(1);
    expect(deckTodoListUpdate).toHaveBeenCalledWith(4, 7, {
      body: MANA.body.replace("- [ ] Cut a land", "- [x] Cut a land"),
      expected: MANA.body,
    });
    // A success writes the new body into the cache, so the box is ticked at once.
    expect(
      await screen.findByRole("checkbox", { name: 'Mark "Cut a land" not done' }),
    ).toBeChecked();
    // Ticking in place opens nothing.
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("refuses every box on the card while its tick is on the wire", async () => {
    deckTodoListUpdate.mockImplementation(() => new Promise<void>(() => {}));
    renderBand({ lists: [MANA, TOKENS] });
    const box = await screen.findByRole("checkbox", { name: 'Mark "Cut a land" done' });

    await userEvent.click(box);

    expect(box).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("checkbox", { name: 'Mark "Check curve" not done' })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    // Another card's boxes are not this tick's business.
    expect(screen.getByRole("checkbox", { name: 'Mark "Revise tokens" done' })).not.toHaveAttribute(
      "aria-disabled",
    );

    await userEvent.click(screen.getByRole("checkbox", { name: 'Mark "Check curve" not done' }));
    expect(deckTodoListUpdate).toHaveBeenCalledTimes(1);
  });

  /**
   * **Review focus 3** — a card ticked while its dialog is open in another window: the body moved,
   * the compare-and-set refuses, and the band re-reads rather than overwriting what was typed.
   */
  it("re-reads the lists and says why when the list changed since the card drew it", async () => {
    deckTodoListUpdate.mockRejectedValue(TODOS_CHANGED);
    renderBand({ lists: [MANA] });
    const band = await region();
    const box = await within(band).findByRole("checkbox", { name: 'Mark "Cut a land" done' });
    expect(deckTodoLists).toHaveBeenCalledTimes(1);

    await userEvent.click(box);

    expect(await within(band).findByRole("alert")).toHaveTextContent(TODOS_CHANGED);
    await waitFor(() => expect(deckTodoLists).toHaveBeenCalledTimes(2));
    expect(deckTodoListUpdate).toHaveBeenCalledTimes(1);
  });
});

/* --------------------------------------------------------------------- editing -------- */

describe("editing a list", () => {
  it("opens the dialog on that list from Edit", async () => {
    renderBand();

    await userEvent.click(await screen.findByRole("button", { name: "Edit Mana" }));

    const dialog = await screen.findByRole("dialog", { name: "Edit to-do list" });
    expect(within(dialog).getByRole("textbox", { name: "Title" })).toHaveValue("Mana");
    expect(await within(dialog).findByRole("textbox", { name: "To-do list" })).toHaveValue(
      MANA.body,
    );
  });

  it("opens the dialog from a press on the card outside its controls", async () => {
    renderBand({ lists: [TOKENS] });

    await userEvent.click(await screen.findByText("Revise tokens"));

    const dialog = await screen.findByRole("dialog", { name: "Edit to-do list" });
    expect(within(dialog).getByRole("textbox", { name: "Title" })).toHaveValue("Tokens");
  });

  it("hands the caret back to Edit when the dialog is closed", async () => {
    renderBand({ lists: [TOKENS] });
    const edit = await screen.findByRole("button", { name: "Edit Tokens" });

    await userEvent.click(edit);
    const dialog = await screen.findByRole("dialog", { name: "Edit to-do list" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Done" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(edit).toHaveFocus();
  });
});

/* --------------------------------------------------------------------- deleting ------- */

describe("deleting a list", () => {
  it("asks first, then deletes", async () => {
    renderBand();

    await userEvent.click(await screen.findByRole("button", { name: "Delete Mana" }));

    const question = await screen.findByRole("dialog", { name: "Delete “Mana”?" });
    expect(question).toHaveTextContent("Its to-dos go with it.");
    expect(deckTodoListDelete).not.toHaveBeenCalled();

    await userEvent.click(within(question).getByRole("button", { name: "Delete list" }));

    expect(deckTodoListDelete).toHaveBeenCalledWith(4, 7);
  });

  it("deletes nothing when the question is cancelled", async () => {
    renderBand();

    await userEvent.click(await screen.findByRole("button", { name: "Delete Tokens" }));
    const question = await screen.findByRole("dialog", { name: "Delete “Tokens”?" });
    await userEvent.click(within(question).getByRole("button", { name: "Cancel" }));

    expect(deckTodoListDelete).not.toHaveBeenCalled();
  });
});

/* --------------------------------------------------------------------- New to-do list - */

describe("New to-do list", () => {
  it("opens a shut band and a dialog on a list not made yet", async () => {
    const { onToggle } = renderBand({ open: false });
    const band = await region();

    await userEvent.click(within(band).getByRole("button", { name: NEW_LIST_LABEL }));

    expect(onToggle).toHaveBeenCalledWith(true);
    const dialog = await screen.findByRole("dialog", { name: "New to-do list" });
    expect(within(dialog).getByRole("textbox", { name: "Title" })).toHaveValue("");
    expect(await within(dialog).findByRole("textbox", { name: "To-do list" })).toHaveValue("");
    // Opening the dialog is not a write.
    expect(deckTodoListCreate).not.toHaveBeenCalled();
  });

  it("creates nothing when the new list is closed untouched", async () => {
    renderBand();

    await userEvent.click(await screen.findByRole("button", { name: NEW_LIST_LABEL }));
    const dialog = await screen.findByRole("dialog", { name: "New to-do list" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Done" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(deckTodoListCreate).not.toHaveBeenCalled();
  });

  /** **Review focus 4** — a title and nothing else is not blank. */
  it("creates a list with an empty body when only a title was typed", async () => {
    renderBand();

    await userEvent.click(await screen.findByRole("button", { name: NEW_LIST_LABEL }));
    const dialog = await screen.findByRole("dialog", { name: "New to-do list" });
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Title" }), "Groceries");
    await userEvent.click(within(dialog).getByRole("button", { name: "Done" }));

    await waitFor(() => expect(deckTodoListCreate).toHaveBeenCalledTimes(1));
    expect(deckTodoListCreate).toHaveBeenCalledWith(4, "Groceries", "");
    expect(await screen.findByRole("button", { name: "Edit Groceries" })).toBeInTheDocument();
  });
});

/* --------------------------------------------------------------------- refusal -------- */

describe("a refused read", () => {
  it("draws no card and no count, and says so in one line", async () => {
    deckTodoLists.mockRejectedValue("That deck is not there any more.");
    const onToggle = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <DeckTodosPanel deckId={4} open onToggle={onToggle} />
      </QueryClientProvider>,
    );
    const band = await region();

    expect(await within(band).findByRole("alert")).toHaveTextContent(
      "That deck is not there any more.",
    );
    expect(within(band).getAllByRole("alert")).toHaveLength(1);
    expect(within(band).queryByText(/loading/i)).toBeNull();
    expect(within(band).queryByText(/open ·/)).toBeNull();
    expect(within(band).queryByText(NO_LISTS)).toBeNull();
  });
});

/* --------------------------------------------------------------------- placement ------ */

describe("the band's shell", () => {
  /** The two placement constraints on this component's own root: a `<section>`, never an
   *  `<aside>`, and `shrink-0`. `classList` because jsdom applies no stylesheet. */
  it("is a shrink-0 section whose body can be selected as text", async () => {
    renderBand({ open: false });
    const band = await region();

    expect(band.tagName).toBe("SECTION");
    expect(band.classList).toContain("shrink-0");

    const disclosure = within(band).getByRole("button", { name: TODOS_HEADING });
    const body = document.getElementById(disclosure.getAttribute("aria-controls") ?? "");
    expect(body).not.toBeNull();
    expect(body?.classList).toContain("select-text");
  });
});
