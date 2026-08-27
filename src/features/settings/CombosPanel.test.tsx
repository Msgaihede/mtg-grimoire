import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComboProgress, ComboStatus } from "@/lib/ipc";

const combosStatus = vi.hoisted(() => vi.fn());
const combosRefresh = vi.hoisted(() => vi.fn());
const onCombosProgress = vi.hoisted(() => vi.fn());
const unlisten = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { combosStatus, combosRefresh, onCombosProgress },
}));

import {
  COMBOS_STATUS_KEY,
  COMBO_PHASE_LABEL,
  CombosPanel,
  comboNote,
  comboState,
  stampText,
} from "./CombosPanel";

/** A fixed instant every "2 hours ago" below is read against, so the sentences are facts
 *  rather than a race against the clock. */
const NOW = Math.floor(Date.now() / 1000);

/**
 * A database that holds Spellbook's list.
 *
 * The stamp is the shape the live file publishes — measured 2026-08-27, when the `timestamp`
 * read `2026-08-27T03:12:44Z` twenty minutes after the file was built.
 *
 * **`checkedAt` is deliberately newer than `fetchedAt`**, which is the ordinary state of a feed
 * that answered `304`: we asked an hour ago and the rows have not changed for two. Equal stamps
 * would let a panel that read one field twice pass the test this fixture exists for.
 *
 * **`cards` counts card *slots*** — one `combo_cards` row per card per combo — so it is larger
 * than `combos` rather than a count of the corpus.
 */
const INGESTED: ComboStatus = {
  combos: 105_478,
  cards: 7_310,
  stamp: "2026-08-27T03:12:44Z",
  fetchedAt: NOW - 7_200,
  checkedAt: NOW - 3_600,
  stale: false,
};

/** A fresh install. `fetchedAt` is `null` and the counts are `0` — and the panel must read the
 *  first of those and not the second, since a file that ingested and matched nothing is not a
 *  file nobody has fetched. */
const NEVER: ComboStatus = {
  combos: 0,
  cards: 0,
  stamp: null,
  fetchedAt: null,
  checkedAt: NOW - 60,
  stale: true,
};

/** Ingested a fortnight ago, which is past the weekly interval. */
const STALE: ComboStatus = { ...INGESTED, stale: true, fetchedAt: NOW - 14 * 86_400 };

/**
 * One world, as a wrapper.
 *
 * The status is **seeded into the client** rather than stubbed onto the mock, which is what
 * lets several worlds stand side by side in one file: a mock is one function every test here
 * shares, where a client belongs to the tree it was rendered in. `BackupPanel.test.tsx`'s
 * harness, for its reasons — including `staleTime: Infinity`, which stops the seeded answer
 * being refetched out from under the first assertion.
 */
