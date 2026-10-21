// Bant/Fog Tron: Urza lands, color filters, fogs, Mystical Teachings, Stream of Thought.
import type { ActivatedDef, CardDef, CardInstance, Ctx, ManaColor } from '../types';
import type { Game } from '../game';
import { T, etb, tAll, tc, ti, tp } from './helpers';

type Script = Partial<CardDef>;

const ANY: ManaColor[][] = [['W'], ['U'], ['B'], ['R'], ['G']];

/** Urza's Tron: each piece makes more colorless mana when you control all three */
export const TRON_PIECES = ['Mine', 'Power-Plant', 'Tower'];
export const hasTron = (g: Game, pid: number) =>
  TRON_PIECES.every((p) => g.lands(pid as 0 | 1).some((l) => g.hasSubtype(l, p)));

const urzaLand = (amount: number): Script => ({
  activated: [
    {
      text: `{T}: Add {C}. With all three Urza lands, add ${'{C}'.repeat(amount)} instead.`,
      cost: { tap: true },
      producesFn: (g, card) => [Array<ManaColor>(hasTron(g, card.controller) ? amount : 1).fill('C')],
      resolve: async () => {},
    },
  ],
});

/** "{N}(, {T}): Add one mana of any color" — also used by auto-payment to fix colors */
const filter = (mana: string, tap: boolean): ActivatedDef => ({
  text: `${mana}${tap ? ', {T}' : ''}: Add one mana of any color.`,
  label: 'Filter mana',
  cost: { mana, tap },
  produces: ANY,
  resolve: async () => {},
});

async function searchToHand(c: Ctx, filterFn: (x: CardInstance) => boolean, prompt: string) {
  const found = await c.g.searchLibrary(c.me, filterFn, prompt);
  if (found) {
    c.g.log(`${c.g.players[c.me].name} reveals ${found.def.name}.`, c.me);
    c.g.moveCard(found, 'hand');
  }
  c.g.shuffle(c.me);
}

const drawOnEnter = etb('Draw a card.', async (c) => c.g.draw(c.me, 1));

