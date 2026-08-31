import { readFileSync, writeFileSync } from "node:fs";
const ROOT = "D:/Code/mtg-grimoire/.claude/worktrees/parity-reset/src";

function edit(rel, pairs) {
  const p = `${ROOT}/${rel}`;
  let s = readFileSync(p, "utf8");
  for (const [from, to] of pairs) {
    if (!s.includes(from)) throw new Error(`${rel}: NOT FOUND: ${from.slice(0, 90)}`);
    if (s.split(from).length > 2) throw new Error(`${rel}: NOT UNIQUE: ${from.slice(0, 90)}`);
    s = s.replace(from, to);
  }
  writeFileSync(p, s);
  console.log("patched " + rel);
}

// ── SettingsPage.test.tsx ────────────────────────────────────────────────────────────────
// The page no longer decides this, so the page's test must not claim it does. A mock or an
// assertion left describing the old truth stays green for ever over a reversed behaviour.
edit("features/settings/SettingsPage.test.tsx", [
  [
    `describe("the Updates panel is not on the web target", () => {
  /**
   * **Found by driving the phone on 2026-08-30, not by this suite.** After PR 10 routed 114 of
   * the crate's 154 commands, \`update_history\` was the only \`unknown command\` left anywhere in
   * the app — and it was *printed on the Settings page*, where the documented behaviour is
   * that §6.3's ten desktop-only commands are hidden rather than broken.
   *
   * The panel's own \`installKind === "managed"\` test could not have caught it: that reads an
   * answer from \`update_status\`, which is itself desktop-only, so on a browser it never
   * arrives and the panel concluded it was *not* managed and drew the controls.
   */
  it("is gone on the web build, while the rest of the page stays", async () => {
    const { isWebTarget } = await import("@/pwa/target");
    vi.mocked(isWebTarget).mockReturnValue(true);

    render(wrap(<SettingsPage update={NO_UPDATE} />));

    expect(screen.queryByText("panel:update")).not.toBeInTheDocument();
    expect(screen.getByText("panel:cache")).toBeInTheDocument();
  });

  it("is on the page when the build is not the web one", async () => {
    const { isWebTarget } = await import("@/pwa/target");
    vi.mocked(isWebTarget).mockReturnValue(false);

    render(wrap(<SettingsPage update={NO_UPDATE} />));

    expect(screen.getByText("panel:update")).toBeInTheDocument();
  });
});`,
    `describe("the Updates panel is drawn on every target", () => {
  /**
   * **This reverses PR #315, and the history is why the reversal is not a regression.**
   *
   * Driving the phone on 2026-08-30 found \`update_history\` printing \`unknown command\` on this
   * page — the last one left in the app after PR 10 routed 114 commands — so #315 hid the
   * whole panel behind \`!isWebTarget()\`. That was right while none of the five updater
   * commands answered. Two of them answer now: \`update_status\` and \`update_history\` are
   * routed by \`web::route\`, and a browser gets \`installKind: "web"\`.
   *
   * **So the decision moved out of this file**, and that is the point rather than a
   * refactor. #315's own write-up named the general lesson — *a feature gated on a backend
   * answer is ungated wherever the backend cannot answer* — and a build-time constant
   * standing in for an answer the backend could not give is the other half of the same
   * mistake. What each install kind draws is now \`UpdatePanel\`'s, tested against a real
   * \`installKind\` in \`UpdatePanel.test.tsx\`; all this page decides is that the panel exists.
   *
   * The panel is stubbed here, so these two assert reachability and nothing about content —
   * which is the whole of what this file can honestly say about it.
   */
  it("is on the page on the web build, as it is everywhere else", async () => {
    const { isWebTarget } = await import("@/pwa/target");
    vi.mocked(isWebTarget).mockReturnValue(true);

    render(wrap(<SettingsPage update={NO_UPDATE} />));

    expect(screen.getByText("panel:update")).toBeInTheDocument();
    // The page itself still rendered, so this is the panel and not a failed mount.
    expect(screen.getByText("panel:cache")).toBeInTheDocument();
  });

  it("is on the page when the build is not the web one", async () => {
    const { isWebTarget } = await import("@/pwa/target");
    vi.mocked(isWebTarget).mockReturnValue(false);

    render(wrap(<SettingsPage update={NO_UPDATE} />));

    expect(screen.getByText("panel:update")).toBeInTheDocument();
  });
});`,
  ],
]);

// ── UpdatePanel.test.tsx ─────────────────────────────────────────────────────────────────
edit("features/settings/UpdatePanel.test.tsx", [
  [
    `  /**
   * An MSI install or a Linux build. The news is still delivered — a reader should know a
   * new version exists — but nothing here promises to install it, and the sentence says why
   * and what happens to their collection.
   */`,
    `  /**
   * A browser, where the **service worker** replaces this build.
   *
   * \`managed\`'s twin, and the fixture is deliberately the same one: \`available\` is set, so a
   * panel that merely had nothing to show would pass. What must be absent is absent because
   * of \`installKind\`.
   *
   * **This is the assertion PR #315 could not make**, and the reason it could not is the
   * lesson worth keeping. Before \`web::route\` answered \`update_status\`, \`installKind\` was
   * \`undefined\` in a browser — so \`=== "managed"\` said false, and this panel drew a Download
   * button over a page that can download nothing. #315 hid the whole panel instead, because
   * hiding was the only thing that did not depend on an answer. The panel decides for itself
   * again now, off an answer that exists.
   */
  it("names the service worker on the web build, and offers nothing", () => {
    render(panel(update({ status: status({ installKind: "web" }), action: "none" })));

    expect(screen.getByText(/Updates arrive through your browser/)).toBeInTheDocument();
    expect(screen.getByText(/nothing to check for here/)).toBeInTheDocument();
    // Not Google Play. Naming the wrong updater is the failure this variant exists to avoid.
    expect(screen.queryByText(/Google Play/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Check now$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Download/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /View on GitHub/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/is available/)).not.toBeInTheDocument();
    // **The About half is the whole reason the panel is back on the page in a browser.**
    // #315 removed it saying a web About panel was worth having and was a different thing to
    // build; this is it, and the version is the fact it exists to carry.
    expect(screen.getByText(/MTG Grimoire/)).toBeInTheDocument();
    expect(screen.getByText("0.2.0")).toBeInTheDocument();
  });

  /**
   * **Nothing is offered until the backend has said which install this is**, which is the
   * structural half of the same fix.
   *
   * \`status\` is \`null\` for the first frame on every target — and was \`null\` for ever on the
   * web build, where the command did not answer at all. The old test here was \`!managed\`,
   * which is \`true\` for \`null\`: a panel with no answer yet offered Check now, and on a
   * browser it offered it permanently. An absent answer must read as "not yet", never as
   * "not managed".
   */
  it("offers no controls before the backend has answered", () => {
    render(panel(update({ status: null, action: "none" })));

    expect(screen.queryByRole("button", { name: /^Check now$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Download/ })).not.toBeInTheDocument();
    // It says so rather than going blank, which is what the panel has always done here.
    expect(screen.getByText(/Checking for updates…/)).toBeInTheDocument();
  });

  /**
   * An MSI install or a Linux build. The news is still delivered — a reader should know a
   * new version exists — but nothing here promises to install it, and the sentence says why
   * and what happens to their collection.
   */`,
  ],
]);
