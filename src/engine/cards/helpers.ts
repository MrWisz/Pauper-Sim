import type { Game } from '../game';
import type {
  ActivatedDef,
  CardInstance,
  Color,
  Ctx,
  ManaColor,
  PlayerId,
  StackItem,
  Target,
  TargetSpec,
  TriggerDef,
} from '../types';

export const cardOf = (g: Game, t: Target) => (t.kind === 'card' ? g.card(t.id) : undefined);
export const itemOf = (g: Game, t: Target) => (t.kind === 'stack' ? g.stack.find((s) => s.id === t.id) : undefined);

export const isColor = (c: CardInstance, col: Color) => c.def.colors.includes(col);

/** Target specs */
export const T = {
  any: (prompt = 'Choose any target'): TargetSpec => ({ kind: 'any', prompt }),
  player: (prompt = 'Choose target player'): TargetSpec => ({ kind: 'player', prompt }),
  opponent: (prompt = 'Choose target opponent'): TargetSpec => ({
    kind: 'player',
    prompt,
    filter: (g, t, ctx) => t.kind === 'player' && t.pid !== ctx.controller,
  }),
  creature: (prompt = 'Choose target creature', filter?: (g: Game, c: CardInstance, me: PlayerId) => boolean): TargetSpec => ({
    kind: 'permanent',
    prompt,
    filter: (g, t, ctx) => {
      const c = cardOf(g, t);
      return !!c && g.isCreature(c) && (!filter || filter(g, c, ctx.controller));
    },
  }),
  permanent: (prompt: string, filter: (g: Game, c: CardInstance, me: PlayerId) => boolean): TargetSpec => ({
    kind: 'permanent',
    prompt,
    filter: (g, t, ctx) => {
      const c = cardOf(g, t);
      return !!c && filter(g, c, ctx.controller);
    },
  }),
  spell: (prompt: string, filter?: (g: Game, s: StackItem) => boolean): TargetSpec => ({
    kind: 'stack',
    prompt,
    filter: (g, t) => {
      const s = itemOf(g, t);
      return !!s && s.kind === 'spell' && (!filter || filter(g, s));
    },
  }),
  graveyardCard: (prompt: string, filter?: (g: Game, c: CardInstance, me: PlayerId) => boolean, min = 1, max = 1): TargetSpec => ({
    kind: 'graveyardCard',
    prompt,
    min,
    max,
    filter: (g, t, ctx) => {
      const c = cardOf(g, t);
      return !!c && (!filter || filter(g, c, ctx.controller));
    },
  }),
};

/** First target of spec i, if still legal */
export const tc = (c: Ctx, i = 0, j = 0) => {
  const t = c.targets[i]?.[j];
  return t ? cardOf(c.g, t) : undefined;
};
export const tAll = (c: Ctx, i = 0) => (c.targets[i] ?? []).map((t) => cardOf(c.g, t)).filter(Boolean) as CardInstance[];
export const tp = (c: Ctx, i = 0): PlayerId | undefined => {
  const t = c.targets[i]?.[0];
  return t?.kind === 'player' ? t.pid : undefined;
};
export const ti = (c: Ctx, i = 0) => {
  const t = c.targets[i]?.[0];
  return t ? itemOf(c.g, t) : undefined;
};
export const tRaw = (c: Ctx, i = 0) => c.targets[i]?.[0];

/** Damage the first target of spec i (player or creature) */
export const damageT = (c: Ctx, i: number, n: number) => {
  const t = tRaw(c, i);
  if (t) c.g.dealDamage(c.src, t, n);
};

export const mana = (...opts: ManaColor[][]): ActivatedDef => ({
  text: `{T}: Add ${opts.map((o) => o.map((m) => `{${m}}`).join('')).join(' or ')}.`,
  cost: { tap: true },
  produces: opts,
  resolve: async () => {},
});

export const etb = (text: string, resolve: (c: Ctx) => Promise<void>, targets?: TargetSpec[]): TriggerDef => ({
  text,
  event: 'etb',
  match: (g, self, ev) => ev.type === 'etb' && ev.card === self,
  targets,
  resolve,
});

export const dies = (text: string, resolve: (c: Ctx) => Promise<void>): TriggerDef => ({
  text,
  event: 'ltb',
  match: (g, self, ev) => ev.type === 'ltb' && ev.card === self && ev.to === 'graveyard',
  resolve,
});

export const ltb = (text: string, resolve: (c: Ctx) => Promise<void>): TriggerDef => ({
  text,
  event: 'ltb',
  match: (g, self, ev) => ev.type === 'ltb' && ev.card === self,
  resolve,
});

export const castTrigger = (
  text: string,
  filter: (g: Game, spell: CardInstance) => boolean,
  resolve: (c: Ctx) => Promise<void>,
): TriggerDef => ({
  text,
  event: 'cast',
  match: (g, self, ev) => ev.type === 'cast' && ev.controller === self.controller && filter(g, ev.card),
  resolve,
});

export const combatDamageTrigger = (text: string, resolve: (c: Ctx) => Promise<void>): TriggerDef => ({
  text,
  event: 'combatDamagePlayer',
  match: (g, self, ev) => ev.type === 'combatDamagePlayer' && ev.source === self,
  resolve,
});

export const cycling = (cost: string): ActivatedDef => ({
  text: `Cycling ${cost}: discard this card, draw a card.`,
  label: `Cycling ${cost}`,
  zone: 'hand',
  cost: { mana: cost, discardSelf: true },
  ai: 'cycle',
  resolve: async (c) => c.g.draw(c.me, 1),
});

export const ninjutsu = (cost: string): ActivatedDef => ({
  text: `Ninjutsu ${cost}`,
  label: `Ninjutsu ${cost}`,
  zone: 'hand',
  cost: { mana: cost, returnUnblocked: true },
  ai: 'ninjutsu',
  resolve: async (c) => {
    const card = c.src;
    if (card.zone !== 'hand') return;
    c.g.log(`${card.def.name} enters tapped and attacking!`, c.me);
    c.g.moveCard(card, 'battlefield', { tapped: true, attacking: true, controller: c.me });
  },
});

export const equipAbility = (cost: string): ActivatedDef => ({
  text: `Equip ${cost}`,
  label: `Equip ${cost}`,
  cost: { mana: cost },
  sorcery: true,
  targets: [T.creature('Choose a creature you control to equip', (g, c, me) => c.controller === me)],
  ai: 'utility',
  resolve: async (c) => {
    const t = tc(c);
    if (t && t.controller === c.me) c.g.attach(c.src, t);
  },
});

export const tempPT = (g: Game, c: CardInstance, p: number, t: number) => {
  c.tempPower += p;
  c.tempToughness += t;
  g.changed();
};

export const counterIf = (c: Ctx, pred: (s: StackItem) => boolean) => {
  const s = ti(c);
  if (s && pred(s)) c.g.counterItem(s);
};

export const spellIs = (s: StackItem, type: string) => s.card.def.types.includes(type);
