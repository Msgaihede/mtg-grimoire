import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { FOCUS } from "@/lib/focus";
import { AUTO_BRACKET, ipc, type ComboBracketTag, type DeckCard, type DeckCombo } from "@/lib/ipc";
import { LAYER } from "@/lib/layers";
import { popup } from "@/lib/motion";
import { COMBOS_STATUS_KEY, combosForCardsKey } from "@/lib/query";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { cn } from "@/lib/utils";
import { bracketWarning, estimateBracket } from "./validation/bracket";

/**
 * The Commander bracket, as a readout on the header's ledger and an advisory behind it.
 *
 * **It rode inside the format check's panel until 2026-08-24** and had no control of its own: a
 * reader who wanted to know what bracket their deck read as had to open a list of *findings* and
 * scroll past them. The two are different questions — the check says what is broken, this says
 * how strong the deck is, and a bracket cannot make a deck illegal — so they are two presses on
 * one line now rather than one press with the second answer stapled underneath.
 *
 * **Advisory in the copy as well as in the code.** Wizards' scale is explicitly "advisory only,
 * not hard validation" (the research doc), so the number is prefixed `~`, the panel leads with
 * the word estimate, and the disclosure names every card the number was read from — a reader who
 * disagrees with a heuristic can see which card caused it, which is the only thing that makes a
 * guess like this worth showing at all.
 *
 * **The estimate is computed on every edit now, and that is what the control costs.** It used to
 * be gated on the panel being open (`estimateBracket` greps every face of every card for four
 * phrases) — which is no longer possible, because the *button* prints the number. Memoised on
 * the rows, so it is one pass per change to the deck rather than one per render; the caller draws
 * this only for a format with a command zone, which is the whole of where a bracket means
 * anything.
 *
 * The panel is an `"inner"` Escape rung and the same piece of editor state as every dialog, so it
 * and the check can never be open at once — see `DeckEditor`'s `Layer` union, which is where that
 * is made structural.
 *
 * ## What 2026-08-27 added: a number the reader owns, and a fourth signal
 *
 * **A reading and an answer are different things, and the control now says which one it is
 * holding.** `decks.bracket` is `0` for Auto and 1–5 set by hand, so `Bracket ~3` is what the
 * cards read as and `Bracket 3` is what the reader told the deck it is. The `~` is the whole of
 * the visible difference and it is doing real work: the scale is a conversation opener, and a
 * reader who has *had* that conversation should not have their table's agreement re-derived from
 * their card list every time they open the deck.
 *
 * **The estimate became a floor, which is what every bracket restriction already was.** The
 * document says "not allowed below bracket N" — never "this deck is an N" — so what the cards
 * can honestly say is the bottom of a range. That is also the only thing that makes a *mismatch*
 * statable: a bracket set below the floor is a deck whose cards say it cannot sit that low.
 * It is **never 5, and since 2026-09-01 never 1**: both ends of the scale are an intent rather
 * than a card list — 4 and 5 have identical deck restrictions and differ only on whether the deck
 * is built for the cEDH metagame, and 1 Exhibition asks that its builder "prioritize a goal,
 * theme, or idea over power". So the reading spans 2 to 4 and the two ends are numbers only the
 * picker in the panel can produce. A deck that flags nothing reads `Bracket ~2`.
 *
 * **The fourth signal is two-card combos, which cannot be read out of a card's own text at
 * all** — a combo is a fact about an *interaction*. Commander Spellbook's bulk file supplies
 * them and their `bracketTag`, and it is a fourth optional feed like the price lists and the two
 * tagger datasets: a database that has never fetched it reads three signals instead of four, and
 * {@link Advisory} says so in words rather than letting silence imply the deck has none.
 */
