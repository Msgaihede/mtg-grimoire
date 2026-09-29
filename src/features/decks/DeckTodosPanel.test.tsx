import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const deckTodos = vi.hoisted(() => vi.fn());
const deckTodosSet = vi.hoisted(() => vi.fn());
// The two commands are what the band *is* — every assertion below is about what one of them was
// asked or answered. `importOriginal` keeps `ipcError`, which the refusal line renders through.
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { deckTodos, deckTodosSet },
}));

/** What the stand-in below was handed, one call per render — how a test reads `appendRequest`,
 *  `mode` and the label without the real editor drawing any of them. */
const editorRenders = vi.hoisted(() => vi.fn());

/** The props the band hands the lazy editor — the real component's three and checklist mode's
 *  three, so a rename on either side fails here rather than rendering nothing. */
interface StandInProps {
  value: string;
  onChange: (markdown: string) => void;
  ariaLabel: string;
  mode?: "note" | "checklist";
  appendRequest?: number;
  onAppendHandled?: () => void;
}

/**
 * The lazy editor, stood in for by a textarea — `DeckNotesPanel.test.tsx`'s mock, with one
 * difference that is the point of half this file.
 *
 * **It seeds its text once, at mount, and ignores `value` after that.** The real `NoteEditor`
 * does follow a changed `value`, so this is stricter than the thing it stands in for, on
 * purpose: the band promises that a body arriving from elsewhere *remounts* the editor (a new
 * `key`) rather than being pushed into one the reader may be typing in, and a controlled
 * textarea would show the new text either way and prove nothing about which of the two happened.
 * Element identity is the other half — a remount is a new `<textarea>`, an edit is the same one.
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

import { DeckTodosPanel, TODOS_HEADING } from "./DeckTodosPanel";

/* --------------------------------------------------------------------- fixtures ------- */

/** Two open and one done, one of them a sub-to-do — `countTodos` counts every depth. */
const NEST = "- [ ] Revise tokens\n  - [x] Cut Clue tokens\n- [ ] Sleeve the deck";

/** The key the band's read sits under — how "the widget ticked something" is spelled below. */
const KEY = ["decks", "todos", 4];

function renderBand(props: { open?: boolean } = {}) {
  const onToggle = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const band = (open: boolean) => (
    <QueryClientProvider client={client}>
      <DeckTodosPanel deckId={4} open={open} onToggle={onToggle} />
    </QueryClientProvider>
  );
  const view = render(band(props.open ?? true));
  return {
    ...view,
    onToggle,
    client,
    /** What the host does when it writes `decks.todos_open` and hands the answer back — under
     *  the same client, because `rerender` replaces the root. */
    setOpen: (open: boolean) => view.rerender(band(open)),
  };
}

const region = () => screen.findByRole("region", { name: TODOS_HEADING });
const editor = () => screen.findByRole("textbox", { name: "To-do list" });
const textbox = () => screen.getByRole("textbox", { name: "To-do list" });

/** Let TanStack's notifications land. They are delivered on a `setTimeout(0)`, so a microtask
 *  flush alone leaves the DOM on the old value (memory: *Fake timers and query notifications*). */
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

/**
 * Run a faked clock forward **and let every promise waiting on it settle**, inside `act`.
 *
 * The async variant rather than `advanceTimersByTime`, because a save is a mutation: the timer
 * fires, `mutate` awaits its way to the command, the command's promise settles, and the cache
 * write it makes is announced on another `setTimeout(0)`. Only the async clock walks that whole
 * chain in one call.
 */
async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/**
 * Fake the two timer functions and nothing else — the repo's shape (memory: *Fake timers and
 * query notifications*). **Only ever called after the editor is on screen**: every `findBy*`
 * above polls on the real clock, and `userEvent` hangs outright under a fake one, so no test
 * below that fakes the clock presses anything through `userEvent` afterwards.
 */
