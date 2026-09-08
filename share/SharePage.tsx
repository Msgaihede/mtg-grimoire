import { Component, useMemo, useState, type ErrorInfo, type ReactNode } from "react";
import { GrimoireMark } from "@/components/GrimoireMark";
import { ManaLine } from "@/components/ManaLine";
import { CONDITION_LABEL, CONDITIONS, type Condition } from "@/lib/conditions";
import { FINISH_LABEL, FINISHES, type Finish } from "@/lib/finish";
import { FOCUS } from "@/lib/focus";
import { LAYER } from "@/lib/layers";
import { type Currency, resolveMarketplace } from "@/lib/marketplace";
import { formatPrice } from "@/lib/prices";
import type { ShareCard, ShareFolder, ShareSnapshot } from "@/lib/shareSnapshot";
import { cn } from "@/lib/utils";
import { ShareTile } from "./ShareTile";

/**
 * The one sentence the app owes every reader of this page, and it is a **spec requirement rather
 * than copy** (§5.1): the relay stores a share snapshot in the clear, by decision, so the
 * privacy claim is *"anyone with the link"* — never "private", never "encrypted".
 *
 * Word for word the shell's own `<noscript>` (`share-worker/src/page.ts`), so a reader with
 * scripting off and one with it on are told the same thing.
 */
export const READ_ONLY_NOTICE =
  "This is a read-only snapshot. Anyone with this link can see it.";

/**
 * Metadata posted, blob never uploaded — the state a publish that died between its two steps
 * leaves behind (spec §4.1), and the reason a **missing** `<link id="snapshot">` is not an error.
 *
 * The Worker already renders this sentence outside `#root` for a reader with no JavaScript; this
 * page draws it in the app's own chrome and takes that fallback out of the document, so it is
 * never said twice.
 */
export const SNAPSHOT_PENDING = "This shared collection is not ready yet.";

/** The blob did not arrive at all — the network, or an R2 object the D1 row outlived. */
export const SNAPSHOT_OFFLINE = "This shared collection could not be loaded.";

/**
 * Where the snapshot is, read out of the shell rather than guessed.
 *
 * `share-worker/src/page.ts` inlines the blob's **immutable** URL as
 * `<link id="snapshot" rel="preload" as="fetch" crossorigin href="/s/{id}/{hash}.json.gz">`,
 * built from the same D1 row that rendered the page. There is no `/s/{id}/index.json` route to
 * fall back to and there must not be one: it would spend a second Worker request, on the free
 * plan's per-account 100,000/day, to learn a fact the first response was already holding.
 *
 * **`null` is a state, not a failure.** The shell emits no link when the row has no
 * `object_key`, so its absence *is* the "not ready yet" signal.
 */
export function snapshotHref(doc: Document): string | null {
  const link = doc.getElementById("snapshot");
  if (link === null || link.tagName !== "LINK") return null;
  const href = (link as HTMLLinkElement).href;
  return href === "" ? null : href;
}

/**
 * **`parseSnapshot` guarantees `v`, `folders` and `cards`, and nothing else — by design.**
 *
 * Its own header says why: a per-field validator there would be a fourth implementation of the
 * format, free to disagree with the writer and both readers. So every *other* field this page
 * reads is checked here, at the one place that reads it, and the answer for a missing one is the
 * binder minus that column rather than a refusal. A body that parses but omits `currency` used to
 * throw inside this function **during render**, where `boot`'s `try` cannot reach it — and a
 * throw out of `root.render` is a blank page, not a notice.
 */
function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Which currency the prices on the wire are in. The snapshot's own answer wins. */
function shareCurrency(snapshot: ShareSnapshot): Currency {
  const named = asText(snapshot.currency).toLowerCase();
  if (named === "usd" || named === "eur") return named;
  // A currency this build does not know is a snapshot from a future one; the marketplace it was
  // priced at is the better guess than a hard-coded dollar.
  return resolveMarketplace(snapshot.marketplace).currency;
}

/** `1,204` — the grouping every count on this page gets, and prices never (that is `formatPrice`). */
const COUNT = new Intl.NumberFormat("en-US");

