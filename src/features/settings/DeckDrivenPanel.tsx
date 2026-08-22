import type { JSX } from "react";
import type { useDeckDrivenCollection } from "@/lib/useDeckDrivenCollection";
import { cn } from "@/lib/utils";
import { SWITCH, switchTone } from "./controls";
import { PanelAlert, SettingsSection } from "./panelChrome";

/**
 * Whether the reader's decks *are* their collection.
 *
 * Placed with `MarketplacePanel` in the page's top half, by the ordering rule `SettingsPage`
 * states: ordered by what a press costs, and this one costs nothing — it changes where a list is
 * read from and deletes nothing, so it is free to try and free to undo. It is the page's second
 * real *setting* rather than a report or a deletion, which is the other half of why it sits
 * there and nowhere near the Danger Zone.
 *
 * **The copy has three jobs and they are all load-bearing.** It says what the collection becomes
 * (the sum of the live lists), what it leaves out and why (Theory is what a deck is being built
 * toward, so it is not something the reader has), and that nothing is deleted — which is the
 * sentence that makes the switch safe to press. The last is not reassurance: a reader who
 * believes this might throw their collection away will never find out that it does not. This
 * panel is the only place the feature is ever explained, so a sentence dropped here is a fact
 * the reader has nowhere else to learn.
 *
 * **Every clause of it is `collection_source::LIVE` in words**, and that predicate is
 * deliberately broader than the deck allocator's: no `is_active` term (an inactive Maybeboard is
 * a statement about how the *deck* is read, not about whose hands the cards are in), no
 * `decks.archived` term (archiving is filing, not disassembling), and no `theory_enabled` term
 * — a deck with no plan keeps every row as `live`, so "a deck without one counts in full" falls
 * out of the rule rather than being a special case. Each of those is a surprise if it is not
 * said, so each of them is said.
 *
 * The panel holds no state. `useDeckDrivenCollection` owns the optimistic write, the rollback
 * that the rail's twin deliberately refuses to do, and the sentence a refusal leaves behind;
 * this draws them.
 */
export function DeckDrivenPanel({
  deckDriven,
}: {
  deckDriven: ReturnType<typeof useDeckDrivenCollection>;
}): JSX.Element {
  const on = deckDriven.deckDriven;

  return (
    <SettingsSection id="deck-driven" title="Deck driven collection">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-2">
          <p className="text-sm text-dim">
            Track your collection as the sum of the cards in your decks, instead of adding cards
            to it by hand. Every copy in every deck counts — including sideboards, piles you have
            switched off, and decks you have archived. You still own those cards.
          </p>
          <p className="text-sm text-dim">
            A deck&rsquo;s <strong className="font-medium text-text">Theory</strong> list is left
            out: that is what the deck is being built toward, not what is sleeved up. A deck with
            no Theory list counts in full.
          </p>
          <p className="text-sm text-dim">
            While this is on the collection cannot be edited by hand, and{" "}
            <strong className="font-medium text-text">nothing is deleted</strong> — anything you
            added yourself is waiting exactly as you left it when you switch back.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          // Named by the heading beside it *and* by its own word, in that order — the pairing
          // `SettingsSection` guarantees, `deck-driven` giving `<h2 id="deck-driven-heading">`.
          // `aria-label` would replace the visible state with something that does not contain
          // it, which is the WCAG 2.5.3 failure a control labelled by its own text exists to
          // avoid. `TheorySwitch` is where this shape comes from.
          aria-labelledby="deck-driven-heading deck-driven-state"
          onClick={() => deckDriven.setDeckDriven(!on)}
          className={cn(SWITCH, switchTone(on))}
        >
          <span id="deck-driven-state">{on ? "Enabled" : "Disabled"}</span>
        </button>
      </div>

      {/* `problem`, for `HiddenTagsPanel`'s reason arrived at from the other side: the hook rolls
          the optimistic write back, so a refused press leaves the switch reading exactly as it
          did — and the red sentence is the only thing between that and a control that looks
          like it was never pressed. */}
      <PanelAlert tone="problem">{deckDriven.error}</PanelAlert>
    </SettingsSection>
  );
}
