# Google Play B — the Play build is pair-only: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the light app's Tauri host — the build Google Play distributes — nothing a reader can reach names Patreon, a membership, a supporter or a payment, and no path opens Patreon; a phone gets sync by pairing with a device that already syncs. The desktop app and the web app are unchanged.

**Architecture:** The existing host seam: a host answers a command name or refuses it, and the page draws only what it was handed. The light Tauri host answers one new name, `membership_elsewhere`, with its own sentence; it refuses the two Patreon commands before the core's table is reached; and it rewords three core error sentences on their way out of `core_call`. The shared Sync panel asks that one name and, when a host answered, draws the host's sentence in place of everything about membership. The page never learns what kind of host it is on.

**Tech Stack:** Rust (the `grimoire-light` crate, `mobile/src-tauri`), React 19 + TanStack Query (`src/features/settings/SyncPanelBody.tsx`), Vitest + Testing Library, the Storybook fake (`.storybook/fake`).

**Spec:** `docs/superpowers/specs/2026-10-07-google-play-release-design.md` §5 (and §3 for Google's rule). Read it before starting.

## Global Constraints

- **Nothing under `mobile/` asks which platform it runs on** (`mobile/phone/fence.test.ts`). No `userAgent`, `isTauri`, `__TAURI`, `isAndroid`, `@tauri-apps/plugin-os`. The decision is the host's, in Rust.
- **The page has no words of its own for the host's sentence.** It draws the string it is handed. Tests hand it a sentence no host ships.
- **The light Tauri host answers on every platform it builds for** — Android and its desktop debugging window (`mobile:tauri`). No `cfg(target_os = "android")` round the new module.
- **The desktop app and the web host refuse `membership_elsewhere`** by having no such command, and draw exactly what they draw today. No existing desktop assertion may be weakened to make this pass.
- **No control and no text is drawn about membership until the host has answered or refused.** A *Connect Patreon* that flashes is the defect.
- **On a host that answered, the reader never sees** (case-insensitive) `patreon`, `membership`, `supporter`, `supporting`, `payment`, `pledge`, `subscri`, or a price, from the Sync panel or from an error `core_call` returns.
- **The core's wording is not edited.** `crates/grimoire-core` strings stay as they are for the desktop and the web app; the light host rewords them at its own boundary.
- **Design tokens:** dim text is `text-dim`; a settings button is `PANEL_BUTTON`. No new colours, no new components.
- **Domain vocabulary:** a *membership* here is the Patreon entitlement; a *group* is the pairing group. Do not write "account", "subscription" or "plan" in any new string.
- **One commit for this whole plan** (`feat(android): …`), in the last task. `npm run verify` once, in the last task; before that run only the single test file a step names.
- **This worktree needs `npm install` before any Vitest run** (the `worktree-setup` skill).

## An addition the spec's sweep found

Spec §5 lists what `SupporterSection` draws. A sweep of everything else a light-edition reader can reach found five more places; this plan handles three and names two it leaves:

| Found | Where | This plan |
| --- | --- | --- |
| `relayNote("off")`: "…until you connect a membership." and `outcomeText(null)`: "…Connect a membership and pair a device first." | `SyncPanelBody.tsx` | Both take the host's answer and say it without a membership (Task 3) |
| Three core error sentences that reach the panel's red alert: `entitlement::GROUP_IS_FULL`, `identity::NO_MEMBERSHIP`, and `client.rs`'s "…; the membership has ended" | `crates/grimoire-core` | Reworded by the light host as they leave `core_call` (Task 1) |
| The same `GROUP_IS_FULL` sentence written to `error_log` by the live-sync loop, read back in Settings → Errors | `sync_engine/live.rs` | **Left.** It is a row of data, not an error from a call; it states a limit, offers nothing to press and names no price. Named in Review Focus |
| The collection's **Share** button on the desktop face for a device whose group is entitled; it calls `share_list`, which no light host has | `ShareFolderMenu.tsx` | **Left to its own change**: it is broken on the web app today too, and names no payment |
| Settings search keywords `patreon supporter membership` | `nav.ts` | **Left.** Matched against typing, never displayed |

## Review Focus

1. **A reader on the Play build whose group's membership has ended** presses *Sync now*. They should read that sync is no longer on for the group, not that a membership ended. → Task 1's `reword` test for the lapsed sentence.
2. **A sixth device joining a full group on the Play build** should be told the group has five devices, in the pairing sentence's words. → Task 1's `reword` test for `GROUP_IS_FULL`.
3. **The host answering late** (a slow first IPC call): the panel must draw neither *Connect Patreon* nor the word "Membership" in the gap. → Task 3's "draws nothing of the offer before the host has answered".
4. **A host that answers something that is not a sentence** (`null`, `""`, an object): the panel must treat it as a refusal and draw the desktop's panel, never an empty paragraph. → Task 3's "reads an answer that is not a sentence as a refusal".
5. **A tablet at 1024px or wider on the Play build** draws the desktop face; its Sync panel is the same component and must be pair-only too. → covered by construction (one component, one question) and by Task 4's live pass at both widths; no unit test tells the faces apart.

Left visible on purpose, for the owner to weigh: the `error_log` row in item 3 of the table above.

## File Structure

| File | Change | Responsibility |
| --- | --- | --- |
| `mobile/src-tauri/src/membership.rs` | create | The host's answer, its two refusals, and its rewording of three core sentences |
| `mobile/src-tauri/src/lib.rs` | modify | Route the three names before the table; reword errors after it |
| `src/lib/core/hostMembership.ts` | create | The command's name and what its answer means — read by the page and the fake |
| `src/features/settings/SyncPanelBody.tsx` | modify | Ask once; draw the host's sentence in place of the membership block |
| `src/features/settings/SyncPanel.test.tsx` | modify | The panel on a host that answers, refuses, answers late, answers nonsense |
| `.storybook/fake/db.ts`, `.storybook/fake/world.ts`, `.storybook/fake/world.test.ts` | modify | A `pairOnly` fault: a world whose host answers in the light host's own words |
| `src/features/settings/SyncPanel.stories.tsx` | modify | One story, so the panel can be seen and driven at a phone's width |
| `mobile/host.test.ts` | modify | Hold `lib.rs`'s routing and the lapsed sentence's tail to the core's |
| `mobile/src-tauri/capabilities/light.json` | modify | Its description no longer says Connect Patreon leaves through the opener |
| `mobile/CLAUDE.md`, `docs/reference/light-app.md` | modify | Say what is now true |

---

### Task 1: The light host answers, refuses and rewords

**Files:**
- Create: `mobile/src-tauri/src/membership.rs`
- Modify: `mobile/src-tauri/src/lib.rs` (the `mod` list near line 39; `core_call`, lines 63–87)
- Modify: `mobile/src-tauri/capabilities/light.json` (`description`)
- Test: in `membership.rs` itself (`#[cfg(test)] mod tests`)

**Interfaces:**
- Consumes: `grimoire_core::sync_engine::entitlement::GROUP_IS_FULL`, `grimoire_core::sync_pair::identity::{GROUP_IS_FULL, NO_MEMBERSHIP}` (all `pub const &str`).
- Produces:
  - command `membership_elsewhere` → the JSON string `membership::SENTENCE`;
  - commands `sync_patreon_begin`, `sync_patreon_claim` → `Err("<name>: <NOT_OFFERED>")`;
  - `pub fn answers(name: &str) -> bool`, `pub fn answer(name: &str) -> Result<serde_json::Value, String>`, `pub fn reword(error: String) -> String`;
  - `pub const SENTENCE: &str` and `pub const LAPSED_TAIL: &str`, each **a string literal on one line** — Task 2 and Task 4 read this file as text.

- [ ] **Step 1: Write `mobile/src-tauri/src/membership.rs` with its tests**

```rust
//! **Sync on this host is joined, never bought** — Google Play, 2026-10-07
//! (`docs/superpowers/specs/2026-10-07-google-play-release-design.md` §5).
//!
//! Sync is paid for with a Patreon membership, and a membership belongs to a *group*: any device
//! paired into an entitled group is entitled with it (`sync_engine::entitlement`). Google Play's
//! Payments policy lets an app use what was paid for somewhere else and forbids it to lead a
//! reader to that somewhere — a button, a link or a sentence. So this host, the one Play
//! distributes, offers no membership at all:
//!
//! - **`membership_elsewhere`** → one sentence, in this host's own words, saying how sync turns
//!   on here. The Sync panel asks the name once and, handed a sentence, draws it where the
//!   membership block would be (`src/lib/core/hostMembership.ts`). The desktop app and the web
//!   host have no such command, refuse the name, and draw what they always have — which is the
//!   whole of how the page stays ignorant of where it runs.
//! - **`sync_patreon_begin` and `sync_patreon_claim` are refused here**, before the core's table
//!   is reached. The panel no longer draws the presses that send them; this is the same rule
//!   held a second time, so no page that regressed could open Patreon from this build.
//! - **Three of the core's sentences are reworded on their way out** ([`reword`]). They are
//!   written for a reader who can connect a membership, and say so. Here they say what is true
//!   of the group instead. The core's wording is the desktop's and the web app's and is not
//!   edited.
//!
//! **It answers on every platform this crate builds for**, the desktop debugging window
//! included: this host *is* the Play build, and answering everywhere is what lets the panel be
//! driven in `mobile:tauri`.

use grimoire_core::sync_engine::entitlement::GROUP_IS_FULL as RELAY_GROUP_IS_FULL;
use grimoire_core::sync_pair::identity::{GROUP_IS_FULL, NO_MEMBERSHIP};
use serde_json::Value;

/// The name the Sync panel asks by — `src/lib/core/hostMembership.ts` spells it for the page.
pub const ELSEWHERE: &str = "membership_elsewhere";

/// What this host says in place of an offer. One line: `.storybook/fake/world.ts` reads this
/// literal as text, so a story draws the sentence a phone draws.
pub const SENTENCE: &str = "Sync turns on for this device when it is paired with one that already syncs.";

/// The two commands that begin and finish connecting a membership.
const BEGIN: &str = "sync_patreon_begin";
const CLAIM: &str = "sync_patreon_claim";

/// What either of them is answered with here.
pub const NOT_OFFERED: &str = "this app turns sync on by pairing, not by connecting";

/// What the core says once the relay has answered 401: `sync_engine::client`'s `lapsed`. One
/// line: `mobile/host.test.ts` holds this literal to the core's own source.
pub const LAPSED_TAIL: &str = "; the membership has ended";

/// The same news, about the group.
const LAPSED_HERE: &str = "; sync is no longer on for this group";

/// `identity::NO_MEMBERSHIP`, without its last sentence's instruction.
const NO_SYNC_YET: &str = "Removing a device changes the key your devices share, and that change has to reach the others through the relay. Sync is not on for this group yet.";

/// Whether `name` is one of the three commands this module answers.
pub fn answers(name: &str) -> bool {
    name == ELSEWHERE || name == BEGIN || name == CLAIM
}

/// Answer one of the three — [`answers`] said it is one.
pub fn answer(name: &str) -> Result<Value, String> {
    if name == ELSEWHERE {
        Ok(Value::String(SENTENCE.to_owned()))
    } else {
        Err(format!("{name}: {NOT_OFFERED}"))
    }
}

/// One of the core's refusals, in this host's words.
///
/// - the relay's device cap becomes the pairing ceremony's sentence for the same limit, which
///   the core already has and which names a group, not a membership;
/// - a removal with nothing to carry it keeps its explanation and loses its instruction;
/// - a 401's "the membership has ended" becomes what that means for the group — matched as a
///   part and not a suffix, because the core may append why a grant could not be cleared.
///
/// Anything else is returned as it came.
pub fn reword(error: String) -> String {
    if error == RELAY_GROUP_IS_FULL {
        return GROUP_IS_FULL.to_owned();
    }
    if error == NO_MEMBERSHIP {
        return NO_SYNC_YET.to_owned();
    }
    if error.contains(LAPSED_TAIL) {
        return error.replace(LAPSED_TAIL, LAPSED_HERE);
    }
    error
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every word Play's rule is about. A sentence of this host's that held one would be the
    /// host leading a reader to a payment.
    const FORBIDDEN: [&str; 8] = [
        "patreon",
        "membership",
        "supporter",
        "supporting",
        "payment",
        "pledge",
        "subscri",
        "price",
    ];

    fn clean(sentence: &str) {
        let lower = sentence.to_lowercase();
        for word in FORBIDDEN {
            assert!(!lower.contains(word), "{sentence:?} says {word:?}");
        }
    }

    #[test]
    fn it_answers_its_three_commands_and_nothing_else() {
        assert!(answers("membership_elsewhere"));
        assert!(answers("sync_patreon_begin"));
        assert!(answers("sync_patreon_claim"));
        assert!(!answers("sync_supporter_status"));
        assert!(!answers("sync_now"));
        assert!(!answers("sync_pairing_begin"));
    }

    #[test]
    fn it_says_how_sync_turns_on_here_and_names_no_payment() {
        let said = answer(ELSEWHERE).unwrap();
        assert_eq!(said, Value::String(SENTENCE.to_owned()));
        assert!(SENTENCE.contains("paired"), "{SENTENCE}");
        clean(SENTENCE);
    }

    #[test]
    fn it_refuses_both_halves_of_connecting_by_name() {
        for name in [BEGIN, CLAIM] {
            let refusal = answer(name).unwrap_err();
            assert!(refusal.starts_with(&format!("{name}: ")), "{refusal}");
            // Never an authorize address: `sync_patreon_begin`'s answer is a URL the page opens.
            assert!(!refusal.contains("http"), "{refusal}");
            clean(&refusal);
        }
    }

    #[test]
    fn the_relays_device_cap_reads_as_the_pairing_ceremonys() {
        let said = reword(RELAY_GROUP_IS_FULL.to_owned());
        assert_eq!(said, GROUP_IS_FULL);
        assert!(said.contains("five"), "{said}");
        clean(&said);
    }

    #[test]
    fn a_removal_with_nothing_to_carry_it_loses_its_instruction() {
        let said = reword(NO_MEMBERSHIP.to_owned());
        assert!(said.starts_with("Removing a device changes the key"), "{said}");
        assert!(!said.contains("Connect"), "{said}");
        clean(&said);
    }

    #[test]
    fn a_lapse_is_news_about_the_group() {
        let plain = reword(format!("the relay answered 401 to a push{LAPSED_TAIL}"));
        assert_eq!(plain, "the relay answered 401 to a push; sync is no longer on for this group");
        // With the core's own postscript after it.
        let noted = reword(format!(
            "the relay answered 401 to a pull{LAPSED_TAIL} (the grant could not be cleared: busy)"
        ));
        assert_eq!(
            noted,
            "the relay answered 401 to a pull; sync is no longer on for this group \
             (the grant could not be cleared: busy)"
        );
        clean(&plain);
        clean(&noted);
    }

    #[test]
    fn every_other_refusal_is_left_as_it_came() {
        for error in [
            "There is no command named nope on this host.",
            "the relay answered 503 to /g/abc/pull",
            "",
        ] {
            assert_eq!(reword(error.to_owned()), error);
        }
    }

    /// The sentences this host rewords are the core's, by value: were one of them reworded
    /// there, `reword` would stop matching it and say nothing.
    #[test]
    fn the_cores_sentences_are_the_ones_this_host_expects_to_reword() {
        assert!(RELAY_GROUP_IS_FULL.to_lowercase().contains("membership"));
        assert!(NO_MEMBERSHIP.ends_with("Connect a membership first."));
        assert_ne!(RELAY_GROUP_IS_FULL, GROUP_IS_FULL);
    }
}
```

- [ ] **Step 2: Declare the module and see its tests fail to be routed**

In `mobile/src-tauri/src/lib.rs`, add `mod membership;` to the module list, in alphabetical order:

```rust
mod downloads;
mod files;
mod membership;
mod navigation;
mod startup;
```

Run: `cargo test -p grimoire-light membership`

Expected: the eight tests in `membership::tests` PASS — the module is whole on its own. (A module that is not declared makes every cargo run vacuous: if this prints `running 0 tests`, the `mod` line is missing.)

- [ ] **Step 3: Route the three names, and reword what the table refuses**

In `mobile/src-tauri/src/lib.rs`, in `core_call`, add the membership check directly after the `files::answers` block, and reword the table's errors. The function's body becomes:

```rust
    if name == startup::COMMAND {
        let status = app.state::<Startup>().status();
        return serde_json::to_value(status).map_err(|e| e.to_string());
    }
    // The two file commands need no state: a dialog and a document, never the database.
    if files::answers(&name) {
        return files::answer(&app, &name, args).await;
    }
    // Nor does how sync is turned on here: one sentence, and two refusals. Before the state,
    // so the answer is the same on a launch that has not opened its database yet.
    if membership::answers(&name) {
        return membership::answer(&name);
    }
    let Some(state) = app.try_state::<Arc<State>>() else {
        return Err(format!("{name}: the app is still starting."));
    };
    let state = Arc::clone(&state);
    if downloads::answers(&name) {
        let hold = app.state::<downloads::Hold>();
        return downloads::answer(state, &hold, &name, args).await;
    }
    let body = body.map(|b| decode_body(&name, &b)).transpose()?;
    grimoire_core::dispatch(&state, &name, args.unwrap_or(Value::Null), body)
        .await
        .map_err(membership::reword)
```

Add to the file's module doc, after the bullet about the two file commands:

```rust
//! - **how sync is turned on here** ([`membership`]): this is the build Google Play
//!   distributes, so it offers no membership — one sentence for the Sync panel, the two
//!   connecting commands refused, and three of the core's sentences reworded on their way out.
```

- [ ] **Step 4: The capability's description**

In `mobile/src-tauri/capabilities/light.json`, in `description`, replace

`because a press that leaves the app — the desktop face's \`Open on …\` on a tablet past 1024px, and Connect Patreon on both faces — goes through`

with

`because a press that leaves the app — the desktop face's \`Open on …\` on a tablet past 1024px, and the privacy policy's link — goes through`

The `permissions` array is unchanged.

- [ ] **Step 5: Run the crate's tests**

Run: `cargo test -p grimoire-light`

Expected: PASS, the crate's earlier tests and the eight new ones.

---

### Task 2: The name, and a fake host that answers it

**Files:**
- Create: `src/lib/core/hostMembership.ts`
- Modify: `.storybook/fake/db.ts` (the `Fault` union near line 1582 and its doc comment above)
- Modify: `.storybook/fake/world.ts` (imports; after the `lentStorage` block near line 238)
- Modify: `.storybook/fake/world.test.ts` (after the `lentStorage` test near line 137)

**Interfaces:**
- Consumes: `membership.rs`'s `pub const SENTENCE: &str = "…";` on one line (Task 1).
- Produces:
  - `export const MEMBERSHIP_ELSEWHERE = "membership_elsewhere"` from `@/lib/core/hostMembership`;
  - fault `"pairOnly"` in the fake's `Fault` type;
  - `export const PAIR_ONLY_SENTENCE: string` from `.storybook/fake/world.ts`.

- [ ] **Step 1: Write the failing world test**

In `.storybook/fake/world.test.ts`, change the import on line 16 to `import { PAIR_ONLY_SENTENCE, installWorld } from "./world";`, and add after the `lentStorage` test:

```ts
  /**
   * `pairOnly` is the other fault about the *host*: the light app's Tauri host — the build
   * Google Play distributes — answers `membership_elsewhere` with a sentence of its own, and a
   * desktop, which is what a story is unless it says otherwise, refuses the name. The sentence
   * is read out of that host's Rust source, so a story draws what a phone draws.
   */
  it("makes a world the Play build's for `pairOnly`, and leaves the next one a desktop", async () => {
    installWorld({ fault: "pairOnly" });
    await expect(invoke("membership_elsewhere")).resolves.toBe(PAIR_ONLY_SENTENCE);
    expect(PAIR_ONLY_SENTENCE).toMatch(/paired with one that already syncs/);
    expect(PAIR_ONLY_SENTENCE).not.toMatch(/patreon|membership|supporter|payment/i);

    installWorld({ seed: "starter" });
    await expect(invoke("membership_elsewhere")).rejects.toThrow(/No fake handler registered/);
  });
```

`{ seed: "starter" }` is how this file's other tests install a world with no fault.

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run .storybook/fake/world.test.ts -t "pairOnly"`

Expected: FAIL — `PAIR_ONLY_SENTENCE` is not exported by `./world`.

- [ ] **Step 3: Write `src/lib/core/hostMembership.ts`**

```ts
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
```

- [ ] **Step 4: The fault, in the fake**

In `.storybook/fake/db.ts`, add to the `Fault` union after `| "lentStorage"`:

```ts
  | "lentStorage"
  | "pairOnly";
```

(moving the semicolon), and add to the doc comment above the union, after the `lentStorage` paragraph:

```ts
 * **`pairOnly`** is the second entry about the host, and `lentStorage`'s shape exactly: the
 * light app's Tauri host — the build Google Play distributes — answers `membership_elsewhere`
 * (`src/lib/core/hostMembership.ts`) with one sentence saying how sync turns on there, where
 * every other host refuses the name; and the Sync panel draws that sentence in place of its
 * membership half. `world.ts` puts the handler over the one world's table.
```

In `.storybook/fake/world.ts`, add the imports beside the `hostStorage` ones:

```ts
import { MEMBERSHIP_ELSEWHERE } from "@/lib/core/hostMembership";
import lightMembership from "../../mobile/src-tauri/src/membership.rs?raw";
```

Add, above `installWorld` (module scope):

```ts
/**
 * What the light app's Tauri host answers `membership_elsewhere` with — **read out of that
 * host's own source**, not copied here, so a `pairOnly` story draws the sentence a phone draws.
 * `membership.rs` keeps the literal on one line for this; a literal this cannot find is a
 * thrown error at import, never an empty sentence a story would draw as nothing.
 */
export const PAIR_ONLY_SENTENCE: string = (() => {
  const found = /pub const SENTENCE: &str =\s*"([^"\\]+)";/.exec(lightMembership)?.[1];
  if (found === undefined) {
    throw new Error("mobile/src-tauri/src/membership.rs holds no one-line SENTENCE literal");
  }
  return found;
})();
```

And directly after the `lentStorage` block inside `installWorld`:

```ts
  // The other fault about the host: the build Google Play distributes, which answers a name
  // every other host refuses — in that host's own words (`PAIR_ONLY_SENTENCE`, above). Over
  // the world's table and not in `allHandlers`, for `lentStorage`'s reason.
  if (db.fault === "pairOnly") {
    scope.commands = { ...scope.commands, [MEMBERSHIP_ELSEWHERE]: () => PAIR_ONLY_SENTENCE };
  }
