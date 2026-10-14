import { useState } from "react";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@grimoire/fake/core"));
vi.mock("@tauri-apps/api/event", () => import("@grimoire/fake/event"));
vi.mock("@tauri-apps/api/window", () => import("@grimoire/fake/window"));

import type { CommandTable } from "@grimoire/fake/scope";
import type { FakeParams } from "@grimoire/fake/world";
import { EMPTY_HISTORY } from "@grimoire/ui/features/scanner/history/historyWords";
import { useNotifications } from "@grimoire/ui/lib/notifications";
import { renderPhone } from "../testing";
import { HistorySheet } from "./HistorySheet";

const SETTLE = { timeout: 5_000 };

/** The sheet over a world, open, with a press that opened it — for the caret to come back to. */
function Harness() {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open history
      </button>
      <HistorySheet open={open} onClose={() => setOpen(false)} onDismiss={() => setOpen(false)} />
    </>
  );
}

function mount(
  fake: FakeParams = { seed: "scanHistory" },
  commands?: (own: CommandTable) => CommandTable,
) {
  renderPhone(<Harness />, { fake, commands });
}

const sheet = () => screen.getByRole("dialog", { name: "Scan history" });

/** Drill into a batch by its name, and hand back its section. */
async function openBatch(name: string): Promise<HTMLElement> {
  await userEvent.click(
    await within(sheet()).findByRole("button", { name: new RegExp(`^${name}`) }, SETTLE),
  );
  return await within(sheet()).findByRole("region", { name }, SETTLE);
}

describe("the phone's scan history", () => {
  it("lists every batch newest first, with when, how many and where it went", async () => {
    mount();
    const list = await within(sheet()).findByRole("list", { name: "Scans" }, SETTLE);
    const entries = within(list).getAllByRole("button");
    expect(entries.map((e) => e.querySelector(".font-medium")?.textContent)).toEqual([
      "Bob's binder",
      "Scan 2",
      "Scan 1",
    ]);
    expect(entries[0]).toHaveTextContent("4 cards");
    expect(entries[0]).toHaveTextContent("Archived");
    expect(entries[1]).toHaveTextContent("Added to “Binder”");
    expect(entries[2]).toHaveTextContent("Added to collection");
  });

  it("says how a pile gets here when there is none", async () => {
    mount({ seed: "starter" });
    expect(await within(sheet()).findByText(EMPTY_HISTORY, {}, SETTLE)).toBeInTheDocument();
  });

  it("drills into a batch to read its cards, and goes back to the list", async () => {
    mount();
    const batch = await openBatch("Scan 1");
    expect(within(batch).getByText("5 cards · 2 printings")).toBeInTheDocument();
    const cards = within(within(batch).getByRole("list", { name: "Cards in Scan 1" })).getAllByRole(
      "listitem",
    );
    expect(cards).toHaveLength(2);
    expect(cards[0]).toHaveTextContent("MH2 259");
    expect(cards[0]).toHaveTextContent("×4");

    await userEvent.click(within(sheet()).getByRole("button", { name: "Scan history" }));
    expect(await within(sheet()).findByRole("list", { name: "Scans" }, SETTLE)).toBeInTheDocument();
  });

  it("renames a batch on a page of its own, and a blank name puts the default back", async () => {
    mount();
    let batch = await openBatch("Scan 2");
    await userEvent.click(within(batch).getByRole("button", { name: "Rename" }));
    const box = await within(sheet()).findByRole("textbox", { name: "Name" });
    await userEvent.clear(box);
    await userEvent.type(box, "Binder pulls");
    await userEvent.click(within(sheet()).getByRole("button", { name: "Rename scan" }));
    batch = await within(sheet()).findByRole("region", { name: "Binder pulls" }, SETTLE);

    await userEvent.click(within(batch).getByRole("button", { name: "Rename" }));
    const again = await within(sheet()).findByRole("textbox", { name: "Name" });
    expect(again).toHaveAttribute("placeholder", "Scan 2");
    await userEvent.clear(again);
    await userEvent.click(within(sheet()).getByRole("button", { name: "Rename scan" }));
    expect(
      await within(sheet()).findByRole("region", { name: "Scan 2" }, SETTLE),
    ).toBeInTheDocument();
  });

  it("says a refused rename under the box, and stays on the page", async () => {
    mount(undefined, () => ({
      scan_history_rename: () => {
        throw new Error("The database is busy.");
      },
    }));
    const batch = await openBatch("Scan 1");
    await userEvent.click(within(batch).getByRole("button", { name: "Rename" }));
    await userEvent.type(await within(sheet()).findByRole("textbox", { name: "Name" }), "!");
    await userEvent.click(within(sheet()).getByRole("button", { name: "Rename scan" }));
    expect(await within(sheet()).findByRole("alert", {}, SETTLE)).toHaveTextContent(
      "Couldn't rename the scan — The database is busy.",
    );
    expect(within(sheet()).getByRole("textbox", { name: "Name" })).toBeInTheDocument();
  });

  it("asks before deleting, says the collection is not touched, and toasts the delete", async () => {
    mount();
    const batch = await openBatch("Scan 1");
    await userEvent.click(within(batch).getByRole("button", { name: "Delete…" }));
    expect(
      await within(sheet()).findByText(
        "“Scan 1” will be removed from your scan history. The cards it added stay in your collection.",
      ),
    ).toBeInTheDocument();

    // Cancel goes back to the batch, and deletes nothing.
    await userEvent.click(within(sheet()).getByRole("button", { name: "Cancel" }));
    await userEvent.click(
      within(await within(sheet()).findByRole("region", { name: "Scan 1" })).getByRole("button", {
        name: "Delete…",
      }),
    );
    await userEvent.click(await within(sheet()).findByRole("button", { name: "Delete scan" }));

    const list = await within(sheet()).findByRole("list", { name: "Scans" }, SETTLE);
    await waitFor(() => expect(within(list).getAllByRole("button")).toHaveLength(2), SETTLE);
    expect(within(list).queryByRole("button", { name: /^Scan 1/ })).toBeNull();
    await waitFor(
      () =>
        expect(useNotifications.getState().notices[0]).toMatchObject({
          title: "Deleted “Scan 1” from scan history",
          tone: "success",
        }),
      SETTLE,
    );
  });

  it("says an archived batch never touched the collection", async () => {
    mount();
    const batch = await openBatch("Bob's binder");
    await userEvent.click(within(batch).getByRole("button", { name: "Delete…" }));
    expect(
      await within(sheet()).findByText(
        "“Bob's binder” will be removed from your scan history. Your collection is not affected.",
      ),
    ).toBeInTheDocument();
  });

  it("starts on the list again after a close", async () => {
    mount();
    await openBatch("Scan 1");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), SETTLE);
    await userEvent.click(screen.getByRole("button", { name: "Open history" }));
    expect(await within(sheet()).findByRole("list", { name: "Scans" }, SETTLE)).toBeInTheDocument();
  });
});
