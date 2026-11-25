# Searching with Scryfall syntax in MTG Grimoire

MTG Grimoire reads Scryfall's search language, the one on scryfall.com, in every search box it
has. Three tools take it in their `syntax` argument:

| Tool | Searches |
| --- | --- |
| `find_cards` | every Magic card in the card database, one printing per card unless `allPrintings` |
| `search_collection` | the user's copies, by printing, finish and folder |
| `search_wishlist` | the user's wishes |

`syntax` is ANDed with everything else the tool takes: `find_cards`' `query`, `set` and `filters`,
the other two's `query` and `folderId`. Everything here reads; nothing changes the user's cards.

## The grammar

- **A term is a keyword, a sign and a value**: `t:goblin`, `cmc>=3`, `o:"draw a card"`. The signs
  are `:` `=` `!=` `>` `>=` `<` `<=`; which ones a keyword takes is in the reference below.
- **Terms side by side must all hold.** `or` between two terms means either, and AND binds tighter
  than OR, as on Scryfall: `t:goblin t:creature or t:elf` is a goblin creature, or an elf.
  Parentheses group: `(t:goblin or t:elf) c:r` is a red goblin or a red elf.
- **A `-` in front leaves out** a term or a group: `-t:creature`, `-(t:goblin or t:elf)`. `not:x`
  is `-is:x`.
- **Quotes hold a value with spaces**, double or single: `o:"enters the battlefield"`,
  `o:'can't block'`. An apostrophe inside a word is part of the word, so `Urza's` is one word.
- **Anything that is not a term is free text**: words of the card's name, and more (see "Free
  text" below). `-bolt` leaves out cards *named* bolt, `!"lightning bolt"` is one exact name and
  `name:bolt` is a name word.

```scryfall
t:goblin t:creature or t:elf
(t:goblin or t:elf) c:r
t:creature -(t:goblin or t:elf)
o:"enters the battlefield" -t:creature
bolt t:instant
!"lightning bolt"
not:reprint s:lea
```

## The traps

- **What a bare `:` means differs by keyword.** `c:rg` is "at least red and green" (`c>=rg`),
  while `id:rg` is "fits inside red-green" (`id<=rg`): the colour identity question a Commander
  deck asks. `cmc:3` is mana value exactly 3. The reference's "`:` means" column says, keyword by
  keyword.
- **`t:` and `o:` match the starts of words, not any part of one.** `o:draw` finds "draw" and
  "draws"; `o:raw` does not find "draw" as it would on Scryfall. Type lines are whole words, so `t:`
  agrees with Scryfall in practice. `o:` reads the rules text of every face, reminder text included.
- **`-bolt` leaves out by name only.** To leave out rules text, write `-o:bolt`.
- **Tags are Scryfall's tagger's, by name.** `otag:` is what a card does (`otag:removal`,
  `otag:ramp`), `atag:` what its art shows (`atag:dragon`). Spaces, hyphens and capitals do not
  matter (`otag:"card draw"` is `otag:card-draw`), but the tag must exist: look names up with
  `find_tags`. An unknown tag is refused with its closest names.
- **Colours** (`c:` and `id:`) take letters (`wubrg`, `c` for colourless), names (`red`, `azorius`,
  `esper`, `abzan`), `m` for multicoloured, or a count (`c=2`).
- **Rarity is ordered**: `r>=rare` is rare and mythic.
- **Mana costs compare symbols, not amounts**: `m:{G}{U}` has at least a green and a blue symbol,
  and `m<={3}{R}` does not find `{1}{R}`.
- **`usd`, `eur` and `tix` are Scryfall's prices** as of the last card sync. The user's own
  marketplace prices are `find_cards`' `filters.priceMin` and `filters.priceMax`.

```scryfall
id<=rg t:legendary t:creature
c:rg
c=2 t:instant
r>=rare s:neo
m:{G}{U} t:creature
otag:removal id<=b f:commander
atag:dragon -t:dragon
usd<1 f:pauper t:creature
```

## Free text, tool by tool

Every keyword means the same in all three tools. The free text does not:

- in `find_cards` and `search_collection` it matches the starts of words in the card's name, type
  line and rules text (`bolt` finds Lightning Bolt and Boltwing Marauder);
- in `search_wishlist` it matches part of the card's name, so a wish whose printing has left the
  card database still answers.

## What this app does not take

Scryfall's regular expressions (`o:/^{T}:/`), `~` for the card's own name (it is dropped: write
the rules text without it), `cube:`, `cheapest:`, `artists>` and `illustrations>` are not read
here, and neither are Scryfall's display keywords (`unique:`, `order:`, `direction:`, `prefer:`,
`display:`, `include:`): each tool answers in its own order, and `find_cards`' `allPrintings`
answers every printing. **A term the tools cannot apply as written is refused**, every one of them
in one answer, each with what its keyword takes:

```scryfall-refused
o:/^draw/
cube:vintage
order:usd
unique:prints
cmc>=banana
is:fetchlnad
t>goblin
t:
t:goblin or
(t:goblin
```

Fix the terms the refusal names and search again. If part of what the user asked cannot be said in
this syntax, tell them, rather than dropping it. To search for words that look like a term, put
the whole term in quotes: `"cmc>=banana"`.

## Questions and their searches

"Instants that draw a card, in blue":

```scryfall
t:instant o:"draw a card" c:u
```

"Goblins or elves with haste":

```scryfall
(t:goblin or t:elf) kw:haste
```

"Commanders for an Izzet deck":

```scryfall
is:commander id<=ur
```

"Green ramp for a Golgari Commander deck, three mana or less":

```scryfall
otag:ramp id<=bg f:commander cmc<=3
```

"Creatures whose power is greater than their toughness":

```scryfall
t:creature pow>tou
```

"Modern-legal one-drops that are not creatures":

```scryfall
f:modern cmc=1 -t:creature
```

"Mythics from Kamigawa: Neon Dynasty under $5":

```scryfall
s:neo r:mythic usd<5
```

"Cards banned in Commander":

```scryfall
banned:commander
```

"Which fetchlands do I own?", as a `search_collection` call:

```json
{ "name": "search_collection", "arguments": { "syntax": "is:fetchland" } }
```

"Every Japanese printing of Lightning Bolt", as a `find_cards` call:

```json
{ "name": "find_cards", "arguments": { "syntax": "!\"lightning bolt\" lang:ja", "allPrintings": true } }
```

"White or blue fliers for three or less, twenty of them":

```json
{ "name": "find_cards", "arguments": { "syntax": "t:creature kw:flying id<=wu cmc<=3", "limit": 20 } }
```

## Answering

- Say which search you ran when it is not obvious from the question, so the user can adjust it.
- If a search finds nothing, say so and suggest a looser one (fewer terms, `or` instead of side by
  side, `id<=` instead of `c:`).
- Only report what the tools answered.
