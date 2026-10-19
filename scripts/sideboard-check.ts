// Prints what the AI would sideboard in each matchup: npx tsx scripts/sideboard-check.ts
import { buildDeck, PRESETS } from '../src/engine/decks';
import { aiSideboard } from '../src/engine/sideboard';

const decks = Object.fromEntries(await Promise.all(Object.entries(PRESETS).map(async ([n, t]) => [n, await buildDeck(t)] as const)));
const pairs: [string, string][] = [
  ['Mono Red Madness', 'Dimir Faeries'],
  ['Dimir Faeries', 'Mono Red Madness'],
  ['Dimir Faeries', 'Selesnya Bogles'],
  ['Mono Red Madness', 'Grixis Affinity'],
  ['Selesnya Bogles', 'Grixis Affinity'],
  ['Grixis Affinity', 'Rakdos Madness'],
];
const count = (xs: string[]) => Object.entries(xs.reduce<Record<string, number>>((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {})).map(([k, v]) => `${v} ${k}`).join(', ') || '—';
for (const [me, opp] of pairs) {
  // pretend the AI saw a random ~20 of the opponent's nonland cards
  const pool = decks[opp].cards.filter((c) => !c.types.includes('Land'));
  const seen = pool.filter((_, i) => i % 2 === 0).slice(0, 20);
  const r = aiSideboard(decks[me].cards, decks[me].side, seen);
  console.log(`${me} vs ${opp}\n  IN:  ${count(r.swapsIn)}\n  OUT: ${count(r.swapsOut)}\n  main ${r.main.length}, side ${r.side.length}`);
}
