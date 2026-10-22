import { ChevronRight } from "lucide-react";
import { Fragment, type ReactNode, type Ref } from "react";
import { FOCUS } from "@/lib/focus";
import { cn } from "@/lib/utils";

/**
 * One step back up the trail — a page above the one on screen.
 *
 * `label` is the word drawn; `name` is the accessible name when the word alone would be
 * ambiguous (the deck editor's `Decks` crumb is `Back to decks`, because the rail has a button
 * called `Decks` on the same screen). WCAG 2.5.3: the name must contain the drawn word, so
 * `name` always begins with or contains `label`.
 */
export interface PageCrumb {
  label: string;
  /**
   * Go there. Absent for a parent that is not a page of its own — Settings', whose sections have
   * no page above them — and then the crumb is drawn as words, not as a button that does nothing.
   */
  onOpen?: () => void;
  name?: string;
  /** For a page that hands the caret back to its way out — the deck editor's `backRef`. */
  ref?: Ref<HTMLButtonElement>;
}

/** The page title: Cinzel at 20/600, two steps over the display face's 18px floor. */
export const PAGE_TITLE =
  "m-0 min-w-0 font-heading text-xl font-semibold leading-none tracking-[0.02em]";

/** A parent crumb: the body face, small and dim, so the trail reads as a quiet lead-in to the
 *  title rather than as a row of buttons. Cinzel is never drawn below 18px, so it is not this. */
const CRUMB = cn(
  "shrink-0 whitespace-nowrap text-[13px] text-dim",
  "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
  FOCUS,
);

/** The mono meta beside a title that has counts rather than figures (`4 folders · 23 decks`), and
 *  beside a section heading. */
export const PAGE_META = "whitespace-nowrap font-mono text-xs tabular-nums text-dim";

/**
 * A section heading inside a page — a group, a folder wall, a settings or scanner panel: Cinzel at
 * 18/600, then optional {@link PAGE_META}, then {@link SECTION_RULE} to the row's end and an
 * optional {@link SECTION_LINK}. Recipes rather than a component, because the callers' headings
 * differ in element (`h2`/`h3`) and some are a fold button.
 */
export const SECTION_TITLE = "m-0 font-heading text-lg font-semibold leading-none";

/** The line after a section heading: a flex filler, 1px of `--border` to the row's end — the
 *  page bar's own rule ({@link PageRule}), started after the title instead of under it. */
export const SECTION_RULE = "h-px min-w-6 flex-1 self-center bg-border";

/** A section heading's optional link at the row's end (`Show all`). */
export const SECTION_LINK = cn(
  "shrink-0 whitespace-nowrap text-[13px] text-accent",
  "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
  FOCUS,
);

/**
 * The page bar: every page's top row, and its heading ("Page & Section Headings" canvas, option
 * A · Quiet row, approved 2026-10-21).
 *
 * **It is the row each page already drew, not a block above it.** The app's visible page header
 * went on 2026-10-11 because vertical space is the thing every wall is short of; this brings the
 * page's name back without spending any — the title takes the left end of the row the page's
 * figures and actions already stood in, and a full-width grey rule replaces the rule or gap that
 * was under it.
 *
 * Left to right: the trail (sub-pages only), the title, then the slot the page fills — inline
 * figures (`InlineFigureRow`) on the title's baseline, or mono meta — and the actions against the
 * right edge. The actions are the page's own buttons, unrestyled.
 *
 * **Sub-pages are one rule everywhere** (Decks › folder › deck, Trade › trade, Settings ›
 * section): the page you are on is always the Cinzel title, and everything above it is a dim crumb
 * with a chevron after it. A trail of three or more collapses its middle to `…`, so the root and
 * the immediate parent stay one press away and the title never loses its width to a long path.
 *
 * **The title is an `<h2>` by default.** `AppShell` keeps the window's `<h1>` (the view's name,
 * for the screen reader that navigates by headings), and every page already carried an `<h2>`
 * naming itself — `sr-only` while there was no visible header. The bar's title *is* that heading
 * now, drawn. A page whose title is something else — the deck editor's rename field — passes
 * `titleAs="div"` and keeps its own heading.
 *
 * **`flex-wrap`, never an overhang**: at the app's 1024px floor a page with a long title and a
 * full run of actions drops the actions to a second line rather than pushing them out of the
 * window, the rule `FigureRow` learnt the hard way (2026-09-08).
 */
