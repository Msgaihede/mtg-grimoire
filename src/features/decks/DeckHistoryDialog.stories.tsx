import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { DeckHistoryDialog } from "./DeckHistoryDialog";

/**
 * Everything that has happened to one deck, as a centred dialog over the editor.
 *
 * **It renders history and derives none of it.** The day grouping is `auditDays`' and every
 * sentence is `auditSentence`'s, both from `auditText.ts` — there is exactly one of each in this
 * app, because a log meant to survive being useful cannot have its wording baked into its rows,
 * and a second day-grouping is a second chance to file a 23:30 edit under tomorrow.
 *
 * **The chrome is `Dialog`'s** — the scrim, the centred panel, `aria-modal`, the Tab trap and
 * the titled header with its ✕. This surface was a right-hand drawer until 2026-08-14, and it
 * gave the deck nothing in exchange for the width it took: a history is *consulted*, never
 * dragged out of. What is left in the component is the list, which is what these stories are of.
 *
 * **Nine kinds map onto five chips**, and `quantity` is routed by its own `delta` rather than
 * given a sixth: a copy count going down is a removal to everyone except the schema. A kind this
 * build has never heard of — which a database that outlives the app that wrote it will hold —
 * lands in a sixth chip that exists only when such a row does. See {@link AnOlderBuild}.
 *
 * **The rail carries the hue and the glyph carries the meaning.** The visual direction colours
 * both; `--color-pie-g` on `--color-bg` measures 3.26:1, which passes WCAG 1.4.11 for a 3px bar
 * and fails 1.4.3 for a 12px character. So the glyphs are drawn in text colour and nothing on
 * this surface depends on hue.
 *
 * **Driven end to end by `.storybook/fake/`.** `deck_audit_list` is the fake's, and the rows are
 * `seeds.ts`' — the past those decks' writes wrote. `deck_audit.at` is the one timestamp in that
 * fixture measured from a real clock rather than from `CLOCK_BASE`, and it has to be: this is the
 * only surface that renders a stored time as a *date*, so a history dated from a fixed instant
 * would file every row under one absolute heading and put "Today" out of reach. A change made
 * during a story lands above these, under Today, because every write appends to the same table.
 */
const meta = {
  title: "Decks/DeckHistoryDialog",
  component: DeckHistoryDialog,
  tags: ["autodocs"],
  args: { deckId: 4, open: true, onDismiss: fn(), onClose: fn() },
  decorators: [
    (Story) => (
      <div
        // **`position: fixed` resolves against the nearest *transformed* ancestor**, not the
        // viewport — so this one line turns a window-covering dialog into a story-sized one.
        // Without it every story on the autodocs page covers the whole page, and the reader
        // sees one dialog where there are six.
        style={{ transform: "translateZ(0)" }}
        className="relative h-[38rem] overflow-hidden rounded-lg border border-border bg-bg"
      >
        <p className="p-4 text-sm text-dim">The deck editor sits behind the dialog.</p>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DeckHistoryDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Three days of building a Commander deck — deck 4, `Rhystic Testbed`, which is the seeded deck
 * with a history.
 *
 * The line beside the chips counts the whole history and dates its oldest row, so it says how far
 * back the dialog can see. Each day heading carries its own roll-up, and the roll-up keeps gains
 * and losses **apart** — a day that added four and cut one is not the quiet day one netted number
 * would report it as.
 */
export const AWeekOfBuilding: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("dialog", { name: "History" })).toBeInTheDocument();
    await expect(canvas.getByRole("heading", { name: "Today" })).toBeInTheDocument();
    await expect(canvas.getByRole("heading", { name: "Yesterday" })).toBeInTheDocument();

    // Yesterday drew four more lands in and cut a creature: two numbers, not one.
    const yesterday = canvas.getByRole("heading", { name: "Yesterday" }).closest("section");
    await expect(within(yesterday!).getByText("+4 / −1")).toBeInTheDocument();
    // The drawn figure reads as "plus four slash minus one"; the spoken one is a sentence,
    // and it is the only number here that no row's own sentence already carries.
    await expect(
      within(yesterday!).getByText("4 copies added, 1 copy removed"),
    ).toBeInTheDocument();

    // The sentences are `auditText`'s, verbatim — a set code is stored lowercase and printed
    // in capitals, and the fold is the half that has to be said.
    await expect(canvas.getByText("Swapped printing of Sol Ring")).toBeInTheDocument();
    await expect(canvas.getByText("C21 → SLD · folded into one row")).toBeInTheDocument();
  },
};

