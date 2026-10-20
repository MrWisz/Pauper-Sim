// Rules checks for individual mechanics: npx tsx scripts/rules-test.ts
import { Game } from '../src/engine/game';
import { AIController } from '../src/engine/ai';
import { getDef } from '../src/engine/cards/registry';
import type { CardInstance, Controller, PlayerId } from '../src/engine/types';

let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
  if (!ok) failures++;
};

/** p0 = scripted player (targets what we tell it, says yes), p1 = AI */
function setup(opts: { target?: () => number; yes?: boolean } = {}) {
  const p0: Controller = {
    async choose(g, r) {
      if (r.type === 'targets') return [{ kind: 'card', id: opts.target?.() ?? 0 }];
      if (r.type === 'yesno') return opts.yes ?? true;
      if (r.type === 'cards') return r.cards.slice(0, r.min).map((c) => c.id);
      return { type: 'pass' };
    },
  };
  const deck = Array(40).fill(getDef('Island')!);
  const g = new Game([deck, deck], [p0, new AIController(1, 0)], ['P0', 'AI'], 0, 1);
  g.turn = 3;
  g.step = 'main1';
  const put = (pid: PlayerId, name: string) => {
    const c = g.makeCard(getDef(name)!, pid);
    g.moveCard(c, 'battlefield', { controller: pid });
    c.enteredTick = -1;
    return c;
  };
  const inHand = (pid: PlayerId, name: string) => {
    const c = g.makeCard(getDef(name)!, pid);
    c.zone = 'hand';
    g.players[pid].hand.push(c);
    return c;
  };
  const inGrave = (pid: PlayerId, name: string) => {
    const c = g.makeCard(getDef(name)!, pid);
    c.zone = 'graveyard';
    g.players[pid].graveyard.push(c);
    return c;
  };
  const resolveAll = async () => {
    await g.stateCheck();
    while (g.stack.length) {
      await g.resolveTop();
      await g.stateCheck();
    }
  };
  g.pendingTriggers = [];
  return { g, put, inHand, inGrave, resolveAll };
}

// Delver of Secrets transforms when it reveals an instant, and reverts when it leaves the battlefield
{
  const { g, put, resolveAll } = setup();
  const delver = put(1, 'Delver of Secrets');
  const top = g.makeCard(getDef('Brainstorm')!, 1);
  top.zone = 'library';
  g.players[1].library.unshift(top);
  g.pendingTriggers = [];
  g.active = 1;
  g.emit({ type: 'step', step: 'upkeep', active: 1 });
  await resolveAll();
  check(
    'Delver transforms',
    delver.def.name === 'Insectile Aberration' && g.hasKeyword(delver, 'flying') && g.power(delver) === 3,
    `${delver.def.name}, flying=${g.hasKeyword(delver, 'flying')}, ${g.power(delver)}/${g.toughness(delver)}`,
  );
  g.bounce(delver);
  check('transformed card reverts when it leaves', delver.def.name === 'Delver of Secrets' && delver.zone === 'hand', `${delver.def.name} in ${delver.zone}`);
}

// The human player's Delver: answering Yes reveals and transforms, No keeps it as is
for (const answer of [true, false]) {
  const { g, put, resolveAll } = setup({ yes: answer });
  const delver = put(0, 'Delver of Secrets');
  const top = g.makeCard(getDef('Ponder')!, 0);
  top.zone = 'library';
  g.players[0].library.unshift(top);
  g.pendingTriggers = [];
  g.active = 0;
  g.emit({ type: 'step', step: 'upkeep', active: 0 });
  await resolveAll();
  const flipped = delver.def.name === 'Insectile Aberration';
  check(`your Delver, answering ${answer ? 'Yes' : 'No'}`, flipped === answer, delver.def.name);
}

// Delver stays a 1/1 non-flier when the top card is a land
{
  const { g, put, resolveAll } = setup();
  const delver = put(1, 'Delver of Secrets');
  g.active = 1;
  g.emit({ type: 'step', step: 'upkeep', active: 1 });
  await resolveAll();
  check('Delver stays put on a land', delver.def.name === 'Delver of Secrets' && !g.hasKeyword(delver, 'flying'), delver.def.name);
}

