import { NAV } from "@/components/nav";
import { LIGHT_VIEWS, type LightView } from "@/lib/edition";
import { FOCUS_INSET } from "@/lib/focus";
import { cn } from "@/lib/utils";

/**
 * The five destinations a thumb reaches for. Settings is the top bar's.
 *
 * **The words and the glyphs are the desktop rail's**, read out of `NAV` rather than written
 * again — one word per view, in both apps, is what that module exists to keep.
 */
const TABS = NAV.filter(
  (entry): entry is (typeof NAV)[number] & { id: LightView } =>
    (LIGHT_VIEWS as readonly string[]).includes(entry.id) && entry.id !== "settings",
);

export function TabBar({ view, onSelect }: { view: LightView; onSelect: (view: LightView) => void }) {
  return (
    <nav
      aria-label="Views"
      // The bar sits on the screen's bottom edge, which on a phone is under the home indicator.
      className="flex shrink-0 border-t border-border bg-surface pb-[env(safe-area-inset-bottom)]"
    >
      {TABS.map(({ id, label, Icon }) => (
        <button
          key={id}
          type="button"
          aria-current={id === view ? "page" : undefined}
          onClick={() => onSelect(id)}
          className={cn(
            // 52px: over the 44px touch floor in both directions at five tabs on 360px.
            "flex h-13 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-xs",
            id === view ? "text-accent" : "text-dim",
            FOCUS_INSET,
          )}
        >
          <Icon aria-hidden className="size-5" />
          <span className="truncate">{label}</span>
        </button>
      ))}
    </nav>
  );
}
