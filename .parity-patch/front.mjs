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

// ── ipc.ts: the fifth install kind ───────────────────────────────────────────────────────
edit("lib/ipc.ts", [
  [
    ` * \`managed\` is Android: the Play Store installed this app and the store is what replaces it.
 * It is deliberately **not** \`other\` — \`other\` means "we could not tell, here is the release
 * page", and this app's release page offers a Windows exe and an NSIS installer, which is a
 * worse answer on a phone than no answer. \`managed\` means something else installs this app,
 * which is true, is typed, and makes this union exhaustive so \`UpdatePanel\` cannot forget the
 * case.
 */
export type InstallKind = "portable" | "nsis" | "managed" | "other";`,
    ` * \`managed\` is Android: the Play Store installed this app and the store is what replaces it.
 * It is deliberately **not** \`other\` — \`other\` means "we could not tell, here is the release
 * page", and this app's release page offers a Windows exe and an NSIS installer, which is a
 * worse answer on a phone than no answer. \`managed\` means something else installs this app,
 * which is true, is typed, and makes this union exhaustive so \`UpdatePanel\` cannot forget the
 * case.
 *
 * \`web\` is the browser build, and it is \`managed\`'s sibling rather than a repeat of it: both
 * mean "something else installs this and the app does not replace itself", and the reader is
 * owed the name of the thing that does. A **service worker** is what replaces a PWA, and
 * saying "Google Play" to somebody holding a laptop is the same wrong answer \`managed\` exists
 * to stop \`other\` giving a phone. Answered by \`web::route\`, which is the only place in the
 * crate that knows it is running in a browser.
 */
export type InstallKind = "portable" | "nsis" | "managed" | "other" | "web";`,
  ],
]);

// ── UpdatePanel.tsx: who replaces this build, in three answers rather than two ────────────
edit("features/settings/UpdatePanel.tsx", [
  [
    `  const { status, progress, busy, action, error } = update;
  const release = status?.available ?? null;
  /**
   * The Play Store installed this app and the store is what replaces it, so every control on
   * this panel is about something the app cannot do.
   *
   * **Read off \`installKind\` rather than off \`isAndroid()\`**, and the difference is the point:
   * the backend already answered this question — \`Updater::new\` calls
   * \`install_kind_for(cfg!(mobile), …)\` before it touches the disk — and asking the user agent
   * here would be a second, independent answer to one question, free to disagree. It is also
   * deliberately not \`other\`: that one means "we could not tell, here is the release page", and
   * this app's release page offers a Windows exe and an NSIS installer, which is a worse answer
   * on a phone than no answer at all.
   */
  const managed = status?.installKind === "managed";`,
    `  const { status, progress, busy, action, error } = update;
  const release = status?.available ?? null;
  /**
   * Who replaces this build — the answer that decides whether this panel offers controls at
   * all, and the one that has to come from the backend.
   *
   * **Read off \`installKind\` rather than off \`isAndroid()\` or \`isWebTarget()\`**, and the
   * difference is the point: the backend already answered this question, and asking the user
   * agent here would be a second, independent answer to one question, free to disagree.
   *
   * **The trap this walked into once is worth keeping written down.** Until 2026-08-31 the
   * web build did not answer \`update_status\` at all, so \`installKind\` was \`undefined\`, so
   * this test said "not managed" and the panel drew a Download button over a page that can
   * download nothing — **a feature gated on a backend answer is ungated wherever the backend
   * cannot answer.** PR #315 fixed the symptom by hiding the whole panel on web; the fix now
   * is that the browser answers \`"web"\`, which is a real answer this test can read.
   *
   * \`ELSEWHERE\` is the two kinds where something else does the replacing, and each names
   * *what*: a reader told "updates arrive elsewhere" with no elsewhere has been told nothing.
   * Neither is \`other\` — that one means "we could not tell, here is the release page", and
   * this app's release page offers a Windows exe and an NSIS installer, which is a worse
   * answer to a phone or a browser than no answer at all.
   */
  const elsewhere = status ? ELSEWHERE[status.installKind] : null;
  /** Nothing on this panel presses until the backend has said which kind of install this is. */
  const selfUpdating = status !== null && elsewhere === undefined;`,
  ],
  [
    `        {!managed && (
          <button
            type="button"
            onClick={update.check}`,
    `        {selfUpdating && (
          <button
            type="button"
            onClick={update.check}`,
  ],
  [
    `      {managed ? (
        <p className="border-t border-border pt-4 text-sm text-dim">
          <span className="text-text">Updates arrive through Google Play.</span> This build
          cannot replace itself, and there is nothing to check for here.
        </p>
      ) : release ? (`,
    `      {elsewhere ? (
        <p className="border-t border-border pt-4 text-sm text-dim">
          <span className="text-text">{elsewhere}</span> This build cannot replace itself, and
          there is nothing to check for here.
        </p>
      ) : release ? (`,
  ],
  [
    `      {/* Hidden with the rest of it: the list is populated by the very check that is not run
          here, so on a managed install it is an empty accordion promising nothing. */}
      {!managed && (`,
    `      {/* Hidden with the rest of it: the list is populated by the very check that is not run
          here, so wherever something else does the updating it is an empty accordion
          promising nothing. \`update_history\` answers on every target now — in a browser it
          answers \`[]\`, because only a check ever writes that row — so what is hidden here is
          an empty section rather than a broken call. */}
      {selfUpdating && (`,
  ],
  [
    `/**
 * The download bar.`,
    `/**
 * The one sentence for a build that something else replaces, per install kind.
 *
 * **A lookup rather than a ternary**, so the union in \`@/lib/ipc\` is what decides whether a
 * kind belongs here: adding a sixth \`InstallKind\` makes this object's type ask the question,
 * where an \`=== "managed" || === "web"\` chain would quietly answer "self-updating" for it and
 * draw a Download button. The three that are absent — \`portable\`, \`nsis\`, \`other\` — are the
 * three where this app is the thing that installs itself, or where nothing knows what does.
 */
const ELSEWHERE: Partial<Record<InstallKind, string>> = {
  managed: "Updates arrive through Google Play.",
  // Not "reload the page", which is the mechanism rather than the promise, and not accurate
  // either: the service worker fetches the new build in the background and it is live at the
  // *next* start. \`src/pwa\` owns that flow and already tells the reader when one is waiting.
  web: "Updates arrive through your browser.",
};

/**
 * The download bar.`,
  ],
  [
    `import type { ReleaseHistory } from "@/lib/useReleaseHistory";`,
    `import type { InstallKind } from "@/lib/ipc";
import type { ReleaseHistory } from "@/lib/useReleaseHistory";`,
  ],
]);

