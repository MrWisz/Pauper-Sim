// Mono-Green Elves: mana elves, Priest of Titania, Timberwatch Elf, Quirion Ranger, Avenging Hunter (initiative).
import type { ActivatedDef, CardDef, CardInstance, Ctx, ManaColor } from '../types';
import type { Game } from '../game';
import { T, cycling, etb, tAll, tc, tempPT } from './helpers';

type Script = Partial<CardDef>;

/** Elves on the battlefield (both sides; Changelings count) */
const elvesOnBattlefield = (g: Game) => g.creatures().filter((c) => g.hasSubtype(c, 'Elf')).length;

const isBasicLand = (c: CardInstance) => c.def.supertypes.includes('Basic') && c.def.types.includes('Land');

async function searchToHand(c: Ctx, filter: (x: CardInstance) => boolean, prompt: string) {
  const found = await c.g.searchLibrary(c.me, filter, prompt);
  if (found) {
    c.g.log(`${c.g.players[c.me].name} reveals ${found.def.name}.`, c.me);
    c.g.moveCard(found, 'hand');
  }
  c.g.shuffle(c.me);
}

const forestcycling = (cost: string): ActivatedDef => ({
  text: `Forestcycling ${cost}: discard this card, search for a Forest card and put it into your hand.`,
  label: `Forestcycling ${cost}`,
  zone: 'hand',
  cost: { mana: cost, discardSelf: true },
  ai: 'cycle',
  resolve: async (c) => searchToHand(c, (x) => c.g.hasSubtype(x, 'Forest'), 'Choose a Forest card'),
});

const plot = (cost: string): ActivatedDef => ({
  text: `Plot ${cost}: exile this card; cast it free on a later turn.`,
  label: `Plot ${cost}`,
  zone: 'hand',
  cost: { mana: cost },
  sorcery: true,
  special: true,
  ai: 'plot',
  resolve: async (c) => {
    c.g.moveCard(c.src, 'exile');
    c.src.plottedTurn = c.g.turn;
    c.g.log(`${c.src.def.name} is plotted.`, c.me);
  },
});

const token = (name: string, typeLine: string, types: string[], subtypes: string[], extra: Partial<CardDef>): CardDef => ({
  name,
  manaCost: '',
  cmc: 0,
  typeLine,
  types,
  subtypes,
  supertypes: [],
  colors: [],
  oracle: '',
  keywords: [],
  implemented: true,
  isToken: true,
  ...extra,
});

export const elvesTokens: Record<string, CardDef> = {
  Food: token('Food', 'Token Artifact — Food', ['Artifact'], ['Food'], {
    oracle: '{2}, {T}, Sacrifice this token: You gain 3 life.',
    activated: [
      {
        text: '{2}, {T}, Sacrifice: You gain 3 life.',
        label: 'Gain 3 life',
        cost: { mana: '{2}', tap: true, sacSelf: true },
        ai: 'utility',
        resolve: async (c) => c.g.gainLife(c.me, 3),
      },
    ],
  }),
  Treasure: token('Treasure', 'Token Artifact — Treasure', ['Artifact'], ['Treasure'], {
    oracle: '{T}, Sacrifice this token: Add one mana of any color.',
    activated: [
      {
        text: '{T}, Sacrifice: Add one mana of any color.',
        label: 'Sacrifice for mana',
        cost: { tap: true, sacSelf: true },
        produces: [['W'], ['U'], ['B'], ['R'], ['G']],
        resolve: async () => {},
      },
    ],
  }),
  Skeleton: token('Skeleton', 'Token Creature — Skeleton', ['Creature'], ['Skeleton'], {
    colors: ['B'],
    power: 4,
    toughness: 1,
    oracle: 'Menace',
    keywords: ['menace'],
  }),
};

