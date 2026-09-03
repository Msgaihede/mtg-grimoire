import type { JSX } from "react";
import { skipToken, useQuery } from "@tanstack/react-query";
import { Dialog } from "@/components/Dialog";
import { ipc, ipcError, type CardDetail } from "@/lib/ipc";
import { useAppStore } from "@/lib/store";
import { useMarketplace } from "@/lib/useMarketplace";
import { cn } from "@/lib/utils";
import { FORMAT_ORDER } from "./printings";

/**
 * Where this card may be played — **every format, including the ones it may not.**
 *
 * ## Why it does not go through `legalityChips`
 *
 * The helper next door drops every `not_legal` key before anything is drawn, and the docked pane
 * compensated with a caption: *Formats not listed are not legal.* That is the right trade for a
 * 384px column where the chips are a tail under the prices — a card keeps 11.3 of 23 keys on
 * average, so the filter is half the ink — and it is the wrong trade here, because this surface
 * exists for one question and absence is not an answer to it. A reader who pressed **Legality**
 * is asking *can I play this in my format*, and a format that is simply missing from the grid
 * says that to nobody: it reads as data that failed to load.
 *
 * So this reads `card.legalities` directly and draws all 23 rows, `not_legal` in a recessed
 * badge. `legalityChips` is untouched and still right for its own caller. **A regression to it
 * here would silently lose about half the grid**, which is why the test pins a `not_legal` row
 * by name rather than counting anything.
 *
 * ## Never colour alone
 *
 * Each badge carries the **word**. Four statuses land on four treatments, and a reader who
 * cannot tell the green from the red still gets the answer in type — the app's rule wherever a
 * status is coloured, and the same argument `CardTextDialog` is built on one rail entry over:
 * a fact a reader is required to *see* is a fact half of them do not have.
 *
 * ## No footer
 *
 * The mockup ends on two lines this does not draw — *On the Commander Game Changer list* and
 * *Canadian Highlander: 3 points* — and spec §3.1 drops both. `CardDetail` carries no
 * `gameChanger` (the column exists and two other DTOs expose it, so it is a small Rust change,
 * and the line is simply not wanted); Canadian Highlander points exist in **no** data source
 * this app has — not in Scryfall's bulk files at all, because that format's committee maintains
 * the list — so a table here would be a number with no refresh path and no build to go red when
 * it rots. Neither gets a placeholder either: an empty row promising a fact is worse than a
 * grid that never claimed it.
 *
 * ## Self-mounting, like its two siblings
 *
 * It takes no props. `cardOverlay` is one store field with one writer, so at most one nested
 * overlay is ever open, and this is drawn as an `App`-level **sibling** of the card modal rather
 * than as a child of its panel — that panel is a container-query context, and a layout-contained
 * box is the containing block for its `fixed` descendants, so a scrim rendered inside it would
 * stretch to the panel instead of to the window.
 */
export function LegalityDialog(): JSX.Element {
  const overlay = useAppStore((s) => s.cardOverlay);
  const cardId = useAppStore((s) => s.selectedCardId);
  const close = useAppStore((s) => s.closeCardOverlay);
  // Nothing here draws a price — but the marketplace is in `card_detail`'s **key**, because it
  // is in `card_detail`'s answer, and a key that left it out would open a second cache entry for
  // a card the modal behind this one has already fetched.
  const { marketplace } = useMarketplace();

  const open = overlay === "legality" && cardId !== null;

  const card = useQuery({
    // One spelling of the card modal's key, written out rather than imported: `CardDetailPane`
    // owns the only other copy today and that file goes with the dock, so importing it would be
    // an import of something on its way out.
    queryKey: ["card", cardId, marketplace.id],
    // `skipToken` rather than `enabled`, so the closed state is *no query function at all*
    // rather than a disabled one — this component is mounted for the whole life of the app and
    // must cost nothing until a reader asks. An entry the modal has already filled is read on
    // the render this opens.
    queryFn: open && cardId !== null ? () => ipc.cardDetail(cardId, marketplace.id) : skipToken,
  });

  return (
    <Dialog
      open={open}
      title="Legality"
      // The heading says which *question* is open — which is what a reader choosing between
      // three rail entries is picking — and the subtitle says which card it is being asked
      // about.
      subtitle={card.data?.name}
      closeLabel="Close legality"
      size="w-[45rem]"
      // **A claim about the highest thing this surface can be asked to cover**, which is
      // `LAYER.overlayStacked`'s own rule. It is opened from the card modal's options rail and
      // from nowhere else, so it is *always* over another dialog — two `fixed inset-0` scrims,
      // neither inside the other, in the root stacking context. At the default rung they tie,
      // and equal z-indexes are resolved by document order, which is the bug `layers.ts` opens
      // with.
      layer="stacked"
      onDismiss={close}
      onClose={close}
    >
      {/* The fold is measured on **this box** rather than on the window, for spec §2.1's reason:
          the panel is `w-[45rem]` above the phone fold and the whole glass below it, and how its
          own grid should split is a question about the panel's width and nothing else.

          The container is declared here rather than on `Dialog`'s panel because `Dialog`'s
          `container` prop is `@container/card`, a literal spelled for one host — and because a
          container is a containing block for its `fixed` descendants, so it is switched on over
          the smallest subtree that needs it. Nothing under here is `fixed`: the body is a grid
          of text, tooltips mount at the app root, and this dialog opens no popup of its own.

          `@min-[640px]/…` rather than the bare `@[640px]/…` the plan sketched. **Both compile**
          — checked against this build (Tailwind 4.3.3), where the two emit the identical
          `@container legality (width >= 640px)` — so this is one spelling per repo rather than a
          correctness fix: `FilterBar`'s four rungs are the only other named container queries in
          `src/` and they are all written this way. */}
      <div className="min-h-0 flex-1 overflow-y-auto p-5 @container/legality">
        <LegalityBody
          card={card.data ?? null}
          loading={card.isPending}
          error={card.error === null ? null : ipcError(card.error)}
        />
      </div>
    </Dialog>
  );
}

