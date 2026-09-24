/**
 * The two footer buttons a card's popups press — the card detail modal's action row and the
 * price history dialog's, which is the second host of the same row.
 *
 * **One module rather than a copy in each dialog**, because the price history popup is asked to
 * look like the card details popup, and a resemblance is N independent decisions that happen to
 * agree today (`src/CLAUDE.md`, on `Dialog`). Two copies of these strings would be two answers to
 * "what height is a footer button at this rung" the first time either moved.
 *
 * Both are sized against the **`@container/card`** fold, so a host must pass `Dialog`'s
 * `container` for the 36px rung to exist at all — without it the query resolves against nothing
 * and every button stays at the phone's 44px.
 */

/**
 * An action-row button. 44px below `@min-[900px]/card` and the app's own 36px above it, which is
 * the fold `CardModalControls` draws its own controls at — the two rows sit under one another and
 * a row that changed height on a different measurement would read as a mistake.
 */
export const ACTION =
  "flex h-11 min-w-0 items-center justify-center rounded-md border border-border px-4 " +
  "text-sm text-dim transition-colors duration-[var(--duration-fast)] ease-standard " +
  "hover:text-text motion-reduce:transition-none @min-[900px]/card:h-9";

/**
 * The gold one. `border-accent text-accent` filling on hover is this app's primary button
 * wherever a dialog has one (`CreateDeckDialog`'s **Create deck**), rather than a solid fill
 * invented here.
 */
export const ACTION_PRIMARY =
  "flex h-11 min-w-0 items-center justify-center rounded-md border border-accent px-4 " +
  "text-sm text-accent transition-colors duration-[var(--duration-fast)] ease-standard " +
  "hover:bg-accent hover:text-accent-foreground motion-reduce:transition-none " +
  "@min-[900px]/card:h-9";
