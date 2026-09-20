import {
  useEffect,
  useId,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { keepPreviousData, skipToken, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { CardArt } from "@/components/CardArt";
import { Dialog } from "@/components/Dialog";
import { FILTER_FIELD, ToggleChip } from "@/components/FilterChips";
import { ManaText } from "@/components/ManaText";
import { COMBO_TAG } from "@/features/decks/DeckBracket";
import { comboBrackets } from "@/features/decks/validation/bracket";
import { DEBOUNCE_MS } from "@/features/search/useCardSearch";
import { count, plural } from "@/lib/counts";
import { openExternal } from "@/lib/externalLinks";
import { FOCUS } from "@/lib/focus";
import { WALL_CARD_VARIANT } from "@/lib/images";
import {
  ipc,
  ipcError,
  type CardCombo,
  type CardCombosPage,
  type CardDetail,
  type ComboPiece,
  type ComboStatus,
} from "@/lib/ipc";
import { COMBOS_STATUS_KEY, cardCombosKey } from "@/lib/query";
import { useAppStore } from "@/lib/store";
import { useMarketplace } from "@/lib/useMarketplace";
import { cn } from "@/lib/utils";
import { cardDetailKey } from "./cardDetailKey";

/**
 * Combos per request.
 *
 * **The list is paged because the corpus says it has to be.** Measured on the real corpus
 * 2026-09-08: 107 016 combos over 7 330 distinct cards, and the distribution is not remotely
 * flat — Ashnod's Altar is in **6 044** of them and 114 cards are in more than 500. A dialog that
 * asked for "this card's combos" would therefore be asking for six thousand rows, for the one
 * card a reader is most likely to open it on.
 *
 * **50 rather than 25, and the number moved because the argument it stood on is gone**
 * (2026-09-20). It was 25 on the grounds that "a combo row is a wall of art, so a page here is
 * nearer a screen of reading than a screen of tiles" — true of the accordion, where a row carried
 * two to five card pictures. A rail row is one line of type and no picture, so that paragraph
 * describes a surface that no longer exists, and a number left standing on a false reason is
 * worse than a wrong number.
 *
 * **What decides it now is that the reader no longer presses anything to get the next page.** The
 * rail fetches when its sentinel comes into view, so a page's job is to be comfortably more than
 * one screenful of rows — a page that ran out inside the scroller would have the observer firing
 * again before the first one had finished landing.
 *
 * **Measured in the shipped window 2026-09-20** (`npm run tauri dev`, a debug build, 1920×1080,
 * against a copy of the real pair): a row is **59px**, so fifty of them are **2 987px** of scroller
 * against a **605px** rail — **4.9 screens** of headroom. Driven on Ashnod's Altar, five
 * scroll-to-the-foot passes paged **50 → 100 → 150 → 200 → 250 → 300** with the scroller growing
 * 2 987 → 17 799, one page per pass and never more, which is the gate holding.
 *
 * **Paging is still not a way to *find* anything, which is the other half of that 6 044 and why
 * the box above the chips exists.** Fifty at a time with no search is 121 scrolls to reach the end
 * of one card's list, and a reader who wants the combo with Krark-Clan Ironworks in it has no way
 * to ask for it. The search narrows in SQL, like the chips, for the chips' reason: a term applied
 * to the page in hand would be searching 0.8 % of the list and calling the answer *no match*.
 */
const PAGE_SIZE = 50;

/**
 * What an empty answer means when the feed has never been ingested.
 *
 * **This sentence is the whole reason this dialog reads {@link ipc.combosStatus} at all**, and it
 * is `OracleTagsDialog`'s split one feed over: `combos_for_card` cannot tell a card with no combos
 * from a database with no combo table, because both are zero rows, and the two answers are not
 * close. One is a fact about the reader's card; the other is a fact about the reader's database.
 *
 * A never-ingested table is a **supported state** rather than a failure — it is where every
 * install is before its first launch fetch lands, where a machine that cannot reach Spellbook
 * stays, and where `combos_clear` puts one back on purpose. The last clause is
 * `DeckBracket`'s, in this surface's own words: the feed is fetched at launch, there is no button
 * for it anywhere in the app, so the honest instruction is that nothing needs a press.
 */
const NEVER_FETCHED =
  "No combos yet — Commander Spellbook's combo list has not been downloaded. " +
  "The app fetches it in the background shortly after launch. Nothing here needs a press.";

/** An empty answer from a feed that *is* here: Spellbook lists no combo naming this card. The
 *  other half of {@link NEVER_FETCHED}'s split, and the claim that needs the status row. */
const NO_COMBOS = "No combos. Commander Spellbook has none on record naming this card.";

/**
 * A printing with no oracle card behind it.
 *
 * `CardDetail.oracleId` is nullable and a handful of rows really are null, so this is a state
 * rather than a defect — and it is the one case where the dialog asks nothing at all. There is no
 * question to put: `combos_for_card` matches on oracle id, so a null id has nothing to look up and
 * a call would only be this component asking the backend to confirm that zero is zero.
 */
const NO_ORACLE_CARD =
  "No combos. This printing is not linked to an oracle card, and a combo is a fact about the " +
  "card rather than about the printing.";

/**
 * The **fourth** empty, and it must never borrow one of the three above.
 *
 * A filter that leaves nothing is a statement about the filter, not about the card or the
 * database — and the chips are still on screen above it. It is drawn only where `total > 0`,
 * which is what keeps it from ever standing in for {@link NEVER_FETCHED}: a database with no rows
 * has no chips to have narrowed with.
 *
 * **A search that matches nothing is this sentence and not a fifth one.** The box is a filter like
 * the chips are — it narrows the same list, it is undone the same way, and it sits in the same row
 * of controls above this line — so a term that leaves nothing has left the reader in exactly the
 * state a chip does. `total` is over the unfiltered set and the search does not move it, which is
 * what keeps this branch reachable with a term in the box: the empty answer is `matching`.
 */
const NO_MATCH = "No combo matches that filter.";

/**
 * Where the combos came from and how old they are — the app's rule that data with an age says its
 * age, in the voice `pricesAsOf` set and `OracleTagsDialog`'s `AS_OF` repeated one feed over.
 *
 * **It does not say "as of the last card-data sync".** Commander Spellbook's `variants.json.gz` is
 * a separate bulk download on a refresh interval of its own (`combos::REFRESH_INTERVAL_SECS`, a
 * week, against a file Spellbook rebuilds through the day) — so a card sync that finished this
 * morning says nothing whatever about how old these rows are. Blurring the two is the thing the
 * root `CLAUDE.md` asks in bold not to do, and a caption that names the wrong clock is worse than
 * one that names none.
 */
const AS_OF = "Combos come from Commander Spellbook, as of the last combo refresh.";

/** Where one combo lives on the web — Spellbook's own permalink, keyed on the variant id the feed
 *  publishes. Built here rather than in `lib/externalLinks.ts` because this dialog is its only
 *  caller; a second one is the moment it moves next to the three that live there. */
function spellbookComboUrl(id: string): string {
  return `https://commanderspellbook.com/combo/${encodeURIComponent(id)}/`;
}

/**
 * The offset for the page after these, or `undefined` when there is nothing left.
 *
 * `useCollection`'s `nextOffset` in this page's own shape — `CardCombosPage` counts `matching`
 * rather than `total`, because the count a pager has to walk is the count **after** the two
 * filters and not the census the chips are drawn from. The short-page rule is that one's, for its
 * reason: a page shorter than asked for ends the list whatever the count says, so a refresh
 * landing between two requests cannot leave this fetching the same empty page for ever.
 */
function nextComboOffset(pages: readonly CardCombosPage[]): number | undefined {
  const last = pages[pages.length - 1];
  if (!last || last.combos.length === 0) return undefined;
  const seen = pages.reduce((n, page) => n + page.combos.length, 0);
  return seen >= last.matching ? undefined : seen;
}

/**
 * The brackets a combo is legal in, as a range: `2–5`, `4–5`, `1–5`.
 *
 * The rail's 42px box, and the reason it is a *range* rather than five pips at rail scale: every
 * answer {@link comboBrackets} can give is a contiguous run up to 5, because it is a floor read
 * as a set, so the first and the last say the whole of it in four characters.
 *
 * **An empty list is `B` and says so in words.** It is not "brackets none" — a banned combo is a
 * legality finding, which is a different kind of statement from a power floor, and the box would
 * otherwise draw an en dash with nothing either side of it.
 */
function bracketRange(brackets: readonly number[]): string {
  if (brackets.length === 0) return "Not legal";
  return `${brackets[0]}–${brackets[brackets.length - 1]}`;
}

/**
 * The same answer as a sentence — what the pips and the range box are, said once and in words.
 *
 * **The pips are a colour-and-number pair and may not be the only statement of the brackets**, and
 * the range box is a five-character abbreviation of one. So both carry this string: the pane's
 * group as its `aria-label`, the rail row inside {@link comboRowLabel}. `1` is spelled out with
 * the rest rather than collapsed to "any deck", because the sentence has to be readable against
 * the five numbers drawn beside it.
 *
 * `and` before the last rather than a bare comma list: this is read aloud, and "2, 3, 4, 5" is a
 * sequence of numbers where "2, 3, 4 and 5" is a set.
 */
function bracketSentence(brackets: readonly number[]): string {
  if (brackets.length === 0) return "Not legal in Commander";
  const list =
    brackets.length === 1
      ? `${brackets[0]}`
      : `${brackets.slice(0, -1).join(", ")} and ${brackets[brackets.length - 1]}`;
  return `Legal in ${brackets.length === 1 ? "bracket" : "brackets"} ${list}`;
}

/**
 * The pieces that are *not* the card this dialog is about.
 *
 * **What a rail row is for is the other cards**, and the asked-about card is already the dialog's
 * subtitle — repeating it on every one of six thousand rows costs the width the names need. It is
 * matched on the **oracle** id and never on position: `CardCombo.pieces` is in the feed's order so
 * that Spellbook's steps read against it, and the open card is wherever the editors put it.
 *
 * **A combo whose only named card is this one keeps its name**, which is not a hypothetical: the
 * corpus holds seven one-card combos. A row with an empty headline would be a row that draws
 * nothing at all, so the fallback is every piece — which for those rows is the card itself.
 */
function otherPieces(combo: CardCombo, oracleId: string | null): ComboPiece[] {
  const others = combo.pieces.filter((piece) => piece.oracleId !== oracleId);
  return others.length > 0 ? others : combo.pieces;
}

/** How many of a combo's pieces the reader is short of — a piece counts as missing when they hold
 *  fewer copies than it asks for, which is {@link ownedNote}'s own test one level up. */
function missingCount(combo: CardCombo): number {
  return combo.pieces.filter((piece) => piece.owned < piece.quantity).length;
}

/** The rail's ownership half, in the words the sentence is asserted by. `Missing 1` rather than
 *  `1 missing`, so the two states start with different words and a scan down the rail can tell
 *  them apart at the left edge of the phrase. */
function ownedSummary(missing: number): string {
  return missing === 0 ? "You own every piece" : `Missing ${missing}`;
}

/**
 * What one rail row is called, built rather than left to fall out of the layout.
 *
 * **A `gap` is not a word separator to the accessible-name computation.** Left to compute itself
 * from its children this button would read `2–5Rings of Brighthearth2 cardsMissing 1` — the range
 * box, the names, the size and the ownership mark run together, because the accname spec
 * concatenates text nodes and the *spaces* on this row are flex gaps. This repo has been bitten by
 * exactly that with a label and its count computing as `Missing2`.
 *
 * **It replaces `comboLabel`, which named a disclosure, and it says a different thing.** That one
 * ended `— S Spicy`: the letter led, because the letter was what the row drew. Nothing draws a
 * letter any more, so nothing here says one — the row shows a bracket *range* and the name of the
 * classification, and this is those two in words plus the size and the ownership.
 *
 * **Every visible string on the row is in here verbatim**, which is WCAG 2.5.3 rather than
 * tidiness: an accessible name that paraphrased `Missing 1` as "one piece missing" would be a
 * control a reader cannot address by what is written on it. The one exception is the range box,
 * whose `2–5` is expanded by {@link bracketSentence} — that is the box's whole reason for having a
 * sentence at all.
 */
function comboRowLabel(combo: CardCombo, names: string, brackets: readonly number[]): string {
  const tag = COMBO_TAG[combo.bracketTag];
  const parts = [
    `${names} — ${tag.name}`,
    bracketSentence(brackets),
    plural(combo.cardCount, "card"),
    ownedSummary(missingCount(combo)),
  ];
  return `${parts.join(". ")}.`;
}

/**
 * The combos a card is in, over the card detail modal.
 *
 * **Self-mounting, and drawn as a sibling of the modal rather than inside it.** It takes no props
 * and reads `cardOverlay` and `selectedCardId` off the store, which is the shape its three rail
 * siblings already have and the one the card modal's panel forces: that panel is a
 * `@container/card` context, and a container box is the containing block for its `fixed`
 * descendants — so this dialog's `fixed inset-0` scrim rendered *inside* it would resolve against
 * the panel and cover the card modal and nothing else.
 *
 * `layer="stacked"` for the half of that hazard a container cannot fix. This opens **over**
 * another dialog, and at `LAYER.overlay` the two scrims would tie — two `fixed inset-0` boxes,
 * neither inside the other, in the root stacking context — with the winner decided by document
 * order. A rung is a claim about the highest thing a surface can be asked to cover.
 *
 * **Escape needs no code here.** `Dialog` registers its `"inner"` rung on the open flag, and this
 * one mounts after the card modal, so it lands above it on `useDismissOnEscape`'s capture stack
 * and takes the press. The rail's arrow keys are the only keyboard this file binds, they are bound
 * on the list itself rather than on the window, and each one that is handled stops there — see
 * {@link Rail}.
 *
 * ## Why a combo is a surface at all
 *
 * A two-card infinite combo is a fact about an **interaction**, so no amount of reading either
 * card's own text finds one — which is why the deck bracket's fourth signal needed a feed of its
 * own, and why a reader looking at Boros Reckoner has no way to discover Boros Charm from the card
 * in front of them. This is that feed asked the other way round: not *what does this deck contain*
 * but *what is this card a piece of*.
 *
 * ## A rail and a pane, since 2026-09-20 (issue #481)
 *
 * It was a list of accordions, and the report was that the images and the text were too small.
 * Taken literally that asks for a wider accordion; what it describes is a surface scanned by card
 * art through a 96px window, where the thing the reader wants is behind a press. So the left rail
 * is the scan list — one line per combo, no art, the brackets and what is missing — and the right
 * pane is one combo drawn at full size with nothing collapsed. Nothing about the backend moved:
 * the command, its page shape, the three filters and the census are the answer this renders.
 *
 * ## Three empties, and telling them apart is the point
 *
 * Spellbook's feed is optional in the tagger files' sense: a launch fetches it uninvited, a failed
 * fetch keeps whatever was stored, and a database that has never got it answers with three bracket
 * signals rather than four. An empty panel would read as "this card is in no combos", which is a
 * different claim and, on a first launch, a false one. So an empty answer says which of the three
 * it is — {@link NO_ORACLE_CARD}, {@link NEVER_FETCHED}, {@link NO_COMBOS} — and never draws an
 * empty box. {@link NO_MATCH} is a fourth and is about the reader's own filter.
 */
export function CombosDialog(): JSX.Element {
  const overlay = useAppStore((s) => s.cardOverlay);
  const cardId = useAppStore((s) => s.selectedCardId);
  const close = useAppStore((s) => s.closeCardOverlay);
  // Nothing here draws a price — but the marketplace is in `card_detail`'s **key**, because it is
  // in `card_detail`'s answer, and a key that left it out would open a second cache entry for a
  // card the modal behind this one has already fetched. See {@link cardDetailKey}.
  const { marketplace } = useMarketplace();

  const open = overlay === "combos" && cardId !== null;

  // **Gated on `open`**, which is what makes this component free to mount unconditionally at
  // `App` level: a dialog nobody has opened asks the backend nothing. `skipToken` rather than
  // `enabled`, so the closed state is *no query function at all* rather than a disabled one.
  const card = useQuery({
    queryKey: cardDetailKey(cardId, marketplace.id),
    queryFn: open && cardId !== null ? () => ipc.cardDetail(cardId, marketplace.id) : skipToken,
  });

  return (
    <Dialog
      open={open}
      // The heading says which *question* is open — which is what a reader choosing between the
      // rail's entries is picking — and the subtitle says which card it is being asked about.
      title="Combos"
      subtitle={card.data?.name}
      closeLabel="Close combos"
      // **The widest panel this app ships, and the arithmetic is the whole of why it is 62 and not
      // 72.** `minWidth` is 1024 (`src-tauri/tauri.conf.json`) and `Dialog`'s scrim spends 24px a
      // side above the phone fold, so 976px is every pixel the smallest window this app can be
      // has to give. 62rem is 992 — over that by 16, which `max-w-full` absorbs — where 72rem
      // would be 176px of panel the reader could never see. Everything else here is `w-[45rem]`
      // or `w-[55rem]`; a split pane wants more than either.
      //
      // **`max-w-full` absorbing it is true since 2026-09-20 and was not true when this panel was
      // written.** Being the first host wider than the padded box is what exposed a clamp that had
      // been circular since the shell was built: the scrim had no `grid-template-columns`, so the
      // panel's grid area was an implicit `auto` column that sized to the panel, and `100%` of it
      // was whatever the panel had asked for. Driven at 1024×700 it drew **992 at `left: 24`** with
      // **8px** of glass on the right against 24 on the left. `Dialog.tsx` carries the fix and the
      // before/after; with it the same window draws **976 at `left: 24`, 24px either side**, and
      // `document.scrollWidth` stays 1024 — no horizontal page scroll, which is the one thing the
      // 1024 floor forbids.
      //
      // **The height is fixed, which no other dialog in this app does, and that is the pane's
      // doing.** A panel sized by its content would resize as the reader moved down the rail —
      // a two-card combo with no steps against a five-card one with three — so the list they are
      // reading would move under the pointer on every press. `max-h-full` still clamps it to the
      // window's 90vh, so this is a ceiling the panel asks for rather than a size it insists on.
      size="w-[62rem] h-[54rem]"
      layer="stacked"
      onDismiss={close}
      onClose={close}
    >
      {/* Mounted only while it is open — `Dialog`'s own rule, and the whole of why the search box,
          the two chips and the picked row below are `useState` rather than store fields: closing
          the dialog unmounts the body, so a reader who narrowed card A's combos to three-card ones
          with "altar" in the box opens card B on **All** with an empty box and its first combo
          selected, without a single effect having to reset anything. */}
      <Body
        open={open}
        card={card.data ?? null}
        loading={card.isPending}
        oracleId={card.data?.oracleId ?? null}
      />
    </Dialog>
  );
}

/**
 * The panel's contents — the filter band, the two columns, and the five things that are not a
 * list.
 *
 * Split out from the shell for `LegalityDialog`'s reason (the states read as one list rather than
 * as conditions threaded through a `Dialog` call) and for one of its own: **the filters live
 * here**, and all three are in the query key, so both reads have to be here with them.
 */
function Body({
  open,
  card,
  loading,
  oracleId,
}: {
  open: boolean;
  card: CardDetail | null;
  loading: boolean;
  oracleId: string | null;
}) {
  /**
   * How many cards a combo is made of, or `null` for every size.
   *
   * **Sent to the backend rather than applied to the page in hand**, which is not an optimisation
   * — it is the only correct answer. A filter applied here would narrow the 50 rows this dialog
   * happens to be holding and call the result "3-card combos", which on a card with 6 044 of them
   * is a claim about 0.8 % of the list. The same goes for {@link ownedOnly}.
   */
  const [cardCount, setCardCount] = useState<number | null>(null);
  /** Only combos every piece of which the reader has a copy of. Also the backend's business. */
  const [ownedOnly, setOwnedOnly] = useState(false);

  /**
   * What is in the box, and what has been asked for — two states rather than one, and the split is
   * the debounce.
   *
   * {@link text} is the controlled value, so a keystroke is on screen in the same frame it was
   * typed and is never gated on a round trip; {@link asked} follows it {@link DEBOUNCE_MS} later
   * and is what the query is keyed on, so a five-letter word costs one request rather than five.
   * `useCardSearch`'s constant rather than a number of this dialog's own: how long a search box in
   * this app stays quiet is one question, and a box that answered it differently from the three
   * card searches would be a second answer to a settled one.
   */
  const [text, setText] = useState("");
  const [asked, setAsked] = useState("");

  /**
   * Which combo the pane is drawing, as an id the reader pressed — or `null`, which is every
   * reader who has pressed nothing.
   *
   * **The selection is derived from it rather than stored a second time**, which is the whole of
   * why no effect is needed anywhere on this surface. A search, a chip or a new page hands back a
   * different `rows`, and an id that is no longer in it falls through to the first row of the new
   * list — which is what a reader who has just narrowed the list means. A `useEffect` that
   * reconciled a stored `selected` against a changed list would be doing the same arithmetic one
   * render late, and would be a `setState` inside an effect, which this app refuses.
   *
   * Local to this component for `text`'s reason above: a dialog that is unmounted when it closes
   * needs nothing to reset.
   */
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setAsked(text), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  /**
   * The term, or `null` for no search at all.
   *
   * **Trimmed here rather than at the backend**, so `"bolt "` and `"bolt"` are one query key and
   * one cache entry rather than two spellings of the same question. `""` collapses to `null` for
   * the same reason: the wire carries one shape for *no search*, and a key holding the empty
   * string would be a second one that had to answer identically for ever.
   */
  const search = asked.trim() === "" ? null : asked.trim();

  const combos = useInfiniteQuery({
    // **The search is in the key**, with the two filters and for their reason: it narrows in SQL
    // before the page is cut, so a searched answer is a different question rather than a subset of
    // the unsearched one — and a key that left it out would hold the old pages, and with them an
    // offset into a list that no longer exists.
    queryKey: cardCombosKey(oracleId ?? "", search, cardCount, ownedOnly),
    // **No call at all for a card with no oracle id**, which is the state {@link NO_ORACLE_CARD}
    // draws: the command matches on oracle id, so a null one has nothing to ask about and the
    // answer is known here without a round trip.
    queryFn:
      open && oracleId !== null
        ? ({ pageParam }) =>
            ipc.combosForCard({
              oracleId,
              search,
              cardCount,
              ownedOnly,
              limit: PAGE_SIZE,
              offset: pageParam,
            })
        : skipToken,
    initialPageParam: 0,
    getNextPageParam: (_last, pages) => nextComboOffset(pages),
    // A narrowed filter keeps the previous page on screen rather than blanking the panel — the
    // shape every other filtered list in this app uses (`useCollection`, `useCardSearch`). Without
    // it the list would blink to *Reading the combos…* once per debounced keystroke, which is the
    // one thing a search box may not do to the list it is narrowing.
    //
    // **What it costs is one frame of a stale census**, and that is new: `byCardCount` follows the
    // search now, so while a term is in flight the chips are still the previous term's. The
    // alternative is a chip row that empties and refills per keystroke, which is worse.
    placeholderData: keepPreviousData,
  });

  const status = useQuery<ComboStatus>({
    queryKey: COMBOS_STATUS_KEY,
    queryFn: open ? () => ipc.combosStatus() : skipToken,
  });

  /**
   * The census, off the first page.
   *
   * **The search changes the *subject*; the chips are facets of it.** So there are three sets in
   * one page and each number names a different one: `total` is every combo naming this card,
   * filtered by nothing at all; `byCardCount` and `ownedTotal` are over the **search-filtered**
   * set; `matching` is over that set with the chips applied as well.
   *
   * **Only two of the four are drawn now, and the chips are the ones that stopped.** `All · 412`
   * became `All`: the numbers were five figures wide next to a search field, which is what the
   * reader of issue #481 was looking past to find the cards. `matching` says how long the rail is,
   * in one place above it, and `byCardCount` still decides which size chips exist at all.
   *
   * `total` is the one number no control here can move, which is why the empty branches below test
   * it rather than `matching`: a card with combos has a filter row whatever is typed into it, and
   * {@link NEVER_FETCHED} can never be reached by narrowing.
   */
  const page = combos.data?.pages[0] ?? null;
  const total = page?.total ?? 0;
  const matching = page?.matching ?? 0;
  const rows = combos.data?.pages.flatMap((p) => p.combos) ?? [];

  /**
   * The combo the pane draws — the picked one while it is still in the list, the first row
   * otherwise, and `null` only where there are no rows at all.
   *
   * See {@link picked}: this line is the reconciliation, and it is the reason there is no effect.
   */
  const selected = rows.find((combo) => combo.id === picked) ?? rows[0] ?? null;

  /**
   * The body proper, chosen once.
   *
   * **Every state is drawn inside the same frame below**, rather than each returning a shape of
   * its own: the panel's caption is a property of the *panel*, so a dialog that dropped it for its
   * empty states would lose its as-of line exactly when a reader is being told something about
   * where the data came from.
   */
  const content =
    loading ? (
      <Filler>
        <Note>Reading the card…</Note>
      </Filler>
    ) : // `card_detail` answers `null` for an id `cards` has no row for, which is a real state
    // rather than a failure: a collection or a deck can hold a printing the corpus has dropped.
    card === null ? (
      <Filler>
        <Note>This printing is no longer in the card database.</Note>
      </Filler>
    ) : oracleId === null ? (
      <Filler>
        <Note>{NO_ORACLE_CARD}</Note>
      </Filler>
    ) : combos.isError ? (
      <Filler>
        <p className="text-sm text-destructive">
          Could not read the combos — {ipcError(combos.error)}.
        </p>
      </Filler>
    ) : // Both reads, not just the combo one: the sentence an empty answer gets is *decided* by
    // the status row, so drawing before it lands would flash whichever of the two claims the
    // default happened to be — and one of them is about the reader's database rather than about
    // their card.
    combos.isPending || status.isPending ? (
      <Filler>
        <Note>Reading the combos…</Note>
      </Filler>
    ) : total === 0 ? (
      // An unanswered status reads as never-fetched rather than as "no combos", and that is the
      // safe way round: `combos_status` reads one small table and makes no network call, so this
      // branch is all but unreachable — and of the two claims, "the file has not been downloaded"
      // is the one that stays true of a database nobody can read the status of.
      <Filler>
        <Note>{(status.data?.fetchedAt ?? null) === null ? NEVER_FETCHED : NO_COMBOS}</Note>
      </Filler>
    ) : (
      <>
        {/* The filter band spans both columns and scrolls with neither: it narrows the rail, and a
            control that scrolled away from the list it narrows is a control a reader has to go
            looking for. `shrink-0`, so a long chip row shortens the columns rather than being
            squeezed out of the panel. */}
        <div className="shrink-0 border-b border-border bg-surface px-4 py-3">
          <SearchField value={text} onChange={setText} />
          <Filters
            page={page}
            cardCount={cardCount}
            ownedOnly={ownedOnly}
            onCardCount={setCardCount}
            onOwnedOnly={setOwnedOnly}
          />
        </div>
        {matching === 0 || selected === null ? (
          <Filler>
            <Note>{NO_MATCH}</Note>
          </Filler>
        ) : (
          // `min-h-0` is what makes the two scrollers below scroll at all: a flex item's default
          // `min-height: auto` is its content, so without this the row grows to the tallest of its
          // two columns and the panel's own clamp has nothing left to bite on.
          <div className="flex min-h-0 flex-1">
            <Rail
              rows={rows}
              matching={matching}
              oracleId={oracleId}
              selectedId={selected.id}
              onPick={setPicked}
              hasNext={combos.hasNextPage}
              fetching={combos.isFetchingNextPage}
              onNext={combos.fetchNextPage}
            />
            {/* **Keyed on the combo, which is a scroll reset rather than a remount for its own
                sake.** The pane is a scroller and a five-piece combo with three steps is taller
                than it; a reader who read to the foot of one and pressed the next row would
                otherwise arrive halfway down a different combo. A new key is a new element, and a
                new element starts at `scrollTop: 0`. */}
            <Pane key={selected.id} combo={selected} />
          </div>
        )}
      </>
    );

  return (
    <>
      {content}
      {/* Outside both columns: the caption is about the whole panel, so it must not scroll away
          from the thing it qualifies. */}
      <p className="border-t border-border px-4 py-3 text-xs text-dim">{AS_OF}</p>
    </>
  );
}

/**
 * The box a state that is *not* a list fills — the scroller the rail and the pane replace.
 *
 * It exists so that every one of the six sentences above is drawn in the same place and at the
 * same size as the list would have been, rather than each arm repeating four utilities and one of
 * them eventually disagreeing. Nothing about it is shared with `Note`, which is the *sentence*;
 * this is the room.
 */
function Filler({ children }: { children: ReactNode }) {
  return <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>;
}

/**
 * The scan list — one line per combo, and no card art anywhere in it.
 *
 * **Art is what the pane is for, and a picture per row is what made this surface unreadable.**
 * Each row is 59px, measured in the shipped window, and says three things: which brackets the
 * combo is legal in, which other
 * cards it needs, and how much of it the reader already owns. Those are what a reader is choosing
 * *between*; everything else about a combo is one press away and drawn at full size.
 *
 * **Paging is scrolling.** There is no *Show more*: a sentinel sits at the foot of the scroller
 * and an `IntersectionObserver` rooted on the scroller asks for the next page when it comes into
 * view. The gate is `hasNext && !fetching`, which is {@link nextComboOffset}'s answer unchanged —
 * "fewer rows in hand than `matching`, and the last page was not short" — so a page shorter than
 * asked for still ends the list whatever the count says.
 */
function Rail({
  rows,
  matching,
  oracleId,
  selectedId,
  onPick,
  hasNext,
  fetching,
  onNext,
}: {
  rows: CardCombo[];
  matching: number;
  oracleId: string | null;
  selectedId: string;
  onPick: (id: string) => void;
  hasNext: boolean;
  fetching: boolean;
  /** `fetchNextPage` itself rather than a closure over it, so this is referentially stable and
   *  the observer below is not torn down and rebuilt on every render of the rail. */
  onNext: () => unknown;
}) {
  const headingId = useId();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = scrollerRef.current;
    const target = sentinelRef.current;
    // **Gated here rather than inside the callback**, so a list with nothing left to ask for
    // observes nothing at all — and so that the observer is *re-created* when a fetch finishes,
    // which is what keeps a short list paging: a target that is already intersecting when it is
    // observed fires immediately, so a rail the first page did not fill goes on asking until it
    // is full or the list ends.
    if (root === null || target === null || !hasNext || fetching) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void onNext();
      },
      { root },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [hasNext, fetching, onNext]);

  /**
   * The arrow keys, **on the list and never on the window**.
   *
   * `Dialog` owns Escape through its capture rung and a global handler here would be a second
   * claim on a press this dialog has already settled — so every key this understands is handled
   * where the caret already is and stops there. `ArrowDown`/`ArrowUp` walk one row, `Home`/`End`
   * go to the ends, and each moves the *selection* with the focus: a rail where the caret and the
   * pane had drifted apart would need a second press to say which of them the reader meant.
   *
   * The buttons are read off the list rather than tracked in a ref array, because there is exactly
   * one per row and they are in the list's own order — a ref map would be a second copy of
   * `rows` that can disagree with it.
   */
  function onKeyDown(e: ReactKeyboardEvent<HTMLUListElement>) {
    const at = rows.findIndex((combo) => combo.id === selectedId);
    if (at < 0) return;
    const to =
      e.key === "ArrowDown"
        ? at + 1
        : e.key === "ArrowUp"
          ? at - 1
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? rows.length - 1
              : -1;
    if (to < 0 || to >= rows.length) return;
    // Both, and in this order: the press is ours, so it neither scrolls the rail by a line nor
    // reaches the panel's own `onKeyDown`.
    e.preventDefault();
    e.stopPropagation();
    const target = rows[to];
    if (target === undefined) return;
    onPick(target.id);
    // The element is already in the DOM — the rows are all rendered — so this lands before the
    // re-render the `onPick` above schedules, and the caret never passes through `<body>`.
    const buttons = e.currentTarget.querySelectorAll<HTMLButtonElement>("button");
    const button = buttons[to];
    button?.focus();
    // `nearest` parks the row flush against the scrollport, which is the **padding** box — so the
    // scroller's own `px-2 py-2` is what buys the focus ring its 4px, and `scroll-m-1.5` on the
    // row is the same 6px `DROP_MARK_ROOM` states for a mark drawn at rest.
    button?.scrollIntoView({ block: "nearest" });
  }

  return (
    <div className="flex w-[21.5rem] shrink-0 flex-col border-r border-border">
      {/* **The figure and its unit in one element, separated by a literal space** — never two
          boxes with a `gap` between them, because a `gap` is not a word separator to the
          accessible-name computation and the pair would compute as `6,044combos`. This repo has
          shipped exactly that, as `Missing2`.

          It is the one place this dialog states the size of the list. The chips carried it until
          2026-09-20 and gave it up: five figures of arithmetic in the row of controls between the
          search box and the cards is what issue #481's reporter was reading past.

          **`count` rather than `plural`**, whose own doc says so: every other caller of that
          helper counts cards or piles in a deck and none reaches four figures, where this line
          reads `6,044 combos` on the card it was written for. */}
      <h3
        id={headingId}
        className="shrink-0 px-4 pb-2 pt-3.5 text-xs uppercase tracking-wide text-dim"
      >
        {count(matching)} {matching === 1 ? "combo" : "combos"}
      </h3>
      {/* **The scroller is this box and not the `<ul>` inside it**, because the sentinel has to sit
          at the foot of the scrolled content and a `<div>` is not content a `<ul>` may hold.
          `relative` is the app's rule for any scroll container: a scroller is the containing block
          for its own absolutely positioned content, and the one that shipped without it stretched
          the document. */}
      <div ref={scrollerRef} className="relative min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {/* The list keeps a name of its own, the more exact of the two: the heading says how many
            combos there are, this says what the items in it are. */}
        <ul aria-label="Combos" aria-describedby={headingId} onKeyDown={onKeyDown}>
          {rows.map((combo) => (
            <Row
              key={combo.id}
              combo={combo}
              oracleId={oracleId}
              selected={combo.id === selectedId}
              onPick={onPick}
            />
          ))}
        </ul>
        {/* Nothing to see and nothing to announce — its whole job is to be intersected. It is
            given a height because a zero-height box is a target an observer can still report, but
            one that sits exactly on the content edge and reports differently between engines. */}
        <div ref={sentinelRef} aria-hidden="true" className="h-2" />
      </div>
    </div>
  );
}

