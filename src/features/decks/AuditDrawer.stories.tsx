import { useMemo, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import type { DeckAuditEntry, DeckAuditKind } from "@/lib/ipc";
import { printing } from "../../../.storybook/fake/fixtures";
import { AuditDrawer } from "./AuditDrawer";

/**
 * The deck's history, over the deck.
 *
 * **These stories seed a `QueryClient` of their own rather than the fake backend**, and that is
 * a deliberate gap rather than a shortcut: `.storybook/fake/db.ts` has no `deck_audit_list`
 * handler yet — the audit tables reach the fake in Task 19 — and a story file may not reach
 * into the fake to give itself one. So each story installs its own client, pre-answered under
 * the very key `useDeckAudit` reads (`["decks", "audit", deckId]`) and never stale, which means
 * the real hook, the real `ipc` mirror and the real `auditText` all run and only the transport
 * is stood in for. {@link HistoryUnavailable} is the story that leaves the seeding out and
 * shows what the drawer does with a read it cannot make.
 */

/** A stamp at a fixed local hour on a given day, so "Today" and "Yesterday" are those days
 *  whenever the catalogue is opened — an offset in seconds would cross midnight and file a
 *  story's entries under the wrong heading. */
function stamp(daysAgo: number, hour: number, minute: number): number {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, minute, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

let nextId = 1;

/**
 * One history row.
 *
 * The card ids and names come off **corpus printings**, for the reason every deck fixture in
 * this repository does: a name in a log is the one handle a reader has on the card it is about,
 * and inventing one teaches a catalogue reader a card that does not exist. The payloads are
 * written out, because a payload is exactly what Rust writes and what `auditText.ts` reads —
 * a fixture that built them through a helper would be asserting against its own helper.
 */
function row(
  kind: DeckAuditKind,
  at: number,
  payload: string,
  over: Partial<DeckAuditEntry> = {},
): DeckAuditEntry {
  return {
    id: nextId++,
    deckId: 1,
    at,
    variant: "live",
    kind,
    cardId: null,
    cardName: null,
    payload,
    delta: 0,
    ...over,
  };
}

/** A row about one printing, named as the backend denormalises it. */
function card(
  kind: DeckAuditKind,
  at: number,
  setCode: string,
  collectorNumber: string,
  payload: string,
  delta: number,
): DeckAuditEntry {
  const p = printing(setCode, collectorNumber);
  return row(kind, at, payload, { cardId: p.id, cardName: p.name, delta });
}

/**
 * A week of building, in the order the backend answers: newest first.
 *
 * Every band is represented, because the chips above the list are only worth pressing if there
 * is something behind each of them — and the three days are three different shapes of day: one
 * that gained and cut, one that only cut, and the day the deck was created.
 */
const WEEK: DeckAuditEntry[] = [
  card("add", stamp(0, 14, 12), "kld", "235", '{"category":"Value","quantity":1}', 1),
  card("move", stamp(0, 14, 9), "avr", "6", '{"from":"Creature","to":"Maybeboard"}', 0),
  card("swap", stamp(0, 13, 58), "c21", "263", '{"fromSet":"c21","toSet":"sld","folded":true}', 0),
  card("remove", stamp(0, 13, 51), "mp2", "8", '{"category":"Draw","reason":"cut for the curve"}', -1),
  row(
    "category",
    stamp(0, 11, 20),
    '{"action":"rename","name":"Draw","previousName":"Value","cards":7}',
  ),
  card("tag", stamp(0, 11, 4), "avr", "6", '{"tag":"Cut candidate"}', 0),

  card("remove", stamp(1, 22, 31), "isd", "51", '{"category":"Creature","quantity":1}', -1),
  // The one shape a `quantity` row takes in a singleton deck: basic lands, which CR 100.2a
  // exempts from every copy limit.
  card("quantity", stamp(1, 22, 24), "lea", "288", '{"category":"Lands","from":3,"to":7}', 4),
  row("category", stamp(1, 20, 15), '{"action":"deactivate","name":"Maybeboard","cards":10}'),
  row("deck", stamp(1, 19, 58), '{"field":"built","to":true}'),

  card("add", stamp(6, 18, 2), "eld", "303", '{"category":"Commander","quantity":1}', 1),
  row("deck", stamp(6, 18, 1), '{"field":"format","from":"casual","to":"Commander"}'),
  row("folder", stamp(6, 18, 0), '{"action":"move","folder":"Commander › Legends"}'),
];

/**
 * One story's backend, as a pre-answered query.
 *
 * `staleTime: Infinity` is the load-bearing option: with it, a query that already has data
 * never refetches, so nothing in these stories ever reaches the fake's dispatch table and asks
 * it for a command it does not have. Per story rather than per module, because a docs page
 * mounts every story on it at once — the lesson `.storybook/fake/scope.ts` is written around.
 */
function Seeded({
  deckId,
  entries,
  children,
}: {
  deckId: number;
  entries: DeckAuditEntry[] | null;
  children: ReactNode;
}) {
  const client = useMemo(() => {
    const c = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    if (entries !== null) c.setQueryData(["decks", "audit", deckId], entries);
    return c;
  }, [deckId, entries]);

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const meta = {
  title: "Decks/AuditDrawer",
  component: AuditDrawer,
  tags: ["autodocs"],
  args: { deckId: 1, open: true, onDismiss: fn(), onClose: fn() },
  decorators: [
    (Story, context) => (
      <div
        // **`position: fixed` resolves against the nearest *transformed* ancestor**, not the
        // viewport — so this one line turns a window-covering drawer into a story-sized one.
        // Without it every story on the autodocs page covers the whole page, and the reader
        // sees one drawer where there are six.
        style={{ transform: "translateZ(0)" }}
        className="relative h-[38rem] overflow-hidden rounded-lg border border-border bg-bg"
      >
        <p className="p-4 text-sm text-dim">The deck editor sits behind the drawer.</p>
        <Seeded
          deckId={context.args.deckId}
          entries={(context.parameters.audit as DeckAuditEntry[] | null | undefined) ?? null}
        >
          <Story />
        </Seeded>
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "Everything that has happened to one deck, as a drawer over the editor.\n\n" +
          "**It renders history and derives none of it.** The day grouping is `auditDays`' and " +
          "every sentence is `auditSentence`'s, both from `auditText.ts` — there is exactly one " +
          "of each in this app, because a log meant to survive being useful cannot have its " +
          "wording baked into its rows, and a second day-grouping is a second chance to file a " +
          "23:30 edit under tomorrow.\n\n" +
          "**Nine kinds map onto five chips**, and `quantity` is routed by its own `delta` " +
          "rather than given a sixth: a copy count going down is a removal to everyone except " +
          "the schema. A kind this build has never heard of — which a database that outlives " +
          "the app that wrote it will hold — lands in a sixth chip that exists only when such a " +
          "row does. See `AnOlderBuild`.\n\n" +
          "**The rail carries the hue and the glyph carries the meaning.** The visual direction " +
          "colours both; `--color-pie-g` on `--color-bg` measures 3.26:1, which passes WCAG " +
          "1.4.11 for a 3px bar and fails 1.4.3 for a 12px character. So the glyphs are drawn " +
          "in text colour and nothing on this surface depends on hue.\n\n" +
          "**These stories seed a `QueryClient` rather than the fake backend.** " +
          "`.storybook/fake/db.ts` has no `deck_audit_list` handler yet (Task 19 gives it one), " +
          "and a story file may not reach into the fake to write itself one. Everything above " +
          "the transport is real: the hook, the `ipc` mirror's types and every sentence.",
      },
    },
  },
} satisfies Meta<typeof AuditDrawer>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Three days of building a Commander deck.
 *
 * The header counts the whole history and dates its oldest row, so the line says how far back
 * the drawer can see. Each day heading carries its own roll-up, and the roll-up keeps gains and
 * losses **apart** — a day that added four and cut six is not the quiet day one netted number
 * would report it as.
 */
export const AWeekOfBuilding: Story = {
  parameters: { audit: WEEK },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("dialog", { name: "Deck history" })).toBeInTheDocument();
    await expect(canvas.getByRole("heading", { name: "Today" })).toBeInTheDocument();
    await expect(canvas.getByRole("heading", { name: "Yesterday" })).toBeInTheDocument();

    // Yesterday drew four more lands in and cut a creature: two numbers, not one.
    const yesterday = canvas.getByRole("heading", { name: "Yesterday" }).closest("section");
    await expect(within(yesterday!).getByText("+4 / −1")).toBeInTheDocument();
    // The drawn figure reads as "plus four slash minus one"; the spoken one is a sentence,
    // and it is the only number in the drawer no row's own sentence already carries.
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
 * The chips stay above the list rather than inside it, so a filter that empties the list is
 * still on screen to be undone — and the count beside them says how much of the history is
 * being looked at, which is the difference between a filtered drawer and a short one.
 */
export const FilteredToTheStructure: Story = {
  parameters: { audit: WEEK },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Adds" }));
    await userEvent.click(canvas.getByRole("button", { name: "Removals" }));

    await expect(canvas.getByText("8 of 13 shown")).toBeInTheDocument();
    await expect(canvas.queryByText("Removed Consecrated Sphinx")).toBeNull();
    await expect(canvas.getByText("Renamed category Value to Draw")).toBeInTheDocument();
    // A day whose remaining rows moved no copies says so, rather than drawing a bare `+0`.
    await expect(canvas.getAllByText("no copies").length).toBeGreaterThan(0);
  },
};

/**
 * Rows written by a build that knew more than this one.
 *
 * A `kind` this app has never met and a payload it cannot parse, side by side. `auditText.ts`
 * is total over both — the unknown kind degrades to "Changed the deck" and the broken payload
 * to the shortest honest sentence — and the drawer's job is not to undo that: the row keeps its
 * date, its delta and its place in the day, and it gets a chip of its own so a reader can still
 * see it and still switch it off. **A row that matched no chip and quietly vanished would be a
 * log with a hole in it**, which is the one thing a log may not have.
 */
export const AnOlderBuild: Story = {
  parameters: {
    audit: [
      row("teleported" as DeckAuditKind, stamp(0, 16, 40), '{"whither":"the shadow realm"}', {
        delta: 3,
      }),
      row("category", stamp(0, 16, 12), "{oh dear"),
      card("add", stamp(0, 15, 55), "mh2", "138", '{"category":"Creature","quantity":1}', 1),
    ] satisfies DeckAuditEntry[],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const other = canvas.getByRole("button", {
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
 * A deck nothing has happened to yet.
 *
 * An empty screen is an invitation to act, not a blank column: it names the kinds of thing that
 * will list here and says the next one will be the first line. The header drops its count with
 * it — "0 changes since" is a sentence about nothing.
 */
export const NothingYet: Story = {
  parameters: { audit: [] satisfies DeckAuditEntry[] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("No changes recorded yet.")).toBeInTheDocument();
    await expect(canvas.queryByText(/changes since/)).toBeNull();
  },
};

/**
 * A read the app could not make — **the one story on this page with no seeded answer**, which
 * is what makes it honest: the query really runs, really reaches `.storybook/fake/core.ts`, and
 * is really refused, because the fake has no `deck_audit_list` handler until Task 19 writes
 * one. The message on screen is therefore the fake's own.
 *
 * The failure is reported **before** the emptiness, and that ordering is the whole point: a
 * failed read has no rows either, and calling it "no changes recorded yet" would tell a reader
 * their history is gone.
 */
export const HistoryUnavailable: Story = {
  parameters: { audit: null },
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
 * `open: false` renders `null` rather than a hidden panel — there is no drawer off-screen to
 * tab into, and nothing is read for it either: the editor keeps this component mounted, and a
 * closed drawer that asked anyway would spend a query on every deck the reader opens to look
 * at.
 */
export const Closed: Story = {
  args: { open: false },
  parameters: { audit: WEEK },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole("dialog")).toBeNull();
  },
};