```

- [ ] **Step 5: Run the world test and see it pass**

Run: `npx vitest run .storybook/fake/world.test.ts`

Expected: PASS, the new test and every existing one.

---

### Task 3: The Sync panel draws the host's sentence

**Files:**
- Modify: `src/features/settings/SyncPanelBody.tsx` (imports; `relayNote` ~442; `outcomeText` ~537; `SupporterSection` ~785–1046)
- Modify: `src/features/settings/SyncPanel.test.tsx` (a new `describe` at the end; two pure-function cases)
- Modify: `src/features/settings/SyncPanel.stories.tsx` (one story)

**Interfaces:**
- Consumes: `MEMBERSHIP_ELSEWHERE` (Task 2); the fake's `pairOnly` fault and `PAIR_ONLY_SENTENCE` (Task 2).
- Produces:
  - `relayNote(state: RelayState, status: RelayStatus | null, now: number, hosted = false): string | null`;
  - `outcomeText(outcome: RelayOutcome | null, hosted = false): string`.
  - `hosted` means *a host answered `membership_elsewhere`*. It is the only thing the page knows.

- [ ] **Step 1: Write the failing tests**

In `src/features/settings/SyncPanel.test.tsx`, append at the end of the file:

```tsx
/**
 * **A host that offers no membership of its own** — the build Google Play distributes, though
 * the panel is never told that. It asks `membership_elsewhere`; a host that answers hands back
 * a sentence saying how sync turns on there, and the panel draws it where the offer, the
 * membership's status and the claim code would be. Every other host refuses the name, and
 * every test above this block is one of those.
 *
 * **The words are the host's.** Each test hands the panel a sentence no host ships, so a panel
 * that kept a wording of its own fails on the text.
 */
