import type { Game } from './game';
import { targetKey } from './game';
import { parseCost, costMV } from './mana';
import type { Action, CardInstance, ChoiceRequest, Controller, ManaColor, PlayerId, StackItem, Target, TargetSpec } from './types';

/** cards whose targeted effects help the creature they target */
const BENEFICIAL_SOURCES = new Set(['Timberwatch Elf', 'Quirion Ranger', 'Vitu-Ghazi Inspector', 'Toxin Analysis']);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Intent {
  cardId: number;
  targets?: Target[];
  mode?: number;
  discard?: number;
  sacrifice?: number;
}

/**
 * Heuristic computer opponent. It is not a search-based AI — it scores the legal options
 * with simple rules of thumb that are good enough for practice games.
 */
export class AIController implements Controller {
  intent: Intent | null = null;
  private failed = new Set<string>();
  private failedKey = '';
  constructor(public pid: PlayerId, public delay = 450) {}

  async choose(g: Game, req: ChoiceRequest): Promise<any> {
    switch (req.type) {
      case 'priority': {
        const a = this.decidePriority(g);
        if (a.type !== 'pass') {
          await sleep(this.delay);
          const key = JSON.stringify(a);
          // remember attempts so we don't loop on actions that fail
          const wk = `${g.turn}:${g.step}:${g.stack.length}`;
          if (wk !== this.failedKey) {
            this.failed.clear();
            this.failedKey = wk;
          }
          this.failed.add(key);
        }
        return a;
      }
      case 'mulligan':
        return this.keepHand(g, req.hand, req.mulligans);
      case 'bottom':
        return this.bottomCards(g, req.cards, req.count);
      case 'targets':
        return this.pickTargets(g, req.spec, req.candidates, req.source, req.cancellable);
      case 'mode':
        return this.pickMode(g, req.source, req.options);
      case 'cards':
        return this.pickCards(g, req);
      case 'yesno':
        return this.yesNo(g, req.purpose, req.source);
      case 'number':
        return req.max;
      case 'color':
        return this.pickColor(g, req.options, req.purpose);
      case 'attackers':
        await sleep(this.delay);
        return this.declareAttackers(g, req.candidates);
      case 'blockers':
        await sleep(this.delay);
        return this.declareBlockers(g, req.attackers, req.candidates);
      case 'scry':
        return this.scry(g, req.cards);
      case 'order':
        return req.cards.map((c) => c.id);
    }
  }

  // ───────────────────────────── evaluation helpers ─────────────────────────────

  get me() {
    return this.pid;
  }
  opp(g: Game) {
    return g.opp(this.pid);
  }

  value(g: Game, c: CardInstance): number {
    if (g.isCreature(c)) {
      let v = g.power(c) * 1.5 + g.toughness(c) + c.def.cmc * 0.5;
      if (g.hasKeyword(c, 'flying')) v += 1.5;
      if (g.hasKeyword(c, 'deathtouch')) v += 1.5;
      if (g.hasKeyword(c, 'lifelink')) v += 1;
      if (g.hasKeyword(c, 'hexproof')) v += 2;
      if (c.def.triggers?.some((t) => t.event === 'cast' || t.event === 'combatDamagePlayer')) v += 2.5;
      if (c.def.isToken) v -= 1;
      if (g.attachments(c).length) v += 2;
      const made = this.manaMade(g, c);
      if (made) v += 2 + made;
      if ((c.def.activated ?? []).some((ab) => ab.label?.startsWith('Pump') || ab.label?.startsWith('Return a Forest'))) v += 2;
      return v;
    }
    if (g.isLand(c)) return 1;
    if (c.def.isToken) return 0.5;
    return 1 + c.def.cmc * 0.5;
  }

  isAggro(g: Game) {
    // red decks with burn are aggressive
    const all = [...g.players[this.me].library, ...g.players[this.me].hand, ...g.permanents(this.me)];
    const burn = all.filter((c) => c.def.ai?.kind === 'burn' || c.def.ai?.kind === 'drain').length;
    return burn >= 6;
  }

  burnInHand(g: Game) {
    let n = 0;
    for (const c of g.players[this.me].hand) {
      if (c.def.ai?.kind === 'burn' && g.castOptions(this.me, c, true).length) n += c.def.ai.amount ?? 0;
    }
    return n;
  }

  kills(g: Game, a: CardInstance, b: CardInstance) {
    const p = g.power(a);
    if (p <= 0) return false;
    return g.hasKeyword(a, 'deathtouch') || p >= g.toughness(b) - b.damage;
  }

  availableMana(g: Game) {
    const p = g.players[this.me];
    let n = Object.values(p.pool).reduce((a, b) => a + b, 0);
    for (const s of g.manaSources(this.me)) n += Math.max(...s.options.map((o) => o.length));
    return n;
  }

  // ───────────────────────────── mulligan ─────────────────────────────

  keepHand(g: Game, hand: CardInstance[], mulls: number) {
    if (mulls >= 2) return true;
    const lands = hand.filter((c) => g.isLand(c)).length;
    const elves = hand.filter((c) => c.def.cmc === 1 && g.isCreature(c) && (c.def.activated ?? []).some((a) => (a.produces || a.producesFn) && a.cost.tap)).length;
    const effective = lands + elves * 0.5;
    if (hand.length === 7) return lands >= 1 && effective >= 2 && lands <= 5;
    return lands >= 1 && lands <= 4;
  }

  bottomCards(g: Game, cards: CardInstance[], n: number) {
    const lands = cards.filter((c) => g.isLand(c));
    const spells = cards.filter((c) => !g.isLand(c)).sort((a, b) => b.def.cmc - a.def.cmc);
    const out: number[] = [];
    let landCount = lands.length;
    while (out.length < n) {
      if (landCount > 3 && lands.length) {
        out.push(lands.pop()!.id);
        landCount--;
      } else if (spells.length) out.push(spells.shift()!.id);
      else out.push(lands.pop()!.id);
    }
    return out;
  }

  // ───────────────────────────── priority ─────────────────────────────

  decidePriority(g: Game): Action {
    const me = this.me;
    const all = g.legalActions(me).filter((a) => !this.failed.has(JSON.stringify(a)));
    if (!all.length) return { type: 'pass' };
    this.intent = null;
    const top = g.stack[g.stack.length - 1];
    const myTurn = g.active === me;

    if (top) {
      if (top.controller !== me) return this.respond(g, top, all);
      return { type: 'pass' };
    }

    // ninjutsu during combat
    if (myTurn && (g.step === 'declareBlockers' || g.step === 'combatDamage')) {
      const nin = this.ninjutsu(g, all);
      if (nin) return nin;
    }
    // Timberwatch Elf: pump an unblocked attacker, or a creature that would lose its fight
    if (g.step === 'declareBlockers') {
      const pump = this.timberwatch(g, all);
      if (pump) return pump;
    }

    if (myTurn && g.isMainPhase()) {
      const land = this.chooseLand(g, all);
      if (land) return land;
      const best = this.bestMainAction(g, all);
      if (best) return best;
      return { type: 'pass' };
    }

    if (myTurn && g.step === 'beginCombat') {
      // clear blockers before attacking
      const r = this.bestRemoval(g, all, true);
      if (r && this.isAggro(g)) return r;
    }

    if (!myTurn) {
      // removal on attackers
      if (g.step === 'declareAttackers' || g.step === 'declareBlockers') {
        // facing lethal: spend whatever removal saves the most damage, before anything else
        const save = this.emergencyResponse(g, all);
        if (save) return save;
        const r = this.bestRemoval(g, all, false, true);
        if (r) return r;
        const pump = this.combatTrick(g, all);
        if (pump) return pump;
      }
      if (g.step === 'end') {
        const eot = this.endOfTurn(g, all);
        if (eot) return eot;
      }
    }
    return { type: 'pass' };
  }

