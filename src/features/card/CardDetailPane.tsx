import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FlipHorizontal2, X } from "lucide-react";
import { ManaText } from "@/components/ManaText";
import { CARD_ASPECT, cardImageUrl } from "@/lib/images";
import { ipc, ipcError, type CardDetail, type CardFace, type Printing } from "@/lib/ipc";
import { rarityColor } from "@/lib/rarity";
import { cn } from "@/lib/utils";
import {
  faceCount,
  finishPrice,
  groupByIllustration,
  legalityChips,
  parseFinishes,
  type Finish,
} from "./printings";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

const FINISH_LABEL: Record<Finish, string> = {
  nonfoil: "Nonfoil",
  foil: "Foil",
  etched: "Etched",
};

/**
 * How a finish is marked in the printings list, where there is no room for a word.
 *
 * Nonfoil is unmarked because it is the default a price is assumed to be; the two that
 * are not carry a letter, and the letter is an `<abbr>` so its full word is one hover — or
 * one screen reader — away.
 */
const FINISH_MARK: Record<Finish, string> = { nonfoil: "", foil: "F", etched: "E" };

/**
 * Keyboard focus, in the shape the rest of the app uses: an outline standing off the
 * control's edge, never a ring (see `FilterBar`'s `FOCUS` — outline is focus, border and
 * ring are state).
 */
const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

/**
 * The colour of a legality chip.
 *
 * `not_legal` is already dropped, so nearly every chip says "legal" — which makes legal
 * the *quiet* case and the exceptions the ones worth ink. Gold is the app's interactive
 * colour and is deliberately not spent here: twenty gold chips under the art would out-
 * shout the focus outline that has to mean something.
 */
const STATUS_CLASS: Record<string, string> = {
  legal: "border-border text-text",
  restricted: "border-border text-muted",
  banned: "border-destructive/40 text-destructive",
};

/**
 * One printing, in full: the card itself, every printing of the same oracle card grouped
 * by artwork, and the credit Scryfall's image policy requires.
 *
 * A docked pane rather than a modal. The results list behind it stays live and reachable,
 * so there is nothing to trap focus into and nothing to mark `aria-modal` — a dialog that
 * claims the page behind it is inert while it demonstrably is not is worse for a screen
 * reader than no dialog at all. It is also an ordinary element in the app's own tree
 * rather than a portal: the shipped CSP is `style-src 'self'`, and every overlay primitive
 * in reach pulls in `react-remove-scroll`, which injects a runtime `<style>` the moment it
 * opens — fine under `tauri dev`, a blank pane in a packaged build.
 *
 * What it does borrow from a dialog is the focus contract, hand-rolled here as in
 * `SetCombobox`: focus moves in when it opens, and Escape hands it back to whatever opened
 * it.
 */