/**
 * `8 September 2025`, in the reader's own locale.
 *
 * The stamp is **seconds** — `updatedAt` is a unix time, like every other timestamp this repo
 * puts on a wire — and reading it as milliseconds dates every share ever published to 1970.
 */
function asOf(updatedAt: number): string | null {
  if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) return null;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "long" }).format(
    new Date(updatedAt * 1000),
  );
}

/**
 * The condition picker's row for "the reader asked for **ungraded**", which is an absence rather
 * than a value.
 *
 * A `<select>` speaks only strings, so the absence needs one — and it must be a string no
 * condition code can ever be. `CONDITIONS` are two- and three-letter codes (`NM`, `DMG`), so the
 * underscores are the whole of the guarantee. It was one invisible character for an hour, which
 * made `grep` call this file binary and told nobody why.
 */
const UNGRADED = "__ungraded";

interface FolderNode extends ShareFolder {
  depth: number;
  /** Cards in this drawer **and every drawer beneath it** — one number, so a rail row cannot lie. */
  count: number;
}

/**
 * The drawers, flattened depth-first with a recursive count on each.
 *
 * A non-null `parent` always resolves within `folders` (the format's third documented absence),
 * so on a document the writer produced the roots are exactly the `null` ones. Neither half of
 * that is *guaranteed* — `parseSnapshot` says nothing about this graph on purpose — so a dangling
 * edge is re-rooted above and a cycle is caught twice: `seen` stops the walk running forever, and
 * the sweep at the end is what stops a drawer inside the loop from vanishing.
 */
function folderRail(snapshot: ShareSnapshot): FolderNode[] {
  const uids = new Set(snapshot.folders.map((f) => f.uid));
  const children = new Map<string | null, ShareFolder[]>();
  for (const folder of snapshot.folders) {
    // A `parent` the snapshot does not carry is a drawer shared out of the middle of somebody's
    // cabinet: the format promises the edge resolves *within* `folders` or is null, and a
    // document that breaks that promise gets a root rather than a card nobody can reach.
    const key = folder.parent !== null && uids.has(folder.parent) ? folder.parent : null;
    const kin = children.get(key);
    if (kin === undefined) children.set(key, [folder]);
    else kin.push(folder);
  }

  const own = new Map<string, number>();
  for (const card of snapshot.cards)
    if (card.fo !== null) own.set(card.fo, (own.get(card.fo) ?? 0) + card.q);

  const rail: FolderNode[] = [];
  const seen = new Set<string>();
  const visit = (folder: ShareFolder, depth: number): number => {
    // `seen` is what makes a cycle impossible rather than merely unlikely: a drawer is drawn
    // once and the walk stops there instead of running forever.
    if (seen.has(folder.uid)) return 0;
    seen.add(folder.uid);
    const node: FolderNode = { ...folder, depth, count: 0 };
    rail.push(node);
    node.count = (own.get(folder.uid) ?? 0) + walk(folder.uid, depth + 1);
    return node.count;
  };
  const walk = (parent: string | null, depth: number): number => {
    let total = 0;
    for (const folder of children.get(parent) ?? []) total += visit(folder, depth);
    return total;
  };
  walk(null, 0);
  // **Whatever the walk did not reach is a root too, and this line is the difference between a
  // malformed document losing a drawer and merely mis-nesting one.** A cycle has no root at all —
  // every folder in it names a parent that *resolves* — so a walk from `null` finds none of them
  // and the rail silently loses every drawer in the loop along with the way to the cards inside
  // it. `parseSnapshot` promises nothing about this graph by design, and this page parses a
  // document it did not write; a drawer that vanishes without a word is worse than one drawn at
  // the wrong depth. Nothing the current writer can produce reaches this loop.
  for (const folder of snapshot.folders) visit(folder, 0);
  return rail;
}

/** Every drawer at or beneath `uid` — what "show me this folder" actually means to a reader. */
function subtree(rail: FolderNode[], uid: string): Set<string> {
  const index = rail.findIndex((f) => f.uid === uid);
  const kept = new Set([uid]);
  if (index === -1) return kept;
  for (let i = index + 1; i < rail.length && rail[i].depth > rail[index].depth; i += 1)
    kept.add(rail[i].uid);
  return kept;
}