function harness(status: ComboStatus | null) {
  return function Harness({ children }: { children: ReactNode }) {
    const [client] = useState(() => {
      const c = new QueryClient({
        defaultOptions: {
          queries: { retry: false, staleTime: Infinity },
          mutations: { retry: false },
        },
      });
      if (status !== null) c.setQueryData(COMBOS_STATUS_KEY, status);
      return c;
    });
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

/**
 * The seed and the command, pointed at the same row.
 *
 * Both halves are needed and the second is the one that is easy to forget: a refresh
 * invalidates the status key whether it worked or not, so a world that seeded the cache alone
 * would answer the *next* read out of the mock's default and quietly change state under the
 * assertion. It cost this file two red tests before it existed.
 */
function world(status: ComboStatus | null) {
  combosStatus.mockResolvedValue(status ?? INGESTED);
  return harness(status);
}

const panel = () => screen.getByRole("region", { name: "Combos" });
const refreshButton = () => within(panel()).getByRole("button", { name: "Refresh combos" });
const downloadButton = () => within(panel()).getByRole("button", { name: "Download combos" });

/** Pushes one `combos:progress` event through the listener the panel registered. */
let emit: (event: ComboProgress) => void;

/** The listener is registered asynchronously; nothing can be emitted before it lands. */
const listening = () => vi.waitFor(() => expect(onCombosProgress).toHaveBeenCalled());

beforeEach(() => {
  unlisten.mockClear();
  combosStatus.mockReset().mockResolvedValue(INGESTED);
  combosRefresh.mockReset().mockResolvedValue(INGESTED);
  onCombosProgress.mockReset().mockImplementation((cb: (e: ComboProgress) => void) => {
    emit = (event) => act(() => cb(event));
    return Promise.resolve(unlisten);
  });
});

describe("CombosPanel", () => {
  /**
   * **The state a fresh install is in, and the one sentence it must not read as.** A database
   * that has never fetched this file is supported — the bracket estimate reads three signals
   * instead of four — so the copy has to explain what happens meanwhile rather than report a
   * fault, and it must not print the zeroes as figures.
   */
  it("says nothing has been downloaded, without calling it a failure", () => {
    render(<CombosPanel />, { wrapper: world(NEVER) });

    expect(within(panel()).getByText(/Nothing downloaded yet/)).toHaveTextContent(
      /reads the other three signals — which is a supported state rather than a fault/,
    );
    // Not the zeroes: "0 combos over 0 cards" would be a figure where there is no answer.
    expect(within(panel()).queryByText(/0 combos/)).not.toBeInTheDocument();
    // And the control offers the thing there is to do, rather than a refresh of nothing.
    expect(downloadButton()).toBeInTheDocument();
    expect(within(panel()).queryByRole("button", { name: "Refresh combos" })).not.toBeInTheDocument();
  });

  /**
   * **What is held, over how many cards, and the three dates that are three different facts.**
   *
   * `stamp` says *which* list this is — Spellbook rebuilds the file continuously. `fetchedAt`
   * says when these rows last changed. `checkedAt` says when we last asked, which a `304`
   * moves and the other two do not. A panel that collapsed them would lose the one thing a
   * reader comes here to settle.
   */
  it("says how many combos it holds, how old they are, and when it last asked", () => {
    render(<CombosPanel />, { wrapper: world(INGESTED) });

    expect(within(panel()).getByText("105,478 combos, naming 7,310 cards between them")).toBeInTheDocument();
    expect(within(panel()).getByText(/Spellbook stamped this list 2026-08-27 03:12 UTC/)).toBeInTheDocument();
    // Two different fields, and the fixture makes them two different answers on purpose: a
    // panel reading one of them twice would print the same relative time on both lines.
    expect(within(panel()).getByText(/Last checked 1 hour ago/)).toBeInTheDocument();
    expect(within(panel()).getByText(/Downloaded 2 hours ago\./)).toBeInTheDocument();
  });

  /**
   * **The week, said out loud.** The file rotates continuously and this app's interval is seven
   * days, so a list a week behind Spellbook's is the schedule working rather than a stale
   * download — and without this line the gap between the stamp and today reads as neglect.
   */
  it("explains that a list up to a week behind is the schedule rather than a fault", () => {
    render(<CombosPanel />, { wrapper: world(INGESTED) });

    expect(within(panel()).getByText(/rebuilds this file continuously/)).toHaveTextContent(
      /up to seven days behind .* is the schedule working rather than a stale download/,
    );
  });

  /** Past the interval, which is the one thing `stale` adds to an otherwise ordinary row. */
  it("says a refresh is due once the list is past the weekly interval", () => {
    render(<CombosPanel />, { wrapper: world(STALE) });

    expect(within(panel()).getByText(/A refresh is due\./)).toBeInTheDocument();
  });

  it("reads the status from the backend when nothing is cached", async () => {
    render(<CombosPanel />, { wrapper: world(null) });

    expect(within(panel()).getByText(/Reading the combo database…/)).toBeInTheDocument();
    expect(await within(panel()).findByText("105,478 combos, naming 7,310 cards between them")).toBeInTheDocument();
    expect(combosStatus).toHaveBeenCalled();
  });

  /**
   * **`force: true`, and the argument is the interval.** A refresh that honoured a weekly
   * throttle would do nothing at all for six days in seven, which is indistinguishable from a
   * dead button. It costs one request and a `304` when the file has not moved.
   */
  it("forces the refresh past the weekly interval", async () => {
    render(<CombosPanel />, { wrapper: world(INGESTED) });

    await userEvent.click(refreshButton());

    expect(combosRefresh).toHaveBeenCalledExactlyOnceWith(true);
  });

  /** The same command from the never-fetched state, where the control has a different name. */
  it("fetches from the never-downloaded state too", async () => {
    render(<CombosPanel />, { wrapper: world(NEVER) });

    await userEvent.click(downloadButton());

    expect(combosRefresh).toHaveBeenCalledExactlyOnceWith(true);
  });

  /**
   * **The progress line moves with the event**, phase by phase, and the fraction is a
   * percentage rather than a unit: `done`/`total` count bytes while the file comes down and
   * variants while it is read in, so one line printing "MB" would be wrong for half a refresh.
   */
  it("draws the phase and the percentage off the progress event", async () => {
    render(<CombosPanel />, { wrapper: world(INGESTED) });
    await listening();

    emit({ phase: "checking", done: 0, total: 0 });
    expect(
      within(panel()).getByRole("progressbar", { name: COMBO_PHASE_LABEL.checking }),
    ).not.toHaveAttribute("aria-valuenow");

    emit({ phase: "downloading", done: 13_771_157, total: 27_542_314 });
    const bar = within(panel()).getByRole("progressbar", { name: COMBO_PHASE_LABEL.downloading });
    expect(bar).toHaveAttribute("aria-valuenow", "50");
    expect(within(panel()).getByText(COMBO_PHASE_LABEL.downloading)).toBeInTheDocument();
    expect(within(panel()).getByText("50%")).toBeInTheDocument();

    emit({ phase: "ingesting", done: 84_382, total: 105_478 });
    expect(within(panel()).getByText(COMBO_PHASE_LABEL.ingesting)).toBeInTheDocument();
    expect(within(panel()).getByText("80%")).toBeInTheDocument();

    // Terminal: the line goes, because the refresh is over and the figures above say the rest.
    emit({ phase: "done", done: 105_478, total: 105_478 });
    expect(within(panel()).queryByRole("progressbar")).not.toBeInTheDocument();
  });

  /** The census `useSyncProgress.test.ts` keeps for the sync's eight: a phase Rust emits that
   *  has no label here renders `undefined` while the refresh runs perfectly. */
  it("labels every phase the backend can emit", () => {
    expect(Object.keys(COMBO_PHASE_LABEL)).toEqual([
      "checking",
      "downloading",
      "ingesting",
      "done",
      "error",
    ]);
    expect(Object.values(COMBO_PHASE_LABEL).every((label) => label.length > 0)).toBe(true);
  });

  /** A refresh in flight has nothing for a second press to do, and the button says so — with
   *  the attribute rather than `aria-disabled`, which is `controls.ts`'s rule for this family. */
  it("puts the button out of reach while a refresh is running", async () => {
    render(<CombosPanel />, { wrapper: world(INGESTED) });
    await listening();

    emit({ phase: "downloading", done: 1, total: 2 });

    expect(refreshButton()).toBeDisabled();
    expect(refreshButton()).toHaveAttribute("aria-busy", "true");
  });

  /**
   * **A failure keeps the rows**, which is the ingest's whole contract — staging tables swapped
   * in one transaction, so a fetch that fell over changed nothing. The figures stay on screen,
   * the sentence says they are the ones from before, and the reason goes to the panel that
   * collects reasons.
   */
  it("keeps the ingested figures on screen when a refresh fails", async () => {
    combosRefresh.mockRejectedValue(new Error("Commander Spellbook timed out after 30s."));
    render(<CombosPanel />, { wrapper: world(INGESTED) });

    await userEvent.click(refreshButton());

    await waitFor(() => {
      expect(within(panel()).getByText(/The last refresh failed/)).toBeInTheDocument();
    });
    // Still there, still counted — the assertion this test exists for.
    expect(within(panel()).getByText("105,478 combos, naming 7,310 cards between them")).toBeInTheDocument();
    expect(within(panel()).getByText(/The combos from 2 hours ago are still here/)).toHaveTextContent(
      /Errors, further down this page, has the details/,
    );
    expect(within(panel()).getByRole("alert")).toHaveTextContent("timed out after 30s");
  });

  /** The other failure: nothing was there to keep, so the sentence must not promise any. */
  it("says a failed first download left no combos", async () => {
    combosRefresh.mockRejectedValue(new Error("no internet connection"));
    render(<CombosPanel />, { wrapper: world(NEVER) });

    await userEvent.click(downloadButton());

    await waitFor(() => {
      expect(
        within(panel()).getByText(/The download failed, so there are still no combos/),
      ).toBeInTheDocument();
    });
    expect(within(panel()).queryByText(/still here and still counted/)).not.toBeInTheDocument();
  });

  /** A failure nobody in this window started — a startup pass, or the deck editor's advisory
   *  triggering one. There is no message on a progress event, so the panel reports the state
   *  and points at the log rather than inventing a reason. */
  it("reports a failure that arrived on the event channel, with no invented reason", async () => {
    render(<CombosPanel />, { wrapper: world(INGESTED) });
    await listening();

    emit({ phase: "error", done: 0, total: 0 });

    expect(within(panel()).getByText(/The last refresh failed/)).toBeInTheDocument();
    expect(within(panel()).queryByRole("alert")).not.toBeInTheDocument();
  });

  /** The listener leaves with the panel — otherwise it outlives it for the app's lifetime. */
  it("drops its subscription on unmount", async () => {
    const { unmount } = render(<CombosPanel />, { wrapper: world(INGESTED) });
    await listening();

    unmount();

    await waitFor(() => expect(unlisten).toHaveBeenCalled());
  });
});

/**
 * The ordering is the whole content of {@link comboState}, so it is asserted directly rather
 * than through six renders.
 */
describe("comboState", () => {
  it("ranks a refresh in flight above everything else", () => {
    expect(comboState(STALE, true, true)).toBe("refreshing");
  });

  it("ranks a failure above the rows it left standing", () => {
    expect(comboState(INGESTED, false, true)).toBe("failed");
    // Including over "never", because "we tried and it did not work" is a different sentence.
    expect(comboState(NEVER, false, true)).toBe("failed");
  });

  it("tells an unanswered read from a database that has never fetched", () => {
    expect(comboState(null, false, false)).toBe("unknown");
    expect(comboState(NEVER, false, false)).toBe("never");
  });

  it("reads staleness off the backend's own flag", () => {
    expect(comboState(INGESTED, false, false)).toBe("fresh");
    expect(comboState(STALE, false, false)).toBe("stale");
  });

  /** `fetchedAt` and not the counts: a file that ingested and matched nothing is not a file
   *  nobody has fetched, and only the second is a state a first press acts on. */
  it("reads never off fetchedAt rather than off the counts", () => {
    expect(comboState({ ...INGESTED, combos: 0, cards: 0 }, false, false)).toBe("fresh");
  });
});

describe("comboNote", () => {
  it("says nothing while a read or a refresh is in flight", () => {
    expect(comboNote("unknown", null, NOW)).toBeNull();
    expect(comboNote("refreshing", INGESTED, NOW)).toBeNull();
  });

  it("dates the rows it has", () => {
    expect(comboNote("fresh", INGESTED, NOW)).toBe("Downloaded 2 hours ago.");
    expect(comboNote("stale", STALE, NOW)).toBe("Downloaded 14 days ago. A refresh is due.");
  });
});

describe("stampText", () => {
  /** The shape the live feed publishes, measured 2026-08-27. */
  it("writes the feed's own ISO stamp in the app's date shape", () => {
    expect(stampText("2026-08-27T03:12:44Z")).toBe("2026-08-27 03:12 UTC");
    expect(stampText("2026-08-27T03:12:44.512Z")).toBe("2026-08-27 03:12 UTC");
  });

  /**
   * **The `Z` is what makes `UTC` true**, so a stamp carrying an offset is printed as it
   * arrived rather than relabelled into a lie.
   */
  it("prints anything else exactly as it came", () => {
    expect(stampText("2026-08-27T03:12:44+02:00")).toBe("2026-08-27T03:12:44+02:00");
    expect(stampText("version 1.2.3")).toBe("version 1.2.3");
  });

  it("has nothing to say about a feed that published no stamp", () => {
    expect(stampText(null)).toBeNull();
    expect(stampText("   ")).toBeNull();
  });
});
