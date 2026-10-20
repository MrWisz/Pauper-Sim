import type { CardDef, CardInstance, Ctx, PlayerId } from '../types';
import type { Game } from '../game';
import {
  T,
  cardOf,
  castTrigger,
  combatDamageTrigger,
  counterIf,
  cycling,
  damageT,
  dies,
  equipAbility,
  etb,
  isColor,
  ltb,
  mana,
  ninjutsu,
  spellIs,
  tAll,
  tc,
  tempPT,
  ti,
  tp,
  tRaw,
} from './helpers';
import { boglesScripts, boglesTokens } from './bogles';
import { blueTerrorScripts, blueTerrorTokens } from './blueterror';

/** Behaviour overrides keyed by card name. Base stats come from cardData.json. */
export type Script = Partial<CardDef>;

const nonCreatureSpell = (g: Game, c: CardInstance) => !g.isCreature(c);
const instantOrSorcery = (g: Game, c: CardInstance) => g.is(c, 'Instant') || g.is(c, 'Sorcery');
const isMountain = (g: Game, c: CardInstance) => g.hasSubtype(c, 'Mountain');
const artifactOrCreature = (g: Game, c: CardInstance) => g.isArtifact(c) || g.isCreature(c);

async function sacrificeChosen(g: Game, pid: PlayerId, filter: (c: CardInstance) => boolean, n: number, prompt: string) {
  const cands = g.permanents(pid).filter(filter);
  if (cands.length < n) return false;
  const chosen = await g.chooseCards(pid, cands, n, n, prompt, 'sacrifice');
  for (const c of chosen) g.sacrifice(c);
  return chosen.length === n;
}

const plot = (cost: string) => ({
  text: `Plot ${cost}: exile this card; cast it free on a later turn.`,
  label: `Plot ${cost}`,
  zone: 'hand' as const,
  cost: { mana: cost },
  sorcery: true,
  special: true,
  ai: 'plot' as const,
  resolve: async (c: Ctx) => {
    c.g.moveCard(c.src, 'exile');
    c.src.plottedTurn = c.g.turn;
    c.g.log(`${c.src.def.name} is plotted.`, c.me);
  },
});

const drawCardText = (n: number) => `Draw ${n === 1 ? 'a card' : n + ' cards'}`;

export const tokenScripts: Record<string, CardDef> = {
  Blood: token('Blood', 'Token Artifact — Blood', ['Artifact'], ['Blood'], [], undefined, {
    oracle: '{1}, {T}, Discard a card, Sacrifice this artifact: Draw a card.',
    activated: [
      {
        text: '{1}, {T}, Discard a card, Sacrifice: Draw a card.',
        label: 'Rummage',
        cost: { mana: '{1}', tap: true, discard: 1, sacSelf: true },
        ai: 'draw',
        resolve: async (c) => c.g.draw(c.me, 1),
      },
    ],
  }),
  Clue: token('Clue', 'Token Artifact — Clue', ['Artifact'], ['Clue'], [], undefined, {
    oracle: '{2}, Sacrifice this artifact: Draw a card.',
    activated: [
      {
        text: '{2}, Sacrifice: Draw a card.',
        label: 'Investigate',
        cost: { mana: '{2}', sacSelf: true },
        ai: 'draw',
        resolve: async (c) => c.g.draw(c.me, 1),
      },
    ],
  }),
  Map: token('Map', 'Token Artifact — Map', ['Artifact'], ['Map'], [], undefined, {
    oracle: '{1}, {T}, Sacrifice this artifact: Target creature you control explores. Activate only as a sorcery.',
    activated: [
      {
        text: '{1}, {T}, Sacrifice: Target creature you control explores.',
        label: 'Explore',
        cost: { mana: '{1}', tap: true, sacSelf: true },
        sorcery: true,
        targets: [T.creature('Choose a creature you control to explore', (g, c, me) => c.controller === me)],
        ai: 'utility',
        resolve: async (c) => {
          const t = tc(c);
          if (t) await c.g.explore(t);
        },
      },
    ],
  }),
  Hero: token('Hero', 'Token Creature — Hero', ['Creature'], ['Hero'], [], [1, 1], { oracle: '' }),
};