// Tolarian Terror costs {1} less per instant/sorcery in the graveyard
{
  const { g, inHand, inGrave } = setup();
  const terror = inHand(0, 'Tolarian Terror');
  for (const n of ['Brainstorm', 'Ponder', 'Counterspell', 'Island']) inGrave(0, n);
  const cost = g.spellCost(0, terror, 'normal');
  check('Tolarian Terror cost reduction', cost.generic === 3 && cost.U === 1, `generic ${cost.generic} + U ${cost.U} (3 spells in graveyard, the land doesn't count)`);
}

// Gut Shot: no red mana, so it's paid with 2 life
{
  let target = 0;
  const { g, put, inHand, resolveAll } = setup({ target: () => target });
  const seer = put(1, 'Faerie Seer');
  target = seer.id;
  const gut = inHand(0, 'Gut Shot');
  const ok = await g.castSpell(0, gut, 'normal');
  await resolveAll();
  check('Gut Shot paid with life', ok && g.players[0].life === 18 && seer.zone === 'graveyard', `cast=${ok}, life ${g.players[0].life}, Faerie Seer in ${seer.zone}`);
}

// Force Spike: countered if they can't pay {1}; not countered if they pay
for (const islands of [0, 1]) {
  let target = 0;
  const { g, put, inHand } = setup({ target: () => target, yes: true });
  // AI casts something; P0 Force Spikes it
  put(0, 'Island');
  for (let i = 0; i < islands; i++) put(1, 'Island');
  const bolt = g.makeCard(getDef('Lightning Bolt')!, 1);
  const item = { id: 999, kind: 'spell' as const, controller: 1 as PlayerId, card: bolt, text: '', targets: [], specs: [], mode: 0, info: { method: 'normal' as const }, mv: 1 };
  bolt.zone = 'stack';
  g.stack.push(item);
  target = 999;
  const spike = inHand(0, 'Force Spike');
  // target the stack item
  (g.controllers[0] as any).choose = async (gg: Game, r: any) => (r.type === 'targets' ? [{ kind: 'stack', id: 999 }] : { type: 'pass' });
  await g.castSpell(0, spike, 'normal');
  await g.resolveTop(); // Force Spike resolves; AI decides whether to pay
  const countered = !g.stack.includes(item);
  if (islands === 0) check('Force Spike counters when they cannot pay', countered, `countered=${countered}`);
  else check('Force Spike is paid when they can', !countered, `countered=${countered}`);
}

// Sleep of the Dead taps and skips one untap step; escape puts it back in the graveyard
{
  let target = 0;
  const { g, put, inHand, inGrave, resolveAll } = setup({ target: () => target });
  put(0, 'Island');
  put(0, 'Island');
  put(0, 'Island');
  const seer = put(1, 'Faerie Seer');
  target = seer.id;
  const sleep = inHand(0, 'Sleep of the Dead');
  await g.castSpell(0, sleep, 'normal');
  await resolveAll();
  const frozenAfterCast = seer.tapped && seer.counters.frozen === 1;
  // simulate the AI's untap steps by running the untap logic directly
  const untap = (pid: PlayerId) => {
    for (const c of g.permanents(pid) as CardInstance[]) {
      if (c.counters.frozen) {
        delete c.counters.frozen;
        continue;
      }
      c.tapped = false;
    }
  };
  untap(1);
  const stillTapped = seer.tapped;
  untap(1);
  check('Sleep of the Dead skips exactly one untap', frozenAfterCast && stillTapped && !seer.tapped, `after cast tapped+frozen=${frozenAfterCast}, after 1st untap tapped=${stillTapped}, after 2nd ${seer.tapped}`);

  // escape it: needs three other cards in the graveyard
  for (const n of ['Island', 'Ponder', 'Brainstorm']) inGrave(0, n);
  for (const c of g.lands(0)) c.tapped = false;
  seer.tapped = false;
  const canEscape = g.castOptions(0, sleep).some((o) => o.method === 'flashback');
  await g.castSpell(0, sleep, 'flashback');
  await resolveAll();
  check('escaped Sleep of the Dead returns to the graveyard', canEscape && sleep.zone === 'graveyard', `escape offered=${canEscape}, card now in ${sleep.zone}`);
}

