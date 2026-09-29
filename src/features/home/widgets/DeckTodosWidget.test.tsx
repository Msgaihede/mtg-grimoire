import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { compile } from "tailwindcss";
import twEntry from "tailwindcss/index.css?raw";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DeckPatch, DeckRow, DeckTodoList, HomeWidget } from "@/lib/ipc";

/**
 * The three commands this widget calls, in front of an **intact** mirror — `DeckCompletionWidget`'s
 * note: the module and the `ipc` object are both spread from the original, so every other command
 * stays real, and each stub is typed against its own signature so a changed wire shape fails under
 * `tsc` rather than inside a render.
 *
 * The cases with data seed the cache through the widget's **exported** key, so a seeded answer only
 * reaches the screen if the body reads the key it claims to. The stubs are for what a cache cannot
 * hold: a read still out, a refetch, and the two writes.
 */
const deckTodoLists = vi.hoisted(() => vi.fn<() => Promise<DeckTodoList[]>>());
const deckTodosSet = vi.hoisted(() =>
  vi.fn<(deckId: number, body: string, expected: string | null) => Promise<void>>(),
);
const deckUpdate = vi.hoisted(() => vi.fn<(id: number, patch: DeckPatch) => Promise<DeckRow>>());
const deckList = vi.hoisted(() => vi.fn<() => Promise<DeckRow[]>>());
vi.mock("@/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ipc")>();
  return {
    ...actual,
    ipc: { ...actual.ipc, deckTodoLists, deckTodosSet, deckUpdate, deckList },
  };
});

import { toggleTodo } from "@/features/decks/todoMarkdown";
import { useAppStore } from "@/lib/store";
import { makeFit, spanPx, type WidgetFit } from "../fit";
import { deckListKey, deckTodoListsKey } from "../keys";
import {
  ALL_DONE,
  CLAMP_CLASSES,
  DeckTodosWidget,
  DeckTodosWidgetSettings,
  NESTED_ONLY,
  NO_TODOS,
  NO_TODOS_HINT,
  NOTHING_CHOSEN,
} from "./DeckTodosWidget";

/** `deck_todos::TODOS_CHANGED`, word for word — the sentence a refused tick must print. */
const TODOS_CHANGED = "That to-do list changed since it was read. Try again.";

/** One deck's list, annotated so the mirror checks the fixture. */
function list(over: Partial<DeckTodoList> & { deckId: number; name: string }): DeckTodoList {
  return {
    archived: false,
    todosOpen: false,
    updatedAt: 1_800_000_000,
    body: "- [ ] A to-do",
    ...over,
  };
}

/**
 * The plan's seeded checklist: an open parent over an open and a done child, and a done top-level
 * item. Lines 0–3, in that order.
 */
const BURN_BODY =
  "- [ ] Revise tokens\n  - [ ] Add a Treasure maker\n  - [x] Cut Clue tokens\n- [x] Sleeve the deck";
const BURN = list({ deckId: 1, name: "Burn", body: BURN_BODY, updatedAt: 1_800_000_100 });
const ATRAXA = list({
  deckId: 2,
  name: "Atraxa",
  body: "- [ ] Cut three creatures",
  updatedAt: 1_800_000_300,
  todosOpen: true,
});
const MONO = list({
  deckId: 3,
  name: "Mono Red",
  body: "- [ ] One\n- [ ] Two\n- [ ] Three",
  updatedAt: 1_800_000_200,
});
const SHELF = list({
  deckId: 4,
  name: "Old Shelf",
  body: "- [ ] Put it back together",
  archived: true,
});
/** Every to-do done — nothing to draw while completed ones are hidden. */
const FINISHED = list({ deckId: 5, name: "Finished", body: "- [x] All of it" });

function widget(config: unknown = null): HomeWidget {
  return { id: "deckTodos", kind: "deckTodos", x: 0, y: 0, w: 3, h: 3, config };
}

/** The box a widget is told it is drawn in, at the grid's target cell. */
function fitFor(w: number, h: number): WidgetFit {
  return makeFit({ w, h, widthPx: spanPx(w, 104), heightPx: spanPx(h, 104), density: "comfortable" });
}

/** Room for every fixture below. */
const ROOMY = fitFor(4, 12);

let qc: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function seed(lists: readonly DeckTodoList[]) {
  qc.setQueryData(deckTodoListsKey, lists);
}

