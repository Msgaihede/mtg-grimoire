//! **The deck tools** (MCP project E, `docs/superpowers/specs/2026-11-25-mcp-decks-design.md`
//! §6.3): `get_deck` (a deck as information, its cards as piles or as decklist text),
//! `deck_stats`, `check_deck`, `deck_shortfall`, `owned_for_deck` and `draw_odds`.
//!
//! Each is a translation onto the core's table, as every tool is (`tools.rs`' rule): `deck_get`,
//! and the commands project E added — `deck_check` and `deck_stats` (the deck page's validation,
//! bracket and stats, ported to the core and held to the page's TypeScript by shared goldens),
//! `deck_owned_fits` and `deck_draw_odds` — with `deck_owned_elsewhere` and `deck_missing_plan`
//! for what the collection holds. So a deck's answers here are the page's answers.
//!
//! Read-only, like every tool but the widget writes: a review suggests, and the user changes the
//! deck in the app.

use super::tools::{pick, rows, run, short_list, tool, with_combo_data, Args};
use crate::sync::AppState;
use crate::transfer::{fields::default_fields, write::format_export, Format, Surface};
use serde_json::{json, Map, Value};
use std::sync::Arc;

/// The decklist formats `get_deck` writes text in: the compact, standard ones, Moxfield's (the
/// default) first — it heads each zone, switched-off piles under `Maybeboard`, where plain text is
/// one flat list of every pile.
const TEXT_FORMATS: [&str; 4] = ["moxfield", "arena", "mtgo", "plain"];

/// The deck tools after `get_deck`, in the order `tools/list` names them.
pub(super) fn tools(read: &Value) -> Vec<Value> {
    let deck_id = json!({ "type": "integer", "description": "From list_decks." });
    let list = json!({
        "type": "string", "enum": ["live", "theory"],
        "description": "The deck's actual list (live, the default) or its theory list.",
    });
    vec![
        tool(
            "deck_stats",
            "Deck stats",
            "A deck's statistics as the app's stats band counts them, over its active piles (a \
             switched-off Maybeboard counts toward nothing): the mana curve (mana values 0-7 and \
             8+, each with its creatures, and an X bar when the deck sets X spells apart), \
             average mana value, lands and nonlands (mdfcLands: nonlands whose back face is a \
             land), card types, creature and land subtypes, per colour the pips the costs ask for \
             against the sources that can make it, and the price, owned and missing in the \
             user's marketplace.",
            json!({ "deckId": deck_id, "list": list }),
            &["deckId"],
            read,
        ),
        tool(
            "check_deck",
            "Check deck",
            "What the app's validation finds wrong with a deck: problems (severity, code, the \
             app's sentence and the cards) over its active piles, and parked: the same for cards \
             in switched-off piles, judged on their own (could they ever come in). checked false \
             means the format is not judged (unspecified): say not checked, never legal. In a \
             Commander format, bracket is the bracket floor read from the cards (Game Changers, \
             mass land denial, extra turns, Commander Spellbook's combos) with its reasons: the \
             lowest bracket the cards allow, never the deck's bracket, and brackets 1 and 5 are \
             the user's to set. warning is the app's sentence when the set bracket is below the \
             floor.",
            json!({ "deckId": deck_id, "list": list }),
            &["deckId"],
            read,
        ),
        tool(
            "deck_shortfall",
            "What a deck is short of",
            "Every card in a deck's active piles the user owns fewer copies of than the deck \
             plays: the missing copies, what they cost in the user's marketplace, where the user \
             owns other copies (a binder, another deck, Recently removed: fetch those rather \
             than buy them) and whether a wish names the card; with totals, and toBuy, the \
             copies the user owns nowhere. A virtual deck tracks no cardboard and answers a note.",
            json!({
                "deckId": deck_id, "list": list,
                "limit": { "type": "integer", "minimum": 1, "maximum": 200, "description": "Rows to answer (default 50)." },
                "offset": { "type": "integer", "minimum": 0, "description": "Rows to skip (default 0)." },
            }),
            &["deckId"],
            read,
        ),
        tool(
            "owned_for_deck",
            "Owned cards for a deck",
            "Cards the user owns that a deck could play and does not: legal in its format, \
             inside its colour identity (the commanders', else the deck's cards'), in none of its \
             active piles. Narrow by query (name words) and filters (types, manaValues, and \
             oracleTags from find_tags, all held). Ordered by EDHREC rank, most played first. \
             Each row names the printing the user owns most of, the copies owned, and how many \
             of those are in other decks.",
            json!({
                "deckId": deck_id, "list": list,
                "query": { "type": "string", "description": "Words of the card's name." },
                "filters": {
                    "type": "object",
                    "properties": {
                        "types": { "type": "array", "items": { "type": "string" }, "description": "Card types: Artifact, Battle, Creature, Enchantment, Instant, Land, Planeswalker, Sorcery. Any one of them." },
                        "manaValues": { "type": "array", "items": { "type": "integer", "minimum": 0, "maximum": 8 }, "description": "Mana values; 8 means 8 or more." },
                        "oracleTags": { "type": "array", "items": { "type": "string" }, "description": "Oracle tag slugs (from find_tags); a card must hold all of them." },
                    },
                    "additionalProperties": false,
                },
                "limit": { "type": "integer", "minimum": 1, "maximum": 100, "description": "Cards to answer (default 20)." },
                "offset": { "type": "integer", "minimum": 0, "description": "Cards to skip (default 0)." },
            }),
            &["deckId"],
            read,
        ),
        tool(
            "draw_odds",
            "Draw odds",
            "The chance of drawing cards from a deck, in the opening hand and by each turn's \
             draw, on the play (no draw on turn 1) or on the draw. Say what to draw with cards \
             (names or cardIds), pile (a pile's name) or type (Creature, Land...: the front \
             face's type, as the app's stats cut it, so a land on a card's back face is not a \
             Land; name it in cards), and how many: want (default 1) at least, exactly or at \
             most (mode). The library is the deck's active piles less the command zone. \
             Mulligans, tutors and card draw are not counted.",
            json!({
                "deckId": deck_id, "list": list,
                "cards": { "type": "array", "items": { "type": "string" }, "description": "Card names or cardIds; any of them counts." },
                "pile": { "type": "string", "description": "A pile's name, e.g. Ramp." },
                "type": { "type": "string", "description": "Artifact, Battle, Creature, Enchantment, Instant, Land, Planeswalker, Sorcery or Other." },
                "want": { "type": "integer", "minimum": 0, "maximum": 20, "description": "How many copies (default 1)." },
                "mode": { "type": "string", "enum": ["atLeast", "exactly", "atMost"], "description": "Default atLeast." },
                "hand": { "type": "integer", "minimum": 1, "maximum": 20, "description": "Opening hand size (default 7)." },
                "turns": { "type": "integer", "minimum": 0, "maximum": 20, "description": "Turns to read past the opening hand (default 4)." },
                "onThePlay": { "type": "boolean", "description": "Default true; false is on the draw." },
            }),
            &["deckId"],
            read,
        ),
    ]
}

