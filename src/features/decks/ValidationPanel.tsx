import { Fragment, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { ChevronRight, CircleCheck, TriangleAlert } from "lucide-react";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import { FILTER_CONTROL, FILTER_FOCUS } from "@/components/FilterChips";
import { FOCUS } from "@/lib/focus";
import type { DeckCard, FormatSpec } from "@/lib/ipc";
import { LAYER } from "@/lib/layers";
import { popup } from "@/lib/motion";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { cn } from "@/lib/utils";
import { estimateBracket } from "./validation/bracket";
import { validateDeck } from "./validation/engine";
import type { ValidationIssue } from "./validation/types";

/**
 * What each of the engine's `code`s is called on screen.
 *
 * The codes are stable machine handles (`validation/types.ts` lists the vocabulary); these are
 * the words a reader groups by. Prose only — the *content* of a finding is always the engine's
 * own sentence, verbatim, because a panel that paraphrased a rule would be a second place for
 * that rule to be stated and the two would drift.
 *
 * A code with no entry falls back to its own handle with the dashes taken out, so a rule added
 * to the engine tomorrow lists under a plain heading rather than vanishing from the panel.
 */
const CODE_LABEL: Record<string, string> = {
  "deck-size": "Deck size",
  "sideboard-size": "Sideboard",
  "copy-limit": "Copy limits",
  singleton: "Singleton",
  restricted: "Restricted cards",
  banned: "Banned cards",
  "not-legal": "Outside the format",
  "unknown-legality": "Legality this app could not read",
  "unknown-copy-limit": "Copy counts this app could not read",
  orphan: "Cards that left the card database",
  "mana-value": "Mana value",
  "commander-zone": "Commander zone",
  "commander-missing": "Missing commander",
  "commander-count": "Commander count",
  "commander-eligibility": "Commander eligibility",
  "commander-partner": "Partners",
  "commander-banned": "Banned as commander",
  "color-identity": "Color identity",
  "companion-zone": "Companion zone",
  "companion-count": "Companion count",
  "companion-eligibility": "Companion eligibility",
  "companion-unknown": "Companion not recognised",
  "companion-condition": "Companion condition",
};

function codeLabel(code: string): string {
  return CODE_LABEL[code] ?? `${code[0].toUpperCase()}${code.slice(1)}`.replace(/-/g, " ");
}

/** A card an issue is about, in the two fields a way into the deck needs. */
export interface NamedCard {
  cardId: string;
  name: string;
}

/** One run of an issue's sentence: prose, or a card the reader can press. */
export interface MessagePart {
  text: string;
  /** The card this run names, or `null` for the words around it. */
  cardId: string | null;
}

/**
 * Split one finding's sentence at the names of the cards it is about.
 *
 * The engine writes whole sentences with the card names already in them, and the panel prints
 * them **verbatim** — so the only honest way to make a card reachable from its own sentence is
 * to find the name where the engine put it. Nothing is added, reordered or reworded: the parts
 * concatenate back to the message exactly.
 *
 * Only the cards the issue itself names are searched, never the whole deck, so a sentence that
 * happens to contain another card's name does not sprout a control that opens the wrong card.
 * Where two names overlap the longer wins, or "Ancient Tomb" would list as prose plus a button
 * reading "Tomb".
 */
export function messageParts(message: string, named: readonly NamedCard[]): MessagePart[] {
  const parts: MessagePart[] = [];
  let at = 0;
  for (;;) {
    let best: { index: number; card: NamedCard } | null = null;
    for (const card of named) {
      if (!card.name) continue;
      const index = message.indexOf(card.name, at);
      if (index < 0) continue;
      const better =
        best === null ||
        index < best.index ||
        (index === best.index && card.name.length > best.card.name.length);
      if (better) best = { index, card };
    }
    if (best === null) break;
    if (best.index > at) parts.push({ text: message.slice(at, best.index), cardId: null });
    parts.push({ text: best.card.name, cardId: best.card.cardId });
    at = best.index + best.card.name.length;
  }
  if (at < message.length) parts.push({ text: message.slice(at), cardId: null });
  return parts;
}

/** The findings that share one code, in the order the engine emitted them. */
interface Group {
  code: string;
  issues: ValidationIssue[];
}

function groupByCode(issues: readonly ValidationIssue[]): Group[] {
  const groups = new Map<string, Group>();
  for (const issue of issues) {
    const group = groups.get(issue.code) ?? { code: issue.code, issues: [] };
    group.issues.push(issue);
    groups.set(issue.code, group);
  }
  return [...groups.values()];
}

export interface ValidationPanelProps {
  cards: readonly DeckCard[];
  /** The rules this deck is judged by. The editor draws nothing here when it has none —
   *  `format_specs` is still loading, or the deck's format has left the seed. */
  spec: FormatSpec;
  open: boolean;
  /** The chip, so the editor can hand the caret back to it on the way out. */
  buttonRef: RefObject<HTMLButtonElement | null>;
  onOpen: () => void;
  /** Escape, and the chip pressed a second time: the caret comes back to the chip. */
  onDismiss: () => void;
  /** Focus left on its own. Closes and hands nothing back — the reader is already
   *  somewhere else. */
  onClose: () => void;
  onSelectCard: (cardId: string) => void;
}

/**
 * What the rules make of this deck, behind one glyph.
 *
 * **Advisory, never blocking** — spec §7, and the engine's own design: nothing here refuses a
 * write, greys out a control or stops a deck from being saved, because an illegal deck is a
 * deck somebody is still building. The button says whether there is anything to fix and how
 * much of it; opening it says what, in the engine's own sentences, with the card each finding is
 * about reachable from the sentence itself.
 *
 * **It was a chip reading "No issues · Modern" or "3 issues" until 2026-08-18**, and what
 * retired that is the deck it sits over having two lists: Live and Theory hold different cards,
 * fail different rules, and are switched between two controls to the left of this one — so the
 * readout changed width as the reader flipped between them and took the rest of the row with it.
 * The button's own site below carries the rest of that argument.
 *
 * The bracket estimate rides in the same panel for the commander formats, and is an estimate
 * in the copy as well as in the code: `estimateBracket` emits no issue, and a number that
 * cannot make a deck illegal must not be drawn as though it could.
 *
 * The panel is an `"inner"` Escape rung — one press closes it and the card pane behind the
 * view keeps its own — and it is the *same* piece of state as the editor's dialogs, so those can
 * never be open at once: a chip's answer floating over a modal is not a state this view draws,
 * and one slot is what makes that structural (`DecksPage`'s `Panel` union is the same
 * arrangement, for the same reason). That used to be justified by `useDismissOnEscape` ordering
 * exactly two rungs, which it no longer does — it stacks capture-phase registrations and only
 * the top one acts — and which was never what the union was for. The screen carries a further
 * `"inner"` peer that no union covers — the set filter in the docked search panel
 * (`SetCombobox`) — held apart by focus and click mechanics instead: see `DeckEditor`'s `Layer`
 * doc for both directions.
 */
export function ValidationPanel({
  cards,
  spec,
  open,
  buttonRef,
  onOpen,
  onDismiss,
  onClose,
  onSelectCard,
}: ValidationPanelProps) {
  const rootRef = useRef<HTMLDivElement>(null);

  // Recomputed on every edit, and deliberately not debounced: the engine is pure, a deck is a
  // few hundred rows, and one pass over them is cheaper than the render it rides along with. A
  // check that lagged the stepper beside it would be a check the reader stops trusting.
  const issues = useMemo(() => validateDeck([...cards], spec), [cards, spec]);
  // Only while the panel is up, unlike the issues: nothing outside the panel draws a bracket,
  // and this one greps every face of every card for four phrases. `validateDeck` earns its
  // every-render pass because the chip prints its count; this earns nothing until it is read.
  const bracket = useMemo(
    () => (open && spec.commanderRule !== null ? estimateBracket([...cards]) : null),
    [cards, spec, open],
  );

  // The `"inner"` rung, owned here rather than by the editor so that this component is a whole
  // dismissible layer on its own. Safe beside the editor's *other* `"inner"` rung — the row
  // menus' — only because the two are one piece of state up there: `Layer` is a union, so at
  // most one of the two registrations is ever `enabled`, and `useDismissOnEscape` orders
  // exactly two rungs (a capture-phase one and a bubble-phase one), never two peers.
  //
  // The set filter in the docked search panel registers the same rung and is *not* in that
  // union; the `onBlur` boundary below is what keeps it from being a third peer, since opening
  // one takes the caret out of the other. `DeckEditor`'s `Layer` doc has the whole arrangement.
  useDismissOnEscape({ layer: "inner", onDismiss, enabled: open });

  const count = issues.length;
  /**
   * The whole of what this control says, now that it says nothing in words.
   *
   * **It names the format in both states, which it did not before.** The count used to be
   * visible text and the format rode along only on the empty state, where there was nothing
   * else to print; a label is now the only place either fact exists, and one that named the
   * ruleset for a clean deck and withheld it for a broken one would be answering "checked
   * against what?" exactly when the question stops being worth asking.
   */
  const label =
    count === 0
      ? `No issues · ${spec.displayName}`
      : `${count} ${count === 1 ? "issue" : "issues"} · ${spec.displayName}`;

  return (
    <div
      ref={rootRef}
      className="relative"
      // Clicking or tabbing away closes the panel, without a window listener that could fight
      // the Escape handshake (`NewDeck`'s arrangement, for its reason). The boundary is the
      // whole control rather than the panel, which is what keeps the chip a toggle: a press on
      // it blurs the panel first, and a handler that did not know the chip would close the
      // panel and let the press reopen it — a control that can only ever open.
      onBlur={(e) => {
        if (open && !rootRef.current?.contains(e.relatedTarget)) onClose();
      }}
    >
      {/**
       * **A glyph in a fixed 36px box, because the two lists disagree and this control is
       * beside the switch between them.** Live and Theory hold different cards, so they fail
       * different rules: flipping the switch took this from "No issues · Modern" to
       * "3 issues" and back, and every control to its right — Built, the two action buttons —
       * slid along with it. A readout that moves the row when the reader changes what it is
       * describing is a readout they have to find again each time, and at the widths this row
       * already wraps at (see the header's `flex-wrap` note) it could also change *which line*
       * those buttons are on.
       *
       * The box is `w-9` for the same reason the undo/redo pair on the row below is: 36px is
       * {@link FILTER_CONTROL}'s own height, so a square is the one width that cannot sit off
       * the line. Nothing inside it may change that width — which is what the count being
       * absolutely positioned is for, below.
       */}
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        // The name and the tooltip are one string: a glyph says nothing to a screen reader and
        // nothing to a pointer either, and two hand-written copies of a sentence are two
        // sentences waiting to disagree. Same arrangement as the undo/redo buttons'.
        aria-label={label}
        title={label}
        onClick={() => (open ? onDismiss() : onOpen())}
        className={cn(
          FILTER_CONTROL,
          FILTER_FOCUS,
          // `relative` for the count; `px-0` because the padding was for words.
          "relative grid w-9 place-items-center px-0",
          // **Not `filterChipState`**, which is this row's recipe and stays so for every
          // control on it that is made of text. It says on, off and hover in the *text*
          // colour, and there is no text here: the glyph's colour is its meaning, so a state
          // that repainted it would be a green check that turns gold when the panel opens.
          // The border carries both instead — the on half of `filterChipState` unchanged, and
          // a hover that brightens the same edge rather than a word.
          open ? "border-accent" : "border-border hover:border-dim",
        )}
      >
        {/* Red for a break, green for none, and **the glyph is the only thing coloured** — a
            tinted surface would make a deck somebody is still building look broken, and this
            panel refuses nothing. That was the old chip's rule when the count was the one red
            thing on it, and it survives the change intact.

            Both shapes are already the app's: `TriangleAlert` is what the shell's error banner
            draws, `CircleCheck` is what both Settings panels draw when there is nothing to
            report. Deliberately *not* `OctagonAlert` — a stop sign says blocked, and nothing
            here blocks anything.

            It counts warnings with errors, and colours the total either way — the brief's
            wording, kept deliberately. A warning is "a fact worth a look" rather than a broken
            rule, so a two-tone count would be more precise; it would also be a control with two
            numbers on it, and the panel behind it already tells the two apart per sentence. */}
        {count === 0 ? (
          <CircleCheck className="size-4 text-ok" aria-hidden="true" />
        ) : (
          <TriangleAlert className="size-4 text-destructive" aria-hidden="true" />
        )}

        {count > 0 && (
          // **Out of flow, so the box cannot grow.** `absolute` takes the count out of the
          // `grid` above, which is the whole mechanism: 3 issues and 47 issues draw the same
          // 36px control, and so does a clean deck. The ring is the page's own background, so
          // the bubble reads as sitting *on* the button rather than welded to its border.
          //
          // **It hangs off the top and never off the right, and that asymmetry is a scrollbar.**
          // The block this control is in is `flex-wrap justify-end`, so every folded line ends
          // flush against the header's right edge — which is the deck editor's own edge, and
          // that editor is the page scroller. `overflow-y: auto` computes `overflow-x` to
          // `auto` as well, so a bubble 4px past that edge on any width where the wrap happens
          // to fall right here is 4px of horizontal scroll on a page that must never have any.
          // Up it costs nothing: the header's `py-1.5` leaves the row 6px of room and the
          // bubble asks for 3.
          //
          // `aria-hidden`, because the number is already in the button's name and a reader who
          // hears "3 issues · Modern, 3" has been told twice. Capped at two digits — sixty
          // findings is a real state (a Standard deck full of cards from other formats), and
          // "99+" is the same shape as "12".
          <span
            aria-hidden="true"
            className={cn(
              "absolute -top-1 right-0 grid h-4 min-w-4 place-items-center",
              "rounded-full px-1 font-mono text-[0.625rem] leading-none tabular-nums",
              "bg-destructive text-bg ring-2 ring-bg",
            )}
          >
            {count > 99 ? "99+" : count}
          </span>
        )}
      </button>

      {/* The panel's presence, and it is safe here in a way it is not on the editor's four
          overlays: this component is already always mounted with its rung gated on `open`, so
          the rung goes dead on the render that starts the exit rather than on the one that
          ends it. Nothing about a longer-lived panel can outlive the flag. */}
      <AnimatePresence>
        {open && (
          <Findings
            key="findings"
            issues={issues}
            cards={cards}
            spec={spec}
            bracket={bracket}
            buttonRef={buttonRef}
            onSelectCard={onSelectCard}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

/** The panel itself: every finding, and the advisory that is not one. */
function Findings({
  issues,
  cards,
  spec,
  bracket,
  buttonRef,
  onSelectCard,
}: {
  issues: ValidationIssue[];
  cards: readonly DeckCard[];
  spec: FormatSpec;
  bracket: ReturnType<typeof estimateBracket> | null;
  buttonRef: RefObject<HTMLButtonElement | null>;
  onSelectCard: (cardId: string) => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  /** False from the render that starts the exit, which is a state this panel has never been in
   *  before: painted, laid out, and no longer the thing the chip is describing. */
  const present = useIsPresent();

  // The caret moves into the layer, as it does for every other one in the app: the panel's own
  // controls are then the next thing Tab reaches, and Escape has something to hand back.
  useEffect(() => {
    panelRef.current?.focus({ preventScroll: true });
  }, []);

  /** The row a `cardId` belongs to, for the names inside a sentence. Built once per render of
   *  the panel — a deck is small, and the alternative is a scan per issue per name. */
  const byId = useMemo(() => new Map(cards.map((card) => [card.cardId, card.name])), [cards]);
  const named = (issue: ValidationIssue): NamedCard[] =>
    (issue.cardIds ?? []).flatMap((cardId) => {
      const name = byId.get(cardId);
      return name === undefined ? [] : [{ cardId, name }];
    });

  return (
    <motion.div
      {...popup}
      ref={panelRef}
      tabIndex={-1}
      role="dialog"
      aria-label={`${spec.displayName} check`}
      // On the way out it is a picture of a panel and nothing else — not clickable, and not in
      // the accessibility tree, where a second copy of the chip's own findings would be. The
      // caret was handed back to the chip before this render.
      aria-hidden={present ? undefined : true}
      // Anchored rather than portalled, and not `aria-modal`: the shipped CSP is
      // `style-src 'self'` and every overlay primitive in reach injects a runtime `<style>` the
      // moment it opens (`SetCombobox`'s decision, for its reason). The editor behind it stays
      // live, which is the point — a reader fixes the deck while reading what is wrong with it.
      className={cn(
        "absolute left-0 top-11 w-80 max-w-[calc(100vw-2rem)] rounded-lg border",
        "border-border bg-bg/95 p-3 text-xs shadow-lg",
        // The scale grows from the corner the panel is pinned by, which is the whole of what
        // `popup` leaves to its consumer: a panel that grew from its own middle would read as
        // unrelated to the chip it hangs off. `left-0` above is why this corner and not another.
        "origin-top-left",
        !present && "pointer-events-none",
        LAYER.popup,
        // The panel scrolls rather than the editor: a Standard deck full of cards from other
        // formats is sixty findings, and a layer taller than the window has no way back to its
        // own chip.
        "max-h-[60vh] overflow-y-auto",
        FOCUS,
      )}
    >
      {issues.length === 0 ? (
        <p className="text-dim">
          Nothing to fix. This deck matches every {spec.displayName} rule this app can check.
        </p>
      ) : (
        groupByCode(issues).map((group) => (
          <div key={group.code} className="mb-3 last:mb-0">
            <p className="text-dim">{codeLabel(group.code)}</p>
            <ul className="mt-1 space-y-1.5">
              {group.issues.map((issue) => (
                <li
                  key={issue.message}
                  // A rule broken and a fact worth a look are told apart by a 2px edge rather
                  // than by a tinted panel: this list refuses nothing, and a red surface would
                  // make a deck somebody is still building look broken. The colour is never
                  // the only carrier — the sentence is announced with its severity.
                  className={cn(
                    "border-l-2 pl-2 leading-snug",
                    issue.severity === "error" ? "border-destructive" : "border-border",
                  )}
                >
                  <p className="min-w-0">
                    <span className="sr-only">
                      {issue.severity === "error" ? "Error: " : "Warning: "}
                    </span>
                    {messageParts(issue.message, named(issue)).map(({ text, cardId }, at) =>
                      cardId === null ? (
                        <Fragment key={at}>{text}</Fragment>
                      ) : (
                        <button
                          key={at}
                          type="button"
                          // The caret goes to the chip *first*, and that is not a flourish:
                          // the card pane records whatever holds it as the thing to hand it
                          // back to on Escape, and this button is about to unmount with the
                          // panel the pane's own focus closes. Without the hop, Escaping out
                          // of the card drops the caret onto `<body>` and the next Tab
                          // restarts from the top of the app. Measured in the running window.
                          onClick={() => {
                            buttonRef.current?.focus();
                            onSelectCard(cardId);
                          }}
                          className={cn("rounded-sm text-accent hover:underline", FOCUS)}
                        >
                          {text}
                        </button>
                      ),
                    )}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}

      {bracket && <Bracket estimate={bracket} />}
    </motion.div>
  );
}

/**
 * The Commander bracket, as an advisory.
 *
 * Wizards' scale is explicitly "advisory only, not hard validation" (research doc), so the copy
 * leads with the word estimate and the disclosure names every card the number was read from —
 * a reader who disagrees with a heuristic can see which card caused it, which is the only thing
 * that makes a guess like this worth showing at all.
 */
function Bracket({ estimate }: { estimate: ReturnType<typeof estimateBracket> }) {
  const [why, setWhy] = useState(false);
  const read: { label: string; names: string[] }[] = [
    { label: "Game changers", names: estimate.gameChangerNames },
    { label: "Mass land denial", names: estimate.massLandDenial },
    { label: "Extra turns", names: estimate.extraTurns },
  ].filter((line) => line.names.length > 0);

  return (
    <div className="mt-3 border-t border-border pt-2">
      {/* One text run: a headline fact split across styled spans is a sentence nothing —
          screen reader, test, or reader skimming — puts back together. */}
      {/* Geist Mono for the counts, as everywhere else data is counted (the direction doc; the
          chip above and `DeckStats`'s figures are the in-file precedents). */}
      <p className="font-mono font-medium tabular-nums">
        Bracket ~{estimate.bracket} · {estimate.gameChangers} game changer
        {estimate.gameChangers === 1 ? "" : "s"}
      </p>
      <p className="mt-1 text-dim">
        An estimate from what this app can see — a bracket is a conversation at the table, never a
        rule this deck can fail.
      </p>

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
    </div>
  );
}
