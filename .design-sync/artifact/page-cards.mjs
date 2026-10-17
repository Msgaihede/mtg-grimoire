// Writes the Design System page cards (components/<Name>/preview.html) for the deck parts, the
// two card-image components, and Dropdown, TooltipProvider and WorkInProgress. The frame is the
// one every existing card in the system uses. The other cards were written by the 2026-09-20
// migration and live only in the artifact.
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
  // The migration's card, brought here on 2026-10-17 because `update` stopped taking `null`: the
  // shell reads `update.progress` for the header's update activity, and the old card's
  // `update: null` threw on mount and drew nothing. An idle update — nothing available, nothing
  // running — is what a window that has checked and found nothing holds.
  AppShell: [
    "chrome",
    `820 width=1280`,
    `
  if (!need('AppShell')) return;
  var C = NS.AppShell;
  var idle = { status: null, progress: null, busy: false, action: 'none', error: null,
    check: noop, download: noop, install: noop, openReleasePage: noop };
  render(h('div', { className: 'bg-bg border border-border rounded-lg overflow-hidden',
                    style: { height: '780px' } },
    h(C, { update: idle },
      h('div', { className: 'p-6 font-sans text-text' },
        h('h2', { className: 'font-heading text-lg' }, 'Home'),
        h('p', { className: 'text-dim text-sm' },
          'The shell draws the sidebar, the window header and the window chrome; this is the view slot the app fills.')))
  ));
`,
  ],
  // The three below joined the bundle on 2026-09-27 and had no page card until 2026-10-17.
  // Every one is drawn at rest: an open listbox or a shown tooltip is a fixed panel opened by
  // input, and the frame runs React 18, where `PopupListbox` gets no ref (NOTES).
  Dropdown: [
    "primitives",
    200,
    `
  if (!need('Dropdown') || !need('MultiDropdown')) return;
  var formats = [
    { value: 'standard', label: 'Standard' },
    { value: 'pioneer', label: 'Pioneer' },
    { value: 'modern', label: 'Modern' },
    { value: 'legacy', label: 'Legacy', disabled: true, title: 'No cards in this deck are legal here' },
    { value: 'commander', label: 'Commander' }
  ];
  function One(p) {
    var s = React.useState(p.value);
    return h(NS.Dropdown, { label: 'Format', options: formats, value: s[0], onChange: s[1], size: p.size, fill: p.fill });
  }
  function Many() {
    var s = React.useState(['modern', 'commander']);
    var picked = s[0];
    return h(NS.MultiDropdown, { label: 'Formats', options: formats, selected: picked,
      triggerLabel: picked.length === 0 ? 'Any format' : picked.length + ' formats',
      onToggle: function (v) {
        s[1](picked.indexOf(v) >= 0 ? picked.filter(function (x) { return x !== v; }) : picked.concat([v]));
      } });
  }
  render(h('div', null,
    h('div', { className: 'ds-wrap' },
      cell('Dropdown', h(One, { value: 'modern' })),
      cell('size="sm"', h(One, { value: 'commander', size: 'sm' })),
      cell('MultiDropdown', h(Many)),
      cell('fill, in a 240px cell', h('div', { style: { width: '240px' } }, h(One, { value: 'pioneer', fill: true })))),
    h('div', { style: { marginTop: '12px' } },
      note('Press a trigger to open its listbox. Rows are { value, label, icon?, hint?, disabled?, title? }; a disabled row\\u2019s title is the reason it gives.'))
  ));
`,
  ],
  TooltipProvider: [
    "primitives",
    200,
    `
  if (!need('useTooltip')) return;
  // The provider is GrimoirePreviewProvider's own: it mounts the one panel every hint opens in.
  function Hints() {
    var tip = NS.useTooltip();
    var btn = 'rounded-md border border-border bg-surface px-3 py-1.5 font-sans text-sm text-text';
    return h('div', { className: 'ds-wrap' },
      cell('A hint', h('button', Object.assign({ className: btn }, tip('Sorted by release date')), 'Release date')),
      cell('Interactive', h('button', Object.assign({ className: btn },
        tip('Needs review \\u2014 three cards have no printing picked', { interactive: true })), 'Needs review')),
      cell('Only when clipped', h('span', Object.assign({ className: 'block w-32 truncate font-sans text-sm text-text' },
        tip('Kamigawa: Neon Dynasty Commander', { whenClipped: true })), 'Kamigawa: Neon Dynasty Commander')));
  }
  render(h('div', null,
    h(Hints),
    h('div', { style: { marginTop: '12px' } },
      note('Hover or focus a control to open its hint. useTooltip() returns props to spread on the element itself \\u2014 no wrapper, never a title attribute.'))
  ));
`,
  ],
  WorkInProgress: [
    "primitives",
    260,
    `
  if (!need('WorkInProgress')) return;
  render(h('div', { className: 'bg-bg border border-border rounded-lg', style: { height: '220px' } },
    h(NS.WorkInProgress, { view: 'Playtesting' })));
`,
  ],
};

for (const [name, [group, height, body]] of Object.entries(cards)) {
  const dir = path.join(outRoot, "project", "components", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "preview.html"), head(group, height) + body + tail);
}
console.log("wrote", Object.keys(cards).join(", "));
