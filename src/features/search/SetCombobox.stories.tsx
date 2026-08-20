import { useCallback, useState, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { compareLabels } from "@/lib/options";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { SetCombobox } from "./SetCombobox";

/**
 * The picker with the selection it edits.
 *
 * `SetCombobox` is controlled — it owns "am I open" and "what has been typed" and nothing else —
 * so a story rendering it against a fixed `selected` would report every click and visibly not
 * move. `initial` seeds the state; the meta's `onToggle` still fires, so the Actions panel shows
 * what the control reports, which is the half a call site has to get right.
 */
function Picker({
  initial = [],
  onToggle,
}: {
  /** Set codes already picked when the story mounts. */
  initial?: readonly string[];
  onToggle: (code: string) => void;
}) {
  const [selected, setSelected] = useState<readonly string[]>(initial);
  return (
    <SetCombobox
      selected={selected}
      onToggle={(code) => {
        setSelected((picked) =>
          picked.includes(code) ? picked.filter((c) => c !== code) : [...picked, code],
        );
        onToggle(code);
      }}
    />
  );
}

/**
 * The picker with an **outer** dismissible layer behind it — a stand-in for the card detail pane.
 *
 * Built on the real `useDismissOnEscape` rather than on a `keydown` handler of its own, because
 * the whole subject of {@link EscapeClosesOneLayer} is which phase each rung listens in, and a
 * hand-written outer layer would be a second implementation of exactly the thing under test.
 *
 * A stand-in and not `CardDetailPane`: that component takes a card id and talks to the backend,
 * and what this needs from it is the one line it shares with every future outer layer — bubble
 * phase, and an early return on `defaultPrevented`, both of which live in the hook.
 */
function WithOuterLayer({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(true);
  const dismiss = useCallback(() => setOpen(false), []);
  useDismissOnEscape({ layer: "outer", onDismiss: dismiss, enabled: open });
  return (
    <div className="flex items-start gap-4">
      <div className="flex-1">{children}</div>
      {open && (
        <aside
          aria-label="Card details"
          className="w-56 rounded-lg border border-border bg-surface p-4 text-sm text-dim"
        >
          An outer layer, standing in for the card pane.
        </aside>
      )}
    </div>
  );
}

const meta = {
  title: "Search/SetCombobox",
  component: Picker,
  tags: ["autodocs"],
  args: { onToggle: fn() },
  // Keyed on the seed, like `QuantityStepper.stories.tsx` and `FilterChips.stories.tsx`:
  // Storybook re-renders a story when an arg changes rather than remounting it, and
  // `useState`'s initial value is read once — so without this, editing `initial` in Controls
  // would move nothing at all.
  render: (args) => <Picker key={args.initial?.join(",") ?? "none"} {...args} />,
  decorators: [
    // The listbox is 288px wide, `absolute`, and pinned `right-0` to the trigger. Room below for
    // it, and room to its left for the pin to be visible as a decision rather than as an
    // accident of where the trigger happened to be.
    (Story) => (
      <div className="flex h-96 w-[32rem] justify-end p-2">
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "A searchable, multi-select set picker — hand-rolled, and deliberately **not** a " +
          "portalled popover. The shipped CSP is `style-src 'self'`, and every Radix overlay " +
          "primitive in reach pulls in `react-remove-scroll`, which injects a runtime `<style>` " +
          "the moment it opens: that passes `tauri dev` and breaks in a packaged build. This is " +
          "a plain absolutely-positioned listbox in the trigger's own stacking context, so " +
          "nothing is injected and nothing is locked, and the ARIA wiring is the whole of what " +
          "the dependency would have provided.\n\n" +
          "It is opened by a *disclosure button*, and the combobox is the text field that " +
          "reveals — which is where the caret goes and what `aria-activedescendant` is read " +
          "from. The keyboard never leaves that field: arrows move a highlight, they do not " +
          "move focus.\n\n" +
          "The rows are ordered by **picked, then whether this search has printings for the " +
          "set, then the code rank a typed query produces, then the set's name** — the shared " +
          "`sortOptions` (`src/lib/options.ts`), given three grouping levels. `list_sets` " +
          "answers newest-first and none of that order survives here, deliberately: what the " +
          "backend says and what a picker draws are different questions. `Open` and " +
          "`PickedFirst` are the two halves of it this corpus can show.\n\n" +
          "**It draws a caller's list where one is given.** Every story here leaves `options` " +
          "absent and gets the session-cached `list_sets()` — the right answer when the question " +
          "is *which sets shall I narrow the whole corpus to*. `AllPrintingsDialog` asks a " +
          "different one and hands over the sets **one card** was printed in, which turns the " +
          "query off entirely and lifts `MAX_SETS`, a ceiling that mirrors a backend truncation " +
          "a client-side filter never reaches. That state is storied where it is used, as " +
          "`Card/AllPrintingsDialog`'s `SetPicker`, because what makes it worth looking at is " +
          "the six rows rather than the thousand — a fact about the card, not about this " +
          "control.\n\n" +
          "**Four of its states cannot be reached from the story corpus, and none is faked " +
          "here.** The fake backend derives `list_sets` from the 43 fixture printings, which is " +
          "**31 sets with a paper printing** (measured by the `Open` story's own assertion): " +
          "too few for the `Showing N of M` footer *and the `Show 50 more` button beside it* — " +
          "they appear and disappear together — which need more than the 100 options " +
          "`MAX_OPTIONS` renders, and far too few for the ceiling sentence, which needs " +
          "`MAX_SETS` (64) picked. The `large` seed does not " +
          "help: its 5 200 synthetic printings take their `setCode` from the same 33 real rows, " +
          "so it is a bigger corpus in the same sets. `Loading sets…` and " +
          "`Could not read the set list` are the query's pending and error states: the fake " +
          "resolves in a microtask and its `list_sets` handler cannot throw, so neither is " +
          "observable. Closing any of them means a corpus regeneration or a fault the fake " +
          "backend does not have, and both are worth more than a hand-written set list here. " +
          "The first two are not unpinned facts, only unstoried ones: `SetCombobox.test.tsx:158` " +
          "covers the footer, `:177` the paging control and `:276` the ceiling, each against a " +
          "set list built for it.",
      },
    },
  },
} satisfies Meta<typeof Picker>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Shut, with nothing picked: a grey disclosure button reading "Any set".
 *
 * The button's *content* is its value, so its accessible name has to come from somewhere else —
 * the `sr-only` "Set" beside it — or assistive tech announces the value twice and never says
 * what field it belongs to. That is the assertion below, and it is one nothing on screen shows.
 */
export const Closed: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole("button", { name: "Set" });
    await expect(trigger).toHaveTextContent("Any set");
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(trigger).toHaveAttribute("aria-haspopup", "listbox");
    await expect(canvas.queryByRole("listbox")).toBeNull();
  },
};

