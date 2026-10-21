import { venture } from './undercity';
import { emptyPool, parseCost, solvePayment, costMV, type Cost, type ManaSource, COLORS } from './mana';
import type {
  Action,
  ActivatedDef,
  CardDef,
  CardInstance,
  CastInfo,
  ChoiceRequest,
  Controller,
  Ctx,
  GameEvent,
  Keyword,
  ManaColor,
  Player,
  PlayerId,
  SpellMode,
  StackItem,
  Step,
  Target,
  TargetCtx,
  TargetSpec,
  TriggerDef,
  Zone,
} from './types';

export class GameOver extends Error {
  constructor(public winner: PlayerId | null) {
    super('game over');
  }
}

export interface LogEntry {
  id: number;
  text: string;
  player?: PlayerId;
  turn: number;
}

interface PendingTrigger {
  trigger: TriggerDef;
  source: CardInstance;
  controller: PlayerId;
  event: GameEvent;
}

/** Visual events for the UI to animate (the engine itself ignores them). */
export type FxEvent = { id: number } & (
  | { type: 'turn'; player: PlayerId }
  | { type: 'cast'; card: CardInstance; controller: PlayerId; text: string }
  | { type: 'damage'; target: Target; amount: number }
  | { type: 'life'; pid: PlayerId; amount: number }
  | { type: 'leave'; card: CardInstance; to: Zone }
  | { type: 'trigger'; card: CardInstance }
  | { type: 'countered'; card: CardInstance }
  | { type: 'combat'; text: string }
);
type FxInput = FxEvent extends infer E ? (E extends { id: number } ? Omit<E, 'id'> : never) : never;

export interface CastOption {
  method: CastInfo['method'];
  altIndex?: number;
  label: string;
}

export const STEP_LABEL: Record<Step, string> = {
  untap: 'Untap',
  upkeep: 'Upkeep',
  draw: 'Draw',
  main1: 'Main 1',
  beginCombat: 'Begin Combat',
  declareAttackers: 'Attackers',
  declareBlockers: 'Blockers',
  firstStrikeDamage: 'First Strike',
  combatDamage: 'Damage',
  endCombat: 'End Combat',
  main2: 'Main 2',
  end: 'End',
  cleanup: 'Cleanup',
};

let tokenDefs: Record<string, CardDef> = {};
export function registerTokens(defs: Record<string, CardDef>) {
  tokenDefs = defs;
}

export class Game {
  players: [Player, Player];
  controllers: [Controller, Controller];
  cards = new Map<number, CardInstance>();
  battlefield: CardInstance[] = [];
  stack: StackItem[] = [];
  active: PlayerId = 0;
  priority: PlayerId = 0;
  step: Step = 'untap';
  turn = 0;
  tick = 0;
  turnStartTick: [number, number] = [0, 0];
  monarch: PlayerId | null = null;
  /** who has the initiative (Undercity), and the room each player is in */
  initiative: PlayerId | null = null;
  dungeonRoom: [string | null, string | null] = [null, null];
  winner: PlayerId | null | undefined = undefined;
  logs: LogEntry[] = [];
  version = 0;
  pending: ChoiceRequest | null = null;
  pendingTriggers: PendingTrigger[] = [];
  /** id of a stack item currently resolving (for UI) */
  resolving: StackItem | null = null;
  /** recent visual events for the UI */
  fx: FxEvent[] = [];
  private fxSeq = 0;
  /** base delay (ms) used to pace the game so humans can follow it; 0 = instant (simulations) */
  paceMs = 0;
  /** turn during which damage can't be prevented (Flaring Pain) */
  preventionTurn = -1;
  /** "prevent all combat damage this turn" (Moment's Peace, Tangle) */
  preventCombatTurn = -1;
  /** "prevent all damage that would be dealt by creatures this turn" (Ethereal Haze) */
  preventCreatureTurn = -1;
  /** spells cast this turn (storm) */
  spellsThisTurn = 0;
  private nextId = 1;
  private listeners = new Set<() => void>();
  private monarchSource: CardInstance;
  initiativeSource: CardInstance;
  rng: () => number;

  constructor(
    decks: [CardDef[], CardDef[]],
    controllers: [Controller, Controller],
    names: [string, string],
    firstPlayer: PlayerId,
    seed = Date.now(),
  ) {
    this.rng = mulberry32(seed);
    this.controllers = controllers;
    this.players = [0, 1].map((i) => ({
      id: i as PlayerId,
      name: names[i],
      life: 20,
      library: [],
      hand: [],
      graveyard: [],
      exile: [],
      pool: emptyPool(),
      landsPlayedThisTurn: 0,
      drawsThisTurn: 0,
      landEnteredThisTurn: false,
      lost: false,
      drewFromEmpty: false,
      mulligans: 0,
    })) as unknown as [Player, Player];
    for (const pid of [0, 1] as PlayerId[]) {
      for (const def of decks[pid]) {
        const c = this.makeCard(def, pid);
        c.zone = 'library';
        this.players[pid].library.push(c);
      }
      this.shuffle(pid);
    }
    this.active = firstPlayer;
    this.initiativeSource = this.makeCard(
      {
        name: 'The Initiative',
        manaCost: '',
        cmc: 0,
        typeLine: 'Designation',
        types: [],
        subtypes: [],
        supertypes: [],
        colors: [],
        oracle:
          'Whenever one or more creatures a player controls deal combat damage to you, that player takes the initiative. Whenever you take the initiative and at the beginning of your upkeep, venture into Undercity.',
        keywords: [],
        implemented: true,
      },
      0,
    );
    this.monarchSource = this.makeCard(
      {
        name: 'The Monarch',
        manaCost: '',
        cmc: 0,
        typeLine: 'Designation',
        types: [],
        subtypes: [],
        supertypes: [],
        colors: [],
        oracle: 'At the beginning of the monarch’s end step, that player draws a card.',
        keywords: [],
        implemented: true,
      },
      0,
    );
  }