export function CardDetailPane({ cardId, onClose }: { cardId: string; onClose: () => void }) {
  const [face, setFace] = useState(0);
  const [shown, setShown] = useState(cardId);
  const paneRef = useRef<HTMLElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  // A different card is a different card, and the back of the last one is not where a
  // reader wants to arrive. Reset during render — React's own answer to state that has to
  // follow a prop, and the same shape `CardGrid`'s tiles use: an effect would paint one
  // frame of the previous card's back face under the new card's name.
  if (shown !== cardId) {
    setShown(cardId);
    setFace(0);
  }

  // The scroll position is the DOM's, not React's, so it is reset where DOM writes belong.
  useEffect(() => {
    if (paneRef.current) paneRef.current.scrollTop = 0;
  }, [cardId]);

  // Once, on the way up: whatever had the caret is where Escape has to put it back.
  useEffect(() => {
    openerRef.current = document.activeElement as HTMLElement | null;
    paneRef.current?.focus();
  }, []);

  const close = useCallback(() => {
    const opener = openerRef.current;
    onClose();
    // Called before React flushes the close, while this pane still holds the focus: an
    // element that unmounts with the caret on it drops it to `<body>`, and the next Tab
    // restarts from the top of the app.
    if (opener?.isConnected) opener.focus();
  }, [onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  const card = useQuery({
    queryKey: ["card", cardId],
    queryFn: () => ipc.cardDetail(cardId),
  });

  const oracleId = card.data?.oracleId ?? null;
  const printings = useQuery({
    queryKey: ["card", "printings", oracleId],
    queryFn: () => ipc.cardPrintings(oracleId as string),
    // A reversible card has no `oracle_id` at all, so there is nothing to ask for.
    enabled: oracleId !== null,
  });

  return (
    <aside
      ref={paneRef}
      tabIndex={-1}
      aria-label="Card details"
      // A block that scrolls, not a flex column: in a column the art is a flex item, and a
      // pane shorter than the card would compress the image to fit rather than scroll —
      // which is the one thing Scryfall's usage rules forbid outright.
      className={cn(
        "w-96 shrink-0 space-y-4 overflow-y-auto rounded-lg border border-border bg-surface p-4",
        FOCUS,
      )}
    >
      <div className="flex items-start gap-2">
        {/* The pane's title, and the one place Cinzel is allowed below the ribbon: a card's
            name is the display line of the whole screen, set at the face's 18px floor so
            it announces the card without competing with the art under it. */}
        <h2 className="min-w-0 flex-1 font-heading text-lg leading-snug">
          {card.data?.name ?? (card.isPending ? "Loading…" : "Card")}
        </h2>
        <button
          type="button"
          onClick={close}
          aria-label="Close card details"
          className={cn(
            "shrink-0 rounded-md border border-border p-1 text-muted",
            "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
            FOCUS,
          )}
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>

      {card.isError && (
        <p role="alert" className="text-sm text-destructive">
          Could not read this card — {ipcError(card.error)}
        </p>
      )}

      {!card.isPending && !card.isError && card.data === null && (
        <p className="text-sm text-muted">
          This printing is not in the card database any more. It may have been removed by the last
          sync — close this and search again.
        </p>
      )}

      {card.data && (
        <>
          <Art card={card.data} face={face} onFlip={() => setFace((f) => (f === 0 ? 1 : 0))} />
          <Facts card={card.data} face={face} />
          <Legalities card={card.data} />
          <Printings
            items={printings.data?.items ?? []}
            total={printings.data?.total ?? 0}
            currentId={card.data.id}
            loading={printings.isPending && oracleId !== null}
            error={printings.isError ? ipcError(printings.error) : null}
          />
          {/* Not decoration and not optional: Scryfall requires the artist and the source
              to be identifiable in the same interface that shows the art. The artist is
              the one whose art is on screen — the two sides of a double-faced card are not
              always the same illustrator. */}
          <p className="border-t border-border pt-3 text-[0.7rem] leading-relaxed text-muted">
            {artistOf(card.data, face) && <>Illustrated by {artistOf(card.data, face)}. </>}
            Card images © Wizards of the Coast · Data © Scryfall
          </p>
        </>
      )}
    </aside>
  );
}

/** Who drew the side on screen, falling back to the card's own credit. */
function artistOf(card: CardDetail, face: number): string | null {
  return card.faces[face]?.artist ?? card.artist;
}

/**
 * The card, as big as the pane allows.
 *
 * The direction doc's one absolute: on a screen that has card art, the art is the loudest
 * thing on it. Everything below is 12–14px grey.
 */
function Art({ card, face, onFlip }: { card: CardDetail; face: number; onFlip: () => void }) {
  const sides = faceCount(card.layout, card.faces.length);
  const src = cardImageUrl(card.id, face, "display");
  // The src that failed, so a flip or a new card clears it without an effect.
  const [broken, setBroken] = useState<string | null>(null);
  const shown = card.faces[face];
  const other = card.faces[face === 0 ? 1 : 0];

  return (
    <div className="space-y-2">
      {broken === src ? (
        // A rate-limited image is a 503 the `<img>` cannot read, so this says what is known
        // rather than guessing: the card is still identified, and the way back is stated.
        <div
          style={{ aspectRatio: CARD_ASPECT }}
          className="flex w-full flex-col items-center justify-center gap-1 rounded-xl bg-bg px-6 text-center"
        >
          <span className="text-sm">{shown?.name || card.name}</span>
          <span className="text-xs text-muted">
            No image yet — it may still be downloading. Reopen the card to try again.
          </span>
        </div>
      ) : (
        <img
          // The name, not "card image": this is what a screen reader announces and what
          // shows if the fetch fails, and both readers want the card.
          alt={shown?.name || card.name}
          src={src}
          // A new face is a new image, so the fade is the flip: 150ms, the whole motion
          // budget, and gone entirely under `prefers-reduced-motion`. A 3D card turn would
          // be the biggest animation in an app whose only other one is the sync sweep.
          key={face}
          onError={() => setBroken(src)}
          decoding="async"
          style={{ aspectRatio: CARD_ASPECT }}
          // No filters and no crop: distorting, recolouring or cropping a card image is
          // forbidden by Scryfall's usage rules. `object-cover` on a 5:7 frame holding a
          // 5:7 image is a no-op that stays safe if the frame ever changes.
          className="w-full animate-in rounded-xl bg-bg object-cover fade-in duration-150 motion-reduce:animate-none"
        />
      )}
      {sides === 2 && (
        <button
          type="button"
          onClick={onFlip}
          className={cn(
            "flex w-full items-center justify-center gap-1.5 rounded-md border border-border",
            "py-1.5 text-xs text-muted transition-colors duration-150 hover:text-text",
            "motion-reduce:transition-none",
            FOCUS,
          )}
        >
          <FlipHorizontal2 className="size-3.5" aria-hidden="true" />
          Flip to {other?.name || "the other face"}
        </button>
      )}
    </div>
  );
}

/**
 * What the card says, and what it costs.
 *
 * Which faces are printed here is a layout question, not a face-count one: a `transform`
 * shows the side on screen and swaps with the flip control, while a `split` shows both
 * halves at once because both are printed on the one side the image is of.
 */
function Facts({ card, face }: { card: CardDetail; face: number }) {
  const finishes = parseFinishes(card.finishes);
  const sides = faceCount(card.layout, card.faces.length);
  const faces: CardFace[] =
    card.faces.length === 0
      ? [
          {
            name: "",
            typeLine: card.typeLine,
            oracleText: card.oracleText,
            manaCost: card.manaCost,
            artist: card.artist,
          },
        ]
      : sides === 2
        ? [card.faces[face] ?? card.faces[0]]
        : card.faces;

  return (
    <div className="space-y-3">
      {/* Provenance, in the data face: set, collector number, printing language. */}
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
        <span className="font-mono" title={card.setName ?? undefined}>
          {card.setCode.toUpperCase()} · {card.collectorNumber}
        </span>
        {card.setName && <span className="min-w-0 truncate">{card.setName}</span>}
        {card.lang !== "en" && <LangBadge lang={card.lang} />}
        {card.rarity && (
          // Tinted text with a gem, never a filled badge: the colour budget is spent on
          // mana and art, and a rarity is a footnote. The word is here rather than only the
          // dot because the dot is the thing a screen reader cannot see.
          <span
            className="inline-flex items-center gap-1 capitalize"
            style={{ color: rarityColor(card.rarity) }}
          >
            <span
              aria-hidden="true"
              className="size-1.5 rounded-full"
              style={{ backgroundColor: rarityColor(card.rarity) }}
            />
            <span className="sr-only">Rarity: </span>
            {card.rarity}
          </span>
        )}
      </p>

      {faces.map((f, i) => (
        <div key={i} className="space-y-1">
          <div className="flex items-baseline justify-between gap-2 text-sm">
            <span className="min-w-0">
              {/* Named only when both halves are on screen at once — otherwise the pane's
                  own heading already carries the name. */}
              {faces.length > 1 && f.name && <span className="mr-1.5 font-medium">{f.name}</span>}
              <span className="text-muted">{f.typeLine ?? "—"}</span>
            </span>
            <ManaText source={f.manaCost} className="shrink-0" />
          </div>
          {f.oracleText && (
            <p className="whitespace-pre-line text-sm leading-relaxed">
              {/* `inline`, not the component's default `inline-flex`: rules text wraps, and
                  a flex run of it would be one unbreakable line. */}
              <ManaText source={f.oracleText} className="inline" />
            </p>
          )}
        </div>
      ))}

      {finishes.length > 0 && (
        <>
          <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
            {finishes.map((f) => (
              <div key={f} className="flex items-baseline gap-1.5">
                <dt className="text-muted">{FINISH_LABEL[f]}</dt>
                <dd className="font-mono tabular-nums">{price(finishPrice(card.prices, f))}</dd>
              </div>
            ))}
          </dl>
          {/* Spec §5: a price is never shown without saying how old it is. The ribbon
              carries the date of the data these came in with. */}
          <p className="text-[0.7rem] text-muted">Prices as of the last card-data sync.</p>
        </>
      )}
    </div>
  );
}

/** The two-letter printing language, shown only when it is not the assumed one. */
function LangBadge({ lang }: { lang: string }) {
  return (
    <span className="rounded border border-border px-1 font-mono text-[0.65rem] uppercase leading-4">
      <span className="sr-only">Language: </span>
      {lang}
    </span>
  );
}

function Legalities({ card }: { card: CardDetail }) {
  const chips = legalityChips(card.legalities);
  if (chips.length === 0) return null;
  return (
    <ul aria-label="Format legality" className="flex flex-wrap gap-1">
      {chips.map(({ format, status }) => (
        <li
          key={format}
          className={cn(
            "rounded-full border px-2 py-0.5 text-[0.7rem] capitalize",
            STATUS_CLASS[status] ?? "border-border text-muted",
          )}
        >
          {format}
          {/* Never colour alone: a banned chip says "banned". "Legal" is the case that
              needs no ink, so its word is there for a screen reader and nowhere else.
              `lowercase` undoes the chip's `capitalize`, which would otherwise make it
              "Commander Banned" — sentence case is the app's voice. */}
          <span className={status === "legal" ? "sr-only" : "ml-1 lowercase opacity-80"}>
            {status}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Every printing of this card, grouped by the artwork it carries.
 *
 * Grouped by illustration rather than listed flat because "which art is this?" is the
 * question a printings list is asked — and the group's heading is its *illustrator*,
 * which is a name the reader can check against the card, rather than "Artwork 2", which
 * is a number invented here.
 */
function Printings({
  items,
  total,
  currentId,
  loading,
  error,
}: {
  items: Printing[];
  total: number;
  currentId: string;
  loading: boolean;
  error: string | null;
}) {
  const headingId = useId();
  // A reversible card has no `oracle_id`, so it has no printings list to fail at loading:
  // nothing to say, and no empty section to say it in.
  if (!loading && !error && items.length === 0) return null;

  const groups = groupByIllustration(items);
  return (
    // The rule separates "this card" from "every card like it", which is the pane's one
    // real division. Set in the same hairline as the credit line below it rather than a
    // heavier rule: three sections, two hairlines, no boxes. The heading is rendered while
    // the list is still loading so the pane does not reflow around it when it arrives.
    <section aria-labelledby={headingId} className="space-y-2 border-t border-border pt-3">
      <h3 id={headingId} className="text-xs uppercase tracking-wide text-muted">
        Printings
      </h3>
      {loading && <p className="text-xs text-muted">Loading printings…</p>}
      {error && (
        <p className="text-xs text-destructive">
          Could not read the other printings — {error}. The card above is unaffected.
        </p>
      )}
      {/* A count line, so it is set in the data face. `items.length` is capped at 400 and
          `total` is not — saying only the first would report a Forest as having 400
          printings when it has 862. */}
      {items.length > 0 && (
        <p className="font-mono text-[0.7rem] tabular-nums text-muted">
          {items.length < total
            ? `${items.length} of ${total} printings`
            : `${total} printing${total === 1 ? "" : "s"}`}
          {" · "}
          {groups.length} artwork{groups.length === 1 ? "" : "s"}
        </p>
      )}
      {groups.map((group, i) => (
        <div key={group.illustrationId ?? `ungrouped-${i}`} className="space-y-0.5">
          <p className="flex items-baseline gap-1.5 pt-1 text-[0.7rem] text-muted">
            <span className="min-w-0 truncate">
              {group.printings[0].artist ?? "Artist unknown"}
            </span>
            <span className="font-mono tabular-nums">· {group.printings.length}</span>
          </p>
          <ul className="space-y-0.5">
            {group.printings.map((p) => (
              <PrintingRow key={p.id} printing={p} current={p.id === currentId} />
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

function PrintingRow({ printing, current }: { printing: Printing; current: boolean }) {
  return (
    <li
      className={cn(
        "flex items-baseline gap-2 rounded-md px-2 py-1 text-xs",
        // The one printing this pane is about. A gold hairline down its edge rather than a
        // fill: gold means "here" everywhere else in the app, and a filled row in a list of
        // forty would be the brightest thing under the art.
        current ? "border-l-2 border-accent bg-bg pl-1.5 text-text" : "text-muted",
      )}
    >
      <span
        aria-hidden="true"
        title={printing.rarity ?? undefined}
        className="size-1.5 shrink-0 translate-y-px rounded-full"
        style={{ backgroundColor: rarityColor(printing.rarity) }}
      />
      <span className="min-w-0 flex-1 truncate font-mono" title={printing.setName ?? undefined}>
        {printing.setCode.toUpperCase()} · {printing.collectorNumber}
        {printing.releasedAt && <> · {printing.releasedAt.slice(0, 4)}</>}
      </span>
      {printing.lang !== "en" && <LangBadge lang={printing.lang} />}
      {/* Per finish, from the blob — never one number standing for both. */}
      {parseFinishes(printing.finishes).map((f) => (
        <span key={f} className="shrink-0 font-mono tabular-nums">
          {FINISH_MARK[f] && (
            <abbr title={FINISH_LABEL[f]} className="mr-0.5 text-[0.65rem] text-muted no-underline">
              {FINISH_MARK[f]}
            </abbr>
          )}
          {price(finishPrice(printing.prices, f))}
        </span>
      ))}
    </li>
  );
}

/** A price, or an em dash. Never `$0.00`, which is a price nobody quoted. */
function price(value: number | null): string {
  return value === null ? "—" : usd.format(value);
}
