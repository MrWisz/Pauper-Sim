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

// ───────────── Elves AI ─────────────

// 11. Quirion Ranger: return a Forest already tapped for mana to untap a tapped Priest, when that lets it cast more
{
  const { g, ai, put, hand } = setup(20);
  g.active = 1;
  g.step = 'main1';
  const tappedForest = put(1, 'Forest', true);
  put(1, 'Forest', true);
  const untappedForest = put(1, 'Forest');
  const priest = put(1, 'Priest of Titania', true);
  put(1, 'Llanowar Elves', true);
  put(1, 'Timberwatch Elf');
  put(1, 'Quirion Ranger');
  hand(1, 'Avenging Hunter'); // 5 mana: we have 1 untapped Forest; untapping Priest (+4) and replaying the Forest (+1) gets there
  const act = ai.decidePriority(g);
  const isQuirion = act.type === 'activate' && g.card(act.cardId)!.def.name === 'Quirion Ranger';
  const tgt = ai.intent?.targets?.[0];
  check('Quirion untaps Priest to cast more', isQuirion && tgt?.kind === 'card' && tgt.id === priest.id, `action ${act.type === 'activate' ? g.card(act.cardId)!.def.name : act.type}`);
  if (isQuirion) {
    await g.perform(1, act);
    while (g.stack.length) await g.resolveTop();
    const back = g.players[1].hand.find((c) => c.def.name === 'Forest');
    check(
      'Quirion only returns a tapped Forest',
      !!back && back !== untappedForest && untappedForest.zone === 'battlefield' && !priest.tapped,
      `returned ${back === tappedForest || (back && back !== untappedForest) ? 'a tapped Forest' : 'the untapped Forest'}, Priest tapped=${priest.tapped}`,
    );
  }
}

// 12. ...but never when no Forest has been tapped (untapping would cost us a land's mana)
{
  const { g, ai, put, hand } = setup(20);
  g.active = 1;
  g.step = 'main1';
  for (let i = 0; i < 3; i++) put(1, 'Forest');
  put(1, 'Priest of Titania', true);
  put(1, 'Llanowar Elves', true);
  put(1, 'Quirion Ranger');
  hand(1, 'Generous Ent');
  const act = ai.decidePriority(g);
  const name = act.type === 'activate' ? g.card(act.cardId)!.def.name : act.type;
  check('no Quirion without a tapped Forest', name !== 'Quirion Ranger', `action ${name}`);
}

// 13. Combo: Timberwatch already pumped this combat -> Quirion untaps it (tapped Forest) so it can pump again
{
  const { g, ai, put } = setup(20);
  g.active = 1;
  g.step = 'declareBlockers';
  put(1, 'Forest', true);
  const attacker = put(1, 'Llanowar Elves');
  attacker.attacking = true;
  attacker.tapped = true;
  attacker.wasBlocked = false;
  const tw = put(1, 'Timberwatch Elf', true); // used its pump already
  put(1, 'Quirion Ranger');
  const act = ai.decidePriority(g);
  const isQuirion = act.type === 'activate' && g.card(act.cardId)!.def.name === 'Quirion Ranger';
  const tgt = ai.intent?.targets?.[0];
  check('Quirion untaps Timberwatch for a second pump', isQuirion && tgt?.kind === 'card' && tgt.id === tw.id, `action ${act.type === 'activate' ? g.card(act.cardId)!.def.name : act.type}`);
}

// 14. Lethal with pumps: opponent at 5, two 1/1 elves attack and Timberwatch (3 Elves = +3) stays home to pump
{
  const { g, ai, put } = setup(20);
  g.players[0].life = 5;
  g.active = 1;
  const a1 = put(1, 'Llanowar Elves');
  const a2 = put(1, 'Fyndhorn Elves');
  const tw = put(1, 'Timberwatch Elf');
  const ids = ai.declareAttackers(g, [a1, a2, tw]);
  check('attack for lethal with Timberwatch held back', ids.length === 2 && !ids.includes(tw.id), `attacks with ${ids.map((id) => g.card(id)!.def.name).join(', ')}`);
}

// 15. Mulligans: 1 Forest + 2 one-drop mana elves is a keep
{
  const { g, ai } = setup(20);
  const mk = (n: string) => g.makeCard(getDef(n)!, 1);
  const handCards = ['Forest', 'Llanowar Elves', 'Elvish Mystic', 'Priest of Titania', 'Timberwatch Elf', 'Lead the Stampede', 'Quirion Ranger'].map(mk);
  const keep = ai.keepHand(g, handCards, 0);
  const oneLandNoElves = ['Forest', 'Generous Ent', 'Avenging Hunter', 'Lead the Stampede', 'Winding Way', 'Nyxborn Hydra', 'Masked Vandal'].map(mk);
  check('keep 1 land + 2 mana elves', keep && !ai.keepHand(g, oneLandNoElves, 0), `elf hand kept=${keep}, 1-lander without elves kept=${ai.keepHand(g, oneLandNoElves, 0)}`);
}

