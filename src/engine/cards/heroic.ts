// Mono-White Heroic: heroic creatures grown by cheap Auras and counters, umbra armor, rebound protection.
import type { CardDef, Ctx, ManaColor, TriggerDef } from '../types';
import type { Game } from '../game';
import { T, castTrigger, tc, tempPT } from './helpers';

type Script = Partial<CardDef>;

const COLOR_NAMES: Record<string, string> = { W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green' };

/** "Heroic — Whenever you cast a spell that targets this creature, ..." */
const heroic = (text: string, resolve: (c: Ctx) => Promise<void>): TriggerDef => ({
  text: `Heroic — Whenever you cast a spell that targets this creature, ${text}`,
  event: 'cast',
  match: (g, self, ev) =>
    ev.type === 'cast' &&
    ev.controller === self.controller &&
    g.stack.some((s) => s.kind === 'spell' && s.card === ev.card && s.targets.flat().some((t) => t.kind === 'card' && t.id === self.id)),
  resolve,
});

const addCounter = (g: Game, c: Ctx['src'], n = 1) => {
  if (c.zone !== 'battlefield') return;
  c.counters['+1/+1'] = (c.counters['+1/+1'] ?? 0) + n;
  g.log(`${c.def.name} gets a +1/+1 counter.`, c.controller);
  g.changed();
};

const heroicCounter = heroic('put a +1/+1 counter on it.', async (c) => addCounter(c.g, c.src));

/** Homestead Courage / Dig Site Inventory */
const counterAndVigilance: Script = {
  spell: {
    targets: [T.creature('Choose target creature you control', (g, x, me) => x.controller === me)],
    resolve: async (c) => {
      const t = tc(c);
      if (!t) return;
      addCounter(c.g, t);
      if (!t.tempKeywords.includes('vigilance')) t.tempKeywords.push('vigilance');
    },
  },
  ai: { kind: 'pump' },
};

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

export const heroicTokens: Record<string, CardDef> = {
  Spirit: token('Spirit', 'Token Creature — Spirit', ['Creature'], ['Spirit'], {
    colors: ['W', 'B'],
    power: 1,
    toughness: 1,
    oracle: 'Flying',
    keywords: ['flying'],
  }),
};

export const heroicScripts: Record<string, Script> = {
  'Lagonna-Band Trailblazer': { triggers: [heroicCounter] },
  'Akroan Skyguard': { triggers: [heroicCounter] },
  'Seeker of the Way': {
    triggers: [
      castTrigger(
        'Prowess. Whenever you cast a noncreature spell, this creature gets +1/+1 and gains lifelink until end of turn.',
        (g, spell) => !g.isCreature(spell),
        async (c) => {
          if (c.src.zone !== 'battlefield') return;
          tempPT(c.g, c.src, 1, 1);
          if (!c.src.tempKeywords.includes('lifelink')) c.src.tempKeywords.push('lifelink');
        },
      ),
    ],
  },
  'Hyena Umbra': {
    umbraArmor: true,
    grant: { power: 1, toughness: 1, keywords: () => ['first strike'] },
  },
  // the targeting rule lives in Game.candidates (Flagbearer subtype)
  'Standard Bearer': {},
  'Shield of Duty and Reason': { grant: { protection: ['G', 'U'] } },
  'Mask of Law and Grace': { grant: { protection: ['B', 'R'] } },
  'Homestead Courage': counterAndVigilance,
  'Dig Site Inventory': counterAndVigilance,
  'Emerge Unscathed': {
    rebound: true,
    spell: {
      targets: [T.creature('Choose target creature you control', (g, x, me) => x.controller === me)],
      resolve: async (c) => {
        const g = c.g;
        const t = tc(c);
        if (!t) return;
        const opts: ManaColor[][] = [['W'], ['U'], ['B'], ['R'], ['G']];
        const r = await g.ask<number | null>(c.me, { type: 'color', player: c.me, options: opts, source: c.src, purpose: 'protection' });
        const col = opts[r ?? 0][0];
        t.tempProtections = [...(t.tempProtections ?? []), col];
        g.log(`${t.def.name} gains protection from ${COLOR_NAMES[col]} until end of turn.`, c.me);
        g.changed();
      },
    },
    ai: { kind: 'pump', reactive: true },
  },
  'Beckon Apparition': {
    spell: {
      targets: [T.graveyardCard('Choose target card in a graveyard')],
      resolve: async (c) => {
        const t = tc(c);
        if (t && t.zone === 'graveyard') c.g.exile(t);
        c.g.createToken(c.me, 'Spirit');
      },
    },
    ai: { kind: 'gyHate' },
  },
};
