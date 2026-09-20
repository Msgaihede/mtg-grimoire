import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn } from "storybook/test";
import type { DeckNote } from "@/lib/ipc";
import { NoteEditorDialog, type NoteDraft } from "./NoteEditorDialog";

/**
 * ⚠️ **The two `Range` methods jsdom does not implement — and these are the first stories in this
 * repo that need them.**
 *
 * Every other story in the app deliberately avoids mounting an editor (`DeckNotesPanel.stories.tsx`
 * says so in as many words: *"What no press here does is load an editor."*), so neither
 * `src/test-setup.ts` nor `src/stories.test.tsx` installs these — the two suites that mount a
 * ProseMirror view each carry their own copy. This file is the third, and it is the first that is
 * collected by `stories.test.tsx`.
 *
 * What it buys is not cosmetic: ProseMirror asks a `Range` for its rectangles on any dispatch that
 * scrolls the selection into view, jsdom has **no such method**, and the `TypeError` is thrown
 * inside the view's own dispatch — so it escapes as an **unhandled error**, and
 * `stories.test.tsx` records what that costs in this repo's own words: *"Vitest fails a run on an
 * unhandled error even when every test passed."* A red `npm run verify` reporting
 * `Tests 0 failed`.
 *
 * Nothing below types or focuses, so it may well never fire — which is exactly why it is written
 * down rather than left to be found on a CI run. `??=`, so a jsdom that grows a real
 * implementation is used instead.
 */
Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();

/**
 * ⚠️ **The lazy chunk, started here and awaited before every story — because `findBy*` gives a
 * dynamic import one second, and under load it does not always win.**
 *
 * Three of the four plays below wait on the editing surface, and that surface is Tiptap behind a
 * `React.lazy`. So on any run where the module is not already in the registry, the first of them
 * is racing the import rather than measuring this dialog — and `findBy*`'s default is **1 000 ms**
 * however long the module actually takes.
 *
 * **It is load and not a disk cache**, which is worth stating because the natural guess is the
 * other one and it is checkable: vitest's own on-disk cache (`node_modules/.vite/vitest`) measures
 * about **1 KB**, and deleting it before a filtered run of this file changed nothing at all —
 * 20.27 s, four plays green (2026-09-20). Every `vitest run` is a fresh process; what varies
 * between them is the machine. The two failures on record have that shape.
 * `NoteEditorDialog.test.tsx`'s own `beforeAll` records one — *"the same file passed in 3.5 s and,
 * on a run whose setup alone took 2.7 s, failed with the first test timing out on exactly that
 * await"*. The second was this file's neighbour on 2026-09-20: `DeckNotesPanel.stories.tsx`'s
 * `Empty` went red on the same kind of await on a run whose transform and import phases both took
 * roughly twice their usual length (**20.0 s / 33.3 s**, against **8.1 s / 16.6 s** on the very
 * next run of the same filter). A single run never reproduces either, which is the whole reason
 * this is written rather than waited on.
 *
 * **These plays have been winning that race by luck rather than by design.**
 * `DeckNotesPanel.stories.tsx` sorts before this file and presses `New note`, so by the time these
 * run the module is usually already in the registry — but story order is not a contract, and a
 * rename, a split, or a filtered run of this file alone puts it first and the luck is gone.
 *
 * **This is not a sleep.** It awaits the exact resource being raced and nothing else: it costs
 * what the import costs and no more, and once settled it is a registry hit in the same tick.
 * `NoteEditorDialog.test.tsx` solves the identical race with `beforeAll(async () => { await
 * import("./NoteEditor"); })`; `beforeEach` on the meta is CSF's slot for it — `runStory` awaits
 * `applyBeforeEach` before it mounts anything, so the wait lands where vitest's own 15 s
 * `testTimeout` applies instead of testing-library's one second, and the promise is started here
 * at module scope so the import is already in flight by the first story.
 *
 * ⚠️ **It must stay an `import()` _expression_.** A static `from "./NoteEditor"` in a story file
 * is not exempt from `DeckNotesPanel.test.tsx`'s 141.5 kB sweep — that sweep excuses only
 * `NoteEditor`'s own file and `.test.` files — so writing this as an import statement would turn
 * the one fence for the lazy boundary red.
 */
