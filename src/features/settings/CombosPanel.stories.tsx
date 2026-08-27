import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { emitFake } from "../../../.storybook/fake/event";
import { COMBO_PHASE_LABEL, CombosPanel } from "./CombosPanel";

const meta = {
  title: "Settings/CombosPanel",
  component: CombosPanel,
  tags: ["autodocs"],
  decorators: [
    // The settings column's own width — `max-w-2xl` inside the 1280×800 window — because the
    // layout risk here is the row at the foot, where a two-line sentence shares a line with a
    // fixed-width button.
    (Story) => (
      <div className="max-w-2xl p-2">
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "Commander Spellbook's combo list — the **fourth** signal a Commander deck's bracket " +
          "estimate reads, and the only one that is not written on a card.\n\n" +
          "Game Changers, mass land denial and extra turns are all facts about a single card, " +
          "so the app reads them off the corpus it already has. A two-card infinite is a fact " +
          "about an *interaction*: no amount of reading either card finds it, which is why it " +
          "takes a bulk download of its own — `variants.json.gz`, 27.5 MB compressed, measured " +
          "2026-08-27.\n\n" +
          "**A database that has never fetched it is a supported state and must not read as an " +
          "error.** It is what every install is on its first launch and what a machine with no " +
          "route to Spellbook stays in; the estimate reads three signals instead of four and " +
          "says so where it is drawn. That is the tagger datasets' rule one feed over.\n\n" +
          "**Three dates, because they answer three questions.** `stamp` is *which* list this " +
          "is — Spellbook rebuilds the file continuously. `fetchedAt` is when these rows last " +
          "changed. `checkedAt` is when we last asked, which a `304` moves and the other two do " +
          "not. This app's refresh interval is a week, so a list seven days behind Spellbook's " +
          "is the schedule working rather than a stale download, and the panel says so.\n\n" +
          "**This panel reaches the backend itself**, so every story here is a **seeded world** " +
          "rather than an argument: Refresh really calls `combos_refresh`, and a world carrying " +
          "the `combosFetchError` fault really refuses it.",
      },
    },
  },
} satisfies Meta<typeof CombosPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The list on disk: how many combos, over how many card slots, and how old.
 *
 * The figures are Geist Mono — a count is data, the direction's third type role. **The
 * assertions are shapes rather than numbers** because the fixture's totals belong to
 * `.storybook/fake/seeds.ts` and a story that pinned them would go red the day somebody added a
 * combo to the seed.
 */
export const Ingested: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(await canvas.findByText(/combos, naming .* between them/)).toBeInTheDocument();
    // What we hold, and when we last asked — two lines, because they are two facts.
    await expect(canvas.getByText(/Spellbook stamped this list/)).toBeInTheDocument();
    await expect(canvas.getByText(/Last checked/)).toBeInTheDocument();
    // The week, said out loud: without it the gap between the stamp and today reads as neglect.
    await expect(canvas.getByText(/up to seven days behind/)).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Refresh combos" })).toBeEnabled();
  },
};

/**
 * Nothing downloaded — the state a fresh install is in, and **not** a failure.
 *
 * There is no `combosMissing` *fault* to reach for, deliberately: a never-fetched combo table is
 * not something that has gone wrong with a world, it is where every install sits until somebody
 * presses the button, because the backend will not fetch this file uninvited. So it is a seed.
 *
 * The copy has one job the other three states do not — to say what happens **meanwhile**. A
 * bracket estimate with no combo data reads its other three signals and is still an answer, and
 * a panel that only reported an absence would leave a reader believing their decks were being
 * mis-scored until they found a button.
 */
export const NeverFetched: Story = {
  parameters: { fake: { seed: "combosMissing" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(await canvas.findByText(/Nothing downloaded yet/)).toHaveTextContent(
      /supported state rather than a fault/,
    );
    // No figures at all, rather than the zeroes: "0 combos" is a number where there is no answer.
    await expect(canvas.queryByText(/combos, naming/)).not.toBeInTheDocument();
    // And the control names the thing there is to do. Nothing to *re*-fresh yet.
    await expect(canvas.getByRole("button", { name: "Download combos" })).toBeInTheDocument();
    await expect(canvas.queryByRole("button", { name: "Refresh combos" })).not.toBeInTheDocument();
  },
};

/**
 * A refresh in flight, driven by the event rather than by a press.
 *
 * `emitFake` reaches the panel because `.storybook/main.ts` aliases `@tauri-apps/api/event` to
 * the same module this file imports from, so there is one listener map. That is the honest way
 * to story this state: the backend can be fetching for reasons this window never started, and
 * the panel has to draw it either way.
 *
 * **The fraction is a percentage and never a unit.** `done`/`total` count bytes while the file
 * is coming down and variants while it is read in, so a line printing "MB" through both would be
 * wrong for half of a refresh. The numbers below are the measured ones — 27 542 314 bytes
 * compressed, 2026-08-27 — at the halfway mark.
 */
export const Refreshing: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("button", { name: "Refresh combos" });

    emitFake("combos:progress", { phase: "downloading", done: 13_771_157, total: 27_542_314 });

    await waitFor(async () => {
      await expect(
        canvas.getByRole("progressbar", { name: COMBO_PHASE_LABEL.downloading }),
      ).toHaveAttribute("aria-valuenow", "50");
    });
    await expect(canvas.getByText("50%")).toBeInTheDocument();
    // Nothing for a second press to do — `disabled`, which is `controls.ts`' rule for this
    // family of buttons and the reverse of the app's usual `aria-disabled`.
    await expect(canvas.getByRole("button", { name: "Refresh combos" })).toBeDisabled();
    // The rows are still on screen underneath: a refresh is not a deletion.
    await expect(canvas.getByText(/combos, naming .* between them/)).toBeInTheDocument();

    // The terminal phase takes the line back down; the figures above say the rest.
    emitFake("combos:progress", { phase: "done", done: 27_542_314, total: 27_542_314 });
    await waitFor(async () => {
      await expect(canvas.queryByRole("progressbar")).not.toBeInTheDocument();
    });
  },
};

/**
 * The refresh refused — **and every combo already ingested is still there**, which is what the
 * sentence has to say.
 *
 * That is the ingest's own contract rather than luck: the rows are built in staging tables and
 * swapped in one transaction, so a fetch that fell over changed nothing. A bracket estimate is
 * still reading four signals while this line is on screen, and a panel that implied otherwise
 * would send a reader looking for a fault in their decks.
 *
 * The reason goes to `Errors`, further down the same page, which is where this app collects
 * them. This panel knows *that* a refresh failed and often not *why* — a failure nobody in this
 * window started arrives as a bare `error` phase with no message on it.
 */
export const RefreshFailed: Story = {
  parameters: { fake: { fault: "combosFetchError" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const before = await canvas.findByText(/combos, naming .* between them/);
    const figures = before.textContent;

    await userEvent.click(canvas.getByRole("button", { name: "Refresh combos" }));

    await waitFor(async () => {
      await expect(canvas.getByText(/The last refresh failed/)).toHaveTextContent(
        /still here and still counted/,
      );
    });
    await expect(canvas.getByRole("alert")).toBeInTheDocument();
    // The same figures, to the character: a refusal may not cost the reader a row.
    await expect(canvas.getByText(/combos, naming .* between them/)).toHaveTextContent(
      figures ?? "",
    );
  },
};