describe("on a host that offers no membership of its own", () => {
  const SAID = "Sync begins here once this device has joined a group that already has it.";
  /** Everything Play's rule is about. None of it may be on the page on such a host. */
  const PAID = /patreon|membership|supporter|supporting|payment|pledge|subscri/i;

  /** A host that answers `membership_elsewhere` with `answer`, and refuses every other name. */
  const host = (answer: unknown) =>
    hostInvoke.mockImplementation((command: string) =>
      command === "membership_elsewhere"
        ? Promise.resolve(answer)
        : Promise.reject(`Command ${command} not found`),
    );
  /** Long enough for an answer already given to have reached the screen — see `drawn` above. */
  const drawn = () => act(() => new Promise<void>((settled) => setTimeout(settled, 50)));

  it("draws the host's sentence where the offer would be, and nothing about a membership", async () => {
    host(SAID);
    render(<SyncPanel />, { wrapper: unpaired });

    const said = await screen.findByText(SAID);
    expect(said.tagName).toBe("P");
    expect(said).not.toHaveAttribute("role");
    await drawn();
    expect(screen.queryByRole("button", { name: /connect patreon/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/claim code/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Membership" })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(PAID);
    // And it never asked the engine for Patreon's address.
    expect(syncPatreonBegin).not.toHaveBeenCalled();
  });

  it("still says the relay needs no account, and that sync is off", async () => {
    host(SAID);
    render(<SyncPanel />, { wrapper: unpaired });
    await screen.findByText(SAID);
    expect(screen.getByRole("heading", { name: "Relay" })).toBeInTheDocument();
    expect(screen.getByText(/end-to-end encrypted relay server that requires no account/i)).toBeInTheDocument();
    expect(screen.getByText("Sync is off. Nothing leaves this device.")).toBeInTheDocument();
  });

  it("says nothing more once the group has sync, and keeps Sync now", async () => {
    host(SAID);
    syncSupporterStatus.mockResolvedValue(SUPPORTING);
    syncRelayStatus.mockResolvedValue(RELAY_ON);
    render(<SyncPanel />, { wrapper: paired });

    expect(await screen.findByRole("button", { name: /sync now/i })).toBeInTheDocument();
    await drawn();
    // How to turn sync on is no news to a device that has it.
    expect(screen.queryByText(SAID)).not.toBeInTheDocument();
    expect(screen.getByText(/4 changes pending/i)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(PAID);
  });

  it("reports a trip that had nothing to do without naming a membership", async () => {
    const user = userEvent.setup();
    host(SAID);
    syncRelayStatus.mockResolvedValue(RELAY_ON);
    syncNow.mockResolvedValue(null);
    render(<SyncPanel />, { wrapper: paired });

    await user.click(await screen.findByRole("button", { name: /sync now/i }));
    expect(await screen.findByText("Nothing to sync. Pair this device first.")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(PAID);
  });

  /**
   * The gap before the host has spoken. A *Connect Patreon* drawn in it is one a phone shows on
   * every visit to Settings, for as long as its first call takes.
   */
  it("draws nothing of the offer before the host has answered", async () => {
    hostInvoke.mockImplementation((command: string) =>
      command === "membership_elsewhere"
        ? new Promise(() => {})
        : Promise.reject(`Command ${command} not found`),
    );
    render(<SyncPanel />, { wrapper: unpaired });

    // The pairing half is the engine's and draws at once; wait for it, then look.
    await screen.findByRole("button", { name: /pair a device/i });
    await drawn();
    expect(screen.queryByRole("button", { name: /connect patreon/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Membership" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Relay" })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(PAID);
  });

  /** A host that answers the name with something that is not a sentence has said nothing. */
  it.each([null, "", "   ", 0, {}])("reads an answer that is not a sentence (%j) as a refusal", async (answer) => {
    host(answer);
    render(<SyncPanel />, { wrapper: unpaired });
    expect(await screen.findByRole("button", { name: /connect patreon/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Membership" })).toBeInTheDocument();
  });

  it("asks the host once, however often the panel draws", async () => {
    host(SAID);
    const { rerender } = render(<SyncPanel />, { wrapper: unpaired });
    await screen.findByText(SAID);
    rerender(<SyncPanel />);
    await drawn();
    expect(
      hostInvoke.mock.calls.filter(([command]) => command === "membership_elsewhere"),
    ).toHaveLength(1);
  });
});

describe("the two sentences that name a membership, on a host that offers none", () => {
  it("says sync is off without saying how to pay for it", () => {
    expect(relayNote("off", null, 0)).toBe(
      "Sync is off. Nothing leaves this device until you connect a membership.",
    );
    expect(relayNote("off", null, 0, true)).toBe("Sync is off. Nothing leaves this device.");
    // Every other state says the same thing on every host.
    for (const state of ["unknown", "syncing", "failed", "unpaired", "never", "synced"] as const) {
      expect(relayNote(state, RELAY_ON, 1_700_000_100, true)).toBe(
        relayNote(state, RELAY_ON, 1_700_000_100),
      );
    }
  });

  it("says a trip had nothing to do without telling the reader to connect", () => {
    expect(outcomeText(null)).toBe("Nothing to sync. Connect a membership and pair a device first.");
    expect(outcomeText(null, true)).toBe("Nothing to sync. Pair this device first.");
    expect(outcomeText(OUTCOME, true)).toBe(outcomeText(OUTCOME));
  });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run src/features/settings/SyncPanel.test.tsx -t "membership"`

Expected: FAIL — the first block finds *Connect Patreon* drawn on a host that answered (the panel does not ask yet), and the second finds `relayNote(…, true)` returning the membership sentence.

- [ ] **Step 3: The two sentence functions**

In `src/features/settings/SyncPanelBody.tsx`, change `relayNote`'s signature and its `off` arm:

```tsx
export function relayNote(
  state: RelayState,
  status: RelayStatus | null,
  now: number,
  hosted = false,
): string | null {
  const at = status?.lastSyncAt ?? null;
  switch (state) {
    case "unknown":
    case "syncing":
      return null;
    case "off":
      // On a host that offers no membership (`hosted`), how sync turns on is that host's
      // sentence to say, and it is drawn above this one. Here it is only off.
      return hosted
        ? "Sync is off. Nothing leaves this device."
        : "Sync is off. Nothing leaves this device until you connect a membership.";
```

(the remaining arms are unchanged), and add to its doc comment's `@param` list:

```tsx
 * @param hosted whether the host answered `membership_elsewhere` — see {@link MEMBERSHIP_ELSEWHERE}.
 * Only `off` differs: it is the one state whose sentence tells a reader what to connect.
```

Change `outcomeText`'s signature and its first branch:

```tsx
export function outcomeText(outcome: RelayOutcome | null, hosted = false): string {
  if (outcome === null) {
    return hosted
      ? "Nothing to sync. Pair this device first."
      : "Nothing to sync. Connect a membership and pair a device first.";
  }
```

- [ ] **Step 4: Ask the host**

In `src/features/settings/SyncPanelBody.tsx`, add the import beside `hostStorage`'s:

```tsx
import { MEMBERSHIP_ELSEWHERE } from "@/lib/core/hostMembership";
```

and, directly after `askStorageWarning`:

```tsx
/**
 * Whether the host offers a membership itself, asked the way {@link askStorageWarning} asks:
 * outside the `["sync"]` root, because no round trip and no pairing changes a host's answer.
 */
const MEMBERSHIP_ELSEWHERE_KEY: QueryKey = ["host", "membership", "elsewhere"];

/**
 * Ask the host, once, how sync is turned on where it offers no membership.
 *
 * A sentence, or `null`: the desktop app and the web host have no such command and refuse the
 * name, and that refusal — silent, for {@link askStorageWarning}'s reasons — is the answer on
 * every host that draws this panel's membership half as it always was. An answer that is not a
 * sentence is a refusal too: {@link sentence}.
 */
const askMembershipElsewhere = (): Promise<string | null> =>
  core.call<unknown>(MEMBERSHIP_ELSEWHERE).then(sentence, () => null);
```

- [ ] **Step 5: Draw it**

In `SupporterSection`, add after the `supporterRead` query and `membership` line:

```tsx
  const elsewhereRead = useQuery({
    queryKey: MEMBERSHIP_ELSEWHERE_KEY,
    queryFn: askMembershipElsewhere,
    staleTime: Infinity,
  });
  /**
   * `undefined` until the host has answered or refused; `null` on a host that offers a
   * membership itself; a sentence on one that does not.
   */
  const elsewhere = elsewhereRead.data;
  /** A host answered: this panel says nothing about a membership, and draws its sentence. */
  const hosted = typeof elsewhere === "string";
```

Change the `note` line to pass it:

```tsx
  const note = relayNote(state, status, nowSeconds(), hosted);
```

Replace the start of the component's `return` — from `return (` through the end of the `{supporter === null ? ( … ) : ( … )}` expression (the block that ends just before the comment `**An unanswered relay read is not "nothing is waiting".**`) — with:

```tsx
  // **Nothing of this half until the host has said which kind it is.** The question is one
  // rejected promise on a desktop and one answered call on a phone, and either takes a moment:
  // drawn before it settles, the heading and the Connect Patreon press below would flash on a
  // host that must never show them. An empty box, so the rule above it holds its place.
  if (elsewhere === undefined) {
    return <div className="border-t border-border pt-4" />;
  }

  return (
    <div className="space-y-3 border-t border-border pt-4">
      <h3 className="font-heading text-sm leading-none">{hosted ? "Relay" : "Membership"}</h3>

      <p className="text-sm text-dim">
        Your devices sync through an end-to-end encrypted relay server that requires no account.
        {hosted ? null : " Relay hosting is funded by supporters on Patreon."}
      </p>

      {hosted ? (
        // **The host's sentence, and none of this panel's.** It says how sync turns on where
        // nothing is offered, so it is drawn only while sync is not on: to a device whose group
        // has it, it is an answer to a question nobody has. No status line, no offer, no claim
        // code — and no "loading membership", which would name the thing this host never does.
        supporter === null ? (
          supporterRead.isError ? (
            <p className="text-sm text-dim">Couldn't load whether sync is on.</p>
          ) : null
        ) : on ? null : (
          <p className="text-sm">{elsewhere}</p>
        )
      ) : supporter === null ? (
        <p className="text-sm text-dim">
          {supporterRead.isError ? "Couldn't load your membership." : "Loading membership…"}
        </p>
      ) : (
        <div className="space-y-3">
          <p className="text-sm">{supporterNote(membership, supporter)}</p>

          {membership === "ended" && <p className="text-sm text-dim">{LAPSE_REASSURANCE}</p>}

          {offering && (
            /* …the existing offering block, from <div className="space-y-3"> to its closing
               </div>, moved here unchanged: CONNECT_ORDER, the Connect Patreon button, the
               re-claim warning, the claim-code label, field and Connect button… */
          )}
        </div>
      )}
```

**"Moved here unchanged" is literal**: cut the existing `{offering && ( … )}` JSX, comments included, and paste it where the placeholder comment stands. Do not retype it. The existing comment above `{supporter === null ? (` (`**No controls at all while the read is unanswered**…`) stays above the `supporter === null ?` arm of the non-hosted branch.

Change the outcome alert to pass `hosted`:

```tsx
      <PanelAlert tone="plain">
        {outcome === undefined || syncing ? null : outcomeText(outcome, hosted)}
      </PanelAlert>
```

Add to `SupporterSection`'s doc comment, as its last paragraph:

```tsx
 * **On a host that offers no membership, none of the above is drawn** — it asks
 * {@link MEMBERSHIP_ELSEWHERE}, and a host that answers hands back the one sentence that
 * stands in for the offer, the status line and the claim code. The figures, the socket's line
 * and Sync now stay: they say whether sync works, and none of them names a payment. The panel
 * does not know which host that is; it knows a sentence, or a refusal.
```

- [ ] **Step 6: Run the panel's tests**

Run: `npx vitest run src/features/settings/SyncPanel.test.tsx`

Expected: PASS, the new tests and every existing one.

If an **existing** test fails, it will be one that looked for the membership half with a synchronous `getBy…` straight after `render`: that half now waits one settled promise for the host's refusal. Change that query to `await screen.findBy…`. Do not change what the test asserts, and do not make the panel draw before the host has answered.

- [ ] **Step 7: A story, so the panel can be seen**

In `src/features/settings/SyncPanel.stories.tsx`, add the import beside the fake's other one (`import { PAIR_ONLY_SENTENCE } from "../../../.storybook/fake/world";`), and add after `NotPairedInABrowser`:

```tsx
/**
 * **A host that offers no membership** — the light app's Tauri host, which Google Play
 * distributes, though the panel is never told so. The `pairOnly` fault makes this story's host
 * answer `membership_elsewhere` in that host's own words, read from its Rust source; the panel
 * draws the sentence where the offer, the membership's status and the claim code would be.
 * Every other story in this file is a host that refuses the name.
 *
 * Drive it at a phone's width with `npm run mobile:dev` at
 * `http://localhost:5175/settings?fault=pairOnly`.
 */
export const OnAHostThatOffersNoMembership: Story = {
  parameters: { fake: { fault: "pairOnly" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(await canvas.findByText(PAIR_ONLY_SENTENCE)).toBeInTheDocument();
    await expect(canvas.getByRole("heading", { name: "Relay" })).toBeInTheDocument();
    await expect(canvas.queryByRole("button", { name: /connect patreon/i })).not.toBeInTheDocument();
    await expect(canvas.queryByLabelText(/claim code/i)).not.toBeInTheDocument();
    await expect(canvasElement).not.toHaveTextContent(/patreon|membership|supporter|payment/i);
    // Pairing is the way in, and it is still offered.
    await expect(canvas.getByRole("button", { name: /pair a device/i })).toBeInTheDocument();
  },
};
```

- [ ] **Step 8: Run the stories' own suite for this file**

Run: `npx vitest run src/stories.test.tsx -t "SyncPanel"`

Expected: PASS, with a non-zero count of tests run. `-t` here matches the file path, so `SyncPanel` selects this file's stories; a filter that matches nothing exits 0 having run nothing — check the count. If the repo's story runner is at another path, `git ls-files '*stories.test.tsx'` names it.

---

### Task 4: The fences, the documents, and the live pass

**Files:**
- Modify: `mobile/host.test.ts`
- Modify: `mobile/CLAUDE.md` (§2, the *Platform abstraction below `@/lib/core`* list; §5, the Android host)
- Modify: `docs/reference/light-app.md` (append a section)

- [ ] **Step 1: Hold the host's routing, and the sentence it rewords, in `mobile/host.test.ts`**

Add the imports beside the other `?raw` ones:

```ts
import lightMembership from "./src-tauri/src/membership.rs?raw";
import coreSyncClient from "../crates/grimoire-core/src/sync_engine/client.rs?raw";
import { MEMBERSHIP_ELSEWHERE } from "@/lib/core/hostMembership";
```

Append a `describe`:

```ts
/**
 * **The build Google Play distributes offers no membership** (2026-10-07). Play forbids an app
 * to lead a reader to a payment made elsewhere, so this host answers one name with a sentence
 * of its own, refuses the two commands that connect a membership, and rewords the core's
 * sentences that tell a reader to. Each of the three is a thing a careless edit can drop, and
 * a dropped one is a policy strike found by a reviewer and not by a test.
 */
describe("the light host offers no membership", () => {
  const literal = (name: string) =>
    new RegExp(`pub const ${name}: &str =\\s*"([^"\\\\]+)";`).exec(lightMembership)?.[1];

  it("answers the name the page asks by", () => {
    expect(literal("ELSEWHERE")).toBe(MEMBERSHIP_ELSEWHERE);
    // One line, which is how the Storybook fake reads it.
    expect(literal("SENTENCE")).toMatch(/paired/);
  });

  it("is asked before the core's table, and rewords what the table refuses", () => {
    const call = lightLib.slice(lightLib.indexOf("async fn core_call("));
    const body = call.slice(0, call.indexOf("\n}\n"));
    expect(body).toContain("if membership::answers(&name) {");
    expect(body).toContain("return membership::answer(&name);");
    expect(body.indexOf("membership::answers")).toBeLessThan(body.indexOf("grimoire_core::dispatch"));
    expect(body).toMatch(
      /grimoire_core::dispatch\([\s\S]*?\)\s*\.await\s*\.map_err\(membership::reword\)/,
    );
  });

  it("refuses both halves of connecting", () => {
    expect(lightMembership).toContain('const BEGIN: &str = "sync_patreon_begin";');
    expect(lightMembership).toContain('const CLAIM: &str = "sync_patreon_claim";');
    expect(lightMembership).toMatch(/name == ELSEWHERE \|\| name == BEGIN \|\| name == CLAIM/);
  });

  it("rewords the sentences the core still writes for a lapse and for a key it does not know", () => {
    // The host matches the core's words by value. Were the core's reworded, the host would
    // stop matching and a phone would read the membership sentence again.
    const tail = literal("LAPSED_TAIL");
    expect(tail).toBe("; the membership has ended");
    expect(coreSyncClient).toContain(`the relay answered 401 to {what}${tail}`);
    // The key check's 401 has no const in the core: the host matches its opening words, and
    // the sentence that follows them there still tells a reader to reconnect Patreon.
    const head = literal("KEY_CHECK_HEAD");
    expect(head).toBe("the relay did not recognise this device's group key.");
    expect(coreSyncClient).toContain(`"${head} If your devices synced \\`);
    expect(lightMembership).toContain("if error.starts_with(KEY_CHECK_HEAD) {");
  });

  it("says nothing a reader could pay for, in any sentence of its own", () => {
    const own = [...lightMembership.matchAll(/^(?:pub )?const [A-Z_]+: &str =\s*"([^"\\]+)";/gm)]
      .map((m) => m[1])
      // Three literals are names and matches, not sentences a reader is shown: the command
      // this host answers, the two it refuses, and the core's words it looks for.
      .filter(
        (text) =>
          text !== MEMBERSHIP_ELSEWHERE &&
          !text.startsWith("sync_patreon_") &&
          text !== "; the membership has ended",
      );
    // What is left: SENTENCE, NOT_OFFERED, LAPSED_HERE, NO_SYNC_YET, KEY_CHECK_HEAD and
    // KEY_CHECK_HERE.
    expect(own).toHaveLength(6);
    for (const text of own) {
      expect(text, text).not.toMatch(/patreon|membership|supporter|supporting|payment|pledge|subscri|price/i);
    }
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run mobile/host.test.ts mobile/phone/fence.test.ts`

Expected: PASS. `fence.test.ts` passes untouched: nothing under `mobile/` reads a platform. If `is asked before the core's table` fails on the last regex, `cargo fmt` laid the call out differently — read `core_call` and fit the expression to what rustfmt wrote, keeping the three things it holds (`dispatch`, `.await`, `.map_err(membership::reword)`).

- [ ] **Step 3: `mobile/CLAUDE.md`**

In §2, under **Platform abstraction below `@/lib/core`**, add after the *Storage the host does not own* bullet:

```markdown
  - A membership the host does not offer: `@/lib/core/hostMembership`. The Sync panel asks `membership_elsewhere` and, handed a sentence, draws it in place of everything about a membership — the offer, the status line, the claim code. Only the light Tauri host answers (it is the build Google Play distributes, and Play forbids leading a reader to a payment made elsewhere); every other host refuses the name. Never word that sentence on the page, and never add a string under the panel that names Patreon, a membership or a payment without asking what a host that answered should say instead.
```

In §5, **Android Host**, add after the *Metered network check* bullet:

```markdown
- Pair-only for sync (`src-tauri/src/membership.rs`): answers `membership_elsewhere` with its own sentence, refuses `sync_patreon_begin` and `sync_patreon_claim` before the core's table, and rewords four of the core's sentences on their way out of `core_call` (`host.test.ts` holds all of it). A phone gets sync by pairing into a group that has it.
```

- [ ] **Step 4: `docs/reference/light-app.md`**

Append at the end of the file:

```markdown
## 11. Google Play — the host offers no membership (2026-10-07)

The Android host is published on Google Play
(`docs/superpowers/specs/2026-10-07-google-play-release-design.md`). Play's Payments policy
requires its own billing for anything an app sells, and forbids an app to lead a reader to a
payment made elsewhere — "buttons, links, messaging... or other calls to action" — except
through programs that need enrolment and reporting. It allows an app to use what was paid for
somewhere else. Sync is paid for on Patreon, and a membership belongs to a group, so the owner
chose **pair-only**: the Play build offers nothing, and a phone gets sync by being paired into
a group that already has it.

- **One name, answered by one host.** The Sync panel asks `membership_elsewhere`
  (`src/lib/core/hostMembership.ts`). The light Tauri host answers a sentence of its own
  (`mobile/src-tauri/src/membership.rs`); the desktop app and the web host have no such command
  and draw what they always have. On a host that answered, the panel's second half is headed
  *Relay*, keeps the sentence about the relay needing no account, draws the host's sentence
  while sync is not on, and keeps the figures, the socket's line and *Sync now*. It draws no
  status line, no offer and no claim code, and nothing at all until the host has answered or
  refused.
- **Two refusals.** `sync_patreon_begin` and `sync_patreon_claim` are refused in `core_call`
  before the table is reached.
- **Four sentences reworded.** The relay's device cap (`entitlement::GROUP_IS_FULL`) reads as
  the pairing ceremony's own (`identity::GROUP_IS_FULL`); a removal with nothing to carry it
  (`identity::NO_MEMBERSHIP`) loses "Connect a membership first."; a 401's "the membership
  has ended" becomes "sync is no longer on for this group"; and the key check's 401, which
  tells a reader to "reconnect Patreon once", says instead that sync has to be set up again on
  the device it was turned on from. That fourth one is a literal inside a function in the core
  and not a constant, so the host matches its opening words and `mobile/host.test.ts` holds
  those words to the core's source. The refusals of the two connecting commands carry no
  command name, because the name itself says Patreon. The core's wording is unchanged for the
  other two hosts.
- **What a phone-only member does.** Opens `https://mtg-grimoire.app` in the phone's browser,
  connects there, and pairs the app with it by the typed code. That costs one of the group's
  five places.
- **What is left, knowingly.** Two of those sentences are also written to `error_log` by the
  core as they happen — the relay's device cap ("This membership already covers five
  devices…") by the live-sync loop, and the key check's 401 ("…reconnect Patreon once…") by
  the sync client — and Settings → Errors draws each row as written. They are rows of data and
  not errors from a call, so the host's rewording does not reach them; neither offers anything
  to press, and both are faults a reader meets rarely. Rewording them means the core writing a
  host-neutral sentence, which is its own change. The settings search still
  matches the words `patreon`, `supporter` and `membership` on the desktop face, and displays
  none of them. The collection's Share button on the desktop face is drawn for a device whose
  group is entitled and calls a command no light host has — on the web app too — and is its
  own change.
- **Not measured here:** the panel on a phone. `mobile:dev` at a phone's width over the fake,
  and `mobile:tauri` over the real host, are what was driven.
```

If the file's last numbered section is not 10, number this one after it.

- [ ] **Step 5: See it, at a phone's width and a tablet's**

Follow the `running-the-app` skill for locks. Then:

1. `npm run mobile:dev`, open `http://localhost:5175/settings?fault=pairOnly` at 360px wide, open the Sync group. Confirm: heading *Relay*; the host's sentence; no *Connect Patreon*, no claim-code field; "Sync is off. Nothing leaves this device."
2. The same address at 1280px wide (the desktop face). Confirm the same panel.
3. `http://localhost:5175/settings` with no fault, at 360px. Confirm the membership half is exactly as before: *Membership*, *Connect Patreon*, the claim-code field.
4. `npm run mobile:tauri` (takes the app lock; warn the owner first — a bare debug window alarms). Open Settings → Sync. Confirm the real host's sentence is drawn. This is the only step that runs `membership.rs` under a page.

Record what each showed in the pull request's description. A unit test cannot see a flash; step 1 is where to watch for *Connect Patreon* appearing for a frame on load — reload five times and watch.

---

### Task 5: Verify and commit

- [ ] **Step 1: Sweep for a string that slipped in**

Run: `git diff --name-only main... | xargs grep -n -i "patreon\|membership" -- 2>/dev/null | grep -v "^docs/\|\.test\.\|\.stories\.\|membership\.rs\|hostMembership\.ts\|CLAUDE\.md"`

Expected: only lines in `SyncPanelBody.tsx` that were there before this change or are inside its non-hosted branch and doc comments, and `.storybook/fake` comments. Any *new user-visible* string naming either word outside the non-hosted branch is a defect.

- [ ] **Step 2: Run the whole gate, once**

Run: `npm run verify`

Expected: exit 0. `cargo fmt --check` is part of it: if `membership.rs` is reformatted, check that `SENTENCE` and `LAPSED_TAIL` are still each one string literal (rustfmt does not break a literal, but it may move it to the line after `=` — the readers allow that).

- [ ] **Step 3: Commit**

```bash
git add -A mobile/src-tauri/src/membership.rs mobile/src-tauri/src/lib.rs mobile/src-tauri/capabilities/light.json src/lib/core/hostMembership.ts src/features/settings/SyncPanelBody.tsx src/features/settings/SyncPanel.test.tsx src/features/settings/SyncPanel.stories.tsx .storybook/fake/db.ts .storybook/fake/world.ts .storybook/fake/world.test.ts mobile/host.test.ts mobile/CLAUDE.md docs/reference/light-app.md docs/superpowers/plans/2026-10-07-google-play-b-pair-only-sync.md
git commit -m "$(cat <<'EOF'
feat(android): turn sync on by pairing only, on the build Play distributes

Google Play forbids an app to lead a reader to a payment made elsewhere.
The light Tauri host now answers membership_elsewhere with a sentence of
its own, and the Sync panel draws that in place of the membership offer,
its status line and the claim code. The host also refuses the two commands
that connect a membership and rewords three core sentences that tell a
reader to.

The desktop app and the web app refuse the name and are unchanged.

Refs #761

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

## What changed in execution (2026-10-07)

The plan above is as it was written. These are the decisions made while it was carried out —
each one where the code now differs from a task's text, or where something found in review was
fixed or knowingly left. Where the two disagree, the code and this list are right.

- tasks make WIP commits and the controller squashes the branch into the plan's one conventional commit before the PR — the review loop needs a commit range per task and the repo wants one commit per feature — costs a soft reset on a private branch if wrong.
- the controller runs `npm run verify`, one worktree at a time, with one shared CARGO_TARGET_DIR (D:\Code\mtg-grimoire\.claude\worktrees\gp-target); no implementer runs verify — two verifies at once fake Rust failures (memory) — costs a late finding if a task's own focused tests missed something.
- the plan's final commit step is the controller's (the squash); the last task's implementer does the sweep and the documents only.
- merge order is A, then B, then C; B and C merge main and resolve the shared files (mobile/host.test.ts, mobile/CLAUDE.md, docs/reference/light-app.md) when their turn comes — costs a small manual merge.
- Task 4 Step 5's live pass is run by the controller after Task 4, over mobile:dev, serialized with plan C on port 5175; its mobile:tauri step is not run — it opens a debug window on the owner's screen and takes the app lock — costs: the real host's sentence is unseen under a page until the first internal-test install; reported as not done.
- Task 4's host.test regex for the dispatch call was "dispatch\([^)]*\)", which cannot match a call whose arguments hold a parenthesis (args.unwrap_or(Value::Null)); the plan and brief now use a lazy any-character match — a plan defect found in this scan — costs nothing if wrong, the test fails loudly.
- **Task 1.** the refusal for sync_patreon_begin/claim carries no command name — the plan's "{name}: ..." put "patreon" in a string a reader could see, against the spec's "no Patreon wording"; NOT_OFFERED becomes a whole sentence — costs: this host's refusals are not uniformly prefixed.
- **Task 1.** reword gains a fourth arm for the key check's 401 sentence (client.rs ~956: "reconnect Patreon once ... no membership connected"), matched by its opening words (KEY_CHECK_HEAD) because the core has no const for it; Task 4's fence holds the head to the core's source and its sentence count goes from 4 to 6; the error_log copy of this sentence joins the documented residue — costs: a core rewording of that sentence's opening silently stops the match until the fence goes red.
- **Task 3.** both existing tests find the storage question's result by the command's name (a helper, `answered`), not by position — the assertion's meaning is unchanged and the sibling stops being vacuous; this is the one kind of existing-test change beyond the brief's findBy rule — costs nothing if wrong beyond a review finding.
- **Task 4.** the plan's light-app.md bullet "are what was driven" is replaced with what is true — no window has been driven yet; three looks are owed — the plan wrote the sentence before the pass it describes — costs nothing; updated again after the controller's live look.
- **Task 4.** three Minors join the round (assert the refusal expression and tie the two command names to the core's table; make the sentence census fail on a constant its regex cannot read; one comment clause) — each closes a way a fence could pass silently — costs a slightly wider re-review.
- the host rewords the rows error_log_list answers, the same way as errors — the spec's sweep rule has no "left" category, and the fix needs no core edit — costs: a second place the host touches an answer, covered by its own tests and a fence.
- reword matches the three by-value sentences anywhere in an error and gains a catch-all for sync commands only (any remaining patreon/membership/supporter/pledge/subscri- wording becomes one plain sentence) — scoped to sync_* commands and sync rows so a user's own deck or folder name is never eaten — costs: an unknown future sync error is shown as a vague sentence on this host rather than leaking the words.
- the hosted "nothing to do" sentence becomes "Nothing to sync. Sync is not on for this device." and the key-check rewrite regains its first cause.
- the tests and fences of Important 4 (a-c) are added; the census of core literals as a test is not — the catch-all makes it a nicety.
- deferred minors — fixed in the wave: the NO_MEMBERSHIP test compares the whole sentence; "asks the host once" is made to bite; the command tie becomes an allow-list over the registrations; the story's and the fake test's word lists are completed; four untrue sentences corrected. Left: reword replacing every occurrence of the lapsed tail (the safe direction); the shared `it` in world.test; the empty box's growth (to be looked at on a phone); the comment's layout; the pairing half's other states held by reading.
- **left as it is.** world.ts computes PAIR_ONLY_SENTENCE at module scope and throws if the Rust literal cannot be read — it would redden every story, not one; caught in CI either way (mobile/src-tauri/* routes to frontend) — left.
- **left as it is.** scripts/ci-route.mjs does not route mobile/src-tauri/* to the storybook job though Storybook now bundles a file from there — no red is missed today — left, noted for the owner.
- **left as it is.** the fake's Fault is single-valued, so pairOnly cannot be combined with a lapsed or entitled membership in a story — the hosted states are held by unit tests instead.
- two of those are closed by the controller before the gate, as one-line edits — settled() waits for the heading "Relay", and the bullet's lead is renamed — the first is the plan's main guarantee asserting over nothing; SyncPanel.test.tsx 119 passing after it — costs: two lines no reviewer read, which the gate runs.
- **left as it is.** the command tie matches names holding patreon/supporter/membership/claim; a connecting command named for a pledge, a plan or a checkout would pass it — costs: such a command would reach a Play build unrefused until someone reads the core's table.
- **left as it is.** a sync error or relay row quoting a device the reader named "Patreon phone" is replaced by the plain sentence — the ruled direction (hide rather than leak) — costs: one vaguer error for that reader.
- **left as it is.** KEY_CHECK_HEAD drops whatever follows it — the core wraps by prefix only today — costs: a future suffix would be lost silently on this host.
- shard 1 is taken as green on that file passing alone three times running (13/13 each) and the gate resumes from vitest-2, not from vitest-1 — the repo's own practice under a fleet is to rerun the failed files — costs: shard 1 was never green in one piece on this head; CI's frontend job is. Resumed (pid 51628).
