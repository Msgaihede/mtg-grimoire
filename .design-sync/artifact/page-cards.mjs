// Writes the Design System page cards (components/<Name>/preview.html) for the deck parts and
// the two card-image components. The frame is the one every existing card in the system uses.
// Usage: node .design-sync/artifact/page-cards.mjs <pubDir>
import fs from "node:fs";
import path from "node:path";

const outRoot = process.argv[2];

const head = (group, height) => `<!-- @dsCard group="${group}" height=${height} -->
<div id="ds-root"></div>
<style>
  html, body { margin: 0; background: var(--color-bg, #14110e); }
  #ds-root { padding: 16px; box-sizing: border-box; }
  .ds-wrap { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-start; }
  .ds-wrap.ds-col { flex-direction: column; align-items: stretch; }
  .ds-cell { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .ds-cap { font-size: 11px; letter-spacing: .06em; text-transform: uppercase; }
  .ds-flush { padding: 0; }
</style>
<script>
(function () {
  var h = React.createElement;
  var NS = window.MtgGrimoire || {};
  var Provider = NS.GrimoirePreviewProvider || function (p) { return h(React.Fragment, null, p.children); };
  var root = document.getElementById('ds-root');
  var noop = function () {};

  function cell(caption, node) {
    return h('div', { className: 'ds-cell', key: caption },
      h('div', { className: 'ds-cap font-sans text-dim' }, caption), node);
  }
  function note(text) {
    return h('p', { className: 'font-sans text-dim text-sm' }, text);
  }
  function render(node) {
    try {
      // The art folder, stated: the frame may inline the bundle, which leaves it no script URL.
      ReactDOM.createRoot(root).render(h(Provider, { cardArt: '../../card-art/' }, node));
    } catch (e) {
      root.textContent = 'Preview did not render: ' + ((e && e.message) || e);
    }
  }
  function need(name) {
    if (NS[name]) return true;
    render(note(name + ' is not exported on window.MtgGrimoire in this frame.'));
    return false;
  }

`;
const tail = `})();
</script>
`;

