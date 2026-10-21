// Esper Affinity: Glint Hawk / Kor Skyfisher bouncing Cryogen Relic & co., Dispatch, Tithing Blade.
import type { CardDef, CardInstance, Ctx } from '../types';
import type { Game } from '../game';
import { T, etb, tAll, tc } from './helpers';

type Script = Partial<CardDef>;

const metalcraft = (g: Game, pid: number) => g.artifacts(pid as 0 | 1).length >= 3;

/** look at the top n cards one by one; each may go to the graveyard */
async function surveil(c: Ctx, n: number) {
  const g = c.g;
  const top = g.players[c.me].library.slice(0, n);
  let binned = 0;
  for (const card of top) {
    if (await g.yesNo(c.me, `Surveil: put ${card.def.name} into your graveyard? (No = keep it on top)`, 'surveil', card)) {
      g.moveCard(card, 'graveyard');
      binned++;
    }
  }
  g.log(`${g.players[c.me].name} surveils ${top.length}: ${binned} into the graveyard.`, c.me);
}

/** "return a permanent/artifact you control to its owner's hand" */
async function bounceOwn(c: Ctx, filter: (x: CardInstance) => boolean, optional: boolean, prompt: string) {
  const g = c.g;
  const cands = g.permanents(c.me).filter(filter);
  const pick = await g.chooseCards(c.me, cands, optional ? 0 : 1, 1, prompt, 'bounceOwn', c.src);
  for (const x of pick) g.bounce(x);
  return pick.length > 0;
}

export const esperScripts: Record<string, Script> = {
  'Glint Hawk': {
    triggers: [
      etb('Sacrifice this unless you return an artifact you control to its owner’s hand.', async (c) => {
        const returned = await bounceOwn(c, (x) => c.g.isArtifact(x), true, 'Glint Hawk: return an artifact you control to your hand (or sacrifice Glint Hawk)');
        if (!returned && c.src.zone === 'battlefield') c.g.sacrifice(c.src);
      }),
    ],
  },
  'Kor Skyfisher': {
    triggers: [
      etb('Return a permanent you control to its owner’s hand.', async (c) => {
        await bounceOwn(c, () => true, false, 'Kor Skyfisher: return a permanent you control to your hand');
      }),
    ],
  },
  Dispatch: {
    spell: {
      targets: [T.creature('Choose target creature')],
      resolve: async (c) => {
        const t = tc(c);
        if (!t) return;
        if (metalcraft(c.g, c.me)) c.g.exile(t);
        else {
          t.tapped = true;
          c.g.log(`${t.def.name} is tapped.`, c.me);
          c.g.changed();
        }
      },
    },
    ai: { kind: 'removal' },
  },
  'Grim Bauble': {
    triggers: [
      etb(
        'Target creature an opponent controls gets -2/-2 until end of turn.',
        async (c) => {
          const t = tc(c);
          if (t) {
            t.tempPower -= 2;
            t.tempToughness -= 2;
            c.g.log(`${t.def.name} gets -2/-2 until end of turn.`, c.me);
            c.g.changed();
          }
        },
        [T.creature('Choose target creature an opponent controls', (g, x, me) => x.controller !== me)],
      ),
    ],
    activated: [
      {
        text: '{2}{B}, {T}, Sacrifice: Surveil 2.',
        label: 'Surveil 2',
        cost: { mana: '{2}{B}', tap: true, sacSelf: true },
        ai: 'utility',
        resolve: async (c) => surveil(c, 2),
      },
    ],
    ai: { kind: 'removal', amount: 2 },
  },
  'Dust to Dust': {
    spell: {
      targets: [{ ...T.permanent('Choose two target artifacts', (g, x) => g.isArtifact(x)), min: 2, max: 2 }],
      resolve: async (c) => {
        for (const x of tAll(c, 0)) c.g.exile(x);
      },
    },
    ai: { kind: 'artifactRemoval' },
  },
  'Tithing Blade': {
    triggers: [
      etb('Each opponent sacrifices a creature of their choice.', async (c) => {
        const g = c.g;
        const crs = g.creatures(c.opp);
        const sel = await g.chooseCards(c.opp, crs, 1, 1, 'Sacrifice a creature', 'sacrifice');
        for (const x of sel) g.sacrifice(x);
      }),
    ],
    activated: [
      {
        text: 'Craft with creature {4}{B}: exile this and a creature you control or a creature card from your graveyard; return it transformed.',
        label: 'Craft {4}{B}',
        cost: { mana: '{4}{B}', exileSelf: true },
        sorcery: true,
        ai: 'utility',
        canActivate: (g, card, pid) => g.creatures(pid).length > 0 || g.players[pid].graveyard.some((x) => g.isCreature(x)),
        resolve: async (c) => {
          const g = c.g;
          const options = [...g.players[c.me].graveyard.filter((x) => g.isCreature(x)), ...g.creatures(c.me)];
          const pick = await g.chooseCards(c.me, options, 1, 1, 'Craft: exile a creature you control or a creature card from your graveyard', 'exileGraveyard', c.src);
          for (const x of pick) g.moveCard(x, 'exile');
          const card = c.src;
          if (card.zone === 'exile' && card.def.backFace) {
            card.frontDef = card.def;
            card.def = card.def.backFace;
            g.log(`Tithing Blade returns transformed into ${card.def.name}.`, c.me);
            g.moveCard(card, 'battlefield', { controller: c.me });
          }
        },
      },
    ],
  },
  'Consuming Sepulcher': {
    triggers: [
      {
        text: 'At the beginning of your upkeep, each opponent loses 1 life and you gain 1 life.',
        event: 'step',
        match: (g, self, ev) => ev.type === 'step' && ev.step === 'upkeep' && ev.active === self.controller,
        resolve: async (c) => {
          c.g.loseLife(c.opp, 1);
          c.g.gainLife(c.me, 1);
        },
      },
    ],
  },
};
