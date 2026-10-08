import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn } from "storybook/test";
import { ipc } from "@/lib/ipc";
import { TITLE_LABEL, TODO_EDITOR_LABEL, TodoListDialog } from "./TodoListDialog";

/**
 * ⚠️ **The two `Range` methods jsdom does not implement** — `NoteEditorDialog.stories.tsx` carries
 * the whole argument. Both stories mount a real ProseMirror view, `packages/ui/stories.test.tsx` plays
 * them under jsdom, and a `TypeError` inside the view's own dispatch escapes as an unhandled error
 * that fails a run in which every test passed.
 */
Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();

/**
 * ⚠️ **The lazy chunk, awaited before every story** — `NoteEditorDialog.stories.tsx`'
 * `EDITOR_CHUNK`, for its reason. **An `import()` expression, never a static import**:
 * `DeckNotesPanel.test.tsx`'s sweep excuses no story file.
 */
const EDITOR_CHUNK = import("./NoteEditor");

/** The starter seed's first deck — every story here writes to it through the fake. */
const DECK = 1;

/** A to-do document: a heading, to-dos with a sub-to-do, a paragraph, and a second list. */
const BODY = [
  "## Lands",
  "",
  "- [ ] Cut a land",
  "  - [x] Check the curve first",
  "",
  "Aim for 36 with the MDFCs counted as spells.",
  "",
  "- [ ] Revise the fetch package",
].join("\n");

/**
 * An existing list for the dialog to open on — **made through the fake at render**, because the
 * list ids a seed hands out are the fake's to choose. A query rather than an effect, so nothing
 * here writes state in an effect body; the dialog mounts once the create has answered, and its own
 * read then finds the row.
 */
function WithList({ children }: { children: (id: number) => ReactNode }) {
  const made = useQuery({
    queryKey: ["story", "todo-list-dialog", "made"],
    queryFn: () => ipc.deckTodoListCreate(DECK, "Mana base", BODY),
    staleTime: Infinity,
  });
  return made.data === undefined ? null : <>{children(made.data.id)}</>;
}

/**
 * Where one deck to-do list is written — a title field and the checklist editor, **autosaved**:
 * 600 ms after the reader stops, again the moment the caret leaves, and on every way out.
 *
 * ⚠️ **Not `NoteEditorDialog`.** A note is saved by a press on Save; a to-do list has no Save.
 *
 * **A new list is made by its first real change** — opened from New to-do list on nothing, closed
 * untouched it creates nothing, and a title alone is a list with an empty body.
 */
const meta = {
  title: "Decks/TodoListDialog",
  component: TodoListDialog,
  tags: ["autodocs"],
  beforeEach: async () => {
    await EDITOR_CHUNK;
  },
  args: {
    deckId: DECK,
    open: true,
    listId: null as number | null,
    onClose: fn(),
    onDelete: fn(),
  },
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "One deck to-do list in a dialog: a **Title** field over the checklist editor, " +
          "written as it is typed. **Delete list** asks first; **Done** closes, writing whatever " +
          "is still owed.",
      },
    },
  },
} satisfies Meta<typeof TodoListDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** **New to-do list** — opened on nothing, with nothing to read first. */
export const NewList: Story = {
  play: async ({ canvas }) => {
    await expect(await canvas.findByRole("dialog", { name: "New to-do list" })).toBeInTheDocument();
    await expect(canvas.getByRole("textbox", { name: TITLE_LABEL })).toHaveValue("");
    await expect(
      await canvas.findByRole("textbox", { name: TODO_EDITOR_LABEL }),
    ).toBeInTheDocument();
  },
};

/** **An existing list** — its title in the field and its document in the editor. */
export const ExistingList: Story = {
  render: (args) => <WithList>{(id) => <TodoListDialog {...args} listId={id} />}</WithList>,
  play: async ({ canvas }) => {
    await expect(
      await canvas.findByRole("dialog", { name: "Edit to-do list" }),
    ).toBeInTheDocument();
    await expect(await canvas.findByRole("textbox", { name: TITLE_LABEL })).toHaveValue(
      "Mana base",
    );
    await expect(
      await canvas.findByRole("textbox", { name: TODO_EDITOR_LABEL }),
    ).toBeInTheDocument();
  },
};
