import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BuildCorpus } from "./BuildCorpus";

/**
 * **This screen is where an eviction lands on the web target**, and finding that out is the
 * point of the file. `WebBoot` gates `<App />` on a corpus existing and `SyncProgress` — which
 * carries the same two sentences for desktop — is inside `App`, so a browser that threw the
 * corpus away shows this and never that.
 */
describe("why the database is empty", () => {
  it("calls a genuine first run a first run", () => {
    render(<BuildCorpus onDone={() => {}} reason="never-built" />);
    expect(screen.getByRole("heading", { name: "Build the card database" })).toBeInTheDocument();
    expect(screen.getByText(/builds its own copy/)).toBeInTheDocument();
  });

  it("says the data was cleared when this browser has had a corpus before", () => {
    render(<BuildCorpus onDone={() => {}} reason="evicted" />);
    expect(screen.getByRole("heading", { name: "Your card data was cleared" })).toBeInTheDocument();
    expect(screen.getByText(/removed the card database to free up space/)).toBeInTheDocument();
    // The way out is unchanged — this is the same screen, not a second one.
    expect(screen.getByRole("button", { name: "Build it now" })).toBeEnabled();
  });

  /** Desktop's answer, and the default: a file on disk does not vanish while the app stays. */
  it("defaults to a first run when nobody says otherwise", () => {
    render(<BuildCorpus onDone={() => {}} />);
    expect(screen.getByRole("heading", { name: "Build the card database" })).toBeInTheDocument();
  });
});