const cards = {
  StackView: [
    "decks",
    760,
    `
  if (!need('StackView') || !need('deckGroups') || !need('MARKETPLACES')) return;
  // The Stacks desk as its Default story mounts it: the seeded deck grouped by category,
  // one currency for the whole screen, and the fixture's rule breaks.
  render(h('div', { style: { display: 'flex', height: '672px' } },
    h(NS.StackView, {
      groups: NS.deckGroups(),
      marketplace: NS.MARKETPLACES.tcgplayer,
      tracksCollection: true,
      violations: NS.deckViolations(),
      onSelect: noop
    })));
`,
  ],
  CardStack: [
    "decks",
    600,
    `
  if (!need('CardStack') || !need('deckCard') || !need('printing')) return;
  var P = NS.printing, D = NS.deckCard;
  var ramp = [
    D(P('lea', '288'), { quantity: 2, ownedQuantity: 1 }),
    D(P('mh2', '138'), { quantity: 1, ownedQuantity: 1 }),
    D(P('dom', '168'), { quantity: 1, ownedQuantity: 0 }),
    D(P('lea', '161'), { quantity: 1, ownedQuantity: 1 }),
    D(P('isd', '51'), { quantity: 1, ownedQuantity: 1 }),
    D(P('gtc', '148'), { quantity: 1, ownedQuantity: 1 })
  ];
  var box = { width: '224px' };
  render(h('div', { className: 'ds-wrap' },
    cell('A pile of six', h('div', { style: box },
      h(NS.CardStack, { cards: ramp, label: 'Ramp', currency: 'usd', onSelect: noop }))),
    cell('A pile of two', h('div', { style: box },
      h(NS.CardStack, { cards: ramp.slice(0, 2), label: 'Ramp', currency: 'usd', onSelect: noop })))
  ));
`,
  ],
  CardChin: [
    "cards",
    400,
    `
  if (!need('CardChin') || !need('CardArt') || !need('printing')) return;
  var bolt = NS.printing('lea', '161');
  var base = { rarity: 'rare', zoom: 1, setCode: 'c21', collectorNumber: '179',
    printingTitle: 'Commander 2021 \\u00b7 #179', money: '$12.32', seam: 'art' };
  function tile(over) {
    var props = {}; var k;
    for (k in base) props[k] = base[k];
    for (k in over) props[k] = over[k];
    return h('div', { style: { width: '200px' } },
      h(NS.CardArt, { cardId: bolt.id, name: bolt.name }),
      h(NS.CardChin, props));
  }
  render(h('div', { className: 'ds-wrap' },
    cell('Under a card', tile({})),
    cell('Foil', tile({ finish: 'foil' })),
    cell('Mythic, etched', tile({ rarity: 'mythic', finish: 'etched' }))
  ));
`,
  ],
  QuantityTag: [
    "decks",
    120,
    `
  if (!need('QuantityTag')) return;
  var C = NS.QuantityTag;
  function tag(props) { return h('div', { style: { display: 'flex' } }, h(C, props)); }
  render(h('div', { className: 'ds-wrap' },
    cell('Plain', tag({ quantity: 3, name: null, color: null, gameChanger: false })),
    cell('Labelled', tag({ quantity: 3, name: 'Ramp', color: '#00733e', gameChanger: false })),
    cell('Game changer', tag({ quantity: 1, name: 'Fast mana', color: '#d9b95c', gameChanger: true })),
    cell('Noted', tag({ quantity: 2, name: 'Ramp', color: '#00733e', gameChanger: false, noted: true })),
    cell('Crowned and noted', tag({ quantity: 12, name: null, color: null, gameChanger: true, noted: true }))
  ));
`,
  ],
  CardArt: [
    "cards",
    420,
    `
  if (!need('CardArt') || !need('printing')) return;
  var C = NS.CardArt;
  var box = { width: '220px' };
  var bolt = NS.printing('lea', '161');
  var states = [
    ['A card', { cardId: bolt.id, name: bolt.name }],
    ['Selected', { cardId: bolt.id, name: bolt.name, selected: true }],
    ['Game changer', { cardId: bolt.id, name: bolt.name, gameChanger: true }],
    ['Fallback (no card)', { cardId: null, name: 'Lightning Bolt' }]
  ];
  render(h('div', null,
    h('div', { className: 'ds-wrap' }, states.map(function (s) {
      return cell(s[0], h('div', { style: box }, h(C, s[1])));
    })),
    h('div', { style: { marginTop: '12px' } },
      note('Card images are the seeded fixture\\u2019s real printings, served from card-art/ beside the bundle. A cardId of null draws the fallback and fetches nothing.'))
  ));
`,
  ],
  CardImage: [
    "primitives",
    400,
    `
  if (!need('CardImage') || !need('printing') || !need('cardImageUrl')) return;
  var C = NS.CardImage;
  // A component inside the provider, so the art mode is set by the time the address is built.
  function Frames() {
    var bolt = NS.printing('lea', '161');
    var src = NS.cardImageUrl(bolt.id, 0, 'grid');
    return h('div', { className: 'ds-wrap' },
      cell('A card', h(C, { src: src, alt: bolt.name,
        className: 'rounded-lg bg-surface', style: { width: '244px', height: '340px' } })),
      cell('Decorative (alt="")', h(C, { src: src, alt: '',
        className: 'rounded-lg bg-surface', style: { width: '244px', height: '340px' } })));
  }
  render(h('div', null,
    h(Frames),
    h('div', { style: { marginTop: '12px' } },
      note('In the app the address is the mtgimg:// protocol\\u2019s; here cardImageUrl answers the fixture\\u2019s real printing from card-art/ beside the bundle.'))
  ));
`,
  ],
};

for (const [name, [group, height, body]] of Object.entries(cards)) {
  const dir = path.join(outRoot, "project", "components", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "preview.html"), head(group, height) + body + tail);
}
console.log("wrote", Object.keys(cards).join(", "));
