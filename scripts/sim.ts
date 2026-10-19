// Headless AI-vs-AI games to smoke-test the engine: npx tsx scripts/sim.ts [games]
import { Game } from '../src/engine/game';
import { AIController } from '../src/engine/ai';
import { buildDeck, PRESETS } from '../src/engine/decks';

const N = parseInt(process.argv[2] ?? '20', 10);
const names = Object.keys(PRESETS);
const results: Record<string, { w: number; l: number; d: number }> = {};
let errors = 0;
let totalTurns = 0;
for (let i = 0; i < N; i++) {
  const a = names[i % names.length];
  const b = names[(i + 1 + Math.floor(i / names.length)) % names.length];
  const da = await buildDeck(PRESETS[a]);
  const db = await buildDeck(PRESETS[b]);
  if (i === 0) for (const d of [da, db]) if (d.unimplemented.length || d.notFound.length) console.log('Missing', d.unimplemented, d.notFound);
  const g = new Game([da.cards, db.cards], [new AIController(0, 0), new AIController(1, 0)], [a, b], (i % 2) as 0 | 1, 1000 + i);
  let finished = false;
  const timeout = new Promise<void>((r) => setTimeout(r, 20000));
  try {
    await Promise.race([
      g.run().then(() => (finished = true)),
      timeout,
    ]);
  } catch (e) {
    errors++;
    console.log(`Game ${i} ${a} vs ${b}: ERROR`, (e as Error).stack?.split('\n').slice(0, 6).join('\n'));
    console.log(g.logs.slice(-15).map((l) => l.text).join('\n'));
    continue;
  }
  if (!finished || g.turn > 60) {
    console.log(`Game ${i} ${a} vs ${b}: DID NOT FINISH (turn ${g.turn}, step ${g.step})`);
    console.log(g.logs.slice(-25).map((l) => l.text).join('\n'));
    errors++;
    continue;
  }
  totalTurns += g.turn;
  const w = g.winner;
  for (const [n, pid] of [[a, 0], [b, 1]] as const) {
    results[n] ??= { w: 0, l: 0, d: 0 };
    if (w === null) results[n].d++;
    else if (w === pid) results[n].w++;
    else results[n].l++;
  }
  console.log(`Game ${i}: ${a} vs ${b} -> ${w === null ? 'draw' : w === 0 ? a : b} (turn ${g.turn}, life ${g.players[0].life}-${g.players[1].life})`);
}
console.log(results, 'errors', errors, 'avg turns', (totalTurns / Math.max(1, N - errors)).toFixed(1));
process.exit(0);
