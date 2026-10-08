import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DeckTodoList } from "@/lib/ipc";

const deckTodoLists = vi.hoisted(() => vi.fn());
const deckTodoListCreate = vi.hoisted(() => vi.fn());
const deckTodoListUpdate = vi.hoisted(() => vi.fn());
const deckTodoListDelete = vi.hoisted(() => vi.fn());
// The four commands are what the dialog *is* — every assertion below is about what one of them was
// asked or answered. `importOriginal` keeps `ipcError`, which the refusal line renders through.
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { deckTodoLists, deckTodoListCreate, deckTodoListUpdate, deckTodoListDelete },
}));

/** What the stand-in below was handed, one call per render. */
const editorRenders = vi.hoisted(() => vi.fn());

interface StandInProps {
  value: string;
  onChange: (markdown: string) => void;
  ariaLabel: string;
  mode?: "note" | "checklist";
}

/**
 * The lazy editor, stood in for by a textarea that **seeds its text once, at mount, and ignores
 * `value` after that** — stricter than the real one on purpose: the dialog promises that a body
 * arriving from elsewhere *remounts* the editor (a new `key`), and element identity is how a test
 * tells a remount from an edit. `DeckTodosPanel.test.tsx` carried this stand-in for #672; it moved
 * here with the autosave it exists to test.
 */
