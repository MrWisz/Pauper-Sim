// Scenario checks for the AI's survival logic: npx tsx scripts/combat-test.ts
import { Game } from '../src/engine/game';
import { AIController } from '../src/engine/ai';
import { getDef } from '../src/engine/cards/registry';
import type { Controller, PlayerId } from '../src/engine/types';

const idle: Controller = { async choose() { return { type: 'pass' }; } };
let failures = 0;

function setup(aiLife: number) {
  const deck = Array(40).fill(getDef('Mountain')!);
  const ai = new AIController(1, 0);
  const g = new Game([deck, deck], [idle, ai], ['Human', 'AI'], 0, 1);
  g.turn = 6;
  g.players[1].life = aiLife;
  const put = (pid: PlayerId, name: string, tapped = false) => {
    const c = g.makeCard(getDef(name)!, pid);
    g.moveCard(c, 'battlefield', { controller: pid, tapped });
    c.enteredTick = -1;
    return c;
  };
  const hand = (pid: PlayerId, name: string) => {
    const c = g.makeCard(getDef(name)!, pid);
    c.zone = 'hand';
    g.players[pid].hand.push(c);
    return c;
  };
  g.pendingTriggers = [];
  return { g, ai, put, hand };
}

function check(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
  if (!ok) failures++;
}

// 1. Chump blocks to survive: AI at 4, facing 4/4 + 2/2 + 1/1 (7 damage) with two 1/1s.
{
  const { g, ai, put } = setup(4);
  const atk = [put(0, 'Myr Enforcer'), put(0, 'Guttersnipe'), put(0, 'Voldaren Epicure')];
  const bl = [put(1, 'Faerie Seer'), put(1, 'Voldaren Epicure')];
  // Faerie Seer flies and can block anything here
  for (const a of atk) a.attacking = true;
  const blocks = ai.declareBlockers(g, atk, bl);
  const through = ai.damageThrough(g, atk, blocks);
  check('chump to survive', through < 4, `blocks ${Object.keys(blocks).length}, damage through ${through} (life 4)`);
}

// 2. No needless chumps when not lethal: AI at 20 facing a 4/4 with a 1/1.
{
  const { g, ai, put } = setup(20);
  const atk = [put(0, 'Myr Enforcer')];
  const bl = [put(1, 'Voldaren Epicure')];
  atk[0].attacking = true;
  const blocks = ai.declareBlockers(g, atk, bl);
  check('no chump at high life', Object.keys(blocks).length === 0, `blocks ${Object.keys(blocks).length}`);
}

// 3. Trample: chumping a 6/1 trampler with a 1/1 saves only 1, so it needs the biggest blocker.
{
  const { g, ai, put } = setup(5);
  const enforcer = put(0, 'Myr Enforcer');
  const rancor = g.makeCard(getDef('Rancor')!, 0);
  g.moveCard(rancor, 'battlefield', { controller: 0, attachTo: enforcer }); // 6/4 trample
  enforcer.attacking = true;
  const small = put(1, 'Voldaren Epicure');
  const big = put(1, 'Thorn of the Black Rose'); // 1/3 deathtouch
  const blocks = ai.declareBlockers(g, [enforcer], [small, big]);
  const through = ai.damageThrough(g, [enforcer], blocks);
  check('trample needs real blockers', through < 5, `damage through ${through} (life 5), blockers ${Object.keys(blocks).map((id) => g.card(+id)!.def.name)}`);
}

// 4. Emergency removal: AI at 3, an unblockable-for-us flier attacks, AI holds Lightning Bolt + Mountain.
{
  const { g, ai, put, hand } = setup(3);
  const flier = put(0, 'Utrom Monitor'); // 3/3 flier
  put(1, 'Voldaren Epicure'); // can't block a flier
  put(1, 'Mountain');
  hand(1, 'Lightning Bolt');
  g.active = 0;
  g.step = 'declareAttackers';
  flier.attacking = true;
  const act = ai.decidePriority(g);
  const card = act.type === 'cast' ? g.card(act.cardId)!.def.name : act.type;
  const tgt = ai.intent?.targets?.[0];
  check('bolt the lethal attacker', card === 'Lightning Bolt' && tgt?.kind === 'card' && tgt.id === flier.id, `action ${card}`);
}

