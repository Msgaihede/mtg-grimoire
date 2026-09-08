/**
 * Somebody else's collection, read inside the app.
 *
 * ## Why this is a view and not a page in the browser
 *
 * The same snapshot has two viewers (spec §7 and §8) and they answer different questions.
 * `share/SharePage.tsx` is what a stranger gets from a link in a chat window: no account, no app,
 * no database. This one is what a *Grimoire reader* gets, and the one thing it can do that the
 * other cannot is the reason it exists — **every row cross-referenced against what the reader
 * already owns and already wants**. A binder is only worth scrolling if you can see what is in it
 * that you have been looking for.
 *
 * ## It has no write path, and that is the whole of the read-only guarantee
 *
 * There is no read-only mode anywhere on this app's data path: `lock_db_read` returns the *write*
 * connection on wasm, and `@/lib/writes` is only about which mutation owns an error banner. So
 * the guarantee here is structural — this view renders a **fetched document** and nothing in
 * `src/features/share/` names an ipc mutation. `readOnly.test.ts` is that fence, and it is a
 * source sweep rather than a runtime check because there is nothing at runtime to check.
 *
 * Two consequences worth stating, since both look like omissions:
 *
 * * **A tile is not a button.** Opening the app's own card surface from here would hand the
 *   reader every write that surface has — add to a deck, record a copy — inside a view whose
 *   promise is that it changes nothing. The snapshot carries the picture, the name, the set and
 *   the number, which is what a reader needs to recognise a card in a binder.
 * * **The want list is the one exception, and it writes the reader's _own_ wishlist.** Spec
 *   decision 8: tick rows, press *Add to wishlist*, choose a folder they already have. Nothing
 *   about the binder on screen moves — it belongs to somebody else and is a fetched document
 *   besides. `AddToWishlist.tsx` is the whole of the write and `readOnly.test.ts` is where the
 *   exception is written down; every other command this directory names is still a read.
 */
import { useMemo, useState, type ReactNode } from "react";
import { useQueries } from "@tanstack/react-query";
import { Handshake, Heart, Link2, RefreshCw, X } from "lucide-react";
import { CardArt } from "@/components/CardArt";
import { CardChin } from "@/components/CardChin";
import { CountTag } from "@/components/CountTag";
import { cardScaleVars, DEFAULT_ZOOM } from "@/lib/cardZoom";
import { CONDITION_LABEL, type Condition } from "@/lib/conditions";
import { BUTTON } from "@/features/settings/controls";
import { isFinish, type Finish } from "@/lib/finish";
import { FOCUS } from "@/lib/focus";
import { ipcError } from "@/lib/ipc";
import { resolveMarketplace, type Currency } from "@/lib/marketplace";
import { formatPrice } from "@/lib/prices";
import type { ShareCard, ShareSnapshot } from "@/lib/shareSnapshot";
import { useAppStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { AddToWishlist } from "./AddToWishlist";
import { OpenShareDialog } from "./OpenShareDialog";
import { drawers, subtreeOf } from "./shareTree";
import { crossReference, useOwnedIndex, type OwnedIndex } from "./useOwnedIndex";
import { sharedSnapshotQuery, useSharedSnapshot } from "./useSharedSnapshot";

/**
 * The absence, drawn.
 *
 * `fields` says which **question** the publisher answered and never that every card has an
 * answer — an ungraded copy carries no `c`, and a finish the marketplace does not quote carries
 * no `p`. Both are ordinary, and both are this character rather than a blank (which reads as a
 * layout fault) or a zero (which reads as a shop offering the card for nothing).
 */
export const NOTHING = "—";

/** `1,204` — the grouping every count here gets. Prices go through `formatPrice`. */
const COUNT = new Intl.NumberFormat("en-US");

/** `8 September 2025`, in the reader's own locale. `updatedAt` is **seconds**. */
function asOf(updatedAt: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "long" }).format(
    new Date(updatedAt * 1000),
  );
}

