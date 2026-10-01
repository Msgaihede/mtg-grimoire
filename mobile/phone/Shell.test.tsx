import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("../../.storybook/fake/core"));
vi.mock("@tauri-apps/api/event", () => import("../../.storybook/fake/event"));
vi.mock("@tauri-apps/api/window", () => import("../../.storybook/fake/window"));

import { PhoneFace } from "./PhoneApp";
import { installLayout, renderPhone } from "./testing";

beforeAll(installLayout);

const tabs = () =>
  within(screen.getByRole("navigation", { name: "Views" }))
    .getAllByRole("button")
    .map((b) => b.textContent);

describe("the phone shell", () => {
  it("draws five tabs, in the rail's order", () => {
    renderPhone(<PhoneFace />);
    expect(tabs()).toEqual(["Search", "Decks", "Collection", "Wishlist", "Scanner"]);
  });

  it("opens on Search and says so in the title", () => {
    renderPhone(<PhoneFace />);
    expect(screen.getByRole("heading", { level: 1, name: "Search" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Search" })).toHaveAttribute("aria-current", "page");
  });

  it("moves on a tab press, and the URL follows", async () => {
    renderPhone(<PhoneFace />);
    await userEvent.click(screen.getByRole("button", { name: "Wishlist" }));

    expect(window.location.pathname).toBe("/wishlist");
    expect(screen.getByRole("heading", { level: 1, name: "Wishlist" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Wishlist" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Search" })).not.toHaveAttribute("aria-current");
  });

  it("opens on the URL's destination", () => {
    renderPhone(<PhoneFace />, { path: "/collection" });
    expect(screen.getByRole("heading", { level: 1, name: "Collection" })).toBeInTheDocument();
  });

  it("reaches Settings from the top bar, and lights no tab there", async () => {
    renderPhone(<PhoneFace />);
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));

    expect(window.location.pathname).toBe("/settings");
    expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
    for (const tab of within(screen.getByRole("navigation", { name: "Views" })).getAllByRole("button")) {
      expect(tab).not.toHaveAttribute("aria-current");
    }
  });

  it("returns on Back", async () => {
    renderPhone(<PhoneFace />);
    await userEvent.click(screen.getByRole("button", { name: "Decks" }));
    expect(screen.getByRole("heading", { level: 1, name: "Decks" })).toBeInTheDocument();

    window.history.back();
    expect(await screen.findByRole("heading", { level: 1, name: "Search" })).toBeInTheDocument();
  });
});
