import { useRef, useState } from 'react';
import { Game } from '../engine/game';
import { AIController } from '../engine/ai';
import { buildDeck, PRESETS, type BuiltDeck } from '../engine/decks';
import { aiSideboard } from '../engine/sideboard';
import type { CardDef, PlayerId } from '../engine/types';
import { HumanController } from './human';
import { Board, type MatchView } from './Board';
import { SideboardScreen } from './Sideboard';
import { AboutFooter } from './About';

const LS = 'pauper-sim-setup-v1';

interface Setup {
  myDeck: string;
  aiDeck: string;
  first: 'random' | 'me' | 'ai';
  speed: number;
  format: 'bo1' | 'bo3';
}

function loadSetup(): Setup {
  const defaults: Setup = { myDeck: PRESETS['Mono Red Madness'], aiDeck: PRESETS['Dimir Faeries'], first: 'random', speed: 450, format: 'bo3' };
  try {
    const s = JSON.parse(localStorage.getItem(LS) ?? 'null');
    if (s?.myDeck) return { ...defaults, ...s };
  } catch {
    /* ignore */
  }
  return defaults;
}

interface Lists {
  main: CardDef[];
  side: CardDef[];
}

/** A best-of-1 or best-of-3 match between you (player 0) and the computer (player 1). */
interface Match {
  bo3: boolean;
  base: [BuiltDeck, BuiltDeck];
  lists: [Lists, Lists];
  wins: [number, number];
  game: number;
  /** loser of the last finished game (chooses play/draw); null after a draw */
  lastLoser: PlayerId | null;
  /** your cards the computer has seen so far (it sideboards against these) */
  seen: CardDef[];
  aiSwaps: number;
}

interface Running {
  id: number;
  g: Game;
  human: HumanController;
}

const MAX_GAMES = 5; // draws don't count, but don't loop forever