type Sort = "name" | "set" | "price" | "quantity";

export function SharePage({ snapshot }: { snapshot: ShareSnapshot }) {
  const [folder, setFolder] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [finish, setFinish] = useState<Finish | "">("");
  const [condition, setCondition] = useState("");
  const [sort, setSort] = useState<Sort>("name");

  const currency = shareCurrency(snapshot);
  const market = resolveMarketplace(snapshot.marketplace);
  // Guarded for `asText`'s reason: `fields` is not one of the three keys `parseSnapshot`
  // promises, and an absent one means "the publisher answered no optional question" rather than
  // a document nobody can open.
  const fields = Array.isArray(snapshot.fields) ? snapshot.fields : [];
  const showValue = fields.includes("value");
  const showCondition = fields.includes("condition");
  const showLang = fields.includes("lang");
  const owner = asText(snapshot.owner);
  // A heading with no text is a heading nothing announces, so the fallback is a name rather than
  // an empty string. It is what the Worker's own 404 page calls this, one word shorter.
  const title = asText(snapshot.title) || "Shared collection";
  const stamp = asOf(snapshot.updatedAt);

  const rail = useMemo(() => folderRail(snapshot), [snapshot]);
  const copies = useMemo(() => snapshot.cards.reduce((n, c) => n + c.q, 0), [snapshot]);
  const worth = useMemo(
    () => snapshot.cards.reduce((sum, c) => sum + (c.p ?? 0) * c.q, 0),
    [snapshot],
  );
  /**
   * Copies the marketplace quoted nothing for.
   *
   * Said beside the figure rather than folded into it, which is the app's own rule: a total that
   * silently omitted them would read as the binder being worth less than it is, and there is no
   * second marketplace to reach for — a `null` price is the answer.
   */
  const unquoted = useMemo(
    () => snapshot.cards.reduce((n, c) => n + (c.p === undefined ? c.q : 0), 0),
    [snapshot],
  );

  /** The finishes actually on the wire. A control offering one the binder has none of narrows to nothing. */
  const finishes = useMemo(
    () => FINISHES.filter((f) => snapshot.cards.some((c) => c.f === f)),
    [snapshot],
  );
  /** Likewise for grades, plus the ungraded row when any copy carries no `c` at all. */
  const grades = useMemo(() => {
    const present = CONDITIONS.filter((c) => snapshot.cards.some((card) => card.c === c));
    return snapshot.cards.some((c) => c.c === undefined) ? [...present, UNGRADED] : present;
  }, [snapshot]);

  /**
   * The cards paired with **their position in the snapshot's own array**, which is this page's
   * only unique key.
   *
   * ⚠️ **Nothing about a card identifies it.** A row is a printing, a finish, a folder and a
   * grade, and none of that is a key: two rows of one binder can agree on every one of them and
   * differ in a column this page does not draw. `{id}:{finish}:{folder}:{condition}` looked
   * unique and was not — measured in the running page 2026-09-08, where React reported *two
   * children with the same key* and reserves the right to drop one of them. The index is stable
   * because `snapshot` is immutable: filtering and sorting derive from this list rather than
   * replacing it.
   */
  const rows = useMemo(
    () => snapshot.cards.map((card, index) => ({ card, key: String(index) })),
    [snapshot],
  );

  const shown = useMemo(() => {
    const drawer = folder === null ? null : subtree(rail, folder);
    const needle = text.trim().toLowerCase();
    const matches = (card: ShareCard) =>
      needle === "" ||
      card.n.toLowerCase().includes(needle) ||
      card.s.toLowerCase().includes(needle) ||
      card.cn.toLowerCase().includes(needle);

    const kept = rows.filter(
      ({ card }) =>
        (drawer === null || (card.fo !== null && drawer.has(card.fo))) &&
        matches(card) &&
        (finish === "" || card.f === finish) &&
        (condition === "" ||
          (condition === UNGRADED ? card.c === undefined : card.c === condition)),
    );

    const by: Record<Sort, (a: ShareCard, b: ShareCard) => number> = {
      name: (a, b) => a.n.localeCompare(b.n) || a.s.localeCompare(b.s),
      set: (a, b) =>
        a.s.localeCompare(b.s) || a.cn.localeCompare(b.cn, undefined, { numeric: true }),
      // Unquoted last, always: a card the marketplace never listed is not the cheapest one.
      price: (a, b) => (b.p ?? -1) - (a.p ?? -1),
      quantity: (a, b) => b.q - a.q || a.n.localeCompare(b.n),
    };
    return kept.sort((a, b) => by[sort](a.card, b.card));
  }, [rows, rail, folder, text, finish, condition, sort]);

  /** Copies rather than rows, so the wall's figure and the rail's counts are the same unit. */
  const shownCopies = useMemo(() => shown.reduce((n, r) => n + r.card.q, 0), [shown]);

  const filtered = text !== "" || finish !== "" || condition !== "";
  const reset = () => {
    setText("");
    setFinish("");
    setCondition("");
  };

  return (
    <div className="flex min-h-dvh flex-col bg-bg text-text">
      <Ribbon />
      <div className="mx-auto w-full max-w-[84rem] px-5 pb-20 sm:px-8">
        <header className="border-b border-border py-8">
          {/* The owner above the binder's name rather than beside it: the issue asks that a
              stranger be able to see whose collection this is, and a line of its own answers
              that before the title is read. */}
          {/* A `ch` cap would be measured in the h1's own inherited size and not in Cinzel's, so
              a two-word title wrapped at 1280 the first time this was drawn in a browser. */}
          {/* ⚠️ **The `aria-label` is the whole of the accessible name, and it is not
              decoration.** The two spans below are `block`, and name computation concatenates
              them with **nothing** between — `block` is a layout fact and the accname spec does
              not read layout — so the first thing a screen reader announced on this page was
              `Giradeli’sTrade binder`. That is this repo's own `Missing2` bug
              (`css-gap-breaks-the-accessible-name`), arriving on the one page strangers open.
              A trailing space inside the first span does **not** fix it: name computation trims
              each element's contribution before appending it, measured here 2026-09-08. So the
              phrase is spelled once, from the same two strings the spans draw, and
              `SharePage.test.tsx` asserts the **computed name** rather than the two texts —
              asserting the parts is exactly what let this ship. */}
          <h1
            className="max-w-[34rem]"
            aria-label={owner === "" ? title : `${owner}’s ${title}`}
          >
            {owner !== "" && <span className="block text-sm text-dim">{owner}’s</span>}
            <span className="block font-heading text-[1.75rem] leading-tight sm:text-[2.125rem]">
              {title}
            </span>
          </h1>
          <p className="mt-4 font-mono text-[0.8125rem] text-dim">
            {COUNT.format(copies)} {copies === 1 ? "card" : "cards"}
            {rail.length > 0 &&
              ` in ${COUNT.format(rail.length)} ${rail.length === 1 ? "drawer" : "drawers"}`}
            {stamp !== null && `, as of ${stamp}`}
          </p>
          <p className="mt-1 font-mono text-[0.8125rem] text-dim">
            {showValue
              ? `Worth ${formatPrice(worth, currency)} at ${market.label} prices` +
                (unquoted > 0 ? `, with ${COUNT.format(unquoted)} unquoted` : "")
              : "Prices were not shared"}
          </p>
          <p className="mt-5 max-w-[54ch] text-sm text-dim">{READ_ONLY_NOTICE}</p>
        </header>

        <div className="flex flex-col gap-8 pt-6 md:flex-row md:gap-10">
          {rail.length > 0 && (
            <nav className="md:w-52 md:shrink-0">
              <ul role="list" aria-label="Folders" className="flex flex-col gap-px">
                <RailRow
                  name="All cards"
                  count={copies}
                  depth={0}
                  active={folder === null}
                  onPick={() => setFolder(null)}
                />
                {rail.map((node) => (
                  <RailRow
                    key={node.uid}
                    name={node.name}
                    count={node.count}
                    depth={node.depth + 1}
                    active={folder === node.uid}
                    onPick={() => setFolder(node.uid)}
                  />
                ))}
              </ul>
            </nav>
          )}

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <label htmlFor="share-text" className="sr-only">
                Search this collection
              </label>
              <input
                id="share-text"
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
              {finishes.length > 1 && (
                <div className="flex flex-wrap items-center gap-1">
                  <Chip pressed={finish === ""} onPick={() => setFinish("")}>
                    All finishes
                  </Chip>
                  {finishes.map((f) => (
                    <Chip key={f} pressed={finish === f} onPick={() => setFinish(f)}>
                      {FINISH_LABEL[f]}
                    </Chip>
                  ))}
                </div>
              )}
              {showCondition && grades.length > 0 && (
                <Picker
                  id="share-condition"
                  label="Condition"
                  value={condition}
                  onPick={setCondition}
                  options={[
                    { value: "", label: "Any condition" },
                    ...grades.map((g) => ({
                      value: g,
                      label: g === UNGRADED ? "Not graded" : (CONDITION_LABEL[g as Condition] ?? g),
                    })),
                  ]}
                />
              )}
              <Picker
                id="share-sort"
                label="Sort"
                value={sort}
                onPick={(v) => setSort(v as Sort)}
                options={[
                  { value: "name", label: "Name" },
                  { value: "set", label: "Set" },
                  ...(showValue ? [{ value: "price", label: "Price" }] : []),
                  { value: "quantity", label: "Copies" },
                ]}
              />
              {filtered && (
                <button
                  type="button"
                  onClick={reset}
                  className={cn(
                    "h-9 shrink-0 rounded-md border border-accent/50 px-3 text-sm text-accent",
                    "transition-colors duration-150 hover:bg-accent/10 motion-reduce:transition-none",
                    FOCUS,
                  )}
                >
                  Reset all
                </button>
              )}
            </div>

            {/* Copies, like the rail's counts and the header's — a wall that said "32" beside a
                rail saying "62" is one list measured two ways. */}
            <p className="mt-4 font-mono text-xs text-dim">
              {shownCopies === copies
                ? `${COUNT.format(copies)} ${copies === 1 ? "card" : "cards"}`
                : `${COUNT.format(shownCopies)} of ${COUNT.format(copies)} cards`}
            </p>

            {shown.length === 0 ? (
              <p className="mt-8 text-sm text-dim">
                Nothing here matches. Widen the search, or pick another drawer.
              </p>
            ) : (
              <ul
                role="list"
                aria-label="Cards"
                className="mt-3 grid gap-3"
                // An inline template rather than an arbitrary Tailwind value: the class scanner
                // reads whole class names out of source text, and a template built by
                // interpolation emits no rule at all.
                style={{ gridTemplateColumns: "repeat(auto-fill, minmax(9.5rem, 1fr))" }}
              >
                {shown.map(({ card, key }) => (
                  <ShareTile
                    key={key}
                    card={card}
                    currency={currency}
                    showValue={showValue}
                    showCondition={showCondition}
                    showLang={showLang}
                  />
                ))}
              </ul>
            )}

            <p className="mt-12 max-w-[54ch] text-xs text-dim">
              A snapshot does not change on its own. This page will show these cards until the
              collection is published again.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The app's own ribbon, at the app's own height, carrying the one signature this design has.
 *
 * The mana line is 2px of W→U→B→R→G and appears **once** on any screen that draws it. It is what
 * makes a page opened from a Discord link recognisably the same program the binder was kept in.
 */
function Ribbon() {
  return (
    <div className={cn("sticky top-0", LAYER.header)}>
      <div className="flex h-14 items-center gap-3 bg-surface px-5 sm:px-8">
        <GrimoireMark size={26} label="MTG Grimoire" />
        <span className="font-heading text-lg">MTG Grimoire</span>
        <span className="ml-auto hidden text-sm text-dim sm:inline">A shared collection</span>
      </div>
      <ManaLine sync={null} />
    </div>
  );
}

function RailRow({
  name,
  count,
  depth,
  active,
  onPick,
}: {
  name: string;
  count: number;
  depth: number;
  active: boolean;
  onPick: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onPick}
        aria-current={active ? "true" : undefined}
        style={{ paddingLeft: `${0.75 + depth * 0.75}rem` }}
        className={cn(
          "flex w-full items-center gap-2 rounded-md border-l-2 py-1.5 pr-2 text-left text-sm",
          "transition-colors duration-150 motion-reduce:transition-none",
          active
            ? "border-accent bg-surface text-text"
            : "border-transparent text-dim hover:bg-surface/60 hover:text-text",
          FOCUS,
        )}
      >
        <span className="min-w-0 flex-1 truncate">{name}</span>
        <span className="shrink-0 font-mono text-xs tabular-nums">{COUNT.format(count)}</span>
      </button>
    </li>
  );
}

function Chip({
  pressed,
  onPick,
  children,
}: {
  pressed: boolean;
  onPick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onPick}
      className={cn(
        "h-9 rounded-md border px-3 text-sm transition-colors duration-150",
        "motion-reduce:transition-none",
        pressed
          ? "border-accent bg-accent/15 text-text"
          : "border-border bg-surface text-dim hover:text-text",
        FOCUS,
      )}
    >
      {children}
    </button>
  );
}