export const tronScripts: Record<string, Script> = {
  "Urza's Mine": urzaLand(2),
  "Urza's Power Plant": urzaLand(2),
  "Urza's Tower": urzaLand(3),

  'Expedition Map': {
    activated: [
      {
        text: '{2}, {T}, Sacrifice: Search your library for a land card and put it into your hand.',
        label: 'Search for a land',
        cost: { mana: '{2}', tap: true, sacSelf: true },
        ai: 'utility',
        resolve: async (c) => searchToHand(c, (x) => c.g.isLand(x), 'Choose a land card'),
      },
    ],
  },
  'Prophetic Prism': { triggers: [drawOnEnter], activated: [filter('{1}', true)] },
  'Energy Refractor': { triggers: [drawOnEnter], activated: [filter('{2}', false)] },
  "Bonder's Ornament": {
    activated: [
      { text: '{T}: Add one mana of any color.', cost: { tap: true }, produces: ANY, resolve: async () => {} },
      {
        text: "{4}, {T}: Each player who controls a permanent named Bonder's Ornament draws a card.",
        label: 'Draw a card',
        cost: { mana: '{4}', tap: true },
        ai: 'draw',
        resolve: async (c) => {
          for (const p of [0, 1] as const) if (c.g.permanents(p).some((x) => x.def.name === "Bonder's Ornament")) c.g.draw(p, 1);
        },
      },
    ],
  },
  'Conduit Pylons': {
    triggers: [
      etb('Surveil 1.', async (c) => {
        const g = c.g;
        const top = g.players[c.me].library[0];
        if (!top) return;
        if (await g.yesNo(c.me, `Surveil 1: put ${top.def.name} into your graveyard? (No = keep it on top)`, 'surveil', top)) {
          g.moveCard(top, 'graveyard');
          g.log(`${g.players[c.me].name} surveils ${top.def.name} into the graveyard.`, c.me);
        } else g.log(`${g.players[c.me].name} keeps the top card.`, c.me);
      }),
    ],
    activated: [filter('{1}', true)],
  },

  'Behold the Multiverse': {
    spell: {
      resolve: async (c) => {
        await c.g.scry(c.me, 2);
        c.g.draw(c.me, 2);
      },
    },
    foretell: '{1}{U}',
    activated: [
      {
        text: 'Foretell — {2}: exile this card face down; cast it on a later turn for its foretell cost.',
        label: 'Foretell {2}',
        zone: 'hand',
        cost: { mana: '{2}' },
        special: true,
        ai: 'plot',
        canActivate: (g, card, pid) => g.active === pid,
        resolve: async (c) => {
          c.g.moveCard(c.src, 'exile');
          c.src.foretoldTurn = c.g.turn;
          c.g.log(`${c.g.players[c.me].name} foretells a card.`, c.me);
        },
      },
    ],
    ai: { kind: 'draw', reactive: true },
  },

  'Bramble Wurm': {
    triggers: [etb('You gain 5 life.', async (c) => c.g.gainLife(c.me, 5))],
    activated: [
      {
        text: '{2}{G}, Exile this card from your graveyard: You gain 5 life.',
        label: 'Gain 5 life',
        zone: 'graveyard',
        cost: { mana: '{2}{G}', exileSelf: true },
        ai: 'utility',
        resolve: async (c) => c.g.gainLife(c.me, 5),
      },
    ],
  },

  'Crop Rotation': {
    additionalCost: { kind: 'sacrifice', filter: (g, c) => g.isLand(c), prompt: 'Sacrifice a land' },
    spell: {
      resolve: async (c) => {
        const g = c.g;
        const found = await g.searchLibrary(c.me, (x) => g.isLand(x), 'Choose a land card to put onto the battlefield');
        if (found) {
          g.log(`${g.players[c.me].name} puts ${found.def.name} onto the battlefield.`, c.me);
          g.moveCard(found, 'battlefield', { controller: c.me });
        }
        g.shuffle(c.me);
      },
    },
    ai: { kind: 'other' },
  },

  "Moment's Peace": {
    spell: {
      resolve: async (c) => {
        c.g.preventCombatTurn = c.g.turn;
        c.g.log('All combat damage this turn will be prevented.', c.me);
      },
    },
    ai: { kind: 'fog', reactive: true },
  },
  Tangle: {
    spell: {
      resolve: async (c) => {
        const g = c.g;
        g.preventCombatTurn = g.turn;
        for (const a of g.attackers()) a.counters.frozen = 1;
        g.log("All combat damage this turn will be prevented; attackers don't untap next turn.", c.me);
        g.changed();
      },
    },
    ai: { kind: 'fog', reactive: true },
  },
  'Ethereal Haze': {
    spell: {
      resolve: async (c) => {
        c.g.preventCreatureTurn = c.g.turn;
        c.g.log('All damage creatures would deal this turn will be prevented.', c.me);
      },
    },
    ai: { kind: 'fog', reactive: true },
  },

  'Mystical Teachings': {
    spell: {
      resolve: async (c) =>
        searchToHand(c, (x) => x.def.types.includes('Instant') || x.def.keywords.includes('flash'), 'Choose an instant card or a card with flash'),
    },
    ai: { kind: 'draw', reactive: true },
  },
  Prohibit: {
    kicker: '{2}',
    spell: {
      targets: [T.spell('Choose target spell (mana value 2 or less, 4 or less if kicked)')],
      resolve: async (c) => {
        const s = ti(c);
        const limit = c.info.kicked ? 4 : 2;
        if (s && s.mv <= limit) c.g.counterItem(s);
        else if (s) c.g.log(`${s.card.def.name} is too expensive for Prohibit.`, c.me);
      },
    },
    ai: { kind: 'counter', reactive: true },
  },

  'Stream of Thought': {
    replicate: '{2}{U}{U}',
    spell: {
      targets: [T.player('Choose target player to mill four cards')],
      resolve: async (c) => {
        const g = c.g;
        const p = tp(c);
        const copies = 1 + (c.info.replicate ?? 0);
        if (copies > 1) g.log(`Stream of Thought is copied ${copies - 1} time${copies > 2 ? 's' : ''} (replicate).`, c.me);
        for (let i = 0; i < copies; i++) {
          if (p !== undefined) g.mill(p, 4);
          // you shuffle up to four cards from your graveyard into your library
          const gy = g.players[c.me].graveyard.filter((x) => x !== c.src);
          const back = await g.chooseCards(c.me, gy, 0, 4, 'Stream of Thought: shuffle up to four cards from your graveyard into your library', 'shuffleBack', c.src);
          for (const x of back) g.moveCard(x, 'library');
          if (back.length) {
            g.shuffle(c.me);
            g.log(`${g.players[c.me].name} shuffles ${back.map((x) => x.def.name).join(', ')} into their library.`, c.me);
          }
        }
      },
    },
    ai: { kind: 'other' },
  },
  'Weather the Storm': {
    storm: true,
    spell: {
      resolve: async (c) => {
        const copies = 1 + (c.info.storm ?? 0);
        if (copies > 1) c.g.log(`Storm: Weather the Storm is copied ${copies - 1} time${copies > 2 ? 's' : ''}.`, c.me);
        c.g.gainLife(c.me, 3 * copies);
      },
    },
    ai: { kind: 'other', reactive: true },
  },

  'Ancient Grudge': {
    spell: {
      targets: [T.permanent('Choose target artifact', (g, x) => g.isArtifact(x))],
      resolve: async (c) => {
        const t = tc(c);
        if (t) c.g.destroy(t);
      },
    },
    ai: { kind: 'artifactRemoval' },
  },
  'Breath Weapon': {
    spell: {
      resolve: async (c) => {
        for (const cr of c.g.creatures()) if (!c.g.hasSubtype(cr, 'Dragon')) c.g.dealDamage(c.src, cr, 2);
      },
    },
    ai: { kind: 'sweeper', amount: 2 },
  },
  'Circle of Protection: Blue': {
    activated: [
      {
        text: '{1}: The next time a blue source of your choice would deal damage to you this turn, prevent that damage.',
        label: 'Prevent damage from a blue source',
        cost: { mana: '{1}' },
        ai: 'utility',
        resolve: async (c) => {
          const p = c.g.players[c.me];
          p.copBlue = (p.copBlue ?? 0) + 1;
          c.g.log(`${p.name} is protected from the next blue source of damage this turn.`, c.me);
        },
      },
    ],
  },
  'Crypt Incursion': {
    spell: {
      targets: [T.player("Choose a player whose graveyard's creatures to exile")],
      resolve: async (c) => {
        const g = c.g;
        const p = tp(c);
        if (p === undefined) return;
        const creatures = g.players[p].graveyard.filter((x) => g.isCreature(x));
        for (const x of creatures) g.moveCard(x, 'exile');
        g.log(`${creatures.length} creature card(s) exiled.`, c.me);
        g.gainLife(c.me, 3 * creatures.length);
      },
    },
    ai: { kind: 'gyHate' },
  },
};

void tAll;