  private respond(g: Game, top: StackItem, all: Action[]): Action {
    const me = this.me;
    const threat = this.threatLevel(g, top);
    for (const a of all) {
      if (a.type !== 'cast') continue;
      const c = g.card(a.cardId)!;
      const kind = c.def.ai?.kind;
      if (kind === 'counter' && threat >= 2) {
        // "counter unless they pay" only works if they can't pay the tax
        const tax = c.def.name === 'Force Spike' ? 1 : c.def.name === 'Spell Pierce' ? 2 : 0;
        if (tax) {
          const theirs = top.controller;
          const avail =
            Object.values(g.players[theirs].pool).reduce((s, n) => s + n, 0) +
            g.manaSources(theirs).reduce((s, src) => s + Math.max(...src.options.map((o) => o.length)), 0);
          if (avail >= tax) continue;
        }
        const spec = g.modesFor(c, a.method)[0].targets?.[0];
        if (spec && g.isTargetLegal(spec, { kind: 'stack', id: top.id }, { controller: me, source: c, chosen: [] })) {
          this.intent = { cardId: c.id, targets: [{ kind: 'stack', id: top.id }] };
          return a;
        }
      }
      if (kind === 'blast' && threat >= 1) {
        const modes = g.modesFor(c, a.method);
        const color = c.def.name.includes('Pyro') || c.def.name.includes('Red') ? 'U' : 'R';
        if (top.kind === 'spell' && top.card.def.colors.includes(color as any)) {
          const spec = modes[0].targets![0];
          if (g.isTargetLegal(spec, { kind: 'stack', id: top.id }, { controller: me, source: c, chosen: [] })) {
            this.intent = { cardId: c.id, mode: 0, targets: [{ kind: 'stack', id: top.id }] };
            return a;
          }
        }
      }
      // Spellstutter Sprite as a counter
      if (c.def.name === 'Spellstutter Sprite' && threat >= 1 && top.kind === 'spell') {
        const faeries = g.permanents(me).filter((x) => g.hasSubtype(x, 'Faerie')).length + 1;
        if (top.mv <= faeries) return a;
      }
    }
    // respond to removal on my creature with nothing; respond to burn targeting me when lethal is out of scope
    return { type: 'pass' };
  }

  threatLevel(g: Game, s: StackItem): number {
    const me = this.me;
    if (s.kind === 'ability') return 0;
    const c = s.card;
    const targetsMine = s.targets.flat().some((t) => (t.kind === 'player' ? t.pid === me : t.kind === 'card' && g.card(t.id)?.controller === me));
    if (g.isCreature(c)) return this.value(g, c) >= 5 ? 3 : 2;
    const kind = c.def.ai?.kind;
    if (kind === 'removal' && targetsMine) return 3;
    if (kind === 'burn') {
      if (targetsMine) {
        const t = s.targets.flat()[0];
        if (t?.kind === 'player' && g.players[me].life <= 6) return 3;
        if (t?.kind === 'card') return this.value(g, g.card(t.id)!) >= 4 ? 3 : 1;
        return 1;
      }
      return 0;
    }
    if (kind === 'draw' && s.mv >= 2) return 2;
    if (kind === 'drain') return 2;
    if (kind === 'counter') return 2;
    if (g.isPermanentCard(c)) return 2;
    return s.mv >= 2 ? 2 : 1;
  }

  private chooseLand(g: Game, all: Action[]): Action | null {
    const lands = all.filter((a) => a.type === 'playLand').map((a) => g.card((a as any).cardId)!);
    if (!lands.length) return null;
    const me = this.me;
    const onField = g.lands(me).length;
    const score = (l: CardInstance) => {
      let s = 0;
      const tapped = typeof l.def.entersTapped === 'function' ? l.def.entersTapped(g, l) : !!l.def.entersTapped;
      const karoo = l.def.triggers?.some((t) => t.text.startsWith('Return a land'));
      if (karoo) s += onField >= 2 ? 3 : -10;
      // colors we need for spells in hand
      const colorsNeeded = new Set<string>();
      for (const c of g.players[me].hand) for (const m of c.def.manaCost.matchAll(/\{([WUBRG])\}/g)) colorsNeeded.add(m[1]);
      const produces = new Set((l.def.activated ?? []).flatMap((a) => (a.produces ?? []).flat()));
      for (const col of colorsNeeded) if (produces.has(col as any)) s += 1;
      if (g.isArtifact(l)) s += 1;
      // play tapped lands when we have nothing to do with the mana this turn
      const castableNow = g.players[me].hand.some((c) => !g.isLand(c) && costMV(g.spellCost(me, c, 'normal')) <= this.availableMana(g) + 1);
      if (tapped) s += castableNow ? -2 : 2;
      if (l.def.triggers?.some((t) => t.text.includes('damage to target opponent'))) s += 1;
      return s;
    };
    lands.sort((a, b) => score(b) - score(a));
    return { type: 'playLand', cardId: lands[0].id };
  }