/** Which currency the prices on the wire are in. The snapshot's own answer wins. */
function shareCurrency(snapshot: ShareSnapshot): Currency {
  const named = snapshot.currency.toLowerCase();
  if (named === "usd" || named === "eur") return named;
  // A currency this build does not know is a snapshot from a future one; the marketplace it was
  // priced at is a better guess than a hard-coded dollar.
  return resolveMarketplace(snapshot.marketplace).currency;
}

/** Which rows the reader has narrowed to, against their own two lists. */
type Match = "all" | "wanted" | "unowned";

const MATCHES: readonly { id: Match; label: string }[] = [
  { id: "all", label: "Everything" },
  { id: "wanted", label: "On your wishlist" },
  { id: "unowned", label: "You do not own it" },
];

type Sort = "name" | "set" | "quantity" | "price";

/**
 * The view.
 *
 * Reads the open links out of the store and draws the head of that list, because the head **is**
 * the current binder — see `AppState.openedShares` for why that is one field rather than two.
 */
export function SharedPage() {
  const openedShares = useAppStore((s) => s.openedShares);
  const openShare = useAppStore((s) => s.openShare);
  const closeShare = useAppStore((s) => s.closeShare);
  const [pasting, setPasting] = useState(false);

  const url = openedShares[0] ?? null;
  const share = useSharedSnapshot(url);
  const snapshot = share.data;
  // Only once there is a binder to draw the figures against: this sweeps the reader's whole
  // collection, and somebody who never opens a share must never pay for it.
  const cross = useOwnedIndex(snapshot !== undefined);

  const paste = (
    <OpenShareDialog
      open={pasting}
      onClose={() => setPasting(false)}
      onOpened={() => setPasting(false)}
    />
  );

  if (url === null) {
    return (
      <Frame>
        <Empty onPaste={() => setPasting(true)} />
        {paste}
      </Frame>
    );
  }

  return (
    <Frame>
      <Switcher
        open={openedShares}
        current={url}
        onPick={openShare}
        onPaste={() => setPasting(true)}
      />
      {share.isPending ? (
        <p className="mt-8 text-sm text-dim">Fetching the collection…</p>
      ) : share.isError ? (
        <Refused
          sentence={ipcError(share.error)}
          onRetry={() => void share.refetch()}
          onClose={() => closeShare(url)}
        />
      ) : (
        <Binder
          /**
           * ⚠️ **The key is load-bearing and its absence was a wrong write.**
           *
           * Every piece of this component's state is about *one* binder, and the ticks are about
           * one binder's **positions**: {@link rows} keys a row by its index in the snapshot's own
           * array, which is the only unique key this document has. Switching binders is a shipped
           * control — {@link Switcher} draws a tab per open share — and it does not unmount
           * anything: `Switcher`'s `useQueries` holds an observer on every open link at
           * `staleTime: Infinity`, so the target snapshot is already warm and `isPending` is false
           * on the same render.
           *
           * Without a key, `picked` therefore survived the switch and `pickedCards` resolved keys
           * `"0"`, `"1"` against the **new** binder's rows: *Add to wishlist* wrote the first two
           * cards of a collection the reader had never looked at, with no error and no cue. The
           * search box, the drawer, the sort and the report carried over too, which is merely
           * wrong-looking.
           *
           * A key rather than an effect that clears the state, because "this is a different
           * binder" is exactly what a key says and an effect would have to be remembered by
           * whoever adds the next field.
           */
          key={url}
          snapshot={share.data}
          index={cross.index}
          // ⚠️ **`ready` is passed and not merely computed.** Until both sweeps land — up to a
          // hundred round trips at the 50 000-card size `useOwnedIndex` argues from — `index` is
          // `EMPTY_INDEX`, and a wall drawn against it says *You own 0 · You want 0* on every
          // tile: the exact figure that module exists to keep off the screen, arriving as an
          // answer rather than as a wait. `failed` is the same absence for a different reason,
          // which is why both are here and neither is folded into the other.
          figuresReady={cross.ready}
          figuresFailed={cross.failed}
          refreshing={share.isFetching}
          onRefresh={() => void share.refetch()}
          onClose={() => closeShare(url)}
        />
      )}
      {paste}
    </Frame>
  );
}

