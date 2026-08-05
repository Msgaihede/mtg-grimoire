import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FlipHorizontal2, X } from "lucide-react";
import { ManaText } from "@/components/ManaText";
import { RarityGem } from "@/components/RarityGem";
import { AddToCollectionButton, REVEAL_ON_HOVER } from "@/features/collection/AddToCollection";
import { FINISH_LABEL, FINISH_MARK, finishPrice, parseFinishes } from "@/lib/finish";
import { CARD_ASPECT, cardImageUrl } from "@/lib/images";
import { ipc, ipcError, type CardDetail, type CardFace, type Printing } from "@/lib/ipc";
import { PRICES_AS_OF, usdPrice } from "@/lib/prices";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { cn } from "@/lib/utils";
import { faceCount, groupByIllustration, legalityChips } from "./printings";

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
  restricted: "border-border text-dim",
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

  // The outer layer: bubble phase, and it yields to any control open over the results —
  // the set filter's listbox, anything later — that consumed the press from the capture
  // phase. Without that the pane closes underneath such a control on the same press, and
  // the two focus hand-backs fight over where the caret lands. See `useDismissOnEscape`.
  useDismissOnEscape({ layer: "outer", onDismiss: close });

  const card = useQuery({
    queryKey: ["card", cardId],
    queryFn: () => ipc.cardDetail(cardId),
  });

  const oracleId = card.data?.oracleId ?? null;
  const printings = useQuery({
    queryKey: ["card", "printings", oracleId],
    queryFn: () => ipc.cardPrintings(oracleId as string),
    // `oracleId` is nullable on the wire, so there is a state with nothing to ask for.
    //
    // It is *not* the reversible-card state, whatever the comment here used to say:
    // Scryfall omits only the top-level `oracle_id` on those, and `card_row` falls back to
    // `card_faces[0]`, so the column is filled. 0 of 116,568 live rows are null, all 81
    // reversible printings included. This gate is a fence around the type, not around a
    // card — which is why the section below renders nothing instead of explaining itself.
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
        {/* The card's name is content, not a section header, so it stays in Geist —
            Cinzel is for view titles and hero copy, and never below 18px. */}
        <h2 className="min-w-0 flex-1 text-base font-medium">
          {card.data?.name ?? (card.isPending ? "Loading…" : "Card")}
        </h2>
        <button
          type="button"
          onClick={close}
          aria-label="Close card details"
          className={cn(
            "shrink-0 rounded-md border border-border p-1 text-dim",
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
        <p className="text-sm text-dim">
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
            card={card.data}
            items={printings.data?.items ?? []}
            total={printings.data?.total ?? 0}
            loading={printings.isPending && oracleId !== null}
            error={printings.isError ? ipcError(printings.error) : null}
          />
          {/* Not decoration and not optional: Scryfall requires the artist and the source
              to be identifiable in the same interface that shows the art. The artist is
              the one whose art is on screen — the two sides of a double-faced card are not
              always the same illustrator. */}
          <p className="border-t border-border pt-3 text-[0.7rem] leading-relaxed text-dim">
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
          <span className="text-xs text-dim">
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
            "py-1.5 text-xs text-dim transition-colors duration-150 hover:text-text",
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
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-dim">
        <span className="font-mono" title={card.setName ?? undefined}>
          {card.setCode.toUpperCase()} · {card.collectorNumber}
        </span>
        {card.setName && <span className="min-w-0 truncate">{card.setName}</span>}
        {card.lang !== "en" && <LangBadge lang={card.lang} />}
        {/* Tinted text with a gem, never a filled badge — the shared component, which is
            where that judgement now lives for all four surfaces that show a rarity. */}
        {card.rarity && <RarityGem rarity={card.rarity} withLabel />}
      </p>

      {faces.map((f, i) => (
        <div key={i} className="space-y-1">
          <div className="flex items-baseline justify-between gap-2 text-sm">
            <span className="min-w-0">
              {/* Named only when both halves are on screen at once — otherwise the pane's
                  own heading already carries the name. */}
              {faces.length > 1 && f.name && <span className="mr-1.5 font-medium">{f.name}</span>}
              <span className="text-dim">{f.typeLine ?? "—"}</span>
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
                <dt className="text-dim">{FINISH_LABEL[f]}</dt>
                <dd className="font-mono tabular-nums">{usdPrice(finishPrice(card.prices, f))}</dd>
              </div>
            ))}
          </dl>
          {/* Spec §5: a price is never shown without saying how old it is. The ribbon
              carries the date of the data these came in with. */}
          <p className="text-[0.7rem] text-dim">{PRICES_AS_OF}</p>
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
            STATUS_CLASS[status] ?? "border-border text-dim",
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
 *
 * It is also the fastest way in the app to record "I have the Alpha one": every row adds
 * its own printing, which is why the whole card is passed rather than only its id — a wish
 * and an entry both need the name and the oracle id, and neither is on a `Printing`.
 */
function Printings({
  card,
  items,
  total,
  loading,
  error,
}: {
  card: CardDetail;
  items: Printing[];
  total: number;
  loading: boolean;
  error: string | null;
}) {
  const headingId = useId();
  // A card with no `oracleId` never asked for printings, so it has no list to fail at
  // loading: nothing to say, and no empty section to say it in. (Nor does a card whose
  // printings all left `cards` — same shape, same silence.)
  if (!loading && !error && items.length === 0) return null;

  const groups = groupByIllustration(items);
  return (
    // The rule separates "this card" from "every card like it", which is the pane's one
    // real division. Set in the same hairline as the credit line below it rather than a
    // heavier rule: three sections, two hairlines, no boxes. The heading is rendered while
    // the list is still loading so the pane does not reflow around it when it arrives.
    <section aria-labelledby={headingId} className="space-y-2 border-t border-border pt-3">
      <h3 id={headingId} className="text-xs uppercase tracking-wide text-dim">
        Printings
      </h3>
      {loading && <p className="text-xs text-dim">Loading printings…</p>}
      {error && (
        <p className="text-xs text-destructive">
          Could not read the other printings — {error}. The card above is unaffected.
        </p>
      )}
      {/* A count line, so it is set in the data face. `items.length` is capped at 400 and
          `total` is not — saying only the first would report a Forest as having 400
          printings when it has 862. */}
      {items.length > 0 && (
        <p className="font-mono text-[0.7rem] tabular-nums text-dim">
          {items.length < total
            ? `${items.length} of ${total} printings`
            : `${total} printing${total === 1 ? "" : "s"}`}
          {" · "}
          {groups.length} artwork{groups.length === 1 ? "" : "s"}
        </p>
      )}
      {groups.map((group, i) => (
        <div key={group.illustrationId ?? `ungrouped-${i}`} className="space-y-0.5">
          <p className="flex items-baseline gap-1.5 pt-1 text-[0.7rem] text-dim">
            <span className="min-w-0 truncate">
              {group.printings[0].artist ?? "Artist unknown"}
            </span>
            <span className="font-mono tabular-nums">· {group.printings.length}</span>
          </p>
          <ul className="space-y-0.5">
            {group.printings.map((p) => (
              <PrintingRow key={p.id} printing={p} card={card} current={p.id === card.id} />
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

function PrintingRow({
  printing,
  card,
  current,
}: {
  printing: Printing;
  card: CardDetail;
  current: boolean;
}) {
  return (
    <li
      className={cn(
        // `items-center` rather than baseline now that the row ends in a control: a 24px
        // button hung off a baseline sits a third of its height below the prices it lines
        // up with. `group` is what reveals that button on hover.
        "group flex items-center gap-2 rounded-md px-2 py-1 text-xs",
        // The one printing this pane is about. A gold hairline down its edge rather than a
        // fill: gold means "here" everywhere else in the app, and a filled row in a list of
        // forty would be the brightest thing under the art.
        current ? "border-l-2 border-accent bg-bg pl-1.5 text-text" : "text-dim",
      )}
    >
      <RarityGem rarity={printing.rarity} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate font-mono" title={printing.setName ?? undefined}>
        {printing.setCode.toUpperCase()} · {printing.collectorNumber}
        {printing.releasedAt && <> · {printing.releasedAt.slice(0, 4)}</>}
      </span>
      {printing.lang !== "en" && <LangBadge lang={printing.lang} />}
      {/* Per finish, from the blob — never one number standing for both. */}
      {parseFinishes(printing.finishes).map((f) => (
        <span key={f} className="shrink-0 font-mono tabular-nums">
          {FINISH_MARK[f] && (
            <abbr title={FINISH_LABEL[f]} className="mr-0.5 text-[0.65rem] text-dim no-underline">
              {FINISH_MARK[f]}
            </abbr>
          )}
          {usdPrice(finishPrice(printing.prices, f))}
        </span>
      ))}
      {/* This row's printing, not the pane's card: the set and the collector number are the
          row's own, and so are the finishes it may be owned in. */}
      <AddToCollectionButton
        className={REVEAL_ON_HOVER}
        target={{
          cardId: printing.id,
          name: card.name,
          setCode: printing.setCode,
          collectorNumber: printing.collectorNumber,
          oracleId: card.oracleId,
          finishes: parseFinishes(printing.finishes),
        }}
      />
    </li>
  );
}