/**
 * Two sets picked, and the button turns gold and counts them.
 *
 * A count rather than the names: this control shares a line with six colour chips, nine mana
 * values, a format select and a Reset all, and "Limited Edition Alpha, Modern Horizons 2" is
 * wider than all of them together. The ceiling is 64 sets, so there is no width at which naming
 * them would have worked.
 *
 * The play opens it to reach the other half of the state — a picked row is `aria-selected` and
 * carries a check, and the check's slot is held open on *every* row so that picking one does not
 * shuffle the column sideways.
 */
export const Selected: Story = {
  args: { initial: ["lea", "mh2"] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole("button", { name: "Set" });
    await expect(trigger).toHaveTextContent("2 sets");

    await userEvent.click(trigger);
    const list = canvas.getByRole("listbox");
    // Multi-select is declared on the list, not implied by two rows being selected.
    await expect(list).toHaveAttribute("aria-multiselectable", "true");
    const picked = within(list).getByText("Limited Edition Alpha").closest("li");
    await expect(picked).toHaveAttribute("aria-selected", "true");
    const notPicked = within(list).getByText("Tempest").closest("li");
    await expect(notPicked).toHaveAttribute("aria-selected", "false");
  },
};

/**
 * Open, and what the whole list is: **31 sets**, not the 33 the fixture corpus prints cards in.
 *
 * A set with no paper printing can never match a search, so offering it would be offering an
 * empty result (`SetCombobox.tsx:182`). The two missing here are the two the corpus knows only
 * as digital printings — Vintage Masters and Final Fantasy — and the assertion names them,
 * because "31" alone would pass just as happily if the filter had dropped the wrong two. Final
 * Fantasy: Through the Ages is the control: same words at the front of its name, a paper
 * printing, and it is offered.
 *
 * **And they are alphabetical**, which is the whole of the order when nothing is picked, nothing
 * is typed and no facet counts have arrived: Amonkhet Invocations first, Zendikar Rising last,
 * where `list_sets` would have answered Assassin's Creed first and Limited Edition Alpha last.
 * Asserted against `compareLabels` rather than against 31 written-out names — the corpus is
 * generated and a regeneration must move this story rather than break it — which does mean the
 * assertion shares the app's collator and cannot catch a *wrong* one. `options.test.ts` is where
 * the collator itself is pinned.
 *
 * The real database is ~1 050 sets, which is why the list opens on a page of 100 and why that
 * page has a footer and a way to ask for the next one. Neither is reachable here; see the note
 * on this page.
 */
