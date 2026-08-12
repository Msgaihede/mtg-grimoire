import { Check } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useId } from "react";
import { FILTER_FOCUS, filterChipState } from "@/components/FilterChips";
import { MARKETPLACE_LIST, type Currency, type Marketplace } from "@/lib/marketplace";
import { statusLine } from "@/lib/motion";
import type { MarketplaceState } from "@/lib/useMarketplace";
import { cn } from "@/lib/utils";

/**
 * One row of the picker — the app's existing "on / off / out of reach" control, laid out down
 * the page instead of along a filter row.
 *
 * The property list is spelled out for `FILTER_CONTROL`'s reason: a colour utility and a
 * transform one compile to the same CSS longhand and tailwind-merge would keep only one of
 * them. `scale` is named beside `transform` because Tailwind v4's `scale-*` writes the `scale`
 * longhand, and a transition list that does not name it makes the press snap. `0.99` rather
 * than the chips' `0.97`: this control is the width of the panel, and a full-width row that
 * dips 3% reads as the page moving.
 */
const ROW =
  "flex w-full items-start gap-3 rounded-md border px-3 py-2 text-left text-sm " +
  "transition-[color,background-color,border-color,opacity,transform,scale] " +
  "duration-[var(--duration-fast)] ease-standard active:scale-[0.99] " +
  "aria-disabled:active:scale-100 motion-reduce:transition-none";

/**
 * The currency beside the name, in the app's third type role.
 *
 * The code rather than the symbol: "$" is read aloud as "dollar" and would leave a reader
 * choosing between two marketplaces that both quote in it with nothing to tell them apart,
 * where `USD` is the thing actually written on the setting.
 */
const CURRENCY_LABEL: Record<Currency, string> = { usd: "USD", eur: "EUR" };

/**
 * Why an entry is listed and not selectable, in that entry's own words.
 *
 * **It explains rather than greys.** Three of the five have no feed in this build — Scryfall's
 * `prices` blob carries `usd*` and `eur*` and nothing else — and a row that simply dimmed would
 * leave a reader to guess whether the app had broken, whether they had to sync, or whether the
 * marketplace itself had stopped. Named per row rather than said once above the list, because
 * the sentence is the answer to "why not *this* one", which is a question asked at a row.
 */
function noFeedNote(marketplace: Marketplace): string {
  return `No price feed yet — ${marketplace.label} prices are not in the card data this app syncs.`;
}

/**
 * One marketplace, offered.
 *
 * **`aria-disabled` and never the attribute.** A `disabled` button leaves the tab order, so a
 * keyboard reader walking this list would find two rows where a sighted one sees five and never
 * meet the sentence that says why the other three are out. The row stays focusable, keeps
 * saying whether it is the chosen one, carries its reason as its accessible *description*, and
 * ignores the press.
 *
 * The name is pinned to the label and the currency with `aria-labelledby` for that last part:
 * name-from-content would otherwise swallow the whole note into the button's name, and a
 * control called "Card Kingdom USD No price feed yet — Card Kingdom prices are not in the card
 * data this app syncs." is one nobody can ask for by name.
 */
function Option({
  marketplace,
  chosen,
  onChoose,
}: {
  marketplace: Marketplace;
  chosen: boolean;
  onChoose: () => void;
}) {
  const id = useId();
  const unavailable = !marketplace.priced;

  return (
    <li>
      <button
        type="button"
        aria-pressed={chosen}
        aria-disabled={unavailable || undefined}
        aria-labelledby={`${id}-name ${id}-currency`}
        aria-describedby={unavailable ? `${id}-note` : undefined}
        onClick={() => {
          if (!unavailable) onChoose();
        }}
        className={cn(ROW, FILTER_FOCUS, filterChipState(chosen, unavailable))}
      >
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span id={`${id}-name`}>{marketplace.label}</span>
            {/* A currency is data, and data is Geist Mono — the same role prices, versions and
                collector numbers already carry in this window. */}
            <span id={`${id}-currency`} className="font-mono text-xs tabular-nums">
              {CURRENCY_LABEL[marketplace.currency]}
            </span>
          </span>
          {unavailable && (
            <span id={`${id}-note`} className="mt-1 block text-xs">
              {noFeedNote(marketplace)}
            </span>
          )}
        </span>
        {/* The mark, beside the gold border and the gold text: three signals rather than
            colour alone, since "which one is on" is the only question this panel answers. */}
        {chosen && <Check className="mt-0.5 size-4 shrink-0" aria-hidden="true" />}
      </button>
    </li>
  );
}

/**
 * Where every price in this window comes from.
 *
 * Quiet like its two neighbours — `bg-surface`, border grey, and the only gold on it is the
 * chosen row and the focus ring, which is what gold already means everywhere else here.
 *
 * **All five are listed and two can be picked.** Hiding the other three would be the tidier
 * panel and the worse one: a reader who trades on Card Kingdom would search this list, find
 * nothing, and be left unable to tell "not supported" from "not found". `marketplace.ts`'s
 * `priced` flag is a fact about the card data rather than a placeholder, and each row says so
 * in its own words.
 *
 * The state is a prop, exactly as `ErrorLogPanel`'s log is: `SettingsPage` calls
 * `useMarketplace()` and hands the answer down, so every story here is an argument and the
 * panel itself never reaches the backend.
 */
export function MarketplacePanel({ marketplace }: { marketplace: MarketplaceState }) {
  const { marketplace: chosen, select, selecting, error } = marketplace;

  return (
    <section aria-labelledby="prices-heading" className="space-y-4">
      <h2 id="prices-heading" className="font-heading text-lg leading-none">
        Prices
      </h2>

      <div className="space-y-4 rounded-lg border border-border bg-surface p-4">
        <p className="text-sm text-dim">
          Every price this app shows — in search, the collection, decks and the wishlist — is quoted
          from one marketplace, in that marketplace&rsquo;s currency. Switching is instant: nothing
          re-syncs and nothing is refetched.
        </p>

        {/* `aria-busy` on the list rather than `disabled` on the rows: the write is one row
            long and a list that emptied its own tab order for the length of it would move the
            caret out from under a keyboard reader mid-press. */}
        <ul aria-busy={selecting || undefined} className="space-y-2">
          {MARKETPLACE_LIST.map((entry) => (
            <Option
              key={entry.id}
              marketplace={entry}
              chosen={entry.id === chosen.id}
              onChoose={() => select(entry.id)}
            />
          ))}
        </ul>

        {/* Grown into place rather than shoving the list up by its height — both neighbouring
            panels' line, and the same reasoning: its own animated element because it carries no
            padding and no border, `overflow-hidden` because the sentence is laid out at full
            size whatever the box is doing. */}
        <AnimatePresence initial={false}>
          {error && (
            <motion.p
              {...statusLine}
              role="alert"
              className="overflow-hidden text-sm text-destructive"
            >
              {error}
            </motion.p>
          )}
        </AnimatePresence>
      </div>
    </section>
  );
}
