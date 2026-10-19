import { Game } from '../src/engine/game';
import { AIController } from '../src/engine/ai';
import { buildDeck, PRESETS } from '../src/engine/decks';
const [a, b, seed] = [process.argv[2], process.argv[3], +(process.argv[4] ?? 7)];
const da = await buildDeck(PRESETS[a]); const db = await buildDeck(PRESETS[b]);
const g = new Game([da.cards, db.cards], [new AIController(0, 0), new AIController(1, 0)], ['A', 'B'], 0, seed);
await g.run();
console.log(g.logs.map((l) => l.text).join('\n'));
process.exit(0);