/// `get_deck`'s definition, which `tools.rs` lists in its old place.
pub(super) fn get_deck_tool(read: &Value) -> Value {
    tool(
        "get_deck",
        "Get deck",
        "One deck: its kind (regular; theory, a planning list beside the cards owned; or \
         virtual, which tracks no cardboard), format, game, commanders and companion, colour \
         identity (the commanders', else the active cards'), settings, counts (sized: what the \
         format counts; inactive: copies in switched-off piles, which count toward nothing) and \
         how many problems check_deck finds; and its cards, pile by pile, or with as: \"text\" as \
         compact decklist text.",
        json!({
            "deckId": { "type": "integer", "description": "From list_decks." },
            "list": {
                "type": "string", "enum": ["live", "theory"],
                "description": "The deck's actual list (live, the default) or its theory list.",
            },
            "as": { "type": "string", "enum": ["piles", "text"], "description": "The cards pile by pile (the default), or as decklist text." },
            "textFormat": { "type": "string", "enum": TEXT_FORMATS, "description": "With as: \"text\": moxfield (the default: Commander, Companion, Deck, Sideboard and Maybeboard headings, switched-off piles under Maybeboard), arena (switched-on piles only), mtgo (SB: lines) or plain (one flat list of every pile, switched-off ones included)." },
        }),
        &["deckId"],
        read,
    )
}

/// The sentence for a deck id no deck has — `held_combos`' own.
fn no_deck(deck_id: i64) -> String {
    format!("No deck has the id {deck_id}. Use list_decks to look one up.")
}

/// The `list` argument: `live` (the default) or `theory`.
fn list_arg(args: &Args) -> Result<String, String> {
    Ok(args
        .choice("list", &["live", "theory"], Some("live"))?
        .unwrap_or_default())
}

/// The user's marketplace, or `null` (the core's default) when it cannot be read.
async fn marketplace(state: &Arc<AppState>) -> Value {
    run(state, "get_marketplace", json!({}))
        .await
        .ok()
        .filter(Value::is_string)
        .unwrap_or(Value::Null)
}

/// Money to the cent, `null` kept.
fn money(value: &Value) -> Value {
    value
        .as_f64()
        .map_or(Value::Null, |v| json!((v * 100.0).round() / 100.0))
}

/// A probability to four places.
fn chance(value: &Value) -> Value {
    value
        .as_f64()
        .map_or(Value::Null, |v| json!((v * 10_000.0).round() / 10_000.0))
}

/// An identity as the search tools take it: WUBRG letters, or `C` for colourless.
fn identity_word(identity: &Value) -> Value {
    match identity.get("letters").and_then(Value::as_str) {
        None => Value::Null,
        Some("") => json!("C"),
        Some(letters) => json!(letters),
    }
}

/// `deckKind.ts`' three kinds.
fn kind_of(deck: &Value) -> &'static str {
    if deck["virtualOnly"] == json!(true) {
        "virtual"
    } else if deck["theoryEnabled"] == json!(true) {
        "theory"
    } else {
        "regular"
    }
}

/// The note for a deck whose format is not judged.
fn unchecked_note(check: &Value) -> String {
    match check.get("formatName").and_then(Value::as_str) {
        Some(name) => format!(
            "The app does not judge decks in {name}: say the deck is not checked, never that it \
             is legal. The user picks a format in the deck's settings."
        ),
        None => format!(
            "The app has no rules for this deck's format ({}), so it is not checked.",
            check["formatKey"].as_str().unwrap_or_default()
        ),
    }
}