/** The view's own column. `AppShell`'s `main` is the scroller; this decides the measure. */
function Frame({ children }: { children: ReactNode }) {
  return <div className="mx-auto w-full max-w-[84rem] px-5 pb-16 sm:px-8">{children}</div>;
}

/**
 * A reader who has never opened a link.
 *
 * An empty screen is an invitation to act, so the sentence says what a shared collection is and
 * the control does the one thing there is to do. It is also the only entry point that exists
 * before the cabinet grows its own Share control, which is why the button is the loud thing here
 * rather than a line of help.
 */
function Empty({ onPaste }: { onPaste: () => void }) {
  return (
    <div className="max-w-[46ch] py-16">
      <Handshake className="size-7 text-dim" aria-hidden />
      <h2 className="mt-4 font-heading text-[1.375rem] leading-snug">
        Open a collection somebody shared with you
      </h2>
      <p className="mt-3 text-sm text-dim">
        Paste the link they sent you. You will see their binder as it was when they published it,
        with every card checked against what you own and what is on your wishlist.
      </p>
      <button
        type="button"
        onClick={onPaste}
        className={cn(BUTTON, "mt-6 border-accent/50 text-accent")}
      >
        <Link2 className="size-4" aria-hidden />
        Open a shared collection
      </button>
    </div>
  );
}

/**
 * Which binder is on screen, and the way to another.
 *
 * Drawn as a row of links rather than a picker, because a reader trading with two people has two
 * of these and never twenty — and a `<select>` of one entry is a control that looks like a
 * choice and is not.
 */
function Switcher({
  open,
  current,
  onPick,
  onPaste,
}: {
  open: readonly string[];
  current: string;
  onPick: (url: string) => void;
  onPaste: () => void;
}) {
  /**
   * A name for each open binder.
   *
   * **`useQueries` rather than a peek at the cache**, and the difference is a tab that goes blank
   * after five minutes. Every link in `openedShares` was fetched by the paste dialog, so the
   * snapshot *is* in the cache — but a query with no observer is garbage-collected at TanStack's
   * default `gcTime`, and a row of tabs reading off `getQueryData` would silently fall back to
   * the share's id for a reader who left the window alone. Subscribing keeps each one alive, and
   * costs nothing to fetch: `staleTime` is `Infinity` and the documents are already there.
   */
  const titles = useQueries({
    queries: open.map((url) => sharedSnapshotQuery(url)),
  });
  const nameOf = (url: string, at: number) => {
    const snapshot = titles[at]?.data;
    return snapshot === undefined ? shareIdOf(url) : `${snapshot.owner}’s ${snapshot.title}`;
  };

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border py-3">
      {open.length > 1 &&
        open.map((url, at) => (
          <button
            key={url}
            type="button"
            aria-current={url === current ? "true" : undefined}
            onClick={() => onPick(url)}
            className={cn(
              "h-8 rounded-md border px-3 text-sm transition-colors duration-150",
              "motion-reduce:transition-none",
              url === current
                ? "border-accent bg-accent/15 text-text"
                : "border-border bg-surface text-dim hover:text-text",
              FOCUS,
            )}
          >
            {nameOf(url, at)}
          </button>
        ))}
      <button
        type="button"
        onClick={onPaste}
        className={cn(BUTTON, "ml-auto border-border text-dim hover:text-text")}
      >
        <Link2 className="size-4" aria-hidden />
        Open another
      </button>
    </div>
  );
}

/**
 * The last path segment — `{SHARE_BASE}/s/{id}` — which is the only name a link carries before
 * its snapshot has arrived.
 */