/**
 * The same week with the two card-count bands switched off.
 *
 * The chips stay above the list rather than inside it, so a filter that empties the list is still
 * on screen to be undone — and the count beside them says how much of the history is being looked
 * at, which is the difference between a filtered dialog and a short one.
 */
export const FilteredToTheStructure: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("dialog", { name: "History" });
    await userEvent.click(canvas.getByRole("button", { name: "Adds" }));
    await userEvent.click(canvas.getByRole("button", { name: "Removals" }));

    await expect(canvas.getByText("8 of 13 shown")).toBeInTheDocument();
    await expect(canvas.queryByText("Removed Consecrated Sphinx")).toBeNull();
    await expect(canvas.getByText("Renamed category Value to Card advantage")).toBeInTheDocument();
    // A day whose remaining rows moved no copies says so, rather than drawing a bare `+0`.
    await expect(canvas.getAllByText("no copies").length).toBeGreaterThan(0);
  },
};

/**
 * Rows written by a build that knew more than this one — deck 3, the archived Old School deck,
 * which is the honest place for them: a database outlives the app that wrote it, so this build
 * may be older *or* newer than the one that wrote a row.
 *
 * A `kind` this app has never met and a payload it cannot parse, side by side. `auditText.ts` is
 * total over both — the unknown kind degrades to "Changed the deck" and the broken payload to the
 * shortest honest sentence — and this dialog's job is not to undo that: the row keeps its date,
 * its delta and its place in the day, and it gets a chip of its own so a reader can still see it
 * and still switch it off. **A row that matched no chip and quietly vanished would be a log with
 * a hole in it**, which is the one thing a log may not have.
 */
export const AnOlderBuild: Story = {
  args: { deckId: 3 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const other = await canvas.findByRole("button", {
      name: "Other, changes this version of the app has no name for",
    });
    await expect(other).toHaveAttribute("aria-pressed", "true");
    await expect(canvas.getByText("Changed the deck")).toBeInTheDocument();
    // The unreadable payload still names its subject as far as it can, and the rows around it
    // are untouched.
    await expect(canvas.getByText("Changed category a category")).toBeInTheDocument();
    await expect(canvas.getByText("Added Ragavan, Nimble Pilferer")).toBeInTheDocument();

    await userEvent.click(other);
    await expect(canvas.queryByText("Changed the deck")).toBeNull();
  },
};

/**
 * A deck nothing has happened to yet — deck 1, which predates the table.
 *
 * An empty screen is an invitation to act, not a blank column: it names the kinds of thing that
 * will list here and says the next one will be the first line. The chips' caption goes with it —
 * "0 changes since" is a sentence about nothing.
 */
export const NothingYet: Story = {
  args: { deckId: 1 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("No changes recorded yet.")).toBeInTheDocument();
    await expect(canvas.queryByText(/changes since/)).toBeNull();
  },
};

/**
 * A read the app could not make.
 *
 * `deckMeta` is the fault for the reads a deck screen makes *beside* the deck — its categories,
 * its labels, the folder tree, the theory diff and this one. The deck itself read fine, which is
 * why there is a dialog open over it at all.
 *
 * The failure is reported **before** the emptiness, and that ordering is the whole point: a failed
 * read has no rows either, and calling it "no changes recorded yet" would tell a reader their
 * history is gone.
 */
export const HistoryUnavailable: Story = {
  parameters: { fake: { fault: "deckMeta" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText("This deck's history could not be read."),
    ).toBeInTheDocument();
    await expect(canvas.queryByText("No changes recorded yet.")).toBeNull();
  },
};

/**
 * Closed, which is nothing at all.
 *
 * `open: false` renders `null` rather than a hidden panel — there is no panel behind the scrim to
 * tab into, and nothing is read for it either: the editor keeps this component mounted, and a
 * closed dialog that asked anyway would spend a query on every deck the reader opens to look at.
 */
export const Closed: Story = {
  args: { open: false },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole("dialog")).toBeNull();
  },
};