/// `get_deck`: the deck as information, and its cards.
pub(super) async fn get_deck(state: &Arc<AppState>, args: &Args) -> Result<Value, String> {
    let deck_id = args.required_int("deckId")?;
    let variant = list_arg(args)?;
    let shape = args
        .choice("as", &["piles", "text"], Some("piles"))?
        .unwrap_or_default();
    let text_format = args.choice("textFormat", &TEXT_FORMATS, None)?;
    if text_format.is_some() && shape != "text" {
        return Err("textFormat is for as: \"text\".".to_owned());
    }
    let detail = run(
        state,
        "deck_get",
        json!({ "id": deck_id, "variant": variant }),
    )
    .await?;
    if detail.is_null() {
        return Err(no_deck(deck_id));
    }
    let ask = json!({ "deckId": deck_id, "variant": variant });
    let check = run(state, "deck_check", ask.clone()).await?;
    let stats = run(state, "deck_stats", ask).await?;
    let row = detail.get("deck").unwrap_or(&Value::Null);
    let cards = rows(&detail, "cards");
    let active_kind = |kind: &str| -> Vec<Value> {
        cards
            .iter()
            .filter(|c| c["categoryActive"] == json!(true) && c["categoryKind"] == json!(kind))
            .map(|c| pick(c, &[("name", "name"), ("cardId", "cardId")]))
            .collect()
    };

    let mut deck = pick(
        row,
        &[
            ("deckId", "id"),
            ("name", "name"),
            ("format", "formatName"),
            ("formatKey", "formatKey"),
            ("description", "description"),
            ("cards", "cardCount"),
        ],
    );
    deck["list"] = json!(variant);
    deck["kind"] = json!(kind_of(row));
    deck["game"] = row.get("gameKey").cloned().unwrap_or(Value::Null);
    deck["commanders"] = json!(active_kind("commander"));
    deck["companion"] = json!(active_kind("companion"));
    deck["identity"] = identity_word(&check["identity"]);
    deck["identityFrom"] = check["identity"]
        .get("from")
        .cloned()
        .unwrap_or(Value::Null);
    let bracket = row.get("bracket").and_then(Value::as_i64).unwrap_or(0);
    deck["settings"] = json!({
        "bracket": if bracket == 0 { json!("auto") } else { json!(bracket) },
        "xSpellsApart": row.get("separateXGroup"),
        "theoryList": row.get("theoryEnabled"),
        "tags": row.get("tags"),
        "archived": row.get("archived"),
        "folderId": row.get("folderId"),
    });
    let summary = &stats["summary"];
    deck["counts"] = json!({
        "sized": summary["sized"],
        "copies": summary["copies"],
        "inactive": summary["inactive"],
    });
    if check["checked"] == json!(true) {
        let count = |list: &str, severity: &str| {
            rows(&check, list)
                .iter()
                .filter(|i| i["severity"] == json!(severity))
                .count()
        };
        deck["problems"] = json!({
            "errors": count("issues", "error"),
            "warnings": count("issues", "warning"),
            "parked": rows(&check, "parked").len(),
        });
    } else {
        deck["problems"] = Value::Null;
        deck["note"] = json!(unchecked_note(&check));
    }

    if shape == "text" {
        let key = text_format.unwrap_or_else(|| TEXT_FORMATS[0].to_owned());
        let format = Format::ALL
            .into_iter()
            .find(|f| f.key() == key)
            .unwrap_or(Format::Moxfield);
        let rows: Vec<grimoire_core::deck::DeckCardRow> =
            serde_json::from_value(detail["cards"].clone()).map_err(|e| e.to_string())?;
        let cards: Vec<crate::transfer::Card> = rows
            .iter()
            .map(crate::mirror::read::from_deck_card)
            .collect();
        deck["textFormat"] = json!(key);
        deck["text"] = json!(format_export(
            &cards,
            format,
            &default_fields(format, Surface::Deck)
        ));
        return Ok(deck);
    }

    let piles: Vec<Value> = rows(&detail, "categories")
        .iter()
        .filter(|c| c.get("variant").and_then(Value::as_str) == Some(variant.as_str()))
        .map(|pile| {
            let id = pile.get("id");
            let in_pile: Vec<Value> = cards
                .iter()
                .filter(|c| c.get("categoryId") == id)
                .map(|c| {
                    pick(
                        c,
                        &[
                            ("cardId", "cardId"),
                            ("name", "name"),
                            ("quantity", "quantity"),
                            ("set", "setCode"),
                            ("collectorNumber", "collectorNumber"),
                            ("finish", "finish"),
                            ("manaCost", "manaCost"),
                            ("typeLine", "typeLine"),
                        ],
                    )
                })
                .collect();
            let mut pile = pick(
                pile,
                &[("pile", "name"), ("kind", "kind"), ("counts", "isActive")],
            );
            pile["cards"] = Value::Array(in_pile);
            pile
        })
        .collect();
    deck["piles"] = Value::Array(piles);
    Ok(deck)
}