/**
 * The colour of one status badge — `CardDetailPane`'s `STATUS_CLASS` **adapted**, not imported.
 *
 * Adapted in two ways, and both follow from this grid drawing what the pane's chips could not.
 *
 * **`not_legal` is here at all**, which is the whole point of the surface, and it is the quiet
 * one: it is most of the grid on most cards — the pane measured 11.3 of 23 keys *surviving* its
 * filter over the dev corpus on 2026-08-20 — so it is the ground the other three are read
 * against. The pane had the opposite problem: with `not_legal` filtered out, *legal* was the
 * quiet case and got no ink.
 *
 * **`legal` therefore takes `--color-ok`.** That token was added when the deck check became a
 * glyph and its two states had to be told apart without words, which is this question one level
 * up, and it is tuned to *state* a clean answer rather than celebrate it — a peer of
 * `--destructive` rather than one of the mana greens, which are for chips and pips and never for
 * text. Gold stays unspent here for the pane's reason: it is the app's interactive colour and a
 * column of gold badges would out-shout the focus ring that has to mean something.
 *
 * `restricted` keeps full-strength text and a plain border. It is not a milder ban — it is a
 * card you may play *one* of — so it must not sit beside `not_legal` looking the same; the word
 * is what carries it, and the weight is what lets the eye find the word.
 */
const STATUS_CLASS: Record<string, string> = {
  legal: "border-ok/40 text-ok",
  not_legal: "border-border/60 text-dim",
  restricted: "border-border text-text",
  banned: "border-destructive/40 text-destructive",
};

/**
 * The word on the badge, per status.
 *
 * A map rather than a `replace("_", " ")`, because the four values are a closed vocabulary
 * Scryfall publishes and a transformation would silently invent a label for a fifth. An
 * unrecognised status falls through to the raw value, which is how anybody would find out one
 * had arrived.
 */
const STATUS_WORD: Record<string, string> = {
  legal: "Legal",
  not_legal: "Not legal",
  restricted: "Restricted",
  banned: "Banned",
};

/** A status neither map knows: drawn, dim, and saying whatever word Scryfall sent. */
const UNKNOWN_STATUS_CLASS = "border-border/60 text-dim";

/** One row of the grid: the key `cards.legalities` carries, and what it says. */
interface LegalityRow {
  format: string;
  status: string;
}

/**
 * The formats whose name is **not** their key with a capital letter. Everything else is handled
 * by the rule in {@link formatLabel} rather than listed here, so this table is the exceptions and
 * a count of it is a thing the lines below answer.
 *
 * ## Why this is not read from `format_specs`
 *
 * That table is the obvious answer and it was written that way first: `schema::migrate` seeds all
 * 25 rows with a `display_name` beside every other rule those formats are judged by, and
 * `has_legality_data` is literally the column saying which of them appear in this blob. Two
 * things sent it back.
 *
 * **The workbench answers twelve of the twenty-five.** `.storybook/fake/db.ts`'s
 * `format_specs_list` is served from `validation/fixtures.ts`, deliberately — that file is
 * already a hand-copied mirror of the seed and a second mirror is a second place for a cell to
 * drift — and it carries the 12 rows the deck engine's tests need (its own doc says so, measured
 * 2026-08-09). A grid drawing every format through it would therefore show about half its rows as
 * **slugs** in Storybook: `standardbrawl`, `predh`, `oldschool`. That is a page every reader of it
 * would file as a bug, and it would be right to.
 *
 * **And it is a query.** `format_specs` is `staleTime: Infinity` but it is still a read that has
 * not landed on the render a popup opens, so the grid would either flash slugs for a frame or
 * hold a settings-table spinner over a card the modal behind it has already drawn. A name that
 * cannot be spoken synchronously is the wrong shape for this surface.
 *
 * What is given up is real and small: these are proper nouns that have not moved in a decade, and
 * a divergence from the seed is cosmetic rather than a wrong answer. If a third surface ever needs
 * format names outside the deck feature, that is the moment to lift one shared table — not now,
 * with one caller.
 */
