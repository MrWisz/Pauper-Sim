// Mono-Black Devotion: Gray Merchant drains, Pestilence / Crypt Rats sweepers, Chittering Rats, edicts.
import type { CardDef, Ctx, PlayerId } from '../types';
import type { Game } from '../game';
import { T, etb, tc, tp, tRaw } from './helpers';

type Script = Partial<CardDef>;

/** "N damage to each creature and each player" (Pestilence, Crypt Rats) */
function damageEverything(c: Ctx, n: number) {
  const g = c.g;
  if (n <= 0) return;
  for (const cr of [...g.creatures(0), ...g.creatures(1)]) g.dealDamage(c.src, cr, n);
  for (const pid of [0, 1] as PlayerId[]) g.dealDamage(c.src, { kind: 'player', pid }, n);
}

const anyCreatureOut = (g: Game) => g.creatures(0).length + g.creatures(1).length > 0;

export const devotionScripts: Record<string, Script> = {
  'Bake into a Pie': {
    spell: {
      targets: [T.creature()],
      resolve: async (c) => {
        const t = tc(c);
        if (t) c.g.destroy(t);
        c.g.createToken(c.me, 'Food');
      },
    },
    ai: { kind: 'removal' },
  },
  "Chainer's Edict": {
    spell: {
      targets: [T.player()],
      resolve: async (c) => {
        const g = c.g;
        const pid = tp(c);
        if (pid === undefined) return;
        const sel = await g.chooseCards(pid, g.creatures(pid), 1, 1, 'Sacrifice a creature', 'sacrifice');
        for (const x of sel) g.sacrifice(x);
      },
    },
    ai: { kind: 'removal' },
  },
  "Night's Whisper": {
    spell: {
      resolve: async (c) => {
        c.g.draw(c.me, 2);
        c.g.loseLife(c.me, 2);
      },
    },
    ai: { kind: 'draw' },
  },
  'Chittering Rats': {
    triggers: [
      etb(
        'Target opponent puts a card from their hand on top of their library.',
        async (c) => {
          const g = c.g;
          const pid = tp(c);
          if (pid === undefined) return;
          const hand = g.players[pid].hand;
          const sel = await g.chooseCards(pid, hand, Math.min(1, hand.length), 1, 'Put a card from your hand on top of your library', 'putBack', c.src);
          for (const x of sel) {
            g.moveCard(x, 'library');
            g.log(`${g.players[pid].name} puts a card from their hand on top of their library.`, pid);
          }
        },
        [T.opponent()],
      ),
    ],
  },
  'Crypt Rats': {
    activated: [
      {
        text: '{X}: Crypt Rats deals X damage to each creature and each player. Spend only black mana on X.',
        label: 'X damage to everything',
        cost: {},
        xMana: 'B',
        ai: 'damage',
        resolve: async (c) => damageEverything(c, c.info.x ?? 0),
      },
    ],
  },
  'Cuombajj Witches': {
    activated: [
      {
        text: '{T}: This deals 1 damage to any target and 1 damage to any target of an opponent’s choice.',
        label: 'Ping ×2',
        cost: { tap: true },
        targets: [T.any()],
        ai: 'damage',
        resolve: async (c) => {
          const g = c.g;
          const t = tRaw(c);
          if (t) g.dealDamage(c.src, t, 1);
          // the opponent picks the second target as the ability resolves
          const second = await g.chooseTargets(c.opp, [T.any('Cuombajj Witches: choose a target for its other 1 damage')], c.src, false);
          const t2 = second?.[0]?.[0];
          if (t2) g.dealDamage(c.src, t2, 1);
        },
      },
    ],
  },
  'Gray Merchant of Asphodel': {
    triggers: [
      etb('Each opponent loses X life, where X is your devotion to black. You gain life equal to the life lost this way.', async (c) => {
        const g = c.g;
        const x = g.devotion(c.me, 'B');
        g.log(`Devotion to black: ${x}.`, c.me);
        if (x <= 0) return;
        g.loseLife(c.opp, x);
        g.gainLife(c.me, x);
      }),
    ],
  },
  Pestilence: {
    triggers: [
      {
        text: 'At the beginning of the end step, if no creatures are on the battlefield, sacrifice Pestilence.',
        event: 'step',
        match: (g, self, ev) => ev.type === 'step' && ev.step === 'end' && !anyCreatureOut(g),
        resolve: async (c) => {
          if (!anyCreatureOut(c.g) && c.src.zone === 'battlefield') c.g.sacrifice(c.src);
        },
      },
    ],
    activated: [
      {
        text: '{B}: Pestilence deals 1 damage to each creature and each player.',
        label: '1 damage to everything',
        cost: { mana: '{B}' },
        ai: 'damage',
        resolve: async (c) => damageEverything(c, 1),
      },
    ],
  },
  'Tempting Witch': {
    triggers: [etb('Create a Food token.', async (c) => void c.g.createToken(c.me, 'Food'))],
    activated: [
      {
        text: '{2}, {T}, Sacrifice a Food: Target player loses 3 life.',
        label: 'Sac a Food: lose 3',
        cost: { mana: '{2}', tap: true, sacrifice: { filter: (g, x) => g.hasSubtype(x, 'Food'), prompt: 'Sacrifice a Food' } },
        targets: [T.player()],
        ai: 'damage',
        resolve: async (c) => {
          const pid = tp(c);
          if (pid !== undefined) c.g.loseLife(pid, 3);
        },
      },
    ],
  },
  Unearth: {
    spell: {
      targets: [T.graveyardCard('Choose target creature card with mana value 3 or less in your graveyard', (g, x, me) => x.owner === me && g.isCreature(x) && x.def.cmc <= 3)],
      resolve: async (c) => {
        const t = tc(c);
        if (t && t.zone === 'graveyard') c.g.moveCard(t, 'battlefield', { controller: c.me });
      },
    },
  },
  "Witch's Cottage": {
    entersTapped: (g, card) => g.lands(card.controller).filter((x) => x !== card && g.hasSubtype(x, 'Swamp')).length < 3,
    triggers: [
      {
        text: 'When this land enters untapped, you may put target creature card from your graveyard on top of your library.',
        event: 'etb',
        match: (g, self, ev) => ev.type === 'etb' && ev.card === self && !self.tapped,
        targets: [T.graveyardCard('Choose a creature card in your graveyard', (g, x, me) => x.owner === me && g.isCreature(x))],
        resolve: async (c) => {
          const g = c.g;
          const t = tc(c);
          if (!t || t.zone !== 'graveyard') return;
          if (await g.yesNo(c.me, `Put ${t.def.name} on top of your library?`, 'cottage', t)) {
            g.moveCard(t, 'library');
            g.log(`${t.def.name} is put on top of the library.`, c.me);
          }
        },
      },
    ],
  },
};
