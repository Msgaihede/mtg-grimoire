import { Fragment, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { AnimatePresence } from "motion/react";
import { Folder, RectangleVertical, Search, Settings, type LucideIcon } from "lucide-react";
import { Cards } from "@/components/icons";
import { PopupPanel } from "@/components/PopupListbox";
import { FOCUS_INSET } from "@/lib/focus";
import { chordParts, matchesShortcut, shortcut } from "@/lib/shortcuts";
import { useAppStore } from "@/lib/store";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { cn } from "@/lib/utils";
import type { QuickItem, QuickItemKind, QuickTarget } from "./quickSearch";
import { useQuickSearch } from "./useQuickSearch";

const QUICK_SEARCH = shortcut("global", "quickSearch");

/** The field's accessible name and its placeholder — one sentence, so the two cannot drift. */
export const QUICK_SEARCH_LABEL = "Search decks, cards and settings";

const ICONS: Record<QuickItemKind, LucideIcon> = {
  deck: Cards,
  folder: Folder,
  card: RectangleVertical,
  searchAll: Search,
  setting: Settings,
};

const optionId = (base: string, key: string) => `${base}-opt-${key.replace(/[^\w-]/g, "_")}`;

/**
 * Where a press on a result takes the reader — each target is one store action, and the
 * navigating ones write the view first, as every hand-off in `store.ts` asks.
 */
function useGoTo(): (target: QuickTarget) => void {
  const setActiveView = useAppStore((s) => s.setActiveView);
  const setOpenDeckId = useAppStore((s) => s.setOpenDeckId);
  const showDeckFolder = useAppStore((s) => s.showDeckFolder);
  const setPendingFolder = useAppStore((s) => s.setPendingFolder);
  const revealCard = useAppStore((s) => s.revealCard);
  const showTextInSearch = useAppStore((s) => s.showTextInSearch);
  const setPendingSettingsPanel = useAppStore((s) => s.setPendingSettingsPanel);
  return (target) => {
    switch (target.kind) {
      case "deck":
        setActiveView("decks");
        setOpenDeckId(target.id);
        return;
      case "deckFolder":
        showDeckFolder(target.id);
        return;
      case "folder":
        setActiveView(target.scope);
        setPendingFolder({ scope: target.scope, id: target.id });
        return;
      case "reveal":
        revealCard({ scope: target.scope, folderId: target.folderId, query: target.query });
        return;
      case "search":
        showTextInSearch(target.text);
        return;
      case "setting":
        setActiveView("settings");
        setPendingSettingsPanel(target.panel);
        return;
    }
  };
}

/**
 * The header's quick search (issue #1098) — a field centred in the title bar that drops a list of
 * grouped results under itself: decks and deck folders, the collection's folders and cards, the
 * wishlist's, the whole corpus, and the Settings panels, in that order (`quickSearch.ts` argues
 * it). With nothing typed the list is what the reader touched last; typing narrows it.
 *
 * **A combobox, `QuickAdd`'s shape**: the caret stays in the field, ↑/↓ walk every row across the
 * groups, Enter opens the lit one and a click opens any. The lit row is held by **key** rather than
 * by index, because the groups answer at different speeds — a deck lit while the collection's rows
 * arrive above-or-below it stays the deck the reader is looking at.
 *
 * **`Ctrl+K` from anywhere** puts the caret here (except under a modal, which owns the keyboard),
 * and Escape hands it back to wherever it was. The panel is drawn inside the title bar, so it
 * rides that row's `LAYER.caption` over every page.
 */
export function QuickSearch() {
  const base = useId();
  const listboxId = `${base}-list`;
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  /** Where the caret was before `Ctrl+K` took it — Escape gives it back. */
  const returnRef = useRef<HTMLElement | null>(null);
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const goTo = useGoTo();

  const { groups, busy } = useQuickSearch(text, open);
  const items = groups.flatMap((g) => g.items);
  const active = items.find((item) => item.key === activeKey) ?? items[0];

  const close = (restore: boolean) => {
    setOpen(false);
    setText("");
    setActiveKey(null);
    const back = returnRef.current;
    returnRef.current = null;
    if (restore && back !== null && back.isConnected) back.focus();
    else inputRef.current?.blur();
  };

  const choose = (item: QuickItem) => {
    close(false);
    goTo(item.target);
  };

  useDismissOnEscape({ layer: "inner", enabled: open, onDismiss: () => close(true) });

  // Bound here rather than in `AppShell`'s handler, because the field is the whole of what the
  // chord does and it lives here. Not guarded by `isTextField`, for `Ctrl+1…9`'s reason: the chord
  // has no meaning in a field, so yielding would only make it dead where the caret usually is.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!matchesShortcut(QUICK_SEARCH, e)) return;
      if (document.querySelector('[aria-modal="true"]') !== null) return;
      e.preventDefault();
      if (e.repeat) return;
      const field = inputRef.current;
      if (field === null) return;
      if (document.activeElement !== field) {
        returnRef.current =
          document.activeElement instanceof HTMLElement && document.activeElement !== document.body
            ? document.activeElement
            : null;
      }
      field.focus();
      field.select();
      setOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The lit row kept in view inside the panel's own scroller. `scrollIntoView` is optional-called:
  // jsdom has none.
  const activeDomId = active === undefined ? undefined : optionId(base, active.key);
  useEffect(() => {
    if (!open || activeDomId === undefined) return;
    document.getElementById(activeDomId)?.scrollIntoView?.({ block: "nearest" });
  }, [open, activeDomId]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (active !== undefined) choose(active);
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    if (!open) {
      setOpen(true);
      return;
    }
    if (items.length === 0) return;
    const at = active === undefined ? -1 : items.indexOf(active);
    const next =
      e.key === "ArrowDown" ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
    setActiveKey(items[next].key);
  };

  const status = busy
    ? "Searching…"
    : text.trim() === ""
      ? "Nothing recent yet. Type to search."
      : `Nothing matches “${text.trim()}”.`;

  return (
    <div
      ref={rootRef}
      className="relative w-[clamp(14rem,30vw,30rem)]"
      onBlur={(e) => {
        if (!rootRef.current?.contains(e.relatedTarget)) {
          setOpen(false);
          setActiveKey(null);
        }
      }}
    >
      <Search
        aria-hidden
        className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-dim"
      />
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-label={QUICK_SEARCH_LABEL}
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={open ? activeDomId : undefined}
        aria-autocomplete="list"
        aria-keyshortcuts="Control+K"
        placeholder={`${QUICK_SEARCH_LABEL}…`}
        spellCheck={false}
        autoComplete="off"
        value={text}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onChange={(e) => {
          setText(e.target.value);
          setActiveKey(null);
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
        className={cn(
          "peer h-6 w-full rounded-md border border-border bg-bg pr-14 pl-7 text-xs text-text",
          "placeholder:text-dim",
          "transition-colors duration-150 hover:border-dim motion-reduce:transition-none",
          FOCUS_INSET,
        )}
      />
      {/* The chord, drawn where VS Code draws its own — inside the field's right edge — and only
          while the field is idle: once the caret is in it, the reader has found the way in. */}
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute top-1/2 right-1.5 flex -translate-y-1/2 gap-0.5",
          "peer-focus:hidden",
        )}
      >
        {QUICK_SEARCH.chords.flatMap((chord) =>
          chordParts(chord).map((part) => (
            <kbd
              key={part}
              className="rounded border border-border px-1 font-mono text-[0.625rem] leading-4 text-dim"
            >
              {part}
            </kbd>
          )),
        )}
      </span>

      <AnimatePresence>
        {open && (
          // The frame centres the panel under the field and carries the translate, so the panel's
          // own motion transform (the popup preset's scale) has a box of its own to animate.
          <div
            key="panel"
            className="absolute top-full left-1/2 mt-1 w-[clamp(22rem,42vw,40rem)] -translate-x-1/2"
          >
            <PopupPanel className="w-full origin-top rounded-lg border border-border bg-surface text-text shadow-lg">
              <div
                id={listboxId}
                role="listbox"
                aria-label={QUICK_SEARCH_LABEL}
                className="scrollbar-slim max-h-[min(70vh,34rem)] overflow-y-auto p-1"
              >
                {groups.map((group) => {
                  const headingId = `${base}-group-${group.id}`;
                  return (
                    <div key={group.id} role="group" aria-labelledby={headingId}>
                      <div
                        id={headingId}
                        role="presentation"
                        className="px-2 pt-2 pb-1 text-[0.6875rem] tracking-[0.08em] text-dim uppercase"
                      >
                        {group.label}
                      </div>
                      {group.items.map((item) => (
                        <Option
                          key={item.key}
                          id={optionId(base, item.key)}
                          item={item}
                          active={item === active}
                          onHover={() => setActiveKey(item.key)}
                          onChoose={() => choose(item)}
                        />
                      ))}
                    </div>
                  );
                })}
              </div>
              {groups.length === 0 ? (
                <p role="status" className="px-3 py-3 text-xs text-dim">
                  {status}
                </p>
              ) : (
                busy && (
                  <p
                    role="status"
                    className="border-t border-border px-3 py-1 text-[0.6875rem] text-dim"
                  >
                    {status}
                  </p>
                )
              )}
            </PopupPanel>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Option({
  id,
  item,
  active,
  onHover,
  onChoose,
}: {
  id: string;
  item: QuickItem;
  active: boolean;
  onHover: () => void;
  onChoose: () => void;
}) {
  const Icon = ICONS[item.kind];
  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      // The caret stays in the field: a press on a row must not blur it before the click lands.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onChoose}
      onMouseMove={onHover}
      className={cn(
        "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm",
        "transition-colors duration-150 motion-reduce:transition-none",
        active && "bg-bg",
      )}
    >
      <Icon aria-hidden className={cn("size-4 shrink-0", active ? "text-accent" : "text-dim")} />
      <span className="min-w-0 shrink truncate">{item.label}</span>
      {item.detail !== undefined && item.detail !== "" && (
        <Fragment>
          {/* A separator only a screen reader hears, so the name and the detail are not one word. */}
          <span className="sr-only">, </span>
          <span className="ml-auto min-w-0 shrink-[2] truncate pl-2 text-xs text-dim">
            {item.detail}
          </span>
        </Fragment>
      )}
    </div>
  );
}