function draw(
  config: unknown = null,
  { fit = ROOMY, still = false }: { fit?: WidgetFit; still?: boolean } = {},
): ReturnType<typeof render> {
  return render(
    <DeckTodosWidget
      widget={widget(config)}
      fit={fit}
      editing={false}
      still={still}
      onConfig={vi.fn()}
    />,
    { wrapper },
  );
}

/** Every deck heading's accessible name, in drawn order (the grouping case asserts the label is
 *  the computed name). */
function headings(): string[] {
  return screen
    .queryAllByRole("heading", { level: 4 })
    .map((el) => el.getAttribute("aria-label") ?? "");
}

/** Every checkbox's accessible name, in drawn order. */
function boxes(): string[] {
  return screen.queryAllByRole("checkbox").map((el) => el.getAttribute("aria-label") ?? "");
}

/** Replace the two store actions a press writes, and the band's disclosure write, recording the
 *  order all three were made in. */
function recordWrites(): string[] {
  const writes: string[] = [];
  const { setActiveView, setOpenDeckId } = useAppStore.getState();
  useAppStore.setState({
    setActiveView: (view) => {
      writes.push(`view:${view}`);
      setActiveView(view);
    },
    setOpenDeckId: (id) => {
      writes.push(`deck:${id}`);
      setOpenDeckId(id);
    },
  });
  deckUpdate.mockImplementation(async (id, patch) => {
    writes.push(`update:${id}:${JSON.stringify(patch)}`);
    return {} as DeckRow;
  });
  return writes;
}

beforeEach(() => {
  deckTodoLists.mockReset().mockResolvedValue([]);
  deckTodosSet.mockReset().mockResolvedValue(undefined);
  deckUpdate.mockReset().mockResolvedValue({} as DeckRow);
  deckList.mockReset().mockResolvedValue([]);
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  // The store is module-level and leaks between tests; the press cases replace two actions.
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({ activeView: "home" });
});

