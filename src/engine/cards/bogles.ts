// Selesnya Bogles: hexproof creatures + Auras.
import type { CardDef, CardInstance, Ctx } from '../types';
import type { Game } from '../game';
import { T, cardOf, cycling, dies, etb, tAll, tc, tp } from './helpers';

type Script = Partial<CardDef>;

const enchantmentsOnBattlefield = (g: Game) => g.battlefield.filter((c) => g.is(c, 'Enchantment')).length;

async function searchToHand(c: Ctx, filter: (x: CardInstance) => boolean, prompt: string) {
  const found = await c.g.searchLibrary(c.me, filter, prompt);
  if (found) {
    c.g.log(`${c.g.players[c.me].name} reveals ${found.def.name}.`, c.me);
    c.g.moveCard(found, 'hand');
  }
  c.g.shuffle(c.me);
}

const isBasicLand = (x: CardInstance) => x.def.supertypes.includes('Basic') && x.def.types.includes('Land');

function fight(g: Game, a: CardInstance, b: CardInstance) {
  const pa = g.power(a);
  const pb = g.power(b);
  g.log(`${a.def.name} fights ${b.def.name}.`, a.controller);
  g.dealDamage(a, b, pa);
  g.dealDamage(b, a, pb);
}

export const boglesTokens: Record<string, CardDef> = {
  Warrior: {
    name: 'Warrior',
    manaCost: '',
    cmc: 0,
    typeLine: 'Token Creature — Warrior',
    types: ['Creature'],
    subtypes: ['Warrior'],
    supertypes: [],
    colors: ['W'],
    power: 1,
    toughness: 1,
    oracle: 'Vigilance',
    keywords: ['vigilance'],
    implemented: true,
    isToken: true,
  },
  'Eldrazi Spawn': {
    name: 'Eldrazi Spawn',
    manaCost: '',
    cmc: 0,
    typeLine: 'Token Creature — Eldrazi Spawn',
    types: ['Creature'],
    subtypes: ['Eldrazi', 'Spawn'],
    supertypes: [],
    colors: [],
    power: 0,
    toughness: 1,
    oracle: 'Sacrifice this token: Add {C}.',
    keywords: [],
    implemented: true,
    isToken: true,
    activated: [
      {
        text: 'Sacrifice this token: Add {C}.',
        label: 'Sacrifice: add {C}',
        cost: { sacSelf: true },
        produces: [['C']],
        resolve: async () => {},
      },
    ],
  },
};

