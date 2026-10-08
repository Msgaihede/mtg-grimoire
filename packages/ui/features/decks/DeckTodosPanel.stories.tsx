import { useMemo, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent } from "storybook/test";
import type { DeckTodoList } from "@/lib/ipc";
import {
  NEW_LIST_LABEL,
  NO_LISTS,
  TODOS_HEADING,
  TodosBand,
  type TodosBandProps,
} from "./DeckTodosPanel";
import { countTodos, parseTodos, toggleTodo } from "./todoMarkdown";

function list(over: Partial<DeckTodoList> & { id: number }): DeckTodoList {
  return {
    deckId: 1,
    title: "",
    body: "",
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

/** A list with everything a to-do document can hold: a heading, to-dos with a sub-to-do under
 *  one, a paragraph of text, and a second task list after it. */
const MANA = list({
  id: 1,
  title: "Mana base",
  sortOrder: 0,
  body: [
    "## Lands",
    "",
    "- [ ] Cut a land",
    "  - [x] Check the curve first",
    "- [ ] Add a **Treasure** maker",
    "",
    "Aim for 36 with the MDFCs counted as spells.",
    "",
    "- [ ] Revise the fetch package",
  ].join("\n"),
});

/** A plain checklist, and the one the sort puts second. */
const SLEEVES = list({
  id: 2,
  title: "Before Friday",
  sortOrder: 1,
  body: "- [x] Sleeve the deck\n- [ ] Print the token sheet\n- [ ] Swap `Sol Ring` for the foil",
});

/** No title — drawn under the placeholder name. */
const UNTITLED = list({ id: 3, title: "", sortOrder: 2, body: "- [ ] Ask about the Commander" });

/** The header's count, summed over every list — `DeckTodosPanel`'s own arithmetic. */
function sum(lists: DeckTodoList[]): { open: number; done: number } {
  return lists.reduce(
    (acc, each) => {
      const c = countTodos(parseTodos(each.body));
      return { open: acc.open + c.open, done: acc.done + c.done };
    },
    { open: 0, done: 0 },
  );
}

/**
 * The band with its boxes live, minus the database: a tick flips the body in local state and the
 * header's count moves with it, exactly as the cache write does in the app. **No dialog** — Edit
 * and a press on a card are `onEdit`; the dialog has stories of its own.
 */
function Ticking({ lists: seeded, ...band }: TodosBandProps) {
  const [lists, setLists] = useState(seeded ?? []);
  const counts = useMemo(() => sum(lists), [lists]);
  return (
    <TodosBand
      {...band}
      lists={lists}
      counts={counts}
      onTick={(target, line) => {
        band.onTick(target, line);
        const next = toggleTodo(target.body, line);
        if (next === null) return;
        setLists((all) =>
          all.map((each) => (each.id === target.id ? { ...each, body: next } : each)),
        );
      }}
    />
  );
}

/**
 * The deck's to-do lists — **drawn over plain props**, `DeckNotesPanel.stories.tsx`' decision and
 * its reason: a refused read is a state no seed reaches.
 *
 * ⚠️ **A to-do list is not a note.** It shares the notes' card frame, editor and inline dialect,
 * and has no card attachments, no drag and no Save.
 *
 * **No story here loads an editor.** A card is read-only prose with live boxes; the editor is the
 * dialog's, behind `React.lazy`, and `TodoListDialog.stories.tsx` stands that up.
 */
const meta = {
  title: "Decks/DeckTodosPanel",
  component: TodosBand,
  tags: ["autodocs"],
  args: {
    open: false,
    counts: null as TodosBandProps["counts"],
    failure: null as string | null,
    lists: null as DeckTodoList[] | null,
    ticking: null as number | null,
    onToggle: fn(),
    onNewList: fn(),
    onTick: fn(),
    onEdit: fn(),
    onDelete: fn(),
  },
  decorators: [
    (Story) => (
      <div className="w-[60rem] max-w-full p-4">
        <Story />
      </div>
    ),
  ],
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "The deck's to-do lists, in a band at the foot of the editor — under the notes band, " +
          "and so the last thing on the page.\n\n" +
          "**Several titled lists to a deck, drawn as cards.** A card reads its list — headings, " +
          "text and to-dos — and its boxes tick in place, through the list's compare-and-set. " +
          "Edit, or a press on the card, opens the list in a dialog that autosaves.\n\n" +
          "**The header sums every list**, and draws nothing for a deck with no to-do.\n\n" +
          "**`New to-do list` is in the heading row**, outside the collapsible region: it opens a " +
          "shut band and a dialog on a list that is created by its first real change.",
      },
    },
  },
} satisfies Meta<typeof TodosBand>;