// 5. Crack-back: AI at 4 with two 2/2s; opponent has two 2/2s untapped next turn. Attacking with both would leave it dead.
{
  const { g, ai, put } = setup(4);
  put(0, 'Guttersnipe', true);
  put(0, 'Guttersnipe', true); // tapped now, but they'll untap and swing back
  const mine = [put(1, 'Guttersnipe'), put(1, 'Guttersnipe')];
  g.active = 1;
  const attacks = ai.declareAttackers(g, mine);
  check('hold back for crack-back', attacks.length < 2, `attacks with ${attacks.length}`);
}

// 6. Still alpha-strikes when the attack itself is lethal.
{
  const { g, ai, put } = setup(2);
  g.players[0].life = 4;
  put(0, 'Guttersnipe', true);
  put(0, 'Guttersnipe', true);
  const mine = [put(1, 'Guttersnipe'), put(1, 'Guttersnipe')];
  g.active = 1;
  const attacks = ai.declareAttackers(g, mine);
  check('alpha strike for the win', attacks.length === 2, `attacks with ${attacks.length}`);
}

// 7. Pyroblast vs Bogles: the only blue permanent is a hexproof Slippery Bogle wearing (white) Ethereal Armor.
//    The AI must not fire Pyroblast at the Armor (it would do nothing).
{
  const { g, ai, put, hand } = setup(20);
  const bogle = put(0, 'Slippery Bogle');
  const armor = g.makeCard(getDef('Ethereal Armor')!, 0);
  g.moveCard(armor, 'battlefield', { controller: 0, attachTo: bogle });
  put(1, 'Great Furnace');
  hand(1, 'Pyroblast');
  g.active = 1;
  g.step = 'main1';
  const act = ai.decidePriority(g);
  const name = act.type === 'cast' ? g.card(act.cardId)!.def.name : act.type;
  check('no Pyroblast into hexproof Bogles', name !== 'Pyroblast', `action ${name}`);
}

// 8. ...but it still blasts a blue permanent it can target.
{
  const { g, ai, put, hand } = setup(20);
  const monitor = put(0, 'Utrom Monitor'); // blue artifact creature, no hexproof
  put(1, 'Great Furnace');
  hand(1, 'Pyroblast');
  g.active = 1;
  g.step = 'main1';
  const act = ai.decidePriority(g);
  const name = act.type === 'cast' ? g.card(act.cardId)!.def.name : act.type;
  const tgt = ai.intent?.targets?.[0];
  check('Pyroblast a targetable blue permanent', name === 'Pyroblast' && tgt?.kind === 'card' && tgt.id === monitor.id, `action ${name}`);
}

// 9–10. Ward {2}: an opponent's Lightning Bolt is countered unless they pay {2}.
for (const mountains of [1, 3]) {
  let targetId = 0;
  const caster: Controller = {
    async choose(g, r) {
      if (r.type === 'targets') return [{ kind: 'card', id: targetId }];
      if (r.type === 'yesno') return true; // pay ward when possible
      return { type: 'pass' };
    },
  };
  const deck = Array(40).fill(getDef('Mountain')!);
  const g = new Game([deck, deck], [caster, idle], ['Caster', 'Warded'], 0, 1);
  g.turn = 3;
  g.step = 'main1';
  const wardDef = { ...getDef('Slippery Bogle')!, name: 'Ward Tester', keywords: ['ward' as const], wardCost: '{2}' };
  const warded = g.makeCard(wardDef, 1);
  g.moveCard(warded, 'battlefield', { controller: 1 });
  for (let i = 0; i < mountains; i++) g.moveCard(g.makeCard(getDef('Mountain')!, 0), 'battlefield', { controller: 0 });
  const bolt = g.makeCard(getDef('Lightning Bolt')!, 0);
  bolt.zone = 'hand';
  g.players[0].hand.push(bolt);
  targetId = warded.id;
  g.pendingTriggers = [];
  await g.castSpell(0, bolt, 'normal');
  await g.stateCheck(); // ward trigger goes on the stack
  while (g.stack.length) {
    await g.resolveTop();
    await g.stateCheck();
  }
  const countered = g.logs.some((l) => l.text === 'Lightning Bolt is countered.');
  const died = warded.zone !== 'battlefield';
  if (mountains === 1) check('ward counters when the caster cannot pay', countered && !died, `countered=${countered}, warded creature died=${died}`);
  else check('ward lets the spell through when paid', !countered && died, `countered=${countered}, warded creature died=${died}`);
}

console.log(failures ? `${failures} failure(s)` : 'all passed');
process.exit(failures ? 1 : 0);