const fakeClock = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

beforeEach(() => {
  vi.clearAllMocks();
  deckTodos.mockResolvedValue("");
  deckTodosSet.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

/* --------------------------------------------------------------------- the header ----- */

describe("the band, shut", () => {
  it("is named To-do, says how many are open and done, and mounts no editor", async () => {
    deckTodos.mockResolvedValue(NEST);
    renderBand({ open: false });

    const band = await region();
    const disclosure = within(band).getByRole("button", { name: TODOS_HEADING });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(await within(band).findByText("2 open · 1 done")).toBeInTheDocument();

    // Shut is nothing mounted — not a hidden editor: Tiptap is 141.5 kB behind a `lazy`, and a
    // band nobody opened must not be what fetches it.
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(editorRenders).not.toHaveBeenCalled();
  });

  it("draws no count for a deck with no list", async () => {
    deckTodos.mockResolvedValue("");
    renderBand({ open: true });

    // The editor is on screen, which is what proves the read has landed — a count missing
    // *before* the read answers would prove nothing.
    await editor();
    expect(within(await region()).queryByText(/open ·/)).toBeNull();
  });

  it("asks the host to open it when the disclosure is pressed", async () => {
    const { onToggle } = renderBand({ open: false });

    await userEvent.click(within(await region()).getByRole("button", { name: TODOS_HEADING }));

    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it("follows a list changed elsewhere while it is shut", async () => {
    deckTodos.mockResolvedValue("- [ ] Revise tokens");
    const { client } = renderBand({ open: false });
    const band = await region();
    expect(await within(band).findByText("1 open · 0 done")).toBeInTheDocument();

    act(() => client.setQueryData(KEY, "- [x] Revise tokens"));

    expect(await within(band).findByText("0 open · 1 done")).toBeInTheDocument();
  });
});

/* --------------------------------------------------------------------- the editor ----- */

describe("the band, open", () => {
  it("mounts the checklist editor over the stored body", async () => {
    deckTodos.mockResolvedValue(NEST);
    renderBand();

    expect(await editor()).toHaveValue(NEST);
    expect(deckTodos).toHaveBeenCalledWith(4);
    expect(editorRenders).toHaveBeenLastCalledWith(
      expect.objectContaining({ mode: "checklist", ariaLabel: "To-do list" }),
    );
  });

  it("saves once, 600 ms after the last change, as the whole list with no expected body", async () => {
    deckTodos.mockResolvedValue("- [ ] Revise tokens");
    const { client } = renderBand();
    const box = await editor();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    fakeClock();

    fireEvent.change(box, { target: { value: "- [ ] Revise tokens\n- [ ] C" } });
    await tick(400);
    fireEvent.change(box, { target: { value: "- [ ] Revise tokens\n- [ ] Cut" } });
    await tick(599);
    expect(deckTodosSet).not.toHaveBeenCalled();

    await tick(1);
    expect(deckTodosSet).toHaveBeenCalledTimes(1);
    expect(deckTodosSet).toHaveBeenCalledWith(4, "- [ ] Revise tokens\n- [ ] Cut", null);

    // The widget's read is told by name; the deck's root is not, because an autosave per pause
    // re-reading the whole deck is the cost the hook's doc refuses.
    await tick(0);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["decks", "todos", "lists"] });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ["decks"] });

    // **The band's own answer coming back is not a body from elsewhere**: the editor that wrote
    // it is still the one on screen, not a remount seeded with its own words.
    expect(textbox()).toBe(box);
    expect(box).toHaveValue("- [ ] Revise tokens\n- [ ] Cut");
  });

  /**
   * **The half-second after every autosave, held open.** The band records the text it sent as
   * agreed the moment it sends it, while the cache still holds the body *before* it until the
   * command answers — so for the length of the round trip the two disagree, and a band that took
   * that as "a body from elsewhere" would seed the editor back to the reader's previous words and
   * then forward again. An answer that resolves at once never leaves a render in that gap, which
   * is why this one waits to be told.
   */
  it("holds the editor still while its own save is on the wire", async () => {
    deckTodos.mockResolvedValue("- [ ] Revise tokens");
    let answer: () => void = () => {};
    deckTodosSet.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          answer = resolve;
        }),
    );
    renderBand();
    const box = await editor();
    fakeClock();

    fireEvent.change(box, { target: { value: "- [ ] Revise tokens\n- [ ] Mine" } });
    await tick(600);
    expect(deckTodosSet).toHaveBeenCalledTimes(1);

    expect(textbox()).toBe(box);
    expect(box).toHaveValue("- [ ] Revise tokens\n- [ ] Mine");

    await act(async () => answer());
    await tick(0);
    expect(textbox()).toBe(box);
    expect(box).toHaveValue("- [ ] Revise tokens\n- [ ] Mine");
  });

  /**
   * **Two pauses, two saves — and the database's write lock is not fair.** `deck_todos_set` waits
   * up to five seconds for it, so under a busy lock two saves 600 ms apart can both be waiting and
   * the newer can win: disk ends on the older text, the older answer is cached last, and an idle
   * band adopts it over the newer words. The saves are answered here **newest first**, which is the
   * order that loses them; the band must have made the newer one wait its turn rather than race.
   */
  it("lands two saves in the order they were typed, whichever order their answers come in", async () => {
    deckTodos.mockResolvedValue("- [ ] Revise tokens");
    const answers: Array<() => void> = [];
    deckTodosSet.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          answers.push(resolve);
        }),
    );
    const { client } = renderBand();
    const box = await editor();
    fakeClock();

    const older = "- [ ] Revise tokens\n- [ ] Cut";
    const newer = "- [ ] Revise tokens\n- [ ] Cut three creatures";
    fireEvent.change(box, { target: { value: older } });
    await tick(600);
    fireEvent.change(box, { target: { value: newer } });
    await tick(600);

    // The newer save waits behind the older one rather than racing it for the lock.
    expect(deckTodosSet).toHaveBeenCalledTimes(1);

    // Answer whatever is on the wire, newest first — the order an unfair lock can hand them out.
    while (answers.length > 0) {
      const next = answers.pop()!;
      await act(async () => next());
      await tick(0);
    }

    expect(deckTodosSet.mock.calls.map(([, body]) => body)).toEqual([older, newer]);
    expect(client.getQueryData(KEY)).toBe(newer);
    expect(textbox()).toBe(box);
    expect(box).toHaveValue(newer);
  });

  /**
   * **A revert made while the band's own save is on the wire** — delete a line, pause, Ctrl+Z,
   * click away, under a lock that holds the save. While the save is out the store still holds the
   * body *before* it, which is exactly the body the revert returns to, so a band that asked the
   * store whether anything changed would send nothing — and the save of the deleted line would
   * land after it, be adopted by the idle band, and take the reverted line off the screen and the
   * disk. The last body sent is what a revert has to be measured against.
   */
  it("sends a revert made while its own save is on the wire, and ends on it", async () => {
    const before = "- [ ] Revise tokens\n- [ ] Cut Clue tokens";
    const deleted = "- [ ] Revise tokens";
    deckTodos.mockResolvedValue(before);
    const answers: Array<() => void> = [];
    deckTodosSet.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          answers.push(resolve);
        }),
    );
    const { client } = renderBand();
    const box = await editor();
    fakeClock();

    act(() => box.focus());
    fireEvent.change(box, { target: { value: deleted } });
    await tick(600);
    expect(deckTodosSet).toHaveBeenCalledTimes(1);

    fireEvent.change(box, { target: { value: before } });
    act(() => box.blur());
    await tick(0);

    // Answer each save as it reaches the wire; the second waits behind the first (the scope).
    while (answers.length > 0) {
      const next = answers.shift()!;
      await act(async () => next());
      await tick(0);
    }

    expect(deckTodosSet.mock.calls.map(([, body]) => body)).toEqual([deleted, before]);
    expect(client.getQueryData(KEY)).toBe(before);
    expect(textbox()).toHaveValue(before);
  });

  /**
   * **A re-read that began before the save, answering after it.** Every deck write invalidates
   * `["decks"]`, so a background read of this list can be in flight when the band saves — and it
   * holds the body from before the write. Landing after the band has cached its own answer, it
   * would put the old text back and an idle band would adopt it.
   */
  it("keeps its saved body when a read that began before the save answers after it", async () => {
    deckTodos.mockResolvedValue("- [ ] Revise tokens");
    const { client } = renderBand();
    const box = await editor();

    let stale: (body: string) => void = () => {};
    deckTodos.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          stale = resolve;
        }),
    );
    act(() => {
      void client.invalidateQueries({ queryKey: KEY });
    });
    await waitFor(() => expect(deckTodos).toHaveBeenCalledTimes(2));
    fakeClock();

    const mine = "- [ ] Revise tokens\n- [ ] Mine";
    fireEvent.change(box, { target: { value: mine } });
    await tick(600);
    await tick(0);
    expect(deckTodosSet).toHaveBeenCalledWith(4, mine, null);

    await act(async () => stale("- [ ] Revise tokens"));
    await tick(0);

    expect(client.getQueryData(KEY)).toBe(mine);
    expect(textbox()).toBe(box);
    expect(box).toHaveValue(mine);
  });

  /**
   * **The same race with the read starting while the save is on the wire** — the case a cancel in
   * `onMutate` cannot see, because it has already run by then. Holding the save open is what puts
   * the read inside the round trip.
   */
  it("keeps its saved body when a read that began during the save answers after it", async () => {
    deckTodos.mockResolvedValue("- [ ] Revise tokens");
    let answer: () => void = () => {};
    deckTodosSet.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          answer = resolve;
        }),
    );
    const { client } = renderBand();
    const box = await editor();
    fakeClock();

    const mine = "- [ ] Revise tokens\n- [ ] Mine";
    fireEvent.change(box, { target: { value: mine } });
    await tick(600);
    expect(deckTodosSet).toHaveBeenCalledTimes(1);

    let stale: (body: string) => void = () => {};
    deckTodos.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          stale = resolve;
        }),
    );
    await act(async () => {
      void client.invalidateQueries({ queryKey: KEY });
    });
    await tick(0);
    expect(deckTodos).toHaveBeenCalledTimes(2);

    await act(async () => answer());
    await tick(0);
    await act(async () => stale("- [ ] Revise tokens"));
    await tick(0);

    expect(client.getQueryData(KEY)).toBe(mine);
    expect(textbox()).toBe(box);
    expect(box).toHaveValue(mine);
  });

  it("writes the pending draft when it unmounts before the delay is up", async () => {
    deckTodos.mockResolvedValue("- [ ] Revise tokens");
    const view = renderBand();
    const box = await editor();
    fakeClock();

    fireEvent.change(box, { target: { value: "- [ ] Revise tokens\n- [ ] Last words" } });
    await tick(100);
    expect(deckTodosSet).not.toHaveBeenCalled();

    view.unmount();
    await tick(0);

    expect(deckTodosSet).toHaveBeenCalledTimes(1);
    expect(deckTodosSet).toHaveBeenCalledWith(4, "- [ ] Revise tokens\n- [ ] Last words", null);
  });

  it("writes the pending draft the moment the caret leaves the editor, and not again", async () => {
    deckTodos.mockResolvedValue("- [ ] Revise tokens");
    renderBand();
    const box = await editor();
    fakeClock();

    act(() => box.focus());
    fireEvent.change(box, { target: { value: "- [x] Revise tokens" } });
    act(() => box.blur());
    await tick(0);

    expect(deckTodosSet).toHaveBeenCalledTimes(1);
    expect(deckTodosSet).toHaveBeenCalledWith(4, "- [x] Revise tokens", null);

    // The flush took the timer with it, so the delay running out writes nothing a second time.
    await tick(600);
    expect(deckTodosSet).toHaveBeenCalledTimes(1);
  });

  it("stores a checklist with no to-do in it as no list at all", async () => {
    deckTodos.mockResolvedValue("- [ ] Revise tokens");
    renderBand();
    const box = await editor();
    fakeClock();

    // What the editor emits when the reader deletes the last word: one empty item, which is a
    // shape of the document and not a to-do. Stored as it stands, the widget would count a
    // deck with nothing to do as a deck with a list.
    fireEvent.change(box, { target: { value: "- [ ] " } });
    await tick(600);

    expect(deckTodosSet).toHaveBeenCalledWith(4, "", null);
  });

  it("writes nothing when the draft comes back to what is stored", async () => {
    deckTodos.mockResolvedValue("- [ ] Revise tokens");
    renderBand();
    const box = await editor();
    fakeClock();

    fireEvent.change(box, { target: { value: "- [ ] Revise tokensX" } });
    fireEvent.change(box, { target: { value: "- [ ] Revise tokens" } });
    await tick(600);

    expect(deckTodosSet).not.toHaveBeenCalled();
  });

  /**
   * **An empty to-do is a place to type, and writing one would be a write about nothing.** New
   * to-do, or Enter after the last line, then a click away: the draft now ends in `- [ ] `, a line
   * `parseTodos` drops. Sent, it would move the deck's `updated_at` — reordering *Last edited* in
   * the widget and the gallery — over a change nothing reads. And the editor keeps the empty line
   * while the reader is there: nothing is adopted over it.
   */
  it("writes nothing for an empty to-do the reader has not typed in, and keeps it on screen", async () => {
    deckTodos.mockResolvedValue("- [ ] Revise tokens");
    renderBand();
    const box = await editor();
    fakeClock();

    act(() => box.focus());
    fireEvent.change(box, { target: { value: "- [ ] Revise tokens\n- [ ] " } });
    act(() => box.blur());
    await tick(600);
    await tick(0);

    expect(deckTodosSet).not.toHaveBeenCalled();
    expect(textbox()).toBe(box);
    expect(box).toHaveValue("- [ ] Revise tokens\n- [ ] ");
  });

  it("writes nothing for an empty to-do added while its own save is on the wire", async () => {
    deckTodos.mockResolvedValue("- [ ] Revise tokens");
    let answer: () => void = () => {};
    deckTodosSet.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          answer = resolve;
        }),
    );
    const { client } = renderBand();
    const box = await editor();
    fakeClock();

    const mine = "- [ ] Revise tokens\n- [ ] Mine";
    act(() => box.focus());
    fireEvent.change(box, { target: { value: mine } });
    await tick(600);
    expect(deckTodosSet).toHaveBeenCalledTimes(1);

    // The empty line is measured against the body on the wire, not the store's older one.
    fireEvent.change(box, { target: { value: `${mine}\n- [ ] ` } });
    act(() => box.blur());
    await tick(0);
    await act(async () => answer());
    await tick(0);

    expect(deckTodosSet).toHaveBeenCalledTimes(1);
    expect(client.getQueryData(KEY)).toBe(mine);
    expect(textbox()).toBe(box);
    expect(box).toHaveValue(`${mine}\n- [ ] `);
  });

  it("writes nothing for an empty to-do taken away, and does not put it back", async () => {
    deckTodos.mockResolvedValue("- [ ] Revise tokens\n- [ ] ");
    renderBand();
    const box = await editor();
    fakeClock();

    act(() => box.focus());
    fireEvent.change(box, { target: { value: "- [ ] Revise tokens" } });
    act(() => box.blur());
    await tick(600);
    await tick(0);

    expect(deckTodosSet).not.toHaveBeenCalled();
    expect(textbox()).toBe(box);
    expect(box).toHaveValue("- [ ] Revise tokens");
  });

  it("writes a real change beside an empty to-do byte for byte", async () => {
    deckTodos.mockResolvedValue("- [ ] Revise tokens");
    renderBand();
    const box = await editor();
    fakeClock();

    act(() => box.focus());
    fireEvent.change(box, { target: { value: "- [x] Revise tokens\n- [ ] " } });
    act(() => box.blur());
    await tick(0);

    expect(deckTodosSet).toHaveBeenCalledTimes(1);
    expect(deckTodosSet).toHaveBeenCalledWith(4, "- [x] Revise tokens\n- [ ] ", null);
  });

  it("moves the header count with the draft, before anything is saved", async () => {
    deckTodos.mockResolvedValue("- [ ] Revise tokens\n- [ ] Cut Clue tokens");
    renderBand();
    const box = await editor();
    const band = await region();
    expect(within(band).getByText("2 open · 0 done")).toBeInTheDocument();

    fireEvent.change(box, { target: { value: "- [x] Revise tokens\n- [ ] Cut Clue tokens" } });

    expect(within(band).getByText("1 open · 1 done")).toBeInTheDocument();
    expect(deckTodosSet).not.toHaveBeenCalled();
  });

  it("keeps the draft on screen when a save is refused, and says why", async () => {
    deckTodos.mockResolvedValue("- [ ] Revise tokens");
    deckTodosSet.mockRejectedValue("The collection is busy syncing. Try again in a moment.");
    renderBand();
    const box = await editor();
    const band = await region();
    fakeClock();

    fireEvent.change(box, { target: { value: "- [ ] Revise tokens\n- [ ] Mine" } });
    await tick(600);
    await tick(0);

    expect(within(band).getByRole("alert")).toHaveTextContent(
      "The collection is busy syncing. Try again in a moment.",
    );
    // The stored body is still the old one, and a band that adopted it now would take the
    // reader's words away at the one moment they were not saved.
    expect(textbox()).toBe(box);
    expect(box).toHaveValue("- [ ] Revise tokens\n- [ ] Mine");

    // …and the draft is still owed, so the next way out tries again.
    deckTodosSet.mockResolvedValue(undefined);
    act(() => box.focus());
    act(() => box.blur());
    await tick(0);
    expect(deckTodosSet).toHaveBeenCalledTimes(2);
    expect(deckTodosSet).toHaveBeenLastCalledWith(4, "- [ ] Revise tokens\n- [ ] Mine", null);
  });
});

