import { useId, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import type { CardSummary } from "@/lib/ipc";
import { MAX_SUGGESTIONS, QuickAdd } from "./QuickAdd";

/**
 * What the deck the field writes into is called here.
 *
 * The wrapper's list stands in for the deck, so it needs a name a story can address it by, and
 * the name is a constant rather than six copies of one string.
 */
const ADDED = "Added to the deck";

/**
 * A query the fixture corpus answers with more cards than the field will show.
 *
 * **A type line and not a name**, deliberately: the point of this word is that it matches
 * *seventeen* of the corpus's paper cards, which is the only way to see the ceiling do anything.
 * It is a real query on both sides of the fake — `cards_fts` is `(name, type_line, search_text)`
 * (`schema.rs:1273`), so the shipped search reads type lines too — and it is the fake's own
 * simplification that decides the five that come back and their order. Nothing on this page
 * asserts *which* five; see the note on the page.
 */
const MANY = "creature";

/** A name no card in the 43-printing corpus carries — `DeckSearchPanel.stories.tsx`'s miss, so
 *  that "the search really has no answer" is one word across the workbench rather than two. */
const NONE = "brushwagg";

/**
 * The field with the pile it adds to.
 *
 * `QuickAdd` is uncontrolled and reports through one callback, so a story mounting it bare would
 * be a control whose every add went nowhere visible — the same reason `SetCombobox.stories.tsx`
 * has a `Picker` and `DeckSearchPanel.stories.tsx` a `Panel`. The list below is this file's
 * stand-in for the deck: in the app `onAdd` is `useDeck.addCard`, and what a reader watches for
 * is a card arriving somewhere. The meta's `onAdd` still fires beneath it, so the Actions panel
 * shows the half a call site has to get right.
 *
 * **No `QueryClientProvider` here**, and that is not an omission: `preview.tsx`'s `withFake`
 * wraps every story in the world's own client, so the `useQuery` inside `QuickAdd` is answered
 * by the seeded fake backend exactly as `DeckEditor`'s is.
 *
 * The list is a plain sibling and the suggestions are drawn *over* it — `LAYER.popup`, which is
 * what the panel does to the deck's own groups one floor up. That overlap is the story rather
 * than a layout accident, so nothing here pushes it out of the way.
 */
function Field({
  targetName,
  onAdd,
}: {
  /** `QuickAdd`'s own prop, straight through: the pile's name, or `null` under `AUTO_CATEGORY`. */
  targetName: string | null;
  /** `QuickAdd`'s own prop. Called *in addition to* the list below, never instead of it. */
  onAdd: (card: CardSummary) => void;
}) {
  const [added, setAdded] = useState<readonly CardSummary[]>([]);
  // `useId` and not a literal: a docs page mounts every story on it at once, and a hard-coded id
  // would be six elements answering to one label.
  const labelId = useId();
  return (
    <div className="flex flex-col gap-4">
      <QuickAdd
        targetName={targetName}
        onAdd={(card) => {
          setAdded((cards) => [...cards, card]);
          onAdd(card);
        }}
      />
      <div>
        <p id={labelId} className="mb-1 text-[0.6875rem] text-dim">
          {ADDED}
        </p>
        {/* `aria-labelledby` rather than an `aria-label`, so the words on screen and the words a
            screen reader hears are one string — a second, invisible copy of a visible label is
            the mistake `DeckSearchPanel`'s disclosure exists not to make. */}
        <ul aria-labelledby={labelId} className="space-y-0.5 text-sm text-text">
          {added.map((card, i) => (
            <li key={`${card.id}-${i}`}>{card.name}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

const meta = {
  title: "Decks/QuickAdd",
  // The wrapper, not `QuickAdd`, for `FilterBar.stories.tsx`'s reason: `component` has to be the
  // thing the meta is typed over. Both of the wrapper's props *are* the component's and pass
  // straight through, so the table below is still `QuickAdd`'s.
  component: Field,
  tags: ["autodocs"],
  args: {
    // `null` is the field's resting state in the app, not an edge case: a deck is born on
    // `AUTO_CATEGORY`, where there is no one pile to name because the pile is per card.
    // {@link NamedTarget} is the other half — a deck whose settings name one.
    targetName: null,
    onAdd: fn(),
  },
  decorators: [
    // Room below the field for a 288px panel that is `absolute top-full left-0`, and room to its
    // right for the status line — the field is `w-52` (208px) and the panel is wider than it, so
    // a box only as wide as the input would hide the one thing this page is about.
    (Story) => (
      <div className="h-80 w-[34rem] p-3">
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "The deck editor's quick add: a name, a list of what it could be, and the card it " +
          "turns out to be. It is a **combobox**, and hand-rolled for the reason " +
          "`Search/SetCombobox` is — the shipped CSP is `style-src 'self'` and every portalled " +
          "overlay primitive injects a runtime `<style>` the moment it opens, which passes " +
          "`tauri dev` and breaks in a packaged build. Both draw their list in the shared " +
          "`PopupPanel`, so nothing is injected and nothing is locked.\n\n" +
          "**Three routes reach one write**: Enter on the highlighted suggestion " +
          "({@link KeyboardPicks}), a click on any row ({@link ClickToAdd}), and — inside the " +
          "300ms debounce, before any suggestion exists — a one-shot `limit: 1` search. That " +
          "third route is the field's *original* behaviour and the only one that survives a " +
          "reader who types a whole name and presses Enter faster than the debounce, which is " +
          "also why it is the only route that can report a miss ({@link NoMatch}).\n\n" +
          "**Five suggestions, and the ceiling is the reader's rather than the backend's.** " +
          "This is a shortcut over the docked panel's wall, not a second one: a list long " +
          "enough to need a scrollbar has stopped being a shortcut. The search is " +
          "`collapse: true`, so every row is the newest printing of that name — the same one " +
          "the panel offers first for the same text — and a reader who cares which printing " +
          "they get has that panel open beside them.\n\n" +
          "**The caret never leaves the field.** Arrows move `aria-activedescendant` rather " +
          "than focus, and a row's `onMouseDown` refuses the focus a click would take, so the " +
          "next name can be typed without going back for the input. Both are invisible on " +
          "screen and both are asserted below.\n\n" +
          "**Nothing here asserts *which* card comes first, and that is a limit of the fake.** " +
          "`.storybook/fake/db.ts`'s `search_cards` matches a case-insensitive **substring over " +
          "name and type line** and falls back to the browse order: there is no FTS5 index to " +
          "rank with, so it is neither a prefix match nor `bm25`. The shipped search is " +
          "`cards_fts(name, type_line, search_text)` ranked by `bm25`, which is a different " +
          "answer to the same query. What these stories claim is what the *component* decides — " +
          "that rows appear, that there are at most five, and where the highlight is — and " +
          "never what the backend ranked.\n\n" +
          "**There is no story for `Could not search — …`, and it is not for want of trying.** " +
          "A refused *search* would need a fault, and none of the fake's ten touches " +
          "`search_cards` — `busy` is a write lock, raised by `refuseIfBusy` at the top of every " +
          "write handler and by no read handler. The sentence is reachable only from the " +
          "one-shot lookup's `isError`, which the fake cannot produce, so the state is recorded " +
          "here as a decision rather than found later as a gap. The `empty` seed reaches " +
          "{@link NoMatch}'s sentence instead, and for a different reason: a database that has " +
          "not finished its first sync answers every name with nothing.\n\n" +
          "**A green story here is not the live pass**, and never was — jsdom paints nothing " +
          "and Storybook is not the shipped window. That pass was driven separately on " +
          "2026-08-14 and its figures live in `src/features/decks/CLAUDE.md`: the panel's " +
          "anchoring and layer, the arrows moving the highlight without the caret leaving the " +
          "field, and Escape closing this list while leaving the card pane open.",
      },
    },
  },
} satisfies Meta<typeof Field>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The field, addressed the way a screen reader finds it — by role and by name. */
const fieldIn = (canvas: ReturnType<typeof within>, name = "Quick add a card") =>
  canvas.getByRole("combobox", { name });

/**
 * Type, and wait for the rows the debounce eventually produces.
 *
 * The `waitFor` is `DeckSearchPanel.stories.tsx`'s: `DEBOUNCE_MS` is 300, so anything downstream
 * of a keystroke is asserted with an explicit timeout rather than with a bare `getBy` that would
 * be racing a timer. The length is asserted *inside* the wait, not after it, because a list that
 * is briefly one row short is a list this would otherwise catch mid-fill.
 */
async function suggest(canvas: ReturnType<typeof within>, text: string): Promise<HTMLElement[]> {
  await userEvent.type(fieldIn(canvas), text);
  await waitFor(
    async () => {
      await expect(within(canvas.getByRole("listbox")).getAllByRole("option")).toHaveLength(
        MAX_SUGGESTIONS,
      );
    },
    { timeout: 4000 },
  );
  return within(canvas.getByRole("listbox")).getAllByRole("option");
}

/** A row's card name — the first `<span>` in it, ahead of the cost and the set code. */
const nameOf = (option: HTMLElement) => option.querySelector("span")?.textContent ?? "";

/**
 * The field at rest: a placeholder, no list, and a live region with nothing in it.
 *
 * **The empty `role="status"` is the point of this story.** It is mounted for as long as the
 * toolbar is, rather than appearing with its sentence already inside — a live region that arrives
 * together with its text announces nothing, because there was no change to notice. The same rule
 * governs the ribbon's status line.
 *
 * `aria-expanded="false"` is `listOpen` and not `open`: the component starts with its list
 * *allowed* and with nothing to put in it, and those are not the same state. The absent
 * `aria-activedescendant` is the other half — an id pointing at no element announces nothing at
 * all, so the attribute goes away rather than pointing at row zero of an empty list.
 */
export const Resting: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const field = fieldIn(canvas);
    await expect(field).toHaveValue("");
    await expect(field).toHaveAttribute("placeholder", "Sol Ring…");
    await expect(field).toHaveAttribute("aria-expanded", "false");
    await expect(field).toHaveAttribute("aria-autocomplete", "list");
    await expect(field).not.toHaveAttribute("aria-activedescendant");
    await expect(canvas.queryByRole("listbox")).toBeNull();
    await expect(canvas.getByRole("status").textContent).toBe("");
  },
};

/**
 * Typing, with the list up: **five rows, and seventeen cards match**.
 *
 * `MAX_SUGGESTIONS` is imported rather than written as `5`, so this assertion moves with the
 * constant instead of quietly becoming a claim about a number nobody changed on purpose.
 *
 * There is no `scrollIntoView` in this component and there is one in `SetCombobox`, and the
 * reason is this shape: five rows are all visible at once, so the highlight can never move out of
 * the box. The first row is highlighted before any arrow is pressed — `aria-activedescendant`
 * points at it — which is what makes Enter mean something to a reader who has only typed.
 *
 * `aria-autocomplete` is `list` rather than `both`: the rows are the search's answer, not a
 * completion of what is being typed, and nothing is ever written into the field on the reader's
 * behalf.
 */
export const Suggestions: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const options = await suggest(canvas, MANY);
    const field = fieldIn(canvas);
    const list = canvas.getByRole("listbox");

    await expect(field).toHaveAttribute("aria-expanded", "true");
    // The field points at the list it controls, and the list is the element that id names.
    await expect(field).toHaveAttribute("aria-controls", list.id);
    await expect(options[0]).toHaveAttribute("aria-selected", "true");
    await expect(field).toHaveAttribute("aria-activedescendant", options[0].id);
    // The id an option carries and the id `aria-activedescendant` points at are one spelling,
    // and a mismatch is invisible to the eye and total to a screen reader.
    await expect(document.getElementById(options[0].id)).toBe(options[0]);
  },
};

/**
 * Down twice takes the third row, and Enter takes what the highlight is on.
 *
 * Focus never moves: every assertion here is about `aria-selected` and
 * `aria-activedescendant`, which is the whole of what the arrows do. A combobox that moved the
 * caret into its own list would make a reader Tab back out of it to type the next name.
 *
 * The add is read off the row rather than written out, because *which* card is third is the
 * fake's ordering and not this component's claim — see the note on this page. What is claimed is
 * that the card that lands is the card the highlight was on.
 *
 * Enter reaching a row at all depends on `fresh`: the rows have to answer the text that is in the
 * field *now*, or Enter falls through to the one-shot search. It is true here because the wait
 * above outlives the debounce, and it is deliberately false in {@link NoMatch}.
 */
export const KeyboardPicks: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const options = await suggest(canvas, MANY);
    const field = fieldIn(canvas);

    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    await expect(options[2]).toHaveAttribute("aria-selected", "true");
    await expect(options[0]).toHaveAttribute("aria-selected", "false");
    await expect(options[1]).toHaveAttribute("aria-selected", "false");
    await expect(field).toHaveAttribute("aria-activedescendant", options[2].id);
    await expect(field).toHaveFocus();

    const picked = nameOf(options[2]);
    await expect(picked).not.toBe("");
    await userEvent.keyboard("{Enter}");

    await waitFor(async () => {
      await expect(
        within(canvas.getByRole("list", { name: ADDED })).getByText(picked),
      ).toBeVisible();
    });
    await expect(args.onAdd).toHaveBeenCalledOnce();
    // Cleared on a hit, so the next name can be typed straight away — and the list goes with it,
    // because the rows are read off the field's text rather than off the debounced copy.
    await expect(field).toHaveValue("");
    await expect(canvas.queryByRole("listbox")).toBeNull();
  },
};

