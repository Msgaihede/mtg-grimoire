//! The pull, a page at a time (light app phase 6, step 6.5b).
//!
//! `tests.rs` above holds the pull to a relay that answers one page with no `more` — which is
//! every relay deployed before this step, and every one of those tests passed over the paged
//! pull unedited: an answer with no `more` is the last page, and the last page is evaluated as
//! the whole answer always was. What is here is what a *paging* relay adds: the request's
//! `limit`, the cursor written page by page, the carry, what only the last page may do, and —
//! the thing the step is held to — what a paged catch-up produces beside the unpaged one.

use super::*;
use std::future::Future;

/// `envelopes` as the relay orders an answer: by the group's clock.
fn in_group_order(envelopes: &[&Envelope]) -> Vec<serde_json::Value> {
    let mut sorted: Vec<&Envelope> = envelopes.to_vec();
    sorted.sort_by(|a, b| (a.hlc_ms, a.hlc_ctr, &a.device).cmp(&(b.hlc_ms, b.hlc_ctr, &b.device)));
    sorted
        .into_iter()
        .map(|e| serde_json::to_value(e).unwrap())
        .collect()
}

/// A relay that pages: page *k* — counted from nought — is what it answers a pull from cursor
/// *k*, with *k + 1* for its own cursor and `more` for every page but the last. So each page is
/// one stored row's worth and a row's `seq` is its place in `pages`, from one.
///
/// **Each page answers only a request that names the client's `limit`**, so a pull that stopped
/// asking for pages is a pull no mock here answers.
fn paging<'a>(server: &'a MockServer, pages: &[Vec<&Envelope>]) -> Vec<httpmock::Mock<'a>> {
    pages
        .iter()
        .enumerate()
        .map(|(k, page)| {
            let body = serde_json::json!({
                "envelopes": in_group_order(page),
                "cursor": k + 1,
                "more": k + 1 < pages.len(),
            });
            server.mock(|when, then| {
                when.method(GET)
                    .path(format!("/g/{GROUP}/pull"))
                    .query_param("since", k.to_string())
                    .query_param("limit", PULL_PAGE_ROWS.to_string());
                then.status(200).json_body(body);
            })
        })
        .collect()
}

/// A relay that does not page — every one deployed before this step — answering any pull with
/// `rows`, in the group's order, and `cursor`.
fn answering_whole<'a>(
    server: &'a MockServer,
    rows: &[&Envelope],
    cursor: i64,
) -> httpmock::Mock<'a> {
    let body = serde_json::json!({ "envelopes": in_group_order(rows), "cursor": cursor });
    server.mock(|when, then| {
        when.method(GET).path(format!("/g/{GROUP}/pull"));
        then.status(200).json_body(body);
    })
}

/// One `+1` of each of `cards` from `device`, **each sealed on its own, in the order they were
/// written** — so the envelopes' stamps rise as one device's do, which is what lets a second
/// one apply after the first has moved that device's watermark.
fn one_at_a_time(device: &str, cards: &[&str]) -> Vec<Envelope> {
    let conn = paired(device, 0);
    let group = identity::group(&conn).unwrap().unwrap();
    for card in cards {
        add_copy(&conn, card, 1);
    }
    let ops = outbox(&conn);
    assert_eq!(ops.len(), cards.len());
    ops.chunks(1)
        .map(|op| wire::seal_batch(&group, device, op).unwrap())
        .collect()
}

fn cursor_of(conn: &Connection) -> Option<String> {
    get_state(conn, PULL_CURSOR)
}

/// **A pull asks for a page, applies it, writes its cursor, and asks for the next while the
/// relay says there is one.**
///
/// **What makes it red**: a request with no `limit` (no mock answers one); a pull that stops
/// after the first page; a cursor left where the first page put it.
#[tokio::test]
async fn a_pull_asks_for_a_page_and_goes_on_while_the_relay_says_more() {
    let sent = one_at_a_time("dev-a", &["p1", "p2", "p3"]);
    let server = MockServer::start_async().await;
    let pages = paging(&server, &[vec![&sent[0]], vec![&sent[1]], vec![&sent[2]]]);
    let b = paired("dev-b", 0);

    let Pulled { report, .. } = pull(&b, &server.base_url(), "access-1", Some(0))
        .await
        .unwrap();

    assert_eq!((report.applied, report.deferred), (3, 0), "{report:?}");
    for (k, page) in pages.iter().enumerate() {
        assert_eq!(
            page.calls(),
            1,
            "page {k} was asked for {} times",
            page.calls()
        );
    }
    for card in ["p1", "p2", "p3"] {
        assert_eq!(quantity_of(&b, card), (1, 1), "{card}");
    }
    assert_eq!(cursor_of(&b).as_deref(), Some("3"));
    assert_eq!(hold_of(&b), None);
    assert!(error_rows(&b).is_empty(), "{:?}", error_rows(&b));
}

/// **An answer with no `more` is the last page** — which is a relay deployed before paging: it
/// ignores `limit`, answers everything, and is read as it always was, in one request.
#[tokio::test]
async fn an_old_relays_answer_is_one_page_and_the_last() {
    let sent = one_at_a_time("dev-a", &["o1", "o2", "o3"]);
    let server = MockServer::start_async().await;
    // Whatever the query says: an old relay reads `since` and `device` and nothing else.
    let asked = serving(&server, &[&sent[0], &sent[1], &sent[2]], 3);
    let b = paired("dev-b", 0);

    let Pulled { report, .. } = pull(&b, &server.base_url(), "access-1", Some(0))
        .await
        .unwrap();

    assert_eq!(
        asked.calls(),
        1,
        "an answer with no `more` was asked about again"
    );
    assert_eq!(report.applied, 3, "{report:?}");
    assert_eq!(cursor_of(&b).as_deref(), Some("3"));
}

/// **A pull whose fetching fails has applied nothing and moved nothing** — every request of a
/// pull is made before anything is evaluated, because how it is evaluated is decided over the
/// whole of what was fetched. Three pages, and the relay fails the third: no row, no cursor, no
/// hold. The next pull asks for all three again and they land.
///
/// **What makes it red**: a page applied before the last one was fetched — the first assertion
/// finds its row; a cursor moved by a pull that answered `Err`.
#[tokio::test]
async fn a_pull_whose_fetching_fails_has_applied_nothing_and_moved_nothing() {
    let sent = one_at_a_time("dev-a", &["r1", "r2", "r3"]);
    let server = MockServer::start_async().await;
    let mut pages = paging(&server, &[vec![&sent[0]], vec![&sent[1]], vec![&sent[2]]]);
    // The third page fails.
    pages[2].delete();
    let mut failing = server.mock(|when, then| {
        when.method(GET)
            .path(format!("/g/{GROUP}/pull"))
            .query_param("since", "2");
        then.status(500);
    });
    let b = paired("dev-b", 0);

    let failed = pull(&b, &server.base_url(), "access-1", Some(0)).await;

    assert!(failed.is_err(), "{failed:?}");
    assert_eq!(
        (pages[0].calls(), pages[1].calls(), failing.calls()),
        (1, 1, 1),
        "the fixture"
    );
    assert_eq!(cursor_of(&b), None, "a pull that failed moved the cursor");
    for card in ["r1", "r2", "r3"] {
        assert_eq!(
            quantity_of(&b, card),
            (0, 0),
            "{card} applied before the fetch ended"
        );
    }
    assert_eq!(hold_of(&b), None, "a failed page is not a hold");

    // The relay recovers.
    failing.delete();
    server.mock(|when, then| {
        when.method(GET)
            .path(format!("/g/{GROUP}/pull"))
            .query_param("since", "2");
        then.status(200).json_body(serde_json::json!({
            "envelopes": in_group_order(&[&sent[2]]),
            "cursor": 3,
            "more": false,
        }));
    });
    let Pulled {
        report,
        pages: asked,
        whole,
        ..
    } = pull(&b, &server.base_url(), "access-1", Some(0))
        .await
        .unwrap();

    assert_eq!((report.applied, asked, whole), (3, 3, false), "{report:?}");
    assert_eq!(cursor_of(&b).as_deref(), Some("3"));
}