/// `deck_stats`: the stats band's numbers.
///
/// Named `stats` because `deck_stats` is the table command it reads, which `TABLE_ONLY` keeps
/// out of this crate's function names.
pub(super) async fn stats(state: &Arc<AppState>, args: &Args) -> Result<Value, String> {
    let deck_id = args.required_int("deckId")?;
    let variant = list_arg(args)?;
    let market = marketplace(state).await;
    let read = run(
        state,
        "deck_stats",
        json!({ "deckId": deck_id, "variant": variant, "marketplace": market }),
    )
    .await?;
    if read.is_null() {
        return Err(no_deck(deck_id));
    }
    let s = &read["summary"];
    let at = |field: &str, i: usize| s[field].get(i).cloned().unwrap_or(json!(0));
    let mut curve: Vec<Value> = (0..9)
        .map(|i| {
            json!({
                "manaValue": if i == 8 { "8+".to_owned() } else { i.to_string() },
                "cards": at("curve", i),
                "creatures": at("curveCreatures", i),
            })
        })
        .collect();
    if !s["variableCost"].is_null() {
        curve.push(json!({
            "manaValue": "X",
            "cards": s["variableCost"],
            "creatures": s["variableCostCreatures"],
        }));
    }
    let colours: Map<String, Value> = ["W", "U", "B", "R", "G", "C"]
        .iter()
        .map(|k| {
            (
                (*k).to_owned(),
                json!({
                    "pips": s["pips"][k],
                    "pipCards": s["pipCards"][k],
                    "sources": s["sources"][k],
                    "spells": s["spellsByColor"][k],
                }),
            )
        })
        .collect();
    let breakdown = &read["typeBreakdown"];
    Ok(json!({
        "deckId": deck_id,
        "list": variant,
        "sized": s["sized"],
        "copies": s["copies"],
        "inactive": s["inactive"],
        "lands": s["lands"],
        "nonlands": s["nonlands"],
        "mdfcLands": s["mdfcLands"],
        "unknownManaValue": s["unknownManaValue"],
        "averageManaValue": s["averageManaValue"].as_f64().map_or(Value::Null, |v| json!((v * 100.0).round() / 100.0)),
        "curve": curve,
        "types": rows(&read, "typeCounts")
            .iter()
            .map(|b| json!({ "type": b["label"], "cards": b["count"] }))
            .collect::<Vec<_>>(),
        "creatureTypes": rows(breakdown, "creatureTypes")
            .iter()
            .map(|r| json!({ "type": r["name"], "cards": r["count"] }))
            .collect::<Vec<_>>(),
        "landTypes": rows(breakdown, "landSlices")
            .iter()
            .map(|r| json!({ "type": r["label"], "cards": r["count"] }))
            .collect::<Vec<_>>(),
        "colors": colours,
        "sourcesKnown": s["sourcesKnown"],
        "marketplace": market,
        "price": money(&s["price"]),
        "ownedPrice": money(&s["ownedPrice"]),
        "missingPrice": money(&s["missingPrice"]),
        "unpriced": s["unpriced"],
        "owned": s["owned"],
        "missing": s["missing"],
    }))
}

/// `check_deck`: the validation panel's findings and the bracket readout.
pub(super) async fn check_deck(state: &Arc<AppState>, args: &Args) -> Result<Value, String> {
    let deck_id = args.required_int("deckId")?;
    let variant = list_arg(args)?;
    let check = run(
        state,
        "deck_check",
        json!({ "deckId": deck_id, "variant": variant }),
    )
    .await?;
    if check.is_null() {
        return Err(no_deck(deck_id));
    }
    let detail = run(
        state,
        "deck_get",
        json!({ "id": deck_id, "variant": variant }),
    )
    .await?;
    let names: Map<String, Value> = rows(&detail, "cards")
        .iter()
        .filter_map(|c| Some((c["cardId"].as_str()?.to_owned(), c["name"].clone())))
        .collect();
    let problems = |list: &str| -> Vec<Value> {
        rows(&check, list)
            .iter()
            .map(|i| {
                let ids = i["cardIds"].as_array().cloned().unwrap_or_default();
                let mut out = pick(
                    i,
                    &[("severity", "severity"), ("code", "code"), ("message", "message")],
                );
                if !ids.is_empty() {
                    out["cards"] = json!(ids
                        .iter()
                        .map(|id| json!({
                            "name": id.as_str().and_then(|id| names.get(id)).cloned().unwrap_or(Value::Null),
                            "cardId": id,
                        }))
                        .collect::<Vec<_>>());
                }
                out
            })
            .collect()
    };
    let mut answer = json!({
        "deckId": deck_id,
        "list": variant,
        "format": check["formatName"],
        "formatKey": check["formatKey"],
        "checked": check["checked"],
        "problems": problems("issues"),
        "parked": problems("parked"),
    });
    if check["checked"] != json!(true) {
        answer["note"] = json!(unchecked_note(&check));
    }
    let Some(bracket) = check.get("bracket").filter(|b| !b.is_null()) else {
        answer["bracket"] = Value::Null;
        return Ok(answer);
    };
    let estimate = &bracket["estimate"];
    let reasons: Vec<Value> = rows(estimate, "reasons")
        .iter()
        .zip(rows(bracket, "reasons"))
        .map(|(r, sentence)| {
            json!({ "code": r["code"], "floor": r["floor"], "cards": r["cards"], "sentence": sentence })
        })
        .collect();
    let set = bracket["set"].as_i64().unwrap_or(0);
    answer["bracket"] = json!({
        "floor": estimate["floor"],
        "set": if set == 0 { json!("auto") } else { json!(set) },
        "warning": bracket["warning"],
        "reasons": reasons,
        "gameChangers": estimate["gameChangerNames"],
        "massLandDenial": estimate["massLandDenial"],
        "extraTurns": estimate["extraTurns"],
        "combos": short_list(&rows(estimate, "combos")),
        "possibleCombos": short_list(&rows(estimate, "possibleCombos")),
    });
    with_combo_data(
        &mut answer,
        &json!({ "fetchedAt": bracket["combosDownloadedAt"] }),
        Vec::new(),
    );
    Ok(answer)
}