  private bestMainAction(g: Game, all: Action[]): Action | null {
    const me = this.me;
    const opp = this.opp(g);
    const aggro = this.isAggro(g);
    const main1 = g.step === 'main1';
    let best: { a: Action; s: number; intent?: Intent } | null = null;
    const consider = (a: Action, s: number, intent?: Intent) => {
      if (s > 0 && (!best || s > best.s)) best = { a, s, intent };
    };

    for (const a of all) {
      if (a.type === 'cast') {
        const c = g.card(a.cardId)!;
        const kind = c.def.ai?.kind;
        const hint = c.def.ai;
        if (a.method === 'omen') {
          // Roost Seek: dig for a land when we are short
          const lands = g.lands(me).length + g.players[me].hand.filter((x) => g.isLand(x)).length;
          if (lands < 4 && !g.players[me].hand.some((x) => g.isLand(x))) consider(a, 26);
          else if (lands < 4) consider(a, 9);
          continue;
        }
        if (a.method === 'bestow') {
          const maxX = this.maxX(g, c, 'bestow');
          const hosts = g.creatures(me).filter((x) => !x.def.isToken);
          if (hosts.length && maxX >= 1) consider(a, 23 + maxX * 1.5);
          continue;
        }
        if (g.isCreature(c)) {
          // flash counter-creatures are held for the opponent's spells / end step
          if (c.def.name === 'Spellstutter Sprite') continue;
          const xBonus = c.def.entersWithXCounters ? this.maxX(g, c, 'normal') * 1.5 : 0;
          if (c.def.entersWithXCounters && xBonus < 2) continue; // a 0/1 Hydra is not worth it
          // ramp first: mana creatures early, Priest of Titania more so the more Elves we have
          const ramps = (c.def.activated ?? []).some((ab) => (ab.produces || ab.producesFn) && !ab.cost.mana && ab.cost.tap);
          const rampBonus = ramps && g.turn <= 8 ? 5 + (c.def.name === 'Priest of Titania' ? g.creatures().filter((e) => g.hasSubtype(e, 'Elf')).length : 0) : 0;
          consider(a, 20 + this.value(g, c) + xBonus + rampBonus + (c.def.cmc === 1 ? 1 : 0));
          continue;
        }
        if (g.isAura(c)) {
          const host = this.auraHost(g, c);
          if (host) consider(a, this.auraScore(g, c, host), { cardId: c.id, targets: [{ kind: 'card', id: host.id }] });
          continue;
        }
        if (g.isPermanentCard(c)) {
          consider(a, 15 + c.def.cmc);
          continue;
        }
        if (c.def.name === 'Ram Through' || (c.def.name === 'Bushwhack' && g.creatures(me).length)) {
          const fightT = this.fightTargets(g, c.def.name === 'Ram Through');
          if (fightT) {
            consider(a, 24 + fightT.score, {
              cardId: c.id,
              mode: 1,
              targets: [
                { kind: 'card', id: fightT.mine.id },
                { kind: 'card', id: fightT.theirs.id },
              ],
            });
            continue;
          }
        }
        if (c.def.name === 'Bushwhack') {
          const lands = g.lands(me).length + g.players[me].hand.filter((x) => g.isLand(x)).length;
          if (lands < 5) consider(a, 9, { cardId: c.id, mode: 0 });
          continue;
        }
        if (a.method === 'alt' && c.def.name === 'Fireblast') {
          if (g.players[opp].life <= 4) consider(a, 100, { cardId: c.id, targets: [{ kind: 'player', pid: opp }] });
          continue;
        }
        if (a.method === 'flashback' && c.def.name === 'Lava Dart') {
          if (g.players[opp].life <= 1) consider(a, 100, { cardId: c.id, targets: [{ kind: 'player', pid: opp }] });
          else {
            const x1 = g.creatures(opp).find((x) => g.toughness(x) - x.damage <= 1 && this.value(g, x) >= 3);
            if (x1 && g.lands(me).length >= 5) consider(a, 12, { cardId: c.id, targets: [{ kind: 'card', id: x1.id }] });
          }
          continue;
        }
        if (a.method === 'alt' && c.def.name === 'Snuff Out' && !this.payLifeOk(g)) continue;
        switch (kind) {
          case 'burn': {
            const amt = hint?.amount ?? 2;
            const dmg = c.def.name === 'Galvanic Blast' && g.artifacts(me).length >= 3 ? 4 : amt;
            const t = this.burnTarget(g, dmg, c);
            if (!t) break;
            if (t.target.kind === 'player') {
              const lethal = g.players[opp].life <= this.burnInHand(g);
              if (lethal) consider(a, 90, { cardId: c.id, targets: [t.target] });
              else if (aggro && !main1) consider(a, 8 + dmg, { cardId: c.id, targets: [t.target] });
            } else consider(a, 25 + t.score, { cardId: c.id, targets: [t.target] });
            break;
          }
          case 'removal': {
            const t = this.removalTarget(g, c, a);
            if (t && (t.score >= 3 || !hint?.reactive)) consider(a, (hint?.reactive ? 5 : 22) + t.score, { cardId: c.id, targets: t.targets });
            break;
          }
          case 'drain':
            consider(a, aggro ? 18 : 12, { cardId: c.id, targets: [{ kind: 'player', pid: opp }] });
            break;
          case 'sweeper': {
            if (hint?.reactive) break;
            const amt = hint?.amount ?? 1;
            const killed = g.creatures(opp).filter((x) => g.toughness(x) - x.damage <= amt);
            const v = killed.reduce((s, x) => s + this.value(g, x), 0);
            if (killed.length >= 2 || v >= 5 || (c.def.name === 'End the Festivities' && g.players[opp].life <= 1))
              consider(a, 20 + v, { cardId: c.id, targets: [{ kind: 'player', pid: opp }] });
            break;
          }
          case 'draw': {
            const s = this.drawSpellScore(g, c, a);
            if (s > 0) consider(a, s);
            break;
          }
          case 'artifactRemoval': {
            const arts = g.artifacts(opp).sort((x, y) => this.value(g, y) - this.value(g, x));
            if (arts.length && this.value(g, arts[0]) >= 2) consider(a, 15 + this.value(g, arts[0]));
            break;
          }
          case 'blast': {
            const color = c.def.name.includes('Pyro') || c.def.name.includes('Red') ? 'U' : 'R';
            // only permanents of the right color that we can actually target (hexproof Slippery Bogle is blue!)
            const t = g.permanents(opp).filter((x) => x.def.colors.includes(color as any) && !g.isLand(x) && g.canBeTargetedBy(x, me, c));
            if (t.length) {
              t.sort((x, y) => this.value(g, y) - this.value(g, x));
              if (this.value(g, t[0]) >= 3) consider(a, 10 + this.value(g, t[0]), { cardId: c.id, mode: 1, targets: [{ kind: 'card', id: t[0].id }] });
            }
            break;
          }
          default:
            break;
        }
      } else if (a.type === 'activate') {
        const c = g.card(a.cardId)!;
        const ab = c.def.activated![a.index];
        switch (ab.ai) {
          case 'utility':
            if (ab.label?.startsWith('Equip')) {
              const hosts = g.creatures(me).filter((x) => !g.attachments(x).length);
              if (c.attachedTo === null && hosts.length) {
                hosts.sort((x, y) => this.value(g, y) - this.value(g, x));
                consider(a, 6, { cardId: c.id, targets: [{ kind: 'card', id: hosts[0].id }] });
              }
            } else if (ab.label === 'Return two creatures') {
              const dead = g.players[me].graveyard.filter((x) => g.isCreature(x));
              if (dead.length >= 2 && !main1) consider(a, 7);
            } else if (ab.label === 'Explore') {
              if (!main1 || g.players[me].hand.every((x) => g.isLand(x))) consider(a, 3);
            } else if (ab.label?.startsWith('Return a Forest')) {
              const plan = this.quirionManaPlan(g);
              if (plan) consider(a, 30, { cardId: c.id, targets: [{ kind: 'card', id: plan.id }] });
            } else if (ab.label === 'Exile a graveyard') {
              const gy = g.players[opp].graveyard;
              if (gy.some((x) => x.def.flashback || x.def.triggers?.some((t) => t.zone === 'graveyard'))) consider(a, 9, { cardId: c.id, targets: [{ kind: 'player', pid: opp }] });
            }
            break;
          case 'draw': {
            // rummage with Blood when we hold a madness card we can pay for
            if (ab.cost.discard) {
              const hand = g.players[me].hand;
              const mad = hand.find((x) => x.def.madness && this.availableMana(g) >= 1 + costMV(parseCost(x.def.madness)));
              if (mad) consider(a, 14, { cardId: c.id, discard: mad.id });
              else if (!main1 && hand.some((x) => g.isLand(x)) && g.lands(me).length >= 4) consider(a, 2);
            } else if (!main1) consider(a, 2);
            break;
          }
          case 'damage': {
            if (c.def.name === 'Makeshift Munitions') {
              if (g.players[opp].life <= 1) consider(a, 95, { cardId: c.id, targets: [{ kind: 'player', pid: opp }] });
            } else if (c.def.name === 'Krark-Clan Shaman') {
              const oppDie = g.creatures(opp).filter((x) => !g.hasKeyword(x, 'flying') && g.toughness(x) - x.damage <= 1);
              const myDie = g.creatures(me).filter((x) => !g.hasKeyword(x, 'flying') && g.toughness(x) - x.damage <= 1);
              const gain = oppDie.reduce((s, x) => s + this.value(g, x), 0) - myDie.reduce((s, x) => s + this.value(g, x), 0);
              if (gain >= 3) consider(a, 10 + gain);
            }
            break;
          }
          case 'plot':
            if (!main1 && this.availableMana(g) >= 2) consider(a, 1.5);
            break;
          case 'removal': {
            const t = g.permanents(opp).filter((x) => !g.isLand(x)).sort((x, y) => this.value(g, y) - this.value(g, x))[0];
            if (t && this.value(g, t) >= 4) consider(a, 10, { cardId: c.id, targets: [{ kind: 'card', id: t.id }] });
            break;
          }
          case 'cycle':
            if (!main1 && this.wantsCycle(g, c, ab.label ?? '')) consider(a, 1);
            break;
          default:
            break;
        }
      }
    }
    if (!best) return null;
    const b = best as { a: Action; s: number; intent?: Intent };
    this.intent = b.intent ?? null;
    return b.a;
  }

  private drawSpellScore(g: Game, c: CardInstance, a: Action): number {
    const me = this.me;
    const hand = g.players[me].hand;
    // Elves refills: dig first when the hand is nearly empty, so the new cards can still be cast this turn
    if (c.def.name === 'Lead the Stampede' || c.def.name === 'Winding Way') {
      const spells = hand.filter((x) => x !== c && !g.isLand(x)).length;
      return spells <= 1 ? 27 : 8;
    }
    if (c.def.name === 'Land Grant') {
      const lands = g.lands(me).length + hand.filter((x) => g.isLand(x)).length;
      if (lands >= 5) return 0;
      return a.type === 'cast' && a.method === 'alt' ? 12 : 7;
    }
    const ac = c.def.additionalCost;
    if (ac?.kind === 'discard') {
      const others = hand.filter((x) => x !== c);
      if (!others.length) return 0;
      const mad = others.find((x) => x.def.madness);
      return mad ? 16 : 6;
    }
    if (ac?.kind === 'sacrifice') {
      const fodder = this.sacFodder(g);
      return fodder ? 9 : 0;
    }
    if (c.def.ai?.reactive && g.active === me) return 0; // Brainstorm at end of turn
    if (c.def.name === 'Faithless Looting') {
      // loot when it can pay for a madness card afterwards, or to dig with extra lands / flashback
      const manaAfter = this.availableMana(g) - (a.type === 'cast' && a.method === 'flashback' ? 3 : 1);
      if (hand.some((x) => x !== c && x.def.madness) && manaAfter >= 1) return 12;
      const landsInHand = hand.filter((x) => g.isLand(x)).length;
      if (landsInHand >= 2 && g.lands(me).length >= 3) return 6;
      if (hand.some((x) => x.def.triggers?.some((t) => t.zone === 'graveyard'))) return 5;
      return g.lands(me).length >= 4 ? 3 : 0;
    }
    if (c.def.name === 'Highway Robbery') return hand.some((x) => x.def.madness) ? 11 : 5;
    return 8;
  }