/// Run a pull until `stop` says so at one of its turns, and drop it there — a tab closed, or a
/// process ended, between two stretches. Answers whether the pull finished first.
async fn cut_short(conn: &Connection, base: &str, stop: impl Fn(&Connection) -> bool) -> bool {
    let trip = pull(conn, base, "access-1", Some(0));
    tokio::pin!(trip);
    std::future::poll_fn(|cx| {
        if let std::task::Poll::Ready(pulled) = trip.as_mut().poll(cx) {
            pulled.expect("the pull");
            return std::task::Poll::Ready(true);
        }
        if stop(conn) {
            return std::task::Poll::Ready(false);
        }
        std::task::Poll::Pending
    })
    .await
}

/// **The cursor is written page by page, so a pull cut short while it applies is resumed where
/// it stopped.** Three pages, and the tab closes in the turn after the first has applied: its
/// row is there and the cursor is past it. The next pull asks from the second page and for
/// nothing before it.
///
/// **What makes it red**: a cursor written only at the end of a pull — nothing to stop at, and
/// the helper says the pull finished; a pull that takes no turn between two pages, the same; a
/// second pull that asks for the first page again.
#[tokio::test]
async fn a_pull_cut_short_after_a_page_resumes_at_the_next() {
    let sent = one_at_a_time("dev-a", &["r1", "r2", "r3"]);
    let server = MockServer::start_async().await;
    let pages = paging(&server, &[vec![&sent[0]], vec![&sent[1]], vec![&sent[2]]]);
    let b = paired("dev-b", 0);

    let finished = cut_short(&b, &server.base_url(), |conn| {
        cursor_of(conn).as_deref() == Some("1")
    })
    .await;

    assert!(
        !finished,
        "no turn was taken with the cursor at the first page"
    );
    assert_eq!(
        (
            quantity_of(&b, "r1"),
            quantity_of(&b, "r2"),
            quantity_of(&b, "r3")
        ),
        ((1, 1), (0, 0), (0, 0))
    );

    let Pulled {
        report,
        pages: asked,
        ..
    } = pull(&b, &server.base_url(), "access-1", Some(0))
        .await
        .unwrap();

    assert_eq!((report.applied, asked), (2, 2), "{report:?}");
    assert_eq!(
        pages[0].calls(),
        1,
        "the page that had landed was asked for again"
    );
    assert_eq!(cursor_of(&b).as_deref(), Some("3"));
    for card in ["r1", "r2", "r3"] {
        assert_eq!(quantity_of(&b, card), (1, 1), "{card}");
    }
}

/// **A page handed over twice applies nothing twice** — the tab that closed between a page's
/// commit and its cursor. The page carries an ordinary `+2` and a baseline's claim; the cursor
/// is put back to before it, as if it had never been written, and the page is pulled again.
/// `sync_peers` skips the `+2` and the emission ledger the claim.
///
/// **What makes it red**: either guard gone — the row at four, or the claimed row built twice.
#[tokio::test]
async fn a_page_handed_over_twice_applies_nothing_twice() {
    let c = paired("dev-c", 0);
    add_copy(&c, "bolt", 2);
    let e = paired("dev-e", 0);
    add_copy(&e, "claimed", 3);
    e.execute("UPDATE sync_ops SET pushed_at = unixepoch()", [])
        .unwrap();
    let group = identity::group(&c).unwrap().unwrap();
    let ordinary = wire::seal_batch(&group, "dev-c", &outbox(&c)).unwrap();
    let claim = wire::seal_batch(&group, "dev-e", &emission_of(&e, "dev-e")).unwrap();
    let server = MockServer::start_async().await;
    paging(&server, &[vec![&ordinary], vec![&claim]]);
    let b = paired("dev-b", 0);
    let base = server.base_url();

    pull(&b, &base, "access-1", Some(0)).await.unwrap();
    assert_eq!(
        (quantity_of(&b, "bolt"), quantity_of(&b, "claimed")),
        ((1, 2), (1, 3))
    );

    // The cursor's write never landed: both pages come again.
    b.execute("DELETE FROM sync_state WHERE key = ?1", [PULL_CURSOR])
        .unwrap();
    let Pulled { report, .. } = pull(&b, &base, "access-1", Some(0)).await.unwrap();

    assert_eq!(report.applied, 0, "{report:?}");
    assert_eq!(
        (quantity_of(&b, "bolt"), quantity_of(&b, "claimed")),
        ((1, 2), (1, 3)),
        "a page handed over twice counted twice"
    );
    assert_eq!(cursor_of(&b).as_deref(), Some("2"));
}

/// **A child a page ahead of its parent is carried, and nothing is held.** The deck and the
/// `+1` behind it arrive on the first page and the folder the deck names on the second: the
/// first page writes no hold and leaves the cursor, and the two are evaluated as one answer.
///
/// **What makes it red**: a page evaluated on its own. The first page's hold is then written —
/// `pull_hold` is there when the pull ends, or the cursor stopped at nought — and a pull that
/// only went on "while the cursor advanced" never asks for the second page at all.
#[tokio::test]
async fn a_child_a_page_ahead_of_its_parent_is_carried_and_nothing_is_held() {
    let (child, parent) = a_child_and_the_parent_it_names("k1");
    let server = MockServer::start_async().await;
    let pages = paging(&server, &[vec![&child], vec![&parent]]);
    let b = paired("dev-b", 0);

    let Pulled { report, .. } = pull(&b, &server.base_url(), "access-1", Some(0))
        .await
        .unwrap();

    assert_eq!((pages[0].calls(), pages[1].calls()), (1, 1));
    // A folder, a deck and a `+1`, each applied once; nothing held when the pull ended.
    assert_eq!(
        (
            report.applied,
            report.deferred,
            report.held_waiting,
            report.dropped
        ),
        (3, 0, 0, 0),
        "{report:?}"
    );
    let filed: Option<String> = b
        .query_row(
            "SELECT f.name FROM decks d JOIN deck_folders f ON f.id = d.folder_id",
            [],
            |r| r.get(0),
        )
        .optional()
        .unwrap();
    assert_eq!(
        filed.as_deref(),
        Some("Binder"),
        "the deck is not in its folder"
    );
    assert_eq!(quantity_of(&b, "k1"), (1, 1));
    assert_eq!(cursor_of(&b).as_deref(), Some("2"));
    assert_eq!(hold_of(&b), None);
    assert!(error_rows(&b).is_empty(), "{:?}", error_rows(&b));
}

/// **A carry is read again with the very next page, and dropped there when that page resolves
/// it** — the cursor moves past both, with more of the log still to be read. The child on the
/// first page, its parent on the second, an ordinary row on a third, and the pull cut short in
/// the turn after the second: what stands is what the first two did.
///
/// **What makes it red**: a carry held to the end of the log before it is read again — there
/// is then no turn with the cursor at two, and the helper says the pull finished; or a cursor
/// written for the page that was carried.
#[tokio::test]
async fn a_carry_the_next_page_resolves_is_dropped_there() {
    let (child, parent) = a_child_and_the_parent_it_names("k2");
    let behind = an_ordinary_page("c2");
    let server = MockServer::start_async().await;
    paging(&server, &[vec![&child], vec![&parent], vec![&behind]]);
    let b = paired("dev-b", 0);

    let finished = cut_short(&b, &server.base_url(), |conn| {
        cursor_of(conn).as_deref() == Some("2")
    })
    .await;

    assert!(
        !finished,
        "the carry was not read again with the page behind it"
    );
    assert_eq!(quantity_of(&b, "k2"), (1, 1));
    assert_eq!(
        quantity_of(&b, "c2"),
        (0, 0),
        "the third page, not yet read"
    );
    assert_eq!(hold_of(&b), None);
}