export const Open: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Set" }));

    const list = canvas.getByRole("listbox");
    const options = within(list).getAllByRole("option");
    await expect(options).toHaveLength(31);
    await expect(within(list).queryByText("Vintage Masters")).toBeNull();
    await expect(within(list).queryByText("Final Fantasy")).toBeNull();
    await expect(within(list).getByText("Final Fantasy: Through the Ages")).toBeInTheDocument();

    const names = options.map((option) => option.querySelector("span")?.textContent ?? "");
    await expect(names).toEqual([...names].sort(compareLabels));
    // Focus goes to the search box and stays there: the arrows move `aria-activedescendant`
    // rather than the caret, so a reader can type, narrow and pick without leaving the field.
    await expect(canvas.getByRole("combobox", { name: "Search sets" })).toHaveFocus();
  },
};

/**
 * The one level that outranks the alphabet: **a set that is on is drawn first.**
 *
 * The list is a page of 100 out of ~1 050, and a picked set that sorted past the end of it would
 * be a filter the reader can see counted on the button and cannot see, reach or switch off. So
 * "picked" is the first grouping key and the alphabet is the last — Limited Edition Alpha and
 * Modern Horizons 2 sit at the top here, above Amonkhet Invocations, which is where the A-Z
 * would otherwise start.
 *
 * The second half of the assertion is that the rule is a *partition* and not a shuffle: the 29
 * rows below the two picked ones are still in alphabetical order, so ticking a set moves exactly
 * one row and leaves the list the reader had learned to scan.
 */
export const PickedFirst: Story = {
  args: { initial: ["lea", "mh2"] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Set" }));

    const list = canvas.getByRole("listbox");
    const names = within(list)
      .getAllByRole("option")
      .map((option) => option.querySelector("span")?.textContent ?? "");
    await expect(names.slice(0, 2)).toEqual(["Limited Edition Alpha", "Modern Horizons 2"]);

    const rest = names.slice(2);
    await expect(rest[0]).toBe("Amonkhet Invocations");
    await expect(rest).toEqual([...rest].sort(compareLabels));
  },
};

/**
 * Typing narrows it — and the two ways a row can match are not the same rule.
 *
 * A **name** matches anywhere; a **code** matches only from the start. Three letters inside a
 * longer code are a coincidence, three letters inside a set's name are usually what was meant.
 * `un` shows both at once: Unfinity and Unhinged are code matches (`unf`, `unh`), and Unlimited
 * Edition is a name match whose code is `2ed`.
 *
 * `rank` then sorts exact code, code prefix, name — but **this corpus still cannot show that
 * working**, and it is a different confound from the one that used to be written here. The old
 * note said the backend's newest-first order would have produced the same three anyway; the
 * order under `rank` is now the *alphabet*, and the alphabet produces the same three too —
 * Unfinity, Unhinged, Unlimited Edition is both the rank order and plain A-Z. What would
 * separate them is a name-matching set that sorts *before* a code-matching one, and the 31
 * offered here do not contain such a pair. The ordering asserted below is therefore the
 * *result*, not a proof of its cause. `SetCombobox.test.tsx:315` is where the rule is pinned
 * against a set list the alphabet alone would fail — `lea` first, with Arena League 1999 behind
 * it. `:469` pins the middle rank, exact code over a longer code that starts with it, and that
 * pair is a real one (`pls` is Planeshift, `plst` is The List) whose two names happen to agree
 * with A-Z; it is the rank that is being separated there, not the alphabet.
 */