  /** Biggest X we could pay for this spell right now */
  maxX(g: Game, c: CardInstance, method: 'normal' | 'bestow') {
    let x = 0;
    while (x < 20 && g.canPay(this.me, g.spellCost(this.me, c, method, undefined, x + 1))) x++;
    return x;
  }

  /** Timberwatch Elf during the declare-blockers step */
  private timberwatch(g: Game, all: Action[]): Action | null {
    const me = this.me;
    for (const a of all) {
      if (a.type !== 'activate') continue;
      const c = g.card(a.cardId)!;
      if (!c.def.activated![a.index].label?.startsWith('Pump')) continue;
      const x = g.creatures().filter((e) => g.hasSubtype(e, 'Elf')).length;
      if (g.active === me) {
        // our attack: an unblocked attacker deals X more; or a blocked one wins its fight
        const unblocked = g.attackers().filter((at) => at.controller === me && !at.wasBlocked);
        const target =
          unblocked.sort((p, q) => g.power(q) - g.power(p))[0] ??
          g.attackers().find((at) => at.controller === me && at.blockedBy.some((id) => !this.kills(g, at, g.card(id)!)));
        if (target) {
          this.intent = { cardId: c.id, targets: [{ kind: 'card', id: target.id }] };
          return a;
        }
      } else {
        // their attack: save a blocker that would die
        const blocker = g
          .creatures(me)
          .find((b) => b.blocking !== null && this.kills(g, g.card(b.blocking)!, b) && g.toughness(b) + x > g.power(g.card(b.blocking)!));
        if (blocker) {
          this.intent = { cardId: c.id, targets: [{ kind: 'card', id: blocker.id }] };
          return a;
        }
      }
    }
    // combo: Quirion Ranger returns a tapped Forest to untap a tapped Timberwatch, which then pumps again
    const quirion = this.quirionAction(g, all);
    if (quirion && this.tappedForests(g).length) {
      const tappedPumper = g.creatures(me).find((c) => c.tapped && (c.def.activated ?? []).some((ab) => ab.label?.startsWith('Pump')));
      const worth =
        g.active === me
          ? g.attackers().some((at) => at.controller === me && !at.wasBlocked)
          : g.creatures(me).some((b) => b.blocking !== null && this.kills(g, g.card(b.blocking)!, b));
      if (tappedPumper && worth) {
        this.intent = { cardId: quirion.cardId, targets: [{ kind: 'card', id: tappedPumper.id }] };
        return quirion;
      }
    }
    return null;
  }

  /** the Quirion Ranger activation, if it can be used right now */
  private quirionAction(g: Game, all: Action[]): Extract<Action, { type: 'activate' }> | null {
    for (const a of all) {
      if (a.type !== 'activate') continue;
      if (g.card(a.cardId)!.def.activated![a.index].label?.startsWith('Return a Forest')) return a;
    }
    return null;
  }

  /** Forests we've already tapped for mana: returning one costs us nothing this turn */
  tappedForests(g: Game) {
    return g.lands(this.me).filter((l) => l.tapped && g.hasSubtype(l, 'Forest'));
  }

  /** how much mana a creature makes when tapped (0 if none) */
  manaMade(g: Game, c: CardInstance): number {
    let best = 0;
    (c.def.activated ?? []).forEach((a, i) => {
      if (!a.produces && !a.producesFn) return;
      if (a.cost.mana || a.cost.sacSelf) return;
      for (const o of g.produceOptions(c, i)) best = Math.max(best, o.length);
    });
    return best;
  }

  /**
   * Main phase: should Quirion Ranger return a tapped Forest to untap a tapped mana creature?
   * Only if that extra mana (plus replaying the Forest if our land drop is free) lets us cast something we can't now.
   */
  quirionManaPlan(g: Game): CardInstance | null {
    const me = this.me;
    if (!this.tappedForests(g).length) return null;
    const p = g.players[me];
    const landDropFree = p.landsPlayedThisTurn < 1;
    // with the land drop used, the Forest would be stuck in hand; only fine if we have no other land to play next turn
    if (!landDropFree && p.hand.some((x) => g.isLand(x))) return null;
    const target = g
      .creatures(me)
      .filter((x) => x.tapped && !g.isSick(x) && this.manaMade(g, x) > 0)
      .sort((a, b) => this.manaMade(g, b) - this.manaMade(g, a))[0];
    if (!target) return null;
    const avail = this.availableMana(g);
    const extra = this.manaMade(g, target) + (landDropFree ? 1 : 0);
    const enables = p.hand.some((x) => {
      if (g.isLand(x)) return false;
      const cost = costMV(g.spellCost(me, x, 'normal'));
      return cost > avail && cost <= avail + extra;
    });
    // a bigger X for Nyxborn Hydra also counts
    const biggerX = p.hand.some((x) => x.def.entersWithXCounters) && this.manaMade(g, target) >= 2;
    return enables || biggerX ? target : null;
  }

  /** Is paying 4 life (Snuff Out) reasonable right now? */
  payLifeOk(g: Game) {
    const life = g.players[this.me].life;
    const oppPower = g.creatures(this.opp(g)).reduce((s, c) => s + Math.max(0, g.power(c)), 0);
    return this.availableMana(g) < 4 && life - 4 > Math.max(8, oppPower + 3);
  }

  sacFodder(g: Game): CardInstance | null {
    const me = this.me;
    const cands = g.permanents(me).filter((x) => g.isArtifact(x) || g.isCreature(x));
    cands.sort((a, b) => this.sacCost(g, a) - this.sacCost(g, b));
    const f = cands[0];
    if (!f || this.sacCost(g, f) >= 5) return null;
    return f;
  }
  sacCost(g: Game, c: CardInstance) {
    if (c.def.isToken && !g.isCreature(c)) return 0;
    if (c.def.triggers?.some((t) => t.event === 'ltb')) return 0.5; // Ichor Wellspring, Spellbomb
    if (g.isLand(c)) return g.lands(this.me).length >= 5 ? 2 : 6;
    if (g.isCreature(c)) return this.value(g, c);
    return 1.5 + c.def.cmc;
  }

  wantsCycle(g: Game, c: CardInstance, label: string) {
    const me = this.me;
    if (label.startsWith('Islandcycling')) return !g.players[me].hand.some((x) => g.isLand(x)) && g.lands(me).length < 5;
    return true;
  }

  burnTarget(g: Game, dmg: number, src: CardInstance): { target: Target; score: number } | null {
    const opp = this.opp(g);
    let best: { target: Target; score: number } | null = null;
    for (const c of g.creatures(opp)) {
      if (g.toughness(c) - c.damage > dmg) continue;
      const v = this.value(g, c);
      if (!best || v > best.score) best = { target: { kind: 'card', id: c.id }, score: v };
    }
    const aggro = this.isAggro(g);
    if (best && (best.score >= (aggro ? 5 : 2) || g.players[opp].life > 10)) return best;
    return { target: { kind: 'player', pid: opp }, score: dmg };
  }

