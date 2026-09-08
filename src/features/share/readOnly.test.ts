/**
 * The shared view's read-only guarantee, as a source sweep — because there is nothing at runtime
 * to check.
 *
 * **There is no read-only mode anywhere on this app's data path.** `lock_db_read` returns the
 * *write* connection on wasm, and `@/lib/writes` is only about which mutation owns an error
 * banner. So a flag would be a claim rather than a fence. What this view actually has is a
 * stronger property: it renders a **fetched document**, and nothing in `src/features/share/`
 * names a mutation. That is checkable, and this is the check.
 *
 * ## What makes it total, and what it rests on
 *
 * `ipc.ts` is the one door to the backend, so every backend call anywhere in the app is spelled
 * `ipc.<name>`. Sweeping this directory for that spelling therefore finds every call these files
 * make — provided the calls are made *here*. A helper outside this directory that took a
 * callback would be invisible to it, which is why `useOwnedIndex` writes its own paging loop
 * instead of importing `features/transfer/export/scope.ts`'s `sweep`: the ipc name stays inside
 * the swept files, and the fence stays total. Keep it that way.
 *
 * ## The one write that is coming, and why it must break this test
 *
 * Spec decision 8 gives this view a want list: tick rows, press *Add to wishlist*, choose a
 * folder the reader already has. That is a write, deliberately, by an explicit press, into the
 * reader's **own** wishlist — never into the binder on screen, which belongs to somebody else and
 * is a snapshot besides. When it lands it must add its command to {@link READS} in the same
 * commit, which is exactly the friction this test exists to create: one reviewed line, rather
 * than a guarantee that quietly stopped being true.
 */
import { describe, expect, it } from "vitest";

/**
 * Every source file of the shared view, as text.
 *
 * Tests and stories are **out** of the sweep on purpose: they mock `ipc` wholesale and a
 * hoisted spy named after a command is not a call to it. What is being fenced is what the app
 * does, and a suite that fenced its own mocks would be measuring itself.
 */
const SOURCES = Object.entries(
  import.meta.glob<string>("/src/features/share/**/*.{ts,tsx}", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
).filter(([path]) => !/\.(test|stories)\.tsx?$/.test(path));

/** `ipc.something` — the one spelling a backend call has in this app. */
const IPC_CALL = /\bipc\.([A-Za-z_$][\w$]*)/g;

/**
 * The commands this directory is allowed to name. **Every one of them is a read.**
 *
 * * `shareOpen` — fetch somebody else's snapshot. Sends no token and needs no membership.
 * * `shareList` — the group's own published shares, for the surfaces that ask this hook.
 * * `collectionList`, `wishlistList` — the reader's own two lists, swept into the
 *   cross-reference. Reads *of* the reader's data, never writes to it.
 */
const READS: readonly string[] = ["shareOpen", "shareList", "collectionList", "wishlistList"];

/** The three commands that change a share. None of them belongs on a viewer. */
const SHARE_WRITES: readonly string[] = ["shareCreate", "shareRefresh", "shareRevoke"];

describe("the shared view", () => {
  it("sweeps files at all", () => {
    // A glob that matches nothing passes every assertion below without testing anything, which
    // is this shape of test's own failure mode: a moved directory would turn the guarantee into
    // a green build over an empty set.
    expect(SOURCES.length).toBeGreaterThan(4);
    expect(SOURCES.map(([path]) => path)).toContain("/src/features/share/SharedPage.tsx");
  });

  it("has no write path at all", () => {
    for (const [path, source] of SOURCES) {
      for (const [, command] of source.matchAll(IPC_CALL)) {
        expect(
          READS,
          `${path} calls ipc.${command}. Everything in src/features/share/ renders a document ` +
            "somebody else published; a command that is not a read makes the view's read-only " +
            "promise false. If this is the want list (spec decision 8), add the command to " +
            "READS in readOnly.test.ts in the same commit and say why.",
        ).toContain(command);
      }
    }
  });

  it("never touches a share itself", () => {
    for (const [path, source] of SOURCES) {
      for (const command of SHARE_WRITES) {
        expect(source, `${path} names ipc.${command}`).not.toContain(`ipc.${command}`);
      }
    }
  });

  /**
   * And the back door: `ipc.ts` is only the one door while nothing goes round it. A file that
   * imported the raw `invoke`/`Core` layer could call anything at all, and every assertion above
   * would go on passing over it.
   */
  it("reaches the backend only through the ipc wrapper", () => {
    for (const [path, source] of SOURCES) {
      expect(source, `${path} imports the raw call layer`).not.toMatch(
        /from "@\/lib\/(core|invoke)"|from "@tauri-apps\/api\/core"/,
      );
    }
  });
});
