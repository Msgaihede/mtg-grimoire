/**
 * **What a host answers about a membership it does not offer** — the command's name and what
 * its answer means. `hostStorage.ts`'s arrangement, for a second question.
 *
 * Sync is paid for with a membership, and the Sync panel's second half is where a reader
 * connects one. One host must not offer that: the light app's Tauri host is the build Google
 * Play distributes, and Play forbids an app to lead a reader to a payment made anywhere else —
 * a button, a link or a sentence (`docs/superpowers/specs/2026-10-07-google-play-release-design.md`
 * §3). A membership belongs to a group, so a device there gets sync by being paired into a
 * group that has one, and never meets the offer.
 *
 * **The page does not know which host that is, and is not told.** It asks this name. A host
 * that offers no membership answers one sentence, **in its own words**, saying how sync turns
 * on there — and the panel draws that sentence where the offer, the membership's status and
 * the claim code would be. Every other host has no such command and refuses the name, which is
 * nothing to draw differently: the desktop app's IPC and the engine's command table both
 * refuse a name they do not have, in words. That refusal is the whole of how the page stays
 * ignorant of where it runs (`mobile/phone/fence.test.ts`).
 *
 * **The answer is the sentence, not a yes the page words for itself** — `STORAGE_GROUP_WARNING`'s
 * rule, for its reason: a page that kept its own wording for "this host sells nothing" would be
 * a page that knew what kind of host it was on.
 *
 * Takes nothing. Answers a non-empty string, or is refused.
 */
export const MEMBERSHIP_ELSEWHERE = "membership_elsewhere";