const EDITOR_CHUNK = import("./NoteEditor");

function note(over: Partial<DeckNote> & { id: number }): DeckNote {
  return {
    deckId: 1,
    title: "",
    body: "",
    sortOrder: over.id,
    cards: [],
    // A fixed instant rather than `Date.now()`: nothing here prints a date, and a fixture whose
    // values move between two renders of a docs page can make one story disagree with the next
    // for a reason no reader could see.
    createdAt: 1_800_000_000,
    updatedAt: 1_800_000_000,
    ...over,
  };
}

/**
 * Where a note is written — **the one editor in this feature, and the only door to Tiptap.**
 *
 * **Three modes, one dialog, and the only differences are three strings**: the heading, the
 * button's verb, and whether a card comes along. The surface, the footer and the draft are one
 * thing, which is why the four stories below are four sets of arguments rather than four
 * components.
 *
 * **There is no title field, and that is the redesign's own sentence.** Every note this dialog
 * writes is written with `title: ""`, and the name a reader sees is the body's first line. The
 * rule has nothing left saying it but the empty surface's own prompt, which is why
 * {@link NewNote} is the story that matters most here: it is the only place the reader is told
 * what happens to what they are about to type.
 *
 * ⚠️ **These stories really do fetch the editor**, and that is the point rather than an
 * oversight. `NoteEditor` is 141.5 kB gzip behind a `React.lazy`, so a *band* showing twenty
 * notes costs the main chunk nothing — and a dialog whose whole subject is the writing surface
 * has to draw one. **What none of them does is press Save**: a `play` that did would be paying
 * for the round trip to prove a callback this file already types.
 */
const meta = {
  title: "Decks/NoteEditorDialog",
  component: NoteEditorDialog,
  tags: ["autodocs"],
  // The wait itself — see {@link EDITOR_CHUNK}. On the meta rather than on each story, so a fifth
  // story added here inherits it rather than having to remember the race.
  beforeEach: async () => {
    await EDITOR_CHUNK;
  },
  args: {
    open: true,
    // The cast is what lets the three drafts below exist: `StoryObj<typeof meta>` takes each
    // argument's type from the value written here, so a bare object literal would narrow this
    // arg to the one mode and make the other two unwritable.
    draft: { kind: "new" } as NoteDraft,
    pending: false,
    onSave: fn(),
    onClose: fn(),
  },
  parameters: {
    // The dialog is `fixed inset-0` — it covers the window, so a padded canvas would only draw a
    // frame around a scrim that ignores it.
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "The one place a deck note gets written — a centred modal over the band, at " +
          "`w-[40rem]`.\n\n" +
          "**No title field.** The note is written with a blank title and named by its body's " +
          "first line, which is what `noteTitle()` already did for a blank one. The rule is " +
          "taught by the empty surface's placeholder and by nothing else, because a rule with " +
          "nothing saying it is a rule the reader breaks.\n\n" +
          "**Save is refused on an empty body**, through `noteToPlainText` and never the " +
          "markdown string — an empty ProseMirror document is not an empty string. It refuses " +
          "with `aria-disabled` rather than the attribute: the button greys and un-greys as the " +
          "reader types, and a real `disabled` control leaves the tab order, so a reader who " +
          "cleared their last word would find the caret thrown out of the footer by their own " +
          "press. `pending` is the other kind of no and *is* the attribute — the half-second a " +
          "write is in flight.\n\n" +
          "**A fresh open is a fresh draft with nothing resetting it.** `Dialog` mounts and " +
          "unmounts its children, so the draft's `useState` is seeded once per open and no " +
          "effect syncs it back to the prop.\n\n" +
          "**Naming cards is not asked here.** A note names cards through the card actions on " +
          "the note itself; a create the card menu asked for says which card it will name in " +
          "the subtitle, and that is the whole of this dialog's dealings with attachment.",
      },
    },
  },
} satisfies Meta<typeof NoteEditorDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * **A note nobody has written yet, which is where the naming rule is taught.**
 *
 * The heading is the generic `New note` because there is no note to name yet, the verb is
 * `Save note` rather than a bare `Save` — a dialog opened from a card menu has to say what is
 * being saved — and the button is greyed from the first frame, because a blank save would make a
 * note called `Untitled note` with nothing in it.
 *
 * The prompt on the empty surface is the one thing on screen that says the first line becomes the
 * note's name. Painted by a `::before` on ProseMirror's own decorated paragraph, it is not text
 * in the document and never reaches the body.
 */