/**
 * One line of the rail.
 *
 * Three facts and no picture: the bracket range in its box, the *other* pieces' names, and the
 * size with the ownership mark under them. **Ownership is a word and never only a colour** — the
 * whole reason to filter on *I own every piece* is to find the combo you could assemble tonight,
 * so a reader scanning the rail has to be able to see what they are short of without pressing
 * anything.
 *
 * `aria-current` rather than `aria-selected`: the list is a list of buttons rather than a
 * `listbox`, and `current` is the attribute for "the one of these the surface is showing".
 */
function Row({
  combo,
  oracleId,
  selected,
  onPick,
}: {
  combo: CardCombo;
  oracleId: string | null;
  selected: boolean;
  onPick: (id: string) => void;
}) {
  const brackets = comboBrackets(combo.bracketTag);
  const names = otherPieces(combo, oracleId)
    .map((piece) => piece.name)
    .join(" + ");
  const missing = missingCount(combo);

  return (
    <li>
      <button
        type="button"
        aria-current={selected ? "true" : undefined}
        aria-label={comboRowLabel(combo, names, brackets)}
        onClick={() => onPick(combo.id)}
        className={cn(
          "block w-full scroll-m-1.5 rounded-lg border-l-[3px] px-3 py-2.5 text-left",
          "transition-colors duration-150 motion-reduce:transition-none",
          selected ? "border-accent bg-surface" : "border-transparent hover:bg-surface/60",
          FOCUS,
        )}
      >
        <span className="flex items-start gap-2">
          {/* **`min-w-[42px]` rather than `w-`**, so the one answer that is words rather than
              numbers — a banned combo's *Not legal*, which the live feed has never yet carried —
              widens its own box instead of being clipped inside somebody else's. The second line
              sits in the column beside it rather than at a measured indent, so a row that does
              widen stays aligned with itself. */}
          <span
            className={cn(
              "min-w-[42px] shrink-0 rounded-md border px-1 py-0.5 text-center text-xs tabular-nums",
              selected ? "border-accent text-accent" : "border-border text-dim",
            )}
          >
            {bracketRange(brackets)}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium leading-snug">{names}</span>
            <span className="mt-1 flex items-center gap-1.5 text-xs text-dim">
              <span>{plural(combo.cardCount, "card")}</span>
              <span aria-hidden="true">·</span>
              <span className={missing === 0 ? "text-ok" : undefined}>{ownedSummary(missing)}</span>
            </span>
          </span>
        </span>
      </button>
    </li>
  );
}

