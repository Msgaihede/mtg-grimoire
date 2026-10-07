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
//! - **Four of the core's sentences are reworded on their way out** ([`reword`]), wherever they
//!   stand in an error — the core wraps them — and again in the rows Settings → Errors reads
//!   ([`reword_rows`]), because the core *writes* them to `error_log` as they happen. They are
//!   written for a reader who can connect a membership, and say so. Here they say what is true
//!   of the group instead. A sync error that still names a membership after that is replaced
//!   whole by [`UNSAID`]. The core's wording is the desktop's and the web app's and is not
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
pub const SENTENCE: &str =
    "Sync turns on for this device when it is paired with one that already syncs.";

/// The two commands that begin and finish connecting a membership.
const BEGIN: &str = "sync_patreon_begin";
const CLAIM: &str = "sync_patreon_claim";

/// What either of them is answered with here — the whole refusal, with no command name in it:
/// both names say "patreon", and a reader is shown this string as it stands.
pub const NOT_OFFERED: &str = "This app turns sync on by pairing, not by connecting.";

/// What the core says once the relay has answered 401: `sync_engine::client`'s `lapsed`. One
/// line: `mobile/host.test.ts` holds this literal to the core's own source.
pub const LAPSED_TAIL: &str = "; the membership has ended";

/// The same news, about the group.
const LAPSED_HERE: &str = "; sync is no longer on for this group";

/// `identity::NO_MEMBERSHIP`, without its last sentence's instruction.
const NO_SYNC_YET: &str = "Removing a device changes the key your devices share, and that change has to reach the others through the relay. Sync is not on for this group yet.";

/// The opening of what the core says when the relay's key check answers 401
/// (`sync_engine::client`, the key check's 401 arm). The core writes that sentence as a literal
/// inside a function, not a const, so it is matched by its first words. One line: a test holds
/// this literal to the core's own source.
pub const KEY_CHECK_HEAD: &str = "the relay did not recognise this device's group key.";

/// The same news, without the instruction to connect a membership. The commonest cause on this
/// host is that the group never had sync, so it comes first.
const KEY_CHECK_HERE: &str = "the relay did not recognise this device's group key. Sync is not on for this group yet, or it has to be set up again on the device it was turned on from, or this device has been offline across more key changes than the relay keeps.";

/// What a sync error is replaced by when, after every rewording above, it still names a
/// membership: the one sentence that is true of any of them and tells a reader to pay for none.
pub const UNSAID: &str = "Sync could not do that for this group.";

/// The core command Settings → Errors reads its rows with (`commands.rs`, `read error_log_list`).
/// The core writes the key check's 401 sentence into that log as it happens, so [`reword_rows`]
/// rewords what this command answers. One line: `mobile/host.test.ts` holds it to the core's table.
pub const ERROR_LOG: &str = "error_log_list";

/// Whether `name` is one of the three commands this module answers.
pub fn answers(name: &str) -> bool {
    name == ELSEWHERE || name == BEGIN || name == CLAIM
}

/// Answer one of the three — [`answers`] said it is one. The two refusals are [`NOT_OFFERED`]
/// alone, without the command's name.
pub fn answer(name: &str) -> Result<Value, String> {
    if name == ELSEWHERE {
        Ok(Value::String(SENTENCE.to_owned()))
    } else {
        Err(NOT_OFFERED.to_owned())
    }
}

/// One of the core's refusals, in this host's words. `name` is the command that refused.
///
/// Each of the four sentences is matched **wherever it stands in the error**, because the core
/// wraps them (`sync_pair::pairing` says "Could not reach the relay to collect … {error}"), and
/// what precedes or follows is kept:
///
/// - the relay's device cap becomes the pairing ceremony's sentence for the same limit, which
///   the core already has and which names a group, not a membership;
/// - a removal with nothing to carry it keeps its explanation and loses its instruction;
/// - the key check's 401 ("the relay did not recognise this device's group key. …") loses its
///   advice to reconnect Patreon and its talk of a membership — matched by its opening words,
///   and everything from there to the end is the core's sentence, so everything there goes;
/// - a 401's "the membership has ended" becomes what that means for the group — matched as a
///   part and not a suffix, because the core may append why a grant could not be cleared.
///
/// **Then the fence that makes this host a filter and not only a list**: an error of a `sync_`
/// command that still says patreon, membership, supporter, pledge or subscribe is replaced by
/// [`UNSAID`]. It is scoped to `sync_` commands because this runs over *every* command's errors,
/// and a deck a reader named "Patreon rewards" must keep its own message.
///
/// Anything else is returned as it came.
pub fn reword(name: &str, error: String) -> String {
    reword_sentence(&error, name.starts_with("sync_"))
}

