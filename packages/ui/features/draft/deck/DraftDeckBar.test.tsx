import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "@/lib/store";
import { useNotifications } from "@/lib/notifications";

const draftBasicLands = vi.hoisted(() => vi.fn());
const draftDeckKeep = vi.hoisted(() => vi.fn());
const draftDeckDiscard = vi.hoisted(() => vi.fn());
const draftDeckIds = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { draftBasicLands, draftDeckKeep, draftDeckDiscard, draftDeckIds },
}));

import { BASICS_SHIFT_COPIES, DraftDeckBar } from "./DraftDeckBar";
import { openDraftDeck } from "../navigation";
import { DRAFT_DECKS_KEY } from "../useDraftDecks";

const BASICS = [
  { color: "W", name: "Plains", cardId: "plains-fdn" },
  { color: "U", name: "Island", cardId: "island-fdn" },
  { color: "B", name: "Swamp", cardId: "swamp-fdn" },
  { color: "R", name: "Mountain", cardId: "mountain-fdn" },
];

function draw(props: Partial<Parameters<typeof DraftDeckBar>[0]> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData([...DRAFT_DECKS_KEY], [7]);
  const onAddBasic = vi.fn();
  const onExport = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <DraftDeckBar
        deckId={7}
        name="Quick Draft"
        setCodes={["fdn", "dsk"]}
        onAddBasic={onAddBasic}
        onExport={onExport}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { client, onAddBasic, onExport };
}

beforeEach(() => {
  draftBasicLands.mockReset().mockResolvedValue(BASICS);
  draftDeckKeep.mockReset().mockResolvedValue(undefined);
  draftDeckDiscard.mockReset().mockResolvedValue(undefined);
  draftDeckIds.mockReset().mockResolvedValue([]);
  useNotifications.setState({ notices: [], toasts: [] });
  openDraftDeck(7);
});

describe("DraftDeckBar", () => {
  it("says the deck is a draft deck and why the searches are gone", () => {
    draw();
    expect(screen.getByRole("region", { name: "Draft deck" })).toHaveTextContent(
      "Draft deck — build from your Pool; the collection and card search are off.",
    );
  });

  it("asks for the basics in the draft's own sets", async () => {
    draw();
    await screen.findByRole("button", { name: "Add Plains" });
    expect(draftBasicLands).toHaveBeenCalledWith(["fdn", "dsk"]);
  });

  it("adds one basic on a press and five on a Shift-press, through the editor's add", async () => {
    const user = userEvent.setup();
    const { onAddBasic } = draw();

    await user.click(await screen.findByRole("button", { name: "Add Island" }));
    expect(onAddBasic).toHaveBeenLastCalledWith("island-fdn", 1);

    await user.keyboard("{Shift>}");
    await user.click(screen.getByRole("button", { name: "Add Mountain" }));
    await user.keyboard("{/Shift}");
    expect(onAddBasic).toHaveBeenLastCalledWith("mountain-fdn", BASICS_SHIFT_COPIES);
    // A basics press is a stepper's kind of write: no toast.
    expect(useNotifications.getState().toasts).toEqual([]);
  });

  it("greys a colour the corpus has no basic for, and its press adds nothing", async () => {
    const user = userEvent.setup();
    const { onAddBasic } = draw();
    await screen.findByRole("button", { name: "Add Plains" });

    const forest = screen.getByRole("button", { name: "No Green basic land" });
    expect(forest).toHaveAttribute("aria-disabled", "true");
    await user.click(forest);
    expect(onAddBasic).not.toHaveBeenCalled();
  });

  it("saves the deck and says so", async () => {
    const user = userEvent.setup();
    draw();

    await user.click(screen.getByRole("button", { name: "Save deck" }));

    await waitFor(() => expect(draftDeckKeep).toHaveBeenCalledWith(7));
    await waitFor(() =>
      expect(useNotifications.getState().notices[0]).toMatchObject({
        tone: "success",
        title: "Saved “Quick Draft” to your decks",
      }),
    );
  });

  it("says a refused save as an error", async () => {
    draftDeckKeep.mockRejectedValue("The database is busy");
    const user = userEvent.setup();
    draw();

    await user.click(screen.getByRole("button", { name: "Save deck" }));

    await waitFor(() =>
      expect(useNotifications.getState().notices[0]).toMatchObject({
        tone: "error",
        body: "The database is busy",
      }),
    );
  });

  it("hands Export to the editor's dialog, with the button to come back to", async () => {
    const user = userEvent.setup();
    const { onExport } = draw();

    const exportButton = screen.getByRole("button", { name: "Export" });
    await user.click(exportButton);
    expect(onExport).toHaveBeenCalledWith(exportButton);
  });

  it("asks before it discards, and Keep it changes nothing", async () => {
    const user = userEvent.setup();
    draw();

    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.getByRole("group", { name: "Discard Quick Draft" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Keep it" }));

    expect(screen.queryByRole("group", { name: "Discard Quick Draft" })).not.toBeInTheDocument();
    expect(draftDeckDiscard).not.toHaveBeenCalled();
    expect(useAppStore.getState().activeView).toBe("decks");
  });

  it("discards the deck, says so, and goes back to the Draft page with no deck parked", async () => {
    const user = userEvent.setup();
    draw();

    await user.click(screen.getByRole("button", { name: "Discard" }));
    await user.click(screen.getByRole("button", { name: "Discard deck" }));

    await waitFor(() => expect(draftDeckDiscard).toHaveBeenCalledWith(7));
    await waitFor(() => expect(useAppStore.getState().activeView).toBe("draft"));
    expect(useAppStore.getState().openDeckId).toBeNull();
    // Closed before the view changed, so coming back to Decks opens the gallery, not a gone deck.
    expect(useAppStore.getState().parkedDeckId).toBeNull();
    expect(useNotifications.getState().notices[0]).toMatchObject({
      tone: "info",
      title: "Discarded “Quick Draft”",
    });
  });
});