  removalTarget(g: Game, c: CardInstance, a: Action): { targets: Target[]; score: number } | null {
    const me = this.me;
    const opp = this.opp(g);
    const modes = g.modesFor(c, (a as any).method);
    const specs = modes[0].targets ?? [];
    if (c.def.name === 'Searing Blaze') {
      const n = g.players[me].landEnteredThisTurn ? 3 : 1;
      const cr = g.creatures(opp).filter((x) => g.toughness(x) - x.damage <= n).sort((x, y) => this.value(g, y) - this.value(g, x))[0];
      if (!cr) return null;
      return { targets: [{ kind: 'player', pid: opp }, { kind: 'card', id: cr.id }], score: this.value(g, cr) };
    }
    if (c.def.name === 'Agony Warp') {
      const att = g.attackers().filter((x) => x.controller === opp);
      const cands = (att.length ? att : g.creatures(opp)).filter((x) => g.toughness(x) - x.damage <= 3);
      cands.sort((x, y) => this.value(g, y) - this.value(g, x));
      if (!cands[0]) return null;
      return { targets: [{ kind: 'card', id: cands[0].id }, { kind: 'card', id: cands[0].id }], score: this.value(g, cands[0]) };
    }
    if (c.def.name === 'Monstrous Emergence') {
      const myPower = Math.max(
        0,
        ...g.creatures(me).map((x) => g.power(x)),
        ...g.players[me].hand.filter((x) => x !== c && g.isCreature(x)).map((x) => x.def.power ?? 0),
      );
      const cands = g.creatures(opp).filter((x) => g.canBeTargetedBy(x, me, c) && g.toughness(x) - x.damage <= myPower);
      cands.sort((x, y) => this.value(g, y) - this.value(g, x));
      if (!cands[0]) return null;
      return { targets: [{ kind: 'card', id: cands[0].id }], score: this.value(g, cands[0]) };
    }
    if (c.def.name === 'Extract a Confession') {
      const crs = g.creatures(opp);
      if (!crs.length) return null;
      return { targets: [], score: Math.min(...crs.map((x) => this.value(g, x))) + (crs.length === 1 ? 3 : 0) };
    }
    if (!specs.length) return null;
    const spec = specs[0];
    const cands = g.candidates(spec, { controller: me, source: c, chosen: [] });
    let best: { t: Target; v: number } | null = null;
    for (const t of cands) {
      if (t.kind !== 'card') continue;
      const x = g.card(t.id)!;
      if (x.controller === me) continue;
      if (g.hasKeyword(x, 'indestructible')) continue;
      const v = this.value(g, x);
      if (!best || v > best.v) best = { t, v };
    }
    return best ? { targets: [best.t], score: best.v } : null;
  }

  private bestRemoval(g: Game, all: Action[], blockersOnly: boolean, attackersOnly = false): Action | null {
    const me = this.me;
    const opp = this.opp(g);
    let best: { a: Action; v: number; intent: Intent } | null = null;
    for (const a of all) {
      if (a.type !== 'cast') continue;
      if ((a.method === 'alt' && g.card(a.cardId)!.def.name === 'Fireblast') || a.method === 'flashback') continue;
      const c = g.card(a.cardId)!;
      const kind = c.def.ai?.kind;
      if (kind === 'removal') {
        if (!(g.is(c, 'Instant') || g.hasKeyword(c, 'flash')) && !g.canSorcery(me)) continue;
        if (a.method === 'alt' && !this.payLifeOk(g)) continue;
        const t = this.removalTarget(g, c, a);
        if (!t || !t.targets.length) continue;
        if (a.method === 'alt' && t.score < 4) continue;
        const target = g.card((t.targets[t.targets.length - 1] as any).id);
        if (attackersOnly && target && !target.attacking) continue;
        if (t.score >= 3 && (!best || t.score > best.v)) best = { a, v: t.score, intent: { cardId: c.id, targets: t.targets } };
      } else if (kind === 'burn' && (blockersOnly || attackersOnly)) {
        const dmg = c.def.ai?.amount ?? 2;
        const cands = g.creatures(opp).filter((x) => g.toughness(x) - x.damage <= dmg && (!attackersOnly || x.attacking) && (!blockersOnly || !x.tapped));
        cands.sort((x, y) => this.value(g, y) - this.value(g, x));
        if (cands[0] && this.value(g, cands[0]) >= 3 && (!best || this.value(g, cands[0]) > best.v))
          best = { a, v: this.value(g, cands[0]), intent: { cardId: c.id, targets: [{ kind: 'card', id: cands[0].id }] } };
      }
    }
    if (!best) return null;
    this.intent = best.intent;
    return best.a;
  }

  private combatTrick(g: Game, all: Action[]): Action | null {
    const me = this.me;
    for (const a of all) {
      if (a.type !== 'cast') continue;
      const c = g.card(a.cardId)!;
      if (c.def.ai?.kind === 'pump') {
        // give deathtouch to a blocker that would otherwise not kill the attacker
        for (const b of g.creatures(me)) {
          if (b.blocking === null) continue;
          const att = g.card(b.blocking)!;
          if (!this.kills(g, b, att) && g.power(b) > 0) {
            this.intent = { cardId: c.id, targets: [{ kind: 'card', id: b.id }] };
            return a;
          }
        }
      }
      if (c.def.ai?.kind === 'sweeper' && c.def.ai.reactive) {
        const amt = c.def.ai.amount ?? 1;
        const opp = this.opp(g);
        const killed = g.creatures(opp).filter((x) => g.toughness(x) - x.damage <= amt);
        if (killed.length >= 2) return a;
      }
    }
    return null;
  }

  private endOfTurn(g: Game, all: Action[]): Action | null {
    const me = this.me;
    // flash creatures, instant-speed card draw, removal, activations
    for (const a of all) {
      if (a.type === 'cast') {
        const c = g.card(a.cardId)!;
        if (g.isCreature(c) && g.hasKeyword(c, 'flash')) return a;
      }
    }
    const r = this.bestRemoval(g, all, false);
    if (r) return r;
    for (const a of all) {
      if (a.type === 'cast') {
        const c = g.card(a.cardId)!;
        if (c.def.ai?.kind === 'draw' && (g.is(c, 'Instant') || g.hasKeyword(c, 'flash')) && !c.def.additionalCost) return a;
      }
      if (a.type === 'activate') {
        const c = g.card(a.cardId)!;
        const ab = c.def.activated![a.index];
        if (ab.ai === 'cycle' && this.wantsCycle(g, c, ab.label ?? '')) return a;
        if (ab.ai === 'draw' && !ab.cost.discard) return a;
        if (ab.label === 'Gain 2 life' && g.players[me].life < 20) return a;
        if (ab.label === 'Gain 3 life' && g.players[me].life < 15) return a;
        if (ab.label === 'Fetch basic land' && !g.attachments(c).length) return a;
      }
    }
    return null;
  }

  private ninjutsu(g: Game, all: Action[]): Action | null {
    for (const a of all) {
      if (a.type !== 'activate') continue;
      const c = g.card(a.cardId)!;
      if (c.def.activated![a.index].ai !== 'ninjutsu') continue;
      const unblocked = g.attackers().filter((x) => x.controller === this.me && !x.wasBlocked);
      unblocked.sort((x, y) => this.value(g, x) - this.value(g, y));
      if (unblocked[0] && this.value(g, unblocked[0]) < this.value(g, c) + 2) return a;
    }
    return null;
  }

  // ───────────────────────────── choices ─────────────────────────────

  /** Best creature of ours to put an Aura on (hexproof first, then already-suited-up), or a land for land Auras */
  auraHost(g: Game, aura: CardInstance): CardInstance | undefined {
    const me = this.me;
    const cands = g.permanents(me).filter((x) => g.canEnchant(aura, x, me) && g.canBeTargetedBy(x, me, aura));
    if (!cands.length) return undefined;
    if (aura.def.enchant === 'land' || aura.def.enchant === 'Forest') {
      // land auras: prefer a land without one already
      // basics first: fetch lands get sacrificed and would take the Aura with them
      const landScore = (x: CardInstance) => g.attachments(x).length * 10 + (x.def.supertypes.includes('Basic') ? 0 : 5);
      return [...cands].sort((a, b) => landScore(a) - landScore(b))[0];
    }
    const score = (x: CardInstance) =>
      (g.hasKeyword(x, 'hexproof') ? 10 : 0) +
      g.attachments(x).length * 2 +
      this.value(g, x) +
      (x.def.isToken ? -4 : 0) +
      (aura.def.name === 'Angelic Gift' && g.hasKeyword(x, 'flying') ? -6 : 0) +
      (aura.def.name === 'Rancor' && g.hasKeyword(x, 'trample') ? -1 : 0);
    return [...cands].sort((a, b) => score(b) - score(a))[0];
  }