  // ───────────────────────────── infrastructure ─────────────────────────────

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  changed() {
    this.version++;
    for (const fn of this.listeners) fn();
  }
  log(text: string, player?: PlayerId) {
    // "You draws" → "You draw" when a player is literally named "You"
    text = text
      .replace(/\bYou's\b/g, 'Your')
      .replace(/\bYou (\w+?)(ies|es|s)\b/g, (m, stem: string, suf: string) => {
        if (suf === 'ies') return `You ${stem}y`;
        if (suf === 'es' && /(ch|sh|ss|x)$/.test(stem)) return `You ${stem}`;
        return `You ${stem}${suf === 'es' ? 'e' : ''}`;
      });
    this.logs.push({ id: this.nextId++, text, player, turn: this.turn });
    if (this.logs.length > 400) this.logs.splice(0, this.logs.length - 400);
    this.changed();
  }
  pushFx(e: FxInput) {
    if (!this.paceMs) return;
    this.fx.push({ ...(e as any), id: ++this.fxSeq });
    if (this.fx.length > 60) this.fx.splice(0, this.fx.length - 60);
  }
  async pace(mult = 1) {
    if (this.paceMs > 0 && mult > 0) await new Promise((r) => setTimeout(r, this.paceMs * mult));
  }

  async ask<T = any>(pid: PlayerId, req: ChoiceRequest): Promise<T> {
    this.pending = req;
    this.changed();
    const res = await this.controllers[pid].choose(this, req);
    this.pending = null;
    this.changed();
    if (this.winner !== undefined) throw new GameOver(this.winner);
    return res;
  }
  concede(pid: PlayerId) {
    this.winner = this.opp(pid);
    this.log(`${this.players[pid].name} concedes.`, pid);
  }

  makeCard(def: CardDef, owner: PlayerId): CardInstance {
    const c: CardInstance = {
      id: this.nextId++,
      def,
      owner,
      controller: owner,
      zone: 'none',
      tapped: false,
      damage: 0,
      deathtouched: false,
      enteredTick: 0,
      enteredTurn: 0,
      counters: {},
      attachedTo: null,
      tempPower: 0,
      tempToughness: 0,
      tempKeywords: [],
      attacking: false,
      blocking: null,
      blockedBy: [],
      wasBlocked: false,
      plottedTurn: null,
    };
    this.cards.set(c.id, c);
    return c;
  }

  shuffle(pid: PlayerId) {
    const lib = this.players[pid].library;
    for (let i = lib.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [lib[i], lib[j]] = [lib[j], lib[i]];
    }
  }

  opp(pid: PlayerId): PlayerId {
    return (1 - pid) as PlayerId;
  }

  card(id: number) {
    return this.cards.get(id);
  }

  // ───────────────────────────── queries ─────────────────────────────

  is(card: CardInstance, type: string) {
    // a bestowed creature is an Aura while it's attached
    if (type === 'Creature' && card.bestowed) return false;
    return card.def.types.includes(type);
  }
  isCreature(c: CardInstance) {
    return this.is(c, 'Creature');
  }
  isLand(c: CardInstance) {
    return this.is(c, 'Land');
  }
  isArtifact(c: CardInstance) {
    return this.is(c, 'Artifact');
  }
  isPermanentCard(c: CardInstance) {
    return !this.is(c, 'Instant') && !this.is(c, 'Sorcery');
  }
  hasSubtype(c: CardInstance, s: string) {
    if (c.def.subtypes.includes(s)) return true;
    // Changeling: every creature type (but not land/artifact/enchantment subtypes)
    if (c.def.changeling && !NON_CREATURE_SUBTYPES.has(s)) return true;
    for (const e of this.attachments(c)) if (e.def.grant?.subtypes?.includes(s)) return true;
    return false;
  }
  attachments(c: CardInstance) {
    return this.battlefield.filter((e) => e.attachedTo === c.id);
  }
  power(c: CardInstance): number {
    let p = (c.def.power ?? 0) + (c.counters['+1/+1'] ?? 0) - (c.counters['-1/-1'] ?? 0) + c.tempPower;
    for (const e of this.attachments(c)) p += this.grantValue(e.def.grant?.power, c, e);
    return p;
  }
  toughness(c: CardInstance): number {
    let t = (c.def.toughness ?? 0) + (c.counters['+1/+1'] ?? 0) - (c.counters['-1/-1'] ?? 0) + c.tempToughness;
    for (const e of this.attachments(c)) t += this.grantValue(e.def.grant?.toughness, c, e);
    return t;
  }
  hasKeyword(c: CardInstance, k: Keyword): boolean {
    if (c.def.keywords.includes(k) || c.tempKeywords.includes(k)) return true;
    if (c.nextTurnKeywords?.includes(k)) return true;
    for (const e of this.attachments(c)) if (e.def.grant?.keywords?.(this, c, e).includes(k)) return true;
    return false;
  }
  private grantValue(
    v: number | ((g: Game, host: CardInstance, self: CardInstance) => number) | undefined,
    host: CardInstance,
    self: CardInstance,
  ) {
    if (v === undefined) return 0;
    return typeof v === 'number' ? v : v(this, host, self);
  }
  isAura(c: CardInstance) {
    return !!c.bestowed || c.def.subtypes.includes('Aura');
  }
  /** colors this permanent has protection from */
  protections(c: CardInstance): string[] {
    const out: string[] = [];
    for (const e of this.attachments(c)) if (e.def.grant?.protectionFromChosen && e.chosenColor) out.push(e.chosenColor);
    return out;
  }
  protectedFrom(c: CardInstance, source: CardInstance) {
    const p = this.protections(c);
    return p.length > 0 && source.def.colors.some((col) => p.includes(col));
  }
  /** hexproof / protection check for something targeting a permanent */
  canBeTargetedBy(c: CardInstance, controller: PlayerId, source: CardInstance) {
    if (c.zone !== 'battlefield') return true;
    if (c.controller !== controller && this.hasKeyword(c, 'hexproof')) return false;
    if (this.protectedFrom(c, source)) return false;
    return true;
  }
  /** whether an Aura could legally be attached to this permanent */
  canEnchant(aura: CardInstance, host: CardInstance, controller: PlayerId) {
    switch (aura.def.enchant ?? (aura.def.bestow ? 'creature' : undefined)) {
      case 'creature':
        return this.isCreature(host);
      case 'creatureYouControl':
        return this.isCreature(host) && host.controller === controller;
      case 'land':
        return this.isLand(host);
      case 'Forest':
        return this.isLand(host) && this.hasSubtype(host, 'Forest');
      default:
        return false;
    }
  }
  mv(c: CardInstance) {
    return c.def.cmc;
  }
  permanents(pid?: PlayerId) {
    return pid === undefined ? this.battlefield : this.battlefield.filter((c) => c.controller === pid);
  }
  creatures(pid?: PlayerId) {
    return this.permanents(pid).filter((c) => this.isCreature(c));
  }
  artifacts(pid: PlayerId) {
    return this.permanents(pid).filter((c) => this.isArtifact(c));
  }
  lands(pid: PlayerId) {
    return this.permanents(pid).filter((c) => this.isLand(c));
  }
  isSick(c: CardInstance) {
    return c.enteredTick > this.turnStartTick[c.controller] && !this.hasKeyword(c, 'haste');
  }
  isMainPhase() {
    return this.step === 'main1' || this.step === 'main2';
  }
  canSorcery(pid: PlayerId) {
    return this.active === pid && this.isMainPhase() && this.stack.length === 0;
  }
  zoneList(c: CardInstance): CardInstance[] | null {
    const p = this.players[c.owner];
    switch (c.zone) {
      case 'library':
        return p.library;
      case 'hand':
        return p.hand;
      case 'graveyard':
        return p.graveyard;
      case 'exile':
        return p.exile;
      case 'battlefield':
        return this.battlefield;
      default:
        return null;
    }
  }

  // ───────────────────────────── zone movement ─────────────────────────────

  moveCard(
    c: CardInstance,
    to: Zone,
    opts: { tapped?: boolean; controller?: PlayerId; bottom?: boolean; silent?: boolean; attacking?: boolean; attachTo?: CardInstance } = {},
  ) {
    const from = c.zone;
    if (from === 'stack') {
      const i = this.stack.findIndex((s) => s.kind === 'spell' && s.card === c);
      if (i >= 0) this.stack.splice(i, 1);
    } else {
      const list = this.zoneList(c);
      if (list) {
        const i = list.indexOf(c);
        if (i >= 0) list.splice(i, 1);
      }
    }
    const wasCreature = this.isCreature(c);
    const wasArtifact = this.isArtifact(c);
    const prevController = c.controller;
    if (from === 'battlefield') {
      // transformed cards are their front face everywhere but the battlefield
      if (c.frontDef) {
        c.def = c.frontDef;
        c.frontDef = undefined;
      }
      c.castInfo = undefined;
      c.bestowed = false;
      c.nextTurnKeywords = undefined;
      c.goadedBy = undefined;
      c.lastActivated = undefined;
      // things attached to it fall off; it falls off what it is attached to
      for (const e of this.attachments(c)) if (!this.isAura(e)) e.attachedTo = null;
      c.attachedTo = null;
      c.tapped = false;
      c.damage = 0;
      c.deathtouched = false;
      c.counters = {};
      c.tempPower = 0;
      c.tempToughness = 0;
      c.tempKeywords = [];
      this.removeFromCombat(c);
    }
    if (to !== 'battlefield') c.controller = c.owner;
    c.zone = to;

    if (c.def.isToken && to !== 'battlefield') {
      c.zone = 'none';
    } else if (to === 'battlefield') {
      c.controller = opts.controller ?? c.controller;
      const et = c.def.entersTapped;
      c.tapped = !!opts.tapped || (typeof et === 'function' ? et(this, c) : !!et);
      c.enteredTick = ++this.tick;
      c.enteredTurn = this.turn;
      if (opts.attachTo) c.attachedTo = opts.attachTo.id;
      if (opts.attacking) {
        c.attacking = true;
        c.wasBlocked = false;
      }
      this.battlefield.push(c);
      if (this.isLand(c)) this.players[c.controller].landEnteredThisTurn = true;
    } else if (to === 'library') {
      if (opts.bottom) this.players[c.owner].library.push(c);
      else this.players[c.owner].library.unshift(c);
    } else {
      const list = this.zoneList(c);
      list?.push(c);
    }
    if (from === 'battlefield') this.pushFx({ type: 'leave', card: c, to });
    if (from === 'battlefield')
      this.emit({ type: 'ltb', card: c, to, wasCreature, wasArtifact, controller: prevController });
    if (to === 'battlefield') this.emit({ type: 'etb', card: c });
    this.changed();
  }

  removeFromCombat(c: CardInstance) {
    if (c.attacking) {
      c.attacking = false;
      for (const b of this.battlefield) if (b.blocking === c.id) b.blocking = null;
    }
    if (c.blocking !== null) {
      const a = this.card(c.blocking);
      if (a) a.blockedBy = a.blockedBy.filter((id) => id !== c.id);
      c.blocking = null;
    }
    c.blockedBy = [];
  }

  // ───────────────────────────── triggers ─────────────────────────────

  emit(ev: GameEvent) {
    const check = (card: CardInstance, zone: Zone) => {
      for (const t of card.def.triggers ?? []) {
        if (t.event !== ev.type) continue;
        if ((t.zone ?? 'battlefield') !== zone) continue;
        if (!t.match(this, card, ev)) continue;
        this.pendingTriggers.push({ trigger: t, source: card, controller: card.controller, event: ev });
      }
    };
    for (const c of this.battlefield) check(c, 'battlefield');
    if (ev.type === 'ltb') {
      // leaves-the-battlefield triggers look back in time
      const c = ev.card;
      if (!this.battlefield.includes(c)) {
        for (const t of c.def.triggers ?? []) {
          if (t.event !== 'ltb' || (t.zone ?? 'battlefield') !== 'battlefield') continue;
          if (!t.match(this, c, ev)) continue;
          this.pendingTriggers.push({ trigger: t, source: c, controller: ev.controller, event: ev });
        }
      }
    }
    for (const p of this.players) for (const c of p.graveyard) check(c, 'graveyard');
  }

  /** Adds a one-off triggered ability (madness, delayed effects…) */
  addTrigger(source: CardInstance, controller: PlayerId, text: string, resolve: (c: Ctx) => Promise<void>, targets?: TargetSpec[]) {
    this.pendingTriggers.push({
      trigger: { text, event: 'etb', match: () => true, resolve, targets },
      source,
      controller,
      event: { type: 'etb', card: source },
    });
  }

  private async flushTriggers(): Promise<boolean> {
    if (this.pendingTriggers.length === 0) return false;
    const pending = this.pendingTriggers;
    this.pendingTriggers = [];
    // APNAP: active player's triggers go on the stack first (resolve last)
    const ordered = [...pending.filter((p) => p.controller === this.active), ...pending.filter((p) => p.controller !== this.active)];
    for (const p of ordered) {
      const specs = p.trigger.targets ?? [];
      let targets: Target[][] = [];
      if (specs.length) {
        const chosen = await this.chooseTargets(p.controller, specs, p.source, false);
        if (!chosen) {
          this.log(`${p.source.def.name}'s trigger has no legal targets.`, p.controller);
          continue;
        }
        targets = chosen;
      }
      const item: StackItem = {
        id: this.nextId++,
        kind: 'ability',
        controller: p.controller,
        card: p.source,
        text: p.trigger.text,
        targets,
        specs,
        mode: 0,
        info: { method: 'normal', event: p.event },
        resolve: p.trigger.resolve,
        mv: 0,
      };
      this.stack.push(item);
      this.log(`${p.source.def.name} triggers: ${p.trigger.text}`, p.controller);
      this.pushFx({ type: 'trigger', card: p.source });
      this.checkWard(item);
    }
    this.changed();
    await this.pace(0.6);
    return true;
  }

  // ───────────────────────────── state-based actions ─────────────────────────────

  private checkSBA(): boolean {
    let changed = false;
    for (const p of this.players) {
      if (p.life <= 0 || p.drewFromEmpty) p.lost = true;
    }
    const losers = this.players.filter((p) => p.lost);
    if (losers.length) {
      this.winner = losers.length === 2 ? null : this.opp(losers[0].id);
      this.log(losers.length === 2 ? 'The game is a draw.' : `${this.players[this.winner!].name} wins!`);
      throw new GameOver(this.winner);
    }
    const dying: CardInstance[] = [];
    for (const c of this.battlefield) {
      if (!this.isCreature(c)) continue;
      const t = this.toughness(c);
      if (t <= 0) dying.push(c);
      else if ((c.damage >= t || (c.deathtouched && c.damage > 0)) && !this.hasKeyword(c, 'indestructible')) dying.push(c);
    }
    for (const c of dying) {
      this.log(`${c.def.name} dies.`, c.controller);
      this.moveCard(c, 'graveyard');
      changed = true;
    }
    for (const e of [...this.battlefield]) {
      if (this.isAura(e)) {
        const host = e.attachedTo !== null ? this.card(e.attachedTo) : undefined;
        if (!host || host.zone !== 'battlefield' || !this.canEnchant(e, host, e.controller)) {
          if (e.bestowed) {
            // bestow: it stops being an Aura and stays on the battlefield as a creature
            e.bestowed = false;
            e.attachedTo = null;
            this.log(`${e.def.name} is no longer attached and becomes a creature again.`, e.controller);
          } else {
            this.log(`${e.def.name} is put into the graveyard (nothing to enchant).`, e.controller);
            this.moveCard(e, 'graveyard');
          }
          changed = true;
        }
      } else if (e.attachedTo !== null) {
        const host = this.card(e.attachedTo);
        if (!host || host.zone !== 'battlefield' || !this.isCreature(host)) {
          e.attachedTo = null;
          changed = true;
        }
      }
    }
    return changed;
  }

  async stateCheck() {
    for (let guard = 0; guard < 50; guard++) {
      const a = this.checkSBA();
      const b = await this.flushTriggers();
      if (!a && !b) break;
    }
  }

  // ───────────────────────────── game loop ─────────────────────────────

  async run() {
    try {
      this.log(`${this.players[this.active].name} will play first.`);
      await this.mulligans();
      for (;;) await this.takeTurn();
    } catch (e) {
      if (!(e instanceof GameOver)) {
        console.error(e);
        this.log('Engine error: ' + (e as Error).message);
        throw e;
      }
      this.pending = null;
      this.changed();
    }
  }

  private async mulligans() {
    for (const pid of [this.active, this.opp(this.active)]) {
      const p = this.players[pid];
      for (;;) {
        this.draw(pid, 7, true);
        if (p.mulligans >= 6) break;
        const keep = await this.ask<boolean>(pid, { type: 'mulligan', player: pid, hand: [...p.hand], mulligans: p.mulligans });
        if (keep) break;
        p.mulligans++;
        this.log(`${p.name} mulligans.`, pid);
        for (const c of [...p.hand]) this.moveCard(c, 'library');
        this.shuffle(pid);
      }
      if (p.mulligans > 0) {
        const n = Math.min(p.mulligans, p.hand.length);
        const ids = await this.ask<number[]>(pid, { type: 'bottom', player: pid, cards: [...p.hand], count: n });
        for (const id of ids) this.moveCard(this.card(id)!, 'library', { bottom: true });
        this.log(`${p.name} keeps ${p.hand.length} cards.`, pid);
      } else this.log(`${p.name} keeps 7.`, pid);
    }
  }

  private async takeTurn() {
    this.turn++;
    const ap = this.active;
    this.turnStartTick[ap] = ++this.tick;
    this.spellsThisTurn = 0;
    for (const c of this.battlefield) {
      if (c.controller === ap && c.nextTurnKeywords) c.nextTurnKeywords = undefined;
      if (c.goadedBy === ap) c.goadedBy = undefined;
    }
    for (const p of this.players) {
      p.landsPlayedThisTurn = 0;
      p.drawsThisTurn = 0;
      p.landEnteredThisTurn = false;
    }
    this.log(`── Turn ${this.turn}: ${this.players[ap].name} ──`, ap);
    this.pushFx({ type: 'turn', player: ap });
    this.changed();
    await this.pace(1.6);

    this.step = 'untap';
    for (const c of this.permanents(ap)) {
      // "doesn't untap during its controller's next untap step" (Sleep of the Dead)
      if (c.counters.frozen) {
        delete c.counters.frozen;
        continue;
      }
      if (!c.tapped) continue;
      if ((c.counters.stun ?? 0) > 0) {
        c.counters.stun--;
        if (!c.counters.stun) delete c.counters.stun;
      } else c.tapped = false;
    }
    this.changed();

    this.step = 'upkeep';
    this.emit({ type: 'step', step: 'upkeep', active: ap });
    if (this.initiative === ap) {
      this.addTrigger(this.initiativeSource, ap, 'The initiative: venture into Undercity', async () => venture(this, ap, this.initiativeSource));
    }
    await this.priorityStep();

    this.step = 'draw';
    if (this.turn > 1) this.draw(ap, 1);
    await this.priorityStep();

    this.step = 'main1';
    await this.priorityStep();

    await this.combat();

    this.step = 'main2';
    await this.priorityStep();

    this.step = 'end';
    this.emit({ type: 'step', step: 'end', active: ap });
    if (this.monarch === ap) {
      const m = ap;
      this.addTrigger(this.monarchSource, m, 'The monarch draws a card.', async (c) => {
        if (this.monarch !== null) this.draw(this.monarch, 1);
      });
      this.monarchSource.controller = m;
    }
    await this.priorityStep();

    this.step = 'cleanup';
    const p = this.players[ap];
    if (p.hand.length > 7) {
      const n = p.hand.length - 7;
      const ids = await this.ask<number[]>(ap, {
        type: 'cards',
        player: ap,
        prompt: `Discard ${n} card${n > 1 ? 's' : ''} (maximum hand size)`,
        cards: [...p.hand],
        min: n,
        max: n,
        purpose: 'discard',
      });
      this.discardCards(ap, ids.map((id) => this.card(id)!));
    }
    for (const c of this.battlefield) {
      c.damage = 0;
      c.deathtouched = false;
      c.tempPower = 0;
      c.tempToughness = 0;
      c.tempKeywords = [];
    }
    for (const pl of this.players) {
      pl.pool = emptyPool();
      pl.copBlue = 0;
    }
    // madness triggers from cleanup discards
    if (this.pendingTriggers.length) {
      await this.priorityStep();
    }
    this.active = this.opp(ap);
  }

  async priorityStep() {
    this.priority = this.active;
    let passes = 0;
    for (;;) {
      await this.stateCheck();
      const pid = this.priority;
      const action = await this.ask<Action>(pid, { type: 'priority', player: pid });
      if (action.type === 'pass') {
        passes++;
        if (passes >= 2) {
          if (this.stack.length === 0) break;
          await this.resolveTop();
          passes = 0;
          this.priority = this.active;
          continue;
        }
        this.priority = this.opp(pid);
      } else {
        const ok = await this.perform(pid, action);
        if (ok) passes = 0;
      }
    }
    for (const p of this.players) p.pool = emptyPool();
    this.changed();
  }

  // ───────────────────────────── combat ─────────────────────────────

  canAttack(c: CardInstance) {
    return (
      this.isCreature(c) &&
      c.controller === this.active &&
      !c.tapped &&
      !this.isSick(c) &&
      !this.hasKeyword(c, 'defender')
    );
  }
  canBlock(blocker: CardInstance, attacker: CardInstance) {
    if (attacker.def.canBeBlockedBy && !attacker.def.canBeBlockedBy(this, attacker, blocker)) return false;
    if (this.protectedFrom(attacker, blocker)) return false;
    if (!this.isCreature(blocker) || blocker.tapped) return false;
    if (this.hasKeyword(attacker, 'flying') && !this.hasKeyword(blocker, 'flying') && !this.hasKeyword(blocker, 'reach'))
      return false;
    return true;
  }
  attackers() {
    return this.battlefield.filter((c) => c.attacking);
  }

  private async combat() {
    const ap = this.active;
    const dp = this.opp(ap);
    this.step = 'beginCombat';
    await this.priorityStep();

    this.step = 'declareAttackers';
    const cands = this.creatures(ap).filter((c) => this.canAttack(c));
    let ids: number[] = [];
    if (cands.length) ids = await this.ask<number[]>(ap, { type: 'attackers', player: ap, candidates: cands });
    const attackers = ids.map((id) => this.card(id)!).filter((c) => c && cands.includes(c));
    for (const c of cands) {
      if (c.goadedBy !== undefined && !attackers.includes(c)) {
        attackers.push(c);
        this.log(`${c.def.name} is goaded and must attack.`, ap);
      }
    }
    if (!attackers.length) {
      this.step = 'endCombat';
      this.changed();
      return;
    }
    for (const a of attackers) {
      a.attacking = true;
      a.wasBlocked = false;
      if (!this.hasKeyword(a, 'vigilance')) a.tapped = true;
    }
    this.log(`${this.players[ap].name} attacks with ${attackers.map((a) => a.def.name).join(', ')}.`, ap);
    this.pushFx({ type: 'combat', text: `${this.players[ap].name === 'You' ? 'You attack' : this.players[ap].name + ' attacks'} with ${attackers.length} creature${attackers.length > 1 ? 's' : ''}` });
    this.changed();
    await this.pace(1.2);
    await this.priorityStep();

    this.step = 'declareBlockers';
    const live = this.attackers();
    if (live.length) {
      const blockCands = this.creatures(dp).filter((c) => !c.tapped && live.some((a) => this.canBlock(c, a)));
      let blocks: Record<number, number> = {};
      if (blockCands.length)
        blocks = await this.ask<Record<number, number>>(dp, { type: 'blockers', player: dp, attackers: live, candidates: blockCands });
      for (const [bId, aId] of Object.entries(blocks)) {
        const b = this.card(+bId);
        const a = this.card(aId);
        if (!b || !a || !blockCands.includes(b) || !live.includes(a) || !this.canBlock(b, a)) continue;
        b.blocking = a.id;
        a.blockedBy.push(b.id);
        a.wasBlocked = true;
      }
      // menace: needs two or more blockers
      for (const a of live) {
        if (this.hasKeyword(a, 'menace') && a.blockedBy.length === 1) {
          const b = this.card(a.blockedBy[0])!;
          b.blocking = null;
          a.blockedBy = [];
          a.wasBlocked = false;
        }
      }
      for (const a of live)
        if (a.blockedBy.length)
          this.log(`${a.def.name} is blocked by ${a.blockedBy.map((id) => this.card(id)!.def.name).join(', ')}.`, dp);
      this.changed();
      await this.priorityStep();
    }

    const anyFirst = this.battlefield.some(
      (c) => (c.attacking || c.blocking !== null) && (this.hasKeyword(c, 'first strike') || this.hasKeyword(c, 'double strike')),
    );
    if (anyFirst) {
      this.step = 'firstStrikeDamage';
      await this.combatDamage(true);
      await this.priorityStep();
    }
    this.step = 'combatDamage';
    await this.combatDamage(false, anyFirst);
    await this.priorityStep();

    this.step = 'endCombat';
    await this.priorityStep();
    for (const c of this.battlefield) {
      c.attacking = false;
      c.blocking = null;
      c.blockedBy = [];
      c.wasBlocked = false;
    }
    this.changed();
  }

  private async combatDamage(firstStrikeStep: boolean, hadFirstStrike = false) {
    const deals = (c: CardInstance) => {
      const fs = this.hasKeyword(c, 'first strike');
      const ds = this.hasKeyword(c, 'double strike');
      if (firstStrikeStep) return fs || ds;
      if (!hadFirstStrike) return true;
      return !fs || ds;
    };
    const dp = this.opp(this.active);
    const assignments: { src: CardInstance; to: CardInstance | PlayerId; n: number }[] = [];
    for (const a of this.attackers()) {
      if (!deals(a)) continue;
      let power = this.power(a);
      if (power <= 0) continue;
      const blockers = a.blockedBy.map((id) => this.card(id)!).filter((b) => b && b.zone === 'battlefield');
      if (!a.wasBlocked) {
        assignments.push({ src: a, to: dp, n: power });
        continue;
      }
      if (!blockers.length) {
        if (this.hasKeyword(a, 'trample')) assignments.push({ src: a, to: dp, n: power });
        continue;
      }
      const dt = this.hasKeyword(a, 'deathtouch');
      for (let i = 0; i < blockers.length && power > 0; i++) {
        const b = blockers[i];
        const lethal = dt ? 1 : Math.max(0, this.toughness(b) - b.damage);
        const last = i === blockers.length - 1;
        const amt = last && !this.hasKeyword(a, 'trample') ? power : Math.min(power, lethal);
        if (amt > 0) assignments.push({ src: a, to: b, n: amt });
        power -= amt;
      }
      if (power > 0) assignments.push({ src: a, to: dp, n: power });
    }
    for (const b of this.battlefield) {
      if (b.blocking === null || !deals(b)) continue;
      const a = this.card(b.blocking);
      if (!a || a.zone !== 'battlefield') continue;
      const p = this.power(b);
      if (p > 0) assignments.push({ src: b, to: a, n: p });
    }
    const playerHits = new Map<number, { src: CardInstance; player: PlayerId; n: number }>();
    for (const as of assignments) {
      if (typeof as.to === 'number') {
        const dealt = this.dealDamage(as.src, { kind: 'player', pid: as.to }, as.n, true);
        if (dealt > 0) playerHits.set(as.src.id, { src: as.src, player: as.to, n: dealt });
      } else this.dealDamage(as.src, { kind: 'card', id: as.to.id }, as.n, true);
    }
    this.changed();
    await this.pace(1.4);
    for (const h of playerHits.values()) {
      this.emit({ type: 'combatDamagePlayer', source: h.src, player: h.player, amount: h.n });
      if (this.monarch === h.player) this.becomeMonarch(h.src.controller);
      if (this.initiative === h.player && h.src.controller !== h.player) {
        const taker = h.src.controller;
        this.initiative = taker; // only once per combat even if several creatures connect
        this.addTrigger(this.initiativeSource, taker, 'Take the initiative', async () => this.takeInitiative(taker));
      }
    }
    this.changed();
  }

  // ───────────────────────────── mana ─────────────────────────────

  manaSources(pid: PlayerId, exclude?: Set<number>): ManaSource[] {
    const out: ManaSource[] = [];
    for (const c of this.permanents(pid)) {
      if (c.tapped || exclude?.has(c.id)) continue;
      if (this.isCreature(c) && this.isSick(c)) continue;
      const abilities = c.def.activated ?? [];
      for (let i = 0; i < abilities.length; i++) {
        const a = abilities[i];
        if (!isManaAbility(a) || a.cost.mana || !a.cost.tap || a.cost.sacSelf) continue;
        out.push({ id: c.id, options: this.produceOptions(c, i) });
        break;
      }
    }
    return out;
  }

  /** Mana a mana ability makes, including bonuses from Auras like Utopia Sprawl / Abundant Growth. */
  produceOptions(c: CardInstance, index: number): ManaColor[][] {
    const a = c.def.activated?.[index];
    if (!a || !isManaAbility(a)) return [];
    let opts = (a.producesFn ? a.producesFn(this, c) : a.produces!).map((o) => [...o]);
    const plainTap = a.cost.tap && !a.cost.mana && !a.cost.sacSelf;
    if (plainTap && this.isLand(c)) {
      for (const e of this.attachments(c)) {
        if (!e.def.grant?.anyColorMana) continue;
        for (const col of ['W', 'U', 'B', 'R', 'G'] as ManaColor[])
          if (!opts.some((o) => o.length === 1 && o[0] === col)) opts.push([col]);
      }
      for (const e of this.attachments(c)) {
        if (e.def.grant?.extraChosenMana && e.chosenColor) opts = opts.map((o) => [...o, e.chosenColor as ManaColor]);
      }
    }
    return opts;
  }

  /**
   * Phyrexian symbols ({R/P}) can be paid with mana or 2 life each.
   * Returns the all-mana version and the all-life version (with its life cost).
   */
  private phyrexianOptions(cost: Cost): { asMana: Cost; asLife: Cost; life: number } | null {
    if (!cost.phyrexian?.length) return null;
    const asMana: Cost = { ...cost, phyrexian: undefined };
    for (const col of cost.phyrexian) (asMana as any)[col]++;
    return { asMana, asLife: { ...cost, phyrexian: undefined }, life: 2 * cost.phyrexian.length };
  }

  /** "{1}, {T}: Add one mana of any color" style abilities usable to fix colors while paying */
  private filterAbilities(pid: PlayerId, exclude?: Set<number>) {
    const out: { card: CardInstance; n: number; tap: boolean }[] = [];
    for (const c of this.permanents(pid)) {
      if (exclude?.has(c.id)) continue;
      for (const a of c.def.activated ?? []) {
        if (!a.produces || !a.cost.mana || a.cost.sacSelf || a.produces.length < 5) continue;
        if (a.cost.tap && (c.tapped || (this.isCreature(c) && this.isSick(c)))) continue;
        out.push({ card: c, n: costMV(parseCost(a.cost.mana)), tap: !!a.cost.tap });
        break;
      }
    }
    return out.sort((a, b) => a.n - b.n);
  }

  /**
   * Find a way to pay: plain sources first; if colors are missing, route some colored symbols through
   * filters (each one turns N mana of any kind into one mana of the color we need).
   */
  private planPayment(pid: PlayerId, cost: Cost, exclude?: Set<number>): { cost: Cost; filters: { card: CardInstance; color: string }[] } | null {
    const pool = this.players[pid].pool;
    if (solvePayment(cost, pool, this.manaSources(pid, exclude))) return { cost, filters: [] };
    const filters = this.filterAbilities(pid, exclude);
    if (!filters.length) return null;
    const slots: string[] = [];
    for (const k of ['W', 'U', 'B', 'R', 'G'] as const) for (let i = 0; i < cost[k]; i++) slots.push(k);
    const max = Math.min(slots.length, 3);
    const combos = (k: number, start = 0): number[][] =>
      k === 0 ? [[]] : slots.slice(start).flatMap((_, i) => combos(k - 1, start + i + 1).map((rest) => [start + i, ...rest]));
    for (let m = 1; m <= max; m++) {
      for (const combo of combos(m)) {
        const c2: Cost = { ...cost };
        const used: { card: CardInstance; color: string }[] = [];
        const ex = new Set(exclude ?? []);
        let ok = true;
        let fi = 0;
        for (const slot of combo) {
          // tap-filters are used once; untapped ones (Energy Refractor) can be used again
          let f = filters[fi];
          while (f && f.tap && ex.has(f.card.id)) f = filters[++fi];
          if (!f) {
            ok = false;
            break;
          }
          const color = slots[slot];
          (c2 as any)[color]--;
          c2.generic += f.n;
          used.push({ card: f.card, color });
          if (f.tap) ex.add(f.card.id);
        }
        if (ok && solvePayment(c2, pool, this.manaSources(pid, ex))) return { cost: c2, filters: used };
      }
    }
    return null;
  }

  canPay(pid: PlayerId, cost: Cost, exclude?: Set<number>): boolean {
    const ph = this.phyrexianOptions(cost);
    if (ph) {
      if (this.canPay(pid, ph.asMana, exclude)) return true;
      return this.players[pid].life > ph.life && this.canPay(pid, ph.asLife, exclude);
    }
    return !!this.planPayment(pid, cost, exclude);
  }

  async payMana(pid: PlayerId, cost: Cost): Promise<boolean> {
    const ph = this.phyrexianOptions(cost);
    if (ph) {
      // pay with mana when we can, otherwise with life
      if (this.canPay(pid, ph.asMana)) return this.payMana(pid, ph.asMana);
      if (this.players[pid].life <= ph.life || !this.canPay(pid, ph.asLife)) return false;
      this.loseLife(pid, ph.life);
      return this.payMana(pid, ph.asLife);
    }
    if (costMV(cost) === 0) return true;
    const plan = this.planPayment(pid, cost);
    if (!plan) return false;
    const ex = new Set<number>();
    for (const f of plan.filters) {
      if ((f.card.def.activated ?? []).some((a) => a.produces && a.cost.mana && a.cost.tap)) {
        f.card.tapped = true;
        ex.add(f.card.id);
      }
      this.log(`${f.card.def.name} filters mana into {${f.color}}.`, pid);
    }
    const sol = solvePayment(plan.cost, this.players[pid].pool, this.manaSources(pid, ex));
    if (!sol) return false;
    for (const t of sol.taps) {
      const c = this.card(t.id)!;
      c.tapped = true;
    }
    this.players[pid].pool = sol.poolAfter;
    this.changed();
    return true;
  }

  addMana(pid: PlayerId, mana: ManaColor[]) {
    for (const m of mana) this.players[pid].pool[m]++;
    this.changed();
  }

  /** Mana abilities of a permanent that can be used right now. */
  manaAbilities(pid: PlayerId, card: CardInstance) {
    return (card.def.activated ?? [])
      .map((a, i) => ({ a, i }))
      .filter((x) => isManaAbility(x.a) && this.canActivate(pid, card, x.i));
  }

  /** Manually tap a permanent for mana (clicking a land). Synchronous: it never asks questions. */
  manualMana(pid: PlayerId, card: CardInstance, index: number, option: number): boolean {
    const a = card.def.activated?.[index];
    if (!a || !isManaAbility(a) || !this.canActivate(pid, card, index)) return false;
    if (a.cost.mana) {
      const exclude = a.cost.tap ? new Set([card.id]) : undefined;
      const sol = solvePayment(parseCost(a.cost.mana), this.players[pid].pool, this.manaSources(pid, exclude));
      if (!sol) return false;
      for (const t of sol.taps) this.card(t.id)!.tapped = true;
      this.players[pid].pool = sol.poolAfter;
    }
    const opts = this.produceOptions(card, index);
    if (a.cost.tap) card.tapped = true;
    if (a.cost.sacSelf) this.sacrifice(card);
    this.addMana(pid, opts[option] ?? opts[0]);
    return true;
  }

  // ───────────────────────────── costs ─────────────────────────────

  spellCost(pid: PlayerId, card: CardInstance, method: CastInfo['method'], altIndex?: number, x = 0, kicked = false, replicate = 0): Cost {
    const d = card.def;
    let cost: Cost;
    switch (method) {
      case 'madness':
        cost = parseCost(d.madness);
        break;
      case 'flashback':
        cost = parseCost(d.flashback?.mana);
        break;
      case 'alt':
        cost = parseCost(d.altCosts?.[altIndex ?? 0]?.mana);
        break;
      case 'overload':
        cost = parseCost(d.overload);
        break;
      case 'plot':
        cost = parseCost('');
        break;
      case 'bestow':
        cost = parseCost(d.bestow);
        break;
      case 'omen':
        cost = parseCost(d.omen?.manaCost);
        break;
      case 'foretell':
        cost = parseCost(d.foretell);
        break;
      default:
        cost = parseCost(d.manaCost);
    }
    if (d.affinity && (method === 'normal' || method === 'madness')) {
      cost.generic = Math.max(0, cost.generic - this.artifacts(pid).length);
    }
    if (d.costReduction && (method === 'normal' || method === 'madness')) {
      cost.generic = Math.max(0, cost.generic - d.costReduction(this, card, pid));
    }
    // {X}: the chosen value is paid as generic mana
    if (cost.x) cost.generic += cost.x * x;
    if (kicked && d.kicker) cost = addCosts(cost, parseCost(d.kicker));
    for (let i = 0; i < replicate && d.replicate; i++) cost = addCosts(cost, parseCost(d.replicate));
    return cost;
  }

  /** Candidate cards for an additional cost */
  additionalCostCards(pid: PlayerId, card: CardInstance): CardInstance[] {
    const ac = card.def.additionalCost;
    if (!ac) return [];
    if (ac.kind === 'discard') return this.players[pid].hand.filter((c) => c !== card);
    if (ac.kind === 'sacrifice') return this.permanents(pid).filter((c) => ac.filter?.(this, c) ?? true);
    if (ac.kind === 'collectEvidence') return this.players[pid].graveyard.filter((c) => c !== card);
    return [];
  }

  // ───────────────────────────── legal actions ─────────────────────────────

  canPlayLand(pid: PlayerId, c: CardInstance) {
    return (
      c.zone === 'hand' &&
      c.owner === pid &&
      this.isLand(c) &&
      this.canSorcery(pid) &&
      this.players[pid].landsPlayedThisTurn < 1
    );
  }

  private timingOk(pid: PlayerId, c: CardInstance, method: CastInfo['method']) {
    if (method === 'madness') return true;
    if (method === 'plot') return this.canSorcery(pid);
    if (this.is(c, 'Instant') || this.hasKeyword(c, 'flash')) return true;
    return this.canSorcery(pid);
  }

  modesFor(c: CardInstance, method: CastInfo['method']): SpellMode[] {
    if (method === 'bestow') return [{ text: `${c.def.name} (bestow)`, targets: [BESTOW_TARGET], resolve: async () => {} }];
    if (method === 'omen' && c.def.omen) return [{ text: c.def.omen.name, resolve: c.def.omen.resolve }];
    const s = c.def.spell;
    if (s?.modes) return s.modes;
    return [{ text: '', targets: s?.targets, resolve: s?.resolve ?? (async () => {}) }];
  }

  hasTargetsFor(pid: PlayerId, specs: TargetSpec[] | undefined, source: CardInstance) {
    if (!specs?.length) return true;
    const chosen: Target[][] = [];
    for (const spec of specs) {
      const cands = this.candidates(spec, { controller: pid, source, chosen });
      if (cands.length < (spec.min ?? 1)) return false;
      chosen.push(cands.slice(0, spec.min ?? 1));
    }
    return true;
  }

  /** Can `pid` cast `c` with this method right now (ignoring priority)? */
  canCast(pid: PlayerId, c: CardInstance, method: CastInfo['method'], altIndex?: number, ignoreTiming = false): boolean {
    if (this.isLand(c)) return false;
    if (!ignoreTiming && !this.timingOk(pid, c, method)) return false;
    const d = c.def;
    if (method === 'normal' || method === 'alt' || method === 'overload' || method === 'bestow' || method === 'omen') {
      if (c.zone !== 'hand' || c.owner !== pid) return false;
    }
    if (method === 'bestow' && !d.bestow) return false;
    if (method === 'omen' && !d.omen) return false;
    if (d.castCondition && !d.castCondition(this, c, pid)) return false;
    if (method === 'flashback' && (c.zone !== 'graveyard' || !d.flashback || c.owner !== pid)) return false;
    if (method === 'plot' && (c.zone !== 'exile' || c.plottedTurn === null || c.plottedTurn >= this.turn || c.owner !== pid))
      return false;
    if (method === 'madness' && c.zone !== 'exile') return false;
    if (method === 'foretell' && (c.zone !== 'exile' || !d.foretell || c.foretoldTurn === undefined || c.foretoldTurn >= this.turn || c.owner !== pid))
      return false;
    if (method === 'overload' && !d.overload) return false;
    if (method === 'alt') {
      const alt = d.altCosts?.[altIndex ?? 0];
      if (!alt || !alt.canPay(this, c, pid)) return false;
    }
    if (method === 'flashback' && d.flashback?.canPay && !d.flashback.canPay(this, c, pid)) return false;
    // additional costs
    const ac = d.additionalCost;
    if (ac && !ac.optional) {
      const n = this.additionalCostCards(pid, c).length;
      if (n < (ac.amount ?? 1)) return false;
    }
    if (method !== 'overload') {
      const modes = this.modesFor(c, method);
      if (!modes.some((m) => this.hasTargetsFor(pid, m.targets, c))) return false;
    }
    return this.canPay(pid, this.spellCost(pid, c, method, altIndex));
  }

  castOptions(pid: PlayerId, c: CardInstance, ignoreTiming = false): CastOption[] {
    const out: CastOption[] = [];
    if (this.isLand(c)) return out;
    const d = c.def;
    if (c.zone === 'hand') {
      if (this.canCast(pid, c, 'normal', undefined, ignoreTiming)) out.push({ method: 'normal', label: `Cast ${d.name}` });
      d.altCosts?.forEach((alt, i) => {
        if (this.canCast(pid, c, 'alt', i, ignoreTiming)) out.push({ method: 'alt', altIndex: i, label: alt.label });
      });
      if (d.overload && this.canCast(pid, c, 'overload', undefined, ignoreTiming))
        out.push({ method: 'overload', label: `Overload (${d.overload})` });
      if (d.bestow && this.canCast(pid, c, 'bestow', undefined, ignoreTiming)) out.push({ method: 'bestow', label: `Bestow ${d.bestow}` });
      if (d.omen && this.canCast(pid, c, 'omen', undefined, ignoreTiming))
        out.push({ method: 'omen', label: `Cast ${d.omen.name} ${d.omen.manaCost}` });
    } else if (c.zone === 'graveyard') {
      if (this.canCast(pid, c, 'flashback', undefined, ignoreTiming))
        out.push({ method: 'flashback', label: d.flashback?.label ?? `Flashback ${d.flashback?.mana ?? d.flashback?.altLabel ?? ''}` });
    } else if (c.zone === 'exile') {
      if (this.canCast(pid, c, 'plot', undefined, ignoreTiming)) out.push({ method: 'plot', label: 'Cast plotted card (free)' });
      if (this.canCast(pid, c, 'foretell', undefined, ignoreTiming)) out.push({ method: 'foretell', label: `Cast foretold ${d.name} ${d.foretell}` });
    }
    return out;
  }

  abilityZone(a: ActivatedDef) {
    return a.zone ?? 'battlefield';
  }

  canActivate(pid: PlayerId, c: CardInstance, index: number): boolean {
    const a = c.def.activated?.[index];
    if (!a) return false;
    const zone = this.abilityZone(a);
    if (c.zone !== zone) return false;
    if (zone === 'battlefield' ? c.controller !== pid : c.owner !== pid) return false;
    if (a.sorcery && !this.canSorcery(pid)) return false;
    if (a.canActivate && !a.canActivate(this, c, pid)) return false;
    if (a.oncePerTurn && c.lastActivated?.[index] === this.turn) return false;
    const cost = a.cost;
    const exclude = new Set<number>();
    if (cost.returnPermanent && !this.permanents(pid).some((x) => cost.returnPermanent!.filter(this, x))) return false;
    if (cost.tap) {
      if (c.tapped) return false;
      if (this.isCreature(c) && this.isSick(c)) return false;
      exclude.add(c.id);
    }
    if (cost.sacSelf) exclude.add(c.id);
    if (cost.life && this.players[pid].life < cost.life) return false;
    if (cost.sacrifice) {
      const n = this.permanents(pid).filter((x) => cost.sacrifice!.filter(this, x)).length;
      if (n < (cost.sacrifice.count ?? 1)) return false;
    }
    if (cost.discard && this.players[pid].hand.filter((x) => x !== c).length < cost.discard) return false;
    if (cost.returnUnblocked) {
      if (!(this.step === 'declareBlockers' || this.step === 'combatDamage' || this.step === 'firstStrikeDamage')) return false;
      if (!this.attackers().some((x) => x.controller === pid && !x.wasBlocked)) return false;
    }
    if (!this.hasTargetsFor(pid, a.targets, c)) return false;
    if (cost.mana && !this.canPay(pid, parseCost(cost.mana), exclude)) return false;
    return true;
  }

  /** All non-mana things pid could do right now (assuming they have priority). */
  legalActions(pid: PlayerId): Action[] {
    const out: Action[] = [];
    const p = this.players[pid];
    for (const c of p.hand) {
      if (this.canPlayLand(pid, c)) out.push({ type: 'playLand', cardId: c.id });
      for (const o of this.castOptions(pid, c)) out.push({ type: 'cast', cardId: c.id, method: o.method, altIndex: o.altIndex });
    }
    for (const c of p.graveyard)
      for (const o of this.castOptions(pid, c)) out.push({ type: 'cast', cardId: c.id, method: o.method });
    for (const c of p.exile) for (const o of this.castOptions(pid, c)) out.push({ type: 'cast', cardId: c.id, method: o.method });
    const withAbilities = [...this.permanents(pid), ...p.hand, ...p.graveyard];
    for (const c of withAbilities) {
      (c.def.activated ?? []).forEach((a, i) => {
        if (isManaAbility(a)) return;
        if (this.canActivate(pid, c, i)) out.push({ type: 'activate', cardId: c.id, index: i });
      });
    }
    return out;
  }

  async perform(pid: PlayerId, action: Action): Promise<boolean> {
    if (action.type === 'pass') return false;
    const c = this.card(action.cardId);
    if (!c) return false;
    if (action.type === 'playLand') {
      if (!this.canPlayLand(pid, c)) return false;
      this.players[pid].landsPlayedThisTurn++;
      this.log(`${this.players[pid].name} plays ${c.def.name}.`, pid);
      this.moveCard(c, 'battlefield');
      return true;
    }
    if (action.type === 'cast') return this.castSpell(pid, c, action.method, action.altIndex, true);
    if (action.type === 'activate') return this.activate(pid, c, action.index, true);
    return false;
  }

  // ───────────────────────────── targeting ─────────────────────────────

  candidates(spec: TargetSpec, ctx: TargetCtx): Target[] {
    let all: Target[] = [];
    const players: Target[] = [
      { kind: 'player', pid: 0 },
      { kind: 'player', pid: 1 },
    ];
    switch (spec.kind) {
      case 'any':
        all = [...this.creatures().map((c) => ({ kind: 'card', id: c.id }) as Target), ...players];
        break;
      case 'player':
        all = players;
        break;
      case 'permanent':
        all = this.battlefield.map((c) => ({ kind: 'card', id: c.id }));
        break;
      case 'stack':
        all = this.stack.filter((s) => s.card !== ctx.source || s.kind !== 'spell').map((s) => ({ kind: 'stack', id: s.id }));
        break;
      case 'graveyardCard':
        all = [...this.players[0].graveyard, ...this.players[1].graveyard].map((c) => ({ kind: 'card', id: c.id }));
        break;
    }
    const used = new Set<string>();
    for (const i of spec.distinctFrom ?? []) for (const t of ctx.chosen[i] ?? []) used.add(targetKey(t));
    return all.filter((t) => {
      if (used.has(targetKey(t))) return false;
      if (t.kind === 'card') {
        const c = this.card(t.id);
        if (c && !this.canBeTargetedBy(c, ctx.controller, ctx.source)) return false;
      }
      return spec.filter ? spec.filter(this, t, ctx) : true;
    });
  }

  isTargetLegal(spec: TargetSpec, t: Target, ctx: TargetCtx): boolean {
    if (t.kind === 'player') return (spec.kind === 'any' || spec.kind === 'player') && (spec.filter ? spec.filter(this, t, ctx) : true);
    if (t.kind === 'stack') return spec.kind === 'stack' && this.stack.some((s) => s.id === t.id) && (spec.filter ? spec.filter(this, t, ctx) : true);
    const c = this.card(t.id);
    if (!c) return false;
    if (spec.kind === 'graveyardCard') {
      if (c.zone !== 'graveyard') return false;
    } else if (c.zone !== 'battlefield') return false;
    if (spec.kind === 'any' && !this.isCreature(c)) return false;
    if (!this.canBeTargetedBy(c, ctx.controller, ctx.source)) return false;
    return spec.filter ? spec.filter(this, t, ctx) : true;
  }

  async chooseTargets(pid: PlayerId, specs: TargetSpec[], source: CardInstance, cancellable: boolean): Promise<Target[][] | null> {
    const chosen: Target[][] = [];
    for (const spec of specs) {
      const cands = this.candidates(spec, { controller: pid, source, chosen });
      const min = spec.min ?? 1;
      if (cands.length < min) return null;
      if ((spec.max ?? 1) === 0) {
        chosen.push([]);
        continue;
      }
      const picked = await this.ask<Target[] | null>(pid, {
        type: 'targets',
        player: pid,
        spec,
        candidates: cands,
        source,
        cancellable,
      });
      if (!picked) return null;
      chosen.push(picked);
    }
    return chosen;
  }

  resolveTarget(t: Target | undefined): CardInstance | PlayerId | StackItem | undefined {
    if (!t) return undefined;
    if (t.kind === 'player') return t.pid;
    if (t.kind === 'card') return this.card(t.id);
    return this.stack.find((s) => s.id === t.id);
  }

  // ───────────────────────────── casting ─────────────────────────────

  async castSpell(
    pid: PlayerId,
    c: CardInstance,
    method: CastInfo['method'],
    altIndex?: number,
    cancellable = true,
  ): Promise<boolean> {
    if (!this.canCast(pid, c, method, altIndex, method === 'madness')) return false;
    const d = c.def;
    const info: CastInfo = { method, altIndex };

    // 1. mode
    const modes = this.modesFor(c, method);
    let mode = 0;
    if (d.spell?.modes && method !== 'overload' && method !== 'bestow' && method !== 'omen') {
      const opts = modes.map((m) => ({ text: m.text, enabled: this.hasTargetsFor(pid, m.targets, c) }));
      const r = await this.ask<number | null>(pid, { type: 'mode', player: pid, source: c, options: opts, cancellable });
      if (r === null || r === undefined) return false;
      mode = r;
    }
    const specs = method === 'overload' ? [] : modes[mode].targets ?? [];

    // 2. targets
    let targets: Target[][] = [];
    if (specs.length) {
      const t = await this.chooseTargets(pid, specs, c, cancellable);
      if (!t) return false;
      targets = t;
    }

    // 2b. choose X (up to what we can afford)
    if (this.spellCost(pid, c, method, altIndex, 0).x) {
      let max = 0;
      while (max < 30 && this.canPay(pid, this.spellCost(pid, c, method, altIndex, max + 1))) max++;
      const x = await this.ask<number | null>(pid, {
        type: 'number',
        player: pid,
        prompt: `${d.name}: choose X`,
        min: 0,
        max,
        source: c,
        purpose: 'x',
      });
      if (x === null || x === undefined) return false;
      info.x = Math.max(0, Math.min(max, x));
    }

    // 3. choose additional costs
    const ac = d.additionalCost;
    let addCards: CardInstance[] = [];
    if (ac) {
      const cands = this.additionalCostCards(pid, c);
      if (ac.kind === 'collectEvidence') {
        const total = cands.reduce((s, x) => s + x.def.cmc, 0);
        if (total >= (ac.amount ?? 6)) {
          const yes = await this.yesNo(pid, `Collect evidence ${ac.amount ?? 6} for ${d.name}?`, 'evidence', c);
          if (yes) {
            for (;;) {
              const ids = await this.ask<number[] | null>(pid, {
                type: 'cards',
                player: pid,
                prompt: `Exile cards from your graveyard with total mana value ${ac.amount ?? 6} or more`,
                cards: cands,
                min: 1,
                max: cands.length,
                purpose: 'evidence',
                source: c,
                cancellable,
              });
              if (!ids) return false;
              const sel = ids.map((id) => this.card(id)!);
              if (sel.reduce((s, x) => s + x.def.cmc, 0) >= (ac.amount ?? 6)) {
                addCards = sel;
                info.evidence = true;
                break;
              }
            }
          }
        }
      } else {
        const n = ac.amount ?? 1;
        const ids = await this.ask<number[] | null>(pid, {
          type: 'cards',
          player: pid,
          prompt: ac.prompt,
          cards: cands,
          min: ac.optional ? 0 : n,
          max: n,
          purpose: ac.kind === 'discard' ? 'discard' : 'sacrifice',
          source: c,
          cancellable,
        });
        if (!ids) return false;
        addCards = ids.map((id) => this.card(id)!);
      }
    }

    // 4. pay mana
    // 2c. kicker / replicate
    if (d.kicker && this.canPay(pid, this.spellCost(pid, c, method, altIndex, info.x ?? 0, true))) {
      info.kicked = await this.yesNo(pid, `Pay kicker ${d.kicker} for ${d.name}?`, 'kicker', c);
    }
    if (d.replicate) {
      let max = 0;
      while (max < 10 && this.canPay(pid, this.spellCost(pid, c, method, altIndex, info.x ?? 0, info.kicked, max + 1))) max++;
      if (max > 0) {
        const r = await this.ask<number | null>(pid, {
          type: 'number',
          player: pid,
          prompt: `${d.name}: how many times to pay replicate ${d.replicate}?`,
          min: 0,
          max,
          source: c,
          purpose: 'replicate',
        });
        if (r === null || r === undefined) return false;
        info.replicate = Math.max(0, Math.min(max, r));
      }
    }
    info.storm = this.spellsThisTurn;
    const cost = this.spellCost(pid, c, method, altIndex, info.x ?? 0, info.kicked, info.replicate ?? 0);
    if (!(await this.payMana(pid, cost))) {
      this.log(`Couldn't pay for ${d.name}.`, pid);
      return false;
    }
    // 5. alternative / flashback non-mana costs
    if (method === 'alt') {
      const ok = await d.altCosts![altIndex ?? 0].pay(this, c, pid);
      if (!ok) return false;
    }
    if (method === 'flashback' && d.flashback?.pay) {
      const ok = await d.flashback.pay(this, c, pid);
      if (!ok) return false;
    }
    // 6. additional costs
    if (ac && addCards.length) {
      if (ac.kind === 'discard') {
        info.discarded = addCards[0];
        this.discardCards(pid, addCards);
      } else if (ac.kind === 'sacrifice') {
        const s = addCards[0];
        info.sacrificed = { mv: s.def.cmc, name: s.def.name, wasCreature: this.isCreature(s) };
        for (const x of addCards) this.sacrifice(x);
      } else if (ac.kind === 'collectEvidence') {
        for (const x of addCards) this.moveCard(x, 'exile');
      }
    }

    // 7. put on stack
    const list = this.zoneList(c);
    if (list) list.splice(list.indexOf(c), 1);
    c.zone = 'stack';
    c.plottedTurn = null;
    const item: StackItem = {
      id: this.nextId++,
      kind: 'spell',
      controller: pid,
      card: c,
      text: modes[mode].text || d.name,
      targets,
      specs,
      mode,
      info,
      mv: d.cmc,
    };
    this.stack.push(item);
    this.spellsThisTurn++;
    this.pushFx({ type: 'cast', card: c, controller: pid, text: modes[mode].text });
    const how = method === 'normal' ? '' : method === 'alt' ? ` (${d.altCosts![altIndex ?? 0].label})` : ` (${method})`;
    this.log(`${this.players[pid].name} casts ${d.name}${how}${this.describeTargets(targets)}.`, pid);
    this.checkWard(item);
    this.emit({ type: 'cast', card: c, controller: pid });
    this.changed();
    return true;
  }

  describeTargets(targets: Target[][]) {
    const names = targets.flat().map((t) => this.targetName(t));
    return names.length ? ` targeting ${names.join(', ')}` : '';
  }
  targetName(t: Target): string {
    if (t.kind === 'player') return this.players[t.pid].name;
    if (t.kind === 'card') return this.card(t.id)?.def.name ?? '?';
    const s = this.stack.find((x) => x.id === t.id);
    return s ? s.card.def.name + (s.kind === 'ability' ? ' ability' : '') : '?';
  }

  async activate(pid: PlayerId, c: CardInstance, index: number, cancellable = true): Promise<boolean> {
    if (!this.canActivate(pid, c, index)) return false;
    const a = c.def.activated![index];
    const cost = a.cost;

    // mana abilities
    if (isManaAbility(a)) {
      const produces = this.produceOptions(c, index);
      let opt = 0;
      if (produces.length > 1) {
        const r = await this.ask<number | null>(pid, { type: 'color', player: pid, options: produces, source: c });
        if (r === null || r === undefined) return false;
        opt = r;
      }
      if (cost.mana && !(await this.payMana(pid, parseCost(cost.mana)))) return false;
      if (cost.tap) c.tapped = true;
      if (cost.sacSelf) this.sacrifice(c);
      this.addMana(pid, produces[opt]);
      return true;
    }

    let targets: Target[][] = [];
    if (a.targets?.length) {
      const t = await this.chooseTargets(pid, a.targets, c, cancellable);
      if (!t) return false;
      targets = t;
    }
    let sacs: CardInstance[] = [];
    if (cost.sacrifice) {
      const cands = this.permanents(pid).filter((x) => cost.sacrifice!.filter(this, x));
      const n = cost.sacrifice.count ?? 1;
      const ids = await this.ask<number[] | null>(pid, {
        type: 'cards',
        player: pid,
        prompt: cost.sacrifice.prompt,
        cards: cands,
        min: n,
        max: n,
        purpose: 'sacrifice',
        source: c,
        cancellable,
      });
      if (!ids) return false;
      sacs = ids.map((id) => this.card(id)!);
    }
    let discards: CardInstance[] = [];
    if (cost.discard) {
      const cands = this.players[pid].hand.filter((x) => x !== c);
      const ids = await this.ask<number[] | null>(pid, {
        type: 'cards',
        player: pid,
        prompt: `Discard ${cost.discard} card(s) to activate ${c.def.name}`,
        cards: cands,
        min: cost.discard,
        max: cost.discard,
        purpose: 'discard',
        source: c,
        cancellable,
      });
      if (!ids) return false;
      discards = ids.map((id) => this.card(id)!);
    }
    let returned: CardInstance | undefined;
    if (cost.returnUnblocked) {
      const cands = this.attackers().filter((x) => x.controller === pid && !x.wasBlocked);
      const ids = await this.ask<number[] | null>(pid, {
        type: 'cards',
        player: pid,
        prompt: 'Return an unblocked attacker to hand',
        cards: cands,
        min: 1,
        max: 1,
        purpose: 'other',
        source: c,
        cancellable,
      });
      if (!ids) return false;
      returned = this.card(ids[0]);
    }
    let bounced: CardInstance | undefined;
    if (cost.returnPermanent) {
      const cands = this.permanents(pid).filter((x) => cost.returnPermanent!.filter(this, x));
      const ids = await this.ask<number[] | null>(pid, {
        type: 'cards',
        player: pid,
        prompt: cost.returnPermanent.prompt,
        cards: cands,
        min: 1,
        max: 1,
        purpose: 'returnLand',
        source: c,
        cancellable,
      });
      if (!ids) return false;
      bounced = this.card(ids[0]);
    }
    if (cost.mana) {
      const exclude = cost.tap ? new Set([c.id]) : undefined;
      const sol = solvePayment(parseCost(cost.mana), this.players[pid].pool, this.manaSources(pid, exclude));
      if (!sol) return false;
      for (const t of sol.taps) this.card(t.id)!.tapped = true;
      this.players[pid].pool = sol.poolAfter;
    }
    if (cost.tap) c.tapped = true;
    if (cost.life) this.loseLife(pid, cost.life);
    const info: CastInfo = { method: 'normal' };
    for (const s of sacs) {
      info.sacrificed = { mv: s.def.cmc, name: s.def.name, wasCreature: this.isCreature(s) };
      this.sacrifice(s);
    }
    if (discards.length) this.discardCards(pid, discards);
    let attackInfo: CardInstance | undefined;
    if (returned) {
      attackInfo = returned;
      this.log(`${returned.def.name} returns to hand.`, pid);
      this.moveCard(returned, 'hand');
    }
    if (bounced) this.bounce(bounced);
    if (a.oncePerTurn) (c.lastActivated ??= {})[index] = this.turn;
    if (cost.sacSelf) this.sacrifice(c);
    if (cost.exileSelf) this.moveCard(c, 'exile');
    if (cost.discardSelf) this.discardCards(pid, [c]);

    const item: StackItem = {
      id: this.nextId++,
      kind: 'ability',
      controller: pid,
      card: c,
      text: a.text,
      targets,
      specs: a.targets ?? [],
      mode: 0,
      info,
      resolve: a.resolve,
      mv: 0,
    };
    if (a.special) {
      this.log(`${this.players[pid].name}: ${c.def.name} — ${a.label ?? a.text}`, pid);
      await a.resolve(this.makeCtx(item));
      this.changed();
      return true;
    }
    this.stack.push(item);
    this.log(`${this.players[pid].name} activates ${c.def.name}${this.describeTargets(targets)}.`, pid);
    this.checkWard(item);
    this.changed();
    return true;
  }

  /**
   * Ward: whenever a permanent with ward becomes the target of a spell or ability an opponent controls,
   * counter that spell or ability unless its controller pays the ward cost.
   */
  checkWard(item: StackItem) {
    for (const t of item.targets.flat()) {
      if (t.kind !== 'card') continue;
      const c = this.card(t.id);
      if (!c || c.zone !== 'battlefield' || c.controller === item.controller || !this.hasKeyword(c, 'ward')) continue;
      const mana = c.def.wardCost;
      const life = c.def.wardLife;
      const costText = mana ?? (life ? `${life} life` : '');
      this.addTrigger(c, c.controller, `Ward — counter ${item.card.def.name} unless its controller pays ${costText}`, async () => {
        if (!this.stack.includes(item)) return;
        const payer = item.controller;
        if (mana) {
          const cost = parseCost(mana);
          if (this.canPay(payer, cost) && (await this.yesNo(payer, `Pay ${mana} for ward (${c.def.name}), or ${item.card.def.name} is countered?`, 'ward', c))) {
            if (await this.payMana(payer, cost)) return;
          }
        } else if (life) {
          if (this.players[payer].life > life && (await this.yesNo(payer, `Pay ${life} life for ward (${c.def.name}), or ${item.card.def.name} is countered?`, 'ward', c))) {
            this.loseLife(payer, life);
            return;
          }
        }
        this.counterItem(item);
      });
    }
  }

  makeCtx(item: StackItem): Ctx {
    return {
      g: this,
      me: item.controller,
      opp: this.opp(item.controller),
      src: item.card,
      targets: item.targets,
      mode: item.mode,
      info: item.info,
      item,
    };
  }

  async resolveTop() {
    const item = this.stack[this.stack.length - 1];
    if (!item) return;
    this.resolving = item;
    this.changed();
    // let players see what is about to resolve
    await this.pace(item.kind === 'spell' ? 1.1 : 0.8);
    // check targets
    const tctx: TargetCtx = { controller: item.controller, source: item.card, chosen: item.targets };
    let anyTargets = false;
    let anyLegal = false;
    const legal = item.targets.map((ts, i) =>
      ts.filter((t) => {
        anyTargets = true;
        const ok = this.isTargetLegal(item.specs[i], t, tctx);
        if (ok) anyLegal = true;
        return ok;
      }),
    );
    this.stack.pop();
    item.targets = legal;
    const ctx = this.makeCtx(item);
    // a bestow spell whose target is gone resolves as a creature instead of fizzling
    const bestowFallsBack = item.kind === 'spell' && item.info.method === 'bestow';
    if (anyTargets && !anyLegal && !bestowFallsBack) {
      this.log(`${item.card.def.name} fizzles (no legal targets).`, item.controller);
      if (item.kind === 'spell') this.finishSpell(item);
      this.resolving = null;
      this.changed();
      return;
    }
    if (item.kind === 'spell' && item.info.method === 'omen' && item.card.def.omen) {
      // Omen: do the sorcery's effect, then shuffle the card into its owner's library
      const c = item.card;
      this.log(`${c.def.omen!.name} resolves.`, item.controller);
      await c.def.omen!.resolve(ctx);
      if (c.zone === 'stack') {
        c.zone = 'none';
        this.moveCard(c, 'library');
        this.shuffle(c.owner);
        this.log(`${c.def.name} is shuffled into its owner's library.`, item.controller);
      }
    } else if (item.kind === 'spell') {
      const c = item.card;
      if (this.isPermanentCard(c)) {
        c.zone = 'none';
        c.castInfo = item.info;
        if (c.def.entersWithXCounters && item.info.x) c.counters['+1/+1'] = item.info.x;
        if (item.info.method === 'bestow') c.bestowed = legal[0]?.length > 0;
        this.log(`${c.def.name} resolves.`, item.controller);
        if (c.def.chooseColor) {
          const opts: ManaColor[][] = [['W'], ['U'], ['B'], ['R'], ['G']];
          const r = await this.ask<number | null>(item.controller, {
            type: 'color',
            player: item.controller,
            options: opts,
            source: c,
            purpose: c.def.chooseColor === 'protection' ? 'protection' : 'sprawl',
          });
          c.chosenColor = opts[r ?? 0][0] as any;
          this.log(`${this.players[item.controller].name} chooses ${c.chosenColor} for ${c.def.name}.`, item.controller);
        }
        const tgt = this.isAura(c) ? ctx.targets[0]?.[0] : undefined;
        const host = tgt ? (this.resolveTarget(tgt) as CardInstance | undefined) : undefined;
        this.moveCard(c, 'battlefield', { controller: item.controller, attachTo: host });
        if (host) this.log(`${c.def.name} enchants ${host.def.name}.`, item.controller);
      } else {
        this.log(`${c.def.name} resolves.`, item.controller);
        const modes = this.modesFor(c, item.info.method);
        await modes[item.mode].resolve(ctx);
        this.finishSpell(item);
      }
    } else {
      await item.resolve?.(ctx);
    }
    this.resolving = null;
    this.changed();
  }

  private finishSpell(item: StackItem) {
    const c = item.card;
    if (c.zone !== 'stack') return;
    c.zone = 'none';
    this.moveCard(c, this.exiledAfterCast(item) ? 'exile' : 'graveyard');
  }

  /** flashback exiles the card afterwards; escape doesn't */
  private exiledAfterCast(item: StackItem) {
    return item.info.method === 'flashback' && !item.card.def.flashback?.escape;
  }

  counterItem(item: StackItem) {
    const i = this.stack.indexOf(item);
    if (i < 0) return;
    this.stack.splice(i, 1);
    this.log(`${item.card.def.name}${item.kind === 'ability' ? ' ability' : ''} is countered.`, item.controller);
    this.pushFx({ type: 'countered', card: item.card });
    if (item.kind === 'spell') {
      item.card.zone = 'none';
      if (this.exiledAfterCast(item)) this.moveCard(item.card, 'exile');
      else this.moveCard(item.card, 'graveyard');
    }
    this.changed();
  }

  // ───────────────────────────── effects ─────────────────────────────

  dealDamage(source: CardInstance, t: Target | PlayerId | CardInstance, n: number, combat = false): number {
    if (n <= 0) return 0;
    let target: Target;
    if (typeof t === 'number') target = { kind: 'player', pid: t };
    else if ('def' in t) target = { kind: 'card', id: t.id };
    else target = t;
    if (this.preventionTurn !== this.turn) {
      if (combat && this.preventCombatTurn === this.turn) {
        this.log(`Combat damage from ${source.def.name} is prevented.`, source.controller);
        return 0;
      }
      if (this.preventCreatureTurn === this.turn && this.isCreature(source)) {
        this.log(`Damage from ${source.def.name} is prevented.`, source.controller);
        return 0;
      }
      if (target.kind === 'player' && source.def.colors.includes('U') && (this.players[target.pid].copBlue ?? 0) > 0) {
        this.players[target.pid].copBlue!--;
        this.log(`Circle of Protection: Blue prevents damage from ${source.def.name}.`, target.pid);
        return 0;
      }
    }
    if (target.kind === 'card' && this.preventionTurn !== this.turn) {
      const c = this.card(target.id);
      if (c && this.protectedFrom(c, source)) {
        this.log(`Damage from ${source.def.name} to ${c.def.name} is prevented (protection).`, source.controller);
        return 0;
      }
    }
    if (target.kind === 'player') {
      this.players[target.pid].life -= n;
      this.pushFx({ type: 'damage', target, amount: n });
      this.log(`${source.def.name} deals ${n} damage to ${this.players[target.pid].name}.`, source.controller);
    } else if (target.kind === 'card') {
      const c = this.card(target.id);
      if (!c || c.zone !== 'battlefield' || !this.isCreature(c)) return 0;
      c.damage += n;
      this.pushFx({ type: 'damage', target, amount: n });
      if (this.hasKeyword(source, 'deathtouch')) c.deathtouched = true;
      this.log(`${source.def.name} deals ${n} damage to ${c.def.name}.`, source.controller);
    } else return 0;
    if (this.hasKeyword(source, 'lifelink')) this.gainLife(source.controller, n);
    if (source.zone === 'battlefield')
      for (const e of this.attachments(source)) if (e.def.grant?.damageLifegain) this.gainLife(e.controller, n);
    this.changed();
    return n;
  }

  loseLife(pid: PlayerId, n: number) {
    if (n <= 0) return;
    this.players[pid].life -= n;
    this.pushFx({ type: 'life', pid, amount: -n });
    this.log(`${this.players[pid].name} loses ${n} life.`, pid);
  }
  gainLife(pid: PlayerId, n: number) {
    if (n <= 0) return;
    this.players[pid].life += n;
    this.pushFx({ type: 'life', pid, amount: n });
    this.log(`${this.players[pid].name} gains ${n} life.`, pid);
  }

  draw(pid: PlayerId, n: number, silent = false) {
    const p = this.players[pid];
    for (let i = 0; i < n; i++) {
      const c = p.library[0];
      if (!c) {
        p.drewFromEmpty = true;
        continue;
      }
      this.moveCard(c, 'hand');
      if (!silent) {
        p.drawsThisTurn++;
        this.emit({ type: 'draw', player: pid, nth: p.drawsThisTurn });
      }
    }
    if (!silent && n > 0) this.log(`${p.name} draws ${n} card${n > 1 ? 's' : ''}.`, pid);
  }

  discardCards(pid: PlayerId, cards: CardInstance[]) {
    for (const c of cards) {
      if (c.zone !== 'hand') continue;
      this.log(`${this.players[pid].name} discards ${c.def.name}.`, pid);
      if (c.def.madness) {
        this.moveCard(c, 'exile');
        this.addTrigger(c, pid, `Madness — you may cast ${c.def.name} for ${c.def.madness}`, async () => {
          if (c.zone !== 'exile') return;
          if (this.canCast(pid, c, 'madness', undefined, true)) {
            const yes = await this.yesNo(pid, `Cast ${c.def.name} for its madness cost ${c.def.madness}?`, 'madness', c);
            if (yes && (await this.castSpell(pid, c, 'madness', undefined, false))) return;
          }
          this.log(`${c.def.name} is put into the graveyard.`, pid);
          this.moveCard(c, 'graveyard');
        });
      } else this.moveCard(c, 'graveyard');
      this.emit({ type: 'discard', card: c, player: pid });
    }
  }

  async discard(pid: PlayerId, n: number, prompt?: string) {
    const hand = this.players[pid].hand;
    if (n <= 0 || hand.length === 0) return [];
    let chosen: CardInstance[];
    if (hand.length <= n) chosen = [...hand];
    else {
      const ids = await this.ask<number[]>(pid, {
        type: 'cards',
        player: pid,
        prompt: prompt ?? `Discard ${n} card${n > 1 ? 's' : ''}`,
        cards: [...hand],
        min: n,
        max: n,
        purpose: 'discard',
      });
      chosen = ids.map((id) => this.card(id)!);
    }
    this.discardCards(pid, chosen);
    return chosen;
  }

  destroy(c: CardInstance) {
    if (c.zone !== 'battlefield') return false;
    if (this.hasKeyword(c, 'indestructible')) {
      this.log(`${c.def.name} is indestructible.`, c.controller);
      return false;
    }
    this.log(`${c.def.name} is destroyed.`, c.controller);
    this.moveCard(c, 'graveyard');
    return true;
  }
  sacrifice(c: CardInstance) {
    if (c.zone !== 'battlefield') return;
    this.log(`${this.players[c.controller].name} sacrifices ${c.def.name}.`, c.controller);
    this.moveCard(c, 'graveyard');
  }
  exile(c: CardInstance) {
    this.log(`${c.def.name} is exiled.`, c.controller);
    this.moveCard(c, 'exile');
  }
  bounce(c: CardInstance) {
    this.log(`${c.def.name} returns to its owner's hand.`, c.controller);
    this.moveCard(c, 'hand');
  }

  createToken(pid: PlayerId, name: string, opts: { tapped?: boolean } = {}): CardInstance {
    const def = tokenDefs[name];
    if (!def) throw new Error('Unknown token ' + name);
    const t = this.makeCard(def, pid);
    this.log(`${this.players[pid].name} creates a ${name} token.`, pid);
    this.moveCard(t, 'battlefield', { controller: pid, tapped: opts.tapped });
    return t;
  }

  /** Take the initiative and venture into Undercity. */
  async takeInitiative(pid: PlayerId) {
    this.initiative = pid;
    this.log(`${this.players[pid].name} takes the initiative.`, pid);
    this.changed();
    await venture(this, pid, this.initiativeSource);
  }

  becomeMonarch(pid: PlayerId) {
    if (this.monarch === pid) return;
    this.monarch = pid;
    this.log(`${this.players[pid].name} becomes the monarch.`, pid);
  }

  exileGraveyard(pid: PlayerId) {
    const gy = [...this.players[pid].graveyard];
    for (const c of gy) this.moveCard(c, 'exile');
    if (gy.length) this.log(`${this.players[pid].name}'s graveyard is exiled.`, pid);
  }

  async yesNo(pid: PlayerId, prompt: string, purpose: string, source?: CardInstance): Promise<boolean> {
    return !!(await this.ask<boolean>(pid, { type: 'yesno', player: pid, prompt, purpose, source }));
  }

  async chooseCards(
    pid: PlayerId,
    cards: CardInstance[],
    min: number,
    max: number,
    prompt: string,
    purpose: any = 'other',
    source?: CardInstance,
  ): Promise<CardInstance[]> {
    if (cards.length === 0 || max === 0) return [];
    min = Math.min(min, cards.length);
    const ids = await this.ask<number[]>(pid, { type: 'cards', player: pid, prompt, cards, min, max, purpose, source });
    return (ids ?? []).map((id) => this.card(id)!).filter(Boolean);
  }

  async scry(pid: PlayerId, n: number) {
    const lib = this.players[pid].library;
    const cards = lib.slice(0, n);
    if (!cards.length) return;
    const r = await this.ask<{ top: number[]; bottom: number[] }>(pid, { type: 'scry', player: pid, cards });
    lib.splice(0, cards.length);
    const top = r.top.map((id) => this.card(id)!);
    const bottom = r.bottom.map((id) => this.card(id)!);
    lib.unshift(...top);
    lib.push(...bottom);
    this.log(`${this.players[pid].name} scries ${cards.length}: ${top.length} on top, ${bottom.length} on the bottom.`, pid);
    this.changed();
  }

  async searchLibrary(pid: PlayerId, filter: (c: CardInstance) => boolean, prompt: string): Promise<CardInstance | undefined> {
    const lib = this.players[pid].library;
    const cands = lib.filter(filter);
    let picked: CardInstance | undefined;
    if (cands.length) {
      const sel = await this.chooseCards(pid, cands, 0, 1, prompt, 'search');
      picked = sel[0];
    }
    return picked;
  }

  async explore(c: CardInstance) {
    const pid = c.controller;
    const top = this.players[pid].library[0];
    if (!top) return;
    this.log(`${c.def.name} explores, revealing ${top.def.name}.`, pid);
    if (this.isLand(top)) {
      this.moveCard(top, 'hand');
    } else {
      if (c.zone === 'battlefield') c.counters['+1/+1'] = (c.counters['+1/+1'] ?? 0) + 1;
      const yes = await this.yesNo(pid, `Put ${top.def.name} into your graveyard?`, 'exploreMill', top);
      if (yes) this.moveCard(top, 'graveyard');
    }
    this.changed();
  }

  /** Turn a double-faced permanent to its other face (keeps damage, counters, attachments, tapped state). */
  transform(c: CardInstance) {
    if (c.zone !== 'battlefield') return;
    if (c.frontDef) {
      this.log(`${c.def.name} transforms into ${c.frontDef.name}.`, c.controller);
      c.def = c.frontDef;
      c.frontDef = undefined;
    } else if (c.def.backFace) {
      this.log(`${c.def.name} transforms into ${c.def.backFace.name}!`, c.controller);
      c.frontDef = c.def;
      c.def = c.def.backFace;
    }
    this.pushFx({ type: 'trigger', card: c });
    this.changed();
  }

  /** Put the top `n` cards of a library into its owner's graveyard. */
  mill(pid: PlayerId, n: number) {
    const cards = this.players[pid].library.slice(0, n);
    for (const c of cards) this.moveCard(c, 'graveyard');
    if (cards.length) this.log(`${this.players[pid].name} mills ${cards.map((c) => c.def.name).join(', ')}.`, pid);
  }

  /**
   * "Counter target spell unless its controller pays X" (Force Spike, Spell Pierce).
   */
  async counterUnlessPays(item: StackItem | undefined, mana: string) {
    if (!item || !this.stack.includes(item)) return;
    const cost = parseCost(mana);
    const payer = item.controller;
    if (this.canPay(payer, cost) && (await this.yesNo(payer, `Pay ${mana} so ${item.card.def.name} isn't countered?`, 'payTax', item.card))) {
      if (await this.payMana(payer, cost)) {
        this.log(`${this.players[payer].name} pays ${mana}.`, payer);
        return;
      }
    }
    this.counterItem(item);
  }

  attach(equipment: CardInstance, creature: CardInstance) {
    if (equipment.zone !== 'battlefield' || creature.zone !== 'battlefield' || !this.isCreature(creature)) return;
    equipment.attachedTo = creature.id;
    this.log(`${equipment.def.name} is attached to ${creature.def.name}.`, equipment.controller);
    this.changed();
  }
}

/** what a bestowed creature can be attached to */
const BESTOW_TARGET: TargetSpec = {
  kind: 'permanent',
  prompt: 'Choose a creature to bestow onto',
  filter: (g, t) => t.kind === 'card' && !!g.card(t.id) && g.isCreature(g.card(t.id)!),
};

/** subtypes that aren't creature types (Changeling doesn't grant these) */
const NON_CREATURE_SUBTYPES = new Set([
  'Forest', 'Island', 'Swamp', 'Mountain', 'Plains', 'Desert',
  'Aura', 'Cartouche', 'Equipment', 'Blood', 'Clue', 'Food', 'Map', 'Treasure',
]);

function addCosts(a: Cost, b: Cost): Cost {
  const out: Cost = { ...a };
  for (const k of ['generic', 'W', 'U', 'B', 'R', 'G', 'C'] as const) out[k] += b[k];
  if (b.hybrid?.length) out.hybrid = [...(a.hybrid ?? []), ...b.hybrid];
  if (b.phyrexian?.length) out.phyrexian = [...(a.phyrexian ?? []), ...b.phyrexian];
  return out;
}

export function isManaAbility(a: ActivatedDef) {
  return !!(a.produces || a.producesFn);
}

export function targetKey(t: Target) {
  return t.kind === 'player' ? 'p' + t.pid : t.kind[0] + t.id;
}

function mulberry32(a: number) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export { COLORS };
