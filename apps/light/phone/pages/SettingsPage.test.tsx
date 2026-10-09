import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@grimoire/fake/core"));
vi.mock("@tauri-apps/api/event", () => import("@grimoire/fake/event"));
vi.mock("@tauri-apps/api/window", () => import("@grimoire/fake/window"));

import { registerCommands } from "@grimoire/fake/core";
import type { ErrorEntry } from "@grimoire/ui/lib/ipc";
import { PhoneFace } from "../PhoneApp";
import { renderPhone } from "../testing";

/** Long enough for a fake round trip. */
const SETTLE = { timeout: 3000 };

const list = () => screen.getByRole("list", { name: "Settings sections" });
const group = (name: string) => within(list()).getByRole("button", { name });

describe("Settings on the phone", () => {
  it("lists the light edition's groups, each closed", () => {
    renderPhone(<PhoneFace />, { path: "/settings" });
    const rows = within(list()).getAllByRole("button");
    expect(rows.map((row) => row.textContent)).toEqual([
      "Card data",
      "Sync",
      "Tags",
      "Appearance",
      "Storage and data",
      "Errors",
    ]);
    for (const row of rows) expect(row).toHaveAttribute("aria-expanded", "false");
    // Nothing the light edition leaves out, and no placeholder sentence where the page was.
    expect(screen.queryByRole("button", { name: "Updates" })).toBeNull();
    expect(screen.queryByText(/arrive in a later phase/)).toBeNull();
  });

  it("opens a group's panels under its row", async () => {
    renderPhone(<PhoneFace />, { path: "/settings" });
    await userEvent.click(group("Storage and data"));

    expect(group("Storage and data")).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByRole("region", { name: "Local cache" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Clear data" })).toBeInTheDocument();
    // The desktop's other two panels in this group are not the light edition's.
    expect(screen.queryByRole("region", { name: "Backup" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Data folder" })).toBeNull();
  });

  it("keeps one group open at a time, and closes it on a second press", async () => {
    renderPhone(<PhoneFace />, { path: "/settings" });
    await userEvent.click(group("Appearance"));
    expect(await screen.findByRole("region", { name: "Theory marks" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Labels" })).toBeInTheDocument();

    await userEvent.click(group("Card data"));
    expect(await screen.findByRole("region", { name: "Prices" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Theory marks" })).toBeNull();
    expect(group("Appearance")).toHaveAttribute("aria-expanded", "false");

    await userEvent.click(group("Card data"));
    expect(screen.queryByRole("region", { name: "Prices" })).toBeNull();
  });

  it("links to the privacy policy under the last group", async () => {
    renderPhone(<PhoneFace />, { path: "/settings" });
    const link = await screen.findByRole("link", { name: "Privacy policy" });
    expect(link).toHaveAttribute("href", "https://mtg-grimoire.app/privacy");
    const list = screen.getByRole("list", { name: "Settings sections" });
    expect(list.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("draws the sync panel and the review queue over whatever the core answers", async () => {
    renderPhone(<PhoneFace />, { path: "/settings" });
    await userEvent.click(group("Sync"));
    expect(await screen.findByRole("region", { name: "Sync" }, SETTLE)).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Needs review" })).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: /Connect Patreon/ }, SETTLE),
    ).toBeInTheDocument();
  });

  it("counts what is waiting on the row, as the desktop rail does", async () => {
    // From a page that asks nothing of the log, so the answer is in place before Settings asks.
    renderPhone(<PhoneFace />, { path: "/scanner" });
    const entry: ErrorEntry = {
      id: 1,
      firstAt: 1_700_000_000,
      lastAt: 1_700_000_000,
      source: "scryfall_image",
      operation: "fetch",
      kind: "timeout",
      message: "timed out",
      detail: null,
      count: 1,
    };
    registerCommands({ error_log_list: () => [entry] });

    await userEvent.click(screen.getByRole("link", { name: "Settings" }));
    expect(
      await within(list()).findByRole("button", { name: "Errors (1)" }, SETTLE),
    ).toBeInTheDocument();
  });
});