  auraScore(g: Game, aura: CardInstance, host: CardInstance): number {
    const me = this.me;
    if (aura.def.enchant === 'land' || aura.def.enchant === 'Forest') return g.turn <= 4 ? 27 : 14;
    // with no hexproof body, we'd rather deploy a creature first
    const safe = g.hasKeyword(host, 'hexproof');
    let s = 18 + aura.def.cmc + (safe ? 4 : -4);
    if (aura.def.name === 'Ancestral Mask') s += g.battlefield.filter((x) => g.is(x, 'Enchantment')).length * 2;
    if (aura.def.name === 'Benevolent Blessing') s -= 6;
    if (g.step === 'main2') s -= 3;
    void me;
    return s;
  }

  /** Our creature + their creature for Ram Through / Bushwhack's fight mode */
  fightTargets(g: Game, oneSided: boolean): { mine: CardInstance; theirs: CardInstance; score: number } | null {
    const me = this.me;
    let best: { mine: CardInstance; theirs: CardInstance; score: number } | null = null;
    for (const a of g.creatures(me)) {
      for (const b of g.creatures(this.opp(g))) {
        if (!g.canBeTargetedBy(b, me, a)) continue;
        if (!this.kills(g, a, b)) continue;
        // never trade away our creature in a fight
        if (!oneSided && this.kills(g, b, a)) continue;
        const score = this.value(g, b);
        if (score >= 2 && (!best || score > best.score)) best = { mine: a, theirs: b, score };
      }
    }
    return best;
  }

  pickColor(g: Game, options: ManaColor[][], purpose?: string): number {
    const idx = (col: string) => Math.max(0, options.findIndex((o) => o[0] === col));
    if (purpose === 'protection') {
      const counts: Record<string, number> = {};
      const opp = this.opp(g);
      for (const c of [...g.permanents(opp), ...g.players[opp].graveyard]) for (const col of c.def.colors) counts[col] = (counts[col] ?? 0) + 1;
      const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
      return top ? idx(top[0]) : 0;
    }
    if (purpose === 'sprawl') {
      // add the color we are shortest on for the cards in hand
      const pips: Record<string, number> = {};
      for (const c of g.players[this.me].hand) for (const m of c.def.manaCost.matchAll(/\{([WUBRG])\}/g)) pips[m[1]] = (pips[m[1]] ?? 0) + 1;
      const top = Object.entries(pips).sort((a, b) => b[1] - a[1]).find(([col]) => col !== 'G');
      return idx(top ? top[0] : 'W');
    }
    return 0;
  }

  pickMode(g: Game, src: CardInstance, options: { text: string; enabled: boolean }[]) {
    if (this.intent?.cardId === src.id && this.intent.mode !== undefined && options[this.intent.mode]?.enabled) return this.intent.mode;
    if (src.def.name === 'The Initiative') {
      // Undercity: grow a creature if we have one, otherwise scry; Trap! over Arena; Catacombs when our board is thin
      const pick = (name: string) => options.findIndex((o) => o.text.startsWith(name));
      const mine = g.creatures(this.me).length;
      if (pick('Forge') >= 0 && pick('Lost Well') >= 0) return mine ? pick('Forge') : pick('Lost Well');
      if (pick('Trap!') >= 0) return pick('Trap!');
      if (pick('Archives') >= 0 && pick('Catacombs') >= 0) return mine < 3 ? pick('Catacombs') : pick('Archives');
      if (pick('Arena') >= 0 && pick('Stash') >= 0) return pick('Arena');
    }
    if (src.def.name === 'Winding Way') {
      const lands = g.lands(this.me).length + g.players[this.me].hand.filter((x) => g.isLand(x)).length;
      return lands < 3 ? 1 : 0;
    }
    if (src.def.name === 'Cast into the Fire') {
      const arts = g.artifacts(this.opp(g)).filter((x) => this.value(g, x) >= 3);
      if (arts.length && options[1].enabled) return 1;
    }
    const i = options.findIndex((o) => o.enabled);
    return i < 0 ? null : i;
  }

  pickTargets(g: Game, spec: TargetSpec, cands: Target[], src: CardInstance, cancellable = false): Target[] | null {
    const me = this.me;
    const opp = this.opp(g);
    const min = spec.min ?? 1;
    const max = spec.max ?? 1;
    const keys = new Set(cands.map(targetKey));
    if (this.intent?.cardId === src.id && this.intent.targets) {
      const t = this.intent.targets.shift();
      if (t && keys.has(targetKey(t))) return [t];
      // the target we planned for isn't legal: back out rather than waste the card on something else
      if (t && cancellable) return null;
    }
    if (g.isAura(src)) {
      const host = this.auraHost(g, src);
      if (host && keys.has(targetKey({ kind: 'card', id: host.id }))) return [{ kind: 'card', id: host.id }];
    }
    const harmful =
      ['burn', 'removal', 'artifactRemoval', 'blast', 'sweeper', 'drain', 'gyHate'].includes(src.def.ai?.kind ?? '') || spec.prompt.startsWith('Arena');
    const beneficial = BENEFICIAL_SOURCES.has(src.def.name) || spec.prompt.startsWith('Forge') || src.def.ai?.kind === 'pump';
    const scored = cands.map((t) => {
      let s = 0;
      // card-draw / self-mill spells (Thought Scour, Deep Analysis) target ourselves; harmful ones the opponent
      if (t.kind === 'player') s = src.def.ai?.kind === 'draw' ? (t.pid === me ? 5 : -5) : t.pid === opp ? 5 : -5;
      else if (t.kind === 'stack') {
        const it = g.stack.find((x) => x.id === t.id)!;
        s = it.controller === opp ? 10 + it.mv : -10;
      } else {
        const c = g.card(t.id)!;
        const mine = c.controller === me || (c.zone === 'graveyard' && c.owner === me);
        const v = this.value(g, c);
        if (c.zone === 'graveyard') s = mine ? (g.isCreature(c) ? v : -1) : v;
        else if (src.def.name === 'Cryogen Relic' || harmful) s = mine ? -v : v;
        else if (beneficial) s = mine ? v : -v;
        else if (spec.prompt.includes('you control')) s = mine ? v : -v;
        else s = mine ? -v : v;
      }
      // blasts only do anything to cards of their color
      if (src.def.ai?.kind === 'blast' && t.kind !== 'player') {
        const blastColor = src.def.name.includes('Pyro') || src.def.name.includes('Red') ? 'U' : 'R';
        const target = t.kind === 'stack' ? g.stack.find((x) => x.id === t.id)?.card : g.card(t.id);
        if (!target?.def.colors.includes(blastColor as any)) s = -100;
      }
      return { t, s };
    });
    scored.sort((a, b) => b.s - a.s);
    const out = scored.filter((x) => x.s > 0).slice(0, max).map((x) => x.t);
    while (out.length < min && scored.length > out.length) {
      const next = scored.find((x) => !out.includes(x.t));
      if (!next) break;
      out.push(next.t);
    }
    return out;
  }