function token(
  name: string,
  typeLine: string,
  types: string[],
  subtypes: string[],
  colors: any[],
  pt: [number, number] | undefined,
  extra: Partial<CardDef>,
): CardDef {
  return {
    name,
    manaCost: '',
    cmc: 0,
    typeLine,
    types,
    subtypes,
    supertypes: [],
    colors,
    power: pt?.[0],
    toughness: pt?.[1],
    oracle: '',
    keywords: [],
    implemented: true,
    isToken: true,
    ...extra,
  };
}

export const scripts: Record<string, Script> = {
  // ─────────────────────────── LANDS ───────────────────────────
  'Jagged Barrens': {
    entersTapped: true,
    triggers: [etb('Deal 1 damage to target opponent.', async (c) => damageT(c, 0, 1), [T.opponent()])],
  },
  'Razortrap Gorge': {
    entersTapped: (g) => !g.players.some((p) => p.life <= 13),
  },
  'Bojuka Bog': {
    entersTapped: true,
    triggers: [
      etb(
        "Exile target player's graveyard.",
        async (c) => {
          const p = tp(c);
          if (p !== undefined) c.g.exileGraveyard(p);
        },
        [T.player("Choose a player whose graveyard to exile")],
      ),
    ],
    ai: { kind: 'gyHate' },
  },
  'Seething Landscape': {
    activated: [
      mana(['C']),
      {
        text: '{T}, Sacrifice: Search for a basic Island, Swamp, or Mountain, put it onto the battlefield tapped.',
        label: 'Fetch basic land',
        cost: { tap: true, sacSelf: true },
        ai: 'utility',
        resolve: async (c) => {
          const g = c.g;
          const found = await g.searchLibrary(
            c.me,
            (x) => x.def.supertypes.includes('Basic') && ['Island', 'Swamp', 'Mountain'].some((s) => x.def.subtypes.includes(s)),
            'Choose a basic Island, Swamp, or Mountain',
          );
          if (found) g.moveCard(found, 'battlefield', { tapped: true, controller: c.me });
          g.shuffle(c.me);
        },
      },
      cycling('{U}{B}{R}'),
    ],
  },
  'Rakdos Carnarium': karoo(),
  'Dimir Aqueduct': karoo(),

  // ─────────────────────────── RED ───────────────────────────
  'Voldaren Epicure': {
    triggers: [
      etb('Deal 1 damage to each opponent. Create a Blood token.', async (c) => {
        c.g.dealDamage(c.src, c.opp, 1);
        c.g.createToken(c.me, 'Blood');
      }),
    ],
  },
  'Kessig Flamebreather': {
    triggers: [
      castTrigger('Deal 1 damage to each opponent.', nonCreatureSpell, async (c) => c.g.dealDamage(c.src, c.opp, 1)),
    ],
  },
  Guttersnipe: {
    triggers: [
      castTrigger('Deal 2 damage to each opponent.', instantOrSorcery, async (c) => c.g.dealDamage(c.src, c.opp, 2)),
    ],
  },
  'Faithless Looting': {
    spell: {
      resolve: async (c) => {
        c.g.draw(c.me, 2);
        await c.g.discard(c.me, 2);
      },
    },
    flashback: { mana: '{2}{R}' },
    ai: { kind: 'draw' },
  },
  'Grab the Prize': {
    additionalCost: { kind: 'discard', prompt: 'Discard a card to cast Grab the Prize' },
    spell: {
      resolve: async (c) => {
        c.g.draw(c.me, 2);
        const d = c.info.discarded;
        if (d && !d.def.types.includes('Land')) c.g.dealDamage(c.src, c.opp, 2);
      },
    },
    ai: { kind: 'draw' },
  },
  'Highway Robbery': {
    spell: {
      resolve: async (c) => {
        const g = c.g;
        const opts = [...g.players[c.me].hand, ...g.lands(c.me)];
        const pick = await g.chooseCards(c.me, opts, 0, 1, 'Highway Robbery: discard a card from your hand OR sacrifice a land you control to draw two cards (or skip)', 'discard', c.src);
        if (!pick.length) return;
        if (pick[0].zone === 'hand') g.discardCards(c.me, pick);
        else g.sacrifice(pick[0]);
        g.draw(c.me, 2);
      },
    },
    activated: [plot('{1}{R}')],
    ai: { kind: 'draw' },
  },
  'Lava Dart': {
    spell: { targets: [T.any()], resolve: async (c) => damageT(c, 0, 1) },
    flashback: {
      altLabel: '— Sacrifice a Mountain',
      canPay: (g, card, pid) => g.permanents(pid).some((x) => isMountain(g, x)),
      pay: (g, card, pid) => sacrificeChosen(g, pid, (x) => isMountain(g, x), 1, 'Sacrifice a Mountain'),
    },
    ai: { kind: 'burn', amount: 1 },
  },
  'Lightning Bolt': {
    spell: { targets: [T.any()], resolve: async (c) => damageT(c, 0, 3) },
    ai: { kind: 'burn', amount: 3 },
  },
  'Fiery Temper': {
    spell: { targets: [T.any()], resolve: async (c) => damageT(c, 0, 3) },
    ai: { kind: 'burn', amount: 3 },
  },
  Fireblast: {
    spell: { targets: [T.any()], resolve: async (c) => damageT(c, 0, 4) },
    altCosts: [
      {
        label: 'Sacrifice two Mountains',
        canPay: (g, card, pid) => g.permanents(pid).filter((x) => isMountain(g, x)).length >= 2,
        pay: (g, card, pid) => sacrificeChosen(g, pid, (x) => isMountain(g, x), 2, 'Sacrifice two Mountains'),
      },
    ],
    ai: { kind: 'burn', amount: 4 },
  },
  'End the Festivities': {
    spell: {
      resolve: async (c) => {
        c.g.dealDamage(c.src, c.opp, 1);
        for (const cr of c.g.creatures(c.opp)) c.g.dealDamage(c.src, cr, 1);
      },
    },
    ai: { kind: 'sweeper', amount: 1 },
  },
  Pyroblast: {
    spell: {
      modes: [
        {
          text: 'Counter target spell if it’s blue',
          targets: [T.spell('Choose target spell')],
          resolve: async (c) => counterIf(c, (s) => isColor(s.card, 'U')),
        },
        {
          text: 'Destroy target permanent if it’s blue',
          targets: [T.permanent('Choose target permanent', () => true)],
          resolve: async (c) => {
            const t = tc(c);
            if (t && isColor(t, 'U')) c.g.destroy(t);
          },
        },
      ],
    },
    ai: { kind: 'blast', reactive: true },
  },
  'Red Elemental Blast': {
    spell: {
      modes: [
        {
          text: 'Counter target blue spell',
          targets: [T.spell('Choose target blue spell', (g, s) => isColor(s.card, 'U'))],
          resolve: async (c) => counterIf(c, () => true),
        },
        {
          text: 'Destroy target blue permanent',
          targets: [T.permanent('Choose target blue permanent', (g, x) => isColor(x, 'U'))],
          resolve: async (c) => {
            const t = tc(c);
            if (t) c.g.destroy(t);
          },
        },
      ],
    },
    ai: { kind: 'blast', reactive: true },
  },
  'Relic of Progenitus': {
    activated: [
      {
        text: '{T}: Target player exiles a card from their graveyard.',
        label: 'Exile a graveyard card',
        cost: { tap: true },
        targets: [T.player('Choose target player')],
        ai: 'never',
        resolve: async (c) => {
          const p = tp(c);
          if (p === undefined) return;
          const gy = c.g.players[p].graveyard;
          const sel = await c.g.chooseCards(p, [...gy], 1, 1, 'Exile a card from your graveyard', 'exileGraveyard');
          for (const x of sel) c.g.exile(x);
        },
      },
      {
        text: '{1}, Exile Relic of Progenitus: Exile all graveyards. Draw a card.',
        label: 'Exile all graveyards',
        cost: { mana: '{1}', exileSelf: true },
        ai: 'utility',
        resolve: async (c) => {
          c.g.exileGraveyard(0);
          c.g.exileGraveyard(1);
          c.g.draw(c.me, 1);
        },
      },
    ],
  },
  'Cast into the Fire': {
    spell: {
      modes: [
        {
          text: 'Deal 1 damage to each of up to two target creatures',
          targets: [{ ...T.creature('Choose up to two target creatures'), min: 1, max: 2 }],
          resolve: async (c) => {
            for (const t of tAll(c, 0)) c.g.dealDamage(c.src, t, 1);
          },
        },
        {
          text: 'Exile target artifact',
          targets: [T.permanent('Choose target artifact', (g, x) => g.isArtifact(x))],
          resolve: async (c) => {
            const t = tc(c);
            if (t) c.g.exile(t);
          },
        },
      ],
    },
    ai: { kind: 'artifactRemoval' },
  },
  'Searing Blaze': {
    spell: {
      targets: [
        T.player('Choose target player'),
        {
          kind: 'permanent',
          prompt: 'Choose target creature that player controls',
          filter: (g, t, ctx) => {
            const c = cardOf(g, t);
            const p = ctx.chosen[0]?.[0];
            return !!c && g.isCreature(c) && (!p || (p.kind === 'player' && c.controller === p.pid));
          },
        },
      ],
      resolve: async (c) => {
        const n = c.g.players[c.me].landEnteredThisTurn ? 3 : 1;
        const p = tp(c, 0);
        const cr = tc(c, 1);
        if (p !== undefined) c.g.dealDamage(c.src, p, n);
        if (cr) c.g.dealDamage(c.src, cr, n);
      },
    },
    ai: { kind: 'removal', amount: 3 },
  },
  'Smash to Smithereens': {
    spell: {
      targets: [T.permanent('Choose target artifact', (g, x) => g.isArtifact(x))],
      resolve: async (c) => {
        const t = tc(c);
        if (!t) return;
        const ctl = t.controller;
        c.g.destroy(t);
        c.g.dealDamage(c.src, ctl, 3);
      },
    },
    ai: { kind: 'artifactRemoval' },
  },
  'Galvanic Blast': {
    spell: {
      targets: [T.any()],
      resolve: async (c) => damageT(c, 0, c.g.artifacts(c.me).length >= 3 ? 4 : 2),
    },
    ai: { kind: 'burn', amount: 2 },
  },
  'Krark-Clan Shaman': {
    activated: [
      {
        text: 'Sacrifice an artifact: Deal 1 damage to each creature without flying.',
        label: 'Sac artifact: 1 to each non-flyer',
        cost: { sacrifice: { filter: (g, c) => g.isArtifact(c), prompt: 'Sacrifice an artifact' } },
        ai: 'damage',
        resolve: async (c) => {
          for (const cr of c.g.creatures()) if (!c.g.hasKeyword(cr, 'flying')) c.g.dealDamage(c.src, cr, 1);
        },
      },
    ],
  },
  'Makeshift Munitions': {
    activated: [
      {
        text: '{1}, Sacrifice an artifact or creature: Deal 1 damage to any target.',
        label: 'Sac: 1 damage',
        cost: { mana: '{1}', sacrifice: { filter: artifactOrCreature, prompt: 'Sacrifice an artifact or creature' } },
        targets: [T.any()],
        ai: 'damage',
        resolve: async (c) => damageT(c, 0, 1),
      },
    ],
  },
  Vandalblast: {
    spell: {
      targets: [T.permanent("Choose target artifact you don't control", (g, x, me) => g.isArtifact(x) && x.controller !== me)],
      resolve: async (c) => {
        if (c.info.method === 'overload') {
          for (const a of c.g.artifacts(c.opp)) c.g.destroy(a);
        } else {
          const t = tc(c);
          if (t) c.g.destroy(t);
        }
      },
    },
    overload: '{4}{R}',
    ai: { kind: 'artifactRemoval' },
  },

  // ─────────────────────────── BLACK ───────────────────────────
  'Alms of the Vein': {
    spell: {
      targets: [T.opponent()],
      resolve: async (c) => {
        const p = tp(c);
        if (p === undefined) return;
        c.g.loseLife(p, 3);
        c.g.gainLife(c.me, 3);
      },
    },
    ai: { kind: 'drain', amount: 3 },
  },
  "Vampire's Kiss": {
    spell: {
      targets: [T.player()],
      resolve: async (c) => {
        const p = tp(c);
        if (p !== undefined) c.g.loseLife(p, 2);
        c.g.gainLife(c.me, 2);
        c.g.createToken(c.me, 'Blood');
        c.g.createToken(c.me, 'Blood');
      },
    },
    ai: { kind: 'drain', amount: 2 },
  },
  'Dark Withering': {
    spell: {
      targets: [T.creature('Choose target nonblack creature', (g, x) => !isColor(x, 'B'))],
      resolve: async (c) => {
        const t = tc(c);
        if (t) c.g.destroy(t);
      },
    },
    ai: { kind: 'removal' },
  },
  'Extract a Confession': {
    additionalCost: { kind: 'collectEvidence', optional: true, amount: 6, prompt: 'Collect evidence 6' },
    spell: {
      resolve: async (c) => {
        const g = c.g;
        const crs = g.creatures(c.opp);
        if (!crs.length) return;
        let pool = crs;
        if (c.info.evidence) {
          const max = Math.max(...crs.map((x) => g.power(x)));
          pool = crs.filter((x) => g.power(x) === max);
        }
        const sel = await g.chooseCards(c.opp, pool, 1, 1, 'Sacrifice a creature', 'sacrifice');
        for (const x of sel) g.sacrifice(x);
      },
    },
    ai: { kind: 'removal' },
  },
  'Faerie Macabre': {
    activated: [
      {
        text: 'Discard this card: Exile up to two target cards from graveyards.',
        label: 'Discard: exile 2 graveyard cards',
        zone: 'hand',
        cost: { discardSelf: true },
        targets: [T.graveyardCard('Choose up to two cards in graveyards', undefined, 1, 2)],
        ai: 'never',
        resolve: async (c) => {
          for (const x of tAll(c, 0)) c.g.exile(x);
        },
      },
    ],
  },
  'Nihil Spellbomb': {
    activated: [
      {
        text: "{T}, Sacrifice: Exile target player's graveyard.",
        label: 'Exile a graveyard',
        cost: { tap: true, sacSelf: true },
        targets: [T.player("Choose a player whose graveyard to exile")],
        ai: 'utility',
        resolve: async (c) => {
          const p = tp(c);
          if (p !== undefined) c.g.exileGraveyard(p);
        },
      },
    ],
    triggers: [
      dies('You may pay {B}. If you do, draw a card.', async (c) => {
        const g = c.g;
        const cost = { generic: 0, W: 0, U: 0, B: 1, R: 0, G: 0, C: 0 };
        if (!g.canPay(c.me, cost)) return;
        if (await g.yesNo(c.me, 'Pay {B} to draw a card (Nihil Spellbomb)?', 'payToDraw', c.src)) {
          if (await g.payMana(c.me, cost)) g.draw(c.me, 1);
        }
      }),
    ],
  },
  'Agony Warp': {
    spell: {
      targets: [T.creature('Target creature gets -3/-0'), T.creature('Target creature gets -0/-3')],
      resolve: async (c) => {
        const a = tc(c, 0);
        const b = tc(c, 1);
        if (a) tempPT(c.g, a, -3, 0);
        if (b) tempPT(c.g, b, 0, -3);
      },
    },
    ai: { kind: 'removal', amount: 3, reactive: true },
  },
  'Baleful Strix': {
    triggers: [etb('Draw a card.', async (c) => c.g.draw(c.me, 1))],
  },
  'Cast Down': {
    spell: {
      targets: [T.creature('Choose target nonlegendary creature', (g, x) => !x.def.supertypes.includes('Legendary'))],
      resolve: async (c) => {
        const t = tc(c);
        if (t) c.g.destroy(t);
      },
    },
    ai: { kind: 'removal' },
  },
  'Snuff Out': {
    spell: {
      targets: [T.creature('Choose target nonblack creature', (g, x) => !isColor(x, 'B'))],
      resolve: async (c) => {
        const t = tc(c);
        if (t) c.g.destroy(t);
      },
    },
    altCosts: [
      {
        label: 'Pay 4 life',
        canPay: (g, card, pid) => g.players[pid].life > 4 && g.permanents(pid).some((x) => g.hasSubtype(x, 'Swamp')),
        pay: async (g, card, pid) => {
          g.loseLife(pid, 4);
          return true;
        },
      },
    ],
    ai: { kind: 'removal' },
  },
  'Suffocating Fumes': {
    spell: {
      resolve: async (c) => {
        for (const cr of c.g.creatures(c.opp)) tempPT(c.g, cr, -1, -1);
      },
    },
    activated: [cycling('{2}')],
    ai: { kind: 'sweeper', amount: 1, reactive: true },
  },
  'Thorn of the Black Rose': {
    triggers: [etb('You become the monarch.', async (c) => c.g.becomeMonarch(c.me))],
  },
  'Arms of Hadar': {
    spell: {
      targets: [T.player()],
      resolve: async (c) => {
        const p = tp(c);
        if (p === undefined) return;
        for (const cr of c.g.creatures(p)) tempPT(c.g, cr, -2, -2);
      },
    },
    ai: { kind: 'sweeper', amount: 2 },
  },
  "Black Mage's Rod": {
    triggers: [
      etb('Job select: create a 1/1 Hero token and attach this to it.', async (c) => {
        const hero = c.g.createToken(c.me, 'Hero');
        c.g.attach(c.src, hero);
      }),
      {
        text: 'Equipped creature deals 1 damage to each opponent.',
        event: 'cast',
        match: (g, self, ev) =>
          ev.type === 'cast' && ev.controller === self.controller && self.attachedTo !== null && !g.isCreature(ev.card),
        resolve: async (c) => {
          const host = c.src.attachedTo !== null ? c.g.card(c.src.attachedTo) : undefined;
          if (host && host.zone === 'battlefield') c.g.dealDamage(host, c.opp, 1);
        },
      },
    ],
    grant: { power: 1, subtypes: ['Wizard'] },
    activated: [equipAbility('{3}')],
  },
  'Blood Fountain': {
    triggers: [etb('Create a Blood token.', async (c) => void c.g.createToken(c.me, 'Blood'))],
    activated: [
      {
        text: '{3}{B}, {T}, Sacrifice: Return up to two target creature cards from your graveyard to your hand.',
        label: 'Return two creatures',
        cost: { mana: '{3}{B}', tap: true, sacSelf: true },
        targets: [T.graveyardCard('Choose up to two creature cards in your graveyard', (g, x, me) => x.owner === me && g.isCreature(x), 1, 2)],
        ai: 'utility',
        resolve: async (c) => {
          for (const x of tAll(c, 0)) c.g.moveCard(x, 'hand');
        },
      },
    ],
  },
  'Cut Down': {
    spell: {
      targets: [T.creature('Choose target creature with total power and toughness 5 or less', (g, x) => g.power(x) + g.toughness(x) <= 5)],
      resolve: async (c) => {
        const t = tc(c);
        if (t) c.g.destroy(t);
      },
    },
    ai: { kind: 'removal' },
  },
  'Fanatical Offering': {
    additionalCost: { kind: 'sacrifice', filter: artifactOrCreature, prompt: 'Sacrifice an artifact or creature' },
    spell: {
      resolve: async (c) => {
        c.g.draw(c.me, 2);
        c.g.createToken(c.me, 'Map');
      },
    },
    ai: { kind: 'draw' },
  },
  "Reckoner's Bargain": {
    additionalCost: { kind: 'sacrifice', filter: artifactOrCreature, prompt: 'Sacrifice an artifact or creature' },
    spell: {
      resolve: async (c) => {
        c.g.gainLife(c.me, c.info.sacrificed?.mv ?? 0);
        c.g.draw(c.me, 2);
      },
    },
    ai: { kind: 'draw' },
  },
  'Refurbished Familiar': {
    affinity: true,
    triggers: [
      etb("Each opponent discards a card. If they can't, you draw a card.", async (c) => {
        if (c.g.players[c.opp].hand.length === 0) c.g.draw(c.me, 1);
        else await c.g.discard(c.opp, 1);
      }),
    ],
  },
  'Toxin Analysis': {
    spell: {
      targets: [T.creature('Choose target creature')],
      resolve: async (c) => {
        const t = tc(c);
        if (t) {
          t.tempKeywords.push('deathtouch', 'lifelink');
          c.g.changed();
        }
        c.g.createToken(c.me, 'Clue');
      },
    },
    ai: { kind: 'pump', reactive: true },
  },
  'Mukotai Ambusher': { activated: [ninjutsu('{1}{B}')] },
  'Sneaky Snacker': {
    triggers: [
      {
        text: 'When you draw your third card in a turn, return Sneaky Snacker to the battlefield tapped.',
        event: 'draw',
        zone: 'graveyard',
        match: (g, self, ev) => ev.type === 'draw' && ev.player === self.owner && ev.nth === 3,
        resolve: async (c) => {
          if (c.src.zone === 'graveyard') c.g.moveCard(c.src, 'battlefield', { tapped: true, controller: c.src.owner });
        },
      },
    ],
  },
  'Kitchen Imp': {},

  // ─────────────────────────── BLUE ───────────────────────────
  'Augur of Bolas': {
    triggers: [
      etb('Look at the top three cards; you may reveal an instant or sorcery and put it into your hand.', async (c) => {
        const g = c.g;
        const lib = g.players[c.me].library;
        const top = lib.slice(0, 3);
        const eligible = top.filter((x) => g.is(x, 'Instant') || g.is(x, 'Sorcery'));
        const pick = await g.chooseCards(c.me, eligible, 0, 1, 'You may reveal an instant or sorcery card to put into your hand', 'reveal', c.src);
        for (const x of pick) {
          g.log(`${g.players[c.me].name} reveals ${x.def.name}.`, c.me);
          g.moveCard(x, 'hand');
        }
        for (const x of top) if (x.zone === 'library') g.moveCard(x, 'library', { bottom: true });
      }),
    ],
  },
  Brainstorm: {
    spell: {
      resolve: async (c) => {
        const g = c.g;
        g.draw(c.me, 3);
        const hand = g.players[c.me].hand;
        const n = Math.min(2, hand.length);
        const pick = await g.chooseCards(c.me, [...hand], n, n, 'Put two cards from your hand on top of your library (first chosen ends on top)', 'putBack', c.src);
        for (const x of [...pick].reverse()) g.moveCard(x, 'library');
      },
    },
    ai: { kind: 'draw', reactive: true },
  },
  Counterspell: {
    spell: { targets: [T.spell('Choose target spell')], resolve: async (c) => counterIf(c, () => true) },
    ai: { kind: 'counter', reactive: true },
  },
  Dispel: {
    spell: {
      targets: [T.spell('Choose target instant spell', (g, s) => spellIs(s, 'Instant'))],
      resolve: async (c) => counterIf(c, () => true),
    },
    ai: { kind: 'counter', reactive: true },
  },
  Annul: {
    spell: {
      targets: [T.spell('Choose target artifact or enchantment spell', (g, s) => spellIs(s, 'Artifact') || spellIs(s, 'Enchantment'))],
      resolve: async (c) => counterIf(c, () => true),
    },
    ai: { kind: 'counter', reactive: true },
  },
  Envelop: {
    spell: {
      targets: [T.spell('Choose target sorcery spell', (g, s) => spellIs(s, 'Sorcery'))],
      resolve: async (c) => counterIf(c, () => true),
    },
    ai: { kind: 'counter', reactive: true },
  },
  Hydroblast: {
    spell: {
      modes: [
        {
          text: 'Counter target spell if it’s red',
          targets: [T.spell('Choose target spell')],
          resolve: async (c) => counterIf(c, (s) => isColor(s.card, 'R')),
        },
        {
          text: 'Destroy target permanent if it’s red',
          targets: [T.permanent('Choose target permanent', () => true)],
          resolve: async (c) => {
            const t = tc(c);
            if (t && isColor(t, 'R')) c.g.destroy(t);
          },
        },
      ],
    },
    ai: { kind: 'blast', reactive: true },
  },
  'Blue Elemental Blast': {
    spell: {
      modes: [
        {
          text: 'Counter target red spell',
          targets: [T.spell('Choose target red spell', (g, s) => isColor(s.card, 'R'))],
          resolve: async (c) => counterIf(c, () => true),
        },
        {
          text: 'Destroy target red permanent',
          targets: [T.permanent('Choose target red permanent', (g, x) => isColor(x, 'R'))],
          resolve: async (c) => {
            const t = tc(c);
            if (t) c.g.destroy(t);
          },
        },
      ],
    },
    ai: { kind: 'blast', reactive: true },
  },
  'Faerie Seer': {
    triggers: [etb('Scry 2.', async (c) => c.g.scry(c.me, 2))],
  },
  'Lórien Revealed': {
    spell: { resolve: async (c) => c.g.draw(c.me, 3) },
    activated: [
      {
        text: 'Islandcycling {1}: Discard this card: search for an Island card and put it into your hand.',
        label: 'Islandcycling {1}',
        zone: 'hand',
        cost: { mana: '{1}', discardSelf: true },
        ai: 'cycle',
        resolve: async (c) => {
          const found = await c.g.searchLibrary(c.me, (x) => c.g.hasSubtype(x, 'Island'), 'Choose an Island card');
          if (found) {
            c.g.log(`${c.g.players[c.me].name} reveals ${found.def.name}.`, c.me);
            c.g.moveCard(found, 'hand');
          }
          c.g.shuffle(c.me);
        },
      },
    ],
    ai: { kind: 'draw' },
  },
  'Moon-Circuit Hacker': {
    activated: [ninjutsu('{U}')],
    triggers: [
      combatDamageTrigger('You may draw a card. If you do, discard a card unless it entered this turn.', async (c) => {
        const g = c.g;
        if (!(await g.yesNo(c.me, 'Draw a card (Moon-Circuit Hacker)?', 'draw', c.src))) return;
        g.draw(c.me, 1);
        if (c.src.enteredTurn !== g.turn) await g.discard(c.me, 1);
      }),
    ],
  },
  'Ninja of the Deep Hours': {
    activated: [ninjutsu('{1}{U}')],
    triggers: [
      combatDamageTrigger('You may draw a card.', async (c) => {
        if (await c.g.yesNo(c.me, 'Draw a card (Ninja of the Deep Hours)?', 'draw', c.src)) c.g.draw(c.me, 1);
      }),
    ],
  },
  'Spellstutter Sprite': {
    triggers: [
      etb(
        'Counter target spell with mana value X or less, where X is the number of Faeries you control.',
        async (c) => {
          const s = ti(c);
          const faeries = c.g.permanents(c.me).filter((x) => c.g.hasSubtype(x, 'Faerie')).length;
          if (s && s.mv <= faeries) c.g.counterItem(s);
        },
        [
          {
            kind: 'stack',
            prompt: 'Counter target spell with mana value X or less (X = Faeries you control)',
            filter: (g, t, ctx) => {
              const s = t.kind === 'stack' ? g.stack.find((x) => x.id === t.id) : undefined;
              if (!s || s.kind !== 'spell') return false;
              const faeries = g.permanents(ctx.controller).filter((x) => g.hasSubtype(x, 'Faerie')).length;
              return s.mv <= faeries;
            },
          },
        ],
      ),
    ],
  },
  'Cryogen Relic': {
    triggers: [
      etb('Draw a card.', async (c) => c.g.draw(c.me, 1)),
      ltb('Draw a card.', async (c) => c.g.draw(c.me, 1)),
    ],
    activated: [
      {
        text: '{1}{U}, Sacrifice: Put a stun counter on up to one target tapped creature.',
        label: 'Stun a tapped creature',
        cost: { mana: '{1}{U}', sacSelf: true },
        targets: [T.creature('Choose target tapped creature', (g, x) => x.tapped)],
        ai: 'utility',
        resolve: async (c) => {
          const t = tc(c);
          if (t) {
            t.counters.stun = (t.counters.stun ?? 0) + 1;
            c.g.log(`${t.def.name} gets a stun counter.`, c.me);
          }
        },
      },
    ],
  },
  Thoughtcast: {
    affinity: true,
    spell: { resolve: async (c) => c.g.draw(c.me, 2) },
    ai: { kind: 'draw' },
  },
  'Utrom Monitor': { affinity: true },
  'Myr Enforcer': { affinity: true },
  "Giant's Boulder": {
    triggers: [etb('Scry 2.', async (c) => c.g.scry(c.me, 2))],
    activated: [
      {
        text: '{1}, {T}: Add one mana of any color.',
        label: 'Filter mana',
        cost: { mana: '{1}', tap: true },
        produces: [['W'], ['U'], ['B'], ['R'], ['G']],
        resolve: async () => {},
      },
      {
        text: '{7}, {T}, Sacrifice: Destroy target permanent.',
        label: 'Destroy target permanent',
        cost: { mana: '{7}', tap: true, sacSelf: true },
        targets: [T.permanent('Choose target permanent', () => true)],
        ai: 'removal',
        resolve: async (c) => {
          const t = tc(c);
          if (t) c.g.destroy(t);
        },
      },
    ],
  },
  'Ichor Wellspring': {
    triggers: [etb('Draw a card.', async (c) => c.g.draw(c.me, 1)), dies('Draw a card.', async (c) => c.g.draw(c.me, 1))],
  },
  Campfire: {
    activated: [
      {
        text: '{1}, {T}: You gain 2 life.',
        label: 'Gain 2 life',
        cost: { mana: '{1}', tap: true },
        ai: 'utility',
        resolve: async (c) => c.g.gainLife(c.me, 2),
      },
    ],
  },
  "Hunter's Blowgun": {
    grant: {
      power: 1,
      toughness: 1,
      keywords: (g, cr) => (g.active === cr.controller ? ['deathtouch'] : ['reach']),
    },
    activated: [equipAbility('{2}')],
  },
};

function karoo(): Script {
  return {
    entersTapped: true,
    triggers: [
      etb('Return a land you control to its owner’s hand.', async (c) => {
        const lands = c.g.lands(c.me);
        const sel = await c.g.chooseCards(c.me, lands, 1, 1, 'Return a land you control to its owner’s hand', 'returnLand', c.src);
        for (const x of sel) c.g.bounce(x);
      }),
    ],
  };
}

Object.assign(scripts, boglesScripts);
Object.assign(tokenScripts, boglesTokens);
Object.assign(scripts, blueTerrorScripts);
Object.assign(tokenScripts, blueTerrorTokens);