/**
 * A click on any row, and **the caret stays in the field**.
 *
 * That is the assertion no screenshot shows and the one this story exists for: a row's
 * `onMouseDown` calls `preventDefault()`, so the press never takes focus off the input. Without
 * it the click blurs the field, the root's `onBlur` closes the list, and the press lands on
 * nothing at all.
 *
 * The second row rather than the first, so the story is about the row that was pressed rather
 * than about the row Enter would have taken anyway.
 */
export const ClickToAdd: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const options = await suggest(canvas, MANY);
    const field = fieldIn(canvas);

    const picked = nameOf(options[1]);
    await expect(picked).not.toBe("");
    await userEvent.click(options[1]);

    await waitFor(async () => {
      await expect(
        within(canvas.getByRole("list", { name: ADDED })).getByText(picked),
      ).toBeVisible();
    });
    await expect(args.onAdd).toHaveBeenCalledOnce();
    await expect(field).toHaveFocus();
    await expect(field).toHaveValue("");
  },
};

/**
 * A name the database does not have — said in words, with the typed text kept.
 *
 * **Enter is what produces this sentence, and nothing else can.** The debounced list simply has
 * no rows and stays shut; the miss lives on the one-shot `limit: 1` lookup, which is the only
 * route that ever asks a question it can get "nothing" back from. So a story that only typed
 * would show an empty box and no explanation, which is precisely the state the sentence exists to
 * replace.
 *
 * The text is typed and submitted in one call, which puts the press well inside the 300ms
 * debounce — the ordinary case for a reader who knows what they are typing, and the reason
 * `onKeyDown` handles Enter *before* it gives up on an empty list.
 *
 * **The field is not cleared.** A hit and a miss are different next actions: type the next card,
 * or correct this one. The one live region carries both, so the sentence replaces "Looking…"
 * rather than appearing beside it.
 */
