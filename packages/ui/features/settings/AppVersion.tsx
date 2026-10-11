import { GrimoireMark } from "@/components/GrimoireMark";

/**
 * The app's mark, its name and the version running, over one line about that version — the head
 * of both Updates panels: the desktop's (`UpdatePanel`, under it the last check) and the light
 * edition's (`VersionPanel`, under it the day the version was released).
 */
export function AppVersion({ version, detail }: { version: string; detail: string }) {
  return (
    /* The app's mark, beside the version it is the mark for. This panel is the nearest thing the
       app has to an About screen — the name, the build and the line under them are already
       answers to one question, and the mark is the fourth.

       **36px is the height of the block it stands beside, not a size off a scale.** The two lines
       to its right are `text-sm` over `text-xs`: 20px and 16px of line box, 36 together. So the
       mark's box is exactly the pair's height and it lines up with them without a nudge, where a
       larger one would have to be centred against a block it overhangs — which is a logo pulling
       the eye off the line that actually answers the reader. It is also half again over the 24px
       `GrimoireMark` needs before it will draw the full artwork, so this is the casting circle,
       the runes and the clasp rivets rather than the simplified mark anything in a 34px chrome
       row can hold. A settings page is where the detail is affordable, and that is the whole of
       why the number here is not the number the chrome uses. **So both lines are always drawn**:
       a caller with nothing to say under the version would leave the mark overhanging one.

       **Hidden from assistive technology, which is the prop's default and is deliberate here
       rather than skipped.** The `<p>` beside it sets `MTG Grimoire` in type, in the same
       sentence as the version — so naming the mark would read the product name out twice in a
       row to the one reader who cannot see that the two are the same thing. `label` is for a
       surface that draws the mark *instead of* the words; this one draws both, and that is the
       test to apply if the sentence beside it ever changes. */
    <div className="flex min-w-0 items-center gap-3">
      <GrimoireMark size={36} className="text-accent" />
      {/* `min-w-0` on both boxes, because a `min-w-0` that stops one level short of the text is
          the same as not having it: this wrapper is the flex item the row wraps, and a flex item
          cannot shrink below its own min-content unless it is told it may. The mark carries its
          own `shrink-0`, so what gives way is the type. */}
      <div className="min-w-0">
        <p className="text-sm text-text">
          MTG Grimoire{" "}
          {/* A version is data, and data is Geist Mono — the direction's third type role,
              alongside collector numbers and prices. */}
          <span className="font-mono tabular-nums">{version}</span>
        </p>
        <p className="text-xs text-dim">{detail}</p>
      </div>
    </div>
  );
}
