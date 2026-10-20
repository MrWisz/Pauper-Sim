import { useMemo, useState } from 'react';
import type { CardDef, PlayerId } from '../engine/types';
import { CardFace } from './CardView';

interface Props {
  game: number;
  wins: [number, number];
  /** current lists (start of this sideboarding) */
  main: CardDef[];
  side: CardDef[];
  /** original registered lists, for "Reset" */
  baseMain: CardDef[];
  baseSide: CardDef[];
  /** who chooses play/draw: the loser of the last game */
  chooser: PlayerId;
  aiSwaps: number;
  onDone: (main: CardDef[], side: CardDef[], first: PlayerId) => void;
  onQuit: () => void;
}

const typeOrder = (d: CardDef) => (d.types.includes('Creature') ? 0 : d.types.includes('Land') ? 2 : 1);

function group(cards: CardDef[]) {
  const m = new Map<string, { def: CardDef; n: number }>();
  for (const d of cards) {
    const e = m.get(d.name);
    if (e) e.n++;
    else m.set(d.name, { def: d, n: 1 });
  }
  return [...m.values()].sort((a, b) => typeOrder(a.def) - typeOrder(b.def) || a.def.cmc - b.def.cmc || a.def.name.localeCompare(b.def.name));
}

/** Between games of a best-of-3: move cards between main deck and sideboard, then pick play/draw. */
export function SideboardScreen({ game, wins, main: main0, side: side0, baseMain, baseSide, chooser, aiSwaps, onDone, onQuit }: Props) {
  const [main, setMain] = useState(main0);
  const [side, setSide] = useState(side0);
  const [first, setFirst] = useState<PlayerId>(0);
  const [hover, setHover] = useState<CardDef | null>(null);
  /** touch screens: tapping a row shows the card first, with buttons to move it */
  const isTouch = useMemo(() => window.matchMedia('(hover: none)').matches, []);
  const [picked, setPicked] = useState<{ name: string; fromMain: boolean } | null>(null);

  const mainGroups = useMemo(() => group(main), [main]);
  const sideGroups = useMemo(() => group(side), [side]);

  const move = (name: string, fromMain: boolean, copies = 1) => {
    let from = fromMain ? main : side;
    let to = fromMain ? side : main;
    for (let k = 0; k < copies; k++) {
      const i = from.findIndex((d) => d.name === name);
      if (i < 0) break;
      to = [...to, from[i]];
      from = [...from.slice(0, i), ...from.slice(i + 1)];
    }
    if (fromMain) {
      setMain(from);
      setSide(to);
    } else {
      setSide(from);
      setMain(to);
    }
  };

  const pickedGroup = picked ? (picked.fromMain ? mainGroups : sideGroups).find((x) => x.def.name === picked.name) : undefined;

  const changed = useMemo(() => {
    const count = (xs: CardDef[]) => xs.reduce<Record<string, number>>((m, d) => ((m[d.name] = (m[d.name] ?? 0) + 1), m), {});
    const a = count(baseMain);
    const b = count(main);
    let n = 0;
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) n += Math.max(0, (b[k] ?? 0) - (a[k] ?? 0));
    return n;
  }, [main, baseMain]);

  const tooSmall = main.length < 40;
  const firstPlayer: PlayerId = chooser === 0 ? first : 1;

  const column = (title: string, groups: { def: CardDef; n: number }[], count: number, fromMain: boolean) => (
    <div className="sb-col">
      <div className="sb-col-head">
        {title} <span className="sb-count">{count}</span>
      </div>
      <div className="sb-list">
        {groups.length === 0 && <div className="empty">Empty</div>}
        {groups.map(({ def, n }) => (
          <button
            key={def.name}
            className={`sb-row ${typeOrder(def) === 2 ? 'land' : ''}`}
            onClick={() => (isTouch ? setPicked({ name: def.name, fromMain }) : move(def.name, fromMain))}
            onMouseEnter={() => setHover(def)}
            onMouseLeave={() => setHover(null)}
            title={fromMain ? 'Move one copy to the sideboard' : 'Move one copy to the main deck'}
          >
            <span className="sb-n">{n}</span>
            <span className="sb-name">{def.name}</span>
            <span className="sb-cost">{def.manaCost.replace(/[{}]/g, '')}</span>
            <span className="sb-arrow">{fromMain ? '→' : '←'}</span>
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div className="sideboard-screen">
      <div className="sb-header">
        <div>
          <h1>Sideboarding — Game {game}</h1>
          <div className="sb-score">
            You {wins[0]} – {wins[1]} Computer
          </div>
        </div>
        <div className="sb-help">
          {isTouch ? 'Tap a card to see it and move it.' : 'Click a card to move one copy across.'} Your main deck must have at least 40 cards.
          {changed > 0 && <div className="sb-changed">{changed} card{changed > 1 ? 's' : ''} swapped from your original list.</div>}
          <div className="sb-ai">
            {aiSwaps > 0 ? `The computer sideboarded ${aiSwaps} card${aiSwaps > 1 ? 's' : ''}.` : 'The computer kept its main deck.'}
          </div>
        </div>
      </div>

      <div className="sb-cols">
        {column('Main deck', mainGroups, main.length, true)}
        {column('Sideboard', sideGroups, side.length, false)}
        <div className="sb-preview">{hover ? <CardFace def={hover} /> : <div className="sb-preview-empty">Hover a card to see it</div>}</div>
      </div>

      {picked && pickedGroup && (
        <div className="inspect-backdrop" onClick={() => setPicked(null)}>
          <div className="inspect-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="inspect-card">
              <CardFace def={pickedGroup.def} />
            </div>
            <div className="sb-sheet-count">
              {pickedGroup.n} in your {picked.fromMain ? 'main deck' : 'sideboard'}
            </div>
            <div className="inspect-actions">
              <button
                className="btn primary"
                onClick={() => {
                  move(picked.name, picked.fromMain);
                  if (pickedGroup.n <= 1) setPicked(null);
                }}
              >
                Move 1 to {picked.fromMain ? 'sideboard' : 'main deck'}
              </button>
              {pickedGroup.n > 1 && (
                <button
                  className="btn secondary"
                  onClick={() => {
                    move(picked.name, picked.fromMain, pickedGroup.n);
                    setPicked(null);
                  }}
                >
                  Move all {pickedGroup.n} to {picked.fromMain ? 'sideboard' : 'main deck'}
                </button>
              )}
              <button className="btn secondary" onClick={() => setPicked(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="sb-footer">
        <div className="sb-play">
          {chooser === 0 ? (
            <>
              <span>You lost the last game, so you choose:</span>
              <label>
                <input type="radio" checked={first === 0} onChange={() => setFirst(0)} /> Play first
              </label>
              <label>
                <input type="radio" checked={first === 1} onChange={() => setFirst(1)} /> Draw first
              </label>
            </>
          ) : (
            <span>The computer lost the last game and chose to play first.</span>
          )}
        </div>
        <div className="btns">
          <button className="btn secondary" onClick={onQuit}>
            Quit match
          </button>
          <button
            className="btn secondary"
            onClick={() => {
              setMain(baseMain);
              setSide(baseSide);
            }}
          >
            Reset to original
          </button>
          <button className="btn primary big" disabled={tooSmall} onClick={() => onDone(main, side, firstPlayer)}>
            {tooSmall ? 'Main deck needs 40+ cards' : `Start game ${game}`}
          </button>
        </div>
      </div>
    </div>
  );
}
