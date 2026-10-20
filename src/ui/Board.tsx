import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Game, STEP_LABEL, targetKey } from '../engine/game';
import type { Action, CardInstance, ChoiceRequest, ManaColor, PlayerId, Step, Target } from '../engine/types';
import { CardBack, CardFace, CardView } from './CardView';
import type { HumanController } from './human';
import { Modals } from './Modals';
import { FxLayer } from './FxLayer';

const STEPS: Step[] = [
  'upkeep',
  'draw',
  'main1',
  'beginCombat',
  'declareAttackers',
  'declareBlockers',
  'combatDamage',
  'endCombat',
  'main2',
  'end',
];

const MANA_ICON: Record<ManaColor, string> = { W: '☀', U: '💧', B: '💀', R: '🔥', G: '🌳', C: '◇' };

interface MenuItem {
  label: string;
  run: () => void;
}

/** Match context for the board: score and whether the match is decided. */
export interface MatchView {
  bo3: boolean;
  game: number;
  /** wins so far, including this game once it has ended */
  wins: [number, number];
  over: boolean;
}

export function Board({
  g,
  human,
  match,
  onExit,
  onRematch,
  onNextGame,
}: {
  g: Game;
  human: HumanController;
  match?: MatchView;
  onExit: () => void;
  onRematch: () => void;
  onNextGame?: () => void;
}) {
  useSyncExternalStore(
    (fn) => g.subscribe(fn),
    () => g.version,
  );
  const me = human.pid;
  const opp = g.opp(me);
  const req: ChoiceRequest | null = human.waiting ? human.req : null;

  const [hover, setHover] = useState<CardInstance | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; title: string; items: MenuItem[] } | null>(null);
  const [picked, setPicked] = useState<Target[]>([]);
  const [attackSel, setAttackSel] = useState<Set<number>>(new Set());
  const [blocks, setBlocks] = useState<Record<number, number>>({});
  const [selBlocker, setSelBlocker] = useState<number | null>(null);
  const [viewer, setViewer] = useState<{ title: string; pid: PlayerId; zone: 'graveyard' | 'exile' } | null>(null);
  /** touch screens have no hover: tap shows a card sheet, long-press zooms */
  const isTouch = useMemo(() => window.matchMedia('(hover: none)').matches, []);
  const narrow = useMemo(() => window.matchMedia('(max-width: 760px), (max-height: 520px)').matches, []);
  const [showLog, setShowLog] = useState(!narrow);
  const [topOpen, setTopOpen] = useState(false);
  const [inspect, setInspect] = useState<{ card: CardInstance; items: MenuItem[] } | null>(null);
  /** after the game ends: hide the result overlay to look at the final board */
  const [viewBoard, setViewBoard] = useState(false);
  const [, force] = useState(0);
  const logRef = useRef<HTMLDivElement>(null);

  // reset transient selection state whenever a new request arrives
  useEffect(() => {
    setPicked([]);
    setMenu(null);
    setInspect(null);
    setSelBlocker(null);
    setBlocks({});
    if (req?.type === 'attackers') setAttackSel(new Set());
  }, [req]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [g.logs.length, showLog]);

  const respond = (v: any) => {
    setMenu(null);
    setViewer(null);
    human.respond(v);
  };

  // ───────── derived highlights ─────────
  const targetKeys = useMemo(() => {
    if (req?.type !== 'targets') return new Set<string>();
    return new Set(req.candidates.map(targetKey));
  }, [req]);
  const pickedKeys = new Set(picked.map(targetKey));

  const playable = useMemo(() => {
    const s = new Set<number>();
    if (req?.type !== 'priority') return s;
    for (const a of g.legalActions(me)) if (a.type !== 'pass') s.add(a.cardId);
    return s;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req, g.version]);

  const highlightFor = (c: CardInstance): 'playable' | 'target' | 'selected' | 'attacking' | 'blocking' | null => {
    if (req?.type === 'targets') {
      const k = targetKey({ kind: 'card', id: c.id });
      if (pickedKeys.has(k)) return 'selected';
      if (targetKeys.has(k)) return 'target';
      return null;
    }
    if (req?.type === 'attackers') {
      if (attackSel.has(c.id)) return 'attacking';
      if (req.candidates.includes(c)) return 'playable';
      return null;
    }
    if (req?.type === 'blockers') {
      if (selBlocker === c.id) return 'selected';
      if (blocks[c.id] !== undefined) return 'blocking';
      if (req.candidates.includes(c) && c.controller === me) return 'playable';
      if (selBlocker !== null && req.attackers.includes(c)) return 'target';
      return null;
    }
    if (req?.type === 'priority' && playable.has(c.id)) return 'playable';
    return null;
  };

  // ───────── click handling ─────────
  const pickTarget = (t: Target) => {
    if (req?.type !== 'targets') return;
    const k = targetKey(t);
    if (!targetKeys.has(k)) return;
    const max = req.spec.max ?? 1;
    if (max === 1) return respond([t]);
    const next = pickedKeys.has(k) ? picked.filter((x) => targetKey(x) !== k) : [...picked, t];
    if (next.length >= max) return respond(next);
    setPicked(next);
  };

  const openMenu = (e: React.MouseEvent, title: string, items: MenuItem[]) => {
    if (!items.length) return;
    if (items.length === 1) return items[0].run();
    setMenu({ x: e.clientX, y: e.clientY, title, items });
  };

  const actionItems = (c: CardInstance): MenuItem[] => {
    const items: MenuItem[] = [];
    const act = (a: Action) => () => respond(a);
    if (g.canPlayLand(me, c)) items.push({ label: `Play ${c.def.name}`, run: act({ type: 'playLand', cardId: c.id }) });
    for (const o of g.castOptions(me, c)) items.push({ label: o.label, run: act({ type: 'cast', cardId: c.id, method: o.method, altIndex: o.altIndex }) });
    (c.def.activated ?? []).forEach((a, i) => {
      if (a.produces) return;
      if (g.canActivate(me, c, i)) items.push({ label: a.label ?? a.text, run: act({ type: 'activate', cardId: c.id, index: i }) });
    });
    return items;
  };

  const manaItems = (c: CardInstance): MenuItem[] => {
    const items: MenuItem[] = [];
    for (const { a, i } of g.manaAbilities(me, c)) {
      g.produceOptions(c, i).forEach((opt, oi) => {
        items.push({
          label: `${a.cost.mana ? a.cost.mana + ', ' : ''}Tap: add ${opt.map((m) => MANA_ICON[m] + m).join('')}`,
          run: () => {
            g.manualMana(me, c, i, oi);
            setMenu(null);
            force((x) => x + 1);
          },
        });
      });
    }
    return items;
  };

  const onCardClick = (c: CardInstance, e: React.MouseEvent) => {
    if (!req) return;
    switch (req.type) {
      case 'targets':
        return pickTarget({ kind: 'card', id: c.id });
      case 'attackers':
        if (!req.candidates.includes(c)) return;
        setAttackSel((s) => {
          const n = new Set(s);
          n.has(c.id) ? n.delete(c.id) : n.add(c.id);
          return n;
        });
        return;
      case 'blockers': {
        if (c.controller === me && req.candidates.includes(c)) {
          if (blocks[c.id] !== undefined) {
            const n = { ...blocks };
            delete n[c.id];
            setBlocks(n);
            return;
          }
          setSelBlocker(selBlocker === c.id ? null : c.id);
          return;
        }
        if (selBlocker !== null && req.attackers.includes(c)) {
          const b = g.card(selBlocker)!;
          if (!g.canBlock(b, c)) return;
          setBlocks({ ...blocks, [selBlocker]: c.id });
          setSelBlocker(null);
        }
        return;
      }
      case 'priority': {
        if (c.zone === 'battlefield' && c.controller === me) {
          const items = [...actionItems(c), ...manaItems(c)];
          return openMenu(e, c.def.name, items);
        }
        if (c.owner === me && (c.zone === 'hand' || c.zone === 'graveyard' || c.zone === 'exile')) {
          return openMenu(e, c.def.name, actionItems(c));
        }
        return;
      }
    }
  };

  /** what you could do with a card right now (same options as the desktop click menu) */
  const itemsFor = (c: CardInstance): MenuItem[] => {
    if (req?.type !== 'priority') return [];
    if (c.zone === 'battlefield' && c.controller === me) return [...actionItems(c), ...manaItems(c)];
    if (c.owner === me && (c.zone === 'hand' || c.zone === 'graveyard' || c.zone === 'exile')) return actionItems(c);
    return [];
  };
  /** big view of a card; on touch screens it also lists the card's actions */
  const openInspect = (c: CardInstance, withActions: boolean) => {
    const items = withActions ? itemsFor(c) : [];
    setInspect({
      card: c,
      items: items.map((it) => ({
        label: it.label,
        run: () => {
          setInspect(null);
          it.run();
        },
      })),
    });
  };
  const inspectOnly = (c: CardInstance) => openInspect(c, false);
  /** touch: while you have priority (or are waiting), tapping a card opens its sheet instead of acting right away */
  const handleCardClick = (c: CardInstance, e: React.MouseEvent) => {
    if (isTouch && (!req || req.type === 'priority')) return openInspect(c, true);
    onCardClick(c, e);
  };

  // ───────── end turn (available any time during your turn) ─────────
  const endTurn = () => {
    human.passTurn = g.turn;
    setAttackSel(new Set());
    if (!human.waiting || !human.req) return;
    if (human.req.type === 'priority') respond({ type: 'pass' });
    else if (human.req.type === 'attackers') respond([]);
    else if (human.req.type === 'targets' && human.req.cancellable) respond(null);
  };

  // ───────── game over / match result ─────────
  const resultText = g.winner === null ? 'Draw' : g.winner === me ? 'Victory' : 'Defeat';
  let matchLine: string | null = null;
  let next = { label: 'Rematch', run: onRematch };
  if (match?.bo3) {
    const [w0, w1] = match.wins;
    if (match.over) {
      matchLine = w0 === w1 ? `Match drawn ${w0}–${w1}` : `Match ${w0 > w1 ? 'won' : 'lost'} ${w0}–${w1}`;
      next = { label: 'New match', run: onRematch };
    } else {
      matchLine = `Match score: You ${w0} – ${w1} Computer`;
      next = { label: 'Sideboard & next game', run: onNextGame ?? onRematch };
    }
  }

  // ───────── main button ─────────
  let primary: { label: string; run: () => void } | null = null;
  let secondary: { label: string; run: () => void }[] = [];
  let prompt = '';
  if (g.winner !== undefined) prompt = g.winner === null ? 'Draw!' : g.winner === me ? 'You win!' : 'You lose.';
  else if (!req) {
    prompt = g.pending && g.pending.player === opp ? `${g.players[opp].name} is thinking…` : '';
  } else if (req.type === 'priority') {
    const top = g.stack[g.stack.length - 1];
    const myTurn = g.active === me;
    if (top) {
      prompt =
        top.controller === me
          ? 'Your spell is on the stack.'
          : top.kind === 'ability'
            ? `${top.card.def.name}'s ability is on the stack. Respond?`
            : `${g.players[opp].name} cast ${top.card.def.name}. Respond?`;
      primary = { label: top.controller === me ? 'Resolve' : 'Pass', run: () => respond({ type: 'pass' }) };
    } else {
      prompt = myTurn ? `Your ${STEP_LABEL[g.step]}` : `Opponent's ${STEP_LABEL[g.step]}`;
      let label = 'Pass';
      if (myTurn && g.step === 'main1') label = g.creatures(me).some((c) => g.canAttack(c)) ? 'To Combat' : 'Next';
      if (myTurn && g.step === 'main2') label = 'Next';
      primary = { label, run: () => respond({ type: 'pass' }) };
    }
    if (!myTurn)
      secondary.push({
        label: 'Pass Turn',
        run: () => {
          human.passTurn = g.turn;
          respond({ type: 'pass' });
        },
      });
  } else if (req.type === 'targets') {
    const src = req.source.def.name;
    prompt = `${src}: ${req.spec.prompt}`;
    const min = req.spec.min ?? 1;
    if ((req.spec.max ?? 1) > 1 && picked.length >= min) primary = { label: `Done (${picked.length})`, run: () => respond(picked) };
    if (req.cancellable) secondary.push({ label: 'Cancel', run: () => respond(null) });
  } else if (req.type === 'attackers') {
    prompt = 'Choose attackers';
    primary = { label: attackSel.size ? `Attack (${attackSel.size})` : 'No Attacks', run: () => respond([...attackSel]) };
    secondary.push({ label: 'All Attack', run: () => setAttackSel(new Set(req.candidates.map((c) => c.id))) });
  } else if (req.type === 'blockers') {
    prompt = selBlocker !== null ? 'Now click the attacker to block' : 'Choose blockers: click your creature, then an attacker';
    const n = Object.keys(blocks).length;
    primary = { label: n ? `Confirm Blocks (${n})` : 'No Blocks', run: () => respond(blocks) };
  }

  const graveyardTargets = req?.type === 'targets' && req.spec.kind === 'graveyardCard';

  const playerHL = (pid: PlayerId) => {
    if (req?.type !== 'targets') return '';
    const k = targetKey({ kind: 'player', pid });
    if (pickedKeys.has(k)) return 'hl-selected';
    return targetKeys.has(k) ? 'hl-target' : '';
  };

  const pool = g.players[me].pool;
  const poolEntries = (Object.entries(pool) as [ManaColor, number][]).filter(([, n]) => n > 0);

  const renderRow = (cards: CardInstance[], cls: string) => (
    <div className={`row ${cls}`}>
      {cards.map((c) => {
        const atts = g.attachments(c);
        const view = <CardView key={c.id} g={g} card={c} highlight={highlightFor(c)} onClick={handleCardClick} onHover={setHover} onInspect={inspectOnly} badge={blockBadge(c)} />;
        if (!atts.length) return view;
        // Auras / Equipment peek out above the permanent they are attached to
        return (
          <div key={c.id} className="attach-group" style={{ paddingTop: atts.length * 18 }}>
            {atts.map((a, i) => (
              <div key={a.id} className="attached" style={{ top: i * 18 }}>
                <CardView g={g} card={a} highlight={highlightFor(a)} onClick={handleCardClick} onHover={setHover} onInspect={inspectOnly} />
              </div>
            ))}
            <div className="attach-host">{view}</div>
          </div>
        );
      })}
    </div>
  );

  const blockBadge = (c: CardInstance) => {
    if (req?.type === 'blockers' && blocks[c.id] !== undefined) return '→ ' + g.card(blocks[c.id])!.def.name;
    return undefined;
  };

  const split = (pid: PlayerId) => {
    // attached permanents are drawn with their host
    const perms = g.permanents(pid).filter((c) => {
      const host = c.attachedTo !== null ? g.card(c.attachedTo) : undefined;
      return !host || host.zone !== 'battlefield';
    });
    const creatures = perms.filter((c) => g.isCreature(c));
    const lands = perms.filter((c) => g.isLand(c) && !g.isCreature(c));
    const others = perms.filter((c) => !g.isCreature(c) && !g.isLand(c));
    return { creatures, lands, others };
  };
  const mine = split(me);
  const theirs = split(opp);

  const zonePile = (pid: PlayerId, zone: 'graveyard' | 'exile', label: string) => {
    const cards = g.players[pid][zone];
    const top = cards[cards.length - 1];
    const castable = pid === me && cards.some((c) => playable.has(c.id));
    return (
      <div
        className={`pile ${castable ? 'hl-playable' : ''} ${graveyardTargets && cards.some((c) => targetKeys.has(targetKey({ kind: 'card', id: c.id }))) ? 'hl-target' : ''}`}
        onClick={() => setViewer({ title: `${g.players[pid].name} — ${label}`, pid, zone })}
        title={`${label} (${cards.length})`}
      >
        {top ? <CardFace def={top.def} className="pile-img" /> : <div className="pile-empty">{label}</div>}
        <span className="pile-count">{cards.length}</span>
      </div>
    );
  };

  const playerPanel = (pid: PlayerId) => {
    const p = g.players[pid];
    return (
      <div className={`player-panel ${pid === me ? 'me' : 'opp'}`}>
        <div
          data-pid={pid}
          className={`avatar ${playerHL(pid)} ${g.priority === pid && g.winner === undefined ? 'has-priority' : ''} ${g.active === pid ? 'active' : ''}`}
          onClick={() => pickTarget({ kind: 'player', pid })}
        >
          {g.monarch === pid && <div className="crown" title="The Monarch">👑</div>}
          <div className="life">{p.life}</div>
          <div className="pname">{p.name}</div>
        </div>
        <div className="piles">
          <div className="pile lib" title="Library">
            <CardBack small />
            <span className="pile-count">{p.library.length}</span>
          </div>
          {zonePile(pid, 'graveyard', 'Graveyard')}
          {zonePile(pid, 'exile', 'Exile')}
        </div>
      </div>
    );
  };

  return (
    <div className="board" onClick={() => setMenu(null)}>
      {/* Opponent */}
      <div className="opp-top">
        {playerPanel(opp)}
        <div className="opp-hand">
          {g.players[opp].hand.map((c) => (
            <CardBack key={c.id} small />
          ))}
        </div>
        <div className="top-buttons">
          {match?.bo3 && (
            <span className="match-badge" title="Best of 3">
              Game {match.game} · You {match.wins[0]} – {match.wins[1]} CPU
            </span>
          )}
          <button className="tb-toggle" onClick={() => setTopOpen((o) => !o)} aria-label="Menu">
            ☰
          </button>
          <div className={`tb-items ${topOpen ? 'open' : ''}`} onClick={() => setTopOpen(false)}>
          <label className="toggle" title="Stop at every priority, like Arena's full control" onClick={(e) => e.stopPropagation()}>
            <input
              type="checkbox"
              checked={human.fullControl}
              onChange={(e) => {
                human.fullControl = e.target.checked;
                force((x) => x + 1);
              }}
            />
            Full control
          </label>
          <button onClick={() => setShowLog((s) => !s)}>{showLog ? 'Hide log' : 'Show log'}</button>
          <button
            onClick={() => {
              if (g.winner === undefined && confirm('Concede this game?')) {
                g.concede(me);
                human.respond(null);
              }
            }}
          >
            Concede
          </button>
          <button onClick={onExit}>Exit</button>
          </div>
        </div>
      </div>

      <div className="battlefield">
        <div className="side opp-side">
          {renderRow([...theirs.lands, ...theirs.others], 'lands')}
          {renderRow(theirs.creatures, 'creatures')}
        </div>

        <div className="midline">
          <div className="phases">
            <span className={`turn-ind ${g.active === me ? 'mine' : 'theirs'}`}>
              T{g.turn} · {g.active === me ? 'Your turn' : "Opponent's turn"}
            </span>
            {STEPS.map((s) => (
              <span key={s} className={`phase ${g.step === s ? 'current' : ''}`}>
                {STEP_LABEL[s]}
              </span>
            ))}
          </div>
        </div>

        <div className="side my-side">
          {renderRow(mine.creatures, 'creatures')}
          {renderRow([...mine.lands, ...mine.others], 'lands')}
        </div>

        {/* Stack */}
        {g.stack.length > 0 && (
          <div className="stack-panel">
            <div className="stack-title">Stack</div>
            {[...g.stack].reverse().map((s) => {
              const k = targetKey({ kind: 'stack', id: s.id });
              const hl = req?.type === 'targets' ? (targetKeys.has(k) ? 'hl-target' : '') : '';
              return (
                <div
                  key={s.id}
                  className={`stack-item ${s.controller === me ? 'mine' : 'theirs'} ${hl}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    pickTarget({ kind: 'stack', id: s.id });
                  }}
                  onMouseEnter={() => setHover(s.card)}
                  onMouseLeave={() => setHover(null)}
                >
                  <div className="stack-art">
                    <CardFace def={s.card.def} />
                  </div>
                  <div className="stack-text">
                    <b>{s.card.def.name}</b>
                    {s.kind === 'ability' && <span className="ability-tag">ability</span>}
                    <div>{s.kind === 'ability' ? s.text : s.text !== s.card.def.name ? s.text : ''}</div>
                    {s.targets.flat().length > 0 && <div className="stack-targets">→ {s.targets.flat().map((t) => g.targetName(t)).join(', ')}</div>}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Log */}
        {showLog && (
          <div className="log" ref={logRef} onClick={() => narrow && setShowLog(false)} title={narrow ? 'Tap to close' : undefined}>
            {g.logs.slice(-150).map((l) => (
              <div key={l.id} className={`log-line ${l.player === me ? 'mine' : l.player === opp ? 'theirs' : 'sys'}`}>
                {l.text}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Me */}
      <div className="me-bottom">
        {playerPanel(me)}
        <div className="hand" style={narrow ? handFit(g.players[me].hand.length) : undefined}>
          {g.players[me].hand.map((c, i, arr) => (
            <div key={c.id} className="hand-slot" style={{
                zIndex: i,
                transform: `rotate(${(i - (arr.length - 1) / 2) * (arr.length > 9 ? 1.2 : 2.2)}deg)`,
                // squeeze big hands so they always fit on screen
                margin: `0 ${arr.length > 7 ? Math.max(-48, -14 - (arr.length - 7) * 5) : -14}px`,
              }}>
              <CardView g={g} card={c} size="hand" highlight={highlightFor(c)} onClick={handleCardClick} onHover={setHover} onInspect={inspectOnly} />
            </div>
          ))}
        </div>
        <div className="controls">
          {poolEntries.length > 0 && (
            <div className="pool">
              {poolEntries.map(([m, n]) => (
                <span key={m} className={`mana mana-${m}`}>
                  {MANA_ICON[m]}×{n}
                </span>
              ))}
            </div>
          )}
          <div className="prompt">{prompt}</div>
          <div className="btns">
            {secondary.map((b) => (
              <button key={b.label} className="btn secondary" onClick={b.run}>
                {b.label}
              </button>
            ))}
            {primary && (
              <button className="btn primary" onClick={primary.run}>
                {primary.label}
              </button>
            )}
          </div>
        </div>
      </div>

      <FxLayer g={g} me={me} />

      {g.active === me && g.winner === undefined && g.turn > 0 && (
        <button className="end-turn-btn" onClick={endTurn} title="Skip the rest of your turn (you'll still be asked about blocks and discards)">
          End Turn ⏭
        </button>
      )}

      {hover && (
        <div className="preview">
          <CardFace def={hover.def} />
          {!hover.def.implemented && <div className="preview-warn">Not scripted: only type, P/T, keywords and mana abilities work.</div>}
        </div>
      )}

      {menu && (
        <div className="menu" style={{ left: Math.min(menu.x, window.innerWidth - 260), top: Math.min(menu.y, window.innerHeight - 40 - menu.items.length * 36) }} onClick={(e) => e.stopPropagation()}>
          <div className="menu-title">{menu.title}</div>
          {menu.items.map((it) => (
            <button key={it.label} onClick={it.run}>
              {it.label}
            </button>
          ))}
        </div>
      )}

      {viewer && (
        <ZoneViewer
          g={g}
          title={viewer.title}
          cards={g.players[viewer.pid][viewer.zone]}
          onClose={() => setViewer(null)}
          highlightFor={highlightFor}
          onCardClick={(c, e) => {
            handleCardClick(c, e);
          }}
          onHover={setHover}
          onInspect={inspectOnly}
        />
      )}

      {graveyardTargets && !viewer && req?.type === 'targets' && (
        <ZoneViewer
          g={g}
          title={`${req.source.def.name}: ${req.spec.prompt}`}
          cards={req.candidates.map((t) => g.card((t as any).id)!).filter(Boolean)}
          highlightFor={highlightFor}
          onCardClick={(c, e) => handleCardClick(c, e)}
          onHover={setHover}
          onInspect={inspectOnly}
          footer={
            <>
              {picked.length >= (req.spec.min ?? 1) && (req.spec.max ?? 1) > 1 && (
                <button className="btn primary" onClick={() => respond(picked)}>
                  Done ({picked.length})
                </button>
              )}
              {req.cancellable && (
                <button className="btn secondary" onClick={() => respond(null)}>
                  Cancel
                </button>
              )}
            </>
          }
        />
      )}

      {req && <Modals g={g} req={req} respond={respond} onHover={setHover} onInspect={inspectOnly} />}

      {inspect && (
        <div className="inspect-backdrop" onClick={() => setInspect(null)}>
          <div className="inspect-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="inspect-card">
              <CardFace def={inspect.card.def} />
            </div>
            {!inspect.card.def.implemented && <div className="preview-warn">Not scripted: only type, P/T, keywords and mana abilities work.</div>}
            <div className="inspect-actions">
              {inspect.items.map((it) => (
                <button key={it.label} className="btn primary" onClick={it.run}>
                  {it.label}
                </button>
              ))}
              <button className="btn secondary" onClick={() => setInspect(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {g.winner !== undefined && !viewBoard && (
        <div className="gameover">
          <div className="gameover-box">
            <h1>{resultText}</h1>
            <p>
              Turn {g.turn} · {g.players[me].life} – {g.players[opp].life}
            </p>
            {matchLine && <p className="gameover-match">{matchLine}</p>}
            <div className="btns">
              <button className="btn primary" onClick={next.run}>
                {next.label}
              </button>
              <button className="btn secondary" onClick={() => setViewBoard(true)}>
                View battlefield
              </button>
              <button className="btn secondary" onClick={onExit}>
                Change decks
              </button>
            </div>
          </div>
        </div>
      )}

      {g.winner !== undefined && viewBoard && (
        <div className="gameover-bar">
          <span className="gameover-bar-result">{resultText}</span>
          <span className="gameover-bar-info">
            Turn {g.turn} · {g.players[me].life} – {g.players[opp].life}
            {matchLine ? ` · ${matchLine}` : ''}
          </span>
          <button className="btn small secondary" onClick={() => setViewBoard(false)}>
            Show result
          </button>
          <button className="btn small primary" onClick={next.run}>
            {next.label}
          </button>
          <button className="btn small secondary" onClick={onExit}>
            Change decks
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Phones: size hand cards so the whole hand fits side by side without overlapping
 * (overlapping cards made taps land on the neighbouring card). Below the minimum size the hand scrolls.
 */
function handFit(n: number): React.CSSProperties {
  const landscape = window.innerHeight <= 520;
  const max = landscape ? 52 : 74;
  const gap = 4;
  // in landscape the hand shares its row with the avatar and the buttons
  const avail = landscape ? window.innerWidth - 360 : window.innerWidth - 16;
  const w = Math.max(44, Math.min(max, Math.floor((avail - gap * Math.max(0, n - 1)) / Math.max(1, n))));
  return { ['--hand-w' as any]: `${w}px`, ['--hand-h' as any]: `${Math.round(w * 1.395)}px` };
}

function ZoneViewer({
  g,
  title,
  cards,
  onClose,
  highlightFor,
  onCardClick,
  onInspect,
  onHover,
  footer,
}: {
  g: Game;
  title: string;
  cards: CardInstance[];
  onClose?: () => void;
  highlightFor: (c: CardInstance) => any;
  onCardClick: (c: CardInstance, e: React.MouseEvent) => void;
  onInspect?: (c: CardInstance) => void;
  onHover: (c: CardInstance | null) => void;
  footer?: React.ReactNode;
}) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">{title}</div>
        <div className="modal-cards">
          {cards.length === 0 && <div className="empty">Empty</div>}
          {cards.map((c) => (
            <CardView key={c.id} g={g} card={c} size="hand" highlight={highlightFor(c)} onClick={onCardClick} onHover={onHover} onInspect={onInspect} />
          ))}
        </div>
        <div className="btns">
          {footer}
          {onClose && (
            <button className="btn secondary" onClick={onClose}>
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