vi.mock("./NoteEditor", async () => {
  const { useState } = await import("react");
  return {
    default: function NoteEditorStandIn(props: StandInProps) {
      editorRenders(props);
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

import { TodoListDialog } from "./TodoListDialog";

/* --------------------------------------------------------------------- fixtures ------- */

const KEY = ["decks", "todos", 4];

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

/** The list most tests open on: id 7, titled, one to-do. */
const MANA = list({ id: 7, title: "Mana", body: "- [ ] Revise tokens" });

/** An update as `useTodoListSave` sends it — both fields, no compare-and-set. */
const update = (title: string, body: string, id = 7) => [4, id, { title, body, expected: null }];

function renderDialog({
  listId = 7 as number | null,
  lists = [MANA] as DeckTodoList[],
}: { listId?: number | null; lists?: DeckTodoList[] } = {}) {
  deckTodoLists.mockResolvedValue(lists);
  const onClose = vi.fn();
  const onDelete = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (open: boolean) => (
    <QueryClientProvider client={client}>
      <TodoListDialog
        deckId={4}
        open={open}
        listId={listId}
        onClose={onClose}
        onDelete={onDelete}
      />
    </QueryClientProvider>
  );
  const view = render(ui(true));
  return {
    ...view,
    client,
    onClose,
    onDelete,
    setOpen: (open: boolean) => view.rerender(ui(open)),
  };
}

const editor = () => screen.findByRole("textbox", { name: "To-do list" });
const textbox = () => screen.getByRole("textbox", { name: "To-do list" });
const titleField = () => screen.getByRole("textbox", { name: "Title" });

/** The body the cache holds for list 7 — how "the store" is read back. */
const cachedBody = (client: QueryClient, id = 7) =>
  (client.getQueryData(KEY) as DeckTodoList[] | undefined)?.find((l) => l.id === id)?.body;

/** A list changed elsewhere — the band ticking a card, another window, a sync apply. */
const arrive = (client: QueryClient, next: DeckTodoList) =>
  act(() => client.setQueryData(KEY, [next]));

const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Fake the two timer functions and nothing else, **only once the editor is on screen** — every
 *  `findBy*` polls on the real clock (memory: *Fake timers and query notifications*). */
const fakeClock = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

beforeEach(() => {
  vi.clearAllMocks();
  deckTodoListUpdate.mockResolvedValue(undefined);
  deckTodoListDelete.mockResolvedValue(undefined);
  deckTodoListCreate.mockImplementation((deckId: number, title: string, body: string) =>
    Promise.resolve(list({ id: 12, deckId, title, body, sortOrder: 3 })),
  );
});

afterEach(() => {
  vi.useRealTimers();
});

/* --------------------------------------------------------------------- an existing list */

describe("an existing list", () => {
  it("mounts the checklist editor and the title over the stored list", async () => {
    renderDialog();

    expect(await editor()).toHaveValue("- [ ] Revise tokens");
    expect(titleField()).toHaveValue("Mana");
    expect(screen.getByRole("dialog", { name: "Edit to-do list" })).toBeInTheDocument();
    expect(editorRenders).toHaveBeenLastCalledWith(
      expect.objectContaining({ mode: "checklist", ariaLabel: "To-do list" }),
    );
  });

  it("saves once, 600 ms after the last change, with both fields and no expected body", async () => {
    const { client } = renderDialog();
    const box = await editor();
    fakeClock();

    fireEvent.change(box, { target: { value: "- [ ] Revise tokens\n- [ ] C" } });
    await tick(400);
    fireEvent.change(box, { target: { value: "- [ ] Revise tokens\n- [ ] Cut" } });
    await tick(599);
    expect(deckTodoListUpdate).not.toHaveBeenCalled();

    await tick(1);
    expect(deckTodoListUpdate).toHaveBeenCalledTimes(1);
    expect(deckTodoListUpdate).toHaveBeenCalledWith(
      ...update("Mana", "- [ ] Revise tokens\n- [ ] Cut"),
    );
    expect(deckTodoListCreate).not.toHaveBeenCalled();

    // The dialog's own answer coming back is not a list from elsewhere.
    await tick(0);
    expect(cachedBody(client)).toBe("- [ ] Revise tokens\n- [ ] Cut");
    expect(textbox()).toBe(box);
  });

  it("sends the title on the same save as the body", async () => {
    renderDialog();
    const box = await editor();
    fakeClock();

    fireEvent.change(titleField(), { target: { value: "Mana base" } });
    await tick(300);
    fireEvent.change(box, { target: { value: "- [x] Revise tokens" } });
    await tick(600);

    expect(deckTodoListUpdate).toHaveBeenCalledTimes(1);
    expect(deckTodoListUpdate).toHaveBeenCalledWith(...update("Mana base", "- [x] Revise tokens"));
  });

  it("holds the editor still while its own save is on the wire", async () => {
    let answer: () => void = () => {};
    deckTodoListUpdate.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          answer = resolve;
        }),
    );
    renderDialog();
    const box = await editor();
    fakeClock();

    fireEvent.change(box, { target: { value: "- [ ] Revise tokens\n- [ ] Mine" } });
    await tick(600);
    expect(deckTodoListUpdate).toHaveBeenCalledTimes(1);
    expect(textbox()).toBe(box);
    expect(box).toHaveValue("- [ ] Revise tokens\n- [ ] Mine");

    await act(async () => answer());
    await tick(0);
    expect(textbox()).toBe(box);
    expect(box).toHaveValue("- [ ] Revise tokens\n- [ ] Mine");
  });

  /** Two pauses, two saves, answered newest first — the order an unfair write lock can hand them
   *  out. The dialog's scope must have made the newer one wait its turn. */
  it("lands two saves in the order they were typed, whichever order their answers come in", async () => {
    const answers: Array<() => void> = [];
    deckTodoListUpdate.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          answers.push(resolve);
        }),
    );
    const { client } = renderDialog();
    const box = await editor();
    fakeClock();

    const older = "- [ ] Revise tokens\n- [ ] Cut";
    const newer = "- [ ] Revise tokens\n- [ ] Cut three creatures";
    fireEvent.change(box, { target: { value: older } });
    await tick(600);
    fireEvent.change(box, { target: { value: newer } });
    await tick(600);

    expect(deckTodoListUpdate).toHaveBeenCalledTimes(1);

    while (answers.length > 0) {
      const next = answers.pop()!;
      await act(async () => next());
      await tick(0);
    }

    expect(deckTodoListUpdate.mock.calls.map(([, , change]) => change.body)).toEqual([
      older,
      newer,
    ]);
    expect(cachedBody(client)).toBe(newer);
    expect(textbox()).toBe(box);
    expect(box).toHaveValue(newer);
  });

  it("sends a revert made while its own save is on the wire, and ends on it", async () => {
    const before = "- [ ] Revise tokens\n- [ ] Cut Clue tokens";
    const deleted = "- [ ] Revise tokens";
    const answers: Array<() => void> = [];
    deckTodoListUpdate.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          answers.push(resolve);
        }),
    );
    const { client } = renderDialog({ lists: [list({ ...MANA, body: before })] });
    const box = await editor();
    fakeClock();

    act(() => box.focus());
    fireEvent.change(box, { target: { value: deleted } });
    await tick(600);
    expect(deckTodoListUpdate).toHaveBeenCalledTimes(1);

    fireEvent.change(box, { target: { value: before } });
    act(() => box.blur());
    await tick(0);

    while (answers.length > 0) {
      const next = answers.shift()!;
      await act(async () => next());
      await tick(0);
    }

    expect(deckTodoListUpdate.mock.calls.map(([, , change]) => change.body)).toEqual([
      deleted,
      before,
    ]);
    expect(cachedBody(client)).toBe(before);
    expect(textbox()).toHaveValue(before);
  });

  it("keeps its saved body when a read that began before the save answers after it", async () => {
    const { client } = renderDialog();
    const box = await editor();

    let stale: (lists: DeckTodoList[]) => void = () => {};
    deckTodoLists.mockImplementation(
      () =>
        new Promise<DeckTodoList[]>((resolve) => {
          stale = resolve;
        }),
    );
    act(() => {
      void client.invalidateQueries({ queryKey: KEY });
    });
    await waitFor(() => expect(deckTodoLists).toHaveBeenCalledTimes(2));
    fakeClock();

    const mine = "- [ ] Revise tokens\n- [ ] Mine";
    fireEvent.change(box, { target: { value: mine } });
    await tick(600);
    await tick(0);
    expect(deckTodoListUpdate).toHaveBeenCalledWith(...update("Mana", mine));

    await act(async () => stale([MANA]));
    await tick(0);

    expect(cachedBody(client)).toBe(mine);
    expect(textbox()).toBe(box);
    expect(box).toHaveValue(mine);
  });

  it("writes the pending draft when it unmounts before the delay is up", async () => {
    const view = renderDialog();
    const box = await editor();
    fakeClock();

    fireEvent.change(box, { target: { value: "- [ ] Revise tokens\n- [ ] Last words" } });
    await tick(100);
    expect(deckTodoListUpdate).not.toHaveBeenCalled();

    view.unmount();
    await tick(0);

    expect(deckTodoListUpdate).toHaveBeenCalledTimes(1);
    expect(deckTodoListUpdate).toHaveBeenCalledWith(
      ...update("Mana", "- [ ] Revise tokens\n- [ ] Last words"),
    );
  });

  it("writes the pending draft the moment the caret leaves the editor, and not again", async () => {
    renderDialog();
    const box = await editor();
    fakeClock();

    act(() => box.focus());
    fireEvent.change(box, { target: { value: "- [x] Revise tokens" } });
    act(() => box.blur());
    await tick(0);

    expect(deckTodoListUpdate).toHaveBeenCalledTimes(1);
    expect(deckTodoListUpdate).toHaveBeenCalledWith(...update("Mana", "- [x] Revise tokens"));

    await tick(600);
    expect(deckTodoListUpdate).toHaveBeenCalledTimes(1);
  });

  it("writes the pending draft when Done is pressed, and closes", async () => {
    const { onClose } = renderDialog();
    const box = await editor();
    fakeClock();

    fireEvent.change(box, { target: { value: "- [x] Revise tokens" } });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await tick(0);

    expect(deckTodoListUpdate).toHaveBeenCalledWith(...update("Mana", "- [x] Revise tokens"));
    expect(onClose).toHaveBeenCalledTimes(1);
    await tick(600);
    expect(deckTodoListUpdate).toHaveBeenCalledTimes(1);
  });

  it("stores a list emptied of every block as an empty body", async () => {
    renderDialog();
    const box = await editor();
    fakeClock();

    // What the editor emits when the reader deletes the last word: one empty to-do, which is a
    // shape of the document and not a to-do.
    fireEvent.change(box, { target: { value: "- [ ] " } });
    await tick(600);

    expect(deckTodoListUpdate).toHaveBeenCalledWith(...update("Mana", ""));
  });

  it("writes nothing when the draft comes back to what is stored", async () => {
    renderDialog();
    const box = await editor();
    fakeClock();

    fireEvent.change(box, { target: { value: "- [ ] Revise tokensX" } });
    fireEvent.change(box, { target: { value: "- [ ] Revise tokens" } });
    fireEvent.change(titleField(), { target: { value: "ManaX" } });
    fireEvent.change(titleField(), { target: { value: "Mana" } });
    await tick(600);

    expect(deckTodoListUpdate).not.toHaveBeenCalled();
  });

  it("writes nothing for an empty to-do the reader has not typed in, and keeps it on screen", async () => {
    renderDialog();
    const box = await editor();
    fakeClock();

    act(() => box.focus());
    fireEvent.change(box, { target: { value: "- [ ] Revise tokens\n- [ ] " } });
    act(() => box.blur());
    await tick(600);
    await tick(0);

    expect(deckTodoListUpdate).not.toHaveBeenCalled();
    expect(textbox()).toBe(box);
    expect(box).toHaveValue("- [ ] Revise tokens\n- [ ] ");
  });

  it("sends an edit that only nests one mark inside another", async () => {
    renderDialog({ lists: [list({ ...MANA, body: "- [ ] **bold nested italic**" })] });
    const box = await editor();
    fakeClock();

    act(() => box.focus());
    fireEvent.change(box, { target: { value: "- [ ] **bold *nested italic***" } });
    act(() => box.blur());
    await tick(0);

    expect(deckTodoListUpdate).toHaveBeenCalledWith(
      ...update("Mana", "- [ ] **bold *nested italic***"),
    );
  });

  it("keeps the draft on screen when a save is refused, says why, and retries at the next way out", async () => {
    deckTodoListUpdate.mockRejectedValue("The collection is busy syncing. Try again in a moment.");
    renderDialog();
    const box = await editor();
    fakeClock();

    fireEvent.change(box, { target: { value: "- [ ] Revise tokens\n- [ ] Mine" } });
    await tick(600);
    await tick(0);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "The collection is busy syncing. Try again in a moment.",
    );
    expect(textbox()).toBe(box);
    expect(box).toHaveValue("- [ ] Revise tokens\n- [ ] Mine");

    deckTodoListUpdate.mockResolvedValue(undefined);
    act(() => box.focus());
    act(() => box.blur());
    await tick(0);
    expect(deckTodoListUpdate).toHaveBeenCalledTimes(2);
    expect(deckTodoListUpdate).toHaveBeenLastCalledWith(
      ...update("Mana", "- [ ] Revise tokens\n- [ ] Mine"),
    );
  });
});