/// ⚠ **A wait is never released on a page that is not the last.** This device has held on a
/// child for two pulls and ten minutes: the next pull that finds it still waiting gives up on
/// it, drops the deck and records that it did. Then its parent is pushed — and the pull that
/// would bring it is paged, the child on the first page and the parent on the second.
///
/// Evaluated as if it were everything, the first page is the third pull past ten minutes: the
/// deck is dropped a request before the folder it was waiting for arrives.
///
/// **What makes it red**: a hold written, or a wait released, by any evaluation but the one
/// that reached `more: false`.
#[tokio::test]
async fn a_wait_is_never_released_on_a_page_that_is_not_the_last() {
    let (child, parent) = a_child_and_the_parent_it_names("w9");
    let b = paired("dev-b", 0);
    // Two pulls that found the child alone, and ten minutes.
    let alone = MockServer::start_async().await;
    serving(&alone, &[&child], 1);
    for _ in 0..2 {
        pull(&b, &alone.base_url(), "access-1", Some(0))
            .await
            .unwrap();
    }
    rewind_hold(&b, 601);
    assert_eq!(
        hold_of(&b).and_then(|h| h["pulls"].as_i64()),
        Some(2),
        "the fixture: a wait one pull from its release"
    );
    assert_eq!(cursor_of(&b), None);

    let server = MockServer::start_async().await;
    paging(&server, &[vec![&child], vec![&parent]]);
    let Pulled { report, .. } = pull(&b, &server.base_url(), "access-1", Some(0))
        .await
        .unwrap();

    assert_eq!(
        report.dropped, 0,
        "a deck was given up on a page early: {report:?}"
    );
    let decks: i64 = b
        .query_row("SELECT count(*) FROM decks WHERE name = 'A'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(decks, 1, "the deck the wait was for");
    assert!(
        error_rows(&b).is_empty(),
        "a release was recorded: {:?}",
        error_rows(&b)
    );
    assert_eq!(hold_of(&b), None, "the wait ended: its parent came");
    assert_eq!(cursor_of(&b).as_deref(), Some("2"));
}

/// **A wait is counted on across a page that applied clean.** This device has held on a child
/// for two pulls and ten minutes, with another device's ordinary row ahead of it on the log.
/// The third pull is paged: the ordinary row's page is clean, and the child's — the last — is
/// the third pull to find it waiting. The wait has run its course, exactly as it has for one
/// answer carrying both: the deck is given up, and the pull says so.
///
/// **What makes it red**: a page that is not the last touching the stored hold. Cleared by the
/// clean page, the wait starts over at one pull and the child is held for another ten minutes
/// that the unpaged pull would not have asked for.
#[tokio::test]
async fn a_wait_is_counted_on_across_a_page_that_applied_clean() {
    let (child, _parent) = a_child_and_the_parent_it_names("w7");
    let ordinary = an_ordinary_page("c7");
    let b = paired("dev-b", 0);
    let whole = MockServer::start_async().await;
    serving(&whole, &[&ordinary, &child], 2);
    for _ in 0..2 {
        pull(&b, &whole.base_url(), "access-1", Some(0))
            .await
            .unwrap();
    }
    rewind_hold(&b, 601);
    assert_eq!(hold_of(&b).and_then(|h| h["pulls"].as_i64()), Some(2));
    assert_eq!(
        (cursor_of(&b), quantity_of(&b, "c7")),
        (None, (1, 1)),
        "the fixture: the ordinary row applied and the cursor held below it"
    );

    let server = MockServer::start_async().await;
    paging(&server, &[vec![&ordinary], vec![&child]]);
    let Pulled { report, .. } = pull(&b, &server.base_url(), "access-1", Some(0))
        .await
        .unwrap();

    assert_eq!(
        report.dropped, 1,
        "the wait started over behind a clean page: {report:?}"
    );
    assert_eq!(hold_of(&b), None);
    assert_eq!(cursor_of(&b).as_deref(), Some("2"));
    assert_eq!(quantity_of(&b, "w7"), (1, 1), "what sat behind the deck");
}

/// **A hold that lasts to the end of the log is written once, by the last page** — and what the
/// pages before it could apply, they applied once. A newer build's batch on the first page, and
/// three pages from another device behind it.
///
/// **What makes it red**: a hold written per page (`pulls` past one); the ordinary pages
/// applied on every evaluation of the carry (a quantity past one); a page asked for twice.
#[tokio::test]
async fn a_hold_to_the_end_of_the_log_is_written_once_by_the_last_page() {
    let newer = a_newer_devices_page("n9");
    let others = one_at_a_time("dev-c", &["h1", "h2", "h3"]);
    let server = MockServer::start_async().await;
    let pages = paging(
        &server,
        &[
            vec![&newer],
            vec![&others[0]],
            vec![&others[1]],
            vec![&others[2]],
        ],
    );
    let b = paired("dev-b", 0);

    let Pulled { report, .. } = pull(&b, &server.base_url(), "access-1", Some(0))
        .await
        .unwrap();

    for (k, page) in pages.iter().enumerate() {
        assert_eq!(page.calls(), 1, "page {k}");
    }
    assert_eq!((report.applied, report.held_newer), (3, 2), "{report:?}");
    for card in ["h1", "h2", "h3"] {
        assert_eq!(
            quantity_of(&b, card),
            (1, 1),
            "{card} applied more than once"
        );
    }
    assert_eq!(quantity_of(&b, "n9"), (0, 0), "a newer build's op applied");
    let hold = hold_of(&b).expect("the newer hold");
    assert_eq!(
        (hold["kind"].as_str(), hold["pulls"].as_i64()),
        (Some("newer"), Some(1)),
        "{hold}"
    );
    assert_eq!(cursor_of(&b), None, "the cursor stays below what is held");

    // And the next trip pages through the same log from the same cursor: nothing moves.
    let Pulled { report: again, .. } = pull(&b, &server.base_url(), "access-1", Some(0))
        .await
        .unwrap();
    assert_eq!(again.applied, 0, "{again:?}");
    assert_eq!(hold_of(&b).and_then(|h| h["pulls"].as_i64()), Some(2));
}

/// **The conversions that follow a pull which read everything wait for the last page.** A page
/// that advanced is not everything: the entries a peer derived from the same pick may be in the
/// next one. Two pages, and the pull cut short in the turn after the first.
///
/// **What makes it red**: the conversions run behind any page that advanced.
#[tokio::test]
async fn the_conversions_behind_a_pull_wait_for_the_last_page() {
    let b = paired("dev-b", 0);
    let deck = crate::schema::fixtures::deck(&b, "Tokens");
    b.execute(
        "INSERT INTO deck_tokens
             (deck_id, oracle_id, card_id, quantity, state, created_at, updated_at, sync_uid)
         VALUES (?1, 'o-treasure', 'p-treasure', 2, 'auto', 0, 0, 'u-pick')",
        [deck],
    )
    .unwrap();
    let entries = |c: &Connection| -> i64 {
        c.query_row("SELECT count(*) FROM deck_token_printings", [], |r| {
            r.get(0)
        })
        .unwrap()
    };
    let sent = one_at_a_time("dev-a", &["v1", "v2"]);
    let server = MockServer::start_async().await;
    paging(&server, &[vec![&sent[0]], vec![&sent[1]]]);

    let finished = cut_short(&b, &server.base_url(), |conn| {
        cursor_of(conn).as_deref() == Some("1")
    })
    .await;

    assert!(!finished, "no turn with the first page applied");
    assert_eq!(quantity_of(&b, "v1"), (1, 1), "page one landed");
    assert_eq!(
        entries(&b),
        0,
        "converted behind a page that was not the last"
    );
    assert_eq!(get_state(&b, crate::deck_tokens::PICKS_READY), None);

    let landed = pull(&b, &server.base_url(), "access-1", Some(0))
        .await
        .unwrap();

    assert_eq!(entries(&b), 2, "one entry per list, behind the last page");
    assert!(landed.converted);
}

/// **A trip whose pull fails part of the way through its pages acks what the earlier ones took,
/// emits no baseline, and its rows are announced by the trip that next ends well.**
///
/// Every request of a pull is made before anything is applied, so what can fail between two
/// pages is the database and not the network: here `sync_peers` is taken away in the turn after
/// the first page, and the second page's evaluation cannot read a watermark. Three things, of
/// that one failure. The ack: the first page moved the cursor, and a trip that ended there
/// without acking would leave the relay's floor under a page this device has consumed. The
/// baseline: a device that has not read everything must not speak for the group. And the
/// announcement: the first page's row is in the database when the trip answers `Err`, and
/// `sync:applied` is sent for a trip that answers `Ok` — so the next trip, which applies
/// nothing itself, has to say `changed`.
///
/// **What makes it red**: no ack behind a pull that stopped part of the way; a baseline begun
/// behind one; the second trip answering `changed: false`.
#[tokio::test]
async fn a_pull_that_fails_between_two_pages_acks_what_it_took_and_emits_nothing() {
    let sent = one_at_a_time("dev-a", &["f1"]);
    let server = MockServer::start_async().await;
    keys_mock(&server, 0);
    let wire_log = Sent::default();
    let pushed = server.mock(|when, then| {
        when.method(POST).path(format!("/g/{GROUP}/push"));
        then.status(200)
            .json_body(serde_json::json!({ "cursor": 9 }));
    });
    // One row, and a last page with nothing on it but the head of the log.
    paging(&server, &[vec![&sent[0]], vec![]]);
    let acked = server.mock(|when, then| {
        when.method(POST)
            .path(format!("/g/{GROUP}/ack"))
            .is_true(tap(&wire_log));
        then.status(204);
    });
    let b = paired("dev-b", 0);
    // A peer that is owed a baseline, and a row to send it: pushed long ago, so nothing pends.
    add_copy(&b, "mine", 1);
    b.execute("UPDATE sync_ops SET pushed_at = unixepoch()", [])
        .unwrap();
    roster(&b, "dev-x");
    set_state(&b, RELAY_URL, &server.base_url()).unwrap();
    grant(&b);

    // The trip, with the watermarks taken away in the turn after the first page.
    let failed = {
        let trip = run_once(&b);
        tokio::pin!(trip);
        let mut taken = false;
        std::future::poll_fn(|cx| {
            let polled = trip.as_mut().poll(cx);
            if polled.is_pending() && !taken && cursor_of(&b).as_deref() == Some("1") {
                b.execute("ALTER TABLE sync_peers RENAME TO sync_peers_away", [])
                    .unwrap();
                taken = true;
            }
            polled
        })
        .await
    };

    assert!(failed.is_err(), "{failed:?}");
    assert_eq!(quantity_of(&b, "f1"), (1, 1), "page one's row");
    assert_eq!(acked.calls(), 1, "the page that landed was not acked");
    let ack: serde_json::Value =
        serde_json::from_str(&wire_log.lock().unwrap().last().unwrap().body).unwrap();
    assert_eq!(ack["cursor"], 1, "{ack}");
    assert_eq!(get_state(&b, LAST_ACKED).as_deref(), Some("1"));
    assert_eq!(
        pushed.calls(),
        0,
        "a baseline went out behind a pull that read part"
    );

    // The database is whole again, and the relay has nothing more to say.
    b.execute("ALTER TABLE sync_peers_away RENAME TO sync_peers", [])
        .unwrap();
    assert_eq!(baselined_at(&b, "dev-x"), None);
    // (For the trip after next, which asks from the head.)
    server.mock(|when, then| {
        when.method(GET)
            .path(format!("/g/{GROUP}/pull"))
            .query_param("since", "2");
        then.status(200)
            .json_body(serde_json::json!({ "envelopes": [], "cursor": 2, "more": false }));
    });
    let next = run_once(&b).await.unwrap().unwrap();

    assert_eq!(next.pulled, 0, "{next:?}");
    assert!(next.changed, "page one's row was never announced: {next:?}");
    assert!(
        next.baseline_ops > 0,
        "the baseline goes out behind the pull that read everything"
    );
    let quiet = run_once(&b).await.unwrap().unwrap();
    assert!(!quiet.changed, "announced twice: {quiet:?}");
}

/// **A write of the reader's own between two pages is kept, and counted once beside the page
/// that carries the same row.** The turn between two pages is where a command runs, and what
/// lands in it is whatever the reader did meanwhile — here a copy of the very card the second
/// page brings. It is the write a live device makes between two pulls: the row ends at both
/// copies, and the reader's is still pending for the next trip to push.
///
/// **What makes it red**: a page applied over the row as it stood when the pull began — one
/// copy; a pull that takes the reader's op for one of its own and marks it sent; a pull with no
/// turn between its pages, where the write is never made.
#[tokio::test]
async fn a_write_between_two_pages_is_kept_and_counted_once() {
    let sent = one_at_a_time("dev-a", &["g1", "g2"]);
    let server = MockServer::start_async().await;
    paging(&server, &[vec![&sent[0]], vec![&sent[1]]]);
    let b = paired("dev-b", 0);
    let base = server.base_url();

    let trip = pull(&b, &base, "access-1", Some(0));
    tokio::pin!(trip);
    let mut wrote = false;
    let pulled = std::future::poll_fn(|cx| {
        let polled = trip.as_mut().poll(cx);
        // Page one's row with the pull still under way is the turn between the two pages.
        if polled.is_pending() && !wrote && quantity_of(&b, "g1") == (1, 1) {
            assert_eq!(quantity_of(&b, "g2"), (0, 0), "page two came first");
            add_copy(&b, "g2", 1);
            wrote = true;
        }
        polled
    })
    .await;

    assert!(wrote, "no turn between the two pages");
    assert_eq!(pulled.unwrap().report.applied, 2);
    assert_eq!(
        quantity_of(&b, "g2"),
        (1, 2),
        "the reader's copy and the page's"
    );
    let pending = outbox(&b);
    assert_eq!(pending.len(), 1, "the reader's own op: {pending:?}");
    assert_eq!(cursor_of(&b).as_deref(), Some("2"));
}

// ---------------------------------------------------------------------------------------
// What a paged catch-up equals
// ---------------------------------------------------------------------------------------

/// What a device holds, by what it says and not where it is: every synced row a fixture below
/// can make, with the names of what it is filed under in place of local ids, and its uid.
fn picture(conn: &Connection) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    for (what, sql) in [
        (
            "copy",
            "SELECT e.card_id || ' x' || e.quantity || ' in ' || coalesce(f.name, '(root)')
                    || ' as ' || coalesce(e.sync_uid, '?')
               FROM collection_entries e LEFT JOIN collection_folders f ON f.id = e.folder_id",
        ),
        (
            "binder",
            "SELECT f.name || ' in ' || coalesce(p.name, '(root)') || ' as ' || coalesce(f.sync_uid, '?')
               FROM collection_folders f LEFT JOIN collection_folders p ON p.id = f.parent_id
              WHERE f.kind = 'user'",
        ),
        (
            "deck",
            "SELECT d.name || ' in ' || coalesce(f.name, '(root)') || ' as ' || coalesce(d.sync_uid, '?')
               FROM decks d LEFT JOIN deck_folders f ON f.id = d.folder_id",
        ),
        (
            "deck folder",
            "SELECT name || ' as ' || coalesce(sync_uid, '?') FROM deck_folders",
        ),
    ] {
        let mut stmt = conn.prepare(sql).unwrap();
        let rows = stmt.query_map([], |r| r.get::<_, String>(0)).unwrap();
        lines.extend(rows.map(|row| format!("{what}: {}", row.unwrap())));
    }
    lines.sort();
    lines.push(format!("cursor: {:?}", cursor_of(conn)));
    lines.push(format!(
        "hold: {:?}",
        hold_of(conn).map(|h| h["kind"].as_str().map(str::to_owned))
    ));
    lines
}

