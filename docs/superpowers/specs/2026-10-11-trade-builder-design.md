# Trade builder — design

Issue: https://github.com/Msgaihede/mtg-grimoire/issues/363
Design canvas: https://claude.ai/artifact/HdQyG2orrcVMtJXWEgX4KB (sixteen boards, eight desktop
and eight phone; the owner reviewed each one on 2026-10-04).

The Trade view has been a rail entry and a `WorkInProgress` sentence since the rail got it. This
is the page behind it, on the desktop app and on the light app's phone face.

## 1. What a trade is

A trade has **two sides**. The left is the reader's — **You give** — and the right is whoever
they are trading with — **They give**. The other party is never named: the owner asked for
neutral wording, so the app says _they_, _them_ and _their side_ everywhere.

Each side is a list of **lines**. A line is one printing in one finish, a quantity, and where it
came from (`collection`, `search` or `scan`). Adding a printing and finish a side already holds
raises that line's quantity rather than making a second line.

A trade also carries:

- a **name** — optional at creation; left empty it is `Trade N`, N being the trade's own id;
- a **marketplace**, chosen at creation and defaulting to the reader's current one. Every price
  in the trade is that marketplace's, in its currency. TCGplayer and Cardmarket are always
  offered, because their prices arrive with the card data; Card Kingdom and Mana Pool only while
  one of them is the app's current marketplace, because only the selected feed is kept fresh;
- a **percentage of market price for each side**, 50–150 in steps of 5, both starting at 100;
- a **status**: `open`, `finished` or `archived`.

A reader can keep any number of trades, leave one and come back to it: every edit is saved as it
is made, and there is no Save.

## 2. Prices, percentages and the balance

**Rust supplies each line's unit price as a fact; TypeScript draws every conclusion from it.**
The arithmetic is in integer cents and is one module, `features/trade/trade.ts`:

- a line's unit price at a side's percentage is `round(unit × rate / 100)`;
- a line's value is that times its quantity; a side's total is the sum of its lines;
- a line with no price is an em dash, adds nothing to the total, and is counted — a total that
  silently leaves a card out is a number that lies by rounding down;
- the **balance** is `theirs − mine`. Positive: _You owe them_. Negative: _They owe you_. Zero:
  _Even trade_. An arrow points at the side that is owed.

When a side is not at 100%, every line and the side total show the adjusted figure with the full
one beside it, dimmed, as `$23.85 at 100%`.

**A trade that is no longer open keeps the prices it closed with.** Finishing or archiving writes
each line's unit price into the line; reopening clears them, and the trade is live again.

## 3. Lifecycle

| From | Action | To | What else happens |
| --- | --- | --- | --- |
| — | New trade | `open` | — |
| `open` | **Finish trade** | `finished` | prices frozen; the four options below run in one transaction; what they did is recorded on the trade |
| `open` | **Archive** | `archived` | prices frozen; the collection and the wishlist are not touched |
| `finished`, `archived` | Reopen | `open` | frozen prices cleared. **Nothing a finish did is undone** |
| any | Duplicate | a new `open` trade | same lines, percentages and marketplace; live prices |
| any | Delete | — | the trade and its lines |

**Finish trade** asks four questions, each a checkbox:

1. _Take the cards you gave out of your collection_ — on by default. Only copies the collection
   actually holds in that printing and finish are taken; the rest are left alone, and the dialog
   says how many before it is pressed. Copies outside any deck go first, plain ones before graded,
   signed or altered ones, and a proxy is never taken. **Copies filed in a deck are taken last,
   and the dialog names every deck that would be left short, in red** (see §4).
2. _Add the cards you received to your collection_ — on by default, with a folder picker.
3. _Take the cards you received off your wishlist_ — on by default.
4. _Put the cards you gave on your wishlist_ — off by default.

A trade that was finished once and reopened opens that dialog with all four **off**: the first
finish already did them, and a second pass would do them twice.

## 4. Adding and editing

- **Your side** adds from the **collection** (the default, and what the issue expects to be the
  common case) or from **all cards**. A line added from the collection is marked _from your
  collection_.
- **A card that sits in a deck can be traded, and it is never quiet about it.** The owner's rule,
  set after the first run on his own data, where two thirds of the collection is filed in decks:
  the quick select lists deck copies in a section of their own, under the ordinary ones, with each
  row naming its deck and drawn in red rather than gold; a line that would reach into a deck
  carries a red mark saying how many copies and which deck; and Finish trade says which decks will
  be short before it is pressed.
- **Their side** adds from all cards only. A line whose card is on the wishlist is marked _on
  your wishlist_.
- **Either side** can be scanned onto. The scanner opens over the trade with a _Scan onto_
  switch between the two sides; scanned cards collect in its list and go onto the side when Add
  is pressed, the way the Scanner's tray reaches the collection.
- A line's **printing**, **finish** and **quantity** are edited in place on desktop and in a
  sheet on the phone, and a line can be removed. The phone's sheet can also move a line to the
  other side.
- **On desktop a line's art opens the app's all-printings wall on that line** (issue #902), while
  the trade is open; a press there rewrites the line and closes. A line your collection supplies
  is shown only the printings you hold — the copies outside every deck first, then the decks' own
  under _In your decks_, captioned in red with the deck's name, the quick select's split — and a
  press takes that copy's finish too. Any other line, either side, is shown every printing, priced
  at the trade's marketplace, and keeps its finish where the printing has it.

## 5. Surfaces

Desktop: a trades pane on the left (New trade, Open, Archived), and the trade beside it — a
header (name, rename, when it was opened and whose prices it uses, More, Archive), the two sides
as two panels with a divider in the gap between them, and a balance panel underneath holding both
totals, the balance and **Finish trade**. On an open trade the divider's arrows are a button that
swaps every card to the other side (issue #936). New trade, Finish trade and the scanner are dialogs; the
percentage is a popover with one slider.

Phone: a trades list, then the trade as two columns with the balance and Finish trade above the
tab bar. Adding, editing, the percentage, finishing and New trade are bottom sheets; the scanner
is a full-screen view. Trade becomes a sixth tab.

The canvas is the reference for every measurement and string.

## 6. What is not in this change

- **Trades do not sync.** They are local to the device that made them.
- **The text mirror does not write them.**
- **No cash line.** A balance is shown, never settled.