export function PageBar({
  title,
  titleAs: Title = "h2",
  titleId,
  titleGrows = false,
  trail = [],
  figures,
  meta,
  actions,
  toolbar,
  children,
  ruled = true,
  className,
}: {
  /** The page on screen. A string almost always; a node where the title is a control. */
  title: ReactNode;
  titleAs?: "h2" | "h3" | "div";
  titleId?: string;
  /**
   * The title is a control that should take the row's spare width — the deck editor's rename
   * field. The groups around it then keep their automatic min-width (the field's own floor), so
   * the row wraps the actions onto a line of their own before it would squeeze the field.
   */
  titleGrows?: boolean;
  /** The pages above this one, root first. Empty on a top-level page. */
  trail?: readonly PageCrumb[];
  /** Inline figures (`InlineFigureRow` from `@/components/Figure`), on the title's baseline. */
  figures?: ReactNode;
  /** Mono meta for a page with counts rather than figures. */
  meta?: ReactNode;
  /** The page's own actions. */
  actions?: ReactNode;
  /**
   * The page's own toolbar, when it has one and no figures row — Search's filter bar, the
   * Scanner's controls. The title then sits at its left end instead of on a row of its own, and
   * `figures`, `meta` and `actions` are not drawn.
   */
  toolbar?: ReactNode;
  /** A second line that belongs to the heading — the deck editor's stats — drawn under the row
   *  and above the rule, so the page has one rule rather than the bar's and its own. */
  children?: ReactNode;
  /**
   * `false` draws no rule and no space for one: the page draws {@link PageRule} itself, under a
   * line of its own that belongs to the heading — the deck editor's ledger, which is a sibling of
   * its bar rather than a child because the bar's component is memoised and the ledger is not.
   */
  ruled?: boolean;
  className?: string;
}) {
  return (
    // **No padding above, 12px below, and the row no taller than its controls** (owner's note,
    // 2026-10-21): `main`'s own 20px is the space above the title, and the 12px under the row
    // matches the gap most pages leave under the rule — a 52px row centred its title 16px further
    // down and read as a gap above the heading that was not there below it.
    <div className={cn("flex shrink-0 flex-col", className)}>
      <div className={cn("flex min-w-0 flex-col gap-2", ruled && "pb-3")}>
        {toolbar !== undefined ? (
          // The title at the left end of the page's own toolbar, centred on its first 36px line —
          // Search's filter row, the Scanner's controls — so naming the page costs no height.
          <div className="flex min-w-0 items-start gap-x-5">
            <div className="flex h-9 min-w-0 shrink-0 items-center">
              <PageTitle
                title={title}
                titleAs={Title}
                titleId={titleId}
                titleGrows={titleGrows}
                trail={trail}
              />
            </div>
            <div className="min-w-0 flex-1">{toolbar}</div>
          </div>
        ) : (
          <div className="flex min-h-9 min-w-0 flex-wrap items-center gap-x-5 gap-y-2">
            <div className={cn("flex items-baseline gap-x-5", titleGrows ? "flex-1" : "min-w-0")}>
              <PageTitle
                title={title}
                titleAs={Title}
                titleId={titleId}
                titleGrows={titleGrows}
                trail={trail}
              />
              {figures}
              {/* Shrinkable: a long meta line (a trade's "Opened … · prices · Saved as you go")
                  truncates before the title does. */}
              {meta != null && meta !== "" && (
                <span className={cn(PAGE_META, "min-w-0 truncate")}>{meta}</span>
              )}
            </div>
            {actions != null && (
              // Not `shrink-0`: a block whose own content can wrap must be allowed to, or its
              // max-content becomes a floor on the whole row — `FigureRow`'s 2026-09-08 defect.
              <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
                {actions}
              </div>
            )}
          </div>
        )}
        {children}
      </div>
      {/* The rule, in place of the hairline or gap that was under each page's top row. */}
      {ruled && <PageRule />}
    </div>
  );
}