export function DeckBracket({
  cards,
  bracket,
  onBracket,
  open,
  buttonRef,
  onOpen,
  onDismiss,
  onClose,
}: {
  cards: readonly DeckCard[];
  /** `decks.bracket` — {@link AUTO_BRACKET} when the reader has not said, 1–5 when they have. */
  bracket: number;
  /**
   * The picker's write: `deckUpdate(id, { bracket })`, which the editor owns because the deck's
   * id and its mutation live there. Its refusal lands in that editor's one banner with every
   * other write's, because the rule is on `deck.update`'s single definition and never here.
   */
  onBracket: (bracket: number) => void;
  open: boolean;
  /** The button, so the editor can hand the caret back to it on the way out. */
  buttonRef: RefObject<HTMLButtonElement | null>;
  onOpen: () => void;
  /** Escape, and the button pressed a second time: the caret comes back to the button. */
  onDismiss: () => void;
  /** Focus left on its own. Closes and hands nothing back — the reader is already somewhere
   *  else. */
  onClose: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);

  /**
   * The printings the two readings are made from, deduped and sorted — **and this array is the
   * cache key**, which is the whole of how a deck edit produces a fresh answer.
   *
   * `combosForCardsKey` (`@/lib/query`, where the literal lives) is keyed on the *contents*
   * rather than on the deck, so an
   * added card is a different query and fetches by construction. That matters twice over here:
   * `query.ts` caches 30 s, so a key that did not move would go on answering what it answered
   * before the edit for half a minute — and **a mounted observer refetches only when its query
   * is actually invalidated**, so a stable key with no invalidation behind it would never
   * refetch at all while the editor stayed open. Keying on the ids needs neither: nothing has to
   * remember to invalidate anything, because the question itself changed.
   *
   * The converse is the part worth stating: a *quantity* change does not move this key, and that
   * is correct rather than stale. A combo is a fact about which cards are in the deck, and a
   * second Sol Ring is not a fifth combo piece.
   *
   * `categoryActive` filters the same pile `estimateBracket` drops — a switched-off Maybeboard is
   * not the deck — so the combo half and the oracle half are read off one list.
   */
  const cardIds = useMemo(() => {
    const ids = new Set<string>();
    for (const card of cards) if (card.categoryActive) ids.add(card.cardId);
    return [...ids].sort();
  }, [cards]);

  const combos = useQuery({
    queryKey: combosForCardsKey(cardIds),
    queryFn: () => ipc.combosForCards(cardIds),
  });

  /**
   * Whether the combo list has ever been downloaded — **not** gated on the panel being open.
   *
   * One local read per Commander deck opened, shared by key with every other mount of this
   * control and with the Settings panel that refreshes the feed. `enabled: open` would save that
   * read and cost the one thing this panel may not do: on the first press the answer would still
   * be in flight, and a panel that draws no combos and says nothing about why is a panel
   * implying the deck has none when the truth is that nothing has been looked at.
   */
  const status = useQuery({ queryKey: COMBOS_STATUS_KEY, queryFn: () => ipc.combosStatus() });

  /**
   * The reading. **Three signals until the combo read lands, four after it** — which is the same
   * arithmetic a database that has never ingested the feed gets, and it is honest in both cases:
   * a floor is the bottom of a range, so a floor computed from fewer signals is low rather than
   * wrong, and it rises when the answer arrives.
   */
  const found = combos.data ?? NO_COMBOS;
  const estimate = useMemo(() => estimateBracket([...cards], found), [cards, found]);

  /**
   * The mismatch, as **one** condition rather than two.
   *
   * The button's treatment and the panel's sentence are both `bracketWarning` returning
   * something, so the two cannot end up disagreeing about whether there is a mismatch — which is
   * exactly what a `bracket < estimate.floor` written out here beside a sentence written in
   * `validation/bracket.ts` would eventually do. The rule is the validation layer's; this file
   * only draws it.
   */
  const set = bracket !== AUTO_BRACKET;
  const warning = set ? bracketWarning(bracket, estimate) : null;

  useDismissOnEscape({ layer: "inner", onDismiss, enabled: open });

  return (
    <div
      ref={rootRef}
      className="relative"
      // Clicking or tabbing away closes it, without a window listener that could fight the
      // Escape handshake. The boundary is the whole control rather than the panel, which is what
      // keeps the button a toggle: a press on it blurs the panel first, and a handler that did
      // not know the button would close the panel and let the press reopen it.
      onBlur={(e) => {
        if (open && !rootRef.current?.contains(e.relatedTarget)) onClose();
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        // **Three names, because there are three claims and only one of them is a reading.**
        // The `~` is drawn and is not spoken — a screen reader says "tilde four" or nothing at
        // all — so the word the glyph stands for goes here; and where there is no glyph the
        // name still has to say whose number this is, because "Bracket 3" alone cannot tell a
        // reader's own answer from the app's guess. The mismatch says it in words for the same
        // reason the treatment below says it in pixels: neither carrier reaches both readers.
        // Every one of the three begins with the visible label (WCAG 2.5.3).
        aria-label={
          !set
            ? `Bracket ${estimate.floor}, an estimate`
            : warning === null
              ? `Bracket ${bracket}, set for this deck`
              : `Bracket ${bracket}, set for this deck — the cards read as bracket ` +
                `${estimate.floor} or higher`
        }
        onClick={() => (open ? onDismiss() : onOpen())}
        className={cn(
          "inline-flex h-7 shrink-0 items-center whitespace-nowrap rounded-md border",
          "px-2 font-mono text-[0.6875rem] tabular-nums",
          // **Accent, and it is not a state.** The bracket is the one figure on this line that is
          // a *reading* rather than a count, and the edge is what says the number came from
          // somewhere the reader can go and look. The check beside it colours a glyph instead,
          // for the reason on that control: red and green there mean broken and clean, and there
          // is no such pair here — a bracket 5 deck is not a worse deck.
          "border-accent text-accent",
          "transition-colors duration-150 motion-reduce:transition-none",
          // **The mismatch is the same accent stated louder, and it is deliberately neither of
          // the check's two colours.** A bracket 2 deck holding a bracket 4 combo is not
          // *broken* — nothing about it is illegal, and `--destructive` next to a check chip
          // already drawing `TriangleAlert` in that exact colour would read as a second, milder
          // rule break. It is not *clean* either, so `--color-ok` is out by the same argument.
          // What it is is two answers about one deck that do not agree, and the honest way to
          // draw that is to show both of them: the fill draws the eye, the second number tells
          // it what to look at, and the `~` in front of that number already means "a reading" on
          // this very control. No new token and no new glyph — a tinted *surface* cannot be read
          // as a severity when it is the colour the control was already wearing.
          //
          // It costs width, once, and that is paid on purpose. The alternative — a fill alone —
          // is a signal carrying no information: it says something is up and leaves the reader
          // to open the panel to learn which of the five numbers it is up about.
          warning !== null ? "bg-accent/15 hover:bg-accent/25" : "hover:bg-accent/10",
          FOCUS,
        )}
      >
        {!set ? `Bracket ~${estimate.floor}` : `Bracket ${bracket}`}
        {warning !== null && ` · ~${estimate.floor}`}
      </button>

      <AnimatePresence>
        {open && (
          <Advisory
            key="advisory"
            estimate={estimate}
            bracket={bracket}
            warning={warning}
            onBracket={onBracket}
            comboState={
              status.data?.fetchedAt === null
                ? "never"
                : combos.isPending
                  ? "reading"
                  : combos.isError
                    ? "failed"
                    : "read"
            }
          />
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * The empty combo list, as one object.
 *
 * `useQuery` answers `undefined` until it has something, and a fresh `[]` per render would make
 * the `estimate` memo's dependency change on every render — which is the exact cost the memo
 * exists to avoid, and it would be invisible: the number would be right and the pass would run
 * for nothing.
 */
const NO_COMBOS: DeckCombo[] = [];

/** Where the combo half of the reading stands. Four states and no boolean pair, because
 *  "nothing found" and "nothing looked at" are the two this panel must never blur. */
type ComboState = "never" | "reading" | "failed" | "read";

/**
 * The five brackets, named — **and the names are the point of this row**.
 *
 * A reader who knows the scale picks a digit; a reader who does not has no way to tell 2 from 3
 * from a number alone, and "2" is not a thing anybody has ever been asked at a table. The name
 * is what they were asked. It cannot go on the chip — five names side by side do not fit a 288px
 * panel and a row that wrapped to three lines would be a bigger control than the advisory it
 * sits in — so it goes in three places that cost no width: the chip's accessible name, its
 * tooltip, and the caption under the row, which spells out whichever one is currently chosen.
 *
 * The clauses are the October 2025 wording, paraphrased from the research doc's table. **1 and 5
 * are the two a card list can never produce**, and both clauses say so: 4 and 5 have identical
 * deck restrictions, so setting 5 is a statement about the metagame the deck is built for, and 1
 * asks that the deck prioritise a theme over power, which is a statement about why it was built.
 * Both are exactly the kind of thing this picker exists to let a reader say.
 */
const BRACKETS: readonly { value: number; label: string; name: string; clause: string }[] = [
  {
    value: AUTO_BRACKET,
    label: "Auto",
    name: "Auto",
    clause: "read from the cards, and it moves as the deck does",
  },
  {
    value: 1,
    label: "1",
    name: "Exhibition",
    clause: "a theme over power, and no extra turns — no card list can show it",
  },
  { value: 2, label: "2", name: "Core", clause: "extra turns in low quantities, never chained" },
  {
    value: 3,
    label: "3",
    name: "Upgraded",
    clause: "up to three Game Changers, and no early two-card combos",
  },
  {
    value: 4,
    label: "4",
    name: "Optimized",
    clause: "nothing restricted — mass land denial and combos allowed",
  },
  {
    value: 5,
    label: "5",
    name: "cEDH",
    clause: "bracket 4's card list, built for the competitive metagame — no card list can show it",
  },
];

/**
 * What each `bracketTag` letter means, **in Commander Spellbook's own words**.
 *
 * This is a label table and deliberately not a second copy of the floor: the numbers a letter
 * implies are `validation/bracket.ts`'s arithmetic and belong to it alone, and a display table
 * that also carried them would be a thing that could quietly disagree with the rule it is
 * describing. What it carries instead is the *source's* description of its own classification
 * (`commanderspellbook.com/syntax-guide/`, read 2026-08-27), which cannot drift from this app's
 * rules because it is not one of them — and which is the honest thing to put in front of a
 * reader anyway, since the letter is a judgement Spellbook's editors made per combo rather than
 * one this app derived.
 *
 * `B` (banned) is in the table because a row can carry it; it raises no floor here, because a
 * banned card is a *legality* finding and the check chip beside this control already reports it
 * off the banned list.
 */
const COMBO_TAG: Record<ComboBracketTag, { name: string; forces: string }> = {
  E: { name: "Exhibition", forces: "for any deck" },
  C: { name: "Core", forces: "for unoptimized decks in bracket 2+" },
  O: { name: "Oddball", forces: "probably 2 or 3, but hard to classify" },
  P: { name: "Powerful", forces: "for strong decks in bracket 3+" },
  S: { name: "Spicy", forces: "probably 3 or 4, but hard to classify" },
  R: { name: "Ruthless", forces: "for competitive decks at brackets 4+" },
  B: { name: "Banned", forces: "not legal in Commander" },
};

/** What the number was read from, what the reader can say back, and the sentence that keeps the
 *  reading a guess. */
function Advisory({
  estimate,
  bracket,
  warning,
  onBracket,
  comboState,
}: {
  estimate: ReturnType<typeof estimateBracket>;
  bracket: number;
  /** {@link bracketWarning}'s sentence, or `null`. Computed by the caller so the button's
   *  treatment and this panel's first line are one decision. */
  warning: string | null;
  onBracket: (bracket: number) => void;
  comboState: ComboState;
}) {
  const gameChangers = estimate.gameChangers;
  const panelRef = useRef<HTMLDivElement>(null);
  const [why, setWhy] = useState(false);
  const tip = useTooltip();
  /** False from the render that starts the exit, which is a state this panel has never been in
   *  before: painted, laid out, and no longer the thing the button is describing. */
  const present = useIsPresent();

  // The caret moves into the layer, as it does for every other one in this editor: the picker
  // below is then the next thing Tab reaches, and Escape has something to hand back.
  useEffect(() => {
    panelRef.current?.focus({ preventScroll: true });
  }, []);

  const read: { label: string; names: string[] }[] = [
    { label: "Game changers", names: estimate.gameChangerNames },
    { label: "Mass land denial", names: estimate.massLandDenial },
    { label: "Extra turns", names: estimate.extraTurns },
  ].filter((line) => line.names.length > 0);

  const chosen = BRACKETS.find((rung) => rung.value === bracket) ?? BRACKETS[0];

  return (
    <motion.div
      {...popup}
      ref={panelRef}
      tabIndex={-1}
      role="dialog"
      aria-label="Bracket estimate"
      // On the way out it is a picture of a panel and nothing else — not clickable, and not in
      // the accessibility tree, where a second copy of the button's own reading would be. The
      // caret was handed back to the button before this render.
      aria-hidden={present ? undefined : true}
      className={cn(
        // Pinned by its right edge, because the button is the last control on the ledger and a
        // panel opening rightwards off it is a panel half outside the page — and right overflow
        // on this scroller is a horizontal scrollbar the editor must never have.
        "absolute right-0 top-9 w-72 max-w-[calc(100vw-2rem)] rounded-lg border",
        "border-border bg-bg/95 p-3 text-xs shadow-lg",
        // The scale grows from the corner the panel is pinned by — one that grew from its own
        // middle would read as unrelated to the button it hangs off.
        "origin-top-right",
        !present && "pointer-events-none",
        LAYER.popup,
        // The panel scrolls rather than the editor, which is `ValidationPanel`'s rule for its
        // findings list and arrived here with the combos: a cEDH deck can match dozens of them,
        // and a layer taller than the window has no way back to its own button.
        "max-h-[60vh] overflow-y-auto",
        // No focus outline: a landing pad, not a control — `tabIndex={-1}` only so the caret has
        // somewhere to go while the panel is open, and neither Tab nor an arrow reaches it. The
        // button it was opened from is what wears the mark. `src/lib/focus.ts` has the rule.
      )}
    >
      {/* **The mismatch leads**, above the reading it is about. It is the one thing in this
          panel the reader did not already know from the button — the button can say *that* the
          two numbers disagree, and only a sentence can say what makes them. The accent rule is
          `ValidationPanel`'s per-finding shape at this panel's size; the colour is the same
          accent the control wears everywhere else, for the reason written on the button. */}
      {warning !== null && (
        <p className="mb-2 border-l-2 border-accent pl-2 leading-snug text-text">{warning}</p>
      )}

      {/* One text run: a headline fact split across styled spans is a sentence nothing — screen
          reader, test, or reader skimming — puts back together. Geist Mono for the counts, as
          everywhere else data is counted. It prints the **floor** whatever the reader has set,
          because this line is the reading and the picker below is the answer. */}
      <p className="font-mono font-medium tabular-nums">
        Bracket ~{estimate.floor} · {gameChangers} game changer{gameChangers === 1 ? "" : "s"}
      </p>
      <p className="mt-1 text-dim">
        An estimate from what this app can see, and a floor rather than a verdict: the cards say
        what this deck cannot sit below, never what it is. A bracket is a conversation at the
        table, never a rule this deck can fail.
      </p>

      {/* **A real radio group rather than six buttons**: one of six is chosen, exactly one is
          true at a time, and `aria-checked` is the only thing that says so to a reader who
          cannot see which one is gold. `ExportDialog`'s format row and `TagSearchBox`'s
          namespace row are the app's other two, and **each radio is its own tab stop rather
          than a roving caret** for the reason written on that second one: two radio groups in
          one app that answered the arrow keys differently would be worse than one that answers
          them nowhere. */}
      <div
        role="radiogroup"
        // Named for the question rather than for the answers — `role="radiogroup"` takes no name
        // from its contents, so without this a screen reader hears six loose tokens.
        aria-label="Bracket for this deck"
        className="mt-2 flex flex-wrap gap-1"
      >
        {BRACKETS.map((rung) => {
          const on = rung.value === bracket;
          const name = rung.label === rung.name ? rung.name : `${rung.label} ${rung.name}`;
          return (
            <button
              key={rung.value}
              type="button"
              role="radio"
              aria-checked={on}
              // The digit alone is not a name — see {@link BRACKETS}. The clause is not in here
              // on purpose: a name is what a control is *called*, and folding the explanation
              // into it would have a screen reader read the whole scale out on every pass
              // through the row.
              aria-label={name}
              {...tip(`${name} — ${rung.clause}`, { describes: false })}
              onClick={() => onBracket(rung.value)}
              className={cn(
                "inline-flex h-6 shrink-0 items-center rounded-md border px-2",
                "font-mono text-[0.6875rem] tabular-nums",
                "transition-colors duration-150 motion-reduce:transition-none",
                on
                  ? "border-accent text-accent"
                  : "border-border text-dim hover:border-accent hover:text-accent",
                FOCUS,
              )}
            >
              {rung.label}
            </button>
          );
        })}
      </div>
      {/* The caption is the row's legibility, and it is one line rather than five: whichever
          rung is chosen, spelled out. `aria-hidden`, because every word of it is already in the
          chosen radio's own name and its tooltip — a screen reader that read both would hear
          the same clause twice for one press. */}
      <p className="mt-1 text-dim" aria-hidden="true">
        {chosen.name} — {chosen.clause}
      </p>

      {/* **The combos, and the four states the reader may be in — of which two look identical
          on screen and mean opposite things.** "No combos matched" is a claim about a list that
          was consulted; a database that has never fetched the feed has consulted nothing, and
          writing the first sentence in the second state is the one thing this panel may never
          do. So the never-ingested case is checked first and says where to go, the in-flight and
          failed cases say so rather than falling through to a count of zero, and only a read
          that actually answered may say the deck has none. */}
      {comboState === "never" ? (
        <p className="mt-2 leading-snug text-dim">
          No combo list has been downloaded, so nothing here has been checked for two-card combos
          at all — this reading is three signals rather than four. Fetch it from Settings, under
          Combos.
        </p>
      ) : comboState === "reading" ? (
        <p className="mt-2 text-dim">Reading combos…</p>
      ) : comboState === "failed" ? (
        <p className="mt-2 leading-snug text-dim">
          The combo list could not be read, so this reading is three signals rather than four.
        </p>
      ) : estimate.combos.length === 0 && estimate.possibleCombos.length === 0 ? (
        <p className="mt-2 text-dim">No two-card combo in the list matches this deck.</p>
      ) : (
        <>
          {estimate.combos.length > 0 && (
            <ul className="mt-2 space-y-1.5">
              {estimate.combos.map((combo) => (
                <ComboLine key={combo.id} combo={combo} confirmed />
              ))}
            </ul>
          )}

          {/* **Their own line, and everything about it says *not counted*.** Every card these
              name is in the deck, but each also needs a `requires[]` template — "a creature with
              flying", "a mana outlet" — which is not a card id and cannot be resolved against a
              decklist at all. So they raise no floor, they carry no accent rule, and the sentence
              above them says what is missing rather than leaving a reader to infer it from a
              heading. A possible combo shown as a found one would be this app inventing a
              restriction the reader's deck does not have. */}
          {estimate.possibleCombos.length > 0 && (
            <>
              <p className="mt-2 leading-snug text-dim">
                Possible, and not counted: every card named below is in this deck, but each combo
                also needs something no card list can answer for — a creature with flying, a way
                to sacrifice. Nothing here has been confirmed.
              </p>
              <ul className="mt-1 space-y-1.5">
                {estimate.possibleCombos.map((combo) => (
                  <ComboLine key={combo.id} combo={combo} confirmed={false} />
                ))}
              </ul>
            </>
          )}
        </>
      )}

      {read.length > 0 && (
        <>
          <button
            type="button"
            aria-expanded={why}
            onClick={() => setWhy((v) => !v)}
            className={cn(
              "mt-1 inline-flex items-center gap-1 rounded-md text-dim",
              "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
              FOCUS,
            )}
          >
            <ChevronRight
              className={cn(
                "size-3 transition-transform duration-150 motion-reduce:transition-none",
                why && "rotate-90",
              )}
              aria-hidden="true"
            />
            What this read
          </button>
          {why && (
            <dl className="mt-1 space-y-1">
              {read.map((line) => (
                <div key={line.label}>
                  <dt className="text-dim">{line.label}</dt>
                  <dd>{line.names.join(", ")}</dd>
                </div>
              ))}
            </dl>
          )}
        </>
      )}
    </motion.div>
  );
}

/**
 * One combo: what it is, what its letter means, and what it does.
 *
 * The names are one text run joined by `+` rather than a list of elements, for the headline's
 * reason — a fact split across elements is one nothing puts back together, and "Thassa's Oracle
 * + Demonic Consultation" is the shape a reader already knows from every combo list they have
 * read.
 *
 * `produces` arrives `'\n'`-joined from the feed (`Infinite lifegain`, `Win the game`) and is
 * drawn only where there is one: a combo whose feature list came through empty gets two lines
 * rather than a third that says nothing.
 */
function ComboLine({ combo, confirmed }: { combo: DeckCombo; confirmed: boolean }) {
  const tag = COMBO_TAG[combo.bracketTag];
  const produces = combo.produces
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join(", ");
  return (
    <li className={cn("border-l-2 pl-2 leading-snug", confirmed ? "border-accent" : "border-border")}>
      <p className={confirmed ? undefined : "text-dim"}>{combo.cards.join(" + ")}</p>
      <p className="text-dim">
        {tag.name} — {tag.forces}
      </p>
      {produces !== "" && <p className="text-dim">{produces}</p>}
    </li>
  );
}