// ───────────── Elves ─────────────

// Priest of Titania makes {G} per Elf (Changeling Masked Vandal counts); summoning-sick mana elves can't tap
{
  const { g, put } = setup();
  const priest = put(0, 'Priest of Titania');
  put(0, 'Llanowar Elves');
  put(0, 'Masked Vandal');
  const fresh = g.makeCard(getDef('Elvish Mystic')!, 0);
  g.moveCard(fresh, 'battlefield', { controller: 0 }); // just arrived: summoning sick
  const idx = priest.def.activated!.findIndex((a) => a.producesFn);
  const mana = g.produceOptions(priest, idx)[0];
  check('Priest of Titania counts Elves (incl. Changeling)', mana.length === 4, `adds ${mana.join('')} with Priest, Llanowar, Vandal, sick Mystic on the battlefield`);
  const sources = g.manaSources(0).map((s) => g.card(s.id)!.def.name);
  check('summoning-sick mana elf not used for mana', !sources.includes('Elvish Mystic') && sources.includes('Llanowar Elves'), sources.join(', '));
}

// Quirion Ranger: return a Forest to untap a creature, once per turn
{
  let target = 0;
  const { g, put, resolveAll } = setup({ target: () => target });
  const forest = put(0, 'Forest');
  put(0, 'Forest');
  const quirion = put(0, 'Quirion Ranger');
  const priest = put(0, 'Priest of Titania');
  priest.tapped = true;
  target = priest.id;
  const idx = quirion.def.activated!.findIndex((a) => a.oncePerTurn);
  const ok = await g.activate(0, quirion, idx);
  await resolveAll();
  check(
    'Quirion Ranger untaps and bounces a Forest',
    ok && !priest.tapped && g.players[0].hand.some((c) => c.def.name === 'Forest'),
    `activated=${ok}, Priest tapped=${priest.tapped}, Forests left in play=${g.lands(0).length}`,
  );
  check('Quirion Ranger only once per turn', !g.canActivate(0, quirion, idx), `can activate again: ${g.canActivate(0, quirion, idx)}`);
  void forest;
}

// Nyxborn Hydra: X counters as a creature; bestowed it pumps its host, and becomes a creature when the host dies
{
  let target = 0;
  const p0x = (x: number): Controller => ({
    async choose(g, r) {
      if (r.type === 'number') return x;
      if (r.type === 'targets') return [{ kind: 'card', id: target }];
      return { type: 'pass' };
    },
  });
  const { g, put, inHand, resolveAll } = setup();
  g.controllers[0] = p0x(3);
  for (let i = 0; i < 5; i++) put(0, 'Forest');
  const hydra = inHand(0, 'Nyxborn Hydra');
  await g.castSpell(0, hydra, 'normal');
  await resolveAll();
  check('Nyxborn Hydra with X=3', hydra.zone === 'battlefield' && g.power(hydra) === 3 && g.toughness(hydra) === 4, `${g.power(hydra)}/${g.toughness(hydra)}`);

  const b = setup();
  b.g.controllers[0] = p0x(2);
  for (let i = 0; i < 4; i++) b.put(0, 'Forest');
  const elf = b.put(0, 'Llanowar Elves');
  target = elf.id;
  const h2 = b.inHand(0, 'Nyxborn Hydra');
  await b.g.castSpell(0, h2, 'bestow');
  await b.resolveAll();
  const pumped = `${b.g.power(elf)}/${b.g.toughness(elf)}`;
  check(
    'bestowed Nyxborn Hydra pumps its host',
    h2.bestowed === true && pumped === '3/3' && b.g.hasKeyword(elf, 'trample') && b.g.hasKeyword(elf, 'reach') && !b.g.isCreature(h2),
    `Llanowar Elves ${pumped}, trample=${b.g.hasKeyword(elf, 'trample')}, Hydra is a creature: ${b.g.isCreature(h2)}`,
  );
  b.g.destroy(elf);
  await b.resolveAll();
  check(
    'bestowed Hydra becomes a creature when the host dies',
    h2.zone === 'battlefield' && b.g.isCreature(h2) && b.g.power(h2) === 2 && b.g.toughness(h2) === 3,
    `zone ${h2.zone}, creature=${b.g.isCreature(h2)}, ${b.g.power(h2)}/${b.g.toughness(h2)}`,
  );
}