/// The same rows of the relay's log, handed to three copies of one device three ways:
///
/// - **unpaged** — one answer carrying all of them, as every relay before step 6.5b answered;
/// - **paged** — one row a page, the smallest pages there can be, in one pull;
/// - **live** — one pull after each row was stored, each answered everything past this
///   device's cursor: what a device that was listening the whole time was handed.
///
/// `receiver` builds the device afresh for each, in whatever state the fixture leaves it.
async fn three_ways(
    receiver: &dyn Fn() -> Connection,
    rows: &[&Envelope],
) -> (Vec<String>, Vec<String>, Vec<String>) {
    let unpaged = receiver();
    let server = MockServer::start_async().await;
    answering_whole(&server, rows, rows.len() as i64);
    pull(&unpaged, &server.base_url(), "access-1", Some(0))
        .await
        .unwrap();

    let paged = receiver();
    let server = MockServer::start_async().await;
    let pages: Vec<Vec<&Envelope>> = rows.iter().map(|row| vec![*row]).collect();
    paging(&server, &pages);
    pull(&paged, &server.base_url(), "access-1", Some(0))
        .await
        .unwrap();

    let live = receiver();
    for stored in 1..=rows.len() {
        let since: usize = cursor_of(&live).map_or(0, |c| c.parse().unwrap());
        let server = MockServer::start_async().await;
        answering_whole(&server, &rows[since..stored], stored as i64);
        pull(&live, &server.base_url(), "access-1", Some(0))
            .await
            .unwrap();
    }
    (picture(&unpaged), picture(&paged), picture(&live))
}