// ── SettingsPage.tsx: the panel is drawn everywhere, and decides for itself ───────────────
edit("features/settings/SettingsPage.tsx", [
  [
    `      {/* **Not on the web target**, where every control on it is about something the app
          cannot do: \`update_status\`, \`update_check\`, \`update_download\`, \`update_apply\` and
          \`update_history\` are five of §6.3's ten desktop-only commands, because **a PWA
          updates through its service worker** — which ships and works. \`!isWebTarget()\`
          rather than the panel's own \`installKind === "managed"\` test, and the difference
          matters: that one reads an answer from \`update_status\`, which on a browser never
          arrives, so the panel decided it was *not* managed and drew the controls anyway.
          Driven on the phone 2026-08-30, this was the last \`unknown command\` in the app.

          What it costs is the nearest thing to an About screen — the mark, the version and
          the last check. **Nothing is lost**, because with no \`update_status\` to read it was
          already drawing "MTG Grimoire …" with no version at all. A web About panel is worth
          having and is a different thing to build. */}
      {!isWebTarget() && <UpdatePanel update={update} history={history} />}`,
    `      {/* **Drawn on every target again, and this reverses half of PR #315.** That change hid
          the whole panel behind \`!isWebTarget()\`, which was right while nothing on it worked:
          \`update_status\` and \`update_history\` answered \`unknown command\` in a browser, and the
          panel's own \`installKind === "managed"\` test could not save it, because that reads an
          answer from \`update_status\` — so on web it read the *absence* as "not managed" and
          drew the controls anyway. Driven on the phone 2026-08-30, that was the last
          \`unknown command\` in the app.

          What it cost was the nearest thing to an About screen, which #315 said out loud was
          worth having and was a different thing to build. This is that thing: \`update_status\`
          and \`update_history\` are routed by \`web::route\` now, the browser answers
          \`installKind: "web"\`, and the panel draws the mark, the name and the version and
          names the service worker in place of a Download button. **The gate moved from the
          build target onto a backend answer**, which is the general lesson #315 wrote down.

          \`update_check\`, \`update_download\`, \`update_apply\` and \`update_open_release_page\` are
          still desktop's, and nothing above reaches them: the panel offers a browser no
          button that calls one. \`update_check\` in particular is *absent* rather than unrouted
          — \`web::route::call\` is synchronous, so no \`async\` command can be an arm there at
          all. Its arm in that file says so. */}
      <UpdatePanel update={update} history={history} />`,
  ],
]);