/// What Settings → Errors is shown: [`ERROR_LOG`]'s answer, a list of rows, with each row's
/// `message` reworded as an error would be. A row from the relay (`source == "relay"`, which is
/// what the core writes every sync failure under) also gets the [`UNSAID`] fence; every other row
/// gets the four sentences only.
///
/// Never an error and never a dropped row: an answer that is not an array, a row that is not an
/// object, a `message` that is not a string — each is returned exactly as it came.
pub fn reword_rows(answer: Value) -> Value {
    let Value::Array(rows) = answer else {
        return answer;
    };
    Value::Array(rows.into_iter().map(reword_row).collect())
}

fn reword_row(mut row: Value) -> Value {
    let sync = row.get("source").and_then(Value::as_str) == Some("relay");
    if let Some(Value::String(message)) = row.get_mut("message") {
        *message = reword_sentence(message, sync);
    }
    row
}

/// The sentences of [`reword`], on any text, with the fence of [`UNSAID`] when `sync`.
fn reword_sentence(text: &str, sync: bool) -> String {
    let mut said = text
        .replace(RELAY_GROUP_IS_FULL, GROUP_IS_FULL)
        .replace(NO_MEMBERSHIP, NO_SYNC_YET)
        .replace(LAPSED_TAIL, LAPSED_HERE);
    if let Some(at) = said.find(KEY_CHECK_HEAD) {
        said.truncate(at);
        said.push_str(KEY_CHECK_HERE);
    }
    if sync {
        let lower = said.to_lowercase();
        if ["patreon", "membership", "supporter", "pledge", "subscri"]
            .iter()
            .any(|word| lower.contains(word))
        {
            return UNSAID.to_owned();
        }
    }
    said
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

    /// The core's key check sentence in full (`sync_engine::client`); the core has no const for it.
    const CORE_KEY_CHECK: &str = "the relay did not recognise this device's group key. If your devices synced together before today, reconnect Patreon once on the device you connected it on - that registers the group with the relay again. Otherwise this group has no membership connected to it yet, or this device has been offline across more key changes than the relay keeps.";

    /// `sync_pair::pairing`'s `COULD_NOT_COLLECT`, which is private there. It is the prefix the
    /// core puts in front of whatever the relay round trip said.
    const COULD_NOT_COLLECT: &str =
        "Could not reach the relay to collect that device's last changes, so it was not removed.";

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
            assert_eq!(refusal, NOT_OFFERED);
            // Never an authorize address: `sync_patreon_begin`'s answer is a URL the page opens.
            assert!(!refusal.contains("http"), "{refusal}");
            // The whole string a reader is shown — the command's name is not in it.
            clean(&refusal);
        }
    }

    #[test]
    fn the_relays_device_cap_reads_as_the_pairing_ceremonys() {
        let said = reword("sync_now", RELAY_GROUP_IS_FULL.to_owned());
        assert_eq!(said, GROUP_IS_FULL);
        assert!(said.contains("five"), "{said}");
        clean(&said);
    }

    #[test]
    fn a_removal_with_nothing_to_carry_it_loses_its_instruction() {
        let said = reword("sync_device_revoke", NO_MEMBERSHIP.to_owned());
        assert!(
            said.starts_with("Removing a device changes the key"),
            "{said}"
        );
        assert!(!said.contains("Connect"), "{said}");
        assert_eq!(said, NO_SYNC_YET);
        clean(&said);
    }

    #[test]
    fn a_lapse_is_news_about_the_group() {
        let plain = reword(
            "sync_now",
            format!("the relay answered 401 to a push{LAPSED_TAIL}"),
        );
        assert_eq!(
            plain,
            "the relay answered 401 to a push; sync is no longer on for this group"
        );
        // With the core's own postscript after it.
        let noted = reword(
            "sync_now",
            format!(
                "the relay answered 401 to a pull{LAPSED_TAIL} (the grant could not be cleared: busy)"
            ),
        );
        assert_eq!(
            noted,
            "the relay answered 401 to a pull; sync is no longer on for this group \
             (the grant could not be cleared: busy)"
        );
        clean(&plain);
        clean(&noted);
    }

    #[test]
    fn a_key_the_relay_does_not_know_names_no_one_to_pay() {
        assert!(CORE_KEY_CHECK.starts_with(KEY_CHECK_HEAD));
        let said = reword("sync_now", CORE_KEY_CHECK.to_owned());
        assert_eq!(said, KEY_CHECK_HERE);
        clean(&said);
    }

    #[test]
    fn every_other_refusal_is_left_as_it_came() {
        for error in [
            "There is no command named nope on this host.",
            "the relay answered 503 to /g/abc/pull",
            "the relay answered 503 to a key check",
            "",
        ] {
            assert_eq!(reword("sync_now", error.to_owned()), error);
            assert_eq!(reword("deck_rename", error.to_owned()), error);
        }
    }

    #[test]
    fn the_sentences_are_found_where_the_core_wraps_them() {
        // `sync_device_revoke`: "{COULD_NOT_COLLECT} {error}".
        let capped = reword(
            "sync_device_revoke",
            format!("{COULD_NOT_COLLECT} {RELAY_GROUP_IS_FULL}"),
        );
        assert_eq!(capped, format!("{COULD_NOT_COLLECT} {GROUP_IS_FULL}"));
        clean(&capped);

        let removal = reword(
            "sync_device_revoke",
            format!("{COULD_NOT_COLLECT} {NO_MEMBERSHIP}"),
        );
        assert_eq!(removal, format!("{COULD_NOT_COLLECT} {NO_SYNC_YET}"));
        clean(&removal);

        let key = reword(
            "sync_device_revoke",
            format!("{COULD_NOT_COLLECT} {CORE_KEY_CHECK}"),
        );
        assert_eq!(key, format!("{COULD_NOT_COLLECT} {KEY_CHECK_HERE}"));
        clean(&key);

        // And in front of text that follows: the by-value arms keep both sides.
        let after = reword("sync_now", format!("{RELAY_GROUP_IS_FULL} (try later)"));
        assert_eq!(after, format!("{GROUP_IS_FULL} (try later)"));
        clean(&after);
    }

    #[test]
    fn a_sync_error_that_still_names_a_membership_is_said_plainly() {
        for error in [
            "Your Patreon pledge could not be read.",
            "no Membership here",
            "ask a Supporter",
            "a subscription is needed",
            "Sync could not read the membership state",
        ] {
            let said = reword("sync_pairing_accept", error.to_owned());
            assert_eq!(said, UNSAID, "{error}");
            clean(&said);
        }
        assert_eq!(
            reword("sync_run", "membership".to_owned()),
            UNSAID,
            "any sync_ command"
        );
    }

    #[test]
    fn the_same_text_from_another_command_is_the_readers_own() {
        // A deck or a folder named by the reader: its error is its own.
        let own = "a deck named \"Patreon rewards\" already exists";
        assert_eq!(reword("deck_rename", own.to_owned()), own);
        assert_eq!(reword("folder_create", own.to_owned()), own);
        // The by-value arms still apply everywhere.
        assert_eq!(
            reword("deck_rename", RELAY_GROUP_IS_FULL.to_owned()),
            GROUP_IS_FULL
        );
    }

    fn row(source: &str, message: &str) -> Value {
        serde_json::json!({
            "id": 7,
            "firstAt": 1,
            "lastAt": 2,
            "source": source,
            "operation": "keys",
            "kind": "http",
            "message": message,
            "detail": "https://relay.example/g/abc/keys",
            "count": 3,
        })
    }

    #[test]
    fn the_error_log_is_reworded_row_by_row() {
        let list = Value::Array(vec![
            row("relay", CORE_KEY_CHECK),
            row("relay", "the relay answered 503 to a key check"),
        ]);
        let said = reword_rows(list);
        let rows = said.as_array().unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0], row("relay", KEY_CHECK_HERE));
        assert_eq!(
            rows[1],
            row("relay", "the relay answered 503 to a key check")
        );
        clean(rows[0]["message"].as_str().unwrap());
    }

    #[test]
    fn a_relay_row_is_fenced_and_another_sources_row_is_not() {
        let said = reword_rows(Value::Array(vec![
            row("relay", "a membership said no"),
            row("database", "a membership said no"),
            // The by-value arms apply to every source.
            row("database", RELAY_GROUP_IS_FULL),
        ]));
        let rows = said.as_array().unwrap();
        assert_eq!(rows[0], row("relay", UNSAID));
        assert_eq!(rows[1], row("database", "a membership said no"));
        assert_eq!(rows[2], row("database", GROUP_IS_FULL));
    }

    #[test]
    fn an_answer_of_another_shape_comes_back_as_it_came() {
        let odd = [
            Value::Null,
            Value::String(CORE_KEY_CHECK.to_owned()),
            serde_json::json!({ "message": CORE_KEY_CHECK, "source": "relay" }),
            serde_json::json!(42),
            Value::Array(vec![]),
        ];
        for answer in odd {
            assert_eq!(reword_rows(answer.clone()), answer);
        }
        // A row that is not an object, a message that is not a string, a row with no message:
        // each stays, in its place, untouched.
        let list = Value::Array(vec![
            Value::String(CORE_KEY_CHECK.to_owned()),
            serde_json::json!({ "source": "relay", "message": 5 }),
            serde_json::json!({ "source": "relay", "message": null }),
            serde_json::json!({ "source": "relay" }),
            serde_json::json!([CORE_KEY_CHECK]),
            // No source: only the by-value arms, which find nothing here.
            serde_json::json!({ "message": "a membership said no" }),
        ]);
        assert_eq!(reword_rows(list.clone()), list);
    }

    #[test]
    fn the_error_log_command_is_reworded_and_not_answered() {
        assert_eq!(ERROR_LOG, "error_log_list");
        assert!(!answers(ERROR_LOG));
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