export default meta;
type Story = StoryObj<typeof meta>;

/** **Shut, which is every deck on arrival.** The count is the reason to open it. */
export const ClosedWithCounts: Story = {
  args: { counts: sum([MANA, SLEEVES, UNTITLED]), lists: [MANA, SLEEVES, UNTITLED] },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("button", { name: TODOS_HEADING })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await expect(canvas.getByRole("region", { name: TODOS_HEADING })).toHaveTextContent(
      "6 open · 2 done",
    );
    await expect(canvas.queryByRole("button", { name: /^Edit / })).toBeNull();
  },
};

/**
 * **Open over three lists** — one holding text beside its to-dos, one plain checklist, one
 * untitled. A press on a box ticks it here and the count follows.
 */
export const OpenWithLists: Story = {
  args: { open: true, lists: [MANA, SLEEVES, UNTITLED] },
  render: (args) => <Ticking {...args} />,
  play: async ({ canvas, args }) => {
    await expect(canvas.getByRole("button", { name: "Edit Untitled list" })).toBeInTheDocument();
    await expect(
      canvas.getByText("Aim for 36 with the MDFCs counted as spells."),
    ).toBeInTheDocument();
    await userEvent.click(canvas.getByRole("checkbox", { name: 'Mark "Cut a land" done' }));
    await expect(args.onTick).toHaveBeenCalledWith(MANA, 2);
    await expect(canvas.getByRole("region", { name: TODOS_HEADING })).toHaveTextContent(
      "5 open · 3 done",
    );
    // Reading and ticking load no editor.
    await expect(canvas.queryByRole("textbox")).toBeNull();
  },
};

/** **A tick on the wire.** Every box on that card is refused until it answers; the others are
 *  not its business. */
export const TickInFlight: Story = {
  args: { open: true, lists: [MANA, SLEEVES], ticking: MANA.id, counts: sum([MANA, SLEEVES]) },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("checkbox", { name: 'Mark "Cut a land" done' })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await expect(
      canvas.getByRole("checkbox", { name: 'Mark "Print the token sheet" done' }),
    ).not.toHaveAttribute("aria-disabled");
  },
};

/** **A tick refused** — the list changed since the card drew it. The band has re-read and says
 *  why on its one line. */
export const TickRefused: Story = {
  args: {
    open: true,
    lists: [MANA],
    counts: sum([MANA]),
    failure: "That to-do list changed since it was read. Try again.",
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("alert")).toHaveTextContent("That to-do list changed");
    await expect(canvas.getByRole("button", { name: "Edit Mana base" })).toBeInTheDocument();
  },
};

/** **A deck with no list yet** — one dim line that names the control which starts one. */
export const Empty: Story = {
  args: { open: true, lists: [], counts: { open: 0, done: 0 } },
  play: async ({ canvas, args }) => {
    await expect(canvas.getByText(NO_LISTS)).toBeInTheDocument();
    await expect(canvas.getByRole("region", { name: TODOS_HEADING })).not.toHaveTextContent(
      /open ·/,
    );
    await userEvent.click(canvas.getByRole("button", { name: NEW_LIST_LABEL }));
    await expect(args.onNewList).toHaveBeenCalled();
  },
};

/** **The read was refused.** One line says so, and nothing else is drawn: no count, no card, no
 *  empty sentence — any of them would be the app asserting something it does not know. */
export const ReadRefused: Story = {
  args: { open: true, failure: "That deck is not there any more." },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("alert")).toHaveTextContent("That deck is not there any more.");
    await expect(canvas.queryByText(NO_LISTS)).toBeNull();
    await expect(canvas.queryByText(/loading/i)).toBeNull();
  },
};