export function App() {
  const [setup, setSetup] = useState<Setup>(loadSetup);
  const [match, setMatch] = useState<Match | null>(null);
  const [running, setRunning] = useState<Running | null>(null);
  const [sideboarding, setSideboarding] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const recorded = useRef(new Set<number>());

  const save = (s: Setup) => {
    setSetup(s);
    try {
      localStorage.setItem(LS, JSON.stringify(s));
    } catch {
      /* ignore */
    }
  };

  const randomFirst = (): PlayerId => (setup.first === 'me' ? 0 : setup.first === 'ai' ? 1 : Math.random() < 0.5 ? 0 : 1);

  const startGame = (m: Match, first: PlayerId) => {
    const human = new HumanController(0);
    const ai = new AIController(1, setup.speed);
    const g = new Game([m.lists[0].main, m.lists[1].main], [human, ai], ['You', 'Computer'], first);
    g.paceMs = setup.speed; // pacing so you can follow what happens
    const id = Date.now();
    setMatch(m);
    setSideboarding(false);
    setRunning({ id, g, human });
    if (import.meta.env.DEV) (window as any).__game = g; // handy for debugging from the console
    g.run()
      .then(() => recordResult(id, g))
      .catch((e) => setError(String(e?.stack ?? e)));
  };

  /** Called once when a game ends: update the score and remember which of your cards the computer saw. */
  const recordResult = (id: number, g: Game) => {
    if (recorded.current.has(id) || g.winner === undefined) return;
    recorded.current.add(id);
    const shown: CardDef[] = [];
    for (const c of g.cards.values()) {
      if (c.owner !== 0 || c.def.isToken) continue;
      if (c.zone === 'battlefield' || c.zone === 'graveyard' || c.zone === 'exile' || c.zone === 'stack') shown.push(c.def);
    }
    const winner = g.winner;
    setMatch((m) => {
      if (!m) return m;
      const wins: [number, number] = [...m.wins];
      if (winner !== null) wins[winner]++;
      return {
        ...m,
        wins,
        lastLoser: winner === null ? null : g.opp(winner),
        seen: [...m.seen, ...shown],
      };
    });
  };

  const newMatch = (base: [BuiltDeck, BuiltDeck]) => {
    recorded.current.clear();
    const m: Match = {
      bo3: setup.format === 'bo3',
      base,
      lists: [
        { main: base[0].cards, side: base[0].side },
        { main: base[1].cards, side: base[1].side },
      ],
      wins: [0, 0],
      game: 1,
      lastLoser: null,
      seen: [],
      aiSwaps: 0,
    };
    startGame(m, randomFirst());
  };

  const matchOver = (m: Match) => !m.bo3 || Math.max(...m.wins) >= 2 || m.game >= MAX_GAMES;

  /** After a game of an unfinished best-of-3: the computer sideboards, then you do. */
  const toSideboarding = () => {
    if (!match) return;
    const ai = aiSideboard(match.base[1].cards, match.base[1].side, match.seen);
    setMatch({ ...match, lists: [match.lists[0], { main: ai.main, side: ai.side }], aiSwaps: ai.swapsIn.length });
    setRunning(null);
    setSideboarding(true);
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
      newMatch([mine, theirs]);
    } catch (e) {
      setError('Could not build decks: ' + (e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const quit = () => {
    if (running && running.g.winner === undefined) {
      running.g.concede(0);
      running.human.respond(null);
    }
    setRunning(null);
    setSideboarding(false);
    setMatch(null);
  };

  if (match && sideboarding) {
    // the loser of the last game chooses; after a draw you choose
    const chooser: PlayerId = match.lastLoser ?? 0;
    return (
      <SideboardScreen
        game={match.game + 1}
        wins={match.wins}
        main={match.lists[0].main}
        side={match.lists[0].side}
        baseMain={match.base[0].cards}
        baseSide={match.base[0].side}
        chooser={chooser}
        aiSwaps={match.aiSwaps}
        onQuit={quit}
        onDone={(main, side, first) => startGame({ ...match, lists: [{ main, side }, match.lists[1]], game: match.game + 1 }, first)}
      />
    );
  }

  if (running && match) {
    const view: MatchView = { bo3: match.bo3, game: match.game, wins: match.wins, over: matchOver(match) };
    return (
      <>
        <Board
          key={running.id}
          g={running.g}
          human={running.human}
          match={view}
          onExit={quit}
          onRematch={() => newMatch(match.base)}
          onNextGame={toSideboarding}
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

  const deckEditor = (label: string, key: 'myDeck' | 'aiDeck') => {
    const counts = countCards(setup[key]);
    return (
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
        <div className="deck-count">
          {counts.main} main deck · {counts.side} sideboard (sideboard goes after a blank line or a “Sideboard” line)
        </div>
      </div>
    );
  };

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
          Match
          <select value={setup.format} onChange={(e) => save({ ...setup, format: e.target.value as Setup['format'] })}>
            <option value="bo3">Best of 3 (with sideboarding)</option>
            <option value="bo1">Best of 1</option>
          </select>
        </label>
        <label>
          Who plays first {setup.format === 'bo3' ? '(game 1)' : ''}
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
          {loading ? 'Loading cards…' : setup.format === 'bo3' ? 'Start match' : 'Start game'}
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
          <li>
            Best of 3: after each game you can swap cards between your main deck and sideboard. The loser of a game chooses who plays
            first next; the computer sideboards against the cards it has seen from you.
          </li>
        </ul>
      </div>
      <AboutFooter />
    </div>
  );
}

function countCards(text: string) {
  let main = 0;
  let side = 0;
  let inSide = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      if (main) inSide = true;
      continue;
    }
    if (/^side ?board:?$/i.test(line)) {
      inSide = true;
      continue;
    }
    if (/^(deck|main ?deck)$/i.test(line)) continue;
    const m = line.match(/^(\d+)/);
    const n = m ? +m[1] : 1;
    if (inSide) side += n;
    else main += n;
  }
  return { main, side };
}
