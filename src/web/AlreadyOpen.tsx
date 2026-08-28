/**
 * What the second tab gets.
 *
 * `opfs-sahpool` holds exclusive access handles and permits one connection to a database; a
 * second document asking for it is refused with `NoModificationAllowedError`. Spec §5.2
 * settled what to do about that: **the first tab wins and the second says so.** No
 * pause/unpause handoff — `pause_vfs()`/`unpause_vfs()` exist and a handoff is buildable, and
 * two tabs fighting over one database is a worse failure than one tab being told to use the
 * other.
 *
 * The reader did nothing wrong, so this is a sentence rather than an error: no code, no
 * stack, no retry loop. Reload is offered because the *other* tab may since have closed, and
 * pressing it is the only way to find out.
 */
export function AlreadyOpen({ onReload }: { onReload?: () => void }) {
  const reload = onReload ?? (() => window.location.reload());
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-8 text-foreground">
      <div className="max-w-md space-y-4 text-center">
        <h1 className="text-xl font-semibold">MTG Grimoire is already open</h1>
        <p className="text-muted-foreground">
          Your collection is open in another tab of this browser. Only one tab can use the card
          database at a time, so this one is standing aside.
        </p>
        <p className="text-muted-foreground">
          Switch to that tab, or close it and reload this one.
        </p>
        <button
          type="button"
          onClick={reload}
          className="rounded-md bg-primary px-4 py-2 text-primary-foreground"
        >
          Reload
        </button>
      </div>
    </main>
  );
}