const FORMAT_LABEL: Record<string, string> = {
  future: "Future Standard",
  penny: "Penny Dreadful",
  standardbrawl: "Standard Brawl",
  competitivebrawl: "Competitive Brawl",
  paupercommander: "Pauper Commander",
  duel: "Duel Commander",
  oldschool: "Old School",
  predh: "PreDH",
  tlr: "Tiny Leaders: Reborn",
};

/**
 * What one format key is called.
 *
 * The rule is the first letter, because Scryfall's keys are lowercase and most of them are one
 * word — and because it is also the right answer for a format that lands *after* this build:
 * `explorer` reads as `Explorer` rather than as a slug. A **new multi-word**
 * key is the case the rule gets visibly wrong (`Standardbrawl`), which is the tell that
 * {@link FORMAT_LABEL} needs a line, and it is a better failure than dropping the row — Scryfall
 * adds formats without asking, and a grid that silently omitted one would be wrong in exactly the
 * direction this whole surface exists to prevent.
 *
 * Capitalised in **JS and not with a `capitalize` class**: the word is the answer here, and a
 * status a reader can only get by looking at rendered pixels is the thing the badge beside it
 * refuses to do.
 */
function formatLabel(format: string): string {
  return FORMAT_LABEL[format] ?? format.charAt(0).toUpperCase() + format.slice(1);
}

/**
 * Every format in the blob, in the order it should be read.
 *
 * **Nothing is filtered.** The only rows dropped are entries whose value is not a string, which
 * is a blob that is not the shape it claims rather than a card with fewer formats.
 *
 * `FORMAT_ORDER` is Scryfall's own emission order and is a **display order, not a schema**: a key
 * it has never heard of ranks last and is drawn rather than dropped, because Scryfall adds
 * formats without asking and a grid that silently omitted one would be wrong in the direction
 * this whole surface exists to prevent. `sort` is stable, so several unknown keys keep the order
 * the blob listed them in.
 */
function legalityRows(legalitiesJson: string | null): LegalityRow[] {
  if (!legalitiesJson) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(legalitiesJson);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];

  const rank = (format: string) => {
    const i = FORMAT_ORDER.indexOf(format as (typeof FORMAT_ORDER)[number]);
    return i === -1 ? FORMAT_ORDER.length : i;
  };
  return Object.entries(parsed as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .sort((a, b) => rank(a[0]) - rank(b[0]))
    .map(([format, status]) => ({ format, status }));
}

/**
 * The grid, and the four states that are not a grid.
 *
 * Split out from the shell so the states read as one list rather than as conditions threaded
 * through a `Dialog` call, and so a story or a test can stage a card no fake could answer with.
 */
function LegalityBody({
  card,
  loading,
  error,
}: {
  card: CardDetail | null;
  loading: boolean;
  error: string | null;
}) {
  if (loading) return <p className="text-sm text-dim">Reading the card…</p>;
  if (error !== null) {
    return <p className="text-sm text-destructive">Could not read the card — {error}.</p>;
  }
  // `card_detail` answers `null` for an id `cards` has no row for, which is a real state rather
  // than a failure: a collection or a deck can hold a printing the corpus has since dropped.
  if (card === null) {
    return <p className="text-sm text-dim">This printing is no longer in the card database.</p>;
  }

  const rows = legalityRows(card.legalities);
  // Not the same as "legal nowhere", which is 23 `not_legal` rows and draws in full. This is a
  // card the corpus holds **no legality blob for at all** — a token, an art card, a row whose
  // JSON did not parse — and saying so is the only thing that tells it from a grid that failed
  // to render.
  if (rows.length === 0) {
    return <p className="text-sm text-dim">Scryfall lists no formats for this card.</p>;
  }

  return (
    // The list keeps a name of its own, and it is the more exact of the two: the dialog's
    // heading says what the surface is about, `Format legality` says what the items in it *are*.
    <ul
      aria-label="Format legality"
      className="grid grid-cols-1 gap-x-8 gap-y-1.5 @min-[640px]/legality:grid-cols-2"
    >
      {rows.map(({ format, status }) => (
        <li key={format} className="flex items-center gap-2.5 text-sm">
          {/* One width for every badge, so the format names line up into a column the eye can
              run down — the grid's whole readability at 23 rows. `text-center` because a
              fixed-width chip with ragged type inside it reads as a broken button. */}
          <span
            className={cn(
              "w-[5.5rem] shrink-0 rounded-full border px-2 py-0.5 text-center text-[0.7rem]",
              STATUS_CLASS[status] ?? UNKNOWN_STATUS_CLASS,
            )}
          >
            {STATUS_WORD[status] ?? status}
          </span>
          <span className="min-w-0 truncate">{formatLabel(format)}</span>
        </li>
      ))}
    </ul>
  );
}