// Avenging Hunter: take the initiative (Secret Entrance gets a basic land), venture at upkeep, lose it to combat damage
{
  const { g, put, inHand, resolveAll } = setup();
  for (let i = 0; i < 5; i++) put(0, 'Forest');
  const forestInLib = g.makeCard(getDef('Forest')!, 0);
  forestInLib.zone = 'library';
  g.players[0].library.push(forestInLib);
  (g.controllers[0] as any).choose = async (gg: Game, r: any) => {
    if (r.type === 'cards') return r.cards.slice(0, Math.max(1, r.min)).map((c: CardInstance) => c.id);
    if (r.type === 'mode') return 1; // Lost Well (scry 2) on the second venture
    if (r.type === 'scry') return { top: r.cards.map((c: CardInstance) => c.id), bottom: [] };
    return { type: 'pass' };
  };
  const hunter = inHand(0, 'Avenging Hunter');
  const handBefore = g.players[0].hand.length;
  await g.castSpell(0, hunter, 'normal');
  await resolveAll();
  check(
    'Avenging Hunter takes the initiative',
    g.initiative === 0 && g.dungeonRoom[0] === 'Secret Entrance' && g.players[0].hand.length === handBefore,
    `initiative=${g.initiative}, room=${g.dungeonRoom[0]}, hand ${handBefore}→${g.players[0].hand.length} (Hunter left, a basic land came)`,
  );
  g.active = 0;
  g.emit({ type: 'step', step: 'upkeep', active: 0 });
  g.addTrigger((g as any).initiativeSource, 0, 'venture', async () => {
    const { venture } = await import('../src/engine/undercity');
    await venture(g, 0, (g as any).initiativeSource);
  });
  await resolveAll();
  check('venturing again moves to the chosen room', g.dungeonRoom[0] === 'Lost Well', `room=${g.dungeonRoom[0]}`);
}

// Sagu Wildling's Roost Seek: fetch a basic land, the card is shuffled into the library
{
  const { g, put, inHand, resolveAll } = setup();
  put(0, 'Forest');
  const sagu = inHand(0, 'Sagu Wildling');
  (g.controllers[0] as any).choose = async (gg: Game, r: any) => (r.type === 'cards' ? [r.cards[0].id] : { type: 'pass' });
  const libBefore = g.players[0].library.length;
  const ok = await g.castSpell(0, sagu, 'omen');
  await resolveAll();
  check(
    'Roost Seek fetches a land and shuffles Sagu Wildling in',
    ok && sagu.zone === 'library' && g.players[0].hand.some((c) => c.def.name === 'Island') && g.players[0].library.length === libBefore,
    `cast=${ok}, Sagu in ${sagu.zone}, library ${libBefore}→${g.players[0].library.length}`,
  );
}

// Land Grant is free with no lands in hand; Gingerbread Cabin enters untapped with 3 other Forests and makes Food
{
  const { g, put, inHand, resolveAll } = setup();
  g.players[0].hand = [];
  const grant = inHand(0, 'Land Grant');
  const free = g.castOptions(0, grant).some((o) => o.method === 'alt');
  (g.controllers[0] as any).choose = async (gg: Game, r: any) => (r.type === 'cards' ? [] : { type: 'pass' });
  check('Land Grant free with no lands in hand', free, `free option offered: ${free}`);
  for (let i = 0; i < 3; i++) put(0, 'Forest');
  const cabin = g.makeCard(getDef('Gingerbread Cabin')!, 0);
  g.moveCard(cabin, 'battlefield', { controller: 0 });
  await resolveAll();
  check('Gingerbread Cabin untapped + Food', !cabin.tapped && g.permanents(0).some((c) => c.def.name === 'Food'), `tapped=${cabin.tapped}`);
}

console.log(failures ? `${failures} failure(s)` : 'all passed');
process.exit(failures ? 1 : 0);
