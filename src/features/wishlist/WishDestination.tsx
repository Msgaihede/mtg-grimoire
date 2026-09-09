/**
 * **Where the next send files** — the one destination control for every surface that pushes
 * cards onto the wishlist without the reader standing on the wishlist page.
 *
 * Two of those exist today and both used to file at the root with no offer at all: the deck's
 * `Compare` dialog, and the live deck's `Send missing to wishlist`. A reader who keeps a
 * `Draft night` drawer had to send to the root, walk to the wishlist and re-file what they had
 * just sent — which is the wishlist's own `+`-files-at-the-root bug (2026-09-07) reappearing one
 * feature over, because a *destination* is not something a surface may leave unasked once the
 * cabinet exists.
 *
 * ## What is drawn, and what is deliberately not
 *
 * **The trigger and its list are this app's own `Dropdown`**, not a popup written here. Both hard
 * parts are already solved in it and neither is obvious: `usePopupPlacement` flips the panel up
 * when there is no room below — this control's first two call sites are dialog *footers*, which is
 * the one place in a window where there never is — and it corrects for the containing block a
 * `Dialog` panel makes, because `motion` leaves `scale: 1` on that panel at rest and **`scale: 1`
 * is not `none`**. `usePopupPlacement`'s own head comment names `TheoryDiffDialog` for exactly
 * that trap, which is one of the two surfaces wiring this control up.
 *
 * **Every folder is a row of its own, by full path, rather than an indented tree.** A
 * `DropdownOption` is a flat row carrying one `label`, so two drawers named `Someday` under
 * different parents would otherwise be one row printed twice with no way for a reader — or for a
 * `getByRole` — to tell which is which. The path is what disambiguates them; the *name* alone is
 * what {@link useWishDestinationName} answers, because a sentence about a send names the drawer
 * and this list is what already said which drawer it is.
 *
 * **The list is drawn even when the reader has no folders at all**, and that is a deliberate
 * departure from `cardMenu.tsx`'s rule for the same offer — there, "with no folders it is a single
 * action, exactly as it was before folders existed". The difference is where the reader is
 * standing. A card menu is opened on a page that has its own route to making a folder, so an
 * absent picker costs nothing; here, making a folder *without leaving the dialog* is the whole of
 * what issue #437 asks for, and a control that hid itself until a folder existed could never be
 * used to make the first one. Two rows — `Wishlist` and `New folder…` — is the floor, not an
 * empty state.
 *
 * ## The three glyphs
 *
 * `Heart` for the root, never `Folder`: the root is the list itself rather than a drawer in it.
 * The wording and the glyph are `buildWishlistTargetItems`' (`src/features/card/cardMenu.tsx`),
 * matched rather than re-decided — this is the same offer made from a different surface, and a
 * second wording for it is how one destination comes to have two names. `Folder` for a drawer, and
 * `FolderPlus` for the row that opens a surface instead of making a write, whose trailing ellipsis
 * is this app's mark for exactly that.
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { AnimatePresence } from "motion/react";
import { Folder, FolderPlus, Heart } from "lucide-react";
import { Dropdown } from "@/components/Dropdown/Dropdown";
import { usePopupPlacement } from "@/components/Dropdown/usePopupPlacement";
import type { DropdownOption } from "@/components/Dropdown/types";
import { PopupPanel } from "@/components/PopupListbox";
import { MoveToFolder } from "@/features/decks/MoveToFolder";
import { FOCUS } from "@/lib/focus";
import { buildFolderTree, type FolderNode } from "@/lib/folderTree";
import { ipcError, type WishlistFolder } from "@/lib/ipc";
import { LAYER } from "@/lib/layers";
import { PRESS } from "@/lib/motion";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { cn } from "@/lib/utils";
import { useWishlistFolderList, useWishlistFolders } from "./useWishlistFolders";

/**
 * The two `value`s that are not a folder id.
 *
 * A `Dropdown` speaks strings and a folder's own value is `String(id)`, which is always digits —
 * so neither of these can ever collide with one however the cabinet grows. Spelled as words
 * rather than as `""` and `"-1"`: an empty string is what a controlled `<select>` uses for "no
 * choice", and the root here is a *destination* rather than the absence of one.
 */
const ROOT_VALUE = "root";
const NEW_VALUE = "new";

/** The root's name, everywhere this app says it: `cardMenu.tsx`'s row, `MoveToFolder`'s
 *  `rootLabel` in `EditWish`, and the wishlist page's own breadcrumb. */