/// `deck_shortfall`: the short rows, priced, with where else the user owns the card.
pub(super) async fn deck_shortfall(state: &Arc<AppState>, args: &Args) -> Result<Value, String> {
    let deck_id = args.required_int("deckId")?;
    let variant = list_arg(args)?;
    let limit = args.bounded("limit", 50, 1, 200)?;
    let offset = args.bounded("offset", 0, 0, i64::from(u32::MAX))?;
    let market = marketplace(state).await;
    let detail = run(
        state,
        "deck_get",
        json!({ "id": deck_id, "variant": variant, "marketplace": market }),
    )
    .await?;
    if detail.is_null() {
        return Err(no_deck(deck_id));
    }
    let mut answer = json!({ "deckId": deck_id, "list": variant, "marketplace": market });
    if detail["deck"]["virtualOnly"] == json!(true) {
        answer["kind"] = json!("virtual");
        answer["rows"] = json!([]);
        answer["total"] = json!(0);
        answer["note"] = json!(
            "This is a virtual deck, which tracks no cardboard: nothing in it is owned or short. \
             For what building it would take, find_cards with owned: true says which of its \
             cards the user owns."
        );
        return Ok(answer);
    }
    let live = variant == "live";
    let elsewhere: Map<String, Value> = if live {
        run(state, "deck_owned_elsewhere", json!({ "deckId": deck_id }))
            .await?
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|e| Some((e["oracleId"].as_str()?.to_owned(), e["places"].clone())))
            .collect()
    } else {
        Map::new()
    };
    let wished: Vec<(Value, Value)> = if live {
        run(state, "deck_missing_plan", json!({ "deckId": deck_id }))
            .await?
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|m| m["wishes"].as_array().is_some_and(|w| !w.is_empty()))
            .map(|m| (m["cardId"].clone(), m["finish"].clone()))
            .collect()
    } else {
        Vec::new()
    };

    let short: Vec<Value> = rows(&detail, "cards")
        .into_iter()
        .filter(|c| {
            c["categoryActive"] == json!(true)
                && c["ownedQuantity"].as_i64().unwrap_or(0) < c["quantity"].as_i64().unwrap_or(0)
        })
        .collect();
    let (mut missing, mut cost, mut unpriced, mut to_buy, mut to_buy_cost) = (0, 0.0, 0, 0, 0.0);
    let mut out = Vec::new();
    for c in &short {
        let wanted = c["quantity"].as_i64().unwrap_or(0);
        let have = c["ownedQuantity"].as_i64().unwrap_or(0).min(wanted);
        let lacking = wanted - have;
        let places = c["oracleId"]
            .as_str()
            .and_then(|o| elsewhere.get(o))
            .cloned();
        missing += lacking;
        let line_cost = c["unitPrice"].as_f64().map(|p| p * lacking as f64);
        match line_cost {
            Some(v) => cost += v,
            None => unpriced += lacking,
        }
        if live && places.is_none() {
            to_buy += lacking;
            to_buy_cost += line_cost.unwrap_or(0.0);
        }
        let mut row = pick(
            c,
            &[
                ("name", "name"),
                ("cardId", "cardId"),
                ("finish", "finish"),
                ("pile", "categoryName"),
            ],
        );
        row["wanted"] = json!(wanted);
        row["have"] = json!(have);
        row["missing"] = json!(lacking);
        row["unitPrice"] = money(&c["unitPrice"]);
        row["cost"] = line_cost.map_or(Value::Null, |v| money(&json!(v)));
        if live {
            row["elsewhere"] = json!(places
                .unwrap_or_else(|| json!([]))
                .as_array()
                .cloned()
                .unwrap_or_default()
                .iter()
                .map(|p| json!({
                    "place": p["name"].as_str().unwrap_or("the collection, in no folder"),
                    "kind": p["kind"].as_str().unwrap_or("root"),
                    "copies": p["quantity"],
                }))
                .collect::<Vec<_>>());
            row["onWishlist"] = json!(wished
                .iter()
                .any(|(id, finish)| *id == c["cardId"] && *finish == c["finish"]));
        }
        out.push(row);
    }
    answer["total"] = json!(out.len());
    answer["missing"] = json!(missing);
    answer["cost"] = money(&json!(cost));
    answer["unpriced"] = json!(unpriced);
    if live {
        answer["toBuy"] = json!(to_buy);
        answer["toBuyCost"] = money(&json!(to_buy_cost));
    } else {
        answer["note"] = json!(
            "On the theory list, have counts every copy the user owns that this deck could use, \
             wherever it is; where those copies sit is the actual list's question."
        );
    }
    let start = usize::try_from(offset).unwrap_or(usize::MAX);
    let take = usize::try_from(limit).unwrap_or(0);
    answer["rows"] = json!(out.into_iter().skip(start).take(take).collect::<Vec<_>>());
    Ok(answer)
}