export const elvesScripts: Record<string, Script> = {
  'Priest of Titania': {
    activated: [
      {
        text: '{T}: Add {G} for each Elf on the battlefield.',
        cost: { tap: true },
        producesFn: (g) => [Array<ManaColor>(Math.max(1, elvesOnBattlefield(g))).fill('G')],
        resolve: async () => {},
      },
    ],
  },
  'Timberwatch Elf': {
    activated: [
      {
        text: '{T}: Target creature gets +X/+X until end of turn, where X is the number of Elves on the battlefield.',
        label: 'Pump +X/+X',
        cost: { tap: true },
        targets: [T.creature('Choose a creature to get +X/+X')],
        ai: 'damage',
        resolve: async (c) => {
          const t = tc(c);
          const x = elvesOnBattlefield(c.g);
          if (t) {
            tempPT(c.g, t, x, x);
            c.g.log(`${t.def.name} gets +${x}/+${x} until end of turn.`, c.me);
          }
        },
      },
    ],
  },
  'Quirion Ranger': {
    activated: [
      {
        text: 'Return a Forest you control to its owner’s hand: Untap target creature. Activate only once each turn.',
        label: 'Return a Forest: untap a creature',
        cost: { returnPermanent: { filter: (g, x) => g.hasSubtype(x, 'Forest'), prompt: 'Return a Forest you control to its owner’s hand' } },
        oncePerTurn: true,
        targets: [T.creature('Choose a creature to untap')],
        ai: 'utility',
        resolve: async (c) => {
          const t = tc(c);
          if (t) {
            t.tapped = false;
            c.g.log(`${t.def.name} untaps.`, c.me);
            c.g.changed();
          }
        },
      },
    ],
  },
  'Avenging Hunter': {
    triggers: [etb('You take the initiative.', async (c) => c.g.takeInitiative(c.me))],
  },
  'Generous Ent': {
    triggers: [etb('Create a Food token.', async (c) => void c.g.createToken(c.me, 'Food'))],
    activated: [forestcycling('{1}')],
  },
  'Gingerbread Cabin': {
    entersTapped: (g, card) => g.lands(card.controller).filter((x) => x !== card && g.hasSubtype(x, 'Forest')).length < 3,
    triggers: [
      {
        text: 'When this land enters untapped, create a Food token.',
        event: 'etb',
        match: (g, self, ev) => ev.type === 'etb' && ev.card === self && !self.tapped,
        resolve: async (c) => void c.g.createToken(c.me, 'Food'),
      },
    ],
  },
  'Land Grant': {
    spell: { resolve: async (c) => searchToHand(c, (x) => c.g.hasSubtype(x, 'Forest'), 'Choose a Forest card') },
    altCosts: [
      {
        label: 'Reveal your hand (no lands in it) instead of paying',
        canPay: (g, card, pid) => !g.players[pid].hand.some((x) => x !== card && g.isLand(x)),
        pay: async (g, card, pid) => {
          const rest = g.players[pid].hand.filter((x) => x !== card);
          g.log(`${g.players[pid].name} reveals their hand: ${rest.map((x) => x.def.name).join(', ') || 'nothing else'}.`, pid);
          return true;
        },
      },
    ],
    ai: { kind: 'draw' },
  },
  'Lead the Stampede': {
    spell: {
      resolve: async (c) => {
        const g = c.g;
        const top = g.players[c.me].library.slice(0, 5);
        const creatures = top.filter((x) => g.isCreature(x));
        const pick = await g.chooseCards(c.me, creatures, 0, creatures.length, 'Lead the Stampede: put any number of creature cards into your hand', 'takeAll', c.src);
        for (const x of pick) {
          g.log(`${g.players[c.me].name} reveals ${x.def.name}.`, c.me);
          g.moveCard(x, 'hand');
        }
        for (const x of top) if (x.zone === 'library') g.moveCard(x, 'library', { bottom: true });
      },
    },
    ai: { kind: 'draw' },
  },
  'Winding Way': {
    spell: {
      modes: ['creature', 'land'].map((kind) => ({
        text: `Choose ${kind}: reveal the top four; ${kind} cards go to your hand, the rest to your graveyard`,
        resolve: async (c: Ctx) => {
          const g = c.g;
          const top = g.players[c.me].library.slice(0, 4);
          g.log(`${g.players[c.me].name} reveals ${top.map((x) => x.def.name).join(', ')}.`, c.me);
          for (const x of top) {
            const hit = kind === 'creature' ? g.isCreature(x) : g.isLand(x);
            g.moveCard(x, hit ? 'hand' : 'graveyard');
          }
        },
      })),
    },
    ai: { kind: 'draw' },
  },
  'Masked Vandal': {
    triggers: [
      etb(
        'You may exile a creature card from your graveyard. If you do, exile target artifact or enchantment an opponent controls.',
        async (c) => {
          const g = c.g;
          const t = tc(c);
          const fodder = g.players[c.me].graveyard.filter((x) => g.isCreature(x));
          if (!t || !fodder.length) return;
          const pick = await g.chooseCards(c.me, fodder, 0, 1, `Masked Vandal: exile a creature card from your graveyard to exile ${t.def.name}?`, 'exileGraveyard', c.src);
          if (!pick.length) return;
          g.moveCard(pick[0], 'exile');
          g.exile(t);
        },
        [T.permanent('Choose target artifact or enchantment an opponent controls', (g, x, me) => x.controller !== me && (g.isArtifact(x) || g.is(x, 'Enchantment')))],
      ),
    ],
  },
  'Nyxborn Hydra': {
    // bestowed: enchanted creature gets +1/+1 for each +1/+1 counter on this Aura, and reach and trample
    grant: {
      power: (g, host, self) => self.counters['+1/+1'] ?? 0,
      toughness: (g, host, self) => self.counters['+1/+1'] ?? 0,
      keywords: () => ['reach', 'trample'],
    },
  },
  'Sagu Wildling': {
    triggers: [etb('You gain 3 life.', async (c) => c.g.gainLife(c.me, 3))],
    omen: {
      name: 'Roost Seek',
      manaCost: '{G}',
      text: 'Search your library for a basic land card, put it into your hand, then shuffle. (Also shuffle this card.)',
      resolve: async (c) => searchToHand(c, isBasicLand, 'Roost Seek: choose a basic land card'),
    },
  },
  'Spinewoods Paladin': {
    triggers: [etb('You gain 3 life.', async (c) => c.g.gainLife(c.me, 3))],
    activated: [plot('{3}{G}')],
  },
  'Vitu-Ghazi Inspector': {
    additionalCost: { kind: 'collectEvidence', optional: true, amount: 6, prompt: 'Collect evidence 6' },
    triggers: [
      {
        text: 'If evidence was collected, put a +1/+1 counter on target creature and you gain 2 life.',
        event: 'etb',
        match: (g, self, ev) => ev.type === 'etb' && ev.card === self && !!self.castInfo?.evidence,
        targets: [T.creature('Choose a creature to get a +1/+1 counter')],
        resolve: async (c) => {
          const t = tc(c);
          if (t) t.counters['+1/+1'] = (t.counters['+1/+1'] ?? 0) + 1;
          c.g.gainLife(c.me, 2);
        },
      },
    ],
  },
  'Monstrous Emergence': {
    castCondition: (g, card, pid) => g.creatures(pid).length > 0 || g.players[pid].hand.some((x) => x !== card && g.isCreature(x)),
    spell: {
      targets: [T.creature('Choose target creature')],
      resolve: async (c) => {
        const g = c.g;
        const t = tc(c);
        if (!t) return;
        const options = [...g.creatures(c.me), ...g.players[c.me].hand.filter((x) => x !== c.src && g.isCreature(x))];
        const pick = await g.chooseCards(c.me, options, 1, 1, 'Monstrous Emergence: choose a creature you control or reveal a creature card from your hand', 'strongest', c.src);
        const chosen = pick[0];
        if (!chosen) return;
        const power = chosen.zone === 'battlefield' ? g.power(chosen) : chosen.def.power ?? 0;
        if (chosen.zone === 'hand') g.log(`${g.players[c.me].name} reveals ${chosen.def.name}.`, c.me);
        g.dealDamage(c.src, t, power);
      },
    },
    ai: { kind: 'removal' },
  },
  'Pulse of Murasa': {
    spell: {
      targets: [T.graveyardCard('Choose a creature or land card in a graveyard', (g, x) => g.isCreature(x) || g.isLand(x))],
      resolve: async (c) => {
        for (const x of tAll(c, 0)) c.g.moveCard(x, 'hand');
        c.g.gainLife(c.me, 6);
      },
    },
    ai: { kind: 'other', reactive: true },
  },
};

void cycling;
