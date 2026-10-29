# Generated widgets: the json-render catalogue

A home widget the reader generates is declarative: a GraphQL document over the read graph
([graphql.md](graphql.md)) for its data, and a [json-render](https://json-render.dev) spec for its
picture. This page is the picture half — the **component catalogue** a spec may be built from, and
how each name is drawn with this app's own components. Added 2026-10-29; nothing on screen uses it
yet (the `custom` widget kind, the answer-to-state adapter and the MCP's spec tools come next).

It lives in [`packages/ui/features/home/generated/`](../../packages/ui/features/home/generated/).
Not to be confused with the **Widget catalogue** (`WidgetCatalogue.tsx`), the dialog a reader adds a
widget kind from.

## The files

| File                    | What                                                                                                                                                                                   |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `catalog.ts`            | `defineCatalog` — every component, action and function a spec may name, with zod props and a description written for the model. `catalog.prompt()`, `.validate(spec)`, `.jsonSchema()` |
| `registry.tsx`          | `defineRegistry` — each name drawn with the app's own part; the actions as store hand-offs; `useCatalogFunctions()`, the `$computed` functions at the reader's marketplace             |
| `SpecView.tsx`          | One spec drawn: the store, the providers, the registry, the handlers and the functions in one place, so a widget body, a story and a test draw a spec the same way                     |
| `examples.ts`           | Worked specs with the state an answer would hand them — the stories draw them, the suite validates and renders them                                                                    |
| `catalog.test.tsx`      | Catalogue and registry name the same components; the prompt names everything; every example validates; drawing, binding, visibility, `$computed`; each action's hand-off               |
| `catalog.prompt.md`     | `catalogPrompt()` — json-render's prompt with this app's rules (`CATALOG_RULES`). A committed snapshot                                                                                 |
| `catalog.contract.json` | `catalogContract()` — every component's props and every action's params as JSON Schema, with slots and descriptions. A committed snapshot                                              |

**The two snapshots are for the desktop's MCP server**, which hands a model the vocabulary and
checks its spec with no TypeScript running — the read graph's `schema.graphql`, for the picture
half. `catalog.test.tsx` holds both to the catalogue byte for byte (`toMatchFileSnapshot`);
`pnpm vitest run -u` rewrites them after an intended change, and `.prettierignore` keeps Prettier
off them. json-render's own `jsonSchema()` is not enough for that job: it describes the spec's
envelope, with every component's props an open object.

json-render is pinned exact (`@json-render/core` and `@json-render/react` 0.21.1, with `zod` 4 as
its peer): it is young and its minor versions move.

## What is in it

- **Layout and text**: `Stack`, `Grid`, `Divider`, `Panel` (`StatsCard`), `Heading`, `Text`,
  `ManaText`, `Price`, `Hint` (the app's tooltip over its children).
- **The home widgets' own parts** (`WidgetParts.tsx`): `Figures`, `Bars`, `RowList`, `Row`,
  `Message`, `Footer`. The measured ones (`Figures`, `Bars`, `RowList`) read the widget card's
  `WidgetFit` from `CatalogFitContext`; outside a card it is a medium card's.
- **Charts**: `PriceChart` (`priceHistory/PriceChart`, money over time), `ColumnChart` (the deck
  stats band's `BarChart` — card counts, `mana: true` for the curve's circled numerals),
  `PriceHistogram` (Draft & Packs' `ValueHistogram`, binned by its own `histogram`). A horizontal
  breakdown is `Bars`.
- **Cards and their marks**: `CardArt`, `CardTile`, `RarityGem`, `FinishMark`, `SetSymbol`,
  `CountTag`, `OwnedBadge`, `GameChangerMark`.
- **Inputs**, each the control the app already uses for the job:

  | Name            | Drawn by                       | Binds                 |
  | --------------- | ------------------------------ | --------------------- |
  | `Button`        | `BUTTON` (Settings' controls)  | — (`press` event)     |
  | `TextInput`     | an input with `TOUCH_FIELD`    | `value`               |
  | `Select`        | `Dropdown`                     | `value`               |
  | `Combobox`      | `Dropdown` with `searchable`   | `value`               |
  | `MultiSelect`   | `MultiDropdown`                | `selected` (an array) |
  | `Segmented`     | Draft & Packs' `Segmented`     | `value`               |
  | `RadioGroup`    | the importer's `ModeRadios`    | `value`               |
  | `Switch`        | `SWITCH` + `switchTone`        | `checked`             |
  | `ToggleChip`    | the Search page's `ToggleChip` | `pressed`             |
  | `NumberStepper` | `QuantityStepper`              | `value`               |
  | `PriceRange`    | the Search page's `PriceRange` | `min` and `max`       |

- **The widgets' own settings controls** (`WidgetSettingsPanel.tsx`, exported from there and used
  by the panel and the kinds' settings alike): `FieldGroup` (`SettingsGroup`), `ChoiceChips`
  (`SettingsChips` — every pick and the density), `Checkbox` (`SettingsCheck` — the `Show`
  switches), `Checklist` (Summary's figures), `CompactStepper` (`SettingsStepper` — `Wide`/`Tall`),
  `Picker` (`SettingsPicker` — the deck, folder and wishlist pickers, searchable past eight) and
  `CardSearch` (Price movers' `CardPicker`). `CardSearch` is the one input that reads data of its
  own: it searches the card database as the price movers' picker does.

Left out on purpose: dialogs, menus and the virtual table (a widget is a tile, not a page), and
controls tied to one feature's data (`TagChips`, `FinishRadios`, `SyncProgress`, `ValueChart`'s
history views).

A component is a picture of facts it is handed: nothing in the catalogue fetches, `CardSearch`'s
card search aside.

## Rules

- **Draw with the app's part, never a second idea of it.** `Figures` is `WidgetFigures`, `Row` is
  `WidgetRow`, `CardTile` is `CardTile`, `Price` is `formatPrice` — so a generated widget wears the
  app's tokens, sizes and press feedback, and a change to a part changes every widget built from it.
  `defineRegistry` types each entry against its catalogue props, so a prop renamed on one side is a
  compile error on the other, and the suite fails on a name on one side only.
- **Colours are words from the palette** (`accent`, `up`, `down`, `dim`, the five mana colours and
  colourless), never a free colour: `catalog.validate` refuses `#ff00ff`.
- **State has three parts.** The widget's GraphQL answer is the state root (`/decks/0/name` is
  the query's `decks` field); `/ui` is the widget's own inputs (a filter, a sort, a switch); and
  `/settings` is what the reader configures and keeps. A model seeds only `/ui` and `/settings`,
  never sample data for the query's fields — `CATALOG_RULES` overrides json-render's own rule,
  written for pages that invent their data. The examples keep the same layout.
- **Inputs write only the widget's own state** (`$bindState` under `/ui` or `/settings`). The
  graph is read-only and so is a widget: an input filters, sorts or switches what it draws, never
  the reader's data.
- **Actions navigate**, through the store hand-offs the hand-written widgets use and in their
  order (`setActiveView` before a one-shot like `setOpenDeckId`):

  | Action             | Goes to                                                    |
  | ------------------ | ---------------------------------------------------------- |
  | `openCard`         | a printing's card details                                  |
  | `openDeck`         | a deck in the editor                                       |
  | `openFolder`       | a collection or wishlist folder                            |
  | `openView`         | one of the app's pages                                     |
  | `showSet`          | Search, showing one set                                    |
  | `searchText`       | Search, showing what a text or query finds                 |
  | `showInCollection` | the Collection, filtered by a query                        |
  | `revealCard`       | the folder a card is filed in, filtered to it              |
  | `openDeckFolder`   | the Decks gallery, standing in one deck folder             |
  | `openReview`       | the Collection or Wishlist, its flagged rows only          |
  | `openSettings`     | Settings, one panel in view (Settings' own list, `nav.ts`) |
  | `openPriceHistory` | a printing's price history for one finish                  |
  | `openPrintings`    | the dialog of every printing of a card                     |
  | `goldfish`         | a deck's solo practice game (desktop only)                 |

  No action writes the reader's data; adding one is the owner's decision.

- **Two actions are the host's**: `refresh` (ask the widget's document again) and `saveSettings`
  (keep the state under a path — `/settings` — in the widget's stored config). `SpecView` answers
  them through its `host` prop; drawn without one (a story, a preview) they do nothing. The custom
  widget kind will be that host.
- **A `$item` in an action's params arrives as a state path.** json-render resolves it to the
  item's path (`/decks/1/id`), the shape its own `setState` needs, and its prompt tells a model so.
  The actions read such a param back from the spec's state (`valueOf` in `registry.tsx`); no value
  they take begins with `/`. That is why `SpecView` runs on a store of its own: the handlers read it.
- **Conclusions TypeScript owns are `$computed` functions**: `formatPrice` (at the reader's
  marketplace — a spec never spells a currency), `formatNumber`, `formatPercent`, `formatDate`.
- **Optional props are `.nullable()`**, json-render's convention: a model sends `null` for a prop it
  leaves out. Every element carries `children`, `[]` for a leaf — `validate` requires it.
- **Content security**: json-render renders React elements only — no `eval`, no `innerHTML`, no
  injected styles — so a spec stays inside `script-src 'self'` and `style-src 'self'`. `Grid`'s
  column count is an inline `style` attribute, which the policy allows.

## Stories

`Home/Generated/SpecView`: Decks (figures, a `repeat` of rows that open their deck, a `$template`
footer), Rarity (bars, a switch hiding them), Filter (rows narrowed by a chip and a price range
through `visible`), Settings (the widgets' settings controls, saved
through `saveSettings`), Cards (a wall of tiles over the fake's printings) and Gallery (one of every
component). Each spec sits in a box a widget of its footprint covers, with
that box's fit.