/// `owned_for_deck`: owned cards the deck could play and does not.
pub(super) async fn owned_for_deck(state: &Arc<AppState>, args: &Args) -> Result<Value, String> {
    let deck_id = args.required_int("deckId")?;
    let variant = list_arg(args)?;
    let limit = args.bounded("limit", 20, 1, grimoire_core::deck_fits::MAX_LIMIT)?;
    let offset = args.bounded("offset", 0, 0, i64::from(u32::MAX))?;
    let words: Vec<String> = args
        .text("query")?
        .map(|q| q.split_whitespace().map(str::to_owned).collect())
        .unwrap_or_default();
    let filters = match args.0.get("filters") {
        None | Some(Value::Null) => Args(Map::new()),
        Some(Value::Object(map)) => Args(map.clone()),
        Some(_) => return Err("filters must be an object.".to_owned()),
    };
    let checked =
        super::filters::checked(state, &filters, &["types", "manaValues", "oracleTags"]).await?;
    let found = run(
        state,
        "deck_owned_fits",
        json!({
            "deckId": deck_id,
            "variant": variant,
            "words": words,
            "oracleTags": checked.oracle_tags.iter().map(|t| t.slug.clone()).collect::<Vec<_>>(),
            "types": checked.types,
            "manaValues": checked.mana_values,
            "limit": limit,
            "offset": offset,
        }),
    )
    .await?;
    if found.is_null() {
        return Err(no_deck(deck_id));
    }
    let cards: Vec<Value> = rows(&found, "cards")
        .iter()
        .map(|c| {
            pick(
                c,
                &[
                    ("name", "name"),
                    ("cardId", "cardId"),
                    ("typeLine", "typeLine"),
                    ("manaCost", "manaCost"),
                    ("owned", "owned"),
                    ("inOtherDecks", "inDecks"),
                    ("edhrecRank", "edhrecRank"),
                ],
            )
        })
        .collect();
    let mut answer = json!({
        "deckId": deck_id,
        "list": variant,
        "identity": identity_word(&found["identity"]),
        "format": found["format"],
        "total": found["total"],
        "cards": cards,
    });
    if found["identity"].is_null() {
        answer["note"] = json!("The deck has no cards yet, so colour narrows nothing.");
    }
    Ok(answer)
}

/// `draw_odds`: the hypergeometric chance of drawing what was named, turn by turn.
pub(super) async fn draw_odds(state: &Arc<AppState>, args: &Args) -> Result<Value, String> {
    let deck_id = args.required_int("deckId")?;
    let variant = list_arg(args)?;
    let want = args.bounded("want", 1, 0, 20)?;
    let mode = args
        .choice("mode", &["atLeast", "exactly", "atMost"], Some("atLeast"))?
        .unwrap_or_default();
    let hand = args.bounded("hand", 7, 1, 20)?;
    let turns = args.bounded("turns", 4, 0, 20)?;
    let on_the_play = args.switch("onThePlay")?.unwrap_or(true);
    let odds = run(
        state,
        "deck_draw_odds",
        json!({
            "deckId": deck_id,
            "variant": variant,
            "cards": args.texts("cards")?,
            "pile": args.text("pile")?,
            "cardType": args.text("type")?,
            "want": want,
            "mode": mode,
            "hand": hand,
            "turns": turns,
            "onThePlay": on_the_play,
        }),
    )
    .await?;
    if odds.is_null() {
        return Err(no_deck(deck_id));
    }
    let by_turn: Vec<Value> = rows(&odds, "byTurn")
        .iter()
        .map(|t| json!({ "turn": t["turn"], "cardsSeen": t["cardsSeen"], "chance": chance(&t["chance"]) }))
        .collect();
    let mut answer = pick(
        &odds,
        &[
            ("deckId", "deckId"),
            ("list", "variant"),
            ("library", "library"),
            ("successes", "successes"),
            ("matched", "matched"),
            ("want", "want"),
            ("mode", "mode"),
            ("hand", "hand"),
            ("onThePlay", "onThePlay"),
        ],
    );
    answer["openingHand"] = chance(&odds["openingHand"]);
    answer["byTurn"] = json!(by_turn);
    let unmatched = rows(&odds, "unmatched");
    if !unmatched.is_empty() {
        let named: Vec<&str> = unmatched.iter().filter_map(Value::as_str).collect();
        answer["unmatched"] = json!(named);
        answer["note"] = json!(format!(
            "Nothing in the library matched {}; get_deck lists its cards and piles.",
            named.join(", ")
        ));
    }
    Ok(answer)
}

#[cfg(test)]
mod tests {
    use super::super::tools::{call, Called};
    use crate::mcp::testing::state;
    use crate::sync::AppState;
    use grimoire_core::deck::fixtures::{input, kind_of, main_of};
    use grimoire_core::deck::{add_card, create_deck};
    use rusqlite::{params, Connection};
    use serde_json::{json, Value};
    use std::sync::Arc;

    fn seed(state: &AppState, f: impl FnOnce(&Connection)) {
        let conn = state.db.lock().unwrap();
        f(&conn);
    }

    async fn done(state: &Arc<AppState>, name: &str, args: Value) -> Value {
        match call(state, name, args).await {
            Called::Done(v) => v,
            Called::Refused(why) => panic!("{name} refused: {why}"),
            Called::NoSuchTool => panic!("{name} is not a tool"),
        }
    }

    async fn refused(state: &Arc<AppState>, name: &str, args: Value) -> String {
        match call(state, name, args).await {
            Called::Refused(why) => why,
            Called::Done(v) => panic!("{name} answered {v}"),
            Called::NoSuchTool => panic!("{name} is not a tool"),
        }
    }