export const NewNote: Story = {
  play: async ({ canvas }) => {
    await expect(await canvas.findByRole("heading", { name: "New note" })).toBeInTheDocument();
    // The refusal, in the spelling that keeps the button's tab stop. Not pressed: what a press
    // does is `NoteEditorDialog.test.tsx`'s, and a `play` that pressed Save would be asserting a
    // callback rather than showing a state.
    await expect(await canvas.findByRole("button", { name: "Save note" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    // No title field anywhere — the thing this redesign deleted. **Counted rather than
    // name-matched**: a `queryByRole("textbox", { name: /title/i })` is satisfied by an
    // unlabelled input, or by one called `Name` or `Heading`, which is the same field wearing a
    // different word. One box, and it is the body.
    const boxes = await canvas.findAllByRole("textbox");
    await expect(boxes).toHaveLength(1);
    await expect(boxes[0]).toHaveAccessibleName("Body of New note");
  },
};

/**
 * **The card menu's create**, which differs from {@link NewNote} by one line of type.
 *
 * The subtitle is a promise the press has already made: the host attaches the card in the same
 * write, so the dialog says which one rather than asking. There is no picker here and there is
 * not meant to be — naming cards stays a card action on the note itself, and a create that opened
 * a second chooser would be asking a question the reader answered by right-clicking.
 */
export const NewNoteFromACard: Story = {
  args: {
    draft: { kind: "newFromCard", card: { oracleId: "o-bolt", name: "Lightning Bolt" } },
  },
  play: async ({ canvas }) => {
    await expect(await canvas.findByText(/will name Lightning Bolt/)).toBeInTheDocument();
    // Still the create's verb and still the create's heading: the card narrows the sentence and
    // nothing else about the dialog moves.
    await expect(await canvas.findByRole("heading", { name: "New note" })).toBeInTheDocument();
  },
};

/**
 * **An edit, seeded with what is already there.**
 *
 * Two things change and only two: the heading is the note's own name, so a reader who opened the
 * wrong row can see it; and the verb is the bare `Save`, because the thing being saved is the note
 * the heading has just named.
 *
 * The heading is the note's **stored** title rather than the draft's first line — a heading that
 * renamed itself under the reader's hands as they typed would be the one thing on screen that had
 * stopped identifying what they opened.
 */
export const EditingANote: Story = {
  args: {
    draft: {
      kind: "edit",
      note: note({
        id: 7,
        title: "Mana base",
        body:
          "Fourteen sources, and two of them are **slow**.\n\n" +
          "- Sol Ring\n" +
          "- Arcane Signet\n\n" +
          "> Cut a land before cutting a rock.",
      }),
    },
  },
  play: async ({ canvas }) => {
    await expect(await canvas.findByRole("heading", { name: "Mana base" })).toBeInTheDocument();
    await expect(await canvas.findByRole("button", { name: "Save" })).toBeInTheDocument();
    // Seeded, and with a body there is nothing to refuse: the button is in reach from the first
    // frame, which is the other half of the blank rule.
    await expect(canvas.getByRole("button", { name: "Save" })).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
  },
};

/**
 * **A note with no title at all, which is every note this dialog writes.**
 *
 * `deck_notes.title` is legally `''` and stays that way, so the heading is `noteTitle()`'s second
 * arm — the body's first line, with its markup gone. That is the rule the create flow's
 * placeholder is promising, shown here on the other side of it: what a reader typed as their
 * first line is what the note is called everywhere afterwards.
 */
export const EditingABlankTitledNote: Story = {
  args: {
    draft: {
      kind: "edit",
      note: note({
        id: 8,
        title: "",
        body: "Ask Supreme about the Bolt count\n\nThree felt like too few all night.",
      }),
    },
  },
  play: async ({ canvas }) => {
    await expect(
      await canvas.findByRole("heading", { name: "Ask Supreme about the Bolt count" }),
    ).toBeInTheDocument();
  },
};