export const Filtered: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Set" }));
    await userEvent.type(canvas.getByRole("combobox", { name: "Search sets" }), "un");

    const list = canvas.getByRole("listbox");
    const names = within(list)
      .getAllByRole("option")
      // The first `<span>` in a row is the set's name; the second is its code and the third is
      // the check's slot.
      .map((option) => option.querySelector("span")?.textContent);
    await expect(names).toEqual(["Unfinity", "Unhinged", "Unlimited Edition"]);
  },
};

/**
 * A query nothing matches: one sentence where the rows would be.
 *
 * It is a `role="presentation"` `<li>` rather than a bare one, because a plain `<li>` inside a
 * `listbox` is a `listitem` where only `option`s are allowed — assistive tech would announce a
 * broken list. The role makes it the sentence it already looks like.
 */
export const NoMatch: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Set" }));
    await userEvent.type(canvas.getByRole("combobox", { name: "Search sets" }), "zzzz");

    const list = canvas.getByRole("listbox");
    await expect(within(list).getByText("No sets match that.")).toBeInTheDocument();
    await expect(within(list).queryAllByRole("option")).toHaveLength(0);
  },
};

/**
 * A database with no sets in it at all — and **the same sentence**, which is worth seeing.
 *
 * On a first launch this picker can be opened while the opening sync is still writing `sets`, so
 * an empty answer is a real state and not only a hypothetical. The component has three sentences
 * for an empty list — pending, failed, and no match — and this case falls into the third: the
 * query has answered, successfully, with nothing. "No sets match that." is then a reply to a
 * question the reader did not ask, since they have typed nothing.
 *
 * Left as it is rather than storied around: the copy is the component's, this file only shows
 * what it says. It is recorded here so the gap is a decision rather than a discovery.
 */
export const EmptyDatabase: Story = {
  parameters: { fake: { seed: "empty" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Set" }));

    const list = canvas.getByRole("listbox");
    await expect(within(list).getByText("No sets match that.")).toBeInTheDocument();
  },
};

/**
 * Escape closes **one** layer per press, and the protocol is a handshake rather than a z-index.
 *
 * Both rungs listen on `window`, so neither can see the other and neither can be ordered by CSS.
 * The listbox is the `"inner"` one: it listens in the **capture** phase and calls
 * `preventDefault()`, and the outer layer returns early on `defaultPrevented`. Capture is the
 * load-bearing half — two `window` listeners for one event run in *registration* order, and the
 * outer layer is always the one mounted first, so in the bubble phase it would act first, read
 * `defaultPrevented` as false, and close the pane *and* the popup on one press.
 *
 * `App.test.tsx` pins the real stack (the card pane with a real popup inside it). What this
 * story adds is the same fact where a reader can watch it: press once, the listbox goes and the
 * panel beside it stays; press again, the panel goes.
 *
 * The second assertion is the other half of the contract and is invisible: a layer Escape
 * dismissed hands focus back to whatever opened it, *before* React flushes the close, while the
 * element is still mounted — otherwise the caret lands on `<body>` and the next Tab restarts
 * from the top of the app rather than continuing along the filter row. An outside click
 * deliberately does not do this; the reader is already somewhere else.
 */
export const EscapeClosesOneLayer: Story = {
  render: (args) => (
    <WithOuterLayer>
      <Picker {...args} />
    </WithOuterLayer>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole("button", { name: "Set" });
    await expect(canvas.getByRole("complementary", { name: "Card details" })).toBeInTheDocument();

    await userEvent.click(trigger);
    await expect(canvas.getByRole("listbox")).toBeInTheDocument();

    await userEvent.keyboard("{Escape}");
    await expect(canvas.queryByRole("listbox")).toBeNull();
    // The outer layer is untouched: one press, one layer.
    await expect(canvas.getByRole("complementary", { name: "Card details" })).toBeInTheDocument();
    await expect(trigger).toHaveFocus();

    await userEvent.keyboard("{Escape}");
    await expect(canvas.queryByRole("complementary", { name: "Card details" })).toBeNull();
  },
};