    /// One Commander-legal printing, priced at TCGplayer.
    fn card(c: &Connection, id: &str, name: &str, type_line: &str, cost: &str, identity: &str) {
        let legal = grimoire_core::legalities::bit("commander").unwrap() as i64;
        c.execute(
            "INSERT INTO cards (id, oracle_id, name, set_code, collector_number, lang, layout,
                                rarity, released_at, type_line, type_mask, mana_cost, cmc,
                                colors, color_identity, legalities, legal_mask, prices, finishes,
                                produced_mana, raw)
             VALUES (?1, 'o-' || ?1, ?2, 'tst', ?1, 'en', 'normal', 'common', '2020-01-01', ?3,
                     ?4, ?5, ?6, ?7, ?7, '{\"commander\":\"legal\"}', ?8,
                     '{\"usd\":\"2.50\"}', '[\"nonfoil\"]', '', '{}')",
            params![
                id,
                name,
                type_line,
                i64::from(grimoire_core::cardtypes::type_mask(type_line)),
                cost,
                grimoire_core::deck_rules::engine::mana_value_of(Some(cost)),
                identity,
                legal
            ],
        )
        .unwrap();
    }

    fn own(c: &Connection, card_id: &str, quantity: i64) {
        grimoire_core::collection::add_entry(
            c,
            &grimoire_core::collection::EntryInput {
                card_id: card_id.to_owned(),
                finish: "nonfoil".to_owned(),
                quantity,
                ..Default::default()
            },
        )
        .unwrap();
    }

    fn put(c: &Connection, deck: i64, card: &str, pile: i64, quantity: i64) {
        add_card(c, deck, card, Some(pile), None, "live", None, quantity).unwrap();
    }

    /// A Commander deck led by a mono-green commander: two Llanowar Elves (one owned at the
    /// collection's root), a Counterspell outside the identity, a switched-off Maybeboard Forest;
    /// and, owned and not in it, a Rampant Growth.
    fn green_deck(c: &Connection) -> i64 {
        card(
            c,
            "cmd",
            "Green Leader",
            "Legendary Creature — Elf",
            "{2}{G}",
            "G",
        );
        card(
            c,
            "elf",
            "Llanowar Elves",
            "Creature — Elf Druid",
            "{G}",
            "G",
        );
        card(c, "counter", "Counterspell", "Instant", "{U}{U}", "U");
        card(c, "forest", "Forest", "Basic Land — Forest", "", "G");
        card(c, "ramp", "Rampant Growth", "Sorcery", "{1}{G}", "G");
        own(c, "elf", 1);
        own(c, "ramp", 2);
        let deck = create_deck(c, &input("Elves", "commander")).unwrap().id;
        put(c, deck, "cmd", kind_of(c, deck, "commander"), 1);
        let main = main_of(c, deck);
        put(c, deck, "elf", main, 2);
        put(c, deck, "counter", main, 1);
        put(c, deck, "forest", kind_of(c, deck, "maybe"), 1);
        deck
    }

    #[tokio::test]
    async fn get_deck_answers_the_deck_as_information_and_as_text() {
        let state = state("decks-get");
        let mut deck = 0;
        seed(&state, |c| deck = green_deck(c));
        let got = done(&state, "get_deck", json!({ "deckId": deck })).await;
        assert_eq!(got["kind"], "regular");
        assert_eq!(
            got["commanders"],
            json!([{ "name": "Green Leader", "cardId": "cmd" }])
        );
        assert_eq!(got["companion"], json!([]));
        assert_eq!(got["identity"], "G");
        assert_eq!(got["identityFrom"], "commanders");
        assert_eq!(got["settings"]["bracket"], "auto");
        assert_eq!(
            got["counts"],
            json!({ "sized": 4, "copies": 4, "inactive": 1 })
        );
        assert_eq!(got["problems"]["parked"], 0);
        assert!(got["problems"]["errors"].as_u64().unwrap() >= 2, "{got}");
        assert!(got["piles"].as_array().unwrap().len() >= 2);

        let text = done(&state, "get_deck", json!({ "deckId": deck, "as": "text" })).await;
        assert_eq!(text["textFormat"], "moxfield");
        let text = text["text"].as_str().unwrap();
        assert!(text.contains("2 Llanowar Elves"), "{text}");
        assert!(text.contains("Maybeboard\n1 Forest"), "{text}");
        let arena = done(
            &state,
            "get_deck",
            json!({ "deckId": deck, "as": "text", "textFormat": "arena" }),
        )
        .await;
        assert!(
            !arena["text"].as_str().unwrap().contains("Forest"),
            "{arena}"
        );

        let why = refused(&state, "get_deck", json!({ "deckId": 9999 })).await;
        assert!(why.contains("list_decks"), "{why}");
        let why = refused(
            &state,
            "get_deck",
            json!({ "deckId": deck, "textFormat": "arena" }),
        )
        .await;
        assert!(why.contains("as"), "{why}");
    }

    #[tokio::test]
    async fn check_deck_names_the_problems_the_bracket_floor_and_a_missing_combo_list() {
        let state = state("decks-check");
        let mut deck = 0;
        seed(&state, |c| deck = green_deck(c));
        let got = done(&state, "check_deck", json!({ "deckId": deck })).await;
        assert_eq!(got["checked"], true);
        let identity = got["problems"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["code"] == "color-identity")
            .expect("Counterspell is outside the commander's identity");
        assert_eq!(identity["cards"][0]["name"], "Counterspell");
        assert_eq!(got["bracket"]["floor"], 2);
        assert_eq!(got["bracket"]["set"], "auto");
        assert_eq!(got["comboData"]["downloadedAt"], Value::Null);
        assert!(got["note"]
            .as_str()
            .unwrap()
            .contains("not been downloaded"));

        let mut casual = 0;
        seed(&state, |c| {
            casual = create_deck(c, &input("Pile", "unspecified")).unwrap().id;
        });
        let got = done(&state, "check_deck", json!({ "deckId": casual })).await;
        assert_eq!(got["checked"], false);
        assert!(
            got["note"].as_str().unwrap().contains("not checked"),
            "{got}"
        );
        assert_eq!(got["bracket"], Value::Null);
    }

    #[tokio::test]
    async fn deck_stats_counts_the_active_piles() {
        let state = state("decks-stats");
        let mut deck = 0;
        seed(&state, |c| deck = green_deck(c));
        let got = done(&state, "deck_stats", json!({ "deckId": deck })).await;
        assert_eq!(got["sized"], 4);
        assert_eq!(got["lands"], 0, "the Forest is in a switched-off pile");
        assert_eq!(got["curve"][1]["cards"], 2);
        assert_eq!(got["curve"][1]["creatures"], 2);
        assert_eq!(got["colors"]["G"]["pips"], 3);
        assert_eq!(got["types"][0], json!({ "type": "Creature", "cards": 3 }));
    }

    #[tokio::test]
    async fn deck_shortfall_prices_what_is_missing_and_says_where_copies_are() {
        let state = state("decks-short");
        let mut deck = 0;
        seed(&state, |c| deck = green_deck(c));
        let got = done(&state, "deck_shortfall", json!({ "deckId": deck })).await;
        let rows = got["rows"].as_array().unwrap();
        let elf = rows.iter().find(|r| r["name"] == "Llanowar Elves").unwrap();
        assert_eq!(
            (elf["wanted"].clone(), elf["missing"].clone()),
            (json!(2), json!(2))
        );
        assert_eq!(elf["elsewhere"][0]["copies"], 1);
        assert_eq!(elf["cost"], 5.0);
        // The Elves are owned elsewhere; the commander and Counterspell are to buy.
        assert_eq!(got["toBuy"], 2);
        assert_eq!(got["toBuyCost"], 5.0);
        assert_eq!(got["total"], 3);
        assert!(
            rows.iter().all(|r| r["name"] != "Forest"),
            "a parked card is never short"
        );

        let mut proxies = 0;
        seed(&state, |c| {
            proxies = create_deck(c, &input("Proxies", "commander")).unwrap().id;
            c.execute("UPDATE decks SET virtual_only = 1 WHERE id = ?1", [proxies])
                .unwrap();
        });
        let got = done(&state, "deck_shortfall", json!({ "deckId": proxies })).await;
        assert_eq!(got["kind"], "virtual");
        assert!(got["note"].as_str().unwrap().contains("virtual"));
    }

    #[tokio::test]
    async fn owned_for_deck_offers_owned_cards_inside_the_identity_not_in_the_deck() {
        let state = state("decks-owned");
        let mut deck = 0;
        seed(&state, |c| deck = green_deck(c));
        let got = done(&state, "owned_for_deck", json!({ "deckId": deck })).await;
        assert_eq!(got["identity"], "G");
        assert_eq!(got["format"], "commander");
        assert_eq!(got["total"], 1);
        assert_eq!(got["cards"][0]["name"], "Rampant Growth");
        assert_eq!(got["cards"][0]["owned"], 2);

        let why = refused(
            &state,
            "owned_for_deck",
            json!({ "deckId": deck, "filters": { "oracleTags": ["nope"] } }),
        )
        .await;
        assert!(why.contains("find_tags"), "{why}");
        let why = refused(
            &state,
            "owned_for_deck",
            json!({ "deckId": deck, "filters": { "rarities": ["rare"] } }),
        )
        .await;
        assert!(why.contains("rarities"), "{why}");
    }

    #[tokio::test]
    async fn draw_odds_reads_the_library_turn_by_turn() {
        let state = state("decks-odds");
        let mut deck = 0;
        seed(&state, |c| deck = green_deck(c));
        let got = done(
            &state,
            "draw_odds",
            json!({ "deckId": deck, "cards": ["llanowar elves"], "hand": 1, "turns": 2 }),
        )
        .await;
        // Library: 2 Elves and a Counterspell (the commander and the parked Forest are not in it).
        assert_eq!(
            (got["library"].clone(), got["successes"].clone()),
            (json!(3), json!(2))
        );
        assert_eq!(got["byTurn"][0]["cardsSeen"], 1);
        assert_eq!(got["byTurn"][1]["cardsSeen"], 2);
        assert_eq!(got["byTurn"][1]["chance"], 1.0);

        let got = done(
            &state,
            "draw_odds",
            json!({ "deckId": deck, "cards": ["Black Lotus"] }),
        )
        .await;
        assert!(
            got["note"].as_str().unwrap().contains("Black Lotus"),
            "{got}"
        );
        let why = refused(&state, "draw_odds", json!({ "deckId": deck })).await;
        assert!(why.contains("Name what to draw"), "{why}");
        let why = refused(
            &state,
            "draw_odds",
            json!({ "deckId": deck, "type": "Goblin", "mode": "most" }),
        )
        .await;
        assert!(why.contains("mode"), "{why}");
    }
}