  pickCards(g: Game, req: Extract<ChoiceRequest, { type: 'cards' }>): number[] {
    const me = this.me;
    const { cards, min, max, purpose } = req;
    const want = (n: number, sorted: CardInstance[]) => sorted.slice(0, n).map((c) => c.id);
    if (this.intent && req.source?.id === this.intent.cardId) {
      if (purpose === 'discard' && this.intent.discard && cards.some((c) => c.id === this.intent!.discard)) return [this.intent.discard];
    }
    switch (purpose) {
      case 'discard': {
        if (req.player !== me) return want(min, cards);
        const sorted = [...cards].sort((a, b) => this.discardScore(g, b) - this.discardScore(g, a));
        // Highway Robbery: "may" discard a card or sacrifice a land
        const n = min === 0 ? (sorted.length && this.discardScore(g, sorted[0]) > 0 ? 1 : 0) : min;
        return want(n, sorted);
      }
      case 'sacrifice': {
        if (req.player !== me) return want(min, [...cards].sort((a, b) => this.value(g, a) - this.value(g, b)));
        const sorted = [...cards].sort((a, b) => this.sacCost(g, a) - this.sacCost(g, b));
        return want(Math.max(min, 1), sorted);
      }
      case 'putBack': {
        const landsTotal = g.lands(me).length + cards.filter((c) => g.isLand(c)).length;
        const sorted = [...cards].sort((a, b) => {
          const sa = g.isLand(a) ? (landsTotal >= 4 ? 10 : -10) : a.def.cmc;
          const sb = g.isLand(b) ? (landsTotal >= 4 ? 10 : -10) : b.def.cmc;
          return sb - sa;
        });
        return want(min, sorted);
      }
      case 'returnLand': {
        const sorted = [...cards].sort((a, b) => {
          const sa = (a.tapped ? 10 : 0) + (a === req.source ? -5 : 0) + (a.def.supertypes.includes('Basic') ? 1 : 0);
          const sb = (b.tapped ? 10 : 0) + (b === req.source ? -5 : 0) + (b.def.supertypes.includes('Basic') ? 1 : 0);
          return sb - sa;
        });
        return want(1, sorted);
      }
      case 'evidence': {
        if (min === max) return want(min, [...cards].sort((a, b) => this.value(g, a) - this.value(g, b)));
        const sorted = [...cards].sort((a, b) => b.def.cmc - a.def.cmc);
        const out: number[] = [];
        let total = 0;
        for (const c of sorted) {
          if (total >= 6) break;
          out.push(c.id);
          total += c.def.cmc;
        }
        return out;
      }
      case 'other': {
        // ninjutsu: return the weakest unblocked attacker
        const sorted = [...cards].sort((a, b) => this.value(g, a) - this.value(g, b));
        return want(Math.max(1, min), sorted);
      }
      case 'takeAll':
        return cards.map((c) => c.id);
      case 'strongest': {
        const power = (c: CardInstance) => (c.zone === 'battlefield' ? g.power(c) : c.def.power ?? 0);
        return want(1, [...cards].sort((a, b) => power(b) - power(a)));
      }
      case 'exileGraveyard': {
        const sorted = [...cards].sort((a, b) => a.def.cmc - b.def.cmc);
        return want(min, sorted);
      }
      default: {
        const sorted = [...cards].sort((a, b) => this.value(g, b) - this.value(g, a));
        return want(Math.max(min, Math.min(max, 1)), sorted);
      }
    }
  }

  discardScore(g: Game, c: CardInstance): number {
    const me = this.me;
    if (c.zone === 'battlefield') return g.lands(me).length >= 6 ? 1 : -5; // Highway Robbery land sacrifice
    if (c.def.madness) {
      const need = costMV(parseCost(c.def.madness));
      // a madness card we can't pay for is just a discarded card
      return this.availableMana(g) >= need ? 10 : -1;
    }
    if (c.def.triggers?.some((t) => t.zone === 'graveyard')) return 7; // Sneaky Snacker
    if (c.def.flashback) return 4;
    if (g.isLand(c)) {
      const lands = g.lands(me).length + g.players[me].hand.filter((x) => g.isLand(x)).length;
      return lands >= 5 ? 5 : lands >= 3 ? 1 : -3;
    }
    return 2 - c.def.cmc * 0.5 - this.value(g, c) * 0.1;
  }

  yesNo(g: Game, purpose: string, src?: CardInstance) {
    if (purpose === 'evidence') return g.creatures(this.opp(g)).length >= 2;
    if (purpose === 'exploreMill') return false;
    if (purpose === 'ponderShuffle') {
      // shuffle away a top three that doesn't give us what we need
      const me = this.me;
      const top = g.players[me].library.slice(0, 3);
      const lands = g.lands(me).length + g.players[me].hand.filter((c) => g.isLand(c)).length;
      const topLands = top.filter((c) => g.isLand(c)).length;
      if (lands < 3 && topLands === 0) return true;
      if (lands >= 5 && topLands === top.length) return true;
      return false;
    }
    return true;
  }

  scry(g: Game, cards: CardInstance[]) {
    const me = this.me;
    const lands = g.lands(me).length + g.players[me].hand.filter((c) => g.isLand(c)).length;
    const top: number[] = [];
    const bottom: number[] = [];
    let l = lands;
    for (const c of cards) {
      if (g.isLand(c)) {
        if (l < 4) {
          top.push(c.id);
          l++;
        } else bottom.push(c.id);
      } else if (c.def.cmc <= Math.max(3, lands + 1)) top.push(c.id);
      else bottom.push(c.id);
    }
    return { top, bottom };
  }

  // ───────────────────────────── combat ─────────────────────────────

  /** Combat damage one attacker would deal to the defending player, given who blocks it. */
  private attackerDamageThrough(g: Game, a: CardInstance, blockers: CardInstance[]): number {
    let p = Math.max(0, g.power(a));
    if (g.hasKeyword(a, 'double strike')) p *= 2;
    if (!blockers.length) return p;
    if (!g.hasKeyword(a, 'trample')) return 0;
    const absorb = blockers.reduce((s, b) => s + (g.hasKeyword(a, 'deathtouch') ? 1 : Math.max(0, g.toughness(b) - b.damage)), 0);
    return Math.max(0, p - absorb);
  }

  /** Total damage that gets through to the defending player with these blocks (blockerId → attackerId). */
  damageThrough(g: Game, attackers: CardInstance[], blocks: Record<number, number>): number {
    let total = 0;
    for (const a of attackers) {
      const bl = Object.entries(blocks)
        .filter(([, aid]) => aid === a.id)
        .map(([bid]) => g.card(+bid)!)
        .filter(Boolean);
      total += this.attackerDamageThrough(g, a, bl);
    }
    return total;
  }

  /**
   * Burn the opponent could still point at our face this turn (rough guess from what they've shown):
   * if they've been casting burn/drain and still hold cards, keep a few points of buffer.
   */
  reachMargin(g: Game, who: PlayerId): number {
    const p = g.players[who];
    const shown = p.graveyard.filter((c) => c.def.ai?.kind === 'burn' || c.def.ai?.kind === 'drain').length;
    if (!shown || !p.hand.length) return 0;
    return Math.min(3, p.hand.length);
  }

  /**
   * Adds blocks (on top of `initial`) until the damage that gets through is below `life`,
   * always picking the block that saves the most damage — chump blocks included.
   */
  survivalBlocks(
    g: Game,
    attackers: CardInstance[],
    blockers: CardInstance[],
    life: number,
    initial: Record<number, number> = {},
  ): { blocks: Record<number, number>; through: number } {
    const blocks = { ...initial };
    let through = this.damageThrough(g, attackers, blocks);
    while (through >= life) {
      let best: { b: CardInstance; a: CardInstance; score: number; through: number } | null = null;
      for (const b of blockers) {
        if (blocks[b.id] !== undefined) continue;
        for (const a of attackers) {
          if (!g.canBlock(b, a)) continue;
          const t = this.damageThrough(g, attackers, { ...blocks, [b.id]: a.id });
          const saved = through - t;
          if (saved <= 0) continue;
          // save the most damage; prefer blocks that kill the attacker or survive; spend the cheapest creature
          const score = saved * 10 + (this.kills(g, b, a) ? 4 : 0) + (!this.kills(g, a, b) ? 3 : 0) - this.value(g, b);
          if (!best || score > best.score) best = { b, a, score, through: t };
        }
      }
      if (!best) break;
      blocks[best.b.id] = best.a.id;
      through = best.through;
    }
    return { blocks, through };
  }

  /** Would we die (or nearly) if `attackers` swing at us and we block with `blockers` as well as we can? */
  isLethal(g: Game, attackers: CardInstance[], blockers: CardInstance[], defender: PlayerId) {
    const life = g.players[defender].life - this.reachMargin(g, g.opp(defender));
    return this.survivalBlocks(g, attackers, blockers, life).through >= life;
  }