const ROOT_LABEL = "Wishlist";

/**
 * What joins the levels of a path.
 *
 * **`folderPaths` in `src/features/decks/DeckSettingsForm.tsx` spells the same idea `" › "`**, and
 * the two disagreeing is worth knowing about rather than hiding: that one is the deck gallery's
 * and this one is the wishlist's, and issue #437 asks for this spelling by name. If the app ever
 * settles on one, it settles in both places at once.
 */
const PATH_SEPARATOR = " / ";

/** A row's glyph. `flex-none` because the label beside it truncates and the mark must not. */
const GLYPH = "size-3.5 flex-none";

/**
 * One folder, and the path a reader would say out loud to reach it.
 *
 * **Walked off {@link buildFolderTree}'s answer rather than up each row's `parentId`**, and the
 * two genuinely differ. That builder resolves a folder whose parent is missing — and every folder
 * caught in a corrupt cycle — *to the root*, and terminates either way; a walk upward over the
 * flat rows needs a depth fence of its own and still prints a path through a folder that is not
 * on screen. Every gesture a reader makes is made against what they can see, so the path has to
 * be the path the tree draws.
 *
 * Depth-first, which is the order the tree is drawn in and the order a destination list offers.
 */
function pathRows(
  nodes: readonly FolderNode<WishlistFolder>[],
  prefix = "",
): { id: number; path: string }[] {
  return nodes.flatMap((node) => {
    const path = prefix === "" ? node.folder.name : prefix + PATH_SEPARATOR + node.folder.name;
    return [{ id: node.folder.id, path }, ...pathRows(node.children, path)];
  });
}

/**
 * The destination's name for a sentence — `null` at the root, the folder's own name otherwise.
 *
 * **The folder's NAME, never its path.** A call site writes `Sent. 4 wishes updated in
 * ${name}.`, and a sentence names the drawer: `Sent. 4 wishes updated in Ordered / Draft night.`
 * is a file path read aloud. The dropdown above is what disambiguates two drawers sharing a name,
 * and it has already done that by the time this sentence is written.
 *
 * **`null` while the list is still loading, and `null` for an id that names no folder any more.**
 * Both are the same answer for the same reason: this hook cannot say which drawer, so it says
 * nothing rather than guessing — and a caller's `name === null ? … : …` then falls to the root
 * sentence, which is where `wishlist_entries.folder_id`'s `ON DELETE SET NULL` puts the wishes
 * anyway. `EditWish` reads a missing folder as the root by the same rule.
 *
 * It reads {@link useWishlistFolderList} rather than taking a list as an argument, so a call site
 * that only wants the word does not have to grow a query — TanStack serves every reader of that
 * key from one cache entry.
 */
export function useWishDestinationName(folderId: number | null): string | null {
  const { folders } = useWishlistFolderList();
  if (folderId === null) return null;
  return folders.find((folder) => folder.id === folderId)?.name ?? null;
}