// ───────────── Tron AI ─────────────

// 16. Fog: a big unblocked attack gets Moment's Peace (after blockers are declared)
{
  const { g, ai, put, hand } = setup(10);
  g.active = 0;
  g.step = 'declareBlockers';
  put(1, 'Forest');
  put(1, 'Island');
  hand(1, "Moment's Peace");
  for (const n of ['Myr Enforcer', 'Guttersnipe']) {
    const a = put(0, n);
    a.attacking = true;
    a.tapped = true;
  }
  const act = ai.decidePriority(g);
  const name = act.type === 'cast' ? g.card(act.cardId)!.def.name : act.type;
  check("fog a 6-damage attack", name === "Moment's Peace", `action ${name}`);
}

// 17. ...but not a single 1/1 poke
{
  const { g, ai, put, hand } = setup(20);
  g.active = 0;
  g.step = 'declareBlockers';
  put(1, 'Forest');
  put(1, 'Island');
  hand(1, "Moment's Peace");
  const a = put(0, 'Voldaren Epicure');
  a.attacking = true;
  a.tapped = true;
  const act = ai.decidePriority(g);
  const name = act.type === 'cast' ? g.card(act.cardId)!.def.name : act.type;
  check('no fog for 1 damage', name !== "Moment's Peace", `action ${name}`);
}

// 18. Keep fog mana up: with 3 lands, Moment's Peace in hand and a threatening board, don't tap out for a 2-drop artifact
{
  const { g, ai, put, hand } = setup(20);
  g.active = 1;
  g.step = 'main1';
  put(1, 'Forest');
  put(1, 'Island');
  put(1, 'Island');
  hand(1, "Moment's Peace");
  hand(1, 'Generous Ent'); // can't afford anyway
  const prism = hand(1, 'Prophetic Prism'); // 2 mana: leaves 1, not enough for Moment's Peace
  put(0, 'Myr Enforcer');
  put(0, 'Guttersnipe');
  g.players[1].landsPlayedThisTurn = 1;
  const act = ai.decidePriority(g);
  check('holds up fog mana', !(act.type === 'cast' && act.cardId === prism.id), `action ${act.type === 'cast' ? g.card(act.cardId)!.def.name : act.type}`);
}

// 19. Assemble Tron: play the missing Urza piece over a basic
{
  const { g, ai, put, hand } = setup(20);
  g.active = 1;
  g.step = 'main1';
  put(1, "Urza's Mine");
  put(1, "Urza's Power Plant");
  hand(1, 'Island');
  const tower = hand(1, "Urza's Tower");
  const act = ai.decidePriority(g);
  check('plays the missing Tron piece', act.type === 'playLand' && act.cardId === tower.id, `plays ${act.type === 'playLand' ? g.card(act.cardId)!.def.name : act.type}`);
}

// 20. Crop Rotation: sacrifice the basic (not a Tron piece) to fetch the missing Urza land
{
  const { g, ai, put, hand } = setup(20);
  g.active = 1;
  g.step = 'main1';
  const mine = put(1, "Urza's Mine");
  const plant = put(1, "Urza's Power Plant");
  const forest = put(1, 'Forest');
  const tower = g.makeCard(getDef("Urza's Tower")!, 1);
  tower.zone = 'library';
  g.players[1].library.splice(10, 0, tower);
  g.players[1].landsPlayedThisTurn = 1;
  const crop = hand(1, 'Crop Rotation');
  const act = ai.decidePriority(g);
  const isCrop = act.type === 'cast' && act.cardId === crop.id;
  if (isCrop) {
    await g.perform(1, act);
    while (g.stack.length) await g.resolveTop();
  }
  check(
    'Crop Rotation completes Tron',
    isCrop && tower.zone === 'battlefield' && forest.zone === 'graveyard' && mine.zone === 'battlefield' && plant.zone === 'battlefield',
    `cast=${isCrop}, Tower in ${tower.zone}, Forest in ${forest.zone}`,
  );
}

// 21. Stream of Thought for the win: opponent has 8 cards left, we can replicate once
{
  const { g, ai, put, hand } = setup(20);
  g.active = 1;
  g.step = 'main1';
  for (let i = 0; i < 5; i++) put(1, 'Island');
  g.players[1].landsPlayedThisTurn = 1;
  g.players[0].library.splice(8);
  const stream = hand(1, 'Stream of Thought');
  const act = ai.decidePriority(g);
  check('Stream of Thought mills out the opponent', act.type === 'cast' && act.cardId === stream.id, `action ${act.type === 'cast' ? g.card(act.cardId)!.def.name : act.type}`);
}

console.log(failures ? `${failures} failure(s)` : 'all passed');
process.exit(failures ? 1 : 0);