describe("DeckTodosWidget", () => {
  describe("grouping", () => {
    it("heads each deck with its name and open count, its to-dos and sub-to-dos beneath", () => {
      seed([BURN]);
      draw();

      expect(headings()).toEqual(["Burn · 2 open"]);
      expect(screen.getByRole("heading", { level: 4 })).toHaveAccessibleName("Burn · 2 open");
      // Completed ones are hidden by default; the open child stays under its open parent.
      expect(boxes()).toEqual(['Mark "Revise tokens" done', 'Mark "Add a Treasure maker" done']);
      const parent = screen.getByRole("checkbox", { name: 'Mark "Revise tokens" done' });
      const child = screen.getByRole("checkbox", { name: 'Mark "Add a Treasure maker" done' });
      // Indented one step per level: the sub-to-do's row says its level and is pushed in.
      expect(parent.closest("li")).toHaveAttribute("aria-level", "1");
      expect(child.closest("li")).toHaveAttribute("aria-level", "2");
      expect(child.closest("li")?.style.paddingLeft).not.toBe(parent.closest("li")?.style.paddingLeft);
    });

    it("leaves the open count off when the switch is off", () => {
      seed([BURN]);
      draw({ counts: false });

      expect(headings()).toEqual(["Burn"]);
      expect(screen.queryByText(/open$/)).toBeNull();
    });

    it("names a checkbox the way the band's editor does, done and not done", () => {
      seed([BURN]);
      draw({ done: true });

      expect(boxes()).toEqual([
        'Mark "Revise tokens" done',
        'Mark "Add a Treasure maker" done',
        'Mark "Cut Clue tokens" not done',
        'Mark "Sleeve the deck" not done',
      ]);
      expect(screen.getByRole("checkbox", { name: 'Mark "Sleeve the deck" not done' })).toBeChecked();
      expect(screen.getByRole("checkbox", { name: 'Mark "Revise tokens" done' })).not.toBeChecked();
    });

    it("draws a to-do's marks, and keeps a hard break a line of its own", () => {
      seed([list({ deckId: 1, name: "Burn", body: "- [ ] cut **three** creatures  \n      then test" })]);
      draw();

      const box = screen.getByRole("checkbox");
      expect(within(box).getByText("three").tagName).toBe("STRONG");
      // The break is a "\n" inside a run, drawn by `whitespace-pre-line` rather than dropped.
      expect(box.querySelector(".whitespace-pre-line")?.textContent).toContain("\nthen test");
    });
  });

  describe("the switches", () => {
    it("hides a completed to-do, but keeps a done parent over an open child, drawn done", () => {
      seed([list({ deckId: 1, name: "Burn", body: "- [x] Parent\n  - [ ] Child\n- [x] Alone" })]);
      draw();

      expect(boxes()).toEqual(['Mark "Parent" not done', 'Mark "Child" done']);
    });

    it("shows completed to-dos when asked", () => {
      seed([list({ deckId: 1, name: "Burn", body: "- [x] Parent\n  - [ ] Child\n- [x] Alone" })]);
      draw({ done: true });

      expect(boxes()).toEqual([
        'Mark "Parent" not done',
        'Mark "Child" done',
        'Mark "Alone" not done',
      ]);
    });

    it("draws the top level only with sub-to-dos off", () => {
      seed([BURN]);
      draw({ nested: false });

      expect(boxes()).toEqual(['Mark "Revise tokens" done']);
    });

    it("leaves archived decks out unless they are asked for", () => {
      seed([BURN, SHELF]);
      const { unmount } = draw();
      expect(headings()).toEqual(["Burn · 2 open"]);
      unmount();

      draw({ archived: true });
      expect(headings()).toEqual(["Burn · 2 open", "Old Shelf · 1 open"]);
    });

    it("draws only the chosen decks under Chosen…", () => {
      seed([BURN, ATRAXA, MONO]);
      draw({ scope: "chosen", deckIds: [3, 1] });

      // Still in the reader's `Order` rather than the checklist's: Mono Red was edited last.
      expect(headings().map((name) => name.split(" · ")[0])).toEqual(["Mono Red", "Burn"]);
    });

    it("points at the checklist when Chosen… has nothing chosen", () => {
      seed([BURN]);
      draw({ scope: "chosen" });

      expect(screen.getByText(NOTHING_CHOSEN)).toBeInTheDocument();
      expect(screen.queryByRole("checkbox")).toBeNull();
    });
  });

  describe("order", () => {
    const names = () => headings().map((name) => name.split(" · ")[0]);

    it("orders the most recently edited deck first by default", () => {
      seed([BURN, ATRAXA, MONO]);
      draw();

      expect(names()).toEqual(["Atraxa", "Mono Red", "Burn"]);
    });

    it("orders by name", () => {
      seed([MONO, BURN, ATRAXA, list({ deckId: 9, name: "burn again" })]);
      draw({ order: "name" });

      const expected = ["Mono Red", "Burn", "Atraxa", "burn again"].sort((a, b) =>
        a.localeCompare(b, "en"),
      );
      expect(names()).toEqual(expected);
    });

    it("orders by most open, a tie settled by name", () => {
      seed([BURN, ATRAXA, MONO, list({ deckId: 9, name: "Aggro", body: "- [ ] x\n- [ ] y" })]);
      draw({ order: "open" });

      expect(names()).toEqual(["Mono Red", "Aggro", "Burn", "Atraxa"]);
    });
  });

  describe("empty", () => {
    it("leaves a deck with nothing to draw off the card", () => {
      seed([BURN, FINISHED]);
      draw();

      expect(headings()).toEqual(["Burn · 2 open"]);
    });

    it("says there are no to-dos when no deck has any", () => {
      seed([]);
      draw();

      expect(screen.getByText(NO_TODOS)).toBeInTheDocument();
      expect(screen.getByText(NO_TODOS_HINT)).toBeInTheDocument();
      expect(NO_TODOS).toBe("No to-dos yet");
      expect(NO_TODOS_HINT).toBe("Add them in any deck's To-do band.");
    });

    it("says there are none when the only list is an archived deck's", () => {
      seed([SHELF]);
      draw();

      expect(screen.getByText(NO_TODOS)).toBeInTheDocument();
    });

    /** Not "no to-dos yet" to a reader who has done every one of them. */
    it("says every to-do is done, and names the switch, when completed ones are hidden", () => {
      seed([FINISHED]);
      draw();

      expect(screen.getByText(ALL_DONE)).toBeInTheDocument();
      expect(ALL_DONE).toContain("Show completed");
      expect(screen.queryByText(NO_TODOS)).toBeNull();
    });

    /**
     * With sub-to-dos off, a done parent over an open child is hidden — so a deck whose only open
     * work is nested draws nothing, and "every to-do is done" would be false and name the wrong
     * switch.
     */
    it("names Show sub-to-dos when the only open to-dos are nested under finished ones", () => {
      seed([list({ deckId: 1, name: "Burn", body: "- [x] P\n  - [ ] c" })]);
      draw({ nested: false });

      expect(screen.getByText(NESTED_ONLY)).toBeInTheDocument();
      expect(NESTED_ONLY).toContain("Show sub-to-dos");
      expect(screen.queryByText(ALL_DONE)).toBeNull();
    });

    it("says it is loading while the read is out, and why when it is refused", async () => {
      deckTodoLists.mockReturnValue(new Promise(() => {}));
      const { unmount } = draw();
      expect(screen.getByText("Loading to-dos…")).toBeInTheDocument();
      unmount();

      deckTodoLists.mockRejectedValue("the database is busy");
      qc.clear();
      draw();
      expect(await screen.findByText(/the database is busy/)).toBeInTheDocument();
    });
  });

  describe("ticking in place", () => {
    it("writes the toggled body with the body it read as the expected one, and refreshes", async () => {
      const user = userEvent.setup();
      const invalidate = vi.spyOn(qc, "invalidateQueries");
      seed([BURN]);
      draw();

      await user.click(screen.getByRole("checkbox", { name: 'Mark "Add a Treasure maker" done' }));

      expect(deckTodosSet).toHaveBeenCalledTimes(1);
      expect(deckTodosSet).toHaveBeenCalledWith(1, toggleTodo(BURN_BODY, 1), BURN_BODY);
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["decks", "todos"] });
    });

    it("greys the row while the write is out, and takes no second tick", async () => {
      const user = userEvent.setup();
      deckTodosSet.mockReturnValue(new Promise(() => {}));
      seed([BURN]);
      draw();

      const box = screen.getByRole("checkbox", { name: 'Mark "Revise tokens" done' });
      await user.click(box);
      expect(box).toHaveAttribute("aria-disabled", "true");

      await user.click(screen.getByRole("checkbox", { name: 'Mark "Add a Treasure maker" done' }));
      expect(deckTodosSet).toHaveBeenCalledTimes(1);
    });

    it("prints a refusal's own sentence and reads the lists again", async () => {
      const user = userEvent.setup();
      deckTodosSet.mockRejectedValue(TODOS_CHANGED);
      deckTodoLists.mockResolvedValue([BURN]);
      seed([BURN]);
      draw();

      await user.click(screen.getByRole("checkbox", { name: 'Mark "Revise tokens" done' }));

      expect(await screen.findByRole("alert")).toHaveTextContent(TODOS_CHANGED);
      expect(deckTodoLists).toHaveBeenCalled();
    });

    /** A line `parseTodos` reads as a to-do only because nothing is dropped — it has no box. */
    it("greys a to-do with no box to tick, and writes nothing for it", async () => {
      const user = userEvent.setup();
      seed([list({ deckId: 1, name: "Burn", body: "- plain bullet\n- [ ] a" })]);
      draw();

      const plain = screen.getByRole("checkbox", { name: 'Mark "plain bullet" done' });
      expect(plain).toHaveAttribute("aria-disabled", "true");
      expect(screen.getByRole("checkbox", { name: 'Mark "a" done' })).not.toHaveAttribute(
        "aria-disabled",
      );

      await user.click(plain);
      expect(deckTodosSet).not.toHaveBeenCalled();
      // Drawn as not tickable, too: a dashed box, where a tickable to-do's is solid.
      const boxOf = (el: HTMLElement) => el.querySelector('[aria-hidden="true"]');
      expect(boxOf(plain)?.classList.contains("border-dashed")).toBe(true);
      const tickable = screen.getByRole("checkbox", { name: 'Mark "a" done' });
      expect(boxOf(tickable)?.classList.contains("border-dashed")).toBe(false);
    });

    /** `PRESS_SOFT` dips on `:active`; a row that refuses the press must not look pressed. */
    it("keeps a refused row from dipping under the press", () => {
      seed([BURN]);
      draw();

      for (const box of screen.getAllByRole("checkbox")) {
        expect(box.classList.contains("aria-disabled:active:scale-100")).toBe(true);
      }
    });
  });

  describe("opening a deck", () => {
    /** `setActiveView` clears `openDeckId` on the way in, so the view is written first — and the
     *  band's disclosure before either, so the deck opens on it. */
    it("opens the band first when it is shut, then the view, then the deck", async () => {
      const user = userEvent.setup();
      const writes = recordWrites();
      seed([BURN]);
      draw();

      await user.click(screen.getByRole("button", { name: "Burn · 2 open" }));

      expect(writes).toEqual([`update:1:${JSON.stringify({ todosOpen: true })}`, "view:decks", "deck:1"]);
      expect(useAppStore.getState().activeView).toBe("decks");
      expect(useAppStore.getState().openDeckId).toBe(1);
    });

    it("writes nothing to a band that is already open", async () => {
      const user = userEvent.setup();
      const writes = recordWrites();
      seed([ATRAXA]);
      draw();

      await user.click(screen.getByRole("button", { name: "Atraxa · 1 open" }));

      expect(deckUpdate).not.toHaveBeenCalled();
      expect(writes).toEqual(["view:decks", "deck:2"]);
    });

    it("opens the deck even when the band's write is refused", async () => {
      const user = userEvent.setup();
      const writes = recordWrites();
      deckUpdate.mockRejectedValue("That deck is not there any more.");
      seed([BURN]);
      draw();

      await user.click(screen.getByRole("button", { name: "Burn · 2 open" }));

      await vi.waitFor(() => expect(writes).toEqual(["view:decks", "deck:1"]));
    });
  });

  describe("still", () => {
    it("draws pictures of rows: nothing ticks, nothing opens, nothing is written", async () => {
      const user = userEvent.setup();
      const writes = recordWrites();
      seed([BURN]);
      draw(null, { still: true });

      expect(screen.queryByRole("button")).toBeNull();
      expect(screen.queryByRole("checkbox")).toBeNull();
      expect(screen.getByRole("heading", { level: 4 })).toHaveAccessibleName("Burn · 2 open");
      await user.click(screen.getByText("Revise tokens"));
      await user.click(screen.getByText("Burn"));

      expect(deckTodosSet).not.toHaveBeenCalled();
      expect(deckUpdate).not.toHaveBeenCalled();
      expect(writes).toEqual([]);
    });
  });

  describe("what fits", () => {
    const many = list({
      deckId: 1,
      name: "Burn",
      body: Array.from({ length: 20 }, (_, i) => `- [ ] Item ${i + 1}`).join("\n"),
    });

    it("cuts whole rows and counts the rest in a footer", () => {
      seed([many]);
      draw(null, { fit: fitFor(3, 3) });

      const shown = boxes().length;
      expect(shown).toBeGreaterThan(0);
      expect(shown).toBeLessThan(20);
      expect(screen.getByText(`+${20 - shown} more`)).toBeInTheDocument();
    });

    it("draws no footer when everything fits", () => {
      seed([BURN]);
      draw();

      expect(screen.queryByText(/^\+\d+ more$/)).toBeNull();
    });

    /**
     * A heading with none of its to-dos under it would read as a deck with nothing to do. Eight
     * 27px rows (a heading, five items, a heading, one item) in a body 253px tall: with the footer
     * reserved, seven rows and their 6px gaps fit, so the cut lands exactly on the second heading —
     * which goes too.
     */
    it("never ends on a heading with nothing under it", () => {
      const first = list({
        deckId: 1,
        name: "Burn",
        updatedAt: 2,
        body: Array.from({ length: 5 }, (_, i) => `- [ ] Item ${i + 1}`).join("\n"),
      });
      const second = list({ deckId: 2, name: "Atraxa", updatedAt: 1, body: "- [ ] Later" });
      seed([first, second]);
      const fit = makeFit({ w: 3, h: 3, widthPx: spanPx(3, 104), heightPx: 305, density: "comfortable" });
      expect(fit.fitCount(27, 24)).toBe(7);
      draw(null, { fit });

      expect(headings()).toEqual(["Burn · 5 open"]);
      expect(boxes()).toHaveLength(5);
      expect(screen.getByText("+1 more")).toBeInTheDocument();
    });

    /**
     * A to-do taller than the box used to stop the cut at the first row and take its heading with
     * it, leaving a card that drew nothing but "+2 more". It is drawn instead, clamped to the lines
     * left, and the rest are counted.
     */
    it("draws a to-do too tall for the box clamped to the lines left, not an empty card", () => {
      const long = "Swap the whole mana base for fetches and shocks ".repeat(6).trim();
      seed([list({ deckId: 1, name: "Burn", body: `- [ ] ${long}\n- [ ] Next` })]);
      draw(null, { fit: fitFor(2, 2) });

      expect(headings()).toEqual(["Burn · 2 open"]);
      const box = screen.getByRole("checkbox", { name: `Mark "${long}" done` });
      const text = box.querySelector(".whitespace-pre-line");
      const clamp = Array.from(text?.classList ?? []).find((name) => name.startsWith("line-clamp-"));
      expect(clamp).toBeDefined();
      expect(screen.getByText("+1 more")).toBeInTheDocument();
    });

    it("clamps nothing that fits", () => {
      seed([BURN]);
      draw();

      for (const box of screen.getAllByRole("checkbox")) {
        const text = box.querySelector(".whitespace-pre-line");
        const names = Array.from(text?.classList ?? []);
        expect(names.some((name) => name.startsWith("line-clamp-"))).toBe(false);
      }
    });
  });

  /**
   * **A class Tailwind cannot parse emits nothing, silently**, and jsdom loads no stylesheet — so
   * the classes this body picks at run time are compiled here against the real Tailwind.
   */
  it("uses clamp and press classes the real Tailwind emits", async () => {
    const compiler = await compile(`@import "tailwindcss";\n`, {
      base: "/",
      loadStylesheet: (id: string) => {
        if (id !== "tailwindcss") throw new Error(`unexpected stylesheet import: ${id}`);
        return Promise.resolve({
          path: "/tailwindcss/index.css",
          base: "/tailwindcss",
          content: twEntry,
        });
      },
      loadModule: () => Promise.reject(new Error("no JS modules expected")),
    });
    const css = compiler.build([...CLAMP_CLASSES, "aria-disabled:active:scale-100"]);
    CLAMP_CLASSES.forEach((name, i) => {
      expect(css, name).toContain(`-webkit-line-clamp: ${i + 1}`);
    });
    // v4 writes the scale through its custom properties: `--tw-scale-x: 100%` and friends.
    expect(css).toMatch(/\[aria-disabled="true"\]:active \{[^}]*--tw-scale-x: 100%/);
  });
});