  declareAttackers(g: Game, cands: CardInstance[]): number[] {
    const me = this.me;
    const opp = this.opp(g);
    const blockers = g.creatures(opp).filter((c) => !c.tapped);
    const oppLife = g.players[opp].life;
    const aggro = this.isAggro(g);

    // alpha strike if lethal through their best possible blocks
    const all = cands.filter((c) => g.power(c) > 0);
    if (all.length) {
      const theirBest = this.survivalBlocks(g, all, blockers, oppLife);
      if (theirBest.through >= oppLife) return all.map((c) => c.id);
      // Elves: attackers + Timberwatch pumps on whatever gets through
      const pumpers = g.creatures(me).filter((c) => !c.tapped && !g.isSick(c) && (c.def.activated ?? []).some((ab) => ab.label?.startsWith('Pump')));
      if (pumpers.length) {
        const x = g.creatures().filter((e) => g.hasSubtype(e, 'Elf')).length;
        const quirionReady = g
          .creatures(me)
          .some((q) => (q.def.activated ?? []).some((ab, i) => ab.oncePerTurn && ab.label?.startsWith('Return a Forest') && q.lastActivated?.[i] !== g.turn));
        const pumps = pumpers.length + (quirionReady && this.tappedForests(g).length ? 1 : 0);
        const attackers = all.filter((c) => !pumpers.includes(c));
        if (attackers.length) {
          const through = this.survivalBlocks(g, attackers, blockers, oppLife).through;
          if (through > 0 && through + x * pumps >= oppLife) return attackers.map((c) => c.id);
        }
      }
    }

    const out: number[] = [];
    const sortedCands = [...cands].sort((a, b) => this.value(g, a) - this.value(g, b));
    for (const a of sortedCands) {
      if (g.power(a) <= 0) continue;
      // Timberwatch Elf: tapping to pump another attacker beats attacking with a 1/2
      const pumper = (a.def.activated ?? []).some((ab) => ab.label?.startsWith('Pump'));
      const elves = g.creatures().filter((e) => g.hasSubtype(e, 'Elf')).length;
      if (pumper && elves > g.power(a) && cands.length > 1) continue;
      const canBlockIt = blockers.filter((b) => g.canBlock(b, a));
      const badBlocks = canBlockIt.filter((b) => this.kills(g, b, a) && !this.kills(g, a, b));
      const trades = canBlockIt.filter((b) => this.kills(g, b, a) && this.kills(g, a, b));
      let attack = false;
      if (!canBlockIt.length) attack = true;
      else if (!badBlocks.length && !trades.length) attack = true;
      else if (!badBlocks.length && aggro) attack = true;
      else if (!badBlocks.length && trades.every((b) => this.value(g, b) >= this.value(g, a))) attack = true;
      if (attack) out.push(a.id);
    }

    // survival: don't tap creatures we need to block a lethal crack-back next turn
    const crackBack = (attacking: number[]) => {
      const myBlockers = g.creatures(me).filter((c) => !c.tapped && (!attacking.includes(c.id) || g.hasKeyword(c, 'vigilance')));
      return this.isLethal(g, g.creatures(opp), myBlockers, me);
    };
    if (out.length && crackBack(out) && !crackBack([])) {
      // keep back the best blockers first until we're safe
      const byBlockValue = out
        .map((id) => g.card(id)!)
        .filter((c) => !g.hasKeyword(c, 'vigilance'))
        .sort((a, b) => g.toughness(b) + (g.hasKeyword(b, 'deathtouch') ? 3 : 0) - (g.toughness(a) + (g.hasKeyword(a, 'deathtouch') ? 3 : 0)));
      for (const c of byBlockValue) {
        out.splice(out.indexOf(c.id), 1);
        if (!crackBack(out)) break;
      }
    }
    return out;
  }

  declareBlockers(g: Game, attackers: CardInstance[], cands: CardInstance[]): Record<number, number> {
    const me = this.me;
    const blocks: Record<number, number> = {};
    const used = new Set<number>();
    const myLife = g.players[me].life;
    const sorted = [...attackers].sort((a, b) => g.power(b) - g.power(a));
    const aggro = this.isAggro(g);

    // 1. value blocks
    for (const a of sorted) {
      const options = cands.filter((b) => !used.has(b.id) && g.canBlock(b, a));
      if (!options.length) continue;
      const safe = options.filter((b) => this.kills(g, b, a) && !this.kills(g, a, b));
      const survive = options.filter((b) => !this.kills(g, a, b));
      const trade = options.filter((b) => this.kills(g, b, a) && this.value(g, b) <= this.value(g, a) + 0.5);
      let pick: CardInstance | undefined;
      if (safe.length) pick = safe.sort((x, y) => this.value(g, x) - this.value(g, y))[0];
      else if (survive.length && !aggro) pick = survive.sort((x, y) => this.value(g, x) - this.value(g, y))[0];
      else if (trade.length && (!aggro || myLife <= 8)) pick = trade.sort((x, y) => this.value(g, x) - this.value(g, y))[0];
      if (pick) {
        blocks[pick.id] = a.id;
        used.add(pick.id);
      }
    }

    // 2. survival: if what's left would kill us (counting likely burn), add chump blocks until it doesn't
    const life = myLife - this.reachMargin(g, this.opp(g));
    const survived = this.survivalBlocks(g, attackers, cands, life, blocks);
    if (survived.through >= life && survived.through < myLife) {
      // can't get out of burn range, but we can still avoid dying to the attack itself
      return this.survivalBlocks(g, attackers, cands, myLife, blocks).blocks;
    }
    return survived.blocks;
  }

  /**
   * When an attack is lethal even after our best blocks, use instant-speed removal / burn / shrink
   * effects on the attacker that saves the most damage.
   */
  emergencyResponse(g: Game, all: Action[]): Action | null {
    const me = this.me;
    const opp = this.opp(g);
    const attackers = g.attackers().filter((a) => a.controller === opp);
    if (!attackers.length) return null;
    const life = g.players[me].life - this.reachMargin(g, opp);
    const blocked = g.step === 'declareBlockers';
    // blocks are locked in after declare blockers; before that, assume our best blocks
    const currentBlocks = (atts: CardInstance[]) => {
      if (blocked) {
        const b: Record<number, number> = {};
        for (const a of atts) for (const id of a.blockedBy) b[id] = a.id;
        return this.damageThrough(g, atts, b);
      }
      const myBlockers = g.creatures(me).filter((c) => !c.tapped);
      return this.survivalBlocks(g, atts, myBlockers, life).through;
    };
    const through = currentBlocks(attackers);
    if (through < life) return null;

    let best: { a: Action; saved: number; intent: Intent } | null = null;
    for (const a of all) {
      if (a.type !== 'cast') continue;
      const c = g.card(a.cardId)!;
      if (!(g.is(c, 'Instant') || g.hasKeyword(c, 'flash'))) continue;
      const kind = c.def.ai?.kind;
      if (!['removal', 'burn'].includes(kind ?? '') && c.def.name !== 'Agony Warp') continue;
      const spec = g.modesFor(c, a.method)[0].targets?.[0];
      if (!spec) continue;
      for (const t of g.candidates(spec, { controller: me, source: c, chosen: [] })) {
        if (t.kind !== 'card') continue;
        const target = g.card(t.id)!;
        if (!attackers.includes(target)) continue;
        let after: number;
        if (c.def.name === 'Agony Warp') {
          // -3/-0 on the attacker: it deals 3 less
          const saved = Math.min(3, Math.max(0, g.power(target))) * (this.attackerDamageThrough(g, target, target.blockedBy.map((id) => g.card(id)!).filter(Boolean)) > 0 ? 1 : 0);
          after = through - saved;
        } else {
          if (kind === 'burn') {
            const dmg = c.def.name === 'Galvanic Blast' && g.artifacts(me).length >= 3 ? 4 : c.def.ai?.amount ?? 2;
            if (dmg < g.toughness(target) - target.damage) continue;
          }
          after = currentBlocks(attackers.filter((x) => x !== target));
        }
        const saved = through - after;
        if (saved > 0 && (!best || saved > best.saved)) {
          const targets: Target[] = c.def.name === 'Agony Warp' ? [t, t] : [t];
          best = { a, saved, intent: { cardId: c.id, targets } };
        }
      }
    }
    if (!best) return null;
    this.intent = best.intent;
    return best.a;
  }
}