/* --------------------------------------------------------------------- adopting ------- */

describe("a list changed elsewhere", () => {
  it("replaces the editor when nobody is in it and nothing is unsaved", async () => {
    const { client } = renderDialog();
    const box = await editor();

    arrive(client, list({ ...MANA, body: "- [x] Revise tokens" }));

    await waitFor(() => expect(textbox()).toHaveValue("- [x] Revise tokens"));
    expect(textbox()).not.toBe(box);
    expect(deckTodoListUpdate).not.toHaveBeenCalled();
  });

  it("waits while the caret is in the dialog, and takes it once the caret leaves", async () => {
    const { client } = renderDialog();
    const box = await editor();

    act(() => box.focus());
    arrive(client, list({ ...MANA, title: "Mana base", body: "- [x] Revise tokens" }));
    await settle();

    expect(textbox()).toBe(box);
    expect(box).toHaveValue("- [ ] Revise tokens");
    expect(titleField()).toHaveValue("Mana");

    act(() => box.blur());

    await waitFor(() => expect(textbox()).toHaveValue("- [x] Revise tokens"));
    expect(titleField()).toHaveValue("Mana base");
    expect(deckTodoListUpdate).not.toHaveBeenCalled();
  });

  it("loses to an unsaved draft, which the next autosave writes over it", async () => {
    const { client } = renderDialog();
    const box = await editor();
    fakeClock();

    fireEvent.change(box, { target: { value: "- [ ] Revise tokens\n- [ ] Mine" } });
    arrive(client, list({ ...MANA, body: "- [x] Revise tokens" }));
    await tick(0);

    expect(textbox()).toBe(box);
    expect(box).toHaveValue("- [ ] Revise tokens\n- [ ] Mine");

    await tick(600);
    expect(deckTodoListUpdate).toHaveBeenCalledWith(
      ...update("Mana", "- [ ] Revise tokens\n- [ ] Mine"),
    );
    await tick(0);
    expect(textbox()).toBe(box);
  });
});

