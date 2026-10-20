// Mono-Blue Terror: Delver, Tolarian Terror, cantrips and cheap counters.
import type { CardDef, CardInstance, Ctx } from '../types';
import type { Game } from '../game';
import { T, castTrigger, tc, ti, tp } from './helpers';

type Script = Partial<CardDef>;

const isInstantOrSorcery = (c: CardInstance) => c.def.types.includes('Instant') || c.def.types.includes('Sorcery');
const spellsInGraveyard = (g: Game, pid: number) => g.players[pid as 0 | 1].graveyard.filter(isInstantOrSorcery).length;

export const blueTerrorTokens: Record<string, CardDef> = {
  'Bird Illusion': {
    name: 'Bird Illusion',
    manaCost: '',
    cmc: 0,
    typeLine: 'Token Creature — Bird Illusion',
    types: ['Creature'],
    subtypes: ['Bird', 'Illusion'],
    supertypes: [],
    colors: ['U'],
    power: 1,
    toughness: 1,
    oracle: 'Flying',
    keywords: ['flying'],
    implemented: true,
    isToken: true,
  },
};

export const blueTerrorScripts: Record<string, Script> = {
  'Delver of Secrets': {
    // Scryfall lists both faces' keywords together; the front face has none
    keywords: [],
    triggers: [
      {
        text: 'Look at the top card of your library; if you reveal an instant or sorcery, transform.',
        event: 'step',
        match: (g, self, ev) => ev.type === 'step' && ev.step === 'upkeep' && ev.active === self.controller,
        resolve: async (c) => {
          const g = c.g;
          const top = g.players[c.me].library[0];
          if (!top || c.src.zone !== 'battlefield' || c.src.frontDef) return;
          if (isInstantOrSorcery(top)) {
            const pick = await g.chooseCards(c.me, [top], 0, 1, `Delver of Secrets: reveal ${top.def.name} to transform?`, 'reveal', c.src);
            if (pick.length) {
              g.log(`${g.players[c.me].name} reveals ${top.def.name}.`, c.me);
              g.transform(c.src);
            }
          } else {
            // you still get to look at it
            await g.ask(c.me, {
              type: 'cards',
              player: c.me,
              prompt: `Delver of Secrets: the top card of your library is ${top.def.name} (not an instant or sorcery)`,
              cards: [top],
              min: 0,
              max: 0,
              purpose: 'reveal',
              source: c.src,
            });
          }
        },
      },
    ],
  },
  'Insectile Aberration': {
    keywords: ['flying'],
  },
  'Tolarian Terror': {
    costReduction: (g, card, pid) => spellsInGraveyard(g, pid),
  },
  'Cryptic Serpent': {
    costReduction: (g, card, pid) => spellsInGraveyard(g, pid),
  },
  'Deem Inferior': {
    costReduction: (g, card, pid) => g.players[pid].drawsThisTurn,
    spell: {
      targets: [T.permanent('Choose target nonland permanent', (g, x) => !g.isLand(x))],
      resolve: async (c) => {
        const g = c.g;
        const t = tc(c);
        if (!t) return;
        const owner = t.owner;
        const second = await g.yesNo(owner, `Put ${t.def.name} second from the top of your library? (No = bottom)`, 'deemTop', t);
        const lib = g.players[owner].library;
        g.moveCard(t, 'library', { bottom: !second });
        if (t.def.isToken) return;
        if (second && lib[0] === t && lib.length > 1) {
          lib.splice(0, 1);
          lib.splice(1, 0, t);
        }
        g.log(`${t.def.name} is put ${second ? 'second from the top of' : 'on the bottom of'} its owner's library.`, c.me);
      },
    },
    ai: { kind: 'removal' },
  },
  'Deep Analysis': {
    spell: {
      targets: [T.player()],
      resolve: async (c) => {
        const p = tp(c);
        if (p !== undefined) c.g.draw(p, 2);
      },
    },
    flashback: {
      mana: '{1}{U}',
      label: 'Flashback {1}{U}, pay 3 life',
      canPay: (g, card, pid) => g.players[pid].life > 3,
      pay: async (g, card, pid) => {
        g.loseLife(pid, 3);
        return true;
      },
    },
    ai: { kind: 'draw' },
  },
  'Force Spike': {
    spell: {
      targets: [T.spell('Choose target spell')],
      resolve: async (c) => c.g.counterUnlessPays(ti(c), '{1}'),
    },
    ai: { kind: 'counter', reactive: true },
  },
  'Spell Pierce': {
    spell: {
      targets: [T.spell('Choose target noncreature spell', (g, s) => !s.card.def.types.includes('Creature'))],
      resolve: async (c) => c.g.counterUnlessPays(ti(c), '{2}'),
    },
    ai: { kind: 'counter', reactive: true },
  },
  'Mental Note': {
    spell: {
      resolve: async (c) => {
        c.g.mill(c.me, 2);
        c.g.draw(c.me, 1);
      },
    },
    ai: { kind: 'draw' },
  },
  'Thought Scour': {
    spell: {
      targets: [T.player('Choose target player to mill')],
      resolve: async (c) => {
        const p = tp(c);
        if (p !== undefined) c.g.mill(p, 2);
        c.g.draw(c.me, 1);
      },
    },
    ai: { kind: 'draw' },
  },
  Ponder: {
    spell: {
      resolve: async (c) => {
        const g = c.g;
        const lib = g.players[c.me].library;
        const top = lib.slice(0, 3);
        if (top.length > 1) {
          const order = await g.ask<number[]>(c.me, {
            type: 'order',
            player: c.me,
            prompt: 'Ponder: click the cards in the order you want them (first = top of library)',
            cards: top,
          });
          const ordered = (order ?? []).map((id) => g.card(id)!).filter((x) => top.includes(x));
          if (ordered.length === top.length) lib.splice(0, top.length, ...ordered);
        }
        if (await g.yesNo(c.me, 'Ponder: shuffle your library?', 'ponderShuffle', c.src)) {
          g.shuffle(c.me);
          g.log(`${g.players[c.me].name} shuffles.`, c.me);
        }
        g.draw(c.me, 1);
      },
    },
    ai: { kind: 'draw' },
  },
  'Sleep of the Dead': {
    spell: {
      targets: [T.creature()],
      resolve: async (c: Ctx) => {
        const t = tc(c);
        if (!t) return;
        t.tapped = true;
        t.counters.frozen = 1;
        c.g.log(`${t.def.name} is tapped and won't untap during its controller's next untap step.`, c.me);
        c.g.changed();
      },
    },
    flashback: {
      mana: '{2}{U}',
      label: 'Escape {2}{U} (exile three other graveyard cards)',
      escape: true,
      canPay: (g, card, pid) => g.players[pid].graveyard.filter((x) => x !== card).length >= 3,
      pay: async (g, card, pid) => {
        const others = g.players[pid].graveyard.filter((x) => x !== card);
        const sel = await g.chooseCards(pid, others, 3, 3, 'Exile three other cards from your graveyard (escape)', 'evidence', card);
        for (const x of sel) g.moveCard(x, 'exile');
        return sel.length === 3;
      },
    },
    ai: { kind: 'removal' },
  },
  'Gut Shot': {
    spell: {
      targets: [T.any()],
      resolve: async (c) => {
        const t = c.targets[0]?.[0];
        if (t) c.g.dealDamage(c.src, t, 1);
      },
    },
    ai: { kind: 'burn', amount: 1 },
  },
  'Murmuring Mystic': {
    triggers: [
      castTrigger('Create a 1/1 blue Bird Illusion creature token with flying.', (g, spell) => isInstantOrSorcery(spell), async (c) =>
        void c.g.createToken(c.me, 'Bird Illusion'),
      ),
    ],
  },
  'Steel Sabotage': {
    spell: {
      modes: [
        {
          text: 'Counter target artifact spell',
          targets: [T.spell('Choose target artifact spell', (g, s) => s.card.def.types.includes('Artifact'))],
          resolve: async (c) => {
            const s = ti(c);
            if (s) c.g.counterItem(s);
          },
        },
        {
          text: "Return target artifact to its owner's hand",
          targets: [T.permanent('Choose target artifact', (g, x) => g.isArtifact(x))],
          resolve: async (c) => {
            const t = tc(c);
            if (t) c.g.bounce(t);
          },
        },
      ],
    },
    ai: { kind: 'counter', reactive: true },
  },
};