/**
 * The trail and the Cinzel title — the bar's left end, on its own. Exported for a page whose
 * toolbar draws its own row and so takes the title as that row's first item: Search's filter bar
 * (`FilterBar`'s `lead`), where a title beside the row would narrow the box its one-line layout
 * is measured on. Such a page draws {@link PageRule} under its row itself.
 */
export function PageTitle({
  title,
  titleAs: Title = "h2",
  titleId,
  titleGrows = false,
  trail = [],
}: {
  title: ReactNode;
  titleAs?: "h2" | "h3" | "div";
  titleId?: string;
  titleGrows?: boolean;
  trail?: readonly PageCrumb[];
}) {
  // Root, `…`, immediate parent: the two a reader most often wants, and the rest elided. A trail
  // of two is drawn whole — eliding one crumb to save one crumb is no saving.
  const shown: (PageCrumb | null)[] =
    trail.length > 2 ? [trail[0], null, trail[trail.length - 1]] : [...trail];
  return (
    <div
      className={cn(
        "flex items-baseline gap-2 whitespace-nowrap",
        titleGrows ? "flex-1" : "min-w-0",
      )}
    >
      {shown.length > 0 && (
        // A trail is navigation, so it is a landmark — named `Page trail` rather than
        // `Breadcrumb`, so it never shares a name with a page's own folder trail (the
        // collection's `Collection folders`, the wishlist's `Wishlist folders`).
        <nav aria-label="Page trail" className="flex min-w-0 items-baseline gap-2">
          {shown.map((crumb, i) => (
            <Fragment key={crumb === null ? "gap" : `${i}:${crumb.label}`}>
              {crumb === null ? (
                <span aria-hidden="true" className="text-[13px] text-dim">
                  …
                </span>
              ) : crumb.onOpen === undefined ? (
                <span className="shrink-0 whitespace-nowrap text-[13px] text-dim">
                  {crumb.label}
                </span>
              ) : (
                <button
                  ref={crumb.ref}
                  type="button"
                  onClick={crumb.onOpen}
                  aria-label={crumb.name}
                  className={CRUMB}
                >
                  {crumb.label}
                </button>
              )}
              <ChevronRight
                aria-hidden="true"
                className="size-3 shrink-0 self-center text-dim/60"
                strokeWidth={2}
              />
            </Fragment>
          ))}
        </nav>
      )}
      {/* Truncated only when it is words: a control in the title (the rename field) carries a
          focus outline that an `overflow: hidden` here would clip. A growing title gives back
          `PAGE_TITLE`'s `min-w-0` for `min-w-auto`, so no box between the field and the
          wrapping row can be squeezed past the field's own floor. */}
      <Title
        id={titleId}
        className={cn(
          PAGE_TITLE,
          typeof title === "string" && "truncate",
          titleGrows && "flex min-w-auto flex-1",
        )}
      >
        {title}
      </Title>
    </div>
  );
}

/**
 * The page bar's rule, for a page that draws its heading row itself ({@link PageTitle}): 1px of
 * `--border` across the whole width.
 *
 * **Grey and full-width, not the gold fading hairline the canvas drew** (the owner's note,
 * 2026-10-21): a line that fades out to the right leaves the right half of the heading with no
 * edge under it, and the space above the title and below the line then read as uneven.
 */
export function PageRule() {
  return <div aria-hidden="true" className="h-px shrink-0 bg-border" />;
}