export const NoMatch: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const field = fieldIn(canvas);
    await userEvent.type(field, `${NONE}{Enter}`);

    await waitFor(
      async () => {
        await expect(canvas.getByRole("status")).toHaveTextContent(`No card found for “${NONE}”.`);
      },
      { timeout: 4000 },
    );
    await expect(field).toHaveValue(NONE);
    await expect(args.onAdd).not.toHaveBeenCalled();
    // The debounced search settles on nothing a beat later, so there is no list either — and the
    // status line is the whole of the explanation.
    await expect(canvas.queryByRole("listbox")).toBeNull();
  },
};

/**
 * The same field pointed at a named pile: `Quick add a card to Sideboard`.
 *
 * The name is the control's whole answer to "where does this go", and it is an `aria-label`
 * because there is no room on this toolbar row for a visible one. Under `AUTO_CATEGORY` — every
 * other story on this page — it says only `Quick add a card`, because the pile is decided per
 * card by the type line and a name promising one would be a control named after a setting rather
 * than after what pressing it does.
 *
 * The absence of the shorter name is asserted too: `getByRole`'s string `name` is an exact match,
 * so the two cannot both be true, and a story asserting only the presence of the long one would
 * pass just as happily if the label had grown a second copy.
 */
export const NamedTarget: Story = {
  args: { targetName: "Sideboard" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(fieldIn(canvas, "Quick add a card to Sideboard")).toBeVisible();
    await expect(canvas.queryByRole("combobox", { name: "Quick add a card" })).toBeNull();
  },
};
