import { Fragment, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { ChevronRight } from "lucide-react";
import { FILTER_CONTROL, FILTER_FOCUS, filterChipState } from "@/components/FilterChips";
import type { DeckCard, FormatSpec } from "@/lib/ipc";
import { LAYER } from "@/lib/layers";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { cn } from "@/lib/utils";
import { FOCUS } from "./cardControl";
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
 * What the rules make of this deck, behind one chip.
 *
 * **Advisory, never blocking** — spec §7, and the engine's own design: nothing here refuses a
 * write, greys out a control or stops a deck from being saved, because an illegal deck is a
 * deck somebody is still building. The chip says how many findings there are; opening it says
 * what they are, in the engine's own sentences, with the card each one is about reachable from
 * the sentence itself.
 *
 * The bracket estimate rides in the same panel for the commander formats, and is an estimate
 * in the copy as well as in the code: `estimateBracket` emits no issue, and a number that
 * cannot make a deck illegal must not be drawn as though it could.
 *
 * The panel is an `"inner"` Escape rung — one press closes it and the card pane behind the
 * view keeps its own — and it is the *same* piece of state as the row menus, so those two can
 * never be open at once (`useDismissOnEscape` orders exactly two rungs; `DecksPage`'s `Panel`
 * union is the same arrangement, for the same reason). The screen carries a **third** `"inner"`
 * peer that no union covers — the set filter in the docked search panel (`SetCombobox`) — and
 * that one is held apart by focus and click mechanics instead: see `DeckEditor`'s `Layer` doc
 * for both directions and for the one case the mechanics do not cover.
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
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => (open ? onDismiss() : onOpen())}
        className={cn(FILTER_CONTROL, FILTER_FOCUS, "px-3", filterChipState(open))}
      >
        {count === 0 ? (
          `No issues · ${spec.displayName}`
        ) : (
          <>
            {/* The number is the only red on the chip: a coloured *surface* would make a deck
                somebody is still building look broken, and this panel refuses nothing.

                It counts warnings with errors, and colours the total either way — the brief's
                wording, kept deliberately. A warning is "a fact worth a look" rather than a
                broken rule, so a two-tone count would be more precise; it would also be a chip
                with two numbers on it, and the panel behind it already tells the two apart per
                sentence. One number, one press to see what it is made of. */}
            <span className="font-mono tabular-nums text-destructive">{count}</span>{" "}
            {count === 1 ? "issue" : "issues"}
          </>
        )}
      </button>

      {open && (
        <Findings
          issues={issues}
          cards={cards}
          spec={spec}
          bracket={bracket}
          buttonRef={buttonRef}
          onSelectCard={onSelectCard}
        />
      )}
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
    <div
      ref={panelRef}
      tabIndex={-1}
      role="dialog"
      aria-label={`${spec.displayName} check`}
      // Anchored rather than portalled, and not `aria-modal`: the shipped CSP is
      // `style-src 'self'` and every overlay primitive in reach injects a runtime `<style>` the
      // moment it opens (`SetCombobox`'s decision, for its reason). The editor behind it stays
      // live, which is the point — a reader fixes the deck while reading what is wrong with it.
      className={cn(
        "absolute left-0 top-11 w-80 max-w-[calc(100vw-2rem)] rounded-lg border",
        "border-border bg-bg/95 p-3 text-xs shadow-lg",
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
    </div>
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