/// **A child and its parent, split across a page edge**: the paged catch-up is what the unpaged
/// one was, and what a live device's pulls made.
///
/// The live device holds on the child for a pull — `waiting`, one pull old — and the parent's
/// pull clears it. The paged one never writes that hold: it carries the child's page instead.
/// All three end on the same rows, cursor and hold.
#[tokio::test]
async fn a_child_and_its_parent_across_a_page_edge_end_as_the_unpaged_pull_ends() {
    let (child, parent) = a_child_and_the_parent_it_names("e1");
    let (unpaged, paged, live) = three_ways(&|| paired("dev-b", 0), &[&child, &parent]).await;

    assert!(
        unpaged
            .iter()
            .any(|line| line.starts_with("deck: A in Binder")),
        "the fixture: {unpaged:#?}"
    );
    assert_eq!(
        paged, live,
        "a paged catch-up is not what a live device's pulls made"
    );
    assert_eq!(
        paged, unpaged,
        "and here it is what one unpaged pull made too"
    );
}

/// **A put a baseline's claim covers, and the claim, split across a page edge**: the paged
/// catch-up is what the unpaged one was.
///
/// `dev-a` holds two of a card and has pushed the `+2`; then it emits a baseline, whose claim
/// for that row says two and whose horizon covers the `+2`. In one answer the put is dropped as
/// carried by the claim. Split, the put's page builds the row and the claim's meets it at the
/// same two. Two, three ways.
///
/// **The put is the earlier row, and that is the only order a log can hold them in.** A
/// baseline is never begun while anything is pending (`emit_baselines`, design 2026-10-03 §5),
/// so whatever an emission's horizon covers was stored by the relay before the emission's first
/// chunk — the emitter's own ops because it pushed them first, another device's because the
/// emitter had to pull them to cover them. Pages are in `seq` order, so the edge can only fall
/// with the put on the earlier side. [`the_other_order_is_not_one_a_log_can_hold`] says what
/// the other would do, and why this test does not ask it.
///
/// **What makes it red**: a put counted on top of the claim that already holds it — four.
#[tokio::test]
async fn a_covered_put_and_its_claim_across_a_page_edge_end_as_the_unpaged_pull_ends() {
    let (put, claim) = a_covered_put_and_its_claim();
    let (unpaged, paged, live) = three_ways(&|| paired("dev-b", 0), &[&put, &claim]).await;

    assert!(
        unpaged
            .iter()
            .any(|line| line.starts_with("copy: bolt x2 in (root)")),
        "the fixture: {unpaged:#?}"
    );
    assert_eq!(
        paged, live,
        "a paged catch-up is not what a live device's pulls made"
    );
    assert_eq!(
        paged, unpaged,
        "and here it is what one unpaged pull made too"
    );
}

/// `dev-a`'s `+2` of a card, pushed, and then the baseline it emits: `(put, claim)`.
fn a_covered_put_and_its_claim() -> (Envelope, Envelope) {
    let a = paired("dev-a", 0);
    add_copy(&a, "bolt", 2);
    let group = identity::group(&a).unwrap().unwrap();
    let put = wire::seal_batch(&group, "dev-a", &outbox(&a)).unwrap();
    a.execute("UPDATE sync_ops SET pushed_at = unixepoch()", [])
        .unwrap();
    let claim = wire::seal_batch(&group, "dev-a", &emission_of(&a, "dev-a")).unwrap();
    (put, claim)
}

/// **The claim stored ahead of the put it covers is not an order a log can hold — and were it
/// one, a page edge between them would double the row.** Recorded because it was found by
/// asking: handed the claim's row and then the put's, a paged pull and a live device's two
/// pulls both end at four of the card, where one answer carrying both ends at two. The horizon
/// that covers the put rides the claim's chunk and filters the page it is in; a page later
/// there is none beside the put, and a claim that built the row leaves no watermark for it to
/// be below.
///
/// **Why it is not a defect of the pull's**: see the test above — an emitter's horizon covers
/// only what the relay had already stored, so on any log the put has the lower `seq`, and a
/// pull that reads rows in `seq` order, paged or not, meets it first. What this pins is the
/// premise. If a relay ever answers out of `seq` order, or a baseline is ever begun beside a
/// pending op, this is the card out of nothing that follows — on a live device as on a paged
/// one, which is what the middle assertion holds.
#[tokio::test]
async fn the_other_order_is_not_one_a_log_can_hold() {
    let (put, claim) = a_covered_put_and_its_claim();
    let (unpaged, paged, live) = three_ways(&|| paired("dev-b", 0), &[&claim, &put]).await;

    let copies = |picture: &[String]| -> String {
        picture
            .iter()
            .find(|line| line.starts_with("copy: "))
            .map(|line| line.split(" as ").next().unwrap().to_owned())
            .unwrap_or_else(|| "no copy".to_owned())
    };
    assert_eq!(copies(&unpaged), "copy: bolt x2 in (root)", "{unpaged:#?}");
    assert_eq!(
        paged, live,
        "paging made an arrival a live device does not meet"
    );
    assert_eq!(
        copies(&paged),
        "copy: bolt x4 in (root)",
        "a put behind its claim is no longer counted twice: the premise this records has \
         moved, and its doc with it — {paged:#?}"
    );
}

