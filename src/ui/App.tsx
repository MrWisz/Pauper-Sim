import { useState } from 'react';
import { Game } from '../engine/game';
import { AIController } from '../engine/ai';
import { buildDeck, PRESETS, type BuiltDeck } from '../engine/decks';
import type { PlayerId } from '../engine/types';
import { HumanController } from './human';
import { Board } from './Board';

const LS = 'pauper-sim-setup-v1';

interface Setup {
  myDeck: string;
  aiDeck: string;
  first: 'random' | 'me' | 'ai';
  speed: number;
}

function loadSetup(): Setup {
  try {
    const s = JSON.parse(localStorage.getItem(LS) ?? 'null');
    if (s?.myDeck) return s;
  } catch {
    /* ignore */
  }
  return { myDeck: PRESETS['Mono Red Madness'], aiDeck: PRESETS['Dimir Faeries'], first: 'random', speed: 450 };
}

interface Running {
  id: number;
  g: Game;
  human: HumanController;
  decks: [BuiltDeck, BuiltDeck];
}

export function App() {
  const [setup, setSetup] = useState<Setup>(loadSetup);
  const [running, setRunning] = useState<Running | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const save = (s: Setup) => {
    setSetup(s);
    try {
      localStorage.setItem(LS, JSON.stringify(s));
    } catch {
      /* ignore */
    }
  };

  const start = (decks: [BuiltDeck, BuiltDeck]) => {
    const human = new HumanController(0);
    const ai = new AIController(1, setup.speed);
    const first: PlayerId = setup.first === 'me' ? 0 : setup.first === 'ai' ? 1 : Math.random() < 0.5 ? 0 : 1;
    const g = new Game([decks[0].cards, decks[1].cards], [human, ai], ['You', 'Computer'], first);
    g.paceMs = setup.speed; // pacing so you can follow what happens
    setRunning({ id: Date.now(), g, human, decks });
    (window as any).__game = g; // handy for debugging from the console
    g.run().catch((e) => setError(String(e?.stack ?? e)));
  };

  const prepare = async () => {
    setLoading(true);
    setError('');
    try {
      const mine = await buildDeck(setup.myDeck);
      const theirs = await buildDeck(setup.aiDeck);
      const w: string[] = [];
      for (const [label, d] of [
        ['Your deck', mine],
        ["Computer's deck", theirs],
      ] as const) {
        if (d.cards.length < 40) w.push(`${label} only has ${d.cards.length} cards.`);
        if (d.notFound.length) w.push(`${label}: not found on Scryfall (skipped): ${d.notFound.join(', ')}`);
        if (d.unimplemented.length)
          w.push(`${label}: not scripted yet — these work as vanilla cards (type, P/T, keywords, mana only): ${d.unimplemented.join(', ')}`);
      }
      setWarnings(w);
      if (!mine.cards.length || !theirs.cards.length) {
        setError('Both decks need at least one card.');
        return;
      }
      start([mine, theirs]);
    } catch (e) {
      setError('Could not build decks: ' + (e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  if (running) {
    return (
      <>
        <Board
          key={running.id}
          g={running.g}
          human={running.human}
          onExit={() => {
            if (running.g.winner === undefined) running.g.concede(0);
            running.human.respond(null);
            setRunning(null);
          }}
          onRematch={() => start(running.decks)}
        />
        {warnings.length > 0 && (
          <div className="warn-toast" onClick={() => setWarnings([])}>
            {warnings.map((w) => (
              <div key={w}>⚠ {w}</div>
            ))}
            <small>click to dismiss</small>
          </div>
        )}
        {error && <div className="error-toast">{error}</div>}
      </>
    );
  }

  const deckEditor = (label: string, key: 'myDeck' | 'aiDeck') => (
    <div className="deck-col">
      <div className="deck-head">
        <h2>{label}</h2>
        <select
          value=""
          onChange={(e) => {
            if (e.target.value) save({ ...setup, [key]: PRESETS[e.target.value] });
          }}
        >
          <option value="">Load a meta deck…</option>
          {Object.keys(PRESETS).map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </div>
      <textarea value={setup[key]} onChange={(e) => save({ ...setup, [key]: e.target.value })} spellCheck={false} />
      <div className="deck-count">{countCards(setup[key])} cards in main deck (sideboard after a blank line is ignored)</div>
    </div>
  );

  return (
    <div className="setup">
      <h1>Pauper Sim</h1>
      <p className="tagline">Paste or pick decklists, then play against the computer. One card per line, like “4 Lightning Bolt”.</p>
      <div className="deck-cols">
        {deckEditor('Your deck', 'myDeck')}
        {deckEditor("Computer's deck", 'aiDeck')}
      </div>
      <div className="setup-opts">
        <label>
          Who plays first
          <select value={setup.first} onChange={(e) => save({ ...setup, first: e.target.value as Setup['first'] })}>
            <option value="random">Random</option>
            <option value="me">Me</option>
            <option value="ai">Computer</option>
          </select>
        </label>
        <label>
          Game speed
          <select value={setup.speed} onChange={(e) => save({ ...setup, speed: +e.target.value })}>
            <option value={900}>Slow</option>
            <option value={450}>Normal</option>
            <option value={150}>Fast</option>
          </select>
        </label>
        <button className="btn primary big" onClick={prepare} disabled={loading}>
          {loading ? 'Loading cards…' : 'Start game'}
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="help">
        <h3>How to play</h3>
        <ul>
          <li>Glowing cards can be played. Click a card in hand to cast it, or click a permanent to use its abilities.</li>
          <li>Mana is paid automatically when you cast. You can also click lands to tap them for mana first; floating mana is used first.</li>
          <li>Triggers, the stack, combat damage, state-based actions and turn steps are handled for you.</li>
          <li>Attacking: click creatures to toggle them, then press Attack. Blocking: click your creature, then the attacker.</li>
          <li>Pass Turn skips your priority until the turn ends, but stops if the opponent casts something. Full control stops at every priority.</li>
          <li>Hover any card to zoom in. Click a graveyard or exile pile to look inside (and to cast flashback or plotted cards).</li>
        </ul>
      </div>
    </div>
  );
}

function countCards(text: string) {
  let n = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      if (n) break;
      continue;
    }
    const m = line.trim().match(/^(\d+)/);
    n += m ? +m[1] : 1;
  }
  return n;
}