/* --------------------------------------------------------------------- a new list ----- */

describe("a new list", () => {
  it("opens on nothing, with no read to wait for", async () => {
    renderDialog({ listId: null, lists: [] });

    expect(await editor()).toHaveValue("");
    expect(titleField()).toHaveValue("");
    expect(screen.getByRole("dialog", { name: "New to-do list" })).toBeInTheDocument();
  });

  it("creates on its first real change, and updates the id it answered after that — never a second create", async () => {
    renderDialog({ listId: null, lists: [] });
    const box = await editor();
    fakeClock();

    fireEvent.change(box, { target: { value: "- [ ] Buy sleeves" } });
    await tick(600);
    await tick(0);
    expect(deckTodoListCreate).toHaveBeenCalledTimes(1);
    expect(deckTodoListCreate).toHaveBeenCalledWith(4, "", "- [ ] Buy sleeves");

    fireEvent.change(box, { target: { value: "- [ ] Buy sleeves\n- [ ] Sort" } });
    await tick(600);
    await tick(0);

    expect(deckTodoListCreate).toHaveBeenCalledTimes(1);
    expect(deckTodoListUpdate).toHaveBeenCalledWith(
      ...update("", "- [ ] Buy sleeves\n- [ ] Sort", 12),
    );
  });

  /** The scope is per dialog, so an update queued behind a create waits for the id it answers. */
  it("holds an update typed while the create is on the wire until the create answers", async () => {
    let answer: () => void = () => {};
    deckTodoListCreate.mockImplementation(
      (deckId: number, title: string, body: string) =>
        new Promise<DeckTodoList>((resolve) => {
          answer = () => resolve(list({ id: 12, deckId, title, body }));
        }),
    );
    renderDialog({ listId: null, lists: [] });
    const box = await editor();
    fakeClock();

    fireEvent.change(box, { target: { value: "- [ ] Buy" } });
    await tick(600);
    fireEvent.change(box, { target: { value: "- [ ] Buy sleeves" } });
    await tick(600);

    expect(deckTodoListCreate).toHaveBeenCalledTimes(1);
    expect(deckTodoListUpdate).not.toHaveBeenCalled();

    await act(async () => answer());
    await tick(0);
    await tick(0);

    expect(deckTodoListCreate).toHaveBeenCalledTimes(1);
    expect(deckTodoListUpdate).toHaveBeenCalledWith(...update("", "- [ ] Buy sleeves", 12));
  });

  it("creates nothing when it is closed untouched", async () => {
    const { onClose } = renderDialog({ listId: null, lists: [] });
    const box = await editor();
    fakeClock();

    // The editor's own floor — one empty to-do — is not a change a reader made.
    fireEvent.change(box, { target: { value: "- [ ] " } });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await tick(600);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(deckTodoListCreate).not.toHaveBeenCalled();
    expect(deckTodoListUpdate).not.toHaveBeenCalled();
  });

  /** `isBlankList` trims the title, so spaces are not a title — the one case where "blank" and
   *  "agrees with nothing typed" part company. */
  it("creates nothing for a title of spaces and an empty list", async () => {
    const { onClose } = renderDialog({ listId: null, lists: [] });
    const box = await editor();
    fakeClock();

    fireEvent.change(titleField(), { target: { value: "   " } });
    fireEvent.change(box, { target: { value: "- [ ] " } });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await tick(600);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(deckTodoListCreate).not.toHaveBeenCalled();
  });

  it("creates a list with an empty body when only a title was typed", async () => {
    const { onClose } = renderDialog({ listId: null, lists: [] });
    await editor();
    fakeClock();

    fireEvent.change(titleField(), { target: { value: "Groceries" } });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await tick(0);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(deckTodoListCreate).toHaveBeenCalledTimes(1);
    expect(deckTodoListCreate).toHaveBeenCalledWith(4, "Groceries", "");
  });

  it("throws a list never made away on Delete list, asking nothing", async () => {
    const { onClose, onDelete } = renderDialog({ listId: null, lists: [] });
    const box = await editor();
    fakeClock();

    fireEvent.change(box, { target: { value: "- [ ] Nope" } });
    fireEvent.click(screen.getByRole("button", { name: "Delete list" }));
    await tick(600);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onDelete).not.toHaveBeenCalled();
    expect(deckTodoListCreate).not.toHaveBeenCalled();
  });
});

/* --------------------------------------------------------------------- deleting ------- */

describe("Delete list", () => {
  it("asks first, then hands the id to the host and writes nothing it owed", async () => {
    const { onClose, onDelete } = renderDialog();
    const box = await editor();

    fireEvent.change(box, { target: { value: "- [ ] Revise tokens\n- [ ] Going anyway" } });
    fireEvent.click(screen.getByRole("button", { name: "Delete list" }));

    const question = await screen.findByRole("dialog", { name: "Delete “Mana”?" });
    expect(question).toHaveTextContent("Its to-dos go with it.");
    fireEvent.click(within(question).getByRole("button", { name: "Delete list" }));

    expect(onDelete).toHaveBeenCalledWith(7);
    expect(onClose).toHaveBeenCalledTimes(1);
    await settle();
    expect(deckTodoListUpdate).not.toHaveBeenCalled();
  });

  it("does nothing when the question is cancelled", async () => {
    const { onDelete, onClose } = renderDialog();
    await editor();

    fireEvent.click(screen.getByRole("button", { name: "Delete list" }));
    const question = await screen.findByRole("dialog", { name: "Delete “Mana”?" });
    fireEvent.click(within(question).getByRole("button", { name: "Cancel" }));

    expect(onDelete).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