export function WishDestination({
  folderId,
  onChange,
  label,
  size = "sm",
  disabled = false,
}: {
  /** Where the next send files. `null` is the wishlist root. */
  folderId: number | null;
  onChange: (folderId: number | null) => void;
  /**
   * The trigger's accessible name — a whole sentence, e.g. "Wishlist folder to send to".
   *
   * The trigger's *content* is the destination, so without this the control announces a folder
   * name and nothing about what that folder is for. Two of these can be on one screen (a dialog
   * over a page that has one), so a caller picks a name that is distinct on the page rather than
   * distinct in the app — `FilterBar`'s `labels` rule, one control over.
   */
  label: string;
  /** @default "sm" */
  size?: "sm" | "md";
  disabled?: boolean;
}): ReactElement {
  const { folders } = useWishlistFolderList();
  /**
   * The folder this control has just made, held until the list query carries it.
   *
   * **The one moment the reader is watching is the moment the query is least able to answer.**
   * `create`'s success invalidates `["wishlist"]` and *then* resolves, so the render that files
   * the new destination happens while the folder list is still the old one — and a destination
   * this component could not find would fall back to the root below, i.e. the trigger would read
   * `Wishlist` for a beat after a press whose entire point was to file somewhere else.
   *
   * Merged during render rather than reconciled in an effect (`no setState inside an effect` is
   * this repo's rule and the React Compiler lint enforces it): the moment the refetch lands, the
   * list carries the folder, `known` stops widening, and this ref-like scrap of state becomes
   * inert without anything having to clear it.
   */
  const [minted, setMinted] = useState<WishlistFolder | null>(null);
  const [creating, setCreating] = useState(false);

  const triggerId = useId();
  /**
   * The whole control, which is three things at once: the box `usePopupPlacement` measures, the
   * subtree an outside press is judged against, and the element the panel is rendered *inside* so
   * that it follows its own trigger in DOM order. `KeyMap` takes its anchor the same way and for
   * the same three reasons.
   *
   * `inline-flex` so the box is the `Dropdown`'s own and not the row's — the panel below is
   * `fixed` and therefore out of flow, so it contributes nothing to this rect.
   */
  const rootRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const known = useMemo(
    () =>
      minted !== null && !folders.some((folder) => folder.id === minted.id)
        ? [...folders, minted]
        : folders,
    [folders, minted],
  );
  /**
   * The cabinet as a tree, and the same tree as one path per folder.
   *
   * Both are computed once, here, and handed down — the panel below draws the *same* cabinet from
   * the *same* rows, so a folder this control has just minted is offered as a parent for the next
   * one and named correctly in the panel's own caption. A second `buildFolderTree` inside the
   * panel read `folders` rather than `known` and would have gone on saying `Inside Wishlist` about
   * a folder the reader had made a second earlier.
   */
  const nodes = useMemo(() => buildFolderTree(known, []), [known]);
  const rows = useMemo(() => pathRows(nodes), [nodes]);

  const options = useMemo<DropdownOption[]>(
    () => [
      {
        value: ROOT_VALUE,
        label: ROOT_LABEL,
        icon: <Heart className={GLYPH} aria-hidden="true" />,
      },
      ...rows.map((row) => ({
        value: String(row.id),
        label: row.path,
        icon: <Folder className={GLYPH} aria-hidden="true" />,
      })),
      {
        value: NEW_VALUE,
        label: "New folder…",
        icon: <FolderPlus className={GLYPH} aria-hidden="true" />,
      },
    ],
    [rows],
  );

  /**
   * The destination as a row of this list — the root whenever the id names no folder we can see.
   *
   * That is `buildFolderTree`'s own rule for a child whose parent is missing, `EditWish`'s rule
   * for the folder line on a wish, and {@link useWishDestinationName}'s answer above: **three
   * readings of one id that must not disagree**, or a dialog would name one destination in its
   * picker and a different one in the sentence it prints afterwards. The alternative — leaving the
   * value unmatched — makes the trigger draw `Dropdown`'s em-dash placeholder, which says the
   * control has no destination at all when it demonstrably has one.
   *
   * Nothing is written back to the caller from here: a render may not call `onChange`, and an id
   * that is merely a refetch away from resolving is not a mistake to correct.
   */
  const value =
    folderId !== null && rows.some((row) => row.id === folderId) ? String(folderId) : ROOT_VALUE;

  const closePanel = useCallback(() => {
    setCreating(false);
    // The caret goes back to what opened the layer, which is every dismissible layer's contract
    // here. By id rather than by a ref because `Dropdown` exposes its trigger only through `id` —
    // `getElementById` and not `querySelector`, since `useId` mints ids that are not valid
    // selectors. `Dropdown` scrolls its own active row into view the same way.
    document.getElementById(triggerId)?.focus();
  }, [triggerId]);

  // One rung for one decision. The `Dropdown` registers its own `"inner"` rung while its list is
  // open and drops it on the press that opens this panel, so the two are never on the stack at
  // once and Escape never costs two presses to leave one choice.
  useDismissOnEscape({ layer: "inner", onDismiss: closePanel, enabled: creating });

  const { placement } = usePopupPlacement({
    triggerRef: rootRef,
    frameRef,
    panelRef,
    open: creating,
    // Pinned to the control's left edge: this sits at the left of a dialog's footer row, and a
    // panel opening leftwards from there is clipped by a scrim that cannot be scrolled back.
    align: "start",
    // An ancestor scrolled out from under the panel. Closed rather than followed, and **without**
    // the caret hand-back: the reader is looking somewhere else by definition.
    onClose: () => setCreating(false),
  });

  return (
    <div
      ref={rootRef}
      className="inline-flex"
      // Focus leaving the whole control closes the panel, which is how an outside press is caught
      // without a `window` listener that could fight the Escape handshake. Guarded on the flag for
      // `AnchoredPopup`'s reason: an exiting panel is still in this subtree, so focus leaving it
      // mid-fade fires this again. Nothing is handed back — an outside press means the reader is
      // already somewhere else, which is this app's standing rule.
      onBlur={(e) => {
        if (creating && !rootRef.current?.contains(e.relatedTarget)) setCreating(false);
      }}
    >
      <Dropdown
        id={triggerId}
        label={label}
        value={value}
        options={options}
        size={size}
        disabled={disabled}
        onChange={(next) => {
          if (next === NEW_VALUE) {
            setCreating(true);
            return;
          }
          onChange(next === ROOT_VALUE ? null : Number(next));
        }}
      />
      <AnimatePresence>
        {creating && (
          // The key belongs on `AnimatePresence`'s own direct child — `Dropdown`'s note and
          // `KeyMap`'s, and the same shape. The frame is the zero-size `fixed` box
          // `usePopupPlacement` measures, so whatever containing block this control landed in is
          // subtracted rather than guessed at.
          <div key="panel" ref={frameRef} className={cn("fixed left-0 top-0 size-0", LAYER.popup)}>
            <PopupPanel
              ref={panelRef}
              style={{ left: placement?.left ?? 0, top: placement?.top ?? 0 }}
              className={cn(
                "absolute w-64 rounded-lg border border-border bg-surface p-3 text-text shadow-lg",
                // Pinned by the corner it grows from. All four written out whole: Tailwind scans
                // source text, so a class built by interpolation emits no rule at all.
                placement?.flipY
                  ? placement.flipX
                    ? "origin-bottom-right"
                    : "origin-bottom-left"
                  : placement?.flipX
                    ? "origin-top-right"
                    : "origin-top-left",
                // Invisible for the one frame before the panel's own size exists.
                placement === null && "invisible",
              )}
            >
              {/* A component of its own so that its contents mount and unmount **with** the panel:
                  a half-typed name, a picked parent and a refusal are all facts about one opening
                  and must not survive into the next. `AnchoredPopup` splits its own panel out for
                  exactly this and says so. */}
              <NewFolderPanel
                nodes={nodes}
                rows={rows}
                startParentId={value === ROOT_VALUE ? null : Number(value)}
                onCreated={(folder) => {
                  setMinted(folder);
                  onChange(folder.id);
                  closePanel();
                }}
                onCancel={closePanel}
              />
            </PopupPanel>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** A caption over one section of the panel. `formFields.ts`'s `CAPTION` at the same size — not
 *  imported, because that module's subject is a *deck form* and this is a wishlist popup. */
const CAPTION = "block text-[0.6875rem] text-dim";

/**
 * The name line.
 *
 * **`Dropdown`'s own search box**, which is the box that control draws inside a panel of exactly
 * this shape, at exactly this layer, opened by exactly this trigger — minus its `mb-2`, which is
 * that panel's spacing rather than the field's, plus an explicit `text-text` for the reason
 * `Dropdown`'s rows spell one: nothing on the way down here names a text colour, so a field that
 * inherited would take whatever the page around the control happens to be using.
 *
 * Copying the folder *wall*'s field instead would be wrong twice over: `FolderNameField` is a tile
 * shaped to a folder card's 62px footprint with its ✓/✕ absolutely positioned against the `<li>`
 * around it, and neither of those things exists here.
 *
 * It carries no press recipe, which is a rule rather than an omission: `motion.test.ts` sweeps
 * every box the reader types into for one, because a `scale` on a field pivots the whole box under
 * the pointer.
 */
const FIELD = cn(
  "h-8 w-full rounded-md border border-border bg-bg px-2 text-sm text-text",
  "focus:border-accent focus:outline-none",
);

/**
 * The panel's two buttons.
 *
 * Written here rather than shared, because this app has no button primitive: `EditWish`'s
 * `PANEL_BUTTON` is private to that file, `features/settings/controls.ts`'s `BUTTON` is the
 * Settings page's vocabulary, and `features/scanner/panels/Panel.tsx` has a third. What is not
 * re-decided is the press and the focus ring, which come from the two modules that own them.
 *
 * **A real `disabled` on the submit, which is this app's usual `aria-disabled` rule reversed and
 * is right here for `FolderNameField`'s reason**: the rule is about a control that greys as the
 * reader types *and still has something to say*, and a submit whose whole meaning is the empty
 * field beside it has nothing. `disabled:active:scale-100` holds it still, so a greyed control
 * cannot depress under the finger and disagree with its own look.
 */
const PANEL_BUTTON = cn(
  "inline-flex h-7 items-center rounded-md border px-2.5 text-xs",
  PRESS,
  "disabled:opacity-40 disabled:active:scale-100",
  FOCUS,
);

/**
 * `New folder…`, opened.
 *
 * **`useWishlistFolders()` is mounted here and not one component up, and that placement is the
 * whole of how the summary stays opt-in.** `useWishlistFolderList()` is the cheap read every
 * reader of the cabinet shares; `useWishlistFolders()` composes it *and* mounts
 * `wishlist_folder_summary`, a `GROUP BY` over every wish carrying the owned-copies subquery and a
 * marketplace price expression. `WishDestination` is drawn on the deck editor and inside a deck
 * dialog, neither of which draws a folder card or a price subtotal — so mounting the write's hook
 * at the control's own level would pay for that query on every deck a reader opens. Mounted here,
 * it costs nothing until the reader presses a row that exists to make a write. That is
 * `MenuLazy`'s argument in `cardMenu.tsx`, applied to a query instead of to a submenu, and the two
 * hooks share one cache entry for the list either way.
 */
function NewFolderPanel({
  nodes,
  rows,
  startParentId,
  onCreated,
  onCancel,
}: {
  /** The cabinet the parent picker offers, and the same cabinet as paths for the caption above
   *  it — both computed by the control, so the panel cannot disagree with the list behind it. */
  nodes: readonly FolderNode<WishlistFolder>[];
  rows: readonly { id: number; path: string }[];
  /** The parent the panel opens on — the destination the control is already pointing at, because
   *  a reader who has picked `Ordered` and then presses `New folder…` is making a drawer in it. */
  startParentId: number | null;
  onCreated: (folder: WishlistFolder) => void;
  onCancel: () => void;
}) {
  const { create } = useWishlistFolders();
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState(startParentId);
  const [refusal, setRefusal] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const nameId = useId();

  const trimmed = name.trim();

  /**
   * The caret lands on the name, because typing one is the first thing there is to do.
   *
   * **This has to be a passive effect and it has to be here rather than in a layout effect**, and
   * both halves are load-bearing: `MoveToFolder` focuses its own root on mount and cannot be told
   * not to, React runs a parent's effects *after* its children's, and every layout effect runs
   * before every passive one. So a `useLayoutEffect` here would put the caret on the field and
   * have the destination list take it away a moment later. The test named `puts the caret on the
   * name field` is the fence, since nothing about the ordering is visible in the markup.
   */
  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const submit = () => {
    // **The guard is here as well as on the tick, and the reason is not the one `FolderNameField`
    // gives.** That file says implicit submission does not ask the tick's permission; it does.
    // Enter in a text field is a click on the form's default button, and a *disabled* button's
    // activation behaviour is a no-op — HTML's own rule, and jsdom's
    // `HTMLButtonElement._activationBehavior` is guarded by `!isDisabled(this)` to match. So with
    // the tick greyed, Enter never reaches this function at all. What this line is really for is
    // the edit that swaps `disabled` for `aria-disabled` — which is the house rule's *default*
    // answer everywhere else — and a second submit landing while the first is in flight.
    //
    // Trimmed, so a trailing space makes `Draft night` rather than a folder whose stored name
    // disagrees with what is drawn beside it; `wishlist_folders::valid_name` trims and refuses the
    // empty remainder at the far end, so a name that is only spaces is refused twice and reaches
    // the database never.
    if (trimmed === "" || create.isPending) return;
    setRefusal(null);
    create.mutate(
      { parentId, name: trimmed },
      {
        onSuccess: onCreated,
        // **Reported, never swallowed.** The panel stays open holding what the reader typed, and
        // the destination above is left exactly as it was: a press that failed must not look like
        // a press that worked.
        onError: (error) => setRefusal(ipcError(error)),
      },
    );
  };

  const parentPath =
    parentId === null ? ROOT_LABEL : (rows.find((row) => row.id === parentId)?.path ?? ROOT_LABEL);

  return (
    <form
      // `<form>` with a name is a `role="form"` grouping already, so nothing here overrides a
      // role — and this is a real form rather than a div with a button: Enter in the field is the
      // browser's own implicit submission, which is what "submits on Enter" means for free.
      aria-label="New folder"
      // **A landing pad, and it is what stops a press on the panel's own words from closing it.**
      // Pressing a non-focusable element moves the caret to the nearest focusable *ancestor*, and
      // with none inside this panel that is `<body>` — which reaches the control's outside-press
      // guard as a `focusout` with a null `relatedTarget` and reads as the reader having looked
      // away. So clicking the `Inside …` caption would dismiss the panel mid-decision.
      // `AnchoredPopup` gives its own panel this attribute for the same reason, and
      // `src/lib/focus.ts` is why it draws no outline: nobody navigated here, so there is no
      // "you are here" to draw.
      tabIndex={-1}
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="space-y-1">
        {/* **A visible `<label>` rather than an `aria-label`, so the two names cannot disagree.**
            `FolderNameField` calls the same box `New folder name` because a folder *tile* has no
            room for a caption and that string is its only name; a panel has the room, so the word
            a reader sees is the word a screen reader hears, and WCAG 2.5.3 is satisfied by
            construction rather than by a substring test. It sits in a form named `New folder`,
            which is what supplies the rest of the sentence. */}
        <label htmlFor={nameId} className={CAPTION}>
          Name
        </label>
        <input
          ref={nameRef}
          id={nameId}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={FIELD}
        />
      </div>

      <div className="space-y-1">
        {/* Truncated rather than wrapped, which is `EditWish`'s `SectionLine` rule and its reason:
            a two-line value would move everything under it, and the panel's height would then
            depend on how deep a folder the reader picked — measured once on mount, that is a
            panel whose placement stops being true the moment it is used. Nothing is lost, because
            the list immediately below marks that same folder `Here now`. */}
        <span className={cn(CAPTION, "truncate")}>Inside {parentPath}</span>
        {/* **`inline`, which is the whole of what makes this a section rather than a second
            layer.** The popup shape — anchored, its own width, its own box, its own z-index — is
            what the deck gallery needs; here the list has been drawn into a layer that is already
            open, and drawing it as one of its own would give one decision two Escape rungs on a
            ladder ordered by registration. It carries the *role* as well as the box: inline the
            list is a `group`, so a screen reader is told what the eye can already see. This is
            `EditWish.tsx`'s composition, and the only thing that differs is which question the
            list is answering — there, where a wish goes; here, where a folder goes. */}
        <MoveToFolder
          label="Where the new folder goes"
          nodes={nodes}
          // The parent chosen so far, which `MoveToFolder` draws as `Here now` and makes inert.
          // Re-picking it would write nothing anyway, and the mark is what says which row the
          // caption above is naming when the list has been scrolled past it.
          currentId={parentId}
          // The top level of *this* tree. The component defaults to the deck gallery's word, which
          // is the surface it was written for; a reader filing a card they are buying must not be
          // told they are putting it in the deck gallery.
          rootLabel={ROOT_LABEL}
          inline
          // Nothing is forbidden: a folder that does not exist yet has no descendants to be filed
          // inside, which is the whole of what `forbidden` is for.
          pending={create.isPending}
          // **The caret goes back to the name, and that is a fence as well as a courtesy.**
          // `MoveToFolder` draws `currentId` inert, so the row just pressed carries `disabled` on
          // the very next render — and a browser blurs an element that becomes disabled under the
          // caret, which arrives as a `focusout` with a **null** `relatedTarget` and reads to this
          // control's own outside-press guard as the reader having looked away. The panel would
          // close on the press that chose the parent. Moving the caret first, synchronously in the
          // handler and therefore before the row is disabled, makes the question moot — and leaves
          // the reader back on the field they were half-way through typing. **jsdom does not blur
          // an element it disables**, so the suite could never see the failure; the test that
          // pins this asserts the caret rather than the absence of the bug.
          onPick={(id) => {
            setParentId(id);
            nameRef.current?.focus();
          }}
          // **Deliberately nothing.** `onClose` means "focus left this layer on its own", and the
          // only layer here is the panel — whose own root already closes it when focus leaves.
          // Wired to anything else it would fire on the caret merely reaching the Create button
          // beside it, and unmount that button under the press about to be made on it.
          onClose={() => {}}
        />
      </div>

      {refusal !== null && (
        <p role="alert" className="text-[0.7rem] leading-relaxed text-destructive">
          Could not make the folder — {refusal}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className={cn(PANEL_BUTTON, "border-border text-dim hover:text-text")}
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={trimmed === "" || create.isPending}
          className={cn(PANEL_BUTTON, "border-accent text-accent")}
        >
          {create.isPending ? "Creating…" : "Create folder"}
        </button>
      </div>
    </form>
  );
}