/* --------------------------------------------------------------------- refusal -------- */

describe("a refused read", () => {
  it("mounts no editor, says so in one line, and never saves", async () => {
    deckTodos.mockRejectedValue("That deck is not there any more.");
    renderBand({ open: true });
    const band = await region();

    expect(await within(band).findByRole("alert")).toHaveTextContent(
      "That deck is not there any more.",
    );
    expect(within(band).getAllByRole("alert")).toHaveLength(1);

    // **No editor over a body nobody read.** One mounted over `""` would be an empty checklist,
    // and the first keystroke would autosave it over whatever the deck really holds.
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(editorRenders).not.toHaveBeenCalled();
    // And no "loading" either: the alert has said what happened.
    expect(within(band).queryByText(/loading/i)).toBeNull();
    // No count: a `0 open` beside a refusal is a number the app does not have.
    expect(within(band).queryByText(/open ·/)).toBeNull();

    await userEvent.click(within(band).getByRole("button", { name: "New to-do" }));
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(deckTodosSet).not.toHaveBeenCalled();
  });
});

/* --------------------------------------------------------------------- New to-do ------ */

describe("New to-do", () => {
  it("opens a shut band and asks the editor for a fresh item, once per press", async () => {
    deckTodos.mockResolvedValue("- [ ] Revise tokens");
    const { onToggle, setOpen } = renderBand({ open: false });
    const band = await region();

    await userEvent.click(within(band).getByRole("button", { name: "New to-do" }));
    expect(onToggle).toHaveBeenCalledWith(true);

    // The host writes `todos_open` and hands the answer back; the editor that mounts is asked.
    setOpen(true);
    await editor();
    expect(editorRenders).toHaveBeenLastCalledWith(expect.objectContaining({ appendRequest: 1 }));

    // Taking the request clears it, so a remount later does not append a second time.
    const handled = editorRenders.mock.lastCall![0] as StandInProps;
    act(() => handled.onAppendHandled!());
    expect(editorRenders).toHaveBeenLastCalledWith(expect.objectContaining({ appendRequest: 0 }));

    // A second press is a second request — and the band is open now, so it asks nobody to open it.
    await userEvent.click(within(band).getByRole("button", { name: "New to-do" }));
    expect(editorRenders).toHaveBeenLastCalledWith(expect.objectContaining({ appendRequest: 1 }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});

/* --------------------------------------------------------------------- adopting ------- */

describe("a list changed elsewhere", () => {
  it("replaces the editor when nobody is in it and nothing is unsaved", async () => {
    deckTodos.mockResolvedValue("- [ ] Revise tokens");
    const { client } = renderBand();
    const box = await editor();

    act(() => client.setQueryData(KEY, "- [x] Revise tokens"));

    await waitFor(() => expect(textbox()).toHaveValue("- [x] Revise tokens"));
    // A remount, not an edit pushed into the old one — see the stand-in's doc.
    expect(textbox()).not.toBe(box);
    // Taking somebody else's write is not a write.
    expect(deckTodosSet).not.toHaveBeenCalled();
  });

  it("waits while the caret is in the editor, and takes it once the caret leaves", async () => {
    deckTodos.mockResolvedValue("- [ ] Revise tokens");
    const { client } = renderBand();
    const box = await editor();

    act(() => box.focus());
    act(() => client.setQueryData(KEY, "- [x] Revise tokens"));
    await settle();

    expect(textbox()).toBe(box);
    expect(box).toHaveValue("- [ ] Revise tokens");

    act(() => box.blur());

    await waitFor(() => expect(textbox()).toHaveValue("- [x] Revise tokens"));
    expect(deckTodosSet).not.toHaveBeenCalled();
  });

  it("loses to an unsaved draft, which the next autosave writes over it", async () => {
    deckTodos.mockResolvedValue("- [ ] Revise tokens");
    const { client } = renderBand();
    const box = await editor();
    fakeClock();

    fireEvent.change(box, { target: { value: "- [ ] Revise tokens\n- [ ] Mine" } });
    act(() => client.setQueryData(KEY, "- [x] Revise tokens"));
    await tick(0);

    expect(textbox()).toBe(box);
    expect(box).toHaveValue("- [ ] Revise tokens\n- [ ] Mine");

    // The one-document cost, stated at its sharpest (spec §6): the reader's typing wins.
    await tick(600);
    expect(deckTodosSet).toHaveBeenCalledWith(4, "- [ ] Revise tokens\n- [ ] Mine", null);
    await tick(0);
    expect(textbox()).toBe(box);
  });
});

/* --------------------------------------------------------------------- placement ------ */

describe("the band's shell", () => {
  /**
   * The four placement constraints the notes band's header spells out, the two of them that live
   * on this component's own root. **A `<section>`, never an `<aside>`** — a second complementary
   * landmark broke five of `App.test.tsx`'s pane assertions — and **`shrink-0`**, without which
   * the band is squeezed to nothing on every deck taller than the window. `classList` because
   * jsdom applies no stylesheet; the live pass is what measures the computed values.
   */
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
