import { lazy, Suspense, useMemo, useState, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn } from "storybook/test";
import { TODOS_HEADING, TodosBand, type TodosBandProps } from "./DeckTodosPanel";
import { countTodos, parseTodos } from "./todoMarkdown";

/**
 * ⚠️ **The two `Range` methods jsdom does not implement** — `NoteEditorDialog.stories.tsx` carries
 * the whole argument. Two stories below mount a real ProseMirror view, `src/stories.test.tsx`
 * plays them under jsdom, and a `TypeError` thrown inside the view's own dispatch escapes as an
 * unhandled error that fails a run in which every test passed. `??=`, so a jsdom that grows a real
 * implementation is used instead.
 */
Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();

/**
 * ⚠️ **The lazy chunk, started here and awaited before every story** — `NoteEditorDialog.stories.tsx`'
 * `EDITOR_CHUNK`, for its reason: `findBy*` gives a dynamic import one second, and under load it
 * does not always win.
 *
 * **It must stay an `import()` _expression_**, and so must the `lazy` below it. A static
 * `from "./NoteEditor"` in a story file is not exempt from `DeckNotesPanel.test.tsx`'s 141.5 kB
 * sweep — that excuses only `NoteEditor`'s own file and `.test.` files.
 */
const EDITOR_CHUNK = import("./NoteEditor");
const NoteEditor = lazy(() => import("./NoteEditor"));

/**
 * A deck's list with everything the band can hold: a to-do with sub-to-dos under it, one of them
 * done, a done to-do at the top level, and inline marks. Three open and two done — `countTodos`
 * counts every depth.
 */
const NEST = [
  "- [ ] Revise tokens",
  "  - [ ] Add a **Treasure** maker",
  "  - [x] Cut the Clue tokens",
  "- [ ] Cut three creatures for `instant`-speed interaction",
  "- [x] Sleeve the deck",
].join("\n");

/**
 * The band as the deck editor wires it, minus the database: a draft the editor writes into and a
 * header count read off that draft, so ticking a box in the workbench moves the figure exactly as
 * it does in the app. **No autosave and no query** — those are `DeckTodosPanel`'s and its suite's;
 * this is here so the drawing can be looked at with a real editor in the slot.
 */
function WithEditor({ body, ...band }: Omit<TodosBandProps, "counts" | "editor"> & { body: string }) {
  const [draft, setDraft] = useState(body);
  const counts = useMemo(() => countTodos(parseTodos(draft)), [draft]);
  const editor: ReactNode = (
    <Suspense fallback={<p className="text-xs text-dim">Opening the editor…</p>}>
      <NoteEditor mode="checklist" value={draft} onChange={setDraft} ariaLabel="To-do list" />
    </Suspense>
  );
  return <TodosBand {...band} counts={counts} editor={editor} />;
}

/**
 * The deck's to-do list — **drawn over plain props**, `DeckNotesPanel.stories.tsx`' decision and
 * its reason: a refused read is a state no seed reaches, so the band is split the way the notes
 * band is and the workbench stands up the drawing half.
 *
 * ⚠️ **A to-do list is not a note.** One list to a deck, stored whole on the deck's own row and
 * edited in place, where the band above it holds many notes each opened in a dialog. What the two
 * share is the header's grammar and the editor's inline dialect, and nothing else.
 *
 * **Two stories load the editor and two do not**, and the line between them is the band's own:
 * a shut band mounts nothing, and neither does a band whose read was refused.
 */
