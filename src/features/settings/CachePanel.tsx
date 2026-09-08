import { useState, type JSX } from "react";
import { Eraser, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { ConfirmDialog } from "./ConfirmDialog";
import { BUTTON } from "./controls";
import { PanelAlert, SettingsSection } from "./panelChrome";
import type { LocalCache } from "./useDataReset";

/** Which of the two questions is open. `DangerZonePanel`'s union one panel up, for its reason:
 *  two half-answered confirmations at once is not a state this page draws, and separate booleans
 *  can express it. */
type Asking = "images" | "combos" | null;

/**
 * The downloaded bytes, and the two buttons that throw them away.
 *
 * **Its own panel, above the danger zone rather than in it, and the separation is the point.**
 * Everything below the fold on this page is irreversible; nothing here is. A reader who has come
 * to the Settings page because the app is taking up too much room needs a button they can press
 * without reading three sentences first — and putting it one row above Clear collection would
 * make it the button they reach for by muscle memory when they meant that one.
 *
 * So the two panels differ in every way a page can differ: a separate region with its own
 * heading, a plain border rather than the destructive red, and a confirmation with no typed word
 * (see {@link ConfirmDialog}'s `typeToConfirm`).
 *
 * **Both rows earn that treatment by the same fact rather than by resembling each other**, which
 * is what makes the second one belong here instead of in the danger zone. Pictures live under
 * `data/` and combos live in `corpus.db` — the rebuildable half of schema 27's split, the half
 * that exists so that deleting it costs a download and nothing else. Neither row can reach a
 * table the reader wrote, so neither needs a gate that assumes it might.
 *
 * **The size is reported after the fact rather than before**, which is a deliberate absence: a
 * "Cached: 314 MB" line would need a directory walk over 5 540 files every time this page is
 * opened, and it would be a number nobody acts on until they press the button anyway. The
 * outcome sentence says what was freed.
 *
 * **The combo row is a debugging affordance and its copy is sized to that.** It says what goes,
 * that it comes straight back, and that nobody needs to press it — and deliberately not what a
 * combo is or how often the feed refreshes on its own. The panel that explained all of that
 * existed to make a reader press Refresh; the download is automatic now, so the explanation went
 * with the press it was arguing for. What the button cannot say is inside its confirmation,
 * because 27.5 MB and a wait are facts about the cost rather than about the choice.
 */
export function CachePanel({ cache }: { cache: LocalCache }): JSX.Element {
  const [asking, setAsking] = useState<Asking>(null);

  return (
    <SettingsSection id="cache" title="Local cache">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 text-sm text-dim">
          Card images and the leftovers of each download. All of it is fetched again when it is
          next needed — your collection and decks are not touched.
        </p>
        <button
          type="button"
          onClick={() => setAsking("images")}
          disabled={cache.clear.pending}
          aria-busy={cache.clear.pending || undefined}
          className={cn(BUTTON, "border-border hover:bg-bg disabled:hover:bg-transparent")}
        >
          <Eraser className="size-4" aria-hidden="true" />
          Clear cache
        </button>
      </div>

      {/* A rule between the rows, `DangerZonePanel`'s list separator: two sentences of the same
          size and colour with a control at the end of each read as one paragraph that has been
          wrapped, and the reader has to be able to tell which button the second sentence is
          about. */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
        <p className="min-w-0 text-sm text-dim">
          The stored combos, thrown away and downloaded again straight away. Nothing needs this
          done — it is here for when a deck&rsquo;s combo readout looks wrong.
        </p>
        <button
          type="button"
          onClick={() => setAsking("combos")}
          disabled={cache.combos.pending}
          aria-busy={cache.combos.pending || undefined}
          className={cn(BUTTON, "border-border hover:bg-bg disabled:hover:bg-transparent")}
        >
          {/* Not `Eraser`, which is the row above: the two are the same box in the same colour at
              the same end of the same kind of sentence, so the glyph is the whole of what tells
              them apart at a glance. `RefreshCw` rather than a bin because it is the truer verb —
              this press ends with more data than it started with, not less. */}
          <RefreshCw
            className={cn("size-4", cache.combos.pending && "animate-spin")}
            aria-hidden="true"
          />
          Clear combos
        </button>
      </div>

      {/* `plain`, like `ErrorLogPanel`'s and unlike the danger zone's: the sentence here is
          usually good news, and the one refusal it can carry — a sync in flight — is a "not
          now" rather than a fault. One line for both rows, because `useLocalCache` has already
          settled which write owns it. */}
      <PanelAlert tone={cache.status?.tone ?? "plain"}>{cache.status?.text ?? null}</PanelAlert>

      <ConfirmDialog
        open={asking === "images"}
        title="Clear local cache"
        confirmLabel="Clear cache"
        typeToConfirm={false}
        pending={cache.clear.pending}
        onConfirm={cache.clear.run}
        onDismiss={() => setAsking(null)}
        onClose={() => setAsking(null)}
      >
        Deletes the card images and download leftovers stored beside the database. Nothing is
        lost — the app fetches each picture again the next time it draws that card, so the only
        cost is that they arrive over the network once more.
      </ConfirmDialog>

      {/* Two dialogs rather than one keyed on `asking`, which is the opposite of what the danger
          zone does one panel down — and the reason is that these two questions share nothing.
          That panel's three rows differ only in a label and a warning, so one dialog fed from a
          row object is the smaller thing; these have different headings, different buttons,
          different pending flags and unrelated bodies, and folding them would be a lookup table
          with one entry per field. What it would buy is the fade-out state that panel keeps a
          `shown` row for, and neither of these loses its title on the way out because each is
          mounted on its own flag. */}
      <ConfirmDialog
        open={asking === "combos"}
        title="Clear combo data"
        confirmLabel="Clear combos"
        typeToConfirm={false}
        pending={cache.combos.pending}
        onConfirm={cache.combos.run}
        onDismiss={() => setAsking(null)}
        onClose={() => setAsking(null)}
      >
        Deletes every combo held here and fetches Commander Spellbook&rsquo;s list again at once.
        That download is 27.5 MB and the import takes a while, and a deck&rsquo;s bracket estimate
        reads its other three signals until it finishes.
      </ConfirmDialog>
    </SettingsSection>
  );
}