/**
 * A native `<select>`, and deliberately not the app's `Dropdown`.
 *
 * That component belongs to `features/` — which this bundle may not reach — and everything it
 * buys (a searchable list, option counts, a popup that escapes a virtualised row) answers a
 * question this page does not have. A native control is also the one a phone renders as its own
 * wheel, which on a link opened from a chat app is most of the traffic.
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

/**
 * Every state that is not a binder: not ready yet, could not be loaded, and the four sentences
 * `parseSnapshot` throws.
 *
 * **The chrome is the same one the cards get.** A stranger who followed a link and met an
 * unstyled sentence has no way to tell a share that is a few seconds early from a page that is
 * broken; the ribbon and the mana line are what say the link reached the right place.
 */
export function ShareNotice({ sentence, detail }: { sentence: string; detail?: string }) {
  return (
    <div className="flex min-h-dvh flex-col bg-bg text-text">
      <Ribbon />
      {/* The same container the binder gets, so the sentence starts under the app mark rather
          than floating in the middle of a page with a left-aligned ribbon. */}
      <div className="mx-auto w-full max-w-[84rem] px-5 py-16 sm:px-8">
        {/* Cinzel, because this sentence *is* the page — the direction's "view title or hero",
            never body text and never below 18px. 22px over ~38 characters puts the longest of
            the five (`SNAPSHOT_UNREADABLE`, two clauses) on three lines rather than one banner
            across the window. */}
        <p className="max-w-[38ch] font-heading text-[1.375rem] leading-snug">{sentence}</p>
        {detail !== undefined && <p className="mt-4 max-w-[54ch] text-sm text-dim">{detail}</p>}
      </div>
    </div>
  );
}

/** What a reader is told when this page threw where nothing could catch it. */
export const SNAPSHOT_UNDRAWABLE = "This shared collection could not be drawn.";

/**
 * **The floor under every field this page reads, and the reason it is a boundary rather than more
 * guards.**
 *
 * `parseSnapshot` promises `v`, `folders` and `cards` and deliberately nothing else, so every
 * other read is a guess about a document written by a build that may be newer than this one. The
 * named ones are guarded at their own site (`asText`, `asOf`, the `fields` check) and that is the
 * better answer where it applies — a binder minus one column beats a sentence.
 *
 * This catches the rest. A throw during render escapes `boot`'s `try` entirely: `root.render` is
 * asynchronous in React 19, so the exception surfaces from a commit the `await` chain has already
 * left. What a stranger got was a **blank page** — no sentence, no chrome, nothing to report. One
 * class component is the whole of the fix, and it is the only class in this bundle.
 */
export class ShareBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // The only place this is ever recorded — there is no `error_log` on a page with no core.
    console.error(error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <ShareNotice
        sentence={SNAPSHOT_UNDRAWABLE}
        detail="The link is good; this page could not read what it points at. Reload, or ask for the link again."
      />
    );
  }
}