/// The fixture of the test below, which is `apply::tests`'
/// `a_copy_filed_into_a_binder_the_same_page_brings_back_stays_in_it` with its two writes pushed
/// apart: `dev-b` makes a binder and `dev-a` hears of it; `dev-b` — built afresh by the closure
/// this answers, which is why the binder is made under a uid said out loud — deletes it; and
/// `dev-a`, not having heard, files a copy into the binder and, in a later push, renames it:
/// later than the delete, so add-wins brings the binder back. (`dev-b` has to be the one that
/// made it: a binder is rebuilt from the op that built it, which is in its maker's own history.)
/// Answers `dev-b`'s maker and `dev-a`'s two pushes, in the order they were pushed.
fn a_copy_filed_into_a_binder_deleted_here_and_then_its_rename(
) -> (impl Fn() -> Connection, Envelope, Envelope) {
    let with_the_binder = || {
        let b = paired("dev-b", 0);
        b.execute(
            "INSERT INTO collection_folders
                (parent_id, name, kind, sort_order, created_at, updated_at, sync_uid)
             VALUES (NULL, 'B', 'user', 0, unixepoch(), unixepoch(), 'u-the-binder')",
            [],
        )
        .unwrap();
        b
    };
    let a = paired("dev-a", 0);
    apply::apply(&a, &outbox(&with_the_binder())).unwrap();
    let binder: i64 = a
        .query_row(
            "SELECT id FROM collection_folders WHERE sync_uid = 'u-the-binder'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    // What `dev-a` writes next is stamped after `dev-b`'s delete, whenever that is made.
    a.execute("UPDATE sync_clock SET ms = ms + 60000", [])
        .unwrap();
    a.execute(
        "INSERT INTO collection_entries
            (card_id,set_code,collector_number,lang,finish,condition,quantity,folder_id,
             created_at,updated_at)
         VALUES ('c1','lea','1','en','nonfoil','NM',1,?1,unixepoch(),unixepoch())",
        [binder],
    )
    .unwrap();
    a.execute(
        "UPDATE collection_folders SET name = 'B2' WHERE id = ?1",
        [binder],
    )
    .unwrap();
    let wrote = outbox(&a);
    assert_eq!(wrote.len(), 2, "the copy and the rename: {wrote:?}");
    let group = identity::group(&a).unwrap().unwrap();
    let filed = wire::seal_batch(&group, "dev-a", &wrote[..1]).unwrap();
    let renamed = wire::seal_batch(&group, "dev-a", &wrote[1..]).unwrap();

    let receiver = move || {
        let b = with_the_binder();
        let here: i64 = b
            .query_row(
                "SELECT id FROM collection_folders WHERE name = 'B'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        crate::collection_folders::delete_folder(&b, here).unwrap();
        b
    };
    (receiver, filed, renamed)
}

/// **A `gone` decision and the op that reverses it, split across a page edge: the paged
/// catch-up is what the unpaged one was, and what a live device's pulls made.**
///
/// This device deleted a binder. The other one, not having heard, files a copy into it, and in
/// a later push renames it — after the delete, so add-wins brings the binder back.
///
/// *One answer carrying both pushes*: the binder's rename lands first — a folder ranks ahead of
/// what is filed in it — the binder is back, and the copy is filed into it, as it is on the
/// device that sent it.
///
/// *The copy's push alone, then the rename's*: the copy names a parent that is gone, and
/// nothing else in what was handed over can bring it back. A binder's key is `SET NULL`, so the
/// copy is written at the root — which is what the sender does to it when the delete reaches
/// it — and nothing is held. **And `apply` writes down that it did so** (`apply::orphans`, issue
/// #841): when the rename arrives and the binder comes back, the copy is filed into it again.
///
/// **Until then this was the one row of the three-ways table that differed**, and this test's
/// last assertion held the difference: the binder came back empty here, the sender kept the
/// copy in it, and nothing either would send said so — the move to the root was `apply`'s own
/// write, behind `capture::suppressed`. It was older than paging; a live device pulling between
/// the two pushes met it, and paging only let a device that was behind meet it too.
/// `apply/tests/cuts.rs` has the other shapes of it.
///
/// **What makes it red**: a paged catch-up that differs from the live one — paging adding an
/// arrival of its own; and a copy left at the root by either, which is the defect back.
#[tokio::test]
async fn a_gone_decision_and_its_reversal_across_a_page_edge_end_as_the_unpaged_pull_ends() {
    let (receiver, filed, renamed) = a_copy_filed_into_a_binder_deleted_here_and_then_its_rename();
    let (unpaged, paged, live) = three_ways(&receiver, &[&filed, &renamed]).await;

    assert!(
        unpaged
            .iter()
            .any(|line| line.starts_with("copy: c1 x1 in B2")),
        "the fixture: {unpaged:#?}"
    );
    assert_eq!(
        paged, live,
        "a paged catch-up is not what a live device's pulls made"
    );
    assert_eq!(
        paged, unpaged,
        "the copy did not follow its binder back: where the log was cut decided where it is"
    );
}

/// **A sender held for its clock on a later page than its own earlier batch: the paged catch-up
/// is what a live device's pulls make, and ends as the unpaged pull ends.**
///
/// `dev-a` wrote `early` and then `fast`, the second stamped two days ahead, a batch each.
/// *One answer carrying both* holds the sender whole: neither applies until the clock catches
/// up. *A page each*: `early` applies and the cursor moves past it; `fast` is the last page's
/// to hold, as `clock`. So **while the hold lasts the two differ by `early`** — which a live
/// device that pulled between the two pushes holds as well — and once the clock catches up
/// all three hold both cards.
///
/// **Holding a sender whole was only ever whole within one answer**, and what it protects is a
/// sender whose stamps do not rise with the log, so that a batch applied alone would lift its
/// watermark past what a later one holds (`a_sender_held_for_its_clock_waits_whole_so_its_
/// watermark_cannot_pass_what_it_holds`). An ordinary sender's stamps do rise with the log —
/// one device's clock, pushed in the order it wrote. The sender whose stamps do not is an
/// older build's baseline, and that is never read a page at a time
/// ([`an_older_builds_baseline_is_read_as_one_answer_however_it_is_paged`]).
///
/// **What makes it red**: a paged catch-up that differs from the live one; a hold written by
/// the page that was not the last; a card lost when the clock catches up.
#[tokio::test]
async fn a_clock_held_sender_across_a_page_edge_ends_as_a_live_devices_pulls_do() {
    let a = paired("dev-a", 0);
    add_copy(&a, "early", 1);
    add_copy(&a, "fast", 1);
    let group = identity::group(&a).unwrap().unwrap();
    let now = now_ms(&a);
    let mut ops = outbox(&a);
    assert_eq!(ops.len(), 2, "{ops:?}");
    ops[1].at.ms = now + 2 * DAY_MS;
    let early = wire::seal_batch(&group, "dev-a", &ops[..1]).unwrap();
    let fast = wire::seal_batch(&group, "dev-a", &ops[1..]).unwrap();
    let cards = |conn: &Connection| {
        ["early", "fast"]
            .into_iter()
            .filter(|card| quantity_of(conn, card) == (1, 1))
            .collect::<Vec<_>>()
    };

    let unpaged = paired("dev-b", 0);
    let whole = MockServer::start_async().await;
    answering_whole(&whole, &[&early, &fast], 2);
    let paged = paired("dev-b", 0);
    let pages = MockServer::start_async().await;
    paging(&pages, &[vec![&early], vec![&fast]]);
    let live = paired("dev-b", 0);
    let after_one = MockServer::start_async().await;
    answering_whole(&after_one, &[&early], 1);
    let after_two = MockServer::start_async().await;
    answering_whole(&after_two, &[&fast], 2);

    pull(&unpaged, &whole.base_url(), "access-1", Some(0))
        .await
        .unwrap();
    pull(&paged, &pages.base_url(), "access-1", Some(0))
        .await
        .unwrap();
    pull(&live, &after_one.base_url(), "access-1", Some(0))
        .await
        .unwrap();
    pull(&live, &after_two.base_url(), "access-1", Some(0))
        .await
        .unwrap();

    assert_eq!(picture(&paged), picture(&live), "while the clock is held");
    assert_eq!(cards(&unpaged), Vec::<&str>::new(), "the sender, whole");
    assert_eq!(cards(&paged), ["early"]);
    assert_eq!(
        read_hold(&paged).map(|h| h.kind).as_deref(),
        Some("clock"),
        "the last page's hold"
    );
    assert_eq!(cursor_of(&paged).as_deref(), Some("1"));

    // Two days on.
    {
        let _clock = WallAt::set(now + 2 * DAY_MS);
        pull(&unpaged, &whole.base_url(), "access-1", Some(0))
            .await
            .unwrap();
        pull(&paged, &pages.base_url(), "access-1", Some(0))
            .await
            .unwrap();
        pull(&live, &after_two.base_url(), "access-1", Some(0))
            .await
            .unwrap();
    }
    assert_eq!(cards(&paged), ["early", "fast"]);
    assert_eq!(picture(&paged), picture(&live));
    assert_eq!(picture(&paged), picture(&unpaged));
}

/// A baseline of two rows from `dev-a`, one row a chunk, in table order — **and the first row in
/// that order is the one touched last**, so the first chunk carries the later stamp. With
/// `references` it is what a build since the claim design of 2026-10-03 emits (v0.40.0); without,
/// what every build from v0.18.0 to v0.39 does: the same claims, each judged by the sender's
/// watermark, the horizon on the first op of every chunk.
fn a_baseline_in_two_chunks(references: bool) -> (Envelope, Envelope) {
    let a = paired("dev-a", 0);
    add_copy(&a, "recent", 1);
    add_copy(&a, "older", 1);
    a.execute(
        "UPDATE collection_entries SET updated_at = updated_at - 1000 WHERE card_id = 'older'",
        [],
    )
    .unwrap();
    // What made the rows went out long ago: nothing pends, so a baseline may be begun.
    a.execute("UPDATE sync_ops SET pushed_at = unixepoch()", [])
        .unwrap();
    let mut ops = emission_of(&a, "dev-a");
    // The collection's own root binder, and the two copies in the order they were added.
    assert_eq!(
        ops.iter().map(|op| op.table.as_str()).collect::<Vec<_>>(),
        [
            "collection_folders",
            "collection_entries",
            "collection_entries"
        ]
    );
    assert!(
        (ops[1].at.ms, ops[1].at.ctr) > (ops[2].at.ms, ops[2].at.ctr),
        "the fixture: the first chunk's stamp is the later one"
    );
    // The horizon and the head ride the first op of every chunk.
    ops[2].horizon = ops[0].horizon.clone();
    if references {
        let head = ops[0].emission.clone().expect("a claim's reference");
        let own = ops[2].emission.as_mut().expect("a claim's reference");
        own.n = head.n;
        own.since = head.since;
        own.resumed = head.resumed;
    } else {
        for op in &mut ops {
            op.emission = None;
        }
    }
    let group = identity::group(&a).unwrap().unwrap();
    (
        wire::seal_batch(&group, "dev-a", &ops[..2]).unwrap(),
        wire::seal_batch(&group, "dev-a", &ops[2..]).unwrap(),
    )
}

/// How many copies a [`picture`] holds.
fn copies_in(picture: &[String]) -> usize {
    picture
        .iter()
        .filter(|line| line.starts_with("copy: "))
        .count()
}

/// One pull of `rows`, a row a page, by a device that holds nothing: what it answered.
async fn paged_pull_of(rows: &[&Envelope]) -> Pulled {
    let server = MockServer::start_async().await;
    let pages: Vec<Vec<&Envelope>> = rows.iter().map(|row| vec![*row]).collect();
    paging(&server, &pages);
    pull(&paired("dev-b", 0), &server.base_url(), "access-1", Some(0))
        .await
        .unwrap()
}

/// **A baseline in two chunks, split across a page edge**: from a build that sends references,
/// the paged catch-up is what the unpaged one was — a claim carries its own idempotence and the
/// watermark neither judges it nor moves for it. **And it is read a page at a time**: a
/// baseline with references is not what the one-answer evaluation is for.
///
/// **What makes it red**: a claim judged by its sender's watermark — the second chunk's row,
/// stamped below the first's, skipped as seen; and a classification that takes this baseline
/// for an older build's, which would be every catch-up read whole and paging off for everybody,
/// with nothing lost to say so.
#[tokio::test]
async fn a_baseline_in_two_chunks_across_a_page_edge_ends_as_the_unpaged_pull_ends() {
    let (first, second) = a_baseline_in_two_chunks(true);
    let (unpaged, paged, live) = three_ways(&|| paired("dev-b", 0), &[&first, &second]).await;

    assert_eq!(copies_in(&unpaged), 2, "the fixture: {unpaged:#?}");
    assert_eq!(paged, live);
    assert_eq!(paged, unpaged);

    let Pulled { pages, whole, .. } = paged_pull_of(&[&first, &second]).await;
    assert_eq!(
        (pages, whole),
        (2, false),
        "a baseline with references was read as one answer"
    );
}

/// ⚠ **An older build's baseline is read as one answer, however it is paged.** The same two
/// chunks from a build that sends no references — every release from v0.18.0 to v0.39 — and an
/// ordinary row of another device's behind them, a row a page.
///
/// Read a page at a time, the first chunk builds `recent` and lifts the sender's watermark to
/// its stamp; the second chunk's `older`, stamped below it, is skipped as seen, and this device
/// never holds a card the sender does. **That is what a live device that pulls between the two
/// chunks does today** — `live` below, a row short — and what references were built to end for
/// the builds that send them. A device catching up used to be handed both chunks in one answer,
/// which `apply` sorts by stamp; so it is handed them as one answer still.
///
/// **What makes it red**: such a catch-up applied a page at a time — the paged device a row
/// short, as the live one is. *And* the day a live device stops losing the row: the last
/// assertion says it still does.
#[tokio::test]
async fn an_older_builds_baseline_is_read_as_one_answer_however_it_is_paged() {
    let (first, second) = a_baseline_in_two_chunks(false);
    let behind = an_ordinary_page("c9");
    let rows = [&first, &second, &behind];
    let (unpaged, paged, live) = three_ways(&|| paired("dev-b", 0), &rows).await;

    assert_eq!(copies_in(&unpaged), 3, "the fixture: {unpaged:#?}");
    assert_eq!(
        paged, unpaged,
        "an older build's baseline was read a page at a time"
    );
    let Pulled { pages, whole, .. } = paged_pull_of(&rows).await;
    assert_eq!((pages, whole), (3, true), "which way the pull says it went");
    assert_eq!(
        copies_in(&live),
        2,
        "a live device no longer loses the row a second chunk holds below the first's stamp: \
         the defect this records is closed, and this assertion with it — {live:#?}"
    );
}

/// ⚠ **An older build's own ordinary op, a page ahead of its baseline — the join.** `dev-a`,
/// on a build with no references, holds `held` from before it was paired — no insert of it is
/// on the log — adds `fresh`, and pairs: its trip pushes the `+1` and then the baseline, as
/// every trip does. A device joining that group pulls exactly this log, from nought.
///
/// *One answer carrying both*: sorted by stamp, the baseline's claim for `held` — stamped when
/// the row was last touched — is ahead of the `+1`, and both cards land. *The `+1`'s page, then
/// the baseline's*: the `+1` applies, the sender's watermark is at now, and the chunk's `held`
/// is below it and skipped as seen.
///
/// **This is the one a rule that looks at a page as it is read cannot catch**: by the time a
/// page shows the chunk, the page before it has moved the watermark. So the whole catch-up is
/// classified before any of it is applied, and this one is evaluated as one answer.
///
/// **A live device that hears the doorbell on the `+1` loses the row today** (`live`), and has
/// since baselines were built: `docs/reference/sync.md`'s "a sparse op pulled ahead of its
/// baseline". That is not this pull's, and is not changed by it.
///
/// **What makes it red**: a catch-up evaluated a page at a time whenever its first page looks
/// ordinary — `held` missing, as on the live device. *And* the day the live device holds it:
/// the last assertion says it still does not.
#[tokio::test]
async fn an_older_builds_own_op_a_page_ahead_of_its_baseline_is_read_as_one_answer() {
    let a = paired("dev-a", 0);
    add_copy(&a, "held", 1);
    a.execute(
        "UPDATE collection_entries SET updated_at = updated_at - 1000 WHERE card_id = 'held'",
        [],
    )
    .unwrap();
    add_copy(&a, "fresh", 1);
    let plus_one = outbox(&a).pop().expect("the +1 of `fresh`");
    assert_eq!(plus_one.table, "collection_entries", "{plus_one:?}");
    a.execute("UPDATE sync_ops SET pushed_at = unixepoch()", [])
        .unwrap();
    let mut claims = emission_of(&a, "dev-a");
    for op in &mut claims {
        op.emission = None;
    }
    let group = identity::group(&a).unwrap().unwrap();
    let edit = wire::seal_batch(&group, "dev-a", &[plus_one]).unwrap();
    let baseline = wire::seal_batch(&group, "dev-a", &claims).unwrap();
    let rows = [&edit, &baseline];

    let (unpaged, paged, live) = three_ways(&|| paired("dev-b", 0), &rows).await;

    assert_eq!(copies_in(&unpaged), 2, "the fixture: {unpaged:#?}");
    assert_eq!(
        paged, unpaged,
        "a row one unpaged answer delivered was lost to a page edge"
    );
    let Pulled { pages, whole, .. } = paged_pull_of(&rows).await;
    assert_eq!((pages, whole), (2, true));
    assert_eq!(
        copies_in(&live),
        1,
        "`held` landed on a device that pulled between the +1 and the baseline: the defect \
         this records is closed, and this assertion with it — {live:#?}"
    );
}

/// **What says "an older build's baseline" is exact: a horizon with no reference**, held here
/// to what each generation really puts on the wire.
///
/// A build since v0.40.0: its ordinary ops — a copy, a binder, a copy filed, a rename, a
/// delete, a deck in a folder — carry neither; every op of its baseline carries a reference,
/// and the first of each chunk the horizon beside it. A build from v0.18.0 to v0.39: the same
/// baseline with no reference anywhere. Only the last is one.
///
/// **What makes it red**: an op of a current build's that carries a horizon and no reference —
/// every catch-up holding one would be read as one answer, silently, paging off; or an older
/// chunk that is not recognised, which is rows lost.
#[test]
fn only_a_horizon_with_no_reference_is_an_older_builds_baseline() {
    let a = paired("dev-a", 0);
    add_copy(&a, "c1", 2);
    a.execute(
        "INSERT INTO collection_folders
            (parent_id, name, kind, sort_order, created_at, updated_at)
         VALUES (NULL, 'B', 'user', 0, unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
    a.execute(
        "UPDATE collection_entries SET folder_id =
             (SELECT id FROM collection_folders WHERE name = 'B')",
        [],
    )
    .unwrap();
    a.execute(
        "UPDATE collection_folders SET name = 'B2' WHERE name = 'B'",
        [],
    )
    .unwrap();
    a.execute(
        "INSERT INTO deck_folders (name, sort_order, created_at, updated_at)
         VALUES ('Binder', 0, unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
    a.execute(
        "INSERT INTO decks (name, format_key, folder_id, created_at, updated_at)
         VALUES ('A', 'commander', (SELECT id FROM deck_folders), unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
    add_copy(&a, "gone", 1);
    a.execute("DELETE FROM collection_entries WHERE card_id = 'gone'", [])
        .unwrap();
    let group = identity::group(&a).unwrap().unwrap();
    let ordinary = outbox(&a);
    assert!(ordinary.len() >= 7, "the fixture: {}", ordinary.len());
    assert!(
        ordinary
            .iter()
            .all(|op| op.horizon.is_none() && op.emission.is_none()),
        "an ordinary op carries a horizon or a reference"
    );
    let sealed = |ops: &[Op]| wire::seal_batch(&group, "dev-a", ops).unwrap();
    let is_older = |envelopes: &[Envelope]| an_older_baseline_is_in(&a, &group, envelopes).unwrap();
    assert!(!is_older(&[sealed(&ordinary)]), "ordinary ops");

    a.execute("UPDATE sync_ops SET pushed_at = unixepoch()", [])
        .unwrap();
    let claims = emission_of(&a, "dev-a");
    assert!(claims.len() >= 4, "the fixture: {}", claims.len());
    assert!(
        claims.iter().all(|op| op.emission.is_some()),
        "a claim of a current build's with no reference"
    );
    assert!(
        claims[0].horizon.is_some(),
        "the horizon rides the first op"
    );
    // As one chunk, and as a chunk an op — the horizon on the first op of each, as it is sent.
    let chunks: Vec<Envelope> = claims
        .iter()
        .map(|claim| {
            let mut first = claim.clone();
            first.horizon = claims[0].horizon.clone();
            sealed(&[first])
        })
        .collect();
    assert!(!is_older(&[sealed(&claims)]), "a baseline with references");
    assert!(!is_older(&chunks), "…a chunk an op");
    assert!(!is_older(&[sealed(&ordinary), sealed(&claims)]));

    let stripped: Vec<Op> = claims
        .iter()
        .cloned()
        .map(|mut op| {
            op.emission = None;
            op
        })
        .collect();
    assert!(is_older(&[sealed(&stripped)]), "a baseline with none");
    assert!(
        is_older(&[sealed(&ordinary), sealed(&claims), sealed(&stripped[..1])]),
        "one older chunk among everything else"
    );
    // A chunk of an older build's is known by its first op, which is where the horizon rides;
    // the ops behind it carry nothing, and are never a chunk of their own.
    assert!(!is_older(&[sealed(&stripped[1..])]));
}

// ---------------------------------------------------------------------------------------
// One connection, one thread — and a page's command between two pages
// ---------------------------------------------------------------------------------------

/// **Between two pages of a pull, the engine answers the page.** This is what the step is for:
/// a browser's engine is one thread on one connection, the unpaged pull held both for the
/// length of its apply, and a search asked meanwhile waited — twenty-nine seconds, for a
/// 50 000-row import.
///
/// A state as a browser's is built — one connection, and this thread declared the only one
/// ([`crate::platform::alone`]), so a connection asked for while it is held is a panic and not
/// a wait. The relay serves two pages. `sync_now` is pressed, and **at every turn the trip
/// takes** — every request it waits on, and the turn it gives the host between two pages — the
/// page reads its collection, as a command queued behind the trip would be run. One of those
/// reads must find the first page's row and not the second's.
///
/// **What makes it red**: a pull that holds the connection across a request or a turn — the
/// read panics, by name; a pull that takes no turn between two pages, or one that is not paged
/// — no read ever sees one row without the other.
#[tokio::test]
async fn a_page_command_is_answered_between_two_pages_of_a_pull() {
    use crate::commands::dispatch;
    use serde_json::{json, Value};

    let sent = one_at_a_time("dev-a", &["b1", "b2"]);
    let server = MockServer::start_async().await;
    keys_mock(&server, 0);
    paging(&server, &[vec![&sent[0]], vec![&sent[1]]]);
    server.mock(|when, then| {
        when.method(POST).path(format!("/g/{GROUP}/ack"));
        then.status(204);
    });

    let (state, _heard, _dir) =
        crate::state::fixtures::single("client-paged-pull-alone", "http://127.0.0.1:1");
    {
        let conn = state.lock_db();
        conn.execute("DELETE FROM sync_identity", []).unwrap();
        conn.execute("DELETE FROM sync_group", []).unwrap();
        conn.execute(
            "INSERT INTO sync_identity (id, device_id, secret_key, public_key, name, created_at)
             VALUES (1, 'dev-b', x'00', x'01', 'dev-b', 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sync_group (id, group_id, epoch, group_key, joined_at)
             VALUES (1, ?1, 0, ?2, 0)",
            rusqlite::params![GROUP, vec![7u8; 32]],
        )
        .unwrap();
        set_state(&conn, RELAY_URL, &server.base_url()).unwrap();
        grant(&conn);
    }
    let _alone = crate::platform::alone::emulate();
    assert!(state.one_connection());

    let trip = dispatch(&state, "sync_now", Value::Null, None);
    tokio::pin!(trip);
    let mut reads = 0usize;
    let mut between = false;
    let synced = std::future::poll_fn(|cx| {
        let polled = trip.as_mut().poll(cx);
        if polled.is_pending() {
            // The trip has let go: a command of the page's own runs here, start to finish.
            let summary = crate::platform::timer::unbroken(dispatch(
                &state,
                "collection_summary",
                json!({ "query": {} }),
                None,
            ))
            .expect("a read of the page's own");
            reads += 1;
            between |= summary["entries"] == 1;
        }
        polled
    })
    .await;

    let outcome = synced.expect("the trip");
    assert_eq!(outcome["pulled"], 2, "{outcome}");
    assert_eq!(outcome["pullPages"], 2, "{outcome}");
    assert!(reads > 0, "the trip never waited");
    assert!(
        between,
        "of {reads} reads asked while the trip waited, none found the first page's row \
         without the second's"
    );
}
