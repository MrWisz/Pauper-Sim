import type { Game } from '../engine/game';
import type { Action, ChoiceRequest, Controller, PlayerId } from '../engine/types';

/**
 * Bridges engine decisions to the UI. Like Arena, it auto-passes priority when the
 * player has nothing relevant to do, unless "full control" is on.
 */
export class HumanController implements Controller {
  req: ChoiceRequest | null = null;
  private resolver: ((v: any) => void) | null = null;
  fullControl = false;
  /** pass priority until this turn ends (unless the opponent does something) */
  passTurn: number | null = null;

  constructor(public pid: PlayerId) {}

  async choose(g: Game, req: ChoiceRequest): Promise<any> {
    if (req.type === 'priority' && this.shouldAutoPass(g)) return { type: 'pass' } as Action;
    if (req.type === 'attackers' && this.passTurn === g.turn) return [];
    return new Promise((resolve) => {
      this.req = req;
      this.resolver = resolve;
      g.changed();
    });
  }

  get waiting() {
    return !!this.resolver;
  }

  respond(value: any) {
    const r = this.resolver;
    this.resolver = null;
    this.req = null;
    r?.(value);
  }

  shouldAutoPass(g: Game): boolean {
    const me = this.pid;
    const top = g.stack[g.stack.length - 1];
    if (this.passTurn !== null && this.passTurn !== g.turn) this.passTurn = null;
    // opponent did something: stop passing
    if (this.passTurn !== null && top && top.controller !== me) this.passTurn = null;
    if (this.fullControl) return false;
    if (this.passTurn !== null) return true;
    // our own spell on top: let it resolve (Arena behaviour)
    if (top && top.controller === me) return true;
    const actions = g.legalActions(me);
    if (!actions.length) return true;
    if (top) {
      // don't stop for the opponent's harmless triggers (scry, draw…) — only spells or abilities aimed at us
      if (top.kind === 'ability') {
        const aimedAtMe = top.targets
          .flat()
          .some((t) => (t.kind === 'player' ? t.pid === me : t.kind === 'card' && g.card(t.id)?.controller === me));
        return !aimedAtMe;
      }
      return false;
    }
    const myTurn = g.active === me;
    const step = g.step;
    if (myTurn) {
      if (step === 'main1' || step === 'main2') return false;
      // ninjutsu window
      if ((step === 'declareBlockers' || step === 'combatDamage') && actions.some((a) => a.type === 'activate' && g.card(a.cardId)?.zone === 'hand'))
        return false;
      return true;
    }
    if (step === 'declareAttackers' && g.attackers().length) return false;
    if (step === 'declareBlockers' && g.attackers().length) return false;
    if (step === 'end') return false;
    return true;
  }
}