function shareIdOf(url: string): string {
  const segments = url.split("/").filter((s) => s !== "");
  return segments[segments.length - 1] ?? url;
}

/** A link that did not answer, in the view's own chrome. */
function Refused({
  sentence,
  onRetry,
  onClose,
}: {
  sentence: string;
  onRetry: () => void;
  onClose: () => void;
}) {
  return (
    <div className="max-w-[46ch] py-14">
      <p className="font-heading text-[1.375rem] leading-snug">{sentence}</p>
      <p className="mt-3 text-sm text-dim">
        A shared collection stops answering when its owner withdraws it, or when their membership
        ends. The link cannot be revived from this side.
      </p>
      <div className="mt-6 flex flex-wrap gap-2">
        <button type="button" onClick={onRetry} className={cn(BUTTON, "border-border")}>
          <RefreshCw className="size-4" aria-hidden />
          Try again
        </button>
        <button type="button" onClick={onClose} className={cn(BUTTON, "border-border")}>
          <X className="size-4" aria-hidden />
          Close this collection
        </button>
      </div>
    </div>
  );
}

/** The binder itself: the header, the narrowing controls, and the wall. */
function Binder({
  snapshot,
  index,
  figuresReady,
  figuresFailed,
  refreshing,
  onRefresh,
  onClose,
}: {
  snapshot: ShareSnapshot;
  index: OwnedIndex;
  /**
   * Both sweeps have landed and {@link index} is the reader's real answer.
   *
   * **Everything that reads a figure is gated on this**, in three places and for one reason: an
   * unfinished sweep is an *absence*, and drawn as a number it is a confident zero. The tile
   * draws no figure line at all; the three match chips do not narrow; and the wall says it is
   * still checking.
   */
  figuresReady: boolean;
  figuresFailed: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const [drawer, setDrawer] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [match, setMatch] = useState<Match>("all");
  const [sort, setSort] = useState<Sort>("name");
  /**
   * The rows the reader has ticked, by the snapshot-position key {@link rows} hands out.
   *
   * **Keyed on the row and folded to a card only on the way out** ({@link AddToWishlist}'s
   * `fold`): the wall draws rows, so a tick is about the row that was under the pointer, and two
   * rows of one printing in two of the publisher's drawers are two ticks and one wish.
   */
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const [sending, setSending] = useState(false);
  /** What the last add did, in the view rather than in a dialog that has closed over it. */
  const [report, setReport] = useState<string | null>(null);

  const currency = shareCurrency(snapshot);
  const market = resolveMarketplace(snapshot.marketplace);
  const showValue = snapshot.fields.includes("value");
  const showCondition = snapshot.fields.includes("condition");
  const showLang = snapshot.fields.includes("lang");

  const tree = useMemo(() => drawers(snapshot), [snapshot]);
  const copies = useMemo(() => snapshot.cards.reduce((n, c) => n + c.q, 0), [snapshot]);

  /**
   * The cards paired with **their position in the snapshot's own array**, which is the only
   * unique key this document has.
   *
   * ⚠️ **Nothing about a card identifies it.** A row is a printing, a finish, a folder and a
   * grade, and two rows of one binder can agree on every one of those and still be two rows.
   * `{id}:{finish}:{folder}` looked unique and was not — the web viewer measured React reporting
   * *two children with the same key* on the golden's own shape. The index is stable because the
   * snapshot is immutable: filtering and sorting derive from this list rather than replacing it.
   */
  const rows = useMemo(
    () => snapshot.cards.map((card, index) => ({ card, key: String(index) })),
    [snapshot],
  );

  const shown = useMemo(() => {
    const kept = drawer === null ? null : subtreeOf(tree, drawer);
    const needle = text.trim().toLowerCase();
    const matches = (card: ShareCard) =>
      needle === "" ||
      card.n.toLowerCase().includes(needle) ||
      card.s.toLowerCase().includes(needle) ||
      card.cn.toLowerCase().includes(needle);

    const filtered = rows.filter(({ card }) => {
      if (kept !== null && (card.fo === null || !kept.has(card.fo))) return false;
      if (!matches(card)) return false;
      // ⚠️ **`!figuresReady` widens to everything, and it must.** Against `EMPTY_INDEX` every
      // card answers *own 0, want 0*, so *On your wishlist* would empty the binder and *You do
      // not own it* would keep all of it — two confident wrong answers, both of which then
      // rearrange themselves when the sweep lands. A reader's pressed chip is remembered and
      // starts narrowing the moment there is something true to narrow by.
      if (match === "all" || !figuresReady) return true;
      const { own, want } = crossReference(card, index);
      return match === "wanted" ? want > 0 : own === 0;
    });

    const by: Record<Sort, (a: ShareCard, b: ShareCard) => number> = {
      name: (a, b) => a.n.localeCompare(b.n) || a.s.localeCompare(b.s),
      set: (a, b) =>
        a.s.localeCompare(b.s) || a.cn.localeCompare(b.cn, undefined, { numeric: true }),
      quantity: (a, b) => b.q - a.q || a.n.localeCompare(b.n),
      // Unquoted last, always: a card the marketplace never listed is not the cheapest one.
      price: (a, b) => (b.p ?? -1) - (a.p ?? -1),
    };
    return filtered.sort((a, b) => by[sort](a.card, b.card));
  }, [rows, tree, drawer, text, match, sort, index, figuresReady]);

  const shownCopies = useMemo(() => shown.reduce((n, r) => n + r.card.q, 0), [shown]);

  /**
   * The ticked copies, read off **`rows`** and never off `shown`.
   *
   * A pick is about a card and a filter is about the wall, so narrowing the wall must not quietly
   * drop what the reader has already chosen — they tick as they scroll and then press a chip to
   * check themselves. `rows` is the whole snapshot and the snapshot is immutable, so a key that
   * was ticked always resolves.
   */
  const pickedCards = useMemo(
    () => rows.filter(({ key }) => picked.has(key)).map(({ card }) => card),
    [rows, picked],
  );

  const toggle = (key: string) =>
    setPicked((was) => {
      const next = new Set(was);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  return (
    <>
      <header className="border-b border-border py-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          {/* The owner above the binder's name rather than beside it: a stranger's collection has
              to say whose it is before it says what it is called.
              **`{" "}` between the two spans is load-bearing.** They are `block`, so their text
              nodes concatenate with no separator and the accessible name of this heading would
              otherwise be `Giradeli’sTrade binder` — the same defect a `gap` between a label and
              its count produced elsewhere in this app. */}
          <h2 className="max-w-[34rem]">
            <span className="block text-sm text-dim">{snapshot.owner}’s</span>{" "}
            <span className="block font-heading text-[1.75rem] leading-tight">
              {snapshot.title}
            </span>
          </h2>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onRefresh}
              aria-disabled={refreshing}
              className={cn(BUTTON, "border-border text-dim hover:text-text")}
            >
              {/* `motion-reduce:animate-none` is the ribbon's own spelling: an indefinite spin is
                  the one animation here that is not a transition, so it needs its own opt-out. */}
              <RefreshCw
                className={cn("size-4", refreshing && "animate-spin motion-reduce:animate-none")}
                aria-hidden
              />
              {refreshing ? "Checking…" : "Check for an update"}
            </button>
            <button
              type="button"
              onClick={onClose}
              className={cn(BUTTON, "border-border text-dim hover:text-text")}
            >
              <X className="size-4" aria-hidden />
              Close this collection
            </button>
          </div>
        </div>

        <p className="mt-4 font-mono text-[0.8125rem] text-dim">
          {COUNT.format(copies)} {copies === 1 ? "card" : "cards"}
          {tree.length > 0 &&
            ` in ${COUNT.format(tree.length)} ${tree.length === 1 ? "drawer" : "drawers"}`}
          {`, as of ${asOf(snapshot.updatedAt)}`}
        </p>
        {showValue && (
          <p className="mt-1 font-mono text-[0.8125rem] text-dim">
            Priced at {market.label}, in {currency.toUpperCase()}
          </p>
        )}
        <p className="mt-4 max-w-[54ch] text-sm text-dim">
          This is a read-only snapshot. It shows these cards until {snapshot.owner} publishes their
          collection again, and nothing you do here changes it.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-2 pt-4">
        <label htmlFor="shared-text" className="sr-only">
          Search this collection
        </label>
        <input
          id="shared-text"
          type="search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Search this collection…"
          className={cn(
            "h-9 min-w-0 flex-1 basis-56 rounded-md border border-border bg-surface px-3",
            "text-sm text-text placeholder:text-dim",
            FOCUS,
          )}
        />
        {tree.length > 0 && (
          <Picker
            id="shared-drawer"
            label="Drawer"
            value={drawer ?? ""}
            onPick={(v) => setDrawer(v === "" ? null : v)}
            options={[
              { value: "", label: `All drawers (${COUNT.format(copies)})` },
              ...tree.map((d) => ({
                // The depth is drawn with figure spaces rather than an indent class, because a
                // native `<option>` renders no markup at all — this is the one place in the app
                // where a nested list has nothing but characters to say so.
                value: d.uid,
                label: `${"  ".repeat(d.depth)}${d.name} (${COUNT.format(d.count)})`,
              })),
            ]}
          />
        )}
        <Picker
          id="shared-sort"
          label="Sort"
          value={sort}
          onPick={(v) => setSort(v as Sort)}
          options={[
            { value: "name", label: "Name" },
            { value: "set", label: "Set" },
            { value: "quantity", label: "Copies" },
            ...(showValue ? [{ value: "price", label: "Price" }] : []),
          ]}
        />
      </div>

      {/* The narrowing this view exists for, and the reason it is chips rather than another
          picker: it is the question a reader came here with, and it should be one press. */}
      <div className="flex flex-wrap items-center gap-1 pt-3">
        {MATCHES.map((m) => (
          <button
            key={m.id}
            type="button"
            aria-pressed={match === m.id}
            onClick={() => setMatch(m.id)}
            className={cn(
              "h-8 rounded-md border px-3 text-sm transition-colors duration-150",
              "motion-reduce:transition-none",
              match === m.id
                ? "border-accent bg-accent/15 text-text"
                : "border-border bg-surface text-dim hover:text-text",
              FOCUS,
            )}
          >
            {m.label}
          </button>
        ))}
      </div>

      {figuresFailed ? (
        // Said out loud rather than folded into zeroes: the two are indistinguishable on screen
        // and only one of them is safe to trade on.
        <p role="status" className="pt-3 text-sm text-destructive">
          Your own collection and wishlist could not be read, so the figures below are missing
          rather than zero.
        </p>
      ) : (
        !figuresReady && (
          // The wait, named. Without this the chips look broken — pressed and narrowing nothing —
          // and the tiles look as though the reader owns none of a binder they may own half of.
          // It is the same absence the banner above reports, arriving for a better reason.
          <p role="status" className="pt-3 text-sm text-dim">
            Checking your collection and wishlist…
          </p>
        )
      )}

      <p className="pt-4 font-mono text-xs text-dim">
        {shownCopies === copies
          ? `${COUNT.format(copies)} ${copies === 1 ? "card" : "cards"}`
          : `${COUNT.format(shownCopies)} of ${COUNT.format(copies)} cards`}
      </p>

      {/* The want list's bar — mounted only once something is ticked, so a reader who is only
          browsing never sees a control they have no use for. It sits between the count and the
          wall because that is where the count it is about changes. */}
      {pickedCards.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-accent/40 bg-accent/10 px-3 py-2">
          <span className="font-mono text-sm">{COUNT.format(pickedCards.length)} picked</span>
          <button
            type="button"
            onClick={() => setSending(true)}
            className={cn(BUTTON, "ml-auto border-accent/50 text-accent")}
          >
            <Heart className="size-4" aria-hidden />
            Add to wishlist
          </button>
          <button
            type="button"
            onClick={() => setPicked(new Set())}
            className={cn(BUTTON, "border-border text-dim hover:text-text")}
          >
            Clear picks
          </button>
        </div>
      )}

      {report !== null && (
        // `status` and not `alert`: the region is mounted only when there is something to say,
        // but this one is the result of a press the reader has just made and watched.
        <p role="status" className="pt-3 text-sm text-dim">
          {report}
        </p>
      )}

      <AddToWishlist
        open={sending}
        cards={pickedCards}
        index={index}
        onClose={() => setSending(false)}
        onAdded={(said) => {
          setReport(said);
          // Put the picks down: a bar still reading *2 picked* over cards that are now on the
          // wishlist invites exactly the same press a second time, and `wishlist_add` folds.
          setPicked(new Set());
        }}
      />

      {shown.length === 0 ? (
        <p className="mt-8 text-sm text-dim">
          Nothing here matches. Widen the search, or pick another drawer.
        </p>
      ) : (
        <ul
          role="list"
          aria-label="Cards"
          className="mt-3 grid gap-3"
          // An inline template rather than an arbitrary Tailwind value: the class scanner reads
          // whole class names out of source text, and one built by interpolation emits no rule.
          style={{ gridTemplateColumns: "repeat(auto-fill, minmax(9.5rem, 1fr))" }}
        >
          {shown.map(({ card, key }) => (
            <SharedTile
              key={key}
              card={card}
              // `figuresReady` and not just `!figuresFailed`: a sweep that has not finished is
              // an absence exactly as a refused one is, and `EMPTY_INDEX` answers both with a
              // zero that reads as a fact.
              cross={figuresReady ? crossReference(card, index) : null}
              // **The tick is gated on the same answer the figure line is, and that is one gate
              // rather than a coincidence.** A want list built against `EMPTY_INDEX` would offer
              // to add cards the reader already wants and the dialog's already-wanted line would
              // say nothing was there — a silent double-add produced by a wait. `null` draws no
              // control at all rather than a disabled one: ten cards ticked and then found
              // unsendable is worse than no tick to make.
              picked={figuresReady ? picked.has(key) : null}
              onPick={() => toggle(key)}
              currency={currency}
              showValue={showValue}
              showCondition={showCondition}
              showLang={showLang}
            />
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * One copy in somebody else's binder, with the reader's own two figures under it.
 *
 * **`cardId` *and* `imageUrl`, and both are needed.** `cardArtSrc` picks between them by build:
 * the desktop app draws the picture out of its own image cache over `mtgimg://`, which is a
 * printing the reader's corpus almost certainly already has, and the web build draws the
 * `cards.scryfall.io` URL the snapshot carries. Passing only the URL — which is what the public
 * viewer does — would leave every frame in the shipped window empty.
 */
function SharedTile({
  card,
  cross,
  picked,
  onPick,
  currency,
  showValue,
  showCondition,
  showLang,
}: {
  card: ShareCard;
  /** `null` when the reader's own lists could not be read — an absent figure, not a zero. */
  cross: { own: number; want: number } | null;
  /** Whether this row is ticked, and `null` for a wall that may not be ticked at all — see the
   *  gate at the call site. */
  picked: boolean | null;
  onPick: () => void;
  currency: Currency;
  showValue: boolean;
  showCondition: boolean;
  showLang: boolean;
}) {
  const finish: Finish | null = isFinish(card.f) ? card.f : null;
  // A published copy *is* the finish it was stored as. `nonfoil` goes unmarked, which is the
  // app's rule everywhere.
  const marked = finish === "nonfoil" ? null : finish;
  const condition =
    card.c === undefined ? NOTHING : (CONDITION_LABEL[card.c as Condition] ?? card.c);

  return (
    <li
      className="group flex flex-col"
      style={cardScaleVars(DEFAULT_ZOOM)}
      // The list item's own name, so a tile can be addressed by the card in it. The picture's
      // `alt` says the name too; one repetition on a tile is cheaper than a wall of pictures
      // with no text at all.
      aria-label={
        card.n +
        (card.q > 1 ? `, ${card.q} copies` : "") +
        (cross === null ? "" : `. You own ${cross.own}, you want ${cross.want}`)
      }
    >
      <div className="relative">
        <CardArt cardId={card.id} name={card.n} imageUrl={card.img} finish={marked} />
        {picked !== null && (
          // Top-left, which is the corner this wall leaves free: the finish chip owns top-right
          // everywhere in the app and the copy count owns bottom-left here. Backed the same way
          // the count is, because a bare control on somebody's artwork reads as part of the art.
          <span className="absolute left-1 top-1 rounded bg-bg/85 px-1 py-0.5">
            <input
              type="checkbox"
              checked={picked}
              onChange={onPick}
              // Named for the card rather than "Select": every one of these is a checkbox in a
              // wall of checkboxes, and the accessible name is the only thing that tells them
              // apart. The verb is the bar's — *picked* — so one word carries the whole gesture.
              aria-label={`Pick ${card.n}`}
              className={cn("size-4 accent-accent", FOCUS)}
            />
          </span>
        )}
        {card.q > 1 && (
          <span className="absolute bottom-1 left-1 rounded bg-bg/85 px-1.5 py-0.5">
            <CountTag count={card.q} title={`${card.q} copies`} />
          </span>
        )}
      </div>
      <CardChin
        zoom={DEFAULT_ZOOM}
        // Rarity is not on the wire (spec §3's absences), so the gem says *unknown* rather than
        // being derived from a corpus this snapshot knows nothing about.
        rarity={null}
        setCode={card.s}
        collectorNumber={card.cn}
        finish={marked}
        // `undefined` rather than `null`: the chin draws no money slot for the first and an em
        // dash for the second, which is exactly the difference between "nobody asked" and
        // "nobody quoted". Both are live states here.
        money={showValue ? formatPrice(card.p ?? null, currency) : undefined}
        seam="art"
      />

      {cross !== null && (
        /* **Two spans, not one string joined by a middle dot.** Each figure has to be able to
           stand on its own — and a joined line reads as one word to anything that flattens it,
           which is how `Missing2` happened elsewhere in this app. */
        <span className="mt-1 flex items-baseline justify-between gap-2 text-[0.6875rem]">
          <span className={cn("font-mono", cross.own > 0 ? "text-text" : "text-dim")}>
            You own {cross.own}
          </span>
          <span className={cn("font-mono", cross.want > 0 ? "text-accent" : "text-dim")}>
            You want {cross.want}
          </span>
        </span>
      )}

      {(showCondition || showLang) && (
        <span className="mt-0.5 flex items-baseline gap-2 overflow-hidden text-[0.6875rem]">
          {showCondition && <span className="truncate text-dim">{condition}</span>}
          {showLang && (
            <span className="shrink-0 font-mono uppercase text-dim">{card.l ?? NOTHING}</span>
          )}
        </span>
      )}
    </li>
  );
}

/**
 * A native `<select>`, and deliberately not the app's `Dropdown`.
 *
 * ⚠️ **Every `value` here matches an option by construction.** A controlled `<select>` whose
 * value matches nothing does not draw blank — it silently reports the first row.
 */
function Picker({
  id,
  label,
  value,
  onPick,
  options,
}: {
  id: string;
  label: string;
  value: string;
  onPick: (value: string) => void;
  options: readonly { value: string; label: string }[];
}) {
  return (
    <>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onPick(e.target.value)}
        className={cn(
          "h-9 shrink-0 rounded-md border border-border bg-surface px-2 text-sm text-text",
          FOCUS,
        )}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </>
  );
}