/**
 * One combo, whole — the half of this dialog the issue was about.
 *
 * Nothing here is collapsed and nothing is abbreviated: the pieces are card frames at 176px rather
 * than 96, `produces` is the headline it is, and the five prose fields are drawn wherever the feed
 * filled them. Everything optional still goes through {@link Section}, which draws **nothing**
 * rather than an empty heading — that rule is structural rather than repeated at five call sites,
 * because five sites each remembering to check a string is five chances to ship a heading with
 * nothing under it.
 */
function Pane({ combo }: { combo: CardCombo }) {
  const tag = COMBO_TAG[combo.bracketTag];
  const brackets = comboBrackets(combo.bracketTag);
  const produces = splitLines(combo.produces);
  // Split once and read twice: the prerequisite pair decides whether its column is drawn at all
  // as well as what goes in it, and two `splitLines` of one field would be two answers to that.
  const prerequisites = splitLines(combo.easyPrerequisites);
  const notable = splitLines(combo.notablePrerequisites);
  const steps = splitLines(combo.description);

  return (
    <div className="min-w-0 flex-1 overflow-y-auto p-5">
      {/* **`flex-wrap`, because five pieces do not fit and the alternative is a sideways
          scrollbar.** An `overflow-y-auto` box computes `overflow-x` to `auto` as well, so without
          the wrap a wide row grows a horizontal scrollbar *inside* the pane.

          **Measured 2026-09-20**: a piece and its gap occupy 211px, and the pane's content box is
          **606px** at the app's own 1920×1080 — three frames (598) fit, four do not — against
          **575px** at the 1024 floor, where two fit and three wrap. So the wrap is the ordinary
          case rather than the edge one: Ashnod's Altar is in **967** five-card combos on the live
          feed, and one of them drew its five pieces over **three** rows at 1024 with
          `scrollWidth === clientWidth` throughout. */}
      <div className="flex flex-wrap items-center gap-3">
        {combo.pieces.map((piece, i) => (
          <div key={`${piece.oracleId}:${i}`} className="flex items-center gap-3">
            {/* Centred on the piece by `items-center` and offset by nothing. The accordion's `+`
                carried an `mt-[3.75rem]` that its own comment admitted was derived rather than
                measured — half of a 96px frame's height, less half a text line — and a number
                nobody has looked at is worse than no number. */}
            {i > 0 && <span className="text-xl text-dim">+</span>}
            <Piece piece={piece} />
          </div>
        ))}
      </div>

      {/* **The brackets, and the pips speak once.** `role="img"` with the sentence as the label is
          what stops five separate numbers being read as five separate things — a reader would hear
          "2 3 4 5" with no statement of what they are, and the two that are *not* filled would be
          read identically to the three that are. The filled/unfilled pair is a colour difference,
          which is exactly the kind of statement this app never makes on its own. */}
      <div className="mt-5 flex flex-wrap items-center gap-3">
        {brackets.length === 0 ? (
          // A `B` row, which the live feed has never yet carried: there is no floor to draw,
          // because *Banned* is a legality finding rather than a power one.
          <span className="text-sm">Not legal in Commander</span>
        ) : (
          <>
            <span className="text-xs uppercase tracking-wide text-dim">Legal in bracket</span>
            <span role="img" aria-label={bracketSentence(brackets)} className="flex gap-1.5">
              {[1, 2, 3, 4, 5].map((n) => (
                <span
                  key={n}
                  className={cn(
                    "flex size-[26px] items-center justify-center rounded-md border",
                    "text-[0.8125rem] font-semibold tabular-nums",
                    brackets.includes(n)
                      ? "border-accent bg-accent text-accent-fg"
                      : "border-border text-dim",
                  )}
                >
                  {n}
                </span>
              ))}
            </span>
          </>
        )}
        {/* Spellbook's own classification, in Spellbook's own words — `COMBO_TAG` imported from
            the deck bracket rather than spelled a second time here. **The letter is drawn nowhere
            in this app now**: this row said `S · Spicy — probably 3 or 4` until 2026-09-20 and was
            the only place it was printed — `DeckBracket`'s own `ComboLine` has always drawn the
            name and the sentence and never the initial. The pips above say what the letter
            *means*, which is the thing a reader wanted it for, and an `R` beside them would be a
            second vocabulary to learn.

            **One text node, and the emphasis that would have broken it lasted one afternoon.**
            The name was wrapped in a `font-medium text-text` span for a day, which reads correctly
            on screen and is unfindable as a sentence: Testing Library reads an element's *own*
            text children, so the outer span computed as `— probably 3 or 4, but hard to classify`
            and `Spicy` was a different element. That is `Note`'s rule and `src/CLAUDE.md`'s
            `Missing2` one surface over, and `DeckBracket`'s own `ComboLine` has always drawn these
            two the same way. A reader reads this as one sentence; so does the query for it. */}
        <span className="text-sm text-dim">
          {tag.name} — {tag.forces}
        </span>
      </div>

      {/* **The headline, because on this layout it is the headline of the thing.** A reader has
          picked a row off the rail by its pieces; what they are here to read is what it does. The
          feed joins its feature names with newlines and nothing here does anything to them but
          print them, so a combo with three go into one line separated the way a chip row is. */}
      {produces.length > 0 && <p className="mt-5 text-lg leading-snug">{produces.join(" · ")}</p>}

      {/* Prerequisites in a fixed column beside the steps, rather than stacked: a prerequisite is
          usually one short line and a step is usually three, so stacking them leaves a 600px band
          holding four words. 300px is wide enough for the longest prerequisite the feed writes
          without wrapping it to three lines.

          **The column is drawn only when it has something in it, and that is {@link Section}'s own
          rule one box out.** `Section` draws nothing for an empty field, which is right and was not
          enough: a *box around two* of them still spends its 300px and the row's 32px gap on
          nothing, and most of the feed's rows fill neither prerequisite field. Driven in the
          shipped window 2026-09-20 on Basalt Monolith, whose first combo has no prerequisites at
          all: the empty column sat at `left: 829` holding no text, `Steps` began at **1161** —
          332px right of `produces` at 829 — and was squeezed into **274px** of a 606px content box,
          with 300px of blank beside it. Which is the 600px-band failure this comment opens by
          claiming to avoid, reached from the other end. */}
      <div className="mt-4 flex flex-wrap gap-8">
        {(prerequisites.length > 0 || notable.length > 0) && (
          <div className="w-[300px] shrink-0">
            <Section title="Prerequisites" lines={prerequisites} />
            <Section title="Notable prerequisites" lines={notable} />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <Section title="Steps" lines={steps} ordered />
        </div>
      </div>

      {combo.manaNeeded !== "" && (
        <div className="mt-4">
          <h4 className="text-[0.6875rem] uppercase tracking-wide text-dim">Mana needed</h4>
          {/* The symbols, not the braces — the direction doc's rule, and `ManaText` carries the
              `sr-only` token beside each glyph so `{2}` is still spoken. */}
          <ManaText source={combo.manaNeeded} className="mt-0.5 text-sm" />
        </div>
      )}

      {/* **Their own sentence, and everything about it says *not the whole combo*.** A
          `requires[]` template — "a creature with flying", "a mana outlet" — is not a card id and
          can be resolved against no card list at all, so a pane that drew its named pieces and
          stopped would be this app implying a two-card combo where the feed says three things are
          needed. `DeckBracket`'s "Possible, and not counted" block is the same sentence one
          surface over. */}
      {combo.templateCount > 0 && (
        <p className="mt-4 text-xs leading-snug text-dim">
          Also needs {plural(combo.templateCount, "piece")} no card list can name — a creature with
          flying, a way to sacrifice — so the cards above are not the whole combo.
        </p>
      )}

      {/* `openExternal` is the app's single call that leaves it, and it is made **on the press**.
          Never a raw `window.open`, which in a Tauri webview navigates the app's own window — the
          rule `CardModalRail` states at its own site. */}
      <button
        type="button"
        onClick={() => void openExternal(spellbookComboUrl(combo.id))}
        className={cn(
          "mt-5 rounded-md text-xs text-dim",
          "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
          FOCUS,
        )}
      >
        View on Commander Spellbook
      </button>
    </div>
  );
}

/**
 * The box that narrows *this* list — a case-insensitive substring against any piece's name, the
 * asked-about card included.
 *
 * **Named for the list rather than for the act.** The card modal is on screen behind this dialog
 * and the app is full of boxes that say `Search cards`, so a bare `Search` here is the control
 * lying about which list it narrows — `FilterBar`'s `labels` rule, at a surface that has to obey
 * it because the *other* box is a different component on a different layer. A `useId` stem rather
 * than a constant for the second half of the same rule: two mounted boxes sharing one `id` is a
 * `getByLabelText` that cannot tell them apart, and `Dialog` mounts and unmounts this one.
 *
 * **`clearFieldOnEscape` is deliberately absent, and the omission is not a gap.** This box is
 * inside a dialog, `Dialog` registers its `"inner"` rung in the **capture** phase, and the capture
 * stack acts before an element's own `keydown` — so the call would be a line that cannot execute.
 * Escape closes the combos, which is what a reader in a modal means by it. `src/CLAUDE.md` states
 * the exception at the rule's own site.
 *
 * **{@link FILTER_FIELD} and never `FILTER_CONTROL`** — the row's chips dip 3 % under a press and a
 * box the reader types into must not, or Chromium's own ✕ slides out from under the pointer and
 * the box bounces without clearing (issue #179; the measurement is on the constant, and
 * `motion.test.ts` sweeps for the class). It is also where the finger's 44px floor comes from,
 * with no number spelled a second time here.
 */
function SearchField({ value, onChange }: { value: string; onChange: (text: string) => void }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="sr-only">
        Search these combos
      </label>
      <input
        id={id}
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search these combos by piece…"
        className={cn(
          FILTER_FIELD,
          FOCUS,
          // Full width, because this is the panel's own row rather than one control in a wrapping
          // filter bar — there is nothing beside it to leave room for.
          "w-full min-w-0 border-border bg-bg px-3 placeholder:text-dim focus:border-accent",
        )}
      />
    </div>
  );
}

/**
 * The two filters — a chip per combo size, and a toggle for the ones the reader can build today.
 *
 * **The counts are gone and the census is not.** A chip read `3 cards · 1 999` until 2026-09-20,
 * which is five figures of arithmetic in a row of controls sitting between a search box and the
 * cards the reader opened this to look at — the thing issue #481 describes reading past. The
 * number it was carrying is drawn once, over the rail, where it describes the list it is a count
 * of. What the census still decides is which chips exist at all, and both rules below are
 * unchanged.
 *
 * **A chip is drawn only for a size the backend has combos for.** `byCardCount` is the census, so
 * a bucket that is not in it is a size that does not exist for this card — and inventing a `5+`
 * chip would send the backend a `cardCount` it reads as an exact size and get an empty list back.
 * A bucket that somehow arrives at zero is dropped for the same reason: a chip that can only ever
 * empty the list is a control that lies.
 *
 * **The census these are drawn from is the searched one, and the one exception to the sentence
 * above is what the search made necessary.** A reader can narrow to `3 cards` and then type a term
 * no three-card combo matches, at which point the size the query is still carrying has no bucket —
 * so the chip that is emptying the list would vanish from the row and take the way back with it,
 * leaving *No combo matches that filter* over a row of controls none of which is on. So a
 * **pressed** size keeps its chip. That is not the control that lies: it is the one that is doing
 * the emptying, said out loud, and pressing it again is the way out.
 */
function Filters({
  page,
  cardCount,
  ownedOnly,
  onCardCount,
  onOwnedOnly,
}: {
  page: CardCombosPage | null;
  cardCount: number | null;
  ownedOnly: boolean;
  onCardCount: (cards: number | null) => void;
  onOwnedOnly: (only: boolean) => void;
}) {
  const census = page?.byCardCount ?? [];
  const buckets = census
    .filter((bucket) => bucket.combos > 0)
    // The pressed size, kept even where the search left it no bucket — see the header. Appended
    // before the sort, so it lands in size order like any other chip.
    .concat(
      cardCount !== null && !census.some((bucket) => bucket.cards === cardCount)
        ? [{ cards: cardCount, combos: 0 }]
        : [],
    )
    // Ascending, and sorted here rather than trusted: the display order of a filter row is this
    // file's decision, it costs one pass over at most a handful of buckets, and a row whose chips
    // moved with the backend's `GROUP BY` would reorder under the reader for no reason they could
    // see.
    .sort((a, b) => a.cards - b.cards);

  return (
    // `flex-wrap`, because the narrowest surface that draws a row of chips decides its height —
    // this panel is `w-[62rem]` above the phone fold and the whole glass below it, and an unwrapped
    // row just hangs out of the panel and turns into a horizontal scrollbar.
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <ToggleChip label="All" pressed={cardCount === null} onClick={() => onCardCount(null)} />
      {buckets.map((bucket) => (
        <ToggleChip
          key={bucket.cards}
          label={plural(bucket.cards, "card")}
          pressed={cardCount === bucket.cards}
          // Pressing the chip that is already on goes back to All — the row has no "off" state of
          // its own, and a reader who narrowed by mistake should not have to find the other chip.
          onClick={() => onCardCount(cardCount === bucket.cards ? null : bucket.cards)}
        />
      ))}
      <ToggleChip
        label="I own every piece"
        pressed={ownedOnly}
        onClick={() => onOwnedOnly(!ownedOnly)}
      />
    </div>
  );
}

/**
 * One card of a combo — its picture at full size, its name, and whether the reader has it.
 *
 * **176px rather than 96, which is the whole of issue #481 in one number.** `w-44` against a 5:7
 * frame is 176 × 246, near enough double the accordion's `w-24`, and the pane exists so that there
 * is room for it.
 *
 * **Ownership is a word and never only a colour.** A green frame would say nothing to the readers
 * this rule exists for, and this is the surface where it matters most: the whole reason to filter
 * on *I own every piece* is to find the combo you could assemble tonight.
 */
function Piece({ piece }: { piece: ComboPiece }) {
  return (
    <span className="flex w-44 flex-col gap-1.5">
      <CardArt
        cardId={piece.cardId}
        name={piece.name}
        // **The protocol URL is computed here and passed in**, which is `lib/images.ts`'s rule and
        // load-bearing rather than a style: `.storybook/main.ts` aliases `@/lib/images` to a fake
        // whose whole job is to replace `cardImageUrl` with generated art, and a call made *inside*
        // that module would reach the real function and paint every story a broken image.
        //
        // `cardId === null` is a card this corpus has never synced — the feed names cards the
        // reader's database may simply not have — and `CardArt` draws its named, empty frame for
        // it, which is this app's existing "no art" state rather than an error.
        imageUrl={piece.imageUris?.[WALL_CARD_VARIANT] ?? null}
      />
      <span className="text-[0.9375rem] leading-snug">{piece.name}</span>
      {/* A count laid **beside** a card keeps its `×` — `CountTag`'s bare number is for a count
          laid *on* one, where the tag it is printed on says what is being counted. */}
      {piece.quantity > 1 && <span className="text-xs text-dim">×{piece.quantity}</span>}
      {/* **The command-zone caveat rides the ownership line rather than sitting on its own.** It
          is a fact about how this piece has to be *played*, not a third status — and on a rail
          that now shows one combo at a time, a line of its own under two lines of type reads as a
          fourth caption nobody asked for. */}
      <span className={cn("text-xs", piece.owned >= piece.quantity ? "text-ok" : "text-dim")}>
        {ownedNote(piece.owned, piece.quantity)}
        {piece.mustBeCommander && " · must be your commander"}
      </span>
    </span>
  );
}

/**
 * What the reader has of one piece, in words.
 *
 * `0` is an answer rather than a gap, and it is the answer this surface is most often about. The
 * partial case is spelled out because "Owned" over one copy of a combo that wants two would be
 * wrong in the direction that costs the reader a game.
 */
function ownedNote(owned: number, quantity: number): string {
  if (owned === 0) return "Not owned";
  if (owned >= quantity) return "Owned";
  return `${owned} of ${quantity} owned`;
}

/**
 * A `'\n'`-joined feed field, as lines.
 *
 * Blank entries are dropped rather than drawn: a trailing newline is a wire artefact and an empty
 * `<li>` is a bullet with nothing beside it. An all-blank field therefore comes back `[]`, which
 * is what {@link Section} tests — so "the field was empty" and "the field was three newlines" draw
 * the same nothing.
 */
function splitLines(source: string): string[] {
  return source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/**
 * A titled block of lines, or nothing at all.
 *
 * **The empty case is the whole reason this exists.** The fields it draws are `""` on a large share
 * of the feed's rows, and a heading with nothing under it reads as content that failed to load —
 * which on a surface whose *other* empty states are carefully distinguished sentences would be the
 * one place the panel said something it did not mean.
 */
function Section({
  title,
  lines,
  ordered = false,
}: {
  title: string;
  lines: string[];
  /** Numbered, for `description` — Spellbook's steps are a sequence and reading them out of order
   *  is reading a different combo. Everything else is a set. */
  ordered?: boolean;
}) {
  if (lines.length === 0) return null;
  // Written out twice rather than picking the tag with a variable: `<List>` over a `"ol" | "ul"`
  // union is a JSX element type TypeScript resolves to the intersection of the two elements'
  // props, and the numbering is the whole difference between the two anyway.
  const items = lines.map((line, i) => <li key={i}>{line}</li>);
  return (
    // `first:mt-0`, because which of these is first is the *feed's* decision: a combo whose only
    // filled field is `notablePrerequisites` opens the column on that block, and a block carrying
    // the gap meant for one above it would sit 12px low for that row alone.
    <div className="mt-3 first:mt-0">
      <h4 className="text-[0.6875rem] uppercase tracking-wide text-dim">{title}</h4>
      {ordered ? (
        <ol
          aria-label={title}
          className="mt-1 list-decimal space-y-1 pl-5 text-sm leading-snug marker:text-dim"
        >
          {items}
        </ol>
      ) : (
        <ul aria-label={title} className="mt-1 space-y-1 text-sm leading-snug">
          {items}
        </ul>
      )}
    </div>
  );
}

/**
 * One dim sentence in the body — every state that is not a list of combos.
 *
 * **One text node, and that is load-bearing rather than tidy.** Testing Library reads an element's
 * *own* text children, so a sentence broken by a `<span>` becomes unfindable by anything that
 * queries it as a sentence — which is how a reader reads it, and how the test for it is written.
 * `OracleTagsDialog`'s `Note` and `LegalityDialog`'s two captions say the same thing at their own
 * sites; this is the third.
 */
function Note({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("text-sm leading-relaxed text-dim", className)}>{children}</p>;
}
