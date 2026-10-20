// The initiative and the Undercity dungeon (Avenging Hunter).
// Whenever you take the initiative, and at the beginning of your upkeep while you have it,
// you venture into Undercity: enter it, or move to the next room, and do that room's effect.
import type { Game } from './game';
import type { CardInstance, PlayerId, TargetSpec } from './types';

export interface Room {
  name: string;
  text: string;
  next: string[];
  effect: (g: Game, pid: PlayerId, source: CardInstance) => Promise<void>;
}

const creatureSpec = (prompt: string): TargetSpec => ({
  kind: 'permanent',
  prompt,
  filter: (g, t) => t.kind === 'card' && !!g.card(t.id) && g.isCreature(g.card(t.id)!),
});

const isBasicLand = (c: CardInstance) => c.def.supertypes.includes('Basic') && c.def.types.includes('Land');

export const UNDERCITY: Record<string, Room> = {
  'Secret Entrance': {
    name: 'Secret Entrance',
    text: 'Search your library for a basic land card, put it into your hand',
    next: ['Forge', 'Lost Well'],
    effect: async (g, pid) => {
      const found = await g.searchLibrary(pid, isBasicLand, 'Secret Entrance: choose a basic land card');
      if (found) {
        g.log(`${g.players[pid].name} reveals ${found.def.name}.`, pid);
        g.moveCard(found, 'hand');
      }
      g.shuffle(pid);
    },
  },
  Forge: {
    name: 'Forge',
    text: 'Put two +1/+1 counters on target creature',
    next: ['Trap!', 'Arena'],
    effect: async (g, pid, source) => {
      const t = await g.chooseTargets(pid, [creatureSpec('Forge: put two +1/+1 counters on target creature')], source, false);
      const c = t?.[0]?.[0]?.kind === 'card' ? g.card(t[0][0].id) : undefined;
      if (c) {
        c.counters['+1/+1'] = (c.counters['+1/+1'] ?? 0) + 2;
        g.log(`${c.def.name} gets two +1/+1 counters.`, pid);
      }
    },
  },
  'Lost Well': {
    name: 'Lost Well',
    text: 'Scry 2',
    next: ['Arena', 'Stash'],
    effect: async (g, pid) => g.scry(pid, 2),
  },
  'Trap!': {
    name: 'Trap!',
    text: 'Target player loses 5 life',
    next: ['Archives'],
    effect: async (g, pid, source) => {
      const t = await g.chooseTargets(pid, [{ kind: 'player', prompt: 'Trap!: target player loses 5 life' }], source, false);
      const p = t?.[0]?.[0];
      if (p?.kind === 'player') g.loseLife(p.pid, 5);
    },
  },
  Arena: {
    name: 'Arena',
    text: 'Goad target creature (it must attack each combat until your next turn)',
    next: ['Archives', 'Catacombs'],
    effect: async (g, pid, source) => {
      const t = await g.chooseTargets(pid, [creatureSpec('Arena: goad target creature')], source, false);
      const c = t?.[0]?.[0]?.kind === 'card' ? g.card(t[0][0].id) : undefined;
      if (c) {
        c.goadedBy = pid;
        g.log(`${c.def.name} is goaded.`, pid);
      }
    },
  },
  Stash: {
    name: 'Stash',
    text: 'Create a Treasure token',
    next: ['Catacombs'],
    effect: async (g, pid) => void g.createToken(pid, 'Treasure'),
  },
  Archives: {
    name: 'Archives',
    text: 'Draw a card',
    next: ['Throne of the Dead Three'],
    effect: async (g, pid) => g.draw(pid, 1),
  },
  Catacombs: {
    name: 'Catacombs',
    text: 'Create a 4/1 black Skeleton creature token with menace',
    next: ['Throne of the Dead Three'],
    effect: async (g, pid) => void g.createToken(pid, 'Skeleton'),
  },
  'Throne of the Dead Three': {
    name: 'Throne of the Dead Three',
    text: 'Reveal the top ten cards; put a creature card from among them onto the battlefield with three +1/+1 counters and hexproof until your next turn',
    next: [],
    effect: async (g, pid) => {
      const top = g.players[pid].library.slice(0, 10);
      g.log(`${g.players[pid].name} reveals ${top.map((c) => c.def.name).join(', ')}.`, pid);
      const pick = await g.chooseCards(pid, top.filter((c) => g.isCreature(c)), 1, 1, 'Throne of the Dead Three: choose a creature', 'reveal');
      const c = pick[0];
      if (c) {
        c.counters['+1/+1'] = (c.counters['+1/+1'] ?? 0) + 3;
        g.moveCard(c, 'battlefield', { controller: pid });
        c.nextTurnKeywords = ['hexproof'];
        g.log(`${c.def.name} enters with three +1/+1 counters and hexproof until your next turn.`, pid);
      }
      g.shuffle(pid);
    },
  },
};

/** Move to the next room of Undercity (choosing a path when there are two) and resolve it. */
export async function venture(g: Game, pid: PlayerId, source: CardInstance) {
  const current = g.dungeonRoom[pid];
  let options = current ? UNDERCITY[current].next : ['Secret Entrance'];
  if (!options.length) {
    g.log(`${g.players[pid].name} completes Undercity.`, pid);
    options = ['Secret Entrance'];
  }
  let room = options[0];
  if (options.length > 1) {
    const r = await g.ask<number | null>(pid, {
      type: 'mode',
      player: pid,
      source,
      options: options.map((n) => ({ text: `${n} — ${UNDERCITY[n].text}`, enabled: true })),
      cancellable: false,
    });
    room = options[r ?? 0];
  }
  g.dungeonRoom[pid] = room;
  g.log(`${g.players[pid].name} ventures into ${room}.`, pid);
  g.changed();
  await UNDERCITY[room].effect(g, pid, source);
}