describe("DeckTodosWidgetSettings", () => {
  const deckRow = (id: number, name: string, archived = false) =>
    ({ id, name, archived, formatKey: "modern", formatName: "Modern" }) as DeckRow;
  const ALL = [deckRow(1, "Burn"), deckRow(2, "Atraxa"), deckRow(4, "Old Shelf", true)];

  function settings(config: unknown) {
    const onConfig = vi.fn();
    qc.setQueryData(deckListKey, ALL);
    render(<DeckTodosWidgetSettings widget={widget(config)} onConfig={onConfig} />, { wrapper });
    return onConfig;
  }

  async function offered(user: ReturnType<typeof userEvent.setup>): Promise<string[]> {
    await user.click(screen.getByRole("button", { name: "Decks to track" }));
    return screen.getAllByRole("option").map((el) => el.textContent ?? "");
  }

  it("points at the scope row instead of drawing a picker that would do nothing", () => {
    settings(null);

    expect(screen.queryByRole("button", { name: "Decks to track" })).toBeNull();
    expect(
      screen.getByText("Choose Chosen… under Which decks to pick the decks this widget tracks."),
    ).toBeInTheDocument();
  });

  it("offers every deck but an archived one, alphabetically", async () => {
    const user = userEvent.setup();
    settings({ scope: "chosen" });

    expect(await offered(user)).toEqual([
      expect.stringContaining("Atraxa"),
      expect.stringContaining("Burn"),
    ]);
  });

  it("offers archived decks too once they are included", async () => {
    const user = userEvent.setup();
    settings({ scope: "chosen", archived: true });

    expect(await offered(user)).toEqual([
      expect.stringContaining("Atraxa"),
      expect.stringContaining("Burn"),
      expect.stringContaining("Old Shelf (archived)"),
    ]);
  });

  it("writes the chosen ids beside the scope, carrying a choice it does not offer", async () => {
    const user = userEvent.setup();
    const onConfig = settings({ scope: "chosen", deckIds: [4, 1] });

    expect(screen.getByRole("button", { name: "Decks to track" })).toHaveTextContent("1 deck");
    await user.click(screen.getByRole("button", { name: "Decks to track" }));
    await user.click(screen.getByRole("option", { name: /Atraxa/ }));

    expect(onConfig).toHaveBeenCalledWith({ deckIds: [4, 1, 2], scope: "chosen" });
  });
});