export const boglesScripts: Record<string, Script> = {
  'Abundant Growth': {
    triggers: [etb('Draw a card.', async (c) => c.g.draw(c.me, 1))],
    grant: { anyColorMana: true },
  },
  'Utopia Sprawl': {
    chooseColor: 'mana',
    grant: { extraChosenMana: true },
  },
  'Ancestral Mask': {
    grant: {
      power: (g, host, self) => 2 * (enchantmentsOnBattlefield(g) - 1),
      toughness: (g, host, self) => 2 * (enchantmentsOnBattlefield(g) - 1),
    },
  },
  'Ethereal Armor': {
    grant: {
      power: (g, host, self) => g.permanents(self.controller).filter((x) => g.is(x, 'Enchantment')).length,
      toughness: (g, host, self) => g.permanents(self.controller).filter((x) => g.is(x, 'Enchantment')).length,
      keywords: () => ['first strike'],
    },
  },
  'Angelic Gift': {
    triggers: [etb('Draw a card.', async (c) => c.g.draw(c.me, 1))],
    grant: { keywords: () => ['flying'] },
  },
  'Armadillo Cloak': {
    grant: { power: 2, toughness: 2, keywords: () => ['trample'], damageLifegain: true },
  },
  'Spirit Link': {
    grant: { damageLifegain: true },
  },
  Rancor: {
    grant: { power: 2, keywords: () => ['trample'] },
    triggers: [
      dies('Return Rancor to its owner’s hand.', async (c) => {
        if (c.src.zone === 'graveyard') c.g.moveCard(c.src, 'hand');
      }),
    ],
  },
  'Cartouche of Solidarity': {
    triggers: [etb('Create a 1/1 white Warrior creature token with vigilance.', async (c) => void c.g.createToken(c.me, 'Warrior'))],
    grant: { power: 1, toughness: 1, keywords: () => ['first strike'] },
  },
  'Benevolent Blessing': {
    chooseColor: 'protection',
    grant: { protectionFromChosen: true },
  },
  "Sentinel's Eyes": {
    grant: { power: 1, toughness: 1, keywords: () => ['vigilance'] },
    flashback: {
      mana: '{W}',
      label: 'Escape {W} (exile two other graveyard cards)',
      canPay: (g, card, pid) => g.players[pid].graveyard.filter((x) => x !== card).length >= 2,
      pay: async (g, card, pid) => {
        const others = g.players[pid].graveyard.filter((x) => x !== card);
        const sel = await g.chooseCards(pid, others, 2, 2, 'Exile two other cards from your graveyard (escape)', 'evidence', card);
        for (const x of sel) g.moveCard(x, 'exile');
        return sel.length === 2;
      },
    },
  },
  'Silhana Ledgewalker': {
    canBeBlockedBy: (g, attacker, blocker) => g.hasKeyword(blocker, 'flying'),
  },
  "Heliod's Pilgrim": {
    triggers: [
      etb('You may search your library for an Aura card and put it into your hand.', async (c) =>
        searchToHand(c, (x) => x.def.subtypes.includes('Aura'), 'Choose an Aura card'),
      ),
    ],
  },
  'Malevolent Rumble': {
    spell: {
      resolve: async (c) => {
        const g = c.g;
        const top = g.players[c.me].library.slice(0, 4);
        g.log(`${g.players[c.me].name} reveals ${top.map((x) => x.def.name).join(', ')}.`, c.me);
        const perms = top.filter((x) => g.isPermanentCard(x));
        const pick = await g.chooseCards(c.me, perms, 0, 1, 'You may put a permanent card into your hand', 'reveal', c.src);
        for (const x of pick) g.moveCard(x, 'hand');
        for (const x of top) if (x.zone === 'library') g.moveCard(x, 'graveyard');
        g.createToken(c.me, 'Eldrazi Spawn');
      },
    },
    ai: { kind: 'draw' },
  },
  Bushwhack: {
    spell: {
      modes: [
        {
          text: 'Search your library for a basic land card and put it into your hand',
          resolve: async (c) => searchToHand(c, isBasicLand, 'Choose a basic land card'),
        },
        {
          text: 'Target creature you control fights target creature you don’t control',
          targets: [
            T.creature('Choose a creature you control', (g, x, me) => x.controller === me),
            T.creature('Choose a creature you don’t control', (g, x, me) => x.controller !== me),
          ],
          resolve: async (c) => {
            const a = tc(c, 0);
            const b = tc(c, 1);
            if (a && b) fight(c.g, a, b);
          },
        },
      ],
    },
    ai: { kind: 'other' },
  },
  'Ram Through': {
    spell: {
      targets: [
        T.creature('Choose a creature you control', (g, x, me) => x.controller === me),
        T.creature('Choose a creature you don’t control', (g, x, me) => x.controller !== me),
      ],
      resolve: async (c) => {
        const g = c.g;
        const a = tc(c, 0);
        const b = tc(c, 1);
        if (!a || !b) return;
        const p = g.power(a);
        if (g.hasKeyword(a, 'trample')) {
          const lethal = g.hasKeyword(a, 'deathtouch') ? 1 : Math.max(0, g.toughness(b) - b.damage);
          g.dealDamage(a, b, Math.min(p, lethal));
          if (p > lethal) g.dealDamage(a, b.controller, p - lethal);
        } else g.dealDamage(a, b, p);
      },
    },
    ai: { kind: 'removal' },
  },
  'Thraben Charm': {
    spell: {
      modes: [
        {
          text: 'Deal damage equal to twice the number of creatures you control to target creature',
          targets: [T.creature()],
          resolve: async (c) => {
            const t = tc(c);
            if (t) c.g.dealDamage(c.src, t, 2 * c.g.creatures(c.me).length);
          },
        },
        {
          text: 'Destroy target enchantment',
          targets: [T.permanent('Choose target enchantment', (g, x) => g.is(x, 'Enchantment'))],
          resolve: async (c) => {
            const t = tc(c);
            if (t) c.g.destroy(t);
          },
        },
        {
          text: "Exile target player's graveyard",
          targets: [T.player("Choose a player whose graveyard to exile")],
          resolve: async (c) => {
            const p = tp(c);
            if (p !== undefined) c.g.exileGraveyard(p);
          },
        },
      ],
    },
    ai: { kind: 'removal' },
  },
  'Call Damage Control': {
    spell: {
      targets: [
        T.graveyardCard(
          'Choose up to two artifact, creature, enchantment or land cards in your graveyard',
          (g, x, me) => x.owner === me && ['Artifact', 'Creature', 'Enchantment', 'Land'].some((t) => g.is(x, t)),
          1,
          2,
        ),
      ],
      resolve: async (c) => {
        for (const x of tAll(c, 0)) c.g.moveCard(x, 'hand');
      },
    },
    ai: { kind: 'draw' },
  },
  'Flaring Pain': {
    spell: {
      resolve: async (c) => {
        c.g.preventionTurn = c.g.turn;
        c.g.log("Damage can't be prevented this turn.", c.me);
      },
    },
    ai: { kind: 'other', reactive: true },
  },
  'Scattershot Archer': {
    activated: [
      {
        text: '{T}: Deal 1 damage to each creature with flying.',
        label: '1 damage to each flyer',
        cost: { tap: true },
        ai: 'damage',
        resolve: async (c) => {
          for (const cr of c.g.creatures()) if (c.g.hasKeyword(cr, 'flying')) c.g.dealDamage(c.src, cr, 1);
        },
      },
    ],
  },
  'Ash Barrens': {
    activated: [
      {
        text: 'Basic landcycling {1}: search for a basic land card and put it into your hand.',
        label: 'Basic landcycling {1}',
        zone: 'hand',
        cost: { mana: '{1}', discardSelf: true },
        ai: 'cycle',
        resolve: async (c) => searchToHand(c, isBasicLand, 'Choose a basic land card'),
      },
    ],
  },
  'Sheltering Landscape': {
    activated: [
      {
        text: '{T}: Add {C}.',
        cost: { tap: true },
        produces: [['C']],
        resolve: async () => {},
      },
      {
        text: '{T}, Sacrifice: Search for a basic Mountain, Forest, or Plains, put it onto the battlefield tapped.',
        label: 'Fetch basic land',
        cost: { tap: true, sacSelf: true },
        ai: 'utility',
        resolve: async (c) => {
          const g = c.g;
          const found = await g.searchLibrary(
            c.me,
            (x) => isBasicLand(x) && ['Mountain', 'Forest', 'Plains'].some((s) => x.def.subtypes.includes(s)),
            'Choose a basic Mountain, Forest, or Plains',
          );
          if (found) g.moveCard(found, 'battlefield', { tapped: true, controller: c.me });
          g.shuffle(c.me);
        },
      },
      cycling('{R}{G}{W}'),
    ],
  },
};

void cardOf;