// ── useUpdate.ts: poll where a check can change the answer, read once where it cannot ─────
edit("lib/useUpdate.ts", [
  [
    `  useEffect(() => {
    // **The web target has no updater to poll**, and the \`catch\` below is what made that
    // invisible: \`update_status\` is one of §6.3's desktop-only commands, so on a browser this
    // was a failing IPC call once a minute for the life of the tab, swallowed every time.
    // Found on the phone 2026-08-30 while chasing the one \`unknown command\` still on screen.
    if (isWebTarget()) return;
    let cancelled = false;`,
    `  useEffect(() => {
    let cancelled = false;`,
  ],
  [
    `      // Chained timeouts rather than an interval, so two reads can never overlap.
      timer = setTimeout(poll, POLL_MS);
    };`,
    `      // Chained timeouts rather than an interval, so two reads can never overlap.
      //
      // **Read once on the web target, rather than not at all.** \`update_status\` answers
      // there since 2026-08-31 — it is \`installKind: "web"\` and two \`app_meta\` reads — and
      // \`UpdatePanel\` needs that answer to know it must not draw a Download button. What it
      // does not need is a second read: this poll exists for exactly one thing, the check
      // Rust spawns at startup and emits no event for, and a browser runs no such check. So
      // the answer cannot change while the tab is open, and re-asking every minute would be
      // a write-lock acquisition a minute for a constant.
      if (!isWebTarget()) timer = setTimeout(poll, POLL_MS);
    };`,
  ],
]);

// ── useReleaseHistory.ts: the command answers everywhere now ──────────────────────────────
edit("lib/useReleaseHistory.ts", [
  [
    `    // **Never on the web target**, where \`update_history\` is one of the commands §6.3 keeps
    // desktop-only: a PWA updates through its service worker, so there is no portable \`.exe\`
    // whose releases this would list. Driven on the phone 2026-08-30, this was the *only*
    // \`unknown command\` left in the app after PR 10 — printed on the Settings page, where the
    // documented behaviour is that those commands are hidden rather than broken.
    //
    // \`enabled\` rather than a caller-side \`if\`, because the hook is called unconditionally by
    // \`SettingsPage\` and this is the same shape \`useWebStorage\` already has one line away:
    // inert on the target it does not apply to, and a build-time constant deciding it.
    enabled: !isWebTarget(),
`,
    `    // **No target gate any more**, and its removal is the point rather than a tidy-up.
    // \`update_history\` is routed by \`web::route\` since 2026-08-31 and answers on every
    // target: two \`app_meta\` reads and no network, which is what its Rust doc has always
    // said. In a browser it answers \`[]\` — only \`update_check\` ever writes that row, and
    // \`app_meta\` is not one of the synced tables — which is the same "never fetched" state
    // the Tagger models, and \`UpdatePanel\` draws no history section there anyway.
    //
    // This hook read \`enabled: !isWebTarget()\` until then, added by PR #315 because the call
    // was printing \`unknown command\` on the Settings page. A build-time constant standing in
    // for an answer the backend could not give is exactly what that PR's own write-up named
    // as the general lesson; the backend gives it now.
`,
  ],
  [
    `import { ipc, ipcError, type ReleaseNote } from "@/lib/ipc";
import { isWebTarget } from "@/pwa/target";
`,
    `import { ipc, ipcError, type ReleaseNote } from "@/lib/ipc";
`,
  ],
  [
    `    // **\`fetchStatus\`, not \`isPending\` alone.** A query that is \`enabled: false\` stays
    // \`pending\` for ever in TanStack v5 — it has no data and never will — so the plain read
    // would report "loading" permanently on the web target. \`idle\` is what tells the two
    // apart: nothing is in flight and nothing is going to be.`,
    // The reading is still correct and still the one to keep — it is what "nothing is in
    // flight" means — so the code is untouched and only the reason it cites moves.
    `    // **\`fetchStatus\`, not \`isPending\` alone.** A query that is disabled stays \`pending\`
    // for ever in TanStack v5 — it has no data and never will — so the plain read reports
    // "loading" permanently for one. \`idle\` is what tells the two apart: nothing is in
    // flight and nothing is going to be.
    //
    // **Kept after the \`enabled\` gate above was removed**, and deliberately: this is the
    // correct reading of "is something in flight" whether or not anything is currently
    // disabling the query, and the day one is again — a paused query, a suspended tab — the
    // plain \`isPending\` would put "Reading the version history…" on screen for ever.`,
  ],
]);