const meta = {
  title: "Decks/DeckTodosPanel",
  component: TodosBand,
  tags: ["autodocs"],
  // The wait itself — see {@link EDITOR_CHUNK}. On the meta, so a story added here that mounts
  // the editor inherits it rather than having to remember the race.
  beforeEach: async () => {
    await EDITOR_CHUNK;
  },
  args: {
    open: false,
    // The casts let a story narrow each of these without the meta's value fixing its type —
    // `DeckNotesPanel.stories.tsx`' own two lines of reason.
    counts: null as TodosBandProps["counts"],
    failure: null as string | null,
    editor: null as ReactNode,
    onToggle: fn(),
    onNewTodo: fn(),
  },
  // A React element is not something a control can edit.
  argTypes: { editor: { control: false } },
  // The band sits at the foot of the editor's column — a column's width and nothing else.
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
          "The deck's to-do list, in a band at the foot of the editor — under the notes band, " +
          "and so the last thing on the page.\n\n" +
          "**One checklist to a deck, edited in place.** The open body is the notes' editor in " +
          "checklist mode: Enter for the next to-do, Tab to nest it, a box to tick and a button " +
          "to delete each row. It saves 600 ms after the reader stops, and again the moment the " +
          "caret leaves.\n\n" +
          "**The header counts the draft**, so the figure moves as a box is ticked rather than " +
          "when the write lands — and draws nothing for an empty list.\n\n" +
          "**`New to-do` is in the heading row**, outside the collapsible region: it opens a " +
          "shut band and puts the caret on a fresh item at the end.\n\n" +
          "**The open state is `decks.todos_open`**, written through the ordinary deck patch, so " +
          "it is an arg here and the press is `onToggle`.",
      },
    },
  },
} satisfies Meta<typeof TodosBand>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * **Shut, which is every deck on arrival** — the column is `DEFAULT 0`. The count is the reason to
 * open it, which is why the read runs whether or not the band is drawn; the editor does not.
 */
export const ClosedWithCounts: Story = {
  args: { counts: { open: 3, done: 2 } },
  play: async ({ canvas }) => {
    const band = canvas.getByRole("region", { name: TODOS_HEADING });
    await expect(canvas.getByRole("button", { name: TODOS_HEADING })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await expect(band).toHaveTextContent("3 open · 2 done");
    // Shut is nothing mounted: Tiptap is fetched by opening the band and never by drawing it.
    await expect(canvas.queryByRole("textbox")).toBeNull();
  },
};

/**
 * **Open over a list with sub-to-dos in it** — the state the band exists for. The nesting is the
 * editor's own (`TaskItem` with `nested: true`), and the header's figure counts every depth.
 */
export const OpenWithNest: Story = {
  args: { open: true },
  render: (args) => <WithEditor {...args} body={NEST} />,
  play: async ({ canvas }) => {
    await expect(await canvas.findByRole("textbox", { name: "To-do list" })).toBeInTheDocument();
    await expect(canvas.getByRole("region", { name: TODOS_HEADING })).toHaveTextContent(
      "3 open · 2 done",
    );
  },
};

/**
 * **A deck with no list yet.** The editor still draws — one empty item and the placeholder, which
 * is the checklist document's own floor — and the header draws no figure: `0 open · 0 done` beside
 * an empty list would say the same thing twice.
 */
export const Empty: Story = {
  args: { open: true },
  render: (args) => <WithEditor {...args} body="" />,
  play: async ({ canvas }) => {
    await expect(await canvas.findByRole("textbox", { name: "To-do list" })).toBeInTheDocument();
    await expect(canvas.getByRole("region", { name: TODOS_HEADING })).not.toHaveTextContent(
      /open ·/,
    );
  },
};

/**
 * **The read was refused.** One line says so, and nothing else is drawn: no count, because a
 * `0 open` here would be a number the app does not have, and **no editor**, because one mounted
 * over a body nobody read would be an empty checklist whose first keystroke autosaved over the
 * deck's real list.
 */
export const ReadRefused: Story = {
  args: { open: true, failure: "That deck is not there any more." },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("alert")).toHaveTextContent("That deck is not there any more.");
    await expect(canvas.queryByRole("textbox")).toBeNull();
    await expect(canvas.queryByText(/loading/i)).toBeNull();
  },
};
